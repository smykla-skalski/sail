use std::io;
use std::os::unix::process::CommandExt;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::time::{Duration, Instant};

pub struct ChildWatchdog {
    child: Option<Child>,
    _input: Option<ChildStdin>,
}

impl ChildWatchdog {
    pub fn start(group: u32) -> io::Result<Self> {
        let mut command = Command::new("/bin/sh");
        command
            .arg("-c")
            .arg("cat >/dev/null; kill -9 0")
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        command.process_group(group as i32);
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
            let _ = child.kill();
            let _ = child.wait();
        }
    }

    pub fn kill_group(&mut self) {
        drop(self._input.take());
        if let Some(mut child) = self.child.take() {
            let deadline = Instant::now() + Duration::from_secs(2);
            loop {
                match child.try_wait() {
                    Ok(Some(_)) => break,
                    Ok(None) if Instant::now() < deadline => {
                        std::thread::sleep(Duration::from_millis(10));
                    }
                    _ => {
                        let _ = child.kill();
                        let _ = child.wait();
                        break;
                    }
                }
            }
        }
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
    fn parent_pipe_closure_kills_process_group() {
        let mut command = Command::new("sleep");
        command.arg("30").process_group(0);
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

    #[test]
    fn explicit_cleanup_kills_process_group() {
        let mut command = Command::new("sleep");
        command.arg("30").process_group(0);
        let mut server = command.spawn().unwrap();
        let group = nix::unistd::Pid::from_raw(server.id() as i32);
        let mut watchdog = ChildWatchdog::start(server.id()).unwrap();

        watchdog.kill_group();
        assert!(!server.wait().unwrap().success());
        assert!(matches!(
            nix::sys::signal::killpg(group, None),
            Err(nix::errno::Errno::ESRCH)
        ));
    }
}
