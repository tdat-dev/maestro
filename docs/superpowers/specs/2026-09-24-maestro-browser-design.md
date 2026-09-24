# Maestro Browser — agents drive a real Chrome, extensions included

Date: 2026-09-24 · Status: proposed · Branch: `feat/agent-inbox`

## Goal

Every agent Maestro launches can use a real Google Chrome: open pages, read
them, click, type, take screenshots, and **use installed extensions** such as
GCare, including the extension's own interface (popup, side panel, settings
page), not only what it injects into websites. Everything goes through
Maestro: one browser, one set of tools, and one place to watch and stop.

The companion extension for the user's everyday Chrome ("Maestro for Chrome")
stays a later phase. Chrome forbids one extension from driving another
extension's pages, so it cannot reach GCare's own interface. This design does
not have that limit.

## Why a dedicated profile plus CDP

- The agent drives a real Chrome (branded, auto-updated), not Chromium or a
  webview, so extensions from the Web Store install and run normally.
- It uses its own `--user-data-dir` ("Maestro Chrome"). Chrome 136+ refuses
  `--remote-debugging-port` on the default profile but accepts it on a
  separate one. The user installs GCare and signs in there once. The profile
  persists.
- Over CDP every target is reachable: tabs, extension pages
  (`chrome-extension://<id>/...`), extension service workers, and iframes that
  extensions inject.
- The user's everyday Chrome is never touched, so an agent cannot wander into
  personal tabs.

## Spike results (2026-09-24, Chrome 153.0.8010.53, this machine)

**Copying a real profile does not work:**
- **Logins are lost.** All 1,654 cookies in the source profile use `v20`
  app-bound encryption. The copy came up with none of them. Only the 3
  cookies Facebook set fresh were present.
- **Extensions are wiped.** Chrome treats a copied `Secure Preferences` as
  tampered: it writes `preference_reset_time`, empties the protected
  extension settings, and garbage-collects the extension folders. The
  service workers ran on the first start and were gone after that.
- **It crashed.** Chrome crashed twice on the tampered copy, once during
  `Extensions.triggerAction`.

**A fresh Maestro profile plus CDP works:**
- **Launch.** `--remote-debugging-port=0`, then read `DevToolsActivePort`.
- **Unpacked extensions load over CDP.** `--load-extension` is ignored on
  branded Chrome 153, even with
  `--disable-features=DisableLoadExtensionCommandLineSwitch`. But
  `Extensions.loadUnpacked({ path })` over the ordinary WebSocket
  connection, with `--enable-unsafe-extension-debugging`, loads the
  extension with the same id as in the real profile
  (`hbffpofijgejjkeapalldifihkbibicl`). It runs the code live from the
  user's folder.
- **GravityCare's real interface is fully drivable.** It is not the toolbar
  popup. `popup.html` is only an intro page, which also serves as the
  new-tab page. The real interface is a Vue app that `content.js` writes
  into `https://www.facebook.com/?window=auto-mkt`. Over CDP it read the
  whole app, and a real mouse click on "VI" switched it to Vietnamese.
- **The toolbar action works.** `Extensions.triggerAction({ id, targetId })`
  needs the **tab** target id, not the page target id. On a clean profile it
  returned `{}` and the popup appeared as its own `page` target. No crash.

**What this changes:**
- "Use every existing profile" becomes **mirror**, not copy. Each real
  profile gets a Maestro profile with the same name:
  - its unpacked extensions are loaded live from their folders;
  - its Web Store extensions are listed with a one-click "Add" (Chrome Web
    Store page) each;
  - sites are logged into once and remembered.
- The everyday-Chrome extension route ("Maestro for Chrome") is **not
  blocked for GravityCare**, because GravityCare's app is an `https:` page
  that `chrome.debugger` can attach to. That route keeps the user's live
  logins. It remains the only way to reuse live logins.

## Every existing Chrome profile, not one blank one

> Superseded in part by the spike above: copying fails, mirroring works.

The user wants agents to work in each Chrome profile they already have, with
its extensions and logins. There is a constraint: Chrome 136+ ignores
`--remote-debugging-port` on the real `User Data` folder, and a running Chrome
locks that folder anyway. So Maestro **imports** the profiles instead:

- **List them.** Read `%LOCALAPPDATA%/Google/Chrome/User Data/Local State`
  (`profile.info_cache`): folder, name, Google account, avatar. Maestro shows
  them with the same names.
- **Import them.** Copy each chosen profile folder, plus `Local State`, into
  Maestro Chrome's own `User Data`, under the same folder names. Skip caches,
  which are gigabytes and not needed. This brings along extensions and their
  data (GCare included), bookmarks, and settings. Whether cookies and saved
  logins survive depends on Chrome's app-bound cookie encryption, and the
  spike checks this.
  - If they do not survive: the agent logs in once per site (passwords can
    come from Google Sync), and the imported profile keeps it from then on.
