use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeMap, BTreeSet, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
#[cfg(feature = "e2e")]
use std::sync::{Arc, Condvar, Mutex, OnceLock};
#[cfg(feature = "e2e")]
use std::time::{Duration, Instant};
#[cfg(not(feature = "e2e"))]
use tauri::Manager;

use crate::settings_records::{self as records, is_record_key};
use std::sync::Mutex as StdMutex;

type Settings = BTreeMap<String, String>;
type Deletions = BTreeMap<String, BTreeSet<String>>;
const DELETIONS_KEY: &str = "sai-settings-deletions";
const MODIFIED_KEY: &str = "sai-settings-modified";
const SPAWN_RECEIPTS_KEY: &str = "sai-agent-spawn-receipts";
const INTERRUPTED_TURNS_KEY: &str = "sai-interrupted-agent-turns";
const ACP_TURN_EVIDENCE_KEY: &str = "sai-acp-turn-evidence";
const ACP_TURN_EVIDENCE_LIMIT: usize = 500;
const ACP_UNSETTLED_RETENTION_MS: u64 = 7 * 24 * 60 * 60 * 1_000;

#[cfg(feature = "e2e")]
#[derive(Default)]
struct E2eWriterState {
    active: usize,
    resetting: bool,
}

#[cfg(feature = "e2e")]
struct E2eWriterGate {
    state: Mutex<E2eWriterState>,
    idle: Condvar,
}

#[cfg(feature = "e2e")]
static E2E_WRITER_GATE: OnceLock<Arc<E2eWriterGate>> = OnceLock::new();

#[cfg(feature = "e2e")]
fn e2e_writer_gate() -> Arc<E2eWriterGate> {
    E2E_WRITER_GATE
        .get_or_init(|| {
            Arc::new(E2eWriterGate {
                state: Mutex::new(E2eWriterState::default()),
                idle: Condvar::new(),
            })
        })
        .clone()
}

#[cfg(feature = "e2e")]
pub(crate) struct E2eWriterGuard(Arc<E2eWriterGate>);

#[cfg(feature = "e2e")]
impl Drop for E2eWriterGuard {
    fn drop(&mut self) {
        if let Ok(mut state) = self.0.state.lock() {
            state.active -= 1;
            self.0.idle.notify_all();
        }
    }
}

#[cfg(feature = "e2e")]
impl E2eWriterGate {
    fn begin(self: &Arc<Self>) -> Result<E2eWriterGuard, String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        if state.resetting {
            return Err("E2E settings writers are resetting".into());
        }
        state.active += 1;
        Ok(E2eWriterGuard(self.clone()))
    }

    fn quiesce(&self, timeout: Duration) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.resetting = true;
        let deadline = Instant::now() + timeout;
        while state.active > 0 {
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Timed out quiescing E2E settings writers".into());
            }
            let (next, _) = self
                .idle
                .wait_timeout(state, remaining)
                .map_err(|error| error.to_string())?;
            state = next;
        }
        Ok(())
    }

    fn resume(&self) -> Result<(), String> {
        let mut state = self.state.lock().map_err(|error| error.to_string())?;
        state.resetting = false;
        Ok(())
    }
}

#[cfg(feature = "e2e")]
pub(crate) fn begin_e2e_settings_write() -> Result<E2eWriterGuard, String> {
    e2e_writer_gate().begin()
}

#[cfg(feature = "e2e")]
fn quiesce_e2e_settings_writes() -> Result<(), String> {
    e2e_writer_gate().quiesce(Duration::from_secs(10))
}

#[cfg(feature = "e2e")]
fn resume_e2e_settings_writes() -> Result<(), String> {
    e2e_writer_gate().resume()
}

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
    #[serde(default)]
    pub directory: String,
    pub session_id: String,
    pub turn_id: String,
    pub status: String,
    pub error: Option<String>,
    #[serde(default)]
    pub updated_at: u64,
    #[serde(default)]
    pub post_turn_pending: bool,
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

