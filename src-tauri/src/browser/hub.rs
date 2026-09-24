//! The browser hub: one local WebSocket server inside Maestro that both sides
//! dial into.
//!
//! - **Browsers**: each Chrome/Edge/Brave profile running the "Maestro for
//!   Chrome" extension reaches us through the native host (`host.rs`).
//! - **Agents**: every maestro-mcp process (one per agent) dials in to call
//!   browser tools.
//!
//! The hub routes an agent's call to the browser that agent picked (or the only
//! one connected) and routes the answer back. It never runs browser actions
//! itself. The port and a random token are written to
//! `~/.maestro/browser-hub.json`, readable only by this user's processes; every
//! peer must present the token in its first message.

use std::collections::hash_map::RandomState;
use std::collections::HashMap;
use std::hash::{BuildHasher, Hasher};
use std::io::ErrorKind;
use std::net::{Ipv4Addr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use serde_json::{json, Value};
use tungstenite::Message;

#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct BrowserInfo {
    pub id: u64,
    pub browser: String,
    pub email: String,
    pub profile: String,
    pub version: String,
}

impl BrowserInfo {
    pub fn label(&self) -> String {
        let who = if !self.profile.is_empty() {
            self.profile.clone()
        } else if !self.email.is_empty() {
            self.email.clone()
        } else {
            "unnamed profile".into()
        };
        format!("{} · {}", self.browser, who)
    }
}

enum Role {
    Unknown,
    Browser(BrowserInfo),
    Agent { name: String, pick: Option<u64> },
}

struct Peer {
    tx: mpsc::Sender<String>,
    role: Role,
}

/// Who asked. Maestro itself (the live view) asks too, and waits on a channel.
enum Asker {
    Agent(u64, Value),
    App(mpsc::Sender<Value>),
}

struct Pending {
    asker: Asker,
    browser: u64,
    agent: String,
    /// The call as sent, so a click held for the user's OK can be sent again.
    call: Value,
}

/// A risky click waiting for the user's OK (see RISKY in the extension).
struct Held {
    agent_conn: u64,
    cid: Value,
    browser: u64,
    agent: String,
    call: Value,
    what: String,
    url: String,
    at: u64,
}

/// How long a held click waits for the user. The agent's call gives up after
/// the same time (HOLD_TIMEOUT_MS in maestro-mcp), so a late OK never clicks
/// for an agent that has moved on.
pub const HOLD_MS: u64 = 10 * 60_000;

/// What Maestro shows for a held click.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Ask {
    pub id: u64,
    pub agent: String,
    pub what: String,
    pub url: String,
    pub at: u64,
}

/// A page that wants a person (a login or a CAPTCHA).
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Blocker {
    pub agent: String,
    pub kind: String,
    pub url: String,
}

/// What an agent last did in a browser, for the live view and the Stop button.
#[derive(Clone, Debug, Serialize, PartialEq)]
pub struct Activity {
    pub agent: String,
    pub browser: u64,
    pub label: String,
    pub tool: String,
    pub action: String,
    pub at: u64,
    pub paused: bool,
}

#[derive(Default)]
struct Inner {
    peers: HashMap<u64, Peer>,
    pending: HashMap<u64, Pending>,
    activity: HashMap<String, Activity>,
    /// Browsers already told to reload onto the extension on disk (once each).
    reloaded: std::collections::HashSet<String>,
    held: HashMap<u64, Held>,
    /// Hold sending, posting, paying and deleting clicks for the user's OK.
    ask_risky: bool,
    next: u64,
}

pub enum HubEvent {
    Browsers(Vec<BrowserInfo>),
    Activity(Vec<Activity>),
    Asks(Vec<Ask>),
    Blocker(Blocker),
}

fn asks(inner: &Inner) -> Vec<Ask> {
    let now = now_ms();
    let mut v: Vec<Ask> = inner
        .held
        .iter()
        .filter(|(_, h)| now.saturating_sub(h.at) < HOLD_MS)
        .map(|(id, h)| Ask { id: *id, agent: h.agent.clone(), what: h.what.clone(), url: h.url.clone(), at: h.at })
        .collect();
    v.sort_by_key(|a| a.id);
    v
}

type OnChange = Box<dyn Fn(HubEvent) + Send + Sync>;

fn now_ms() -> u64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

fn activities(inner: &Inner) -> Vec<Activity> {
    let mut v: Vec<Activity> = inner.activity.values().cloned().collect();
    v.sort_by(|a, b| a.agent.cmp(&b.agent));
    v
}

