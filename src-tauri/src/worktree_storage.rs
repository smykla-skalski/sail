use crate::acp_terminal::stable_worktree_identity;
use serde::Serialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;

const OWNER_FILE: &str = "worktree-owner-v2";
const OWNER_HEADER: &str = "sail-terminal-worktree-owner-v2";
const GENERATION_FILE: &str = "sail-worktree-generation-v1";
const GENERATION_HEADER: &str = "sail-worktree-generation-v1";
const REPOSITORY_FILE: &str = "sail-repository-generation-v1";
const REPOSITORY_HEADER: &str = "sail-repository-generation-v1";
const ACTIVE_PREFIX: &str = ".active-";
const QUARANTINE_PREFIX: &str = ".reclaim-";

#[derive(Clone, Debug, Eq, PartialEq)]
struct WorktreeIdentity {
    root: PathBuf,
    common_dir: PathBuf,
    admin_dir: PathBuf,
    generation: String,
    repository_generation: String,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupPending {
    pub(crate) cache_key: String,
    pub(crate) reason: String,
}

pub(crate) struct WorktreeDataLease {
    directory: PathBuf,
    active_marker: PathBuf,
    started: AtomicBool,
    released: AtomicBool,
    _lease_lock: FileLock,
}

impl WorktreeDataLease {
    pub(crate) fn mark_started(&self) {
        self.started.store(true, Ordering::Release);
    }

    pub(crate) fn release_clean(&self) -> Result<(), String> {
        if self.released.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        if let Err(error) = fs::remove_file(&self.active_marker) {
            if error.kind() != std::io::ErrorKind::NotFound {
                self.released.store(false, Ordering::Release);
                report_pending(&self.directory, "active-marker-remove-failed");
                return Err(format!(
                    "Cannot clear private storage ownership marker: {error}"
                ));
            }
        }
        if let Err(error) = self._lease_lock.unlock() {
            self.released.store(false, Ordering::Release);
            report_pending(&self.directory, "active-lease-release-failed");
            return Err(error);
        }
        Ok(())
    }
}

impl Drop for WorktreeDataLease {
    fn drop(&mut self) {
        if !self.started.load(Ordering::Acquire) && !self.released.load(Ordering::Acquire) {
            let _ = self.release_clean();
        }
    }
}

pub(crate) fn register(
    cache_directory: &Path,
    requested_worktree: &Path,
) -> Result<(PathBuf, Arc<WorktreeDataLease>), String> {
    let identity = match resolve_identity(requested_worktree) {
        Ok(identity) => identity,
        Err(error) if has_git_metadata(requested_worktree) => {
            report_selected(requested_worktree, "git-identity-unverifiable");
            return Err(format!("Private agent data for {} is retained; Git identity cannot be verified ({error}). No data was deleted. Retry after the repository is accessible and its worktree registration can be verified.", requested_worktree.display()));
        }
        Err(_) => return register_plain_folder(cache_directory, requested_worktree),
    };
    let data_directory = identity_data_directory(cache_directory, &identity)?;
    let key = cache_key(&data_directory)?;
    let _repo_lock = FileLock::acquire(
        &lock_path(cache_directory, "repo", &identity.common_dir)?,
        true,
    )?;
    let _mutation = FileLock::acquire(
        &lock_path(cache_directory, "mutation", &data_directory)?,
        true,
    )?;

    fs::create_dir_all(
        data_directory
            .parent()
            .ok_or("Invalid private storage path.")?,
    )
    .map_err(|error| error.to_string())?;
    if data_directory.exists() {
        validate_owner(&data_directory, &identity, &data_directory)?;
    } else {
        publish_owner_directory(&data_directory, &identity)?;
    }

    let lease_path = lock_path(cache_directory, "lease", &data_directory)?;
    let lease_lock = FileLock::acquire(&lease_path, false)?;
    let active_marker = data_directory.join(format!("{ACTIVE_PREFIX}{}.v1", uuid::Uuid::new_v4()));
    let marker_contents = format!("sail-active-worktree-v1\n{}\n{}\n", std::process::id(), key);
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&active_marker)
        .map_err(|error| error.to_string())?;
    marker
        .write_all(marker_contents.as_bytes())
        .and_then(|_| marker.sync_all())
        .map_err(|error| error.to_string())?;
    drop(marker);

    let lease = Arc::new(WorktreeDataLease {
        directory: data_directory,
        active_marker,
        started: AtomicBool::new(false),
        released: AtomicBool::new(false),
        _lease_lock: lease_lock,
    });
    Ok((lease.directory.clone(), lease))
}

fn register_plain_folder(
    cache_directory: &Path,
    requested_worktree: &Path,
) -> Result<(PathBuf, Arc<WorktreeDataLease>), String> {
    let root = stable_worktree_identity(requested_worktree);
    let data_directory = legacy_data_directory(cache_directory, &root)?;
    let key = cache_key(&data_directory)?;
    fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let lease_path = lock_path(cache_directory, "lease", &data_directory)?;
    let lease_lock = FileLock::acquire(&lease_path, false)?;
    let active_marker = data_directory.join(format!("{ACTIVE_PREFIX}{}.v1", uuid::Uuid::new_v4()));
    let mut marker = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&active_marker)
        .map_err(|error| error.to_string())?;
    marker
        .write_all(format!("sail-active-worktree-v1\n{}\n{}\n", std::process::id(), key).as_bytes())
        .and_then(|_| marker.sync_all())
        .map_err(|error| error.to_string())?;
    let lease = Arc::new(WorktreeDataLease {
        directory: data_directory,
        active_marker,
        started: AtomicBool::new(false),
        released: AtomicBool::new(false),
        _lease_lock: lease_lock,
    });
    Ok((lease.directory.clone(), lease))
}

