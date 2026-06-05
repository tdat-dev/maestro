#![cfg(windows)]
//! Proves a kill-on-job-close Job Object tears down the whole tree:
//! a parent process that spawns a grandchild — both die when the Job handle drops.

use std::os::windows::io::AsRawHandle;
use std::process::Command;
use std::thread::sleep;
use std::time::{Duration, Instant};

use maestro_lib::core::job::Job;

use windows::Win32::Foundation::CloseHandle;
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
        if !pid_alive(pid) {
            return true;
        }
        sleep(Duration::from_millis(50));
    }
    false
}

#[test]
#[serial_test::serial]
fn dropping_job_kills_parent_and_grandchild() {
    // The parent (powershell) launches a hidden `ping` grandchild and records
    // its PID so the test can assert the grandchild also dies.
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
            if let Ok(p) = s.trim().parse::<u32>() {
                grandchild_pid = p;
                break;
            }
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