fn browsers_of(inner: &Inner) -> Vec<BrowserInfo> {
    let mut l: Vec<BrowserInfo> = inner.peers.values().filter_map(|p| match &p.role { Role::Browser(b) => Some(b.clone()), _ => None }).collect();
    l.sort_by_key(|b| b.id);
    l
}

pub struct Hub {
    inner: Mutex<Inner>,
    token: String,
    pub port: u16,
    on_change: OnChange,
    /// The version of the extension on disk, read each time a browser says
    /// hello. A browser running another one is told to reload, so an update
    /// (or an edit during development) reaches every profile without a click.
    pub wanted_version: Box<dyn Fn() -> Option<String> + Send + Sync>,
    /// Maps a browser's signed-in email to its profile name. Swappable in tests.
    profile_of: Box<dyn Fn(&str, &str) -> String + Send + Sync>,
}

pub fn random_token() -> String {
    let mut s = String::new();
    for _ in 0..2 {
        let mut h = RandomState::new().build_hasher();
        h.write_u128(std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0));
        s.push_str(&format!("{:016x}", h.finish()));
    }
    s
}

pub fn hub_file() -> Option<PathBuf> {
    let home = std::env::var("USERPROFILE").or_else(|_| std::env::var("HOME")).ok()?;
    Some(PathBuf::from(home).join(".maestro").join("browser-hub.json"))
}

fn reply(id: &Value, text: String) -> String {
    json!({ "type": "result", "id": id, "result": { "content": [{ "type": "text", "text": text }] } }).to_string()
}

fn fail(id: &Value, error: String) -> String {
    json!({ "type": "error", "id": id, "error": error }).to_string()
}

impl Hub {
    pub fn new(token: String, port: u16, on_change: OnChange) -> Self {
        Hub { inner: Mutex::new(Inner { ask_risky: true, ..Inner::default() }), token, port, on_change, wanted_version: Box::new(|| None), profile_of: Box::new(super::profiles::profile_name) }
    }

    #[cfg(test)]
    pub fn for_test(token: &str, profile_of: impl Fn(&str, &str) -> String + Send + Sync + 'static) -> Self {
        Hub { inner: Mutex::new(Inner { ask_risky: true, ..Inner::default() }), token: token.into(), port: 0, on_change: Box::new(|_| {}), wanted_version: Box::new(|| None), profile_of: Box::new(profile_of) }
    }