fn protected_acp_turns(settings: &Settings) -> HashSet<(String, String, String, String)> {
    let mut protected = interrupted_turns(settings)
        .into_iter()
        .map(|turn| (turn.agent, turn.directory, turn.session_id, turn.turn_id))
        .collect::<HashSet<_>>();
    let receipts = settings
        .get(SPAWN_RECEIPTS_KEY)
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
        let directory = receipt
            .get("targetDirectory")
            .and_then(Value::as_str)
            .unwrap_or_default();
        protected.insert((
            agent.to_string(),
            directory.to_string(),
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
    let previous_pending = evidence
        .iter()
        .filter(|saved| saved.post_turn_pending)
        .count();
    let protected = protected_acp_turns(settings);
    if item.status == "prepared" {
        evidence.retain(|saved| {
            saved.agent != item.agent
                || saved.directory != item.directory
                || saved.session_id != item.session_id
                || !unsettled_acp_evidence(&saved.status)
                || saved.post_turn_pending
                || protected.contains(&(
                    saved.agent.clone(),
                    saved.directory.clone(),
                    saved.session_id.clone(),
                    saved.turn_id.clone(),
                ))
        });
    }
    if let Some(saved) = evidence.iter().find(|saved| {
        saved.agent == item.agent
            && saved.directory == item.directory
            && saved.session_id == item.session_id
            && saved.turn_id == item.turn_id
    }) {
        if matches!(item.status.as_str(), "done" | "failed" | "interrupted") {
            item.post_turn_pending &= saved.post_turn_pending;
        } else {
            item.post_turn_pending |= saved.post_turn_pending;
        }
    } else if matches!(item.status.as_str(), "done" | "failed" | "interrupted") {
        item.post_turn_pending = false;
    }
    // A failed request that never reached the dispatch fence is still labeled "prepared",
    // but it cannot produce a completed turn or post-turn checks.
    if item.status == "prepared" && item.error.is_some() {
        item.post_turn_pending = false;
    }
    evidence.retain(|saved| {
        saved.agent != item.agent
            || saved.directory != item.directory
            || saved.session_id != item.session_id
            || saved.turn_id != item.turn_id
    });
    evidence.push(item);
    evidence.retain(|saved| {
        !unsettled_acp_evidence(&saved.status)
            || protected.contains(&(
                saved.agent.clone(),
                saved.directory.clone(),
                saved.session_id.clone(),
                saved.turn_id.clone(),
            ))
            || now.saturating_sub(saved.updated_at) <= ACP_UNSETTLED_RETENTION_MS
    });
    let pending = evidence
        .iter()
        .filter(|saved| saved.post_turn_pending)
        .count();
    if pending > ACP_TURN_EVIDENCE_LIMIT && pending > previous_pending {
        return Err(format!(
            "Post-turn check backlog is full ({ACP_TURN_EVIDENCE_LIMIT} turns). Resolve pending checks before sending another prompt."
        ));
    }
    let completed = evidence
        .iter()
        .filter(|item| !unsettled_acp_evidence(&item.status) && !item.post_turn_pending)
        .count();
    let completed_limit = ACP_TURN_EVIDENCE_LIMIT.saturating_sub(pending);
    if completed > completed_limit {
        let mut remove = completed - completed_limit;
        evidence.retain(|item| {
            if remove > 0 && !unsettled_acp_evidence(&item.status) && !item.post_turn_pending {
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
    #[cfg(feature = "e2e")]
    let _writer = begin_e2e_settings_write()?;
    let path = settings_path(app)?;
    let _lock = lock_settings(&path)?;
    let mut settings = read_scoped(&path, ACP_KEYS)?;
    let before = settings.clone();
    merge_acp_turn_evidence(&mut settings, evidence)?;
    write_settings(&path, &before, &settings)
}

#[tauri::command]
pub fn get_acp_turn_evidence(
    app: tauri::AppHandle,
    agent: String,
    directory: String,
    session_id: String,
    turn_id: String,
) -> Result<Option<AcpTurnEvidence>, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    Ok(acp_turn_evidence(&read_scoped(&path, ACP_KEYS)?)
        .into_iter()
        .find(|item| {
            item.agent == agent
                && item.directory == directory
                && item.session_id == session_id
                && item.turn_id == turn_id
        }))
}

#[tauri::command]
pub fn list_pending_acp_post_turn_checks(
    app: tauri::AppHandle,
) -> Result<Vec<AcpTurnEvidence>, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    Ok(acp_turn_evidence(&read_scoped(&path, ACP_KEYS)?)
        .into_iter()
        .filter(|item| item.post_turn_pending && item.status == "done")
        .collect())
}

#[tauri::command]
pub fn finish_acp_post_turn_checks(
    app: tauri::AppHandle,
    agent: String,
    directory: String,
    session_id: String,
    turn_id: String,
) -> Result<(), String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    let mut settings = read_scoped(&path, ACP_KEYS)?;
    let before = settings.clone();
    let mut evidence = acp_turn_evidence(&settings);
    let Some(item) = evidence.iter_mut().find(|item| {
        item.agent == agent
            && item.directory == directory
            && item.session_id == session_id
            && item.turn_id == turn_id
            && item.status == "done"
    }) else {
        return Err("Completed ACP turn was not found.".into());
    };
    item.post_turn_pending = false;
    write_acp_turn_evidence(&mut settings, &evidence)?;
    write_settings(&path, &before, &settings)
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
    directory: &str,
    session_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    let mut turns = interrupted_turns(settings);
    turns.retain(|turn| {
        turn.agent != agent
            || turn.directory != directory
            || turn.session_id != session_id
            || turn.turn_id != turn_id
    });
    write_interrupted_turns(settings, &turns)
}

pub fn record_interrupted_turns(
    app: &tauri::AppHandle,
    interrupted: Vec<InterruptedAgentTurn>,
) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    let _writer = begin_e2e_settings_write()?;
    if interrupted.is_empty() {
        return Ok(());
    }
    let path = settings_path(app)?;
    let _lock = lock_settings(&path)?;
    let mut settings = read_scoped(&path, ACP_KEYS)?;
    let before = settings.clone();
    merge_interrupted_turns(&mut settings, interrupted)?;
    write_settings(&path, &before, &settings)
}

pub fn clear_interrupted_turn(
    app: &tauri::AppHandle,
    agent: &str,
    directory: &str,
    session_id: &str,
    turn_id: &str,
) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    let _writer = begin_e2e_settings_write()?;
    let path = settings_path(app)?;
    let _lock = lock_settings(&path)?;
    let mut settings = read_scoped(&path, ACP_KEYS)?;
    if !settings.contains_key(INTERRUPTED_TURNS_KEY) {
        return Ok(());
    }
    let before = settings.clone();
    remove_interrupted_turn(&mut settings, agent, directory, session_id, turn_id)?;
    write_settings(&path, &before, &settings)
}

#[tauri::command]
pub fn list_interrupted_agent_turns(
    app: tauri::AppHandle,
) -> Result<Vec<InterruptedAgentTurn>, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    Ok(interrupted_turns(&read_scoped(&path, ACP_KEYS)?))
}

