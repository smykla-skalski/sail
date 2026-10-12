use std::ffi::OsStr;
use std::process::Command;
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

pub fn worker_command(program: &OsStr, enabled: bool) -> Command {
    #[cfg(unix)]
    if let Some(nice) = nice_program(enabled) {
        let mut command = Command::new(nice);
        command.args(["-n", "10"]).arg(program);
        return command;
    }

    #[cfg(windows)]
    let mut command = Command::new(program);
    #[cfg(not(windows))]
    let command = Command::new(program);
    #[cfg(windows)]
    if enabled {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::BELOW_NORMAL_PRIORITY_CLASS;
        command.creation_flags(BELOW_NORMAL_PRIORITY_CLASS.0);
    }
    command
}

pub fn normal_priority_copy(command: &Command) -> Command {
    #[cfg(unix)]
    let (program, args) = {
        let mut args = command.get_args();
        if command.get_program() == OsStr::new("/usr/bin/nice") {
            // worker_command always adds `-n 10 <program>` before its caller's args.
            let _ = args.next();
            let _ = args.next();
            let program = args
                .next()
                .expect("worker priority wrapper needs a program");
            (program, args)
        } else {
            (command.get_program(), args)
        }
    };
    #[cfg(windows)]
    let (program, args) = (command.get_program(), command.get_args());
    let mut copy = Command::new(program);
    copy.args(args);
    if let Some(directory) = command.get_current_dir() {
        copy.current_dir(directory);
    }
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            copy.env(name, value);
        } else {
            copy.env_remove(name);
        }
    }
    copy
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
        assert!(super::nice_program(false).is_none());
        assert!(super::nice_program(true).is_some());
        let current = unsafe { nix::libc::getpriority(nix::libc::PRIO_PROCESS, 0) };
        let mut child = super::worker_command(std::ffi::OsStr::new("/bin/sh"), true)
            .args(["-c", "echo ready; sleep 2"])
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
        let mut normal = super::worker_command(std::ffi::OsStr::new("/bin/sh"), false)
            .args(["-c", "sleep 2"])
            .spawn()
            .unwrap();
        let actual = unsafe { nix::libc::getpriority(nix::libc::PRIO_PROCESS, normal.id()) };
        assert_eq!(actual, current);
        assert!(normal.wait().unwrap().success());

        let mut priority = super::worker_command(std::ffi::OsStr::new("/bin/sh"), true);
        priority.args(["-c", "printf %s \"$SAIL_PRIORITY_TEST\""]);
        priority.env("SAIL_PRIORITY_TEST", "fallback");
        let output = super::normal_priority_copy(&priority).output().unwrap();
        assert_eq!(output.stdout, b"fallback");
    }

    #[cfg(windows)]
    #[test]
    fn requested_windows_priority_is_applied_to_a_child() {
        use windows::Win32::Foundation::CloseHandle;
        use windows::Win32::System::Threading::{
            GetCurrentProcess, GetPriorityClass, OpenProcess, BELOW_NORMAL_PRIORITY_CLASS,
            PROCESS_QUERY_INFORMATION,
        };

        let mut child = super::worker_command(std::ffi::OsStr::new("cmd"), true)
            .args(["/C", "ping -n 5 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, false, child.id()) }.unwrap();
        let actual = unsafe { GetPriorityClass(handle) };
        unsafe { CloseHandle(handle) }.unwrap();
        assert_eq!(actual, BELOW_NORMAL_PRIORITY_CLASS.0);
        child.kill().unwrap();
        child.wait().unwrap();

        let mut normal = super::worker_command(std::ffi::OsStr::new("cmd"), false)
            .args(["/C", "ping -n 5 127.0.0.1 >nul"])
            .spawn()
            .unwrap();
        let handle = unsafe { OpenProcess(PROCESS_QUERY_INFORMATION, false, normal.id()) }.unwrap();
        let actual = unsafe { GetPriorityClass(handle) };
        unsafe { CloseHandle(handle) }.unwrap();
        let parent = unsafe { GetPriorityClass(GetCurrentProcess()) };
        assert_eq!(actual, parent);
        normal.kill().unwrap();
        normal.wait().unwrap();
    }
}