    /// Bind 127.0.0.1 on a free port, publish it, and serve in the background.
    pub fn start(on_change: OnChange, wanted_version: Box<dyn Fn() -> Option<String> + Send + Sync>) -> std::io::Result<Arc<Hub>> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let mut hub = Hub::new(random_token(), port, on_change);
        hub.wanted_version = wanted_version;
        let hub = Arc::new(hub);
        if let Some(f) = hub_file() {
            if let Some(dir) = f.parent() {
                let _ = std::fs::create_dir_all(dir);
            }
            let _ = std::fs::write(&f, json!({ "port": port, "token": hub.token, "pid": std::process::id() }).to_string());
        }
        let h = hub.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let h = h.clone();
                std::thread::spawn(move || serve(h, stream));
            }
        });
        Ok(hub)
    }

    pub fn browsers(&self) -> Vec<BrowserInfo> {
        browsers_of(&self.inner.lock().unwrap())
    }

    pub fn activity(&self) -> Vec<Activity> {
        activities(&self.inner.lock().unwrap())
    }

    /// Stop (or let go on) an agent's browser use. While paused, every browser
    /// call from that agent is refused with a message telling it to wait.
    pub fn set_paused(&self, agent: &str, paused: bool) {
        let list = {
            let mut inner = self.inner.lock().unwrap();
            let e = inner.activity.entry(agent.to_string()).or_insert_with(|| Activity {
                agent: agent.to_string(), browser: 0, label: String::new(), tool: String::new(), action: String::new(), at: now_ms(), paused,
            });
            e.paused = paused;
            activities(&inner)
        };
        (self.on_change)(HubEvent::Activity(list));
    }

    pub fn asks(&self) -> Vec<Ask> {
        asks(&self.inner.lock().unwrap())
    }

    pub fn set_ask_risky(&self, on: bool) {
        self.inner.lock().unwrap().ask_risky = on;
    }

    /// The user's answer to a held click: send it on, or tell the agent no.
    pub fn answer(&self, id: u64, ok: bool) {
        let list = {
            let mut inner = self.inner.lock().unwrap();
            let Some(h) = inner.held.remove(&id) else { return };
            let agent_tx = inner.peers.get(&h.agent_conn).map(|p| p.tx.clone());
            let expired = now_ms().saturating_sub(h.at) >= HOLD_MS;
            if expired {
                // The agent stopped waiting; its call already failed.
            } else if ok {
                inner.next += 1;
                let hid = inner.next;
                let mut call = h.call.clone();
                call["id"] = json!(hid);
                call["args"]["confirmed"] = json!(true);
                match inner.peers.get(&h.browser) {
                    Some(b) if b.tx.send(call.to_string()).is_ok() => {
                        inner.pending.insert(hid, Pending { asker: Asker::Agent(h.agent_conn, h.cid), browser: h.browser, agent: h.agent, call });
                    }
                    _ => {
                        if let Some(tx) = &agent_tx {
                            let _ = tx.send(fail(&h.cid, "The user allowed it, but the browser has gone.".into()));
                        }
                    }
                }
            } else if let Some(tx) = &agent_tx {
                let _ = tx.send(fail(&h.cid, format!("The user said no to: {}. Don't do it; tell them what you were about to do and why.", h.what)));
            }
            asks(&inner)
        };
        (self.on_change)(HubEvent::Asks(list));
    }

    /// Maestro's own call into a browser on behalf of `agent` (the live view),
    /// answered on a channel. Uses the browser the agent last used.
    pub fn app_call(&self, agent: &str, tool: &str, args: Value, timeout: Duration) -> Result<Value, String> {
        let (tx, rx) = mpsc::channel();
        let hid = {
            let mut inner = self.inner.lock().unwrap();
            let browsers = browsers_of(&inner);
            let target = inner
                .activity
                .get(agent)
                .map(|a| a.browser)
                .filter(|b| browsers.iter().any(|x| x.id == *b))
                .or_else(|| if browsers.len() == 1 { Some(browsers[0].id) } else { None })
                .ok_or_else(|| format!("{agent} isn't using a connected browser."))?;
            inner.next += 1;
            let hid = inner.next;
            let call = json!({ "type": "call", "id": hid, "agent": agent, "tool": tool, "args": args });
            let _ = inner.peers[&target].tx.send(call.to_string());
            inner.pending.insert(hid, Pending { asker: Asker::App(tx), browser: target, agent: agent.to_string(), call });
            hid
        };
        let got = rx.recv_timeout(timeout);
        self.inner.lock().unwrap().pending.remove(&hid);
        match got {
            Ok(v) if v["type"] == "result" => Ok(v["result"].clone()),
            Ok(v) => Err(v["error"].as_str().unwrap_or("The browser did not answer.").to_string()),
            Err(_) => Err("The browser took too long.".into()),
        }
    }

    pub fn add(&self, tx: mpsc::Sender<String>) -> u64 {
        let mut inner = self.inner.lock().unwrap();
        inner.next += 1;
        let id = inner.next;
        inner.peers.insert(id, Peer { tx, role: Role::Unknown });
        id
    }

    pub fn remove(&self, id: u64) {
        let (was_browser, orphans) = {
            let mut inner = self.inner.lock().unwrap();
            let Some(peer) = inner.peers.remove(&id) else { return };
            let label = match &peer.role {
                Role::Browser(b) => Some(b.label()),
                _ => None,
            };
            let held_gone: Vec<u64> = inner.held.iter().filter(|(_, h)| h.browser == id || h.agent_conn == id).map(|(k, _)| *k).collect();
            for k in held_gone {
                let h = inner.held.remove(&k).unwrap();
                if h.browser == id {
                    if let Some(a) = inner.peers.get(&h.agent_conn) {
                        let _ = a.tx.send(fail(&h.cid, "The browser disconnected while waiting for the user.".into()));
                    }
                }
            }
            let gone: Vec<u64> = inner
                .pending
                .iter()
                .filter(|(_, p)| p.browser == id || matches!(&p.asker, Asker::Agent(a, _) if *a == id))
                .map(|(k, _)| *k)
                .collect();
            let mut orphans = vec![];
            for k in gone {
                let p = inner.pending.remove(&k).unwrap();
                let Some(l) = &label else { continue };
                let why = format!("{l} disconnected before it answered.");
                match p.asker {
                    Asker::Agent(a, cid) => {
                        if let Some(agent) = inner.peers.get(&a) {
                            let _ = agent.tx.send(fail(&cid, why));
                        }
                    }
                    Asker::App(tx) => orphans.push((tx, json!({ "type": "error", "error": why }))),
                }
            }
            (label.is_some(), orphans)
        };
        for (tx, v) in orphans {
            let _ = tx.send(v);
        }
        if was_browser {
            (self.on_change)(HubEvent::Browsers(self.browsers()));
        }
    }

    /// Handle one text message from peer `from`. False means: close it.
    pub fn on_message(&self, from: u64, text: &str) -> bool {
        let Ok(v) = serde_json::from_str::<Value>(text) else { return true };
        let ty = v["type"].as_str().unwrap_or("");
        let mut inner = self.inner.lock().unwrap();
        let Some(peer) = inner.peers.get_mut(&from) else { return false };
        match &mut peer.role {
            Role::Unknown => {
                if ty != "hello" || v["token"].as_str() != Some(self.token.as_str()) {
                    return false;
                }
                peer.role = match v["role"].as_str() {
                    Some("browser") => Role::Browser(BrowserInfo { id: from, browser: "Browser".into(), email: String::new(), profile: String::new(), version: String::new() }),
                    Some("agent") => Role::Agent { name: v["agent"].as_str().filter(|s| !s.trim().is_empty()).unwrap_or("Agent").trim().to_string(), pick: None },
                    _ => return false,
                };
                let _ = peer.tx.send(json!({ "type": "hello_ok" }).to_string());
                let is_browser = matches!(peer.role, Role::Browser(_));
                drop(inner);
                if is_browser {
                    (self.on_change)(HubEvent::Browsers(self.browsers()));
                }
                true
            }
            Role::Browser(info) => {
                match ty {
                    "browser_info" => {
                        info.browser = v["browser"].as_str().unwrap_or("Browser").to_string();
                        info.email = v["email"].as_str().unwrap_or("").to_string();
                        info.version = v["version"].as_str().unwrap_or("").to_string();
                        info.profile = (self.profile_of)(&info.browser, &info.email);
                        let tx = peer.tx.clone();
                        let info = info.clone();
                        if let Some(want) = (self.wanted_version)().filter(|w| *w != info.version) {
                            if inner.reloaded.insert(format!("{}|{}|{}", info.browser, info.email, want)) {
                                let _ = tx.send(RELOAD.to_string());
                            }
                        }
                        drop(inner);
                        (self.on_change)(HubEvent::Browsers(self.browsers()));
                    }
                    "result" | "error" => {
                        let Some(hid) = v["id"].as_u64() else { return true };
                        let Some(p) = inner.pending.remove(&hid) else { return true };
                        let confirm = v["result"]["needsConfirm"].clone();
                        let blocker = v["result"]["blocker"].clone();
                        match p.asker {
                            Asker::Agent(a, cid) if confirm.is_object() => {
                                // Hold the click; the agent's call waits for the user.
                                inner.next += 1;
                                let id = inner.next;
                                if let Some(agent) = inner.peers.get(&a) {
                                    let _ = agent.tx.send(json!({ "type": "hold", "id": cid }).to_string());
                                }
                                let what = confirm["what"].as_str().unwrap_or("a click").to_string();
                                let url = confirm["url"].as_str().unwrap_or("").to_string();
                                inner.held.retain(|_, h| now_ms().saturating_sub(h.at) < HOLD_MS);
                                inner.held.insert(id, Held { agent_conn: a, cid, browser: p.browser, agent: p.agent, call: p.call, what, url, at: now_ms() });
                                let list = asks(&inner);
                                drop(inner);
                                (self.on_change)(HubEvent::Asks(list));
                                return true;
                            }
                            Asker::Agent(a, cid) => {
                                if let Some(agent) = inner.peers.get(&a) {
                                    let mut out = v.clone();
                                    out["id"] = cid;
                                    let _ = agent.tx.send(out.to_string());
                                }
                            }
                            Asker::App(tx) => {
                                let _ = tx.send(v);
                            }
                        }
                        if blocker.is_object() {
                            let b = Blocker {
                                agent: p.agent,
                                kind: blocker["kind"].as_str().unwrap_or("").to_string(),
                                url: blocker["url"].as_str().unwrap_or("").to_string(),
                            };
                            drop(inner);
                            (self.on_change)(HubEvent::Blocker(b));
                        }
                    }
                    _ => {}
                }
                true
            }
            Role::Agent { .. } => {
                if ty == "call" && self.call(&mut inner, from, &v) {
                    let list = activities(&inner);
                    drop(inner);
                    (self.on_change)(HubEvent::Activity(list));
                }
                true
            }
        }
    }

    /// Route one agent call. True when the agent's activity changed.
    fn call(&self, inner: &mut Inner, from: u64, v: &Value) -> bool {
        let id = v["id"].clone();
        let tool = v["tool"].as_str().unwrap_or("");
        let args = v.get("args").cloned().unwrap_or(json!({}));
        let browsers = browsers_of(inner);
        let (name, pick) = match &inner.peers[&from].role {
            Role::Agent { name, pick } => (name.clone(), *pick),
            _ => return false,
        };
        let tx = inner.peers[&from].tx.clone();
        let pick = pick.filter(|p| browsers.iter().any(|b| b.id == *p));

        match tool {
            "list_browsers" => {
                let text = if browsers.is_empty() {
                    NONE_CONNECTED.to_string()
                } else {
                    browsers
                        .iter()
                        .map(|b| format!("{} {} (id {}){}", if Some(b.id) == pick { "*" } else { "-" }, b.label(), b.id, if b.email.is_empty() { String::new() } else { format!(", {}", b.email) }))
                        .collect::<Vec<_>>()
                        .join("\n")
                };
                let _ = tx.send(reply(&id, text));
                false
            }
            "select_browser" => {
                let want = args["browser"].as_str().map(|s| s.to_lowercase()).or_else(|| args["browser"].as_u64().map(|n| n.to_string())).unwrap_or_default();
                let hit: Vec<&BrowserInfo> = browsers
                    .iter()
                    .filter(|b| b.id.to_string() == want || b.label().to_lowercase().contains(&want) || (!b.email.is_empty() && b.email.to_lowercase().contains(&want)))
                    .collect();
                match hit.as_slice() {
                    [b] => {
                        if let Some(Peer { role: Role::Agent { pick, .. }, .. }) = inner.peers.get_mut(&from) {
                            *pick = Some(b.id);
                        }
                        let _ = tx.send(reply(&id, format!("{name} now uses {}.", b.label())));
                    }
                    [] => {
                        let _ = tx.send(fail(&id, format!("No connected browser matches \"{want}\". {}", listing(&browsers))));
                    }
                    _ => {
                        let _ = tx.send(fail(&id, format!("\"{want}\" matches more than one browser; be more specific. {}", listing(&browsers))));
                    }
                }
                false
            }
            _ => {
                if inner.activity.get(&name).is_some_and(|a| a.paused) {
                    let _ = tx.send(fail(&id, format!("The user stopped {name}'s browser use from Maestro. Don't use the browser; tell the user where you are and wait until they say to go on.")));
                    return false;
                }
                let target = match (pick, browsers.as_slice()) {
                    (Some(p), _) => p,
                    (None, [only]) => only.id,
                    (None, []) => {
                        let _ = tx.send(fail(&id, NONE_CONNECTED.to_string()));
                        return false;
                    }
                    (None, _) => {
                        let _ = tx.send(fail(&id, format!("More than one browser is connected; pick one with browser_select first. {}", listing(&browsers))));
                        return false;
                    }
                };
                // Running an older extension than the one on disk: update it
                // first (once per version); the agent simply tries again.
                if let Some(b) = browsers.iter().find(|b| b.id == target) {
                    if let Some(want) = (self.wanted_version)().filter(|w| !b.version.is_empty() && *w != b.version) {
                        if inner.reloaded.insert(format!("{}|{}|{}", b.browser, b.email, want)) {
                            let _ = inner.peers[&target].tx.send(RELOAD.to_string());
                            let _ = tx.send(fail(&id, format!("Maestro is updating the browser extension to {want}. Try again in a few seconds.")));
                            return false;
                        }
                    }
                }
                let label = browsers.iter().find(|b| b.id == target).map(|b| b.label()).unwrap_or_default();
                let action = args["action"].as_str().unwrap_or("").to_string();
                inner.activity.insert(name.clone(), Activity { agent: name.clone(), browser: target, label, tool: tool.to_string(), action, at: now_ms(), paused: false });
                inner.next += 1;
                let hid = inner.next;
                let mut args = if args.is_object() { args } else { json!({}) };
                args["_ask"] = json!(inner.ask_risky);
                let call = json!({ "type": "call", "id": hid, "agent": name, "tool": tool, "args": args });
                inner.pending.insert(hid, Pending { asker: Asker::Agent(from, id.clone()), browser: target, agent: name.clone(), call: call.clone() });
                if inner.peers[&target].tx.send(call.to_string()).is_err() {
                    inner.pending.remove(&hid);
                    let _ = tx.send(fail(&id, "That browser just disconnected.".into()));
                }
                true
            }
        }
    }
}