fn identity_data_directory(
    cache_directory: &Path,
    identity: &WorktreeIdentity,
) -> Result<PathBuf, String> {
    let key_material = format!(
        "{}\0{}\0{}",
        encode_path(&identity.root),
        identity.repository_generation,
        identity.generation
    );
    let digest = Sha256::digest(key_material.as_bytes());
    let name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(cache_directory.join("terminal-worktrees").join(name))
}

fn legacy_data_directory(cache_directory: &Path, root: &Path) -> Result<PathBuf, String> {
    let digest = Sha256::digest(path_bytes(root));
    let name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    Ok(cache_directory.join("terminal-worktrees").join(name))
}

fn has_git_metadata(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(directory) = current {
        if directory.join(".git").exists() {
            return true;
        }
        current = directory.parent();
    }
    false
}

pub(crate) fn reconcile(cache_directory: &Path) {
    let cache_root = cache_directory.join("terminal-worktrees");
    let entries = match fs::read_dir(&cache_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(_) => {
            report_pending(&cache_root, "storage-scan-failed");
            return;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            report_pending(&cache_root, "storage-entry-unreadable");
            continue;
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            report_pending(&entry.path(), "storage-entry-name-unreadable");
            continue;
        };
        if let Some(key) = name.strip_prefix(QUARANTINE_PREFIX) {
            if let Some((key, _)) = key.split_once('-').filter(|(key, _)| valid_cache_key(key)) {
                remove_quarantine(&entry.path(), key);
            }
            continue;
        }
        if !valid_cache_key(name) {
            continue;
        }
        let data_directory = entry.path();
        let identity = match read_owner(&data_directory) {
            Ok(identity) => identity,
            Err(reason) => {
                report_pending(&data_directory, reason);
                continue;
            }
        };
        let expected_directory = match identity_data_directory(cache_directory, &identity) {
            Ok(directory) => directory,
            Err(_) => {
                report_pending(&data_directory, "owner-cache-key-unreadable");
                continue;
            }
        };
        if expected_directory != data_directory {
            report_pending(&data_directory, "owner-cache-key-mismatch");
            continue;
        }
        let repo_lock_path = match lock_path(cache_directory, "repo", &identity.common_dir) {
            Ok(path) => path,
            Err(_) => {
                report_pending(&data_directory, "repository-lock-unavailable");
                continue;
            }
        };
        let repo_lock = match FileLock::try_acquire(&repo_lock_path, true) {
            Ok(lock) => lock,
            Err(_) => continue,
        };
        let mutation_path = match lock_path(cache_directory, "mutation", &data_directory) {
            Ok(path) => path,
            Err(_) => {
                report_pending(&data_directory, "storage-lock-unavailable");
                continue;
            }
        };
        let mutation = match FileLock::try_acquire(&mutation_path, true) {
            Ok(lock) => lock,
            Err(_) => continue,
        };
        let lease_path = match lock_path(cache_directory, "lease", &data_directory) {
            Ok(path) => path,
            Err(_) => {
                report_pending(&data_directory, "active-use");
                continue;
            }
        };
        let lease = match FileLock::try_acquire(&lease_path, true) {
            Ok(lock) => lock,
            Err(_) => continue,
        };
        if has_active_markers(&data_directory) {
            report_pending(&data_directory, "unclean-active-use");
            continue;
        }
        if identity.root.exists() {
            match current_identity_matches(&identity) {
                Ok(true) => continue,
                Ok(false) => {
                    report_pending(&data_directory, "worktree-path-reused-or-moved");
                    continue;
                }
                Err(reason) => {
                    report_pending(&data_directory, reason);
                    continue;
                }
            }
        }
        match verify_identity_removed(&identity) {
            Ok(true) => {}
            Ok(false) => {
                report_pending(&data_directory, "git-worktree-registration-still-present");
                continue;
            }
            Err(reason) => {
                report_pending(&data_directory, reason);
                continue;
            }
        }
        let quarantine_key = match cache_key(&data_directory) {
            Ok(key) => key,
            Err(_) => {
                report_pending(&data_directory, "owner-cache-key-unreadable");
                continue;
            }
        };
        let quarantine = match quarantine_path(&cache_root, &quarantine_key) {
            Ok(path) => path,
            Err(_) => {
                report_pending(&data_directory, "cannot-create-quarantine-name");
                continue;
            }
        };
        if fs::rename(&data_directory, &quarantine).is_err() {
            report_pending(&data_directory, "cannot-quarantine-storage");
            continue;
        }
        drop(lease);
        drop(mutation);
        drop(repo_lock);
        remove_quarantine(&quarantine, &quarantine_key);
    }
}

