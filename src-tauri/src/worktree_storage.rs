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
const EXPLICIT_CLEANUP_MARKER: &str = ".sail-explicit-cleanup-pending-v1";
const EXPLICIT_CLEANUP_HEADER: &str = "sail-explicit-worktree-storage-cleanup-v1\n";
const DURABLE_CLEANUP_HEADER: &str = "sail-explicit-worktree-storage-owner-v3\n";
const TEMP_ROOT: &str = "turn-temp";
const TEMP_OWNER_FILE: &str = "sail-temp-owner-v2";
const TEMP_OWNER_HEADER: &str = "sail-temp-owner-v3";
const PREVIOUS_TEMP_OWNER_HEADER: &str = "sail-temp-owner-v2";
const LEGACY_TEMP_OWNER_FILE: &str = "sail-temp-owner-v1";
const LEGACY_TEMP_OWNER_HEADER: &str = "sail-temp-owner-v1";
const TEMP_PROCESS_UNSTARTED: &str = "sail-temp-process-state-v1\nunstarted\n";
const TEMP_PROCESS_EXPOSED: &str = "sail-temp-process-state-v1\nexposed\n";
const TEMP_PENDING_FILE: &str = "sail-temp-cleanup-pending-v1";
const PLAIN_OWNER_FILE: &str = "sail-plain-folder-owner-v1";
const PLAIN_OWNER_HEADER: &str = "sail-plain-folder-owner-v1";

fn write_temp_pending(directory: &Path, reason: &str) -> std::io::Result<()> {
    let staging = directory.join(format!(".{TEMP_PENDING_FILE}-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        file.write_all(reason.as_bytes())?;
        file.sync_all()?;
        fs::rename(&staging, directory.join(TEMP_PENDING_FILE))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&staging);
    }
    result
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct WorktreeIdentity {
    root: PathBuf,
    common_dir: PathBuf,
    admin_dir: PathBuf,
    generation: String,
    repository_generation: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct DurableCleanupIdentity {
    owner: WorktreeIdentity,
    directory_id: String,
}

#[cfg(unix)]
fn directory_identity(path: &Path) -> Result<String, String> {
    use std::os::unix::fs::MetadataExt;
    let metadata = path
        .symlink_metadata()
        .map_err(|error| format!("Cannot inspect selected storage directory identity: {error}"))?;
    if !metadata.is_dir() {
        return Err("Selected storage is not a directory.".into());
    }
    let created = metadata
        .created()
        .map_err(|error| format!("Cannot verify selected storage creation time: {error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("Invalid selected storage creation time: {error}"))?;
    Ok(format!(
        "unix:{}:{}:{}",
        metadata.dev(),
        metadata.ino(),
        created.as_nanos()
    ))
}

#[cfg(windows)]
fn directory_identity(path: &Path) -> Result<String, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::AsRawHandle;
    use windows_sys::Win32::Storage::FileSystem::{
        GetFileInformationByHandle, BY_HANDLE_FILE_INFORMATION, FILE_FLAG_BACKUP_SEMANTICS,
    };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
        .open(path)
        .map_err(|error| format!("Cannot open selected storage directory identity: {error}"))?;
    let created = file
        .metadata()
        .and_then(|metadata| metadata.created())
        .map_err(|error| format!("Cannot verify selected storage creation time: {error}"))?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| format!("Invalid selected storage creation time: {error}"))?;
    let mut info = BY_HANDLE_FILE_INFORMATION::default();
    if unsafe { GetFileInformationByHandle(file.as_raw_handle() as _, &mut info) } == 0 {
        return Err(format!(
            "Cannot inspect selected storage directory identity: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(format!(
        "windows:{}:{}:{}:{}",
        info.dwVolumeSerialNumber,
        info.nFileIndexHigh,
        info.nFileIndexLow,
        created.as_nanos()
    ))
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct CleanupPending {
    pub(crate) cache_key: String,
    pub(crate) reason: String,
    pub(crate) size_bytes: Option<u64>,
    pub(crate) cleanup_token: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) path: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub(crate) owner_path: Option<String>,
}

fn pending_size(path: &Path) -> Option<u64> {
    let mut total = 0u64;
    let mut remaining = vec![path.to_path_buf()];
    while let Some(path) = remaining.pop() {
        let metadata = fs::symlink_metadata(&path).ok()?;
        if metadata.is_dir() {
            for entry in fs::read_dir(path).ok()? {
                remaining.push(entry.ok()?.path());
            }
        } else {
            total = total.saturating_add(metadata.len());
        }
    }
    Some(total)
}

fn pending_item(key: String, reason: &str, path: Option<&Path>, can_clean: bool) -> CleanupPending {
    CleanupPending {
        cache_key: key,
        reason: reason.into(),
        size_bytes: path.and_then(pending_size),
        cleanup_token: if can_clean {
            path.and_then(|path| cache_key(path).ok())
        } else {
            None
        },
        path: None,
        owner_path: None,
    }
}

pub(crate) struct WorktreeDataLease {
    directory: PathBuf,
    active_marker: PathBuf,
    started: AtomicBool,
    released: AtomicBool,
    _lease_lock: FileLock,
    temp: TempLease,
}

struct TempLease {
    directory: PathBuf,
    process_state_file: PathBuf,
    released: AtomicBool,
    started: AtomicBool,
    _lock: FileLock,
}

struct TempOwner {
    pid: u32,
    started_at: Option<u64>,
    protocol_v3: bool,
}

fn process_state_path(cache_directory: &Path, temp_directory: &Path) -> Result<PathBuf, String> {
    let root = cache_directory.join("terminal-worktree-locks");
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let data_directory = temp_directory
        .parent()
        .and_then(Path::parent)
        .ok_or("Private temporary path has no storage owner.")?;
    Ok(root.join(format!(
        "temp-state-{}-{}.state",
        cache_key(data_directory)?,
        cache_key(temp_directory)?
    )))
}

fn process_state_paths(cache_directory: &Path, data_key: &str) -> Result<Vec<PathBuf>, String> {
    let root = cache_directory.join("terminal-worktree-locks");
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let prefix = format!("temp-state-{data_key}-");
    let mut paths = Vec::new();
    for entry in entries {
        let entry = entry.map_err(|error| error.to_string())?;
        if entry
            .file_name()
            .to_str()
            .is_some_and(|name| name.starts_with(&prefix) && name.ends_with(".state"))
        {
            paths.push(entry.path());
        }
    }
    Ok(paths)
}

fn exposed_process_states(cache_directory: &Path, data_key: &str) -> Result<Vec<PathBuf>, String> {
    Ok(process_state_paths(cache_directory, data_key)?
        .into_iter()
        .filter(|path| !unstarted_process_state(path))
        .collect())
}

fn unstarted_process_state(path: &Path) -> bool {
    fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_file())
        && fs::read_to_string(path).is_ok_and(|state| state == TEMP_PROCESS_UNSTARTED)
}

fn create_process_state(path: &Path) -> Result<(), String> {
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    let result = file
        .write_all(TEMP_PROCESS_UNSTARTED.as_bytes())
        .and_then(|_| file.sync_all());
    if let Err(error) = result {
        drop(file);
        let _ = fs::remove_file(path);
        return Err(error.to_string());
    }
    Ok(())
}

fn write_process_state(path: &Path, state: &str) -> Result<(), String> {
    if !fs::symlink_metadata(path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Private temporary process state is not a regular file.".into());
    }
    let mut file = OpenOptions::new()
        .write(true)
        .truncate(true)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.write_all(state.as_bytes())
        .and_then(|_| file.sync_all())
        .map_err(|error| error.to_string())
}

impl TempLease {
    fn exposed_to_process(&self) -> bool {
        !unstarted_process_state(&self.process_state_file)
    }

    fn prepare_process_start(&self) -> Result<(), String> {
        self.verify_root()?;
        if self.exposed_to_process() {
            return Err("Private temporary process state is not unstarted.".into());
        }
        write_process_state(&self.process_state_file, TEMP_PROCESS_EXPOSED)
    }

    fn cancel_process_start(&self) -> Result<(), String> {
        self.verify_root()?;
        if self.started.load(Ordering::Acquire) {
            return Err("Cannot reset temporary state after a process started.".into());
        }
        write_process_state(&self.process_state_file, TEMP_PROCESS_UNSTARTED).map_err(|error| {
            self.mark_pending("turn-temp-process-start-reset-failed");
            format!("Cannot reset private temporary process start: {error}")
        })
    }

    fn verify_root(&self) -> Result<(), String> {
        let root = self
            .directory
            .parent()
            .ok_or("Private temporary root is missing.")?;
        if fs::symlink_metadata(root)
            .map_err(|error| error.to_string())?
            .is_dir()
            && fs::symlink_metadata(&self.directory)
                .map_err(|error| error.to_string())?
                .is_dir()
        {
            Ok(())
        } else {
            Err("Private temporary root is not a directory.".into())
        }
    }

    fn mark_pending(&self, reason: &str) {
        if self.verify_root().is_ok() {
            let _ = write_temp_pending(&self.directory, reason);
        }
        report_pending(&self.directory, reason);
    }

    fn release_clean(&self) -> Result<(), String> {
        if self.released.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let removal = if self.exposed_to_process() {
            if let Ok(reason) = fs::read_to_string(self.directory.join(TEMP_PENDING_FILE)) {
                report_pending(&self.directory, &reason);
            } else {
                self.mark_pending("turn-temp-owner-unverified");
            }
            Ok(())
        } else {
            self.verify_root().and_then(|_| {
                if temp_directory_in_use(&self.directory) {
                    return Err("Private temporary data is still used by a process.".into());
                }
                fs::remove_file(&self.process_state_file).map_err(|error| error.to_string())?;
                fs::remove_dir_all(&self.directory).map_err(|error| error.to_string())
            })
        };
        let removal = removal.map_err(|error| {
            self.mark_pending("turn-temp-removal-failed");
            format!("Cannot remove private temporary data: {error}")
        });
        let unlock = self._lock.unlock();
        let result = removal.and(unlock);
        if result.is_err() {
            self.released.store(false, Ordering::Release);
        }
        result
    }

    fn clear_contents(&self) -> Result<(), String> {
        let result = self.clear_contents_inner();
        if result.is_err() {
            self.mark_pending("turn-temp-removal-failed");
        } else if let Err(error) = fs::remove_file(self.directory.join(TEMP_PENDING_FILE)) {
            if error.kind() != std::io::ErrorKind::NotFound {
                self.mark_pending("turn-temp-pending-marker-remove-failed");
                return Err(error.to_string());
            }
        }
        result
    }

    fn clear_contents_inner(&self) -> Result<(), String> {
        self.verify_root()?;
        for entry in fs::read_dir(&self.directory).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            if entry.file_name() == TEMP_OWNER_FILE
                || entry.file_name() == LEGACY_TEMP_OWNER_FILE
                || entry.file_name() == TEMP_PENDING_FILE
            {
                continue;
            }
            let path = entry.path();
            let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
            let result = if metadata.is_dir() {
                fs::remove_dir_all(&path)
            } else {
                fs::remove_file(&path)
            };
            result.map_err(|error| {
                format!(
                    "Cannot remove private temporary data {}: {error}",
                    path.display()
                )
            })?;
        }
        Ok(())
    }
}

impl Drop for TempLease {
    fn drop(&mut self) {
        if !self.started.load(Ordering::Acquire) && !self.released.load(Ordering::Acquire) {
            let _ = self.release_clean();
        }
    }
}

impl WorktreeDataLease {
    pub(crate) fn prepare_process_start(&self) -> Result<(), String> {
        self.temp.prepare_process_start()
    }

    pub(crate) fn cancel_process_start(&self) -> Result<(), String> {
        self.temp.cancel_process_start()
    }

    pub(crate) fn mark_started(&self) {
        self.temp.started.store(true, Ordering::Release);
        self.started.store(true, Ordering::Release);
    }

    pub(crate) fn temp_directory(&self) -> &Path {
        &self.temp.directory
    }

    pub(crate) fn mark_temp_pending(&self, reason: &str) {
        self.temp.mark_pending(reason);
    }

    pub(crate) fn clear_turn_temp(&self) -> Result<(), String> {
        if self.temp.exposed_to_process() {
            self.temp.mark_pending("turn-temp-owner-unverified");
            return Ok(());
        }
        self.temp.clear_contents()?;
        fs::create_dir_all(self.temp.directory.join("go-tmp")).map_err(|error| {
            self.temp.mark_pending("turn-temp-prepare-failed");
            format!("Cannot prepare private Go temporary data: {error}")
        })
    }

    pub(crate) fn release_clean(&self) -> Result<(), String> {
        if self.released.swap(true, Ordering::AcqRel) {
            return Ok(());
        }
        let temp_result = self.temp.release_clean();
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
        if temp_result.is_err() {
            self.released.store(false, Ordering::Release);
        }
        temp_result
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
    let temp = create_temp_lease(cache_directory, &data_directory)?;
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
        temp,
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
    let _mutation = FileLock::acquire(
        &lock_path(cache_directory, "mutation", &data_directory)?,
        true,
    )?;
    verify_or_publish_plain_owner(cache_directory, &data_directory, &root)?;
    let lease_path = lock_path(cache_directory, "lease", &data_directory)?;
    let lease_lock = FileLock::acquire(&lease_path, false)?;
    let temp = create_temp_lease(cache_directory, &data_directory)?;
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
        temp,
    });
    Ok((lease.directory.clone(), lease))
}

fn create_temp_lease(cache_directory: &Path, data_directory: &Path) -> Result<TempLease, String> {
    let root = data_directory.join(TEMP_ROOT);
    match fs::create_dir(&root) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error.to_string()),
    }
    if !fs::symlink_metadata(&root)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("Private temporary root is not a directory.".into());
    }
    let name = format!("run-{}", uuid::Uuid::new_v4());
    let directory = root.join(&name);
    let staging = root.join(format!(".{name}.tmp"));
    let process_state_file = process_state_path(cache_directory, &directory)?;
    let lock = FileLock::acquire(&lock_path(cache_directory, "temp", &directory)?, true)?;
    fs::create_dir(&staging).map_err(|error| error.to_string())?;
    let mut state_created = false;
    let result = (|| {
        let pid = std::process::id();
        let started_at = sysinfo::System::new_all()
            .process(sysinfo::Pid::from_u32(pid))
            .ok_or("Cannot verify the private temporary owner process.")?
            .start_time();
        let contents = format!(
            "{TEMP_OWNER_HEADER}\n{}\n{}\n{}\n",
            cache_key(data_directory)?,
            pid,
            started_at
        );
        let mut owner = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(staging.join(TEMP_OWNER_FILE))
            .map_err(|error| error.to_string())?;
        owner
            .write_all(contents.as_bytes())
            .and_then(|_| owner.sync_all())
            .map_err(|error| error.to_string())?;
        drop(owner);
        create_process_state(&process_state_file)?;
        state_created = true;
        fs::rename(&staging, &directory).map_err(|error| error.to_string())
    })();
    if let Err(error) = result {
        let _ = fs::remove_dir_all(&staging);
        if state_created {
            let _ = fs::remove_file(&process_state_file);
        }
        return Err(error);
    }
    Ok(TempLease {
        directory,
        process_state_file,
        released: AtomicBool::new(false),
        started: AtomicBool::new(false),
        _lock: lock,
    })
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

