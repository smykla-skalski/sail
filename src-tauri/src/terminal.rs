use base64::Engine;
use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
pub struct TerminalSize {
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenParams {
    id: String,
    directory: String,
    command: Option<String>,
    size: TerminalSize,
    attachment: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Exit { code: u32 },
}

#[derive(Clone, Serialize)]
struct TerminalExitNotice {
    id: String,
    code: u32,
}

struct TerminalOutput {
    history: VecDeque<u8>,
    start: u64,
    #[cfg(windows)]
    current_directory: PathBuf,
    #[cfg(windows)]
    osc_tail: Vec<u8>,
    exit_code: Option<u32>,
    subscriber: Option<(String, Channel<TerminalEvent>)>,
}

struct TerminalSession {
    inspect_id: String,
    owner: Option<String>,
    directory: PathBuf,
    worktree: PathBuf,
    process_id: Option<u32>,
    writer: Mutex<Box<dyn Write + Send>>,
    // Close ConPTY input before closing the pseudoconsole master.
    master: Mutex<Box<dyn MasterPty + Send>>,
    process_group_stop: Arc<Mutex<()>>,
    write_busy: AtomicBool,
    #[cfg(windows)]
    job: crate::acp_terminal::WindowsTerminalJob,
    output: Arc<Mutex<TerminalOutput>>,
    changed: Arc<Condvar>,
}

impl TerminalSession {
    fn stop(&self) -> Result<(), String> {
        let _process_group_stop = self
            .process_group_stop
            .lock()
            .map_err(|error| error.to_string())?;
        #[cfg(unix)]
        {
            if self
                .output
                .lock()
                .map_err(|error| error.to_string())?
                .exit_code
                .is_some()
            {
                return Ok(());
            }
            kill_terminal_process_groups(
                self.process_id
                    .ok_or("Cannot identify terminal process group.")?,
            )?;
        }
        #[cfg(windows)]
        {
            self.job.stop()?;
        }
        Ok(())
    }
}

#[cfg(unix)]
pub(crate) fn kill_terminal_process_groups(shell_process_id: u32) -> Result<(), String> {
    use sysinfo::{ProcessStatus, System};

    // Every owned terminal is its own session leader. Its unreaped child handle
    // keeps this session ID reserved even after the shell exits.
    let session_id = shell_process_id as nix::libc::pid_t;
    if session_id <= 0 || session_id == unsafe { nix::libc::getsid(0) } {
        return Err("Cannot identify terminal process group.".to_string());
    }
    let observed_session = unsafe { nix::libc::getsid(session_id) };
    if observed_session != -1 && observed_session != session_id {
        return Err("Cannot verify terminal process session ownership.".to_string());
    }

    let mut system = System::new_all();
    for _ in 0..40 {
        let mut groups =
            std::collections::HashMap::<nix::libc::pid_t, Vec<nix::libc::pid_t>>::new();
        let mut live_members = Vec::new();
        for process in system.processes().values() {
            let pid = process.pid().as_u32() as nix::libc::pid_t;
            if unsafe { nix::libc::getsid(pid) } != session_id {
                continue;
            }
            let group = unsafe { nix::libc::getpgid(pid) };
            if group <= 0 || unsafe { nix::libc::getsid(pid) } != session_id {
                continue;
            }
            if !matches!(
                process.status(),
                ProcessStatus::Zombie | ProcessStatus::Dead
            ) {
                live_members.push(pid);
                groups.entry(group).or_default().push(pid);
            }
        }
        if live_members.is_empty() {
            return Ok(());
        }
        for (group, members) in groups {
            if group <= 0 || group == unsafe { nix::libc::getpgrp() } {
                continue;
            }
            let still_owned = members.iter().any(|member| unsafe {
                nix::libc::getsid(*member) == session_id && nix::libc::getpgid(*member) == group
            });
            if !still_owned {
                continue;
            }
            match nix::sys::signal::killpg(
                nix::unistd::Pid::from_raw(group),
                nix::sys::signal::Signal::SIGKILL,
            ) {
                Ok(()) | Err(nix::errno::Errno::ESRCH) => {}
                Err(error) => return Err(format!("Cannot stop terminal process: {error}")),
            }
        }
        std::thread::sleep(Duration::from_millis(50));
        system.refresh_all();
    }
    Err("Cannot confirm terminal process groups stopped.".to_string())
}

fn default_editor() -> String {
    #[cfg(target_os = "macos")]
    {
        for candidate in [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "/Applications/Zed.app/Contents/MacOS/cli",
        ] {
            if Path::new(candidate).is_file() {
                return shell_words::quote(candidate).into_owned();
            }
        }
    }
    "code".to_string()
}

#[cfg(test)]
mod tests {
    use super::{canonical_terminal_paths, default_editor, output_page, TerminalOutput};
    use std::collections::VecDeque;
    use std::path::Path;

    #[cfg(windows)]
    fn drain_conpty_output(master: &dyn portable_pty::MasterPty) -> std::thread::JoinHandle<()> {
        use std::io::Read;

        let mut reader = master
            .try_clone_reader()
            .expect("clone ConPTY output reader");
        std::thread::spawn(move || {
            let mut buffer = [0; 8192];
            loop {
                match reader.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(_) => {}
                }
            }
        })
    }

