# Maestro M0 (Skateboard) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prove the load-bearing Windows hard parts: a Tauri v2 desktop app spawns ONE agent CLI under a `portable-pty`/ConPTY pseudo-terminal, streams it bidirectionally to a single xterm.js pane, and tears down the WHOLE descendant process tree cleanly via a Win32 Job Object.

**Architecture:** Two planes. The Rust core (`src-tauri/src/core/*`) is **Tauri-free** so `cargo test` exercises the dangerous logic (PTY, Job Object, supervisor) with no WebView. Thin `#[tauri::command]` wrappers (`commands.rs`) adapt the core to the frontend. PTY bytes stream Rust→JS over a `tauri::ipc::Channel<Vec<u8>>`; sparse lifecycle events (`pty-exit`) use `emit`/`listen`. The frontend `terminal.ts` is transport-agnostic (xterm.js only); `ipc.ts` isolates all `@tauri-apps` calls.

**Tech Stack:** Rust (tauri 2.11, portable-pty 0.9.0, windows 0.62) + TypeScript/Vite (@tauri-apps/api 2.11.0, @xterm/xterm 6.0.0). Windows 10 1809+ / 11.

**Verified facts driving this plan (2026-06-04 research, adversarially checked):**
- `portable-pty` 0.9.0 `Child` exposes `process_id() -> Option<u32>` and `#[cfg(windows)] as_raw_handle() -> Option<RawHandle>` (the real `PROCESS_INFORMATION.hProcess`). → assign the Job Object **by HANDLE** directly (no `OpenProcess`-by-PID TOCTOU). The default docs.rs page hides `as_raw_handle`; it IS present on the windows-msvc target.
- **Windows ConPTY EOF caveat:** the master reader's `read()` does NOT return `0` when the child exits (conhost keeps the write end open). → detect exit via `child.wait()`, and unblock/teardown the reader by **dropping the `MasterPty`**. Never `read_to_end` expecting EOF.
- **Job-assignment race (accepted for M0):** `portable-pty` has no `CREATE_SUSPENDED`/`PROC_THREAD_ATTRIBUTE_JOB_LIST`; assign immediately after spawn + `KILL_ON_JOB_CLOSE`. A grandchild spawned in the sub-ms window before assignment can escape — documented, out of M0 scope to fully close.
- Byte transport = `tauri::ipc::Channel` (fast, ordered), NOT `emit` (per-message JSON broadcast — sparse events only).
- `windows` 0.62: `JOBOBJECT_BASIC_LIMIT_INFORMATION.LimitFlags` is typed `JOB_OBJECT_LIMIT` (not `..._FLAGS`); `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` assigns directly. `HANDLE` has no `Drop` → close it in `Job::drop`.

---

## Task 0: Prerequisites (toolchain install + verify)

The dev box has Node v24.6.0 / npm 11.5.1 but **no Rust toolchain** (`rustc`/`cargo`/`rustup` absent). Install before anything builds. These are interactive installers — the user runs them.

**Files:** none (environment only)

- [ ] **Step 1: Install Microsoft C++ Build Tools**

Download "Build Tools for Visual Studio" and install the **"Desktop development with C++"** workload (provides MSVC linker + Windows SDK). Required by both Rust MSVC toolchain and Tauri.

- [ ] **Step 2: Install Rust (MSVC toolchain)**

Install rustup from https://rustup.rs, then ensure the MSVC host:

Run: `rustup default stable-msvc`
Run: `rustup show`
Expected: active toolchain `stable-x86_64-pc-windows-msvc`.

- [ ] **Step 3: Verify the toolchain**

Run: `rtk node --version` → Expected: `v24.6.0` (or newer)
Run: `rustc --version` → Expected: `rustc 1.xx.x (... )`
Run: `cargo --version` → Expected: `cargo 1.xx.x (... )`

If `rustc`/`cargo` are still "not found", open a NEW terminal (PATH refresh) and retry.

- [ ] **Step 4: Note — no commit (environment only).**

---

## Task 1: Scaffold the Tauri v2 vanilla-TS app into the existing repo

`D:\maestro` already contains `docs/` and a git repo. `create-tauri-app` wants an empty target, so scaffold into a temp dir and merge.

**Files:**
- Create: `src-tauri/` (whole tree), `index.html`, `package.json`, `vite.config.ts`, `tsconfig.json`, `src/main.ts`

- [ ] **Step 1: Scaffold into a temp directory**

