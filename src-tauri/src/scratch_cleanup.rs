use std::fs;
#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use sysinfo::{
    Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, Signal, System, UpdateKind,
};

const IDLE_AGE: Duration = Duration::from_secs(2 * 60 * 60);
const MARKER: &str = ".sail-scratch-root";
const PRIVATE_MARKER: &str = ".sail-cleanup-private";
const PRIVATE_MARKER_VALUE: &str = "sail-cleanup-private-v1\n";
const PRIVATE_OWNER: &str = ".sail-cleanup-owner";

pub(crate) fn sweep_on_startup(cache_directory: Option<&Path>) {
    let root = std::env::temp_dir();
    let now = SystemTime::now();
    let mut phases = serde_json::Map::new();
    let probe = OpenFileProbe::default();
    let open_files = |path: &Path| probe.check(path);
    let mut timed = |name: &str, run: &mut dyn FnMut() -> std::io::Result<u64>| {
        let started = std::time::Instant::now();
        let result = run();
        phases.insert(
            format!("{name}Ms"),
            serde_json::json!(started.elapsed().as_millis() as u64),
        );
        result
    };
    let result = timed("temp", &mut || sweep(&root, now, open_files))
        .and_then(|bytes| {
            if let Some(cache_directory) = cache_directory {
                timed("worktreeTemp", &mut || {
                    sweep_worktree_temp_dirs(cache_directory, now, open_files)
                })
                .map(|worktree_bytes| bytes + worktree_bytes)
            } else {
                Ok(bytes)
            }
        })
        .and_then(|bytes| {
            let Some(home) = std::env::var_os("HOME").map(PathBuf::from) else {
                return Ok(bytes);
            };
            timed("native", &mut || sweep_native_roots(&home, now, open_files))
                .map(|native| bytes + native)
        });
    let freed = result.as_ref().ok().copied();
    phases.insert("freedBytes".into(), serde_json::json!(freed));
    crate::diagnostics::record("startup_scratch_sweep", serde_json::Value::Object(phases));
    match result {
        Ok(bytes) => eprintln!("Sail scratch cleanup freed {bytes} bytes"),
        Err(error) => eprintln!("Sail scratch cleanup unavailable: {error}"),
    }
}

const RUNTIME_PREFIX: &str = "sail-runtime-";
const UNMARKED_GRACE: Duration = Duration::from_secs(10 * 60);
// A quarantine untouched this long belongs to a removal that died, not one
// still deleting a large tree in another thread or Sail.
const QUARANTINE_GRACE: Duration = Duration::from_secs(10 * 60);

pub(crate) enum RuntimeRootEvent {
    Removed { bytes: u64 },
    Kept { reason: &'static str },
}

/// Removes `sail-runtime-<uuid>` roots whose agent has exited. Unlike the
/// startup sweep it skips the idle-age check: a root with a dead owner and no
/// open files has no user, and waiting two hours left multi-GB build output
/// for a whole session.
pub(crate) fn sweep_runtime_roots(
    in_use: &dyn Fn(&Path) -> bool,
    report: &mut dyn FnMut(&str, RuntimeRootEvent),
) {
    let probe = OpenFileProbe::default();
    if let Err(error) = sweep_runtime_roots_in(
        &std::env::temp_dir(),
        SystemTime::now(),
        |path| probe.check(path),
        |paths| probe.check_quarantined(paths),
        in_use,
        report,
    ) {
        eprintln!("Sail runtime scratch cleanup unavailable: {error}");
    }
}

const RUNTIME_SWEEP_DELAY: Duration = Duration::from_secs(15);
const RUNTIME_SWEEP_INTERVAL: Duration = Duration::from_secs(5 * 60);

/// Reclaims runtime roots every five minutes, so one whose agent exited is gone
/// within ten, whether it died in this session or an earlier one.
pub(crate) fn spawn_runtime_sweeper(
    in_use: impl Fn(&Path) -> bool + Send + 'static,
) -> std::io::Result<()> {
    std::thread::Builder::new()
        .name("sail-runtime-scratch-sweep".into())
        .spawn(move || {
            std::thread::sleep(RUNTIME_SWEEP_DELAY);
            let mut log = RuntimeSweepLog::default();
            loop {
                log.sweep(&in_use, crate::diagnostics::record);
                std::thread::sleep(RUNTIME_SWEEP_INTERVAL);
            }
        })
        .map(|_| ())
}

// A kept root is logged once per reason, not on every pass.
#[derive(Default)]
struct RuntimeSweepLog {
    kept: std::collections::HashMap<String, &'static str>,
}

impl RuntimeSweepLog {
    fn sweep(
        &mut self,
        in_use: &dyn Fn(&Path) -> bool,
        mut record: impl FnMut(&str, serde_json::Value),
    ) {
        let mut seen = std::collections::HashMap::new();
        sweep_runtime_roots(in_use, &mut |name, event| {
            self.observe(name, event, &mut seen, &mut record)
        });
        self.kept = seen;
    }

    fn observe(
        &self,
        name: &str,
        event: RuntimeRootEvent,
        seen: &mut std::collections::HashMap<String, &'static str>,
        record: &mut impl FnMut(&str, serde_json::Value),
    ) {
        match event {
            RuntimeRootEvent::Removed { bytes } => record(
                "scratch_runtime_removed",
                serde_json::json!({"root": name, "bytes": bytes}),
            ),
            RuntimeRootEvent::Kept { reason } => {
                seen.insert(name.to_string(), reason);
                if self.kept.get(name) != Some(&reason) {
                    record(
                        "scratch_runtime_kept",
                        serde_json::json!({"root": name, "reason": reason}),
                    );
                }
            }
        }
    }
}

// A Sail killed while deleting a runtime root leaves its quarantine behind.
// Reclaim it here, so it does not wait for a restart and the startup sweep's
// two hour idle rule. A root whose owner still runs goes back under its name.
fn reclaim_runtime_quarantines(
    temp: &Path,
    now: SystemTime,
    euid: u32,
    open_files: &impl Fn(&Path) -> Option<bool>,
    report: &mut dyn FnMut(&str, RuntimeRootEvent),
) -> std::io::Result<()> {
    for entry in fs::read_dir(temp)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(original) = private_quarantine_name(name) else {
            continue;
        };
        if !original.strip_prefix(RUNTIME_PREFIX).is_some_and(|id| {
            uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.hyphenated().to_string() == id)
        }) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.uid() != euid {
            continue;
        }
        match reclaim_private_quarantine(
            temp,
            &path,
            original,
            &metadata,
            &PrivateReclaim {
                now,
                min_age: QUARANTINE_GRACE,
                idle_at: now + IDLE_AGE + Duration::from_secs(1),
            },
            open_files,
        ) {
            PrivateOutcome::Removed(bytes) => report(original, RuntimeRootEvent::Removed { bytes }),
            PrivateOutcome::Kept => report(
                original,
                RuntimeRootEvent::Kept {
                    reason: "quarantine in use",
                },
            ),
            PrivateOutcome::Skipped | PrivateOutcome::Restored => {}
        }
    }
    Ok(())
}

// Roots hidden in quarantine per final open-file check. One lsof call
// answers a whole batch, so a pass costs a few scans instead of one per root.
const RUNTIME_RECLAIM_BATCH: usize = 100;

struct RuntimeCandidate {
    name: String,
    path: PathBuf,
    device: u64,
    bytes: u64,
}

fn sweep_runtime_roots_in(
    temp: &Path,
    now: SystemTime,
    open_files: impl Fn(&Path) -> Option<bool>,
    quarantined_open_files: impl Fn(&[PathBuf]) -> Vec<Option<bool>>,
    in_use: &dyn Fn(&Path) -> bool,
    report: &mut dyn FnMut(&str, RuntimeRootEvent),
) -> std::io::Result<()> {
    let euid = unsafe { nix::libc::geteuid() };
    reclaim_runtime_quarantines(temp, now, euid, &open_files, report)?;
    let ignore_idle_age = now + IDLE_AGE + Duration::from_secs(1);
    let mut candidates = Vec::new();
    for entry in fs::read_dir(temp)? {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        let Some(id) = name.strip_prefix(RUNTIME_PREFIX) else {
            continue;
        };
        if !uuid::Uuid::parse_str(id).is_ok_and(|uuid| uuid.hyphenated().to_string() == id) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.uid() != euid {
            continue;
        }
        let marker = path.join(MARKER);
        match owner_status(&marker) {
            Some(true) => {}
            Some(false) => {
                report(
                    name,
                    RuntimeRootEvent::Kept {
                        reason: "owner running",
                    },
                );
                continue;
            }
            None if marker.exists() => {
                report(
                    name,
                    RuntimeRootEvent::Kept {
                        reason: "unreadable owner marker",
                    },
                );
                continue;
            }
            None => {
                // A root is unmarked between its creation and the agent spawn.
                let young = now
                    .duration_since(metadata.modified()?)
                    .is_ok_and(|age| age < UNMARKED_GRACE);
                if !young {
                    report(
                        name,
                        RuntimeRootEvent::Kept {
                            reason: "no owner marker",
                        },
                    );
                }
                continue;
            }
        }
        // A gate of another agent can build inside this root after its agent died.
        if in_use(&path) {
            report(
                name,
                RuntimeRootEvent::Kept {
                    reason: "build in use",
                },
            );
            continue;
        }
        let Ok(Some(bytes)) = inspect(&path, metadata.dev(), ignore_idle_age) else {
            report(
                name,
                RuntimeRootEvent::Kept {
                    reason: "not removable",
                },
            );
            continue;
        };
        candidates.push(RuntimeCandidate {
            name: name.to_string(),
            path,
            device: metadata.dev(),
            bytes,
        });
    }
    for batch in candidates.chunks(RUNTIME_RECLAIM_BATCH) {
        reclaim_runtime_batch(
            temp,
            batch,
            ignore_idle_age,
            &open_files,
            &quarantined_open_files,
            in_use,
            report,
        );
    }
    Ok(())
}

fn reclaim_runtime_batch(
    temp: &Path,
    batch: &[RuntimeCandidate],
    now: SystemTime,
    open_files: &impl Fn(&Path) -> Option<bool>,
    quarantined_open_files: &impl Fn(&[PathBuf]) -> Vec<Option<bool>>,
    in_use: &dyn Fn(&Path) -> bool,
    report: &mut dyn FnMut(&str, RuntimeRootEvent),
) {
    let mut hidden = Vec::new();
    for candidate in batch {
        // Earlier batches took time since the scan; a gate may have started.
        if in_use(&candidate.path) {
            report(
                &candidate.name,
                RuntimeRootEvent::Kept {
                    reason: "build in use",
                },
            );
            continue;
        }
        match quarantine_root(
            temp,
            &candidate.path,
            &candidate.name,
            candidate.device,
            open_files,
        ) {
            Ok(quarantined) => hidden.push((candidate, quarantined)),
            Err(_) if !candidate.path.exists() => {}
            Err(reason) => report(&candidate.name, RuntimeRootEvent::Kept { reason }),
        }
    }
    let paths = hidden
        .iter()
        .map(|(_, quarantined)| quarantined.quarantine.clone())
        .collect::<Vec<_>>();
    let mut open = quarantined_open_files(&paths).into_iter();
    for (candidate, quarantined) in hidden {
        let open = open.next().flatten();
        match finish_quarantined(quarantined, now, || open) {
            Ok(()) => report(
                &candidate.name,
                RuntimeRootEvent::Removed {
                    bytes: candidate.bytes,
                },
            ),
            Err(_) if !candidate.path.exists() => {}
            Err(reason) => report(&candidate.name, RuntimeRootEvent::Kept { reason }),
        }
    }
}

