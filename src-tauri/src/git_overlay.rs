use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};

const VERSION: u8 = 1;
const REF_LOCK_TIMEOUT_MS: &str = "5000";
static ACTIVE: OnceLock<Mutex<Vec<(PathBuf, PathBuf, PathBuf)>>> = OnceLock::new();
static CACHE: OnceLock<PathBuf> = OnceLock::new();

fn git_config_path(path: &Path) -> OsString {
    #[cfg(windows)]
    {
        // canonicalize() adds the verbatim prefix, which Git for Windows rejects
        // in include.path and the objects/info/alternates text file.
        let path = path.to_string_lossy();
        let path = if let Some(unc) = path.strip_prefix("\\\\?\\UNC\\") {
            format!("\\\\{unc}")
        } else if let Some(local) = path.strip_prefix("\\\\?\\") {
            local.to_string()
        } else {
            path.into_owned()
        };
        OsString::from(path.replace('\\', "/"))
    }
    #[cfg(not(windows))]
    {
        path.as_os_str().to_os_string()
    }
}

fn git_config_quoted_path(path: &Path) -> Result<String, String> {
    let path = git_config_path(path)
        .into_string()
        .map_err(|_| "Git config path is not valid UTF-8.".to_string())?;
    Ok(format!(
        "\"{}\"",
        path.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}

#[cfg(windows)]
fn durable_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::{
        MoveFileExW, MOVEFILE_REPLACE_EXISTING, MOVEFILE_WRITE_THROUGH,
    };

    let source = crate::extended_windows_path(source)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = crate::extended_windows_path(destination)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let flags = MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH;
    if unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), flags) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(not(windows))]
fn durable_rename(source: &Path, destination: &Path) -> std::io::Result<()> {
    fs::rename(source, destination)
}

#[cfg(windows)]
fn sync_renamed_parent(_path: &Path) -> std::io::Result<()> {
    // Windows cannot open directories through File::open. MoveFileExW with
    // MOVEFILE_WRITE_THROUGH flushes each rename before it returns.
    Ok(())
}

#[cfg(not(windows))]
fn sync_renamed_parent(path: &Path) -> std::io::Result<()> {
    File::open(path)?.sync_all()
}

fn register(worktree: &Path, git_dir: &Path, source_git_dir: &Path) {
    let entries = ACTIVE.get_or_init(|| Mutex::new(Vec::new()));
    if let Ok(mut entries) = entries.lock() {
        entries.retain(|(root, _, _)| root != worktree);
        entries.push((
            worktree.to_path_buf(),
            git_dir.to_path_buf(),
            source_git_dir.to_path_buf(),
        ));
    }
}

pub(crate) fn registered_paths(directory: &Path) -> Option<(PathBuf, PathBuf)> {
    let directory = dunce::canonicalize(directory).ok()?;
    ACTIVE
        .get()?
        .lock()
        .ok()?
        .iter()
        .filter(|(root, git_dir, source_git_dir)| {
            directory.starts_with(root)
                && source(root).ok().flatten().is_some_and(|current| {
                    current.git_dir == *source_git_dir
                        && validate_overlay(git_dir, &current.common_dir).is_ok()
                })
        })
        .max_by_key(|(root, _, _)| root.components().count())
        .map(|(root, git_dir, _)| (root.clone(), git_dir.clone()))
}

pub(crate) fn registered_directory(directory: &Path) -> Option<PathBuf> {
    registered_paths(directory).map(|(_, git_dir)| git_dir)
}

pub(crate) fn index_differs(directory: &Path) -> Option<bool> {
    let directory = dunce::canonicalize(directory).ok()?;
    let entries = ACTIVE.get()?.lock().ok()?;
    let (_, private, source) = entries
        .iter()
        .filter(|(root, _, _)| directory.starts_with(root))
        .max_by_key(|(root, _, _)| root.components().count())?;
    let private_index = fs::read(private.join("index")).ok();
    let source_index = fs::read(source.join("index")).ok();
    Some(private_index != source_index)
}

pub(crate) fn known_worktree(directory: &Path) -> Option<PathBuf> {
    let directory = dunce::canonicalize(directory).ok()?;
    if let Some(root) = ACTIVE
        .get()
        .and_then(|entries| entries.lock().ok())
        .and_then(|entries| {
            entries
                .iter()
                .filter(|(root, _, _)| directory.starts_with(root))
                .max_by_key(|(root, _, _)| root.components().count())
                .map(|(root, _, _)| root.clone())
        })
    {
        return Some(root);
    }
    known_worktree_in_cache(CACHE.get()?, &directory)
}

fn known_worktree_in_cache(cache: &Path, directory: &Path) -> Option<PathBuf> {
    directory.ancestors().find_map(|root| {
        let (git_dir, manifest, _) = paths(cache, root);
        let present = |path: &Path| fs::symlink_metadata(path).is_ok();
        (present(&git_dir) || present(&manifest) || present(&manifest.with_extension("bak")))
            .then(|| root.to_path_buf())
    })
}

pub(crate) fn initialize(cache: &Path) {
    let _ = CACHE.set(cache.to_path_buf());
    let directory = cache.join("git-overlay-manifests");
    let Ok(entries) = fs::read_dir(directory) else {
        return;
    };
    for entry in entries.flatten() {
        let Ok(contents) = fs::read(entry.path()) else {
            continue;
        };
        let Ok(manifest) = serde_json::from_slice::<Manifest>(&contents) else {
            continue;
        };
        if let Ok(Some(overlay)) = GitOverlay::existing(cache, &manifest.worktree) {
            register(
                &overlay.worktree,
                &overlay.git_dir,
                &overlay.manifest.source_git_dir,
            );
        }
    }
}

pub(crate) fn require_shared_current(worktree: &Path) -> Result<(), String> {
    let worktree = dunce::canonicalize(worktree).map_err(|error| error.to_string())?;
    let Some(cache) = CACHE.get() else {
        return if known_worktree(&worktree).is_some() {
            Err(
                "Private Git state is registered without its cache; shared Git operation refused."
                    .into(),
            )
        } else {
            Ok(())
        };
    };
    require_shared_current_in_cache(cache, &worktree)
}

pub(crate) fn require_no_private_state_at_missing(worktree: &Path) -> Result<(), String> {
    let root = crate::acp_terminal::stable_worktree_identity(worktree);
    if ACTIVE
        .get()
        .and_then(|entries| entries.lock().ok())
        .is_some_and(|entries| entries.iter().any(|(registered, _, _)| registered == &root))
    {
        return Err("Missing worktree has private Git state; cleanup requires recovery.".into());
    }
    if let Some(cache) = CACHE.get() {
        let (private, manifest, _) = paths(cache, &root);
        if [private, manifest.clone(), manifest.with_extension("bak")]
            .iter()
            .any(|path| fs::symlink_metadata(path).is_ok())
        {
            return Err(
                "Missing worktree has private Git state; cleanup requires recovery.".into(),
            );
        }
    }
    Ok(())
}

pub(crate) fn removed_worktree_overlay_absent(worktree: &Path) -> Result<bool, String> {
    let root = crate::acp_terminal::stable_worktree_identity(worktree);
    let cache = CACHE
        .get()
        .ok_or("Private Git cache is unavailable for cleanup verification.")?;
    if let Some(entries) = ACTIVE.get() {
        if entries
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .any(|(owner, _, _)| owner == &root)
        {
            return Ok(false);
        }
    }
    let (private, manifest, _) = paths(cache, &root);
    for path in [private, manifest.clone(), manifest.with_extension("bak")] {
        match fs::symlink_metadata(&path) {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(format!("Cannot verify private Git state: {error}")),
        }
    }
    Ok(true)
}

/// A staged checkout can still own a synchronized overlay keyed to its old path.
/// Keep that overlay in place so it becomes usable again after the Git move.
pub(crate) fn require_recoverable_private_state_at_missing(
    original: &Path,
    recovery: &Path,
) -> Result<(), String> {
    let root = crate::acp_terminal::stable_worktree_identity(original);
    let Some(cache) = CACHE.get() else {
        return require_no_private_state_at_missing(&root);
    };
    require_recoverable_private_state_at_missing_in_cache(cache, &root, recovery)
}

fn require_recoverable_private_state_at_missing_in_cache(
    cache: &Path,
    original: &Path,
    recovery: &Path,
) -> Result<(), String> {
    let root = crate::acp_terminal::stable_worktree_identity(original);
    let (private, manifest_path, _) = paths(cache, &root);
    let present = |path: &Path| fs::symlink_metadata(path).is_ok();
    if !present(&private)
        && !present(&manifest_path)
        && !present(&manifest_path.with_extension("bak"))
    {
        return require_no_private_state_at_missing(&root);
    }
    let manifest = read_manifest(&manifest_path)?
        .ok_or("Missing worktree has incomplete private Git state; recovery refused.")?;
    if manifest.version != VERSION || manifest.worktree != root || manifest.promotion.is_some() {
        return Err("Missing worktree has private Git state that requires recovery.".into());
    }
    let current = source(recovery)?.ok_or("Recovery checkout is not a linked Git worktree.")?;
    if manifest.source_git_dir != current.git_dir
        || manifest.common_dir != current.common_dir
        || manifest.branch != current.branch
        || manifest.promoted_oid != current.head
        || index_hash(&current.git_dir.join("index"))? != manifest.source_index_hash
    {
        return Err("Recovery checkout does not match the original private Git state.".into());
    }
    validate_overlay(&private, &current.common_dir)?;
    let head = output(
        git_command()
            .arg("--git-dir")
            .arg(git_config_path(&private))
            .args(["rev-parse", "--verify", "HEAD^{commit}"]),
    )?;
    if String::from_utf8_lossy(&head.stdout).trim() != manifest.promoted_oid
        || index_hash(&private.join("index"))? != manifest.source_index_hash
    {
        return Err("Recovery checkout has unpromoted private Git changes.".into());
    }
    Ok(())
}

pub(crate) fn forget_removed_worktree(worktree: &Path) -> Result<(), String> {
    let root = crate::acp_terminal::stable_worktree_identity(worktree);
    let Some(cache) = CACHE.get() else {
        if known_worktree(&root).is_some() {
            return Err("Private Git cache is unavailable after worktree deletion.".into());
        }
        return Ok(());
    };
    forget_removed_worktree_in_cache(cache, &root)
}

pub(crate) fn forget_removed_worktree_for_repository(
    worktree: &Path,
    repository: &Path,
) -> Result<(), String> {
    let result = output(
        git_command()
            .arg("-C")
            .arg(repository)
            .args(["rev-parse", "--git-common-dir"]),
    )?;
    let common = String::from_utf8(result.stdout).map_err(|error| error.to_string())?;
    let common = Path::new(common.trim());
    let common = dunce::canonicalize(if common.is_absolute() {
        common.to_path_buf()
    } else {
        repository.join(common)
    })
    .map_err(|error| error.to_string())?;
    let cache = CACHE
        .get()
        .ok_or("Private Git cache is unavailable for selected cleanup.")?;
    forget_removed_worktree_in_cache_checked(cache, worktree, Some(&common))
}