fn read_plain_owner(
    cache_directory: &Path,
    data_directory: &Path,
) -> Result<PathBuf, &'static str> {
    if !fs::symlink_metadata(data_directory)
        .map_err(|_| "plain-folder-owner-unverifiable")?
        .is_dir()
    {
        return Err("plain-folder-owner-unverifiable");
    }
    let metadata = fs::symlink_metadata(data_directory.join(PLAIN_OWNER_FILE))
        .map_err(|_| "plain-folder-owner-missing")?;
    if !metadata.is_file() {
        return Err("plain-folder-owner-unverifiable");
    }
    let contents = fs::read_to_string(data_directory.join(PLAIN_OWNER_FILE))
        .map_err(|_| "plain-folder-owner-unverifiable")?;
    let mut lines = contents.lines();
    if lines.next() != Some(PLAIN_OWNER_HEADER) {
        return Err("plain-folder-owner-unverifiable");
    }
    let root = decode_path(lines.next().ok_or("plain-folder-owner-unverifiable")?)
        .map_err(|_| "plain-folder-owner-unverifiable")?;
    if !root.is_absolute()
        || lines.next().is_some()
        || legacy_data_directory(cache_directory, &root)
            .ok()
            .as_deref()
            != Some(data_directory)
    {
        return Err("plain-folder-owner-unverifiable");
    }
    Ok(root)
}

fn verify_or_publish_plain_owner(
    cache_directory: &Path,
    data_directory: &Path,
    root: &Path,
) -> Result<(), String> {
    if !fs::symlink_metadata(data_directory)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("Plain-folder storage root is not a directory.".into());
    }
    match read_plain_owner(cache_directory, data_directory) {
        Ok(registered) if registered == root => return Ok(()),
        Ok(_) => return Err("Plain-folder storage owner does not match.".into()),
        Err(_) => {}
    }
    match fs::symlink_metadata(data_directory.join(TEMP_ROOT)) {
        Ok(_) => {
            return Err("Existing plain-folder temporary data has no verifiable owner.".into());
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let owner = data_directory.join(PLAIN_OWNER_FILE);
    match fs::symlink_metadata(&owner) {
        Ok(metadata) if !metadata.is_file() => {
            return Err("Plain-folder storage owner is not a regular file.".into());
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    let staging = data_directory.join(format!(".{PLAIN_OWNER_FILE}-{}.tmp", uuid::Uuid::new_v4()));
    let publication = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&staging)?;
        file.write_all(format!("{PLAIN_OWNER_HEADER}\n{}\n", encode_path(root)).as_bytes())?;
        file.sync_all()?;
        drop(file);
        if owner.exists() {
            fs::remove_file(&owner)?;
        }
        fs::rename(&staging, &owner)
    })();
    if publication.is_err() {
        let _ = fs::remove_file(&staging);
    }
    publication.map_err(|error| error.to_string())
}

fn has_git_metadata(path: &Path) -> bool {
    let mut current = Some(path);
    while let Some(directory) = current {
        match fs::symlink_metadata(directory.join(".git")) {
            Ok(_) => return true,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => return true,
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
            if let Some((key, suffix)) = key.split_once('-').filter(|(key, _)| valid_cache_key(key))
            {
                if suffix
                    .strip_suffix(".tmp")
                    .is_some_and(|uuid| uuid::Uuid::parse_str(uuid).is_ok())
                {
                    match has_durable_cleanup_marker_by_key(cache_directory, key) {
                        Ok(true) => report_pending(&entry.path(), "explicit-cleanup-required"),
                        Ok(false) => match has_explicit_cleanup_marker(&entry.path()) {
                            Ok(true) => report_pending(&entry.path(), "explicit-cleanup-required"),
                            Ok(false) => {
                                let _ = remove_quarantine(&entry.path(), key);
                            }
                            Err(_) => {
                                report_pending(
                                    &entry.path(),
                                    "explicit-cleanup-marker-unverifiable",
                                );
                            }
                        },
                        Err(_) => {
                            report_pending(&entry.path(), "explicit-cleanup-marker-unverifiable");
                        }
                    }
                }
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
                if read_plain_owner(cache_directory, &data_directory).is_ok() {
                    reclaim_verified_unstarted_temp(cache_directory, &data_directory);
                    for item in temp_directory_status(cache_directory, &data_directory) {
                        report_pending(&data_directory, &item.reason);
                    }
                } else {
                    report_pending(&data_directory, reason);
                }
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
        reclaim_verified_unstarted_temp(cache_directory, &data_directory);
        for item in temp_directory_status(cache_directory, &data_directory) {
            report_pending(&data_directory, &item.reason);
        }
        // An active sibling shares the repository lock but has a separate lease. Check
        // its lease first so skipping that sibling cannot hold the repository lock
        // while a removed worktree from the same repository is reconciled.
        let lease_path = match lock_path(cache_directory, "lease", &data_directory) {
            Ok(path) => path,
            Err(_) => {
                report_pending(&data_directory, "active-use");
                continue;
            }
        };
        let lease = match FileLock::try_acquire(&lease_path, true) {
            Ok(lock) => lock,
            Err(_error) => {
                #[cfg(test)]
                eprintln!("reconcile lease lock: {_error}");
                report_pending(&data_directory, "active-use");
                continue;
            }
        };
        let repo_lock_path = match lock_path(cache_directory, "repo", &identity.common_dir) {
            Ok(path) => path,
            Err(_) => {
                report_pending(&data_directory, "repository-lock-unavailable");
                continue;
            }
        };
        let repo_lock = match FileLock::try_acquire(&repo_lock_path, true) {
            Ok(lock) => lock,
            Err(_error) => {
                #[cfg(test)]
                eprintln!("reconcile repository lock: {_error}");
                report_pending(&data_directory, "active-use");
                continue;
            }
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
            Err(_error) => {
                #[cfg(test)]
                eprintln!("reconcile mutation lock: {_error}");
                report_pending(&data_directory, "active-use");
                continue;
            }
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
        match has_durable_cleanup_marker(cache_directory, &data_directory) {
            Ok(true) => {
                report_pending(&data_directory, "explicit-cleanup-required");
                continue;
            }
            Ok(false) => match has_explicit_cleanup_marker(&data_directory) {
                Ok(true) => {
                    report_pending(&data_directory, "explicit-cleanup-required");
                    continue;
                }
                Ok(false) => {}
                Err(_) => {
                    report_pending(&data_directory, "explicit-cleanup-marker-unverifiable");
                    continue;
                }
            },
            Err(_) => {
                report_pending(&data_directory, "explicit-cleanup-marker-unverifiable");
                continue;
            }
        }
        let pending_temp = temp_directory_status(cache_directory, &data_directory);
        if !pending_temp.is_empty() {
            for item in pending_temp {
                report_pending(&data_directory, &item.reason);
            }
            continue;
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
        let _ = remove_quarantine(&quarantine, &quarantine_key);
    }
}

pub(crate) fn cleanup_status(cache_directory: &Path) -> Vec<CleanupPending> {
    let mut pending = Vec::new();
    let cache_root = cache_directory.join("terminal-worktrees");
    let entries = match fs::read_dir(&cache_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return pending,
        Err(_) => {
            return vec![pending_item(
                "unknown".into(),
                "storage-scan-failed",
                None,
                false,
            )]
        }
    };
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                pending.push(pending_item(
                    "unknown".into(),
                    "storage-entry-unreadable",
                    None,
                    false,
                ));
                continue;
            }
        };
        let name = entry.file_name().to_string_lossy().into_owned();
        let directory = entry.path();
        pending.extend(temp_directory_status(cache_directory, &directory));
        let reason = if name.starts_with(QUARANTINE_PREFIX) {
            let durable = name
                .strip_prefix(QUARANTINE_PREFIX)
                .and_then(|name| name.split_once('-'))
                .filter(|(key, _)| valid_cache_key(key))
                .map(|(key, _)| has_durable_cleanup_marker_by_key(cache_directory, key));
            match durable.transpose().and_then(|durable| {
                if durable == Some(true) {
                    Ok(true)
                } else {
                    has_explicit_cleanup_marker(&directory)
                }
            }) {
                Ok(true) => Some("explicit-cleanup-required"),
                Ok(false) => Some("cleanup-interrupted"),
                Err(_) => Some("explicit-cleanup-marker-unverifiable"),
            }
        } else if !valid_cache_key(&name) {
            None
        } else {
            match read_owner(&directory) {
                Err(reason) => {
                    if read_plain_owner(cache_directory, &directory).is_ok() {
                        match lock_path(cache_directory, "lease", &directory)
                            .and_then(|path| FileLock::try_acquire(&path, true))
                        {
                            Ok(_lease) if has_active_markers(&directory) => {
                                Some("unclean-active-use")
                            }
                            Ok(_lease) => None,
                            Err(_) => Some("active-use"),
                        }
                    } else {
                        Some(reason)
                    }
                }
                Ok(identity) => {
                    let lease = match lock_path(cache_directory, "lease", &directory) {
                        Ok(path) => {
                            let acquisition = FileLock::try_acquire(&path, true);
                            #[cfg(test)]
                            if let Err(error) = &acquisition {
                                eprintln!("cleanup_status lease lock {}: {error}", path.display());
                                #[cfg(unix)]
                                log_lock_holder(&path);
                            }
                            acquisition.ok()
                        }
                        Err(_error) => {
                            #[cfg(test)]
                            eprintln!(
                                "cleanup_status lease lock path for {}: {_error}",
                                directory.display()
                            );
                            None
                        }
                    };
                    if lease.is_none() {
                        Some("active-use")
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
                            Ok(true) => {
                                match has_durable_cleanup_marker(cache_directory, &directory)
                                    .and_then(|durable| {
                                        if durable {
                                            Ok(true)
                                        } else {
                                            has_explicit_cleanup_marker(&directory)
                                        }
                                    }) {
                                    Ok(true) => Some("explicit-cleanup-required"),
                                    Ok(false) => Some("stale-worktree-storage"),
                                    Err(_) => Some("explicit-cleanup-marker-unverifiable"),
                                }
                            }
                            Ok(false) => Some("git-worktree-registration-still-present"),
                            Err(reason) => Some(reason),
                        }
                    }
                }
            }
        };
        if let Some(reason) = reason {
            pending.push(pending_item(name, reason, Some(&directory), false));
        }
    }
    pending.sort_by(|left, right| left.cache_key.cmp(&right.cache_key));
    pending
}

pub(crate) fn retry_cleanup(cache_directory: &Path) -> Vec<CleanupPending> {
    reconcile(cache_directory);
    cleanup_status(cache_directory)
}

fn reclaim_verified_unstarted_temp(cache_directory: &Path, data_directory: &Path) {
    let Ok(mutation_path) = lock_path(cache_directory, "mutation", data_directory) else {
        return;
    };
    let Ok(_mutation) = FileLock::try_acquire(&mutation_path, true) else {
        return;
    };
    let root = data_directory.join(TEMP_ROOT);
    if !fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.is_dir()) {
        return;
    }
    let Ok(entries) = fs::read_dir(&root) else {
        return;
    };
    for entry in entries.flatten() {
        let directory = entry.path();
        let Some(name) = entry.file_name().to_str().map(str::to_owned) else {
            continue;
        };
        let Some(original_name) = original_run_name(&name) else {
            continue;
        };
        let lock_directory = root.join(original_name);
        let Ok(owner) = read_temp_owner(&directory, data_directory) else {
            continue;
        };
        if !owner.protocol_v3 || process_owner_alive(&owner) {
            continue;
        }
        let Ok(process_state_file) = process_state_path(cache_directory, &lock_directory) else {
            continue;
        };
        if !unstarted_process_state(&process_state_file) {
            continue;
        }
        let Ok(lock_path) = lock_path(cache_directory, "temp", &lock_directory) else {
            continue;
        };
        let Ok(_lock) = FileLock::try_acquire(&lock_path, true) else {
            continue;
        };
        if temp_directory_in_use(&directory) {
            continue;
        }
        if let Err(error) = fs::remove_file(&process_state_file) {
            let _ = write_temp_pending(&directory, "verified-temp-removal-failed");
            report_pending(
                &directory,
                &format!("verified-temp-removal-failed: {error}"),
            );
            continue;
        }
        if let Err(error) = fs::remove_dir_all(&directory) {
            let _ = write_temp_pending(&directory, "verified-temp-removal-failed");
            report_pending(
                &directory,
                &format!("verified-temp-removal-failed: {error}"),
            );
        }
    }
}

/// Remove one pending temporary directory after the user has checked that it is unused.
/// The token identifies a path already reported by cleanup_status; it is never a path
/// supplied by the frontend.
#[cfg(test)]
pub(crate) fn clean_pending_temp(
    cache_directory: &Path,
    token: &str,
) -> Result<Vec<CleanupPending>, String> {
    clean_pending_temp_inner(cache_directory, token, None, None)?;
    Ok(retry_cleanup(cache_directory))
}

pub(crate) fn clean_pending_temp_checked(
    cache_directory: &Path,
    token: &str,
    expected_path: &Path,
    expected_owner_path: &Path,
) -> Result<Vec<CleanupPending>, String> {
    clean_pending_temp_inner(
        cache_directory,
        token,
        None,
        Some((expected_path, expected_owner_path)),
    )?;
    Ok(retry_cleanup(cache_directory))
}

