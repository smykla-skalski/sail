use sail_project_knowledge::{Proposal, SelectedMemory};
use serde::Serialize;
use std::fs::OpenOptions;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use tauri::State;
use uuid::Uuid;

struct Pending {
    token: String,
    directory: PathBuf,
    proposal: Proposal,
}

#[derive(Default)]
pub struct PendingProposal(Mutex<Option<Pending>>);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgePreview {
    token: String,
    memory: String,
    source_session: String,
    destination: String,
    revision: String,
    diff: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct KnowledgeChange {
    worktree: String,
    destination: String,
    revision: String,
}

fn selected_memory(
    app: &tauri::AppHandle,
    directory: &str,
    id: &str,
) -> Result<SelectedMemory, String> {
    crate::memory::ensure_enabled(app, directory)?;
    let record = crate::memory::inspect(app, directory, id)?;
    if record.expires_at.is_some_and(|expiry| {
        expiry
            <= std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap_or_default()
                .as_millis() as u64
    }) {
        return Err("This memory has expired.".into());
    }
    let source_session = record
        .provenance
        .session_id
        .filter(|source| !source.trim().is_empty())
        .ok_or("Select a memory with a source session.")?;
    Ok(SelectedMemory {
        id: record.id,
        content: record.content,
        source_session,
    })
}

fn require_write_access(repository: &Path, destination: &Path) -> Result<(), String> {
    let path = repository.join(destination);
    OpenOptions::new()
        .write(true)
        .open(&path)
        .map(|_| ())
        .map_err(|_| "Repository write access is required for the destination.".into())
}

#[tauri::command]
pub fn preview_project_knowledge(
    app: tauri::AppHandle,
    state: State<'_, PendingProposal>,
    directory: String,
    memory_id: String,
    destination: String,
    proposed_text: String,
) -> Result<KnowledgePreview, String> {
    let memory = selected_memory(&app, &directory, &memory_id)?;
    let repository = PathBuf::from(&directory);
    let destination = PathBuf::from(destination);
    let proposal =
        sail_project_knowledge::preview(&repository, memory, &destination, &proposed_text, true)?;
    require_write_access(&repository, proposal.destination())?;
    let preview = KnowledgePreview {
        token: Uuid::new_v4().to_string(),
        memory: proposal.memory().content.clone(),
        source_session: proposal.memory().source_session.clone(),
        destination: proposal.destination().display().to_string(),
        revision: proposal.revision().to_string(),
        diff: proposal.diff().to_string(),
    };
    let mut pending = state.0.lock().map_err(|_| "Proposal is unavailable.")?;
    *pending = Some(Pending {
        token: preview.token.clone(),
        directory: repository,
        proposal,
    });
    Ok(preview)
}

#[tauri::command]
pub fn reject_project_knowledge(
    state: State<'_, PendingProposal>,
    token: String,
) -> Result<(), String> {
    let mut pending = state.0.lock().map_err(|_| "Proposal is unavailable.")?;
    if pending
        .as_ref()
        .is_none_or(|proposal| proposal.token != token)
    {
        return Err("Proposal is no longer available. Preview it again.".into());
    }
    pending.take();
    Ok(())
}

#[tauri::command]
pub fn accept_project_knowledge(
    app: tauri::AppHandle,
    state: State<'_, PendingProposal>,
    token: String,
) -> Result<KnowledgeChange, String> {
    let pending = {
        let mut slot = state.0.lock().map_err(|_| "Proposal is unavailable.")?;
        if slot.as_ref().is_none_or(|proposal| proposal.token != token) {
            return Err("Proposal is no longer available. Preview it again.".into());
        }
        slot.take().ok_or("Proposal is no longer available.")?
    };
    let directory = pending
        .directory
        .to_str()
        .ok_or("Invalid repository path.")?;
    let current = selected_memory(&app, directory, &pending.proposal.memory().id)?;
    if current != *pending.proposal.memory() {
        return Err("Memory changed after preview. Preview it again.".into());
    }
    require_write_access(&pending.directory, pending.proposal.destination())?;
    let change = sail_project_knowledge::accept(&pending.directory, &pending.proposal, true)?;
    Ok(KnowledgeChange {
        worktree: change.worktree().display().to_string(),
        destination: change.destination().display().to_string(),
        revision: change.revision().to_string(),
    })
}

#[cfg(test)]
mod tests {
    use super::require_write_access;
    use std::fs;

    #[test]
    fn read_only_destination_cannot_be_accepted() {
        let root =
            std::env::temp_dir().join(format!("sail-knowledge-access-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let destination = root.join("AGENTS.md");
        fs::write(&destination, "original\n").unwrap();
        let original_permissions = fs::metadata(&destination).unwrap().permissions();
        let mut permissions = original_permissions.clone();
        permissions.set_readonly(true);
        fs::set_permissions(&destination, permissions).unwrap();

        assert!(require_write_access(&root, "AGENTS.md".as_ref()).is_err());
        assert_eq!(fs::read_to_string(&destination).unwrap(), "original\n");

        fs::set_permissions(&destination, original_permissions).unwrap();
        fs::remove_dir_all(&root).unwrap();
    }
}