fn forget_removed_worktree_in_cache(cache: &Path, worktree: &Path) -> Result<(), String> {
    forget_removed_worktree_in_cache_checked(cache, worktree, None)
}

fn forget_removed_worktree_in_cache_checked(
    cache: &Path,
    worktree: &Path,
    expected_common: Option<&Path>,
) -> Result<(), String> {
    let root = crate::acp_terminal::stable_worktree_identity(worktree);
    if root.exists() {
        return Err("Removed worktree path was recreated before private Git cleanup.".into());
    }
    let (private, manifest_path, lock_path) = paths(cache, &root);
    let present = |path: &Path| fs::symlink_metadata(path).is_ok();
    if !present(&private)
        && !present(&manifest_path)
        && !present(&manifest_path.with_extension("bak"))
    {
        if let Some(entries) = ACTIVE.get() {
            entries
                .lock()
                .map_err(|error| error.to_string())?
                .retain(|(owner, _, _)| owner != &root);
        }
        return Ok(());
    }
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(lock_path)
        .map_err(|error| error.to_string())?;
    lock.lock().map_err(|error| error.to_string())?;
    if root.exists() {
        return Err("Removed worktree path was recreated during private Git cleanup.".into());
    }
    let mut manifest = read_manifest(&manifest_path)?
        .ok_or("Removed worktree has unregistered private Git state.")?;
    if manifest.version != VERSION || manifest.worktree != root || manifest.promotion.is_some() {
        return Err("Removed worktree private Git state requires recovery.".into());
    }
    if expected_common.is_some_and(|common| manifest.common_dir.as_path() != common) {
        return Err("Removed worktree private Git state belongs to another repository.".into());
    }
    let backup = manifest_path.with_extension("bak");
    if present(&backup) {
        let previous: Manifest =
            serde_json::from_slice(&fs::read(&backup).map_err(|error| error.to_string())?)
                .map_err(|error| format!("Cannot verify previous overlay manifest: {error}"))?;
        if previous.version != manifest.version
            || previous.worktree != manifest.worktree
            || previous.source_git_dir != manifest.source_git_dir
            || previous.common_dir != manifest.common_dir
        {
            return Err("Overlay manifest backup belongs to another worktree.".into());
        }
    }
    // A prior removal may have deleted only part of this directory. Its
    // remaining contents cannot be distinguished from a replacement on retry.
    if manifest.removing && present(&private) {
        return Err(format!(
            "Interrupted private Git cleanup retained unverifiable data at {}. Leave it pending for separate recovery.",
            private.display()
        ));
    }
    if !manifest.removing && present(&private) {
        validate_overlay(&private, &manifest.common_dir)?;
        let head = output(
            git_command()
                .arg("--git-dir")
                .arg(git_config_path(&private))
                .args(["rev-parse", "--verify", "HEAD^{commit}"]),
        )?;
        if String::from_utf8_lossy(&head.stdout).trim() != manifest.promoted_oid
            || index_hash(&private.join("index"))? != manifest.source_index_hash
        {
            return Err("Removed worktree has unpromoted private Git changes.".into());
        }
        manifest.removing = true;
        write_manifest(&manifest_path, &manifest)?;
    }
    match fs::remove_dir_all(&private) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.to_string()),
    }
    fs::remove_file(&manifest_path).map_err(|error| error.to_string())?;
    if present(&backup) {
        fs::remove_file(&backup).map_err(|error| error.to_string())?;
    }
    if let Some(entries) = ACTIVE.get() {
        entries
            .lock()
            .map_err(|error| error.to_string())?
            .retain(|(owner, _, _)| owner != &root);
    }
    Ok(())
}

fn require_shared_current_in_cache(cache: &Path, worktree: &Path) -> Result<(), String> {
    fn read_regular_index(path: &Path) -> Result<Option<Vec<u8>>, String> {
        let metadata = match fs::symlink_metadata(path) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.to_string()),
        };
        if !metadata.file_type().is_file() {
            return Err("Git index is not a regular file; shared Git operation refused.".into());
        }
        fs::read(path).map(Some).map_err(|error| error.to_string())
    }
    let (private, manifest, _) = paths(cache, worktree);
    let present = |path: &Path| fs::symlink_metadata(path).is_ok();
    let has_overlay =
        present(&private) || present(&manifest) || present(&manifest.with_extension("bak"));
    if !has_overlay {
        return Ok(());
    }
    let overlay = GitOverlay::existing(cache, worktree)?
        .ok_or("Private Git state is incomplete; shared Git operation refused.")?;
    let current = source(worktree)?.ok_or("Assigned linked worktree is unavailable.")?;
    if overlay.manifest.promotion.is_some() || current.head != overlay.manifest.promoted_oid {
        return Err("Private Git promotion is pending; shared Git operation refused.".into());
    }
    let branch = output(
        git_command()
            .arg("--git-dir")
            .arg(git_config_path(&overlay.git_dir))
            .args(["symbolic-ref", "-q", "HEAD"]),
    )?;
    if String::from_utf8_lossy(&branch.stdout).trim() != overlay.manifest.branch {
        return Err("Private Git branch changed; shared Git operation refused.".into());
    }
    let head = output(
        git_command()
            .arg("--git-dir")
            .arg(git_config_path(&overlay.git_dir))
            .args(["rev-parse", "--verify", "HEAD^{commit}"]),
    )?;
    if String::from_utf8_lossy(&head.stdout).trim() != current.head {
        return Err("Private Git commits are pending; shared Git operation refused.".into());
    }
    if read_regular_index(&overlay.git_dir.join("index"))?
        != read_regular_index(&current.git_dir.join("index"))?
    {
        return Err("Private Git index changes are pending; shared Git operation refused.".into());
    }
    Ok(())
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Manifest {
    version: u8,
    worktree: PathBuf,
    source_git_dir: PathBuf,
    common_dir: PathBuf,
    branch: String,
    promoted_oid: String,
    source_index_hash: Option<String>,
    promotion: Option<Promotion>,
    #[serde(default)]
    removing: bool,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct Promotion {
    expected_oid: String,
    new_oid: String,
    new_index_hash: String,
    index_backup: String,
}

#[derive(Clone, Debug)]
pub(crate) struct GitOverlay {
    pub(crate) git_dir: PathBuf,
    pub(crate) worktree: PathBuf,
    manifest_path: PathBuf,
    manifest: Manifest,
}

struct Source {
    worktree: PathBuf,
    git_dir: PathBuf,
    common_dir: PathBuf,
    branch: String,
    head: String,
}

fn git_command() -> Command {
    let mut command = Command::new("git");
    for key in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
    ] {
        command.env_remove(key);
    }
    command.args(["-c", "core.filesRefLockTimeout=5000"]);
    #[cfg(windows)]
    command.args(["-c", "core.longpaths=true"]);
    command
}

struct OverlayBuild(PathBuf);

impl Drop for OverlayBuild {
    fn drop(&mut self) {
        if let Err(error) = fs::remove_dir_all(&self.0) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "Cannot clean up Git overlay build {}: {error}",
                    self.0.display()
                );
            }
        }
    }
}

fn output(command: &mut Command) -> Result<Output, String> {
    let result = command.output().map_err(|error| error.to_string())?;
    if result.status.success() {
        Ok(result)
    } else {
        Err(String::from_utf8_lossy(&result.stderr).trim().to_string())
    }
}

fn source(worktree: &Path) -> Result<Option<Source>, String> {
    let worktree = dunce::canonicalize(worktree).map_err(|error| error.to_string())?;
    let pointer = worktree.join(".git");
    if !fs::symlink_metadata(&pointer).is_ok_and(|metadata| metadata.file_type().is_file()) {
        return Ok(None);
    }
    let result = output(git_command().arg("-C").arg(&worktree).args([
        "rev-parse",
        "--show-toplevel",
        "--git-dir",
        "--git-common-dir",
    ]))?;
    let stdout = String::from_utf8(result.stdout).map_err(|error| error.to_string())?;
    let mut paths = stdout.lines();
    let top = dunce::canonicalize(Path::new(paths.next().ok_or("Missing Git worktree root.")?))
        .map_err(|error| error.to_string())?;
    if top != worktree {
        return Ok(None);
    }
    let resolve = |value: &str| {
        let path = Path::new(value);
        if path.is_absolute() {
            path.canonicalize()
        } else {
            worktree.join(path).canonicalize()
        }
        .map_err(|error| error.to_string())
    };
    let git_dir = resolve(paths.next().ok_or("Missing linked Git directory.")?)?;
    let common_dir = resolve(paths.next().ok_or("Missing common Git directory.")?)?;
    if git_dir == common_dir || !git_dir.starts_with(common_dir.join("worktrees")) {
        return Ok(None);
    }
    let backlink = fs::read_to_string(git_dir.join("gitdir")).map_err(|error| error.to_string())?;
    let backlink = Path::new(backlink.trim());
    let backlink = if backlink.is_absolute() {
        backlink.to_path_buf()
    } else {
        git_dir.join(backlink)
    };
    if dunce::canonicalize(&backlink).map_err(|error| error.to_string())? != pointer {
        return Err("Linked Git directory belongs to another worktree.".into());
    }
    let branch = git_command()
        .arg("-C")
        .arg(&worktree)
        .args(["symbolic-ref", "-q", "HEAD"])
        .output()
        .map_err(|error| error.to_string())?;
    if branch.status.code() == Some(1) && branch.stderr.is_empty() {
        // A detached linked worktree has no branch to isolate in a Git overlay.
        return Ok(None);
    }
    if !branch.status.success() {
        return Err(String::from_utf8_lossy(&branch.stderr).trim().to_string());
    }
    let branch = String::from_utf8(branch.stdout).map_err(|error| error.to_string())?;
    let branch = branch.trim().to_string();
    if !branch.starts_with("refs/heads/") {
        return Err("Assigned worktree has no branch reference.".into());
    }
    let head = output(git_command().arg("-C").arg(&worktree).args([
        "rev-parse",
        "--verify",
        "HEAD^{commit}",
    ]))?;
    let head = String::from_utf8(head.stdout).map_err(|error| error.to_string())?;
    Ok(Some(Source {
        worktree,
        git_dir,
        common_dir,
        branch,
        head: head.trim().to_string(),
    }))
}

fn paths(cache: &Path, worktree: &Path) -> (PathBuf, PathBuf, PathBuf) {
    let identity = crate::acp_terminal::worktree_data_directory(cache, worktree);
    let key = identity.file_name().unwrap_or_default();
    (
        cache.join("git-overlays").join(key),
        cache
            .join("git-overlay-manifests")
            .join(key)
            .with_extension("json"),
        cache.join("git-overlay-locks").join(key),
    )
}

fn reject_links(path: &Path) -> Result<(), String> {
    let metadata = fs::symlink_metadata(path).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Git overlay contains a symbolic link: {}",
            path.display()
        ));
    }
    if metadata.is_dir() {
        for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
            reject_links(&entry.map_err(|error| error.to_string())?.path())?;
        }
    }
    Ok(())
}

