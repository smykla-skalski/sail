use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

use crate::browser_agent::CapabilityProfile;

struct AgentDefinition {
    id: &'static str,
    name: &'static str,
    executable: &'static str,
    binary_env: Option<&'static str>,
    launch: Launch,
}

enum Launch {
    Npx {
        package: &'static str,
        min_node_major: u32,
    },
    // Native binary resolved by the shared OpenCode settings; started as `<binary> acp`.
    OpenCode,
}

const OPENCODE_BINARY_SETTING: &str = "sai-opencode-bin";

const AGENTS: &[AgentDefinition] = &[
    AgentDefinition {
        id: "claude",
        name: "Claude",
        executable: "claude",
        binary_env: None,
        launch: Launch::Npx {
            package: "@agentclientprotocol/claude-agent-acp@0.84.0",
            min_node_major: 22,
        },
    },
    AgentDefinition {
        id: "codex",
        name: "Codex",
        executable: "codex",
        binary_env: Some("CODEX_PATH"),
        launch: Launch::Npx {
            package: "@agentclientprotocol/codex-acp@2.0.0",
            min_node_major: 18,
        },
    },
    AgentDefinition {
        id: "opencode",
        name: "OpenCode",
        executable: "opencode",
        binary_env: None,
        launch: Launch::OpenCode,
    },
];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentAvailability {
    id: String,
    name: String,
    binary_path: Option<String>,
    available: bool,
    reason: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AgentEvent {
    agent: String,
    message: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSubagentSnapshot {
    agent: String,
    capability_profile: CapabilityProfile,
    session_id: String,
    parent_session_id: String,
    directory: String,
    outcome: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSubagentSnapshotSet {
    generation: u64,
    subagents: Vec<NativeSubagentSnapshot>,
}

#[derive(Clone)]
struct NativeSubagentState {
    parent_session_id: String,
    directory: PathBuf,
    outcome: String,
}

#[derive(Default)]
struct NativeSubagentRegistry(HashMap<String, NativeSubagentState>);

impl NativeSubagentRegistry {
    fn spawn(&mut self, parent_session_id: &str, session_id: &str, directory: PathBuf) {
        self.0
            .entry(session_id.to_string())
            .and_modify(|entry| {
                entry.parent_session_id = parent_session_id.to_string();
                entry.directory = directory.clone();
            })
            .or_insert_with(|| NativeSubagentState {
                parent_session_id: parent_session_id.to_string(),
                directory,
                outcome: "working".into(),
            });
    }

    fn update(&mut self, session_id: &str, outcome: &str) {
        let Some(entry) = self.0.get_mut(session_id) else {
            return;
        };
        entry.outcome = match outcome {
            "completed" | "failed" | "working" => outcome,
            "cancelled" => "interrupted",
            _ => "unknown",
        }
        .into();
    }

    fn active_in(&self, directory: &Path) -> Vec<String> {
        self.0
            .iter()
            .filter(|(_, entry)| {
                entry.directory == directory
                    && !matches!(
                        entry.outcome.as_str(),
                        "completed" | "failed" | "interrupted"
                    )
            })
            .map(|(session_id, _)| session_id.clone())
            .collect()
    }

    fn snapshots(
        &self,
        agent: &str,
        profile: CapabilityProfile,
        directory: &Path,
    ) -> Vec<NativeSubagentSnapshot> {
        self.0
            .iter()
            .filter(|(_, entry)| entry.directory == directory)
            .map(|(session_id, entry)| NativeSubagentSnapshot {
                agent: agent.to_string(),
                capability_profile: profile,
                session_id: session_id.clone(),
                parent_session_id: entry.parent_session_id.clone(),
                directory: entry.directory.to_string_lossy().into_owned(),
                outcome: entry.outcome.clone(),
            })
            .collect()
    }
}

#[derive(Default)]
struct WorktreeFenceState {
    generations: HashMap<PathBuf, u64>,
    starting_sessions: HashMap<PathBuf, usize>,
    guarded_sessions: HashMap<(String, String), GuardedSession>,
}

struct GuardedSession {
    directory: PathBuf,
    expected_generation: u64,
}

#[derive(Clone, Default)]
pub struct AgentWorktreeFence(Arc<Mutex<WorktreeFenceState>>);

impl AgentWorktreeFence {
    #[cfg(test)]
    fn record_native_update(&self, directory: &Path) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        let generation = state
            .generations
            .entry(directory.to_path_buf())
            .or_default();
        *generation = generation.saturating_add(1);
        Ok(())
    }

    fn begin_session(
        &self,
        directory: &Path,
        expected_generation: Option<u64>,
    ) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        if !directory.is_dir() {
            return Err("Repository directory does not exist.".into());
        }
        let generation = state
            .generations
            .get(directory)
            .copied()
            .unwrap_or_default();
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err("Task-owned subagents changed before the replacement started.".into());
        }
        *state
            .starting_sessions
            .entry(directory.to_path_buf())
            .or_default() += 1;
        Ok(())
    }

    fn finish_session(
        &self,
        directory: &Path,
        expected_generation: Option<u64>,
    ) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        Self::finish_starting_session(&mut state, directory);
        let generation = state
            .generations
            .get(directory)
            .copied()
            .unwrap_or_default();
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err("Task-owned subagents changed while the replacement was starting.".into());
        }
        if !directory.is_dir() {
            return Err("Repository directory no longer exists.".into());
        }
        Ok(())
    }

    fn arm_session(
        &self,
        agent: &str,
        session_id: &str,
        directory: &Path,
        expected_generation: u64,
    ) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        Self::finish_starting_session(&mut state, directory);
        let generation = state
            .generations
            .get(directory)
            .copied()
            .unwrap_or_default();
        if expected_generation != generation {
            return Err("Task-owned subagents changed while the replacement was starting.".into());
        }
        if !directory.is_dir() {
            return Err("Repository directory no longer exists.".into());
        }
        state.guarded_sessions.insert(
            (agent.to_string(), session_id.to_string()),
            GuardedSession {
                directory: directory.to_path_buf(),
                expected_generation,
            },
        );
        Ok(())
    }

    fn release_session(&self, agent: &str, session_id: &str) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .guarded_sessions
            .remove(&(agent.to_string(), session_id.to_string()));
        Ok(())
    }

    fn dispatch_session<T>(
        &self,
        agent: &str,
        session_id: &str,
        dispatch: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        let key = (agent.to_string(), session_id.to_string());
        let Some(guard) = state.guarded_sessions.remove(&key) else {
            drop(state);
            return dispatch();
        };
        let generation = state
            .generations
            .get(&guard.directory)
            .copied()
            .unwrap_or_default();
        if guard.expected_generation != generation {
            return Err("Task-owned subagents changed before replacement prompt dispatch.".into());
        }
        if !guard.directory.is_dir() {
            return Err("Repository directory no longer exists.".into());
        }
        dispatch()
    }

    fn finish_starting_session(state: &mut WorktreeFenceState, directory: &Path) {
        if let Some(count) = state.starting_sessions.get_mut(directory) {
            *count = count.saturating_sub(1);
            if *count == 0 {
                state.starting_sessions.remove(directory);
            }
        }
    }

    pub fn stop_sessions_in(
        &self,
        app: &AppHandle,
        agents: &AgentManager,
        directory: &Path,
    ) -> Result<(), String> {
        for entry in agents.active_sessions_in(directory)? {
            let Some((agent, session_id)) = entry.split_once(':') else {
                continue;
            };
            if let Ok(runtime) = connection_for_session(agents, agent, session_id) {
                let _ = cancel_session(app, &runtime, agent, session_id, None);
            }
        }
        // Cancel is asynchronous; the prompt stays active until the agent replies.
        let deadline = Instant::now() + Duration::from_secs(10);
        while !agents.active_sessions_in(directory)?.is_empty() && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(100));
        }
        Ok(())
    }

    pub fn cleanup<T>(
        &self,
        agents: &AgentManager,
        directory: &Path,
        expected_generation: Option<u64>,
        cleanup: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let state = self.0.lock().map_err(|error| error.to_string())?;
        let generation = state
            .generations
            .get(directory)
            .copied()
            .unwrap_or_default();
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err("Task-owned subagents changed before worktree cleanup.".into());
        }
        if state
            .starting_sessions
            .get(directory)
            .is_some_and(|count| *count > 0)
            || state
                .guarded_sessions
                .values()
                .any(|guard| guard.directory == directory)
        {
            return Err("An agent session is starting in this worktree.".into());
        }
        let active = agents.active_sessions_in(directory)?;
        if !active.is_empty() {
            return Err(format!(
                "Worktree has active agent sessions: {}.",
                active.join(", ")
            ));
        }
        cleanup()
    }
}

struct Connection {
    agent: String,
    profile: CapabilityProfile,
    child: Mutex<Child>,
    #[cfg(unix)]
    watchdog: Mutex<crate::child_watchdog::ChildWatchdog>,
    stopped: AtomicBool,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::Sender<PendingResponse>>>,
    reader_progress: ReaderProgress,
    permission_state: Mutex<PermissionState>,
    elicitation_state: Mutex<HashMap<String, PendingElicitation>>,
    next_permission_generation: AtomicU64,
    prompt_state: Mutex<PromptState>,
    cancelled_prompts: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    capabilities: Mutex<Value>,
    session_directories: Mutex<HashMap<String, PathBuf>>,
    session_configs: Mutex<HashMap<String, SessionConfig>>,
    native_subagents: Mutex<NativeSubagentRegistry>,
    session_profiles: Mutex<HashMap<String, CapabilityProfile>>,
    pending_directory: Mutex<Option<PathBuf>>,
    session_creation: Mutex<()>,
    ready: Condvar,
}

// The adapter fingerprints `cwd` and `mcpServers`, and recreates a live
// session (killing its turn and background work) when they change. Each
// session therefore keeps the exact parameters it was first sent.
#[derive(Clone)]
struct SessionConfig {
    cwd: String,
    directory: PathBuf,
    servers: Vec<Value>,
    token: String,
}

fn mcp_server(config: &crate::browser_agent::McpConfig) -> Value {
    json!({
        "name":"sail-browser",
        "command":config.command,
        "args":config.args,
        "env":config.env.iter().map(|(name,value)| json!({"name":name,"value":value})).collect::<Vec<_>>()
    })
}

fn session_request_params(cwd: &str, session_id: Option<&str>, servers: &[Value]) -> Value {
    let mut params = json!({"cwd":cwd,"mcpServers":servers});
    if let Some(session_id) = session_id {
        params["sessionId"] = json!(session_id);
    }
    params
}

fn session_servers(browser: Value, memory: Option<Value>) -> Vec<Value> {
    let mut servers = vec![browser];
    if let Some(memory) = memory {
        servers.push(memory);
    }
    servers
}

fn optional_memory_server(result: Result<Option<Value>, String>) -> Option<Value> {
    result.unwrap_or_default()
}

fn per_load_mcp() -> bool {
    std::env::var("SAIL_ACP_PER_LOAD_MCP").as_deref() == Ok("1")
}

fn canonical_directory(cwd: &str) -> PathBuf {
    PathBuf::from(cwd)
        .canonicalize()
        .unwrap_or_else(|_| PathBuf::from(cwd))
}

/// Returns the parameters to send for a restored session, reusing the ones
/// already sent for it so the adapter keeps the live session.
fn reuse_session_config(
    configs: &mut HashMap<String, SessionConfig>,
    session_id: &str,
    cwd: &str,
    memory: Option<Value>,
    mint: impl FnOnce() -> Result<crate::browser_agent::McpConfig, String>,
    mut release: impl FnMut(&str),
) -> Result<SessionConfig, String> {
    let directory = canonical_directory(cwd);
    if let Some(existing) = configs.get(session_id) {
        if existing.directory == directory {
            return Ok(existing.clone());
        }
    }
    let config = mint()?;
    let next = SessionConfig {
        cwd: cwd.to_string(),
        directory,
        servers: session_servers(mcp_server(&config), memory),
        token: config.token,
    };
    if let Some(previous) = configs.insert(session_id.to_string(), next.clone()) {
        release(&previous.token);
    }
    Ok(next)
}

/// Returns the parameters to send for a restored session. Reuse keeps the adapter's live session;
/// `per_load` is the documented rollback switch and mints a fresh config for every load.
fn restore_params(
    per_load: bool,
    configs: &mut HashMap<String, SessionConfig>,
    session_id: &str,
    cwd: &str,
    memory: Option<Value>,
    mint: impl FnOnce() -> Result<crate::browser_agent::McpConfig, String>,
    release: impl FnMut(&str),
) -> Result<Value, String> {
    if per_load {
        let config = mint()?;
        let servers = session_servers(mcp_server(&config), memory);
        return Ok(session_request_params(cwd, Some(session_id), &servers));
    }
    let config = reuse_session_config(configs, session_id, cwd, memory, mint, release)?;
    Ok(session_request_params(
        &config.cwd,
        Some(session_id),
        &config.servers,
    ))
}

#[derive(Clone, Debug)]
struct PendingPermission {
    message: Value,
    received_at: u64,
    generation: u64,
    fingerprint: String,
}

#[derive(Clone, Debug)]
struct PendingElicitation {
    message: Value,
    received_at: u64,
}

#[cfg(test)]
fn claim_pending_permission(
    permissions: &Mutex<HashMap<String, PendingPermission>>,
    key: &str,
    expected_session_id: &str,
    expected_generation: u64,
    expected_fingerprint: &str,
) -> Result<PendingPermission, String> {
    let mut permissions = permissions.lock().map_err(|error| error.to_string())?;
    claim_pending_permission_map(
        &mut permissions,
        key,
        expected_session_id,
        expected_generation,
        expected_fingerprint,
    )
}

fn claim_pending_permission_map(
    permissions: &mut HashMap<String, PendingPermission>,
    key: &str,
    expected_session_id: &str,
    expected_generation: u64,
    expected_fingerprint: &str,
) -> Result<PendingPermission, String> {
    let pending = permissions
        .get(key)
        .ok_or_else(|| "Permission request is no longer pending.".to_string())?;
    let session_id = pending
        .message
        .pointer("/params/sessionId")
        .and_then(Value::as_str);
    if session_id != Some(expected_session_id)
        || pending.generation != expected_generation
        || pending.fingerprint != expected_fingerprint
    {
        return Err("Permission request identity no longer matches.".to_string());
    }
    permissions
        .remove(key)
        .ok_or_else(|| "Permission request is no longer pending.".to_string())
}

struct PendingResponse {
    message: Value,
    generation: u64,
}

#[derive(Default)]
struct ReaderProgress {
    next: AtomicU64,
    processed: Mutex<u64>,
    ready: Condvar,
}

impl ReaderProgress {
    fn next_generation(&self) -> u64 {
        self.next.fetch_add(1, Ordering::AcqRel) + 1
    }

    fn acknowledge(&self, generation: u64) {
        if let Ok(mut processed) = self.processed.lock() {
            *processed = (*processed).max(generation);
            self.ready.notify_all();
        }
    }

    fn wait_for(&self, generation: u64) -> Result<(), String> {
        let mut processed = self.processed.lock().map_err(|error| error.to_string())?;
        while *processed < generation {
            processed = self
                .ready
                .wait(processed)
                .map_err(|error| error.to_string())?;
        }
        Ok(())
    }

    fn processed(&self) -> Result<u64, String> {
        self.processed
            .lock()
            .map(|processed| *processed)
            .map_err(|error| error.to_string())
    }
}

#[derive(Default)]
struct PermissionState {
    pending: HashMap<String, PendingPermission>,
    canceling_sessions: HashMap<String, CancelingSession>,
    settled_prompts: HashMap<String, (String, u64)>,
    /// Requests answered already, so a repeat of the same answer from another surface succeeds
    /// instead of failing. Bounded; the oldest entries go first.
    answered: HashMap<String, AnsweredPermission>,
    answered_order: VecDeque<String>,
}

#[derive(Clone)]
struct AnsweredPermission {
    session_id: String,
    generation: u64,
    fingerprint: String,
    result: Value,
}

const ANSWERED_PERMISSION_LIMIT: usize = 256;

impl PermissionState {
    fn remember_answer(
        &mut self,
        key: &str,
        pending: &PendingPermission,
        session_id: &str,
        result: &Value,
    ) {
        if self.answered.len() >= ANSWERED_PERMISSION_LIMIT {
            if let Some(oldest) = self.answered_order.pop_front() {
                self.answered.remove(&oldest);
            }
        }
        self.answered_order.retain(|item| item != key);
        self.answered_order.push_back(key.to_string());
        self.answered.insert(
            key.to_string(),
            AnsweredPermission {
                session_id: session_id.to_string(),
                generation: pending.generation,
                fingerprint: pending.fingerprint.clone(),
                result: result.clone(),
            },
        );
    }

