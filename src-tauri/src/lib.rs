pub mod commands;
pub mod core;
pub mod error;
pub mod state;
pub mod review;
pub mod worktree;

use crate::state::AppState;
use tauri::menu::{Menu, MenuItem};
use tauri::tray::{MouseButton, MouseButtonState, TrayIconBuilder, TrayIconEvent};
use tauri::{Emitter, Manager};

/// Bring the main window back to the foreground (used by the tray icon + menu).
fn show_main_window(app: &tauri::AppHandle) {
    if let Some(w) = app.get_webview_window("main") {
        let _ = w.show();
        let _ = w.set_focus();
    }
}

/// Build the system-tray icon with a Show/Quit menu. Created hidden — the
/// frontend turns it on via `set_tray_visible` when "Hide to tray" is enabled.
fn build_tray(app: &tauri::App) -> tauri::Result<()> {
    let show_i = MenuItem::with_id(app, "show", "Show Maestro", true, None::<&str>)?;
    let quit_i = MenuItem::with_id(app, "quit", "Quit", true, None::<&str>)?;
    let menu = Menu::with_items(app, &[&show_i, &quit_i])?;

    let mut builder = TrayIconBuilder::with_id("main")
        .tooltip("Maestro")
        .menu(&menu)
        .show_menu_on_left_click(false)
        .on_menu_event(|app, event| match event.id.as_ref() {
            "show" => show_main_window(app),
            "quit" => {
                // Surface the window so the frontend's kill-all confirm is visible,
                // then let the frontend run its existing quit flow.
                show_main_window(app);
                let _ = app.emit("tray-quit", ());
            }
            _ => {}
        })
        .on_tray_icon_event(|tray, event| {
            if let TrayIconEvent::Click {
                button: MouseButton::Left,
                button_state: MouseButtonState::Up,
                ..
            } = event
            {
                show_main_window(tray.app_handle());
            }
        });

    if let Some(icon) = app.default_window_icon() {
        builder = builder.icon(icon.clone());
    }

    // Built visible by default; hide it until the frontend enables "Hide to tray".
    let tray = builder.build(app)?;
    tray.set_visible(false)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_notification::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(AppState::default())
        .setup(|app| {
            build_tray(app)?;
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_input,
            commands::pty_resize,
            commands::pty_kill,
            commands::pty_kill_all,
            commands::set_tray_visible,
            commands::set_tray_tooltip,
            worktree::git_repo_root,
            worktree::worktree_add,
            worktree::worktree_remove,
            review::git_repos_under,
            review::repo_diff,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