/// Native acceptance runs install a signed app under `~/Applications`, outside
/// the system temporary directory, so the `$TMPDIR` sweep never sees them.
fn sweep_native_roots(
    home: &Path,
    now: SystemTime,
    open_files: impl Fn(&Path) -> Option<bool>,
) -> std::io::Result<u64> {
    match sweep_with(&home.join("Applications"), now, open_files, true) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        result => result,
    }
}

fn sweep_worktree_temp_dirs(
    cache_directory: &Path,
    now: SystemTime,
    open_files: impl Fn(&Path) -> Option<bool>,
) -> std::io::Result<u64> {
    let storage = cache_directory.join("terminal-worktrees");
    let entries = match fs::read_dir(storage) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(0),
        Err(error) => return Err(error),
    };
    let owner = unsafe { nix::libc::geteuid() };
    let mut freed = 0;
    for entry in entries {
        let Ok(entry) = entry else { continue };
        let name = entry.file_name();
        let Some(name) = name.to_str() else { continue };
        if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let path = entry.path();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.uid() != owner {
            continue;
        }
        let temp = path.join("tmp");
        let Ok(metadata) = fs::symlink_metadata(&temp) else {
            continue;
        };
        if !metadata.is_dir() || metadata.uid() != owner {
            continue;
        }
        match sweep(&temp, now, &open_files) {
            Ok(bytes) => freed += bytes,
            Err(error) => eprintln!("Sail scratch cleanup kept {}: {error}", temp.display()),
        }
    }
    Ok(freed)
}

pub(crate) fn owner_identity() -> Option<String> {
    owner_identity_for_pid(std::process::id())
}

pub(crate) fn owner_identity_for_pid(pid: u32) -> Option<String> {
    let started = process_start_time(pid)?;
    Some(format!("{pid} {started}"))
}

// An agent that died but was not reaped still answers `kill(pid, 0)`. It has
// exited and holds nothing, so its root is reclaimable.
#[cfg(target_os = "macos")]
fn unreaped_zombie(pid: u32) -> bool {
    // sysinfo drops a macOS zombie and proc_pidinfo reports it as running, so
    // read the kernel's process table entry through `ps`.
    Command::new("/bin/ps")
        .args(["-o", "stat=", "-p"])
        .arg(pid.to_string())
        .output()
        .is_ok_and(|output| output.stdout.trim_ascii().starts_with(b"Z"))
}

#[cfg(not(target_os = "macos"))]
fn unreaped_zombie(pid: u32) -> bool {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing(),
    );
    system
        .process(Pid::from_u32(pid))
        .is_some_and(|process| process.status() == ProcessStatus::Zombie)
}

fn process_start_time(pid: u32) -> Option<u64> {
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing(),
    );
    Some(system.process(Pid::from_u32(pid))?.start_time())
}

pub(crate) struct OwnedRuntimeScratch {
    path: PathBuf,
    identity: crate::WorktreeDirectoryIdentity,
    owner: Option<String>,
    cleaned: bool,
}

impl OwnedRuntimeScratch {
    pub(crate) fn create() -> std::io::Result<Self> {
        Self::create_in(&std::env::temp_dir())
    }

    fn create_in(temp: &Path) -> std::io::Result<Self> {
        let path = temp.join(format!("sail-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&path)?;
        if let Err(error) = fs::create_dir_all(path.join("build/go-tmp")) {
            let _ = fs::remove_dir_all(&path);
            return Err(error);
        }
        Ok(Self {
            identity: crate::worktree_directory_identity(&path)?,
            path,
            owner: None,
            cleaned: false,
        })
    }

    pub(crate) fn path(&self) -> &Path {
        &self.path
    }

    pub(crate) fn mark_owner(&mut self, pid: u32) -> std::io::Result<()> {
        let owner = owner_identity_for_pid(pid).ok_or(std::io::ErrorKind::NotFound)?;
        fs::write(self.path.join(MARKER), &owner)?;
        self.owner = Some(owner);
        Ok(())
    }

    pub(crate) fn cleanup_now(&mut self) -> std::io::Result<()> {
        if self.cleaned {
            return Ok(());
        }
        // The periodic sweep may have removed the root of an exited agent.
        let removed = |error: &std::io::Error, path: &Path| {
            error.kind() == std::io::ErrorKind::NotFound && !path.exists()
        };
        let identity = match crate::worktree_directory_identity(&self.path) {
            Ok(identity) => identity,
            Err(error) if removed(&error, &self.path) => {
                self.cleaned = true;
                return Ok(());
            }
            Err(error) => return Err(error),
        };
        if identity != self.identity {
            return Err(std::io::ErrorKind::InvalidData.into());
        }
        let result = if let Some(owner) = self.owner.as_deref() {
            remove_owned_runtime_root(&self.path, owner)
        } else {
            fs::remove_dir_all(&self.path)
        };
        match result {
            Err(error) if !removed(&error, &self.path) => return Err(error),
            _ => {}
        }
        self.cleaned = true;
        Ok(())
    }
}

impl Drop for OwnedRuntimeScratch {
    fn drop(&mut self) {
        if let Err(error) = self.cleanup_now() {
            eprintln!(
                "Sail runtime scratch retained {}: {error}",
                self.path.display()
            );
        }
    }
}

fn remove_owned_runtime_root(path: &Path, owner: &str) -> std::io::Result<()> {
    if fs::read_to_string(path.join(MARKER))? != owner {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    let (pid, _) = owner
        .split_once(' ')
        .ok_or(std::io::ErrorKind::InvalidData)?;
    let pid = pid
        .parse::<u32>()
        .map_err(|_| std::io::ErrorKind::InvalidData)?;
    if owner_identity_for_pid(pid).as_deref() == Some(owner) {
        return Err(std::io::ErrorKind::WouldBlock.into());
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir() || metadata.uid() != unsafe { nix::libc::geteuid() } {
        return Err(std::io::ErrorKind::PermissionDenied.into());
    }
    let now = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
    if inspect(path, metadata.dev(), now)?.is_none() || has_open_files(path) != Some(false) {
        return Err(std::io::ErrorKind::WouldBlock.into());
    }
    let parent = path.parent().ok_or(std::io::ErrorKind::InvalidInput)?;
    let name = path
        .file_name()
        .ok_or(std::io::ErrorKind::InvalidInput)?
        .to_string_lossy();
    let private = parent.join(format!(
        "sail-cleanup-private-{}-{name}",
        uuid::Uuid::new_v4()
    ));
    fs::create_dir(&private)?;
    if let Err(error) = fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE) {
        let _ = fs::remove_dir(&private);
        return Err(error);
    }
    if let Err(error) = fs::set_permissions(&private, fs::Permissions::from_mode(0o300)) {
        remove_private_parent(&private);
        return Err(error);
    }
    let hidden = private.join(uuid::Uuid::new_v4().to_string());
    if let Err(error) = fs::rename(path, &hidden) {
        remove_private_parent(&private);
        return Err(error);
    }
    let safe = inspect(&hidden, metadata.dev(), now)?.is_some()
        && fs::read_to_string(hidden.join(MARKER)).ok().as_deref() == Some(owner)
        && has_open_files(&hidden) == Some(false);
    if !safe || save_private_owner(&hidden, &private).is_err() {
        restore(&hidden, path);
        if !hidden.exists() {
            remove_private_parent(&private);
        }
        return Err(std::io::ErrorKind::WouldBlock.into());
    }
    fs::remove_dir_all(&hidden)?;
    remove_private_parent(&private);
    Ok(())
}

pub(crate) fn wrap_command(command: &Command) -> std::io::Result<Command> {
    let mut wrapped = Command::new(std::env::current_exe()?);
    wrapped
        .arg("--exec-with-scratch-owner")
        .arg(command.get_program())
        .args(command.get_args());
    if let Some(directory) = command.get_current_dir() {
        wrapped.current_dir(directory);
    }
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            wrapped.env(name, value);
        } else {
            wrapped.env_remove(name);
        }
    }
    Ok(wrapped)
}

pub fn exec_with_scratch_owner() -> ! {
    use std::os::unix::process::CommandExt;

    let mut args = std::env::args_os().skip(2);
    let Some(program) = args.next() else {
        eprintln!("Scratch owner wrapper needs a command");
        std::process::exit(2);
    };
    let mut command = Command::new(program);
    command.args(args).env_remove("SAIL_SCRATCH_OWNER_IDENTITY");
    if let Some(owner) = owner_identity() {
        command.env("SAIL_SCRATCH_OWNER_IDENTITY", owner);
    }
    let error = command.exec();
    eprintln!("Scratch owner wrapper could not launch command: {error}");
    std::process::exit(1);
}

fn sweep(
    temp: &Path,
    now: SystemTime,
    open_files: impl Fn(&Path) -> Option<bool>,
) -> std::io::Result<u64> {
    sweep_with(temp, now, open_files, false)
}

// `stop_leftovers` ends processes still running from a dead-owner root before
// its open-file check. Native fixtures outlive the run that launched them.
fn sweep_with(
    temp: &Path,
    now: SystemTime,
    open_files: impl Fn(&Path) -> Option<bool>,
    stop_leftovers: bool,
) -> std::io::Result<u64> {
    let mut freed = 0;
    let owner = unsafe { nix::libc::geteuid() };
    for entry in fs::read_dir(temp)? {
        let Ok(entry) = entry else {
            continue;
        };
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        let Ok(metadata) = fs::symlink_metadata(&path) else {
            continue;
        };
        if !metadata.is_dir() || metadata.uid() != owner || !candidate_name(&name, &path) {
            continue;
        }
        if let Some(original_name) = private_quarantine_name(&name) {
            if let PrivateOutcome::Removed(bytes) = reclaim_private_quarantine(
                temp,
                &path,
                original_name,
                &metadata,
                &PrivateReclaim {
                    now,
                    min_age: IDLE_AGE,
                    idle_at: now,
                },
                &open_files,
            ) {
                freed += bytes;
            }
            continue;
        }
        // The owner check is cheap; the tree walk below is not, so a live
        // owner never pays for it.
        if !marker_owner_dead(&path) {
            continue;
        }
        let Ok(Some(bytes)) = inspect(&path, metadata.dev(), now) else {
            continue;
        };
        if stop_leftovers {
            stop_root_processes(&path);
        }
        if reclaim_root(temp, &path, &name, metadata.dev(), now, &open_files).is_ok() {
            freed += bytes;
        }
    }
    Ok(freed)
}

// When a pass runs and how it judges a quarantine. `idle_at` is the time the
// safety walk measures file ages against: the startup sweep keeps files
// younger than two hours, while a dead owner's root has no user at all.
struct PrivateReclaim {
    now: SystemTime,
    min_age: Duration,
    idle_at: SystemTime,
}

// What a pass found in a `sail-cleanup-private-*` directory.
enum PrivateOutcome {
    // Not ours, too fresh to be abandoned, or unreadable: left untouched.
    Skipped,
    Removed(u64),
    // The root is back under its original name, where its next check applies.
    Restored,
    // The root has a live owner or open files, or deletion failed.
    Kept,
}

// Recovers a quarantine left by a Sail that died while removing a root. The
// root goes back under its original name unless its owner has exited and
// nothing holds a file in it, in which case it is deleted. `min_age` is how
// long the directory must sit untouched, so a removal still running in
// another thread or Sail is not raced.
fn reclaim_private_quarantine(
    temp: &Path,
    path: &Path,
    original_name: &str,
    metadata: &fs::Metadata,
    when: &PrivateReclaim,
    open_files: &impl Fn(&Path) -> Option<bool>,
) -> PrivateOutcome {
    if fs::read_to_string(path.join(PRIVATE_MARKER))
        .ok()
        .as_deref()
        != Some(PRIVATE_MARKER_VALUE)
    {
        return PrivateOutcome::Skipped;
    }
    let Ok(modified) = metadata.modified() else {
        return PrivateOutcome::Skipped;
    };
    if when.now.duration_since(modified).unwrap_or_default() < when.min_age {
        return PrivateOutcome::Skipped;
    }
    let Ok(root) = private_child(path) else {
        return PrivateOutcome::Skipped;
    };
    let Some(old_root) = root else {
        remove_private_parent(path);
        return PrivateOutcome::Skipped;
    };
    // A process may have seen the old child name during recovery's
    // brief directory listing. Rename it after hiding the parent so
    // only the new, unlisted path is used for the safety check.
    let root = path.join(uuid::Uuid::new_v4().to_string());
    if fs::rename(&old_root, &root).is_err() {
        return PrivateOutcome::Skipped;
    }
    let original = temp.join(original_name);
    let safe = inspect(&root, metadata.dev(), when.idle_at).is_ok_and(|result| result.is_some())
        && (marker_owner_dead(&root)
            || (!root.join(MARKER).exists() && owner_dead(&path.join(PRIVATE_OWNER))))
        && open_files(&root) == Some(false);
    if safe {
        let bytes = inspect(&root, metadata.dev(), when.idle_at)
            .ok()
            .flatten()
            .unwrap_or(0);
        // A read-only directory the killed removal had not reached blocks
        // deletion, as in `finish_quarantined`.
        let mut removed = fs::remove_dir_all(&root);
        if removed.is_err() {
            make_directories_writable(&root);
            removed = fs::remove_dir_all(&root);
        }
        if removed.is_ok() {
            remove_private_parent(path);
            return PrivateOutcome::Removed(bytes);
        }
    } else if !original.exists() {
        if restore_owner_marker(&root, path).is_ok() {
            restore(&root, &original);
        }
        if !root.exists() {
            remove_private_parent(path);
            return PrivateOutcome::Restored;
        }
    }
    PrivateOutcome::Kept
}

// Quarantines a verified dead-owner root and deletes it. The caller has
// already checked the owner and idle age; this rechecks open files around the
// rename so a process that opens the root meanwhile keeps it.
fn reclaim_root(
    temp: &Path,
    path: &Path,
    name: &str,
    device: u64,
    now: SystemTime,
    open_files: &impl Fn(&Path) -> Option<bool>,
) -> Result<(), &'static str> {
    let quarantined = quarantine_root(temp, path, name, device, open_files)?;
    let hidden = quarantined.quarantine.clone();
    finish_quarantined(quarantined, now, || open_files(&hidden))
}