    /// True when this exact answer already resolved the request.
    fn repeats_answer(
        &self,
        key: &str,
        session_id: &str,
        generation: u64,
        fingerprint: &str,
        result: &Value,
    ) -> bool {
        self.answered.get(key).is_some_and(|answered| {
            answered.session_id == session_id
                && answered.generation == generation
                && answered.fingerprint == fingerprint
                && &answered.result == result
        })
    }
}

struct CancelingSession {
    turn_id: Option<String>,
    settlement_generation: Option<u64>,
}

impl PermissionState {
    fn record(
        &mut self,
        message: Value,
        received_at: u64,
        turn_id: Option<String>,
        mut resolve: impl FnMut(&Value) -> Result<(), String>,
    ) -> Result<(), String> {
        let Some(request_id) = message.get("id").cloned() else {
            return Ok(());
        };
        let session_id = message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        let generation = message
            .pointer("/params/sailPermissionGeneration")
            .and_then(Value::as_u64)
            .unwrap_or_default();
        let fingerprint = message
            .pointer("/params/sailPermissionFingerprint")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string();
        self.pending.insert(
            request_id.to_string(),
            PendingPermission {
                message,
                received_at,
                generation,
                fingerprint,
            },
        );
        let cancel_late_request =
            self.canceling_sessions
                .get(&session_id)
                .is_some_and(|canceling| {
                    turn_id.as_deref().is_none_or(|request_turn| {
                        canceling.turn_id.as_deref() == Some(request_turn)
                    })
                });
        if cancel_late_request {
            let key = request_id.to_string();
            resolve(&request_id)?;
            self.pending.remove(&key);
        }
        Ok(())
    }

    fn begin_cancel(&mut self, session_id: &str, turn_id: Option<&str>) {
        let Some(turn_id) = turn_id else {
            return;
        };
        let settlement_generation = self
            .settled_prompts
            .get(session_id)
            .filter(|(settled_turn, _)| settled_turn == turn_id)
            .map(|(_, generation)| *generation);
        self.canceling_sessions.insert(
            session_id.to_string(),
            CancelingSession {
                turn_id: Some(turn_id.to_string()),
                settlement_generation,
            },
        );
    }

    fn acknowledge_prompt_settlement(&mut self, session_id: &str, turn_id: &str, generation: u64) {
        self.settled_prompts
            .insert(session_id.to_string(), (turn_id.to_string(), generation));
        if let Some(canceling) = self.canceling_sessions.get_mut(session_id) {
            if canceling.turn_id.as_deref().is_none_or(|id| id == turn_id) {
                canceling.settlement_generation = Some(generation);
            }
        }
    }

    fn begin_turn(&mut self, session_id: &str, processed_generation: u64) -> bool {
        match self.canceling_sessions.get(session_id) {
            None => true,
            Some(canceling)
                if canceling
                    .settlement_generation
                    .is_some_and(|generation| generation <= processed_generation) =>
            {
                self.settled_prompts.remove(session_id);
                true
            }
            Some(_) => false,
        }
    }
}

fn resolve_session_permissions(
    permissions: &mut HashMap<String, PendingPermission>,
    session_id: &str,
    mut resolve: impl FnMut(&Value, &PendingPermission) -> Result<(), String>,
) -> Result<(), String> {
    let ids = permissions
        .iter()
        .filter_map(|(key, pending)| {
            (pending
                .message
                .pointer("/params/sessionId")
                .and_then(Value::as_str)
                == Some(session_id))
            .then_some(key.clone())
        })
        .collect::<Vec<_>>();
    for key in ids {
        let Some(pending) = permissions.get(&key) else {
            continue;
        };
        let Some(request_id) = pending.message.get("id") else {
            continue;
        };
        resolve(request_id, pending)?;
        permissions.remove(&key);
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermissionInfo {
    agent: String,
    message: Value,
    received_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PermissionResourceTrust {
    trusted: bool,
    canonical_resources: Vec<String>,
}

fn inspect_permission_resources(
    workspace: &Path,
    resources: &[String],
) -> Result<PermissionResourceTrust, String> {
    let root = workspace
        .canonicalize()
        .map_err(|error| format!("Cannot inspect workspace resources: {error}"))?;
    let mut canonical_resources = Vec::new();
    for resource in resources {
        let local_file_url = resource
            .strip_prefix("file://localhost/")
            .map(|path| format!("/{path}"))
            .or_else(|| {
                resource
                    .strip_prefix("file:///")
                    .map(|path| format!("/{path}"))
            });
        #[cfg(windows)]
        let local_file_url = local_file_url.map(|path| {
            if path.as_bytes().get(2) == Some(&b':') {
                path[1..].to_string()
            } else {
                path
            }
        });
        if resource.is_empty()
            || resource.starts_with('~')
            || (resource.contains("://") && local_file_url.is_none())
            || resource.contains('$')
            || resource.contains('%')
        {
            return Ok(PermissionResourceTrust {
                trusted: false,
                canonical_resources,
            });
        }
        let resource_path = PathBuf::from(local_file_url.as_deref().unwrap_or(resource));
        let target = if resource_path.is_absolute() {
            resource_path
        } else {
            workspace.join(resource_path)
        };
        if !target.exists() {
            return Ok(PermissionResourceTrust {
                trusted: false,
                canonical_resources,
            });
        }
        let canonical = target
            .canonicalize()
            .map_err(|error| format!("Cannot inspect permission resource: {error}"))?;
        if !canonical.starts_with(&root) {
            return Ok(PermissionResourceTrust {
                trusted: false,
                canonical_resources,
            });
        }
        let mut component = target.as_path();
        while component.starts_with(workspace) && component != workspace {
            if std::fs::symlink_metadata(component)
                .map(|metadata| metadata.file_type().is_symlink())
                .unwrap_or(false)
            {
                return Ok(PermissionResourceTrust {
                    trusted: false,
                    canonical_resources,
                });
            }
            let Some(parent) = component.parent() else {
                break;
            };
            component = parent;
        }
        canonical_resources.push(canonical.to_string_lossy().into_owned());
    }
    Ok(PermissionResourceTrust {
        trusted: true,
        canonical_resources,
    })
}

#[tauri::command]
pub fn acp_permission_resources_trusted(
    workspace: String,
    resources: Vec<String>,
) -> Result<PermissionResourceTrust, String> {
    inspect_permission_resources(Path::new(&workspace), &resources)
}

impl Drop for Connection {
    fn drop(&mut self) {
        self.stop_child();
    }
}

impl Connection {
    fn stop_child(&self) {
        if let Ok(mut child) = self.child.lock() {
            if self.stopped.swap(true, Ordering::AcqRel) {
                return;
            }
            stop_process(&mut child);
        }
        #[cfg(unix)]
        if let Ok(mut watchdog) = self.watchdog.lock() {
            watchdog.stop();
        }
    }

    fn terminate(&self) {
        self.stop_child();
        self.alive.store(false, Ordering::Release);
        self.ready.notify_all();
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        let mut input = self.input.lock().map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut *input, message).map_err(|error| error.to_string())?;
        input.write_all(b"\n").map_err(|error| error.to_string())?;
        input.flush().map_err(|error| error.to_string())
    }

    fn request_response(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<PendingResponse, String> {
        self.request_response_around_write(
            method,
            params,
            timeout,
            |message| self.write(message),
            || {},
        )
    }

    fn request_response_around_write(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        write_message: impl FnOnce(&Value) -> Result<(), String>,
        after_write: impl FnOnce(),
    ) -> Result<PendingResponse, String> {
        if !self.alive.load(Ordering::Acquire) {
            return Err("Agent process stopped. Reopen the thread to reconnect.".into());
        }
        let id = self.next_id.fetch_add(1, Ordering::Relaxed);
        let started = Instant::now();
        let session_id = params
            .get("sessionId")
            .and_then(Value::as_str)
            .map(str::to_string);
        crate::diagnostics::record(
            "acp_request_started",
            json!({"agent":self.agent,"method":method,"requestId":id,"sessionId":session_id}),
        );
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, sender);
        if let Err(error) =
            write_message(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
        {
            crate::diagnostics::record(
                "acp_request_write_failed",
                json!({
                    "agent":self.agent,"method":method,"requestId":id,"sessionId":session_id
                }),
            );
            self.pending
                .lock()
                .map_err(|cause| cause.to_string())?
                .remove(&id);
            return Err(error);
        }
        after_write();
        let response = receiver.recv_timeout(timeout).map_err(|_| {
            crate::diagnostics::record(
                "acp_request_timeout",
                json!({
                    "agent":self.agent,"method":method,"requestId":id,"sessionId":session_id,
                    "elapsedMs":started.elapsed().as_millis()
                }),
            );
            self.pending
                .lock()
                .ok()
                .and_then(|mut pending| pending.remove(&id));
            format!("Agent did not answer {method} in time.")
        })?;
        self.reader_progress.wait_for(response.generation)?;
        crate::diagnostics::record(
            "acp_request_finished",
            json!({
                "method":method,"requestId":id,"elapsedMs":started.elapsed().as_millis(),
                "agent":self.agent,"sessionId":session_id,
                "ok":response.message.get("error").is_none(),
                "stopReason":response.message.pointer("/result/stopReason").and_then(Value::as_str)
            }),
        );
        Ok(response)
    }

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let response = self.request_response(method, params, timeout)?.message;
        if let Some(error) = response.get("error") {
            return Err(error
                .get("message")
                .and_then(Value::as_str)
                .unwrap_or("Agent request failed.")
                .to_string());
        }
        Ok(response.get("result").cloned().unwrap_or(Value::Null))
    }

    fn notify(&self, method: &str, params: Value) -> Result<(), String> {
        self.write(&json!({"jsonrpc":"2.0","method":method,"params":params}))
    }

    fn respond(
        &self,
        id: Value,
        expected_session_id: &str,
        expected_generation: u64,
        expected_fingerprint: &str,
        result: Value,
    ) -> Result<Option<PendingPermission>, String> {
        let key = id.to_string();
        let mut state = self
            .permission_state
            .lock()
            .map_err(|error| error.to_string())?;
        let pending = match claim_pending_permission_map(
            &mut state.pending,
            &key,
            expected_session_id,
            expected_generation,
            expected_fingerprint,
        ) {
            Ok(pending) => pending,
            Err(error) => {
                // A second surface repeating the first answer is a success with no new event.
                return if state.repeats_answer(
                    &key,
                    expected_session_id,
                    expected_generation,
                    expected_fingerprint,
                    &result,
                ) {
                    Ok(None)
                } else {
                    Err(error)
                };
            }
        };
        if let Err(error) = self.write(&json!({"jsonrpc":"2.0","id":id,"result":result})) {
            state.pending.entry(key).or_insert_with(|| pending.clone());
            return Err(error);
        }
        state.remember_answer(&key, &pending, expected_session_id, &result);
        Ok(Some(pending))
    }
}

fn stop_process(child: &mut Child) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
    }
    #[cfg(windows)]
    let _ = Command::new("taskkill")
        .args(["/PID", &child.id().to_string(), "/T", "/F"])
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
    let _ = child.kill();
    let _ = child.wait();
}

type ConnectionKey = (String, CapabilityProfile);

#[derive(Clone, Default)]
pub struct AgentManager(Arc<Mutex<HashMap<ConnectionKey, Arc<Connection>>>>);

impl AgentManager {
    fn active_sessions_in(&self, directory: &Path) -> Result<Vec<String>, String> {
        let agents = self.0.lock().map_err(|error| error.to_string())?;
        let mut active = Vec::new();
        for ((agent, _profile), runtime) in agents.iter() {
            let directories = runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?;
            let prompts = runtime
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?;
            active.extend(
                prompts
                    .active
                    .keys()
                    .filter(|session_id| {
                        directories
                            .get(*session_id)
                            .is_some_and(|path| path == directory)
                    })
                    .map(|session_id| format!("{agent}:{session_id}")),
            );
            drop(prompts);
            drop(directories);
            active.extend(
                runtime
                    .native_subagents
                    .lock()
                    .map_err(|error| error.to_string())?
                    .active_in(directory)
                    .into_iter()
                    .map(|session_id| format!("{agent}:{session_id}")),
            );
        }
        active.sort();
        active.dedup();
        Ok(active)
    }

    fn native_subagent_snapshots(
        &self,
        directory: &Path,
    ) -> Result<Vec<NativeSubagentSnapshot>, String> {
        let agents = self.0.lock().map_err(|error| error.to_string())?;
        let mut snapshots = Vec::new();
        for ((agent, profile), runtime) in agents.iter() {
            snapshots.extend(
                runtime
                    .native_subagents
                    .lock()
                    .map_err(|error| error.to_string())?
                    .snapshots(agent, *profile, directory),
            );
        }
        snapshots.sort_by(|left, right| {
            (&left.agent, &left.session_id).cmp(&(&right.agent, &right.session_id))
        });
        Ok(snapshots)
    }

    pub fn record_interrupted_turns(&self, app: &AppHandle) -> Result<(), String> {
        let agents = self.0.lock().map_err(|error| error.to_string())?;
        for runtime in agents.values() {
            let prompts = runtime
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?;
            let directories = runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?;
            let mut turns = Vec::new();
            for (session_id, prompt) in &prompts.active {
                if let Some(directory) = directories.get(session_id) {
                    turns.push(crate::settings::InterruptedAgentTurn {
                        agent: runtime.agent.clone(),
                        session_id: session_id.clone(),
                        directory: directory.to_string_lossy().into_owned(),
                        turn_id: prompt.turn_id.clone(),
                        text: prompt.text.clone(),
                    });
                }
            }
            drop(directories);
            crate::settings::record_interrupted_turns(app, turns)?;
        }
        Ok(())
    }

