#![cfg(windows)]
//! Multi-agent registry: many agents run concurrently, each killed independently,
//! and kill (drop) tears each down promptly without hanging.

use std::time::{Duration, Instant};

use maestro_lib::core::command_spec::CommandSpec;
use maestro_lib::core::registry::Registry;
use portable_pty::PtySize;

fn size() -> PtySize {
    PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 }
}

// Bounded, long-ish process that also spawns a child (ping) so kill tears a tree.
fn long_spec() -> CommandSpec {
    CommandSpec::new("cmd.exe")
        .arg("/C")
        .arg("echo hi & ping -n 20 127.0.0.1")
}

#[test]
#[serial_test::serial]
fn many_agents_run_and_each_kills_independently() {
    let mut reg = Registry::new();

    reg.spawn("a".into(), &long_spec(), size(), |_| {}, |_| {})
        .expect("spawn a");
    reg.spawn("b".into(), &long_spec(), size(), |_| {}, |_| {})
        .expect("spawn b");
    reg.spawn("c".into(), &long_spec(), size(), |_| {}, |_| {})
        .expect("spawn c");
    assert_eq!(reg.count(), 3, "three agents should run concurrently");

    // Duplicate id is rejected.
    assert!(
        reg.spawn("a".into(), &long_spec(), size(), |_| {}, |_| {}).is_err(),
        "duplicate agent id must be rejected"
    );

    // Input routes to a specific agent.
    reg.write_input("b", b"echo routed\r\n").expect("input to b");

    // Killing one leaves the others running.
    let start = Instant::now();
    reg.kill("a");
    assert_eq!(reg.count(), 2, "killing one removes exactly one");
    assert!(reg.has("b") && reg.has("c"));

    reg.kill("b");
    reg.kill("c");
    assert_eq!(reg.count(), 0, "all agents killed");

    assert!(
        start.elapsed() < Duration::from_secs(10),
        "kills must not hang (took {:?})",
        start.elapsed()
    );

    // Killing an unknown id is a no-op.
    reg.kill("ghost");
    // Operating on a missing agent errors cleanly.
    assert!(reg.write_input("a", b"x").is_err());
}
