use serde::{Deserialize, Serialize};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
#[cfg(not(target_os = "macos"))]
use sysinfo::{Pid, System};

static REGISTRY: OnceLock<Registry> = OnceLock::new();
const RECOVERY_GRACE: Duration = Duration::from_secs(5);

#[derive(Clone, Debug, Deserialize, Serialize)]
struct ProcessRecord {
    run: String,
    pid: u32,
    group: u32,
    started: u64,
    recorded: u64,
}

#[derive(Debug, Deserialize, Serialize)]
struct ProcessFile {
    owner_pid: u32,
    owner_started: u64,
    processes: Vec<ProcessRecord>,
}

struct Registry {
    directory: PathBuf,
    file: PathBuf,
    state: Mutex<ProcessFile>,
}

#[cfg(target_os = "macos")]
fn process_info(pid: u32) -> Option<nix::libc::proc_bsdinfo> {
    let mut info = std::mem::MaybeUninit::<nix::libc::proc_bsdinfo>::uninit();
    let size = std::mem::size_of::<nix::libc::proc_bsdinfo>();
    // A full kernel record is required before reading its process identity.
    let read = unsafe {
        nix::libc::proc_pidinfo(
            pid as i32,
            nix::libc::PROC_PIDTBSDINFO,
            0,
            info.as_mut_ptr().cast(),
            size as i32,
        )
    };
    if read != size as i32 {
        return None;
    }
    Some(unsafe { info.assume_init() })
}

#[cfg(target_os = "macos")]
fn process_started(pid: u32) -> Option<u64> {
    let info = process_info(pid)?;
    info.pbi_start_tvsec
        .checked_mul(1_000_000)?
        .checked_add(info.pbi_start_tvusec)
}

#[cfg(not(target_os = "macos"))]
fn process_started(pid: u32) -> Option<u64> {
    let mut system = System::new();
    system.refresh_processes(
        sysinfo::ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
    );
    system
        .process(Pid::from_u32(pid))
        .map(|process| process.start_time())
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

fn write_file(path: &Path, state: &ProcessFile) -> Result<(), String> {
    let temporary = path.with_extension("tmp");
    let bytes = serde_json::to_vec(state).map_err(|error| error.to_string())?;
    let mut options = std::fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| error.to_string())?;
    file.write_all(&bytes).map_err(|error| error.to_string())?;
    file.sync_all().map_err(|error| error.to_string())?;
    std::fs::rename(temporary, path).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    std::fs::File::open(path.parent().ok_or("Owned process path has no parent.")?)
        .and_then(|directory| directory.sync_all())
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(unix)]
fn stop_process(record: &ProcessRecord) -> Result<bool, String> {
    match process_started(record.pid) {
        Some(started) if started != record.started => return Ok(false),
        // A group can outlive its leader. Its ID remains reserved while any
        // member survives, so an absent leader does not make that group stale.
        Some(_) | None => {}
    }
    #[cfg(target_os = "macos")]
    if let Some(info) = process_info(record.pid) {
        if info.pbi_pgid != record.group {
            return Ok(false);
        }
    }
    let group = nix::unistd::Pid::from_raw(record.group as i32);
    if group.as_raw() <= 0 || group == nix::unistd::getpgrp() {
        return Err("Refusing to stop the Sail process group.".into());
    }
    match nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGKILL) {
        Ok(()) => Ok(true),
        Err(nix::errno::Errno::ESRCH) => Ok(false),
        Err(error) => Err(error.to_string()),
    }
}