// A root hidden under a private name, waiting for its final open-file check.
struct Quarantined {
    original: PathBuf,
    private: PathBuf,
    quarantine: PathBuf,
    device: u64,
}

// Checks the root's open files, then hides it under a name no process can
// list. The check after this rename is the authority; this one only spares a
// busy root the rename.
fn quarantine_root(
    temp: &Path,
    path: &Path,
    name: &str,
    device: u64,
    open_files: &impl Fn(&Path) -> Option<bool>,
) -> Result<Quarantined, &'static str> {
    // An unknown lsof result is unsafe: lack of permission is not proof of idleness.
    match open_files(path) {
        Some(false) => {}
        Some(true) => return Err("open files"),
        None => return Err("open files unknown"),
    }
    let private = temp.join(format!(
        "sail-cleanup-private-{}-{name}",
        uuid::Uuid::new_v4()
    ));
    if fs::create_dir(&private).is_err() {
        return Err("changed while removing");
    }
    if fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE).is_err() {
        let _ = fs::remove_file(private.join(PRIVATE_MARKER));
        let _ = fs::remove_dir(&private);
        return Err("changed while removing");
    }
    if fs::set_permissions(&private, fs::Permissions::from_mode(0o300)).is_err() {
        remove_private_parent(&private);
        return Err("changed while removing");
    }
    // The child name is independent of the visible parent name. A process
    // can list the temp directory, but cannot list this 0300 directory or
    // derive the child path during the final open-file check and deletion.
    let quarantine = private.join(uuid::Uuid::new_v4().to_string());
    if fs::rename(path, &quarantine).is_err() {
        remove_private_parent(&private);
        return Err(if path.exists() {
            "changed while removing"
        } else {
            "gone"
        });
    }
    Ok(Quarantined {
        original: path.to_path_buf(),
        private,
        quarantine,
        device,
    })
}

// Deletes a quarantined root once its final open-file check passes, or
// restores it under its original name.
fn finish_quarantined(
    quarantined: Quarantined,
    now: SystemTime,
    open_files: impl FnOnce() -> Option<bool>,
) -> Result<(), &'static str> {
    let Quarantined {
        original: path,
        private,
        quarantine,
        device,
    } = quarantined;
    let safe = inspect(&quarantine, device, now).is_ok_and(|result| result.is_some())
        && marker_owner_dead(&quarantine)
        && open_files() == Some(false);
    if !safe {
        restore(&quarantine, &path);
        if !quarantine.exists() {
            remove_private_parent(&private);
        }
        return Err("changed while removing");
    }
    // Keep the verified owner outside the tree being removed. A crash can
    // otherwise delete the root marker first and strand a partial build.
    if save_private_owner(&quarantine, &private).is_err() {
        restore(&quarantine, &path);
        if !quarantine.exists() {
            remove_private_parent(&private);
        }
        return Err("changed while removing");
    }
    // A read-only directory in the tree blocks deletion; a retry never gets
    // another chance because the root has left its original name.
    let mut removed = fs::remove_dir_all(&quarantine);
    if removed.is_err() {
        make_directories_writable(&quarantine);
        removed = fs::remove_dir_all(&quarantine);
    }
    if let Err(error) = removed {
        eprintln!(
            "Sail scratch cleanup kept {}: {error}",
            quarantine.display()
        );
        return Err("removal failed");
    }
    remove_private_parent(&private);
    Ok(())
}

fn make_directories_writable(root: &Path) {
    let mut pending = vec![root.to_path_buf()];
    while let Some(directory) = pending.pop() {
        let Ok(metadata) = fs::symlink_metadata(&directory) else {
            continue;
        };
        if !metadata.is_dir() {
            continue;
        }
        let mode = metadata.permissions().mode();
        if mode & 0o700 != 0o700 {
            let _ = fs::set_permissions(&directory, fs::Permissions::from_mode(mode | 0o700));
        }
        if let Ok(entries) = fs::read_dir(&directory) {
            pending.extend(entries.filter_map(Result::ok).map(|entry| entry.path()));
        }
    }
}

fn stop_root_processes(root: &Path) {
    STOP_EPOCH.with(|epoch| epoch.set(epoch.get() + 1));
    let Ok(canonical) = fs::canonicalize(root) else {
        return;
    };
    // A Sail build that runs from the dead run's root keeps its own helpers.
    if std::env::current_exe().is_ok_and(|exe| exe.starts_with(&canonical) || exe.starts_with(root))
    {
        return;
    }
    let own = Pid::from_u32(std::process::id());
    let kind = ProcessRefreshKind::nothing().with_exe(UpdateKind::OnlyIfNotSet);
    let mut system = System::new();
    system.refresh_processes_specifics(ProcessesToUpdate::All, true, kind);
    let is_own_descendant = |process: &sysinfo::Process| {
        let mut parent = process.parent();
        while let Some(pid) = parent {
            if pid == own {
                return true;
            }
            parent = system.process(pid).and_then(sysinfo::Process::parent);
        }
        false
    };
    let mut running = system
        .processes()
        .values()
        .filter(|process| {
            process.pid() != own
                && !is_own_descendant(process)
                && process
                    .exe()
                    .is_some_and(|exe| exe.starts_with(&canonical) || exe.starts_with(root))
        })
        .map(|process| (process.pid(), process.start_time()))
        .collect::<Vec<_>>();
    for signal in [Signal::Term, Signal::Kill] {
        for (pid, started) in &running {
            if let Some(process) = system.process(*pid) {
                if process.start_time() == *started {
                    process.kill_with(signal);
                }
            }
        }
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !running.is_empty() && std::time::Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
            let pids = running.iter().map(|(pid, _)| *pid).collect::<Vec<_>>();
            system.refresh_processes_specifics(ProcessesToUpdate::Some(&pids), true, kind);
            running.retain(|(pid, started)| {
                system.process(*pid).is_some_and(|process| {
                    process.start_time() == *started && process.status() != ProcessStatus::Zombie
                })
            });
        }
        if running.is_empty() {
            return;
        }
    }
    eprintln!(
        "Sail scratch cleanup could not stop processes in {}",
        root.display()
    );
}

fn private_child(parent: &Path) -> std::io::Result<Option<PathBuf>> {
    let original_permissions = fs::metadata(parent)?.permissions();
    fs::set_permissions(parent, fs::Permissions::from_mode(0o700))?;
    let entries = fs::read_dir(parent).and_then(|entries| {
        let mut entries = entries
            .collect::<std::io::Result<Vec<_>>>()?
            .into_iter()
            .filter(|entry| {
                entry.file_name() != PRIVATE_MARKER && entry.file_name() != PRIVATE_OWNER
            })
            .collect::<Vec<_>>();
        if entries.len() > 1 {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidData));
        }
        Ok(entries.pop().map(|entry| entry.path()))
    });
    let hidden = fs::set_permissions(parent, original_permissions);
    hidden?;
    entries
}

fn remove_private_parent(parent: &Path) {
    if let Err(error) = fs::remove_file(parent.join(PRIVATE_OWNER)) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!("Sail scratch cleanup kept {}: {error}", parent.display());
            return;
        }
    }
    if let Err(error) = fs::remove_file(parent.join(PRIVATE_MARKER)) {
        eprintln!("Sail scratch cleanup kept {}: {error}", parent.display());
        return;
    }
    if let Err(error) = fs::remove_dir(parent) {
        eprintln!("Sail scratch cleanup kept {}: {error}", parent.display());
    }
}

