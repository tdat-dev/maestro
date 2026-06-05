use std::sync::Mutex;

use crate::core::registry::Registry;

#[derive(Default)]
pub struct AppState {
    pub registry: Mutex<Registry>,
}
