use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::Manager;

type Settings = BTreeMap<String, String>;
type Deletions = BTreeMap<String, BTreeSet<String>>;
const DELETIONS_KEY: &str = "sai-settings-deletions";
const MODIFIED_KEY: &str = "sai-settings-modified";
const INTERRUPTED_TURNS_KEY: &str = "sai-interrupted-agent-turns";
const ACP_TURN_EVIDENCE_KEY: &str = "sai-acp-turn-evidence";
const ACP_TURN_EVIDENCE_LIMIT: usize = 500;
const ACP_UNSETTLED_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InterruptedAgentTurn {
    pub agent: String,
    pub session_id: String,
    pub directory: String,
    pub turn_id: String,
    pub text: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpTurnEvidence {
    pub agent: String,
    pub session_id: String,
    pub turn_id: String,
    pub status: String,
    pub error: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
}

fn acp_turn_evidence(settings: &Settings) -> Vec<AcpTurnEvidence> {
    settings
        .get(ACP_TURN_EVIDENCE_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default()
}

fn write_acp_turn_evidence(
    settings: &mut Settings,
    evidence: &[AcpTurnEvidence],
) -> Result<(), String> {
    if evidence.is_empty() {
        settings.remove(ACP_TURN_EVIDENCE_KEY);
    } else {
        settings.insert(
            ACP_TURN_EVIDENCE_KEY.to_string(),
            serde_json::to_string(evidence).map_err(|error| error.to_string())?,
        );
    }
    Ok(())
}

fn unsettled_acp_evidence(status: &str) -> bool {
    matches!(status, "prepared" | "dispatch_uncertain" | "dispatched")
}

fn protected_acp_turns(settings: &Settings) -> HashSet<(String, String, String)> {
    let mut protected = interrupted_turns(settings)
        .into_iter()
        .map(|turn| (turn.agent, turn.session_id, turn.turn_id))
        .collect::<HashSet<_>>();
    let receipts = settings
        .get("sai-agent-spawn-receipts")
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
        .and_then(|value| value.as_array().cloned())
        .unwrap_or_default();
    for receipt in receipts {
        let state = receipt
            .get("state")
            .and_then(Value::as_str)
            .unwrap_or_default();
        if matches!(state, "completed" | "failed" | "interrupted") {
            continue;
        }
        let Some(agent) = receipt.get("provider").and_then(Value::as_str) else {
            continue;
        };
        let Some(target_id) = receipt.get("targetId").and_then(Value::as_str) else {
            continue;
        };
        let Some(turn_id) = receipt.get("turnId").and_then(Value::as_str) else {
            continue;
        };
        let Some(session_id) = target_id.strip_prefix(&format!("acp:{agent}:")) else {
            continue;
        };
        protected.insert((
            agent.to_string(),
            session_id.to_string(),
            turn_id.to_string(),
        ));
    }
    protected
}

fn merge_acp_turn_evidence_at(
    settings: &mut Settings,
    mut item: AcpTurnEvidence,
    now: u64,
) -> Result<(), String> {
    item.updated_at = now;
    let mut evidence = acp_turn_evidence(settings);
    let protected = protected_acp_turns(settings);
    if item.status == "prepared" {
        evidence.retain(|saved| {
            saved.agent != item.agent
                || saved.session_id != item.session_id
                || !unsettled_acp_evidence(&saved.status)
                || protected.contains(&(
                    saved.agent.clone(),
                    saved.session_id.clone(),
                    saved.turn_id.clone(),
                ))
        });
    }
    evidence.retain(|saved| {
        saved.agent != item.agent
            || saved.session_id != item.session_id
            || saved.turn_id != item.turn_id
    });
    evidence.push(item);
    evidence.retain(|saved| {
        !unsettled_acp_evidence(&saved.status)
            || protected.contains(&(
                saved.agent.clone(),
                saved.session_id.clone(),
                saved.turn_id.clone(),
            ))
            || now.saturating_sub(saved.updated_at) <= ACP_UNSETTLED_RETENTION_MS
    });
    let completed = evidence
        .iter()
        .filter(|item| !unsettled_acp_evidence(&item.status))
        .count();
    if completed > ACP_TURN_EVIDENCE_LIMIT {
        let mut remove = completed - ACP_TURN_EVIDENCE_LIMIT;
        evidence.retain(|item| {
            if remove > 0 && !unsettled_acp_evidence(&item.status) {
                remove -= 1;
                false
            } else {
                true
            }
        });
    }
    write_acp_turn_evidence(settings, &evidence)
}

fn merge_acp_turn_evidence(settings: &mut Settings, item: AcpTurnEvidence) -> Result<(), String> {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    merge_acp_turn_evidence_at(settings, item, now)
}

pub fn record_acp_turn_evidence(
    app: &tauri::AppHandle,
    evidence: AcpTurnEvidence,
) -> Result<(), String> {
    let path = settings_path(app)?;
    let _lock = lock_settings(&path)?;
    let mut settings = read_settings(&path)?;
    merge_acp_turn_evidence(&mut settings, evidence)?;
    write_settings(&path, &settings)
}

#[tauri::command]
pub fn get_acp_turn_evidence(
    app: tauri::AppHandle,
    agent: String,
    session_id: String,
    turn_id: String,
) -> Result<Option<AcpTurnEvidence>, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    Ok(acp_turn_evidence(&read_settings(&path)?)
        .into_iter()
        .find(|item| {
            item.agent == agent && item.session_id == session_id && item.turn_id == turn_id
        }))
}

fn interrupted_turns(settings: &Settings) -> Vec<InterruptedAgentTurn> {
    settings
        .get(INTERRUPTED_TURNS_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default()
}

fn write_interrupted_turns(
    settings: &mut Settings,
    turns: &[InterruptedAgentTurn],
) -> Result<(), String> {
    if turns.is_empty() {
        settings.remove(INTERRUPTED_TURNS_KEY);
    } else {
        settings.insert(
            INTERRUPTED_TURNS_KEY.to_string(),
            serde_json::to_string(turns).map_err(|error| error.to_string())?,
        );
    }
    Ok(())
}

fn merge_interrupted_turns(
    settings: &mut Settings,
    interrupted: Vec<InterruptedAgentTurn>,
) -> Result<(), String> {
    let mut turns = interrupted_turns(settings);
    for turn in interrupted {
        turns.retain(|saved| {
            saved.agent != turn.agent
                || saved.session_id != turn.session_id
                || saved.directory != turn.directory
        });
        turns.push(turn);
    }
    write_interrupted_turns(settings, &turns)
}

fn remove_interrupted_turn(
    settings: &mut Settings,
    agent: &str,
    session_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    let mut turns = interrupted_turns(settings);
    turns.retain(|turn| {
        turn.agent != agent || turn.session_id != session_id || turn.turn_id != turn_id
    });
    write_interrupted_turns(settings, &turns)
}

pub fn record_interrupted_turns(
    app: &tauri::AppHandle,
    interrupted: Vec<InterruptedAgentTurn>,
) -> Result<(), String> {
    if interrupted.is_empty() {
        return Ok(());
    }
    let path = settings_path(app)?;
    let _lock = lock_settings(&path)?;
    let mut settings = read_settings(&path)?;
    merge_interrupted_turns(&mut settings, interrupted)?;
    write_settings(&path, &settings)
}

pub fn clear_interrupted_turn(
    app: &tauri::AppHandle,
    agent: &str,
    session_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    let path = settings_path(app)?;
    let _lock = lock_settings(&path)?;
    let mut settings = read_settings(&path)?;
    if !settings.contains_key(INTERRUPTED_TURNS_KEY) {
        return Ok(());
    }
    remove_interrupted_turn(&mut settings, agent, session_id, turn_id)?;
    write_settings(&path, &settings)
}

#[tauri::command]
pub fn list_interrupted_agent_turns(
    app: tauri::AppHandle,
) -> Result<Vec<InterruptedAgentTurn>, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    Ok(interrupted_turns(&read_settings(&path)?))
}

#[tauri::command]
pub fn finish_interrupted_agent_turn(
    app: tauri::AppHandle,
    agent: String,
    session_id: String,
    turn_id: String,
) -> Result<(), String> {
    clear_interrupted_turn(&app, &agent, &session_id, &turn_id)
}

fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(root) = std::env::var_os("SAIL_E2E_CONFIG_DIR") {
        return Ok(PathBuf::from(root).join("settings.json"));
    }
    let config = app
        .path()
        .config_dir()
        .map_err(|error| format!("Cannot locate the configuration directory: {error}"))?;
    Ok(config.join("sail").join("settings.json"))
}