pub(crate) fn cleanup_status(cache_directory: &Path) -> Vec<CleanupPending> {
    let mut pending = Vec::new();
    let cache_root = cache_directory.join("terminal-worktrees");
    let entries = match fs::read_dir(&cache_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return pending,
        Err(_) => {
            return vec![CleanupPending {
                cache_key: "unknown".into(),
                reason: "storage-scan-failed".into(),
            }]
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                pending.push(CleanupPending {
                    cache_key: "unknown".into(),
                    reason: "storage-entry-unreadable".into(),
                });
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let directory = entry.path();
        let reason = if name.starts_with(QUARANTINE_PREFIX) {
            Some("cleanup-interrupted")
        } else if !valid_cache_key(&name) {
            None
        } else {
            match read_owner(&directory) {
                Err(reason) => Some(reason),
                Ok(identity) => {
                    let lease_path = lock_path(cache_directory, "lease", &directory);
                    let lease = lease_path
                        .ok()
                        .and_then(|path| FileLock::try_acquire(&path, true).ok());
                    if lease.is_none() {
                        None
                    } else if has_active_markers(&directory) {
                        Some("unclean-active-use")
                    } else if identity.root.exists() {
                        match current_identity_matches(&identity) {
                            Ok(true) => None,
                            Ok(false) => Some("worktree-path-reused-or-moved"),
                            Err(reason) => Some(reason),
                        }
                    } else {
                        match verify_identity_removed(&identity) {
                            Ok(true) => Some("stale-worktree-storage"),
                            Ok(false) => Some("git-worktree-registration-still-present"),
                            Err(reason) => Some(reason),
                        }
                    }
                }
            }
        };
        if let Some(reason) = reason {
            pending.push(CleanupPending {
                cache_key: name,
                reason: reason.into(),
            });
        }
    }
    pending.sort_by(|left, right| left.cache_key.cmp(&right.cache_key));
    pending
}

pub(crate) fn retry_cleanup(cache_directory: &Path) -> Vec<CleanupPending> {
    reconcile(cache_directory);
    cleanup_status(cache_directory)
}

pub(crate) fn data_directory_for_root(cache_directory: &Path, root: &Path) -> Option<PathBuf> {
    let root = stable_worktree_identity(root);
    let entries = fs::read_dir(cache_directory.join("terminal-worktrees")).ok()?;
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(identity) = read_owner(&path) else {
            continue;
        };
        if identity.root == root
            && identity_data_directory(cache_directory, &identity)
                .ok()
                .as_deref()
                == Some(path.as_path())
        {
            return Some(path);
        }
    }
    None
}

pub(crate) fn is_managed_directory(path: &Path) -> bool {
    read_owner(path).is_ok()
}

pub(crate) fn discover_data_directories(cache_directory: &Path, outer_root: &Path) -> Vec<PathBuf> {
    let outer_root = stable_worktree_identity(outer_root);
    let cache_root = cache_directory.join("terminal-worktrees");
    let entries = match fs::read_dir(&cache_root) {
        Ok(entries) => entries,
        Err(_) => return Vec::new(),
    };
    let mut directories = Vec::new();
    for entry in entries.flatten() {
        let path = entry.path();
        let Ok(identity) = read_owner(&path) else {
            continue;
        };
        if !identity.root.starts_with(&outer_root) {
            continue;
        }
        match identity_data_directory(cache_directory, &identity) {
            Ok(expected) if expected == path => directories.push(path),
            _ => report_pending(&path, "owner-cache-key-mismatch"),
        }
    }
    directories.sort_by_key(|path| std::cmp::Reverse(path.components().count()));
    directories
}

fn current_identity_matches(identity: &WorktreeIdentity) -> Result<bool, &'static str> {
    let root = dunce::canonicalize(&identity.root).map_err(|_| "worktree-path-unreadable")?;
    let top = git_path(
        &root,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
    )
    .map_err(|_| "git-worktree-root-unverifiable")?;
    let top = dunce::canonicalize(top).map_err(|_| "git-worktree-root-unverifiable")?;
    if top != identity.root {
        return Ok(false);
    }
    let common = git_path(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )
    .map_err(|_| "git-common-dir-unverifiable")?;
    let admin = git_path(&root, &["rev-parse", "--path-format=absolute", "--git-dir"])
        .map_err(|_| "git-admin-dir-unverifiable")?;
    let common = dunce::canonicalize(common).map_err(|_| "git-common-dir-unverifiable")?;
    let admin = dunce::canonicalize(admin).map_err(|_| "git-admin-dir-unverifiable")?;
    if common != identity.common_dir || admin != identity.admin_dir {
        return Ok(false);
    }
    let repo_generation = read_generation(&common.join(REPOSITORY_FILE))
        .map_err(|_| "git-repository-generation-ambiguous")?;
    let admin_generation = read_generation(&admin.join(GENERATION_FILE))
        .map_err(|_| "git-admin-generation-ambiguous")?;
    Ok(
        repo_generation.as_deref() == Some(identity.repository_generation.as_str())
            && admin_generation.as_deref() == Some(identity.generation.as_str()),
    )
}

