use crate::memory::{self, MemoryInput, MemoryKind, MemoryProvenance, MemoryRecord};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::{Path, PathBuf};
use tauri::AppHandle;

const MAX_SOURCE_BYTES: u64 = 16 * 1024;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryImportCandidate {
    id: String,
    agent: &'static str,
    source: String,
    content: String,
}

fn claude_config_dir() -> Result<PathBuf, String> {
    if let Some(path) = std::env::var_os("CLAUDE_CONFIG_DIR") {
        return Ok(PathBuf::from(path));
    }
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(|home| PathBuf::from(home).join(".claude"))
        .ok_or("Cannot find the home folder.".into())
}

fn claude_project_name(path: &Path) -> String {
    path.to_string_lossy()
        .chars()
        .map(|character| {
            if character.is_ascii_alphanumeric() {
                character
            } else {
                '-'
            }
        })
        .collect()
}

fn source_files(project: &Path, config: &Path) -> Result<Vec<PathBuf>, String> {
    let common = crate::git_common_directory(project)?;
    let repository = common
        .parent()
        .ok_or("Cannot locate the repository root.")?;
    let selected = dunce::canonicalize(project)
        .map_err(|_| "Repository folder no longer exists.".to_string())?;
    let mut directories = vec![repository.to_path_buf()];
    if selected != repository {
        directories.push(selected);
    }
    let mut files = Vec::new();
    for directory in directories {
        files.extend(source_files_in_directory(&directory, config)?);
    }
    Ok(files)
}

fn source_files_in_directory(project: &Path, config: &Path) -> Result<Vec<PathBuf>, String> {
    let memory_dir = config
        .join("projects")
        .join(claude_project_name(project))
        .join("memory");
    match fs::symlink_metadata(&memory_dir) {
        Ok(metadata) if !metadata.file_type().is_dir() => return Ok(Vec::new()),
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot inspect Claude Code memory: {error}")),
    }
    let entries = match fs::read_dir(&memory_dir) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(format!("Cannot inspect Claude Code memory: {error}")),
    };
    let mut topics = Vec::new();
    let mut index = None;
    for entry in entries {
        let entry = entry.map_err(|error| format!("Cannot inspect Claude Code memory: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("md") {
            continue;
        }
        let metadata = fs::symlink_metadata(&path)
            .map_err(|error| format!("Cannot inspect Claude Code memory: {error}"))?;
        if !metadata.file_type().is_file() {
            continue;
        }
        if metadata.len() > MAX_SOURCE_BYTES {
            return Err(format!(
                "Claude Code memory file exceeds the 16 KiB import limit: {}",
                path.display()
            ));
        }
        if path.file_name().and_then(|name| name.to_str()) == Some("MEMORY.md") {
            index = Some(path);
        } else {
            topics.push(path);
        }
    }
    topics.sort();
    if let Some(index) = index {
        topics.push(index);
    }
    Ok(topics)
}

fn read_candidates(project: &Path, config: &Path) -> Result<Vec<MemoryImportCandidate>, String> {
    let mut candidates = Vec::new();
    let mut seen_content = std::collections::HashSet::new();
    for path in source_files(project, config)? {
        let raw = fs::read_to_string(&path)
            .map_err(|error| format!("Cannot read Claude Code memory: {error}"))?;
        let content = raw.trim();
        if content.is_empty() || !seen_content.insert(content.to_owned()) {
            continue;
        }
        if content.chars().count() > 4_000 {
            return Err(format!(
                "Claude Code memory exceeds Sail's 4,000-character limit: {}",
                path.display()
            ));
        }
        let mut digest = Sha256::new();
        digest.update(path.to_string_lossy().as_bytes());
        digest.update([0]);
        digest.update(content.as_bytes());
        let id = digest
            .finalize()
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        candidates.push(MemoryImportCandidate {
            id,
            agent: "claude",
            source: path.to_string_lossy().into_owned(),
            content: content.to_owned(),
        });
    }
    Ok(candidates)
}

fn import_tag(id: &str) -> String {
    format!("claude-import-{}", &id[..24])
}

fn pending_candidates(
    project: &Path,
    config: &Path,
    existing: &[MemoryRecord],
) -> Result<Vec<MemoryImportCandidate>, String> {
    let candidates = read_candidates(project, config)?;
    Ok(candidates
        .into_iter()
        .filter(|candidate| {
            let tag = import_tag(&candidate.id);
            !existing
                .iter()
                .any(|memory| memory.tags.contains(&tag) || memory.content == candidate.content)
        })
        .collect())
}