fn validate_overlay(git_dir: &Path, common_dir: &Path) -> Result<(), String> {
    reject_links(git_dir)?;
    let alternates = fs::read_to_string(git_dir.join("objects/info/alternates"))
        .map_err(|error| format!("Cannot read private Git object alternates: {error}"))?;
    let expected = common_dir.join("objects");
    if alternates.trim_end() != git_config_path(&expected).to_string_lossy() {
        return Err("Private Git object alternates changed; overlay requires recovery.".into());
    }
    Ok(())
}

fn index_hash(path: &Path) -> Result<Option<String>, String> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    if !metadata.file_type().is_file() {
        return Err("Git index path is not a regular file.".into());
    }
    let digest = Sha256::digest(fs::read(path).map_err(|error| error.to_string())?);
    Ok(Some(
        digest.iter().map(|byte| format!("{byte:02x}")).collect(),
    ))
}

fn shared_index_path(command: &mut Command) -> Result<Option<PathBuf>, String> {
    // rev-parse hides an existing link when core.splitIndex=false and returns an
    // all-zero placeholder when the setting is true but the index is full.
    let result = output(command.args([
        "-c",
        "core.splitIndex=true",
        "rev-parse",
        "--shared-index-path",
    ]))?;
    let path = String::from_utf8(result.stdout).map_err(|error| error.to_string())?;
    let path = path.trim();
    let path = PathBuf::from(path);
    if path.as_os_str().is_empty()
        || path
            .file_name()
            .is_some_and(|name| name == "sharedindex.0000000000000000000000000000000000000000")
    {
        Ok(None)
    } else {
        Ok(Some(path))
    }
}

fn copy_source_shared_index(current: &Source, private_git_dir: &Path) -> Result<bool, String> {
    let Some(path) = shared_index_path(git_command().arg("-C").arg(&current.worktree))? else {
        return Ok(false);
    };
    let path = if path.is_absolute() {
        path
    } else {
        current.worktree.join(path)
    };
    let metadata = fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.file_type().is_file() {
        return Err("Assigned shared index is not a regular file.".into());
    }
    let canonical = path.canonicalize().map_err(|error| error.to_string())?;
    let name = canonical
        .file_name()
        .ok_or("Assigned shared index has no file name.")?;
    if canonical.parent() != Some(current.git_dir.as_path())
        || !name.to_string_lossy().starts_with("sharedindex.")
    {
        return Err("Assigned shared index is outside its linked Git directory.".into());
    }
    let contents = fs::read(&canonical).map_err(|error| error.to_string())?;
    fs::write(private_git_dir.join(name), &contents).map_err(|error| error.to_string())?;
    if fs::read(&canonical).map_err(|error| error.to_string())? != contents {
        return Err("Assigned shared index changed during private copy.".into());
    }
    Ok(true)
}

fn replace_index(
    source: &Path,
    private: &Path,
    expected: Option<&str>,
    replacement: &str,
    backup_name: &str,
) -> Result<(), String> {
    struct OwnedIndexLock(Option<PathBuf>);
    impl Drop for OwnedIndexLock {
        fn drop(&mut self) {
            if let Some(path) = &self.0 {
                let _ = fs::remove_file(path);
            }
        }
    }
    if !backup_name.starts_with("index.sail-overlay-")
        || !backup_name.ends_with(".backup")
        || Path::new(backup_name).components().count() != 1
    {
        return Err("Invalid journaled index backup name.".into());
    }
    let backup = source
        .parent()
        .ok_or("Invalid linked index path.")?
        .join(backup_name);
    // Git writers honor index.lock. Holding it through the final rename keeps
    // an external git add from replacing the index after our comparison.
    let lock_path = source.with_extension("lock");
    let mut locked_index = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock_path)
        .map_err(|error| format!("Assigned index is locked; promotion refused: {error}"))?;
    let mut owned_lock = OwnedIndexLock(Some(lock_path.clone()));
    if backup.exists() && index_hash(&backup)?.as_deref() != expected {
        return Err(
            "Journaled index backup differs from the source snapshot; recovery required.".into(),
        );
    }
    if !source.exists() && backup.exists() {
        durable_rename(&backup, source).map_err(|error| error.to_string())?;
    }
    let current = index_hash(source)?;
    if current.as_deref() == Some(replacement) {
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        return Ok(());
    }
    if current.as_deref() != expected {
        return Err("Assigned index changed outside the task; promotion refused.".into());
    }
    if index_hash(private)?.as_deref() != Some(replacement) {
        return Err("Private index changed during promotion; recovery required.".into());
    }
    let mut input = File::open(private).map_err(|error| error.to_string())?;
    std::io::copy(&mut input, &mut locked_index).map_err(|error| error.to_string())?;
    locked_index.sync_all().map_err(|error| error.to_string())?;
    drop(locked_index);
    // Detect direct index writers that ignore Git's lock convention.
    if index_hash(source)?.as_deref() != expected {
        return Err("Assigned index changed during promotion; promotion refused.".into());
    }
    if source.exists() && !backup.exists() {
        let mut snapshot = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&backup)
            .map_err(|error| error.to_string())?;
        let mut original = File::open(source).map_err(|error| error.to_string())?;
        std::io::copy(&mut original, &mut snapshot).map_err(|error| error.to_string())?;
        snapshot.sync_all().map_err(|error| error.to_string())?;
        if index_hash(&backup)?.as_deref() != expected {
            return Err("Assigned index changed while backing up; promotion refused.".into());
        }
    }
    durable_rename(&lock_path, source).map_err(|error| error.to_string())?;
    owned_lock.0 = None;
    sync_renamed_parent(source.parent().ok_or("Invalid linked index path.")?)
        .map_err(|error| error.to_string())?;
    if backup.exists() {
        fs::remove_file(backup).map_err(|error| error.to_string())?;
    }
    Ok(())
}

fn write_manifest(path: &Path, manifest: &Manifest) -> Result<(), String> {
    fs::create_dir_all(path.parent().ok_or("Invalid overlay manifest path.")?)
        .map_err(|error| error.to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let backup = path.with_extension("bak");
    let write = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        let contents = serde_json::to_vec(manifest).map_err(|error| error.to_string())?;
        file.write_all(&contents)
            .and_then(|_| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        if path.exists() {
            if backup.exists() {
                let prior: Manifest =
                    serde_json::from_slice(&fs::read(&backup).map_err(|error| error.to_string())?)
                        .map_err(|error| {
                            format!("Cannot verify previous overlay manifest: {error}")
                        })?;
                if prior.version != manifest.version
                    || prior.worktree != manifest.worktree
                    || prior.source_git_dir != manifest.source_git_dir
                    || prior.common_dir != manifest.common_dir
                {
                    return Err("Overlay manifest backup belongs to another worktree.".into());
                }
                fs::remove_file(&backup).map_err(|error| error.to_string())?;
            }
            durable_rename(path, &backup).map_err(|error| error.to_string())?;
        }
        if let Err(error) = durable_rename(&temporary, path) {
            if backup.exists() {
                let _ = durable_rename(&backup, path);
            }
            return Err(error.to_string());
        }
        sync_renamed_parent(path.parent().ok_or("Invalid overlay manifest path.")?)
            .map_err(|error| error.to_string())?;
        if backup.exists() {
            fs::remove_file(&backup).map_err(|error| error.to_string())?;
        }
        Ok(())
    })();
    if write.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    write
}

fn read_manifest(path: &Path) -> Result<Option<Manifest>, String> {
    let backup = path.with_extension("bak");
    if !path.exists() && backup.exists() {
        durable_rename(&backup, path).map_err(|error| error.to_string())?;
    }
    if !path.exists() {
        return Ok(None);
    }
    let parse = |path: &Path| -> Result<Manifest, String> {
        serde_json::from_slice(&fs::read(path).map_err(|error| error.to_string())?)
            .map_err(|error| format!("Cannot read trusted Git overlay manifest: {error}"))
    };
    match parse(path) {
        Ok(manifest) => Ok(Some(manifest)),
        Err(error) if backup.exists() => {
            let manifest = parse(&backup).map_err(|_| error)?;
            fs::remove_file(path).map_err(|error| error.to_string())?;
            durable_rename(&backup, path).map_err(|error| error.to_string())?;
            Ok(Some(manifest))
        }
        Err(error) => Err(error),
    }
}

fn seed_refs(source: &Source, git_dir: &Path) -> Result<(), String> {
    let refs = output(
        git_command()
            .arg("-C")
            .arg(&source.worktree)
            .args(["for-each-ref", "--format=%(refname) %(objectname)"]),
    )?;
    let mut updates = String::new();
    for line in String::from_utf8(refs.stdout)
        .map_err(|error| error.to_string())?
        .lines()
    {
        let (reference, oid) = line
            .split_once(' ')
            .ok_or("Invalid source Git reference output.")?;
        updates.push_str(&format!("update {reference} {oid}\n"));
    }
    if updates.is_empty() {
        return Ok(());
    }
    let mut child = git_command()
        .arg("--git-dir")
        .arg(git_config_path(git_dir))
        .args(["update-ref", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| error.to_string())?;
    child
        .stdin
        .take()
        .ok_or("Git reference update input unavailable.")?
        .write_all(updates.as_bytes())
        .map_err(|error| error.to_string())?;
    let result = child
        .wait_with_output()
        .map_err(|error| error.to_string())?;
    if !result.status.success() {
        return Err(String::from_utf8_lossy(&result.stderr).trim().to_string());
    }
    Ok(())
}

fn configure_private_git(git_dir: &Path) -> Result<(), String> {
    let settings = [
        ("core.filesRefLockTimeout", REF_LOCK_TIMEOUT_MS),
        #[cfg(windows)]
        ("core.longpaths", "true"),
    ];
    for (key, expected) in settings {
        let value = git_command()
            .arg("--git-dir")
            .arg(git_config_path(git_dir))
            .args(["config", "--local", "--get", key])
            .output()
            .map_err(|error| error.to_string())?;
        if !value.status.success() || String::from_utf8_lossy(&value.stdout).trim() != expected {
            output(
                git_command()
                    .arg("--git-dir")
                    .arg(git_config_path(git_dir))
                    .args(["config", "--local", key, expected]),
            )?;
        }
    }
    Ok(())
}

fn private_lock_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut locks = Vec::new();
    let Some(entries) = skip_missing(fs::read_dir(directory))? else {
        return Ok(locks);
    };
    for entry in entries {
        let Some(entry) = skip_missing(entry)? else {
            continue;
        };
        let Some(kind) = skip_missing(entry.file_type())? else {
            continue;
        };
        if kind.is_dir() && entry.file_name() == "refs" {
            locks.extend(ref_lock_files(&entry.path())?);
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|value| value == "lock")
        {
            locks.push(entry.path());
        }
    }
    Ok(locks)
}

fn ref_lock_files(directory: &Path) -> Result<Vec<PathBuf>, String> {
    let mut locks = Vec::new();
    let Some(entries) = skip_missing(fs::read_dir(directory))? else {
        return Ok(locks);
    };
    for entry in entries {
        let Some(entry) = skip_missing(entry)? else {
            continue;
        };
        let Some(kind) = skip_missing(entry.file_type())? else {
            continue;
        };
        if kind.is_dir() {
            locks.extend(ref_lock_files(&entry.path())?);
        } else if kind.is_file()
            && entry
                .path()
                .extension()
                .is_some_and(|value| value == "lock")
        {
            locks.push(entry.path());
        }
    }
    Ok(locks)
}

