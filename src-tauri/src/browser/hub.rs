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

struct Pending {
    agent: u64,
    id: Value,
    browser: u64,
}

#[derive(Default)]
struct Inner {
    peers: HashMap<u64, Peer>,
    pending: HashMap<u64, Pending>,
    next: u64,
}

type OnChange = Box<dyn Fn(Vec<BrowserInfo>) + Send + Sync>;

pub struct Hub {
    inner: Mutex<Inner>,
    token: String,
    pub port: u16,
    on_change: OnChange,
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
        Hub { inner: Mutex::new(Inner::default()), token, port, on_change, profile_of: Box::new(super::profiles::profile_name) }
    }

    #[cfg(test)]
    pub fn for_test(token: &str, profile_of: impl Fn(&str, &str) -> String + Send + Sync + 'static) -> Self {
        Hub { inner: Mutex::new(Inner::default()), token: token.into(), port: 0, on_change: Box::new(|_| {}), profile_of: Box::new(profile_of) }
    }

    /// Bind 127.0.0.1 on a free port, publish it, and serve in the background.
    pub fn start(on_change: OnChange) -> std::io::Result<Arc<Hub>> {
        let listener = TcpListener::bind((Ipv4Addr::LOCALHOST, 0))?;
        let port = listener.local_addr()?.port();
        let hub = Arc::new(Hub::new(random_token(), port, on_change));
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
        let inner = self.inner.lock().unwrap();
        let mut list: Vec<BrowserInfo> = inner
            .peers
            .values()
            .filter_map(|p| match &p.role {
                Role::Browser(b) => Some(b.clone()),
                _ => None,
            })
            .collect();
        list.sort_by_key(|b| b.id);
        list
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
            let gone: Vec<u64> = inner.pending.iter().filter(|(_, p)| p.browser == id || p.agent == id).map(|(k, _)| *k).collect();
            let mut orphans = vec![];
            for k in gone {
                let p = inner.pending.remove(&k).unwrap();
                if let (Some(l), Some(agent)) = (&label, inner.peers.get(&p.agent)) {
                    orphans.push((agent.tx.clone(), fail(&p.id, format!("{l} disconnected before it answered."))));
                }
            }
            (label.is_some(), orphans)
        };
        for (tx, msg) in orphans {
            let _ = tx.send(msg);
        }
        if was_browser {
            (self.on_change)(self.browsers());
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
                    (self.on_change)(self.browsers());
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
                        drop(inner);
                        (self.on_change)(self.browsers());
                    }
                    "result" | "error" => {
                        let Some(hid) = v["id"].as_u64() else { return true };
                        let Some(p) = inner.pending.remove(&hid) else { return true };
                        if let Some(agent) = inner.peers.get(&p.agent) {
                            let mut out = v.clone();
                            out["id"] = p.id;
                            let _ = agent.tx.send(out.to_string());
                        }
                    }
                    _ => {}
                }
                true
            }
            Role::Agent { .. } => {
                if ty == "call" {
                    self.call(&mut inner, from, &v);
                }
                true
            }
        }
    }

    fn call(&self, inner: &mut Inner, from: u64, v: &Value) {
        let id = v["id"].clone();
        let tool = v["tool"].as_str().unwrap_or("");
        let args = v.get("args").cloned().unwrap_or(json!({}));
        let browsers: Vec<BrowserInfo> = {
            let mut l: Vec<BrowserInfo> = inner.peers.values().filter_map(|p| match &p.role { Role::Browser(b) => Some(b.clone()), _ => None }).collect();
            l.sort_by_key(|b| b.id);
            l
        };
        let (name, pick) = match &inner.peers[&from].role {
            Role::Agent { name, pick } => (name.clone(), *pick),
            _ => return,
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
            }
            _ => {
                let target = match (pick, browsers.as_slice()) {
                    (Some(p), _) => p,
                    (None, [only]) => only.id,
                    (None, []) => {
                        let _ = tx.send(fail(&id, NONE_CONNECTED.to_string()));
                        return;
                    }
                    (None, _) => {
                        let _ = tx.send(fail(&id, format!("More than one browser is connected; pick one with browser_select first. {}", listing(&browsers))));
                        return;
                    }
                };
                inner.next += 1;
                let hid = inner.next;
                inner.pending.insert(hid, Pending { agent: from, id: id.clone(), browser: target });
                let msg = json!({ "type": "call", "id": hid, "agent": name, "tool": tool, "args": args }).to_string();
                if inner.peers[&target].tx.send(msg).is_err() {
                    inner.pending.remove(&hid);
                    let _ = tx.send(fail(&id, "That browser just disconnected.".into()));
                }
            }
        }
    }
}

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
