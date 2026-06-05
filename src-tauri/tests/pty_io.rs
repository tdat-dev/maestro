#![cfg(windows)]
//! Proves the PTY streams real child output AND tears down cleanly.
//!
//! ConPTY gotcha (verified): on startup ConPTY emits a cursor-position-report
//! query (ESC[6n) and STALLS rendering until the terminal answers it. The real
//! app answers via xterm.js (term.onData -> pty_input). Here we answer it the
//! same way (write a cursor-position report to the pty input), then poll for the
//! program's output. Teardown is driven by dropping the master (the app's kill()
//! path), which flushes output and gives the reader EOF — and must not hang.

use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::{Duration, Instant};

use maestro_lib::core::command_spec::CommandSpec;
use maestro_lib::core::pty_session::PtySession;
use portable_pty::PtySize;

#[test]
#[serial_test::serial]
fn pty_streams_output_and_tears_down_cleanly() {
    let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
    let spec = CommandSpec::new("cmd.exe").arg("/C").arg("echo hello");

    let (mut session, mut reader, child) = PtySession::spawn(&spec, size).expect("spawn pty");

    // Load-bearing: the child handle must be available for Job assignment.
    assert!(child.as_raw_handle().is_some(), "child raw handle must be Some");

    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break, // EOF after master/ConPTY closes
                Ok(n) => {
                    let _ = tx.send(buf[..n].to_vec());
                }
                Err(_) => break,
            }
        }
    });

    // Answer ConPTY's startup DSR query so it stops stalling and renders the
    // program output (exactly what xterm.js does in the real app).
    let _ = session.write_input(b"\x1b[1;1R");

    // Poll for the program output up to a deadline.
    let mut all = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(4);
    while Instant::now() < deadline {
        while let Ok(c) = rx.try_recv() {
            all.extend_from_slice(&c);
        }
        if String::from_utf8_lossy(&all).contains("hello") {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    // Teardown: dropping the master must flush + drive the reader to EOF within a
    // bounded time (this is the exact property kill() relies on — never hangs).
    session.shutdown();
    let start = Instant::now();
    while !reader_thread.is_finished() && start.elapsed() < Duration::from_secs(5) {
        thread::sleep(Duration::from_millis(25));
    }
    assert!(
        reader_thread.is_finished(),
        "reader must reach EOF after master drop (teardown must not hang)"
    );
    let _ = reader_thread.join();
    while let Ok(c) = rx.try_recv() {
        all.extend_from_slice(&c);
    }

    let text = String::from_utf8_lossy(&all);
    assert!(
        text.contains("hello"),
        "PTY output should contain 'hello', got: {text:?}"
    );

    drop(child);
}