pub(crate) fn remove_after_worktree_removal(
    cache_directory: &Path,
    data_directories: &[PathBuf],
) -> Result<(), String> {
    for data_directory in data_directories {
        let identity = read_owner(data_directory).map_err(|reason| {
            report_pending(data_directory, reason);
            format!("Private agent data is retained pending ownership verification ({reason}).")
        })?;
        if identity_data_directory(cache_directory, &identity)? != *data_directory {
            report_pending(data_directory, "owner-cache-key-mismatch");
            return Err(
                "Private agent data is retained because its owner key does not match.".into(),
            );
        }
        let _repo_lock = FileLock::acquire(
            &lock_path(cache_directory, "repo", &identity.common_dir)?,
            true,
        )?;
        let _mutation = FileLock::acquire(
            &lock_path(cache_directory, "mutation", data_directory)?,
            true,
        )?;
        let _lease =
            FileLock::try_acquire(&lock_path(cache_directory, "lease", data_directory)?, true)
                .map_err(|_| {
                    report_pending(data_directory, "active-use");
                    "Private agent data is retained because another Sail process is still using it."
                        .to_string()
                })?;
        if has_active_markers(data_directory) {
            report_pending(data_directory, "unclean-active-use");
            return Err(
                "Private agent data is retained because prior active use was not cleanly closed."
                    .into(),
            );
        }
        let current_owner = read_owner(data_directory)?;
        if current_owner != identity {
            report_pending(data_directory, "owner-changed-during-removal");
            return Err("Private agent data ownership changed during worktree removal.".into());
        }
        if !verify_identity_removed(&identity).map_err(|reason| {
            report_pending(data_directory, reason);
            format!(
                "Private agent data is retained because worktree identity is ambiguous ({reason})."
            )
        })? {
            report_pending(data_directory, "worktree-identity-still-present");
            return Err(
                "Private agent data is retained because Git still identifies this worktree.".into(),
            );
        }
        let name = cache_key(data_directory)?;
        let quarantine = quarantine_path(
            data_directory
                .parent()
                .ok_or("Invalid private storage path.")?,
            &name,
        )?;
        fs::rename(data_directory, &quarantine).map_err(|error| {
            report_pending(data_directory, "cannot-quarantine-storage");
            error.to_string()
        })?;
        drop(_lease);
        drop(_mutation);
        drop(_repo_lock);
        remove_quarantine(&quarantine, &name);
    }
    Ok(())
}

fn resolve_identity(worktree: &Path) -> Result<WorktreeIdentity, String> {
    let root = dunce::canonicalize(worktree)
        .map_err(|_| "Worktree folder no longer exists.".to_string())?;
    let root = git_path(
        &root,
        &["rev-parse", "--path-format=absolute", "--show-toplevel"],
    )?;
    let common_dir = git_path(
        &root,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let admin_dir = git_path(&root, &["rev-parse", "--path-format=absolute", "--git-dir"])?;
    let root =
        dunce::canonicalize(&root).map_err(|_| "Worktree root cannot be verified.".to_string())?;
    let common_dir = dunce::canonicalize(&common_dir)
        .map_err(|_| "Git common directory cannot be verified.".to_string())?;
    let admin_dir = dunce::canonicalize(&admin_dir)
        .map_err(|_| "Git worktree admin directory cannot be verified.".to_string())?;
    if !admin_dir.starts_with(&common_dir) && admin_dir != common_dir {
        return Err("Git worktree admin directory is outside its repository.".into());
    }
    let generation = ensure_generation(&admin_dir, GENERATION_FILE, GENERATION_HEADER)?;
    let repository_generation = ensure_generation(&common_dir, REPOSITORY_FILE, REPOSITORY_HEADER)?;
    Ok(WorktreeIdentity {
        root,
        common_dir,
        admin_dir,
        generation,
        repository_generation,
    })
}

fn git_path(directory: &Path, arguments: &[&str]) -> Result<PathBuf, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(arguments)
        .output()
        .map_err(|error| format!("Cannot inspect worktree identity: {error}"))?;
    if !output.status.success() {
        return Err("Cannot verify Git worktree identity.".into());
    }
    let path = strip_final_newline(output.stdout);
    let path = path_from_bytes(path)?;
    if !path.is_absolute() {
        return Err("Git returned a non-absolute worktree identity path.".into());
    }
    Ok(path)
}

fn strip_final_newline(mut bytes: Vec<u8>) -> Vec<u8> {
    if bytes.last() == Some(&b'\n') {
        bytes.pop();
        if bytes.last() == Some(&b'\r') {
            bytes.pop();
        }
    }
    bytes
}

#[cfg(unix)]
fn path_from_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> {
    use std::os::unix::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

#[cfg(windows)]
fn path_from_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    if bytes.len() % 2 != 0 {
        return Err("Git returned an invalid worktree identity path.".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &bytes
            .chunks_exact(2)
            .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
            .collect::<Vec<_>>(),
    )))
}

#[cfg(not(any(unix, windows)))]
fn path_from_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> {
    String::from_utf8(bytes)
        .map(PathBuf::from)
        .map_err(|error| error.to_string())
}

fn ensure_generation(directory: &Path, filename: &str, header: &str) -> Result<String, String> {
    let marker = directory.join(filename);
    match read_generation(&marker) {
        Ok(Some(generation)) => return Ok(generation),
        Ok(None) => {}
        Err(error) => return Err(error),
    }
    let generation = uuid::Uuid::new_v4().to_string();
    let temporary = directory.join(format!(".{filename}-{}.tmp", uuid::Uuid::new_v4()));
    let content = format!("{header}\n{generation}\n");
    let write = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)?;
        file.write_all(content.as_bytes())?;
        file.sync_all()?;
        fs::hard_link(&temporary, &marker)?;
        Ok::<_, std::io::Error>(())
    })();
    let _ = fs::remove_file(&temporary);
    match write {
        Ok(()) => Ok(generation),
        Err(error) if marker.exists() => read_generation(&marker)?
            .ok_or_else(|| format!("Cannot read worktree generation marker: {error}")),
        Err(error) => Err(format!("Cannot persist worktree generation: {error}")),
    }
}

