use std::sync::{Arc, Mutex};

use crate::core::registry::Registry;
use crate::dashboard::Dashboard;

#[derive(Default)]
pub struct AppState {
    // Arc so async commands can clone the handle into a blocking task without
    // borrowing Tauri's managed state across an await.
    pub registry: Arc<Mutex<Registry>>,
    // Local web dashboard (opt-in HTTP fleet view + send).
    pub dashboard: Dashboard,
}