- **Keep them current.** A "Refresh from Chrome" button re-imports a profile
  while the user's Chrome is closed. This matters when the user installed a
  new extension or logged in somewhere new.
- **One Maestro Chrome, many profiles.** Tools take a `profile` argument, for
  example `browser_open({ profile: "Work", url })`.
  - A window for that profile is opened with
    `chrome.exe --user-data-dir=<maestro> --profile-directory="Profile 2" <url>`,
    which the running instance picks up.
  - CDP sees the tabs of every open profile.
  - `browser_tabs` reports which profile each tab belongs to.
- **Why not the live profiles?** Bypassing Chrome's block on the real folder is
  fragile, since Chrome closes such holes. It would also force the user's own
  Chrome to be closed while agents work. Driving the live profiles, all tabs
  and current logins, is the job of the later extension ("Maestro for
  Chrome"), and it has the extension-UI limit described below.

## What already exists (reused, not rebuilt)

- **Every agent already gets `maestro-mcp`.** It is registered once, user-wide
  (`claude mcp add --scope user maestro`). Browser tools added there reach
  Claude, Codex, Gemini and opencode with no per-CLI config.
- **File bridges between maestro-mcp and the app**: `fleet.json`,
  `outbox.jsonl`, `spawn-requests.jsonl`. The browser follows the same pattern.
- **Every agent process knows its identity**: `MAESTRO_AGENT` and
  `MAESTRO_WORKSPACE` in its environment (`src/pane.ts`). That is how tabs are
  owned per agent.
- **Chat shows the images an agent receives** (2e1974a), so
  `browser_screenshot` output appears in the chat with no extra work.

## 1. Maestro Chrome (app side, Rust)

- **Find Chrome**: look up `chrome.exe` in the registry (`App Paths`), then
  Program Files and LocalAppData. If it is missing, show a clear message with
  the download link.
- **Profile**: `%APPDATA%/Maestro/chrome-profile`.
- **Launch flags**:
  - `--user-data-dir=<profile>`
  - `--remote-debugging-port=0`: Chrome picks a free port and writes it to
    `<profile>/DevToolsActivePort`. That avoids the Windows reserved-port
    problem we keep hitting with vite.
  - `--remote-debugging-address=127.0.0.1`
  - `--no-first-run`, `--no-default-browser-check`
  - `--enable-unsafe-extension-debugging`, if the spike shows it is needed to
    trigger extension actions.
- **State file**: after launch, write `~/.maestro/browser.json` with
  `{ port, wsEndpoint, pid, startedAt }`. It is global, not per workspace,
  because there is one browser for all projects.
- **Tauri commands**: `browser_start`, `browser_stop`, `browser_status`.
- **Relaunch**: if the user closes the window, the next browser tool call
  launches it again. The profile keeps logins and extensions.
- **On-demand launch**: when maestro-mcp finds no live browser, it appends to
  `~/.maestro/browser-requests.jsonl` and waits (up to about 15 s) for
  `browser.json` to show a live endpoint. The app watches that file, the same
  way it watches `spawn-requests.jsonl`.

## 2. Browser tools in maestro-mcp

- **Connection**: `playwright-core` `chromium.connectOverCDP(wsEndpoint)`,
  connected once per MCP process and reconnected when it drops. The tool
  surface borrows from microsoft/playwright-mcp (Apache-2.0): an accessibility
  snapshot with element refs, then act on a ref. That keeps the agent's view
  small and precise, and screenshots are only for when looks matter.

**Tools:**

| Tool | Does |
|---|---|
| `browser_tabs` | List this agent's tabs (and optionally all tabs), open or close one, switch between them |
| `browser_open` | Navigate the agent's current tab, or a new tab, to a URL |
| `browser_snapshot` | Accessibility tree of the page with `ref`s, including frames |
| `browser_click` / `browser_type` / `browser_press` / `browser_select` / `browser_hover` / `browser_scroll` | Act on a `ref`, or on coordinates as a fallback |
| `browser_screenshot` | Screenshot of the page or one element, returned as an image, so it shows in chat |
| `browser_wait` | Wait for text, a ref, navigation, or a delay |
| `browser_eval` | Run JavaScript in the page. Off by default, enabled in Settings |
| `extensions_list` | Installed extensions: id, name, version, popup, options and side panel pages. Read from the profile's `Preferences` plus each manifest, and cross-checked against CDP targets |
| `extension_open` | Open an extension's popup, options or side panel page in the agent's tab, then act on it with the tools above |
| `extension_action` | Press the extension's toolbar button for the current tab, the same as a user clicking the icon, if the spike confirms CDP can do it |

**Tab ownership:**
- Tabs an agent opens are tagged with its `MAESTRO_AGENT` name, kept in a map
  in `browser.json` keyed by CDP target id.
- An agent acts only on its own tabs unless it explicitly adopts one (for
  example a tab the user opened), and two agents never drive the same tab. A
  second agent gets a clear error naming the owner.

**Tool errors say what to do next**, for example "Maestro Chrome is closed:
opening it, try again", or "tab 3 belongs to Ana".

## 3. The GCare problem: the popup acts on "the current tab"

**The problem**: extension popups usually call
`chrome.tabs.query({active: true, currentWindow: true})` to find the page they
act on (for example the Facebook tab). If we open `popup.html` in a tab
instead, that tab is itself the active tab, so the popup may act on nothing.

**Options, in order of preference.** The spike decides which one we use:

1. **Trigger the real popup.**
   - Use CDP `Extensions.triggerAction` if the installed Chrome version has it
     (possibly behind `--enable-unsafe-extension-debugging`).
   - The real popup then opens against the real active tab and shows up as its
     own CDP target, which we attach to and drive.
2. **Open the popup page in its own window, and put the target page back as
   the active tab of the last-focused window.** Many popups use
   `lastFocusedWindow` or query by URL, so this works for some.
3. **Side panel or options page.** If GCare's features live there, they can be
   opened directly and do not depend on the active tab.
4. **Last resort: an OS-level click** on the toolbar icon of the Maestro Chrome
   window, from a Maestro screenshot plus the Win32 mouse. The popup is still a
   CDP target once open, so only this one click is "blind".

## 4. Inside Maestro (UI)

- **Live view**:
  - When the focused agent is using the browser, the chat side panel shows a
    Browser tile: a live CDP `Page.startScreencast` of that agent's tab (JPEG
    frames, throttled). It shows the URL, the extension name when on an
    extension page, and the time of the last action.
  - Clicking the tile opens it large.
  - **Stop** ends the agent's current browser action and blocks further ones
    until you resume.
  - **Take over** brings the real Maestro Chrome window to the front and
    pauses the agent's browser tools.