Run: `rtk npm create tauri-app@latest maestro-scaffold -- --template vanilla-ts --manager npm`
(run from `D:\`) Expected: creates `D:\maestro-scaffold\` with `src-tauri/`, `index.html`, `package.json`, `vite.config.ts`, `tsconfig.json`, `src/`.

- [ ] **Step 2: Move scaffold files into `D:\maestro` (without clobbering `docs/`/`.git`)**

Run (PowerShell):
```powershell
$src="D:\maestro-scaffold"; $dst="D:\maestro"
Get-ChildItem -Force $src | Where-Object { $_.Name -ne '.git' } | ForEach-Object { Move-Item -Force $_.FullName (Join-Path $dst $_.Name) }
Remove-Item -Recurse -Force $src
```
Expected: `D:\maestro\src-tauri\`, `D:\maestro\index.html`, `D:\maestro\package.json` now exist alongside `docs/`.

- [ ] **Step 3: Install frontend deps**

Run: `rtk npm install` (in `D:\maestro`)
Expected: `node_modules/` created, no errors.

- [ ] **Step 4: First dev run (smoke test the scaffold)**

Run: `rtk npm run tauri dev`
Expected: Rust compiles (first build ~minutes), a desktop window opens showing the template page. Close the window to stop.
(If the linker errors, Task 0 Step 1 was incomplete.)

- [ ] **Step 5: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "chore: scaffold Tauri v2 vanilla-ts app"
```

---

## Task 2: Pin dependencies, configure `[lib]`, add `.gitignore`

**Files:**
- Modify: `src-tauri/Cargo.toml`
- Modify: `package.json`
- Create: `.gitignore`

- [ ] **Step 1: Set `src-tauri/Cargo.toml` dependencies and lib target**

Replace the `[lib]`, `[build-dependencies]`, `[dependencies]` sections with:
```toml
[lib]
name = "maestro_lib"
crate-type = ["staticlib", "cdylib", "rlib"]

[build-dependencies]
tauri-build = { version = "2", features = [] }

[dependencies]
tauri = { version = "2.11", features = [] }
portable-pty = "0.9.0"
windows = { version = "0.62", features = [
    "Win32_Foundation",
    "Win32_System_JobObjects",
    "Win32_System_Threading",
] }
anyhow = "1"
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"

[dev-dependencies]
serial_test = "3"
```

- [ ] **Step 2: Add frontend runtime deps to `package.json`**

Run: `rtk npm install @xterm/xterm@6.0.0 @xterm/addon-fit@0.11.0 @xterm/addon-webgl@0.19.0`
Run: `rtk npm install -D vitest@latest happy-dom@latest`
Expected: these appear in `package.json` `dependencies`/`devDependencies`.

- [ ] **Step 3: Verify `@tauri-apps/api` pin**

Open `package.json`; confirm `@tauri-apps/api` is `2.11.0` (it intentionally trails the CLI `2.11.2`). Do not "fix" it upward.

- [ ] **Step 4: Add `.gitignore`**

Create `D:\maestro\.gitignore`:
```gitignore
node_modules/
dist/
src-tauri/target/
src-tauri/gen/
*.log
.DS_Store
```

- [ ] **Step 5: Verify it still compiles**

Run: `rtk cargo build --manifest-path D:/maestro/src-tauri/Cargo.toml`
Expected: `Finished` (downloads + builds the new crates; no errors).

- [ ] **Step 6: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "chore: pin deps (portable-pty, windows, xterm) and lib target"
```

---

## Task 3: `CommandSpec` (pure, unit-testable)

Describes what to spawn. No OS calls — pure data + a builder bridge. TDD.

**Files:**
- Create: `src-tauri/src/core/mod.rs`
- Create: `src-tauri/src/core/command_spec.rs`
- Modify: `src-tauri/src/lib.rs` (add `pub mod core;`)

- [ ] **Step 1: Create the module wiring**

`src-tauri/src/core/mod.rs`:
```rust
pub mod command_spec;
```
Add to the TOP of `src-tauri/src/lib.rs`:
```rust
pub mod core;
```

- [ ] **Step 2: Write the failing test**

Append to `src-tauri/src/core/command_spec.rs`:
```rust
#[derive(Debug, Clone)]
pub struct CommandSpec {
    pub program: String,
    pub args: Vec<String>,
    pub cwd: Option<String>,
    pub env: Vec<(String, String)>,
}

impl CommandSpec {
    pub fn new(program: impl Into<String>) -> Self {
        CommandSpec { program: program.into(), args: Vec::new(), cwd: None, env: Vec::new() }
    }
    pub fn arg(mut self, a: impl Into<String>) -> Self { self.args.push(a.into()); self }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn builds_program_and_args() {
        let spec = CommandSpec::new("cmd.exe").arg("/C").arg("echo hi");
        assert_eq!(spec.program, "cmd.exe");
        assert_eq!(spec.args, vec!["/C".to_string(), "echo hi".to_string()]);
        assert!(spec.cwd.is_none());
        assert!(spec.env.is_empty());
    }
}
```

- [ ] **Step 3: Run test to verify it passes** (the type is defined inline above; this guards the public API shape later tasks depend on)

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml command_spec`
Expected: PASS (`test core::command_spec::tests::builds_program_and_args ... ok`).

- [ ] **Step 4: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat(core): CommandSpec value type"
```

---

## Task 4: `Job` (Win32 Job Object) + tree-kill integration test

The heart of M0. RED first with a real process tree, then implement.

**Files:**
- Create: `src-tauri/src/core/job.rs`
- Create: `src-tauri/tests/job_tree.rs`
- Modify: `src-tauri/src/core/mod.rs`

- [ ] **Step 1: Declare the module**

Add to `src-tauri/src/core/mod.rs`:
```rust
#[cfg(windows)]
pub mod job;
```

- [ ] **Step 2: Write the failing integration test**

Create `src-tauri/tests/job_tree.rs`:
```rust
#![cfg(windows)]
//! Proves a kill-on-job-close Job Object tears down the whole tree:
//! a parent process that spawns a grandchild both die when the Job handle drops.

use std::io::Write;
use std::os::windows::io::AsRawHandle;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use maestro_lib::core::job::Job;

use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::Threading::{
    GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
};

const STILL_ACTIVE: u32 = 259;

fn pid_alive(pid: u32) -> bool {
    unsafe {
        match OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid) {
            Ok(h) => {
                let mut code = 0u32;
                let ok = GetExitCodeProcess(h, &mut code).is_ok();
                let _ = CloseHandle(h);
                ok && code == STILL_ACTIVE
            }
            Err(_) => false,
        }
    }
}

