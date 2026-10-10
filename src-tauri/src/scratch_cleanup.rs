use std::fs;
#[cfg(target_os = "macos")]
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::MetadataExt;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};
use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System};

const IDLE_AGE: Duration = Duration::from_secs(2 * 60 * 60);
const MARKER: &str = ".sail-scratch-root";
const PRIVATE_MARKER: &str = ".sail-cleanup-private";
const PRIVATE_MARKER_VALUE: &str = "sail-cleanup-private-v1\n";
const PRIVATE_OWNER: &str = ".sail-cleanup-owner";

pub(crate) fn sweep_on_startup() {
    let root = std::env::temp_dir();
    let result = sweep(&root, SystemTime::now(), has_open_files);
    match result {
        Ok(bytes) => eprintln!("Sail scratch cleanup freed {bytes} bytes"),
        Err(error) => eprintln!("Sail scratch cleanup unavailable: {error}"),
    }
}

pub(crate) fn owner_identity() -> Option<String> {
    let pid = std::process::id();
    let mut system = System::new();
    system.refresh_processes_specifics(
        ProcessesToUpdate::Some(&[Pid::from_u32(pid)]),
        true,
        ProcessRefreshKind::nothing(),
    );
    let started = system.process(Pid::from_u32(pid))?.start_time();
    Some(format!("{pid} {started}"))
}

pub(crate) fn wrap_command(command: Command) -> std::io::Result<Command> {
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
    let mut freed = 0;
    let owner = unsafe { nix::libc::geteuid() };
    let mut processes = System::new();
    processes.refresh_processes_specifics(
        ProcessesToUpdate::All,
        true,
        ProcessRefreshKind::nothing(),
    );
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
            if fs::read_to_string(path.join(PRIVATE_MARKER))
                .ok()
                .as_deref()
                != Some(PRIVATE_MARKER_VALUE)
            {
                continue;
            }
            if now.duration_since(metadata.modified()?).unwrap_or_default() < IDLE_AGE {
                continue;
            }
            let Ok(root) = private_child(&path) else {
                continue;
            };
            let Some(old_root) = root else {
                remove_private_parent(&path);
                continue;
            };
            // A process may have seen the old child name during recovery's
            // brief directory listing. Rename it after hiding the parent so
            // only the new, unlisted path is used for the safety check.
            let root = path.join(uuid::Uuid::new_v4().to_string());
            if fs::rename(&old_root, &root).is_err() {
                continue;
            }
            let original = temp.join(original_name);
            let safe = inspect(&root, metadata.dev(), now).is_ok_and(|result| result.is_some())
                && (marker_owner_dead(&root, &processes)
                    || (!root.join(MARKER).exists()
                        && owner_dead(&path.join(PRIVATE_OWNER), &processes)))
                && open_files(&root) == Some(false);
            if safe {
                let bytes = inspect(&root, metadata.dev(), now)
                    .ok()
                    .flatten()
                    .unwrap_or(0);
                if fs::remove_dir_all(&root).is_ok() {
                    freed += bytes;
                    remove_private_parent(&path);
                }
            } else if !original.exists() {
                if restore_owner_marker(&root, &path).is_ok() {
                    restore(&root, &original);
                }
                if !root.exists() {
                    remove_private_parent(&path);
                }
            }
            continue;
        }
        let Ok(Some(bytes)) = inspect(&path, metadata.dev(), now) else {
            continue;
        };
        if !marker_owner_dead(&path, &processes) {
            continue;
        }
        // An unknown lsof result is unsafe: lack of permission is not proof of idleness.
        if open_files(&path) != Some(false) {
            continue;
        }
        let private = temp.join(format!(
            "sail-cleanup-private-{}-{name}",
            uuid::Uuid::new_v4()
        ));
        if fs::create_dir(&private).is_err() {
            continue;
        }
        if fs::write(private.join(PRIVATE_MARKER), PRIVATE_MARKER_VALUE).is_err() {
            let _ = fs::remove_file(private.join(PRIVATE_MARKER));
            let _ = fs::remove_dir(&private);
            continue;
        }
        if fs::set_permissions(&private, fs::Permissions::from_mode(0o300)).is_err() {
            remove_private_parent(&private);
            continue;
        }
        // The child name is independent of the visible parent name. A process
        // can list the temp directory, but cannot list this 0300 directory or
        // derive the child path during the final open-file check and deletion.
        let quarantine = private.join(uuid::Uuid::new_v4().to_string());
        if fs::rename(&path, &quarantine).is_err() {
            remove_private_parent(&private);
            continue;
        }
        let safe = inspect(&quarantine, metadata.dev(), now).is_ok_and(|result| result.is_some())
            && marker_owner_dead(&quarantine, &processes)
            && open_files(&quarantine) == Some(false);
        if !safe {
            restore(&quarantine, &path);
            if !quarantine.exists() {
                remove_private_parent(&private);
            }
            continue;
        }
        // Keep the verified owner outside the tree being removed. A crash can
        // otherwise delete the root marker first and strand a partial build.
        if save_private_owner(&quarantine, &private).is_err() {
            restore(&quarantine, &path);
            if !quarantine.exists() {
                remove_private_parent(&private);
            }
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&quarantine) {
            eprintln!(
                "Sail scratch cleanup kept {}: {error}",
                quarantine.display()
            );
            continue;
        }
        remove_private_parent(&private);
        freed += bytes;
    }
    Ok(freed)
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

