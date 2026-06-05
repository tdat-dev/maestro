//! One running agent: a ConPTY child assigned to a kill-on-close Job, with a
//! reader thread streaming output and a wait thread reporting exit.
//!
//! Field DECLARATION order IS the teardown order on drop, and it is non-blocking:
//!   1. job     -> CloseHandle => KILL_ON_JOB_CLOSE terminates the whole tree;
//!                 the wait thread's child.wait() then returns.
//!   2. session -> dropping the master closes the ConPTY; the reader thread's
//!                 blocked read() gets EOF and the thread ends.
//!   3. threads -> JoinHandles detach; both threads have already finished.

use std::io::Read;
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, Result};
use portable_pty::PtySize;

use crate::core::command_spec::CommandSpec;
#[cfg(windows)]
use crate::core::job::Job;
use crate::core::pty_session::PtySession;

pub struct Agent {
    // NOTE: drop order = declaration order. Keep job first, session second.
    // job + threads are held purely for their drop side-effects / ownership.
    #[cfg(windows)]
    #[allow(dead_code)]
    job: Job,
    session: PtySession,
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

        let reader_thread = spawn_reader(reader, on_bytes);
        let wait_thread = spawn_waiter(child, on_exit);

        Ok(Agent {
            #[cfg(windows)]
            job,
            session,
            reader_thread,
            wait_thread,
        })
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.session.write_input(bytes)
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        self.session.resize(cols, rows)
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
