use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};

const VERSION: u8 = 1;
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
    let manifest = read_manifest(&manifest_path)?
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
    if present(&private) {
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
        fs::remove_dir_all(&private).map_err(|error| error.to_string())?;
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
    command
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
    for line in String::from_utf8(refs.stdout)
        .map_err(|error| error.to_string())?
        .lines()
    {
        let (reference, oid) = line
            .split_once(' ')
            .ok_or("Invalid source Git reference output.")?;
        output(
            git_command()
                .arg("--git-dir")
                .arg(git_config_path(git_dir))
                .args(["update-ref", reference, oid]),
        )?;
    }
    Ok(())
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
            return Ok(Some(existing));
        }
        if git_dir.exists() {
            return Err("Unregistered private Git overlay requires recovery.".into());
        }
        fs::create_dir_all(git_dir.parent().ok_or("Invalid overlay path.")?)
            .map_err(|error| error.to_string())?;
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
        config_entries.push_str("[core]\n\tbare = false\n\tsplitIndex = false\n");
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
        };
        write_manifest(&manifest_path, &manifest)?;
        validate_overlay(&git_dir, &manifest.common_dir)?;
        let overlay = Self {
            git_dir,
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
