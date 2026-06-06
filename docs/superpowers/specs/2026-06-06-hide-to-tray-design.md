# Hide to Tray — Design

**Date:** 2026-06-06
**Status:** Approved (approach A)

## Summary

Add an opt-in "Hide to tray" feature to Maestro. When enabled, both the
titlebar **Close (X)** and **Minimize** buttons hide the window to the Windows
system tray instead of quitting / minimizing to the taskbar — agents keep
running in the background. A new **Settings** modal (opened from a gear icon)
holds the toggle. Users who don't enable it see no tray icon and no behaviour
change.

## Decisions (from brainstorming)

- **Trigger:** both Close (X) and Minimize hide to tray when the setting is on.
- **No confirm on hide:** hiding via X is silent; agents keep running. The
  kill-all confirm only runs on an explicit **Quit** (tray menu).
- **Settings location:** a new Settings modal, opened by a gear icon (topbar +
  Home).
- **Opt-in tray icon:** the tray icon is only visible while the setting is on.

## Approach

Frontend owns the hide/quit logic; Rust only provides the tray icon + menu and
emits events. The window is frameless (`decorations: false`), so the only
minimize/close paths are the app's own titlebar buttons — the frontend can
intercept both completely. This reuses the existing close → confirm → killAll →
destroy flow already living in TypeScript.

## Components

### Rust (`src-tauri`)

1. **`Cargo.toml`** — enable the `tray-icon` feature on the `tauri` dependency.
2. **`lib.rs` `setup` hook** — build a `TrayIcon` (icon from
   `default_window_icon`) with a right-click menu:
   - **Show Maestro** → `window.show()` + `set_focus()`.
   - **Quit** → `window.show()` then `app.emit("tray-quit", ())` so the
     frontend runs its existing confirm + killAll + destroy flow.
   - Left-click on the tray icon → `window.show()` + `set_focus()`.
   - The tray is created **hidden** (`.visible(false)`); the frontend turns it
     on when the setting is enabled.
3. **`set_tray_visible(visible: bool)` command** — toggles tray icon visibility.
   Registered in the `invoke_handler`. Resolves the tray via `app.tray_by_id`
   (built with a known id, e.g. `"main"`).

### Frontend (`src`)

4. **`settings.ts` (new module)** — typed helpers over `localStorage`:
   - `getHideToTray(): boolean` (key `maestro.hideToTray`, default `false`).
   - `setHideToTray(on: boolean): void`.
   - Single source of truth for the key string so tests and callers agree.
5. **`ipc.ts`** — add:
   - `hideWindow(): Promise<void>` → `getCurrentWindow().hide()`.
   - `setTrayVisible(visible: boolean): Promise<void>` → `invoke("set_tray_visible", …)`.
   - `onTrayQuit(cb): Promise<void>` → `listen("tray-quit", cb)`.
6. **`main.ts`**
   - Extract the current quit flow (confirm → `killAll` → `destroyWindow`) into
     a reusable `quitApp()` function.
   - In `onWindowClose`: if `getHideToTray()` → `event.preventDefault()` +
     `hideWindow()` (silent). Else → run existing confirm/killAll/destroy.
   - Wire `onTrayQuit(() => quitApp())`.
   - On boot: read the setting and call `setTrayVisible(getHideToTray())` to
     sync the tray icon state.
   - Wire the gear buttons to open the Settings modal; wire the toggle to
     persist + `setTrayVisible(...)`.
7. **`titlebar.ts`** — in the `wcMin` click handler: if `getHideToTray()` →
   `hideWindow()`, else `minimizeWindow()`.
8. **`index.html`** — add:
   - A gear icon button in the workspace topbar and on the Home screen.
   - A Settings modal (`.backdrop` + `.modal`, same pattern as existing modals)
     containing the "Hide to tray" toggle (reuse the `.perm-toggle` switch
     style).

## Data Flow

```
Setting change (modal toggle)
  → setHideToTray(on) [localStorage]
  → setTrayVisible(on) [Rust shows/hides tray icon]

Close (X) clicked
  → onWindowClose → hideToTray? hide() : confirm→killAll→destroy

Minimize clicked
  → wcMin → hideToTray? hide() : minimize()

Tray left-click / "Show"  → window.show()+focus
Tray "Quit" → window.show() + emit "tray-quit" → quitApp()
```

## Error Handling

- All window/tray IPC calls are wrapped in try/catch (matching existing code),
  so browser preview (no Tauri runtime) degrades gracefully.
- Tray **Quit** always `show()`s the window first so the native confirm dialog
  is visible.
- If `set_tray_visible` is called before the tray exists (it won't, since the
  tray is built in `setup`), the command returns an error that the frontend
  swallows.

## Testing

- **Unit:** `settings.test.ts` — default is `false`, set/get round-trips,
  persists to the expected key. Follows the existing `*.test.ts` (vitest)
  pattern.
- **Manual:** with the toggle on/off, verify X and Minimize behaviour, tray
  icon appears/disappears, left-click restores, tray Quit runs the kill-all
  confirm and exits.

## Out of Scope (YAGNI)

- No "start hidden / launch to tray on boot" option.
- No tray balloon notifications or per-agent tray status.
- No other settings in the modal yet (the modal is built to be extensible, but
  ships with just the one toggle).