    pub fn shutdown(&self) {
        let connections = self
            .0
            .lock()
            .ok()
            .map(|mut agents| {
                agents
                    .drain()
                    .map(|(_, runtime)| runtime)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for runtime in connections {
            runtime.terminate();
        }
    }

    pub fn server_roots(&self) -> Vec<u32> {
        self.0
            .lock()
            .ok()
            .map(|agents| {
                agents
                    .values()
                    .filter_map(|connection| {
                        if !connection.alive.load(Ordering::Acquire) {
                            return None;
                        }
                        connection.child.lock().ok().map(|child| child.id())
                    })
                    .collect()
            })
            .unwrap_or_default()
    }
}

#[tauri::command]
pub fn acp_prepare_restart(app: AppHandle, manager: State<'_, AgentManager>) -> Result<(), String> {
    manager.record_interrupted_turns(&app)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentActivity {
    alive: bool,
    active: Vec<String>,
    active_turns: HashMap<String, String>,
    waiting: Vec<String>,
    sessions: Vec<String>,
    finished: HashMap<String, PromptOutcome>,
}

#[derive(Default)]
struct PromptState {
    active: HashMap<String, ActivePrompt>,
    finished: HashMap<String, PromptOutcome>,
    tool_turns: HashMap<String, HashMap<String, String>>,
    retired_tool_turns: HashMap<String, VecDeque<(String, String)>>,
}

impl PromptState {
    const ACTIVE_TOOL_TURN_LIMIT: usize = 512;
    const RETIRED_TOOL_TURN_LIMIT: usize = 4096;

    fn remember_retired_tool_turns(
        &mut self,
        session_id: &str,
        turns: impl IntoIterator<Item = (String, String)>,
    ) {
        let retired = self
            .retired_tool_turns
            .entry(session_id.to_string())
            .or_default();
        retired.extend(turns);
        while retired.len() > Self::RETIRED_TOOL_TURN_LIMIT {
            retired.pop_front();
        }
    }

    fn retire_turn(&mut self, session_id: &str, turn_id: &str) {
        let retired = self
            .tool_turns
            .get_mut(session_id)
            .map(|turns| {
                let ids = turns
                    .iter()
                    .filter_map(|(tool_id, mapped_turn)| {
                        (mapped_turn == turn_id).then_some(tool_id.clone())
                    })
                    .collect::<Vec<_>>();
                ids.into_iter()
                    .filter_map(|tool_id| turns.remove(&tool_id).map(|turn| (tool_id, turn)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        self.remember_retired_tool_turns(session_id, retired);
    }

    fn observe_update(&mut self, session_id: &str, update: &Value) {
        let turn_id = self
            .active
            .get(session_id)
            .map(|prompt| prompt.turn_id.clone());
        if let (Some(turn_id), Some(tool_call_id)) =
            (turn_id, update.get("toolCallId").and_then(Value::as_str))
        {
            let retired = {
                let turns = self.tool_turns.entry(session_id.to_string()).or_default();
                if turns.len() >= Self::ACTIVE_TOOL_TURN_LIMIT && !turns.contains_key(tool_call_id)
                {
                    turns.drain().collect::<Vec<_>>()
                } else {
                    Vec::new()
                }
            };
            if !retired.is_empty() {
                self.remember_retired_tool_turns(session_id, retired);
            }
            self.tool_turns
                .entry(session_id.to_string())
                .or_default()
                .entry(tool_call_id.to_string())
                .or_insert(turn_id);
        }
        if let Some(prompt) = self.active.get_mut(session_id) {
            prompt.observe_update(update);
        }
    }

    fn permission_turn(&mut self, message: &Value) -> Option<String> {
        let session_id = message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)?;
        let tool_call_id = message
            .pointer("/params/toolCall/toolCallId")
            .and_then(Value::as_str)?;
        if let Some(turn_id) = self
            .tool_turns
            .get(session_id)
            .and_then(|turns| turns.get(tool_call_id))
        {
            return Some(turn_id.clone());
        }
        if let Some((_, turn_id)) = self
            .retired_tool_turns
            .get(session_id)
            .and_then(|turns| turns.iter().rev().find(|(id, _)| id == tool_call_id))
        {
            return Some(turn_id.clone());
        }
        let turn_id = self
            .active
            .get(session_id)
            .map(|prompt| prompt.turn_id.clone())?;
        self.tool_turns
            .entry(session_id.to_string())
            .or_default()
            .insert(tool_call_id.to_string(), turn_id.clone());
        Some(turn_id)
    }

    fn cancellation_turn(&self, session_id: &str, turn_id: Option<String>) -> Option<String> {
        turn_id
            .or_else(|| {
                self.active
                    .get(session_id)
                    .map(|prompt| prompt.turn_id.clone())
            })
            .or_else(|| {
                self.finished
                    .get(session_id)
                    .map(|prompt| prompt.turn_id.clone())
            })
    }
}

fn append_connection_activity(
    activity: &mut HashMap<String, AgentActivity>,
    agent: &str,
    alive: bool,
    prompts: &PromptState,
    directories: &HashMap<String, PathBuf>,
    permissions: &HashMap<String, PendingPermission>,
) {
    if !alive {
        return;
    }
    let item = activity
        .entry(agent.to_string())
        .or_insert_with(|| AgentActivity {
            alive: true,
            active: Vec::new(),
            active_turns: HashMap::new(),
            waiting: Vec::new(),
            sessions: Vec::new(),
            finished: HashMap::new(),
        });
    item.alive = true;
    item.active.extend(prompts.active.keys().cloned());
    item.active_turns.extend(
        prompts
            .active
            .iter()
            .map(|(session, prompt)| (session.clone(), prompt.turn_id.clone())),
    );
    item.finished.extend(prompts.finished.clone());
    item.sessions.extend(directories.keys().cloned());
    item.waiting.extend(
        permissions
            .values()
            .filter_map(|pending| {
                pending
                    .message
                    .pointer("/params/sessionId")
                    .and_then(Value::as_str)
            })
            .map(str::to_string),
    );
}

struct ActivePrompt {
    turn_id: String,
    text: String,
    last_agent_message: String,
    agent_message_open: bool,
    agent_message_overflow: bool,
    known_tool_calls: HashSet<String>,
}

fn durable_prompt_status(status: &'static str, failed: bool, dispatch_phase: u8) -> &'static str {
    if !failed {
        return status;
    }
    match dispatch_phase {
        0 => "prepared",
        1 => "dispatch_uncertain",
        _ => "dispatched",
    }
}

impl ActivePrompt {
    fn observe_update(&mut self, update: &Value) {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    if !self.agent_message_open {
                        self.last_agent_message.clear();
                        self.agent_message_overflow = false;
                    }
                    self.agent_message_open = true;
                    if !self.agent_message_overflow {
                        if self.last_agent_message.len() + text.len() <= 256 {
                            self.last_agent_message.push_str(text);
                        } else {
                            self.last_agent_message.clear();
                            self.agent_message_overflow = true;
                        }
                    }
                }
            }
            Some("user_message_chunk" | "agent_thought_chunk") => {
                if update
                    .pointer("/content/text")
                    .and_then(Value::as_str)
                    .is_some()
                {
                    self.agent_message_open = false;
                }
            }
            Some("tool_call" | "tool_call_update") => {
                if let Some(id) = update.get("toolCallId").and_then(Value::as_str) {
                    if self.known_tool_calls.insert(id.to_string()) {
                        self.agent_message_open = false;
                    }
                }
            }
            _ => {}
        }
    }

    fn reports_interruption(&self) -> bool {
        self.agent_message_open
            && !self.agent_message_overflow
            && self
                .last_agent_message
                .trim()
                .eq_ignore_ascii_case("Step interrupted")
    }
}

#[cfg(test)]
mod interruption_report_tests {
    use super::*;

    fn prompt() -> ActivePrompt {
        ActivePrompt {
            turn_id: "turn".into(),
            text: "task".into(),
            last_agent_message: String::new(),
            agent_message_open: false,
            agent_message_overflow: false,
            known_tool_calls: HashSet::new(),
        }
    }

    #[test]
    fn existing_tool_update_keeps_split_interruption_message_together() {
        let mut active = prompt();
        for update in [
            json!({"sessionUpdate":"tool_call","toolCallId":"read"}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"Step "}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"read"}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"interrupted"}}),
        ] {
            active.observe_update(&update);
        }
        assert!(active.reports_interruption());
    }

    #[test]
    fn new_tool_or_longer_answer_does_not_report_interruption() {
        let mut active = prompt();
        for update in [
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"Step "}}),
            json!({"sessionUpdate":"tool_call_update","toolCallId":"new"}),
            json!({"sessionUpdate":"agent_message_chunk","content":{"text":"interrupted"}}),
        ] {
            active.observe_update(&update);
        }
        assert!(!active.reports_interruption());
        active.observe_update(
            &json!({"sessionUpdate":"agent_message_chunk","content":{"text":" but recovered"}}),
        );
        assert!(!active.reports_interruption());
    }

    #[test]
    fn later_tool_or_thought_closes_interruption_message() {
        for update in [
            json!({"sessionUpdate":"tool_call","toolCallId":"next"}),
            json!({"sessionUpdate":"agent_thought_chunk","content":{"text":"Continuing"}}),
        ] {
            let mut active = prompt();
            active.observe_update(
                &json!({"sessionUpdate":"agent_message_chunk","content":{"text":"Step interrupted"}}),
            );
            assert!(active.reports_interruption());
            active.observe_update(&update);
            assert!(!active.reports_interruption());
        }
    }

    #[test]
    fn cancelling_a_session_resolves_only_its_pending_permissions() {
        let mut permissions = HashMap::from([
            (
                "1".into(),
                PendingPermission {
                    message: json!({"id":1,"params":{"sessionId":"target"}}),
                    received_at: 1,
                    generation: 0,
                    fingerprint: String::new(),
                },
            ),
            (
                "2".into(),
                PendingPermission {
                    message: json!({"id":"two","params":{"sessionId":"other"}}),
                    received_at: 2,
                    generation: 0,
                    fingerprint: String::new(),
                },
            ),
            (
                "3".into(),
                PendingPermission {
                    message: json!({"id":3,"params":{"sessionId":"target"}}),
                    received_at: 3,
                    generation: 0,
                    fingerprint: String::new(),
                },
            ),
        ]);

        let mut ids = Vec::new();
        resolve_session_permissions(&mut permissions, "target", |id, _| {
            ids.push(id.clone());
            Ok(())
        })
        .expect("target permissions should resolve");
        ids.sort_by_key(Value::to_string);

        assert_eq!(ids, vec![json!(1), json!(3)]);
        assert_eq!(permissions.len(), 1);
        assert!(permissions.contains_key("2"));
    }

    #[test]
    fn failed_permission_reply_preserves_current_and_unsent_requests() {
        let mut permissions = HashMap::from([
            (
                "1".into(),
                PendingPermission {
                    message: json!({"id":1,"params":{"sessionId":"target"}}),
                    received_at: 1,
                    generation: 0,
                    fingerprint: String::new(),
                },
            ),
            (
                "2".into(),
                PendingPermission {
                    message: json!({"id":2,"params":{"sessionId":"target"}}),
                    received_at: 2,
                    generation: 0,
                    fingerprint: String::new(),
                },
            ),
        ]);

        let result = resolve_session_permissions(&mut permissions, "target", |_, _| {
            Err("write failed".into())
        });

        assert_eq!(result, Err("write failed".into()));
        assert_eq!(permissions.len(), 2);
        assert!(permissions.contains_key("1"));
        assert!(permissions.contains_key("2"));
    }

    #[test]
    fn permission_arriving_during_cancellation_is_resolved_immediately() {
        let mut state = PermissionState::default();
        state.begin_cancel("target", Some("turn-one"));
        let message = json!({"id":7,"params":{"sessionId":"target"}});
        let mut resolved = Vec::new();

        state
            .record(message, 1, Some("turn-one".into()), |id| {
                resolved.push(id.clone());
                Ok(())
            })
            .expect("late permission should resolve");

        assert_eq!(resolved, vec![json!(7)]);
        assert!(state.pending.is_empty());
    }

    #[test]
    fn cancelled_session_stays_guarded_until_reader_ack_and_new_turn() {
        let mut state = PermissionState::default();
        state.begin_cancel("target", Some("turn-one"));
        state.acknowledge_prompt_settlement("target", "turn-one", 4);
        let mut resolved = Vec::new();

        state
            .record(
                json!({"id":8,"params":{"sessionId":"target"}}),
                1,
                Some("turn-one".into()),
                |id| {
                    resolved.push(id.clone());
                    Ok(())
                },
            )
            .expect("post-response permission should resolve");

        assert_eq!(resolved, vec![json!(8)]);
        assert!(!state.begin_turn("target", 3));
        assert!(state.begin_turn("target", 4));
        assert!(state.canceling_sessions.contains_key("target"));
    }

    #[test]
    fn late_cancelled_turn_permission_does_not_attach_to_replacement_turn() {
        let mut state = PermissionState::default();
        state.begin_cancel("target", Some("turn-one"));
        state.acknowledge_prompt_settlement("target", "turn-one", 4);
        assert!(state.begin_turn("target", 4));
        let mut resolved = Vec::new();

        state
            .record(
                json!({"id":9,"params":{"sessionId":"target"}}),
                2,
                Some("turn-one".into()),
                |id| {
                    resolved.push(id.clone());
                    Ok(())
                },
            )
            .expect("late old-turn permission should resolve");
        state
            .record(
                json!({"id":10,"params":{"sessionId":"target"}}),
                3,
                Some("turn-two".into()),
                |id| {
                    resolved.push(id.clone());
                    Ok(())
                },
            )
            .expect("replacement-turn permission should remain pending");

        assert_eq!(resolved, vec![json!(9)]);
        assert!(!state.pending.contains_key("9"));
        assert!(state.pending.contains_key("10"));
    }

    #[test]
    fn permission_tool_call_identity_preserves_its_originating_turn() {
        let mut prompts = PromptState::default();
        let mut original = prompt();
        original.turn_id = "turn-one".into();
        prompts.active.insert("target".into(), original);
        prompts.observe_update(
            "target",
            &json!({"sessionUpdate":"tool_call","toolCallId":"old-tool"}),
        );
        prompts.active.remove("target");
        let mut replacement = prompt();
        replacement.turn_id = "turn-two".into();
        prompts.active.insert("target".into(), replacement);
        prompts.observe_update(
            "target",
            &json!({"sessionUpdate":"tool_call","toolCallId":"new-tool"}),
        );
        prompts.observe_update(
            "target",
            &json!({"sessionUpdate":"tool_call_update","toolCallId":"old-tool"}),
        );

        assert_eq!(
            prompts.permission_turn(
                &json!({"params":{"sessionId":"target","toolCall":{"toolCallId":"old-tool"}}})
            ),
            Some("turn-one".into())
        );
        assert_eq!(
            prompts.permission_turn(
                &json!({"params":{"sessionId":"target","toolCall":{"toolCallId":"new-tool"}}})
            ),
            Some("turn-two".into())
        );
    }

    #[test]
    fn cancelling_without_an_active_turn_does_not_poison_session_reuse() {
        let mut state = PermissionState::default();

        state.begin_cancel("target", None);

        assert!(!state.canceling_sessions.contains_key("target"));
        assert!(state.begin_turn("target", 0));
    }

    #[test]
    fn idle_cancellation_does_not_discard_an_existing_late_permission_guard() {
        let mut state = PermissionState::default();
        state.begin_cancel("target", Some("turn-one"));

        state.begin_cancel("target", None);

        assert!(state.canceling_sessions.contains_key("target"));
    }

    #[test]
    fn cancellation_adopts_a_response_already_read_for_the_same_turn() {
        let mut state = PermissionState::default();
        state.acknowledge_prompt_settlement("target", "turn-one", 4);

        state.begin_cancel("target", Some("turn-one"));

        assert!(!state.begin_turn("target", 3));
        assert!(state.begin_turn("target", 4));
    }

    #[test]
    fn null_id_cancellation_fences_permissions_after_prompt_settlement() {
        let mut prompts = PromptState::default();
        let mut original = prompt();
        original.turn_id = "turn-one".into();
        prompts.active.insert("target".into(), original);
        prompts.observe_update(
            "target",
            &json!({"sessionUpdate":"tool_call","toolCallId":"old-tool"}),
        );
        prompts.active.remove("target");
        prompts.finished.insert(
            "target".into(),
            PromptOutcome {
                status: "done",
                notify: true,
                error: None,
                turn_id: "turn-one".into(),
            },
        );
        let mut state = PermissionState::default();
        state.acknowledge_prompt_settlement("target", "turn-one", 4);
        let cancelled_turn = prompts.cancellation_turn("target", None);
        state.begin_cancel("target", cancelled_turn.as_deref());
        let permission =
            json!({"id":11,"params":{"sessionId":"target","toolCall":{"toolCallId":"old-tool"}}});
        let permission_turn = prompts.permission_turn(&permission);
        let mut resolved = Vec::new();

        state
            .record(permission, 5, permission_turn, |id| {
                resolved.push(id.clone());
                Ok(())
            })
            .expect("late permission should resolve");

        assert_eq!(cancelled_turn, Some("turn-one".into()));
        assert_eq!(resolved, vec![json!(11)]);
        assert!(state.pending.is_empty());
    }

    #[test]
    fn first_seen_replacement_permission_is_assigned_to_the_active_turn() {
        let mut state = PermissionState::default();
        state.begin_cancel("target", Some("turn-one"));
        state.acknowledge_prompt_settlement("target", "turn-one", 4);
        assert!(state.begin_turn("target", 4));
        let mut prompts = PromptState::default();
        let mut replacement = prompt();
        replacement.turn_id = "turn-two".into();
        prompts.active.insert("target".into(), replacement);
        let permission =
            json!({"id":12,"params":{"sessionId":"target","toolCall":{"toolCallId":"first-seen"}}});
        let permission_turn = prompts.permission_turn(&permission);
        let mut resolved = Vec::new();

        state
            .record(permission, 5, permission_turn.clone(), |id| {
                resolved.push(id.clone());
                Ok(())
            })
            .expect("replacement permission should remain pending");

        assert_eq!(permission_turn, Some("turn-two".into()));
        assert!(resolved.is_empty());
        assert!(state.pending.contains_key("12"));
    }

    #[test]
    fn positively_correlated_replacement_permission_remains_pending() {
        let mut state = PermissionState::default();
        state.begin_cancel("target", Some("turn-one"));
        state.acknowledge_prompt_settlement("target", "turn-one", 4);
        assert!(state.begin_turn("target", 4));
        let mut prompts = PromptState::default();
        let mut replacement = prompt();
        replacement.turn_id = "turn-two".into();
        prompts.active.insert("target".into(), replacement);
        prompts.observe_update(
            "target",
            &json!({"sessionUpdate":"tool_call","toolCallId":"replacement-tool"}),
        );
        let permission = json!({
            "id":13,
            "params":{"sessionId":"target","toolCall":{"toolCallId":"replacement-tool"}}
        });
        let permission_turn = prompts.permission_turn(&permission);
        let mut resolved = Vec::new();

        state
            .record(permission, 5, permission_turn.clone(), |id| {
                resolved.push(id.clone());
                Ok(())
            })
            .expect("correlated replacement permission should remain pending");

        assert_eq!(permission_turn, Some("turn-two".into()));
        assert!(resolved.is_empty());
        assert!(state.pending.contains_key("13"));
    }

    #[test]
    fn retired_tool_correlations_survive_active_map_rollover() {
        let mut prompts = PromptState::default();
        let mut original = prompt();
        original.turn_id = "turn-one".into();
        prompts.active.insert("target".into(), original);
        for index in 0..=PromptState::ACTIVE_TOOL_TURN_LIMIT {
            prompts.observe_update(
                "target",
                &json!({"sessionUpdate":"tool_call","toolCallId":format!("old-{index}")}),
            );
        }
        prompts.retire_turn("target", "turn-one");
        prompts.active.remove("target");
        let mut replacement = prompt();
        replacement.turn_id = "turn-two".into();
        prompts.active.insert("target".into(), replacement);

        let permission = json!({"params":{"sessionId":"target","toolCall":{"toolCallId":"old-0"}}});

        assert_eq!(
            prompts.permission_turn(&permission),
            Some("turn-one".into())
        );
    }

    #[test]
    fn prompt_failure_preserves_the_last_durable_dispatch_boundary() {
        assert_eq!(durable_prompt_status("failed", true, 0), "prepared");
        assert_eq!(
            durable_prompt_status("failed", true, 1),
            "dispatch_uncertain"
        );
        assert_eq!(durable_prompt_status("failed", true, 2), "dispatched");
        assert_eq!(durable_prompt_status("done", false, 1), "done");
    }

    #[test]
    fn prompt_response_waits_for_reader_acknowledgement() {
        let progress = Arc::new(ReaderProgress::default());
        let generation = progress.next_generation();
        let (started_sender, started_receiver) = mpsc::channel();
        let (done_sender, done_receiver) = mpsc::channel();
        let waiting = Arc::clone(&progress);
        let waiter = std::thread::spawn(move || {
            started_sender.send(()).expect("waiter should start");
            waiting
                .wait_for(generation)
                .expect("reader should acknowledge");
            done_sender.send(()).expect("waiter should finish");
        });
        started_receiver.recv().expect("waiter should be ready");

        assert!(done_receiver.try_recv().is_err());
        progress.acknowledge(generation);
        done_receiver
            .recv()
            .expect("acknowledgement should release waiter");
        waiter.join().expect("waiter should stop");
    }
}