- **Queue and header**: a small "browsing" mark on agents using the browser,
  in the agent's colour.
- **Chat**: each browser step reads like the others, for example "Opened
  facebook.com", "Clicked Đăng bài", "Took a screenshot". Screenshots show as
  thumbnails (already built).
- **Settings → Browser**:
  - Allow agents to use the browser (on/off, and per CLI type).
  - An **Open Maestro Chrome** button to install extensions and sign in.
  - Allow JavaScript in pages (`browser_eval`).
  - Ask before sending or paying: when a click target's text matches
    send/post/pay/buy (VI and EN), the tool pauses and the agent's answer card
    asks you. Off by default.
  - Profile location, and a **Reset profile** button behind a confirm.

## 5. Security

- The CDP port listens on 127.0.0.1 only, but any local process can connect
  to it. That is the same trust level as the agents themselves, which already
  run with the user's rights. Written down, not hidden.
- The profile is separate, so the agent sees only what the user signed into
  on purpose.
- `browser_eval` is off by default. File downloads go to a Maestro folder.
- Tab ownership prevents one agent from hijacking another's session.

## Milestones

1. **Spike** (throwaway, in scratchpad, on the user's machine with GCare):
   - launch Chrome with the dedicated profile on port 0;
   - install GCare by hand;
   - list extensions over CDP;
   - check whether `Extensions.triggerAction` works on this Chrome version;
   - open GCare's UI and click one control;
   - confirm the active-tab behaviour.

   Report which option from section 3 wins.
2. **Launcher + tools**: Rust launcher, `browser.json` and requests bridge, and
   the maestro-mcp browser tools with tab ownership. Usable end to end from any
   agent. Tests: unit tests for tools against a headless Chrome in CI style,
   plus a real Chrome run on the machine.
3. **Maestro UI**: live view tile, Stop and Take over, the browsing mark,
   Settings → Browser.
4. **Safety and polish**: ask-before-send, reset profile, error copy,
   docs/README.

## Later: Maestro for Chrome (everyday Chrome)

Separate card, after this ships:
- an MV3 extension forked from Playwright's (Apache-2.0), relayed to Maestro;
- for tasks that need the user's everyday logins.

It can only drive websites, including what extensions inject into them, not
other extensions' own pages. If GCare is ours, adding `externally_connectable`
to GCare would let it call GCare's features directly.