fn read_generation(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect worktree generation: {error}")),
    };
    if !metadata.file_type().is_file() {
        return Err("Worktree generation marker is not a regular file.".into());
    }
    let contents = fs::read_to_string(path)
        .map_err(|error| format!("Cannot read worktree generation marker: {error}"))?;
    let mut lines = contents.lines();
    if !matches!(lines.next(), Some(GENERATION_HEADER | REPOSITORY_HEADER)) {
        return Err("Worktree generation marker is malformed.".into());
    }
    let generation = lines
        .next()
        .ok_or("Worktree generation marker is incomplete.")?;
    if lines.next().is_some() || uuid::Uuid::parse_str(generation).is_err() {
        return Err("Worktree generation marker is malformed.".into());
    }
    Ok(Some(generation.to_string()))
}

fn publish_owner_directory(
    data_directory: &Path,
    identity: &WorktreeIdentity,
) -> Result<(), String> {
    let parent = data_directory
        .parent()
        .ok_or("Invalid private storage path.")?;
    let temporary = parent.join(format!(".owner-{}.tmp", uuid::Uuid::new_v4()));
    fs::create_dir(&temporary).map_err(|error| error.to_string())?;
    let owner = temporary.join(OWNER_FILE);
    let contents = encode_owner(identity);
    let write = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&owner)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, data_directory)?;
        Ok::<_, std::io::Error>(())
    })();
    if write.is_err() {
        let _ = fs::remove_dir_all(&temporary);
    }
    write.map_err(|error| error.to_string())
}

fn encode_owner(identity: &WorktreeIdentity) -> String {
    format!(
        "{OWNER_HEADER}\n{}\n{}\n{}\n{}\n{}\n",
        encode_path(&identity.root),
        encode_path(&identity.common_dir),
        encode_path(&identity.admin_dir),
        identity.repository_generation,
        identity.generation
    )
}

fn read_owner(data_directory: &Path) -> Result<WorktreeIdentity, &'static str> {
    let owner_file = data_directory.join(OWNER_FILE);
    let metadata = fs::symlink_metadata(&owner_file).map_err(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            "owner-metadata-missing"
        } else {
            "owner-metadata-unreadable"
        }
    })?;
    if !metadata.file_type().is_file() {
        return Err("owner-metadata-not-regular");
    }
    let contents = fs::read_to_string(owner_file).map_err(|_| "owner-metadata-unreadable")?;
    let mut lines = contents.lines();
    if lines.next() != Some(OWNER_HEADER) {
        return Err("legacy-or-unknown-owner-metadata");
    }
    let root = decode_path(lines.next().ok_or("owner-metadata-malformed")?)
        .map_err(|_| "owner-metadata-malformed")?;
    let common_dir = decode_path(lines.next().ok_or("owner-metadata-malformed")?)
        .map_err(|_| "owner-metadata-malformed")?;
    let admin_dir = decode_path(lines.next().ok_or("owner-metadata-malformed")?)
        .map_err(|_| "owner-metadata-malformed")?;
    let repository_generation = lines.next().ok_or("owner-metadata-malformed")?.to_string();
    let generation = lines.next().ok_or("owner-metadata-malformed")?.to_string();
    if lines.next().is_some()
        || uuid::Uuid::parse_str(&generation).is_err()
        || uuid::Uuid::parse_str(&repository_generation).is_err()
        || !root.is_absolute()
        || !common_dir.is_absolute()
        || !admin_dir.is_absolute()
        || (admin_dir != common_dir && !admin_dir.starts_with(&common_dir))
    {
        return Err("owner-metadata-malformed");
    }
    Ok(WorktreeIdentity {
        root,
        common_dir,
        admin_dir,
        generation,
        repository_generation,
    })
}

fn validate_owner(
    data_directory: &Path,
    expected: &WorktreeIdentity,
    key_path: &Path,
) -> Result<(), String> {
    let owner = read_owner(data_directory).map_err(|reason| {
        report_selected(&expected.root, reason);
        format!("Private agent storage at {} is pending cleanup because its owner metadata is {reason}; no data was changed.", expected.root.display())
    })?;
    if owner != *expected {
        report_selected(&expected.root, "worktree-generation-mismatch");
        return Err(format!("Private agent storage at {} belongs to a different or unverifiable Git worktree generation. No data was deleted or overwritten; remove the previous owning worktree and retry after cleanup can verify its identity. Cache key {} remains pending.", expected.root.display(), cache_key(key_path)?));
    }
    Ok(())
}

fn verify_identity_removed(identity: &WorktreeIdentity) -> Result<bool, &'static str> {
    if identity.root.exists() {
        return Ok(false);
    }
    let common = fs::canonicalize(&identity.common_dir)
        .map_err(|_| "git-common-dir-missing-or-unreadable")?;
    if common != identity.common_dir {
        return Ok(false);
    }
    match read_generation(&identity.common_dir.join(REPOSITORY_FILE)) {
        Ok(Some(generation)) if generation == identity.repository_generation => {}
        Ok(_) => return Ok(false),
        Err(_) => return Err("git-repository-generation-ambiguous"),
    }
    let listed = git_worktrees(&identity.common_dir).map_err(|_| "git-worktree-list-failed")?;
    if listed
        .iter()
        .any(|path| lexical_absolute(path) == lexical_absolute(&identity.root))
    {
        return Ok(false);
    }
    let admin_metadata = match fs::symlink_metadata(&identity.admin_dir) {
        Ok(metadata) => Some(metadata),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
        Err(_) => return Err("git-admin-dir-unreadable"),
    };
    if let Some(metadata) = admin_metadata {
        if !metadata.file_type().is_dir() {
            return Ok(false);
        }
        match read_generation(&identity.admin_dir.join(GENERATION_FILE)) {
            Ok(Some(generation)) if generation == identity.generation => return Ok(false),
            Ok(_) => return Ok(false),
            Err(_) => return Err("git-admin-generation-ambiguous"),
        }
    }
    let linked_admins = identity.common_dir.join("worktrees");
    let admins = match fs::read_dir(&linked_admins) {
        Ok(admins) => admins,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(true),
        Err(_) => return Err("git-admin-scan-failed"),
    };
    for entry in admins {
        let entry = entry.map_err(|_| "git-admin-entry-unreadable")?;
        let metadata = entry
            .file_type()
            .map_err(|_| "git-admin-entry-unreadable")?;
        if !metadata.is_dir() {
            return Err("git-admin-entry-ambiguous");
        }
        let marker = entry.path().join(GENERATION_FILE);
        match read_generation(&marker) {
            Ok(Some(generation)) if generation == identity.generation => return Ok(false),
            Ok(Some(_)) | Ok(None) => {}
            Err(_) => return Err("git-admin-generation-ambiguous"),
        }
    }
    Ok(true)
}