fn clean_pending_temp_inner(
    cache_directory: &Path,
    token: &str,
    selected_storage: Option<(&Path, &DurableCleanupIdentity)>,
    expected_view: Option<(&Path, &Path)>,
) -> Result<(), String> {
    if !valid_cache_key(token) {
        return Err("Invalid pending temporary data token.".into());
    }
    let (data_directory, target, lock_directory) = find_pending_temp(cache_directory, token)?;
    if selected_storage.is_some_and(|(expected, _)| data_directory != expected) {
        return Err("Pending temporary data belongs to another private storage directory.".into());
    }
    let _mutation = FileLock::try_acquire(
        &lock_path(cache_directory, "mutation", &data_directory)?,
        true,
    )
    .map_err(|_| "Private storage is changing; retry after it becomes idle.".to_string())?;
    let _lease =
        FileLock::try_acquire(&lock_path(cache_directory, "lease", &data_directory)?, true)
            .map_err(|_| "Private storage still has an active owner.".to_string())?;
    if !verified_data_owner(cache_directory, &data_directory) {
        return Err("Private storage ownership changed; refresh cleanup status.".into());
    }
    if let Some((expected_path, expected_owner_path)) = expected_view {
        let owner_path = read_owner(&data_directory)
            .ok()
            .filter(|identity| {
                identity_data_directory(cache_directory, identity)
                    .ok()
                    .as_deref()
                    == Some(data_directory.as_path())
            })
            .map(|identity| identity.root)
            .or_else(|| read_plain_owner(cache_directory, &data_directory).ok());
        if target != expected_path || owner_path.as_deref() != Some(expected_owner_path) {
            return Err(
                "Pending temporary data path or owner changed; refresh cleanup status.".into(),
            );
        }
    }
    if let Some((_, expected)) = selected_storage {
        if directory_identity(&data_directory).ok().as_deref() != Some(&expected.directory_id)
            || read_owner(&data_directory).ok().as_ref() != Some(&expected.owner)
            || !verify_selected_identity_removed(&expected.owner).map_err(str::to_string)?
        {
            return Err(
                "Selected private storage changed during temporary cleanup; its bytes were retained."
                    .into(),
            );
        }
    }
    if !temp_directory_status(cache_directory, &data_directory)
        .iter()
        .any(|item| item.cleanup_token.as_deref() == Some(token))
    {
        return Err("Temporary data is no longer pending; refresh cleanup status.".into());
    }
    if target == data_directory.join(TEMP_ROOT) {
        let states = process_state_paths(cache_directory, &cache_key(&data_directory)?)?;
        if !states.iter().any(|path| !unstarted_process_state(path)) {
            return Err("Temporary exposure is no longer pending; refresh cleanup status.".into());
        }
        if temp_directory_status(cache_directory, &data_directory)
            .iter()
            .any(|item| {
                matches!(
                    item.reason.as_str(),
                    "turn-temp-process-active" | "turn-temp-owner-unverified-active"
                )
            })
            || temp_directory_in_use(&target)
        {
            return Err("Temporary data still has an active owner.".into());
        }
        match fs::symlink_metadata(&target) {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&target).map_err(|error| {
                report_pending(&target, "manual-temp-removal-failed");
                format!("Cannot remove pending temporary data: {error}")
            })?,
            Ok(_) => return Err("Temporary root is not an unused directory.".into()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.to_string()),
        }
        for state in states {
            fs::remove_file(&state).map_err(|error| {
                report_pending(&target, "manual-temp-removal-failed");
                format!("Cannot remove pending temporary process state: {error}")
            })?;
        }
        drop(_lease);
        drop(_mutation);
        return Ok(());
    }
    let _temp_lock = if let Some(lock_directory) = &lock_directory {
        Some(
            FileLock::try_acquire(&lock_path(cache_directory, "temp", lock_directory)?, true)
                .map_err(|_| "Temporary data still has an active owner.".to_string())?,
        )
    } else {
        None
    };
    if !fs::symlink_metadata(&target)
        .map_err(|error| error.to_string())?
        .is_dir()
        || temp_directory_in_use(&target)
    {
        return Err("Temporary data is not an unused directory.".into());
    }
    if let Ok(owner) = read_temp_owner(&target, &data_directory) {
        if owner.pid != std::process::id() && process_owner_alive(&owner) {
            return Err("Temporary data still has a verified active owner.".into());
        }
    }
    if let Some(lock_directory) = &lock_directory {
        let process_state_file = process_state_path(cache_directory, lock_directory)?;
        if unstarted_process_state(&process_state_file) {
            if let Err(error) = fs::remove_file(process_state_file) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    report_pending(&target, "manual-temp-removal-failed");
                    return Err(format!(
                        "Cannot remove pending temporary process state: {error}"
                    ));
                }
            }
        }
    }
    fs::remove_dir_all(&target).map_err(|error| {
        report_pending(&target, "manual-temp-removal-failed");
        format!("Cannot remove pending temporary data: {error}")
    })?;
    drop(_temp_lock);
    drop(_lease);
    drop(_mutation);
    Ok(())
}

fn find_pending_temp(
    cache_directory: &Path,
    token: &str,
) -> Result<(PathBuf, PathBuf, Option<PathBuf>), String> {
    let root = cache_directory.join("terminal-worktrees");
    for entry in fs::read_dir(root).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let data_directory = entry.path();
        if !entry.file_name().to_str().is_some_and(valid_cache_key)
            || !verified_data_owner(cache_directory, &data_directory)
        {
            continue;
        }
        for target in [
            data_directory.join("tmp"),
            data_directory.join("build/go-tmp"),
        ] {
            if cache_key(&target)? == token {
                if target.parent() == Some(data_directory.join("build").as_path())
                    && !fs::symlink_metadata(data_directory.join("build"))
                        .is_ok_and(|metadata| metadata.is_dir())
                {
                    return Err("Legacy temporary storage parent changed.".into());
                }
                return Ok((data_directory, target, None));
            }
        }
        let temp_root = data_directory.join(TEMP_ROOT);
        if cache_key(&temp_root)? == token
            && !exposed_process_states(cache_directory, &cache_key(&data_directory)?)?.is_empty()
        {
            return Ok((data_directory, temp_root, None));
        }
        if !fs::symlink_metadata(&temp_root).is_ok_and(|metadata| metadata.is_dir()) {
            continue;
        }
        for entry in fs::read_dir(&temp_root).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let target = entry.path();
            let name = entry.file_name();
            let lock_directory = name
                .to_str()
                .and_then(original_run_name)
                .map(|name| temp_root.join(name));
            if cache_key(&target)? == token {
                return Ok((data_directory, target, lock_directory));
            }
        }
    }
    Err("Pending temporary data was not found; refresh cleanup status.".into())
}

fn original_run_name(name: &str) -> Option<&str> {
    let original = name
        .strip_prefix('.')
        .and_then(|name| name.strip_suffix(".tmp"))
        .unwrap_or(name);
    let uuid = uuid::Uuid::parse_str(original.strip_prefix("run-")?).ok()?;
    (format!("run-{uuid}") == original).then_some(original)
}

fn verified_data_owner(cache_directory: &Path, data_directory: &Path) -> bool {
    read_owner(data_directory).ok().is_some_and(|identity| {
        identity_data_directory(cache_directory, &identity)
            .ok()
            .as_deref()
            == Some(data_directory)
    }) || read_plain_owner(cache_directory, data_directory).is_ok()
}

fn temp_directory_status(cache_directory: &Path, data_directory: &Path) -> Vec<CleanupPending> {
    let mut pending = Vec::new();
    if !verified_data_owner(cache_directory, data_directory) {
        return pending;
    }
    let owner_path = read_owner(data_directory)
        .ok()
        .filter(|identity| {
            identity_data_directory(cache_directory, identity)
                .ok()
                .as_deref()
                == Some(data_directory)
        })
        .map(|identity| identity.root)
        .or_else(|| read_plain_owner(cache_directory, data_directory).ok())
        .and_then(|path| path.to_str().map(str::to_owned));
    let temp_item = |key: String, reason: &str, path: Option<&Path>, can_clean: bool| {
        let mut item = pending_item(key, reason, path, can_clean);
        if let (Some(path), Some(owner)) = (path.and_then(Path::to_str), owner_path.as_deref()) {
            item.path = Some(path.to_owned());
            item.owner_path = Some(owner.to_owned());
        } else {
            item.cleanup_token = None;
        }
        item
    };
    let root = data_directory.join(TEMP_ROOT);
    match cache_key(data_directory).and_then(|key| exposed_process_states(cache_directory, &key)) {
        Ok(states) if !states.is_empty() => {
            let can_clean = match fs::symlink_metadata(&root) {
                Ok(metadata) => metadata.is_dir(),
                Err(error) => error.kind() == std::io::ErrorKind::NotFound,
            };
            let mut item = temp_item(
                cache_key(&root).unwrap_or_else(|_| "unknown".into()),
                "turn-temp-owner-unverifiable",
                Some(&root),
                can_clean,
            );
            item.size_bytes = Some(item.size_bytes.unwrap_or(0));
            pending.push(item);
        }
        Err(_) => pending.push(temp_item(
            cache_key(data_directory).unwrap_or_else(|_| "unknown".into()),
            "turn-temp-state-scan-failed",
            Some(data_directory),
            false,
        )),
        Ok(_) => {}
    }
    for legacy in [
        data_directory.join("tmp"),
        data_directory.join("build/go-tmp"),
    ] {
        let key = cache_key(&legacy).unwrap_or_else(|_| "unknown".into());
        match fs::symlink_metadata(&legacy) {
            Ok(metadata) if metadata.is_dir() => pending.push(temp_item(
                key,
                "legacy-temp-owner-unverified",
                Some(&legacy),
                true,
            )),
            Ok(_) => pending.push(temp_item(
                key,
                "legacy-temp-root-unverifiable",
                Some(&legacy),
                false,
            )),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(_) => pending.push(temp_item(key, "legacy-temp-scan-failed", None, false)),
        }
    }
    if let Ok(metadata) = fs::symlink_metadata(&root) {
        if !metadata.is_dir() {
            pending.push(temp_item(
                cache_key(data_directory).unwrap_or_else(|_| "unknown".into()),
                "turn-temp-root-unverifiable",
                Some(&root),
                false,
            ));
            return pending;
        }
    }
    let entries = match fs::read_dir(&root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return pending,
        Err(_) => {
            pending.push(temp_item(
                cache_key(data_directory).unwrap_or_else(|_| "unknown".into()),
                "turn-temp-scan-failed",
                None,
                false,
            ));
            return pending;
        }
    };
    for entry in entries {
        let Ok(entry) = entry else {
            pending.push(temp_item(
                cache_key(data_directory).unwrap_or_else(|_| "unknown".into()),
                "turn-temp-entry-unreadable",
                None,
                false,
            ));
            continue;
        };
        let directory = entry.path();
        let key = cache_key(&directory).unwrap_or_else(|_| "unknown".into());
        let name = entry.file_name();
        let lock_directory = match name.to_str().and_then(original_run_name) {
            Some(name) => root.join(name),
            None => {
                let can_clean =
                    fs::symlink_metadata(&directory).is_ok_and(|metadata| metadata.is_dir());
                pending.push(temp_item(
                    key,
                    "turn-temp-owner-unverifiable",
                    Some(&directory),
                    can_clean,
                ));
                continue;
            }
        };
        let reason = match read_temp_owner(&directory, data_directory) {
            Ok(owner) => {
                let pending_reason = fs::read_to_string(directory.join(TEMP_PENDING_FILE)).ok();
                let owner_unverified =
                    pending_reason.as_deref() == Some("turn-temp-owner-unverified");
                let cleanup_failed = fs::symlink_metadata(directory.join(TEMP_PENDING_FILE))
                    .is_ok_and(|metadata| metadata.is_file());
                let lock_path = lock_path(cache_directory, "temp", &lock_directory);
                match lock_path.and_then(|path| FileLock::try_acquire(&path, true)) {
                    Ok(_lock) if temp_directory_in_use(&directory) => {
                        Some("turn-temp-process-active")
                    }
                    Ok(_lock) if owner.pid != std::process::id() && process_owner_alive(&owner) => {
                        Some("turn-temp-process-active")
                    }
                    Ok(_lock) if owner_unverified => Some("turn-temp-owner-unverified"),
                    Ok(_lock) if cleanup_failed => Some("turn-temp-cleanup-failed"),
                    Ok(_lock) => Some("turn-temp-owner-unverified"),
                    Err(_) if owner_unverified => Some("turn-temp-owner-unverified-active"),
                    Err(_) if cleanup_failed => Some("turn-temp-cleanup-failed"),
                    Err(_) => Some("turn-temp-process-active"),
                }
            }
            Err(_) => {
                let lock = lock_path(cache_directory, "temp", &lock_directory);
                match lock.and_then(|path| FileLock::try_acquire(&path, true)) {
                    Ok(_lock) if temp_directory_in_use(&directory) => {
                        Some("turn-temp-process-active")
                    }
                    Ok(_lock) => Some("turn-temp-owner-unverifiable"),
                    Err(_) => Some("turn-temp-process-active"),
                }
            }
        };
        if let Some(reason) = reason {
            pending.push(temp_item(
                key,
                reason,
                Some(&directory),
                matches!(
                    reason,
                    "turn-temp-owner-unverified"
                        | "turn-temp-owner-unverifiable"
                        | "turn-temp-cleanup-failed"
                ),
            ));
        }
    }
    pending
}

fn read_temp_owner(directory: &Path, data_directory: &Path) -> Result<TempOwner, String> {
    if !fs::symlink_metadata(directory)
        .map_err(|error| error.to_string())?
        .is_dir()
    {
        return Err("Temporary owner is not a directory.".into());
    }
    let current = directory.join(TEMP_OWNER_FILE);
    let path = match fs::symlink_metadata(&current) {
        Ok(_) => current,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            directory.join(LEGACY_TEMP_OWNER_FILE)
        }
        Err(error) => return Err(error.to_string()),
    };
    if !fs::symlink_metadata(&path)
        .map_err(|error| error.to_string())?
        .is_file()
    {
        return Err("Temporary owner marker is not a regular file.".into());
    }
    let contents = fs::read_to_string(path).map_err(|error| error.to_string())?;
    let mut lines = contents.lines();
    let header = lines.next();
    if !matches!(
        header,
        Some(TEMP_OWNER_HEADER | PREVIOUS_TEMP_OWNER_HEADER | LEGACY_TEMP_OWNER_HEADER)
    ) || lines.next() != Some(cache_key(data_directory)?.as_str())
    {
        return Err("Temporary owner marker does not match its worktree.".into());
    }
    let pid = lines
        .next()
        .ok_or("Temporary owner marker lacks a process ID.")?
        .parse::<u32>()
        .map_err(|error| error.to_string())?;
    let started_at = if matches!(header, Some(TEMP_OWNER_HEADER | PREVIOUS_TEMP_OWNER_HEADER)) {
        Some(
            lines
                .next()
                .ok_or("Temporary owner marker lacks a process start time.")?
                .parse::<u64>()
                .map_err(|error| error.to_string())?,
        )
    } else {
        None
    };
    if pid == 0 || started_at == Some(0) || lines.next().is_some() {
        return Err("Temporary owner marker is malformed.".into());
    }
    Ok(TempOwner {
        pid,
        started_at,
        protocol_v3: header == Some(TEMP_OWNER_HEADER),
    })
}

fn temp_directory_in_use(directory: &Path) -> bool {
    let system = sysinfo::System::new_all();
    system
        .processes()
        .values()
        .any(|process| process_uses_temp(process, directory))
}

fn environment_uses_temp(values: &[OsString], directory: &Path) -> bool {
    let environment = ["TMPDIR", "TEMP", "TMP"].map(|name| {
        let mut value = OsString::from(name);
        value.push("=");
        value.push(directory.as_os_str());
        value
    });
    let mut go_temporary = OsString::from("GOTMPDIR=");
    go_temporary.push(directory.join("go-tmp").as_os_str());
    let mut legacy_go_temporary = OsString::from("GOTMPDIR=");
    legacy_go_temporary.push(directory.as_os_str());
    values.iter().any(|value| {
        environment.contains(value) || value == &go_temporary || value == &legacy_go_temporary
    })
}

pub(crate) fn process_uses_temp(process: &sysinfo::Process, directory: &Path) -> bool {
    if matches!(
        process.status(),
        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
    ) {
        return false;
    }
    if environment_uses_temp(process.environ(), directory) {
        return true;
    }
    if process
        .cwd()
        .is_some_and(|path| path.starts_with(directory))
        || process
            .exe()
            .is_some_and(|path| path.starts_with(directory))
    {
        return true;
    }
    let path = directory.as_os_str().as_encoded_bytes();
    if path.is_empty() {
        return false;
    }
    process.cmd().iter().any(|argument| {
        argument
            .as_encoded_bytes()
            .windows(path.len())
            .any(|part| part == path)
    })
}

#[cfg(unix)]
fn process_owner_alive(owner: &TempOwner) -> bool {
    use nix::errno::Errno;
    use nix::unistd::Pid;

    match nix::sys::signal::kill(Pid::from_raw(owner.pid as i32), None) {
        Err(Errno::ESRCH) => false,
        Ok(()) | Err(Errno::EPERM) => {
            let system = sysinfo::System::new_all();
            system
                .process(sysinfo::Pid::from_u32(owner.pid))
                .is_none_or(|process| {
                    !matches!(
                        process.status(),
                        sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
                    ) && owner
                        .started_at
                        .is_none_or(|started_at| process.start_time() == started_at)
                })
        }
        Err(_) => true,
    }
}

