//! Single-agent supervisor for M0. Tauri-free: sinks are injected as closures.
//! Teardown order is load-bearing on Windows:
//!   1. drop the Job  -> KILL_ON_JOB_CLOSE terminates the whole tree; child.wait() returns.
//!   2. session.shutdown() drops the master -> reader's read() returns Ok(0) -> reader thread ends.

use std::io::Read;
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, Result};
use portable_pty::PtySize;

use crate::core::command_spec::CommandSpec;
#[cfg(windows)]
use crate::core::job::Job;
use crate::core::pty_session::PtySession;

#[derive(Default)]
pub struct Supervisor {
    running: Option<Running>,
}

struct Running {
    #[cfg(windows)]
    job: Job,
    session: PtySession,
    reader_thread: Option<JoinHandle<()>>,
    wait_thread: Option<JoinHandle<()>>,
}

impl Supervisor {
    pub fn new() -> Self {
        Supervisor::default()
    }

    pub fn is_running(&self) -> bool {
        self.running.is_some()
    }

    /// Spawn one agent. `on_bytes` receives output chunks; `on_exit` fires once
    /// with the real exit code when the child terminates (naturally or via kill).
    pub fn spawn(
        &mut self,
        spec: &CommandSpec,
        size: PtySize,
        on_bytes: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<()> {
        if self.running.is_some() {
            return Err(anyhow!("an agent is already running (M0 is single-session)"));
        }

        let (session, reader, child) = PtySession::spawn(spec, size)?;

        // Assign to a kill-on-close Job IMMEDIATELY after spawn (race window noted
        // in the M0 plan). `as_raw_handle()` yields a Copy pointer value, so
        // `child` can still be moved into the wait thread afterwards.
        #[cfg(windows)]
        let job = {
            let raw = child
                .as_raw_handle()
                .ok_or_else(|| anyhow!("child raw handle unavailable"))?;
            let job = Job::new_kill_on_close()?;
            job.assign_raw(raw)?;
            job
        };

        // Reader thread: stream output until the master is dropped (Ok(0)).
        let reader_thread = spawn_reader(reader, on_bytes);

        // Wait thread: owns the child, blocks on wait(), fires on_exit with the
        // real exit code. kill() drops the job, which makes wait() return.
        let wait_thread = spawn_waiter(child, on_exit);

        self.running = Some(Running {
            #[cfg(windows)]
            job,
            session,
            reader_thread: Some(reader_thread),
            wait_thread: Some(wait_thread),
        });
        Ok(())
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        match &mut self.running {
            Some(r) => r.session.write_input(bytes),
            None => Err(anyhow!("no agent running")),
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        match &self.running {
            Some(r) => r.session.resize(cols, rows),
            None => Err(anyhow!("no agent running")),
        }
    }

    /// Kill is idempotent.
    pub fn kill(&mut self) -> Result<()> {
        if let Some(mut r) = self.running.take() {
            // 1) Drop the job -> tree dies; the child's wait() returns.
            #[cfg(windows)]
            drop(r.job);
            // 2) Drop master -> reader unblocks.
            r.session.shutdown();
            // 3) Join threads (they end promptly after the drops above).
            if let Some(t) = r.wait_thread.take() {
                let _ = t.join();
            }
            if let Some(t) = r.reader_thread.take() {
                let _ = t.join();
            }
        }
        Ok(())
    }
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    mut on_bytes: impl FnMut(&[u8]) + Send + 'static,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => on_bytes(&buf[..n]),
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