fn marker_owner_dead(path: &Path, processes: &System) -> bool {
    owner_dead(&path.join(MARKER), processes)
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

fn owner_dead(marker: &Path, processes: &System) -> bool {
    if !marker.exists() {
        return false;
    }
    let Ok(owner) = fs::read_to_string(marker) else {
        return false;
    };
    let mut parts = owner.split_whitespace();
    let (Some(pid), Some(started), None) = (parts.next(), parts.next(), parts.next()) else {
        return false;
    };
    let Ok(pid) = pid.parse::<i32>() else {
        return false;
    };
    let Ok(started) = started.parse::<u64>() else {
        return false;
    };
    if pid <= 0 || started == 0 {
        return false;
    }
    let result = unsafe { nix::libc::kill(pid, 0) };
    if result == -1 {
        return std::io::Error::last_os_error().raw_os_error() == Some(nix::libc::ESRCH);
    }
    processes
        .process(Pid::from_u32(pid as u32))
        .is_some_and(|process| process.start_time() != started)
}

fn inspect(path: &Path, device: u64, now: SystemTime) -> std::io::Result<Option<u64>> {
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

fn has_open_files(path: &Path) -> Option<bool> {
    let binary = if cfg!(target_os = "macos") {
        PathBuf::from("/usr/sbin/lsof")
    } else {
        PathBuf::from("lsof")
    };
    let output = Command::new(binary).arg("+D").arg(path).output().ok()?;
    if !output.stderr.is_empty() {
        return None;
    }
    if !output.stdout.is_empty() {
        return Some(true);
    }
    if output.status.code() != Some(1) {
        return None;
    }
    // +D walks directory entries and misses an unlinked file that is still
    // open. +L1 lists those descriptors, including their last path.
    let unlinked = Command::new(if cfg!(target_os = "macos") {
        PathBuf::from("/usr/sbin/lsof")
    } else {
        PathBuf::from("lsof")
    })
    .args(["-nP", "-Fn", "+L1"])
    .output()
    .ok()?;
    if !unlinked.stderr.is_empty() || !matches!(unlinked.status.code(), Some(0 | 1)) {
        return None;
    }
    use std::os::unix::ffi::OsStrExt;
    // macOS lsof reports canonical paths even when TMPDIR begins with /var,
    // which is a symlink to /private/var.
    let canonical = fs::canonicalize(path).ok()?;
    let root = canonical.as_os_str().as_bytes();
    let active = unlinked.stdout.split(|byte| *byte == b'\n').any(|line| {
        line.strip_prefix(b"n").is_some_and(|name| {
            name == root || (name.starts_with(root) && name.get(root.len()) == Some(&b'/'))
        })
    });
    Some(active)
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
