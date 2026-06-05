//! Owns a ConPTY-backed PTY (master + writer). Tauri-free. Returns the output
//! reader and the child SEPARATELY so callers run the (blocking) reader on its
//! own thread and wait on the child on another.

use std::io::{Read, Write};

use anyhow::Result;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::core::command_spec::CommandSpec;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

impl PtySession {
    /// Spawn `spec` under a new PTY of `size`. Returns the session, the output
    /// reader (BLOCKING — run on its own thread), and the child (wait + raw
    /// handle live on the child, used on another thread).
    pub fn spawn(
        spec: &CommandSpec,
        size: PtySize,
    ) -> Result<(Self, Box<dyn Read + Send>, Box<dyn Child + Send + Sync>)> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(size)?;

        let mut cmd = CommandBuilder::new(&spec.program);
        for a in &spec.args {
            cmd.arg(a);
        }
        if let Some(cwd) = &spec.cwd {
            cmd.cwd(cwd);
        }
        for (k, v) in &spec.env {
            cmd.env(k, v);
        }

        let child = pair.slave.spawn_command(cmd)?;
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // Let the child see its controlling-terminal end close.
        drop(pair.slave);

        Ok((PtySession { master: pair.master, writer }, reader, child))
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        // portable-pty's resize already returns anyhow::Result<()>.
        self.master.resize(PtySize {
            rows,
            cols,
            pixel_width: 0,
            pixel_height: 0,
        })
    }

    /// Drops the master (closes the ConPTY), which makes a blocked reader's
    /// read() return Ok(0) so its thread can end.
    pub fn shutdown(self) {
        drop(self);
    }
}
