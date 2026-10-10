use std::fs;
use std::os::unix::fs::MetadataExt;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, SystemTime};

const IDLE_AGE: Duration = Duration::from_secs(2 * 60 * 60);
const MARKER: &str = ".sail-scratch-root";

pub(crate) fn sweep_on_startup() {
    let root = std::env::temp_dir();
    let result = sweep(&root, SystemTime::now(), has_open_files);
    match result {
        Ok(bytes) => eprintln!("Sail scratch cleanup freed {bytes} bytes"),
        Err(error) => eprintln!("Sail scratch cleanup unavailable: {error}"),
    }
}

fn sweep(
    temp: &Path,
    now: SystemTime,
    open_files: impl Fn(&Path) -> Option<bool>,
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
        let Ok(Some(bytes)) = inspect(&path, metadata.dev(), now) else {
            continue;
        };
        if !marker_owner_dead(&path) {
            continue;
        }
        // An unknown lsof result is unsafe: lack of permission is not proof of idleness.
        if open_files(&path) != Some(false) {
            continue;
        }
        let quarantine = temp.join(format!("sail-cleanup-quarantine-{}", uuid::Uuid::new_v4()));
        if fs::rename(&path, &quarantine).is_err() {
            continue;
        }
        let safe = inspect(&quarantine, metadata.dev(), now).is_ok_and(|result| result.is_some())
            && marker_owner_dead(&quarantine)
            && open_files(&quarantine) == Some(false);
        if !safe {
            restore(&quarantine, &path);
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&quarantine) {
            eprintln!(
                "Sail scratch cleanup kept {}: {error}",
                quarantine.display()
            );
            continue;
        }
        freed += bytes;
    }
    Ok(freed)
}

fn restore(quarantine: &Path, original: &Path) {
    if let Err(error) = fs::rename(quarantine, original) {
        eprintln!(
            "Sail scratch cleanup kept {} after restore failed: {error}",
            quarantine.display()
        );
    }
}

fn candidate_name(name: &str, path: &Path) -> bool {
    if !name.starts_with("sail") {
        return false;
    }
    if name.starts_with("sail-") && path.join(MARKER).is_file() {
        return true;
    }
    if name
        .strip_prefix("sail-cleanup-quarantine-")
        .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
    {
        return true;
    }
    if name
        .strip_prefix("sail")
        .and_then(|tail| tail.split_once("-e2e"))
        .is_some_and(|(issue, _)| issue.parse::<u64>().is_ok())
    {
        return has_cargo_artifacts(path);
    }
    let Some(tail) = name.strip_prefix("sail-") else {
        return false;
    };
    // Recognize only the old build roots; arbitrary sail-* folders are not ours.
    ((tail.starts_with("review-") || tail.starts_with("ship-"))
        || (tail.split_once('-').is_some_and(|(issue, role)| {
            issue.parse::<u64>().is_ok()
                && ["target", "cargo", "e2e", "adversary"]
                    .iter()
                    .any(|known| role.starts_with(known))
        })))
        && has_cargo_artifacts(path)
}

fn has_cargo_artifacts(path: &Path) -> bool {
    ["", "target", "target-worktree"].iter().any(|root| {
        ["debug", "release"]
            .iter()
            .any(|profile| path.join(root).join(profile).join(".fingerprint").is_dir())
    })
}

fn marker_owner_dead(path: &Path) -> bool {
    let marker = path.join(MARKER);
    if !marker.exists() {
        return true;
    }
    let Ok(owner) = fs::read_to_string(marker) else {
        return false;
    };
    let Ok(pid) = owner.trim().parse::<i32>() else {
        return false;
    };
    if pid <= 0 {
        return false;
    }
    let result = unsafe { nix::libc::kill(pid, 0) };
    result == -1 && std::io::Error::last_os_error().raw_os_error() == Some(nix::libc::ESRCH)
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
    match output.status.code() {
        Some(1) => Some(false),
        _ => None,
    }
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
        sweep(&temp, future, |_| None).unwrap();
        assert!(worktree.exists());
        assert!(unknown.exists());
    }

    #[test]
    fn keeps_a_marked_root_while_its_owner_lives() {
        let temp = fixture();
        let active = temp.join("sail-339-implement.owned");
        fs::create_dir(&active).unwrap();
        fs::write(active.join(MARKER), std::process::id().to_string()).unwrap();
        let future = SystemTime::now() + IDLE_AGE + Duration::from_secs(1);
        sweep(&temp, future, |_| Some(false)).unwrap();
        assert!(active.exists());
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
    fn recognizes_old_e2e_roots() {
        let temp = fixture();
        cargo_artifacts(&temp);
        assert!(candidate_name("sail339-e2e.abc", &temp));
        assert!(!candidate_name("sail339-context.abc", &temp));
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
}