#[cfg(windows)]
fn process_owner_alive(owner: &TempOwner) -> bool {
    let system = sysinfo::System::new_all();
    system
        .process(sysinfo::Pid::from_u32(owner.pid))
        .is_some_and(|process| {
            !matches!(
                process.status(),
                sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
            ) && owner
                .started_at
                .is_none_or(|started_at| process.start_time() == started_at)
        })
}

#[cfg(not(any(unix, windows)))]
fn process_owner_alive(_owner: &TempOwner) -> bool {
    true
}

pub(crate) fn data_directory_for_root(cache_directory: &Path, root: &Path) -> Option<PathBuf> {
    let root = stable_worktree_identity(root);
    if root.exists() {
        let identity = resolve_identity(&root).ok()?;
        let path = identity_data_directory(cache_directory, &identity).ok()?;
        return (read_owner(&path).ok().as_ref() == Some(&identity)).then_some(path);
    }
    let entries = fs::read_dir(cache_directory.join("terminal-worktrees")).ok()?;
    let mut match_path = None;
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
            && match_path.replace(path).is_some()
        {
            return None;
        }
    }
    match_path
}

pub(crate) fn data_directory_for_removal(
    cache_directory: &Path,
    root: &Path,
) -> Result<Option<PathBuf>, String> {
    let identity = resolve_identity(root)?;
    let directory = identity_data_directory(cache_directory, &identity)?;
    let metadata = match fs::symlink_metadata(&directory) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => {
            return Err(format!(
                "Cannot inspect selected private storage at {}: {error}",
                directory.display()
            ));
        }
    };
    if !metadata.is_dir() || read_owner(&directory).ok().as_ref() != Some(&identity) {
        return Err(format!(
            "Selected private storage at {} has an unverifiable owner. Its files were kept.",
            directory.display()
        ));
    }
    Ok(Some(directory))
}

pub(crate) fn is_managed_directory(path: &Path) -> bool {
    read_owner(path).is_ok()
}

pub(crate) fn data_directory_owned_by(
    cache_directory: &Path,
    data_directory: &Path,
    expected_root: &Path,
) -> Result<Option<PathBuf>, String> {
    let identity = read_owner(data_directory).map_err(|reason| reason.to_string())?;
    let expected_directory = identity_data_directory(cache_directory, &identity)?;
    if expected_directory != data_directory
        || !identity
            .root
            .starts_with(stable_worktree_identity(expected_root))
    {
        return Err("Private storage owner does not match the selected worktree.".into());
    }
    if identity.root.exists() && resolve_identity(&identity.root).ok().as_ref() != Some(&identity) {
        return Ok(None);
    }
    Ok(Some(identity.root))
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
        if resolve_identity(&identity.root).ok().as_ref() != Some(&identity) {
            continue;
        }
        match identity_data_directory(cache_directory, &identity) {
            Ok(expected) if expected == path => directories.push(path),
            _ => report_pending(&path, "owner-cache-key-mismatch"),
        }
    }
    directories.sort_by_key(|path| {
        read_owner(path)
            .map(|identity| std::cmp::Reverse(identity.root.components().count()))
            .unwrap_or(std::cmp::Reverse(0))
    });
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
    remove_after_worktree_removal_with_policy(cache_directory, data_directories, false, None)
}

fn remove_after_worktree_removal_with_policy(
    cache_directory: &Path,
    data_directories: &[PathBuf],
    allow_verified_replacement: bool,
    expected_directory_id: Option<&str>,
) -> Result<(), String> {
    for data_directory in data_directories {
        if !data_directory
            .symlink_metadata()
            .map_err(|error| format!("Cannot inspect selected private storage: {error}"))?
            .is_dir()
        {
            return Err("Selected private storage is not a managed directory.".into());
        }
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
        if expected_directory_id.is_some_and(|expected| {
            directory_identity(data_directory).ok().as_deref() != Some(expected)
        }) {
            return Err("Selected private storage directory changed during cleanup; its bytes were retained.".into());
        }
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
        if !verify_identity_removed_inner(&identity, allow_verified_replacement).map_err(
            |reason| {
                report_pending(data_directory, reason);
                format!(
                "Private agent data is retained because worktree identity is ambiguous ({reason})."
            )
            },
        )? {
            report_pending(data_directory, "worktree-identity-still-present");
            return Err(
                "Private agent data is retained because Git still identifies this worktree.".into(),
            );
        }
        let pending_temp = temp_directory_status(cache_directory, data_directory);
        if !pending_temp.is_empty() {
            for item in pending_temp {
                report_pending(data_directory, &item.reason);
            }
            return Err("Private agent data is retained while temporary data is still in use or cannot be verified.".into());
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
        if let Some(expected) = expected_directory_id {
            remove_quarantine_with_identity(&quarantine, &name, &identity, Some(expected))?;
        } else {
            remove_quarantine(&quarantine, &name)?;
        }
        let _ = clear_durable_cleanup_marker(cache_directory, data_directory);
    }
    Ok(())
}

pub(crate) fn ensure_ready_before_worktree_removal(
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
        if read_owner(data_directory)? != identity {
            report_pending(data_directory, "owner-changed-before-removal");
            return Err("Private agent data ownership changed before worktree removal.".into());
        }
        let pending_temp = temp_directory_status(cache_directory, data_directory);
        if !pending_temp.is_empty() {
            for item in pending_temp {
                report_pending(data_directory, &item.reason);
            }
            return Err(
                "Private agent data is retained while temporary data is still in use or cannot be verified."
                    .into(),
            );
        }
        persist_durable_cleanup_marker(cache_directory, data_directory)?;
        if !has_explicit_cleanup_marker(data_directory)? {
            let mut marker = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(data_directory.join(EXPLICIT_CLEANUP_MARKER))
                .map_err(|error| format!("Cannot preserve selected private storage: {error}"))?;
            marker
                .write_all(EXPLICIT_CLEANUP_HEADER.as_bytes())
                .and_then(|_| marker.sync_all())
                .map_err(|error| format!("Cannot persist selected private storage: {error}"))?;
        }
    }
    Ok(())
}

pub(crate) fn retained_selected_storage_locations(
    cache_directory: &Path,
    data_directories: &[PathBuf],
) -> Result<Vec<(String, PathBuf)>, String> {
    let cache_root = cache_directory.join("terminal-worktrees");
    let entries = fs::read_dir(&cache_root)
        .map_err(|error| format!("Cannot inspect retained private storage: {error}"))?
        .map(|entry| {
            entry
                .map(|entry| (entry.file_name(), entry.path()))
                .map_err(|error| format!("Cannot inspect retained private storage: {error}"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut retained = Vec::new();
    for original in data_directories {
        let key = original
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| valid_cache_key(name))
            .ok_or("Selected private storage key is invalid.")?
            .to_owned();
        if !matches!(
            original.symlink_metadata(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound
        ) {
            retained.push((key.clone(), original.clone()));
        }
        let prefix = format!("{QUARANTINE_PREFIX}{}-", cache_key(original)?);
        for (name, path) in &entries {
            if name
                .to_str()
                .and_then(|name| name.strip_prefix(&prefix))
                .and_then(|suffix| suffix.strip_suffix(".tmp"))
                .is_some_and(|uuid| uuid::Uuid::parse_str(uuid).is_ok())
            {
                retained.push((key.clone(), path.clone()));
            }
        }
    }
    Ok(retained)
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct SelectedStorageLocation {
    pub(crate) cache_key: String,
    pub(crate) path: PathBuf,
    pub(crate) size_bytes: Option<u64>,
}

fn malformed_marker_proven_unrelated(
    cache_directory: &Path,
    marker_key: &str,
    selected_root: &Path,
    common_dir: &Path,
    repository_generation: &str,
) -> bool {
    let original = cache_directory.join("terminal-worktrees").join(marker_key);
    let Ok(locations) =
        retained_selected_storage_locations(cache_directory, std::slice::from_ref(&original))
    else {
        return false;
    };
    !locations.is_empty()
        && locations.iter().all(|(_, path)| {
            read_owner(path).is_ok_and(|owner| {
                identity_data_directory(cache_directory, &owner)
                    .is_ok_and(|owner_path| owner_path == original)
                    && (!owner.root.starts_with(selected_root)
                        || owner.common_dir != common_dir
                        || owner.repository_generation != repository_generation)
            })
        })
}

pub(crate) fn selected_removed_storage_locations(
    cache_directory: &Path,
    repository: &Path,
    original_worktree: &Path,
    expected_generation: &str,
) -> Result<Vec<SelectedStorageLocation>, String> {
    let common_dir = git_path(
        repository,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common_dir = dunce::canonicalize(common_dir)
        .map_err(|_| "Selected repository identity cannot be verified.".to_string())?;
    let selected_root = stable_worktree_identity(original_worktree);
    let (repository_generation, worktree_generation) = expected_generation
        .split_once(':')
        .ok_or("The selected worktree generation is malformed.")?;
    let locks = cache_directory.join("terminal-worktree-locks");
    let entries = match fs::read_dir(locks) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            // A new app cache has neither markers nor private storage. An
            // existing storage root without markers remains ambiguous.
            match fs::symlink_metadata(cache_directory.join("terminal-worktrees")) {
                Err(storage_error) if storage_error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Vec::new());
                }
                _ => {}
            }
            return Err(format!("Cannot inspect selected storage markers: {error}"));
        }
        Err(error) => return Err(format!("Cannot inspect selected storage markers: {error}")),
    };
    let mut locations = Vec::new();
    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Cannot inspect selected storage marker: {error}"))?;
        let name = entry.file_name();
        let Some(marker_key) = name
            .to_str()
            .and_then(|name| name.strip_prefix("explicit-"))
            .and_then(|name| name.strip_suffix(".pending"))
            .filter(|key| valid_cache_key(key))
        else {
            continue;
        };
        let durable = match durable_cleanup_identity_by_key(cache_directory, marker_key) {
            Ok(Some(durable)) => durable,
            Ok(None) => continue,
            Err(_error)
                if malformed_marker_proven_unrelated(
                    cache_directory,
                    marker_key,
                    &selected_root,
                    &common_dir,
                    repository_generation,
                ) =>
            {
                continue;
            }
            Err(error) => return Err(error),
        };
        let identity = &durable.owner;
        if !identity.root.starts_with(&selected_root)
            || identity.common_dir != common_dir
            || identity.repository_generation != repository_generation
            || (identity.root == selected_root && identity.generation != worktree_generation)
        {
            continue;
        }
        let original = identity_data_directory(cache_directory, identity)?;
        if cache_key(&original)? != marker_key
            || !verify_selected_identity_removed(identity).map_err(str::to_string)?
        {
            continue;
        }
        for (_, path) in
            retained_selected_storage_locations(cache_directory, std::slice::from_ref(&original))?
        {
            if directory_identity(&path).ok().as_deref() != Some(&durable.directory_id) {
                continue;
            }
            locations.push(SelectedStorageLocation {
                cache_key: original
                    .file_name()
                    .and_then(|name| name.to_str())
                    .ok_or("Selected private storage key is invalid.")?
                    .to_owned(),
                size_bytes: pending_size(&path),
                path,
            });
        }
    }
    Ok(locations)
}

fn has_explicit_cleanup_marker(data_directory: &Path) -> Result<bool, String> {
    let marker = data_directory.join(EXPLICIT_CLEANUP_MARKER);
    let metadata = match marker.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(error) => return Err(format!("Cannot inspect selected cleanup marker: {error}")),
    };
    if !metadata.file_type().is_file() {
        return Err("Selected cleanup marker is not a regular file.".into());
    }
    let contents = fs::read_to_string(&marker)
        .map_err(|error| format!("Cannot read selected cleanup marker: {error}"))?;
    if contents != EXPLICIT_CLEANUP_HEADER {
        return Err("Selected cleanup marker does not match its expected format.".into());
    }
    Ok(true)
}

fn durable_cleanup_marker_path(cache_directory: &Path, key: &str) -> PathBuf {
    cache_directory
        .join("terminal-worktree-locks")
        .join(format!("explicit-{key}.pending"))
}

fn durable_cleanup_identity_by_key(
    cache_directory: &Path,
    key: &str,
) -> Result<Option<DurableCleanupIdentity>, String> {
    let marker = durable_cleanup_marker_path(cache_directory, key);
    let metadata = match marker.symlink_metadata() {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(format!("Cannot inspect durable cleanup marker: {error}")),
    };
    if !metadata.file_type().is_file() {
        return Err("Durable cleanup marker is not a regular file.".into());
    }
    let contents = fs::read_to_string(marker)
        .map_err(|error| format!("Cannot read durable cleanup marker: {error}"))?;
    let body = contents
        .strip_prefix(DURABLE_CLEANUP_HEADER)
        .ok_or("Durable cleanup marker has no verifiable owner identity.")?;
    let (directory_id, owner) = body
        .split_once('\n')
        .filter(|(id, _)| !id.is_empty())
        .ok_or("Durable cleanup marker has no directory identity.")?;
    let owner = parse_owner(owner)
        .map_err(|reason| format!("Durable cleanup owner identity is invalid ({reason})."))?;
    Ok(Some(DurableCleanupIdentity {
        owner,
        directory_id: directory_id.to_owned(),
    }))
}

fn has_durable_cleanup_marker_by_key(cache_directory: &Path, key: &str) -> Result<bool, String> {
    Ok(durable_cleanup_identity_by_key(cache_directory, key)?.is_some())
}

fn has_durable_cleanup_marker(
    cache_directory: &Path,
    data_directory: &Path,
) -> Result<bool, String> {
    has_durable_cleanup_marker_by_key(cache_directory, &cache_key(data_directory)?)
}

fn persist_durable_cleanup_marker(
    cache_directory: &Path,
    data_directory: &Path,
) -> Result<(), String> {
    let key = cache_key(data_directory)?;
    if has_durable_cleanup_marker_by_key(cache_directory, &key)? {
        return Ok(());
    }
    let identity = read_owner(data_directory)
        .map_err(|reason| format!("Cannot preserve selected storage owner ({reason})."))?;
    let directory_id = directory_identity(data_directory)?;
    let marker = durable_cleanup_marker_path(cache_directory, &key);
    fs::create_dir_all(
        marker
            .parent()
            .ok_or("Invalid durable cleanup marker path.")?,
    )
    .map_err(|error| format!("Cannot create durable cleanup marker directory: {error}"))?;
    let temporary = marker.with_extension(format!("pending-{}.tmp", uuid::Uuid::new_v4()));
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)
        .map_err(|error| format!("Cannot preserve selected private storage: {error}"))?;
    let written = file
        .write_all(
            format!(
                "{DURABLE_CLEANUP_HEADER}{directory_id}\n{}",
                encode_owner(&identity)
            )
            .as_bytes(),
        )
        .and_then(|_| file.sync_all())
        .and_then(|_| fs::rename(&temporary, &marker));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written.map_err(|error| format!("Cannot persist selected private storage: {error}"))
}

fn clear_durable_cleanup_marker(
    cache_directory: &Path,
    data_directory: &Path,
) -> Result<(), String> {
    let marker = durable_cleanup_marker_path(cache_directory, &cache_key(data_directory)?);
    match fs::remove_file(marker) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot clear durable cleanup marker: {error}")),
    }
}

