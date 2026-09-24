//! Native messaging host: the process Chrome starts when the "Maestro for
//! Chrome" extension connects to `com.maestro.browser`.
//!
//! It is this same maestro.exe, started with the extension's origin as its
//! argument, and it never opens a window. It relays frames both ways:
//! - Chrome's frames (a 4-byte little-endian length, then JSON) go to the
//!   Maestro hub as WebSocket text;
//! - the hub's text goes back to Chrome as frames.
//!
//! When Maestro isn't running, the host tells the extension "hub_down" and
//! keeps retrying, so opening Maestro later connects by itself. The host
//! remembers the extension's `browser_info` and replays it on every
//! reconnect.

use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, TcpStream};
use std::sync::mpsc;
use std::time::{Duration, Instant};

use serde_json::{json, Value};
use tungstenite::Message;

/// Chrome launches the host with the calling extension's origin as the
/// first argument.
pub fn wanted() -> bool {
    std::env::args().skip(1).any(|a| a.starts_with("chrome-extension://") || a == "--chrome-native-host")
}

fn write_frame(out: &mut impl Write, text: &str) -> std::io::Result<()> {
    out.write_all(&(text.len() as u32).to_le_bytes())?;
    out.write_all(text.as_bytes())?;
    out.flush()
}

fn read_frame(inp: &mut impl Read) -> Option<String> {
    let mut len = [0u8; 4];
    inp.read_exact(&mut len).ok()?;
    let n = u32::from_le_bytes(len) as usize;
    let mut buf = vec![0u8; n];
    inp.read_exact(&mut buf).ok()?;
    Some(String::from_utf8_lossy(&buf).into_owned())
}

fn to_chrome(text: &str) {
    if write_frame(&mut std::io::stdout().lock(), text).is_err() {
        std::process::exit(0); // Chrome closed the port
    }
}

fn dial() -> Result<tungstenite::WebSocket<TcpStream>, String> {
    let f = super::hub::hub_file().ok_or("no home folder")?;
    let raw = std::fs::read_to_string(&f).map_err(|_| "Maestro isn't open".to_string())?;
    let v: Value = serde_json::from_str(&raw).map_err(|e| e.to_string())?;
    let port = v["port"].as_u64().ok_or("bad hub file")? as u16;
    let token = v["token"].as_str().ok_or("bad hub file")?.to_string();
    let stream = TcpStream::connect_timeout(&(Ipv4Addr::LOCALHOST, port).into(), Duration::from_secs(2))
        .map_err(|_| "Maestro isn't open".to_string())?;
    let _ = stream.set_nodelay(true);
    let (mut ws, _) = tungstenite::client(format!("ws://127.0.0.1:{port}/"), stream).map_err(|e| e.to_string())?;
    ws.send(Message::Text(json!({ "type": "hello", "role": "browser", "token": token }).to_string()))
        .map_err(|e| e.to_string())?;
    ws.get_mut().set_nonblocking(true).map_err(|e| e.to_string())?;
    Ok(ws)
}

pub fn run() -> ! {
    // Chrome's side: a blocking reader thread feeding a channel (None = EOF).
    let (tx, rx) = mpsc::channel::<Option<String>>();
    std::thread::spawn(move || {
        let mut stdin = std::io::stdin().lock();
        loop {
            let f = read_frame(&mut stdin);
            let end = f.is_none();
            if tx.send(f).is_err() || end {
                break;
            }
        }
    });
    let mut info: Option<String> = None;
    let remember = |t: &str, info: &mut Option<String>| {
        if t.contains("\"browser_info\"") {
            *info = Some(t.to_string());
        }
    };

    loop {
        match dial() {
            Ok(mut ws) => {
                to_chrome(&json!({ "type": "hub_up" }).to_string());
                if let Some(i) = &info {
                    let _ = ws.write(Message::Text(i.clone()));
                }
                'relay: loop {
                    let mut idle = true;
                    loop {
                        match ws.read() {
                            Ok(Message::Text(t)) => {
                                idle = false;
                                if !t.contains("\"hello_ok\"") {
                                    to_chrome(&t);
                                }
                            }
                            Ok(Message::Close(_)) => break 'relay,
                            Ok(_) => idle = false,
                            Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => break,
                            Err(_) => break 'relay,
                        }
                    }
                    loop {
                        match rx.try_recv() {
                            Ok(Some(t)) => {
                                idle = false;
                                remember(&t, &mut info);
                                match ws.write(Message::Text(t)) {
                                    Ok(()) => {}
                                    Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                                    Err(_) => break 'relay,
                                }
                            }
                            Ok(None) | Err(mpsc::TryRecvError::Disconnected) => std::process::exit(0),
                            Err(mpsc::TryRecvError::Empty) => break,
                        }
                    }
                    match ws.flush() {
                        Ok(()) => {}
                        Err(tungstenite::Error::Io(e)) if e.kind() == ErrorKind::WouldBlock => {}
                        Err(_) => break 'relay,
                    }
                    if idle {
                        std::thread::sleep(Duration::from_millis(4));
                    }
                }
                to_chrome(&json!({ "type": "hub_down", "detail": "Maestro closed" }).to_string());
            }
            Err(why) => {
                to_chrome(&json!({ "type": "hub_down", "detail": why }).to_string());
                // Wait a bit before dialling again, still listening to Chrome.
                let until = Instant::now() + Duration::from_secs(2);
                while Instant::now() < until {
                    match rx.recv_timeout(Duration::from_millis(200)) {
                        Ok(Some(t)) => remember(&t, &mut info),
                        Ok(None) | Err(mpsc::RecvTimeoutError::Disconnected) => std::process::exit(0),
                        Err(mpsc::RecvTimeoutError::Timeout) => {}
                    }
                }
            }
        }
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn frames_round_trip() {
        let mut buf = Vec::new();
        super::write_frame(&mut buf, r#"{"type":"x"}"#).unwrap();
        assert_eq!(&buf[..4], &12u32.to_le_bytes());
        assert_eq!(super::read_frame(&mut buf.as_slice()).as_deref(), Some(r#"{"type":"x"}"#));
    }
}
