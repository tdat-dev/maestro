//! Holds MANY concurrently-running agents keyed by id. Killing an agent simply
//! removes it from the map — its `Drop` performs the (non-blocking) teardown.

use std::collections::HashMap;

use anyhow::{anyhow, Result};
use portable_pty::PtySize;

use crate::core::agent::Agent;
use crate::core::command_spec::CommandSpec;

#[derive(Default)]
pub struct Registry {
    agents: HashMap<String, Agent>,
}

impl Registry {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn count(&self) -> usize {
        self.agents.len()
    }

    pub fn has(&self, id: &str) -> bool {
        self.agents.contains_key(id)
    }

    /// Spawn a new agent under `id`. Rejects a duplicate id.
    pub fn spawn(
        &mut self,
        id: String,
        spec: &CommandSpec,
        size: PtySize,
        on_bytes: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<()> {
        if self.agents.contains_key(&id) {
            return Err(anyhow!("agent '{id}' already exists"));
        }
        let agent = Agent::spawn(spec, size, on_bytes, on_exit)?;
        self.agents.insert(id, agent);
        Ok(())
    }

    pub fn write_input(&mut self, id: &str, bytes: &[u8]) -> Result<()> {
        self.agents
            .get_mut(id)
            .ok_or_else(|| anyhow!("no agent '{id}'"))?
            .write_input(bytes)
    }

    pub fn resize(&self, id: &str, cols: u16, rows: u16) -> Result<()> {
        self.agents
            .get(id)
            .ok_or_else(|| anyhow!("no agent '{id}'"))?
            .resize(cols, rows)
    }

    /// Kill (remove) one agent. No-op if absent. Drop tears the agent down.
    pub fn kill(&mut self, id: &str) {
        self.agents.remove(id);
    }

    /// Kill every agent (each Drop tears its tree down).
    pub fn clear(&mut self) {
        self.agents.clear();
    }
}