#[derive(Clone, Serialize)]
pub struct PromptOutcome {
    status: &'static str,
    notify: bool,
    error: Option<String>,
    #[serde(rename = "turnId")]
    turn_id: String,
}

#[tauri::command]
pub fn acp_activity(
    manager: State<'_, AgentManager>,
) -> Result<HashMap<String, AgentActivity>, String> {
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    let mut activity = HashMap::<String, AgentActivity>::new();
    for runtime in agents.values() {
        let prompts = runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?;
        let directories = runtime
            .session_directories
            .lock()
            .map_err(|error| error.to_string())?;
        let permission_state = runtime
            .permission_state
            .lock()
            .map_err(|error| error.to_string())?;
        append_connection_activity(
            &mut activity,
            &runtime.agent,
            runtime.alive.load(Ordering::Acquire),
            &prompts,
            &directories,
            &permission_state.pending,
        );
    }
    Ok(activity)
}

#[tauri::command]
pub fn acp_native_subagents(
    manager: State<'_, AgentManager>,
    fence: State<'_, AgentWorktreeFence>,
    directory: String,
) -> Result<NativeSubagentSnapshotSet, String> {
    let directory = PathBuf::from(directory);
    let state = fence.0.lock().map_err(|error| error.to_string())?;
    let generation = state
        .generations
        .get(&directory)
        .copied()
        .unwrap_or_default();
    let subagents = manager.native_subagent_snapshots(&directory)?;
    Ok(NativeSubagentSnapshotSet {
        generation,
        subagents,
    })
}

#[tauri::command]
pub fn acp_pending_inbox(
    manager: State<'_, AgentManager>,
) -> Result<Vec<PendingPermissionInfo>, String> {
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    let mut pending = Vec::new();
    for runtime in agents.values() {
        if !runtime.alive.load(Ordering::Acquire) {
            continue;
        }
        for permission in runtime
            .permission_state
            .lock()
            .map_err(|error| error.to_string())?
            .pending
            .values()
        {
            pending.push(PendingPermissionInfo {
                agent: runtime.agent.clone(),
                message: permission.message.clone(),
                received_at: permission.received_at,
            });
        }
        for elicitation in runtime
            .elicitation_state
            .lock()
            .map_err(|error| error.to_string())?
            .values()
        {
            pending.push(PendingPermissionInfo {
                agent: runtime.agent.clone(),
                message: elicitation.message.clone(),
                received_at: elicitation.received_at,
            });
        }
    }
    pending.sort_by_key(|item| item.received_at);
    Ok(pending)
}

impl Drop for AgentManager {
    fn drop(&mut self) {
        if Arc::strong_count(&self.0) != 1 {
            return;
        }
        self.shutdown();
    }
}

fn find_executable(name: &str) -> Option<PathBuf> {
    let names = if cfg!(windows) {
        vec![
            format!("{name}.exe"),
            format!("{name}.cmd"),
            format!("{name}.bat"),
        ]
    } else {
        vec![name.to_string()]
    };
    let mut directories: Vec<PathBuf> = std::env::var_os("PATH")
        .map(|paths| std::env::split_paths(&paths).collect())
        .unwrap_or_default();
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        directories.extend([
            home.join(".local/bin"),
            home.join(".local/share/mise/shims"),
            home.join(".local/share/mise/installs/node/latest/bin"),
            home.join(".npm-global/bin"),
        ]);
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
    ]);
    directories
        .iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .find(|path| path.is_file())
}

fn node_major(node: &PathBuf) -> Option<u32> {
    let output = Command::new(node).arg("--version").output().ok()?;
    if !output.status.success() {
        return None;
    }
    let version = String::from_utf8(output.stdout).ok()?;
    version
        .trim()
        .trim_start_matches('v')
        .split('.')
        .next()?
        .parse()
        .ok()
}

fn definition(id: &str) -> Result<&'static AgentDefinition, String> {
    AGENTS
        .iter()
        .find(|agent| agent.id == id)
        .ok_or_else(|| "Unknown agent.".into())
}

fn parse_profile(profile: Option<&str>) -> Result<CapabilityProfile, String> {
    profile
        .map(|value| {
            CapabilityProfile::parse(value).ok_or_else(|| {
                "Unknown capability profile. Expected explore, review, build, or release."
                    .to_string()
            })
        })
        .transpose()
        .map(|profile| profile.unwrap_or(CapabilityProfile::Build))
}

fn client_capabilities(agent: &str, profile: CapabilityProfile) -> Value {
    let mut capabilities = json!({
        "fs":{"readTextFile":false,"writeTextFile":false},
        "terminal":profile.enables_terminal(),
        "subagents":{},
        "plan":{},
        "elicitation":{"form":{}}
    });
    if agent == "opencode" {
        capabilities["_meta"] = json!({OPENCODE_CHILD_UPDATES: true});
    }
    capabilities
}

const OPENCODE_CHILD_UPDATES: &str = "opencode/child-session-updates";
const OPENCODE_CHILD_UPDATE_METHOD: &str = "opencode/session/child_update";

/// Rewrites OpenCode's child-session extension notification into the `session/update`
/// shapes Claude and Codex already use, so the registry and frontend need no OpenCode branch.
fn opencode_child_update(message: &Value) -> Option<Option<Value>> {
    let method = message.get("method")?.as_str()?;
    if method.trim_start_matches('_') != OPENCODE_CHILD_UPDATE_METHOD {
        return None;
    }
    let params = message.get("params")?;
    let child = params.get("childSessionId").and_then(Value::as_str);
    let parent = params.get("parentSessionId").and_then(Value::as_str);
    let (Some(child), Some(parent)) = (child, parent) else {
        return Some(None);
    };
    let title = params
        .get("title")
        .and_then(Value::as_str)
        .filter(|title| !title.trim().is_empty());
    let wrap = |session_id: &str, update: Value| {
        Some(json!({"method":"session/update","params":{"sessionId":session_id,"update":update}}))
    };
    Some(match params.get("type").and_then(Value::as_str) {
        Some("update") => params
            .get("update")
            .filter(|update| update.is_object())
            .and_then(|update| wrap(child, update.clone())),
        Some("status") => match params.get("status").and_then(Value::as_str) {
            Some("created") => wrap(
                parent,
                json!({
                    "sessionUpdate":"subagent_spawned",
                    "subagentSessionId":child,
                    "name":title.unwrap_or("Subagent"),
                    "task":title.unwrap_or("Delegated task")
                }),
            ),
            Some(status @ ("running" | "completed" | "failed" | "interrupted")) => {
                let mut update = json!({
                    "sessionUpdate":"subagent_state_update",
                    "subagentSessionId":child,
                    "state":match status { "interrupted" => "cancelled", "running" => "working", other => other }
                });
                let reason = params
                    .pointer("/error/message")
                    .or_else(|| params.get("error"));
                if let Some(reason) = reason.and_then(Value::as_str) {
                    update["error"] = json!(reason.chars().take(500).collect::<String>());
                }
                wrap(parent, update)
            }
            _ => None,
        },
        _ => None,
    })
}

fn authorize_terminal_request_for(
    profiles: &HashMap<String, CapabilityProfile>,
    params: &Value,
) -> Result<(), String> {
    let session_id = params
        .get("sessionId")
        .and_then(Value::as_str)
        .ok_or("Terminal request requires a session ID.")?;
    let profile = profiles
        .get(session_id)
        .copied()
        .ok_or_else(|| "Unknown agent session.".to_string())?;
    if !profile.enables_terminal() {
        return Err(format!(
            "Terminal access is disabled by the {} capability profile.",
            profile.as_str()
        ));
    }
    Ok(())
}

fn authorize_terminal_request(runtime: &Connection, params: &Value) -> Result<(), String> {
    let profiles = runtime
        .session_profiles
        .lock()
        .map_err(|error| error.to_string())?;
    authorize_terminal_request_for(&profiles, params)
}

fn connection_for_profile(
    manager: &AgentManager,
    id: &str,
    profile: CapabilityProfile,
) -> Result<Arc<Connection>, String> {
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    agents
        .get(&(id.to_string(), profile))
        .filter(|runtime| runtime.alive.load(Ordering::Acquire))
        .cloned()
        .ok_or_else(|| "Agent is not connected.".into())
}

fn unique_session_owner(
    profiles: impl IntoIterator<Item = CapabilityProfile>,
) -> Result<Option<CapabilityProfile>, String> {
    let mut owner = None;
    for profile in profiles {
        if owner.is_some_and(|current| current != profile) {
            return Err(
                "Agent session is connected under multiple capability profiles.".to_string(),
            );
        }
        owner = Some(profile);
    }
    Ok(owner)
}

fn connection_for_session(
    manager: &AgentManager,
    id: &str,
    session_id: &str,
) -> Result<Arc<Connection>, String> {
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    let matches = agents
        .values()
        .filter(|runtime| {
            runtime.agent == id
                && runtime.alive.load(Ordering::Acquire)
                && runtime
                    .session_profiles
                    .lock()
                    .is_ok_and(|profiles| profiles.contains_key(session_id))
        })
        .collect::<Vec<_>>();
    unique_session_owner(matches.iter().map(|runtime| runtime.profile))?;
    matches
        .first()
        .cloned()
        .cloned()
        .ok_or_else(|| "Agent session is not connected.".to_string())
}

fn register_session(
    manager: &AgentManager,
    agent: &str,
    profile: CapabilityProfile,
    session_id: &str,
    directory: PathBuf,
) -> Result<Arc<Connection>, String> {
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    let mut owners = Vec::new();
    for runtime in agents
        .values()
        .filter(|runtime| runtime.agent == agent && runtime.alive.load(Ordering::Acquire))
    {
        if runtime
            .session_profiles
            .lock()
            .map_err(|error| error.to_string())?
            .contains_key(session_id)
        {
            owners.push(runtime.profile);
        }
    }
    if let Some(owner) = unique_session_owner(owners)? {
        if owner != profile {
            return Err(format!(
                "Agent session is already connected under the {} capability profile.",
                owner.as_str()
            ));
        }
    }
    let runtime = agents
        .get(&(agent.to_string(), profile))
        .filter(|runtime| runtime.alive.load(Ordering::Acquire))
        .cloned()
        .ok_or_else(|| "Agent is not connected.".to_string())?;
    runtime
        .session_directories
        .lock()
        .map_err(|error| error.to_string())?
        .insert(session_id.to_string(), directory);
    runtime
        .session_profiles
        .lock()
        .map_err(|error| error.to_string())?
        .insert(session_id.to_string(), profile);
    Ok(runtime)
}

#[tauri::command]
pub async fn acp_agents(app: AppHandle) -> Result<Vec<AgentAvailability>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        agent_availability(
            crate::settings::string_setting(&app, OPENCODE_BINARY_SETTING),
            |_| true,
        )
    })
    .await
    .map_err(|error| error.to_string())
}

fn agent_availability(
    opencode_binary: Result<Option<String>, String>,
    keep: impl Fn(&str) -> bool,
) -> Vec<AgentAvailability> {
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("SAIL_ACP_TEST_AGENT") {
        return AGENTS
            .iter()
            .filter(|agent| keep(agent.id))
            .map(|agent| AgentAvailability {
                id: agent.id.into(),
                name: agent.name.into(),
                binary_path: Some(PathBuf::from(&path).to_string_lossy().into_owned()),
                available: true,
                reason: None,
            })
            .collect();
    }
    let npx = find_executable("npx");
    let node = find_executable("node");
    let major = node.as_ref().and_then(node_major);
    AGENTS
        .iter()
        .filter(|agent| keep(agent.id))
        .map(|agent| match agent.launch {
            Launch::OpenCode => match opencode_binary.clone().and_then(crate::resolve_binary) {
                Ok(binary) => AgentAvailability {
                    id: agent.id.into(),
                    name: agent.name.into(),
                    binary_path: Some(binary.to_string_lossy().into_owned()),
                    available: true,
                    reason: None,
                },
                Err(reason) => AgentAvailability {
                    id: agent.id.into(),
                    name: agent.name.into(),
                    binary_path: None,
                    available: false,
                    reason: Some(reason),
                },
            },
            Launch::Npx { min_node_major, .. } => {
                let binary = find_executable(agent.executable);
                AgentAvailability {
                    id: agent.id.into(),
                    name: agent.name.into(),
                    binary_path: binary
                        .as_ref()
                        .map(|path| path.to_string_lossy().into_owned()),
                    available: binary.is_some()
                        && npx.is_some()
                        && major.is_some_and(|version| version >= min_node_major),
                    reason: if binary.is_none() {
                        Some(format!("Install {} first.", agent.name))
                    } else if npx.is_none() || node.is_none() {
                        Some("Node.js and npx are required for the ACP adapter.".into())
                    } else if major.is_none_or(|version| version < min_node_major) {
                        Some(format!(
                            "{} requires Node.js {} or newer.",
                            agent.name, min_node_major
                        ))
                    } else {
                        None
                    },
                }
            }
        })
        .collect()
}

#[tauri::command]
pub async fn acp_connect(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
    profile: Option<String>,
) -> Result<Value, String> {
    let profile = parse_profile(profile.as_deref())?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connect_blocking(app, &manager, agent, profile))
        .await
        .map_err(|error| error.to_string())?
}

fn agent_availability_for(app: &AppHandle, agent: &str) -> Result<AgentAvailability, String> {
    let availability = agent_availability(
        crate::settings::string_setting(app, OPENCODE_BINARY_SETTING),
        |id| id == agent,
    )
    .into_iter()
    .next()
    .ok_or("Unknown agent.")?;
    if availability.available {
        Ok(availability)
    } else {
        Err(availability
            .reason
            .unwrap_or_else(|| "Agent unavailable.".into()))
    }
}

