use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const CONFIG: &str = ".sail/worktree.json";

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorktreeConfig {
    #[serde(default)]
    pub setup: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub archive: String,
    #[serde(default)]
    pub copy: Vec<String>,
    #[serde(default, rename = "postTurnChecks")]
    pub post_turn_checks: Vec<String>,
}

pub fn read(directory: &Path) -> Result<Option<WorktreeConfig>, String> {
    let path = directory.join(CONFIG);
    if !path.exists() {
        return Ok(None);
    }
    let tracked = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["ls-files", "--error-unmatch", "--", CONFIG])
        .output()
        .map_err(|error| format!("Cannot inspect Sail config: {error}"))?;
    if !tracked.status.success() {
        return Err("Sail worktree config must be committed to the repository.".to_string());
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("Sail worktree config must be a file smaller than 64 KiB.".to_string());
    }
    let value = std::fs::read(&path).map_err(|error| error.to_string())?;
    let config: WorktreeConfig = serde_json::from_slice(&value)
        .map_err(|error| format!("Invalid Sail worktree config: {error}"))?;
    if config
        .post_turn_checks
        .iter()
        .any(|command| command.trim().is_empty())
    {
        return Err("Post-turn check command cannot be empty.".to_string());
    }
    for item in &config.copy {
        let path = Path::new(item);
        if item.is_empty()
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(format!("Invalid copied path: {item}"));
        }
    }
    Ok(Some(config))
}

fn copy_entry(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Copied path contains a symlink: {}",
            source.display()
        ));
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::copy(source, destination).map_err(|error| error.to_string())?;
    } else {
        return Err(format!(
            "Copied path is not a file or folder: {}",
            source.display()
        ));
    }
    Ok(())
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), String> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Copied path contains a symlink: {}",
                    path.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub fn copy_ignored(
    repository: &Path,
    worktree: &Path,
    config: &WorktreeConfig,
) -> Result<(), String> {
    for item in &config.copy {
        let relative = PathBuf::from(item);
        let source = repository.join(&relative);
        reject_symlink_components(repository, &relative)?;
        if !source.exists() {
            continue;
        }
        let ignored = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(["check-ignore", "-q", "--"])
            .arg(&relative)
            .status()
            .map_err(|error| format!("Cannot check ignored path: {error}"))?;
        if !ignored.success() {
            return Err(format!("Configured copied path is not gitignored: {item}"));
        }
        let destination = worktree.join(&relative);
        reject_symlink_components(worktree, &relative)?;
        if destination.exists() {
            return Err(format!("Copied path already exists in worktree: {item}"));
        }
        copy_entry(&source, &destination)?;
    }
    Ok(())
}
