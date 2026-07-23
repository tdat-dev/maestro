//! One running agent: a ConPTY child assigned to a kill-on-close Job, with a
//! reader thread streaming output and a wait thread reporting exit.
//!
//! Field DECLARATION order IS the teardown order on drop, and it is non-blocking:
//!   1. job     -> CloseHandle => KILL_ON_JOB_CLOSE terminates the whole tree;
//!                 the wait thread's child.wait() then returns.
//!   2. session -> dropping the master closes the ConPTY; the reader thread's
//!                 blocked read() gets EOF and the thread ends.
//!   3. threads -> JoinHandles detach; both threads have already finished.

use std::collections::VecDeque;
use std::fs::File;
use std::io::{Read, Write as IoWrite};
use std::path::Path;
use std::sync::mpsc::{channel, Receiver, Sender};
use std::sync::{Arc, Mutex};
use std::thread::{self, JoinHandle};
use std::time::Instant;

use anyhow::{anyhow, Result};
use portable_pty::PtySize;

use crate::core::command_spec::CommandSpec;
#[cfg(windows)]
use crate::core::job::Job;
use crate::core::pty_session::PtySession;

/// Where PTY output goes (e.g. a window's IPC channel). Swappable via `attach`.
pub type Sink = Box<dyn FnMut(&[u8]) + Send>;

/// Recent output kept for replay when a new window attaches (tab detach).
const SCROLLBACK_CAP: usize = 512 * 1024;

/// An in-progress session recording: raw output frames appended to a JSONL file
/// with a millisecond timestamp, so a player can replay the terminal with its
/// original timing. Each frame is one line `{"t":<ms since start>,"d":"<b64>"}`;
/// the first line is a header `{"v":1}`. Buffered; flushed on stop/drop.
struct Rec {
    w: std::io::BufWriter<File>,
    start: Instant,
}

struct Output {
    buf: VecDeque<u8>,
    sink: Sink,
    // Extra live subscribers (the remote web terminal). Each gets every output
    // chunk; a closed channel is pruned. The single `sink` above is the owning
    // window; taps are additional read-only mirrors.
    taps: Vec<Sender<Vec<u8>>>,
    // When Some, every output chunk is also appended to this recording.
    rec: Option<Rec>,
}

/// Standard base64 (no line breaks). Small dependency-free encoder, matching the
/// one in core::fs — kept local so this module has no cross-module coupling.
fn b64(data: &[u8]) -> String {
    const T: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(data.len().div_ceil(3) * 4);
    for chunk in data.chunks(3) {
        let b0 = chunk[0] as u32;
        let b1 = *chunk.get(1).unwrap_or(&0) as u32;
        let b2 = *chunk.get(2).unwrap_or(&0) as u32;
        let n = (b0 << 16) | (b1 << 8) | b2;
        out.push(T[((n >> 18) & 63) as usize] as char);
        out.push(T[((n >> 12) & 63) as usize] as char);
        out.push(if chunk.len() > 1 { T[((n >> 6) & 63) as usize] as char } else { '=' });
        out.push(if chunk.len() > 2 { T[(n & 63) as usize] as char } else { '=' });
    }
    out
}

/// Append one recorded frame (called by the reader thread under the output lock).
fn rec_frame(rec: &mut Rec, bytes: &[u8]) {
    let t = rec.start.elapsed().as_millis();
    // A failed write must not kill the reader thread; drop the frame silently.
    let _ = writeln!(rec.w, "{{\"t\":{t},\"d\":\"{}\"}}", b64(bytes));
}

pub struct Agent {
    // NOTE: drop order = declaration order. Keep job first, session second.
    // job + threads are held purely for their drop side-effects / ownership.
    #[cfg(windows)]
    #[allow(dead_code)]
    job: Job,
    session: PtySession,
    output: Arc<Mutex<Output>>,
    #[allow(dead_code)]
    reader_thread: JoinHandle<()>,
    #[allow(dead_code)]
    wait_thread: JoinHandle<()>,
}