fn connect_blocking(
    app: AppHandle,
    manager: &AgentManager,
    agent: String,
    profile: CapabilityProfile,
) -> Result<Value, String> {
    let definition = definition(&agent)?;
    let live = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&(agent.clone(), profile))
        .is_some_and(|existing| existing.alive.load(Ordering::Acquire));
    // Probe before taking the agent lock; a live connection needs no availability check.
    let mut availability = if live {
        None
    } else {
        Some(agent_availability_for(&app, &agent)?)
    };
    let mut agents = manager.0.lock().map_err(|error| error.to_string())?;
    let key = (agent.clone(), profile);
    if let Some(existing) = agents.get(&key) {
        if existing.alive.load(Ordering::Acquire) {
            let existing = Arc::clone(existing);
            drop(agents);
            let deadline = Instant::now() + Duration::from_secs(60);
            let mut capabilities = existing
                .capabilities
                .lock()
                .map_err(|error| error.to_string())?;
            while capabilities.is_null() && existing.alive.load(Ordering::Acquire) {
                let remaining = deadline.saturating_duration_since(Instant::now());
                if remaining.is_zero() {
                    return Err("Agent initialization timed out.".into());
                }
                let (next, _) = existing
                    .ready
                    .wait_timeout(capabilities, remaining)
                    .map_err(|error| error.to_string())?;
                capabilities = next;
            }
            return if capabilities.is_null() {
                Err("Agent process stopped during initialization.".into())
            } else {
                Ok(capabilities.clone())
            };
        }
    }
    let availability = match availability.take() {
        Some(availability) => availability,
        None => agent_availability_for(&app, &agent)?,
    };
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    #[cfg(feature = "e2e")]
    let test_agent = std::env::var_os("SAIL_ACP_TEST_AGENT");
    #[cfg(not(feature = "e2e"))]
    let test_agent: Option<std::ffi::OsString> = None;
    let mut paths = Vec::new();
    let mut command = if let Some(path) = test_agent {
        let node = find_executable("node").ok_or("Node.js not found.")?;
        paths.push(node.parent().ok_or("Invalid Node.js path.")?.to_path_buf());
        let mut command = Command::new(&node);
        command.arg(path).arg(&agent);
        command
    } else {
        match definition.launch {
            Launch::Npx { package, .. } => {
                let node = find_executable("node").ok_or("Node.js not found.")?;
                paths.push(node.parent().ok_or("Invalid Node.js path.")?.to_path_buf());
                let npx = find_executable("npx").ok_or("npx not found.")?;
                let mut command = Command::new(npx);
                command.args(["--yes", package]);
                command
            }
            Launch::OpenCode => {
                let binary = availability
                    .binary_path
                    .clone()
                    .ok_or("OpenCode binary not found.")?;
                let mut command = Command::new(binary);
                command.arg("acp");
                command.env_remove("OPENCODE_CONFIG_DIR");
                command
            }
        }
    };
    paths.extend(std::env::split_paths(&original_path));
    command.env(
        "PATH",
        std::env::join_paths(paths).map_err(|error| error.to_string())?,
    );
    if let Some(connection_file) = crate::hook_activity::connection_file(
        app.state::<crate::hook_activity::HookActivityManager>()
            .inner(),
    ) {
        command.env("SAIL_HOOK_CONNECTION_FILE", connection_file);
    }
    if let (Some(name), Some(binary)) = (definition.binary_env, availability.binary_path) {
        command.env(name, binary);
    }
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Could not start {}: {error}", definition.name))?;
    #[cfg(unix)]
    let watchdog = crate::child_watchdog::ChildWatchdog::start(child.id()).map_err(|error| {
        stop_process(&mut child);
        format!("Could not start {} watchdog: {error}", definition.name)
    })?;
    let input = child.stdin.take().ok_or("Agent stdin unavailable.")?;
    let output = child.stdout.take().ok_or("Agent stdout unavailable.")?;
    if let Some(stderr) = child.stderr.take() {
        let stderr_agent = agent.clone();
        let stderr_app = app.clone();
        std::thread::spawn(move || {
            crate::stderr_log::forward(
                stderr,
                &stderr_agent,
                || {
                    stderr_app
                        .state::<crate::browser_agent::BrowserManager>()
                        .active_tokens()
                },
                crate::diagnostics::record,
            );
        });
    }
    let runtime = Arc::new(Connection {
        agent: agent.clone(),
        profile,
        child: Mutex::new(child),
        #[cfg(unix)]
        watchdog: Mutex::new(watchdog),
        stopped: AtomicBool::new(false),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
        reader_progress: ReaderProgress::default(),
        permission_state: Mutex::new(PermissionState::default()),
        elicitation_state: Mutex::new(HashMap::new()),
        next_permission_generation: AtomicU64::new(1),
        prompt_state: Mutex::new(PromptState::default()),
        cancelled_prompts: Mutex::new(HashSet::new()),
        next_id: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        capabilities: Mutex::new(Value::Null),
        session_directories: Mutex::new(HashMap::new()),
        session_configs: Mutex::new(HashMap::new()),
        native_subagents: Mutex::new(NativeSubagentRegistry::default()),
        session_profiles: Mutex::new(HashMap::new()),
        pending_directory: Mutex::new(None),
        session_creation: Mutex::new(()),
        ready: Condvar::new(),
    });
    let reader = Arc::clone(&runtime);
    let reader_manager = manager.clone();
    let agent_id = agent.clone();
    let worktree_fence = app.state::<AgentWorktreeFence>().inner().clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            let Ok(mut message) = serde_json::from_str::<Value>(&line) else {
                crate::diagnostics::record(
                    "acp_invalid_json",
                    json!({"agent":agent_id,"bytes":line.len()}),
                );
                continue;
            };
            if let Some(translated) = opencode_child_update(&message) {
                let Some(translated) = translated else {
                    continue;
                };
                message = translated;
            }
            if message.get("method").is_some() {
                if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
                    params.insert("sailCapabilityProfile".into(), profile.as_str().into());
                }
            }
            if let Some(update) = message.pointer("/params/update") {
                if let Some(session_id) =
                    message.pointer("/params/sessionId").and_then(Value::as_str)
                {
                    if let Ok(mut prompts) = reader.prompt_state.lock() {
                        prompts.observe_update(session_id, update);
                    }
                }
                if update.get("sessionUpdate").and_then(Value::as_str) == Some("subagent_spawned") {
                    let parent_id = message.pointer("/params/sessionId").and_then(Value::as_str);
                    let child_id = update.get("subagentSessionId").and_then(Value::as_str);
                    if let (Some(parent_id), Some(child_id)) = (parent_id, child_id) {
                        if parent_id != child_id {
                            let directory = reader
                                .session_directories
                                .lock()
                                .ok()
                                .and_then(|directories| directories.get(parent_id).cloned());
                            if let Some(directory) = directory {
                                match register_session(
                                    &reader_manager,
                                    &agent_id,
                                    profile,
                                    child_id,
                                    directory.clone(),
                                ) {
                                    Ok(owner) => {
                                        if let (Ok(mut fence), Ok(mut native)) =
                                            (worktree_fence.0.lock(), owner.native_subagents.lock())
                                        {
                                            native.spawn(parent_id, child_id, directory.clone());
                                            let generation =
                                                fence.generations.entry(directory).or_default();
                                            *generation = generation.saturating_add(1);
                                        }
                                    }
                                    Err(error) => crate::diagnostics::record(
                                        "acp_subagent_session_conflict",
                                        json!({"agent":agent_id,"sessionId":child_id,"error":error}),
                                    ),
                                }
                            }
                        }
                    } else {
                        crate::diagnostics::record(
                            "acp_invalid_subagent_update",
                            json!({"agent":agent_id,"parentSessionId":parent_id}),
                        );
                    }
                }
                if update.get("sessionUpdate").and_then(Value::as_str)
                    == Some("subagent_state_update")
                {
                    let child_id = update.get("subagentSessionId").and_then(Value::as_str);
                    let outcome = update.get("state").and_then(Value::as_str);
                    if let (Some(child_id), Some(outcome)) = (child_id, outcome) {
                        if let Ok(mut fence) = worktree_fence.0.lock() {
                            let directory = reader
                                .session_directories
                                .lock()
                                .ok()
                                .and_then(|directories| directories.get(child_id).cloned());
                            if let (Some(directory), Ok(mut native)) =
                                (directory, reader.native_subagents.lock())
                            {
                                native.update(child_id, outcome);
                                let generation = fence.generations.entry(directory).or_default();
                                *generation = generation.saturating_add(1);
                            }
                        }
                    }
                }
                if matches!(
                    update.get("sessionUpdate").and_then(Value::as_str),
                    Some("tool_call_update")
                ) {
                    let status = update.get("status").and_then(Value::as_str);
                    if matches!(status, Some("completed" | "failed")) {
                        crate::diagnostics::record(
                            "acp_tool_finished",
                            json!({
                                "agent":agent_id,
                                "sessionId":message.pointer("/params/sessionId").and_then(Value::as_str),
                                "toolCallId":update.get("toolCallId").and_then(Value::as_str),
                                "status":status
                            }),
                        );
                    }
                }
            }
            if message.get("method").is_some() {
                if let Some(method) = message.get("method").and_then(Value::as_str) {
                    if method.starts_with("terminal/") {
                        if let Some(id) = message.get("id").cloned() {
                            let runtime = Arc::clone(&reader);
                            let app = app.clone();
                            let agent = agent_id.clone();
                            let method = method.to_string();
                            let params = message.get("params").cloned().unwrap_or(Value::Null);
                            std::thread::spawn(move || {
                                if let Err(error) = authorize_terminal_request(&runtime, &params) {
                                    let _ = runtime.write(&json!({
                                        "jsonrpc":"2.0","id":id,
                                        "error":{"code":-32000,"message":error}
                                    }));
                                    return;
                                }
                                let directory = params
                                    .get("sessionId")
                                    .and_then(Value::as_str)
                                    .and_then(|session_id| {
                                        runtime
                                            .session_directories
                                            .lock()
                                            .ok()?
                                            .get(session_id)
                                            .cloned()
                                    })
                                    .or_else(|| runtime.pending_directory.lock().ok()?.clone());
                                let manager =
                                    app.state::<crate::acp_terminal::AcpTerminalManager>();
                                let response = match crate::acp_terminal::handle(
                                    &app,
                                    &manager,
                                    &agent,
                                    runtime.profile,
                                    &method,
                                    params,
                                    directory,
                                ) {
                                    Ok(result) => json!({"jsonrpc":"2.0","id":id,"result":result}),
                                    Err(error) => {
                                        json!({"jsonrpc":"2.0","id":id,"error":{"code":-32000,"message":error}})
                                    }
                                };
                                let _ = runtime.write(&response);
                            });
                        }
                        continue;
                    }
                }
                if message.get("method").and_then(Value::as_str) == Some("$/cancel_request") {
                    if let Some(id) = message.pointer("/params/id") {
                        if let Ok(mut elicitations) = reader.elicitation_state.lock() {
                            elicitations.remove(&id.to_string());
                        }
                    }
                }
                if message.get("method").and_then(Value::as_str) == Some("elicitation/create") {
                    if let Some(id) = message.get("id").cloned() {
                        let received_at = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        if let Ok(mut elicitations) = reader.elicitation_state.lock() {
                            elicitations.insert(
                                id.to_string(),
                                PendingElicitation {
                                    message: message.clone(),
                                    received_at,
                                },
                            );
                        }
                    }
                }
                if message.get("method").and_then(Value::as_str)
                    == Some("session/request_permission")
                {
                    let generation = reader
                        .next_permission_generation
                        .fetch_add(1, Ordering::Relaxed);
                    let fingerprint = uuid::Uuid::new_v4().to_string();
                    if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
                        params.insert("sailPermissionGeneration".into(), generation.into());
                        params.insert(
                            "sailPermissionFingerprint".into(),
                            fingerprint.clone().into(),
                        );
                    }
                    let turn_id = reader
                        .prompt_state
                        .lock()
                        .ok()
                        .and_then(|mut prompts| prompts.permission_turn(&message));
                    if let Ok(mut state) = reader.permission_state.lock() {
                        let received_at = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .unwrap_or_default()
                            .as_millis() as u64;
                        let session_id = message
                            .pointer("/params/sessionId")
                            .and_then(Value::as_str)
                            .unwrap_or_default()
                            .to_string();
                        let event_fingerprint = fingerprint.clone();
                        let _ = state.record(message.clone(), received_at, turn_id, |request_id| {
                            reader.write(&json!({
                                "jsonrpc":"2.0",
                                "id":request_id,
                                "result":{"outcome":{"outcome":"cancelled"}}
                            }))?;
                            let _ = app.emit(
                                "acp-event",
                                AgentEvent {
                                    agent: agent_id.clone(),
                                    message: json!({"method":"sail/permission_resolved","params":{
                                        "sessionId":session_id,"requestId":request_id,
                                        "sailPermissionGeneration":generation,
                                        "sailPermissionFingerprint":event_fingerprint,
                                        "sailPermissionOutcome":"cancelled"
                                    }}),
                                },
                            );
                            Ok(())
                        });
                    }
                }
                let _ = app.emit(
                    "acp-event",
                    AgentEvent {
                        agent: agent_id.clone(),
                        message,
                    },
                );
            } else if let Some(id) = message.get("id").and_then(Value::as_u64) {
                if let Some(sender) = reader
                    .pending
                    .lock()
                    .ok()
                    .and_then(|mut map| map.remove(&id))
                {
                    let generation = reader.reader_progress.next_generation();
                    let _ = sender.send(PendingResponse {
                        message,
                        generation,
                    });
                    reader.reader_progress.acknowledge(generation);
                }
            }
        }
        reader.alive.store(false, Ordering::Release);
        if let Ok(mut configs) = reader.session_configs.lock() {
            let browser = app.state::<crate::browser_agent::BrowserManager>();
            for (_, config) in configs.drain() {
                browser.release(&config.token);
            }
        }
        let mut session_ids = reader
            .session_profiles
            .lock()
            .map(|profiles| profiles.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        session_ids.sort();
        crate::diagnostics::record(
            "agent_disconnected",
            json!({"agent":agent_id,"profile":profile.as_str(),"sessionIds":session_ids}),
        );
        app.state::<crate::acp_terminal::AcpTerminalManager>()
            .stop_sessions(&agent_id, profile, &session_ids);
        reader.ready.notify_all();
        if let Ok(mut state) = reader.permission_state.lock() {
            state.pending.clear();
            state.canceling_sessions.clear();
        }
        if let Ok(mut pending) = reader.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(PendingResponse {
                    message: json!({"error":{"message":"Agent process exited."}}),
                    generation: 0,
                });
            }
        }
        let _ = app.emit(
            "acp-event",
            AgentEvent {
                agent: agent_id,
                message: json!({"method":"sail/disconnected","params":{
                    "profile":profile.as_str(),"sessionIds":session_ids
                }}),
            },
        );
    });
    agents.insert(key, Arc::clone(&runtime));
    drop(agents);
    let result = runtime
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": client_capabilities(&runtime.agent, profile),
                "clientInfo":{"name":"sail","title":"Sail","version":"0.1.0"}
            }),
            Duration::from_secs(60),
        )
        .inspect_err(|_| {
            runtime.terminate();
        })?;
    if result.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        runtime.terminate();
        return Err("Agent does not support ACP v1.".into());
    }
    *runtime
        .capabilities
        .lock()
        .map_err(|error| error.to_string())? = result.clone();
    runtime.ready.notify_all();
    Ok(result)
}

#[tauri::command]
pub fn acp_pending_permissions(
    manager: State<'_, AgentManager>,
    agent: String,
    session_id: String,
) -> Result<Vec<Value>, String> {
    let runtime = connection_for_session(&manager, &agent, &session_id)?;
    let permissions = runtime
        .permission_state
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(permissions
        .pending
        .values()
        .filter(|pending| {
            pending
                .message
                .pointer("/params/sessionId")
                .and_then(Value::as_str)
                == Some(session_id.as_str())
        })
        .map(|pending| pending.message.clone())
        .collect())
}