fn restore(quarantine: &Path, original: &Path) {
    if let Err(error) = restore_without_replacing(quarantine, original) {
        eprintln!(
            "Sail scratch cleanup kept {} after restore failed: {error}",
            quarantine.display()
        );
    }
}

#[cfg(target_os = "macos")]
fn restore_without_replacing(quarantine: &Path, original: &Path) -> std::io::Result<()> {
    let source = std::ffi::CString::new(quarantine.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let destination = std::ffi::CString::new(original.as_os_str().as_bytes())
        .map_err(|_| std::io::Error::from(std::io::ErrorKind::InvalidInput))?;
    let result = unsafe {
        nix::libc::renameatx_np(
            nix::libc::AT_FDCWD,
            source.as_ptr(),
            nix::libc::AT_FDCWD,
            destination.as_ptr(),
            nix::libc::RENAME_EXCL,
        )
    };
    if result == -1 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

#[cfg(not(target_os = "macos"))]
fn restore_without_replacing(quarantine: &Path, original: &Path) -> std::io::Result<()> {
    if original.exists() {
        return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
    }
    fs::rename(quarantine, original)
}

fn candidate_name(name: &str, path: &Path) -> bool {
    if private_quarantine_name(name).is_some() {
        return true;
    }
    if !name.starts_with("sail") {
        return false;
    }
    path.join(MARKER).is_file()
}

fn private_quarantine_name(name: &str) -> Option<&str> {
    let tail = name.strip_prefix("sail-cleanup-private-")?;
    let (uuid, _) = tail.split_once("-sail")?;
    uuid::Uuid::parse_str(uuid).ok()?;
    let original = &tail[uuid.len() + 1..];
    if original == "sail" || original.contains('/') {
        return None;
    }
    Some(original)
}

fn marker_owner_dead(path: &Path) -> bool {
    owner_dead(&path.join(MARKER))
}

fn save_private_owner(root: &Path, private: &Path) -> std::io::Result<()> {
    let marker = root.join(MARKER);
    if !fs::symlink_metadata(&marker)?.is_file() {
        return Err(std::io::ErrorKind::InvalidData.into());
    }
    fs::hard_link(marker, private.join(PRIVATE_OWNER))
}

fn restore_owner_marker(root: &Path, private: &Path) -> std::io::Result<()> {
    if !root.join(MARKER).exists() {
        fs::hard_link(private.join(PRIVATE_OWNER), root.join(MARKER))?;
    }
    Ok(())
}

fn owner_dead(marker: &Path) -> bool {
    owner_status(marker) == Some(true)
}

// Some(true) when the recorded owner has exited, Some(false) while it runs,
// None when the marker is missing or malformed.
fn owner_status(marker: &Path) -> Option<bool> {
    let owner = fs::read_to_string(marker).ok()?;
    let mut parts = owner.split_whitespace();
    let (Some(pid), Some(started), None) = (parts.next(), parts.next(), parts.next()) else {
        return None;
    };
    let pid = pid.parse::<i32>().ok()?;
    let started = started.parse::<u64>().ok()?;
    if pid <= 0 || started == 0 {
        return None;
    }
    let result = unsafe { nix::libc::kill(pid, 0) };
    if result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(nix::libc::ESRCH) {
        return Some(true);
    }
    // A pid that answers but belongs to another user (EPERM) still has to
    // match the recorded start time. Read it now: a snapshot taken before a
    // long pass can predate a pid that was reused meanwhile. An unreaped
    // child answers `kill` too, but it has exited and holds nothing.
    Some(
        unreaped_zombie(pid as u32)
            || process_start_time(pid as u32).is_some_and(|current| current != started),
    )
}

fn inspect(path: &Path, device: u64, now: SystemTime) -> std::io::Result<Option<u64>> {
    #[cfg(test)]
    INSPECT_WALKS.with(|walks| walks.set(walks.get() + 1));
    let mut pending = vec![path.to_path_buf()];
    let mut bytes = 0;
    while let Some(current) = pending.pop() {
        let metadata = fs::symlink_metadata(&current)?;
        if metadata.dev() != device || current.file_name().is_some_and(|name| name == ".git") {
            return Ok(None);
        }
        if now.duration_since(metadata.modified()?).unwrap_or_default() < IDLE_AGE {
            return Ok(None);
        }
        bytes += metadata.blocks() * 512;
        if metadata.is_dir() {
            for child in fs::read_dir(&current)? {
                pending.push(child?.path());
            }
        }
    }
    Ok(Some(bytes))
}

#[cfg(test)]
thread_local! {
    static INSPECT_WALKS: std::cell::Cell<u32> = const { std::cell::Cell::new(0) };
}

thread_local! {
    // Stopping a process can release an unlinked file, so a scan read before
    // that is stale for the root being swept.
    static STOP_EPOCH: std::cell::Cell<u64> = const { std::cell::Cell::new(0) };
}

const LISTING_CACHE_AGE: Duration = Duration::from_secs(20);

fn lsof_binary() -> PathBuf {
    if cfg!(target_os = "macos") {
        PathBuf::from("/usr/sbin/lsof")
    } else {
        PathBuf::from("lsof")
    }
}

// lsof is a bulk disk reader: run it at low priority so a startup pass does
// not compete with agents that are starting.
fn background_lsof() -> Command {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new(lsof_binary());
    unsafe {
        command.pre_exec(|| {
            nix::libc::setpriority(nix::libc::PRIO_PROCESS, 0, 15);
            Ok(())
        });
    }
    command
}

// Every lsof call scans all processes, and the old two or three calls per root
// dominated a pass. One listing of all open files, shared across the roots of a
// pass, answers the first check for each root: a root with a live user is
// rejected without a call of its own. A root's final check, made after it is
// hidden in quarantine, is the authority and always runs its own lsof, which
// lists files under the root and every unlinked file in one scan.
// When and under which stop epoch the listing was read, and its output.
type OpenFileListing = (std::time::Instant, u64, std::sync::Arc<Vec<u8>>);

#[derive(Default)]
struct OpenFileProbe {
    reads: std::cell::Cell<u32>,
    listing: std::cell::RefCell<Option<OpenFileListing>>,
}

fn listing_names_root(listing: &[u8], root: &[u8]) -> bool {
    listing.split(|byte| *byte == b'\n').any(|line| {
        line.strip_prefix(b"n").is_some_and(|name| {
            name == root || (name.starts_with(root) && name.get(root.len()) == Some(&b'/'))
        })
    })
}

impl OpenFileProbe {
    fn open_file_listing(&self) -> Option<std::sync::Arc<Vec<u8>>> {
        let epoch = STOP_EPOCH.with(std::cell::Cell::get);
        if let Some((read, read_epoch, output)) = self.listing.borrow().as_ref() {
            if read.elapsed() < LISTING_CACHE_AGE && *read_epoch == epoch {
                return Some(output.clone());
            }
        }
        self.reads.set(self.reads.get() + 1);
        let listing = background_lsof().args(["-nP", "-Fn"]).output().ok()?;
        if !listing.stderr.is_empty() || !matches!(listing.status.code(), Some(0 | 1)) {
            return None;
        }
        let output = std::sync::Arc::new(listing.stdout);
        *self.listing.borrow_mut() = Some((std::time::Instant::now(), epoch, output.clone()));
        Some(output)
    }

    fn check(&self, path: &Path) -> Option<bool> {
        use std::os::unix::ffi::OsStrExt;

        let quarantined = path
            .parent()
            .and_then(Path::file_name)
            .is_some_and(|parent| {
                parent
                    .to_string_lossy()
                    .starts_with("sail-cleanup-private-")
            });
        // macOS lsof reports canonical paths even when TMPDIR begins with
        // /var, which is a symlink to /private/var.
        let canonical = fs::canonicalize(path).ok()?;
        let root = canonical.as_os_str().as_bytes();
        if !quarantined {
            return Some(listing_names_root(&self.open_file_listing()?, root));
        }
        Some(listing_names_root(&self.quarantine_listing(&[path])?, root))
    }

    // lsof +D misses an unlinked file that is still open, and +L1 lists those
    // descriptors with their last path; selections combine as a union. Every
    // +D directory is searched in the same scan of the process table.
    fn quarantine_listing(&self, paths: &[&Path]) -> Option<Vec<u8>> {
        self.reads.set(self.reads.get() + 1);
        let mut command = background_lsof();
        command.args(["-nP", "-Fn", "+L1"]);
        for path in paths {
            command.arg("+D").arg(path);
        }
        let output = command.output().ok()?;
        if !output.stderr.is_empty() || !matches!(output.status.code(), Some(0 | 1)) {
            return None;
        }
        Some(output.stdout)
    }

    /// Final check for roots already hidden in quarantine, one scan for all of
    /// them. If the combined scan fails, the batch is halved until the failing
    /// root stands alone, so one unreadable root cannot keep the rest.
    fn check_quarantined(&self, paths: &[PathBuf]) -> Vec<Option<bool>> {
        let canonical = paths
            .iter()
            .map(|path| fs::canonicalize(path).ok())
            .collect::<Vec<_>>();
        let mut results = vec![None; paths.len()];
        let listed = canonical
            .iter()
            .enumerate()
            .filter_map(|(index, root)| root.as_deref().map(|root| (index, root)))
            .collect::<Vec<_>>();
        self.scan_quarantined(&listed, &mut results);
        results
    }

    fn scan_quarantined(&self, roots: &[(usize, &Path)], results: &mut [Option<bool>]) {
        use std::os::unix::ffi::OsStrExt;

        match roots {
            [] => {}
            [(index, root)] => results[*index] = self.check(root),
            _ => {
                let paths = roots.iter().map(|(_, root)| *root).collect::<Vec<_>>();
                if let Some(listing) = self.quarantine_listing(&paths) {
                    for (index, root) in roots {
                        results[*index] =
                            Some(listing_names_root(&listing, root.as_os_str().as_bytes()));
                    }
                } else {
                    let (first, second) = roots.split_at(roots.len() / 2);
                    self.scan_quarantined(first, results);
                    self.scan_quarantined(second, results);
                }
            }
        }
    }
}

fn has_open_files(path: &Path) -> Option<bool> {
    OpenFileProbe::default().check(path)
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Fixture(PathBuf);

    impl std::ops::Deref for Fixture {
        type Target = Path;

        fn deref(&self) -> &Self::Target {
            &self.0
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    fn fixture() -> Fixture {
        let root = std::env::temp_dir().join(format!("sail-scratch-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        Fixture(root)
    }

    fn cargo_artifacts(path: &Path) {
        fs::create_dir_all(path.join("debug").join(".fingerprint")).unwrap();
        fs::write(path.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
    }

    #[test]
    fn removes_only_stale_closed_build_roots() {
        let temp = fixture();
        let stale = temp.join("sail-339-cargo.old");
        let open = temp.join("sail-339-target.old");
        let recent = temp.join("sail-339-e2e.new");
        let unrelated = temp.join("sail-context-keep");
        for path in [&stale, &open, &recent, &unrelated] {
            fs::create_dir(path).unwrap();
        }
        for path in [&stale, &open, &recent] {
            cargo_artifacts(path);
        }
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, SystemTime::now(), |_| Some(false)).unwrap();
        assert!(recent.exists());
        sweep(&temp, future, |path| Some(path == open)).unwrap();
        assert!(!stale.exists());
        assert!(open.exists());
        assert!(!recent.exists());
        assert!(unrelated.exists());
    }

    #[test]
    fn keeps_worktrees_and_unknown_open_file_state() {
        let temp = fixture();
        let worktree = temp.join("sail-339-cargo.worktree");
        let unknown = temp.join("sail-339-target.unknown");
        fs::create_dir(&worktree).unwrap();
        fs::create_dir(&unknown).unwrap();
        cargo_artifacts(&worktree);
        cargo_artifacts(&unknown);
        fs::write(worktree.join(".git"), "gitdir: elsewhere").unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |path| {
            if path == worktree {
                Some(false)
            } else {
                None
            }
        })
        .unwrap();
        assert!(worktree.exists());
        assert!(unknown.exists());
    }

    #[test]
    fn keeps_a_marked_root_while_its_owner_lives() {
        let temp = fixture();
        let active = temp.join("sail-339-implement.owned");
        fs::create_dir(&active).unwrap();
        fs::write(active.join(MARKER), owner_identity().unwrap()).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(active.exists());
    }

    #[test]
    fn a_child_owner_becomes_sweepable_after_it_exits() {
        let temp = fixture();
        let root = temp.join("sail-339-target.child");
        fs::create_dir(&root).unwrap();
        let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
        let owner = owner_identity_for_pid(child.id()).unwrap();
        fs::write(root.join(MARKER), owner).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(root.exists());
        child.kill().unwrap();
        child.wait().unwrap();
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(!root.exists());
    }

    #[test]
    fn runtime_build_root_is_removed_after_its_provider_exits() {
        let temp = fixture();
        let mut scratch = OwnedRuntimeScratch::create_in(&temp).unwrap();
        let path = scratch.path().to_path_buf();
        fs::write(path.join("build/artifact"), "build output").unwrap();
        let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
        scratch.mark_owner(child.id()).unwrap();
        drop(scratch);
        assert!(path.exists());
        child.kill().unwrap();
        child.wait().unwrap();
        let scratch = OwnedRuntimeScratch {
            identity: crate::worktree_directory_identity(&path).unwrap(),
            path: path.clone(),
            owner: Some(fs::read_to_string(path.join(MARKER)).unwrap()),
            cleaned: false,
        };
        drop(scratch);
        assert!(!path.exists());
    }

    #[test]
    fn runtime_build_root_with_an_open_file_waits_for_the_sweep() {
        let temp = fixture();
        let mut scratch = OwnedRuntimeScratch::create_in(&temp).unwrap();
        let path = scratch.path().to_path_buf();
        let file = fs::File::create(path.join("build/artifact")).unwrap();
        let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
        scratch.mark_owner(child.id()).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(scratch.cleanup_now().is_err());
        drop(scratch);
        assert!(path.exists());
        drop(file);
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(!path.exists());
    }

    #[test]
    fn startup_reaches_marked_roots_in_worktree_temp_dirs() {
        let cache = fixture();
        let storage = cache.join("terminal-worktrees");
        let temp = storage.join("a".repeat(64)).join("tmp");
        fs::create_dir_all(&temp).unwrap();
        let stale = temp.join("sail-339-worker.stale");
        fs::create_dir(&stale).unwrap();
        fs::write(stale.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        fs::write(stale.join("artifact"), "build output").unwrap();
        let outside = storage.join("unverified").join("tmp");
        fs::create_dir_all(&outside).unwrap();
        let untouched = outside.join("sail-339-worker.stale");
        fs::create_dir(&untouched).unwrap();
        fs::write(untouched.join(MARKER), format!("{} 1", i32::MAX)).unwrap();

        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        let freed = sweep_worktree_temp_dirs(&cache, future, |_| Some(false)).unwrap();

        assert!(freed > 0);
        assert!(!stale.exists());
        assert!(untouched.exists());
    }

    #[test]
    fn sweeps_a_reused_pid_with_a_different_start_time() {
        let temp = fixture();
        let stale = temp.join("sail-339-target.reused");
        fs::create_dir(&stale).unwrap();
        let identity = owner_identity().unwrap();
        let (pid, started) = identity.split_once(' ').unwrap();
        let old_start = started.parse::<u64>().unwrap() - 1;
        fs::write(stale.join(MARKER), format!("{pid} {old_start}")).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(!stale.exists());
    }

    fn fixture_binary(root: &Path) -> PathBuf {
        let binary = root.join("run/Sail Native Fixture.app/Contents/MacOS/sail");
        fs::create_dir_all(binary.parent().unwrap()).unwrap();
        // A copy of this test binary runs anywhere; a copied system binary
        // fails macOS signature validation.
        fs::copy(std::env::current_exe().unwrap(), &binary).unwrap();
        binary
    }

    // Started only by `spawn_orphan`, as a stand-in for a fixture app.
    #[test]
    #[ignore = "helper process for the native root tests"]
    fn fixture_sleeper() {
        std::thread::sleep(Duration::from_secs(300));
    }

    // Matches a fixture app that `open` leaves running with PPID 1.
    fn spawn_orphan(binary: &Path) -> i32 {
        let output = Command::new("/bin/sh")
            .args([
                "-c",
                "\"$0\" scratch_cleanup::tests::fixture_sleeper --ignored --exact >/dev/null 2>&1 & echo $!",
            ])
            .arg(binary)
            .output()
            .unwrap();
        let pid = String::from_utf8(output.stdout)
            .unwrap()
            .trim()
            .parse()
            .unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(alive(pid), "fixture helper did not start");
        pid
    }

    fn alive(pid: i32) -> bool {
        unsafe { nix::libc::kill(pid, 0) == 0 }
    }

    fn wait_until_gone(pid: i32) -> bool {
        for _ in 0..50 {
            if !alive(pid) {
                return true;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
        false
    }

    #[test]
    fn startup_reclaims_a_dead_owner_native_root_and_stops_its_fixture() {
        let home = fixture();
        let applications = home.join("Applications");
        let root = applications.join("sail-681-native.dead");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        fs::create_dir_all(root.join("tmp/target/debug/.fingerprint")).unwrap();
        fs::write(root.join("tmp/target/debug/artifact"), "build output").unwrap();
        let pid = spawn_orphan(&fixture_binary(&root));
        assert!(alive(pid));
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        let freed = sweep_native_roots(&home, future, |_| {
            // The fixture must be stopped before the open-file check.
            Some(!wait_until_gone(pid))
        })
        .unwrap();
        assert!(freed > 0);
        assert!(!root.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_running_fixture_blocks_the_ordinary_sweep_but_not_the_native_one() {
        let home = fixture();
        let root = home.join("Applications/sail-681-native.running");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        let pid = spawn_orphan(&fixture_binary(&root));
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&home.join("Applications"), future, has_open_files).unwrap();
        assert!(root.exists());
        assert!(alive(pid));
        sweep_native_roots(&home, future, has_open_files).unwrap();
        assert!(wait_until_gone(pid));
        assert!(!root.exists());
    }

    #[test]
    fn native_roots_keep_live_owners_and_unmarked_folders() {
        let home = fixture();
        let applications = home.join("Applications");
        let live = applications.join("sail-681-native.live");
        let unmarked = applications.join("sail-681-native.unmarked");
        let app = applications.join("GoLand.app");
        for path in [&live, &unmarked, &app] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(live.join(MARKER), owner_identity().unwrap()).unwrap();
        let pid = spawn_orphan(&fixture_binary(&live));
        fixture_binary(&unmarked);
        let unmarked_pid =
            spawn_orphan(&unmarked.join("run/Sail Native Fixture.app/Contents/MacOS/sail"));
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep_native_roots(&home, future, |_| Some(false)).unwrap();
        assert!(live.exists() && unmarked.exists() && app.exists());
        assert!(alive(pid));
        assert!(alive(unmarked_pid));
        unsafe {
            nix::libc::kill(pid, nix::libc::SIGKILL);
            nix::libc::kill(unmarked_pid, nix::libc::SIGKILL);
        }
    }

    #[test]
    fn a_sibling_root_sharing_a_name_prefix_keeps_its_fixture() {
        let home = fixture();
        let applications = home.join("Applications");
        let dead = applications.join("sail-681-native.a");
        let sibling = applications.join("sail-681-native.ab");
        for path in [&dead, &sibling] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(dead.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        fs::write(sibling.join(MARKER), owner_identity().unwrap()).unwrap();
        let stopped = spawn_orphan(&fixture_binary(&dead));
        let kept = spawn_orphan(&fixture_binary(&sibling));
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep_native_roots(&home, future, |_| Some(false)).unwrap();
        assert!(wait_until_gone(stopped));
        assert!(!dead.exists());
        assert!(sibling.exists());
        assert!(alive(kept));
        unsafe { nix::libc::kill(kept, nix::libc::SIGKILL) };
    }

    #[test]
    fn a_missing_applications_directory_is_not_an_error() {
        let home = fixture();
        assert_eq!(
            sweep_native_roots(&home, SystemTime::now(), |_| Some(false)).unwrap(),
            0
        );
    }

    #[test]
    fn native_roots_wait_for_the_idle_age() {
        let home = fixture();
        let root = home.join("Applications/sail-681-native.recent");
        fs::create_dir_all(&root).unwrap();
        fs::write(root.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        let pid = spawn_orphan(&fixture_binary(&root));
        sweep_native_roots(&home, SystemTime::now(), |_| Some(false)).unwrap();
        assert!(root.exists());
        assert!(alive(pid));
        unsafe { nix::libc::kill(pid, nix::libc::SIGKILL) };
    }

    fn runtime_root(temp: &Path, owner: Option<&str>) -> PathBuf {
        let root = temp.join(format!("sail-runtime-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(root.join("build/go-tmp")).unwrap();
        fs::write(root.join("build/artifact"), "build output").unwrap();
        if let Some(owner) = owner {
            fs::write(root.join(MARKER), owner).unwrap();
        }
        root
    }

    fn each(
        open_files: impl Fn(&Path) -> Option<bool>,
    ) -> impl Fn(&[PathBuf]) -> Vec<Option<bool>> {
        move |paths| paths.iter().map(|path| open_files(path)).collect()
    }

    fn runtime_sweep(
        temp: &Path,
        open_files: impl Fn(&Path) -> Option<bool>,
    ) -> Vec<(String, String)> {
        let mut events = Vec::new();
        sweep_runtime_roots_in(
            temp,
            SystemTime::now(),
            &open_files,
            each(&open_files),
            &|_| false,
            &mut |name, event| {
                let outcome = match event {
                    RuntimeRootEvent::Removed { bytes } => {
                        assert!(bytes > 0);
                        "removed".to_string()
                    }
                    RuntimeRootEvent::Kept { reason } => format!("kept: {reason}"),
                };
                events.push((name.to_string(), outcome));
            },
        )
        .unwrap();
        events
    }

    #[test]
    fn runtime_sweep_removes_a_fresh_dead_owner_root_while_sail_runs() {
        let temp = fixture();
        let dead = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let name = dead.file_name().unwrap().to_str().unwrap().to_string();
        let events = runtime_sweep(&temp, |_| Some(false));
        assert!(!dead.exists());
        assert_eq!(events, vec![(name, "removed".to_string())]);
    }

    #[test]
    fn runtime_sweep_removes_a_root_whose_pid_was_reused() {
        let temp = fixture();
        let identity = owner_identity().unwrap();
        let (pid, started) = identity.split_once(' ').unwrap();
        let old_start = started.parse::<u64>().unwrap() - 1;
        let stale = runtime_root(&temp, Some(&format!("{pid} {old_start}")));
        runtime_sweep(&temp, |_| Some(false));
        assert!(!stale.exists());
    }

    #[test]
    fn runtime_sweep_keeps_live_open_and_unknown_roots_with_a_reason() {
        let temp = fixture();
        let live = runtime_root(&temp, Some(&owner_identity().unwrap()));
        let open = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let unknown = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let garbage = runtime_root(&temp, Some("not a marker"));
        let events = runtime_sweep(&temp, |path| {
            if path == open {
                Some(true)
            } else if path == unknown {
                None
            } else {
                Some(false)
            }
        });
        for root in [&live, &open, &unknown, &garbage] {
            assert!(root.exists());
        }
        let reason = |root: &Path| {
            let name = root.file_name().unwrap().to_str().unwrap();
            events
                .iter()
                .find(|(event, _)| event == name)
                .unwrap()
                .1
                .clone()
        };
        assert_eq!(reason(&live), "kept: owner running");
        assert_eq!(reason(&open), "kept: open files");
        assert_eq!(reason(&unknown), "kept: open files unknown");
        assert_eq!(reason(&garbage), "kept: unreadable owner marker");
    }

    #[test]
    fn runtime_sweep_ignores_other_roots_and_young_unmarked_roots() {
        let temp = fixture();
        let other = temp.join("sail-339-target.dead");
        fs::create_dir(&other).unwrap();
        fs::write(other.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        let named = temp.join("sail-runtime-notes");
        fs::create_dir(&named).unwrap();
        fs::write(named.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        let starting = runtime_root(&temp, None);
        let events = runtime_sweep(&temp, |_| Some(false));
        assert!(events.is_empty());
        assert!(other.exists() && named.exists() && starting.exists());
    }

    #[test]
    fn runtime_sweep_removes_a_root_with_a_read_only_directory() {
        let temp = fixture();
        let root = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let read_only = root.join("build/ro");
        fs::create_dir_all(read_only.join("nested")).unwrap();
        fs::write(read_only.join("nested/file"), "module cache").unwrap();
        fs::set_permissions(&read_only, fs::Permissions::from_mode(0o555)).unwrap();
        let events = runtime_sweep(&temp, |_| Some(false));
        assert!(!root.exists());
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "removed");
        let private = fs::read_dir(&*temp)
            .unwrap()
            .filter_map(Result::ok)
            .any(|entry| {
                entry
                    .file_name()
                    .to_string_lossy()
                    .starts_with("sail-cleanup-private-")
            });
        assert!(!private);
    }

    #[test]
    fn runtime_sweep_keeps_a_root_a_live_build_uses() {
        let temp = fixture();
        let root = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let busy = root.clone();
        let mut events = Vec::new();
        sweep_runtime_roots_in(
            &temp,
            SystemTime::now(),
            |_| Some(false),
            each(|_| Some(false)),
            &|path| path == busy,
            &mut |_, event| {
                events.push(matches!(
                    event,
                    RuntimeRootEvent::Kept {
                        reason: "build in use"
                    }
                ));
            },
        )
        .unwrap();
        assert_eq!(events, vec![true]);
        assert!(root.exists());
    }

    #[test]
    fn runtime_sweep_does_not_report_a_root_removed_by_another_sweep() {
        let temp = fixture();
        let root = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let name = root.file_name().unwrap().to_str().unwrap().to_string();
        let racing = root.clone();
        let mut events = Vec::new();
        sweep_runtime_roots_in(
            &temp,
            SystemTime::now(),
            |path| {
                if path == racing {
                    fs::remove_dir_all(path).unwrap();
                }
                Some(false)
            },
            each(|_| Some(false)),
            &|_| false,
            &mut |reported, _| events.push(reported.to_string()),
        )
        .unwrap();
        assert!(!events.contains(&name));
    }

    #[test]
    fn runtime_sweep_removes_a_root_whose_agent_exited_but_was_not_reaped() {
        let temp = fixture();
        let mut child = Command::new("/bin/sleep").arg("1").spawn().unwrap();
        let owner = owner_identity_for_pid(child.id()).unwrap();
        let root = runtime_root(&temp, Some(&owner));
        std::thread::sleep(Duration::from_millis(1600));
        assert!(unsafe { nix::libc::kill(child.id() as i32, 0) } == 0);
        let events = runtime_sweep(&temp, |_| Some(false));
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].1, "removed");
        assert!(!root.exists());
        child.wait().unwrap();
    }

    #[test]
    fn runtime_sweep_removes_a_root_whose_pid_now_belongs_to_another_user() {
        let temp = fixture();
        let root = runtime_root(&temp, Some("1 12345"));
        runtime_sweep(&temp, |_| Some(false));
        assert!(!root.exists());
    }

    #[test]
    fn runtime_sweep_ignores_non_canonical_uuid_spellings() {
        let temp = fixture();
        let compact = temp.join(format!("sail-runtime-{}", uuid::Uuid::new_v4().simple()));
        let upper = temp.join(format!(
            "sail-runtime-{}",
            uuid::Uuid::new_v4().to_string().to_uppercase()
        ));
        for root in [&compact, &upper] {
            fs::create_dir(root).unwrap();
            fs::write(root.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        }
        let events = runtime_sweep(&temp, |_| Some(false));
        assert!(events.is_empty());
        assert!(compact.exists() && upper.exists());
    }

    #[test]
    fn runtime_sweep_reports_an_old_unmarked_root() {
        let temp = fixture();
        let orphan = runtime_root(&temp, None);
        let mut events = Vec::new();
        let later = SystemTime::now() + UNMARKED_GRACE + Duration::from_secs(1);
        sweep_runtime_roots_in(
            &temp,
            later,
            |_| Some(false),
            each(|_| Some(false)),
            &|_| false,
            &mut |name, event| {
                events.push((
                    name.to_string(),
                    matches!(
                        event,
                        RuntimeRootEvent::Kept {
                            reason: "no owner marker"
                        }
                    ),
                ));
            },
        )
        .unwrap();
        assert_eq!(events.len(), 1);
        assert!(events[0].1);
        assert!(orphan.exists());
    }

    #[test]
    fn runtime_sweep_leaves_a_fresh_private_quarantine_to_its_remover() {
        let temp = fixture();
        let root = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let name = root.file_name().unwrap().to_str().unwrap();
        let private = temp.join(format!(
            "sail-cleanup-private-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&private).unwrap();
        fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE).unwrap();
        runtime_sweep(&temp, |_| Some(false));
        assert!(private.exists());
    }

    // The state a Sail killed inside `remove_dir_all` leaves: the root hidden
    // under a private parent, its marker kept only as the saved owner, and
    // part of the tree already deleted.
    fn killed_removal(temp: &Path, owner: &str) -> (String, PathBuf) {
        let root = runtime_root(temp, Some(owner));
        let name = root.file_name().unwrap().to_str().unwrap().to_string();
        fs::create_dir_all(root.join("build/deps/inner")).unwrap();
        fs::write(root.join("build/deps/inner/object"), "build output").unwrap();
        let hidden = quarantine_root(
            temp,
            &root,
            &name,
            fs::metadata(&root).unwrap().dev(),
            &|_| Some(false),
        )
        .ok()
        .unwrap();
        save_private_owner(&hidden.quarantine, &hidden.private).unwrap();
        fs::remove_file(hidden.quarantine.join(MARKER)).unwrap();
        fs::remove_dir_all(hidden.quarantine.join("build/go-tmp")).unwrap();
        fs::remove_file(hidden.quarantine.join("build/artifact")).unwrap();
        (name, hidden.private)
    }

    fn sweep_after_grace(
        temp: &Path,
        open_files: impl Fn(&Path) -> Option<bool>,
    ) -> Vec<(String, String)> {
        let mut events = Vec::new();
        sweep_runtime_roots_in(
            temp,
            SystemTime::now() + QUARANTINE_GRACE + Duration::from_secs(1),
            &open_files,
            each(&open_files),
            &|_| false,
            &mut |name, event| {
                events.push((
                    name.to_string(),
                    match event {
                        RuntimeRootEvent::Removed { .. } => "removed".to_string(),
                        RuntimeRootEvent::Kept { reason } => format!("kept: {reason}"),
                    },
                ));
            },
        )
        .unwrap();
        events
    }

    #[test]
    fn runtime_sweep_reclaims_a_quarantine_left_by_a_killed_removal() {
        let temp = fixture();
        let (name, private) = killed_removal(&temp, &format!("{} 1", i32::MAX));
        assert!(private.exists());
        let events = sweep_after_grace(&temp, |_| Some(false));
        assert_eq!(events, vec![(name.clone(), "removed".to_string())]);
        assert!(!private.exists());
        assert!(!temp.join(name).exists());
    }

    fn reclaim_quarantines_after_grace(
        temp: &Path,
        open_files: impl Fn(&Path) -> Option<bool>,
    ) -> Vec<(String, bool)> {
        let mut events = Vec::new();
        reclaim_runtime_quarantines(
            temp,
            SystemTime::now() + QUARANTINE_GRACE + Duration::from_secs(1),
            unsafe { nix::libc::geteuid() },
            &open_files,
            &mut |name, event| {
                events.push((
                    name.to_string(),
                    matches!(event, RuntimeRootEvent::Removed { bytes } if bytes > 0),
                ))
            },
        )
        .unwrap();
        events
    }

    #[test]
    fn the_quarantine_scan_itself_deletes_a_killed_removal() {
        let temp = fixture();
        let (name, private) = killed_removal(&temp, &format!("{} 1", i32::MAX));
        let events = reclaim_quarantines_after_grace(&temp, |_| Some(false));
        assert_eq!(events, vec![(name.clone(), true)]);
        assert!(!private.exists());
        assert!(!temp.join(name).exists(), "never exposed under its name");
    }

    #[test]
    fn the_quarantine_scan_restores_a_live_owner_without_deleting() {
        let temp = fixture();
        let root = runtime_root(&temp, Some(&owner_identity().unwrap()));
        let name = root.file_name().unwrap().to_str().unwrap().to_string();
        quarantine_root(
            &temp,
            &root,
            &name,
            fs::metadata(&root).unwrap().dev(),
            &|_| Some(false),
        )
        .ok()
        .unwrap();
        assert!(reclaim_quarantines_after_grace(&temp, |_| Some(false)).is_empty());
        assert!(root.join("build/artifact").exists());
    }

    #[test]
    fn a_killed_removal_goes_even_when_the_main_scan_would_skip_its_root() {
        let temp = fixture();
        let (name, private) = killed_removal(&temp, &format!("{} 1", i32::MAX));
        let mut events = Vec::new();
        sweep_runtime_roots_in(
            &temp,
            SystemTime::now() + QUARANTINE_GRACE + Duration::from_secs(1),
            |_| Some(false),
            each(|_| Some(false)),
            &|_| true,
            &mut |reported, event| {
                events.push((
                    reported.to_string(),
                    matches!(event, RuntimeRootEvent::Removed { .. }),
                ))
            },
        )
        .unwrap();
        assert_eq!(events, vec![(name.clone(), true)]);
        assert!(!private.exists());
        assert!(!temp.join(name).exists());
    }

    #[test]
    fn a_killed_removal_with_a_read_only_directory_is_still_reclaimed() {
        let temp = fixture();
        let (name, private) = killed_removal(&temp, &format!("{} 1", i32::MAX));
        // The quarantine child sits unlisted in a 0300 parent; find it as
        // the recovery code does.
        let child = private_child(&private).unwrap().unwrap();
        fs::set_permissions(
            child.join("build/deps/inner"),
            fs::Permissions::from_mode(0o555),
        )
        .unwrap();
        let events = reclaim_quarantines_after_grace(&temp, |_| Some(false));
        assert_eq!(events, vec![(name, true)]);
        assert!(!private.exists());
    }

    #[test]
    fn runtime_sweep_waits_out_the_grace_before_taking_a_quarantine() {
        let temp = fixture();
        let (_, private) = killed_removal(&temp, &format!("{} 1", i32::MAX));
        assert!(runtime_sweep(&temp, |_| Some(false)).is_empty());
        assert!(private.exists());
    }

    #[test]
    fn runtime_sweep_restores_a_quarantine_whose_owner_is_alive() {
        let temp = fixture();
        let owner = owner_identity().unwrap();
        let root = runtime_root(&temp, Some(&owner));
        let name = root.file_name().unwrap().to_str().unwrap().to_string();
        let hidden = quarantine_root(
            &temp,
            &root,
            &name,
            fs::metadata(&root).unwrap().dev(),
            &|_| Some(false),
        )
        .ok()
        .unwrap();
        let events = sweep_after_grace(&temp, |_| Some(false));
        assert_eq!(events, vec![(name, "kept: owner running".to_string())]);
        assert!(root.join("build/artifact").exists());
        assert!(!hidden.private.exists());
    }

    #[test]
    fn runtime_sweep_keeps_a_quarantine_with_an_open_file() {
        let temp = fixture();
        let (name, private) = killed_removal(&temp, &format!("{} 1", i32::MAX));
        let events = sweep_after_grace(&temp, |_| Some(true));
        assert_eq!(events, vec![(name.clone(), "kept: open files".to_string())]);
        assert!(temp.join(name).join("build/deps/inner/object").exists());
        assert!(!private.exists());
    }

    #[test]
    fn runtime_sweep_leaves_a_quarantine_of_another_kind_of_root() {
        let temp = fixture();
        let root = temp.join("sail-339-target.old");
        fs::create_dir(&root).unwrap();
        fs::write(root.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        let hidden = quarantine_root(
            &temp,
            &root,
            "sail-339-target.old",
            fs::metadata(&root).unwrap().dev(),
            &|_| Some(false),
        )
        .ok()
        .unwrap();
        assert!(sweep_after_grace(&temp, |_| Some(false)).is_empty());
        assert!(hidden.quarantine.exists());
    }

    #[test]
    fn a_connection_close_succeeds_when_the_sweep_already_removed_its_root() {
        let temp = fixture();
        let mut scratch = OwnedRuntimeScratch::create_in(&temp).unwrap();
        let path = scratch.path().to_path_buf();
        let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
        scratch.mark_owner(child.id()).unwrap();
        child.kill().unwrap();
        child.wait().unwrap();
        runtime_sweep(&temp, |_| Some(false));
        assert!(!path.exists());
        scratch.cleanup_now().unwrap();
    }

    #[test]
    fn ten_closed_connections_leave_no_runtime_root() {
        let temp = fixture();
        for _ in 0..10 {
            let mut scratch = OwnedRuntimeScratch::create_in(&temp).unwrap();
            fs::write(scratch.path().join("build/artifact"), "build output").unwrap();
            let mut child = Command::new("/bin/sleep").arg("5").spawn().unwrap();
            scratch.mark_owner(child.id()).unwrap();
            child.kill().unwrap();
            child.wait().unwrap();
            std::mem::forget(scratch);
        }
        runtime_sweep(&temp, |_| Some(false));
        let left = fs::read_dir(&*temp)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|entry| entry.file_name().to_string_lossy().starts_with("sail-"))
            .count();
        assert_eq!(left, 0);
    }

    #[test]
    fn runtime_sweep_restores_only_the_batch_roots_that_fail_the_final_check() {
        let temp = fixture();
        let dead = format!("{} 1", i32::MAX);
        let held = runtime_root(&temp, Some(&dead));
        let unknown = runtime_root(&temp, Some(&dead));
        let free = runtime_root(&temp, Some(&dead));
        fs::write(held.join("held"), "").unwrap();
        fs::write(unknown.join("unknown"), "").unwrap();
        let calls = std::cell::Cell::new(0);
        let mut events = std::collections::HashMap::new();
        sweep_runtime_roots_in(
            &temp,
            SystemTime::now(),
            |_| Some(false),
            |paths| {
                calls.set(calls.get() + 1);
                paths
                    .iter()
                    .map(|path| {
                        if path.join("unknown").exists() {
                            None
                        } else {
                            Some(path.join("held").exists())
                        }
                    })
                    .collect()
            },
            &|_| false,
            &mut |name, event| {
                events.insert(
                    name.to_string(),
                    match event {
                        RuntimeRootEvent::Removed { .. } => "removed",
                        RuntimeRootEvent::Kept { reason } => reason,
                    },
                );
            },
        )
        .unwrap();
        assert_eq!(calls.get(), 1, "one final check for the whole batch");
        for (root, outcome, present) in [
            (&held, "changed while removing", true),
            (&unknown, "changed while removing", true),
            (&free, "removed", false),
        ] {
            let name = root.file_name().unwrap().to_str().unwrap();
            assert_eq!(events[name], outcome);
            assert_eq!(root.exists(), present);
        }
        assert!(fs::read_dir(&*temp)
            .unwrap()
            .filter_map(Result::ok)
            .all(|entry| !entry
                .file_name()
                .to_string_lossy()
                .starts_with("sail-cleanup-private-")));
    }

    #[test]
    fn runtime_sweep_splits_a_large_pass_into_bounded_batches() {
        let temp = fixture();
        let total = RUNTIME_RECLAIM_BATCH * 2 + 1;
        for _ in 0..total {
            let root = temp.join(format!("sail-runtime-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&root).unwrap();
            fs::write(root.join("artifact"), "build output").unwrap();
            fs::write(root.join(MARKER), format!("{} 1", i32::MAX)).unwrap();
        }
        let sizes = std::cell::RefCell::new(Vec::new());
        let mut removed = 0;
        sweep_runtime_roots_in(
            &temp,
            SystemTime::now(),
            |_| Some(false),
            |paths| {
                sizes.borrow_mut().push(paths.len());
                vec![Some(false); paths.len()]
            },
            &|_| false,
            &mut |_, event| removed += matches!(event, RuntimeRootEvent::Removed { .. }) as usize,
        )
        .unwrap();
        assert_eq!(removed, total);
        assert_eq!(
            *sizes.borrow(),
            vec![RUNTIME_RECLAIM_BATCH, RUNTIME_RECLAIM_BATCH, 1]
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn one_scan_checks_every_quarantined_root_in_a_batch() {
        let temp = fixture();
        let roots = (0..4)
            .map(|index| {
                let root = temp.join(format!("sail-cleanup-private-{index}/child"));
                fs::create_dir_all(&root).unwrap();
                root
            })
            .collect::<Vec<_>>();
        let probe = OpenFileProbe::default();
        assert_eq!(probe.check_quarantined(&roots), vec![Some(false); 4]);
        assert_eq!(probe.reads.get(), 1);
        let linked = fs::File::create(roots[1].join("linked")).unwrap();
        let unlinked = fs::File::create(roots[3].join("unlinked")).unwrap();
        fs::remove_file(roots[3].join("unlinked")).unwrap();
        assert_eq!(
            probe.check_quarantined(&roots),
            vec![Some(false), Some(true), Some(false), Some(true)]
        );
        assert_eq!(probe.reads.get(), 2);
        drop((linked, unlinked));
        assert_eq!(probe.check_quarantined(&roots), vec![Some(false); 4]);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_batch_check_keeps_order_when_a_root_cannot_be_resolved() {
        let temp = fixture();
        let roots = [0, 1, 2].map(|index| {
            let root = temp.join(format!("sail-cleanup-private-{index}/child"));
            fs::create_dir_all(&root).unwrap();
            root
        });
        let missing = temp.join("sail-cleanup-private-gone/child");
        let held = fs::File::create(roots[2].join("held")).unwrap();
        let paths = vec![
            roots[0].clone(),
            missing,
            roots[1].clone(),
            roots[2].clone(),
        ];
        let probe = OpenFileProbe::default();
        assert_eq!(
            probe.check_quarantined(&paths),
            vec![Some(false), None, Some(false), Some(true)]
        );
        drop(held);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_unreadable_root_does_not_hide_the_roots_beside_it() {
        let temp = fixture();
        let roots = (0..5)
            .map(|index| {
                let root = temp.join(format!("sail-cleanup-private-{index}/child"));
                fs::create_dir_all(root.join("sub")).unwrap();
                root
            })
            .collect::<Vec<_>>();
        let held = fs::File::create(roots[4].join("held")).unwrap();
        fs::set_permissions(roots[1].join("sub"), fs::Permissions::from_mode(0o000)).unwrap();
        let probe = OpenFileProbe::default();
        let results = probe.check_quarantined(&roots);
        fs::set_permissions(roots[1].join("sub"), fs::Permissions::from_mode(0o700)).unwrap();
        drop(held);
        assert_eq!(results[1], None);
        assert_eq!(
            [results[0], results[2], results[3], results[4]],
            [Some(false), Some(false), Some(false), Some(true)]
        );
        assert!(probe.reads.get() < roots.len() as u32 * 2);
    }

    #[test]
    fn runtime_sweep_rechecks_a_running_build_just_before_quarantine() {
        let temp = fixture();
        let root = runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        let busy = root.clone();
        let asked = std::cell::Cell::new(0);
        let mut kept = Vec::new();
        sweep_runtime_roots_in(
            &temp,
            SystemTime::now(),
            |_| Some(false),
            each(|_| Some(false)),
            &|path| {
                asked.set(asked.get() + 1);
                // The build starts after the first check, before the rename.
                path == busy && asked.get() > 1
            },
            &mut |_, event| {
                if let RuntimeRootEvent::Kept { reason } = event {
                    kept.push(reason);
                }
            },
        )
        .unwrap();
        assert_eq!(kept, vec!["build in use"]);
        assert!(root.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_runtime_pass_scans_open_files_twice_for_any_number_of_roots() {
        let temp = fixture();
        for _ in 0..8 {
            runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
        }
        let probe = OpenFileProbe::default();
        let mut removed = 0;
        sweep_runtime_roots_in(
            &temp,
            SystemTime::now(),
            |path| probe.check(path),
            |paths| probe.check_quarantined(paths),
            &|_| false,
            &mut |_, event| removed += matches!(event, RuntimeRootEvent::Removed { .. }) as u32,
        )
        .unwrap();
        assert_eq!(removed, 8);
        // One shared listing for the first checks, one scan for the batch.
        assert_eq!(probe.reads.get(), 2);
    }

    #[cfg(target_os = "macos")]
    #[test]
    #[ignore = "timing benchmark that runs the real lsof"]
    fn runtime_sweep_pass_time_at_scale() {
        for count in [100, 500, 1000] {
            let temp = fixture();
            for _ in 0..count {
                runtime_root(&temp, Some(&format!("{} 1", i32::MAX)));
            }
            let probe = OpenFileProbe::default();
            let mut removed = 0;
            let started = std::time::Instant::now();
            sweep_runtime_roots_in(
                &temp,
                SystemTime::now(),
                |path| probe.check(path),
                |paths| probe.check_quarantined(paths),
                &|_| false,
                &mut |_, event| removed += matches!(event, RuntimeRootEvent::Removed { .. }) as u32,
            )
            .unwrap();
            eprintln!(
                "BENCH roots={count} removed={removed} lsof_reads={} seconds={:.1}",
                probe.reads.get(),
                started.elapsed().as_secs_f64()
            );
            assert_eq!(removed, count);
        }
    }

    #[test]
    fn kept_roots_are_logged_once_per_reason() {
        let mut log = RuntimeSweepLog::default();
        let mut recorded = Vec::new();
        let mut pass = |log: &mut RuntimeSweepLog, reason| {
            let mut seen = std::collections::HashMap::new();
            log.observe(
                "sail-runtime-a",
                RuntimeRootEvent::Kept { reason },
                &mut seen,
                &mut |event, details| recorded.push((event.to_string(), details)),
            );
            log.kept = seen;
        };
        pass(&mut log, "owner running");
        pass(&mut log, "owner running");
        pass(&mut log, "open files");
        assert_eq!(recorded.len(), 2);
        assert_eq!(recorded[1].1["reason"], "open files");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn one_pass_lists_open_files_once_before_quarantine() {
        let temp = fixture();
        let roots = (0..6)
            .map(|index| {
                let root = temp.join(format!("sail-699-target.{index}"));
                fs::create_dir(&root).unwrap();
                cargo_artifacts(&root);
                root
            })
            .collect::<Vec<_>>();
        let probe = OpenFileProbe::default();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |path| probe.check(path)).unwrap();
        assert!(roots.iter().all(|root| !root.exists()));
        // One shared listing for every root's first check, then one lsof per
        // root after it is hidden in quarantine.
        assert_eq!(probe.reads.get(), 1 + roots.len() as u32);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stopping_a_process_discards_the_shared_listing() {
        let temp = fixture();
        let first = temp.join("sail-699-target.first");
        let second = temp.join("sail-699-target.second");
        for root in [&first, &second] {
            fs::create_dir(root).unwrap();
        }
        let held = second.join("held");
        let handle = fs::File::create(&held).unwrap();
        fs::remove_file(&held).unwrap();
        let probe = OpenFileProbe::default();
        assert_eq!(probe.check(&first), Some(false));
        assert_eq!(probe.check(&second), Some(true));
        drop(handle);
        assert_eq!(probe.check(&second), Some(true), "scan still shared");
        stop_root_processes(&first);
        assert_eq!(probe.check(&second), Some(false));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_quarantine_check_sees_open_and_unlinked_files_under_the_root() {
        let temp = fixture();
        let private = temp.join("sail-cleanup-private-check");
        let root = private.join("child");
        fs::create_dir_all(&root).unwrap();
        let probe = OpenFileProbe::default();
        assert_eq!(probe.check(&root), Some(false));
        let linked = fs::File::create(root.join("linked")).unwrap();
        assert_eq!(probe.check(&root), Some(true));
        drop(linked);
        let unlinked = fs::File::create(root.join("unlinked")).unwrap();
        fs::remove_file(root.join("unlinked")).unwrap();
        assert_eq!(probe.check(&root), Some(true));
        drop(unlinked);
        assert_eq!(probe.check(&root), Some(false));
    }

    #[test]
    fn a_live_owner_root_is_never_walked() {
        let temp = fixture();
        let live = temp.join("sail-699-target.live");
        fs::create_dir(&live).unwrap();
        fs::write(live.join(MARKER), owner_identity().unwrap()).unwrap();
        let before = INSPECT_WALKS.with(std::cell::Cell::get);
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert_eq!(INSPECT_WALKS.with(std::cell::Cell::get), before);
        assert!(live.exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_an_open_file_in_a_scratch_root() {
        let temp = fixture();
        let file = temp.join("held");
        let handle = fs::File::create(&file).unwrap();
        let result = has_open_files(&temp);
        drop(handle);
        assert_eq!(result, Some(true));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn finds_an_open_unlinked_file_in_a_scratch_root() {
        let temp = fixture();
        let root = temp.join("sail-339-target.unlinked");
        fs::create_dir(&root).unwrap();
        cargo_artifacts(&root);
        let file = root.join("held");
        let handle = fs::File::create(&file).unwrap();
        fs::remove_file(&file).unwrap();
        assert_eq!(has_open_files(&root), Some(true));
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, has_open_files).unwrap();
        assert!(root.exists());
        drop(handle);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn sweep_preserves_an_open_root_and_removes_a_closed_one() {
        let temp = fixture();
        let open = temp.join("sail-339-target.open");
        let closed = temp.join("sail-339-cargo.closed");
        fs::create_dir(&open).unwrap();
        fs::create_dir(&closed).unwrap();
        cargo_artifacts(&open);
        cargo_artifacts(&closed);
        let handle = fs::File::create(open.join("held")).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, has_open_files).unwrap();
        assert!(open.exists());
        assert!(!closed.exists());
        drop(handle);
    }

    #[test]
    fn keeps_unmarked_legacy_roots() {
        let temp = fixture();
        let legacy = temp.join("sail339-e2e.abc");
        fs::create_dir(&legacy).unwrap();
        fs::create_dir_all(legacy.join("debug").join(".fingerprint")).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(legacy.exists());
    }

    #[test]
    fn keeps_unverified_legacy_folders() {
        let temp = fixture();
        let notes = temp.join("sail-review-notes");
        fs::create_dir(&notes).unwrap();
        fs::create_dir(notes.join("debug")).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(notes.exists());
    }

    #[test]
    fn restores_a_root_opened_during_quarantine() {
        let temp = fixture();
        let root = temp.join("sail-339-target.race");
        fs::create_dir(&root).unwrap();
        cargo_artifacts(&root);
        let calls = std::cell::Cell::new(0);
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| {
            calls.set(calls.get() + 1);
            Some(calls.get() == 2)
        })
        .unwrap();
        assert_eq!(calls.get(), 2);
        assert!(root.exists());
    }

    #[test]
    fn hides_quarantine_from_directory_listing() {
        let temp = fixture();
        let root = temp.join("sail-339-target.private");
        fs::create_dir(&root).unwrap();
        cargo_artifacts(&root);
        let calls = std::cell::Cell::new(0);
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |path| {
            calls.set(calls.get() + 1);
            if calls.get() == 2 {
                let private = path.parent().unwrap();
                assert_eq!(
                    fs::metadata(private).unwrap().permissions().mode() & 0o777,
                    0o300
                );
                assert!(fs::read_dir(private).is_err());
                assert_ne!(path.file_name().unwrap(), "root");
                assert!(fs::File::create(private.join("root").join("late")).is_err());
            }
            Some(false)
        })
        .unwrap();
        assert_eq!(calls.get(), 2);
        assert!(!root.exists());
    }

    #[test]
    fn recovers_an_orphaned_private_quarantine() {
        let temp = fixture();
        let name = "sail-339-target.orphan";
        let private = temp.join(format!(
            "sail-cleanup-private-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        let root = private.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&private).unwrap();
        fs::create_dir(&root).unwrap();
        cargo_artifacts(&root);
        fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o300)).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(!private.exists());
        assert!(!temp.join(name).exists());
    }

    #[test]
    fn recovers_a_partial_deletion_after_the_root_marker_is_removed() {
        let temp = fixture();
        let name = "sail-339-target.partial";
        let private = temp.join(format!(
            "sail-cleanup-private-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        let root = private.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&private).unwrap();
        fs::create_dir(&root).unwrap();
        cargo_artifacts(&root);
        fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE).unwrap();
        save_private_owner(&root, &private).unwrap();
        fs::remove_file(root.join(MARKER)).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o300)).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(!private.exists());
        assert!(!temp.join(name).exists());
    }

    #[test]
    fn restores_the_owner_marker_when_a_partial_deletion_is_open() {
        let temp = fixture();
        let name = "sail-339-target.partial-open";
        let private = temp.join(format!(
            "sail-cleanup-private-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        let root = private.join(uuid::Uuid::new_v4().to_string());
        fs::create_dir(&private).unwrap();
        fs::create_dir(&root).unwrap();
        cargo_artifacts(&root);
        fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE).unwrap();
        save_private_owner(&root, &private).unwrap();
        fs::remove_file(root.join(MARKER)).unwrap();
        fs::set_permissions(&private, fs::Permissions::from_mode(0o300)).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(true)).unwrap();
        let restored = temp.join(name);
        assert!(restored.join(MARKER).exists());
        assert!(!private.exists());
    }

    #[test]
    fn ignores_unrelated_quarantine_shaped_directory() {
        let temp = fixture();
        let unrelated = temp.join(format!(
            "sail-cleanup-private-{}-sail-project",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("notes"), "keep").unwrap();
        let mode = fs::metadata(&unrelated).unwrap().permissions().mode() & 0o777;
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(unrelated.join("notes").exists());
        assert_eq!(
            fs::metadata(&unrelated).unwrap().permissions().mode() & 0o777,
            mode
        );
    }

    #[test]
    fn failed_private_listing_restores_original_mode() {
        let temp = fixture();
        let private = temp.join("private");
        fs::create_dir(&private).unwrap();
        fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE).unwrap();
        fs::write(private.join("first"), "keep").unwrap();
        fs::write(private.join("second"), "keep").unwrap();
        let mode = fs::metadata(&private).unwrap().permissions().mode() & 0o777;
        assert!(private_child(&private).is_err());
        assert_eq!(
            fs::metadata(&private).unwrap().permissions().mode() & 0o777,
            mode
        );
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn restore_never_replaces_a_new_root() {
        let temp = fixture();
        let root = temp.join("sail-339-target.replaced");
        let quarantine = temp.join("sail-339-target.quarantine");
        fs::create_dir(&root).unwrap();
        fs::create_dir(&quarantine).unwrap();
        fs::write(root.join("new"), "keep").unwrap();
        assert!(restore_without_replacing(&quarantine, &root).is_err());
        assert!(root.join("new").exists());
        assert!(quarantine.exists());
    }
}