#[tauri::command]
pub fn finish_interrupted_agent_turn(
    app: tauri::AppHandle,
    agent: String,
    directory: String,
    session_id: String,
    turn_id: String,
) -> Result<(), String> {
    clear_interrupted_turn(&app, &agent, &directory, &session_id, &turn_id)
}

pub(crate) fn settings_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        let _ = app;
        Ok(crate::e2e_config::root()?.join("settings.json"))
    }
    #[cfg(not(feature = "e2e"))]
    {
        let config = app
            .path()
            .config_dir()
            .map_err(|error| format!("Cannot locate the configuration directory: {error}"))?;
        Ok(config.join("sail").join("settings.json"))
    }
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

const ACP_KEYS: &[&str] = &[
    ACP_TURN_EVIDENCE_KEY,
    INTERRUPTED_TURNS_KEY,
    SPAWN_RECEIPTS_KEY,
];

fn read_settings_file(path: &Path) -> Result<Settings, String> {
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

static MIGRATED: StdMutex<BTreeSet<PathBuf>> = StdMutex::new(BTreeSet::new());

/// Moves record keys out of `settings.json` once per process. Records are written
/// first, so a crash leaves each key in the file, the store, or both; the record
/// wins and the file copy is dropped on the next pass.
fn migrate_records(path: &Path) -> Result<(), String> {
    if MIGRATED
        .lock()
        .map_err(|error| error.to_string())?
        .contains(path)
    {
        return Ok(());
    }
    let mut file = read_settings_file(path)?;
    if file.keys().any(|key| is_record_key(key)) {
        for (key, value) in &file {
            if is_record_key(key) && records::read(path, key)?.is_none() {
                records::write(path, key, value)?;
            }
        }
        file.retain(|key, _| !is_record_key(key));
        write_settings_file(path, &file)?;
    }
    MIGRATED
        .lock()
        .map_err(|error| error.to_string())?
        .insert(path.to_path_buf());
    Ok(())
}

fn read_file_settings(path: &Path) -> Result<Settings, String> {
    migrate_records(path)?;
    read_settings_file(path)
}

fn read_settings(path: &Path) -> Result<Settings, String> {
    let mut settings = read_file_settings(path)?;
    settings.extend(records::read_all(path)?);
    Ok(settings)
}

/// Non-record keys come from `settings.json`; do not write back a scoped read of them.
fn read_scoped(path: &Path, keys: &[&str]) -> Result<Settings, String> {
    migrate_records(path)?;
    let mut settings = Settings::new();
    for key in keys.iter().filter(|key| is_record_key(key)) {
        if let Some(value) = records::read(path, key)? {
            settings.insert((*key).to_string(), value);
        }
    }
    if keys.iter().any(|key| !is_record_key(key)) {
        let mut file = read_settings_file(path)?;
        file.retain(|key, _| keys.contains(&key.as_str()));
        settings.extend(file);
    }
    Ok(settings)
}

/// Persists the difference between `before` and `after`: one record per changed
/// record key, and `settings.json` only when its own content changed.
fn write_settings(path: &Path, before: &Settings, after: &Settings) -> Result<(), String> {
    for (key, value) in after {
        if is_record_key(key) && before.get(key) != Some(value) {
            records::write(path, key, value)?;
        }
    }
    for key in before.keys() {
        if is_record_key(key) && !after.contains_key(key) {
            records::remove(path, key)?;
        }
    }
    let file_part = |settings: &Settings| -> Settings {
        settings
            .iter()
            .filter(|(key, _)| !is_record_key(key))
            .map(|(key, value)| (key.clone(), value.clone()))
            .collect()
    };
    let next = file_part(after);
    if file_part(before) == next {
        return Ok(());
    }
    write_settings_file(path, &next)
}

fn write_settings_file(path: &Path, settings: &Settings) -> Result<(), String> {
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

pub fn string_setting(app: &tauri::AppHandle, key: &str) -> Result<Option<String>, String> {
    let path = settings_path(app)?;
    let _lock = lock_settings(&path)?;
    Ok(read_scoped(&path, &[key])?.remove(key))
}

/// Clear disk-backed fixture settings between E2E specs under the normal settings lock.
#[tauri::command]
pub fn reset_test_settings(app: tauri::AppHandle) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    {
        let path = settings_path(&app)?;
        crate::post_turn_checks::quiesce_test_checks(&app)?;
        let result = (|| {
            quiesce_e2e_settings_writes()?;
            let _lock = lock_settings(&path)?;
            write_settings_file(&path, &Settings::new())?;
            records::clear(&path)?;
            crate::local_claims::reset_test_store(&app)
        })();
        let writers = resume_e2e_settings_writes();
        let checks = crate::post_turn_checks::resume_test_checks(&app);
        result?;
        writers?;
        checks
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = app;
        Err("Settings reset requires the E2E build".into())
    }
}

#[tauri::command]
pub async fn load_settings(app: tauri::AppHandle) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || load_settings_sync(app))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn load_settings_sync(app: tauri::AppHandle) -> Result<Settings, String> {
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    read_settings(&path)
}