fn skip_missing<T>(result: std::io::Result<T>) -> Result<Option<T>, String> {
    match result {
        Ok(value) => Ok(Some(value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(error.to_string()),
    }
}

fn recover_stale_private_locks(
    cache: &Path,
    worktree: &Path,
    git_dir: &Path,
) -> Result<(), String> {
    let locks = private_lock_files(git_dir)?;
    recover_stale_private_locks_from_snapshot(cache, worktree, git_dir, locks)
}

fn recover_stale_private_locks_from_snapshot(
    cache: &Path,
    worktree: &Path,
    git_dir: &Path,
    locks: Vec<PathBuf>,
) -> Result<(), String> {
    if locks.is_empty() {
        return Ok(());
    }
    crate::worktree_storage::with_idle_worktree(cache, worktree, || {
        if overlay_has_live_processes(worktree, git_dir) {
            return Ok(());
        }
        for path in locks {
            let Some(metadata) = skip_missing(fs::symlink_metadata(&path))? else {
                continue;
            };
            if !metadata.file_type().is_file()
                || !metadata
                    .modified()
                    .ok()
                    .and_then(|modified| modified.elapsed().ok())
                    .is_some_and(|age| age >= std::time::Duration::from_secs(30))
            {
                continue;
            }
            let retained_root = git_dir.join("sail-stale-locks");
            fs::create_dir_all(&retained_root).map_err(|error| error.to_string())?;
            let retained = retained_root.join(uuid::Uuid::new_v4().to_string());
            if skip_missing(fs::rename(&path, &retained))?.is_none() {
                continue;
            }
            crate::diagnostics::record(
                "git_overlay_stale_lock_recovered",
                serde_json::json!({
                    "worktree": worktree, "lock": path, "retainedLock": retained,
                }),
            );
        }
        Ok(())
    })?;
    Ok(())
}

fn overlay_has_live_processes(worktree: &Path, git_dir: &Path) -> bool {
    let system = sysinfo::System::new_all();
    system.processes().values().any(|process| {
        !matches!(
            process.status(),
            sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
        ) && process_uses_overlay(process, worktree, git_dir)
    })
}

fn process_uses_overlay(process: &sysinfo::Process, worktree: &Path, git_dir: &Path) -> bool {
    if !process_context_uses_overlay(
        process.cwd(),
        process.name(),
        process.cmd(),
        process.environ(),
        worktree,
        git_dir,
    ) {
        return false;
    }
    #[cfg(windows)]
    {
        windows_process_is_alive(process.pid().as_u32())
    }
    #[cfg(not(windows))]
    {
        true
    }
}

#[cfg(windows)]
fn windows_process_is_alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::{
        CloseHandle, GetLastError, ERROR_INVALID_PARAMETER, STILL_ACTIVE,
    };
    use windows_sys::Win32::System::Threading::{
        GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION,
    };
    // A Windows process snapshot can retain a Git process that exited while
    // its cwd was being read. Verify it is still alive before treating missing
    // process information as an unknown writer. Access failures stay busy.
    let handle = unsafe { OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid) };
    if handle.is_null() {
        return unsafe { GetLastError() } != ERROR_INVALID_PARAMETER;
    }
    let mut exit_code = 0;
    let queried = unsafe { GetExitCodeProcess(handle, &mut exit_code) } != 0;
    unsafe { CloseHandle(handle) };
    !queried || exit_code == STILL_ACTIVE as u32
}

fn process_context_uses_overlay(
    process_cwd: Option<&Path>,
    name: &std::ffi::OsStr,
    arguments: &[OsString],
    environment: &[OsString],
    worktree: &Path,
    git_dir: &Path,
) -> bool {
    let canonical_worktree =
        dunce::canonicalize(worktree).unwrap_or_else(|_| worktree.to_path_buf());
    let canonical_git_dir = dunce::canonicalize(git_dir).unwrap_or_else(|_| git_dir.to_path_buf());
    let worktree = canonical_worktree.as_path();
    let git_dir = canonical_git_dir.as_path();
    let points_into_overlay = |value: &Path, cwd: Option<&Path>| {
        let path = if value.is_absolute() {
            value.to_path_buf()
        } else if let Some(cwd) = cwd {
            cwd.join(value)
        } else {
            return false;
        };
        let path = dunce::canonicalize(&path).unwrap_or(path);
        path.starts_with(worktree) || path.starts_with(git_dir)
    };
    if process_cwd.is_some_and(|cwd| points_into_overlay(cwd, None)) {
        return true;
    }
    for variable in environment {
        let variable = variable.to_string_lossy();
        if let Some((name, value)) = variable.split_once('=') {
            if matches!(
                name,
                "GIT_DIR" | "GIT_COMMON_DIR" | "GIT_WORK_TREE" | "GIT_INDEX_FILE"
            ) && points_into_overlay(Path::new(value), process_cwd)
            {
                return true;
            }
        }
    }
    let mut cwd = process_cwd.map(Path::to_path_buf);
    let mut change_directory = false;
    for argument in arguments {
        let argument = argument.to_string_lossy();
        if argument == "-C" {
            change_directory = true;
            continue;
        }
        let value = argument
            .split_once('=')
            .map_or(argument.as_ref(), |(_, value)| value);
        if points_into_overlay(Path::new(value), cwd.as_deref()) {
            return true;
        }
        if change_directory {
            cwd = Some(cwd.as_deref().unwrap_or(Path::new("")).join(value));
            change_directory = false;
        }
    }
    // Command-line directories cannot prove the actual cwd of an unreadable
    // process: symlinks and directories can move while its writer stays live.
    process_cwd.is_none() && name.to_string_lossy().starts_with("git")
}

fn recover_unregistered_overlay(
    current: &Source,
    git_dir: &Path,
    manifest_path: &Path,
) -> Result<Option<GitOverlay>, String> {
    reject_links(git_dir)?;
    let complete = (|| -> Result<(), String> {
        validate_overlay(git_dir, &current.common_dir)?;
        if !private_lock_files(git_dir)?.is_empty() {
            return Err("Unregistered overlay has unfinished Git writes.".into());
        }
        let branch = output(
            git_command()
                .arg("--git-dir")
                .arg(git_config_path(git_dir))
                .args(["symbolic-ref", "-q", "HEAD"]),
        )?;
        if String::from_utf8_lossy(&branch.stdout).trim() != current.branch {
            return Err("Incomplete private branch.".into());
        }
        let head = output(
            git_command()
                .arg("--git-dir")
                .arg(git_config_path(git_dir))
                .args(["rev-parse", "--verify", "HEAD^{commit}"]),
        )?;
        if String::from_utf8_lossy(&head.stdout).trim() != current.head
            || index_hash(&git_dir.join("index"))? != index_hash(&current.git_dir.join("index"))?
        {
            return Err("Unregistered overlay has private changes.".into());
        }
        index_hash(&git_dir.join("index"))?.ok_or("Incomplete private index.")?;
        output(
            git_command()
                .arg("--git-dir")
                .arg(git_config_path(git_dir))
                .args(["ls-files", "--stage"]),
        )?;
        Ok(())
    })();
    if complete.is_ok() {
        configure_private_git(git_dir)?;
        write_manifest(
            manifest_path,
            &Manifest {
                version: VERSION,
                worktree: current.worktree.clone(),
                source_git_dir: current.git_dir.clone(),
                common_dir: current.common_dir.clone(),
                branch: current.branch.clone(),
                promoted_oid: current.head.clone(),
                source_index_hash: index_hash(&current.git_dir.join("index"))?,
                promotion: None,
                removing: false,
            },
        )?;
        return GitOverlay::existing(
            manifest_path
                .parent()
                .and_then(Path::parent)
                .ok_or("Invalid overlay cache path.")?,
            &current.worktree,
        );
    }
    // Failed initialization was never published to an agent. Preserve any
    // unknown objects before rebuilding instead of discarding private commits.
    let retained = git_dir.with_extension(format!("recovery-{}", uuid::Uuid::new_v4()));
    fs::rename(git_dir, &retained).map_err(|error| error.to_string())?;
    crate::diagnostics::record(
        "git_overlay_initialization_recovered",
        serde_json::json!({
            "worktree": current.worktree,
            "retainedGitDirectory": retained,
        }),
    );
    Ok(None)
}

impl GitOverlay {
    pub(crate) fn existing(cache: &Path, worktree: &Path) -> Result<Option<Self>, String> {
        let worktree = dunce::canonicalize(worktree).map_err(|error| error.to_string())?;
        let (git_dir, manifest_path, _) = paths(cache, &worktree);
        let Some(manifest) = read_manifest(&manifest_path)? else {
            return Ok(None);
        };
        if manifest.version != VERSION || manifest.worktree != worktree {
            return Err("Git overlay owner does not match this worktree.".into());
        }
        if manifest.removing {
            return Err("Private Git overlay belongs to a removed worktree.".into());
        }
        let current = source(&worktree)?.ok_or("Linked Git worktree is unavailable.")?;
        if manifest.source_git_dir != current.git_dir
            || manifest.common_dir != current.common_dir
            || manifest.branch != current.branch
        {
            return Err("Git worktree identity changed; overlay requires recovery.".into());
        }
        if !fs::symlink_metadata(&git_dir).is_ok_and(|metadata| metadata.file_type().is_dir()) {
            return Err("Private Git overlay directory is unavailable.".into());
        }
        validate_overlay(&git_dir, &current.common_dir)?;
        let overlay = Self {
            git_dir,
            worktree,
            manifest_path,
            manifest,
        };
        register(
            &overlay.worktree,
            &overlay.git_dir,
            &overlay.manifest.source_git_dir,
        );
        Ok(Some(overlay))
    }