#[tauri::command]
pub fn acp_pending_elicitations(
    manager: State<'_, AgentManager>,
    agent: String,
    session_id: String,
) -> Result<Vec<Value>, String> {
    let runtime = connection_for_session(&manager, &agent, &session_id)?;
    let pending = runtime
        .elicitation_state
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(pending
        .values()
        .filter(|request| {
            request
                .message
                .pointer("/params/sessionId")
                .and_then(Value::as_str)
                == Some(session_id.as_str())
        })
        .map(|request| request.message.clone())
        .collect())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpElicitationParams {
    agent: String,
    request_id: Value,
    action: String,
    content: Option<Value>,
}

#[tauri::command]
pub fn acp_elicitation(
    manager: State<'_, AgentManager>,
    params: AcpElicitationParams,
) -> Result<(), String> {
    let runtime = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .find(|runtime| runtime.agent == params.agent)
        .cloned()
        .ok_or_else(|| "Agent is not connected.".to_string())?;
    let key = params.request_id.to_string();
    let pending = runtime
        .elicitation_state
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&key)
        .ok_or_else(|| "Elicitation request is no longer pending.".to_string())?;
    let mut result = json!({"action":params.action});
    if let Some(content) = params.content {
        result["content"] = content;
    }
    if let Err(error) =
        runtime.write(&json!({"jsonrpc":"2.0","id":params.request_id,"result":result}))
    {
        runtime
            .elicitation_state
            .lock()
            .map_err(|cause| cause.to_string())?
            .insert(key, pending);
        return Err(error);
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpNewSessionParams {
    agent: String,
    cwd: String,
    native_generation: Option<u64>,
    profile: Option<String>,
}

#[tauri::command]
pub async fn acp_new_session(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    fence: State<'_, AgentWorktreeFence>,
    params: AcpNewSessionParams,
) -> Result<Value, String> {
    let AcpNewSessionParams {
        agent,
        cwd,
        native_generation,
        profile,
    } = params;
    if !PathBuf::from(&cwd).is_dir() {
        return Err("Repository directory does not exist.".into());
    }
    let profile = parse_profile(profile.as_deref())?;
    let manager = manager.inner().clone();
    let browser = browser.inner().clone();
    let fence = fence.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        connect_blocking(app.clone(), &manager, agent.clone(), profile)?;
        let runtime = connection_for_profile(&manager, &agent, profile)?;
        let config =
            browser.config_for_profile(&cwd, None, Some(&agent), Some(profile.as_str()))?;
        // Memory is optional. A settings, path, or executable error must not block the session.
        let memory = optional_memory_server(crate::memory::acp_mcp_server(&app, &cwd, &agent));
        let servers = session_servers(mcp_server(&config), memory);
        let _serial = runtime
            .session_creation
            .lock()
            .map_err(|error| error.to_string())?;
        let directory = PathBuf::from(&cwd);
        fence.begin_session(&directory, native_generation)?;
        *runtime
            .pending_directory
            .lock()
            .map_err(|error| error.to_string())? = Some(PathBuf::from(&cwd));
        let result = runtime.request(
            "session/new",
            session_request_params(&cwd, None, &servers),
            Duration::from_secs(60),
        );
        *runtime
            .pending_directory
            .lock()
            .map_err(|error| error.to_string())? = None;
        let result = match result {
            Ok(result) => result,
            Err(error) => {
                browser.release(&config.token);
                let _ = fence.finish_session(&directory, native_generation);
                return Err(error);
            }
        };
        let Some(id) = result.get("sessionId").and_then(Value::as_str) else {
            browser.release(&config.token);
            let _ = fence.finish_session(&directory, native_generation);
            return Err("Agent did not return a session ID.".into());
        };
        if !per_load_mcp() {
            let mut configs = runtime
                .session_configs
                .lock()
                .map_err(|error| error.to_string())?;
            // The reader drains this map when it exits, so a config stored for a stopped agent
            // would keep its token for the life of the process.
            if runtime.alive.load(Ordering::Acquire) {
                let previous = configs.insert(
                    id.to_string(),
                    SessionConfig {
                        cwd: cwd.clone(),
                        directory: canonical_directory(&cwd),
                        servers,
                        token: config.token.clone(),
                    },
                );
                if let Some(previous) = previous {
                    browser.release(&previous.token);
                }
            } else {
                browser.release(&config.token);
            }
        }
        if let Err(error) = register_session(&manager, &agent, profile, id, directory.clone()) {
            let _ = fence.finish_session(&directory, native_generation);
            return Err(error);
        }
        let fence_result = if let Some(generation) = native_generation {
            fence.arm_session(&agent, id, &directory, generation)
        } else {
            fence.finish_session(&directory, None)
        };
        if let Err(error) = fence_result {
            if let Ok(mut directories) = runtime.session_directories.lock() {
                directories.remove(id);
            }
            if let Ok(mut profiles) = runtime.session_profiles.lock() {
                profiles.remove(id);
            }
            let _ = fence.release_session(&agent, id);
            return Err(error);
        }
        browser.identify(&config.token, id);
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn acp_release_session_fence(
    fence: State<'_, AgentWorktreeFence>,
    agent: String,
    session_id: String,
) -> Result<(), String> {
    fence.release_session(&agent, &session_id)
}

/// Releases the browser token a deleted thread's session still holds.
#[tauri::command]
pub fn acp_forget_session(
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    session_id: String,
) -> Result<(), String> {
    for profile in [
        CapabilityProfile::Explore,
        CapabilityProfile::Review,
        CapabilityProfile::Build,
        CapabilityProfile::Release,
    ] {
        let Ok(runtime) = connection_for_profile(&manager, &agent, profile) else {
            continue;
        };
        let removed = runtime
            .session_configs
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&session_id);
        if let Some(config) = removed {
            browser.release(&config.token);
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_load_session(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    cwd: String,
    session_id: String,
    profile: Option<String>,
) -> Result<Value, String> {
    restore_session(
        manager,
        app,
        browser,
        RestoreSessionParams {
            agent,
            cwd,
            session_id,
            profile,
            method: "session/load",
        },
    )
    .await
}

#[tauri::command]
pub async fn acp_resume_session(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    cwd: String,
    session_id: String,
    profile: Option<String>,
) -> Result<Value, String> {
    restore_session(
        manager,
        app,
        browser,
        RestoreSessionParams {
            agent,
            cwd,
            session_id,
            profile,
            method: "session/resume",
        },
    )
    .await
}

/// One page of the agent's own session history for a working directory.
#[tauri::command]
pub async fn acp_list_sessions(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
    cwd: String,
    cursor: Option<String>,
    profile: Option<String>,
) -> Result<Value, String> {
    let profile = parse_profile(profile.as_deref())?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let capabilities = connect_blocking(app, &manager, agent.clone(), profile)?;
        if capabilities
            .pointer("/agentCapabilities/sessionCapabilities/list")
            .is_none()
        {
            return Ok(json!({"sessions": []}));
        }
        let runtime = connection_for_profile(&manager, &agent, profile)?;
        let mut params = json!({"cwd": cwd});
        if let Some(cursor) = cursor {
            params["cursor"] = json!(cursor);
        }
        runtime.request("session/list", params, Duration::from_secs(30))
    })
    .await
    .map_err(|error| error.to_string())?
}

struct RestoreSessionParams {
    agent: String,
    cwd: String,
    session_id: String,
    profile: Option<String>,
    method: &'static str,
}

async fn restore_session(
    manager: State<'_, AgentManager>,
    app: AppHandle,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    params: RestoreSessionParams,
) -> Result<Value, String> {
    let RestoreSessionParams {
        agent,
        cwd,
        session_id,
        profile,
        method,
    } = params;
    let profile = parse_profile(profile.as_deref())?;
    let manager = manager.inner().clone();
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        connect_blocking(app.clone(), &manager, agent.clone(), profile)?;
        let runtime =
            register_session(&manager, &agent, profile, &session_id, PathBuf::from(&cwd))?;
        // A broken or unavailable memory store must not prevent restoring the agent session.
        let memory = optional_memory_server(crate::memory::acp_mcp_server(&app, &cwd, &agent));
        let params = {
            let mut configs = runtime
                .session_configs
                .lock()
                .map_err(|error| error.to_string())?;
            // The reader drains this map when it exits, so minting for a stopped agent would
            // leak the token.
            if !runtime.alive.load(Ordering::Acquire) {
                return Err("Agent process stopped. Reopen the thread to reconnect.".to_string());
            }
            restore_params(
                per_load_mcp(),
                &mut configs,
                &session_id,
                &cwd,
                memory,
                || {
                    browser.config_for_profile(
                        &cwd,
                        Some(&session_id),
                        Some(&agent),
                        Some(profile.as_str()),
                    )
                },
                |token| browser.release(token),
            )?
        };
        let result = runtime.request(method, params, Duration::from_secs(60));
        if result.is_err() {
            runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&session_id);
            runtime
                .session_profiles
                .lock()
                .map_err(|error| error.to_string())?
                .remove(&session_id);
        }
        let result = result?;
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn prompt_content(
    captures: &crate::browser::CaptureStore,
    text: &str,
    image_paths: Vec<String>,
) -> Result<Vec<Value>, String> {
    if image_paths.len() > 4 {
        return Err("Too many prompt images".to_string());
    }
    let mut content = vec![json!({"type":"text","text":text})];
    let mut total_image_bytes = 0;
    for path in image_paths {
        let bytes = captures.read(&path)?;
        if bytes.len() > 4 * 1024 * 1024 || !bytes.starts_with(b"\x89PNG\r\n\x1a\n") {
            return Err("Invalid prompt image".to_string());
        }
        total_image_bytes += bytes.len();
        if total_image_bytes > 8 * 1024 * 1024 {
            return Err("Prompt images exceed 8 MiB".to_string());
        }
        content.push(json!({
            "type":"image",
            "data":base64::Engine::encode(&base64::engine::general_purpose::STANDARD, bytes),
            "mimeType":"image/png"
        }));
    }
    Ok(content)
}

async fn prepare_prompt_content(
    app: &AppHandle,
    text: &str,
    image_paths: Vec<String>,
) -> Result<Vec<Value>, String> {
    let app = app.clone();
    let text = text.to_string();
    tauri::async_runtime::spawn_blocking(move || {
        prompt_content(
            &app.state::<crate::browser::CaptureStore>(),
            &text,
            image_paths,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPromptParams {
    agent: String,
    session_id: String,
    text: String,
    turn_id: String,
    image_paths: Vec<String>,
}

#[tauri::command]
pub async fn acp_prompt(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    params: AcpPromptParams,
) -> Result<Value, String> {
    let AcpPromptParams {
        agent,
        session_id,
        text,
        turn_id,
        image_paths,
    } = params;
    let content = prepare_prompt_content(&app, &text, image_paths).await?;
    let runtime = connection_for_session(&manager, &agent, &session_id)?;
    {
        let mut prompts = runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?;
        if prompts.active.contains_key(&session_id) {
            return Err("This agent thread already has an active turn.".to_string());
        }
        let processed_generation = runtime.reader_progress.processed()?;
        if !runtime
            .permission_state
            .lock()
            .map_err(|error| error.to_string())?
            .begin_turn(&session_id, processed_generation)
        {
            return Err("The previous cancelled turn is still settling.".into());
        }
        prompts.finished.remove(&session_id);
        prompts.active.insert(
            session_id.clone(),
            ActivePrompt {
                turn_id: turn_id.clone(),
                text: text.clone(),
                last_agent_message: String::new(),
                agent_message_open: false,
                agent_message_overflow: false,
                known_tool_calls: HashSet::new(),
            },
        );
    }
    if let Err(error) = crate::settings::record_acp_turn_evidence(
        &app,
        crate::settings::AcpTurnEvidence {
            agent: agent.clone(),
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            status: "prepared".into(),
            error: None,
            updated_at: 0,
        },
    ) {
        if let Ok(mut prompts) = runtime.prompt_state.lock() {
            if prompts
                .active
                .get(&session_id)
                .is_some_and(|prompt| prompt.turn_id == turn_id)
            {
                prompts.active.remove(&session_id);
            }
        }
        return Err(format!(
            "Cannot persist prompt dispatch intent before sending: {error}"
        ));
    }
    crate::diagnostics::record(
        "prompt_started",
        json!({
            "agent":agent,"sessionId":session_id,"turnId":turn_id
        }),
    );
    let dispatch_fence = app.state::<AgentWorktreeFence>().inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let evidence_app = app.clone();
        let evidence_agent = agent.clone();
        let evidence_session = session_id.clone();
        let evidence_turn = turn_id.clone();
        let dispatch_phase = Arc::new(AtomicU8::new(0));
        let uncertain_phase = Arc::clone(&dispatch_phase);
        let dispatched_phase = Arc::clone(&dispatch_phase);
        let uncertain_app = app.clone();
        let uncertain_agent = agent.clone();
        let uncertain_session = session_id.clone();
        let uncertain_turn = turn_id.clone();
        let dispatch_agent = agent.clone();
        let dispatch_session = session_id.clone();
        let writer = Arc::clone(&runtime);
        let response = runtime.request_response_around_write(
            "session/prompt",
            json!({
                "sessionId":session_id,"prompt":content
            }),
            Duration::from_secs(60 * 60 * 3),
            move |message| {
                dispatch_fence.dispatch_session(&dispatch_agent, &dispatch_session, || {
                    crate::settings::record_acp_turn_evidence(
                        &uncertain_app,
                        crate::settings::AcpTurnEvidence {
                            agent: uncertain_agent,
                            session_id: uncertain_session,
                            turn_id: uncertain_turn,
                            status: "dispatch_uncertain".into(),
                            error: None,
                            updated_at: 0,
                        },
                    )
                    .map_err(|error| {
                        format!(
                            "Cannot persist uncertain prompt dispatch before sending: {error}"
                        )
                    })?;
                    uncertain_phase.store(1, Ordering::Release);
                    writer.write(message)
                })
            },
            move || {
                match crate::settings::record_acp_turn_evidence(
                    &evidence_app,
                    crate::settings::AcpTurnEvidence {
                        agent: evidence_agent.clone(),
                        session_id: evidence_session.clone(),
                        turn_id: evidence_turn.clone(),
                        status: "dispatched".into(),
                        error: None,
                        updated_at: 0,
                    },
                ) {
                    Ok(()) => dispatched_phase.store(2, Ordering::Release),
                    Err(error) => crate::diagnostics::record(
                        "acp_turn_evidence_failed",
                        json!({"agent":evidence_agent,"sessionId":evidence_session,
                            "turnId":evidence_turn,"error":error}),
                    ),
                }
            },
        );
        let settlement_generation = response.as_ref().ok().map(|response| response.generation);
        let mut result = response.and_then(|response| {
            if let Some(error) = response.message.get("error") {
                return Err(error
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("Agent request failed.")
                    .to_string());
            }
            Ok(response
                .message
                .get("result")
                .cloned()
                .unwrap_or(Value::Null))
        });
        if let Some(generation) = settlement_generation {
            if let Ok(mut state) = runtime.permission_state.lock() {
                state.acknowledge_prompt_settlement(&session_id, &turn_id, generation);
            }
        }
        let explicitly_cancelled = runtime
            .cancelled_prompts
            .lock()
            .map(|mut cancelled| cancelled.remove(&turn_id))
            .unwrap_or(false);
        let cancelled_result = result
            .as_ref()
            .ok()
            .and_then(|value| value.get("stopReason"))
            .and_then(Value::as_str)
            == Some("cancelled");
        let reported_interruption = runtime
            .prompt_state
            .lock()
            .ok()
            .and_then(|prompts| {
                prompts
                    .active
                    .get(&session_id)
                    .map(ActivePrompt::reports_interruption)
            })
            .unwrap_or(false);
        let reported_error_interruption = result
            .as_ref()
            .err()
            .is_some_and(|error| {
                matches!(
                    error.trim().to_ascii_lowercase().as_str(),
                    "step interrupted"
                        | "cancelled"
                        | "canceled"
                        | "request cancelled"
                        | "request canceled"
                        | "operation cancelled"
                        | "operation canceled"
                )
            });
        let interrupted = cancelled_result
            || reported_error_interruption
            || (reported_interruption && result.is_ok());
        if interrupted {
            if let Ok(Value::Object(payload)) = &mut result {
                payload.insert("sailInterrupted".into(), Value::Bool(true));
            }
        }
        let status = if interrupted {
            "interrupted"
        } else if result.is_err() {
            "failed"
        } else {
            "done"
        };
        let evidence_status = durable_prompt_status(
            status,
            result.is_err() && settlement_generation.is_none(),
            dispatch_phase.load(Ordering::Acquire),
        );
        if let Err(error) = crate::settings::record_acp_turn_evidence(
            &app,
            crate::settings::AcpTurnEvidence {
                agent: agent.clone(),
                session_id: session_id.clone(),
                turn_id: turn_id.clone(),
                status: evidence_status.into(),
                error: result.as_ref().err().cloned(),
                updated_at: 0,
            },
        ) {
            crate::diagnostics::record(
                "acp_turn_evidence_failed",
                json!({"agent":agent,"sessionId":session_id,"turnId":turn_id,"error":error}),
            );
        }
        crate::diagnostics::record("prompt_finished", json!({
            "agent":agent,"sessionId":session_id,"turnId":turn_id,
            "status":status,"explicitlyCancelled":explicitly_cancelled,
            "reportedInterruption":reported_interruption,
            "reportedErrorInterruption":reported_error_interruption,
            "stopReason":result.as_ref().ok().and_then(|value| value.get("stopReason")).and_then(Value::as_str)
        }));
        let notify = !explicitly_cancelled && !interrupted;
        let latest = if let Ok(mut prompts) = runtime.prompt_state.lock() {
            if prompts
                .active
                .get(&session_id)
                .is_some_and(|prompt| prompt.turn_id == turn_id)
            {
                if !runtime.stopped.load(Ordering::Acquire) {
                    let _ = crate::settings::clear_interrupted_turn(
                        &app,
                        &agent,
                        &session_id,
                        &turn_id,
                    );
                }
                prompts.active.remove(&session_id);
                prompts.finished.insert(
                    session_id.clone(),
                    PromptOutcome {
                        status,
                        notify,
                        error: result.as_ref().err().cloned(),
                        turn_id: turn_id.clone(),
                    },
                );
                true
            } else {
                false
            }
        } else {
            false
        };
        if latest {
            let _ = app.emit(
                "acp-event",
                AgentEvent {
                    agent,
                    message: json!({"method":"sail/prompt_finished","params":{
                        "sessionId":session_id,"turnId":turn_id,"status":status,"notify":notify,
                        "error":result.as_ref().err(),
                        "sailCapabilityProfile":runtime.profile.as_str()
                    }}),
                },
            );
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpSteerParams {
    agent: String,
    session_id: String,
    text: String,
    image_paths: Vec<String>,
}

#[tauri::command]
pub async fn acp_steer(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    params: AcpSteerParams,
) -> Result<Value, String> {
    let AcpSteerParams {
        agent,
        session_id,
        text,
        image_paths,
    } = params;
    let runtime = connection_for_session(&manager, &agent, &session_id)?;
    let supported = runtime
        .capabilities
        .lock()
        .map_err(|error| error.to_string())?
        .pointer("/_meta/steering/supported")
        .and_then(Value::as_bool)
        == Some(true);
    let active = runtime
        .prompt_state
        .lock()
        .map_err(|error| error.to_string())?
        .active
        .contains_key(&session_id);
    let steer_into_running_turn_only = supported && active;
    if !steer_into_running_turn_only {
        return Ok(json!({"outcome":"promptRequired"}));
    }
    let content = prepare_prompt_content(&app, &text, image_paths).await?;
    let wait_as_long_as_a_turn = Duration::from_secs(60 * 60 * 3);
    tauri::async_runtime::spawn_blocking(move || {
        runtime.request(
            "_session/steering",
            json!({
                "sessionId":session_id,
                "prompt":content,
                "_meta":{"steering":{"idleBehavior":"promptRequired"}}
            }),
            wait_as_long_as_a_turn,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn acp_cancel(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
    session_id: String,
    turn_id: Option<String>,
) -> Result<(), String> {
    let runtime = connection_for_session(&manager, &agent, &session_id)?;
    cancel_session(&app, &runtime, &agent, &session_id, turn_id)
}

fn cancel_session(
    app: &AppHandle,
    runtime: &Connection,
    agent: &str,
    session_id: &str,
    turn_id: Option<String>,
) -> Result<(), String> {
    let session_id = session_id.to_string();
    let agent = agent.to_string();
    let cancelled_turn = {
        let mut prompts = runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?;
        let cancelled_turn = prompts.cancellation_turn(&session_id, turn_id);
        if let Some(turn_id) = cancelled_turn.as_deref() {
            prompts.retire_turn(&session_id, turn_id);
        }
        cancelled_turn
    };
    crate::diagnostics::record(
        "cancel_requested",
        json!({
            "agent":agent,"sessionId":session_id,"turnId":cancelled_turn
        }),
    );
    if let Some(turn_id) = cancelled_turn.as_ref() {
        runtime
            .cancelled_prompts
            .lock()
            .map_err(|error| error.to_string())?
            .insert(turn_id.clone());
    }
    let mut permission_state = runtime
        .permission_state
        .lock()
        .map_err(|error| error.to_string())?;
    permission_state.begin_cancel(&session_id, cancelled_turn.as_deref());
    let result = runtime.notify("session/cancel", json!({"sessionId":session_id}));
    if result.is_err() {
        permission_state.canceling_sessions.remove(&session_id);
        if let Some(turn_id) = cancelled_turn.as_ref() {
            runtime
                .cancelled_prompts
                .lock()
                .map_err(|error| error.to_string())?
                .remove(turn_id);
        }
        return result;
    }
    resolve_session_permissions(
        &mut permission_state.pending,
        &session_id,
        |request_id, pending| {
            runtime.write(&json!({
                "jsonrpc":"2.0",
                "id":request_id,
                "result":{"outcome":{"outcome":"cancelled"}}
            }))?;
            let _ = app.emit(
                "acp-event",
                AgentEvent {
                    agent: agent.clone(),
                    message: json!({"method":"sail/permission_resolved","params":{
                        "sessionId":session_id,"requestId":request_id,
                        "sailPermissionGeneration":pending.generation,
                        "sailPermissionFingerprint":pending.fingerprint,
                        "sailPermissionOutcome":"cancelled"
                    }}),
                },
            );
            Ok(())
        },
    )
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionParams {
    agent: String,
    request_id: Value,
    option_id: Option<String>,
    session_id: String,
    request_generation: u64,
    request_fingerprint: String,
}

#[tauri::command]
pub fn acp_permission(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    params: AcpPermissionParams,
) -> Result<(), String> {
    let AcpPermissionParams {
        agent,
        request_id,
        option_id,
        session_id,
        request_generation,
        request_fingerprint,
    } = params;
    let resolution = if option_id.is_some() {
        "selected"
    } else {
        "cancelled"
    };
    let outcome = option_id
        .map(|id| json!({"outcome":"selected","optionId":id}))
        .unwrap_or_else(|| json!({"outcome":"cancelled"}));
    let runtime = connection_for_session(&manager, &agent, &session_id)?;
    let pending = runtime.respond(
        request_id.clone(),
        &session_id,
        request_generation,
        &request_fingerprint,
        json!({"outcome":outcome}),
    )?;
    let Some(pending) = pending else {
        return Ok(());
    };
    let _ = app.emit(
        "acp-event",
        AgentEvent {
            agent,
            message: json!({"method":"sail/permission_resolved","params":{
                "sessionId":session_id,"requestId":request_id,
                "sailPermissionGeneration":pending.generation,
                "sailPermissionFingerprint":pending.fingerprint,
                "sailCapabilityProfile":runtime.profile.as_str(),
                "sailPermissionOutcome":resolution
            }}),
        },
    );
    Ok(())
}

#[tauri::command]
pub async fn acp_set_config(
    manager: State<'_, AgentManager>,
    agent: String,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    let runtime = connection_for_session(&manager, &agent, &session_id)?;
    tauri::async_runtime::spawn_blocking(move || {
        runtime.request(
            "session/set_config_option",
            json!({"sessionId":session_id,"configId":config_id,"value":value}),
            Duration::from_secs(30),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_authenticate(
    manager: State<'_, AgentManager>,
    agent: String,
    method_id: String,
    profile: Option<String>,
) -> Result<Value, String> {
    let profile = parse_profile(profile.as_deref())?;
    let runtime = connection_for_profile(&manager, &agent, profile)?;
    tauri::async_runtime::spawn_blocking(move || {
        runtime.request(
            "authenticate",
            json!({"methodId":method_id}),
            Duration::from_secs(60 * 5),
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod session_config_tests {
    use super::*;
    use crate::browser_agent::McpConfig;
    use std::collections::BTreeMap;

    fn config(token: &str, env: &[(&str, &str)]) -> McpConfig {
        McpConfig {
            command: "/Applications/Sail.app/Contents/MacOS/sail".into(),
            args: vec!["--browser-mcp".into()],
            env: env
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_string()))
                .collect::<BTreeMap<_, _>>(),
            token: token.into(),
        }
    }

    fn scratch(name: &str) -> PathBuf {
        let directory = std::env::temp_dir().join(format!(
            "sail-session-config-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory
    }

    #[test]
    fn request_params_are_identical_whatever_the_env_insertion_order() {
        let first = config(
            "token",
            &[
                ("SAIL_BROWSER_PORT", "4100"),
                ("SAIL_BROWSER_TOKEN", "token"),
            ],
        );
        let second = config(
            "token",
            &[
                ("SAIL_BROWSER_TOKEN", "token"),
                ("SAIL_BROWSER_PORT", "4100"),
            ],
        );
        let params = |config: &McpConfig| {
            let servers = session_servers(mcp_server(config), None);
            serde_json::to_string(&session_request_params(
                "/work/repo",
                Some("session"),
                &servers,
            ))
            .unwrap()
        };
        assert_eq!(params(&first), params(&second));
        assert_eq!(params(&first), params(&first));
        let servers = session_servers(mcp_server(&first), None);
        let request = session_request_params("/work/repo", None, &servers);
        let env = &request["mcpServers"][0]["env"];
        assert_eq!(env[0]["name"], "SAIL_BROWSER_PORT");
        assert_eq!(env[1]["name"], "SAIL_BROWSER_TOKEN");
        assert!(request.get("sessionId").is_none());

        let servers = session_servers(
            mcp_server(&first),
            Some(json!({"name":"sail-memory","command":"/opt/sail"})),
        );
        let request = session_request_params("/work/repo", None, &servers);
        assert_eq!(request["mcpServers"].as_array().unwrap().len(), 2);
        assert_eq!(request["mcpServers"][1]["name"], "sail-memory");
        assert!(optional_memory_server(Err("store unavailable".into())).is_none());
    }

    #[test]
    fn restoring_a_session_reuses_its_first_parameters() {
        let directory = scratch("reuse");
        let cwd = directory.to_string_lossy().into_owned();
        let mut configs = HashMap::new();
        let mut minted = 0;
        let mut released = Vec::new();
        let first = reuse_session_config(
            &mut configs,
            "session",
            &cwd,
            Some(json!({"name":"sail-memory","command":"/opt/sail"})),
            || {
                minted += 1;
                Ok(config("first", &[("SAIL_BROWSER_TOKEN", "first")]))
            },
            |token| released.push(token.to_string()),
        )
        .unwrap();
        let second = reuse_session_config(
            &mut configs,
            "session",
            &cwd,
            None,
            || {
                minted += 1;
                Ok(config("second", &[("SAIL_BROWSER_TOKEN", "second")]))
            },
            |token| released.push(token.to_string()),
        )
        .unwrap();
        assert_eq!(minted, 1);
        assert!(released.is_empty());
        assert_eq!(first.token, "first");
        assert_eq!(second.servers.len(), 2);
        assert_eq!(
            session_request_params(&first.cwd, Some("session"), &first.servers),
            session_request_params(&second.cwd, Some("session"), &second.servers)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_per_load_switch_mints_parameters_for_every_load() {
        let mut configs = HashMap::new();
        let mut minted = 0;
        let mut released = 0;
        let first = restore_params(
            true,
            &mut configs,
            "session",
            "/work/repo",
            None,
            || {
                minted += 1;
                Ok(config("first", &[("SAIL_BROWSER_TOKEN", "first")]))
            },
            |_| released += 1,
        )
        .unwrap();
        let second = restore_params(
            true,
            &mut configs,
            "session",
            "/work/repo",
            None,
            || {
                minted += 1;
                Ok(config("second", &[("SAIL_BROWSER_TOKEN", "second")]))
            },
            |_| released += 1,
        )
        .unwrap();
        assert_eq!(minted, 2);
        assert_eq!(released, 0);
        assert!(configs.is_empty());
        assert_ne!(first, second);
    }

    #[test]
    fn reuse_keeps_the_parameters_the_adapter_already_saw() {
        let directory = scratch("restore");
        let cwd = directory.to_string_lossy().into_owned();
        let mut configs = HashMap::new();
        let mut minted = 0;
        let first = restore_params(
            false,
            &mut configs,
            "session",
            &cwd,
            None,
            || {
                minted += 1;
                Ok(config("first", &[("SAIL_BROWSER_TOKEN", "first")]))
            },
            |_| unreachable!("a reused config releases no token"),
        )
        .unwrap();
        let second = restore_params(
            false,
            &mut configs,
            "session",
            &cwd,
            None,
            || {
                minted += 1;
                Ok(config("second", &[("SAIL_BROWSER_TOKEN", "second")]))
            },
            |_| unreachable!("a reused config releases no token"),
        )
        .unwrap();
        assert_eq!(minted, 1);
        assert_eq!(first, second);
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_symlinked_path_to_the_same_directory_keeps_the_original_cwd() {
        let directory = scratch("symlink");
        let link = directory.with_extension("link");
        std::os::unix::fs::symlink(&directory, &link).unwrap();
        let mut configs = HashMap::new();
        let original = directory.to_string_lossy().into_owned();
        reuse_session_config(
            &mut configs,
            "session",
            &original,
            None,
            || Ok(config("first", &[])),
            |_| {},
        )
        .unwrap();
        let through_link = reuse_session_config(
            &mut configs,
            "session",
            &link.to_string_lossy(),
            None,
            || Err("a symlinked path must not mint a new config".into()),
            |_| {},
        )
        .unwrap();
        assert_eq!(through_link.cwd, original);
        std::fs::remove_file(link).unwrap();
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn moving_a_session_to_another_directory_mints_and_releases() {
        let first_directory = scratch("before");
        let second_directory = scratch("after");
        let mut configs = HashMap::new();
        let mut released = Vec::new();
        reuse_session_config(
            &mut configs,
            "session",
            &first_directory.to_string_lossy(),
            None,
            || Ok(config("first", &[])),
            |token| released.push(token.to_string()),
        )
        .unwrap();
        let moved = reuse_session_config(
            &mut configs,
            "session",
            &second_directory.to_string_lossy(),
            None,
            || Ok(config("second", &[])),
            |token| released.push(token.to_string()),
        )
        .unwrap();
        assert_eq!(moved.token, "second");
        assert_eq!(released, vec!["first".to_string()]);
        std::fs::remove_dir_all(first_directory).unwrap();
        std::fs::remove_dir_all(second_directory).unwrap();
    }
}

#[cfg(test)]
mod native_subagent_fence_tests {
    use super::*;

    #[test]
    fn backend_spawn_observed_after_frontend_snapshot_blocks_cleanup() {
        let fence = AgentWorktreeFence::default();
        let agents = AgentManager::default();
        let directory = PathBuf::from("/worktree");
        let mut cleaned = false;

        fence
            .record_native_update(&directory)
            .expect("native generation should advance");
        let error = fence
            .cleanup(&agents, &directory, Some(0), || {
                cleaned = true;
                Ok(())
            })
            .expect_err("stale cleanup snapshot must be rejected");

        assert_eq!(
            error,
            "Task-owned subagents changed before worktree cleanup."
        );
        assert!(!cleaned);
    }

    #[cfg(unix)]
    #[test]
    fn active_opencode_turn_blocks_worktree_cleanup() {
        let mut child = Command::new("sleep")
            .arg("30")
            .stdin(Stdio::piped())
            .process_group(0)
            .spawn()
            .expect("placeholder agent should start");
        let input = child.stdin.take().expect("placeholder agent stdin");
        let watchdog = crate::child_watchdog::ChildWatchdog::start(child.id())
            .expect("placeholder watchdog should start");
        let runtime = Arc::new(Connection {
            agent: "opencode".into(),
            profile: CapabilityProfile::Build,
            child: Mutex::new(child),
            watchdog: Mutex::new(watchdog),
            stopped: AtomicBool::new(false),
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            reader_progress: ReaderProgress::default(),
            permission_state: Mutex::new(PermissionState::default()),
            elicitation_state: Mutex::new(HashMap::new()),
            next_permission_generation: AtomicU64::new(1),
            prompt_state: Mutex::new(PromptState::default()),
            cancelled_prompts: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            capabilities: Mutex::new(Value::Null),
            session_directories: Mutex::new(HashMap::new()),
            session_configs: Mutex::new(HashMap::new()),
            native_subagents: Mutex::new(NativeSubagentRegistry::default()),
            session_profiles: Mutex::new(HashMap::new()),
            pending_directory: Mutex::new(None),
            session_creation: Mutex::new(()),
            ready: Condvar::new(),
        });
        let directory = PathBuf::from("/worktree");
        runtime
            .session_directories
            .lock()
            .unwrap()
            .insert("ses_open".into(), directory.clone());
        runtime.prompt_state.lock().unwrap().active.insert(
            "ses_open".into(),
            ActivePrompt {
                turn_id: "turn".into(),
                text: "task".into(),
                last_agent_message: String::new(),
                agent_message_open: false,
                agent_message_overflow: false,
                known_tool_calls: HashSet::new(),
            },
        );
        let agents = AgentManager::default();
        agents
            .0
            .lock()
            .unwrap()
            .insert(("opencode".into(), CapabilityProfile::Build), runtime);
        let mut cleaned = false;

        let error = AgentWorktreeFence::default()
            .cleanup(&agents, &directory, None, || {
                cleaned = true;
                Ok(())
            })
            .expect_err("an active OpenCode turn must block worktree removal");

        assert_eq!(
            error,
            "Worktree has active agent sessions: opencode:ses_open."
        );
        assert!(!cleaned);
    }

    #[test]
    fn queued_native_spawn_waits_until_worktree_cleanup_releases_its_fence() {
        let fence = AgentWorktreeFence::default();
        let agents = AgentManager::default();
        let directory = PathBuf::from("/worktree");
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();

        let worker = fence
            .cleanup(&agents, &directory, Some(0), || {
                let queued_fence = fence.clone();
                let queued_directory = directory.clone();
                let worker = std::thread::spawn(move || {
                    started_tx.send(()).expect("queued spawn should start");
                    queued_fence
                        .record_native_update(&queued_directory)
                        .expect("queued spawn should reconcile");
                    finished_tx.send(()).expect("queued spawn should finish");
                });
                started_rx.recv().expect("queued spawn should be scheduled");
                assert!(finished_rx.try_recv().is_err());
                Ok(worker)
            })
            .expect("idle worktree cleanup should finish");

        worker.join().expect("queued spawn worker should finish");
        finished_rx
            .recv()
            .expect("queued spawn should reconcile after cleanup");
    }

    #[test]
    fn native_child_remains_active_until_provider_reports_settlement() {
        let mut registry = NativeSubagentRegistry::default();
        let directory = PathBuf::from("/worktree");

        registry.spawn("retired", "late-child", directory.clone());

        assert_eq!(registry.active_in(&directory), vec!["late-child"]);
        registry.update("late-child", "completed");
        assert!(registry.active_in(&directory).is_empty());
    }

    #[test]
    fn provider_spawn_during_replacement_creation_rejects_handoff() {
        let fence = AgentWorktreeFence::default();
        let directory = PathBuf::from("/worktree");

        fence
            .record_native_update(&directory)
            .expect("native generation should advance");
        let error = fence
            .finish_session(&directory, Some(0))
            .expect_err("replacement must not survive a changed native generation");

        assert_eq!(
            error,
            "Task-owned subagents changed while the replacement was starting."
        );
    }

    #[test]
    fn retired_parent_spawn_before_replacement_dispatch_aborts_prompt() {
        let fence = AgentWorktreeFence::default();
        let directory =
            std::env::temp_dir().join(format!("sail-replacement-fence-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).expect("test worktree should exist");
        fence
            .begin_session(&directory, Some(0))
            .expect("replacement creation should start");
        fence
            .arm_session("codex", "replacement", &directory, 0)
            .expect("replacement should remain guarded");
        let cleanup_error = fence
            .cleanup(&AgentManager::default(), &directory, Some(0), || Ok(()))
            .expect_err("guarded replacement must keep cleanup fenced");
        assert_eq!(
            cleanup_error,
            "An agent session is starting in this worktree."
        );
        fence
            .record_native_update(&directory)
            .expect("late retired-parent spawn should advance the generation");
        let mut dispatched = false;

        let error = fence
            .dispatch_session("codex", "replacement", || {
                dispatched = true;
                Ok(())
            })
            .expect_err("late spawn must abort replacement prompt dispatch");

        assert_eq!(
            error,
            "Task-owned subagents changed before replacement prompt dispatch."
        );
        assert!(!dispatched);
        std::fs::remove_dir(&directory).expect("test worktree should be removable");
    }
}

#[cfg(test)]
mod capability_profile_tests {
    use super::*;

    #[test]
    fn session_ids_have_only_one_live_capability_owner() {
        assert_eq!(
            unique_session_owner([CapabilityProfile::Build, CapabilityProfile::Build]).unwrap(),
            Some(CapabilityProfile::Build)
        );
        assert_eq!(
            unique_session_owner([CapabilityProfile::Build, CapabilityProfile::Review])
                .unwrap_err(),
            "Agent session is connected under multiple capability profiles."
        );
    }

    #[test]
    fn activity_excludes_sessions_from_dead_profile_connections() {
        let mut activity = HashMap::new();
        let prompts = PromptState::default();
        let permissions = HashMap::new();

        append_connection_activity(
            &mut activity,
            "codex",
            false,
            &prompts,
            &HashMap::from([("review-session".to_string(), PathBuf::from("/review"))]),
            &permissions,
        );
        append_connection_activity(
            &mut activity,
            "codex",
            true,
            &prompts,
            &HashMap::from([("build-session".to_string(), PathBuf::from("/build"))]),
            &permissions,
        );

        let codex = activity.get("codex").unwrap();
        assert!(codex.alive);
        assert_eq!(codex.sessions, vec!["build-session"]);
    }

    #[test]
    fn client_terminal_capability_matches_profile() {
        for (profile, expected) in [
            (CapabilityProfile::Explore, false),
            (CapabilityProfile::Review, false),
            (CapabilityProfile::Build, true),
            (CapabilityProfile::Release, true),
        ] {
            assert_eq!(
                client_capabilities("codex", profile)
                    .get("terminal")
                    .and_then(Value::as_bool),
                Some(expected)
            );
        }
    }

    #[test]
    fn only_opencode_opts_into_child_session_updates() {
        let meta = |agent| {
            client_capabilities(agent, CapabilityProfile::Build)
                .get("_meta")
                .cloned()
        };
        assert_eq!(
            meta("opencode"),
            Some(json!({"opencode/child-session-updates":true}))
        );
        assert_eq!(meta("codex"), None);
        assert_eq!(meta("claude"), None);
    }

    #[test]
    fn opencode_child_updates_become_standard_subagent_updates() {
        let notify = |params: Value| json!({"jsonrpc":"2.0","method":"opencode/session/child_update","params":params});
        let base = json!({"rootSessionId":"ses_root","childSessionId":"ses_child","parentSessionId":"ses_root","depth":1,"title":"Explore code"});
        let with = |extra: Value| {
            let mut params = base.clone();
            params
                .as_object_mut()
                .unwrap()
                .extend(extra.as_object().unwrap().clone());
            notify(params)
        };

        let spawned = opencode_child_update(&with(json!({"type":"status","status":"created"})))
            .unwrap()
            .unwrap();
        assert_eq!(
            spawned.pointer("/params/sessionId"),
            Some(&json!("ses_root"))
        );
        assert_eq!(
            spawned.pointer("/params/update"),
            Some(
                &json!({"sessionUpdate":"subagent_spawned","subagentSessionId":"ses_child","name":"Explore code","task":"Explore code"})
            )
        );

        for (status, state) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("interrupted", "cancelled"),
        ] {
            let done = opencode_child_update(&with(json!({"type":"status","status":status})))
                .unwrap()
                .unwrap();
            assert_eq!(
                done.pointer("/params/update/sessionUpdate"),
                Some(&json!("subagent_state_update"))
            );
            assert_eq!(done.pointer("/params/update/state"), Some(&json!(state)));
        }
        let resumed = opencode_child_update(&with(json!({"type":"status","status":"running"})))
            .unwrap()
            .unwrap();
        assert_eq!(
            resumed.pointer("/params/update/state"),
            Some(&json!("working"))
        );
        let failed = opencode_child_update(&with(
            json!({"type":"status","status":"failed","error":{"message":"boom"}}),
        ))
        .unwrap()
        .unwrap();
        assert_eq!(failed.pointer("/params/update/error"), Some(&json!("boom")));

        let inner =
            json!({"sessionUpdate":"agent_message_chunk","content":{"type":"text","text":"hi"}});
        let update = opencode_child_update(&with(json!({"type":"update","update":inner})))
            .unwrap()
            .unwrap();
        assert_eq!(
            update.pointer("/params/sessionId"),
            Some(&json!("ses_child"))
        );
        assert_eq!(update.pointer("/params/update"), Some(&inner));

        assert_eq!(
            opencode_child_update(&json!({"method":"session/update","params":{}})),
            None
        );
        assert_eq!(
            opencode_child_update(
                &json!({"method":"opencode/session/child_update","params":{"type":"status"}})
            ),
            Some(None)
        );
    }

    #[test]
    fn client_advertises_plan_capability() {
        assert_eq!(
            client_capabilities("codex", CapabilityProfile::Build).get("plan"),
            Some(&json!({}))
        );
    }

    #[test]
    fn crafted_terminal_requests_obey_persisted_session_profile() {
        let profiles = HashMap::from([
            ("explore-session".into(), CapabilityProfile::Explore),
            ("review-session".into(), CapabilityProfile::Review),
            ("build-session".into(), CapabilityProfile::Build),
            ("release-session".into(), CapabilityProfile::Release),
        ]);

        for session_id in ["explore-session", "review-session"] {
            let error = authorize_terminal_request_for(
                &profiles,
                &json!({"sessionId":session_id,"command":"/bin/sh","args":["-c","touch escaped"]}),
            )
            .unwrap_err();
            assert!(error.contains("capability profile"));
        }
        for session_id in ["build-session", "release-session"] {
            assert!(authorize_terminal_request_for(
                &profiles,
                &json!({"sessionId":session_id,"terminalId":"crafted"}),
            )
            .is_ok());
        }
        assert_eq!(
            authorize_terminal_request_for(
                &profiles,
                &json!({"sessionId":"unknown","command":"/bin/sh"}),
            )
            .unwrap_err(),
            "Unknown agent session."
        );
    }

    #[test]
    fn workspace_resource_inspection_rejects_symlinks_that_leave_workspace() {
        let root = std::env::temp_dir().join(format!("sail-acp-resource-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("sail-acp-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(outside.join("secret"), "secret").unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret"), root.join("readme")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(outside.join("secret"), root.join("readme")).unwrap();

        let result = inspect_permission_resources(&root, &["readme".into()]).unwrap();

        assert!(!result.trusted);
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn workspace_resource_inspection_accepts_regular_workspace_files() {
        let root = std::env::temp_dir().join(format!("sail-acp-resource-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(root.join("src")).unwrap();
        std::fs::write(root.join("src/lib.rs"), "fn main() {}").unwrap();

        let result = inspect_permission_resources(&root, &["src/lib.rs".into()]).unwrap();
        #[cfg(unix)]
        let file_url = format!("file://{}", root.join("src/lib.rs").display());
        #[cfg(windows)]
        let file_url = format!(
            "file:///{}",
            root.join("src/lib.rs")
                .display()
                .to_string()
                .replace('\\', "/")
        );
        let file_url_result = inspect_permission_resources(&root, &[file_url]).unwrap();

        assert!(result.trusted);
        assert!(file_url_result.trusted);
        assert_eq!(
            result.canonical_resources,
            vec![root
                .join("src/lib.rs")
                .canonicalize()
                .unwrap()
                .to_string_lossy()
                .into_owned()]
        );
        std::fs::remove_dir_all(&root).unwrap();
    }

    #[test]
    fn workspace_resource_inspection_rejects_a_path_swapped_to_a_symlink() {
        let root = std::env::temp_dir().join(format!("sail-acp-resource-{}", uuid::Uuid::new_v4()));
        let outside =
            std::env::temp_dir().join(format!("sail-acp-outside-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        std::fs::create_dir_all(&outside).unwrap();
        std::fs::write(root.join("target"), "workspace").unwrap();
        std::fs::write(outside.join("secret"), "secret").unwrap();

        assert!(
            inspect_permission_resources(&root, &["target".into()])
                .unwrap()
                .trusted
        );
        std::fs::remove_file(root.join("target")).unwrap();
        #[cfg(unix)]
        std::os::unix::fs::symlink(outside.join("secret"), root.join("target")).unwrap();
        #[cfg(windows)]
        std::os::windows::fs::symlink_file(outside.join("secret"), root.join("target")).unwrap();

        assert!(
            !inspect_permission_resources(&root, &["target".into()])
                .unwrap()
                .trusted
        );
        std::fs::remove_dir_all(&root).unwrap();
        std::fs::remove_dir_all(&outside).unwrap();
    }

    #[test]
    fn repeating_an_answer_succeeds_but_a_different_answer_does_not() {
        let mut state = PermissionState::default();
        let pending = PendingPermission {
            message: json!({"id":7,"params":{"sessionId":"child"}}),
            received_at: 1,
            generation: 2,
            fingerprint: "fp".into(),
        };
        let allow = json!({"outcome":{"outcome":"selected","optionId":"allow"}});
        let reject = json!({"outcome":{"outcome":"selected","optionId":"reject"}});
        assert!(!state.repeats_answer("7", "child", 2, "fp", &allow));
        state.remember_answer("7", &pending, "child", &allow);
        assert!(state.repeats_answer("7", "child", 2, "fp", &allow));
        assert!(!state.repeats_answer("7", "child", 2, "fp", &reject));
        assert!(!state.repeats_answer("7", "other", 2, "fp", &allow));
        assert!(!state.repeats_answer("7", "child", 3, "fp", &allow));
    }

    #[test]
    fn answered_permissions_stay_bounded() {
        let mut state = PermissionState::default();
        let pending = PendingPermission {
            message: json!({}),
            received_at: 1,
            generation: 1,
            fingerprint: "fp".into(),
        };
        let result = json!({"outcome":{"outcome":"cancelled"}});
        for id in 0..(ANSWERED_PERMISSION_LIMIT + 10) {
            state.remember_answer(&id.to_string(), &pending, "s", &result);
        }
        assert_eq!(state.answered.len(), ANSWERED_PERMISSION_LIMIT);
        assert!(!state.repeats_answer("0", "s", 1, "fp", &result));
        assert!(state.repeats_answer(
            &(ANSWERED_PERMISSION_LIMIT + 9).to_string(),
            "s",
            1,
            "fp",
            &result
        ));
    }

    #[test]
    fn permission_response_claim_is_available_only_once() {
        let permissions = Mutex::new(HashMap::from([(
            "7".into(),
            PendingPermission {
                message: json!({"id":7,"params":{"sessionId":"new-session"}}),
                received_at: 1,
                generation: 2,
                fingerprint: "new-fingerprint".into(),
            },
        )]));

        assert_eq!(
            claim_pending_permission(&permissions, "7", "old-session", 1, "old-fingerprint")
                .unwrap_err(),
            "Permission request identity no longer matches."
        );
        assert_eq!(
            claim_pending_permission(&permissions, "7", "new-session", 2, "old-fingerprint")
                .unwrap_err(),
            "Permission request identity no longer matches."
        );
        assert!(
            claim_pending_permission(&permissions, "7", "new-session", 2, "new-fingerprint")
                .is_ok()
        );
        assert_eq!(
            claim_pending_permission(&permissions, "7", "new-session", 2, "new-fingerprint")
                .unwrap_err(),
            "Permission request is no longer pending."
        );
    }
}

#[cfg(all(test, unix, not(feature = "e2e")))]
mod native_agent_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_opencode(version: &str) -> (PathBuf, PathBuf) {
        let root = std::env::temp_dir().join(format!("sail-opencode-acp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let binary = root.join("opencode");
        std::fs::write(&binary, format!("#!/bin/sh\necho {version}\n")).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        (root, binary)
    }

    fn opencode(binary: &Path) -> AgentAvailability {
        agent_availability(Ok(Some(binary.to_string_lossy().into_owned())), |_| true)
            .into_iter()
            .find(|agent| agent.id == "opencode")
            .unwrap()
    }

    #[test]
    fn compatible_opencode_binary_is_available_without_node() {
        let (root, binary) = fake_opencode("2.0.24");
        let agent = opencode(&binary);
        assert!(agent.available);
        assert_eq!(agent.reason, None);
        assert_eq!(agent.binary_path.as_deref(), Some(binary.to_str().unwrap()));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn incompatible_opencode_binary_reports_the_version_diagnostic() {
        let (root, binary) = fake_opencode("1.0.0");
        let agent = opencode(&binary);
        assert!(!agent.available);
        assert_eq!(agent.binary_path, None);
        assert_eq!(
            agent.reason.as_deref(),
            Some("OpenCode v2.0.24 is required (found 1.0.0). Upgrade or choose a compatible binary in settings.")
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_opencode_binary_is_unavailable() {
        let agent = opencode(Path::new("/nonexistent/opencode"));
        assert!(!agent.available);
        assert!(agent
            .reason
            .unwrap()
            .starts_with("OpenCode binary not found"));
    }

    #[test]
    fn settings_error_makes_opencode_unavailable_with_the_cause() {
        let agent = agent_availability(Err("Cannot parse settings: bad".into()), |id| {
            id == "opencode"
        })
        .pop()
        .unwrap();
        assert!(!agent.available);
        assert_eq!(agent.reason.as_deref(), Some("Cannot parse settings: bad"));
    }

    #[test]
    fn availability_can_target_one_agent() {
        let ids: Vec<_> = agent_availability(Ok(None), |id| id == "claude")
            .into_iter()
            .map(|agent| agent.id)
            .collect();
        assert_eq!(ids, ["claude"]);
    }

    #[test]
    fn skipping_opencode_never_runs_its_version_probe() {
        let root = std::env::temp_dir().join(format!("sail-opencode-acp-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&root).unwrap();
        let marker = root.join("probed");
        let binary = root.join("opencode");
        std::fs::write(&binary, format!("#!/bin/sh\ntouch {}\n", marker.display())).unwrap();
        std::fs::set_permissions(&binary, std::fs::Permissions::from_mode(0o755)).unwrap();
        let ids: Vec<_> =
            agent_availability(Ok(Some(binary.to_string_lossy().into_owned())), |id| {
                id != "opencode"
            })
            .into_iter()
            .map(|agent| agent.id)
            .collect();
        assert_eq!(ids, ["claude", "codex"]);
        assert!(!marker.exists());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn npx_agents_keep_their_availability_entries() {
        let (root, binary) = fake_opencode("2.0.24");
        let ids: Vec<_> =
            agent_availability(Ok(Some(binary.to_string_lossy().into_owned())), |_| true)
                .into_iter()
                .map(|agent| agent.id)
                .collect();
        assert_eq!(ids, ["claude", "codex", "opencode"]);
        std::fs::remove_dir_all(root).unwrap();
    }
}
