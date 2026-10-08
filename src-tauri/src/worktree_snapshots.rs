use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::fs::{self, File, OpenOptions};
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::validate_repository;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SnapshotInfo {
    id: String,
    kind: String,
    created: u128,
}

struct PrivateIndex(PathBuf);

struct SnapshotTree {
    index: PrivateIndex,
    files: HashSet<PathBuf>,
    links: HashMap<PathBuf, String>,
}

impl Drop for PrivateIndex {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
        let _ = fs::remove_file(self.0.with_extension("lock"));
    }
}

fn git(root: &Path, args: &[&str], index: Option<&Path>) -> Result<Vec<u8>, String> {
    let mut command = Command::new("git");
    // Snapshot refs nest two hashes, which exceeds the legacy Windows path limit.
    #[cfg(windows)]
    command.arg("-c").arg("core.longpaths=true");
    command.arg("-C").arg(root).args(args);
    if let Some(index) = index {
        command.env("GIT_INDEX_FILE", index);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).trim().to_string());
    }
    Ok(output.stdout)
}

fn git_path(root: &Path, name: &str) -> Result<PathBuf, String> {
    let output = git(root, &["rev-parse", "--git-path", name], None)?;
    let path = String::from_utf8(output).map_err(|error| error.to_string())?;
    let path = Path::new(path.trim());
    Ok(if path.is_absolute() {
        path.to_path_buf()
    } else {
        root.join(path)
    })
}

fn lock(root: &Path) -> Result<File, String> {
    let path = git_path(root, "sail-snapshots.lock")?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path)
        .map_err(|error| error.to_string())?;
    file.lock().map_err(|error| error.to_string())?;
    Ok(file)
}

fn private_index(root: &Path, copy_real: bool) -> Result<PrivateIndex, String> {
    let real = git_path(root, "index")?;
    let temporary =
        PrivateIndex(real.with_file_name(format!("sail-snapshot-index-{}", uuid::Uuid::new_v4())));
    if copy_real && real.exists() {
        fs::copy(real, &temporary.0).map_err(|error| error.to_string())?;
    }
    Ok(temporary)
}

fn hash(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn prefix(root: &Path, thread: &str) -> String {
    format!(
        "refs/sail/turns/{}/{}/",
        hash(&root.to_string_lossy()),
        hash(thread)
    )
}

fn snapshot(root: &Path, thread: &str, kind: &str) -> Result<SnapshotInfo, String> {
    let index = private_index(root, true)?;
    git(root, &["add", "-A"], Some(&index.0))?;
    let tree = String::from_utf8(git(root, &["write-tree"], Some(&index.0))?)
        .map_err(|error| error.to_string())?;
    let created = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_millis();
    let id = format!(
        "{}{kind}/{created:013}-{}",
        prefix(root, thread),
        uuid::Uuid::new_v4()
    );
    git(root, &["update-ref", &id, tree.trim()], None)?;
    Ok(SnapshotInfo {
        id,
        kind: kind.to_string(),
        created,
    })
}

fn parse_snapshot(id: String, prefix: &str) -> Option<SnapshotInfo> {
    let suffix = id.strip_prefix(prefix)?;
    let (kind, name) = suffix.split_once('/')?;
    if !matches!(kind, "turn" | "undo") || name.contains('/') {
        return None;
    }
    let (created, _) = name.split_once('-')?;
    let kind = kind.to_string();
    let created = created.parse().ok()?;
    Some(SnapshotInfo { id, kind, created })
}

/// Scopes holding a thread's snapshots; OpenCode threads also keep those taken under the native id.
fn scopes(root: &Path, thread: &str) -> Vec<String> {
    let mut scopes = vec![prefix(root, thread)];
    if let Some(session) = thread.strip_prefix("acp:opencode:") {
        scopes.push(prefix(root, &format!("opencode:{session}")));
    }
    scopes
}

fn list(root: &Path, thread: &str) -> Result<Vec<SnapshotInfo>, String> {
    let mut items = Vec::new();
    for scope in scopes(root, thread) {
        let output = git(root, &["for-each-ref", "--format=%(refname)", &scope], None)?;
        items.extend(
            String::from_utf8(output)
                .map_err(|error| error.to_string())?
                .lines()
                .filter_map(|line| parse_snapshot(line.to_string(), &scope)),
        );
    }
    items.sort_by(|left, right| {
        right
            .created
            .cmp(&left.created)
            .then_with(|| right.id.cmp(&left.id))
    });
    Ok(items)
}

#[cfg(unix)]
fn git_filename(bytes: &[u8]) -> OsString {
    use std::os::unix::ffi::OsStringExt;
    OsString::from_vec(bytes.to_vec())
}

#[cfg(not(unix))]
fn git_filename(bytes: &[u8]) -> OsString {
    OsString::from(String::from_utf8_lossy(bytes).into_owned())
}

fn paths(root: &Path, id: &str) -> Result<SnapshotTree, String> {
    let index = private_index(root, false)?;
    git(root, &["read-tree", id], Some(&index.0))?;
    let output = git(root, &["ls-files", "--stage", "-z"], Some(&index.0))?;
    let mut files = HashSet::new();
    let mut links = HashMap::new();
    for entry in output
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        let tab = entry
            .iter()
            .position(|byte| *byte == b'\t')
            .ok_or("Git returned an invalid index entry.")?;
        let mut metadata = entry[..tab].split(|byte| *byte == b' ');
        let mode = metadata
            .next()
            .ok_or("Git returned an invalid index mode.")?;
        let object = metadata
            .next()
            .ok_or("Git returned an invalid index object.")?;
        let path = PathBuf::from(git_filename(&entry[tab + 1..]));
        if mode == b"160000" {
            links.insert(path.clone(), String::from_utf8_lossy(object).into_owned());
        }
        files.insert(path);
    }
    Ok(SnapshotTree {
        index,
        files,
        links,
    })
}