fn git_worktrees(common_dir: &Path) -> Result<Vec<PathBuf>, String> {
    let mut git_dir_argument = OsString::from("--git-dir=");
    git_dir_argument.push(common_dir.as_os_str());
    let output = std::process::Command::new("git")
        .arg(git_dir_argument)
        .args(["worktree", "list", "--porcelain", "-z"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Git could not list worktrees.".into());
    }
    let mut paths = Vec::new();
    for field in output.stdout.split(|byte| *byte == 0) {
        if let Some(path) = field.strip_prefix(b"worktree ") {
            paths.push(path_from_bytes(path.to_vec())?);
        }
    }
    Ok(paths)
}

fn has_active_markers(data_directory: &Path) -> bool {
    let mut entries = match fs::read_dir(data_directory) {
        Ok(entries) => entries,
        Err(_) => return true,
    };
    entries.any(|entry| match entry {
        Ok(entry) => entry
            .file_name()
            .to_string_lossy()
            .starts_with(ACTIVE_PREFIX),
        Err(_) => true,
    })
}

fn quarantine_path(cache_root: &Path, key: &str) -> Result<PathBuf, String> {
    for _ in 0..4 {
        let candidate = cache_root.join(format!(
            "{QUARANTINE_PREFIX}{key}-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        if !candidate.exists() {
            return Ok(candidate);
        }
    }
    Err("Cannot select a private storage quarantine path.".into())
}

fn remove_quarantine(path: &Path, key: &str) {
    let identity = match read_owner(path) {
        Ok(identity) => identity,
        Err(_) => {
            report_pending(path, "quarantine-owner-unverifiable");
            return;
        }
    };
    let expected = match identity_data_directory(
        path.parent().and_then(Path::parent).unwrap_or(path),
        &identity,
    ) {
        Ok(expected) => expected,
        Err(_) => {
            report_pending(path, "quarantine-owner-unverifiable");
            return;
        }
    };
    if cache_key(&expected)
        .map(|value| value != key)
        .unwrap_or(true)
    {
        report_pending(path, "quarantine-owner-key-mismatch");
        return;
    }
    match fs::remove_dir_all(path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(_) => report_pending(path, "quarantine-removal-failed"),
    }
    let _ = key;
}

fn report_pending(path: &Path, reason: &str) {
    let key = cache_key(path).unwrap_or_else(|_| "unknown".into());
    crate::diagnostics::record(
        "worktree_storage_cleanup_pending",
        json!({"cacheKey":key,"reason":reason}),
    );
}

fn report_selected(path: &Path, reason: &str) {
    let key = cache_key(path).unwrap_or_else(|_| "unknown".into());
    crate::diagnostics::record(
        "worktree_storage_cleanup_pending",
        json!({
            "cacheKey": key,
            "selectedPath": path.to_string_lossy(),
            "reason": reason,
            "message": "Private agent data was retained; no data was deleted. Retry after Git can verify the same worktree identity."
        }),
    );
}

fn lock_path(cache_directory: &Path, kind: &str, key_path: &Path) -> Result<PathBuf, String> {
    let root = cache_directory.join("terminal-worktree-locks");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    Ok(root.join(format!("{kind}-{}.lock", cache_key(key_path)?)))
}

fn cache_key(path: &Path) -> Result<String, String> {
    let bytes = path_bytes(path);
    Ok(Sha256::digest(bytes)
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn path_bytes(path: &Path) -> Vec<u8> {
    let path = path.as_os_str();
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_bytes().to_vec()
    };
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt;
        path.encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    #[cfg(not(any(unix, windows)))]
    let bytes = path.to_string_lossy().as_bytes().to_vec();
    bytes
}

fn valid_cache_key(value: &str) -> bool {
    value.len() == 64 && value.bytes().all(|byte| byte.is_ascii_hexdigit())
}

fn encode_path(path: &Path) -> String {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    #[cfg(not(any(unix, windows)))]
    let bytes = path.to_string_lossy().as_bytes().to_vec();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_path(value: &str) -> Result<PathBuf, String> {
    if !value.len().is_multiple_of(2) || !value.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Invalid encoded path.".into());
    }
    let (pairs, _) = value.as_bytes().as_chunks::<2>();
    let bytes = pairs
        .iter()
        .map(|pair| {
            ((pair[0] as char).to_digit(16).unwrap_or_default() as u8) << 4
                | (pair[1] as char).to_digit(16).unwrap_or_default() as u8
        })
        .collect::<Vec<_>>();
    path_from_bytes(bytes)
}

fn lexical_absolute(path: &Path) -> PathBuf {
    let mut result = PathBuf::new();
    for component in path.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                result.pop();
            }
            other => result.push(other.as_os_str()),
        }
    }
    result
}