    #[cfg(windows)]
    fn close_conpty_bounded(
        close: impl FnOnce() + Send + 'static,
        output_drain: std::thread::JoinHandle<()>,
    ) {
        let (closed, wait) = std::sync::mpsc::sync_channel(1);
        std::thread::spawn(move || {
            close();
            let _ = closed.send(output_drain.join().is_ok());
        });
        let drained = wait
            .recv_timeout(std::time::Duration::from_secs(10))
            .expect("ConPTY close and output drain should finish within 10 seconds");
        assert!(drained, "ConPTY output reader panicked");
    }

    #[cfg(windows)]
    #[test]
    fn worktree_removal_stops_owned_pty_descendant_on_first_attempt() {
        use crate::acp_terminal::WindowsTerminalJob;
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::io::Write;

        let managed =
            std::env::temp_dir().join(format!("sail-owned-terminal-data-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&managed).expect("managed terminal data directory");
        std::fs::write(managed.join("cache-entry"), "private cache")
            .expect("create managed cache entry");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open ConPTY");
        let job = WindowsTerminalJob::new().expect("create owned terminal job");
        let output_drain = drain_conpty_output(pair.master.as_ref());
        let mut command = CommandBuilder::new(super::shell());
        command.set_job_handle(job.raw_handle());
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn cmd.exe in the Job Object");
        drop(pair.slave);
        let mut writer = pair.master.take_writer().expect("take ConPTY writer");
        writer
            .write_all(b"start \"\" /B ping -n 60 127.0.0.1\r\n")
            .expect("start a descendant from the owned shell");
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            let active = job.active_processes().expect("inspect terminal job");
            if active > 1 {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "cmd.exe did not start a background descendant"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        let result = crate::remove_worktree_then_terminal_data(&managed, || job.stop());
        assert!(result.is_ok(), "first removal failed: {result:?}");
        assert!(!managed.exists(), "managed data was retained");
        assert_eq!(job.active_processes().unwrap(), 0);
        child.wait().expect("reap stopped terminal shell");
        drop(writer);
        close_conpty_bounded(move || drop(pair.master), output_drain);
    }

    #[cfg(windows)]
    #[test]
    fn worktree_removal_stops_pty_descendant_after_shell_exits() {
        use crate::acp_terminal::WindowsTerminalJob;
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};
        use std::sync::atomic::AtomicBool;
        use std::sync::{Arc, Condvar, Mutex};

        let managed =
            std::env::temp_dir().join(format!("sail-owned-terminal-data-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&managed).expect("managed terminal data directory");
        std::fs::write(managed.join("cache-entry"), "private cache")
            .expect("create managed cache entry");
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .expect("open ConPTY");
        let job = WindowsTerminalJob::new().expect("create owned terminal job");
        let output_drain = drain_conpty_output(pair.master.as_ref());
        let mut command = CommandBuilder::new(super::shell());
        command.arg("/C");
        command.arg("start \"\" /B ping -n 60 127.0.0.1 & exit");
        command.set_job_handle(job.raw_handle());
        let mut child = pair
            .slave
            .spawn_command(command)
            .expect("spawn shell with descendant in the Job Object");
        drop(pair.slave);
        let writer = pair.master.take_writer().expect("take ConPTY writer");

        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        loop {
            if child.try_wait().expect("poll terminal shell").is_some() {
                break;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "cmd.exe did not exit after starting its descendant"
            );
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(
            job.active_processes().unwrap() > 0,
            "descendant left the job"
        );

        let process_id = child.process_id();
        let session = super::TerminalSession {
            inspect_id: "windows-owned-terminal-test".to_string(),
            owner: None,
            directory: managed.clone(),
            worktree: managed.clone(),
            process_id,
            master: Mutex::new(pair.master),
            process_group_stop: Arc::new(Mutex::new(())),
            writer: Mutex::new(writer),
            write_busy: AtomicBool::new(false),
            job,
            output: Arc::new(Mutex::new(super::TerminalOutput {
                history: VecDeque::new(),
                start: 0,
                current_directory: managed.clone(),
                osc_tail: Vec::new(),
                exit_code: Some(0),
                subscriber: None,
            })),
            changed: Arc::new(Condvar::new()),
        };

        let result = crate::remove_worktree_then_terminal_data(&managed, || session.stop());
        if result.is_err() {
            session
                .job
                .stop()
                .expect("stop test job after failed worktree removal");
        }
        assert!(result.is_ok(), "first removal failed: {result:?}");
        assert!(!managed.exists(), "managed data was retained");
        assert_eq!(session.job.active_processes().unwrap(), 0);
        child.wait().expect("reap exited terminal shell");
        close_conpty_bounded(move || drop(session), output_drain);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stop_kills_interactive_background_job_groups() {
        use super::kill_terminal_process_groups;
        use std::process::Command;

        let marker =
            std::env::temp_dir().join(format!("sail-interactive-job-{}", uuid::Uuid::new_v4()));
        let unrelated_marker = std::env::temp_dir().join(format!(
            "sail-unrelated-session-job-{}",
            uuid::Uuid::new_v4()
        ));
        let mut unrelated = Command::new("/bin/sh")
            .args(["-c", "(sleep 0.5; touch \"$1\") & wait", "sh"])
            .arg(&unrelated_marker)
            .spawn()
            .expect("spawn job in unrelated process session");
        let job_pid_file = marker.with_extension("pid");
        let mut shell = isolated_test_shell(
            "set -m; (sleep 1; touch \"$1\") & echo $! > \"$2\"; wait",
            &marker,
            Some(&job_pid_file),
        );
        let shell_pid = shell.id();
        let job_pid = loop {
            if let Ok(pid) = std::fs::read_to_string(&job_pid_file) {
                break pid.trim().parse::<u32>().expect("background job PID");
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        assert_eq!(
            unsafe { nix::libc::getsid(job_pid as nix::libc::pid_t) },
            shell_pid as nix::libc::pid_t,
            "background job belongs to the owned shell session"
        );
        assert_ne!(
            unsafe { nix::libc::getpgid(job_pid as nix::libc::pid_t) },
            shell_pid as nix::libc::pid_t,
            "interactive background job has a separate process group"
        );
        assert!(!marker.exists(), "background job fixture exited too late");

        kill_terminal_process_groups(shell_pid).expect("kill all groups in owned shell session");
        shell.wait().expect("reap shell after session cleanup");
        unrelated.wait().expect("wait for unrelated session job");
        std::thread::sleep(std::time::Duration::from_millis(1200));

        assert!(!marker.exists(), "interactive background job survived stop");
        assert!(
            unrelated_marker.exists(),
            "stop killed a process from an unrelated session"
        );
        let _ = std::fs::remove_file(job_pid_file);
        let _ = std::fs::remove_file(unrelated_marker);
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_background_job_after_shell_exits() {
        use super::kill_terminal_process_groups;
        use std::time::Duration;

        let marker =
            std::env::temp_dir().join(format!("sail-exited-shell-child-{}", uuid::Uuid::new_v4()));
        let mut shell =
            isolated_test_shell("set -m; (sleep 1; touch \"$1\") & exit 0", &marker, None);
        let shell_pid = shell.id();
        let mut status = unsafe { std::mem::zeroed::<nix::libc::siginfo_t>() };
        let waited = unsafe {
            nix::libc::waitid(
                nix::libc::P_PID,
                shell_pid,
                &mut status,
                nix::libc::WEXITED | nix::libc::WNOWAIT,
            )
        };
        assert_eq!(waited, 0, "observe shell exit without releasing its PID");
        assert_eq!(unsafe { status.si_pid() }, shell_pid as i32);
        assert!(!marker.exists(), "shell group fixture exited too late");

        kill_terminal_process_groups(shell_pid)
            .expect("kill shell group after its foreground group disappeared");
        shell.wait().expect("reap shell after group cleanup");
        std::thread::sleep(Duration::from_millis(1200));

        assert!(!marker.exists(), "shell group child survived stop");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stop_kills_background_job_after_job_group_leader_is_reaped() {
        use super::kill_terminal_process_groups;
        use std::time::{Duration, Instant};

        let marker =
            std::env::temp_dir().join(format!("sail-reaped-job-leader-{}", uuid::Uuid::new_v4()));
        let ready = marker.with_extension("ready");
        let leader_pid_file = marker.with_extension("leader");
        let child_pid_file = marker.with_extension("child");
        let script = "set -m; (sleep 30 & echo $! > \"$2\"; exit 0) & leader=$!; wait \"$leader\"; echo $leader > \"$3\"; touch \"$4\"; sleep 30";
        let mut shell = isolated_test_shell_with_arguments(
            script,
            &[&marker, &child_pid_file, &leader_pid_file, &ready],
        );
        let shell_pid = shell.id();
        let deadline = Instant::now() + Duration::from_secs(3);
        while !ready.exists() {
            assert!(Instant::now() < deadline, "job leader did not exit");
            std::thread::sleep(Duration::from_millis(10));
        }
        let leader: nix::libc::pid_t = std::fs::read_to_string(&leader_pid_file)
            .expect("job leader pid")
            .trim()
            .parse()
            .expect("valid job leader pid");
        assert_eq!(
            unsafe { nix::libc::getsid(leader) },
            -1,
            "job leader was reaped"
        );
        let child: nix::libc::pid_t = std::fs::read_to_string(child_pid_file)
            .expect("job descendant pid")
            .trim()
            .parse()
            .expect("valid descendant pid");
        assert_eq!(unsafe { nix::libc::getsid(child) }, shell_pid as i32);
        assert_ne!(unsafe { nix::libc::getpgid(child) }, -1);
        assert!(!marker.exists(), "background child fixture exited too late");

        kill_terminal_process_groups(shell_pid)
            .expect("kill descendant whose process-group leader was reaped");
        shell.wait().expect("reap terminal shell after cleanup");
        std::thread::sleep(Duration::from_millis(2200));
        assert!(!marker.exists(), "descendant survived group leader cleanup");
    }

    #[cfg(unix)]
    fn isolated_test_shell(
        script: &str,
        marker: &Path,
        extra_argument: Option<&Path>,
    ) -> std::process::Child {
        let mut arguments = vec![marker];
        if let Some(extra_argument) = extra_argument {
            arguments.push(extra_argument);
        }
        isolated_test_shell_with_arguments(script, &arguments)
    }

    #[cfg(unix)]
    fn isolated_test_shell_with_arguments(
        script: &str,
        arguments: &[&Path],
    ) -> std::process::Child {
        use std::os::unix::process::CommandExt;

        let mut command = std::process::Command::new("/bin/sh");
        command.args(["-c", script, "sh"]).args(arguments);
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        command.spawn().expect("spawn isolated terminal shell")
    }

    #[test]
    fn owned_terminal_creation_is_serialized_with_worktree_stop() {
        use super::TerminalManager;
        use std::sync::mpsc;
        use std::sync::Arc;

        let manager = Arc::new(TerminalManager::default());
        let worktree =
            std::env::temp_dir().join(format!("sail-terminal-fence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&worktree).unwrap();
        let (creating_tx, creating_rx) = mpsc::channel();
        let (finish_create_tx, finish_create_rx) = mpsc::channel();
        let creator_manager = Arc::clone(&manager);
        let creator_worktree = worktree.clone();
        let creator = std::thread::spawn(move || {
            creator_manager.with_worktree_creation(&creator_worktree, || {
                creating_tx.send(()).unwrap();
                finish_create_rx.recv().unwrap();
                Ok(())
            })
        });
        creating_rx.recv().unwrap();

        let (deleting_tx, deleting_rx) = mpsc::channel();
        let deleting_manager = Arc::clone(&manager);
        let deleting_worktree = worktree.clone();
        let deleter = std::thread::spawn(move || {
            deleting_tx.send(()).unwrap();
            deleting_manager.stop_worktree(&deleting_worktree)
        });
        deleting_rx.recv().unwrap();
        finish_create_tx.send(()).unwrap();

        creator.join().unwrap().unwrap();
        deleter.join().unwrap().unwrap();
        std::fs::remove_dir_all(&worktree).unwrap();
        let mut created_after_removal = false;
        let create_after_stop = manager.with_worktree_creation(&worktree, || {
            created_after_removal = true;
            Ok(())
        });
        assert_eq!(create_after_stop.unwrap_err(), "Worktree is being removed.");
        assert!(!created_after_removal);
        std::fs::create_dir_all(&worktree).unwrap();
        let blocked_recreation = manager.with_worktree_creation(&worktree, || {
            created_after_removal = true;
            Ok(())
        });
        assert_eq!(
            blocked_recreation.unwrap_err(),
            "Worktree is being removed."
        );
        assert!(!created_after_removal);
        manager.allow_worktree_terminals(&worktree);
        assert!(manager.with_worktree_creation(&worktree, || Ok(())).is_ok());
        std::fs::remove_dir_all(worktree).unwrap();
    }

    #[test]
    fn failed_terminal_close_keeps_session_for_retry() {
        let mut sessions =
            std::collections::HashMap::from([("terminal".to_string(), std::sync::Arc::new(()))]);
        let error = super::stop_then_remove(&mut sessions, "terminal", |_| {
            Err("terminal stop failed".to_string())
        })
        .unwrap_err();

        assert_eq!(error, "terminal stop failed");
        assert!(sessions.contains_key("terminal"));

        super::stop_then_remove(&mut sessions, "terminal", |_| Ok(())).unwrap();
        assert!(!sessions.contains_key("terminal"));
    }

    #[test]
    fn default_editor_path_survives_argument_parsing() {
        let editor = default_editor();
        let parts = shell_words::split(&editor).expect("valid default editor");
        assert_eq!(parts.len(), 1);
    }

    #[test]
    fn inspected_output_pages_and_marks_lost_history() {
        let output = TerminalOutput {
            history: VecDeque::from(b"abcdef".to_vec()),
            start: 3,
            #[cfg(windows)]
            current_directory: Path::new("/repo").to_path_buf(),
            #[cfg(windows)]
            osc_tail: Vec::new(),
            exit_code: Some(0),
            subscriber: None,
        };
        let first = output_page("one", Path::new("/repo"), &output, 0, 2, false);
        assert_eq!(first.output, "ab");
        assert_eq!(first.cursor, 5);
        assert!(first.truncated);
        assert_eq!(first.exit_code, Some(0));
        let second = output_page("one", Path::new("/repo"), &output, first.cursor, 2, false);
        assert_eq!(second.output, "cd");
        assert_eq!(second.cursor, 7);
        assert!(!second.truncated);
        let stale = output_page("one", Path::new("/repo"), &output, 99, 2, false);
        assert!(stale.reset);
        assert_eq!(stale.output, "ab");
    }

    #[test]
    fn terminal_allowlist_resolves_path_aliases() {
        let root = std::env::temp_dir();
        let alias = format!("{}/.", root.display());
        assert_eq!(
            canonical_terminal_paths(&[alias]),
            vec![root.canonicalize().unwrap()]
        );
    }
}

fn editor_program(program: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    if !Path::new(program).is_absolute() {
        let candidate = match program {
            "code" => Some("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
            "zed" => Some("/Applications/Zed.app/Contents/MacOS/cli"),
            _ => None,
        };
        if let Some(candidate) = candidate.filter(|path| Path::new(path).is_file()) {
            return PathBuf::from(candidate);
        }
    }
    PathBuf::from(program)
}

#[derive(Default)]
pub struct TerminalManager(
    Mutex<HashMap<String, Arc<TerminalSession>>>,
    Mutex<HashSet<PathBuf>>,
);

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl TerminalManager {
    pub fn shutdown(&self) {
        let sessions = self
            .0
            .lock()
            .ok()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in sessions {
            let _ = session.stop();
        }
    }

    pub fn stop_worktree(&self, worktree: &Path) -> Result<(), String> {
        let worktree = crate::acp_terminal::stable_worktree_identity(worktree);
        let mut worktree_operations = self.1.lock().map_err(|error| error.to_string())?;
        worktree_operations.insert(worktree.clone());
        let sessions = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .filter(|(_, session)| {
                session.owner.is_some()
                    && crate::acp_terminal::worktree_contains(&worktree, &session.worktree)
            })
            .map(|(id, session)| (id.clone(), Arc::clone(session)))
            .collect::<Vec<_>>();
        for (id, session) in sessions {
            if let Err(error) = session.stop() {
                worktree_operations.remove(&worktree);
                return Err(error);
            }
            self.0
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&id);
        }
        Ok(())
    }

    pub fn allow_worktree_terminals(&self, worktree: &Path) {
        let worktree = crate::acp_terminal::stable_worktree_identity(worktree);
        if let Ok(mut operations) = self.1.lock() {
            operations.remove(&worktree);
        }
    }

    fn with_worktree_creation<T>(
        &self,
        worktree: &Path,
        create: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let worktree = crate::acp_terminal::stable_worktree_identity(worktree);
        let operations = self.1.lock().map_err(|error| error.to_string())?;
        if operations.contains(&worktree) {
            return Err("Worktree is being removed.".into());
        }
        let current = dunce::canonicalize(&worktree)
            .map_err(|_| "Worktree folder no longer exists.".to_string())?;
        if !current.is_dir() || current != worktree {
            return Err("Worktree folder changed while creating terminal.".into());
        }
        create()
    }

    pub fn server_roots(&self) -> Vec<(PathBuf, u32)> {
        self.0
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|session| {
                        if session.output.lock().ok()?.exit_code.is_some() {
                            return None;
                        }
                        Some((session.directory.clone(), session.process_id?))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn inspect(&self, id: &str, allowed: &[PathBuf]) -> Result<Arc<TerminalSession>, String> {
        let session = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .find(|session| session.inspect_id == id)
            .cloned()
            .ok_or("Unknown terminal ID.")?;
        if !allowed.contains(&session.directory) {
            return Err("Unknown terminal ID.".to_string());
        }
        Ok(session)
    }
}

pub(crate) fn canonical_terminal_paths(allowed: &[String]) -> Vec<PathBuf> {
    allowed
        .iter()
        .filter_map(|path| Path::new(path).canonicalize().ok())
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedTerminal {
    terminal_id: String,
    pane_id: String,
    worktree: String,
    state: &'static str,
    exit_code: Option<u32>,
    cursor: u64,
    base_cursor: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedOutput {
    terminal_id: String,
    worktree: String,
    state: &'static str,
    exit_code: Option<u32>,
    output: String,
    output_base64: String,
    cursor: u64,
    base_cursor: u64,
    truncated: bool,
    reset: bool,
    timed_out: bool,
}

fn output_page(
    id: &str,
    directory: &Path,
    output: &TerminalOutput,
    cursor: u64,
    max_bytes: usize,
    timed_out: bool,
) -> InspectedOutput {
    let end = output.start + output.history.len() as u64;
    let truncated = cursor < output.start;
    let reset = cursor > end;
    let offset = if truncated || reset {
        0
    } else {
        (cursor - output.start) as usize
    };
    let bytes: Vec<_> = output
        .history
        .iter()
        .skip(offset)
        .take(max_bytes)
        .copied()
        .collect();
    InspectedOutput {
        terminal_id: format!("shell:{id}"),
        worktree: directory.to_string_lossy().into_owned(),
        state: if output.exit_code.is_some() {
            "exited"
        } else {
            "running"
        },
        exit_code: output.exit_code,
        output: String::from_utf8_lossy(&bytes).into_owned(),
        output_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        cursor: output.start + offset as u64 + bytes.len() as u64,
        base_cursor: output.start,
        truncated,
        reset,
        timed_out,
    }
}

#[tauri::command]
pub fn terminal_inspect_list(
    manager: State<'_, TerminalManager>,
    allowed: Vec<String>,
) -> Result<Vec<InspectedTerminal>, String> {
    let allowed = canonical_terminal_paths(&allowed);
    let sessions = manager.0.lock().map_err(|error| error.to_string())?;
    sessions
        .iter()
        .filter(|(_, session)| allowed.contains(&session.directory))
        .map(|(id, session)| {
            let output = session.output.lock().map_err(|error| error.to_string())?;
            Ok(InspectedTerminal {
                terminal_id: format!("shell:{}", session.inspect_id),
                pane_id: id.clone(),
                worktree: session.directory.to_string_lossy().into_owned(),
                state: if output.exit_code.is_some() {
                    "exited"
                } else {
                    "running"
                },
                exit_code: output.exit_code,
                cursor: output.start + output.history.len() as u64,
                base_cursor: output.start,
            })
        })
        .collect()
}

#[tauri::command]
pub fn terminal_inspect_read(
    manager: State<'_, TerminalManager>,
    id: String,
    allowed: Vec<String>,
    cursor: u64,
    max_bytes: usize,
) -> Result<InspectedOutput, String> {
    let id = id.strip_prefix("shell:").ok_or("Unknown terminal ID.")?;
    let allowed = canonical_terminal_paths(&allowed);
    let session = manager.inspect(id, &allowed)?;
    let output = session.output.lock().map_err(|error| error.to_string())?;
    Ok(output_page(
        id,
        &session.directory,
        &output,
        cursor,
        max_bytes.clamp(1, 65_536),
        false,
    ))
}

fn wait_for_terminal(
    session: Arc<TerminalSession>,
    id: String,
    cursor: u64,
    max_bytes: usize,
    timeout_ms: u64,
) -> Result<InspectedOutput, String> {
    let output = session.output.lock().map_err(|error| error.to_string())?;
    let end = output.start + output.history.len() as u64;
    let (output, timed_out) = if cursor >= output.start
        && cursor == end
        && output.exit_code.is_none()
        && timeout_ms > 0
    {
        let (state, result) = session
            .changed
            .wait_timeout_while(
                output,
                Duration::from_millis(timeout_ms.min(30_000)),
                |state| {
                    state.start + state.history.len() as u64 == cursor && state.exit_code.is_none()
                },
            )
            .map_err(|error| error.to_string())?;
        (state, result.timed_out())
    } else {
        let timed_out = cursor == end && timeout_ms == 0 && output.exit_code.is_none();
        (output, timed_out)
    };
    Ok(output_page(
        &id,
        &session.directory,
        &output,
        cursor,
        max_bytes.clamp(1, 65_536),
        timed_out,
    ))
}

#[tauri::command]
pub async fn terminal_inspect_wait(
    manager: State<'_, TerminalManager>,
    id: String,
    allowed: Vec<String>,
    cursor: u64,
    max_bytes: usize,
    timeout_ms: u64,
) -> Result<InspectedOutput, String> {
    let id = id
        .strip_prefix("shell:")
        .ok_or("Unknown terminal ID.")?
        .to_string();
    let allowed = canonical_terminal_paths(&allowed);
    let session = manager.inspect(&id, &allowed)?;
    tauri::async_runtime::spawn_blocking(move || {
        wait_for_terminal(session, id, cursor, max_bytes, timeout_ms)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn shell() -> PathBuf {
    #[cfg(windows)]
    return std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    #[cfg(not(windows))]
    return std::env::var_os("SHELL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
}

fn spawn(
    directory: PathBuf,
    cols: u16,
    rows: u16,
    script: Option<&str>,
    id: String,
    app: AppHandle,
    owner: Option<String>,
) -> Result<TerminalSession, String> {
    let worktree = if owner.is_some() {
        git_worktree_root(&directory)
    } else {
        directory.clone()
    };
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = CommandBuilder::new(shell());
    #[cfg(not(windows))]
    if let Some(script) = script {
        command.arg("-lc");
        command.arg(script);
    } else {
        command.arg("-l");
    }
    #[cfg(windows)]
    if let Some(script) = script {
        command.arg("/C");
        command.arg(script);
    }
    command.cwd(&directory);
    if owner.is_some() {
        let cache_directory = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;
        let data_directory =
            crate::acp_terminal::worktree_data_directory(&cache_directory, &worktree);
        for (key, value) in crate::acp_terminal::terminal_environment(&data_directory) {
            std::fs::create_dir_all(&value).map_err(|error| error.to_string())?;
            command.env(key, value);
        }
    }
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    command.env("PROMPT", "$E]9;9;$P$E\\$P$G");
    #[cfg(windows)]
    let job = {
        let job = crate::acp_terminal::WindowsTerminalJob::new()?;
        command.set_job_handle(job.raw_handle());
        job
    };
    let child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let output = Arc::new(Mutex::new(TerminalOutput {
        history: VecDeque::new(),
        start: 0,
        #[cfg(windows)]
        current_directory: directory.clone(),
        #[cfg(windows)]
        osc_tail: Vec::new(),
        exit_code: None,
        subscriber: None,
    }));
    let changed = Arc::new(Condvar::new());
    let process_id = child.process_id();
    let process_group_stop = Arc::new(Mutex::new(()));
    let background_process_group_stop = Arc::clone(&process_group_stop);
    let master = Mutex::new(pair.master);
    let child = Arc::new(Mutex::new(child));
    let background_output = Arc::clone(&output);
    let background_changed = Arc::clone(&changed);
    let background_child = Arc::clone(&child);
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if let Ok(mut state) = background_output.lock() {
                        state.history.extend(&buffer[..size]);
                        let excess = state.history.len().saturating_sub(MAX_OUTPUT);
                        state.history.drain(..excess);
                        state.start += excess as u64;
                        background_changed.notify_all();
                        #[cfg(windows)]
                        update_windows_directory(&mut state, &buffer[..size]);
                        if let Some((_, channel)) = &state.subscriber {
                            let _ = channel.send(TerminalEvent::Output {
                                data: buffer[..size].to_vec(),
                            });
                        }
                    }
                }
            }
        }
        #[cfg(unix)]
        let _process_group_stop = if let Some(process_id) = process_id {
            loop {
                let guard = background_process_group_stop
                    .lock()
                    .expect("terminal process group stop lock");
                match kill_terminal_process_groups(process_id) {
                    Ok(()) => break guard,
                    Err(error) => {
                        crate::diagnostics::record(
                            "terminal_process_group_stop_failed",
                            serde_json::json!({"id":&id,"error":error}),
                        );
                        drop(guard);
                        std::thread::sleep(Duration::from_millis(100));
                    }
                }
            }
        } else {
            background_process_group_stop
                .lock()
                .expect("terminal process group stop lock")
        };
        #[cfg(windows)]
        let _process_group_stop = background_process_group_stop
            .lock()
            .expect("terminal process group stop lock");
        let code = background_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code())
            .unwrap_or(1);
        crate::diagnostics::record("terminal_exit", serde_json::json!({"id":&id,"code":code}));
        if let Ok(mut state) = background_output.lock() {
            state.exit_code = Some(code);
            background_changed.notify_all();
            if let Some((_, channel)) = &state.subscriber {
                let _ = channel.send(TerminalEvent::Exit { code });
            }
        }
        let _ = app.emit("terminal:exit", TerminalExitNotice { id, code });
    });
    Ok(TerminalSession {
        inspect_id: Uuid::new_v4().to_string(),
        owner,
        directory,
        worktree,
        process_id,
        master,
        process_group_stop,
        writer: Mutex::new(writer),
        write_busy: AtomicBool::new(false),
        #[cfg(windows)]
        job,
        output,
        changed,
    })
}

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    params: TerminalOpenParams,
    on_event: Channel<TerminalEvent>,
) -> Result<bool, String> {
    let TerminalOpenParams {
        id,
        directory,
        command,
        size,
        attachment,
    } = params;
    let TerminalSize { cols, rows } = size;
    if id.is_empty() {
        return Err("Terminal ID is required".to_string());
    }
    let directory = Path::new(&directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !directory.is_dir() {
        return Err("Terminal directory is not a folder".to_string());
    }
    let mut sessions = manager.0.lock().map_err(|error| error.to_string())?;
    let existed = sessions.contains_key(&id);
    let session = if let Some(session) = sessions.get(&id) {
        if session.directory != directory {
            return Err("Terminal belongs to another directory".to_string());
        }
        Arc::clone(session)
    } else {
        if command
            .as_ref()
            .is_some_and(|script| script.trim().is_empty())
        {
            return Err("Command is empty".to_string());
        }
        let session = Arc::new(spawn(
            directory.clone(),
            cols,
            rows,
            command.as_deref(),
            id.clone(),
            app,
            None,
        )?);
        sessions.insert(id, Arc::clone(&session));
        session
    };
    drop(sessions);
    session
        .master
        .lock()
        .map_err(|error| error.to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut output = session.output.lock().map_err(|error| error.to_string())?;
    output.subscriber = Some((attachment, on_event.clone()));
    for slice in [output.history.as_slices().0, output.history.as_slices().1] {
        for chunk in slice.chunks(8192) {
            on_event
                .send(TerminalEvent::Output {
                    data: chunk.to_vec(),
                })
                .map_err(|error| error.to_string())?;
        }
    }
    if let Some(code) = output.exit_code {
        on_event
            .send(TerminalEvent::Exit { code })
            .map_err(|error| error.to_string())?;
    }
    Ok(existed)
}

#[tauri::command]
pub fn terminal_detach(
    manager: State<'_, TerminalManager>,
    id: String,
    attachment: String,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned();
    if let Some(session) = session {
        let mut output = session.output.lock().map_err(|error| error.to_string())?;
        if output
            .subscriber
            .as_ref()
            .is_some_and(|(current, _)| current == &attachment)
        {
            output.subscriber = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let result = session
        .writer
        .lock()
        .map_err(|error| error.to_string())?
        .write_all(&data)
        .map_err(|error| error.to_string());
    result
}

fn owned_session(
    manager: &TerminalManager,
    terminal_id: &str,
    owner: &str,
) -> Result<Arc<TerminalSession>, String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .find(|session| format!("shell:{}", session.inspect_id) == terminal_id)
        .cloned()
        .ok_or("Unknown terminal ID.")?;
    if session.owner.as_deref() != Some(owner) {
        return Err("Terminal belongs to another source session.".into());
    }
    Ok(session)
}

pub(crate) fn git_worktree_root(directory: &Path) -> PathBuf {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["rev-parse", "--show-toplevel"])
        .output();
    output
        .ok()
        .filter(|output| output.status.success())
        .map(|output| PathBuf::from(String::from_utf8_lossy(&output.stdout).trim()))
        .and_then(|path| dunce::canonicalize(path).ok())
        .unwrap_or_else(|| directory.to_path_buf())
}

#[tauri::command]
pub fn terminal_owned_create(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    pane_id: String,
    directory: String,
    command: String,
    owner: String,
) -> Result<String, String> {
    if pane_id.is_empty() || owner.is_empty() || command.trim().is_empty() {
        return Err("Terminal pane, owner, and command are required.".into());
    }
    if command.len() > 16_384 {
        return Err("Terminal command exceeds 16384 bytes.".into());
    }
    let directory = Path::new(&directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !directory.is_dir() {
        return Err("Terminal directory is not a folder.".into());
    }
    let worktree = git_worktree_root(&directory);
    manager.with_worktree_creation(&worktree, || {
        let current_directory = dunce::canonicalize(&directory)
            .map_err(|_| "Terminal directory no longer exists.".to_string())?;
        if current_directory != directory || !current_directory.is_dir() {
            return Err("Terminal directory changed while creating terminal.".into());
        }
        let mut sessions = manager.0.lock().map_err(|error| error.to_string())?;
        if sessions.contains_key(&pane_id) {
            return Err("Terminal pane already exists.".into());
        }
        let session = Arc::new(spawn(
            directory.clone(),
            80,
            24,
            Some(&command),
            pane_id.clone(),
            app,
            Some(owner),
        )?);
        let terminal_id = format!("shell:{}", session.inspect_id);
        sessions.insert(pane_id, session);
        Ok(terminal_id)
    })
}

#[tauri::command]
pub async fn terminal_owned_write(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    owner: String,
    data: String,
) -> Result<(), String> {
    if data.is_empty() || data.len() > 16_384 {
        return Err("Terminal input must be 1–16384 bytes.".into());
    }
    let session = owned_session(&manager, &terminal_id, &owner)?;
    if session
        .output
        .lock()
        .map_err(|error| error.to_string())?
        .exit_code
        .is_some()
    {
        return Err("Terminal has exited.".into());
    }
    if session.write_busy.swap(true, Ordering::AcqRel) {
        return Err("Terminal input is already in progress.".into());
    }
    let task = tauri::async_runtime::spawn_blocking(move || {
        let result = session
            .writer
            .lock()
            .map_err(|error| error.to_string())
            .and_then(|mut writer| {
                writer
                    .write_all(data.as_bytes())
                    .map_err(|error| error.to_string())
            });
        session.write_busy.store(false, Ordering::Release);
        result
    });
    task.await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn terminal_owned_stop(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    owner: String,
) -> Result<(), String> {
    owned_session(&manager, &terminal_id, &owner)?.stop()?;
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let result = session
        .master
        .lock()
        .map_err(|error| error.to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub fn terminal_close(manager: State<'_, TerminalManager>, id: String) -> Result<(), String> {
    let mut sessions = manager.0.lock().map_err(|error| error.to_string())?;
    stop_then_remove(&mut sessions, &id, TerminalSession::stop)
}

fn stop_then_remove<T>(
    sessions: &mut HashMap<String, Arc<T>>,
    id: &str,
    stop: impl FnOnce(&T) -> Result<(), String>,
) -> Result<(), String> {
    if let Some(session) = sessions.get(id) {
        stop(session)?;
    }
    sessions.remove(id);
    Ok(())
}

fn shell_directory(session: &TerminalSession) -> PathBuf {
    #[cfg(windows)]
    if let Ok(output) = session.output.lock() {
        return output.current_directory.clone();
    }
    #[cfg(target_os = "linux")]
    if let Some(pid) = session.process_id {
        if let Ok(directory) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
            return directory;
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(pid) = session.process_id {
        if let Ok(output) = Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
        {
            if output.status.success() {
                if let Some(directory) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .find_map(|line| line.strip_prefix('n'))
                {
                    return PathBuf::from(directory);
                }
            }
        }
    }
    session.directory.clone()
}

#[cfg(windows)]
fn update_windows_directory(output: &mut TerminalOutput, bytes: &[u8]) {
    output.osc_tail.extend_from_slice(bytes);
    for start in 0..output.osc_tail.len().saturating_sub(3) {
        if !output.osc_tail[start..].starts_with(b"\x1b]9;9;") {
            continue;
        }
        if let Some(end) = output.osc_tail[start + 6..]
            .windows(2)
            .position(|pair| pair == b"\x1b\\")
        {
            let path = &output.osc_tail[start + 6..start + 6 + end];
            if let Ok(path) = std::str::from_utf8(path) {
                let directory = PathBuf::from(path);
                if directory.is_dir() {
                    output.current_directory = directory;
                }
            }
        }
    }
    if output.osc_tail.len() > 8192 {
        let excess = output.osc_tail.len() - 8192;
        output.osc_tail.drain(..excess);
    }
}

#[tauri::command]
pub fn terminal_open_file(
    manager: State<'_, TerminalManager>,
    id: String,
    path: String,
    line: u32,
) -> Result<(), String> {
    if line == 0 {
        return Err("Line number must be positive".to_string());
    }
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let directory = shell_directory(&session);
    let candidate = Path::new(&path);
    let file = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        directory.join(candidate)
    }
    .canonicalize()
    .map_err(|error| error.to_string())?;
    if !file.is_file() {
        return Err("Terminal link is not a file".to_string());
    }
    let editor = std::env::var("SAIL_EDITOR")
        .or_else(|_| std::env::var("VISUAL"))
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| default_editor());
    let parts = shell_words::split(&editor).map_err(|error| error.to_string())?;
    let (program, arguments) = parts.split_first().ok_or("Editor is empty")?;
    let name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program);
    let terminal_editor = ["vim", "nvim", "vi", "nano", "emacs"].contains(&name);
    let mut command = if terminal_editor {
        #[cfg(target_os = "macos")]
        {
            let ghostty = Path::new("/Applications/Ghostty.app/Contents/MacOS/ghostty");
            if ghostty.is_file() {
                let mut command = Command::new(ghostty);
                command.arg("-e").arg(program);
                command
            } else {
                let invocation = std::iter::once(program.as_str())
                    .chain(arguments.iter().map(String::as_str))
                    .chain(
                        [format!("+{line}"), file.to_string_lossy().into_owned()]
                            .iter()
                            .map(String::as_str),
                    )
                    .map(shell_words::quote)
                    .collect::<Vec<_>>()
                    .join(" ");
                Command::new("/usr/bin/osascript")
                    .args([
                        "-e",
                        "on run argv",
                        "-e",
                        "tell application \"Terminal\" to do script (item 1 of argv)",
                        "-e",
                        "end run",
                        "--",
                        &invocation,
                    ])
                    .spawn()
                    .map_err(|error| error.to_string())?;
                return Ok(());
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut command = Command::new("x-terminal-emulator");
            command.arg("-e").arg(program);
            command
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("wt.exe");
            command.arg(program);
            command
        }
    } else {
        Command::new(editor_program(program))
    };
    command.args(arguments);
    if ["code", "codium", "cursor"].contains(&name) {
        command.arg("--goto");
        command.arg(format!("{}:{line}", file.display()));
    } else if terminal_editor {
        command.arg(format!("+{line}"));
        command.arg(file);
    } else {
        command.arg(format!("{}:{line}", file.display()));
    }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}