fn safe_path(root: &Path, relative: &Path) -> Result<PathBuf, String> {
    if relative
        .components()
        .any(|part| !matches!(part, Component::Normal(_)))
    {
        return Err("Snapshot contains an invalid file path.".into());
    }
    Ok(root.join(relative))
}

fn check_parent_symlinks(
    root: &Path,
    relative: &Path,
    previous_files: &HashSet<PathBuf>,
    target_files: &HashSet<PathBuf>,
) -> Result<(), String> {
    let mut parent = safe_path(root, relative)?;
    while let Some(directory) = parent.parent().filter(|directory| *directory != root) {
        let path = directory
            .strip_prefix(root)
            .map_err(|error| error.to_string())?;
        if directory
            .symlink_metadata()
            .is_ok_and(|metadata| !metadata.is_dir())
            && !(previous_files.contains(path) && !target_files.contains(path))
        {
            return Err(format!(
                "A file or symbolic link blocks restore: {}",
                relative.display()
            ));
        }
        parent = directory.to_path_buf();
    }
    Ok(())
}

fn known_directory(
    root: &Path,
    path: &Path,
    previous_files: &HashSet<PathBuf>,
) -> Result<bool, String> {
    for entry in fs::read_dir(path).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let child = entry.path();
        if entry
            .file_type()
            .map_err(|error| error.to_string())?
            .is_dir()
        {
            if !known_directory(root, &child, previous_files)? {
                return Ok(false);
            }
        } else if !previous_files.contains(
            child
                .strip_prefix(root)
                .map_err(|error| error.to_string())?,
        ) {
            return Ok(false);
        }
    }
    Ok(true)
}

fn apply(root: &Path, target: &str, previous: &str) -> Result<(), String> {
    let target = paths(root, target)?;
    let previous = paths(root, previous)?;
    if target.links != previous.links {
        return Err("Restore cannot change a submodule's checked-out commit.".into());
    }
    for relative in target.files.union(&previous.files) {
        check_parent_symlinks(root, relative, &previous.files, &target.files)?;
    }
    for relative in &target.files {
        if target.links.contains_key(relative) {
            continue;
        }
        let path = safe_path(root, relative)?;
        if previous.files.contains(relative) && path.is_dir() {
            return Err(format!(
                "An external directory blocks restore: {}",
                relative.display()
            ));
        }
        if !previous.files.contains(relative)
            && path.symlink_metadata().is_ok()
            && !(path.is_dir()
                && previous.files.iter().any(|file| file.starts_with(relative))
                && known_directory(root, &path, &previous.files)?)
        {
            return Err(format!(
                "An ignored or external file blocks restore: {}",
                relative.display()
            ));
        }
    }
    for relative in previous.files.difference(&target.files) {
        let path = safe_path(root, relative)?;
        if path
            .symlink_metadata()
            .is_ok_and(|metadata| metadata.is_dir())
        {
            return Err(format!(
                "An external directory blocks restore: {}",
                relative.display()
            ));
        }
    }
    for relative in previous.files.difference(&target.files) {
        let path = safe_path(root, relative)?;
        if path.symlink_metadata().is_ok() {
            fs::remove_file(&path).map_err(|error| error.to_string())?;
        }
        let mut parent = path.parent();
        while let Some(directory) = parent.filter(|directory| *directory != root) {
            if fs::remove_dir(directory).is_err() {
                break;
            }
            parent = directory.parent();
        }
    }
    git(
        root,
        &["checkout-index", "--all", "--force"],
        Some(&target.index.0),
    )?;
    Ok(())
}

