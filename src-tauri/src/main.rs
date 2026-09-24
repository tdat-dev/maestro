// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Chrome starts this same exe as the "Maestro for Chrome" native host.
    if maestro_lib::browser::host::wanted() {
        maestro_lib::browser::host::run();
    }
    maestro_lib::run();
}