    pub(crate) fn ensure(cache: &Path, worktree: &Path) -> Result<Option<Self>, String> {
        let Some(current) = source(worktree)? else {
            return Ok(None);
        };
        let (git_dir, manifest_path, lock_path) = paths(cache, &current.worktree);
        fs::create_dir_all(lock_path.parent().ok_or("Invalid overlay lock path.")?)
            .map_err(|error| error.to_string())?;
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|error| error.to_string())?;
        lock.lock().map_err(|error| error.to_string())?;
        if let Some(existing) = Self::existing(cache, &current.worktree)? {
            recover_stale_private_locks(cache, &existing.worktree, &existing.git_dir)?;
            configure_private_git(&existing.git_dir)?;
            return Ok(Some(existing));
        }
        if fs::symlink_metadata(&git_dir).is_ok() {
            let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
            loop {
                let recovery =
                    crate::worktree_storage::with_idle_worktree(cache, &current.worktree, || {
                        if overlay_has_live_processes(&current.worktree, &git_dir) {
                            return Ok(None);
                        }
                        recover_unregistered_overlay(&current, &git_dir, &manifest_path).map(Some)
                    })?
                    .flatten();
                if let Some(recovered) = recovery {
                    if recovered.is_some() {
                        return Ok(recovered);
                    }
                    break;
                }
                if std::time::Instant::now() >= deadline {
                    return Err(
                        "Private Git overlay is busy; retry after its writer finishes.".into(),
                    );
                }
                std::thread::sleep(std::time::Duration::from_millis(100));
            }
        }
        fs::create_dir_all(git_dir.parent().ok_or("Invalid overlay path.")?)
            .map_err(|error| error.to_string())?;
        let published_git_dir = git_dir;
        // Git for Windows rejects GIT_DIR values above PATH_MAX - 40 even
        // with core.longpaths enabled. Keep staging shorter than the final
        // hash-named directory instead of appending a UUID to that hash.
        let build = OverlayBuild(
            published_git_dir
                .parent()
                .ok_or("Invalid overlay path.")?
                .join(format!("building-{}", uuid::Uuid::new_v4())),
        );
        let git_dir = build.0.clone();
        output(
            git_command()
                .args(["init", "--bare", "--quiet"])
                .arg(&git_dir),
        )?;
        let alternate = git_dir.join("objects/info/alternates");
        fs::write(
            &alternate,
            format!(
                "{}\n",
                git_config_path(&current.common_dir.join("objects")).to_string_lossy()
            ),
        )
        .map_err(|error| error.to_string())?;
        let config = git_dir.join("config");
        let source_config = current.common_dir.join("config");
        let mut config_entries = format!(
            "\n[include]\n\tpath = {}\n",
            git_config_quoted_path(&source_config)?
        );
        let worktree_config = current.git_dir.join("config.worktree");
        if worktree_config.is_file() {
            config_entries.push_str(&format!(
                "[include]\n\tpath = {}\n",
                git_config_quoted_path(&worktree_config)?
            ));
        }
        let configured_hooks = git_command()
            .arg("-C")
            .arg(&current.worktree)
            .args(["config", "--get", "core.hooksPath"])
            .output()
            .map_err(|error| error.to_string())?
            .status
            .success();
        if !configured_hooks {
            config_entries.push_str(&format!(
                "[core]\n\thooksPath = {}\n",
                git_config_quoted_path(&current.common_dir.join("hooks"))?
            ));
        }
        // The source includes follow the initial [core] section. A final section
        // overrides any inherited core.splitIndex=true for every task Git command.
        config_entries.push_str(&format!(
            "[core]\n\tbare = false\n\tsplitIndex = false\n\tfilesRefLockTimeout = {REF_LOCK_TIMEOUT_MS}\n"
        ));
        #[cfg(windows)]
        config_entries.push_str("\tlongpaths = true\n");
        OpenOptions::new()
            .append(true)
            .open(&config)
            .and_then(|mut file| file.write_all(config_entries.as_bytes()))
            .map_err(|error| error.to_string())?;
        #[cfg(all(test, windows))]
        {
            let check = git_command()
                .args(["config", "--includes", "--file"])
                .arg(&config)
                .arg("--list")
                .output()
                .map_err(|error| error.to_string())?;
            if !check.status.success() {
                eprintln!(
                    "Windows overlay config diagnostic: stderr={:?} bytes={:?}",
                    String::from_utf8_lossy(&check.stderr),
                    fs::read(&config).map_err(|error| error.to_string())?
                );
            }
        }
        seed_refs(&current, &git_dir)?;
        output(
            git_command()
                .args(["--git-dir"])
                .arg(git_config_path(&git_dir))
                .args(["symbolic-ref", "HEAD", &current.branch]),
        )?;
        let source_index = current.git_dir.join("index");
        let source_index_hash = index_hash(&source_index)?;
        if source_index.is_file() {
            let split = copy_source_shared_index(&current, &git_dir)?;
            fs::copy(&source_index, git_dir.join("index"))
                .map_err(|error| format!("Cannot preserve staged worktree changes: {error}"))?;
            if split {
                output(
                    git_command()
                        .env("GIT_DIR", git_config_path(&git_dir))
                        .env("GIT_WORK_TREE", git_config_path(&current.worktree))
                        .args(["update-index", "--no-split-index"]),
                )?;
            }
        } else {
            output(
                git_command()
                    .env("GIT_DIR", git_config_path(&git_dir))
                    .env("GIT_WORK_TREE", git_config_path(&current.worktree))
                    .args(["read-tree", "HEAD"]),
            )?;
        }
        if index_hash(&source_index)? != source_index_hash {
            return Err("Assigned index changed while creating the private overlay.".into());
        }
        let manifest = Manifest {
            version: VERSION,
            worktree: current.worktree.clone(),
            source_git_dir: current.git_dir.clone(),
            common_dir: current.common_dir,
            branch: current.branch,
            promoted_oid: current.head,
            source_index_hash,
            promotion: None,
            removing: false,
        };
        validate_overlay(&git_dir, &manifest.common_dir)?;
        fs::rename(&git_dir, &published_git_dir).map_err(|error| error.to_string())?;
        if let Err(error) = write_manifest(&manifest_path, &manifest) {
            if !manifest_path.exists() {
                fs::rename(&published_git_dir, &git_dir).map_err(|rollback| {
                    format!("{error}; cannot roll back overlay publication: {rollback}")
                })?;
            }
            return Err(error);
        }
        let overlay = Self {
            git_dir: published_git_dir,
            worktree: current.worktree,
            manifest_path,
            manifest,
        };
        register(
            &overlay.worktree,
            &overlay.git_dir,
            &overlay.manifest.source_git_dir,
        );
        Ok(Some(overlay))
    }

    pub(crate) fn apply(&self, command: &mut Command) {
        command.env("GIT_DIR", git_config_path(&self.git_dir));
        command.env("GIT_WORK_TREE", git_config_path(&self.worktree));
        command.env_remove("GIT_COMMON_DIR");
        command.env_remove("GIT_INDEX_FILE");
    }

    pub(crate) fn promote_quiescent(
        &mut self,
        check_quiescence: impl FnOnce() -> Result<(), String>,
    ) -> Result<(), String> {
        let cache = self
            .manifest_path
            .parent()
            .and_then(Path::parent)
            .ok_or("Invalid Git overlay cache path.")?;
        let (_, _, lock_path) = paths(cache, &self.worktree);
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(lock_path)
            .map_err(|error| error.to_string())?;
        lock.lock().map_err(|error| error.to_string())?;
        check_quiescence()?;
        validate_overlay(&self.git_dir, &self.manifest.common_dir)?;
        recover_stale_private_locks(cache, &self.worktree, &self.git_dir)?;
        let current = source(&self.worktree)?.ok_or("Assigned linked worktree is unavailable.")?;
        if current.git_dir != self.manifest.source_git_dir
            || current.common_dir != self.manifest.common_dir
            || current.branch != self.manifest.branch
        {
            return Err("Assigned worktree identity or branch changed; promotion refused.".into());
        }
        let mut manifest = read_manifest(&self.manifest_path)?
            .ok_or("Trusted Git overlay manifest is missing.")?;
        if manifest.worktree != self.worktree || manifest.version != VERSION {
            return Err("Git overlay owner changed; promotion refused.".into());
        }
        let branch = output(
            git_command()
                .arg("--git-dir")
                .arg(git_config_path(&self.git_dir))
                .args(["symbolic-ref", "-q", "HEAD"]),
        )?;
        if String::from_utf8_lossy(&branch.stdout).trim() != manifest.branch {
            return Err("Private Git HEAD changed branch; promotion refused.".into());
        }
        let head = output(
            git_command()
                .arg("--git-dir")
                .arg(git_config_path(&self.git_dir))
                .args(["rev-parse", "--verify", "HEAD^{commit}"]),
        )?;
        let head = String::from_utf8(head.stdout).map_err(|error| error.to_string())?;
        let head = head.trim();
        let source_index = manifest.source_git_dir.join("index");
        let private_index = self.git_dir.join("index");
        if manifest.promotion.is_none()
            && shared_index_path(
                git_command()
                    .env("GIT_DIR", git_config_path(&self.git_dir))
                    .env("GIT_WORK_TREE", git_config_path(&self.worktree)),
            )?
            .is_some()
        {
            output(
                git_command()
                    .env("GIT_DIR", git_config_path(&self.git_dir))
                    .env("GIT_WORK_TREE", git_config_path(&self.worktree))
                    .args(["update-index", "--no-split-index"]),
            )?;
        }
        let new_index_hash = index_hash(&private_index)?.ok_or("Private Git index is missing.")?;
        let promotion = if let Some(pending) = &manifest.promotion {
            if pending.new_oid != head
                || pending.expected_oid != manifest.promoted_oid
                || pending.new_index_hash != new_index_hash
            {
                return Err(
                    "Pending Git promotion differs from private HEAD; recovery required.".into(),
                );
            }
            pending.clone()
        } else {
            if current.head != manifest.promoted_oid {
                return Err("Assigned branch changed outside the task; promotion refused.".into());
            }
            if index_hash(&source_index)? != manifest.source_index_hash {
                return Err("Assigned index changed outside the task; promotion refused.".into());
            }
            if head == manifest.promoted_oid
                && index_hash(&source_index)?.as_deref() == Some(new_index_hash.as_str())
            {
                return Ok(());
            }
            let pending = Promotion {
                expected_oid: manifest.promoted_oid.clone(),
                new_oid: head.to_string(),
                new_index_hash,
                index_backup: format!("index.sail-overlay-{}.backup", uuid::Uuid::new_v4()),
            };
            manifest.promotion = Some(pending.clone());
            write_manifest(&self.manifest_path, &manifest)?;
            pending
        };
        if current.head == promotion.expected_oid && promotion.new_oid != promotion.expected_oid {
            output(
                git_command()
                    .arg("--git-dir")
                    .arg(git_config_path(&manifest.common_dir))
                    .args(["fetch", "--no-write-fetch-head", "--no-tags"])
                    .arg(git_config_path(&self.git_dir))
                    .arg(&promotion.new_oid),
            )?;
            output(
                git_command()
                    .arg("--git-dir")
                    .arg(git_config_path(&manifest.common_dir))
                    .args([
                        "update-ref",
                        &manifest.branch,
                        &promotion.new_oid,
                        &promotion.expected_oid,
                    ]),
            )?;
        } else if current.head != promotion.new_oid {
            return Err(
                "Assigned branch changed during promotion; recovery requires a decision.".into(),
            );
        }
        replace_index(
            &source_index,
            &private_index,
            manifest.source_index_hash.as_deref(),
            &promotion.new_index_hash,
            &promotion.index_backup,
        )?;
        manifest.promoted_oid = promotion.new_oid;
        manifest.source_index_hash = Some(promotion.new_index_hash);
        manifest.promotion = None;
        write_manifest(&self.manifest_path, &manifest)?;
        self.manifest = manifest;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct OverlayFixture {
        root: PathBuf,
        main: PathBuf,
        task: PathBuf,
        cache: PathBuf,
    }

    impl OverlayFixture {
        fn new() -> Self {
            let root = std::env::temp_dir()
                .join(format!("sail-overlay-recovery-{}", uuid::Uuid::new_v4()));
            let main = root.join("main");
            let task = root.join("task");
            let cache = root.join("cache");
            fs::create_dir_all(&main).unwrap();
            git(&main, &["init", "-q", "-b", "main"]);
            git(&main, &["config", "user.name", "Sail Test"]);
            git(&main, &["config", "user.email", "sail@example.test"]);
            fs::write(main.join("initial.txt"), "base\n").unwrap();
            git(&main, &["add", "initial.txt"]);
            git(
                &main,
                &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
            );
            git(
                &main,
                &[
                    "worktree",
                    "add",
                    "-q",
                    "-b",
                    "task",
                    task.to_str().unwrap(),
                ],
            );
            Self {
                root,
                main,
                task: dunce::canonicalize(task).unwrap(),
                cache,
            }
        }
    }

    impl Drop for OverlayFixture {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.root).unwrap();
        }
    }

    #[test]
    fn ref_lock_contention_waits_for_the_writer() {
        let fixture = OverlayFixture::new();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        let lock_path = overlay.git_dir.join("refs/heads/hooks.lock");
        fs::write(&lock_path, "busy").unwrap();
        let writer = std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(200));
            fs::remove_file(lock_path).unwrap();
        });
        overlay_git(&overlay, &["update-ref", "refs/heads/hooks", "HEAD"]);
        writer.join().unwrap();
        assert_eq!(
            overlay_git(&overlay, &["rev-parse", "hooks"]),
            git(&fixture.task, &["rev-parse", "HEAD"])
        );
        assert!(!fixture.main.join(".git/refs/heads/hooks").exists());
    }

    #[test]
    fn incomplete_overlay_is_preserved_and_sessions_can_retry() {
        let fixture = OverlayFixture::new();
        let (private, manifest, _) = paths(&fixture.cache, &fixture.task);
        fs::create_dir_all(private.join("refs/heads")).unwrap();
        fs::write(private.join("refs/heads/hooks.lock"), "stale writer").unwrap();
        fs::write(private.join("private-data"), "preserve me").unwrap();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        assert!(manifest.is_file());
        assert!(!overlay.git_dir.join("refs/heads/hooks.lock").exists());
        assert_eq!(
            overlay_git(&overlay, &["rev-parse", "HEAD"]),
            git(&fixture.task, &["rev-parse", "HEAD"])
        );
        let retained = fs::read_dir(fixture.cache.join("git-overlays"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.extension()
                    .is_some_and(|extension| extension.to_string_lossy().starts_with("recovery-"))
            })
            .unwrap();
        assert_eq!(
            fs::read_to_string(retained.join("private-data")).unwrap(),
            "preserve me"
        );
        assert_eq!(
            GitOverlay::ensure(&fixture.cache, &fixture.task)
                .unwrap()
                .unwrap()
                .git_dir,
            overlay.git_dir
        );
    }

    #[test]
    fn failed_manifest_publication_does_not_poison_next_session() {
        let fixture = OverlayFixture::new();
        let (private, manifest, _) = paths(&fixture.cache, &fixture.task);
        fs::write(fixture.cache.clone(), "blocked cache").unwrap();
        assert!(GitOverlay::ensure(&fixture.cache, &fixture.task).is_err());
        fs::remove_file(&fixture.cache).unwrap();
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        // Fail after Git initialization, while publishing the trusted manifest.
        fs::remove_dir(manifest.parent().unwrap()).unwrap();
        fs::write(manifest.parent().unwrap(), "blocked manifest directory").unwrap();
        assert!(GitOverlay::ensure(&fixture.cache, &fixture.task).is_err());
        assert!(!private.exists());
        assert_eq!(
            fs::read_dir(fixture.cache.join("git-overlays"))
                .unwrap()
                .count(),
            0
        );
        fs::remove_file(manifest.parent().unwrap()).unwrap();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        require_shared_current_in_cache(&fixture.cache, &fixture.task).unwrap();
        assert!(overlay.manifest_path.is_file());
    }

    #[test]
    fn missing_manifest_recovers_a_clean_overlay_in_place() {
        let fixture = OverlayFixture::new();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        fs::remove_file(&overlay.manifest_path).unwrap();
        let recovered = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        assert_eq!(recovered.git_dir, overlay.git_dir);
        require_shared_current_in_cache(&fixture.cache, &fixture.task).unwrap();
        assert_eq!(
            fs::read_dir(fixture.cache.join("git-overlays"))
                .unwrap()
                .count(),
            1
        );
    }

    #[test]
    fn finished_writer_missing_from_lock_snapshot_does_not_block_other_recovery() {
        let fixture = OverlayFixture::new();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        let finished = overlay.git_dir.join("refs/heads/finished.lock");
        let stale = overlay.git_dir.join("refs/heads/stale.lock");
        fs::write(&finished, "finished writer").unwrap();
        fs::write(&stale, "stale writer").unwrap();
        File::options()
            .write(true)
            .open(&stale)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(60),
                ),
            )
            .unwrap();
        let snapshot = vec![finished.clone(), stale.clone()];
        fs::remove_file(finished).unwrap();

        // Recovery leaves locks intact while a Git writer or storage lease is
        // still active. A concurrent test run can observe that short window.
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while stale.exists() {
            recover_stale_private_locks_from_snapshot(
                &fixture.cache,
                &fixture.task,
                &overlay.git_dir,
                snapshot.clone(),
            )
            .unwrap();
            if !stale.exists() || std::time::Instant::now() >= deadline {
                break;
            }
            std::thread::sleep(std::time::Duration::from_millis(20));
        }

        assert!(!stale.exists());
        overlay_git(&overlay, &["update-ref", "refs/heads/stale", "HEAD"]);
    }

    #[test]
    fn removed_ref_directory_does_not_block_lock_scan() {
        let fixture = OverlayFixture::new();
        let removed = fixture.root.join("removed-refs");
        fs::create_dir(&removed).unwrap();
        fs::remove_dir(&removed).unwrap();

        assert!(ref_lock_files(&removed).unwrap().is_empty());
    }

    #[test]
    fn unreadable_live_git_remains_protected_with_an_unrelated_change_directory() {
        let fixture = OverlayFixture::new();
        let (private, _, _) = paths(&fixture.cache, &fixture.task);
        let arguments = vec![
            OsString::from("git"),
            OsString::from("-C"),
            fixture.main.as_os_str().to_os_string(),
            OsString::from("update-ref"),
            OsString::from("--stdin"),
        ];
        assert!(process_context_uses_overlay(
            None,
            std::ffi::OsStr::new("git"),
            &arguments,
            &[],
            &fixture.task,
            &private,
        ));
        assert!(process_context_uses_overlay(
            None,
            std::ffi::OsStr::new("git"),
            &[OsString::from("git"), OsString::from("update-ref")],
            &[],
            &fixture.task,
            &private,
        ));
    }

    #[test]
    fn unreadable_git_remains_protected_with_relative_targets() {
        let fixture = OverlayFixture::new();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        let relative = overlay.git_dir.strip_prefix(&fixture.root).unwrap();
        let change_directory = fixture.root.as_os_str().to_os_string();
        let cases = [
            (
                vec![
                    OsString::from("git"),
                    OsString::from("-C"),
                    change_directory.clone(),
                    OsString::from("update-ref"),
                ],
                vec![OsString::from(format!("GIT_DIR={}", relative.display()))],
            ),
            (
                vec![
                    OsString::from("git"),
                    OsString::from(format!("--git-dir={}", relative.display())),
                    OsString::from("-C"),
                    change_directory,
                    OsString::from("update-ref"),
                ],
                Vec::new(),
            ),
        ];
        for (arguments, environment) in cases {
            assert!(
                process_context_uses_overlay(
                    None,
                    std::ffi::OsStr::new("git"),
                    &arguments,
                    &environment,
                    &fixture.task,
                    &overlay.git_dir,
                ),
                "Relative Git target must retain its writer: {arguments:?}"
            );
        }
    }

    #[cfg(windows)]
    #[test]
    fn exited_windows_git_process_does_not_block_overlay_recovery() {
        let fixture = OverlayFixture::new();
        let mut child = git_command().args(["--version"]).spawn().unwrap();
        let pid = child.id();
        child.wait().unwrap();
        assert!(!windows_process_is_alive(pid));
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        fs::remove_file(&overlay.manifest_path).unwrap();
        assert!(GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .is_some());
    }

    #[cfg(windows)]
    #[test]
    fn deep_cache_overlay_supports_long_refs_in_plain_git_commands() {
        let fixture = OverlayFixture::new();
        git(&fixture.main, &["config", "core.longpaths", "false"]);
        let cache = fixture.cache.join("deep-cache-directory");
        let overlay = GitOverlay::ensure(&cache, &fixture.task).unwrap().unwrap();
        let reference = format!("refs/heads/{}", "long-ref-".repeat(20));
        assert!(overlay.git_dir.join(&reference).to_string_lossy().len() > 260);
        // Use a plain command so this also verifies the published config, not
        // just the flags used by Sail's internal Git command helper.
        let mut command = Command::new("git");
        overlay.apply(&mut command);
        output(
            command
                .arg("-C")
                .arg(&fixture.task)
                .args(["update-ref", &reference, "HEAD"]),
        )
        .unwrap();
        assert_eq!(
            fs::read_to_string(overlay.git_dir.join(&reference))
                .unwrap()
                .trim(),
            git(&fixture.task, &["rev-parse", "HEAD"])
        );
        assert!(!fixture.main.join(".git").join(reference).exists());
    }

    #[test]
    fn stale_private_lock_is_recovered_only_after_storage_leases_close() {
        let fixture = OverlayFixture::new();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        let lock_path = overlay.git_dir.join("refs/heads/task.lock");
        fs::write(&lock_path, "stale writer").unwrap();
        File::options()
            .write(true)
            .open(&lock_path)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(60),
                ),
            )
            .unwrap();
        let (_, lease) = crate::worktree_storage::register(&fixture.cache, &fixture.task).unwrap();
        GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        assert!(
            lock_path.is_file(),
            "An active lease must retain its Git locks"
        );
        lease.release_clean().unwrap();
        GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        assert!(!lock_path.exists());
        overlay_git(&overlay, &["update-ref", "refs/heads/task", "HEAD"]);
        let retained = fs::read_dir(overlay.git_dir.join("sail-stale-locks"))
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .next()
            .unwrap();
        assert_eq!(fs::read_to_string(retained).unwrap(), "stale writer");
    }

    #[cfg(unix)]
    #[test]
    fn stale_private_lock_is_retained_while_an_external_writer_is_alive() {
        let fixture = OverlayFixture::new();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        let lock_path = overlay.git_dir.join("refs/heads/task.lock");
        fs::write(&lock_path, "live writer").unwrap();
        File::options()
            .write(true)
            .open(&lock_path)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(60),
                ),
            )
            .unwrap();
        let mut command = Command::new("sh");
        overlay.apply(&mut command);
        let mut writer = command
            .args(["-c", "read line"])
            .current_dir(&fixture.task)
            .stdin(Stdio::piped())
            .spawn()
            .unwrap();
        let result = GitOverlay::ensure(&fixture.cache, &fixture.task);
        let retained = lock_path.is_file();
        writer.kill().unwrap();
        writer.wait().unwrap();
        result.unwrap();
        assert!(
            retained,
            "The live writer must retain its lock regardless of age"
        );
    }

    #[test]
    fn prepared_transaction_with_relative_git_dir_retains_its_lock() {
        use std::io::{BufRead, BufReader};
        let fixture = OverlayFixture::new();
        let overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        let head = overlay_git(&overlay, &["rev-parse", "HEAD"]);
        let relative_git_dir = overlay.git_dir.strip_prefix(&fixture.root).unwrap();
        let mut writer = git_command()
            .arg("--git-dir")
            .arg(relative_git_dir)
            .args(["update-ref", "--stdin"])
            .current_dir(&fixture.root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .unwrap();
        let mut input = writer.stdin.take().unwrap();
        input
            .write_all(format!("start\nupdate refs/heads/task {head} {head}\nprepare\n").as_bytes())
            .unwrap();
        input.flush().unwrap();
        let mut response = BufReader::new(writer.stdout.take().unwrap());
        let mut line = String::new();
        response.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "start: ok");
        line.clear();
        response.read_line(&mut line).unwrap();
        assert_eq!(line.trim(), "prepare: ok");
        let lock_path = overlay.git_dir.join("refs/heads/task.lock");
        File::options()
            .write(true)
            .open(&lock_path)
            .unwrap()
            .set_times(
                fs::FileTimes::new().set_modified(
                    std::time::SystemTime::now() - std::time::Duration::from_secs(60),
                ),
            )
            .unwrap();
        let result = GitOverlay::ensure(&fixture.cache, &fixture.task);
        let retained = lock_path.is_file();
        fs::remove_file(&overlay.manifest_path).unwrap();
        let unregistered = GitOverlay::ensure(&fixture.cache, &fixture.task);
        let unregistered_retained = lock_path.is_file();
        input.write_all(b"commit\n").unwrap();
        drop(input);
        assert!(writer.wait().unwrap().success());
        result.unwrap();
        assert!(retained, "A prepared transaction must keep its ref lock");
        assert!(unregistered.unwrap_err().contains("overlay is busy"));
        assert!(
            unregistered_retained,
            "Recovery must retain an unregistered writer's lock"
        );
        GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
    }

    #[test]
    fn interrupted_private_cleanup_resumes_after_the_overlay_directory_is_gone() {
        let fixture = OverlayFixture::new();
        let mut overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        git(
            &fixture.main,
            &["worktree", "remove", fixture.task.to_str().unwrap()],
        );
        overlay.manifest.removing = true;
        write_manifest(&overlay.manifest_path, &overlay.manifest).unwrap();
        fs::copy(
            &overlay.manifest_path,
            overlay.manifest_path.with_extension("bak"),
        )
        .unwrap();
        fs::remove_dir_all(&overlay.git_dir).unwrap();
        forget_removed_worktree_in_cache(&fixture.cache, &fixture.task).unwrap();
        forget_removed_worktree_in_cache(&fixture.cache, &fixture.task).unwrap();
        assert_eq!(known_worktree_in_cache(&fixture.cache, &fixture.task), None);
    }

    #[test]
    fn interrupted_private_cleanup_keeps_a_replacement_overlay_directory() {
        let fixture = OverlayFixture::new();
        let mut overlay = GitOverlay::ensure(&fixture.cache, &fixture.task)
            .unwrap()
            .unwrap();
        git(
            &fixture.main,
            &["worktree", "remove", fixture.task.to_str().unwrap()],
        );
        overlay.manifest.removing = true;
        write_manifest(&overlay.manifest_path, &overlay.manifest).unwrap();
        fs::remove_dir_all(&overlay.git_dir).unwrap();
        fs::create_dir_all(&overlay.git_dir).unwrap();
        let replacement = overlay.git_dir.join("private-replacement.txt");
        fs::write(&replacement, "unrelated data").unwrap();

        let error = forget_removed_worktree_in_cache(&fixture.cache, &fixture.task).unwrap_err();
        assert!(error.contains("retained unverifiable data"), "{error}");
        assert!(error.contains(&overlay.git_dir.to_string_lossy().to_string()));
        assert_eq!(fs::read_to_string(&replacement).unwrap(), "unrelated data");
        assert!(overlay.manifest_path.exists());
    }

    fn git(directory: &Path, arguments: &[&str]) -> String {
        let result = output(git_command().arg("-C").arg(directory).args(arguments)).unwrap();
        String::from_utf8(result.stdout).unwrap().trim().to_string()
    }

    fn overlay_git(overlay: &GitOverlay, arguments: &[&str]) -> String {
        let mut command = git_command();
        overlay.apply(&mut command);
        let result = output(command.arg("-C").arg(&overlay.worktree).args(arguments)).unwrap();
        String::from_utf8(result.stdout).unwrap().trim().to_string()
    }

    #[test]
    fn private_git_dir_keeps_task_commits_out_of_sibling_refs() {
        let root = std::env::temp_dir().join(format!("sail-overlay-test-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let task = root.join("task");
        let sibling = root.join("sibling");
        let cache = root.join("cache");
        fs::create_dir_all(&main).unwrap();
        git(&main, &["init", "-q"]);
        git(&main, &["config", "user.name", "Overlay Test"]);
        git(&main, &["config", "user.email", "overlay@example.com"]);
        fs::write(main.join("initial.txt"), "initial\n").unwrap();
        git(&main, &["add", "initial.txt"]);
        git(
            &main,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "initial"],
        );
        let base_branch = git(&main, &["symbolic-ref", "--short", "HEAD"]);
        git(
            &main,
            &["config", "remote.origin.url", main.to_str().unwrap()],
        );
        git(
            &main,
            &[
                "config",
                "remote.origin.fetch",
                "+refs/heads/*:refs/remotes/origin/*",
            ],
        );
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task",
                task.to_str().unwrap(),
            ],
        );
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "sibling",
                sibling.to_str().unwrap(),
            ],
        );
        fs::write(task.join("staged.txt"), "staged\n").unwrap();
        git(&task, &["add", "staged.txt"]);
        let task_before = git(&task, &["rev-parse", "HEAD"]);
        let sibling_before = git(&sibling, &["rev-parse", "HEAD"]);
        let overlay = GitOverlay::ensure(&cache, &task).unwrap().unwrap();
        require_shared_current_in_cache(&cache, &task).unwrap();
        assert_eq!(index_differs(&task), Some(false));
        assert!(overlay.git_dir.starts_with(cache.join("git-overlays")));
        assert_eq!(
            overlay_git(&overlay, &["status", "--porcelain"]),
            "A  staged.txt"
        );
        assert_eq!(git(&task, &["status", "--porcelain"]), "A  staged.txt");
        assert_eq!(
            overlay_git(&overlay, &["config", "--get", "remote.origin.url"]),
            main.to_str().unwrap()
        );
        assert_eq!(
            overlay_git(&overlay, &["config", "--get", "core.hooksPath"]),
            git_config_path(&main.canonicalize().unwrap().join(".git/hooks"))
                .to_str()
                .unwrap()
        );
        fs::write(task.join("agent.txt"), "task change\n").unwrap();
        overlay_git(&overlay, &["add", "agent.txt"]);
        overlay_git(
            &overlay,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "task change"],
        );
        assert_eq!(index_differs(&task), Some(true));
        assert_eq!(
            overlay_git(&overlay, &["show", "HEAD:initial.txt"]),
            "initial"
        );
        assert_ne!(overlay_git(&overlay, &["rev-parse", "HEAD"]), task_before);
        assert!(require_shared_current_in_cache(&cache, &task).is_err());
        assert_eq!(git(&task, &["rev-parse", "HEAD"]), task_before);
        assert_eq!(git(&sibling, &["rev-parse", "HEAD"]), sibling_before);
        fs::write(main.join("main.txt"), "base change\n").unwrap();
        git(&main, &["add", "main.txt"]);
        git(
            &main,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base change"],
        );
        overlay_git(&overlay, &["fetch", "-q", "origin"]);
        overlay_git(
            &overlay,
            &["rebase", "-q", &format!("origin/{base_branch}")],
        );
        assert_eq!(git(&task, &["rev-parse", "HEAD"]), task_before);
        assert_eq!(git(&sibling, &["rev-parse", "HEAD"]), sibling_before);
        let overlay_head = overlay_git(&overlay, &["rev-parse", "HEAD"]);
        let mut overlay = overlay;
        assert_eq!(
            overlay
                .promote_quiescent(|| Err("writer active".into()))
                .unwrap_err(),
            "writer active"
        );
        assert_eq!(git(&task, &["rev-parse", "HEAD"]), task_before);
        overlay.promote_quiescent(|| Ok(())).unwrap();
        assert_eq!(index_differs(&task), Some(false));
        require_shared_current_in_cache(&cache, &task).unwrap();
        assert_eq!(git(&task, &["rev-parse", "HEAD"]), overlay_head);
        assert_eq!(git(&task, &["status", "--porcelain"]), "");
        assert_eq!(git(&sibling, &["rev-parse", "HEAD"]), sibling_before);
        assert_eq!(
            GitOverlay::existing(&cache, &task)
                .unwrap()
                .unwrap()
                .manifest
                .promoted_oid,
            overlay_head
        );
        fs::write(task.join("staged-only.txt"), "staged without commit\n").unwrap();
        overlay_git(&overlay, &["add", "staged-only.txt"]);
        let source_index = overlay.manifest.source_git_dir.join("index");
        let source_before = fs::read(&source_index).unwrap();
        let source_lock = source_index.with_extension("lock");
        let held_lock = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&source_lock)
            .unwrap();
        fs::write(task.join("blocked-external.txt"), "blocked\n").unwrap();
        assert!(git_command()
            .arg("-C")
            .arg(&task)
            .args(["add", "blocked-external.txt"])
            .output()
            .unwrap()
            .status
            .code()
            .is_some_and(|code| code != 0));
        assert!(overlay.promote_quiescent(|| Ok(())).is_err());
        assert_eq!(fs::read(&source_index).unwrap(), source_before);
        drop(held_lock);
        fs::remove_file(&source_lock).unwrap();
        fs::remove_file(task.join("blocked-external.txt")).unwrap();
        overlay.promote_quiescent(|| Ok(())).unwrap();
        assert_eq!(git(&task, &["rev-parse", "HEAD"]), overlay_head);
        assert_eq!(git(&task, &["status", "--porcelain"]), "A  staged-only.txt");
        require_shared_current_in_cache(&cache, &task).unwrap();
        fs::write(task.join("recovery.txt"), "recovery\n").unwrap();
        overlay_git(&overlay, &["add", "recovery.txt"]);
        overlay_git(
            &overlay,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "recovery"],
        );
        let recovered_head = overlay_git(&overlay, &["rev-parse", "HEAD"]);
        let mut pending = overlay.manifest.clone();
        pending.promotion = Some(Promotion {
            expected_oid: overlay_head.clone(),
            new_oid: recovered_head.clone(),
            new_index_hash: index_hash(&overlay.git_dir.join("index")).unwrap().unwrap(),
            index_backup: format!("index.sail-overlay-{}.backup", uuid::Uuid::new_v4()),
        });
        write_manifest(&overlay.manifest_path, &pending).unwrap();
        git(
            &task,
            &[
                "fetch",
                "--no-write-fetch-head",
                "--no-tags",
                overlay.git_dir.to_str().unwrap(),
                &recovered_head,
            ],
        );
        git(
            &task,
            &[
                "update-ref",
                "refs/heads/task",
                &recovered_head,
                &overlay_head,
            ],
        );
        let mut reopened = GitOverlay::existing(&cache, &task).unwrap().unwrap();
        reopened.promote_quiescent(|| Ok(())).unwrap();
        assert_eq!(reopened.manifest.promoted_oid, recovered_head);
        assert!(reopened.manifest.promotion.is_none());
        assert_eq!(git(&sibling, &["rev-parse", "HEAD"]), sibling_before);
        fs::write(task.join("external-staged.txt"), "external\n").unwrap();
        git(&task, &["add", "external-staged.txt"]);
        fs::write(task.join("private-staged.txt"), "private\n").unwrap();
        overlay_git(&reopened, &["add", "private-staged.txt"]);
        let shared_index = fs::read(&source_index).unwrap();
        assert!(reopened.promote_quiescent(|| Ok(())).is_err());
        assert_eq!(fs::read(&source_index).unwrap(), shared_index);
        assert!(git(&task, &["status", "--porcelain"]).contains("A  external-staged.txt"));
        assert_eq!(git(&sibling, &["rev-parse", "HEAD"]), sibling_before);
        fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn corrupt_overlay_manifest_still_marks_worktree_as_private() {
        let root =
            std::env::temp_dir().join(format!("sail-overlay-corrupt-{}", uuid::Uuid::new_v4()));
        let cache = root.join("cache");
        let task = root.join("task");
        let nested = task.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let (_, manifest, _) = paths(&cache, &task);
        fs::create_dir_all(manifest.parent().unwrap()).unwrap();
        fs::write(&manifest, b"invalid manifest").unwrap();
        assert_eq!(known_worktree_in_cache(&cache, &nested), Some(task.clone()));
        assert!(require_shared_current_in_cache(&cache, &task).is_err());
        fs::remove_dir_all(&root).unwrap();
    }
    #[cfg(windows)]
    #[test]
    fn windows_git_config_paths_use_forward_slashes() {
        assert_eq!(
            git_config_path(Path::new(r"C:\task\repo\.git\config")),
            OsString::from("C:/task/repo/.git/config")
        );
        assert_eq!(
            git_config_quoted_path(Path::new(r"C:\task\repo\.git\config")).unwrap(),
            "\"C:/task/repo/.git/config\""
        );
        assert_eq!(
            git_config_path(Path::new(r"\\?\C:\task\repo\.git\config")),
            OsString::from("C:/task/repo/.git/config")
        );
        assert_eq!(
            git_config_path(Path::new(r"\\?\UNC\server\share\repo\.git\config")),
            OsString::from("//server/share/repo/.git/config")
        );
    }

    #[test]
    fn split_index_is_self_contained_and_promotes_as_full_index() {
        let root =
            std::env::temp_dir().join(format!("sail-overlay-split-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let task = root.join("task");
        let cache = root.join("cache");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main", main.to_str().unwrap()]);
        git(&main, &["config", "user.name", "Sail Test"]);
        git(&main, &["config", "user.email", "sail@example.test"]);
        fs::write(main.join("initial.txt"), "base\n").unwrap();
        git(&main, &["add", "initial.txt"]);
        git(
            &main,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task",
                task.to_str().unwrap(),
            ],
        );
        git(&task, &["config", "core.splitIndex", "true"]);
        fs::write(task.join("staged.txt"), "staged\n").unwrap();
        git(&task, &["add", "staged.txt"]);
        git(&task, &["update-index", "--split-index"]);
        assert!(!git(&task, &["rev-parse", "--shared-index-path"]).is_empty());
        let before = git(&task, &["rev-parse", "HEAD"]);
        let mut overlay = GitOverlay::ensure(&cache, &task).unwrap().unwrap();
        assert!(overlay_git(&overlay, &["rev-parse", "--shared-index-path"]).is_empty());
        assert_eq!(
            overlay_git(&overlay, &["config", "--bool", "core.splitIndex"]),
            "false"
        );
        assert_eq!(
            overlay_git(&overlay, &["status", "--porcelain"]),
            "A  staged.txt"
        );
        fs::write(task.join("agent.txt"), "agent\n").unwrap();
        overlay_git(&overlay, &["add", "agent.txt"]);
        overlay_git(
            &overlay,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "private commit",
            ],
        );
        assert!(overlay_git(&overlay, &["rev-parse", "--shared-index-path"]).is_empty());
        assert_eq!(git(&task, &["rev-parse", "HEAD"]), before);
        overlay.promote_quiescent(|| Ok(())).unwrap();
        assert!(overlay_git(&overlay, &["rev-parse", "--shared-index-path"]).is_empty());
        assert!(shared_index_path(git_command().arg("-C").arg(&task))
            .unwrap()
            .is_none());
        assert!(
            !copy_source_shared_index(&source(&task).unwrap().unwrap(), &overlay.git_dir).unwrap()
        );
        assert_eq!(
            fs::read(overlay.manifest.source_git_dir.join("index")).unwrap(),
            fs::read(overlay.git_dir.join("index")).unwrap()
        );
        assert_eq!(
            git(&task, &["rev-parse", "HEAD"]),
            overlay_git(&overlay, &["rev-parse", "HEAD"])
        );
        assert_eq!(git(&task, &["status", "--porcelain"]), "");
        assert!(require_shared_current_in_cache(&cache, &task).is_err());
        assert_eq!(overlay_git(&overlay, &["status", "--porcelain"]), "");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn detached_linked_worktree_does_not_create_a_branch_overlay() {
        let root =
            std::env::temp_dir().join(format!("sail-overlay-detached-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let detached = root.join("detached");
        let task = root.join("task");
        let cache = root.join("cache");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main", main.to_str().unwrap()]);
        git(&main, &["config", "user.name", "Sail Test"]);
        git(&main, &["config", "user.email", "sail@example.test"]);
        fs::write(main.join("initial.txt"), "base\n").unwrap();
        git(&main, &["add", "initial.txt"]);
        git(
            &main,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "detached",
                detached.to_str().unwrap(),
            ],
        );
        git(&detached, &["checkout", "--detach", "-q"]);

        assert!(source(&detached).unwrap().is_none());
        assert!(GitOverlay::ensure(&cache, &detached).unwrap().is_none());
        let (_, manifest, _) = paths(&cache, &detached.canonicalize().unwrap());
        assert!(!manifest.exists());

        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task",
                task.to_str().unwrap(),
            ],
        );
        assert!(GitOverlay::ensure(&cache, &task).unwrap().is_some());
        git(&task, &["checkout", "--detach", "-q"]);
        assert!(GitOverlay::existing(&cache, &task).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn staged_recovery_accepts_only_the_original_synchronized_overlay() {
        let root = std::env::temp_dir().join(format!(
            "sail-overlay-staged-recovery-{}",
            uuid::Uuid::new_v4()
        ));
        let main = root.join("main");
        let task = root.join("task");
        let recovery = root.join("recovery");
        let cache = root.join("cache");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main", main.to_str().unwrap()]);
        git(&main, &["config", "user.name", "Sail Test"]);
        git(&main, &["config", "user.email", "sail@example.test"]);
        git(
            &main,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "base",
            ],
        );
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task",
                task.to_str().unwrap(),
            ],
        );
        let overlay = GitOverlay::ensure(&cache, &task).unwrap().unwrap();
        require_shared_current_in_cache(&cache, &task).unwrap();

        git(
            &main,
            &[
                "worktree",
                "move",
                task.to_str().unwrap(),
                recovery.to_str().unwrap(),
            ],
        );
        require_recoverable_private_state_at_missing_in_cache(&cache, &task, &recovery).unwrap();
        assert!(overlay.manifest_path.exists());
        git(
            &main,
            &[
                "worktree",
                "move",
                recovery.to_str().unwrap(),
                task.to_str().unwrap(),
            ],
        );
        require_shared_current_in_cache(&cache, &task).unwrap();
        git(
            &main,
            &[
                "worktree",
                "move",
                task.to_str().unwrap(),
                recovery.to_str().unwrap(),
            ],
        );
        git(
            &recovery,
            &[
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "changed",
            ],
        );
        assert!(
            require_recoverable_private_state_at_missing_in_cache(&cache, &task, &recovery)
                .is_err()
        );
        assert!(overlay.manifest_path.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_deletion_forgets_overlay_before_path_reuse() {
        let root =
            std::env::temp_dir().join(format!("sail-overlay-delete-{}", uuid::Uuid::new_v4()));
        let main = root.join("main");
        let task = root.join("task");
        let cache = root.join("cache");
        fs::create_dir_all(&root).unwrap();
        git(&root, &["init", "-q", "-b", "main", main.to_str().unwrap()]);
        git(&main, &["config", "user.name", "Sail Test"]);
        git(&main, &["config", "user.email", "sail@example.test"]);
        fs::write(main.join("initial.txt"), "base\n").unwrap();
        git(&main, &["add", "initial.txt"]);
        git(
            &main,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "task",
                task.to_str().unwrap(),
            ],
        );
        let overlay = GitOverlay::ensure(&cache, &task).unwrap().unwrap();
        assert!(forget_removed_worktree_in_cache(&cache, &task).is_err());
        assert!(overlay.manifest_path.exists());
        require_shared_current_in_cache(&cache, &task).unwrap();
        git(&main, &["worktree", "remove", task.to_str().unwrap()]);
        fs::remove_dir_all(&overlay.git_dir).unwrap();
        assert!(overlay.manifest_path.exists());
        let wrong_common = root.join("unrelated-git");
        assert!(
            forget_removed_worktree_in_cache_checked(&cache, &task, Some(&wrong_common)).is_err()
        );
        forget_removed_worktree_in_cache_checked(
            &cache,
            &task,
            Some(&main.join(".git").canonicalize().unwrap()),
        )
        .unwrap();
        assert!(!overlay.git_dir.exists());
        assert!(!overlay.manifest_path.exists());
        assert_eq!(known_worktree_in_cache(&cache, &task), None);
        assert!(!ACTIVE
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .iter()
            .any(|(owner, _, _)| owner == &task));
        git(
            &main,
            &["worktree", "add", "-q", task.to_str().unwrap(), "task"],
        );
        let same_branch = GitOverlay::ensure(&cache, &task).unwrap().unwrap();
        require_shared_current_in_cache(&cache, &task).unwrap();
        git(&main, &["worktree", "remove", task.to_str().unwrap()]);
        forget_removed_worktree_in_cache(&cache, &task).unwrap();
        assert!(!same_branch.manifest_path.exists());
        git(
            &main,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "other",
                task.to_str().unwrap(),
            ],
        );
        let other_branch = GitOverlay::ensure(&cache, &task).unwrap().unwrap();
        assert_eq!(other_branch.manifest.branch, "refs/heads/other");
        fs::remove_dir_all(root).unwrap();
    }
}
