use tauri::AppHandle;

const SETTING: &str = "sai-background-priority-enabled";

pub fn enabled(app: &AppHandle) -> bool {
    match crate::settings::string_setting(app, SETTING) {
        Ok(value) => value.as_deref() != Some("false"),
        Err(error) => {
            eprintln!("Cannot read background priority setting: {error}");
            true
        }
    }
}

#[cfg(unix)]
pub fn nice_program(enabled: bool) -> Option<&'static str> {
    if !enabled {
        return None;
    }
    let path = "/usr/bin/nice";
    if std::path::Path::new(path).is_file() {
        Some(path)
    } else {
        eprintln!(
            "Background priority unavailable: {path} is missing; continuing at normal priority"
        );
        None
    }
}

pub fn lower_current_process() {
    if std::env::var("SAIL_BACKGROUND_PRIORITY").as_deref() == Ok("false") {
        return;
    }
    #[cfg(unix)]
    {
        let result = unsafe { nix::libc::setpriority(nix::libc::PRIO_PROCESS, 0, 10) };
        if result != 0 {
            eprintln!(
                "Background priority unavailable: {}; continuing at normal priority",
                std::io::Error::last_os_error()
            );
        }
    }
    #[cfg(windows)]
    lower_process(std::process::id());
}

#[cfg(windows)]
pub fn lower_process(pid: u32) {
    use windows::Win32::Foundation::CloseHandle;
    use windows::Win32::System::Threading::{
        OpenProcess, SetPriorityClass, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_SET_INFORMATION,
    };
    let result = unsafe {
        OpenProcess(PROCESS_SET_INFORMATION, false, pid).and_then(|handle| {
            let result = SetPriorityClass(handle, BELOW_NORMAL_PRIORITY_CLASS);
            let _ = CloseHandle(handle);
            result
        })
    };
    if let Err(error) = result {
        eprintln!("Background priority unavailable: {error}; continuing at normal priority");
    }
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    #[test]
    fn requested_niceness_is_inherited_by_a_child() {
        use std::io::{BufRead, BufReader};
        use std::process::Command;

        assert!(super::nice_program(false).is_none());
        let nice = super::nice_program(true).expect("supported Unix platforms provide nice");
        let current = unsafe { nix::libc::getpriority(nix::libc::PRIO_PROCESS, 0) };
        let mut child = Command::new(nice)
            .args(["-n", "10", "/bin/sh", "-c", "echo ready; sleep 2"])
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready, "ready\n");
        let actual = unsafe { nix::libc::getpriority(nix::libc::PRIO_PROCESS, child.id()) };
        let output = child.wait_with_output().unwrap();
        assert!(output.status.success());
        if actual < (current + 10).min(19) {
            assert!(
                String::from_utf8_lossy(&output.stderr).contains("priority"),
                "priority failed without reporting a reason"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn requested_windows_priority_is_applied_to_a_child() {
        use std::process::Command;
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetPriorityClass, OpenProcess, BELOW_NORMAL_PRIORITY_CLASS, PROCESS_QUERY_INFORMATION,
        };

        let mut child = Command::new("cmd")
            .args(["/C", "ping -n 5 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        super::lower_process(child.id());
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, false, child.id()) }.unwrap();
        let actual = unsafe { GetPriorityClass(handle) };
        unsafe { CloseHandle(handle) }.unwrap();
        assert_eq!(actual, BELOW_NORMAL_PRIORITY_CLASS.0);
        child.kill().unwrap();
        child.wait().unwrap();
    }
}