struct FileLock {
    file: File,
}

impl FileLock {
    fn acquire(path: &Path, exclusive: bool) -> Result<Self, String> {
        Self::acquire_mode(path, exclusive, false)
    }

    fn acquire_mode(path: &Path, exclusive: bool, nonblocking: bool) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|error| error.to_string())?;
        lock_file(&file, exclusive, nonblocking).map_err(|error| error.to_string())?;
        Ok(Self { file })
    }

    fn try_acquire(path: &Path, exclusive: bool) -> Result<Self, String> {
        Self::acquire_mode(path, exclusive, true)
    }

    fn unlock(&self) -> Result<(), String> {
        unlock_file(&self.file).map_err(|error| error.to_string())
    }
}

#[cfg(unix)]
fn lock_file(file: &File, exclusive: bool, nonblocking: bool) -> std::io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let mut flags = if exclusive {
        nix::libc::LOCK_EX
    } else {
        nix::libc::LOCK_SH
    };
    if nonblocking {
        flags |= nix::libc::LOCK_NB;
    }
    let result = unsafe { nix::libc::flock(file.as_raw_fd(), flags) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(unix)]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::unix::io::AsRawFd;
    let result = unsafe { nix::libc::flock(file.as_raw_fd(), nix::libc::LOCK_UN) };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn lock_file(file: &File, exclusive: bool, nonblocking: bool) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        LockFileEx, LOCKFILE_EXCLUSIVE_LOCK, LOCKFILE_FAIL_IMMEDIATELY,
    };
    use windows_sys::Win32::System::IO::OVERLAPPED;
    let mut overlapped = OVERLAPPED::default();
    let mut flags = 0;
    if exclusive {
        flags |= LOCKFILE_EXCLUSIVE_LOCK;
    }
    if nonblocking {
        flags |= LOCKFILE_FAIL_IMMEDIATELY;
    }
    let result = unsafe {
        LockFileEx(
            file.as_raw_handle() as _,
            flags,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn unlock_file(file: &File) -> std::io::Result<()> {
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::UnlockFileEx;
    use windows_sys::Win32::System::IO::OVERLAPPED;
    let mut overlapped = OVERLAPPED::default();
    let result = unsafe {
        UnlockFileEx(
            file.as_raw_handle() as _,
            0,
            u32::MAX,
            u32::MAX,
            &mut overlapped,
        )
    };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(any(unix, windows)))]
fn lock_file(_file: &File, _exclusive: bool, _nonblocking: bool) -> std::io::Result<()> {
    Err(std::io::Error::other(
        "Cross-process storage locking is unavailable.",
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    struct GitFixture {
        root: PathBuf,
        repository: PathBuf,
        first: PathBuf,
        second: PathBuf,
        cache: PathBuf,
    }

    impl GitFixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("sail-worktree-storage-{}", uuid::Uuid::new_v4()));
            let repository = root.join("repository");
            let first = root.join("worktree-first");
            let second = root.join("worktree-second");
            let cache = root.join("cache");
            fs::create_dir_all(&repository).unwrap();
            Self::git(&repository, &["init", "--quiet"]);
            Self::git(
                &repository,
                &["config", "user.email", "sail-test@example.invalid"],
            );
            Self::git(&repository, &["config", "user.name", "Sail test"]);
            fs::write(repository.join("tracked"), "fixture").unwrap();
            Self::git(&repository, &["add", "tracked"]);
            Self::git(&repository, &["commit", "--quiet", "-m", "fixture"]);
            Self::git(
                &repository,
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "--detach",
                    first.to_str().unwrap(),
                    "HEAD",
                ],
            );
            Self::git(
                &repository,
                &[
                    "worktree",
                    "add",
                    "--quiet",
                    "--detach",
                    second.to_str().unwrap(),
                    "HEAD",
                ],
            );
            Self {
                root,
                repository,
                first,
                second,
                cache,
            }
        }

        fn git(repository: &Path, args: &[&str]) -> Vec<u8> {
            let output = std::process::Command::new("git")
                .arg("-C")
                .arg(repository)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {:?}: {}",
                args,
                String::from_utf8_lossy(&output.stderr)
            );
            output.stdout
        }

        fn remove(&self, worktree: &Path) {
            Self::git(
                &self.repository,
                &["worktree", "remove", "--force", worktree.to_str().unwrap()],
            );
        }
    }

    impl Drop for GitFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    #[test]
    fn lexical_identity_does_not_follow_a_reused_path() {
        let root = Path::new("/tmp/worktree/../worktree");
        assert_eq!(lexical_absolute(root), Path::new("/tmp/worktree"));
    }

    #[test]
    fn externally_removed_worktree_storage_is_reconciled_after_clean_release() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.mark_started();
        lease.release_clean().unwrap();
        drop(lease);
        fixture.remove(&fixture.first);

        let pending = retry_cleanup(&fixture.cache);

        assert!(!directory.exists());
        assert!(pending.is_empty(), "remaining: {pending:?}");
    }

    #[test]
    fn retry_status_reports_and_retains_legacy_storage_without_identity() {
        let fixture = GitFixture::new();
        let directory =
            legacy_data_directory(&fixture.cache, &stable_worktree_identity(&fixture.first))
                .unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join("worktree-owner-v1"), "legacy owner").unwrap();

        let pending = retry_cleanup(&fixture.cache);

        assert!(directory.exists());
        assert!(pending.iter().any(|item| {
            item.cache_key == directory.file_name().unwrap().to_string_lossy()
                && item.reason == "owner-metadata-missing"
        }));
    }

    #[test]
    fn explicitly_removed_nested_worktrees_delete_only_their_v2_storage() {
        let fixture = GitFixture::new();
        let nested = fixture.first.join("nested-worktree");
        GitFixture::git(
            &fixture.repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                nested.to_str().unwrap(),
                "HEAD",
            ],
        );
        let (outer_data, outer_lease) = register(&fixture.cache, &fixture.first).unwrap();
        let (nested_data, nested_lease) = register(&fixture.cache, &nested).unwrap();
        outer_lease.mark_started();
        outer_lease.release_clean().unwrap();
        nested_lease.mark_started();
        nested_lease.release_clean().unwrap();
        fs::write(outer_data.join("payload"), "outer").unwrap();
        fs::write(nested_data.join("payload"), "nested").unwrap();
        let directories = discover_data_directories(&fixture.cache, &fixture.first);
        assert_eq!(directories.len(), 2);

        GitFixture::git(
            &fixture.repository,
            &["worktree", "remove", "--force", nested.to_str().unwrap()],
        );
        fixture.remove(&fixture.first);
        remove_after_worktree_removal(&fixture.cache, &directories).unwrap();

        assert!(!outer_data.exists());
        assert!(!nested_data.exists());
    }

    #[test]
    fn active_or_registered_worktree_data_is_retained_for_retry() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.mark_started();
        drop(lease);
        fixture.remove(&fixture.first);

        reconcile(&fixture.cache);
        assert!(directory.exists());
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "unclean-active-use"));

        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "unclean-active-use"));
    }

    #[test]
    fn stale_git_registration_prevents_cleanup() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        drop(lease);
        fs::remove_dir_all(&fixture.first).unwrap();

        reconcile(&fixture.cache);

        assert!(directory.exists());
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "git-worktree-registration-still-present"));
    }

    #[test]
    fn reused_worktree_path_gets_a_separate_generation_and_keeps_old_data() {
        let fixture = GitFixture::new();
        let (old_directory, old_lease) = register(&fixture.cache, &fixture.first).unwrap();
        old_lease.release_clean().unwrap();
        fixture.remove(&fixture.first);
        GitFixture::git(
            &fixture.repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                fixture.first.to_str().unwrap(),
                "HEAD",
            ],
        );
        let (new_directory, new_lease) = register(&fixture.cache, &fixture.first).unwrap();

        assert_ne!(old_directory, new_directory);
        reconcile(&fixture.cache);
        assert!(old_directory.exists());
        assert!(new_directory.exists());
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.cache_key == old_directory.file_name().unwrap().to_string_lossy()));
        new_lease.release_clean().unwrap();
    }

    #[test]
    fn unrelated_sibling_storage_survives_selected_worktree_cleanup() {
        let fixture = GitFixture::new();
        let (first_directory, first_lease) = register(&fixture.cache, &fixture.first).unwrap();
        let (second_directory, second_lease) = register(&fixture.cache, &fixture.second).unwrap();
        first_lease.release_clean().unwrap();
        drop(first_lease);
        fixture.remove(&fixture.first);

        reconcile(&fixture.cache);

        assert!(!first_directory.exists());
        assert!(second_directory.exists());
        second_lease.release_clean().unwrap();
    }

    #[test]
    fn missing_common_repository_identity_retains_private_storage() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        drop(lease);
        fixture.remove(&fixture.first);
        fs::remove_dir_all(fixture.repository.join(".git")).unwrap();

        reconcile(&fixture.cache);

        assert!(directory.exists());
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "git-common-dir-missing-or-unreadable"));
    }

    #[test]
    fn interrupted_quarantine_cleanup_is_retryable() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        drop(lease);
        fixture.remove(&fixture.first);
        let key = cache_key(&directory).unwrap();
        let quarantine = directory.parent().unwrap().join(format!(
            "{QUARANTINE_PREFIX}{key}-{}.tmp",
            uuid::Uuid::new_v4()
        ));
        fs::rename(&directory, &quarantine).unwrap();

        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.cache_key.starts_with(QUARANTINE_PREFIX)));
        reconcile(&fixture.cache);
        assert!(!quarantine.exists());
    }

    #[test]
    fn legacy_path_hash_and_unverified_plain_folder_storage_remain_usable() {
        let fixture = GitFixture::new();
        let legacy =
            legacy_data_directory(&fixture.cache, &stable_worktree_identity(&fixture.first))
                .unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(
            legacy.join("worktree-owner-v1"),
            "sail-terminal-worktrees-v1\nlegacy",
        )
        .unwrap();
        let (current, lease) = register(&fixture.cache, &fixture.first).unwrap();
        assert_ne!(legacy, current);
        assert!(legacy.exists());
        lease.release_clean().unwrap();

        let plain = fixture.root.join("plain-folder");
        fs::create_dir_all(&plain).unwrap();
        let (plain_data, plain_lease) = register(&fixture.cache, &plain).unwrap();
        assert_eq!(
            plain_data,
            legacy_data_directory(&fixture.cache, &stable_worktree_identity(&plain)).unwrap()
        );
        plain_lease.release_clean().unwrap();
    }
}