fn lock_settings(path: &Path) -> Result<File, String> {
    let parent = path.parent().ok_or("Cannot locate settings folder.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create settings folder: {error}"))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(|error| format!("Cannot open settings lock: {error}"))?;
    lock.lock()
        .map_err(|error| format!("Cannot lock settings: {error}"))?;
    Ok(lock)
}

fn read_settings(path: &Path) -> Result<Settings, String> {
    let backup = path.with_extension("json.bak");
    let contents = match fs::read_to_string(path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            match fs::read_to_string(&backup) {
                Ok(contents) => contents,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(Settings::new());
                }
                Err(error) => return Err(format!("Cannot read settings backup: {error}")),
            }
        }
        Err(error) => return Err(format!("Cannot read settings: {error}")),
    };
    serde_json::from_str(&contents).map_err(|error| format!("Cannot parse settings: {error}"))
}

fn write_settings(path: &Path, settings: &Settings) -> Result<(), String> {
    let temporary = path.with_extension("json.tmp");
    let contents = serde_json::to_vec_pretty(settings)
        .map_err(|error| format!("Cannot encode settings: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Cannot write settings: {error}"))?;
    file.write_all(&contents)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Cannot write settings: {error}"))?;
    drop(file);

    #[cfg(windows)]
    {
        let backup = path.with_extension("json.bak");
        if path.exists() {
            if backup.exists() {
                fs::remove_file(&backup)
                    .map_err(|error| format!("Cannot replace settings backup: {error}"))?;
            }
            fs::rename(path, &backup)
                .map_err(|error| format!("Cannot back up settings: {error}"))?;
        }
        if let Err(error) = fs::rename(&temporary, path) {
            if backup.exists() {
                let _ = fs::rename(&backup, path);
            }
            return Err(format!("Cannot save settings: {error}"));
        }
        if backup.exists() {
            let _ = fs::remove_file(backup);
        }
    }
    #[cfg(not(windows))]
    fs::rename(&temporary, path).map_err(|error| format!("Cannot save settings: {error}"))?;
    Ok(())
}