#[cfg(windows)]
fn stop_process(record: &ProcessRecord) -> Result<bool, String> {
    if process_started(record.pid) != Some(record.started) {
        return Ok(false);
    }
    let output = std::process::Command::new("taskkill")
        .args(["/PID", &record.pid.to_string(), "/T", "/F"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(format!(
            "taskkill failed for PID {}: {}",
            record.pid,
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(true)
}

fn report(record: &ProcessRecord, reason: &str, stopped: bool) {
    crate::diagnostics::record(
        "owned_process_cleanup",
        serde_json::json!({
            "run": record.run,
            "pid": record.pid,
            "group": record.group,
            "reason": reason,
            "stopped": stopped
        }),
    );
}

impl Registry {
    fn save(&self, state: &ProcessFile) -> Result<(), String> {
        write_file(&self.file, state)
    }

    fn register(&self, run: &str, pid: u32, group: u32) -> Result<(), String> {
        if group == 0 || group > i32::MAX as u32 {
            return Err("Invalid owned process group.".into());
        }
        #[cfg(unix)]
        if pid != group {
            return Err("Owned process must lead its process group.".into());
        }
        let started = process_started(pid).ok_or("Cannot identify owned process.")?;
        #[cfg(target_os = "macos")]
        if process_info(pid).is_none_or(|info| info.pbi_pgid != group) {
            return Err("Owned process is not in its recorded group.".into());
        }
        let record = ProcessRecord {
            run: run.to_string(),
            pid,
            group,
            started,
            recorded: now(),
        };
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.processes.push(record);
        self.save(&state)
    }

    fn stop_matching(
        &self,
        reason: &str,
        matches: impl Fn(&ProcessRecord) -> bool,
    ) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        let mut retained = Vec::new();
        let mut errors = Vec::new();
        for record in state.processes.drain(..) {
            if !matches(&record) {
                retained.push(record);
                continue;
            }
            match stop_process(&record) {
                Ok(stopped) => report(&record, reason, stopped),
                Err(error) => {
                    errors.push(format!("PID {}: {error}", record.pid));
                    retained.push(record);
                }
            }
        }
        state.processes = retained;
        self.save(&state)?;
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }

    fn stop_run(&self, run: &str) -> Result<(), String> {
        self.stop_matching("run_finished", |record| record.run == run)
    }

    fn stop_pid(&self, run: &str, pid: u32) -> Result<(), String> {
        self.stop_matching("terminal_stopped", |record| {
            record.run == run && record.pid == pid
        })
    }

    fn recover(&self) -> Result<(), String> {
        let mut errors = Vec::new();
        for entry in std::fs::read_dir(&self.directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let path = entry.path();
            if path == self.file
                || !path.file_name().is_some_and(|name| {
                    name.to_string_lossy().starts_with("owned-processes-")
                        && name.to_string_lossy().ends_with(".json")
                })
            {
                continue;
            }
            let bytes = match std::fs::read(&path) {
                Ok(bytes) => bytes,
                Err(error) => {
                    errors.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            let mut file: ProcessFile = match serde_json::from_slice(&bytes) {
                Ok(file) => file,
                Err(error) => {
                    errors.push(format!("{}: {error}", path.display()));
                    continue;
                }
            };
            if process_started(file.owner_pid) == Some(file.owner_started) {
                continue;
            }
            let mut retained = Vec::new();
            for record in file.processes.drain(..) {
                if now().saturating_sub(record.recorded) < RECOVERY_GRACE.as_secs() {
                    retained.push(record);
                    continue;
                }
                match stop_process(&record) {
                    Ok(stopped) => report(&record, "startup_recovery", stopped),
                    Err(error) => {
                        crate::diagnostics::record(
                            "owned_process_cleanup_failed",
                            serde_json::json!({
                                "run": record.run, "pid": record.pid, "error": error
                            }),
                        );
                        retained.push(record);
                    }
                }
            }
            file.processes = retained;
            let result = if file.processes.is_empty() {
                std::fs::remove_file(&path).map_err(|error| error.to_string())
            } else {
                write_file(&path, &file)
            };
            if let Err(error) = result {
                errors.push(format!("{}: {error}", path.display()));
            }
        }
        if errors.is_empty() {
            Ok(())
        } else {
            Err(errors.join("; "))
        }
    }
}

pub fn init(directory: PathBuf) -> Result<(), String> {
    std::fs::create_dir_all(&directory).map_err(|error| error.to_string())?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(&directory, std::fs::Permissions::from_mode(0o700))
            .map_err(|error| error.to_string())?;
    }
    let owner_pid = std::process::id();
    let owner_started = process_started(owner_pid).ok_or("Cannot identify Sail process.")?;
    let file = directory.join(format!("owned-processes-{}.json", uuid::Uuid::new_v4()));
    let registry = Registry {
        directory,
        file,
        state: Mutex::new(ProcessFile {
            owner_pid,
            owner_started,
            processes: Vec::new(),
        }),
    };
    {
        let state = registry.state.lock().map_err(|error| error.to_string())?;
        registry.save(&state)?;
    }
    REGISTRY
        .set(registry)
        .map_err(|_| "Owned process registry is already initialized.".to_string())?;
    std::thread::spawn(|| {
        std::thread::sleep(RECOVERY_GRACE);
        if let Some(registry) = REGISTRY.get() {
            if let Err(error) = registry.recover() {
                crate::diagnostics::record(
                    "owned_process_recovery_failed",
                    serde_json::json!({"error": error}),
                );
            }
        }
    });
    Ok(())
}

pub fn register(run: &str, pid: u32, group: u32) -> Result<(), String> {
    REGISTRY
        .get()
        .ok_or("Owned process registry is unavailable.")?
        .register(run, pid, group)
}

pub fn stop_run(run: &str) -> Result<(), String> {
    REGISTRY
        .get()
        .ok_or("Owned process registry is unavailable.")?
        .stop_run(run)
}

pub fn stop_pid(run: &str, pid: u32) -> Result<(), String> {
    REGISTRY
        .get()
        .ok_or("Owned process registry is unavailable.")?
        .stop_pid(run, pid)
}

pub fn shutdown() -> Result<(), String> {
    let registry = REGISTRY
        .get()
        .ok_or("Owned process registry is unavailable.")?;
    let runs = registry
        .state
        .lock()
        .map_err(|error| error.to_string())?
        .processes
        .iter()
        .map(|record| record.run.clone())
        .collect::<std::collections::HashSet<_>>();
    for run in runs {
        registry.stop_run(&run)?;
    }
    std::fs::remove_file(&registry.file).map_err(|error| error.to_string())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::os::unix::process::CommandExt;
    use std::process::{Child, Command};

    fn directory() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("sail-owned-process-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    fn new_registry(path: &Path, owner_started: u64) -> Registry {
        let file = path.join(format!("owned-processes-{}.json", uuid::Uuid::new_v4()));
        let state = ProcessFile {
            owner_pid: std::process::id(),
            owner_started,
            processes: Vec::new(),
        };
        write_file(&file, &state).unwrap();
        Registry {
            directory: path.to_path_buf(),
            file,
            state: Mutex::new(state),
        }
    }

    struct Sleeper(Child);

    impl Drop for Sleeper {
        fn drop(&mut self) {
            let _ = self.0.kill();
            let _ = self.0.wait();
        }
    }

    fn sleeper() -> Sleeper {
        Sleeper(
            Command::new("sleep")
                .arg("30")
                .process_group(0)
                .spawn()
                .unwrap(),
        )
    }

    fn running(child: &mut Sleeper) -> bool {
        child.0.try_wait().unwrap().is_none()
    }

    #[test]
    fn completion_stops_only_registered_run() {
        let path = directory();
        let registry = new_registry(&path, process_started(std::process::id()).unwrap());
        let mut owned = sleeper();
        let mut unrelated = sleeper();
        registry
            .register("run-a", owned.0.id(), owned.0.id())
            .unwrap();
        registry.stop_run("run-a").unwrap();
        owned.0.wait().unwrap();
        assert!(running(&mut unrelated));
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn recovery_checks_owner_and_process_identity() {
        let path = directory();
        let registry = new_registry(&path, process_started(std::process::id()).unwrap());
        let previous = new_registry(&path, 0);
        let mut stale = sleeper();
        let mut reused = sleeper();
        let mut unrelated = sleeper();
        previous
            .register("crashed-run", stale.0.id(), stale.0.id())
            .unwrap();
        {
            let mut state = previous.state.lock().unwrap();
            state.processes[0].recorded = now() - RECOVERY_GRACE.as_secs();
            state.processes.push(ProcessRecord {
                run: "reused-pid".into(),
                pid: reused.0.id(),
                group: reused.0.id(),
                started: 0,
                recorded: now() - RECOVERY_GRACE.as_secs(),
            });
            previous.save(&state).unwrap();
        }
        registry.recover().unwrap();
        stale.0.wait().unwrap();
        assert!(running(&mut reused));
        assert!(running(&mut unrelated));
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn malformed_recovery_file_does_not_skip_valid_owners() {
        let path = directory();
        let registry = new_registry(&path, process_started(std::process::id()).unwrap());
        let previous = new_registry(&path, 0);
        let mut stale = sleeper();
        previous
            .register("crashed-run", stale.0.id(), stale.0.id())
            .unwrap();
        {
            let mut state = previous.state.lock().unwrap();
            state.processes[0].recorded = now() - RECOVERY_GRACE.as_secs();
            previous.save(&state).unwrap();
        }
        std::fs::write(path.join("owned-processes-invalid.json"), b"{").unwrap();

        assert!(registry.recover().is_err());
        stale.0.wait().unwrap();
        assert!(!previous.file.exists());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn owned_pty_uses_child_as_process_group_leader() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("sleep");
        command.arg("30");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        let group = pair.master.process_group_leader();
        let _ = child.kill();
        let _ = child.wait();
        assert_eq!(group, Some(pid as i32));
    }

    #[test]
    fn owned_pty_group_stops_from_the_registry() {
        use portable_pty::{native_pty_system, CommandBuilder, PtySize};

        let path = directory();
        let registry = new_registry(&path, process_started(std::process::id()).unwrap());
        let pair = native_pty_system()
            .openpty(PtySize {
                rows: 24,
                cols: 80,
                pixel_width: 0,
                pixel_height: 0,
            })
            .unwrap();
        let mut command = CommandBuilder::new("sleep");
        command.arg("30");
        let mut child = pair.slave.spawn_command(command).unwrap();
        let pid = child.process_id().unwrap();
        let group = pair.master.process_group_leader().unwrap() as u32;

        registry.register("owned-pty", pid, group).unwrap();
        registry.stop_pid("owned-pty", pid).unwrap();
        assert!(!child.wait().unwrap().success());
        assert!(registry.state.lock().unwrap().processes.is_empty());
        std::fs::remove_dir_all(path).unwrap();
    }

    #[test]
    fn fast_exiting_child_keeps_its_identity_until_reaped() {
        for _ in 0..20 {
            let mut child = Command::new("true").process_group(0).spawn().unwrap();
            assert!(process_started(child.id()).is_some());
            let _ = child.wait();
        }
    }
}