const RELOAD: &str = r#"{"type":"call","id":0,"agent":"Maestro","tool":"reload","args":{}}"#;

const NONE_CONNECTED: &str = "No browser is connected to Maestro. Open Chrome (or Edge/Brave) in a profile that has the \"Maestro for Chrome\" extension; see Maestro Settings → Browser to install it.";

fn listing(browsers: &[BrowserInfo]) -> String {
    let names: Vec<String> = browsers.iter().map(|b| format!("{} (id {})", b.label(), b.id)).collect();
    format!("Connected: {}.", names.join("; "))
}

/// One peer connection: a non-blocking loop that reads its messages into the
/// hub and writes whatever the hub queued for it.
fn serve(hub: Arc<Hub>, stream: TcpStream) {
    let _ = stream.set_nodelay(true);
    let Ok(mut ws) = tungstenite::accept(stream) else { return };
    let (tx, rx) = mpsc::channel::<String>();
    let id = hub.add(tx);
    if ws.get_mut().set_nonblocking(true).is_err() {
        hub.remove(id);
        return;
    }
    'conn: loop {
        let mut idle = true;
        loop {
            match ws.read() {
                Ok(Message::Text(t)) => {
                    idle = false;
                    if !hub.on_message(id, &t) {
                        break 'conn;
                    }
                }
                Ok(Message::Close(_)) => break 'conn,
                Ok(_) => idle = false,
                Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break,
                Err(_) => break 'conn,
            }
        }
        while let Ok(out) = rx.try_recv() {
            idle = false;
            match ws.write(Message::Text(out)) {
                Ok(()) => {}
                Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                Err(_) => break 'conn,
            }
        }
        match ws.flush() {
            Ok(()) => {}
            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
            Err(_) => break 'conn,
        }
        if idle {
            std::thread::sleep(Duration::from_millis(4));
        }
    }
    hub.remove(id);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn peer(hub: &Hub) -> (u64, mpsc::Receiver<String>) {
        let (tx, rx) = mpsc::channel();
        (hub.add(tx), rx)
    }
    fn last(rx: &mpsc::Receiver<String>) -> Value {
        let mut v = Value::Null;
        while let Ok(s) = rx.try_recv() {
            v = serde_json::from_str(&s).unwrap();
        }
        v
    }

    #[test]
    fn a_peer_without_the_token_is_dropped() {
        let hub = Hub::for_test("t", |_, _| String::new());
        let (a, _rx) = peer(&hub);
        assert!(!hub.on_message(a, r#"{"type":"hello","role":"agent","token":"nope"}"#));
    }

    #[test]
    fn a_call_reaches_the_only_browser_and_the_answer_comes_back() {
        let hub = Hub::for_test("t", |b, e| if b == "Google Chrome" && e == "me@x.com" { "GravityCare".into() } else { String::new() });
        let (br, brx) = peer(&hub);
        let (ag, arx) = peer(&hub);
        assert!(hub.on_message(br, r#"{"type":"hello","role":"browser","token":"t"}"#));
        assert!(hub.on_message(br, r#"{"type":"browser_info","browser":"Google Chrome","email":"me@x.com","version":"0.1.0"}"#));
        assert_eq!(hub.browsers()[0].label(), "Google Chrome · GravityCare");
        assert!(hub.on_message(ag, r#"{"type":"hello","role":"agent","token":"t","agent":"Ana"}"#));
        last(&arx);
        last(&brx);

        hub.on_message(ag, r#"{"type":"call","id":7,"tool":"tabs","args":{}}"#);
        let fwd = last(&brx);
        assert_eq!(fwd["agent"], "Ana");
        assert_eq!(fwd["tool"], "tabs");
        let hid = fwd["id"].as_u64().unwrap();

        hub.on_message(br, &json!({ "type": "result", "id": hid, "result": { "content": [] } }).to_string());
        let back = last(&arx);
        assert_eq!(back["type"], "result");
        assert_eq!(back["id"], 7);
    }

    #[test]
    fn with_two_browsers_the_agent_must_pick_one() {
        let hub = Hub::for_test("t", |_, e| if e == "a@x.com" { "Work".into() } else { "GravityCare".into() });
        let (b1, _r1) = peer(&hub);
        let (b2, r2) = peer(&hub);
        let (ag, arx) = peer(&hub);
        for (b, e) in [(b1, "a@x.com"), (b2, "b@x.com")] {
            hub.on_message(b, r#"{"type":"hello","role":"browser","token":"t"}"#);
            hub.on_message(b, &json!({ "type": "browser_info", "browser": "Google Chrome", "email": e }).to_string());
        }
        hub.on_message(ag, r#"{"type":"hello","role":"agent","token":"t","agent":"Ana"}"#);
        hub.on_message(ag, r#"{"type":"call","id":1,"tool":"tabs","args":{}}"#);
        let e = last(&arx);
        assert_eq!(e["type"], "error");
        assert!(e["error"].as_str().unwrap().contains("browser_select"));

        hub.on_message(ag, r#"{"type":"call","id":2,"tool":"select_browser","args":{"browser":"gravitycare"}}"#);
        assert_eq!(last(&arx)["type"], "result");
        hub.on_message(ag, r#"{"type":"call","id":3,"tool":"tabs","args":{}}"#);
        assert_eq!(last(&r2)["tool"], "tabs");
    }

    #[test]
    fn a_stopped_agent_is_refused_until_let_go_on() {
        let hub = Hub::for_test("t", |_, _| "P".into());
        let (br, brx) = peer(&hub);
        let (ag, arx) = peer(&hub);
        hub.on_message(br, r#"{"type":"hello","role":"browser","token":"t"}"#);
        hub.on_message(ag, r#"{"type":"hello","role":"agent","token":"t","agent":"Ana"}"#);
        hub.on_message(ag, r#"{"type":"call","id":1,"tool":"computer","args":{"action":"left_click"}}"#);
        let a = &hub.activity()[0];
        assert_eq!((a.agent.as_str(), a.tool.as_str(), a.action.as_str(), a.paused), ("Ana", "computer", "left_click", false));
        last(&brx);

        hub.set_paused("Ana", true);
        hub.on_message(ag, r#"{"type":"call","id":2,"tool":"navigate","args":{"url":"x"}}"#);
        let e = last(&arx);
        assert_eq!((e["type"].as_str(), e["id"].as_u64()), (Some("error"), Some(2)));
        assert!(e["error"].as_str().unwrap().contains("wait"));
        assert_eq!(last(&brx), Value::Null, "nothing reached the browser");

        hub.set_paused("Ana", false);
        hub.on_message(ag, r#"{"type":"call","id":3,"tool":"navigate","args":{"url":"x"}}"#);
        assert_eq!(last(&brx)["tool"], "navigate");
    }

    #[test]
    fn maestro_can_ask_a_browser_for_an_agent() {
        let hub = std::sync::Arc::new(Hub::for_test("t", |_, _| "P".into()));
        let (br, brx) = peer(&hub);
        hub.on_message(br, r#"{"type":"hello","role":"browser","token":"t"}"#);
        last(&brx);
        let h = hub.clone();
        let t = std::thread::spawn(move || h.app_call("Ana", "peek", json!({}), Duration::from_secs(2)));
        let fwd = loop {
            if let Ok(s) = brx.recv_timeout(Duration::from_secs(2)) { break serde_json::from_str::<Value>(&s).unwrap(); }
        };
        assert_eq!((fwd["tool"].as_str(), fwd["agent"].as_str()), (Some("peek"), Some("Ana")));
        hub.on_message(br, &json!({ "type": "result", "id": fwd["id"], "result": { "content": [] } }).to_string());
        assert_eq!(t.join().unwrap().unwrap(), json!({ "content": [] }));
    }

    #[test]
    fn a_browser_on_an_old_extension_is_told_to_reload_once() {
        let mut hub = Hub::for_test("t", |_, _| "P".into());
        hub.wanted_version = Box::new(|| Some("0.2.0".into()));
        let (br, brx) = peer(&hub);
        hub.on_message(br, r#"{"type":"hello","role":"browser","token":"t"}"#);
        last(&brx);
        hub.on_message(br, r#"{"type":"browser_info","browser":"Google Chrome","email":"a@x.com","version":"0.1.0"}"#);
        assert_eq!(last(&brx)["tool"], "reload");
        hub.on_message(br, r#"{"type":"browser_info","browser":"Google Chrome","email":"a@x.com","version":"0.1.0"}"#);
        assert_eq!(last(&brx), Value::Null, "only once, so a folder that never updates can't loop");
    }

    #[test]
    fn a_call_to_an_out_of_date_browser_updates_it_first() {
        let mut hub = Hub::for_test("t", |_, _| "P".into());
        let want = std::sync::Arc::new(Mutex::new("0.1.0".to_string()));
        let w = want.clone();
        hub.wanted_version = Box::new(move || Some(w.lock().unwrap().clone()));
        let (br, brx) = peer(&hub);
        let (ag, arx) = peer(&hub);
        hub.on_message(br, r#"{"type":"hello","role":"browser","token":"t"}"#);
        hub.on_message(br, r#"{"type":"browser_info","browser":"Google Chrome","email":"a@x.com","version":"0.1.0"}"#);
        hub.on_message(ag, r#"{"type":"hello","role":"agent","token":"t","agent":"Ana"}"#);
        last(&brx);
        last(&arx);
        *want.lock().unwrap() = "0.1.1".into(); // the extension on disk was just edited
        hub.on_message(ag, r#"{"type":"call","id":1,"tool":"tabs","args":{}}"#);
        assert_eq!(last(&brx)["tool"], "reload");
        assert!(last(&arx)["error"].as_str().unwrap().contains("Try again"));
        hub.on_message(ag, r#"{"type":"call","id":2,"tool":"tabs","args":{}}"#);
        assert_eq!(last(&brx)["tool"], "tabs", "only one reload per version");
    }

    #[test]
    fn a_risky_click_waits_for_the_user() {
        let hub = Hub::for_test("t", |_, _| "P".into());
        let (br, brx) = peer(&hub);
        let (ag, arx) = peer(&hub);
        hub.on_message(br, r#"{"type":"hello","role":"browser","token":"t"}"#);
        hub.on_message(ag, r#"{"type":"hello","role":"agent","token":"t","agent":"Ana"}"#);
        last(&arx);
        hub.on_message(ag, r#"{"type":"call","id":5,"tool":"computer","args":{"action":"left_click","ref":"ref_3"}}"#);
        let fwd = last(&brx);
        assert_eq!(fwd["args"]["_ask"], true);
        let held = json!({ "type": "result", "id": fwd["id"], "result": { "content": [], "needsConfirm": { "what": "Click \"Đăng\"", "url": "https://facebook.com" } } });
        hub.on_message(br, &held.to_string());
        assert_eq!(last(&arx), json!({ "type": "hold", "id": 5 }));
        let a = hub.asks();
        assert_eq!((a.len(), a[0].agent.as_str(), a[0].what.as_str()), (1, "Ana", "Click \"Đăng\""));

        hub.answer(a[0].id, true);
        let again = last(&brx);
        assert_eq!((again["args"]["confirmed"].as_bool(), again["args"]["ref"].as_str()), (Some(true), Some("ref_3")));
        hub.on_message(br, &json!({ "type": "result", "id": again["id"], "result": { "content": [] } }).to_string());
        assert_eq!((last(&arx)["type"].as_str(), hub.asks().len()), (Some("result"), 0));

        // An OK that comes after the agent gave up clicks nothing.
        hub.on_message(ag, r#"{"type":"call","id":9,"tool":"computer","args":{"action":"left_click","ref":"ref_9"}}"#);
        let fwd = last(&brx);
        hub.on_message(br, &json!({ "type": "result", "id": fwd["id"], "result": { "content": [], "needsConfirm": { "what": "Click \"Mua\"" } } }).to_string());
        let late = hub.asks()[0].id;
        hub.inner.lock().unwrap().held.get_mut(&late).unwrap().at -= HOLD_MS;
        assert!(hub.asks().is_empty(), "an expired ask is no longer shown");
        hub.answer(late, true);
        assert_eq!(last(&brx), Value::Null, "a late OK never reaches the page");
        last(&arx);

        hub.on_message(ag, r#"{"type":"call","id":6,"tool":"computer","args":{"action":"left_click","ref":"ref_4"}}"#);
        let fwd = last(&brx);
        hub.on_message(br, &json!({ "type": "result", "id": fwd["id"], "result": { "content": [], "needsConfirm": { "what": "Click \"Gửi\"" } } }).to_string());
        hub.answer(hub.asks()[0].id, false);
        let no = last(&arx);
        assert_eq!((no["type"].as_str(), no["id"].as_u64()), (Some("error"), Some(6)));
        assert_eq!(last(&brx), Value::Null, "a refused click never reaches the page");
    }

    #[test]
    fn a_browser_that_leaves_fails_its_pending_calls() {
        let hub = Hub::for_test("t", |_, _| "P".into());
        let (br, _brx) = peer(&hub);
        let (ag, arx) = peer(&hub);
        hub.on_message(br, r#"{"type":"hello","role":"browser","token":"t"}"#);
        hub.on_message(ag, r#"{"type":"hello","role":"agent","token":"t","agent":"Ana"}"#);
        hub.on_message(ag, r#"{"type":"call","id":"x","tool":"tabs","args":{}}"#);
        hub.remove(br);
        let e = last(&arx);
        assert_eq!(e["type"], "error");
        assert_eq!(e["id"], "x");
    }
}