fn identity(value: &serde_json::Value, field: &str) -> String {
    value
        .get(field)
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn append_unique(base: &mut Vec<serde_json::Value>, extra: &[serde_json::Value], field: &str) {
    let mut seen: HashSet<String> = base.iter().map(|item| identity(item, field)).collect();
    for item in extra {
        if seen.insert(identity(item, field)) {
            base.push(item.clone());
        }
    }
}

fn merge_catalog(current: &str, legacy: &str, prefer_legacy: bool) -> String {
    if prefer_legacy {
        return merge_catalog(legacy, current, false);
    }
    let Ok(mut base) = serde_json::from_str::<serde_json::Value>(current) else {
        return legacy.to_string();
    };
    let Ok(extra) = serde_json::from_str::<serde_json::Value>(legacy) else {
        return current.to_string();
    };
    let (Some(base), Some(extra)) = (base.as_object_mut(), extra.as_object()) else {
        return current.to_string();
    };
    for field in ["repositories", "groups"] {
        let Some(entries) = extra.get(field).and_then(serde_json::Value::as_array) else {
            continue;
        };
        let Some(existing) = base
            .get_mut(field)
            .and_then(serde_json::Value::as_array_mut)
        else {
            base.insert(field.to_string(), serde_json::Value::Array(entries.clone()));
            continue;
        };
        if field == "repositories" {
            append_unique(existing, entries, "");
        } else {
            for group in entries {
                let id = identity(group, "id");
                if let Some(saved) = existing.iter_mut().find(|item| identity(item, "id") == id) {
                    if let (Some(saved), Some(group)) = (saved.as_object_mut(), group.as_object()) {
                        if let Some(repositories) = group
                            .get("repositories")
                            .and_then(serde_json::Value::as_array)
                        {
                            if let Some(assigned) = saved
                                .get_mut("repositories")
                                .and_then(serde_json::Value::as_array_mut)
                            {
                                append_unique(assigned, repositories, "");
                            }
                        }
                    }
                } else {
                    existing.push(group.clone());
                }
            }
        }
    }
    if let Some(worktrees) = extra
        .get("worktrees")
        .and_then(serde_json::Value::as_object)
    {
        let saved = base
            .entry("worktrees")
            .or_insert_with(|| serde_json::json!({}));
        if let Some(saved) = saved.as_object_mut() {
            for (repository, entries) in worktrees {
                let Some(entries) = entries.as_array() else {
                    continue;
                };
                let existing = saved
                    .entry(repository)
                    .or_insert_with(|| serde_json::json!([]));
                if let Some(existing) = existing.as_array_mut() {
                    append_unique(existing, entries, "path");
                }
            }
        }
    }
    serde_json::to_string(base).unwrap_or_else(|_| current.to_string())
}

fn merge_threads(current: &str, legacy: &str) -> String {
    let Ok(mut base) = serde_json::from_str::<Vec<serde_json::Value>>(current) else {
        return legacy.to_string();
    };
    let Ok(extra) = serde_json::from_str::<Vec<serde_json::Value>>(legacy) else {
        return current.to_string();
    };
    let mut seen: HashSet<String> = base
        .iter()
        .map(|item| {
            format!(
                "{}:{}:{}",
                identity(item, "agent"),
                identity(item, "directory"),
                identity(item, "sessionId")
            )
        })
        .collect();
    for item in extra {
        let id = format!(
            "{}:{}:{}",
            identity(&item, "agent"),
            identity(&item, "directory"),
            identity(&item, "sessionId")
        );
        if seen.insert(id) {
            base.push(item);
        }
    }
    serde_json::to_string(&base).unwrap_or_else(|_| current.to_string())
}

fn thread_id(thread: &serde_json::Value) -> String {
    serde_json::json!([
        identity(thread, "agent"),
        identity(thread, "directory"),
        identity(thread, "sessionId")
    ])
    .to_string()
}

fn catalog_entries(raw: &str) -> Deletions {
    let Ok(catalog) = serde_json::from_str::<serde_json::Value>(raw) else {
        return Deletions::new();
    };
    let mut entries = Deletions::new();
    let mut collect = |kind: &str, values: Vec<String>| {
        entries.insert(kind.to_string(), values.into_iter().collect());
    };
    collect(
        "repositories",
        catalog["repositories"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|entry| entry.as_str().map(str::to_string))
            .collect(),
    );
    collect(
        "groups",
        catalog["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|group| identity(group, "id"))
            .collect(),
    );
    collect(
        "memberships",
        catalog["groups"]
            .as_array()
            .into_iter()
            .flatten()
            .flat_map(|group| {
                group["repositories"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|path| {
                        path.as_str().map(|path| {
                            serde_json::json!([identity(group, "id"), path]).to_string()
                        })
                    })
            })
            .collect(),
    );
    collect(
        "worktrees",
        catalog["worktrees"]
            .as_object()
            .into_iter()
            .flat_map(|worktrees| worktrees.values())
            .filter_map(serde_json::Value::as_array)
            .flatten()
            .map(|entry| identity(entry, "path"))
            .collect(),
    );
    entries
}

fn entries_for(key: &str, raw: &str) -> Deletions {
    if key == "sai-project-catalog" {
        return catalog_entries(raw);
    }
    let threads = serde_json::from_str::<Vec<serde_json::Value>>(raw).unwrap_or_default();
    Deletions::from([(
        "threads".to_string(),
        threads.iter().map(thread_id).collect(),
    )])
}

fn update_deletions(saved: &mut Settings, key: &str, next: &str) -> Result<(), String> {
    let mut deleted: Deletions = saved
        .get(DELETIONS_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let before = saved
        .get(key)
        .map(|raw| entries_for(key, raw))
        .unwrap_or_default();
    let after = entries_for(key, next);
    for (kind, previous) in before {
        let active = after.get(&kind).cloned().unwrap_or_default();
        deleted
            .entry(kind)
            .or_default()
            .extend(previous.difference(&active).cloned());
    }
    for (kind, active) in after {
        if let Some(removed) = deleted.get_mut(&kind) {
            for id in active {
                removed.remove(&id);
            }
        }
    }
    saved.insert(
        DELETIONS_KEY.to_string(),
        serde_json::to_string(&deleted)
            .map_err(|error| format!("Cannot encode deletions: {error}"))?,
    );
    Ok(())
}

fn filter_legacy(key: &str, raw: &str, deleted: &Deletions) -> String {
    let has = |kind: &str, id: &str| deleted.get(kind).is_some_and(|ids| ids.contains(id));
    if key == "sail-agent-threads" {
        let Ok(mut threads) = serde_json::from_str::<Vec<serde_json::Value>>(raw) else {
            return raw.to_string();
        };
        threads.retain(|thread| !has("threads", &thread_id(thread)));
        return serde_json::to_string(&threads).unwrap_or_else(|_| raw.to_string());
    }
    let Ok(mut catalog) = serde_json::from_str::<serde_json::Value>(raw) else {
        return raw.to_string();
    };
    if let Some(repositories) = catalog["repositories"].as_array_mut() {
        repositories.retain(|path| !path.as_str().is_some_and(|path| has("repositories", path)));
    }
    if let Some(groups) = catalog["groups"].as_array_mut() {
        groups.retain(|group| !has("groups", &identity(group, "id")));
        for group in groups {
            let id = identity(group, "id");
            if let Some(repositories) = group["repositories"].as_array_mut() {
                repositories.retain(|path| {
                    !path.as_str().is_some_and(|path| {
                        has("repositories", path)
                            || has("memberships", &serde_json::json!([id, path]).to_string())
                    })
                });
            }
        }
    }
    if let Some(worktrees) = catalog["worktrees"].as_object_mut() {
        worktrees.retain(|repository, _| !has("repositories", repository));
        for entries in worktrees.values_mut() {
            if let Some(entries) = entries.as_array_mut() {
                entries.retain(|entry| !has("worktrees", &identity(entry, "path")));
            }
        }
    }
    serde_json::to_string(&catalog).unwrap_or_else(|_| raw.to_string())
}

pub fn string_setting(app: &tauri::AppHandle, key: &str) -> Option<String> {
    let path = settings_path(app).ok()?;
    let _lock = lock_settings(&path).ok()?;
    read_settings(&path).ok()?.remove(key)
}

#[tauri::command]
pub fn load_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    read_settings(&path)
}

#[tauri::command]
pub fn migrate_settings(
    app: tauri::AppHandle,
    legacy: Settings,
    prefer_legacy: bool,
) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    let mut saved = read_settings(&path)?;
    let before = saved.clone();
    let deleted: Deletions = saved
        .get(DELETIONS_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let modified: BTreeSet<String> = saved
        .get(MODIFIED_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    for (key, value) in legacy {
        if (!key.starts_with("sai-") && key != "sail-agent-threads")
            || key == DELETIONS_KEY
            || key == MODIFIED_KEY
        {
            continue;
        }
        let value = if key == "sai-project-catalog" || key == "sail-agent-threads" {
            filter_legacy(&key, &value, &deleted)
        } else {
            value
        };
        match saved.get(&key) {
            None if !modified.contains(&key) => {
                saved.insert(key, value);
            }
            None => {}
            Some(current) if key == "sai-project-catalog" => {
                let merged = merge_catalog(
                    current,
                    &value,
                    prefer_legacy && !modified.contains("sai-project-catalog"),
                );
                saved.insert(key, merged);
            }
            Some(current) if key == "sail-agent-threads" => {
                let merged = merge_threads(current, &value);
                saved.insert(key, merged);
            }
            Some(_) if prefer_legacy && !modified.contains(&key) => {
                saved.insert(key, value);
            }
            Some(_) => {}
        }
    }
    if saved != before {
        write_settings(&path, &saved)?;
    }
    Ok(saved)
}

#[tauri::command]
pub fn save_setting(
    app: tauri::AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    if !key.starts_with("sai-") && key != "sail-agent-threads" {
        return Err("Unknown settings key.".to_string());
    }
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    let mut saved = read_settings(&path)?;
    if key == DELETIONS_KEY || key == MODIFIED_KEY {
        return Err("Unknown settings key.".to_string());
    }
    let mut modified: BTreeSet<String> = saved
        .get(MODIFIED_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    modified.insert(key.clone());
    saved.insert(
        MODIFIED_KEY.to_string(),
        serde_json::to_string(&modified)
            .map_err(|error| format!("Cannot encode changes: {error}"))?,
    );
    if key == "sai-project-catalog" || key == "sail-agent-threads" {
        update_deletions(&mut saved, &key, value.as_deref().unwrap_or_default())?;
    }
    match value {
        Some(value) => {
            saved.insert(key, value);
        }
        None => {
            saved.remove(&key);
        }
    }
    write_settings(&path, &saved)
}

#[cfg(test)]
mod tests {
    use super::{
        acp_turn_evidence, filter_legacy, interrupted_turns, lock_settings,
        merge_acp_turn_evidence, merge_acp_turn_evidence_at, merge_catalog,
        merge_interrupted_turns, merge_threads, read_settings, remove_interrupted_turn,
        update_deletions, write_settings, AcpTurnEvidence, Deletions, InterruptedAgentTurn,
        Settings, ACP_TURN_EVIDENCE_LIMIT, ACP_UNSETTLED_RETENTION_MS, DELETIONS_KEY,
    };

    #[test]
    fn acp_turn_evidence_is_provider_correlated_replaced_and_bounded() {
        let evidence = |agent: &str, session: &str, turn: &str, status: &str| AcpTurnEvidence {
            agent: agent.into(),
            session_id: session.into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
        };
        let mut settings = Settings::new();
        merge_acp_turn_evidence(
            &mut settings,
            evidence("claude", "session", "turn", "dispatched"),
        )
        .unwrap();
        merge_acp_turn_evidence(&mut settings, evidence("claude", "session", "turn", "done"))
            .unwrap();
        merge_acp_turn_evidence(
            &mut settings,
            evidence("codex", "session", "turn", "failed"),
        )
        .unwrap();
        assert_eq!(
            acp_turn_evidence(&settings)
                .into_iter()
                .map(|item| (item.agent, item.session_id, item.turn_id, item.status))
                .collect::<Vec<_>>(),
            vec![
                (
                    "claude".into(),
                    "session".into(),
                    "turn".into(),
                    "done".into()
                ),
                (
                    "codex".into(),
                    "session".into(),
                    "turn".into(),
                    "failed".into()
                ),
            ]
        );
        for index in 0..ACP_TURN_EVIDENCE_LIMIT - 1 {
            merge_acp_turn_evidence(
                &mut settings,
                evidence("claude", "other", &format!("turn-{index}"), "done"),
            )
            .unwrap();
        }

        let saved = acp_turn_evidence(&settings);
        assert_eq!(saved.len(), ACP_TURN_EVIDENCE_LIMIT);
        assert!(!saved
            .iter()
            .any(|item| item.agent == "claude" && item.session_id == "session"));
        assert!(saved
            .iter()
            .any(|item| item.agent == "codex" && item.status == "failed"));
    }

    #[test]
    fn acp_turn_evidence_never_prunes_unsettled_dispatches() {
        let evidence = |turn: &str, status: &str| AcpTurnEvidence {
            agent: "codex".into(),
            session_id: "session".into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
        };
        let mut settings = Settings::new();
        merge_acp_turn_evidence(&mut settings, evidence("prepared", "prepared")).unwrap();
        merge_acp_turn_evidence(&mut settings, evidence("running", "dispatched")).unwrap();
        for index in 0..=ACP_TURN_EVIDENCE_LIMIT {
            merge_acp_turn_evidence(&mut settings, evidence(&format!("done-{index}"), "done"))
                .unwrap();
        }

        let saved = acp_turn_evidence(&settings);
        assert_eq!(saved.len(), ACP_TURN_EVIDENCE_LIMIT + 2);
        assert!(saved.iter().any(|item| item.turn_id == "prepared"));
        assert!(saved.iter().any(|item| item.turn_id == "running"));
        assert!(!saved.iter().any(|item| item.turn_id == "done-0"));
    }

    #[test]
    fn abandoned_dispatch_evidence_expires_but_owned_work_stays_protected() {
        let evidence = |session: &str, turn: &str, status: &str| AcpTurnEvidence {
            agent: "codex".into(),
            session_id: session.into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
        };
        let mut settings = Settings::new();
        merge_acp_turn_evidence_at(
            &mut settings,
            evidence("abandoned", "old", "dispatch_uncertain"),
            1,
        )
        .unwrap();
        merge_acp_turn_evidence_at(
            &mut settings,
            evidence("owned", "protected", "dispatched"),
            1,
        )
        .unwrap();
        settings.insert(
            "sai-agent-spawn-receipts".into(),
            serde_json::json!([{
                "provider": "codex",
                "targetId": "acp:codex:owned",
                "turnId": "protected",
                "state": "unavailable"
            }])
            .to_string(),
        );

        merge_acp_turn_evidence_at(
            &mut settings,
            evidence("recent", "fresh", "prepared"),
            ACP_UNSETTLED_RETENTION_MS + 2,
        )
        .unwrap();

        let saved = acp_turn_evidence(&settings);
        assert!(!saved.iter().any(|item| item.turn_id == "old"));
        assert!(saved.iter().any(|item| item.turn_id == "protected"));
        assert!(saved.iter().any(|item| item.turn_id == "fresh"));
    }

    #[test]
    fn a_new_prompt_retires_uncertain_evidence_for_the_same_session() {
        let evidence = |turn: &str, status: &str| AcpTurnEvidence {
            agent: "claude".into(),
            session_id: "session".into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
        };
        let mut settings = Settings::new();
        merge_acp_turn_evidence_at(&mut settings, evidence("old", "dispatch_uncertain"), 1)
            .unwrap();

        merge_acp_turn_evidence_at(&mut settings, evidence("new", "prepared"), 2).unwrap();

        let saved = acp_turn_evidence(&settings);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].turn_id, "new");
    }

    #[test]
    fn interrupted_turns_replace_previous_attempt_without_losing_other_threads() {
        let turn = |session: &str, attempt: &str| InterruptedAgentTurn {
            agent: "claude".into(),
            session_id: session.into(),
            directory: "/repo".into(),
            turn_id: attempt.into(),
            text: "Continue the work".into(),
        };
        let mut settings = Settings::new();
        merge_interrupted_turns(
            &mut settings,
            vec![turn("one", "old"), turn("two", "other")],
        )
        .unwrap();
        merge_interrupted_turns(&mut settings, vec![turn("one", "new")]).unwrap();
        remove_interrupted_turn(&mut settings, "claude", "one", "old").unwrap();
        assert_eq!(
            interrupted_turns(&settings),
            vec![turn("two", "other"), turn("one", "new")]
        );
        remove_interrupted_turn(&mut settings, "claude", "one", "new").unwrap();
        assert_eq!(interrupted_turns(&settings), vec![turn("two", "other")]);
    }

    #[test]
    fn merges_projects_from_two_webview_origins() {
        let dev = r#"{"repositories":["/dev"],"groups":[],"worktrees":{}}"#;
        let packaged = r#"{"repositories":["/daily"],"groups":[{"id":"daily","name":"Daily","repositories":["/daily"]}],"worktrees":{}}"#;
        let merged: serde_json::Value =
            serde_json::from_str(&merge_catalog(dev, packaged, true)).unwrap();
        assert_eq!(
            merged["repositories"],
            serde_json::json!(["/daily", "/dev"])
        );
        assert_eq!(merged["groups"][0]["name"], "Daily");
    }

    #[test]
    fn deduplicates_restored_agent_threads() {
        let thread = r#"{"agent":"claude","directory":"/daily","sessionId":"1"}"#;
        let merged = merge_threads(&format!("[{thread}]"), &format!("[{thread}]"));
        let threads: Vec<serde_json::Value> = serde_json::from_str(&merged).unwrap();
        assert_eq!(threads.len(), 1);
    }

    #[test]
    fn deleted_legacy_items_stay_deleted() {
        let old = r#"{"repositories":["/keep","/deleted"],"groups":[{"id":"group","repositories":["/keep","/deleted"]},{"id":"removed","repositories":[]}],"worktrees":{"/keep":[{"path":"/tree","branch":"old"}]}}"#;
        let new = r#"{"repositories":["/keep"],"groups":[{"id":"group","repositories":[]}],"worktrees":{"/keep":[]}}"#;
        let mut saved = Settings::from([("sai-project-catalog".to_string(), old.to_string())]);
        update_deletions(&mut saved, "sai-project-catalog", new).unwrap();
        let deleted: Deletions = serde_json::from_str(&saved[DELETIONS_KEY]).unwrap();
        let filtered: serde_json::Value =
            serde_json::from_str(&filter_legacy("sai-project-catalog", old, &deleted)).unwrap();
        assert_eq!(filtered["repositories"], serde_json::json!(["/keep"]));
        assert_eq!(filtered["groups"].as_array().unwrap().len(), 1);
        assert_eq!(filtered["groups"][0]["repositories"], serde_json::json!([]));
        assert_eq!(filtered["worktrees"]["/keep"], serde_json::json!([]));

        let thread = r#"{"agent":"claude","directory":"/keep","sessionId":"1"}"#;
        saved.insert("sail-agent-threads".to_string(), format!("[{thread}]"));
        update_deletions(&mut saved, "sail-agent-threads", "[]").unwrap();
        let deleted: Deletions = serde_json::from_str(&saved[DELETIONS_KEY]).unwrap();
        assert_eq!(
            filter_legacy("sail-agent-threads", &format!("[{thread}]"), &deleted),
            "[]"
        );
    }

    #[test]
    fn concurrent_writers_keep_distinct_settings() {
        let directory = std::env::temp_dir().join(format!(
            "sail-settings-test-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let path = directory.join("settings.json");
        let writers: Vec<_> = (0..8)
            .map(|index| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let _lock = lock_settings(&path).unwrap();
                    let mut saved = read_settings(&path).unwrap();
                    saved.insert(format!("sai-key-{index}"), index.to_string());
                    write_settings(&path, &saved).unwrap();
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(read_settings(&path).unwrap().len(), 8);
        std::fs::remove_dir_all(directory).unwrap();
    }
}