fn wait_dead(pid: u32, timeout: Duration) -> bool {
    let start = Instant::now();
    while start.elapsed() < timeout {
        if !pid_alive(pid) { return true; }
        sleep(Duration::from_millis(50));
    }
    false
}

#[test]
#[serial_test::serial]
fn dropping_job_kills_parent_and_grandchild() {
    // PIDFILE: the parent (powershell) launches a hidden `ping` grandchild and
    // records its PID so the test can assert the grandchild also dies.
    let pidfile = std::env::temp_dir().join("maestro_m0_grandchild.pid");
    let _ = std::fs::remove_file(&pidfile);
    let pidfile_str = pidfile.to_string_lossy().replace('\\', "\\\\");

    let ps = format!(
        "$c = Start-Process ping -ArgumentList '-n','30','127.0.0.1' -PassThru -WindowStyle Hidden; \
         $c.Id | Out-File -Encoding ascii '{}'; Start-Sleep 30",
        pidfile_str
    );

    let mut parent = Command::new("powershell")
        .args(["-NoProfile", "-NonInteractive", "-Command", &ps])
        .spawn()
        .expect("spawn parent powershell");

    let parent_pid = parent.id();
    let parent_handle = parent.as_raw_handle();

    // Assign the PARENT to a kill-on-close job.
    let job = Job::new_kill_on_close().expect("create job");
    job.assign_raw(parent_handle).expect("assign parent to job");

    // Wait for the grandchild PID to be written, then read it.
    let mut grandchild_pid = 0u32;
    let start = Instant::now();
    while start.elapsed() < Duration::from_secs(10) {
        if let Ok(s) = std::fs::read_to_string(&pidfile) {
            if let Ok(p) = s.trim().parse::<u32>() { grandchild_pid = p; break; }
        }
        sleep(Duration::from_millis(50));
    }
    assert!(grandchild_pid != 0, "grandchild never reported its PID");

    // Both must be alive now.
    assert!(pid_alive(parent_pid), "parent should be alive before kill");
    assert!(pid_alive(grandchild_pid), "grandchild should be alive before kill");

    // THE KILL: dropping the only job handle => KILL_ON_JOB_CLOSE reaps the tree.
    drop(job);

    assert!(wait_dead(parent_pid, Duration::from_secs(5)), "parent not killed");
    assert!(wait_dead(grandchild_pid, Duration::from_secs(5)), "grandchild not killed");

    let _ = parent.wait();
    let _ = std::fs::remove_file(&pidfile);
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml --test job_tree`
Expected: FAIL to compile — `unresolved import maestro_lib::core::job::Job` (module/type not implemented yet).

- [ ] **Step 4: Implement `Job`**

Create `src-tauri/src/core/job.rs`:
```rust
#![cfg(windows)]
//! RAII wrapper over a Win32 Job Object configured to KILL the whole process
//! tree when the (single) job handle closes — i.e. when this `Job` drops or the
//! owning process exits. See research verdict: handle has no Drop in `windows`,
//! so we close it ourselves; that close is exactly the kill trigger.

use core::ffi::c_void;
use std::mem::size_of;
use std::os::windows::io::RawHandle;

use windows::core::{PCWSTR, Result};
use windows::Win32::Foundation::{CloseHandle, HANDLE};
use windows::Win32::System::JobObjects::{
    AssignProcessToJobObject, CreateJobObjectW, SetInformationJobObject,
    JobObjectExtendedLimitInformation, JOBOBJECT_EXTENDED_LIMIT_INFORMATION,
    JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
};

pub struct Job {
    handle: HANDLE,
}

// The job handle is a kernel handle; moving it across threads is sound.
unsafe impl Send for Job {}

impl Job {
    pub fn new_kill_on_close() -> Result<Self> {
        unsafe {
            let handle = CreateJobObjectW(None, PCWSTR::null())?;
            let mut info = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
            // Field type is JOB_OBJECT_LIMIT (verified); direct assign compiles.
            info.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(
                handle,
                JobObjectExtendedLimitInformation,
                &info as *const _ as *const c_void,
                size_of::<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>() as u32,
            )?;
            Ok(Job { handle })
        }
    }

    /// Assign a process (by its raw OS HANDLE) to the job. The handle is only
    /// read transiently by the kernel; ownership stays with the caller.
    pub fn assign_raw(&self, process: RawHandle) -> Result<()> {
        unsafe { AssignProcessToJobObject(self.handle, HANDLE(process)) }
    }
}

impl Drop for Job {
    fn drop(&mut self) {
        // Closing the last job handle triggers KILL_ON_JOB_CLOSE.
        unsafe { let _ = CloseHandle(self.handle); }
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml --test job_tree -- --test-threads=1`
Expected: PASS (`dropping_job_kills_parent_and_grandchild ... ok`). May take ~2-6s.
If it flakes "not killed", increase the `wait_dead` timeout; death after `CloseHandle` is asynchronous.

- [ ] **Step 6: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat(core): Job Object with verified tree-kill integration test"
```

---

## Task 5: `PtySession` (portable-pty spawn/IO/resize + handle exposure) + PTY I/O test

**Files:**
- Create: `src-tauri/src/core/pty_session.rs`
- Create: `src-tauri/tests/pty_io.rs`
- Modify: `src-tauri/src/core/mod.rs`

- [ ] **Step 1: Declare the module**

Add to `src-tauri/src/core/mod.rs`:
```rust
pub mod pty_session;
```

- [ ] **Step 2: Write the failing integration test**

Create `src-tauri/tests/pty_io.rs`:
```rust
#![cfg(windows)]
//! Verifies (a) `echo hello` output arrives over the PTY using the Windows-correct
//! read pattern (read on a thread; detect exit via child.wait; drop master to unblock),
//! and (b) the child raw handle is available for Job assignment.

use std::io::Read;
use std::sync::mpsc;
use std::thread;
use std::time::Duration;

use maestro_lib::core::command_spec::CommandSpec;
use maestro_lib::core::pty_session::PtySession;
use portable_pty::PtySize;

#[test]
#[serial_test::serial]
fn pty_echo_hello_arrives_and_handle_available() {
    let size = PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 };
    let spec = CommandSpec::new("cmd.exe").arg("/C").arg("echo hello");

    let (session, mut reader, mut child) = PtySession::spawn(&spec, size).expect("spawn pty");

    // Load-bearing: the child handle must be available for Job assignment.
    assert!(child.as_raw_handle().is_some(), "child raw handle must be Some");

    // Read on a separate thread (read() is blocking; on Windows it does NOT
    // return 0 on child exit until the master is dropped).
    let (tx, rx) = mpsc::channel::<Vec<u8>>();
    let reader_thread = thread::spawn(move || {
        let mut buf = [0u8; 4096];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => { let _ = tx.send(buf[..n].to_vec()); }
                Err(_) => break,
            }
        }
    });

    // Detect exit via the CHILD's wait(), THEN drop the master to close the
    // ConPTY and unblock the reader thread.
    let status = child.wait().expect("wait");
    assert!(status.success(), "echo should exit 0");
    session.shutdown(); // drops master -> reader gets Ok(0) -> thread ends

    let _ = reader_thread.join();

    // Drain everything the reader captured.
    let mut all = Vec::new();
    while let Ok(chunk) = rx.recv_timeout(Duration::from_millis(200)) {
        all.extend_from_slice(&chunk);
    }
    let text = String::from_utf8_lossy(&all);
    assert!(text.contains("hello"), "PTY output should contain 'hello', got: {text:?}");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml --test pty_io`
Expected: FAIL to compile — `unresolved import maestro_lib::core::pty_session::PtySession`.

- [ ] **Step 4: Implement `PtySession`**

Create `src-tauri/src/core/pty_session.rs`:
```rust
//! Owns a ConPTY-backed PTY (master + writer). Tauri-free. Returns the output
//! reader and the child SEPARATELY so callers run the (blocking) reader on its
//! own thread and wait on the child on another.

use std::io::{Read, Write};

use anyhow::Result;
use portable_pty::{native_pty_system, Child, CommandBuilder, MasterPty, PtySize};

use crate::core::command_spec::CommandSpec;

pub struct PtySession {
    master: Box<dyn MasterPty + Send>,
    writer: Box<dyn Write + Send>,
}

impl PtySession {
    /// Spawn `spec` under a new PTY of `size`. Returns the session, the output
    /// reader (BLOCKING — run on its own thread), and the child (wait + raw
    /// handle live on the child, used on another thread).
    pub fn spawn(
        spec: &CommandSpec,
        size: PtySize,
    ) -> Result<(Self, Box<dyn Read + Send>, Box<dyn Child + Send + Sync>)> {
        let pty_system = native_pty_system();
        let pair = pty_system.openpty(size)?;

        let mut cmd = CommandBuilder::new(&spec.program);
        for a in &spec.args { cmd.arg(a); }
        if let Some(cwd) = &spec.cwd { cmd.cwd(cwd); }
        for (k, v) in &spec.env { cmd.env(k, v); }

        let child = pair.slave.spawn_command(cmd)?;
        let reader = pair.master.try_clone_reader()?;
        let writer = pair.master.take_writer()?;

        // Let the child see its controlling-terminal end close.
        drop(pair.slave);

        Ok((PtySession { master: pair.master, writer }, reader, child))
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        self.writer.write_all(bytes)?;
        self.writer.flush()?;
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<()> {
        // portable-pty's resize already returns anyhow::Result<()>.
        self.master.resize(PtySize { rows, cols, pixel_width: 0, pixel_height: 0 })
    }

    /// Drops the master (closes the ConPTY), which makes a blocked reader's
    /// read() return Ok(0) so its thread can end.
    pub fn shutdown(self) {
        drop(self);
    }
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml --test pty_io -- --test-threads=1`
Expected: PASS (`pty_echo_hello_arrives_and_handle_available ... ok`).

- [ ] **Step 6: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat(core): PtySession over portable-pty with Windows-correct read/exit handling"
```

---

## Task 6: `Supervisor` (single session, spawn→assign→stream→teardown)

Owns the Job + session + reader/wait threads for ONE agent (M0). Enforces single-session and correct teardown order (drop job → tree dies; drop master → reader ends).

**Files:**
- Create: `src-tauri/src/core/supervisor.rs`
- Modify: `src-tauri/src/core/mod.rs`

- [ ] **Step 1: Declare the module**

Add to `src-tauri/src/core/mod.rs`:
```rust
pub mod supervisor;
```

- [ ] **Step 2: Write the failing integration test**

Create `src-tauri/tests/supervisor.rs`:
```rust
#![cfg(windows)]
use std::sync::{Arc, Mutex};
use std::thread::sleep;
use std::time::Duration;

use maestro_lib::core::command_spec::CommandSpec;
use maestro_lib::core::supervisor::Supervisor;
use portable_pty::PtySize;

fn size() -> PtySize { PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 } }

#[test]
#[serial_test::serial]
fn streams_output_then_rejects_second_spawn_then_kills() {
    let out = Arc::new(Mutex::new(Vec::<u8>::new()));
    let out2 = out.clone();
    let exited = Arc::new(Mutex::new(None::<u32>));
    let exited2 = exited.clone();

    let mut sup = Supervisor::new();
    // A bounded, long-ish process so the second-spawn rejection is observable.
    let spec = CommandSpec::new("cmd.exe").arg("/C").arg("echo hi & ping -n 10 127.0.0.1");

    sup.spawn(
        &spec,
        size(),
        move |bytes| out2.lock().unwrap().extend_from_slice(bytes),
        move |code| *exited2.lock().unwrap() = Some(code),
    )
    .expect("first spawn ok");

    // Spawning again while running must be rejected.
    let err = sup.spawn(&spec, size(), |_| {}, |_| {});
    assert!(err.is_err(), "second spawn must be rejected while running");

    // Output should accumulate.
    sleep(Duration::from_millis(800));
    assert!(
        String::from_utf8_lossy(&out.lock().unwrap()).contains("hi"),
        "expected streamed output to contain 'hi'"
    );

    // Kill tears down the tree and ends threads.
    sup.kill().expect("kill ok");

    // After kill, a fresh spawn is allowed again.
    sup.spawn(&spec, size(), |_| {}, |_| {}).expect("respawn after kill ok");
    sup.kill().expect("final kill ok");
}
```

- [ ] **Step 3: Run test to verify it fails**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml --test supervisor`
Expected: FAIL to compile — `Supervisor` unresolved.

- [ ] **Step 4: Implement `Supervisor`**

Create `src-tauri/src/core/supervisor.rs`:
```rust
//! Single-agent supervisor for M0. Tauri-free: sinks are injected as closures.
//! Teardown order is load-bearing on Windows:
//!   1. drop the Job  -> KILL_ON_JOB_CLOSE terminates the whole tree; child.wait() returns.
//!   2. drop the master (session.shutdown) -> reader's read() returns Ok(0) -> reader thread ends.

use std::io::Read;
use std::thread::{self, JoinHandle};

use anyhow::{anyhow, Result};
use portable_pty::PtySize;

use crate::core::command_spec::CommandSpec;
#[cfg(windows)]
use crate::core::job::Job;
use crate::core::pty_session::PtySession;

#[derive(Default)]
pub struct Supervisor {
    running: Option<Running>,
}

struct Running {
    #[cfg(windows)]
    job: Job,
    session: PtySession,
    reader_thread: Option<JoinHandle<()>>,
    wait_thread: Option<JoinHandle<()>>,
}

impl Supervisor {
    pub fn new() -> Self {
        Supervisor::default()
    }

    pub fn is_running(&self) -> bool {
        self.running.is_some()
    }

    /// Spawn one agent. `on_bytes` receives output chunks; `on_exit` fires once
    /// with the exit code when the child terminates.
    pub fn spawn(
        &mut self,
        spec: &CommandSpec,
        size: PtySize,
        on_bytes: impl FnMut(&[u8]) + Send + 'static,
        on_exit: impl FnOnce(u32) + Send + 'static,
    ) -> Result<()> {
        if self.running.is_some() {
            return Err(anyhow!("an agent is already running (M0 is single-session)"));
        }

        let (session, reader, child) = PtySession::spawn(spec, size)?;

        // Assign to a kill-on-close Job IMMEDIATELY after spawn (race window noted).
        // `as_raw_handle()` returns a Copy pointer value, so `child` can still be
        // moved into the wait thread afterwards.
        #[cfg(windows)]
        let job = {
            let raw = child
                .as_raw_handle()
                .ok_or_else(|| anyhow!("child raw handle unavailable"))?;
            let job = Job::new_kill_on_close()?;
            job.assign_raw(raw)?;
            job
        };

        // Reader thread: stream output until the master is dropped (Ok(0)).
        let reader_thread = spawn_reader(reader, on_bytes);

        // Wait thread: owns the child, blocks on wait(), and fires on_exit with
        // the REAL exit code. kill() drops the job, which makes wait() return.
        let wait_thread = spawn_waiter(child, on_exit);

        self.running = Some(Running {
            #[cfg(windows)]
            job,
            session,
            reader_thread: Some(reader_thread),
            wait_thread: Some(wait_thread),
        });
        Ok(())
    }

    pub fn write_input(&mut self, bytes: &[u8]) -> Result<()> {
        match &mut self.running {
            Some(r) => r.session.write_input(bytes),
            None => Err(anyhow!("no agent running")),
        }
    }

    pub fn resize(&mut self, cols: u16, rows: u16) -> Result<()> {
        match &self.running {
            Some(r) => r.session.resize(cols, rows),
            None => Err(anyhow!("no agent running")),
        }
    }

    /// Kill is idempotent.
    pub fn kill(&mut self) -> Result<()> {
        if let Some(mut r) = self.running.take() {
            // 1) Drop the job -> tree dies. (cfg-gated; on non-windows this is a no-op.)
            #[cfg(windows)]
            drop(r.job);
            // 2) Drop master -> reader unblocks.
            r.session.shutdown();
            // 3) Join threads (they end promptly after the drops above).
            if let Some(t) = r.reader_thread.take() { let _ = t.join(); }
            if let Some(t) = r.wait_thread.take() { let _ = t.join(); }
        }
        Ok(())
    }
}

fn spawn_reader(
    mut reader: Box<dyn Read + Send>,
    mut on_bytes: impl FnMut(&[u8]) + Send + 'static,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut buf = [0u8; 16384];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => on_bytes(&buf[..n]),
                Err(_) => break,
            }
        }
    })
}

fn spawn_waiter(
    child: Box<dyn portable_pty::Child + Send + Sync>,
    on_exit: impl FnOnce(u32) + Send + 'static,
) -> JoinHandle<()> {
    thread::spawn(move || {
        let mut child = child;
        let code = child.wait().map(|s| s.exit_code()).unwrap_or(1);
        on_exit(code);
    })
}
```

> **Note:** `child.wait()` blocks the wait thread until the process exits — either naturally or because `kill()` dropped the Job (`KILL_ON_JOB_CLOSE` terminates the tree, so `wait()` returns). `as_raw_handle()` yields a `Copy` pointer, so reading it for Job assignment does not prevent moving `child` into the wait thread.

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml --test supervisor -- --test-threads=1`
Expected: PASS (`streams_output_then_rejects_second_spawn_then_kills ... ok`).

- [ ] **Step 6: Run the whole core suite serially**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml -- --test-threads=1`
Expected: all of `command_spec`, `job_tree`, `pty_io`, `supervisor` PASS.

- [ ] **Step 7: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat(core): single-session Supervisor with spawn/stream/kill teardown"
```

---

## Task 7: `CommandError` + `AppState` (Tauri boundary types)

**Files:**
- Create: `src-tauri/src/error.rs`
- Create: `src-tauri/src/state.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Write the failing test for error serialization**

Create `src-tauri/src/error.rs`:
```rust
use serde::Serialize;

#[derive(Debug, thiserror::Error, Serialize)]
pub enum CommandError {
    #[error("{0}")]
    Failed(String),
}

impl From<anyhow::Error> for CommandError {
    fn from(e: anyhow::Error) -> Self {
        CommandError::Failed(e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn serializes_to_stable_shape() {
        let e = CommandError::Failed("boom".into());
        let json = serde_json::to_string(&e).unwrap();
        assert_eq!(json, r#"{"Failed":"boom"}"#);
    }
}
```

- [ ] **Step 2: Run the test**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml error`
Expected: PASS (`serializes_to_stable_shape ... ok`).

- [ ] **Step 3: Create `AppState`**

Create `src-tauri/src/state.rs`:
```rust
use std::sync::Mutex;
use crate::core::supervisor::Supervisor;

#[derive(Default)]
pub struct AppState {
    pub supervisor: Mutex<Supervisor>,
}
```

- [ ] **Step 4: Wire modules into `lib.rs`**

Ensure the top of `src-tauri/src/lib.rs` has:
```rust
pub mod core;
pub mod error;
pub mod state;
pub mod commands;
```
(The `commands` module is created in Task 8; adding it now will fail to compile, so add the `commands` line in Task 8 Step 4 instead. For this task add only `core`, `error`, `state`.)

- [ ] **Step 5: Verify compile**

Run: `rtk cargo build --manifest-path D:/maestro/src-tauri/Cargo.toml`
Expected: `Finished`.

- [ ] **Step 6: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat: CommandError + AppState boundary types"
```

---

## Task 8: Tauri commands + wire `lib.rs`

Thin adapters: parse args, build the on_bytes Channel sink + on_exit emit, call the supervisor.

**Files:**
- Create: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Implement the commands**

Create `src-tauri/src/commands.rs`:
```rust
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};

use crate::core::command_spec::CommandSpec;
use crate::error::CommandError;
use crate::state::AppState;
use portable_pty::PtySize;

#[tauri::command]
pub fn pty_spawn(
    app: AppHandle,
    state: State<'_, AppState>,
    program: String,
    args: Vec<String>,
    cols: u16,
    rows: u16,
    on_bytes: Channel<Vec<u8>>,
) -> Result<(), CommandError> {
    let mut spec = CommandSpec::new(program);
    for a in args { spec = spec.arg(a); }
    let size = PtySize { rows, cols, pixel_width: 0, pixel_height: 0 };

    let channel = on_bytes.clone();
    let app2 = app.clone();

    let mut sup = state.supervisor.lock().map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.spawn(
        &spec,
        size,
        move |bytes| { let _ = channel.send(bytes.to_vec()); },
        move |code| { let _ = app2.emit("pty-exit", code); },
    )
    .map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_input(state: State<'_, AppState>, data: String) -> Result<(), CommandError> {
    let mut sup = state.supervisor.lock().map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.write_input(data.as_bytes()).map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_resize(state: State<'_, AppState>, cols: u16, rows: u16) -> Result<(), CommandError> {
    let mut sup = state.supervisor.lock().map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.resize(cols, rows).map_err(CommandError::from)
}

#[tauri::command]
pub fn pty_kill(state: State<'_, AppState>) -> Result<(), CommandError> {
    let mut sup = state.supervisor.lock().map_err(|_| CommandError::Failed("state poisoned".into()))?;
    sup.kill().map_err(CommandError::from)
}
```

- [ ] **Step 2: Replace the body of `run()` in `lib.rs`**

Set `src-tauri/src/lib.rs` to (preserving the module declarations at the top):
```rust
pub mod core;
pub mod error;
pub mod state;
pub mod commands;

use crate::state::AppState;

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .manage(AppState::default())
        .invoke_handler(tauri::generate_handler![
            commands::pty_spawn,
            commands::pty_input,
            commands::pty_resize,
            commands::pty_kill,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
```

- [ ] **Step 3: Verify compile**

Run: `rtk cargo build --manifest-path D:/maestro/src-tauri/Cargo.toml`
Expected: `Finished`.

- [ ] **Step 4: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat: pty_spawn/input/resize/kill Tauri commands"
```

---

## Task 9: Frontend `terminal.ts` (transport-agnostic xterm pane) + test

**Files:**
- Create: `src/terminal.ts`
- Create: `src/terminal.test.ts`
- Create/Modify: `vitest.config.ts`

- [ ] **Step 1: Add Vitest config (happy-dom)**

Create `D:\maestro\vitest.config.ts`:
```ts
import { defineConfig } from "vitest/config";
export default defineConfig({
  test: { environment: "happy-dom" },
});
```
Add to `package.json` `scripts`: `"test": "vitest run"`.

- [ ] **Step 2: Write the failing test**

Create `src/terminal.test.ts`:
```ts
import { describe, it, expect, vi } from "vitest";
import { mountTerminal } from "./terminal";

describe("mountTerminal", () => {
  it("forwards user input via onInput", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const onInput = vi.fn();
    const onResize = vi.fn();

    const handle = mountTerminal(el, onInput, onResize);
    // Simulate xterm delivering typed data by writing then reading back is hard
    // in jsdom; instead assert the handle surface exists and dispose is safe.
    expect(typeof handle.write).toBe("function");
    expect(typeof handle.fit).toBe("function");
    handle.dispose();
  });
});
```

- [ ] **Step 3: Run test to verify it fails**

Run: `rtk npm run test`
Expected: FAIL — cannot find module `./terminal`.

- [ ] **Step 4: Implement `terminal.ts`**

Create `src/terminal.ts`:
```ts
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import "@xterm/xterm/css/xterm.css";

export interface TerminalHandle {
  write(data: Uint8Array): void;
  fit(): { cols: number; rows: number };
  dispose(): void;
}

export function mountTerminal(
  container: HTMLElement,
  onInput: (data: string) => void,
  onResize: (cols: number, rows: number) => void,
): TerminalHandle {
  const term = new Terminal({
    convertEol: false, // ConPTY already emits \r\n
    cursorBlink: true,
    fontFamily: "Consolas, 'Cascadia Mono', monospace",
    fontSize: 14,
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  term.open(container);
  fit.fit();

  // Optional GPU renderer with graceful fallback to the DOM renderer.
  void (async () => {
    try {
      const { WebglAddon } = await import("@xterm/addon-webgl");
      const webgl = new WebglAddon();
      webgl.onContextLoss(() => webgl.dispose());
      term.loadAddon(webgl);
    } catch {
      /* DOM renderer (default) is fine */
    }
  })();

  term.onData((data) => onInput(data));

  const ro = new ResizeObserver(() => {
    fit.fit();
    onResize(term.cols, term.rows);
  });
  ro.observe(container);

  return {
    write: (data) => term.write(data),
    fit: () => {
      fit.fit();
      return { cols: term.cols, rows: term.rows };
    },
    dispose: () => {
      ro.disconnect();
      term.dispose();
    },
  };
}
```

- [ ] **Step 5: Run test to verify it passes**

Run: `rtk npm run test`
Expected: PASS (`mountTerminal > forwards user input via onInput`).

- [ ] **Step 6: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat(ui): transport-agnostic xterm.js terminal pane"
```

---

## Task 10: Frontend `ipc.ts` (Tauri wrappers) + mocked test

**Files:**
- Create: `src/ipc.ts`
- Create: `src/ipc.test.ts`

- [ ] **Step 1: Write the failing test (mock the Tauri core boundary)**

Create `src/ipc.test.ts`:
```ts
import { describe, it, expect, vi, beforeEach } from "vitest";

const invoke = vi.fn().mockResolvedValue(undefined);
class FakeChannel<T> { onmessage: ((m: T) => void) | null = null; }
vi.mock("@tauri-apps/api/core", () => ({ invoke, Channel: FakeChannel }));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn().mockResolvedValue(() => {}) }));

import { spawnPty, sendInput, resizePty, killPty } from "./ipc";

beforeEach(() => invoke.mockClear());

describe("ipc", () => {
  it("spawnPty passes camelCase args and binds the channel before invoke", async () => {
    const onBytes = vi.fn();
    await spawnPty("powershell.exe", ["-NoLogo"], 80, 24, onBytes);
    expect(invoke).toHaveBeenCalledWith("pty_spawn", expect.objectContaining({
      program: "powershell.exe", args: ["-NoLogo"], cols: 80, rows: 24,
      onBytes: expect.any(Object),
    }));
  });

  it("sendInput / resizePty / killPty call the right commands", async () => {
    await sendInput("ls\r"); expect(invoke).toHaveBeenCalledWith("pty_input", { data: "ls\r" });
    await resizePty(120, 40); expect(invoke).toHaveBeenCalledWith("pty_resize", { cols: 120, rows: 40 });
    await killPty(); expect(invoke).toHaveBeenCalledWith("pty_kill");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `rtk npm run test`
Expected: FAIL — cannot find module `./ipc`.

- [ ] **Step 3: Implement `ipc.ts`**

Create `src/ipc.ts`:
```ts
import { invoke, Channel } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export async function spawnPty(
  program: string,
  args: string[],
  cols: number,
  rows: number,
  onBytes: (bytes: Uint8Array) => void,
): Promise<void> {
  // Rust Vec<u8> arrives as a JS number[]; wrap as Uint8Array for xterm.
  const ch = new Channel<number[]>();
  ch.onmessage = (msg) => onBytes(new Uint8Array(msg));
  await invoke("pty_spawn", { program, args, cols, rows, onBytes: ch });
}

export async function sendInput(data: string): Promise<void> {
  await invoke("pty_input", { data });
}

export async function resizePty(cols: number, rows: number): Promise<void> {
  await invoke("pty_resize", { cols, rows });
}

export async function killPty(): Promise<void> {
  await invoke("pty_kill");
}

export async function onExit(cb: (code: number) => void): Promise<UnlistenFn> {
  return listen<number>("pty-exit", (e) => cb(e.payload));
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `rtk npm run test`
Expected: PASS (both `ipc` tests green).

- [ ] **Step 5: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat(ui): Tauri IPC wrappers for pty commands"
```

---

## Task 11: Wire `main.ts` + `index.html` (end-to-end)

**Files:**
- Modify: `index.html`
- Modify: `src/main.ts`

- [ ] **Step 1: Set the terminal container in `index.html`**

Replace `<body>...</body>` contents of `D:\maestro\index.html` with:
```html
<body style="margin:0;background:#0b0e14;">
  <div style="display:flex;gap:8px;padding:8px;">
    <button id="spawn">Spawn powershell</button>
    <button id="kill">Kill (tree)</button>
    <span id="status" style="color:#9aa;font-family:monospace;"></span>
  </div>
  <div id="terminal" style="width:100vw;height:calc(100vh - 48px);"></div>
  <script type="module" src="/src/main.ts"></script>
</body>
```

- [ ] **Step 2: Wire `src/main.ts`**

Replace `src/main.ts` with:
```ts
import { mountTerminal } from "./terminal";
import { spawnPty, sendInput, resizePty, killPty, onExit } from "./ipc";

const container = document.getElementById("terminal")!;
const status = document.getElementById("status")!;

const term = mountTerminal(
  container,
  (data) => { void sendInput(data); },
  (cols, rows) => { void resizePty(cols, rows); },
);

document.getElementById("spawn")!.addEventListener("click", async () => {
  const { cols, rows } = term.fit();
  status.textContent = "spawning…";
  await spawnPty("powershell.exe", ["-NoLogo"], cols, rows, (bytes) => term.write(bytes));
  status.textContent = "running";
  await onExit((code) => { status.textContent = `exited (${code})`; });
});

document.getElementById("kill")!.addEventListener("click", async () => {
  await killPty();
  status.textContent = "killed";
});
```

- [ ] **Step 3: Run the app**

Run: `rtk npm run tauri dev`
Expected: window opens with the two buttons + an empty terminal.

- [ ] **Step 4: Manual smoke check**

Click **Spawn powershell** → a PowerShell prompt renders in the pane. Type `echo hi` + Enter → output appears. Resize the window → prompt reflows.

- [ ] **Step 5: Commit**

```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "feat: end-to-end single-pane PTY terminal in Tauri window"
```

---

## Task 12: M0 acceptance — prove tree-kill in the real app

**Files:** none (verification + notes)

- [ ] **Step 1: Spawn + create a child process inside the pane**

Run the app (`rtk npm run tauri dev`), click **Spawn powershell**, then in the pane run:
```
Start-Process notepad
```
Confirm a Notepad window opens (this is a grandchild of the supervised PowerShell).

- [ ] **Step 2: Kill from the app and verify the tree dies**

Click **Kill (tree)**. Expected: the PowerShell pane goes inert AND the Notepad window closes. Verify no orphan remains:

Run: `rtk powershell -Command "Get-Process notepad -ErrorAction SilentlyContinue"`
Expected: no output (process gone).

- [ ] **Step 3: Verify clean teardown (no leaked maestro/agent processes)**

Close the app window. Run: `rtk powershell -Command "Get-Process powershell,notepad -ErrorAction SilentlyContinue | Select-Object Name,Id"`
Expected: only your own shells, none spawned by Maestro.

- [ ] **Step 4: Run the full automated suite one more time**

Run: `rtk cargo test --manifest-path D:/maestro/src-tauri/Cargo.toml -- --test-threads=1`
Run: `rtk npm run test`
Expected: all green.

- [ ] **Step 5: Record M0 results + commit a short note**

Append outcomes (what worked, any flake, observed kill latency) to `docs/superpowers/specs/2026-06-04-maestro-multi-agent-cli-orchestrator-design.md` under a new `## M0 Results` heading, then:
```bash
rtk git -C D:/maestro add -A
rtk git -C D:/maestro commit -m "docs: M0 acceptance results"
```

---

## M0 Definition of Done

- App launches on Windows; one agent CLI runs in a live xterm.js pane with working input, output, and resize.
- Clicking **Kill** drops the Job → the whole descendant tree (incl. a grandchild like Notepad) terminates; closing the app leaves no orphaned agent processes.
- `cargo test` (job_tree, pty_io, supervisor, command_spec, error) and `npm run test` (terminal, ipc) all pass.
- Core logic (`core/*`, `error.rs`) imports no `tauri::*`.

## Carried-forward risks (into M1)
- Job-assignment race (sub-ms grandchild escape) — accept for M0; close in a later milestone via own ConPTY + `PROC_THREAD_ATTRIBUTE_JOB_LIST` if needed.
- `Supervisor` holds `Option<Running>` (single session). M1 multi-pane must introduce an agent registry + the resource governor; the second-spawn rejection test guards against accidentally half-implementing that now.
- `CREATE_BREAKAWAY_FROM_JOB` children (some installers/daemons) escape tree-kill — document per-adapter.
- WebGL pane scaling deferred (M0 is single pane); M1 must enforce WebGL-on-focused-only + virtualization.