pub(crate) fn retry_selected_removed_worktree_storage(
    cache_directory: &Path,
    repository: &Path,
    original_worktree: &Path,
    expected_generation: &str,
    selected_cache_key: &str,
) -> Result<(), String> {
    if !valid_cache_key(selected_cache_key) {
        return Err("Invalid selected private storage key.".into());
    }
    let data_directory = cache_directory
        .join("terminal-worktrees")
        .join(selected_cache_key);
    let locations = retained_selected_storage_locations(
        cache_directory,
        std::slice::from_ref(&data_directory),
    )?;
    let [(_, selected)] = locations.as_slice() else {
        return Err("Selected private storage has no unique retained location; refresh pending cleanup before retrying.".into());
    };
    match selected.symlink_metadata() {
        Err(error) => return Err(format!("Cannot inspect selected private storage: {error}")),
        Ok(metadata) if !metadata.is_dir() => {
            return Err("Selected private storage is not a managed directory.".into());
        }
        Ok(_) => {}
    }
    let marker_key = cache_key(&data_directory)?;
    let durable = durable_cleanup_identity_by_key(cache_directory, &marker_key)?
        .ok_or("Selected private storage lacks an explicit cleanup marker.")?;
    if directory_identity(selected)? != durable.directory_id {
        return Err("Selected private storage directory changed; its bytes were retained.".into());
    }
    let selected_owner = read_owner(selected);
    let identity =
        match &selected_owner {
            Ok(identity) if *identity == durable.owner => identity.clone(),
            Err("owner-metadata-missing") if *selected != data_directory => durable.owner.clone(),
            _ => return Err(
                "Selected private storage ownership cannot be verified against its durable marker."
                    .into(),
            ),
        };
    let common_dir = git_path(
        repository,
        &["rev-parse", "--path-format=absolute", "--git-common-dir"],
    )?;
    let common_dir = dunce::canonicalize(common_dir)
        .map_err(|_| "Selected repository identity cannot be verified.".to_string())?;
    let selected_root = stable_worktree_identity(original_worktree);
    let (expected_repository_generation, expected_worktree_generation) = expected_generation
        .split_once(':')
        .ok_or("The selected worktree generation is malformed.")?;
    if !identity.root.starts_with(&selected_root)
        || identity.common_dir != common_dir
        || identity.repository_generation != expected_repository_generation
        || (identity.root == selected_root && identity.generation != expected_worktree_generation)
        || identity_data_directory(cache_directory, &identity)? != data_directory
    {
        return Err("Selected private storage belongs to a different worktree generation.".into());
    }
    if !verify_selected_identity_removed(&identity).map_err(str::to_string)? {
        return Err(
            "The selected worktree generation is still registered; private storage remains intact."
                .into(),
        );
    }
    if *selected == data_directory {
        return remove_after_worktree_removal_with_policy(
            cache_directory,
            &[data_directory],
            true,
            Some(&durable.directory_id),
        );
    }
    let quarantine_key = cache_key(&data_directory)?;
    let _repo_lock = FileLock::acquire(
        &lock_path(cache_directory, "repo", &identity.common_dir)?,
        true,
    )?;
    let _mutation = FileLock::acquire(
        &lock_path(cache_directory, "mutation", &data_directory)?,
        true,
    )?;
    let _lease =
        FileLock::try_acquire(&lock_path(cache_directory, "lease", &data_directory)?, true)
            .map_err(|_| "Selected private storage is in active use.".to_string())?;
    if has_active_markers(selected)
        || directory_identity(selected).ok().as_deref() != Some(&durable.directory_id)
        || match &selected_owner {
            Ok(_) => read_owner(selected).ok().as_ref() != Some(&identity),
            Err(_) => read_owner(selected).is_ok(),
        }
        || durable_cleanup_identity_by_key(cache_directory, &marker_key)?.as_ref() != Some(&durable)
        || !verify_selected_identity_removed(&identity).map_err(str::to_string)?
    {
        return Err(
            "Selected private storage changed during retry; its bytes were retained.".into(),
        );
    }
    remove_quarantine_with_identity(
        selected,
        &quarantine_key,
        &identity,
        Some(&durable.directory_id),
    )?;
    let _ = clear_durable_cleanup_marker(cache_directory, &data_directory);
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

pub(crate) fn generation(worktree: &Path) -> Result<String, String> {
    let identity = resolve_identity(worktree)?;
    Ok(format!(
        "{}:{}",
        identity.repository_generation, identity.generation
    ))
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
    let path = git_path_from_bytes(path)?;
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

fn git_path_from_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> {
    #[cfg(windows)]
    {
        String::from_utf8(bytes)
            .map(PathBuf::from)
            .map_err(|error| format!("Git returned an invalid UTF-8 path: {error}"))
    }
    #[cfg(not(windows))]
    {
        path_from_bytes(bytes)
    }
}

#[cfg(unix)]
fn path_from_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> {
    use std::os::unix::ffi::OsStringExt;
    Ok(PathBuf::from(std::ffi::OsString::from_vec(bytes)))
}

#[cfg(windows)]
fn path_from_bytes(bytes: Vec<u8>) -> Result<PathBuf, String> {
    use std::os::windows::ffi::OsStringExt;
    let (pairs, remainder) = bytes.as_chunks::<2>();
    if !remainder.is_empty() {
        return Err("Git returned an invalid worktree identity path.".into());
    }
    Ok(PathBuf::from(std::ffi::OsString::from_wide(
        &pairs
            .iter()
            .map(|pair| u16::from_le_bytes(*pair))
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
        {
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&owner)?;
            file.write_all(contents.as_bytes())?;
            file.sync_all()?;
        }
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
    parse_owner(&contents)
}

fn parse_owner(contents: &str) -> Result<WorktreeIdentity, &'static str> {
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
    verify_identity_removed_inner(identity, false)
}

fn verify_selected_identity_removed(identity: &WorktreeIdentity) -> Result<bool, &'static str> {
    verify_identity_removed_inner(identity, true)
}

fn verify_identity_removed_inner(
    identity: &WorktreeIdentity,
    allow_verified_replacement: bool,
) -> Result<bool, &'static str> {
    if identity.root.exists() && !allow_verified_replacement {
        return Ok(false);
    }
    if identity.root.exists() {
        match resolve_identity(&identity.root) {
            Ok(current) if current == *identity => return Ok(false),
            Ok(_) => {}
            Err(_) => return Err("worktree-replacement-identity-ambiguous"),
        }
    }
    let common = dunce::canonicalize(&identity.common_dir)
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
    for path in &listed {
        if lexical_absolute(path) == lexical_absolute(&identity.root) {
            if !allow_verified_replacement {
                return Ok(false);
            }
            match resolve_identity(path) {
                Ok(current) if current == *identity => return Ok(false),
                Ok(_) => {}
                Err(_) => return Err("worktree-replacement-identity-ambiguous"),
            }
        }
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
            Ok(Some(_)) if allow_verified_replacement => {}
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
            paths.push(git_path_from_bytes(path.to_vec())?);
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

fn remove_quarantine(path: &Path, key: &str) -> Result<(), String> {
    let identity = match read_owner(path) {
        Ok(identity) => identity,
        Err(_) => {
            report_pending(path, "quarantine-owner-unverifiable");
            return Err(format!(
                "Private storage remains at {} because its quarantine owner is unverifiable.",
                path.display()
            ));
        }
    };
    remove_quarantine_with_identity(path, key, &identity, None)
}

fn remove_quarantine_with_identity(
    path: &Path,
    key: &str,
    identity: &WorktreeIdentity,
    expected_directory_id: Option<&str>,
) -> Result<(), String> {
    if expected_directory_id
        .is_some_and(|expected| directory_identity(path).ok().as_deref() != Some(expected))
    {
        return Err("Selected quarantine directory changed; its bytes were retained.".into());
    }
    let expected = match identity_data_directory(
        path.parent().and_then(Path::parent).unwrap_or(path),
        identity,
    ) {
        Ok(expected) => expected,
        Err(_) => {
            report_pending(path, "quarantine-owner-unverifiable");
            return Err(format!(
                "Private storage remains at {} because its quarantine owner is unverifiable.",
                path.display()
            ));
        }
    };
    if cache_key(&expected)
        .map(|value| value != key)
        .unwrap_or(true)
    {
        report_pending(path, "quarantine-owner-key-mismatch");
        return Err(format!(
            "Private storage remains at {} because its quarantine key does not match.",
            path.display()
        ));
    }
    let cache_directory = path.parent().and_then(Path::parent).unwrap_or(path);
    match exposed_process_states(cache_directory, key) {
        Ok(states) if !states.is_empty() => {
            report_pending(path, "turn-temp-owner-unverifiable");
            return Err(
                "Private storage retains temporary process state; review it before cleanup.".into(),
            );
        }
        Err(_) => {
            report_pending(path, "turn-temp-state-scan-failed");
            return Err("Cannot verify private storage temporary process state.".into());
        }
        Ok(_) => {}
    }
    match fs::remove_dir_all(path) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => {
            report_pending(path, "quarantine-removal-failed");
            Err(format!(
                "Private storage remains at {} because removal failed: {error}",
                path.display()
            ))
        }
    }
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

#[cfg(all(test, unix))]
fn log_lock_holder(path: &Path) {
    let program = if cfg!(target_os = "macos") {
        "/usr/sbin/lsof"
    } else {
        "lsof"
    };
    match std::process::Command::new(program)
        .arg("-nP")
        .arg(path)
        .output()
    {
        Ok(output) => eprintln!(
            "lease lock holders for {}: status={} stdout={} stderr={}",
            path.display(),
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        ),
        Err(error) => eprintln!("Cannot inspect lease lock holders: {error}"),
    }
}

pub(crate) struct FileLock {
    file: File,
}

impl FileLock {
    pub(crate) fn acquire(path: &Path, exclusive: bool) -> Result<Self, String> {
        Self::acquire_mode(path, exclusive, false)
    }

    fn acquire_mode(path: &Path, exclusive: bool, nonblocking: bool) -> Result<Self, String> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(|error| {
                format!("Cannot create lock directory {}: {error}", parent.display())
            })?;
        }
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(path)
            .map_err(|error| format!("Cannot open lock file {}: {error}", path.display()))?;
        lock_file(&file, exclusive, nonblocking)
            .map_err(|error| format!("Cannot lock file {}: {error}", path.display()))?;
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
                    "--lock",
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
                    "--lock",
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
                &[
                    "worktree",
                    "remove",
                    "--force",
                    "--force",
                    worktree.to_str().unwrap(),
                ],
            );
        }
    }

    impl Drop for GitFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.root);
        }
    }

    fn pending_with_reason(cache: &Path, expected: &str) -> CleanupPending {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            let status = cleanup_status(cache);
            if let Some(item) = status.iter().find(|item| item.reason == expected) {
                return item.clone();
            }
            assert!(std::time::Instant::now() < deadline, "{status:?}");
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    fn assert_pending_temp_cleaned(cache: &Path, token: &str) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            match clean_pending_temp(cache, token) {
                Ok(_) => return,
                Err(error)
                    if std::time::Instant::now() < deadline
                        && matches!(
                            error.as_str(),
                            "Temporary data still has an active owner."
                                | "Private storage still has an active owner."
                                | "Temporary data is no longer pending; refresh cleanup status."
                                | "Private storage is changing; retry after it becomes idle."
                                | "Temporary data is not an unused directory."
                        ) =>
                {
                    std::thread::sleep(std::time::Duration::from_millis(1));
                }
                Err(error) => panic!("pending temporary cleanup failed: {error}"),
            }
        }
    }

    fn assert_storage_reclaimed_after_retry(cache: &Path, directory: &Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        while directory.exists() && std::time::Instant::now() < deadline {
            retry_cleanup(cache);
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
        assert!(!directory.exists(), "private storage was not reclaimed");
    }

    #[cfg(unix)]
    fn assert_verified_temp_reclaimed(cache: &Path, temp: &Path) {
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
        loop {
            retry_cleanup(cache);
            if !temp.exists() {
                return;
            }
            assert!(
                std::time::Instant::now() < deadline,
                "verified temporary data remained: {:?}",
                cleanup_status(cache)
            );
            std::thread::sleep(std::time::Duration::from_millis(1));
        }
    }

    fn write_expired_temp_owner_with_header(temp: &Path, data_directory: &Path, header: &str) {
        let pid = std::process::id();
        let started_at = sysinfo::System::new_all()
            .process(sysinfo::Pid::from_u32(pid))
            .unwrap()
            .start_time();
        fs::write(
            temp.join(TEMP_OWNER_FILE),
            format!(
                "{header}\n{}\n{pid}\n{}\n",
                cache_key(data_directory).unwrap(),
                started_at + 1
            ),
        )
        .unwrap();
    }

    fn write_expired_temp_owner(temp: &Path, data_directory: &Path) {
        write_expired_temp_owner_with_header(temp, data_directory, PREVIOUS_TEMP_OWNER_HEADER);
    }

    #[test]
    fn lexical_identity_does_not_follow_a_reused_path() {
        let root = Path::new("/tmp/worktree/../worktree");
        assert_eq!(lexical_absolute(root), Path::new("/tmp/worktree"));
    }

    #[test]
    fn git_paths_decode_utf8_output_separately_from_owner_path_bytes() {
        let path = git_path_from_bytes("/tmp/café-工作".as_bytes().to_vec()).unwrap();
        assert_eq!(path, PathBuf::from("/tmp/café-工作"));
    }

    #[test]
    fn owner_directory_is_published_after_closing_metadata_file() {
        let root = std::env::temp_dir().join(format!(
            "sail-worktree-owner-publication-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let data_directory = root.join("owned");
        let identity = WorktreeIdentity {
            root: root.join("worktree"),
            common_dir: root.join("common"),
            admin_dir: root.join("common/worktrees/admin"),
            generation: uuid::Uuid::new_v4().to_string(),
            repository_generation: uuid::Uuid::new_v4().to_string(),
        };

        publish_owner_directory(&data_directory, &identity).unwrap();

        assert_eq!(read_owner(&data_directory).unwrap(), identity);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn windows_git_identity_path_decodes_utf16_bytes_and_rejects_odd_length() {
        use std::os::windows::ffi::OsStrExt;

        let path = path_from_bytes(vec![b'C', 0, b':', 0, b'\\', 0, 0x3d, 0xd8]).unwrap();
        assert_eq!(
            path.as_os_str().encode_wide().collect::<Vec<_>>(),
            [u16::from(b'C'), u16::from(b':'), u16::from(b'\\'), 0xd83d]
        );
        assert!(path_from_bytes(vec![b'C']).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn dangling_git_metadata_does_not_reopen_legacy_storage() {
        use std::os::unix::fs::symlink;

        let root = std::env::temp_dir().join(format!(
            "sail-dangling-git-metadata-{}",
            uuid::Uuid::new_v4()
        ));
        let worktree = root.join("worktree");
        let cache = root.join("cache");
        fs::create_dir_all(&worktree).unwrap();
        symlink(worktree.join("missing-git-dir"), worktree.join(".git")).unwrap();
        let legacy = legacy_data_directory(&cache, &stable_worktree_identity(&worktree)).unwrap();
        fs::create_dir_all(&legacy).unwrap();
        fs::write(legacy.join("sentinel"), "retain").unwrap();

        let error = register(&cache, &worktree)
            .err()
            .expect("dangling Git metadata must block legacy fallback");

        assert!(error.contains("Git identity cannot be verified"));
        assert_eq!(
            fs::read_to_string(legacy.join("sentinel")).unwrap(),
            "retain"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unicode_git_worktree_paths_register_and_clean() {
        let fixture = GitFixture::new();
        let worktree = fixture.root.join("café-工作");
        GitFixture::git(
            &fixture.repository,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                "--lock",
                worktree.to_str().unwrap(),
                "HEAD",
            ],
        );
        let (directory, lease) = register(&fixture.cache, &worktree).unwrap();
        lease.mark_started();
        lease.release_clean().unwrap();
        fixture.remove(&worktree);

        remove_after_worktree_removal(&fixture.cache, std::slice::from_ref(&directory)).unwrap();

        assert!(!directory.exists());
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
    fn completed_turn_temp_is_reclaimed_without_touching_a_live_terminal() {
        let fixture = GitFixture::new();
        let (_, runtime) = register(&fixture.cache, &fixture.first).unwrap();
        let (_, terminal) = register(&fixture.cache, &fixture.first).unwrap();
        runtime.mark_started();
        terminal.mark_started();
        let earlier = runtime.temp_directory().join("earlier-turn");
        let active = terminal.temp_directory().join("active-terminal");
        fs::write(&earlier, "finished").unwrap();
        fs::write(&active, "running").unwrap();

        runtime.clear_turn_temp().unwrap();

        assert!(!earlier.exists());
        assert_eq!(fs::read_to_string(&active).unwrap(), "running");
        assert!(runtime.temp_directory().join("go-tmp").is_dir());
        runtime.temp.mark_pending("turn-temp-removal-failed");
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "turn-temp-cleanup-failed"));
        for turn in 0..10 {
            let artifact = runtime.temp_directory().join(format!("turn-{turn}"));
            fs::write(&artifact, "new").unwrap();
            runtime.clear_turn_temp().unwrap();
            assert!(!artifact.exists());
            assert_eq!(fs::read_to_string(&active).unwrap(), "running");
        }
        assert!(!cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "turn-temp-cleanup-failed"));
        terminal.release_clean().unwrap();
        runtime.release_clean().unwrap();
        assert!(!active.exists());
    }

    #[test]
    fn active_turn_temp_is_visible_without_a_manual_cleanup_action() {
        let fixture = GitFixture::new();
        let (_, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let artifact = lease.temp_directory().join("active-artifact");
        fs::write(&artifact, "running").unwrap();

        let pending = cleanup_status(&fixture.cache);
        let item = pending
            .iter()
            .find(|item| item.reason == "turn-temp-process-active")
            .unwrap();
        assert!(item.size_bytes.unwrap() >= 7);
        assert!(item.cleanup_token.is_none());
        assert_eq!(fs::read_to_string(&artifact).unwrap(), "running");

        lease.release_clean().unwrap();
        assert!(!artifact.exists());
    }

    #[test]
    fn ten_verified_unexposed_turns_do_not_accumulate_temp_while_terminal_runs() {
        let fixture = GitFixture::new();
        let (_, terminal) = register(&fixture.cache, &fixture.first).unwrap();
        terminal.mark_started();
        let active = terminal.temp_directory().join("terminal-artifact");
        fs::write(&active, "running").unwrap();

        for turn in 0..10 {
            let (_, runtime) = register(&fixture.cache, &fixture.first).unwrap();
            let temp = runtime.temp_directory().to_path_buf();
            fs::write(temp.join(format!("turn-{turn}")), "finished").unwrap();
            runtime.mark_started();
            runtime.release_clean().unwrap();
            assert!(!temp.exists());
            assert_eq!(fs::read_to_string(&active).unwrap(), "running");
        }
        terminal.release_clean().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn ten_crashed_owners_with_verified_exits_leave_no_earlier_temp() {
        let fixture = GitFixture::new();
        let (_, terminal) = register(&fixture.cache, &fixture.first).unwrap();
        terminal.mark_started();
        let active = terminal.temp_directory().join("terminal-artifact");
        fs::write(&active, "running").unwrap();

        for turn in 0..10 {
            let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
            let temp = lease.temp_directory().to_path_buf();
            fs::write(temp.join(format!("turn-{turn}")), "unused").unwrap();
            let mut owner = std::process::Command::new("sleep")
                .arg("30")
                .spawn()
                .unwrap();
            let started_at = sysinfo::System::new_all()
                .process(sysinfo::Pid::from_u32(owner.id()))
                .unwrap()
                .start_time();
            fs::write(
                temp.join(TEMP_OWNER_FILE),
                format!(
                    "{TEMP_OWNER_HEADER}\n{}\n{}\n{started_at}\n",
                    cache_key(&directory).unwrap(),
                    owner.id(),
                ),
            )
            .unwrap();
            lease.mark_started();
            drop(lease);
            owner.kill().unwrap();
            owner.wait().unwrap();

            assert_verified_temp_reclaimed(&fixture.cache, &temp);
            assert_eq!(fs::read_to_string(&active).unwrap(), "running");
        }
        terminal.release_clean().unwrap();
    }

    #[test]
    fn process_exposed_temp_remains_pending_after_its_parent_exits() {
        let fixture = GitFixture::new();
        let (_, runtime) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = runtime.temp_directory().to_path_buf();
        let artifact = temp.join("artifact");
        fs::write(&artifact, "retain").unwrap();
        runtime.prepare_process_start().unwrap();
        let mut child = std::process::Command::new("git")
            .arg("--version")
            .env("TMPDIR", &temp)
            .stdout(std::process::Stdio::null())
            .spawn()
            .unwrap();
        runtime.mark_started();
        let child_visible_marker = temp.join("sail-temp-process-starting-v1");
        if child_visible_marker.exists() {
            fs::remove_file(child_visible_marker).unwrap();
        }
        assert!(child.wait().unwrap().success());
        runtime.release_clean().unwrap();

        let item = pending_with_reason(&fixture.cache, "turn-temp-owner-unverified");
        assert!(item.size_bytes.unwrap() >= 6);
        assert_eq!(item.path.as_deref(), temp.to_str());
        assert_eq!(
            item.owner_path.as_deref(),
            dunce::canonicalize(&fixture.first).unwrap().to_str()
        );
        assert!(clean_pending_temp_checked(
            &fixture.cache,
            item.cleanup_token.as_deref().unwrap(),
            &temp.join("another-run"),
            &fixture.first,
        )
        .is_err());
        assert_eq!(fs::read_to_string(&artifact).unwrap(), "retain");
        assert_pending_temp_cleaned(&fixture.cache, item.cleanup_token.as_deref().unwrap());
        assert!(!artifact.exists());
    }

    #[test]
    fn failed_process_start_releases_unexposed_temp() {
        let fixture = GitFixture::new();
        let (_, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        fs::write(temp.join("artifact"), "unused").unwrap();
        lease.prepare_process_start().unwrap();
        assert!(std::process::Command::new(temp.join("missing-program"))
            .spawn()
            .is_err());
        lease.cancel_process_start().unwrap();
        drop(lease);

        assert!(!temp.exists());
    }

    #[test]
    fn failed_process_start_reset_remains_visible_and_retryable() {
        let fixture = GitFixture::new();
        let (_, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        let state = lease.temp.process_state_file.clone();
        lease.prepare_process_start().unwrap();
        fs::remove_file(&state).unwrap();
        fs::create_dir(&state).unwrap();
        assert!(lease.cancel_process_start().is_err());
        drop(lease);

        let item = pending_with_reason(&fixture.cache, "turn-temp-cleanup-failed");
        fs::remove_dir(&state).unwrap();
        fs::write(&state, "invalid").unwrap();
        assert_pending_temp_cleaned(&fixture.cache, item.cleanup_token.as_deref().unwrap());
        assert!(!temp.exists());
    }

    #[test]
    fn missing_process_state_cannot_prove_temp_was_unexposed() {
        let fixture = GitFixture::new();
        let (_, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        fs::write(temp.join("artifact"), "retain").unwrap();
        fs::remove_file(&lease.temp.process_state_file).unwrap();
        lease.mark_started();
        drop(lease);

        retry_cleanup(&fixture.cache);
        assert_eq!(fs::read_to_string(temp.join("artifact")).unwrap(), "retain");
        let item = pending_with_reason(&fixture.cache, "turn-temp-owner-unverified");
        assert_pending_temp_cleaned(&fixture.cache, item.cleanup_token.as_deref().unwrap());
        assert!(!temp.exists());
    }

    #[test]
    fn abandoned_temp_is_retained_until_process_ownership_is_verified() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let abandoned = lease.temp_directory().to_path_buf();
        fs::write(abandoned.join("artifact"), "old").unwrap();
        write_expired_temp_owner(&abandoned, &directory);
        lease.mark_started();
        drop(lease);

        let abandoned_item = pending_with_reason(&fixture.cache, "turn-temp-owner-unverified");
        assert!(abandoned_item.size_bytes.unwrap() >= 3);
        let abandoned_token = abandoned_item.cleanup_token.clone().unwrap();
        retry_cleanup(&fixture.cache);
        assert_eq!(
            fs::read_to_string(abandoned.join("artifact")).unwrap(),
            "old"
        );
        assert!(directory.exists());

        let (_, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let unverified = lease.temp_directory().to_path_buf();
        fs::write(unverified.join("artifact"), "retain").unwrap();
        fs::write(unverified.join(TEMP_OWNER_FILE), "invalid").unwrap();
        lease.mark_started();
        drop(lease);

        retry_cleanup(&fixture.cache);
        assert_eq!(
            fs::read_to_string(unverified.join("artifact")).unwrap(),
            "retain"
        );
        let unverified_token = pending_with_reason(&fixture.cache, "turn-temp-owner-unverifiable")
            .cleanup_token
            .unwrap();
        assert_pending_temp_cleaned(&fixture.cache, &abandoned_token);
        assert!(!abandoned.exists());
        assert!(unverified.exists());
        assert_pending_temp_cleaned(&fixture.cache, &unverified_token);
        assert!(!unverified.exists());
    }

    #[test]
    fn crashed_owner_without_a_process_start_is_reclaimed_after_exit() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        fs::write(temp.join("artifact"), "unused").unwrap();
        write_expired_temp_owner_with_header(&temp, &directory, TEMP_OWNER_HEADER);
        lease.mark_started();
        drop(lease);

        retry_cleanup(&fixture.cache);
        assert!(!temp.exists());
    }

    #[test]
    fn process_exposure_state_retains_crashed_owner_temp() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        fs::write(temp.join("artifact"), "possibly-live").unwrap();
        lease.prepare_process_start().unwrap();
        write_expired_temp_owner_with_header(&temp, &directory, TEMP_OWNER_HEADER);
        lease.mark_started();
        drop(lease);

        retry_cleanup(&fixture.cache);
        assert_eq!(
            fs::read_to_string(temp.join("artifact")).unwrap(),
            "possibly-live"
        );
        pending_with_reason(&fixture.cache, "turn-temp-owner-unverified");
    }

    #[test]
    fn abandoned_plain_folder_temp_is_retained_without_process_proof() {
        let fixture = GitFixture::new();
        let plain = fixture.root.join("plain-folder");
        fs::create_dir(&plain).unwrap();
        let (directory, lease) = register(&fixture.cache, &plain).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        fs::write(temp.join("artifact"), "old").unwrap();
        write_expired_temp_owner(&temp, &directory);
        lease.mark_started();
        drop(lease);

        pending_with_reason(&fixture.cache, "turn-temp-owner-unverified");
        retry_cleanup(&fixture.cache);
        assert_eq!(fs::read_to_string(temp.join("artifact")).unwrap(), "old");
        assert!(directory.exists());

        let (_, lease) = register(&fixture.cache, &plain).unwrap();
        let unverified = lease.temp_directory().to_path_buf();
        fs::write(unverified.join("artifact"), "retain").unwrap();
        fs::write(directory.join(PLAIN_OWNER_FILE), "invalid").unwrap();
        lease.mark_started();
        drop(lease);
        retry_cleanup(&fixture.cache);
        assert_eq!(
            fs::read_to_string(unverified.join("artifact")).unwrap(),
            "retain"
        );
        assert!(!cleanup_status(&fixture.cache).is_empty());
    }

    #[test]
    fn crashed_plain_folder_active_marker_remains_visible_after_temp_reclaim() {
        let fixture = GitFixture::new();
        let plain = fixture.root.join("plain-folder");
        fs::create_dir(&plain).unwrap();
        let (directory, lease) = register(&fixture.cache, &plain).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        write_expired_temp_owner_with_header(&temp, &directory, TEMP_OWNER_HEADER);
        lease.mark_started();
        drop(lease);

        retry_cleanup(&fixture.cache);

        assert!(!temp.exists());
        let pending = pending_with_reason(&fixture.cache, "unclean-active-use");
        assert_eq!(
            pending.cache_key,
            directory.file_name().unwrap().to_string_lossy()
        );
        assert!(pending.size_bytes.is_some());
    }

    #[test]
    fn incomplete_plain_folder_owner_is_republished_before_creating_temp() {
        let fixture = GitFixture::new();
        let plain = fixture.root.join("plain-folder");
        fs::create_dir(&plain).unwrap();
        let canonical_plain = stable_worktree_identity(&plain);
        let directory = legacy_data_directory(&fixture.cache, &canonical_plain).unwrap();
        fs::create_dir_all(&directory).unwrap();
        fs::write(directory.join(PLAIN_OWNER_FILE), "").unwrap();

        let (_, lease) = register(&fixture.cache, &plain).unwrap();

        assert_eq!(
            read_plain_owner(&fixture.cache, &directory).unwrap(),
            canonical_plain
        );
        lease.release_clean().unwrap();
    }

    #[test]
    fn legacy_temp_is_reported_and_retained_without_process_ownership() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let artifact = directory.join("tmp/artifact");
        fs::create_dir_all(artifact.parent().unwrap()).unwrap();
        fs::write(&artifact, "legacy").unwrap();
        lease.release_clean().unwrap();
        fixture.remove(&fixture.first);

        let pending = retry_cleanup(&fixture.cache);

        assert_eq!(fs::read_to_string(&artifact).unwrap(), "legacy");
        assert!(pending
            .iter()
            .any(|item| item.reason == "legacy-temp-owner-unverified"));
        assert!(
            remove_after_worktree_removal(&fixture.cache, std::slice::from_ref(&directory))
                .is_err()
        );
        let token = pending
            .iter()
            .find(|item| item.reason == "legacy-temp-owner-unverified")
            .unwrap()
            .cleanup_token
            .clone()
            .unwrap();
        assert_pending_temp_cleaned(&fixture.cache, &token);
        assert!(!artifact.exists());
    }

    #[test]
    fn malformed_legacy_temp_paths_have_distinct_pending_keys() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        fs::write(directory.join("tmp"), "not a directory").unwrap();
        fs::create_dir_all(directory.join("build")).unwrap();
        fs::write(directory.join("build/go-tmp"), "not a directory").unwrap();
        lease.release_clean().unwrap();

        let malformed: Vec<_> = cleanup_status(&fixture.cache)
            .into_iter()
            .filter(|item| item.reason == "legacy-temp-root-unverifiable")
            .collect();
        assert_eq!(malformed.len(), 2);
        assert_ne!(malformed[0].cache_key, malformed[1].cache_key);
        assert!(malformed.iter().all(|item| item.cleanup_token.is_none()));
    }

    #[cfg(unix)]
    #[test]
    fn pending_marker_symlink_cannot_overwrite_a_user_file() {
        let fixture = GitFixture::new();
        let (_, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let user_file = fixture.root.join("user-file");
        fs::write(&user_file, "keep this user data").unwrap();
        let marker = lease.temp_directory().join(TEMP_PENDING_FILE);
        std::os::unix::fs::symlink(&user_file, &marker).unwrap();

        lease.mark_temp_pending("turn-temp-owner-unverified");

        assert_eq!(
            fs::read_to_string(&user_file).unwrap(),
            "keep this user data"
        );
        assert!(fs::symlink_metadata(&marker).unwrap().is_file());
        assert_eq!(
            fs::read_to_string(&marker).unwrap(),
            "turn-temp-owner-unverified"
        );
        lease.release_clean().unwrap();
    }

    #[test]
    fn legacy_go_temp_environment_is_recognized() {
        let temp = Path::new("cache/build/go-tmp");
        let mut legacy = OsString::from("GOTMPDIR=");
        legacy.push(temp.as_os_str());
        let mut current = OsString::from("GOTMPDIR=");
        current.push(temp.join("go-tmp").as_os_str());

        assert!(environment_uses_temp(&[legacy], temp));
        assert!(environment_uses_temp(&[current], temp));
        assert!(!environment_uses_temp(
            &[OsString::from("GOTMPDIR=other")],
            temp
        ));
    }

    #[cfg(target_os = "linux")]
    #[test]
    fn manual_cleanup_keeps_legacy_go_temp_while_its_process_is_running() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = directory.join("build/go-tmp");
        fs::create_dir_all(&temp).unwrap();
        let artifact = temp.join("artifact");
        fs::write(&artifact, "active-go-build").unwrap();
        lease.release_clean().unwrap();

        let mut process = std::process::Command::new("sleep")
            .arg("30")
            .env("GOTMPDIR", &temp)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        let observed = loop {
            if temp_directory_in_use(&temp) {
                break true;
            }
            if std::time::Instant::now() >= deadline {
                break false;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        };
        let result = clean_pending_temp(&fixture.cache, &cache_key(&temp).unwrap());
        process.kill().unwrap();
        process.wait().unwrap();

        assert!(observed, "legacy Go temporary process was not visible");
        assert_eq!(
            result.unwrap_err(),
            "Temporary data is not an unused directory."
        );
        assert_eq!(fs::read_to_string(&artifact).unwrap(), "active-go-build");
        assert_pending_temp_cleaned(&fixture.cache, &cache_key(&temp).unwrap());
        assert!(!temp.exists());
    }

    #[cfg(unix)]
    #[test]
    fn abandoned_temp_waits_for_its_owner_process_to_exit() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        let mut owner = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        fs::write(
            temp.join(TEMP_OWNER_FILE),
            format!(
                "{PREVIOUS_TEMP_OWNER_HEADER}\n{}\n{}\n{}\n",
                cache_key(&directory).unwrap(),
                owner.id(),
                sysinfo::System::new_all()
                    .process(sysinfo::Pid::from_u32(owner.id()))
                    .unwrap()
                    .start_time()
            ),
        )
        .unwrap();
        lease.mark_started();
        drop(lease);

        retry_cleanup(&fixture.cache);
        assert!(temp.exists());
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "turn-temp-process-active"));
        assert!(clean_pending_temp(&fixture.cache, &cache_key(&temp).unwrap()).is_err());
        assert!(temp.exists());

        owner.kill().unwrap();
        owner.wait().unwrap();
        retry_cleanup(&fixture.cache);
        assert!(temp.exists());
        pending_with_reason(&fixture.cache, "turn-temp-owner-unverified");
        assert_pending_temp_cleaned(&fixture.cache, &cache_key(&temp).unwrap());
        assert!(!temp.exists());
    }

    #[cfg(unix)]
    #[test]
    fn reused_process_id_is_not_treated_as_the_temp_owner() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        fs::write(temp.join("artifact"), "old").unwrap();
        let mut unrelated = std::process::Command::new("sleep")
            .arg("30")
            .spawn()
            .unwrap();
        let started_at = sysinfo::System::new_all()
            .process(sysinfo::Pid::from_u32(unrelated.id()))
            .unwrap()
            .start_time();
        fs::write(
            temp.join(TEMP_OWNER_FILE),
            format!(
                "{PREVIOUS_TEMP_OWNER_HEADER}\n{}\n{}\n{}\n",
                cache_key(&directory).unwrap(),
                unrelated.id(),
                started_at + 1
            ),
        )
        .unwrap();
        lease.mark_started();
        drop(lease);

        retry_cleanup(&fixture.cache);

        assert!(temp.exists());
        pending_with_reason(&fixture.cache, "turn-temp-owner-unverified");
        assert!(unrelated.try_wait().unwrap().is_none());
        unrelated.kill().unwrap();
        unrelated.wait().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn removed_worktree_retains_temp_used_by_detached_worker() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        let artifact = temp.join("artifact");
        fs::write(&artifact, "live").unwrap();
        let mut worker = std::process::Command::new("python3")
            .arg("-c")
            .arg("import sys,time; time.sleep(30); open(sys.argv[1]).read()")
            .arg(&artifact)
            .env("TMPDIR", &temp)
            .spawn()
            .unwrap();
        for _ in 0..100 {
            if temp_directory_in_use(&temp) {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(temp_directory_in_use(&temp));

        lease.mark_started();
        assert!(lease.release_clean().is_err());
        fixture.remove(&fixture.first);

        assert!(
            remove_after_worktree_removal(&fixture.cache, std::slice::from_ref(&directory))
                .is_err()
        );
        reconcile(&fixture.cache);
        assert_eq!(fs::read_to_string(&artifact).unwrap(), "live");

        worker.kill().unwrap();
        worker.wait().unwrap();
        lease.release_clean().unwrap();
        drop(lease);
        for _ in 0..100 {
            retry_cleanup(&fixture.cache);
            if !directory.exists() {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
        assert!(!directory.exists());
    }

    #[cfg(unix)]
    #[test]
    fn renamed_temp_with_new_session_worker_remains_pending() {
        use std::os::unix::process::CommandExt;

        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        let orphan = temp.parent().unwrap().join("run-orphan");
        let process_state = process_state_path(&fixture.cache, &temp).unwrap();
        let artifact = temp.join("artifact");
        let ready = fixture.root.join("worker-ready");
        fs::write(&artifact, "live").unwrap();
        lease.prepare_process_start().unwrap();
        let mut command = std::process::Command::new("python3");
        command
            .arg("-c")
            .arg("import sys,time; file=open(sys.argv[1]); open(sys.argv[2], 'w').write('ready'); time.sleep(30)")
            .arg(&artifact)
            .arg(&ready);
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut worker = command.spawn().unwrap();
        lease.mark_started();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let worker_ready = ready.exists();
        if worker_ready {
            fs::rename(&temp, &orphan).unwrap();
        }
        let active_cleanup = clean_pending_temp(&fixture.cache, &cache_key(&orphan).unwrap());
        let release = lease.release_clean();
        fixture.remove(&fixture.first);
        let removal =
            remove_after_worktree_removal(&fixture.cache, std::slice::from_ref(&directory));
        reconcile(&fixture.cache);
        let retained = fs::read_to_string(orphan.join("artifact"));
        let pending = cleanup_status(&fixture.cache);
        worker.kill().unwrap();
        worker.wait().unwrap();

        assert!(
            worker_ready,
            "new-session worker did not open temporary data"
        );
        assert!(
            release.is_ok(),
            "lease release did not clear active ownership"
        );
        assert!(active_cleanup.is_err());
        assert!(removal.is_err());
        assert_eq!(retained.unwrap(), "live");
        let item = pending
            .iter()
            .find(|item| item.cache_key == cache_key(&orphan).unwrap())
            .expect("renamed temporary data must remain visible");
        assert_eq!(item.reason, "turn-temp-owner-unverifiable");
        assert!(item.size_bytes.is_some_and(|size| size > 0));
        assert_pending_temp_cleaned(&fixture.cache, item.cleanup_token.as_deref().unwrap());
        assert!(!orphan.exists());
        assert_eq!(
            fs::read_to_string(&process_state).unwrap(),
            TEMP_PROCESS_EXPOSED
        );
        let root = pending_with_reason(&fixture.cache, "turn-temp-owner-unverifiable");
        assert_eq!(root.cache_key, cache_key(temp.parent().unwrap()).unwrap());
        assert_pending_temp_cleaned(&fixture.cache, root.cleanup_token.as_deref().unwrap());
        assert!(!process_state.exists());
    }

    #[cfg(unix)]
    #[test]
    fn held_temp_root_fd_preserves_late_child_after_quarantine() {
        use std::os::unix::process::CommandExt;

        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        let root = temp.parent().unwrap().to_path_buf();
        let ready = fixture.root.join("fd-ready");
        let trigger = fixture.root.join("create-late-child");
        let key = cache_key(&directory).unwrap();
        let quarantine = quarantine_path(&fixture.cache.join("terminal-worktrees"), &key).unwrap();
        lease.prepare_process_start().unwrap();
        let mut command = std::process::Command::new("python3");
        command
            .arg("-c")
            .arg("import os,sys,time\nfd=os.open(sys.argv[1], os.O_RDONLY|os.O_DIRECTORY)\nopen(sys.argv[2], 'w').write('ready')\nwhile not os.path.exists(sys.argv[3]): time.sleep(.01)\nos.mkdir('late', dir_fd=fd)\nchild=os.open('late', os.O_RDONLY|os.O_DIRECTORY, dir_fd=fd)\nartifact=os.open('artifact', os.O_WRONLY|os.O_CREAT, 0o600, dir_fd=child)\nos.write(artifact, b'late-write')\nos.close(artifact)\ntime.sleep(30)")
            .arg(&root)
            .arg(&ready)
            .arg(&trigger)
            .env_remove("TMPDIR");
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut worker = command.spawn().unwrap();
        lease.mark_started();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let worker_ready = ready.exists();
        if worker_ready {
            lease.release_clean().unwrap();
            fs::remove_dir_all(&temp).unwrap();
            fixture.remove(&fixture.first);
            fs::rename(&directory, &quarantine).unwrap();
            assert!(remove_quarantine(&quarantine, &key).is_err());
            fs::write(&trigger, "go").unwrap();
        }
        let artifact = quarantine.join(TEMP_ROOT).join("late/artifact");
        let artifact_deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while worker_ready && !artifact.exists() && std::time::Instant::now() < artifact_deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        let retained = fs::read_to_string(&artifact);
        retry_cleanup(&fixture.cache);
        worker.kill().unwrap();
        worker.wait().unwrap();

        assert!(worker_ready, "detached worker did not open temporary root");
        assert_eq!(retained.unwrap(), "late-write");
        assert!(quarantine.exists());
        fs::rename(&quarantine, &directory).unwrap();
        let pending = cleanup_status(&fixture.cache)
            .into_iter()
            .find(|item| item.cache_key == cache_key(&root).unwrap())
            .expect("exposed temporary root must remain pending");
        assert_eq!(pending.reason, "turn-temp-owner-unverifiable");
        assert!(pending.size_bytes.is_some_and(|size| size > 0));
        assert_pending_temp_cleaned(&fixture.cache, pending.cleanup_token.as_deref().unwrap());
        assert_storage_reclaimed_after_retry(&fixture.cache, &directory);
    }

    #[test]
    fn copied_temp_owner_marker_cannot_clear_external_exposure() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        let root = temp.parent().unwrap();
        let copied = root.join("copied");
        let process_state = process_state_path(&fixture.cache, &temp).unwrap();
        lease.prepare_process_start().unwrap();
        lease.mark_started();
        lease.release_clean().unwrap();
        fs::create_dir(&copied).unwrap();
        fs::copy(temp.join(TEMP_OWNER_FILE), copied.join(TEMP_OWNER_FILE)).unwrap();
        fs::write(copied.join("artifact"), "retain").unwrap();
        fs::remove_dir_all(&temp).unwrap();
        fixture.remove(&fixture.first);

        assert!(
            remove_after_worktree_removal(&fixture.cache, std::slice::from_ref(&directory))
                .is_err()
        );
        assert_pending_temp_cleaned(&fixture.cache, &cache_key(&copied).unwrap());
        assert_eq!(
            fs::read_to_string(&process_state).unwrap(),
            TEMP_PROCESS_EXPOSED
        );
        let pending = pending_with_reason(&fixture.cache, "turn-temp-owner-unverifiable");
        assert_eq!(pending.cache_key, cache_key(root).unwrap());
        assert_pending_temp_cleaned(&fixture.cache, pending.cleanup_token.as_deref().unwrap());
        assert!(!process_state.exists());
        assert_storage_reclaimed_after_retry(&fixture.cache, &directory);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_temp_root_is_not_used_or_reclaimed() {
        use std::os::unix::fs::symlink;

        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        let outside = fixture.root.join("outside");
        fs::create_dir_all(&outside).unwrap();
        fs::write(outside.join("sentinel"), "retain").unwrap();
        fs::remove_dir(directory.join(TEMP_ROOT)).unwrap();
        symlink(&outside, directory.join(TEMP_ROOT)).unwrap();

        assert!(register(&fixture.cache, &fixture.first).is_err());
        retry_cleanup(&fixture.cache);
        assert_eq!(
            fs::read_to_string(outside.join("sentinel")).unwrap(),
            "retain"
        );
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.reason == "turn-temp-root-unverifiable"));
    }

    #[cfg(windows)]
    #[test]
    fn removed_worktree_cleanup_accepts_windows_verbatim_common_dir_alias() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let identity = read_owner(&directory).unwrap();
        lease.mark_started();
        lease.release_clean().unwrap();
        drop(lease);
        fixture.remove(&fixture.first);

        let std_canonical = fs::canonicalize(&identity.common_dir).unwrap();
        let normalized_canonical = dunce::canonicalize(&identity.common_dir).unwrap();
        assert_eq!(normalized_canonical, identity.common_dir);
        assert!(
            std_canonical != normalized_canonical,
            "Windows std canonicalize should expose its verbatim prefix"
        );
        assert!(verify_identity_removed(&identity).unwrap());

        remove_after_worktree_removal(&fixture.cache, std::slice::from_ref(&directory)).unwrap();
        assert!(!directory.exists());
    }

    #[test]
    fn active_lease_is_reported_pending_and_retry_cleans_after_release() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.mark_started();
        fixture.remove(&fixture.first);

        let pending = retry_cleanup(&fixture.cache);

        assert!(directory.exists(), "active owner data must be retained");
        assert!(
            pending.iter().any(|item| {
                item.cache_key == directory.file_name().unwrap().to_string_lossy()
                    && item.reason == "active-use"
            }),
            "active owner should be visible in cleanup status: {pending:?}"
        );

        lease.release_clean().unwrap();
        let pending = retry_cleanup(&fixture.cache);

        assert!(
            !directory.exists(),
            "released stale data should be reclaimed; pending: {pending:?}"
        );
        assert!(!pending
            .iter()
            .any(|item| item.cache_key == directory.file_name().unwrap().to_string_lossy()));
    }

    #[test]
    fn stale_active_marker_refuses_cleanup_before_git_removal() {
        let fixture = GitFixture::new();
        let (directory, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        drop(lease);
        let marker = directory.join(".active-stale.v1");
        fs::write(&marker, "previous process").unwrap();

        let error =
            ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&directory))
                .unwrap_err();

        assert!(error.contains("not cleanly closed"), "{error}");
        assert!(fixture.first.is_dir());
        assert!(directory.is_dir());
        fs::remove_file(marker).unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&directory))
            .unwrap();
    }

    #[test]
    fn selected_storage_retry_requires_the_removed_owner_generation() {
        let fixture = GitFixture::new();
        let generation = generation(&fixture.first).unwrap();
        let (selected, selected_lease) = register(&fixture.cache, &fixture.first).unwrap();
        selected_lease.release_clean().unwrap();
        let (sibling, sibling_lease) = register(&fixture.cache, &fixture.second).unwrap();
        sibling_lease.release_clean().unwrap();
        let selected_key = selected.file_name().unwrap().to_string_lossy().into_owned();
        let sibling_key = sibling.file_name().unwrap().to_string_lossy().into_owned();

        let retry = |worktree: &Path, expected: &str, key: &str| {
            retry_selected_removed_worktree_storage(
                &fixture.cache,
                &fixture.repository,
                worktree,
                expected,
                key,
            )
        };
        assert!(retry(&fixture.first, &generation, &selected_key).is_err());
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&selected))
            .unwrap();
        fixture.remove(&fixture.first);
        assert!(retry(&fixture.second, &generation, &selected_key).is_err());
        assert!(retry(&fixture.first, "wrong-generation", &selected_key).is_err());
        assert!(retry(&fixture.first, &generation, &sibling_key).is_err());
        assert!(selected.exists());
        assert!(sibling.exists());

        retry(&fixture.first, &generation, &selected_key).unwrap();
        assert!(!selected.exists());
        assert!(sibling.exists());
    }

    #[test]
    fn selected_storage_scan_distinguishes_an_empty_cache_from_unmarked_storage() {
        let fixture = GitFixture::new();
        let generation = generation(&fixture.first).unwrap();
        fixture.remove(&fixture.first);

        assert!(selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &generation,
        )
        .unwrap()
        .is_empty());

        let retained = fixture.cache.join("terminal-worktrees").join("unmarked");
        fs::create_dir_all(&retained).unwrap();
        fs::write(retained.join("user-data"), "keep").unwrap();
        assert!(selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &generation,
        )
        .is_err());
        assert!(retained.join("user-data").exists());
    }

    #[test]
    fn selected_storage_scan_ignores_only_proven_unrelated_malformed_markers() {
        let fixture = GitFixture::new();
        let generation = generation(&fixture.first).unwrap();
        let (selected, selected_lease) = register(&fixture.cache, &fixture.first).unwrap();
        selected_lease.release_clean().unwrap();
        let (sibling, sibling_lease) = register(&fixture.cache, &fixture.second).unwrap();
        sibling_lease.release_clean().unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&selected))
            .unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&sibling))
            .unwrap();
        fixture.remove(&fixture.first);

        let sibling_key = sibling.file_name().unwrap().to_str().unwrap();
        fs::write(
            durable_cleanup_marker_path(&fixture.cache, sibling_key),
            "malformed marker",
        )
        .unwrap();
        let found = selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &generation,
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0].path, selected);
        let selected_key = selected.file_name().unwrap().to_str().unwrap();
        fs::write(
            durable_cleanup_marker_path(&fixture.cache, selected_key),
            "malformed marker",
        )
        .unwrap();
        assert!(selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &generation,
        )
        .is_err());
        assert!(selected.exists());
        assert!(sibling.exists());
    }

    #[test]
    fn selected_storage_retry_preserves_a_replacement_checkout() {
        let fixture = GitFixture::new();
        let old_generation = generation(&fixture.first).unwrap();
        let (storage, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
            .unwrap();
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
        let replacement_generation = generation(&fixture.first).unwrap();
        assert_ne!(old_generation, replacement_generation);
        let discovered = selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &old_generation,
        )
        .unwrap();
        assert_eq!(discovered.len(), 1);
        retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &old_generation,
            storage.file_name().unwrap().to_str().unwrap(),
        )
        .unwrap();
        assert!(!storage.exists());
        assert_eq!(generation(&fixture.first).unwrap(), replacement_generation);
    }

    #[test]
    fn selected_storage_retry_accepts_only_removed_nested_storage() {
        let fixture = GitFixture::new();
        let outer_generation = generation(&fixture.first).unwrap();
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
        let (storage, lease) = register(&fixture.cache, &nested).unwrap();
        lease.release_clean().unwrap();
        let key = storage.file_name().unwrap().to_string_lossy().into_owned();

        assert!(retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &outer_generation,
            &key,
        )
        .is_err());
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
            .unwrap();
        fixture.remove(&nested);
        fixture.remove(&fixture.first);
        retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &outer_generation,
            &key,
        )
        .unwrap();
        assert!(!storage.exists());
    }

    #[test]
    fn selected_storage_remains_pending_across_startup_reconciliation() {
        let fixture = GitFixture::new();
        let outer_generation = generation(&fixture.first).unwrap();
        let (storage, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
            .unwrap();
        fixture.remove(&fixture.first);

        reconcile(&fixture.cache);

        assert!(storage.exists());
        let discovered = selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &outer_generation,
        )
        .unwrap();
        assert_eq!(discovered.len(), 1);
        assert_eq!(discovered[0].path, storage);
        assert!(cleanup_status(&fixture.cache).iter().any(|item| {
            item.cache_key == storage.file_name().unwrap().to_string_lossy()
                && item.reason == "explicit-cleanup-required"
        }));
        retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &outer_generation,
            &storage.file_name().unwrap().to_string_lossy(),
        )
        .unwrap();
        assert!(!storage.exists());
    }

    #[test]
    fn exposed_temp_refuses_selected_checkout_removal_before_git() {
        let fixture = GitFixture::new();
        let (storage, lease) = register(&fixture.cache, &fixture.first).unwrap();
        let artifact = lease.temp_directory().join("selected-artifact");
        fs::write(&artifact, "selected").unwrap();
        lease.prepare_process_start().unwrap();
        lease.mark_started();
        lease.release_clean().unwrap();

        let error =
            ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
                .unwrap_err();

        assert!(error.contains("temporary data"), "{error}");
        assert!(fixture.first.is_dir());
        assert_eq!(fs::read_to_string(&artifact).unwrap(), "selected");
        assert!(!has_explicit_cleanup_marker(&storage).unwrap());
    }

    #[test]
    fn selected_storage_retry_keeps_exposed_temp_pending() {
        let fixture = GitFixture::new();
        let expected_generation = generation(&fixture.first).unwrap();
        let (storage, initial_lease) = register(&fixture.cache, &fixture.first).unwrap();
        initial_lease.release_clean().unwrap();

        let (_, sibling_lease) = register(&fixture.cache, &fixture.second).unwrap();
        let sibling_artifact = sibling_lease.temp_directory().join("sibling-artifact");
        fs::write(&sibling_artifact, "keep").unwrap();
        sibling_lease.prepare_process_start().unwrap();
        sibling_lease.mark_started();
        sibling_lease.release_clean().unwrap();

        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
            .unwrap();
        let (same_storage, lease) = register(&fixture.cache, &fixture.first).unwrap();
        assert_eq!(same_storage, storage);
        let selected_artifact = lease.temp_directory().join("selected-artifact");
        fs::write(&selected_artifact, "selected").unwrap();
        lease.prepare_process_start().unwrap();
        lease.mark_started();
        lease.release_clean().unwrap();
        fixture.remove(&fixture.first);
        assert!(
            remove_after_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
                .unwrap_err()
                .contains("temporary data")
        );
        assert_eq!(fs::read_to_string(&selected_artifact).unwrap(), "selected");

        let error = retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &expected_generation,
            storage.file_name().unwrap().to_str().unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("temporary data"), "{error}");
        assert!(storage.exists());
        assert_eq!(fs::read_to_string(&selected_artifact).unwrap(), "selected");
        let pending = cleanup_status(&fixture.cache);
        let expected_owner = stable_worktree_identity(&fixture.first);
        assert!(
            pending.iter().any(|item| {
                item.path.as_deref().is_some_and(|path| {
                    fs::read_to_string(Path::new(path).join("selected-artifact"))
                        .ok()
                        .as_deref()
                        == Some("selected")
                }) && item.owner_path.as_deref() == expected_owner.to_str()
            }),
            "{pending:?}"
        );
        assert_eq!(fs::read_to_string(sibling_artifact).unwrap(), "keep");
    }

    #[test]
    fn selected_quarantine_remains_visible_and_retryable_after_interruption() {
        let fixture = GitFixture::new();
        let outer_generation = generation(&fixture.first).unwrap();
        let (storage, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
            .unwrap();
        fixture.remove(&fixture.first);
        let quarantine_key = cache_key(&storage).unwrap();
        let recovery = quarantine_path(storage.parent().unwrap(), &quarantine_key).unwrap();
        fs::rename(&storage, &recovery).unwrap();
        fs::remove_file(recovery.join(EXPLICIT_CLEANUP_MARKER)).unwrap();

        reconcile(&fixture.cache);

        assert!(recovery.exists());
        assert!(cleanup_status(&fixture.cache).iter().any(|item| {
            item.cache_key == recovery.file_name().unwrap().to_string_lossy()
                && item.reason == "explicit-cleanup-required"
        }));
        let retained =
            retained_selected_storage_locations(&fixture.cache, std::slice::from_ref(&storage))
                .unwrap();
        assert_eq!(
            retained,
            vec![(
                storage.file_name().unwrap().to_string_lossy().into_owned(),
                recovery.clone()
            )]
        );
        retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &outer_generation,
            &storage.file_name().unwrap().to_string_lossy(),
        )
        .unwrap();
        assert!(!recovery.exists());
    }

    #[test]
    fn selected_quarantine_with_partially_deleted_owner_is_retryable() {
        let fixture = GitFixture::new();
        let expected_generation = generation(&fixture.first).unwrap();
        let (storage, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
            .unwrap();
        fixture.remove(&fixture.first);
        let key = cache_key(&storage).unwrap();
        let recovery = quarantine_path(storage.parent().unwrap(), &key).unwrap();
        fs::rename(&storage, &recovery).unwrap();
        fs::remove_file(recovery.join(OWNER_FILE)).unwrap();
        fs::write(
            recovery.join("retained-artifact"),
            "kept until explicit retry",
        )
        .unwrap();

        reconcile(&fixture.cache);
        let discovered = selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &expected_generation,
        )
        .unwrap();
        assert_eq!(discovered.len(), 1);
        assert_eq!(
            discovered[0].cache_key,
            storage.file_name().unwrap().to_string_lossy()
        );
        assert_eq!(discovered[0].path, recovery);
        assert!(discovered[0].size_bytes.is_some_and(|size| size > 0));
        assert_eq!(
            fs::read_to_string(recovery.join("retained-artifact")).unwrap(),
            "kept until explicit retry"
        );
        retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &expected_generation,
            storage.file_name().unwrap().to_str().unwrap(),
        )
        .unwrap();
        assert!(!recovery.exists());
    }

    #[test]
    fn selected_retry_keeps_a_replaced_quarantine_directory() {
        let fixture = GitFixture::new();
        let expected_generation = generation(&fixture.first).unwrap();
        let (storage, lease) = register(&fixture.cache, &fixture.first).unwrap();
        lease.release_clean().unwrap();
        ensure_ready_before_worktree_removal(&fixture.cache, std::slice::from_ref(&storage))
            .unwrap();
        fixture.remove(&fixture.first);
        let key = cache_key(&storage).unwrap();
        let recovery = quarantine_path(storage.parent().unwrap(), &key).unwrap();
        let unrelated = fixture.root.join("unrelated-recovery");
        fs::create_dir(&unrelated).unwrap();
        fs::write(unrelated.join("unrelated"), "keep").unwrap();
        fs::rename(&storage, &recovery).unwrap();
        fs::remove_dir_all(&recovery).unwrap();
        fs::rename(&unrelated, &recovery).unwrap();

        assert!(selected_removed_storage_locations(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &expected_generation,
        )
        .unwrap()
        .is_empty());
        let error = retry_selected_removed_worktree_storage(
            &fixture.cache,
            &fixture.repository,
            &fixture.first,
            &expected_generation,
            storage.file_name().unwrap().to_str().unwrap(),
        )
        .unwrap_err();
        assert!(error.contains("directory changed"), "{error}");
        assert_eq!(
            fs::read_to_string(recovery.join("unrelated")).unwrap(),
            "keep"
        );
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
        pending_with_reason(&fixture.cache, "unclean-active-use");

        pending_with_reason(&fixture.cache, "unclean-active-use");
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
        pending_with_reason(&fixture.cache, "git-worktree-registration-still-present");
    }

    #[test]
    fn reused_worktree_path_gets_a_separate_generation_and_keeps_old_data() {
        let fixture = GitFixture::new();
        let (old_directory, old_lease) = register(&fixture.cache, &fixture.first).unwrap();
        let old_generation = generation(&fixture.first).unwrap();
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
        let new_generation = generation(&fixture.first).unwrap();

        assert_ne!(old_directory, new_directory);
        assert_ne!(old_generation, new_generation);
        reconcile(&fixture.cache);
        assert!(old_directory.exists());
        assert!(new_directory.exists());
        assert!(cleanup_status(&fixture.cache)
            .iter()
            .any(|item| item.cache_key == old_directory.file_name().unwrap().to_string_lossy()));
        new_lease.release_clean().unwrap();
    }

    #[test]
    fn explicit_cleanup_selects_only_the_current_generation_at_a_reused_path() {
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
        new_lease.release_clean().unwrap();

        assert_ne!(old_directory, new_directory);
        assert_eq!(
            data_directory_for_root(&fixture.cache, &fixture.first),
            Some(new_directory.clone())
        );
        let selected = discover_data_directories(&fixture.cache, &fixture.first);
        assert_eq!(selected, vec![new_directory.clone()]);
        fixture.remove(&fixture.first);
        remove_after_worktree_removal(&fixture.cache, &selected).unwrap();

        assert!(!new_directory.exists());
        assert!(old_directory.exists());
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

        assert!(
            !first_directory.exists(),
            "reconciliation left removed worktree storage: {:?}",
            cleanup_status(&fixture.cache)
        );
        assert!(second_directory.exists());
        second_lease.release_clean().unwrap();
    }

    #[test]
    fn active_sibling_registered_first_does_not_block_removed_worktree_cleanup() {
        let fixture = GitFixture::new();
        let (active_directory, active_lease) = register(&fixture.cache, &fixture.second).unwrap();
        let (removed_directory, removed_lease) = register(&fixture.cache, &fixture.first).unwrap();
        removed_lease.release_clean().unwrap();
        drop(removed_lease);
        fixture.remove(&fixture.first);

        reconcile(&fixture.cache);

        assert!(
            !removed_directory.exists(),
            "active sibling prevented cleanup: {:?}",
            cleanup_status(&fixture.cache)
        );
        assert!(active_directory.exists());
        active_lease.release_clean().unwrap();
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
        pending_with_reason(&fixture.cache, "git-common-dir-missing-or-unreadable");
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