#[tauri::command]
pub async fn record_turn_snapshot(path: String, thread: String) -> Result<SnapshotInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(validate_repository(path)?);
        let _lock = lock(&root)?;
        snapshot(&root, &thread, "turn")
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn list_turn_snapshots(
    path: String,
    thread: String,
) -> Result<Vec<SnapshotInfo>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(validate_repository(path)?);
        list(&root, &thread)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn restore_turn_snapshot(
    path: String,
    thread: String,
    id: String,
) -> Result<SnapshotInfo, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = PathBuf::from(validate_repository(path)?);
        let _lock = lock(&root)?;
        if !list(&root, &thread)?.iter().any(|item| item.id == id) {
            return Err("Snapshot does not belong to this thread and worktree.".into());
        }
        let undo = snapshot(&root, &thread, "undo")?;
        if let Err(error) = apply(&root, &id, &undo.id) {
            let partial = snapshot(&root, &thread, "undo")?;
            if let Err(rollback) = apply(&root, &undo.id, &partial.id) {
                return Err(format!(
                    "Restore failed: {error}. Rollback failed: {rollback}."
                ));
            }
            git(&root, &["update-ref", "-d", &partial.id], None)?;
            git(&root, &["update-ref", "-d", &undo.id], None)?;
            return Err(format!("Restore failed and was rolled back: {error}"));
        }
        Ok(undo)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lists_opencode_snapshots_taken_under_the_native_thread_id() {
        let root =
            std::env::temp_dir().join(format!("sail-snapshot-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet"], None).unwrap();
        fs::write(root.join("file.txt"), "one").unwrap();
        let native = snapshot(&root, "opencode:ses_1", "turn").unwrap();
        let acp = snapshot(&root, "acp:opencode:ses_1", "turn").unwrap();
        snapshot(&root, "opencode:ses_2", "turn").unwrap();

        let ids = |thread: &str| -> Vec<String> {
            let mut ids: Vec<_> = list(&root, thread)
                .unwrap()
                .into_iter()
                .map(|item| item.id)
                .collect();
            ids.sort();
            ids
        };
        let mut both = vec![native.id.clone(), acp.id.clone()];
        both.sort();
        assert_eq!(ids("acp:opencode:ses_1"), both);
        assert_eq!(ids("opencode:ses_1"), vec![native.id]);
        assert!(ids("acp:claude:ses_1").is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn restores_created_edited_and_deleted_files_without_changing_index() {
        let root =
            std::env::temp_dir().join(format!("sail-snapshot-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        git(&root, &["init", "--quiet"], None).unwrap();
        fs::write(root.join("edited.txt"), "before").unwrap();
        fs::write(root.join("deleted.txt"), "before").unwrap();
        git(&root, &["add", "-A"], None).unwrap();
        let before_index = fs::read(git_path(&root, "index").unwrap()).unwrap();
        let before = snapshot(&root, "test", "turn").unwrap();

        fs::write(root.join("edited.txt"), "after").unwrap();
        fs::remove_file(root.join("deleted.txt")).unwrap();
        fs::write(root.join("created.txt"), "after").unwrap();
        let undo = snapshot(&root, "test", "undo").unwrap();
        apply(&root, &before.id, &undo.id).unwrap();

        assert_eq!(
            fs::read_to_string(root.join("edited.txt")).unwrap(),
            "before"
        );
        assert_eq!(
            fs::read_to_string(root.join("deleted.txt")).unwrap(),
            "before"
        );
        assert!(!root.join("created.txt").exists());
        assert_eq!(
            fs::read(git_path(&root, "index").unwrap()).unwrap(),
            before_index
        );

        apply(&root, &undo.id, &before.id).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("edited.txt")).unwrap(),
            "after"
        );
        assert!(!root.join("deleted.txt").exists());
        assert_eq!(
            fs::read_to_string(root.join("created.txt")).unwrap(),
            "after"
        );

        fs::create_dir(root.join("shape")).unwrap();
        fs::write(root.join("shape/child.txt"), "child").unwrap();
        let directory = snapshot(&root, "test", "turn").unwrap();
        fs::remove_file(root.join("shape/child.txt")).unwrap();
        fs::remove_dir(root.join("shape")).unwrap();
        fs::write(root.join("shape"), "file").unwrap();
        let file = snapshot(&root, "test", "turn").unwrap();
        apply(&root, &directory.id, &file.id).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("shape/child.txt")).unwrap(),
            "child"
        );
        apply(&root, &file.id, &directory.id).unwrap();
        assert_eq!(fs::read_to_string(root.join("shape")).unwrap(), "file");

        let child = root.with_extension("child");
        fs::create_dir(&child).unwrap();
        git(&child, &["init", "--quiet"], None).unwrap();
        fs::write(child.join("file"), "submodule").unwrap();
        git(&child, &["add", "file"], None).unwrap();
        git(
            &child,
            &[
                "-c",
                "commit.gpgsign=false",
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "commit",
                "--quiet",
                "-m",
                "initial",
            ],
            None,
        )
        .unwrap();
        git(
            &root,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                "--quiet",
                child.to_str().unwrap(),
                "sub",
            ],
            None,
        )
        .unwrap();
        let before_submodule = snapshot(&root, "test", "turn").unwrap();
        fs::write(root.join("edited.txt"), "submodule turn").unwrap();
        let after_submodule = snapshot(&root, "test", "turn").unwrap();
        apply(&root, &before_submodule.id, &after_submodule.id).unwrap();
        assert_eq!(
            fs::read_to_string(root.join("edited.txt")).unwrap(),
            "after"
        );
        assert_eq!(
            fs::read_to_string(root.join("sub/file")).unwrap(),
            "submodule"
        );
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(child).unwrap();
    }
}
