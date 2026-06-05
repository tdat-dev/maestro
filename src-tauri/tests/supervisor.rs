#![cfg(windows)]
//! Supervisor state machine + teardown. We assert the single-session rules and,
//! crucially, that kill() RETURNS promptly (drops the Job -> tree dies ->
//! child.wait() returns; drops the master -> reader reaches EOF -> both threads
//! join). Output-streaming is proven by pty_io; here, with no terminal answering
//! ConPTY's startup query, we don't assert on streamed bytes.

use std::time::{Duration, Instant};

use maestro_lib::core::command_spec::CommandSpec;
use maestro_lib::core::supervisor::Supervisor;
use portable_pty::PtySize;

fn size() -> PtySize {
    PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }
}

// A bounded, long-ish process that also spawns a child (ping), so kill() must
// tear down a real tree.
fn long_spec() -> CommandSpec {
    CommandSpec::new("cmd.exe")
        .arg("/C")
        .arg("echo hi & ping -n 20 127.0.0.1")
}

#[test]
#[serial_test::serial]
fn single_session_rules_and_prompt_teardown() {
    let mut sup = Supervisor::new();

    sup.spawn(&long_spec(), size(), |_| {}, |_| {})
        .expect("first spawn ok");
    assert!(sup.is_running(), "should be running after spawn");

    // Spawning again while running must be rejected.
    assert!(
        sup.spawn(&long_spec(), size(), |_| {}, |_| {}).is_err(),
        "second spawn must be rejected while running"
    );

    // kill() MUST return promptly (this is the teardown-doesn't-hang guarantee).
    let start = Instant::now();
    sup.kill().expect("kill ok");
    assert!(
        start.elapsed() < Duration::from_secs(8),
        "kill() must not hang (took {:?})",
        start.elapsed()
    );
    assert!(!sup.is_running(), "should be idle after kill");

    // After kill, a fresh spawn is allowed again.
    sup.spawn(&long_spec(), size(), |_| {}, |_| {})
        .expect("respawn after kill ok");
    sup.kill().expect("final kill ok");
    assert!(!sup.is_running());

    // kill() is idempotent.
    sup.kill().expect("idempotent kill ok");
}
