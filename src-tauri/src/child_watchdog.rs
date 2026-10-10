use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};

pub struct ChildWatchdog {
    child: Option<Child>,
    _input: Option<ChildStdin>,
}

impl ChildWatchdog {
    pub fn start(group: u32) -> io::Result<Self> {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("cat >/dev/null; kill -9 -\"$1\"")
            .arg("terminal-watchdog")
            .arg(group.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .process_group(0);
        let mut child = command.spawn()?;
        let input = child
            .stdin
            .take()
            .ok_or_else(|| io::Error::other("watchdog stdin unavailable"))?;
        Ok(Self {
            child: Some(child),
            _input: Some(input),
        })
    }

    pub fn stop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let group = nix::unistd::Pid::from_raw(child.id() as i32);
            let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL);
            let _ = child.wait();
        }
        self._input.take();
    }
}

impl Drop for ChildWatchdog {
    fn drop(&mut self) {
        self.stop();
    }
}

#[cfg(test)]
mod tests {
    use super::ChildWatchdog;
    use std::os::unix::process::CommandExt;
    use std::process::Command;
    use std::time::{Duration, Instant};

    #[test]
    fn parent_pipe_closure_kills_terminal_process_group() {
        let mut command = Command::new("sleep");
        command.arg("30");
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut server = command.spawn().unwrap();
        let group = nix::unistd::Pid::from_raw(server.id() as i32);
        let mut watchdog = ChildWatchdog::start(server.id()).unwrap();

        std::thread::sleep(Duration::from_millis(100));
        assert!(server.try_wait().unwrap().is_none());
        drop(watchdog._input.take());

        let deadline = Instant::now() + Duration::from_secs(3);
        while server.try_wait().unwrap().is_none() {
            if Instant::now() >= deadline {
                let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL);
                let _ = server.wait();
                panic!("watchdog did not stop the process group");
            }
            std::thread::sleep(Duration::from_millis(20));
        }
        watchdog.stop();
        assert!(matches!(
            nix::sys::signal::killpg(group, None),
            Err(nix::errno::Errno::ESRCH)
        ));
    }
}