impl Agent {
    /// Spawn one agent. `on_bytes` receives output chunks; `on_exit` fires once
    /// with the real exit code when the child terminates (naturally or on kill).
    pub fn spawn(
        spec: &CommandSpec,
        size: PtySize,
        on_bytes: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<Self> {
        let (session, reader, child) = PtySession::spawn(spec, size)?;

        // Assign to a kill-on-close Job IMMEDIATELY after spawn.
        #[cfg(windows)]
        let job = {
            let raw = child
                .as_raw_handle()
                .ok_or_else(|| anyhow!("child raw handle unavailable"))?;
            let job = Job::new_kill_on_close()?;
            job.assign_raw(raw)?;
            job
        };

        let output = Arc::new(Mutex::new(Output {
            buf: VecDeque::new(),
            sink: Box::new(on_bytes),
            taps: Vec::new(),
            rec: None,
        }));
        let reader_thread = spawn_reader(reader, output.clone());
        let wait_thread = spawn_waiter(child, on_exit);

        Ok(Agent {
            #[cfg(windows)]
            job,
            session,
            output,
            reader_thread,
            wait_thread,
        })
    }

    /// Re-point output at a new sink (a freshly-detached window's channel).
    /// The buffered scrollback is replayed through the new sink first, under
    /// the same lock the reader thread uses, so the swap loses/dupes nothing.
    pub fn attach(&self, mut sink: Sink) {
        let mut o = self.output.lock().unwrap_or_else(|p| p.into_inner());
        let (a, b) = o.buf.as_slices();
        if !a.is_empty() {
            sink(a);
        }
        if !b.is_empty() {
            sink(b);
        }
        o.sink = sink;
    }

    /// Subscribe to this agent's live output. The current scrollback is replayed
    /// into the channel first (so a fresh terminal paints immediately), then
    /// every new chunk arrives until the receiver is dropped or the agent exits.
    pub fn tap(&self) -> Receiver<Vec<u8>> {
        let (tx, rx) = channel::<Vec<u8>>();
        let mut o = self.output.lock().unwrap_or_else(|p| p.into_inner());
        let (a, b) = o.buf.as_slices();
        if !a.is_empty() || !b.is_empty() {
            let mut replay = Vec::with_capacity(a.len() + b.len());
            replay.extend_from_slice(a);
            replay.extend_from_slice(b);
            let _ = tx.send(replay);
        }
        o.taps.push(tx);
        rx
    }

    /// Start recording this agent's output to `path` (a JSONL "cast" file). The
    /// current scrollback is written as the first frame (t=0) so the recording is
    /// self-contained — a player sees the screen state at record start. Replaces
    /// any recording already in progress.
    pub fn record_start(&self, path: &str) -> Result<()> {
        let file = File::create(Path::new(path))?;
        let mut w = std::io::BufWriter::new(file);
        writeln!(w, "{{\"v\":1}}")?;
        let mut o = self.output.lock().unwrap_or_else(|p| p.into_inner());
        let (a, b) = o.buf.as_slices();
        if !a.is_empty() || !b.is_empty() {
            let mut snap = Vec::with_capacity(a.len() + b.len());
            snap.extend_from_slice(a);
            snap.extend_from_slice(b);
            writeln!(w, "{{\"t\":0,\"d\":\"{}\"}}", b64(&snap))?;
        }
        o.rec = Some(Rec { w, start: Instant::now() });
        Ok(())
    }

    /// Stop recording and flush the file. No-op if not recording.
    pub fn record_stop(&self) {
        let mut o = self.output.lock().unwrap_or_else(|p| p.into_inner());
        if let Some(mut rec) = o.rec.take() {
            let _ = rec.w.flush();
        }
    }

    pub fn is_recording(&self) -> bool {
        self.output
            .lock()
            .unwrap_or_else(|p| p.into_inner())
            .rec
            .is_some()
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.session.write_input(bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.session.resize(cols, rows)
    }
}

fn spawn_reader(mut reader: Box<dyn Read + Send>, output: Arc<Mutex<Output>>) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let mut o = output.lock().unwrap_or_else(|p| p.into_inner());
                    o.buf.extend(&buf[..n]);
                    let over = o.buf.len().saturating_sub(SCROLLBACK_CAP);
                    if over > 0 {
                        o.buf.drain(..over);
                    }
                    (o.sink)(&buf[..n]);
                    // Mirror to live taps (remote terminals); drop closed ones.
                    if !o.taps.is_empty() {
                        let chunk = buf[..n].to_vec();
                        o.taps.retain(|t| t.send(chunk.clone()).is_ok());
                    }
                    // Append to the session recording, if one is running.
                    if let Some(rec) = o.rec.as_mut() {
                        rec_frame(rec, &buf[..n]);
                    }
                }
                Err(_) => break,
            }
        }
    })
}

fn spawn_waiter(
    child: Box<dyn portable_pty::Child + Send + Sync>,
    on_exit: impl FnOnce(u32) + Send + 'static,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut child = child;
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        on_exit(code);
    })
}
