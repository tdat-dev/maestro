#![cfg(windows)]
//! Tab-detach hand-off: `attach` must replay the buffered scrollback through
//! the new sink and route all subsequent output there (old sink goes silent).

use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use maestro_lib::core::command_spec::CommandSpec;
use maestro_lib::core::registry::Registry;
use portable_pty::PtySize;

fn size() -> PtySize {
    PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }
}

fn contains(haystack: &[u8], needle: &[u8]) -> bool {
    haystack.windows(needle.len()).any(|w| w == needle)
}

/// Poll `cond` until it holds or the timeout elapses.
fn wait_for(mut cond: impl FnMut() -> bool, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if cond() {
            return true;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    false
}

#[test]
#[serial_test::serial]
fn attach_replays_scrollback_and_reroutes_output() {
    let mut reg = Registry::new();

    let first: Arc<Mutex<Vec<u8>>> = Arc::default();
    let f = first.clone();
    // Prints a marker immediately, then keeps emitting (one ping line/second).
    let spec = CommandSpec::new("cmd.exe")
        .arg("/C")
        .arg("echo detach-marker & ping -n 30 127.0.0.1");
    reg.spawn(
        "a".into(),
        &spec,
        size(),
        move |b| f.lock().unwrap().extend_from_slice(b),
        |_| {},
    )
    .expect("spawn a");

    // Answer ConPTY's startup DSR query (ESC[6n) so it starts rendering —
    // exactly what xterm.js does in the real app (see pty_io.rs).
    reg.write_input("a", b"\x1b[1;1R").expect("answer DSR");

    assert!(
        wait_for(|| contains(&first.lock().unwrap(), b"detach-marker"), Duration::from_secs(10)),
        "marker should reach the original sink"
    );

    // Attach a new sink (the "detached window"). Replay must deliver the
    // marker that was emitted BEFORE the attach.
    let second: Arc<Mutex<Vec<u8>>> = Arc::default();
    let s = second.clone();
    reg.attach("a", Box::new(move |b| s.lock().unwrap().extend_from_slice(b)))
        .expect("attach");
    assert!(
        contains(&second.lock().unwrap(), b"detach-marker"),
        "attach must replay buffered scrollback synchronously"
    );

    // Live output now flows to the new sink only.
    let first_len = first.lock().unwrap().len();
    let second_len = second.lock().unwrap().len();
    assert!(
        wait_for(|| second.lock().unwrap().len() > second_len, Duration::from_secs(10)),
        "new sink should keep receiving live output"
    );
    assert_eq!(
        first.lock().unwrap().len(),
        first_len,
        "old sink must go silent after attach"
    );

    // Attaching to an unknown agent errors cleanly.
    assert!(reg.attach("ghost", Box::new(|_| {})).is_err());

    reg.kill("a");
}