#[tauri::command]
pub fn preview_memory_import(
    app: AppHandle,
    directory: String,
) -> Result<Vec<MemoryImportCandidate>, String> {
    memory::ensure_enabled(&app, &directory)?;
    let existing = memory::list(&app, &directory, false)?;
    pending_candidates(Path::new(&directory), &claude_config_dir()?, &existing)
}

#[tauri::command]
pub fn import_agent_memories(
    app: AppHandle,
    directory: String,
    ids: Vec<String>,
) -> Result<Vec<MemoryRecord>, String> {
    memory::ensure_enabled(&app, &directory)?;
    if ids.len() > 100 {
        return Err("Select at most 100 memories per import.".into());
    }
    let existing = memory::list(&app, &directory, false)?;
    let pending = pending_candidates(Path::new(&directory), &claude_config_dir()?, &existing)?;
    let mut selected = Vec::new();
    for id in &ids {
        if selected
            .iter()
            .any(|candidate: &MemoryImportCandidate| &candidate.id == id)
        {
            return Err("Duplicate import selection.".into());
        }
        let candidate = pending
            .iter()
            .find(|candidate| &candidate.id == id)
            .ok_or("An import candidate changed or was already imported. Refresh the preview.")?;
        selected.push(candidate.clone());
    }
    memory::remember_unique_batch(
        &app,
        &directory,
        selected
            .into_iter()
            .map(|candidate| MemoryInput {
                content: candidate.content,
                kind: Some(MemoryKind::Other),
                tags: Some(vec![import_tag(&candidate.id)]),
                provenance: Some(MemoryProvenance {
                    agent: Some("claude".into()),
                    session_id: None,
                    source: Path::new(&candidate.source)
                        .file_name()
                        .map(|name| format!("Claude Code memory/{}", name.to_string_lossy())),
                }),
            })
            .collect(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir()
                .join(format!("sail-memory-import-test-{}", uuid::Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }

        fn path(&self) -> &Path {
            &self.0
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn discovers_unique_index_and_topic_files() {
        let root = TestRoot::new();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let project = dunce::canonicalize(project).unwrap();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap();
        let config = root.path().join("claude");
        let memory_dir = config
            .join("projects")
            .join(claude_project_name(&project))
            .join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        fs::write(memory_dir.join("MEMORY.md"), "See topic.md").unwrap();
        fs::write(memory_dir.join("topic.md"), "Use local clusters.").unwrap();
        let candidates = read_candidates(&project, &config).unwrap();
        assert_eq!(candidates.len(), 2);
        assert_eq!(candidates[0].content, "Use local clusters.");
        assert_eq!(candidates[1].content, "See topic.md");
    }

    #[test]
    fn deduplicates_saved_content() {
        let root = TestRoot::new();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let project = dunce::canonicalize(project).unwrap();
        std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap();
        let config = root.path().join("claude");
        let memory_dir = config
            .join("projects")
            .join(claude_project_name(&project))
            .join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        fs::write(memory_dir.join("topic.md"), "Use local clusters.").unwrap();
        let candidate = read_candidates(&project, &config).unwrap().remove(0);
        let store = root.path().join("store");
        let saved = memory::remember_at(
            &store,
            "test",
            MemoryInput {
                content: candidate.content.clone(),
                kind: None,
                tags: None,
                provenance: None,
            },
        )
        .unwrap();
        assert!(pending_candidates(&project, &config, &[saved])
            .unwrap()
            .is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn ignores_linked_source_files() {
        let root = TestRoot::new();
        let project = root.path().join("project");
        fs::create_dir(&project).unwrap();
        let project = dunce::canonicalize(project).unwrap();
        assert!(std::process::Command::new("git")
            .args(["init", "-q"])
            .current_dir(&project)
            .status()
            .unwrap()
            .success());
        let config = root.path().join("claude");
        let memory_dir = config
            .join("projects")
            .join(claude_project_name(&project))
            .join("memory");
        fs::create_dir_all(&memory_dir).unwrap();
        let outside = root.path().join("outside.md");
        fs::write(&outside, "Not a memory").unwrap();
        std::os::unix::fs::symlink(&outside, memory_dir.join("linked.md")).unwrap();
        assert!(read_candidates(&project, &config).unwrap().is_empty());
    }
}