#[tauri::command]
pub async fn migrate_settings(
    app: tauri::AppHandle,
    legacy: Settings,
    prefer_legacy: bool,
) -> Result<Settings, String> {
    tauri::async_runtime::spawn_blocking(move || migrate_settings_sync(app, legacy, prefer_legacy))
        .await
        .map_err(|error| error.to_string())?
}

fn migrate_settings_sync(
    app: tauri::AppHandle,
    legacy: Settings,
    prefer_legacy: bool,
) -> Result<Settings, String> {
    #[cfg(feature = "e2e")]
    let _writer = begin_e2e_settings_write()?;
    let path = settings_path(&app)?;
    let _lock = lock_settings(&path)?;
    let mut saved = read_settings(&path)?;
    let before = saved.clone();
    let deleted: Deletions = saved
        .get(DELETIONS_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default();
    let modified = modified_keys(&saved);
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
    write_settings(&path, &before, &saved)?;
    Ok(saved)
}

#[tauri::command]
pub async fn save_setting(
    app: tauri::AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || save_setting_sync(app, key, value))
        .await
        .map_err(|error| error.to_string())?
}

pub(crate) fn save_setting_sync(
    app: tauri::AppHandle,
    key: String,
    value: Option<String>,
) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    let _writer = begin_e2e_settings_write()?;
    if !key.starts_with("sai-") && key != "sail-agent-threads" {
        return Err("Unknown settings key.".to_string());
    }
    if key == DELETIONS_KEY || key == MODIFIED_KEY {
        return Err("Unknown settings key.".to_string());
    }
    save_setting_at(&settings_path(&app)?, key, value)
}

fn save_setting_at(path: &Path, key: String, value: Option<String>) -> Result<(), String> {
    let path = path.to_path_buf();
    let _lock = lock_settings(&path)?;
    let mut saved = if is_record_key(&key) {
        read_scoped(&path, &[&key, MODIFIED_KEY, DELETIONS_KEY])?
    } else {
        let mut saved = read_file_settings(&path)?;
        saved.extend(read_scoped(&path, &[MODIFIED_KEY, DELETIONS_KEY])?);
        saved
    };
    let before = saved.clone();
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
    write_settings(&path, &before, &saved)
}

