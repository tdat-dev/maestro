use std::sync::Mutex;

use crate::core::supervisor::Supervisor;

#[derive(Default)]
pub struct AppState {
    pub supervisor: Mutex<Supervisor>,
}