fn modified_keys(settings: &Settings) -> BTreeSet<String> {
    settings
        .get(MODIFIED_KEY)
        .and_then(|raw| serde_json::from_str(raw).ok())
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::{
        acp_turn_evidence, filter_legacy, interrupted_turns, is_record_key, lock_settings,
        merge_acp_turn_evidence, merge_acp_turn_evidence_at, merge_catalog,
        merge_interrupted_turns, merge_threads, modified_keys, read_file_settings, read_scoped,
        read_settings, read_settings_file, records, remove_interrupted_turn, save_setting_at,
        update_deletions, write_acp_turn_evidence, write_settings, AcpTurnEvidence, Deletions,
        InterruptedAgentTurn, Settings, ACP_KEYS, ACP_TURN_EVIDENCE_LIMIT,
        ACP_UNSETTLED_RETENTION_MS, DELETIONS_KEY, MODIFIED_KEY, SPAWN_RECEIPTS_KEY,
    };
    #[cfg(feature = "e2e")]
    use super::{E2eWriterGate, E2eWriterState};
    #[cfg(feature = "e2e")]
    use std::sync::{mpsc, Arc, Condvar, Mutex};
    #[cfg(feature = "e2e")]
    use std::time::Duration;

    #[test]
    fn prepared_turn_keeps_pending_check_until_completion_but_legacy_history_is_silent() {
        let mut settings = Settings::new();
        let turn = |status: &str, pending: bool| AcpTurnEvidence {
            agent: "claude".into(),
            directory: "/repo".into(),
            session_id: "session".into(),
            turn_id: "turn".into(),
            status: status.into(),
            error: None,
            updated_at: 0,
            post_turn_pending: pending,
        };
        merge_acp_turn_evidence_at(&mut settings, turn("prepared", true), 1).unwrap();
        merge_acp_turn_evidence_at(&mut settings, turn("dispatched", false), 2).unwrap();
        merge_acp_turn_evidence_at(&mut settings, turn("done", true), 3).unwrap();
        assert!(acp_turn_evidence(&settings)[0].post_turn_pending);

        let mut suppressed = Settings::new();
        merge_acp_turn_evidence_at(&mut suppressed, turn("prepared", true), 1).unwrap();
        merge_acp_turn_evidence_at(&mut suppressed, turn("done", false), 2).unwrap();
        assert!(!acp_turn_evidence(&suppressed)[0].post_turn_pending);

        let historical: AcpTurnEvidence = serde_json::from_value(serde_json::json!({
            "agent": "claude", "directory": "/repo", "sessionId": "old",
            "turnId": "old", "status": "done", "error": null
        }))
        .unwrap();
        assert!(!historical.post_turn_pending);
    }

    #[test]
    fn pending_completed_turn_survives_evidence_history_eviction() {
        let mut settings = Settings::new();
        let turn = |id: String, status: &str, pending: bool| AcpTurnEvidence {
            agent: "claude".into(),
            directory: "/repo".into(),
            session_id: id.clone(),
            turn_id: id,
            status: status.into(),
            error: None,
            updated_at: 0,
            post_turn_pending: pending,
        };
        merge_acp_turn_evidence_at(&mut settings, turn("pending".into(), "prepared", true), 1)
            .unwrap();
        merge_acp_turn_evidence_at(&mut settings, turn("pending".into(), "done", true), 2).unwrap();
        for index in 0..=ACP_TURN_EVIDENCE_LIMIT {
            merge_acp_turn_evidence_at(
                &mut settings,
                turn(format!("old-{index}"), "done", false),
                index as u64 + 3,
            )
            .unwrap();
        }
        let saved = acp_turn_evidence(&settings);
        assert!(saved
            .iter()
            .any(|item| item.turn_id == "pending" && item.post_turn_pending));
        assert!(!saved.iter().any(|item| item.turn_id == "old-0"));
    }

    #[test]
    fn pending_check_backlog_refuses_new_dispatch_without_losing_existing_recovery() {
        let turn = |index: usize, status: &str, pending: bool| AcpTurnEvidence {
            agent: "claude".into(),
            directory: "/repo".into(),
            session_id: format!("session-{index}"),
            turn_id: format!("turn-{index}"),
            status: status.into(),
            error: None,
            updated_at: 1,
            post_turn_pending: pending,
        };
        let mut settings = Settings::new();
        let pending = (0..ACP_TURN_EVIDENCE_LIMIT)
            .map(|index| turn(index, "done", true))
            .collect::<Vec<_>>();
        write_acp_turn_evidence(&mut settings, &pending).unwrap();

        let error = merge_acp_turn_evidence_at(
            &mut settings,
            turn(ACP_TURN_EVIDENCE_LIMIT, "prepared", true),
            2,
        )
        .unwrap_err();
        assert!(error.contains("backlog is full"));
        assert_eq!(acp_turn_evidence(&settings), pending);

        let mut settled = pending;
        settled[0].post_turn_pending = false;
        write_acp_turn_evidence(&mut settings, &settled).unwrap();
        merge_acp_turn_evidence_at(
            &mut settings,
            turn(ACP_TURN_EVIDENCE_LIMIT, "prepared", true),
            3,
        )
        .unwrap();
        let saved = acp_turn_evidence(&settings);
        assert_eq!(saved.len(), ACP_TURN_EVIDENCE_LIMIT);
        assert_eq!(
            saved.iter().filter(|item| item.post_turn_pending).count(),
            500
        );
        assert!(saved.iter().all(|item| item.turn_id != "turn-0"));
    }

    #[test]
    fn failed_pre_dispatch_prompt_releases_its_pending_check_slot() {
        let evidence = |turn: &str, error: Option<&str>| AcpTurnEvidence {
            agent: "claude".into(),
            directory: "/repo".into(),
            session_id: "session".into(),
            turn_id: turn.into(),
            status: "prepared".into(),
            error: error.map(str::to_string),
            updated_at: 0,
            post_turn_pending: error.is_none(),
        };
        let mut settings = Settings::new();
        merge_acp_turn_evidence_at(&mut settings, evidence("failed", None), 1).unwrap();
        assert!(acp_turn_evidence(&settings)[0].post_turn_pending);

        merge_acp_turn_evidence_at(
            &mut settings,
            evidence("failed", Some("dispatch fence rejected request")),
            2,
        )
        .unwrap();
        let failed = &acp_turn_evidence(&settings)[0];
        assert_eq!(failed.status, "prepared");
        assert_eq!(
            failed.error.as_deref(),
            Some("dispatch fence rejected request")
        );
        assert!(!failed.post_turn_pending);

        merge_acp_turn_evidence_at(&mut settings, evidence("next", None), 3).unwrap();
        let saved = acp_turn_evidence(&settings);
        assert_eq!(saved.len(), 1);
        assert_eq!(saved[0].turn_id, "next");
        assert!(saved[0].post_turn_pending);
    }

    #[test]
    fn failed_pre_dispatch_prompt_does_not_exhaust_the_500_turn_backlog() {
        let mut settings = Settings::new();
        let pending = (0..ACP_TURN_EVIDENCE_LIMIT - 1)
            .map(|index| AcpTurnEvidence {
                agent: "claude".into(),
                directory: "/repo".into(),
                session_id: format!("older-{index}"),
                turn_id: format!("older-{index}"),
                status: "done".into(),
                error: None,
                updated_at: 1,
                post_turn_pending: true,
            })
            .collect::<Vec<_>>();
        write_acp_turn_evidence(&mut settings, &pending).unwrap();
        let prepared = |turn: &str, error: Option<&str>| AcpTurnEvidence {
            agent: "claude".into(),
            directory: "/repo".into(),
            session_id: "current".into(),
            turn_id: turn.into(),
            status: "prepared".into(),
            error: error.map(str::to_string),
            updated_at: 0,
            post_turn_pending: error.is_none(),
        };
        merge_acp_turn_evidence_at(&mut settings, prepared("failed", None), 2).unwrap();
        assert_eq!(
            acp_turn_evidence(&settings)
                .iter()
                .filter(|item| item.post_turn_pending)
                .count(),
            ACP_TURN_EVIDENCE_LIMIT
        );
        merge_acp_turn_evidence_at(&mut settings, prepared("failed", Some("not sent")), 3).unwrap();
        merge_acp_turn_evidence_at(&mut settings, prepared("next", None), 4).unwrap();
        let saved = acp_turn_evidence(&settings);
        assert_eq!(saved.len(), ACP_TURN_EVIDENCE_LIMIT);
        assert!(saved.iter().any(|item| item.turn_id == "next"));
        assert!(!saved.iter().any(|item| item.turn_id == "failed"));
    }

    #[test]
    fn acp_turn_evidence_is_provider_correlated_replaced_and_bounded() {
        let evidence = |agent: &str, session: &str, turn: &str, status: &str| AcpTurnEvidence {
            agent: agent.into(),
            directory: "/repo".into(),
            session_id: session.into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
            post_turn_pending: false,
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
            directory: "/repo".into(),
            session_id: "session".into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
            post_turn_pending: false,
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
            directory: "/repo".into(),
            session_id: session.into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
            post_turn_pending: false,
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
                "targetDirectory": "/repo",
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
            directory: "/repo".into(),
            session_id: "session".into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
            post_turn_pending: false,
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
    fn a_new_prompt_keeps_a_completed_turn_waiting_for_evidence_retry() {
        let evidence = |turn: &str, status: &str, pending: bool| AcpTurnEvidence {
            agent: "claude".into(),
            directory: "/repo".into(),
            session_id: "session".into(),
            turn_id: turn.into(),
            status: status.into(),
            error: None,
            updated_at: 0,
            post_turn_pending: pending,
        };
        let mut settings = Settings::new();
        merge_acp_turn_evidence_at(&mut settings, evidence("old", "prepared", true), 1).unwrap();
        merge_acp_turn_evidence_at(&mut settings, evidence("old", "dispatched", false), 2).unwrap();

        merge_acp_turn_evidence_at(&mut settings, evidence("new", "prepared", true), 3).unwrap();
        assert!(acp_turn_evidence(&settings)
            .iter()
            .any(|item| item.turn_id == "old" && item.post_turn_pending));

        merge_acp_turn_evidence_at(&mut settings, evidence("old", "done", true), 4).unwrap();
        assert!(acp_turn_evidence(&settings)
            .iter()
            .any(|item| item.turn_id == "old" && item.status == "done" && item.post_turn_pending));
    }

    #[test]
    fn interrupted_turns_replace_previous_attempt_without_losing_other_threads() {
        let turn = |directory: &str, session: &str, attempt: &str| InterruptedAgentTurn {
            agent: "claude".into(),
            session_id: session.into(),
            directory: directory.into(),
            turn_id: attempt.into(),
            text: "Continue the work".into(),
        };
        let mut settings = Settings::new();
        merge_interrupted_turns(
            &mut settings,
            vec![turn("/repo", "one", "old"), turn("/repo", "two", "other")],
        )
        .unwrap();
        merge_interrupted_turns(&mut settings, vec![turn("/repo", "one", "new")]).unwrap();
        merge_interrupted_turns(&mut settings, vec![turn("/sibling", "one", "new")]).unwrap();
        remove_interrupted_turn(&mut settings, "claude", "/repo", "one", "old").unwrap();
        assert_eq!(
            interrupted_turns(&settings),
            vec![
                turn("/repo", "two", "other"),
                turn("/repo", "one", "new"),
                turn("/sibling", "one", "new")
            ]
        );
        remove_interrupted_turn(&mut settings, "claude", "/repo", "one", "new").unwrap();
        assert_eq!(
            interrupted_turns(&settings),
            vec![
                turn("/repo", "two", "other"),
                turn("/sibling", "one", "new")
            ]
        );
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
                    let before = saved.clone();
                    saved.insert(format!("sai-key-{index}"), index.to_string());
                    write_settings(&path, &before, &saved).unwrap();
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(read_settings(&path).unwrap().len(), 8);
        std::fs::remove_dir_all(directory).unwrap();
    }

    fn scratch_settings(name: &str) -> std::path::PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sail-settings-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("settings.json")
    }

    #[test]
    fn upgrade_moves_state_keys_out_of_settings_and_keeps_every_value() {
        let path = scratch_settings("upgrade");
        let legacy = Settings::from([
            ("sai-theme".to_string(), "dark".to_string()),
            ("sai-agent-transcript-cache".to_string(), "[1]".to_string()),
            ("sai-agent-spawn-receipts".to_string(), "[2]".to_string()),
            ("sai-issue-graph:/repo:ses:1".to_string(), "{}".to_string()),
            (
                MODIFIED_KEY.to_string(),
                "[\"sai-theme\",\"sai-agent-spawn-receipts\"]".to_string(),
            ),
        ]);
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();

        let loaded = read_settings(&path).unwrap();
        assert_eq!(loaded["sai-agent-transcript-cache"], "[1]");
        assert_eq!(loaded["sai-agent-spawn-receipts"], "[2]");
        assert_eq!(loaded["sai-issue-graph:/repo:ses:1"], "{}");
        assert_eq!(loaded["sai-theme"], "dark");
        assert_eq!(
            modified_keys(&loaded),
            ["sai-agent-spawn-receipts", "sai-theme"]
                .map(String::from)
                .into_iter()
                .collect()
        );

        let on_disk = read_settings_file(&path).unwrap();
        assert!(on_disk.keys().all(|key| !is_record_key(key)), "{on_disk:?}");
        assert_eq!(on_disk["sai-theme"], "dark");
        assert!(!on_disk.contains_key(MODIFIED_KEY));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_crash_after_copying_records_loses_nothing_on_the_next_load() {
        let path = scratch_settings("crash");
        let legacy = Settings::from([
            ("sai-theme".to_string(), "dark".to_string()),
            ("sai-ship-runs".to_string(), "[\"old\"]".to_string()),
        ]);
        std::fs::write(&path, serde_json::to_vec(&legacy).unwrap()).unwrap();
        records::write(&path, "sai-ship-runs", "[\"newer\"]").unwrap();

        let loaded = read_settings(&path).unwrap();
        assert_eq!(loaded["sai-ship-runs"], "[\"newer\"]");
        assert_eq!(loaded["sai-theme"], "dark");
        assert!(!read_settings_file(&path)
            .unwrap()
            .contains_key("sai-ship-runs"));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn saving_a_record_key_leaves_settings_json_untouched() {
        let path = scratch_settings("isolated");
        let original = b"{ \"sai-theme\": \"dark\" }";
        std::fs::write(&path, original).unwrap();
        let before = read_scoped(&path, ACP_KEYS).unwrap();
        let mut after = before.clone();
        after.insert(SPAWN_RECEIPTS_KEY.to_string(), "[3]".to_string());
        write_settings(&path, &before, &after).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        assert_eq!(
            read_scoped(&path, ACP_KEYS).unwrap()[SPAWN_RECEIPTS_KEY],
            "[3]"
        );

        let before = after.clone();
        after.remove(SPAWN_RECEIPTS_KEY);
        write_settings(&path, &before, &after).unwrap();
        assert!(read_scoped(&path, ACP_KEYS).unwrap().is_empty());
        assert_eq!(std::fs::read(&path).unwrap(), original);
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn saving_a_user_setting_does_not_rewrite_records() {
        let path = scratch_settings("user");
        let mut saved = Settings::new();
        saved.insert("sai-ship-runs".to_string(), "[1]".to_string());
        write_settings(&path, &Settings::new(), &saved).unwrap();
        let record = path.with_file_name("records");
        let stamp = |directory: &std::path::Path| -> Vec<std::time::SystemTime> {
            std::fs::read_dir(directory)
                .unwrap()
                .map(|entry| entry.unwrap().metadata().unwrap().modified().unwrap())
                .collect()
        };
        let first = stamp(&record);
        let before = read_file_settings(&path).unwrap();
        let mut after = before.clone();
        after.insert("sai-theme".to_string(), "light".to_string());
        write_settings(&path, &before, &after).unwrap();
        assert_eq!(stamp(&record), first);
        assert_eq!(read_settings(&path).unwrap()["sai-theme"], "light");
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn save_setting_writes_only_the_store_that_owns_the_key() {
        let path = scratch_settings("owner");
        std::fs::write(&path, b"{ \"sai-theme\": \"dark\" }").unwrap();
        let original = std::fs::read(&path).unwrap();

        save_setting_at(&path, SPAWN_RECEIPTS_KEY.into(), Some("[1]".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);
        save_setting_at(&path, SPAWN_RECEIPTS_KEY.into(), Some("[2]".into())).unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), original);

        save_setting_at(&path, "sai-theme".into(), Some("light".into())).unwrap();
        let loaded = read_settings(&path).unwrap();
        assert_eq!(loaded["sai-theme"], "light");
        assert_eq!(loaded[SPAWN_RECEIPTS_KEY], "[2]");
        assert_eq!(
            modified_keys(&loaded),
            ["sai-theme", SPAWN_RECEIPTS_KEY]
                .map(String::from)
                .into_iter()
                .collect()
        );
        let on_disk = read_settings_file(&path).unwrap();
        assert_eq!(on_disk.len(), 1, "{on_disk:?}");

        save_setting_at(&path, SPAWN_RECEIPTS_KEY.into(), None).unwrap();
        assert!(!read_settings(&path)
            .unwrap()
            .contains_key(SPAWN_RECEIPTS_KEY));
        std::fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[cfg(feature = "e2e")]
    #[test]
    fn e2e_settings_reset_waits_for_writers_and_fails_closed_on_timeout() {
        let gate = Arc::new(E2eWriterGate {
            state: Mutex::new(E2eWriterState::default()),
            idle: Condvar::new(),
        });
        let writer = gate.begin().unwrap();
        let waiting = gate.clone();
        let (sender, receiver) = mpsc::channel();
        let reset = std::thread::spawn(move || {
            sender
                .send(waiting.quiesce(Duration::from_secs(1)))
                .unwrap();
        });
        assert!(receiver.recv_timeout(Duration::from_millis(25)).is_err());
        drop(writer);
        assert!(receiver
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok());
        reset.join().unwrap();
        assert!(gate.begin().is_err());
        gate.resume().unwrap();
        assert!(gate.begin().is_ok());

        let writer = gate.begin().unwrap();
        assert!(gate.quiesce(Duration::from_millis(1)).is_err());
        assert!(gate.begin().is_err());
        drop(writer);
        gate.resume().unwrap();
        assert!(gate.begin().is_ok());
    }
}
