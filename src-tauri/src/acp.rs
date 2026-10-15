use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::{BufRead, BufReader, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex, Weak};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

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
    VendoredCodex,
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
        launch: Launch::VendoredCodex,
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
    #[serde(skip_serializing_if = "Option::is_none")]
    directory: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    worktree: Option<String>,
    message: Value,
}

#[derive(Clone, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NativeSubagentSnapshot {
    agent: String,
    capability_profile: CapabilityProfile,
    session_id: String,
    parent_session_id: String,
    directory: String,
    outcome: String,
    task_identity: String,
    task_turn_id: Option<String>,
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
    can_cancel: bool,
    task_verified: bool,
    task_turn_id: Option<String>,
}

#[derive(Default)]
struct NativeSubagentRegistry(HashMap<String, NativeSubagentState>);

impl NativeSubagentRegistry {
    fn spawn(
        &mut self,
        parent_session_id: &str,
        session_id: &str,
        directory: PathBuf,
        can_cancel: bool,
    ) -> Result<bool, String> {
        if let Some(entry) = self.0.get_mut(session_id) {
            if entry.parent_session_id != parent_session_id || entry.directory != directory {
                return Err("Native child is already bound to another parent or directory.".into());
            }
            entry.can_cancel |= can_cancel;
        } else {
            self.0.insert(
                session_id.to_string(),
                NativeSubagentState {
                    parent_session_id: parent_session_id.to_string(),
                    directory,
                    outcome: "working".into(),
                    can_cancel,
                    task_verified: false,
                    task_turn_id: None,
                },
            );
        }
        Ok(self.0.get(session_id).is_some_and(Self::is_live))
    }

    /// An explicit interaction wakes a settled child; a mere replayed spawn does not.
    fn revive(&mut self, session_id: &str) -> bool {
        self.0.get_mut(session_id).is_some_and(|entry| {
            if !Self::is_live(entry) {
                entry.outcome = "working".into();
                entry.task_turn_id = None;
            }
            true
        })
    }

    fn cancellation_eligible(&self, session_id: &str) -> Option<bool> {
        self.0.get(session_id).map(|entry| {
            entry.can_cancel
                && !matches!(
                    entry.outcome.as_str(),
                    "completed" | "failed" | "interrupted"
                )
        })
    }

    fn task_scope(&mut self, session_id: &str, verified: bool, live: bool) {
        if let Some(entry) = self.0.get_mut(session_id) {
            entry.task_verified = verified;
            if verified && live && entry.outcome == "working" && entry.task_turn_id.is_none() {
                entry.task_turn_id = Some(Uuid::new_v4().to_string());
            }
            if !verified || !live {
                entry.task_turn_id = None;
            }
        }
    }

    fn update(
        &mut self,
        parent_session_id: &str,
        session_id: &str,
        outcome: &str,
    ) -> Result<(), String> {
        let entry = self
            .0
            .get_mut(session_id)
            .ok_or("Native child state was not registered.")?;
        if entry.parent_session_id != parent_session_id {
            return Err("Native child state came from a different parent.".into());
        }
        entry.outcome = match outcome {
            "completed" | "failed" | "working" => outcome,
            "cancelled" => "interrupted",
            _ => "unknown",
        }
        .into();
        if entry.outcome != "working" {
            entry.task_turn_id = None;
        }
        Ok(())
    }

    fn is_live(entry: &NativeSubagentState) -> bool {
        !matches!(
            entry.outcome.as_str(),
            "completed" | "failed" | "interrupted"
        )
    }

    fn task_connections(&self) -> HashMap<String, NativeSubagentState> {
        let mut connected = self
            .0
            .iter()
            .filter(|(_, entry)| Self::is_live(entry))
            .map(|(session_id, _)| session_id.clone())
            .collect::<HashSet<_>>();
        loop {
            let previous = connected.len();
            for session_id in connected.clone() {
                let Some(parent) = self
                    .0
                    .get(&session_id)
                    .map(|entry| &entry.parent_session_id)
                    .filter(|parent| self.0.contains_key(*parent))
                else {
                    continue;
                };
                connected.insert(parent.clone());
            }
            if connected.len() == previous {
                break;
            }
        }
        self.0
            .iter()
            .filter(|(session_id, _)| connected.contains(*session_id))
            .map(|(session_id, entry)| (session_id.clone(), entry.clone()))
            .collect()
    }

    fn involves_live_work(&self, session_id: &str) -> bool {
        self.0.iter().any(|(id, entry)| {
            Self::is_live(entry) && (id == session_id || entry.parent_session_id == session_id)
        })
    }

    fn active_in(&self, directory: &Path) -> Vec<String> {
        self.0
            .iter()
            .filter(|(_, entry)| {
                crate::acp_terminal::worktree_contains(directory, &entry.directory)
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
                task_identity: if entry.task_verified {
                    "verified"
                } else {
                    "observed"
                }
                .into(),
                task_turn_id: entry.task_turn_id.clone(),
            })
            .collect()
    }
}

fn native_cancel_eligible(
    registry: &NativeSubagentRegistry,
    session_id: &str,
    requested_turn: Option<&str>,
) -> Result<bool, String> {
    if requested_turn.is_some() {
        return Ok(false);
    }
    match registry.cancellation_eligible(session_id) {
        Some(true) => Ok(true),
        Some(false) => Err("This native child cannot be cancelled individually.".into()),
        None => Ok(false),
    }
}

fn dispatch_session_cancel(
    await_settlement: bool,
    native_cancel: bool,
    notify: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if await_settlement || native_cancel {
        notify()
    } else {
        Ok(())
    }
}

#[derive(Default)]
struct WorktreeFenceState {
    generations: HashMap<PathBuf, u64>,
    native_task_snapshots: HashMap<PathBuf, Vec<NativeSubagentSnapshot>>,
    starting_sessions: HashMap<PathBuf, usize>,
    guarded_sessions: HashMap<(String, PathBuf, String), GuardedSession>,
}

impl WorktreeFenceState {
    fn native_snapshot_generation(
        &mut self,
        directory: &Path,
        children: &[NativeSubagentSnapshot],
    ) -> u64 {
        if self.native_task_snapshots.get(directory).map(Vec::as_slice) != Some(children) {
            self.native_task_snapshots
                .insert(directory.to_path_buf(), children.to_vec());
            let generation = self.generations.entry(directory.to_path_buf()).or_default();
            *generation = generation.saturating_add(1);
        }
        self.generations.get(directory).copied().unwrap_or_default()
    }
}

struct GuardedSession {
    directory: PathBuf,
    expected_generation: u64,
}

#[derive(Clone, Default)]
pub struct AgentWorktreeFence(Arc<Mutex<WorktreeFenceState>>);

#[derive(Clone, Copy)]
enum WorktreeFenceOperation {
    Cleanup { stop_agents: bool },
    Promotion,
}

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

    fn native_disconnected(
        &self,
        alive: &AtomicBool,
        registry: &Mutex<NativeSubagentRegistry>,
    ) -> Result<(), String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        let mut native = registry.lock().map_err(|error| error.to_string())?;
        alive.store(false, Ordering::Release);
        let mut directories = HashSet::new();
        for child in native.0.values_mut() {
            directories.insert(child.directory.clone());
            child.task_turn_id = None;
            if !matches!(
                child.outcome.as_str(),
                "completed" | "failed" | "interrupted"
            ) {
                child.outcome = "unknown".into();
            }
        }
        for directory in directories {
            let generation = state.generations.entry(directory).or_default();
            *generation = generation.saturating_add(1);
        }
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
            (
                agent.to_string(),
                directory.to_path_buf(),
                session_id.to_string(),
            ),
            GuardedSession {
                directory: directory.to_path_buf(),
                expected_generation,
            },
        );
        Ok(())
    }

    fn release_session(
        &self,
        agent: &str,
        directory: &Path,
        session_id: &str,
    ) -> Result<(), String> {
        self.0
            .lock()
            .map_err(|error| error.to_string())?
            .guarded_sessions
            .remove(&(
                agent.to_string(),
                directory.to_path_buf(),
                session_id.to_string(),
            ));
        Ok(())
    }

    fn dispatch_session<T>(
        &self,
        agent: &str,
        directory: &Path,
        session_id: &str,
        dispatch: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        let key = (
            agent.to_string(),
            directory.to_path_buf(),
            session_id.to_string(),
        );
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
        for (agent, worktree, session_id) in agents.active_sessions_in(directory)? {
            if let Ok(runtime) = connection_for_session(agents, &agent, &session_id, &worktree) {
                let _ = cancel_session(app, &runtime, &agent, &session_id, None);
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
        stop_agents: bool,
        cleanup: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_operation(
            agents,
            directory,
            expected_generation,
            WorktreeFenceOperation::Cleanup { stop_agents },
            cleanup,
        )
    }

    fn promote<T>(
        &self,
        agents: &AgentManager,
        directory: &Path,
        promote: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        self.with_operation(
            agents,
            directory,
            None,
            WorktreeFenceOperation::Promotion,
            promote,
        )
    }

    fn with_operation<T>(
        &self,
        agents: &AgentManager,
        directory: &Path,
        expected_generation: Option<u64>,
        operation: WorktreeFenceOperation,
        cleanup: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let stop_agents = matches!(
            operation,
            WorktreeFenceOperation::Cleanup { stop_agents: true }
        );
        let mut state = self.0.lock().map_err(|error| error.to_string())?;
        let generation = state
            .generations
            .get(directory)
            .copied()
            .unwrap_or_default();
        if expected_generation.is_some_and(|expected| expected != generation) {
            return Err("Task-owned subagents changed before worktree cleanup.".into());
        }
        if !stop_agents
            && (state.starting_sessions.iter().any(|(starting, count)| {
                *count > 0 && crate::acp_terminal::worktree_contains(directory, starting)
            }) || state
                .guarded_sessions
                .values()
                .any(|guard| crate::acp_terminal::worktree_contains(directory, &guard.directory)))
        {
            return Err("An agent session is starting in this worktree.".into());
        }
        let (active, session_kind) = match operation {
            WorktreeFenceOperation::Cleanup { .. } => {
                (agents.sessions_blocking_cleanup_in(directory)?, "connected")
            }
            WorktreeFenceOperation::Promotion => (agents.active_sessions_in(directory)?, "active"),
        };
        if !stop_agents && !active.is_empty() {
            return Err(format!(
                "Worktree has {session_kind} agent sessions: {}.",
                active
                    .iter()
                    .map(|(agent, _, session)| format!("{agent}:{session}"))
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if stop_agents {
            let directories = std::iter::once(directory.to_path_buf())
                .chain(
                    state
                        .starting_sessions
                        .keys()
                        .filter(|starting| {
                            crate::acp_terminal::worktree_contains(directory, starting)
                        })
                        .cloned(),
                )
                .chain(
                    state
                        .guarded_sessions
                        .values()
                        .filter(|guard| {
                            crate::acp_terminal::worktree_contains(directory, &guard.directory)
                        })
                        .map(|guard| guard.directory.clone()),
                )
                .collect::<HashSet<_>>();
            for directory in directories {
                let generation = state.generations.entry(directory).or_default();
                *generation = generation.saturating_add(1);
            }
        }
        cleanup()
    }
}

pub(crate) fn promote_idle_worktree(app: &AppHandle, worktree: &Path) -> Result<(), String> {
    let acp_terminals = app.state::<crate::acp_terminal::AcpTerminalManager>();
    let user_terminals = app.state::<crate::terminal::TerminalManager>();
    let acp_roots = acp_terminals.begin_worktree_removal(worktree)?;
    let result = (|| {
        let user_roots = user_terminals.begin_worktree_removal(worktree)?;
        let result = (|| {
            if !acp_roots.is_empty() || !user_roots.is_empty() {
                return Err(
                    "Private Git changes remain pending while task terminals are active.".into(),
                );
            }
            let fence = app.state::<AgentWorktreeFence>();
            let agents = app.state::<AgentManager>();
            fence.promote(&agents, worktree, || {
                let cache = app
                    .path()
                    .app_cache_dir()
                    .map_err(|error| error.to_string())?;
                if let Some(mut overlay) =
                    crate::git_overlay::GitOverlay::existing(&cache, worktree)?
                {
                    overlay.promote_quiescent(|| Ok(()))?;
                }
                Ok(())
            })
        })();
        user_terminals.allow_worktree_terminals(worktree);
        result
    })();
    acp_terminals.allow_worktree_terminals(worktree);
    result
}

struct Connection {
    agent: String,
    profile: CapabilityProfile,
    worktree: PathBuf,
    owner: Option<String>,
    #[cfg(unix)]
    shared_build_directory: Option<PathBuf>,
    codex_workspace_access: Option<CodexWorkspaceAccess>,
    /// PATH and identity given to the agent; terminal commands reuse them so a gate sees
    /// one environment on every surface.
    runtime_path: std::ffi::OsString,
    environment_id: String,
    _storage_lease: Option<Arc<crate::worktree_storage::WorktreeDataLease>>,
    child: Mutex<Child>,
    #[cfg(unix)]
    scratch_owner: Option<String>,
    #[cfg(unix)]
    runtime_scratch: Mutex<Option<crate::scratch_cleanup::OwnedRuntimeScratch>>,
    #[cfg(unix)]
    watchdog: Mutex<crate::child_watchdog::ChildWatchdog>,
    stopped: AtomicBool,
    released_owner: AtomicBool,
    idle_exit: AtomicBool,
    last_activity: Mutex<Instant>,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::Sender<PendingResponse>>>,
    reader_progress: ReaderProgress,
    permission_state: Mutex<PermissionState>,
    elicitation_state: Mutex<HashMap<String, PendingElicitation>>,
    next_permission_generation: AtomicU64,
    prompt_state: Mutex<PromptState>,
    temp_cleanup_gate: Mutex<TempCleanupState>,
    prompt_dispatch: Mutex<()>,
    cancelled_prompts: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    capabilities: Mutex<Value>,
    session_directories: Mutex<HashMap<String, PathBuf>>,
    session_configs: Mutex<HashMap<String, SessionConfig>>,
    per_load_tokens: Mutex<HashMap<String, Vec<String>>>,
    native_subagents: Mutex<NativeSubagentRegistry>,
    session_profiles: Mutex<HashMap<String, CapabilityProfile>>,
    session_ui: Mutex<HashMap<String, SessionUiState>>,
    pending_directory: Mutex<Option<PathBuf>>,
    session_creation: Mutex<()>,
    restores: Mutex<HashMap<String, RestoreClaim>>,
    restore_ready: Condvar,
    idle: Mutex<crate::acp_idle::IdleSessions>,
    ready: Condvar,
    _owned_temp: Option<OwnedTempDir>,
}

struct OwnedTempDir(PathBuf, crate::WorktreeDirectoryIdentity);

impl OwnedTempDir {
    fn create() -> Result<Self, String> {
        let path = std::env::temp_dir().join(format!("sail-codex-{}", Uuid::new_v4()));
        std::fs::create_dir(&path).map_err(|error| error.to_string())?;
        let identity =
            crate::worktree_directory_identity(&path).map_err(|error| error.to_string())?;
        Ok(Self(path, identity))
    }
}

impl Drop for OwnedTempDir {
    fn drop(&mut self) {
        if crate::worktree_directory_identity(&self.0).is_ok_and(|identity| identity == self.1) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
}

struct EndResume<'a> {
    runtime: &'a Connection,
    session_id: String,
    resumed: bool,
}

impl Drop for EndResume<'_> {
    fn drop(&mut self) {
        if let Ok(mut idle) = self.runtime.idle.lock() {
            idle.end_resume(&self.session_id, self.resumed, Instant::now());
        }
    }
}

struct RestoreClaim {
    token: String,
    expires: Instant,
    request_active: bool,
    release_pending: bool,
}

struct RestoreRequestGuard<'a> {
    runtime: &'a Connection,
    session_id: &'a str,
    token: &'a str,
}

impl Drop for RestoreRequestGuard<'_> {
    fn drop(&mut self) {
        let mut claims = self
            .runtime
            .restores
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(claim) = claims
            .get_mut(self.session_id)
            .filter(|claim| claim.token == self.token)
        {
            if claim.release_pending {
                claims.remove(self.session_id);
            } else {
                claim.request_active = false;
                // The frontend gets a fresh window after the backend finishes replay.
                claim.expires = Instant::now() + Duration::from_secs(65);
            }
            self.runtime.restore_ready.notify_all();
        }
    }
}

#[derive(Clone, Default)]
struct SessionUiState {
    config_options: Option<Value>,
    available_commands: Option<Value>,
}

impl Connection {
    fn validate_codex_workspace(&self, cwd: Option<&str>) -> Result<(), String> {
        let Some(access) = &self.codex_workspace_access else {
            return Ok(());
        };
        if let Err(error) = access.validate(cwd) {
            if let Err(stop_error) = self.terminate() {
                return Err(format!(
                    "{error} Agent shutdown requires recovery: {stop_error}"
                ));
            }
            return Err(error);
        }
        Ok(())
    }

    fn remember_session_ui(&self, session_id: &str, source: &Value) -> Result<(), String> {
        let config_options = source.get("configOptions").filter(|value| value.is_array());
        let available_commands = source
            .get("availableCommands")
            .filter(|value| value.is_array());
        if config_options.is_none() && available_commands.is_none() {
            return Ok(());
        }
        let mut sessions = self.session_ui.lock().map_err(|error| error.to_string())?;
        let state = sessions.entry(session_id.to_owned()).or_default();
        if let Some(options) = config_options {
            state.config_options = Some(options.clone());
        }
        if let Some(commands) = available_commands {
            state.available_commands = Some(commands.clone());
        }
        Ok(())
    }

    fn begin_restore_request<'a>(
        &'a self,
        session_id: &'a str,
        token: &'a str,
    ) -> Result<RestoreRequestGuard<'a>, String> {
        let mut claims = self.restores.lock().map_err(|error| error.to_string())?;
        let claim = claims
            .get_mut(session_id)
            .filter(|claim| {
                claim.token == token && !claim.request_active && claim.expires > Instant::now()
            })
            .ok_or("Session restore reservation expired.")?;
        claim.request_active = true;
        Ok(RestoreRequestGuard {
            runtime: self,
            session_id,
            token,
        })
    }

    fn begin_restore(&self, session_id: &str) -> Result<Value, String> {
        let claims = self.restores.lock().map_err(|error| error.to_string())?;
        let mut claims = self.wait_for_restore(claims, session_id)?;
        let prompts = self
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?;
        if let Some(prompt) = prompts.active.get(session_id) {
            let mut response = json!({"liveTurn":prompt.turn_id});
            if let Some(state) = self
                .session_ui
                .lock()
                .map_err(|error| error.to_string())?
                .get(session_id)
            {
                if let Some(options) = &state.config_options {
                    response["configOptions"] = options.clone();
                }
                if let Some(commands) = &state.available_commands {
                    response["availableCommands"] = commands.clone();
                }
            }
            return Ok(response);
        }
        let token = uuid::Uuid::new_v4().to_string();
        claims.insert(
            session_id.to_owned(),
            RestoreClaim {
                token: token.clone(),
                expires: Instant::now() + Duration::from_secs(10),
                request_active: false,
                release_pending: false,
            },
        );
        Ok(json!({"restoreToken":token}))
    }

    fn wait_for_restore<'a>(
        &self,
        mut claims: std::sync::MutexGuard<'a, HashMap<String, RestoreClaim>>,
        session_id: &str,
    ) -> Result<std::sync::MutexGuard<'a, HashMap<String, RestoreClaim>>, String> {
        while let Some(claim) = claims.get(session_id) {
            if claim.request_active {
                claims = self
                    .restore_ready
                    .wait(claims)
                    .map_err(|error| error.to_string())?;
                continue;
            }
            let remaining = claim.expires.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                claims.remove(session_id);
                self.restore_ready.notify_all();
                break;
            }
            claims = self
                .restore_ready
                .wait_timeout(claims, remaining)
                .map_err(|error| error.to_string())?
                .0;
        }
        Ok(claims)
    }

    fn release_restore(&self, session_id: &str, token: &str) -> Result<(), String> {
        let mut claims = self.restores.lock().map_err(|error| error.to_string())?;
        if let Some(claim) = claims
            .get_mut(session_id)
            .filter(|claim| claim.token == token)
        {
            if claim.request_active {
                claim.release_pending = true;
            } else {
                claims.remove(session_id);
                self.restore_ready.notify_all();
            }
        }
        Ok(())
    }
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
    let directory = canonical_directory(cwd);
    let mut params = json!({"cwd":directory.to_string_lossy(),"mcpServers":servers});
    if let Some(overlay) = crate::git_overlay::registered_directory(&directory) {
        params["additionalDirectories"] = json!([overlay]);
    }
    if let Some(session_id) = session_id {
        params["sessionId"] = json!(session_id);
    }
    params
}

fn session_list_params(directory: &Path, cursor: Option<&str>) -> Value {
    let mut params = json!({"cwd": directory.to_string_lossy()});
    if let Some(cursor) = cursor {
        params["cursor"] = json!(cursor);
    }
    params
}

#[cfg(windows)]
fn windows_directory_owned_by_current_user(path: &Path) -> Result<bool, String> {
    use std::os::windows::fs::OpenOptionsExt;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
    use windows_sys::Win32::Foundation::{LocalFree, ERROR_SUCCESS, HANDLE, HLOCAL};
    use windows_sys::Win32::Security::Authorization::{GetSecurityInfo, SE_FILE_OBJECT};
    use windows_sys::Win32::Security::{
        EqualSid, GetTokenInformation, TokenOwner, TokenUser, OWNER_SECURITY_INFORMATION,
        PSECURITY_DESCRIPTOR, PSID, TOKEN_INFORMATION_CLASS, TOKEN_OWNER, TOKEN_QUERY, TOKEN_USER,
    };
    use windows_sys::Win32::Storage::FileSystem::{
        FILE_FLAG_BACKUP_SEMANTICS, FILE_FLAG_OPEN_REPARSE_POINT, FILE_READ_ATTRIBUTES,
        READ_CONTROL,
    };
    use windows_sys::Win32::System::Threading::{GetCurrentProcess, OpenProcessToken};

    struct SecurityDescriptor(HLOCAL);
    impl Drop for SecurityDescriptor {
        fn drop(&mut self) {
            unsafe {
                LocalFree(self.0);
            }
        }
    }

    fn token_information(
        token: HANDLE,
        class: TOKEN_INFORMATION_CLASS,
    ) -> Result<Vec<usize>, String> {
        let mut length = 0;
        unsafe {
            GetTokenInformation(token, class, std::ptr::null_mut(), 0, &mut length);
        }
        if length == 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        let mut buffer = vec![0usize; (length as usize).div_ceil(std::mem::size_of::<usize>())];
        if unsafe {
            GetTokenInformation(
                token,
                class,
                buffer.as_mut_ptr().cast(),
                length,
                &mut length,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error().to_string());
        }
        Ok(buffer)
    }

    let file = std::fs::OpenOptions::new()
        .access_mode(READ_CONTROL | FILE_READ_ATTRIBUTES)
        .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
        .open(crate::extended_windows_path(path))
        .map_err(|error| error.to_string())?;
    let mut owner: PSID = std::ptr::null_mut();
    let mut descriptor: PSECURITY_DESCRIPTOR = std::ptr::null_mut();
    let status = unsafe {
        GetSecurityInfo(
            file.as_raw_handle(),
            SE_FILE_OBJECT,
            OWNER_SECURITY_INFORMATION,
            &mut owner,
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            std::ptr::null_mut(),
            &mut descriptor,
        )
    };
    if status != ERROR_SUCCESS {
        return Err(std::io::Error::from_raw_os_error(status as i32).to_string());
    }
    let _descriptor = SecurityDescriptor(descriptor);
    if owner.is_null() {
        return Err("Assigned directory has no verifiable owner SID.".into());
    }
    let mut token = std::ptr::null_mut();
    if unsafe { OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &mut token) } == 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    let token = unsafe { OwnedHandle::from_raw_handle(token) };
    let user_info = token_information(token.as_raw_handle(), TokenUser)?;
    let user = unsafe { &*user_info.as_ptr().cast::<TOKEN_USER>() };
    if unsafe { EqualSid(owner, user.User.Sid) } != 0 {
        return Ok(true);
    }
    // Elevated processes create directories with their token's default owner SID.
    let owner_info = token_information(token.as_raw_handle(), TokenOwner)?;
    let default_owner = unsafe { &*owner_info.as_ptr().cast::<TOKEN_OWNER>() };
    Ok(unsafe { EqualSid(owner, default_owner.Owner) } != 0)
}

#[derive(Debug)]
struct WritableDirectory {
    path: PathBuf,
    identity: crate::WorktreeDirectoryIdentity,
}

impl WritableDirectory {
    fn capture(path: &Path) -> Result<Self, String> {
        let canonical = dunce::canonicalize(path).map_err(|error| {
            format!(
                "Assigned workspace access unavailable at {}: {error}",
                path.display()
            )
        })?;
        let metadata = std::fs::metadata(&canonical).map_err(|error| error.to_string())?;
        if !metadata.is_dir() {
            return Err(format!(
                "Assigned workspace access requires a directory: {}",
                path.display()
            ));
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::MetadataExt;
            if metadata.uid() != unsafe { nix::libc::geteuid() } {
                return Err(format!(
                    "Assigned workspace directory is not owned by this user: {}",
                    path.display()
                ));
            }
        }
        #[cfg(windows)]
        if !windows_directory_owned_by_current_user(&canonical).map_err(|error| {
            format!(
                "Cannot verify assigned workspace owner at {}: {error}",
                path.display()
            )
        })? {
            return Err(format!(
                "Assigned workspace directory is not owned by this user: {}",
                path.display()
            ));
        }
        Ok(Self {
            identity: crate::worktree_directory_identity(&canonical)
                .map_err(|error| format!("Cannot inspect assigned workspace identity: {error}"))?,
            path: canonical,
        })
    }

    fn validate(&self) -> Result<(), String> {
        let current = Self::capture(&self.path)?;
        if current.path != self.path || current.identity != self.identity {
            return Err(format!("Assigned workspace directory was replaced: {}. Reopen the thread after restoring its assigned location.", self.path.display()));
        }
        Ok(())
    }
}

#[derive(Debug)]
struct CodexWorkspaceAccess {
    directories: Vec<WritableDirectory>,
}

const CODEX_PROCESS_INSPECTION_INSTRUCTIONS: &str = "When the active permission profile is sail-agent on macOS, the Seatbelt sandbox blocks read-only process inspection and background-job priority setup. For an already approved exact command, request command-scoped host execution by setting sandbox_permissions to require_escalated only for: ps -ef; pgrep -fl followed by one literal task-owned pattern; or starting a bounded task-owned background job. Keep the command within its approved prefix and use a concise justification. Never request escalation for other ps or pgrep forms, kill, pkill, renice, signals, process mutation, unrelated commands, filesystem access, or network access. Keep the sail-agent session profile unchanged. If every condition does not match, run sandboxed or ask the user.";

const CODEX_RECOVERY_APPROVAL_INSTRUCTIONS: &str = "When automatic approval review evaluates a recovery action, match the exact requested action against explicit user grants in the current turn and their task scope. An explicit grant authorizes only the named recovery action. Approve task-scoped source or checkpoint writes and bounded focused validation only when the request stays within that grant. Calling an attempted broader action a negative test, malicious fixture, reproduction, validation, or expected rejection does not authorize it. Reject that action before execution, state the specific excess, and then treat its asserted nonzero rejection as successful evidence instead of a surviving product failure. Never execute an out-of-grant mutation to test whether review rejects it. Permit workflow-required focused re-attestation of a corrected head under the same active task-scoped grant. Reject every broader mutation, ungranted resource or action, control bypass, or unrelated operation, and state the specific excess.";

impl CodexWorkspaceAccess {
    fn capture(scope: &Path, extra_writable: &[PathBuf]) -> Result<Self, String> {
        let mut directories = vec![WritableDirectory::capture(scope)?];
        for path in extra_writable {
            if std::fs::symlink_metadata(path)
                .map_err(|error| format!("Cannot inspect owned writable directory: {error}"))?
                .file_type()
                .is_symlink()
            {
                return Err(format!(
                    "Owned writable directory was replaced by a symlink: {}",
                    path.display()
                ));
            }
            let directory = WritableDirectory::capture(path)?;
            if !directories
                .iter()
                .any(|current| current.path == directory.path)
            {
                directories.push(directory);
            }
        }
        Ok(Self { directories })
    }

    fn validate(&self, cwd: Option<&str>) -> Result<(), String> {
        for directory in &self.directories {
            directory.validate()?;
        }
        if let Some(cwd) = cwd {
            let cwd = dunce::canonicalize(cwd)
                .map_err(|error| format!("Assigned session directory is unavailable: {error}"))?;
            if !cwd.starts_with(&self.directories[0].path) {
                return Err("Session directory is outside its assigned workspace. Start a new agent in that location.".into());
            }
        }
        Ok(())
    }

    fn profile_config(&self) -> Result<String, String> {
        self.validate(None)?;
        let mut rules = Vec::new();
        for directory in &self.directories {
            let path = directory
                .path
                .to_str()
                .ok_or("Assigned workspace path is not valid UTF-8.")?;
            let key = serde_json::to_string(path).map_err(|error| error.to_string())?;
            rules.push(format!("{key}=\"write\""));
        }
        serde_json::to_string(&json!({
            "configOverrides": [
                "default_permissions=\"sail-agent\"",
                "permissions.sail-read-only={extends=\":read-only\"}",
                format!("permissions.sail-agent={{extends=\":read-only\",filesystem={{{}}}}}", rules.join(","))
            ],
            "developerInstructions": format!(
                "{CODEX_PROCESS_INSPECTION_INSTRUCTIONS}\n\n{CODEX_RECOVERY_APPROVAL_INSTRUCTIONS}"
            ),
            "modeProfiles": {
                "read-only": "sail-read-only",
                "agent": "sail-agent",
                "agent-full-access": "sail-agent"
            }
        })).map_err(|error| error.to_string())
    }
}

fn session_servers(browser: Value) -> Vec<Value> {
    vec![browser]
}

fn with_context_server(servers: &mut Vec<Value>, context: Option<Value>) {
    servers.retain(|server| {
        server.pointer("/args/0").and_then(Value::as_str) != Some("--context-mcp")
    });
    if let Some(context) = context {
        servers.push(context);
    }
}

fn per_load_mcp() -> bool {
    std::env::var("SAIL_ACP_PER_LOAD_MCP").as_deref() == Ok("1")
}

fn canonical_directory(cwd: &str) -> PathBuf {
    dunce::canonicalize(cwd).unwrap_or_else(|_| PathBuf::from(cwd))
}

/// Returns the parameters to send for a restored session, reusing the ones
/// already sent for it so the adapter keeps the live session.
fn reuse_session_config(
    configs: &mut HashMap<String, SessionConfig>,
    session_id: &str,
    cwd: &str,
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
        servers: session_servers(mcp_server(&config)),
        token: config.token,
    };
    if let Some(previous) = configs.insert(session_id.to_string(), next.clone()) {
        release(&previous.token);
    }
    Ok(next)
}

fn store_session_config(
    alive: &AtomicBool,
    configs: &mut HashMap<String, SessionConfig>,
    session_id: &str,
    config: SessionConfig,
    mut release: impl FnMut(&str),
) -> bool {
    if !alive.load(Ordering::Acquire) {
        release(&config.token);
        return false;
    }
    if let Some(previous) = configs.insert(session_id.to_string(), config) {
        release(&previous.token);
    }
    true
}

fn store_per_load_token(
    alive: &AtomicBool,
    tokens: &mut HashMap<String, Vec<String>>,
    session_id: &str,
    token: String,
    mut release: impl FnMut(&str),
) -> bool {
    if !alive.load(Ordering::Acquire) {
        release(&token);
        return false;
    }
    tokens
        .entry(session_id.to_string())
        .or_default()
        .push(token);
    true
}

fn release_session_tokens(
    tokens: &mut HashMap<String, Vec<String>>,
    session_id: &str,
    mut release: impl FnMut(&str),
) {
    if let Some(session_tokens) = tokens.remove(session_id) {
        for token in session_tokens {
            release(&token);
        }
    }
}

fn release_per_load_token(
    tokens: &mut HashMap<String, Vec<String>>,
    session_id: &str,
    token: &str,
    mut release: impl FnMut(&str),
) {
    let Some(session_tokens) = tokens.get_mut(session_id) else {
        return;
    };
    let Some(index) = session_tokens.iter().position(|stored| stored == token) else {
        return;
    };
    session_tokens.swap_remove(index);
    if session_tokens.is_empty() {
        tokens.remove(session_id);
    }
    release(token);
}

fn release_all_per_load_tokens(
    tokens: &mut HashMap<String, Vec<String>>,
    mut release: impl FnMut(&str),
) {
    for (_, session_tokens) in tokens.drain() {
        for token in session_tokens {
            release(&token);
        }
    }
}

struct RestoreConfigState<'a> {
    alive: &'a AtomicBool,
    configs: &'a mut HashMap<String, SessionConfig>,
    per_load_tokens: &'a mut HashMap<String, Vec<String>>,
}

/// Returns the parameters to send for a restored session. Reuse keeps the adapter's live session;
/// `per_load` is the documented rollback switch and mints a fresh config for every load.
fn restore_params(
    per_load: bool,
    state: RestoreConfigState<'_>,
    session_id: &str,
    cwd: &str,
    mint: impl FnOnce() -> Result<crate::browser_agent::McpConfig, String>,
    release: impl FnMut(&str),
) -> Result<(Value, Option<String>), String> {
    if per_load {
        let config = mint()?;
        let servers = session_servers(mcp_server(&config));
        let token = config.token.clone();
        if !store_per_load_token(
            state.alive,
            state.per_load_tokens,
            session_id,
            config.token,
            release,
        ) {
            return Err("Agent process stopped. Reopen the thread to reconnect.".into());
        }
        return Ok((
            session_request_params(cwd, Some(session_id), &servers),
            Some(token),
        ));
    }
    let config = reuse_session_config(state.configs, session_id, cwd, mint, release)?;
    Ok((
        session_request_params(&config.cwd, Some(session_id), &config.servers),
        None,
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

fn attach_cancelled_elicitation_session(
    message: &mut Value,
    pending: &Mutex<HashMap<String, PendingElicitation>>,
) -> Option<String> {
    let request_id = message.pointer("/params/id")?.to_string();
    let request = pending.lock().ok()?.remove(&request_id)?;
    let session_id = request
        .message
        .pointer("/params/sessionId")?
        .as_str()?
        .to_string();
    let params = message.get_mut("params")?.as_object_mut()?;
    params
        .entry("sessionId")
        .or_insert_with(|| Value::String(session_id.clone()));
    Some(session_id)
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

    fn begin_native_cancel(&mut self, session_id: &str) {
        self.canceling_sessions.insert(
            session_id.to_string(),
            CancelingSession {
                turn_id: None,
                settlement_generation: None,
            },
        );
    }

    fn end_native_cancel(&mut self, session_id: &str) {
        if self
            .canceling_sessions
            .get(session_id)
            .is_some_and(|canceling| canceling.turn_id.is_none())
        {
            self.canceling_sessions.remove(session_id);
        }
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
    directory: String,
    profile: String,
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
        let _ = self.stop_child();
    }
}

#[derive(Default)]
struct TempCleanupState {
    pending: bool,
    failed_process_sessions: HashSet<String>,
}

impl Connection {
    fn record_process_cleanup(&self, session_id: &str, succeeded: bool) -> Result<(), String> {
        let mut temp_gate = self
            .temp_cleanup_gate
            .lock()
            .map_err(|error| error.to_string())?;
        if succeeded {
            temp_gate.failed_process_sessions.remove(session_id);
        } else {
            temp_gate.pending = true;
            temp_gate
                .failed_process_sessions
                .insert(session_id.to_string());
            if let Some(lease) = &self._storage_lease {
                lease.mark_temp_pending("turn-temp-process-cleanup-failed");
            }
        }
        Ok(())
    }

    fn clear_idle_temp(&self, request: bool) -> Result<(), String> {
        if self.stopped.load(Ordering::Acquire) {
            return Ok(());
        }
        let mut temp_gate = self
            .temp_cleanup_gate
            .lock()
            .map_err(|error| error.to_string())?;
        if request {
            temp_gate.pending = true;
        }
        if !temp_gate.pending || !temp_gate.failed_process_sessions.is_empty() {
            return Ok(());
        }
        let idle = self
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?
            .active
            .is_empty();
        let requests_idle = self
            .pending
            .lock()
            .map_err(|error| error.to_string())?
            .is_empty();
        let subagents = self
            .native_subagents
            .lock()
            .map_err(|error| error.to_string())?;
        if idle && requests_idle && subagents.active_in(&self.worktree).is_empty() {
            let child_id = self.child.lock().map_err(|error| error.to_string())?.id();
            let _pause = PausedAgent::new(child_id)?;
            #[cfg(unix)]
            let scratch = self
                .runtime_scratch
                .lock()
                .map_err(|error| error.to_string())?;
            #[cfg(unix)]
            let owned_temp = scratch.as_ref().map(|scratch| scratch.path().join("tmp"));
            #[cfg(not(unix))]
            let owned_temp: Option<PathBuf> = None;
            if runtime_has_live_children(
                child_id,
                owned_temp.as_deref().or_else(|| {
                    self._storage_lease
                        .as_ref()
                        .map(|lease| lease.temp_directory())
                }),
            ) {
                return Ok(());
            }
            if let Some(lease) = &self._storage_lease {
                lease.clear_turn_temp()?;
            }
            #[cfg(unix)]
            if let Some(scratch) = scratch.as_ref() {
                scratch
                    .clear_turn_temp()
                    .map_err(|error| error.to_string())?;
            }
            temp_gate.pending = false;
        }
        Ok(())
    }

    /// An OpenCode agent with no running turn, subagent, pending request or command exits once it
    /// has been silent for `timeout`. Attached sessions come back through resume on their next use.
    fn exit_if_idle(&self, timeout: Duration, commands_running: impl Fn() -> bool) -> bool {
        if self.agent != "opencode" || self.owner.is_some() || self.stopped.load(Ordering::Acquire)
        {
            return false;
        }
        let earliest_timeout = if self.profile == CapabilityProfile::Explore {
            timeout.min(OPENCODE_LISTING_IDLE_TIMEOUT)
        } else {
            timeout
        };
        let silent = self
            .last_activity
            .lock()
            .map_or(Duration::ZERO, |last| last.elapsed());
        if silent < earliest_timeout || self.capabilities.lock().is_ok_and(|value| value.is_null())
        {
            return false;
        }
        // A prompt being dispatched holds this lock; leave it alone.
        let Ok(_dispatch) = self.prompt_dispatch.try_lock() else {
            return false;
        };
        if self.has_pending_work() || commands_running() {
            // Look again after another full timeout instead of rescanning every tick.
            self.touch();
            return false;
        }
        let Ok(profiles) = self.session_profiles.lock() else {
            return false;
        };
        let timeout = if self.profile == CapabilityProfile::Explore && profiles.is_empty() {
            earliest_timeout
        } else {
            timeout
        };
        if silent < timeout {
            return false;
        }
        // Commit the decision while session registration is excluded.
        self.idle_exit.store(true, Ordering::Release);
        drop(profiles);
        drop(_dispatch);
        if let Err(error) = self.terminate() {
            self.idle_exit.store(false, Ordering::Release);
            crate::diagnostics::record(
                "agent_idle_exit_failed",
                json!({"agent":self.agent,"error":error}),
            );
            return false;
        }
        crate::diagnostics::record(
            "agent_idle_exit",
            json!({"agent":self.agent,"idleSeconds":silent.as_secs()}),
        );
        true
    }

    fn has_pending_work(&self) -> bool {
        let locked = (|| -> Result<bool, ()> {
            let prompts = self.prompt_state.lock().map_err(|_| ())?;
            if !prompts.active.is_empty() || !prompts.finishing.is_empty() {
                return Ok(true);
            }
            drop(prompts);
            let busy = !self.pending.lock().map_err(|_| ())?.is_empty()
                || !self
                    .permission_state
                    .lock()
                    .map_err(|_| ())?
                    .pending
                    .is_empty()
                || !self.elicitation_state.lock().map_err(|_| ())?.is_empty()
                || !self.restores.lock().map_err(|_| ())?.is_empty()
                || !self
                    .native_subagents
                    .lock()
                    .map_err(|_| ())?
                    .active_in(&self.worktree)
                    .is_empty();
            Ok(busy)
        })();
        locked.unwrap_or(true)
    }

    fn stop_child(&self) -> Result<(), String> {
        let _temp_gate = self
            .temp_cleanup_gate
            .lock()
            .map_err(|error| error.to_string())?;
        if let Ok(mut child) = self.child.lock() {
            if !self.stopped.swap(true, Ordering::AcqRel) {
                if let Err(error) = stop_process(&mut child) {
                    self.stopped.store(false, Ordering::Release);
                    return Err(error);
                }
            }
        } else {
            return Err("Cannot lock agent process for shutdown.".into());
        }
        #[cfg(unix)]
        self.watchdog
            .lock()
            .map_err(|_| "Cannot lock agent process watchdog for shutdown.")?
            .stop();
        #[cfg(unix)]
        {
            let mut scratch = self
                .runtime_scratch
                .lock()
                .map_err(|_| "Cannot lock agent runtime scratch for shutdown.")?;
            if let Some(root) = scratch.as_mut() {
                root.cleanup_now()
                    .map_err(|error| format!("Agent runtime scratch cleanup failed: {error}"))?;
            }
            scratch.take();
        }
        if let Some(lease) = &self._storage_lease {
            lease.release_clean()?;
        }
        Ok(())
    }

    fn terminate(&self) -> Result<(), String> {
        let result = self.stop_child();
        self.alive.store(false, Ordering::Release);
        self.ready.notify_all();
        result
    }

    fn reusable(&self) -> bool {
        self.alive.load(Ordering::Acquire)
            && !self.stopped.load(Ordering::Acquire)
            && !self.idle_exit.load(Ordering::Acquire)
    }

    fn touch(&self) {
        if let Ok(mut last) = self.last_activity.lock() {
            *last = Instant::now();
        }
    }

    fn write(&self, message: &Value) -> Result<(), String> {
        self.touch();
        let mut input = self.input.lock().map_err(|error| error.to_string())?;
        let mut message = message.clone();
        if let Some(owner) = &self.owner {
            translate_session_ids(&mut message, owner, true);
        }
        serde_json::to_writer(&mut *input, &message).map_err(|error| error.to_string())?;
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

    /// An idle exit sent nothing the agent could have acted on, so callers may safely reattach
    /// and retry on this error.
    fn request_response_around_write(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        write_message: impl FnOnce(&Value) -> Result<(), String>,
        after_write: impl FnOnce(),
    ) -> Result<PendingResponse, String> {
        let result = self.dispatch_request(method, params, timeout, write_message, after_write);
        if !self.idle_exit.load(Ordering::Acquire) {
            return result;
        }
        match result {
            Err(_) => Err(IDLE_EXIT_ERROR.into()),
            Ok(mut response) => {
                if let Some(error) = response
                    .message
                    .get_mut("error")
                    .and_then(Value::as_object_mut)
                    .filter(|error| {
                        error.get("message").and_then(Value::as_str)
                            == Some("Agent process exited.")
                    })
                {
                    error.insert("message".into(), IDLE_EXIT_ERROR.into());
                }
                Ok(response)
            }
        }
    }

    fn dispatch_request(
        &self,
        method: &str,
        params: Value,
        timeout: Duration,
        write_message: impl FnOnce(&Value) -> Result<(), String>,
        after_write: impl FnOnce(),
    ) -> Result<PendingResponse, String> {
        if method.starts_with("session/") || method.starts_with("_session/") {
            self.validate_codex_workspace(params.get("cwd").and_then(Value::as_str))?;
        }

        let listing_dispatch = (method == "session/list")
            .then(|| {
                self.prompt_dispatch
                    .lock()
                    .map_err(|error| error.to_string())
            })
            .transpose()?;
        if self.idle_exit.load(Ordering::Acquire) {
            return Err(IDLE_EXIT_ERROR.into());
        }
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
        let temp_gate = self
            .temp_cleanup_gate
            .lock()
            .map_err(|error| error.to_string())?;
        self.pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id, sender);
        drop(temp_gate);
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
        drop(listing_dispatch);
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

fn stop_process(child: &mut Child) -> Result<(), String> {
    #[cfg(unix)]
    {
        crate::terminal::kill_terminal_process_groups(child.id())?;
    }
    #[cfg(windows)]
    {
        let result = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .map_err(|error| format!("Cannot start agent process-tree shutdown: {error}"))?;
        if !result.success()
            && child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
        {
            return Err(format!(
                "Cannot stop agent process tree (taskkill exited {result})."
            ));
        }
    }
    if child
        .try_wait()
        .map_err(|error| format!("Cannot inspect agent process: {error}"))?
        .is_none()
    {
        child
            .kill()
            .map_err(|error| format!("Cannot stop agent process: {error}"))?;
    }
    child
        .wait()
        .map_err(|error| format!("Cannot wait for agent process shutdown: {error}"))?;
    Ok(())
}

#[derive(Clone, Debug, Eq, Hash, PartialEq)]
struct ConnectionKey {
    worktree: PathBuf,
    agent: String,
    profile: CapabilityProfile,
    owner: Option<String>,
}

const OWNED_SESSION_PREFIX: &str = "sail-owned:";

fn owned_session_id(owner: &str, wire_id: &str) -> String {
    format!("{OWNED_SESSION_PREFIX}{owner}:{wire_id}")
}

fn session_owner(session_id: &str) -> Option<&str> {
    let rest = session_id.strip_prefix(OWNED_SESSION_PREFIX)?;
    let (owner, _) = rest.split_once(':')?;
    Uuid::parse_str(owner).ok()?;
    Some(owner)
}

fn translate_session_ids(value: &mut Value, owner: &str, to_wire: bool) {
    match value {
        Value::Object(fields) => {
            for (key, entry) in fields {
                if matches!(
                    key.as_str(),
                    "sessionId" | "subagentSessionId" | "parentSessionId"
                ) {
                    if let Some(id) = entry.as_str() {
                        let prefix = format!("{OWNED_SESSION_PREFIX}{owner}:");
                        if to_wire {
                            if let Some(wire_id) = id.strip_prefix(&prefix) {
                                *entry = Value::String(wire_id.to_string());
                            }
                        } else if !id.starts_with(&prefix) {
                            *entry = Value::String(owned_session_id(owner, id));
                        }
                    }
                } else {
                    translate_session_ids(entry, owner, to_wire);
                }
            }
        }
        Value::Array(items) => {
            for item in items {
                translate_session_ids(item, owner, to_wire);
            }
        }
        _ => {}
    }
}

/// Git roots by requested directory. Each ACP command resolves its worktree, and a `git`
/// spawn per call made every thread open pay for ten or more of them.
static WORKTREE_ROOTS: std::sync::LazyLock<Mutex<HashMap<PathBuf, PathBuf>>> =
    std::sync::LazyLock::new(Default::default);

fn worktree_identity(directory: &Path) -> PathBuf {
    let cached = WORKTREE_ROOTS
        .lock()
        .ok()
        .and_then(|roots| roots.get(directory).cloned())
        .filter(|root| root.join(".git").exists());
    let root = cached.unwrap_or_else(|| {
        let root = crate::terminal::git_worktree_root(directory);
        if root.join(".git").exists() {
            if let Ok(mut roots) = WORKTREE_ROOTS.lock() {
                roots.insert(directory.to_path_buf(), root.clone());
            }
        }
        root
    });
    crate::acp_terminal::stable_worktree_identity(&root)
}

fn connection_key(agent: &str, profile: CapabilityProfile, directory: &Path) -> ConnectionKey {
    connection_key_for_owner(agent, profile, directory, None)
}

fn connection_key_for_owner(
    agent: &str,
    profile: CapabilityProfile,
    directory: &Path,
    owner: Option<&str>,
) -> ConnectionKey {
    ConnectionKey {
        worktree: worktree_identity(directory),
        agent: agent.to_string(),
        profile,
        owner: owner.map(str::to_string),
    }
}

fn session_directory(runtime: &Connection, session_id: &str) -> Option<String> {
    runtime
        .session_directories
        .lock()
        .ok()?
        .get(session_id)
        .map(|path| path.to_string_lossy().into_owned())
}

fn runtime_environment(
    data_directory: &Path,
    temp_directory: &Path,
    runtime_scratch: Option<&Path>,
    shared_build_directory: Option<&Path>,
) -> Vec<(&'static str, PathBuf)> {
    let owned_temp = runtime_scratch.map(|scratch| scratch.join("tmp"));
    let temp_directory = owned_temp.as_deref().unwrap_or(temp_directory);
    let mut environment = crate::acp_terminal::terminal_environment(data_directory, temp_directory);
    let shared_download_cache = data_directory
        .parent()
        .and_then(Path::parent)
        .unwrap_or(data_directory)
        .join("terminal-package-downloads");
    let build_directory = shared_build_directory
        .map(Path::to_path_buf)
        .unwrap_or_else(|| runtime_scratch.unwrap_or(data_directory).join("build"));
    environment.extend([
        ("CARGO_TARGET_DIR", build_directory.join("cargo-target")),
        ("GOCACHE", build_directory.join("go-cache")),
        ("GOTMPDIR", temp_directory.join("go-tmp")),
        ("NPM_CONFIG_CACHE", shared_download_cache.join("npm")),
        ("YARN_CACHE_FOLDER", shared_download_cache.join("yarn")),
        ("COREPACK_HOME", shared_download_cache.join("corepack")),
        ("UV_TOOL_DIR", data_directory.join("uv-tools")),
        ("UV_TOOL_BIN_DIR", data_directory.join("bin")),
    ]);
    environment
}

/// Directories Sail may put ahead of the inherited PATH, whether or not they exist yet.
fn configured_tool_candidates(
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    windows: bool,
) -> Vec<PathBuf> {
    let mut paths = Vec::new();
    if windows {
        if let Some(local) = local_app_data {
            paths.push(local.join("mise/shims"));
        }
    } else if let Some(home) = home {
        paths.push(home.join(".local/share/mise/shims"));
    }
    if let Some(home) = home {
        paths.extend([home.join(".local/bin"), home.join(".cargo/bin")]);
    }
    paths
}

fn configured_tool_paths(
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    windows: bool,
) -> Vec<PathBuf> {
    configured_tool_candidates(home, local_app_data, windows)
        .into_iter()
        .filter(|path| path.is_dir())
        .collect()
}

fn default_gnupg_directory(home: Option<&Path>) -> Option<PathBuf> {
    let directory = home?.join(".gnupg");
    std::fs::symlink_metadata(&directory)
        .ok()?
        .file_type()
        .is_dir()
        .then_some(directory)
}

/// Ship It keeps its checkpoints, and the lock files next to them, here. Only
/// this directory is shared, not the XDG data root or its siblings.
fn ship_it_checkpoint_directory(data_home: Option<&Path>, home: Option<&Path>) -> Option<PathBuf> {
    let root = match data_home {
        Some(path) if path.is_absolute() => path.to_path_buf(),
        Some(path) if !path.as_os_str().is_empty() => return None,
        _ => home?.join(".local/share"),
    };
    let directory = root.join("sai/ship-it/checkpoints");
    let mut builder = std::fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    std::os::unix::fs::DirBuilderExt::mode(&mut builder, 0o700);
    builder.create(&directory).ok()?;
    let is_directory = std::fs::symlink_metadata(&directory)
        .ok()?
        .file_type()
        .is_dir();
    (is_directory && WritableDirectory::capture(&directory).is_ok()).then_some(directory)
}

fn user_writable_directories(home: Option<&Path>, data_home: Option<&Path>) -> Vec<PathBuf> {
    default_gnupg_directory(home)
        .into_iter()
        .chain(ship_it_checkpoint_directory(data_home, home))
        .collect()
}

/// Identity of the tool environment every agent-owned surface of a worktree shares. It hashes
/// the candidate tool directories, not only the existing ones, so creating `~/.local/bin`
/// mid-gate does not change the identity of a worktree.
pub(crate) fn tool_environment_id(data_directory: &Path) -> String {
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    environment_id_for(
        data_directory,
        home.as_deref(),
        local_app_data.as_deref(),
        cfg!(windows),
    )
}

fn environment_id_for(
    data_directory: &Path,
    home: Option<&Path>,
    local_app_data: Option<&Path>,
    windows: bool,
) -> String {
    crate::acp_terminal::environment_identity(
        data_directory,
        &configured_tool_candidates(home, local_app_data, windows),
    )
}

fn agent_path(
    mut paths: Vec<PathBuf>,
    scoped_tool_bin: PathBuf,
    original: &std::ffi::OsStr,
) -> Result<std::ffi::OsString, String> {
    let scoped_index = usize::from(
        paths
            .first()
            .is_some_and(|path| path.ends_with(Path::new("mise/shims"))),
    );
    paths.insert(scoped_index, scoped_tool_bin);
    std::env::join_paths(paths.into_iter().chain(std::env::split_paths(original)))
        .map_err(|error| error.to_string())
}

#[cfg(unix)]
fn gate_build_directory(
    root: &Path,
    revision: &str,
    gate_owner: &str,
    shared_busy: bool,
) -> PathBuf {
    use sha2::{Digest, Sha256};
    let revision_key = Sha256::digest(revision.as_bytes())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    let shared = root.join("build").join(format!("target-{revision_key}"));
    if shared_busy {
        shared.join(format!("concurrent-{gate_owner}"))
    } else {
        shared
    }
}

fn prepare_runtime_directories(data_directory: &Path, temp_directory: &Path) -> Result<(), String> {
    for directory in [
        temp_directory.to_path_buf(),
        data_directory.join("cache"),
        data_directory.join("build"),
        data_directory.join("bin"),
        data_directory.join("uv-tools"),
        temp_directory.join("go-tmp"),
    ] {
        std::fs::create_dir_all(directory).map_err(|error| error.to_string())?;
    }
    Ok(())
}

#[derive(Eq, Hash, PartialEq)]
struct ForgetGenerationKey {
    agent: String,
    directory: PathBuf,
    session_id: String,
}

impl ForgetGenerationKey {
    fn new(agent: &str, directory: &str, session_id: &str) -> Self {
        Self {
            agent: agent.to_string(),
            directory: canonical_directory(directory),
            session_id: session_id.to_string(),
        }
    }
}

type ForgetGenerations = HashMap<ForgetGenerationKey, u64>;

fn retryable_process_cleanup_sessions(
    failed: &HashSet<String>,
    prompts: &PromptState,
    cancelled_turns: &HashSet<String>,
) -> Vec<(String, bool)> {
    let busy = !prompts.active.is_empty() || !prompts.finishing.is_empty();
    failed
        .iter()
        .filter_map(|session_id| {
            let cancelled_and_finishing = prompts.finishing.contains(session_id)
                && prompts
                    .active
                    .get(session_id)
                    .is_some_and(|prompt| cancelled_turns.contains(&prompt.turn_id));
            (!busy || cancelled_and_finishing)
                .then(|| (session_id.clone(), cancelled_and_finishing))
        })
        .collect()
}

#[derive(Clone, Default)]
pub struct AgentManager(
    Arc<Mutex<HashMap<ConnectionKey, Arc<Connection>>>>,
    Arc<Mutex<ForgetGenerations>>,
    Arc<Mutex<HashMap<PathBuf, Weak<Mutex<()>>>>>,
    Arc<AtomicU64>,
    /// Serializes listing-agent startup so a sidebar refresh spawns one agent, not one per directory.
    Arc<Mutex<()>>,
);

/// True while a live connection builds inside `root`, as a gate does under the
/// runtime scratch of the agent that started it.
#[cfg(unix)]
pub(crate) fn runtime_root_in_use(manager: &AgentManager, root: &Path) -> bool {
    let Ok(connections) = manager.0.lock() else {
        return true;
    };
    connections.values().any(|runtime| {
        runtime.alive.load(Ordering::Acquire)
            && runtime
                .shared_build_directory
                .as_deref()
                .is_some_and(|directory| directory.starts_with(root))
    })
}

impl AgentManager {
    fn worktree_startup(&self, worktree: &Path) -> Result<Arc<Mutex<()>>, String> {
        let mut startups = self.2.lock().map_err(|error| error.to_string())?;
        startups.retain(|_, startup| startup.strong_count() > 0);
        if let Some(startup) = startups.get(worktree).and_then(Weak::upgrade) {
            return Ok(startup);
        }
        let startup = Arc::new(Mutex::new(()));
        startups.insert(worktree.to_path_buf(), Arc::downgrade(&startup));
        Ok(startup)
    }

    pub fn retry_turn_temp_cleanup(&self, app: &AppHandle) {
        let connections = self
            .0
            .lock()
            .ok()
            .map(|agents| agents.values().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        for connection in connections {
            let process_retry = (|| -> Result<(), String> {
                let mut temp_gate = connection
                    .temp_cleanup_gate
                    .lock()
                    .map_err(|error| error.to_string())?;
                if temp_gate.failed_process_sessions.is_empty() {
                    return Ok(());
                }
                let prompts = connection
                    .prompt_state
                    .lock()
                    .map_err(|error| error.to_string())?;
                let cancelled_turns = connection
                    .cancelled_prompts
                    .lock()
                    .map_err(|error| error.to_string())?;
                let sessions = retryable_process_cleanup_sessions(
                    &temp_gate.failed_process_sessions,
                    &prompts,
                    &cancelled_turns,
                );
                drop(cancelled_turns);
                drop(prompts);
                let mut cancelled_retry_succeeded = false;
                for (session_id, cancelled_and_finishing) in sessions {
                    if cleanup_session_processes(app, &connection, &connection.agent, &session_id) {
                        temp_gate.failed_process_sessions.remove(&session_id);
                        cancelled_retry_succeeded |= cancelled_and_finishing;
                    }
                }
                if cancelled_retry_succeeded && temp_gate.failed_process_sessions.is_empty() {
                    if let Some(lease) = &connection._storage_lease {
                        lease.mark_temp_pending("turn-temp-owner-unverified");
                    }
                }
                Ok(())
            })();
            if let Err(error) = process_retry {
                crate::diagnostics::record(
                    "turn_temp_cleanup_failed",
                    json!({"agent":connection.agent,"error":error}),
                );
                continue;
            }
            if let Err(error) = connection.clear_idle_temp(false) {
                if let Some(lease) = &connection._storage_lease {
                    lease.mark_temp_pending("turn-temp-cleanup-failed");
                }
                crate::diagnostics::record(
                    "turn_temp_cleanup_failed",
                    json!({"agent":connection.agent,"error":error}),
                );
            }
        }
    }

    fn forget_generation(
        &self,
        agent: &str,
        directory: &str,
        session_id: &str,
    ) -> Result<u64, String> {
        Ok(*self
            .1
            .lock()
            .map_err(|error| error.to_string())?
            .get(&ForgetGenerationKey::new(agent, directory, session_id))
            .unwrap_or(&0))
    }

    fn mark_forget(&self, agent: &str, directory: &str, session_id: &str) -> Result<(), String> {
        *self
            .1
            .lock()
            .map_err(|error| error.to_string())?
            .entry(ForgetGenerationKey::new(agent, directory, session_id))
            .or_default() += 1;
        Ok(())
    }

    fn with_current_forget_generation<T>(
        &self,
        agent: &str,
        directory: &str,
        session_id: &str,
        expected: u64,
        operation: impl FnOnce() -> Result<T, String>,
    ) -> Result<T, String> {
        let generations = self.1.lock().map_err(|error| error.to_string())?;
        if generations
            .get(&ForgetGenerationKey::new(agent, directory, session_id))
            .copied()
            .unwrap_or(0)
            != expected
        {
            return Err("This agent thread was deleted while reconnecting.".into());
        }
        let result = operation();
        drop(generations);
        result
    }

    pub(crate) fn active_sessions_in(
        &self,
        directory: &Path,
    ) -> Result<Vec<(String, PathBuf, String)>, String> {
        let agents = self.0.lock().map_err(|error| error.to_string())?;
        let mut active = Vec::new();
        for (key, runtime) in agents.iter() {
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
                        directories.get(*session_id).is_some_and(|path| {
                            crate::acp_terminal::worktree_contains(directory, path)
                        })
                    })
                    .filter_map(|session_id| {
                        directories.get(session_id).map(|_path| {
                            (key.agent.clone(), key.worktree.clone(), session_id.clone())
                        })
                    }),
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
                    .map(|session_id| (key.agent.clone(), key.worktree.clone(), session_id)),
            );
        }
        active.sort();
        active.dedup();
        Ok(active)
    }

    pub(crate) fn sessions_blocking_cleanup_in(
        &self,
        directory: &Path,
    ) -> Result<Vec<(String, PathBuf, String)>, String> {
        let mut sessions = self.active_sessions_in(directory)?;
        let agents = self.0.lock().map_err(|error| error.to_string())?;
        for (key, runtime) in agents.iter() {
            let directories = runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?;
            sessions.extend(
                directories
                    .iter()
                    .filter(|(_, path)| crate::acp_terminal::worktree_contains(directory, path))
                    .map(|(session, _)| (key.agent.clone(), key.worktree.clone(), session.clone())),
            );
        }
        sessions.sort();
        sessions.dedup();
        Ok(sessions)
    }

    fn native_subagent_snapshots(
        &self,
        directory: &Path,
    ) -> Result<Vec<NativeSubagentSnapshot>, String> {
        let agents = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut snapshots = Vec::new();
        for runtime in &agents {
            let prompts = runtime
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?;
            let children = runtime
                .native_subagents
                .lock()
                .map_err(|error| error.to_string())?
                .snapshots(&runtime.agent, runtime.profile, directory);
            for mut child in children {
                if !runtime.alive.load(Ordering::Acquire) {
                    child.task_turn_id = None;
                    if !matches!(
                        child.outcome.as_str(),
                        "completed" | "failed" | "interrupted"
                    ) {
                        child.outcome = "unknown".into();
                    }
                } else if child.task_identity == "verified" {
                    if let Some(prompt) = prompts.active.get(&child.session_id) {
                        child.task_turn_id = Some(prompt.turn_id.clone());
                    }
                }
                snapshots.push(child);
            }
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
                self.3.fetch_add(1, Ordering::AcqRel);
                agents
                    .drain()
                    .map(|(_, runtime)| runtime)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for runtime in connections {
            let _ = runtime.terminate();
        }
    }

    pub fn stop_worktree(&self, worktree: &Path) -> Result<(), String> {
        let worktree = worktree_identity(worktree);
        let startup = self.worktree_startup(&worktree)?;
        let _startup = startup.lock().map_err(|error| error.to_string())?;
        let keys = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .keys()
            .filter(|key| crate::acp_terminal::worktree_contains(&worktree, &key.worktree))
            .cloned()
            .collect::<Vec<_>>();
        for key in keys {
            let runtime = self
                .0
                .lock()
                .map_err(|error| error.to_string())?
                .get(&key)
                .cloned();
            let Some(runtime) = runtime else { continue };
            runtime.terminate()?;
            let mut agents = self.0.lock().map_err(|error| error.to_string())?;
            if agents
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &runtime))
            {
                agents.remove(&key);
            }
        }
        Ok(())
    }

    fn stop_owner(&self, worktree: &Path, owner: &str) -> Result<(), String> {
        Uuid::parse_str(owner).map_err(|_| "Invalid agent run owner ID.")?;
        let worktree = worktree_identity(worktree);
        let startup = self.worktree_startup(&worktree)?;
        let _startup = startup.lock().map_err(|error| error.to_string())?;
        let runtimes = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .filter(|(key, _)| key.worktree == worktree && key.owner.as_deref() == Some(owner))
            .map(|(key, runtime)| (key.clone(), Arc::clone(runtime)))
            .collect::<Vec<_>>();
        for (key, runtime) in runtimes {
            if !runtime
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?
                .active
                .is_empty()
            {
                return Err("Agent run still has an active turn.".into());
            }
            if !runtime
                .native_subagents
                .lock()
                .map_err(|error| error.to_string())?
                .active_in(&worktree)
                .is_empty()
            {
                return Err("Agent run still has an active native subagent.".into());
            }
            #[cfg(unix)]
            if let Some(root) = runtime
                .runtime_scratch
                .lock()
                .map_err(|error| error.to_string())?
                .as_ref()
                .map(|scratch| scratch.path().to_path_buf())
            {
                let dependent_gate = self
                    .0
                    .lock()
                    .map_err(|error| error.to_string())?
                    .values()
                    .any(|other| {
                        !Arc::ptr_eq(other, &runtime)
                            && other.alive.load(Ordering::Acquire)
                            && other
                                .shared_build_directory
                                .as_ref()
                                .is_some_and(|directory| directory.starts_with(&root))
                    });
                if dependent_gate {
                    return Err("Agent run still has an active validation gate.".into());
                }
            }
            runtime.released_owner.store(true, Ordering::Release);
            if let Err(error) = runtime.terminate() {
                if !runtime.stopped.load(Ordering::Acquire) {
                    runtime.released_owner.store(false, Ordering::Release);
                }
                return Err(error);
            }
            let mut agents = self.0.lock().map_err(|error| error.to_string())?;
            if agents
                .get(&key)
                .is_some_and(|current| Arc::ptr_eq(current, &runtime))
            {
                agents.remove(&key);
            }
        }
        Ok(())
    }

    pub fn worktree_roots_in(&self, worktree: &Path) -> Result<Vec<PathBuf>, String> {
        let worktree = worktree_identity(worktree);
        let agents = self.0.lock().map_err(|error| error.to_string())?;
        let mut roots = agents
            .keys()
            .filter(|key| crate::acp_terminal::worktree_contains(&worktree, &key.worktree))
            .map(|key| key.worktree.clone())
            .collect::<Vec<_>>();
        roots.sort();
        roots.dedup();
        Ok(roots)
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
pub async fn acp_release_owner(
    manager: State<'_, AgentManager>,
    directory: String,
    owner: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || manager.stop_owner(Path::new(&directory), &owner))
        .await
        .map_err(|error| error.to_string())?
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
    finishing: HashSet<String>,
    finished: HashMap<String, PromptOutcome>,
    forgotten: HashSet<String>,
    forget_generation: HashMap<String, u64>,
    pending_forgets: HashMap<String, usize>,
    committed_forgets: HashSet<String>,
    tool_turns: HashMap<String, HashMap<String, String>>,
    retired_tool_turns: HashMap<String, VecDeque<(String, String)>>,
}

struct CancellationPlan {
    turn_id: Option<String>,
    cleanup_current: bool,
    await_settlement: bool,
    track_prompt: bool,
}

impl PromptState {
    const ACTIVE_TOOL_TURN_LIMIT: usize = 512;
    const RETIRED_TOOL_TURN_LIMIT: usize = 4096;

    fn mark_forgotten(&mut self, session_id: &str) {
        self.forgotten.insert(session_id.to_string());
        *self
            .pending_forgets
            .entry(session_id.to_string())
            .or_default() += 1;
        *self
            .forget_generation
            .entry(session_id.to_string())
            .or_default() += 1;
    }

    fn finish_forget(&mut self, session_id: &str, committed: bool) {
        let Some(pending) = self.pending_forgets.get_mut(session_id) else {
            return;
        };
        *pending -= 1;
        if *pending == 0 {
            self.pending_forgets.remove(session_id);
        }
        if committed {
            self.committed_forgets.insert(session_id.to_string());
        } else if !self.pending_forgets.contains_key(session_id)
            && !self.committed_forgets.contains(session_id)
        {
            self.forgotten.remove(session_id);
        }
    }

    fn ensure_prompt_available(&self, session_id: &str) -> Result<(), String> {
        if self.forgotten.contains(session_id) {
            return Err("This agent thread was deleted.".into());
        }
        Ok(())
    }

    fn complete_restore(&mut self, session_id: &str, generation: u64) -> Result<(), String> {
        if self.forget_generation.get(session_id).copied().unwrap_or(0) != generation {
            return Err("This agent thread was deleted while reconnecting.".into());
        }
        if self.pending_forgets.contains_key(session_id) {
            return Err("This agent thread is being deleted.".into());
        }
        self.forgotten.remove(session_id);
        self.committed_forgets.remove(session_id);
        Ok(())
    }

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

    fn cancellation_plan(
        &self,
        session_id: &str,
        requested_turn: Option<String>,
    ) -> CancellationPlan {
        let active = self.active.get(session_id);
        let finished = self.finished.get(session_id);
        let turn_id = requested_turn.or_else(|| {
            active
                .map(|prompt| prompt.turn_id.clone())
                .or_else(|| finished.map(|prompt| prompt.turn_id.clone()))
        });
        let cleanup_current = turn_id
            .as_deref()
            .zip(active)
            .is_some_and(|(turn_id, prompt)| prompt.turn_id == turn_id);
        let await_settlement = turn_id.as_deref().is_some_and(|turn_id| {
            active.is_some_and(|prompt| prompt.turn_id == turn_id && prompt.dispatched)
                || finished.is_some_and(|prompt| prompt.turn_id == turn_id)
        });
        let track_prompt = cleanup_current
            || (turn_id.is_some()
                && active.is_none()
                && !turn_id
                    .as_deref()
                    .zip(finished)
                    .is_some_and(|(turn_id, prompt)| prompt.turn_id == turn_id));
        CancellationPlan {
            turn_id,
            cleanup_current,
            await_settlement,
            track_prompt,
        }
    }
}

fn prepare_session_cancellation(
    prompts: &mut PromptState,
    cancelled_prompts: &mut HashSet<String>,
    permissions: &mut PermissionState,
    session_id: &str,
    requested_turn: Option<String>,
) -> CancellationPlan {
    let plan = prompts.cancellation_plan(session_id, requested_turn);
    if plan.cleanup_current || plan.await_settlement {
        let turn_id = plan.turn_id.as_deref().expect("matched cancellation turn");
        prompts.retire_turn(session_id, turn_id);
    }
    if plan.cleanup_current {
        prompts.finishing.insert(session_id.to_string());
    }
    if plan.track_prompt {
        let turn_id = plan.turn_id.as_ref().expect("tracked cancellation turn");
        cancelled_prompts.insert(turn_id.clone());
    }
    if plan.await_settlement {
        permissions.begin_cancel(session_id, plan.turn_id.as_deref());
    }
    plan
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
    dispatched: bool,
    memory_capture: crate::memory_capture::TurnCapture,
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

fn retry_completed_turn_evidence(
    mut write: impl FnMut() -> Result<(), String>,
    mut report: impl FnMut(&str),
    mut pause: impl FnMut(Duration),
    attempts: usize,
) -> Result<(), String> {
    let mut delay = Duration::from_millis(50);
    for attempt in 0..attempts {
        match write() {
            Ok(()) => return Ok(()),
            Err(error) => {
                report(&error);
                if attempt + 1 == attempts {
                    return Err(error);
                }
            }
        }
        pause(delay);
        delay = delay.saturating_mul(2).min(Duration::from_secs(2));
    }
    Err("No completion evidence write was attempted.".into())
}

async fn retry_completion_evidence_after_cleanup<F, R, P, Fut, S>(
    mut write: F,
    mut report: R,
    mut pause: P,
    on_saved: S,
) where
    F: FnMut() -> Result<(), String>,
    R: FnMut(&str),
    P: FnMut(Duration) -> Fut,
    Fut: std::future::Future<Output = ()>,
    S: FnOnce(),
{
    let mut delay = Duration::from_millis(50);
    loop {
        match write() {
            Ok(()) => {
                on_saved();
                return;
            }
            Err(error) => report(&error),
        }
        pause(delay).await;
        delay = delay.saturating_mul(2).min(Duration::from_secs(2));
    }
}

impl ActivePrompt {
    fn observe_update(&mut self, update: &Value) {
        match update.get("sessionUpdate").and_then(Value::as_str) {
            Some("agent_message_chunk") => {
                if let Some(text) = update.pointer("/content/text").and_then(Value::as_str) {
                    self.memory_capture.push(text, !self.agent_message_open);
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
    use std::cell::Cell;

    fn prompt() -> ActivePrompt {
        ActivePrompt {
            turn_id: "turn".into(),
            text: "task".into(),
            dispatched: false,
            memory_capture: crate::memory_capture::TurnCapture::default(),
            last_agent_message: String::new(),
            agent_message_open: false,
            agent_message_overflow: false,
            known_tool_calls: HashSet::new(),
        }
    }

    #[test]
    fn forgetting_waits_for_the_cancelled_turn_to_settle() {
        let mut prompts = PromptState::default();
        prompts.active.insert("target".into(), prompt());
        let state = Arc::new(Mutex::new(prompts));
        let settling = Arc::clone(&state);
        let settled = std::thread::spawn(move || {
            std::thread::sleep(Duration::from_millis(150));
            settling.lock().unwrap().active.remove("target");
        });
        let started = Instant::now();
        let mut cancelled = false;

        cancel_before_forget(
            &state,
            &Mutex::new(()),
            "target",
            || {
                cancelled = true;
                Ok(())
            },
            Duration::from_secs(1),
        )
        .unwrap();

        settled.join().unwrap();
        assert!(cancelled);
        assert!(started.elapsed() >= Duration::from_millis(150));
        assert!(!state.lock().unwrap().active.contains_key("target"));
        assert!(state.lock().unwrap().forgotten.contains("target"));
        state.lock().unwrap().finish_forget("target", true);
        assert!(state
            .lock()
            .unwrap()
            .ensure_prompt_available("target")
            .is_err());
    }

    #[test]
    fn forgetting_keeps_the_turn_active_when_cancel_fails() {
        let mut prompts = PromptState::default();
        prompts.active.insert("target".into(), prompt());
        let state = Mutex::new(prompts);

        let result = cancel_before_forget(
            &state,
            &Mutex::new(()),
            "target",
            || Err("cancel failed".into()),
            Duration::from_secs(1),
        );

        assert_eq!(result.unwrap_err(), "cancel failed");
        assert!(state.lock().unwrap().active.contains_key("target"));
        assert!(!state.lock().unwrap().forgotten.contains("target"));
        state.lock().unwrap().active.remove("target");
        assert!(state
            .lock()
            .unwrap()
            .ensure_prompt_available("target")
            .is_ok());
    }

    #[test]
    fn timeout_keeps_token_and_allows_prompt_after_turn_settles() {
        let mut prompts = PromptState::default();
        prompts.active.insert("target".into(), prompt());
        let state = Mutex::new(prompts);

        let result =
            cancel_before_forget(&state, &Mutex::new(()), "target", || Ok(()), Duration::ZERO);

        assert_eq!(
            result.unwrap_err(),
            "Agent turn did not stop; browser token remains active."
        );
        assert!(!state.lock().unwrap().forgotten.contains("target"));
        state.lock().unwrap().active.remove("target");
        assert!(state
            .lock()
            .unwrap()
            .ensure_prompt_available("target")
            .is_ok());
    }

    #[test]
    fn cancel_before_prompt_write_fences_late_dispatch() {
        let mut prompts = PromptState::default();
        prompts.active.insert("target".into(), prompt());
        let state = Arc::new(Mutex::new(prompts));
        let dispatch = Arc::new(Mutex::new(()));
        let waiting = Arc::clone(&state);
        let waiting_dispatch = Arc::clone(&dispatch);
        let (cancelled, observed) = mpsc::channel();
        let forget = std::thread::spawn(move || {
            cancel_before_forget(
                &waiting,
                &waiting_dispatch,
                "target",
                || {
                    cancelled.send(()).unwrap();
                    Ok(())
                },
                Duration::from_secs(1),
            )
        });
        observed.recv_timeout(Duration::from_secs(1)).unwrap();

        let mut wrote_prompt = false;
        let result = dispatch_prompt_if_current(&dispatch, &state, "target", "turn", || {
            wrote_prompt = true;
            Ok(())
        });
        assert!(result.is_err());
        assert!(!wrote_prompt);
        state.lock().unwrap().active.remove("target");
        forget.join().unwrap().unwrap();
        state.lock().unwrap().finish_forget("target", true);
        assert!(state
            .lock()
            .unwrap()
            .ensure_prompt_available("target")
            .is_err());
    }

    #[test]
    fn failed_forget_cannot_clear_another_pending_or_committed_deletion() {
        let mut prompts = PromptState::default();
        prompts.mark_forgotten("target");
        prompts.mark_forgotten("target");

        prompts.finish_forget("target", false);
        assert!(prompts.ensure_prompt_available("target").is_err());
        assert!(prompts.complete_restore("target", 2).is_err());
        prompts.finish_forget("target", true);
        assert!(prompts.ensure_prompt_available("target").is_err());

        prompts.mark_forgotten("target");
        prompts.finish_forget("target", false);
        assert!(prompts.ensure_prompt_available("target").is_err());

        let mut retryable = PromptState::default();
        retryable.mark_forgotten("target");
        retryable.mark_forgotten("target");
        retryable.finish_forget("target", false);
        assert!(retryable.ensure_prompt_available("target").is_err());
        retryable.finish_forget("target", false);
        assert!(retryable.ensure_prompt_available("target").is_ok());
    }

    #[test]
    fn forgetting_idle_session_fences_late_turns() {
        let state = Mutex::new(PromptState::default());

        cancel_before_forget(
            &state,
            &Mutex::new(()),
            "target",
            || panic!("idle session must not be cancelled"),
            Duration::ZERO,
        )
        .unwrap();

        assert!(state.lock().unwrap().forgotten.contains("target"));
    }

    #[test]
    fn restore_started_before_forget_cannot_revive_deleted_session() {
        let manager = AgentManager::default();
        let directory = "/example/worktree";
        let manager_generation = manager
            .forget_generation("claude", directory, "target")
            .unwrap();
        let prompts = Mutex::new(PromptState::default());
        manager.mark_forget("claude", directory, "target").unwrap();
        prompts.lock().unwrap().mark_forgotten("target");
        prompts.lock().unwrap().finish_forget("target", true);
        // The restore reaches the runtime after deletion, so its local snapshot is current.
        let restore_generation = prompts.lock().unwrap().forget_generation["target"];

        assert_ne!(
            manager
                .forget_generation("claude", directory, "target")
                .unwrap(),
            manager_generation
        );
        assert_eq!(restore_generation, 1);
        assert!(complete_restore_if_current(
            &manager,
            &prompts,
            "claude",
            directory,
            "target",
            manager_generation,
            restore_generation,
        )
        .is_err());
        assert!(prompts.lock().unwrap().forgotten.contains("target"));
        let explicit_restore_generation = manager
            .forget_generation("claude", directory, "target")
            .unwrap();
        assert_eq!(explicit_restore_generation, 1);
        assert!(complete_restore_if_current(
            &manager,
            &prompts,
            "claude",
            directory,
            "target",
            explicit_restore_generation,
            restore_generation,
        )
        .is_ok());
        assert!(!prompts.lock().unwrap().forgotten.contains("target"));
    }

    #[test]
    fn deletion_during_connect_prevents_late_registration_and_token_creation() {
        let manager = AgentManager::default();
        let directory = "/example/worktree";
        let started_generation = manager
            .forget_generation("claude", directory, "target")
            .unwrap();
        // Forget sees no connection while connect_blocking is still in progress.
        manager.mark_forget("claude", directory, "target").unwrap();
        let mut registered_or_minted = false;

        let stale = manager.with_current_forget_generation(
            "claude",
            directory,
            "target",
            started_generation,
            || {
                registered_or_minted = true;
                Ok(())
            },
        );

        assert!(stale.is_err());
        assert!(!registered_or_minted);
        let explicit_generation = manager
            .forget_generation("claude", directory, "target")
            .unwrap();
        manager
            .with_current_forget_generation(
                "claude",
                directory,
                "target",
                explicit_generation,
                || {
                    registered_or_minted = true;
                    Ok(())
                },
            )
            .unwrap();
        assert!(registered_or_minted);
    }

    #[test]
    fn restore_already_using_runtime_cannot_clear_later_forget() {
        let mut prompts = PromptState::default();
        let restore_generation = prompts
            .forget_generation
            .get("target")
            .copied()
            .unwrap_or(0);
        prompts.mark_forgotten("target");

        assert!(prompts
            .complete_restore("target", restore_generation)
            .is_err());
        assert!(prompts.forgotten.contains("target"));
    }

    #[test]
    fn prompt_cleanup_finishes_before_next_turn_can_start() {
        let mut prompts = PromptState::default();
        prompts.active.insert("target".into(), prompt());
        let state = Mutex::new(prompts);
        let finished = finish_prompt_after_cleanup(
            &state,
            "target",
            "turn",
            PromptOutcome {
                status: "done",
                notify: true,
                error: None,
                turn_id: "turn".into(),
            },
            || {
                let prompts = state.lock().unwrap();
                assert!(prompts.active.contains_key("target"));
                assert!(prompts.finishing.contains("target"));
                drop(prompts);
                assert!(with_active_terminal_prompt_state(&state, "target", || Ok(())).is_err());
            },
        );

        assert!(finished);
        let prompts = state.lock().unwrap();
        assert!(!prompts.active.contains_key("target"));
        assert_eq!(prompts.finished.get("target").unwrap().turn_id, "turn");
    }

    #[test]
    fn terminal_creation_requires_an_active_turn() {
        let mut prompts = PromptState::default();
        prompts.active.insert("target".into(), prompt());
        let state = Mutex::new(prompts);
        assert!(with_active_terminal_prompt_state(&state, "target", || Ok(())).is_ok());
        assert!(with_active_terminal_prompt_state(&state, "other", || Ok(())).is_err());
        state.lock().unwrap().active.remove("target");
        assert!(with_active_terminal_prompt_state(&state, "target", || Ok(())).is_err());
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
    fn cancelling_before_prompt_dispatch_does_not_wait_for_settlement() {
        let mut prompts = PromptState::default();
        prompts.active.insert("target".into(), prompt());
        let mut cancelled = HashSet::new();
        let mut permissions = PermissionState::default();

        let plan = prepare_session_cancellation(
            &mut prompts,
            &mut cancelled,
            &mut permissions,
            "target",
            Some("turn".into()),
        );

        assert_eq!(plan.turn_id.as_deref(), Some("turn"));
        assert!(plan.cleanup_current);
        assert!(!plan.await_settlement);
        assert!(plan.track_prompt);
        assert!(prompts.finishing.contains("target"));
        assert!(cancelled.contains("turn"));
        assert!(permissions.begin_turn("target", 0));
    }

    #[test]
    fn cancelling_before_prompt_registration_does_not_wait_for_settlement() {
        let mut prompts = PromptState::default();
        let mut cancelled = HashSet::new();
        let mut permissions = PermissionState::default();

        let plan = prepare_session_cancellation(
            &mut prompts,
            &mut cancelled,
            &mut permissions,
            "target",
            Some("turn".into()),
        );

        assert_eq!(plan.turn_id.as_deref(), Some("turn"));
        assert!(!plan.cleanup_current);
        assert!(!plan.await_settlement);
        assert!(plan.track_prompt);
        assert!(cancelled.contains("turn"));
        assert!(permissions.begin_turn("target", 0));
    }

    #[test]
    fn cancelling_a_dispatched_prompt_waits_for_its_response() {
        let mut prompts = PromptState::default();
        let mut active = prompt();
        active.dispatched = true;
        prompts.active.insert("target".into(), active);
        let mut cancelled = HashSet::new();
        let mut permissions = PermissionState::default();

        let plan = prepare_session_cancellation(
            &mut prompts,
            &mut cancelled,
            &mut permissions,
            "target",
            Some("turn".into()),
        );

        assert_eq!(plan.turn_id.as_deref(), Some("turn"));
        assert!(plan.cleanup_current);
        assert!(plan.await_settlement);
        assert!(plan.track_prompt);
        assert!(!permissions.begin_turn("target", 0));
    }

    #[test]
    fn stale_turn_cancellation_does_not_cancel_the_replacement() {
        let mut prompts = PromptState::default();
        let mut active = prompt();
        active.turn_id = "replacement".into();
        active.dispatched = true;
        prompts.active.insert("target".into(), active);
        let mut cancelled = HashSet::new();
        let mut permissions = PermissionState::default();

        let plan = prepare_session_cancellation(
            &mut prompts,
            &mut cancelled,
            &mut permissions,
            "target",
            Some("stale".into()),
        );

        assert_eq!(plan.turn_id.as_deref(), Some("stale"));
        assert!(!plan.cleanup_current);
        assert!(!plan.await_settlement);
        assert!(!plan.track_prompt);
        assert!(!prompts.finishing.contains("target"));
        assert!(!cancelled.contains("stale"));
        assert!(permissions.begin_turn("target", 0));
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
        let plan = prompts.cancellation_plan("target", None);
        assert!(plan.await_settlement);
        assert!(!plan.track_prompt);
        let cancelled_turn = plan.turn_id;
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
    fn native_cancel_without_turn_fences_only_target_until_terminal() {
        let mut state = PermissionState::default();
        state.begin_native_cancel("target");
        let mut resolved = Vec::new();

        state
            .record(
                json!({"id":1,"params":{"sessionId":"target"}}),
                1,
                None,
                |request_id| {
                    resolved.push(request_id.clone());
                    Ok(())
                },
            )
            .unwrap();
        state
            .record(
                json!({"id":2,"params":{"sessionId":"sibling"}}),
                2,
                None,
                |request_id| {
                    resolved.push(request_id.clone());
                    Ok(())
                },
            )
            .unwrap();

        assert_eq!(resolved, [json!(1)]);
        assert!(!state.pending.contains_key("1"));
        assert!(state.pending.contains_key("2"));

        state.end_native_cancel("target");
        state
            .record(
                json!({"id":3,"params":{"sessionId":"target"}}),
                3,
                None,
                |request_id| {
                    resolved.push(request_id.clone());
                    Ok(())
                },
            )
            .unwrap();

        assert_eq!(resolved, [json!(1)]);
        assert!(state.pending.contains_key("3"));
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
    fn transient_completion_write_failure_delays_finished_event_until_evidence_is_durable() {
        let attempts = Cell::new(0);
        let reports = Cell::new(0);
        let pauses = Cell::new(0);
        let finished = Cell::new(false);
        retry_completed_turn_evidence(
            || {
                assert!(!finished.get());
                attempts.set(attempts.get() + 1);
                if attempts.get() == 1 {
                    Err("injected settings write failure".into())
                } else {
                    Ok(())
                }
            },
            |error| {
                assert_eq!(error, "injected settings write failure");
                assert!(!finished.get());
                reports.set(reports.get() + 1);
            },
            |delay| {
                assert_eq!(delay, Duration::from_millis(50));
                assert!(!finished.get());
                pauses.set(pauses.get() + 1);
            },
            3,
        )
        .unwrap();
        finished.set(true);
        assert_eq!(attempts.get(), 2);
        assert_eq!(reports.get(), 1);
        assert_eq!(pauses.get(), 1);
    }

    #[test]
    fn persistent_completion_write_failure_returns_without_signaling_a_finish() {
        let attempts = Cell::new(0);
        let pauses = Cell::new(0);
        let result = retry_completed_turn_evidence(
            || {
                attempts.set(attempts.get() + 1);
                Err("injected persistent settings failure".into())
            },
            |_| {},
            |_| pauses.set(pauses.get() + 1),
            3,
        );
        assert_eq!(result.unwrap_err(), "injected persistent settings failure");
        assert_eq!(attempts.get(), 3);
        assert_eq!(pauses.get(), 2);
    }

    #[tokio::test]
    async fn failed_completion_write_retries_after_cleanup_and_signals_once_after_recovery() {
        let attempts = Cell::new(0);
        let ready_events = Cell::new(0);
        let pauses = Cell::new(0);
        retry_completion_evidence_after_cleanup(
            || {
                assert_eq!(ready_events.get(), 0);
                attempts.set(attempts.get() + 1);
                if attempts.get() <= 4 {
                    Err("injected persistent settings failure".into())
                } else {
                    Ok(())
                }
            },
            |_| assert_eq!(ready_events.get(), 0),
            |delay| {
                pauses.set(pauses.get() + 1);
                assert!(delay <= Duration::from_secs(2));
                async {}
            },
            || ready_events.set(ready_events.get() + 1),
        )
        .await;
        assert_eq!(attempts.get(), 5);
        assert_eq!(pauses.get(), 4);
        assert_eq!(ready_events.get(), 1);
    }

    #[tokio::test]
    async fn background_completion_retry_can_be_cancelled_when_the_app_stops() {
        use std::sync::atomic::AtomicUsize;

        let attempts = Arc::new(AtomicUsize::new(0));
        let ready_events = Arc::new(AtomicUsize::new(0));
        let retry_attempts = attempts.clone();
        let retry_events = ready_events.clone();
        let retry = tokio::spawn(async move {
            retry_completion_evidence_after_cleanup(
                || {
                    retry_attempts.fetch_add(1, Ordering::SeqCst);
                    Err("settings remain unwritable".into())
                },
                |_| {},
                |_| std::future::pending::<()>(),
                || {
                    retry_events.fetch_add(1, Ordering::SeqCst);
                },
            )
            .await;
        });
        tokio::task::yield_now().await;
        assert_eq!(attempts.load(Ordering::SeqCst), 1);
        retry.abort();
        assert!(retry.await.unwrap_err().is_cancelled());
        assert_eq!(ready_events.load(Ordering::SeqCst), 0);
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
pub async fn acp_activity(
    manager: State<'_, AgentManager>,
    directory: String,
) -> Result<HashMap<String, AgentActivity>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = worktree_identity(Path::new(&directory));
        let agents = manager
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut activity = HashMap::<String, AgentActivity>::new();
        for runtime in agents.iter().filter(|runtime| runtime.worktree == worktree) {
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
            if runtime.alive.load(Ordering::Acquire) {
                let native = runtime
                    .native_subagents
                    .lock()
                    .map_err(|error| error.to_string())?;
                if let Some(item) = activity.get_mut(&runtime.agent) {
                    for (session, child) in &native.0 {
                        if let Some(turn) = &child.task_turn_id {
                            item.active_turns
                                .entry(session.clone())
                                .or_insert_with(|| turn.clone());
                            item.active.push(session.clone());
                        }
                    }
                }
            }
        }
        Ok(activity)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_native_subagents(
    manager: State<'_, AgentManager>,
    fence: State<'_, AgentWorktreeFence>,
    directory: String,
) -> Result<NativeSubagentSnapshotSet, String> {
    let manager = manager.inner().clone();
    let fence = fence.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let directory = PathBuf::from(directory);
        let mut state = fence.0.lock().map_err(|error| error.to_string())?;
        let subagents = manager.native_subagent_snapshots(&directory)?;
        let generation = state.native_snapshot_generation(&directory, &subagents);
        Ok(NativeSubagentSnapshotSet {
            generation,
            subagents,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_pending_inbox(
    manager: State<'_, AgentManager>,
) -> Result<Vec<PendingPermissionInfo>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let agents = manager
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .cloned()
            .collect::<Vec<_>>();
        let mut pending = Vec::new();
        for runtime in &agents {
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
                    profile: runtime.profile.as_str().to_string(),
                    directory: runtime
                        .session_directories
                        .lock()
                        .ok()
                        .and_then(|directories| {
                            permission
                                .message
                                .pointer("/params/sessionId")
                                .and_then(Value::as_str)
                                .and_then(|id| directories.get(id).cloned())
                        })
                        .unwrap_or_else(|| runtime.worktree.clone())
                        .to_string_lossy()
                        .into_owned(),
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
                    profile: runtime.profile.as_str().to_string(),
                    directory: runtime
                        .session_directories
                        .lock()
                        .ok()
                        .and_then(|directories| {
                            elicitation
                                .message
                                .pointer("/params/sessionId")
                                .and_then(Value::as_str)
                                .and_then(|id| directories.get(id).cloned())
                        })
                        .unwrap_or_else(|| runtime.worktree.clone())
                        .to_string_lossy()
                        .into_owned(),
                    message: elicitation.message.clone(),
                    received_at: elicitation.received_at,
                });
            }
        }
        pending.sort_by_key(|item| item.received_at);
        Ok(pending)
    })
    .await
    .map_err(|error| error.to_string())?
}

impl Drop for AgentManager {
    fn drop(&mut self) {
        if Arc::strong_count(&self.0) != 1 {
            return;
        }
        self.shutdown();
    }
}

pub(crate) fn find_executable(name: &str) -> Option<PathBuf> {
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

fn observe_agent_with_reef(agent: &str, pid: u32) {
    let Some(reef) = find_executable("reef") else {
        return;
    };
    let _ = spawn_reef_registration(reef, agent.to_owned(), pid);
}

fn spawn_reef_registration(
    reef: PathBuf,
    agent: String,
    pid: u32,
) -> std::io::Result<std::thread::JoinHandle<Option<i32>>> {
    std::thread::Builder::new()
        .name("reef-agent-registration".to_owned())
        .spawn(move || {
        let outcome = Command::new(reef)
            .args(["agents", "observe", &agent, "--pid"])
            .arg(pid.to_string())
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .and_then(|mut child| child.wait());
        let code = outcome
            .as_ref()
            .ok()
            .and_then(std::process::ExitStatus::code);
        crate::diagnostics::record(
            "reef_agent_registration",
            json!({"agent": agent, "status": if outcome.as_ref().is_ok_and(std::process::ExitStatus::success) { "registered" } else { "failed" }, "exitCode": code}),
        );
        code
        })
}

#[cfg(all(test, unix))]
mod reef_observation_tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn registration_is_best_effort_and_does_not_wrap_the_agent() {
        let nonce = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap()
            .as_nanos();
        let dir = std::env::temp_dir().join(format!(
            "sail-reef-registration-{}-{nonce}",
            std::process::id(),
        ));
        std::fs::create_dir(&dir).unwrap();
        let reef = dir.join("reef");
        std::fs::write(&reef, b"#!/bin/sh\nprintf '%s\\n' \"$@\" > \"$0.out\"\n").unwrap();
        std::fs::set_permissions(&reef, std::fs::Permissions::from_mode(0o700)).unwrap();

        assert_eq!(
            spawn_reef_registration(reef.clone(), "opencode".to_owned(), 42)
                .unwrap()
                .join()
                .unwrap(),
            Some(0)
        );

        let args = std::fs::read_to_string(dir.join("reef.out")).unwrap();
        assert_eq!(args, "agents\nobserve\nopencode\n--pid\n42\n");
        std::fs::write(&reef, b"#!/bin/sh\nexit 2\n").unwrap();
        assert_eq!(
            spawn_reef_registration(reef, "codex".to_owned(), 42)
                .unwrap()
                .join()
                .unwrap(),
            Some(2)
        );
        std::fs::remove_dir_all(dir).unwrap();
    }
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

fn codex_native_activity_update(message: &Value, owner: Option<&str>) -> Option<Value> {
    if message.get("method").and_then(Value::as_str) != Some("session/update") {
        return None;
    }
    let parent = message
        .pointer("/params/sessionId")
        .and_then(Value::as_str)?;
    let update = message.pointer("/params/update")?;
    let input = update.get("rawInput").or_else(|| update.get("input"))?;
    let activity = input.get("activityKind").and_then(Value::as_str)?;
    let wire_child = input.get("agentThreadId").and_then(Value::as_str)?;
    if wire_child.trim().is_empty() || wire_child == parent {
        return None;
    }
    let child = owner
        .map(|owner| owned_session_id(owner, wire_child))
        .unwrap_or_else(|| wire_child.to_string());
    let name = input
        .get("agentPath")
        .and_then(Value::as_str)
        .and_then(|path| path.split('/').rfind(|part| !part.is_empty()))
        .filter(|name| !name.trim().is_empty())
        .unwrap_or("Subagent");
    let adapter_title = match activity {
        "started" => format!("Start subagent {name}"),
        "interacted" => format!("Interact with subagent {name}"),
        "interrupted" => format!("Interrupt subagent {name}"),
        "completed" => format!("Complete subagent {name}"),
        _ => return None,
    };
    let trusted = match update.get("subagent") {
        Some(marker) => marker.as_bool() == Some(true),
        None => {
            matches!(
                update.get("sessionUpdate").and_then(Value::as_str),
                Some("tool_call" | "tool_call_update")
            ) && update.get("title").and_then(Value::as_str) == Some(adapter_title.as_str())
        }
    };
    if !trusted {
        return None;
    }
    let update = match activity {
        "started" | "interacted" => {
            let mut spawned = json!({
                "sessionUpdate":"subagent_spawned",
                "subagentSessionId":child,
                "name":name,
                "task":name
            });
            if activity == "interacted" {
                spawned["revive"] = json!(true);
            }
            spawned
        }
        "completed" | "interrupted" => json!({
            "sessionUpdate":"subagent_state_update",
            "subagentSessionId":child,
            "state":if activity == "completed" { "completed" } else { "cancelled" }
        }),
        _ => return None,
    };
    Some(json!({"method":"session/update","params":{"sessionId":parent,"update":update}}))
}

fn claude_native_activity_update(
    message: &Value,
    registered: impl FnOnce(&str, &str) -> bool,
) -> Option<Value> {
    if message.get("method").and_then(Value::as_str) != Some("session/update") {
        return None;
    }
    let parent = message
        .pointer("/params/sessionId")
        .and_then(Value::as_str)?;
    let update = message.pointer("/params/update")?;
    if !matches!(
        update.get("sessionUpdate").and_then(Value::as_str),
        Some("tool_call" | "tool_call_update")
    ) {
        return None;
    }
    let tool_id = update
        .get("toolCallId")
        .and_then(Value::as_str)
        .filter(|tool_id| !tool_id.trim().is_empty())?;
    let child = format!("{parent}:claude-subagent:{tool_id}");
    let state = match update.get("status").and_then(Value::as_str) {
        Some("completed") => Some("completed"),
        Some("failed") => Some("failed"),
        Some("cancelled" | "interrupted") => Some("cancelled"),
        _ => None,
    };
    let normalized = if let Some(state) = state {
        if !registered(parent, &child) {
            return None;
        }
        json!({
            "sessionUpdate":"subagent_state_update",
            "subagentSessionId":child,
            "state":state
        })
    } else {
        if update.get("subagent").and_then(Value::as_bool) != Some(true)
            && !claude_adapter_subagent_signature(update)
        {
            return None;
        }
        let task = update
            .get("title")
            .and_then(Value::as_str)
            .or_else(|| update.pointer("/input/description").and_then(Value::as_str))
            .filter(|task| !task.trim().is_empty())
            .unwrap_or("Delegated task");
        json!({
            "sessionUpdate":"subagent_spawned",
            "subagentSessionId":child,
            "name":task,
            "task":task
        })
    };
    Some(json!({"method":"session/update","params":{"sessionId":parent,"update":normalized}}))
}

fn claude_adapter_subagent_signature(update: &Value) -> bool {
    let adapter_name = update
        .pointer("/_meta/claudeCode/toolName")
        .and_then(Value::as_str);
    if !matches!(adapter_name, Some("Agent" | "Task")) {
        return false;
    }
    if update
        .get("name")
        .is_some_and(|name| name.as_str() != adapter_name)
    {
        return false;
    }
    let Some(input) = update.get("rawInput").and_then(Value::as_object) else {
        return false;
    };
    input
        .get("subagent_type")
        .and_then(Value::as_str)
        .is_some_and(|kind| !kind.trim().is_empty())
        && input
            .get("run_in_background")
            .and_then(Value::as_bool)
            .is_some()
}

fn native_activity_fence(update: &Value) -> Option<(&str, bool)> {
    let tool_id = update.get("toolCallId").and_then(Value::as_str)?;
    let status = update.get("status").and_then(Value::as_str);
    if matches!(
        status,
        Some("completed" | "failed" | "cancelled" | "interrupted")
    ) {
        return Some((tool_id, false));
    }
    update
        .get("subagent")
        .and_then(Value::as_bool)
        .filter(|subagent| *subagent)
        .map(|_| (tool_id, true))
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
    directory: &Path,
) -> Result<Arc<Connection>, String> {
    connection_for_owner(manager, id, profile, directory, None)
}

fn connection_for_owner(
    manager: &AgentManager,
    id: &str,
    profile: CapabilityProfile,
    directory: &Path,
    owner: Option<&str>,
) -> Result<Arc<Connection>, String> {
    let key = connection_key_for_owner(id, profile, directory, owner);
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    agents
        .get(&key)
        .filter(|runtime| runtime.alive.load(Ordering::Acquire))
        .cloned()
        .ok_or_else(|| "Agent is not connected.".into())
}

fn connection_for_elicitation(
    manager: &AgentManager,
    agent: &str,
    profile: CapabilityProfile,
    directory: &Path,
    session_id: &str,
) -> Result<Arc<Connection>, String> {
    let runtime = connection_for_session(manager, agent, session_id, directory)?;
    if runtime.profile != profile {
        return Err("Agent session is not connected in this profile and worktree.".into());
    }
    let sessions = runtime
        .session_profiles
        .lock()
        .map_err(|error| error.to_string())?;
    if sessions.get(session_id) != Some(&profile) {
        return Err("Agent session is not connected in this profile and worktree.".into());
    }
    drop(sessions);
    Ok(runtime)
}

fn claim_pending_elicitation(
    pending: &Mutex<HashMap<String, PendingElicitation>>,
    request_key: &str,
    session_id: &str,
) -> Result<PendingElicitation, String> {
    let mut pending = pending.lock().map_err(|error| error.to_string())?;
    if !pending.get(request_key).is_some_and(|request| {
        request
            .message
            .pointer("/params/sessionId")
            .and_then(Value::as_str)
            == Some(session_id)
    }) {
        return Err("Elicitation request is no longer pending for this session.".into());
    }
    pending
        .remove(request_key)
        .ok_or_else(|| "Elicitation request is no longer pending.".to_string())
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
    directory: &Path,
) -> Result<Arc<Connection>, String> {
    let key = connection_key(id, CapabilityProfile::Build, directory);
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    let owner = session_owner(session_id);
    let matches = agents
        .values()
        .filter(|runtime| {
            runtime.agent == id
                && runtime.worktree == key.worktree
                && runtime.owner.as_deref() == owner
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
        .map(|runtime| Arc::clone(runtime))
        .ok_or_else(|| "Agent session is not connected in this worktree.".to_string())
}

/// OpenCode attaches the child's own session ID to its MCP calls; other agents give none.
fn task_provider_id<'a>(runtime: &Connection, child_id: &'a str) -> Option<&'a str> {
    (runtime.agent == "opencode").then(|| {
        runtime
            .owner
            .as_ref()
            .and_then(|owner| child_id.strip_prefix(&format!("{OWNED_SESSION_PREFIX}{owner}:")))
            .unwrap_or(child_id)
    })
}

fn register_native_task_connections(
    runtime: &Connection,
    browser: &crate::browser_agent::BrowserManager,
) -> Result<(), String> {
    // Keep settlement serialized with browser registration and ancestor pruning.
    let native = runtime
        .native_subagents
        .lock()
        .map_err(|error| error.to_string())?;
    let children = native.task_connections();
    for _ in 0..children.len() {
        for (child_id, child) in &children {
            let provider_id = task_provider_id(runtime, child_id);
            browser.register_native_child(
                &runtime.agent,
                &child.directory,
                &child.parent_session_id,
                child_id,
                provider_id,
            );
        }
    }
    // Settled ancestors only bridge registration of live descendants.
    for (child_id, child) in children
        .iter()
        .filter(|(_, child)| !NativeSubagentRegistry::is_live(child))
    {
        browser.prune_native_children(
            &runtime.agent,
            &child.directory,
            std::slice::from_ref(child_id),
        );
    }
    Ok(())
}

fn bind_session_directory(
    directories: &mut HashMap<String, PathBuf>,
    session_id: &str,
    directory: PathBuf,
) -> Result<(), String> {
    if directories
        .get(session_id)
        .is_some_and(|existing| existing != &directory)
    {
        return Err("Agent session is already bound to another directory.".into());
    }
    directories
        .entry(session_id.to_string())
        .or_insert(directory);
    Ok(())
}

fn register_session(
    manager: &AgentManager,
    agent: &str,
    profile: CapabilityProfile,
    session_id: &str,
    directory: PathBuf,
) -> Result<Arc<Connection>, String> {
    let runtime = register_session_detached(manager, agent, profile, session_id, directory)?;
    runtime
        .idle
        .lock()
        .map_err(|error| error.to_string())?
        .mark_attached(session_id, Instant::now());
    Ok(runtime)
}

/// Registers a session without reopening an idle-closed thread. A restore marks it attached only
/// once the agent has loaded it, so a failed resume leaves the thread closed for the next retry.
fn register_session_detached(
    manager: &AgentManager,
    agent: &str,
    profile: CapabilityProfile,
    session_id: &str,
    directory: PathBuf,
) -> Result<Arc<Connection>, String> {
    let owner = session_owner(session_id);
    let key = connection_key_for_owner(agent, profile, &directory, owner);
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    let mut owners = Vec::new();
    for runtime in agents.values().filter(|runtime| {
        runtime.agent == agent
            && runtime.worktree == key.worktree
            && runtime.owner.as_deref() == owner
            && runtime.alive.load(Ordering::Acquire)
    }) {
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
        .get(&key)
        .filter(|runtime| runtime.alive.load(Ordering::Acquire))
        .cloned()
        .ok_or_else(|| "Agent is not connected.".to_string())?;
    let mut profiles = runtime
        .session_profiles
        .lock()
        .map_err(|error| error.to_string())?;
    if runtime.idle_exit.load(Ordering::Acquire) {
        return Err(IDLE_EXIT_ERROR.into());
    }
    let mut directories = runtime
        .session_directories
        .lock()
        .map_err(|error| error.to_string())?;
    bind_session_directory(&mut directories, session_id, directory)?;
    drop(directories);
    profiles.insert(session_id.to_string(), profile);
    drop(profiles);
    Ok(runtime)
}

fn record_native_subagent_update(
    app: &AppHandle,
    manager: &AgentManager,
    fence: &AgentWorktreeFence,
    runtime: &Arc<Connection>,
    agent: &str,
    parent_id: &str,
    update: &Value,
) -> Result<(), String> {
    match update.get("sessionUpdate").and_then(Value::as_str) {
        Some("subagent_spawned") => {
            let child_id = update
                .get("subagentSessionId")
                .and_then(Value::as_str)
                .ok_or("Native child update has no child session ID.")?;
            if parent_id == child_id {
                return Err("Native child session matches its parent.".into());
            }
            let directory = runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?
                .get(parent_id)
                .cloned()
                .ok_or("Native child parent directory is unavailable.")?;
            let owner =
                register_session(manager, agent, runtime.profile, child_id, directory.clone())?;
            let parent_live = runtime
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?
                .active
                .contains_key(parent_id);
            let can_cancel = update
                .get("capabilities")
                .and_then(Value::as_object)
                .is_some_and(|capabilities| capabilities.contains_key("cancel"));
            let mut fence = fence.0.lock().map_err(|error| error.to_string())?;
            let mut native = owner
                .native_subagents
                .lock()
                .map_err(|error| error.to_string())?;
            let live = parent_live
                || native
                    .0
                    .get(parent_id)
                    .is_some_and(|parent| parent.task_turn_id.is_some());
            let child_live = native.spawn(parent_id, child_id, directory.clone(), can_cancel)?;
            native.task_scope(child_id, agent == "opencode", live);
            let child_live = if update.get("revive").and_then(Value::as_bool) == Some(true) {
                native.revive(child_id)
            } else {
                child_live
            };
            let provider_id = task_provider_id(runtime, child_id);
            let browser = app.state::<crate::browser_agent::BrowserManager>();
            // A replayed spawn of a settled child must not hold the parent's task identity.
            if child_live {
                browser.register_native_child(agent, &directory, parent_id, child_id, provider_id);
            } else {
                browser.prune_native_children(agent, &directory, &[child_id.to_string()]);
            }
            let generation = fence.generations.entry(directory).or_default();
            *generation = generation.saturating_add(1);
            Ok(())
        }
        Some("subagent_state_update") => {
            let child_id = update
                .get("subagentSessionId")
                .and_then(Value::as_str)
                .ok_or("Native child state has no child session ID.")?;
            let outcome = update
                .get("state")
                .and_then(Value::as_str)
                .ok_or("Native child state has no outcome.")?;
            let directory = runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?
                .get(child_id)
                .cloned()
                .ok_or("Native child directory is unavailable.")?;
            let live_sessions = runtime
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?
                .active
                .keys()
                .cloned()
                .collect::<HashSet<_>>();
            let mut fence = fence.0.lock().map_err(|error| error.to_string())?;
            let mut native = runtime
                .native_subagents
                .lock()
                .map_err(|error| error.to_string())?;
            native.update(parent_id, child_id, outcome)?;
            if outcome == "working" {
                let live = native.0.get(child_id).is_some_and(|child| {
                    live_sessions.contains(&child.parent_session_id)
                        || native
                            .0
                            .get(&child.parent_session_id)
                            .is_some_and(|parent| parent.task_turn_id.is_some())
                });
                native.task_scope(child_id, agent == "opencode", live);
                // A resumed child must hold the task bridge again until it settles.
                app.state::<crate::browser_agent::BrowserManager>()
                    .register_native_child(
                        agent,
                        &directory,
                        parent_id,
                        child_id,
                        task_provider_id(runtime, child_id),
                    );
            }
            let generation = fence.generations.entry(directory.clone()).or_default();
            *generation = generation.saturating_add(1);
            if matches!(outcome, "completed" | "failed" | "cancelled") {
                app.state::<crate::browser_agent::BrowserManager>()
                    .settle_native_child(agent, &directory, parent_id, child_id);
                runtime
                    .permission_state
                    .lock()
                    .map_err(|error| error.to_string())?
                    .end_native_cancel(child_id);
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

/// Agents that keep no transcript for a session until its first turn, so they cannot resume one
/// that never ran.
const NEEDS_FIRST_TURN_AGENTS: &[&str] = &["claude"];

/// Agents whose adapter turns `session/close` into releasing the loaded thread and its MCP servers.
/// OpenCode advertises close but keeps the session's MCP servers until the agent exits, and a
/// resumed session then starts them again, so its idle agent exit is the release path instead.
const IDLE_CLOSE_AGENTS: &[&str] = &["claude", "codex"];

impl Connection {
    fn cached_config_options(&self, session_id: &str) -> Option<Value> {
        self.session_ui
            .lock()
            .ok()?
            .get(session_id)?
            .config_options
            .clone()
    }

    /// A resume resets session-scoped settings such as mode and effort; put back what the thread had.
    fn replay_config(&self, session_id: &str, previous: Option<&Value>, resumed: &Value) {
        let (Some(previous), Some(resumed)) = (
            previous,
            resumed.get("configOptions").filter(|v| v.is_array()),
        ) else {
            return;
        };
        for (config_id, value) in config_replays(previous, resumed) {
            match self.request(
                "session/set_config_option",
                json!({"sessionId":session_id,"configId":config_id,"value":value}),
                Duration::from_secs(30),
            ) {
                Ok(reply) => {
                    let _ = self.remember_session_ui(session_id, &reply);
                }
                Err(error) => crate::diagnostics::record(
                    "idle_session_config_replay_failed",
                    json!({"agent":self.agent,"sessionId":session_id,"configId":config_id,"error":error}),
                ),
            }
        }
    }

    fn touch_session(&self, session_id: &str) {
        if let Ok(mut idle) = self.idle.lock() {
            idle.touch(session_id, Instant::now());
        }
    }

    /// Claims the resume of an idle-closed session. A caller that finds a close or another resume in
    /// flight waits for it; `None` means the session was already loaded when the wait ended. Dropping
    /// the guard without `resumed` leaves the session closed so the next caller retries it.
    fn acquire_resume(&self, session_id: &str) -> Result<Option<EndResume<'_>>, String> {
        // A close ends within its 30 second request and a resume within 60.
        let deadline = Instant::now() + Duration::from_secs(100);
        loop {
            let claim = self
                .idle
                .lock()
                .map_err(|error| error.to_string())?
                .claim_resume(session_id);
            match claim {
                crate::acp_idle::ResumeClaim::Open => return Ok(None),
                crate::acp_idle::ResumeClaim::Claimed => {
                    return Ok(Some(EndResume {
                        runtime: self,
                        session_id: session_id.to_string(),
                        resumed: false,
                    }));
                }
                crate::acp_idle::ResumeClaim::Wait if Instant::now() < deadline => {
                    std::thread::sleep(Duration::from_millis(20));
                }
                crate::acp_idle::ResumeClaim::Wait => {
                    return Err("The thread is still reconnecting. Try again.".to_string());
                }
            }
        }
    }

    /// Resumes an idle-closed session once; `None` means it was already loaded.
    fn reattach_closed<T>(
        &self,
        session_id: &str,
        resume: impl FnOnce() -> Result<T, String>,
    ) -> Result<Option<T>, String> {
        let Some(mut end) = self.acquire_resume(session_id)? else {
            return Ok(None);
        };
        let resumed = resume()?;
        end.resumed = true;
        Ok(Some(resumed))
    }

    /// Starts a restore that reloads the thread in the agent. An idle-closed thread stays closed,
    /// and other callers keep waiting, until the guard is marked resumed; a loaded one is touched.
    fn begin_attaching_restore(&self, session_id: &str) -> Result<Option<EndResume<'_>>, String> {
        let claim = self.acquire_resume(session_id)?;
        if claim.is_none() {
            self.idle
                .lock()
                .map_err(|error| error.to_string())?
                .mark_attached(session_id, Instant::now());
        }
        Ok(claim)
    }

    fn supports_session_close(&self) -> bool {
        IDLE_CLOSE_AGENTS.contains(&self.agent.as_str())
            && self.capabilities.lock().is_ok_and(|capabilities| {
                capabilities
                    .pointer("/agentCapabilities/sessionCapabilities/close")
                    .is_some_and(Value::is_object)
            })
    }

    /// Whether a turn, permission, background task, subagent or terminal still needs the loaded thread.
    fn session_holds_work(
        &self,
        session_id: &str,
        prompts: &PromptState,
        restores: &HashMap<String, RestoreClaim>,
        terminal_running: bool,
    ) -> Result<bool, String> {
        if terminal_running
            || prompts.active.contains_key(session_id)
            || prompts.finishing.contains(session_id)
            || restores
                .get(session_id)
                .is_some_and(|claim| claim.request_active || claim.expires > Instant::now())
        {
            return Ok(true);
        }
        let asks_about_session = |message: &Value| {
            message.pointer("/params/sessionId").and_then(Value::as_str) == Some(session_id)
        };
        {
            let permissions = self
                .permission_state
                .lock()
                .map_err(|error| error.to_string())?;
            if permissions.canceling_sessions.contains_key(session_id)
                || permissions
                    .pending
                    .values()
                    .any(|pending| asks_about_session(&pending.message))
            {
                return Ok(true);
            }
        }
        if self
            .elicitation_state
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .any(|pending| asks_about_session(&pending.message))
        {
            return Ok(true);
        }
        {
            let idle = self.idle.lock().map_err(|error| error.to_string())?;
            if idle.has_async_tasks(session_id)
                || idle.has_background_work(session_id)
                || idle.is_fresh(session_id)
                || idle.is_resuming(session_id)
            {
                return Ok(true);
            }
        }
        Ok(self
            .native_subagents
            .lock()
            .map_err(|error| error.to_string())?
            .involves_live_work(session_id))
    }

    /// Closes a session that finished its work and went unseen past `idle`. Returns whether it closed.
    fn close_session_if_idle(
        &self,
        app: &AppHandle,
        session_id: &str,
        directory: &Path,
        idle: Duration,
    ) -> Result<bool, String> {
        let owner = format!("{}\0acp:{}:{}", directory.display(), self.agent, session_id);
        let terminal_running = app
            .state::<crate::acp_terminal::AcpTerminalManager>()
            .has_running_sessions(
                &self.agent,
                self.profile,
                &self.worktree,
                &[session_id.to_string()],
            )
            || app
                .state::<crate::terminal::TerminalManager>()
                .owner_has_running(&owner);
        let (profile, directory, deleted) = {
            let restores = self.restores.lock().map_err(|error| error.to_string())?;
            let prompts = self
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?;
            if self.session_holds_work(session_id, &prompts, &restores, terminal_running)? {
                self.touch_session(session_id);
                return Ok(false);
            }
            let mut idle_sessions = self.idle.lock().map_err(|error| error.to_string())?;
            // A closed thread a restore registered but has not resumed yet is already closed.
            if idle_sessions.is_closed(session_id)
                || !idle_sessions.expired(session_id, Instant::now(), idle)
            {
                return Ok(false);
            }
            drop(idle_sessions);
            let mut profiles = self
                .session_profiles
                .lock()
                .map_err(|error| error.to_string())?;
            let mut directories = self
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?;
            let (Some(profile), Some(directory)) =
                (profiles.remove(session_id), directories.remove(session_id))
            else {
                return Ok(false);
            };
            self.idle
                .lock()
                .map_err(|error| error.to_string())?
                .begin_close(session_id);
            (profile, directory, prompts.forgotten.contains(session_id))
        };
        let closed = self.request(
            "session/close",
            json!({"sessionId":session_id}),
            Duration::from_secs(30),
        );
        let end_close = || {
            if let Ok(mut idle) = self.idle.lock() {
                idle.end_close(session_id);
                // A deleted thread must stay gone, so it is not marked closed for a reattach.
                if deleted {
                    idle.forget(session_id);
                }
            }
        };
        match closed {
            Ok(_) => {
                end_close();
                crate::diagnostics::record(
                    "idle_session_closed",
                    json!({"agent":self.agent,"sessionId":session_id}),
                );
                Ok(true)
            }
            Err(error) if is_unknown_session_error(&error) => {
                end_close();
                Ok(true)
            }
            Err(error) => {
                if let (Ok(mut profiles), Ok(mut directories)) = (
                    self.session_profiles.lock(),
                    self.session_directories.lock(),
                ) {
                    profiles.insert(session_id.to_string(), profile);
                    directories.insert(session_id.to_string(), directory);
                }
                if let Ok(mut idle) = self.idle.lock() {
                    idle.mark_attached(session_id, Instant::now());
                }
                Err(error)
            }
        }
    }
}

fn is_unknown_session_error(error: &str) -> bool {
    let error = error.to_ascii_lowercase();
    (error.contains("session") || error.contains("thread"))
        && (error.contains("not found") || error.contains("unknown"))
}

impl AgentManager {
    /// Closes finished sessions nobody has looked at for `idle`, so their MCP servers exit.
    pub fn close_idle_sessions(&self, app: &AppHandle, idle: Duration) -> usize {
        let connections = self
            .0
            .lock()
            .map(|agents| {
                agents
                    .values()
                    .filter(|runtime| {
                        runtime.alive.load(Ordering::Acquire) && runtime.supports_session_close()
                    })
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let mut closed = 0;
        for runtime in connections {
            let sessions = runtime
                .session_directories
                .lock()
                .map(|directories| {
                    directories
                        .iter()
                        .map(|(id, directory)| (id.clone(), directory.clone()))
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            for (session_id, directory) in sessions {
                match runtime.close_session_if_idle(app, &session_id, &directory, idle) {
                    Ok(true) => closed += 1,
                    Ok(false) => {}
                    Err(error) => crate::diagnostics::record(
                        "idle_session_close_failed",
                        json!({"agent":runtime.agent,"sessionId":session_id,"error":error}),
                    ),
                }
            }
        }
        closed
    }

    fn idle_closed_connection(
        &self,
        agent: &str,
        session_id: &str,
        directory: &Path,
    ) -> Option<Arc<Connection>> {
        let worktree = worktree_identity(directory);
        let owner = session_owner(session_id);
        self.0
            .lock()
            .ok()?
            .values()
            .find(|runtime| {
                runtime.agent == agent
                    && runtime.worktree == worktree
                    && runtime.owner.as_deref() == owner
                    && runtime.alive.load(Ordering::Acquire)
                    && runtime
                        .idle
                        .lock()
                        .is_ok_and(|idle| idle.is_closed(session_id))
            })
            .cloned()
    }
}

/// Sweeps for idle sessions for the life of the app. A tick only scans in-memory state.
pub fn start_idle_session_sweeper(app: AppHandle) {
    let _ = std::thread::Builder::new()
        .name("sail-idle-session-sweep".into())
        .spawn(move || loop {
            std::thread::sleep(Duration::from_secs(1));
            let (Some(idle), Some(manager)) = (
                crate::acp_idle::idle_timeout(),
                app.try_state::<AgentManager>(),
            ) else {
                continue;
            };
            manager.close_idle_sessions(&app, idle);
        });
}

/// Reattaches a session the idle sweep closed, so a prompt to it works as if it were still loaded.
async fn reattach_idle_closed(
    app: &AppHandle,
    manager: &AgentManager,
    browser: &crate::browser_agent::BrowserManager,
    agent: &str,
    session_id: &str,
    directory: &Path,
) -> Result<(), String> {
    let Some(runtime) = manager.idle_closed_connection(agent, session_id, directory) else {
        return Ok(());
    };
    let params = RestoreSessionCommand {
        agent: agent.to_string(),
        cwd: directory.to_string_lossy().into_owned(),
        session_id: session_id.to_string(),
        profile: Some(runtime.profile.as_str().to_string()),
        restore_token: None,
    };
    let (app, manager, browser) = (app.clone(), manager.clone(), browser.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let session_id = params.session_id.clone();
        runtime.reattach_closed(&session_id, || {
            let previous = runtime.cached_config_options(&session_id);
            let resumed =
                restore_session_blocking(app, &manager, &browser, params, "session/resume", true)?;
            runtime.replay_config(&session_id, previous.as_ref(), &resumed);
            Ok(())
        })
    })
    .await
    .map_err(|error| error.to_string())??;
    Ok(())
}

/// Config selections whose resumed value differs from the one the thread had before the close.
fn config_replays(previous: &Value, resumed: &Value) -> Vec<(String, String)> {
    let choices = |option: &Value| -> Vec<String> {
        let mut values = Vec::new();
        for choice in option
            .get("options")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
        {
            let grouped = choice.get("options").and_then(Value::as_array);
            for choice in grouped.map_or_else(|| std::slice::from_ref(choice), Vec::as_slice) {
                values.extend(
                    choice
                        .get("value")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                );
            }
        }
        values
    };
    let resumed_options = resumed.as_array().map_or(&[][..], Vec::as_slice);
    previous
        .as_array()
        .into_iter()
        .flatten()
        .filter(|option| option.get("type").and_then(Value::as_str) == Some("select"))
        .filter_map(|option| {
            let id = option.get("id")?.as_str()?;
            let wanted = option.get("currentValue")?.as_str()?;
            let now = resumed_options
                .iter()
                .find(|candidate| candidate.get("id").and_then(Value::as_str) == Some(id))?;
            let current = now.get("currentValue").and_then(Value::as_str);
            (current != Some(wanted) && choices(now).iter().any(|value| value == wanted))
                .then(|| (id.to_owned(), wanted.to_owned()))
        })
        .collect()
}

async fn connection_for_session_reattaching(
    app: &AppHandle,
    manager: &AgentManager,
    browser: &crate::browser_agent::BrowserManager,
    agent: &str,
    session_id: &str,
    directory: &Path,
) -> Result<Arc<Connection>, String> {
    // A closed session may still look connected while its resume runs, so ask for the reattach
    // first; it is a no-op for a loaded session.
    reattach_idle_closed(app, manager, browser, agent, session_id, directory).await?;
    let runtime = match connection_for_session(manager, agent, session_id, directory) {
        Ok(runtime) => runtime,
        // The sweeper may have started closing the thread between the check and the lookup.
        Err(_) => {
            reattach_idle_closed(app, manager, browser, agent, session_id, directory).await?;
            connection_for_session(manager, agent, session_id, directory)?
        }
    };
    runtime.touch_session(session_id);
    Ok(runtime)
}

/// E2E specs share one app process and shorten the idle timeout for their own run.
/// The command is only permitted by the E2E capability and has no production effect.
#[tauri::command]
pub fn acp_set_idle_close_timeout(seconds: Option<u64>) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    {
        crate::acp_idle::override_idle_seconds(seconds);
        Ok(())
    }
    #[cfg(not(feature = "e2e"))]
    {
        let _ = seconds;
        Err("The idle close timeout override requires the E2E build".into())
    }
}

/// Heartbeat from a view showing the session; an unseen thread closes after the idle timeout.
#[tauri::command]
pub fn acp_session_visible(
    manager: State<'_, AgentManager>,
    agent: String,
    directory: String,
    session_id: String,
) -> Result<(), String> {
    if let Ok(runtime) =
        connection_for_session(&manager, &agent, &session_id, Path::new(&directory))
    {
        runtime.touch_session(&session_id);
    }
    Ok(())
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
            Launch::VendoredCodex => {
                let binary = find_executable(agent.executable);
                AgentAvailability {
                    id: agent.id.into(),
                    name: agent.name.into(),
                    binary_path: binary
                        .as_ref()
                        .map(|path| path.to_string_lossy().into_owned()),
                    available: binary.is_some() && major.is_some_and(|version| version >= 18),
                    reason: if binary.is_none() {
                        Some(format!("Install {} first.", agent.name))
                    } else if major.is_none_or(|version| version < 18) {
                        Some("Codex requires Node.js 18 or newer.".into())
                    } else {
                        None
                    },
                }
            }
        })
        .collect()
}

fn assigned_scratch_directory(path: &Path, roots: &[PathBuf]) -> Result<PathBuf, String> {
    if !path.is_absolute() {
        return Err("Assigned scratch directory must be absolute.".into());
    }
    let assigned = WritableDirectory::capture(path)?;
    for root in roots {
        let root = dunce::canonicalize(root).map_err(|error| error.to_string())?;
        if assigned.path != root && assigned.path.starts_with(&root) {
            let mut current = path.to_path_buf();
            while dunce::canonicalize(&current).ok().as_ref() != Some(&root) {
                if std::fs::symlink_metadata(&current)
                    .map_err(|error| error.to_string())?
                    .file_type()
                    .is_symlink()
                {
                    return Err("Assigned scratch directory must not traverse symlinks.".into());
                }
                if !current.pop() {
                    break;
                }
            }
            return Ok(assigned.path);
        }
    }
    Err("Assigned scratch directory is outside its owner's private scratch space.".into())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpBuildLease {
    owner: String,
    revision: String,
    scratch_directory: Option<PathBuf>,
}

#[tauri::command]
pub async fn acp_connect(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
    directory: String,
    profile: Option<String>,
    owner: Option<String>,
    build_lease: Option<AcpBuildLease>,
) -> Result<Value, String> {
    let profile = parse_profile(profile.as_deref())?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        connect_blocking_with_build_lease(
            app,
            &manager,
            agent,
            profile,
            Path::new(&directory),
            owner.as_deref(),
            build_lease.as_ref().map(|lease| {
                (
                    lease.owner.as_str(),
                    lease.revision.as_str(),
                    lease.scratch_directory.as_deref(),
                )
            }),
        )
    })
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

fn vendored_codex_adapter(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?
        .join("codex-acp/index.js.txt");
    if bundled.is_file() {
        return Ok(bundled);
    }
    #[cfg(debug_assertions)]
    {
        let source =
            Path::new(env!("CARGO_MANIFEST_DIR")).join("../vendor/codex-acp/dist/index.js.txt");
        if source.is_file() {
            return Ok(source);
        }
    }
    Err("The bundled Codex ACP adapter is missing.".into())
}

fn connect_blocking(
    app: AppHandle,
    manager: &AgentManager,
    agent: String,
    profile: CapabilityProfile,
    directory: &Path,
) -> Result<Value, String> {
    connect_blocking_owned(app, manager, agent, profile, directory, None)
}

fn connect_blocking_owned(
    app: AppHandle,
    manager: &AgentManager,
    agent: String,
    profile: CapabilityProfile,
    directory: &Path,
    owner: Option<&str>,
) -> Result<Value, String> {
    connect_blocking_with_build_lease(app, manager, agent, profile, directory, owner, None)
}

fn connect_blocking_with_build_lease(
    app: AppHandle,
    manager: &AgentManager,
    agent: String,
    profile: CapabilityProfile,
    directory: &Path,
    owner: Option<&str>,
    build_lease: Option<(&str, &str, Option<&Path>)>,
) -> Result<Value, String> {
    if owner.is_some_and(|owner| Uuid::parse_str(owner).is_err()) {
        return Err("Invalid agent run owner ID.".into());
    }
    if build_lease.is_some_and(|(build_owner, revision, _)| {
        owner.is_none() || Uuid::parse_str(build_owner).is_err() || revision.is_empty()
    }) {
        return Err("Invalid shared build target lease.".into());
    }
    let worktree = worktree_identity(directory);
    if !worktree.is_dir() {
        return Err("Repository directory does not exist.".into());
    }
    let fence = app.state::<AgentWorktreeFence>().inner().clone();
    fence.begin_session(&worktree, None)?;
    let result = connect_blocking_inner(
        app.clone(),
        manager,
        agent,
        profile,
        &worktree,
        owner,
        build_lease,
    );
    let finish = fence.finish_session(&worktree, None);
    if finish.is_err() {
        manager.stop_worktree(&worktree)?;
    }
    match (result, finish) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), _) => Err(error),
        (Ok(_), Err(error)) => Err(error),
    }
}

#[cfg(unix)]
fn isolate_agent_process(command: &mut Command) {
    unsafe {
        command.pre_exec(|| {
            if nix::libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
}

/// Capabilities of a live, initialized connection. Checked before the worktree startup lock so
/// reopening a thread never waits behind another agent spawning in the same worktree.
fn initialized_capabilities(
    manager: &AgentManager,
    key: &ConnectionKey,
) -> Result<Option<Value>, String> {
    let existing = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(key)
        .filter(|existing| existing.reusable())
        .cloned();
    let Some(existing) = existing else {
        return Ok(None);
    };
    let capabilities = existing
        .capabilities
        .lock()
        .map_err(|error| error.to_string())?
        .clone();
    if capabilities.is_null() {
        return Ok(None);
    }
    existing.validate_codex_workspace(None)?;
    Ok(Some(capabilities))
}

fn connect_blocking_inner(
    app: AppHandle,
    manager: &AgentManager,
    agent: String,
    profile: CapabilityProfile,
    worktree: &Path,
    owner: Option<&str>,
    build_lease: Option<(&str, &str, Option<&Path>)>,
) -> Result<Value, String> {
    #[cfg(not(unix))]
    let _ = build_lease;
    let definition = definition(&agent)?;
    let startup_generation = manager.3.load(Ordering::Acquire);
    let key = connection_key_for_owner(&agent, profile, worktree, owner);
    if let Some(capabilities) = initialized_capabilities(manager, &key)? {
        return Ok(capabilities);
    }
    let startup = manager.worktree_startup(worktree)?;
    let _startup = startup.lock().map_err(|error| error.to_string())?;
    if manager.3.load(Ordering::Acquire) != startup_generation {
        return Err("Agent startup was cancelled.".into());
    }
    let live = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&key)
        .is_some_and(|existing| existing.reusable());
    // Probe before taking the agent lock; a live connection needs no availability check.
    let mut availability = if live {
        None
    } else {
        Some(agent_availability_for(&app, &agent)?)
    };
    let existing = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&key)
        .cloned();
    if let Some(existing) = existing {
        if existing.reusable() {
            existing.validate_codex_workspace(None)?;
            drop(_startup);
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
    let canary_percent = crate::reef_canary::configured_percent(&app)?;
    #[cfg(unix)]
    let reef_canary = canary_percent
        .map(|percent| {
            let reef = crate::reef_canary::verify_executable(find_executable("reef"))?;
            if percent > 0 {
                crate::reef_canary::verify_scheduler(&reef)?;
            }
            Ok::<_, String>((reef, percent))
        })
        .transpose()?;
    #[cfg(not(unix))]
    if canary_percent.is_some() {
        return Err("Reef canary is supported only on macOS and Linux.".into());
    }
    #[cfg(unix)]
    let shared_build_directory = build_lease.and_then(|(build_owner, revision, _)| {
        let parent = manager
            .0
            .lock()
            .ok()?
            .values()
            .find(|runtime| {
                runtime.worktree == worktree
                    && runtime.owner.as_deref() == Some(build_owner)
                    && runtime.alive.load(Ordering::Acquire)
            })
            .cloned()?;
        let root = parent
            .runtime_scratch
            .lock()
            .ok()?
            .as_ref()?
            .path()
            .to_path_buf();
        let base = gate_build_directory(&root, revision, owner.unwrap_or_default(), false);
        let busy = manager.0.lock().ok()?.values().any(|runtime| {
            runtime.alive.load(Ordering::Acquire)
                && runtime.shared_build_directory.as_deref() == Some(base.as_path())
        });
        Some(gate_build_directory(
            &root,
            revision,
            owner.unwrap_or_default(),
            busy,
        ))
    });
    #[cfg(not(unix))]
    let shared_build_directory: Option<PathBuf> = None;
    let assigned_scratch = if let Some((build_owner, _, Some(path))) = build_lease {
        let parent = manager
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .find(|runtime| {
                runtime.worktree == worktree
                    && runtime.owner.as_deref() == Some(build_owner)
                    && runtime.alive.load(Ordering::Acquire)
            })
            .cloned()
            .ok_or("Assigned scratch owner is no longer running.")?;
        parent.validate_codex_workspace(None)?;
        let mut roots = Vec::new();
        if let Some(lease) = parent._storage_lease.as_ref() {
            roots.push(lease.temp_directory().to_path_buf());
        }
        #[cfg(unix)]
        if let Some(root) = parent
            .runtime_scratch
            .lock()
            .map_err(|error| error.to_string())?
            .as_ref()
        {
            roots.push(root.path().to_path_buf());
        }
        Some(assigned_scratch_directory(path, &roots)?)
    } else {
        None
    };

    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let home =
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).map(PathBuf::from);
    let local_app_data = std::env::var_os("LOCALAPPDATA").map(PathBuf::from);
    #[cfg(feature = "e2e")]
    let test_agent = std::env::var_os("SAIL_ACP_TEST_AGENT");
    #[cfg(not(feature = "e2e"))]
    let test_agent: Option<std::ffi::OsString> = None;
    let mut paths =
        configured_tool_paths(home.as_deref(), local_app_data.as_deref(), cfg!(windows));
    let is_test_agent = test_agent.is_some();
    let mut owned_temp = None;
    let background = crate::background_priority::enabled(&app);
    let mut command = if let Some(path) = test_agent {
        let node = find_executable("node").ok_or("Node.js not found.")?;
        paths.push(node.parent().ok_or("Invalid Node.js path.")?.to_path_buf());
        let mut command = crate::background_priority::worker_command(node.as_os_str(), background);
        command.arg(path).arg(&agent);
        command
    } else {
        match definition.launch {
            Launch::Npx { package, .. } => {
                let node = find_executable("node").ok_or("Node.js not found.")?;
                paths.push(node.parent().ok_or("Invalid Node.js path.")?.to_path_buf());
                let npx = find_executable("npx").ok_or("npx not found.")?;
                let mut command =
                    crate::background_priority::worker_command(npx.as_os_str(), background);
                command.args(["--yes", package]);
                command
            }
            Launch::OpenCode => {
                let binary = availability
                    .binary_path
                    .clone()
                    .ok_or("OpenCode binary not found.")?;
                let mut command = crate::background_priority::worker_command(
                    std::ffi::OsStr::new(&binary),
                    background,
                );
                command.arg("acp");
                command.env_remove("OPENCODE_CONFIG_DIR");
                command
            }
            Launch::VendoredCodex => {
                let node = find_executable("node").ok_or("Node.js not found.")?;
                paths.push(node.parent().ok_or("Invalid Node.js path.")?.to_path_buf());
                let temp = OwnedTempDir::create()?;
                let adapter = temp.0.join("index.mjs");
                std::fs::copy(vendored_codex_adapter(&app)?, &adapter)
                    .map_err(|error| format!("Could not stage Codex ACP adapter: {error}"))?;
                let mut command =
                    crate::background_priority::worker_command(node.as_os_str(), background);
                command.arg(adapter);
                command.env_remove("CODEX_ACP_PERMISSION_PROFILE_CONFIG");
                owned_temp = Some(temp);
                command
            }
        }
    };
    if let Some(connection_file) = crate::hook_activity::connection_file(
        app.state::<crate::hook_activity::HookActivityManager>()
            .inner(),
    ) {
        command.env("SAIL_HOOK_CONNECTION_FILE", connection_file);
    }
    if let (Some(name), Some(binary)) = (definition.binary_env, availability.binary_path) {
        command.env(name, binary);
    }
    let cache_directory = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    let overlay = crate::git_overlay::GitOverlay::ensure(&cache_directory, worktree)?;
    let (data_directory, storage_lease) =
        crate::register_worktree_storage(&cache_directory, worktree)?;
    #[cfg(unix)]
    let mut runtime_scratch = Some(
        crate::scratch_cleanup::OwnedRuntimeScratch::create()
            .map_err(|error| format!("Could not prepare runtime scratch: {error}"))?,
    );
    prepare_runtime_directories(&data_directory, storage_lease.temp_directory())?;
    let runtime_path = agent_path(paths, data_directory.join("bin"), &original_path)?;
    command.env("PATH", &runtime_path);
    let environment_id = tool_environment_id(&data_directory);
    command.env(
        crate::acp_terminal::ENVIRONMENT_ID_VARIABLE,
        &environment_id,
    );
    #[cfg(unix)]
    let scratch_path = runtime_scratch.as_ref().map(|scratch| scratch.path());
    #[cfg(not(unix))]
    let scratch_path: Option<&Path> = None;
    let codex_workspace_access = if let Some(temp) = owned_temp.as_ref() {
        let shared_cache = data_directory
            .parent()
            .and_then(Path::parent)
            .unwrap_or(&data_directory)
            .join("terminal-package-downloads");
        std::fs::create_dir_all(&shared_cache).map_err(|error| error.to_string())?;
        let mut writable = vec![temp.0.clone(), data_directory.clone(), shared_cache];
        let data_home = std::env::var_os("XDG_DATA_HOME").map(PathBuf::from);
        writable.extend(user_writable_directories(
            home.as_deref(),
            data_home.as_deref(),
        ));
        if let Some(overlay) = overlay.as_ref() {
            writable.push(overlay.git_dir.clone());
        }
        if let Some(scratch) = scratch_path {
            writable.push(scratch.to_path_buf());
        }
        if let Some(build) = shared_build_directory.as_ref() {
            std::fs::create_dir_all(build).map_err(|error| error.to_string())?;
            writable.push(build.clone());
        }
        if let Some(scratch) = assigned_scratch.as_ref() {
            writable.push(scratch.clone());
        }
        let access = CodexWorkspaceAccess::capture(worktree, &writable)?;
        command.env(
            "CODEX_ACP_PERMISSION_PROFILE_CONFIG",
            access.profile_config()?,
        );
        Some(access)
    } else {
        None
    };
    for (name, value) in runtime_environment(
        &data_directory,
        storage_lease.temp_directory(),
        scratch_path,
        shared_build_directory.as_deref(),
    ) {
        command.env(name, value);
    }
    if let Some(overlay) = overlay.as_ref() {
        overlay.apply(&mut command);
    }
    command.current_dir(worktree);
    let retry = crate::background_priority::normal_priority_copy(&command);
    #[cfg(unix)]
    let (command, retry) = if let Some((reef, percent)) = reef_canary {
        (
            crate::reef_canary::wrap_command(&command, &reef, &agent, percent)?,
            crate::reef_canary::wrap_command(&retry, &reef, &agent, percent)?,
        )
    } else {
        (command, retry)
    };
    #[cfg(unix)]
    let mut wrapped = crate::scratch_cleanup::wrap_command(&command)
        .map_err(|error| format!("Could not prepare agent owner: {error}"))?;
    #[cfg(unix)]
    isolate_agent_process(&mut wrapped);
    #[cfg(not(unix))]
    let mut wrapped = command;
    storage_lease.prepare_process_start()?;
    let spawn = wrapped
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn();
    let spawn = spawn.or_else(|error| {
        if !background {
            return Err(error);
        }
        eprintln!(
            "Background priority launch failed for {}: {error}; retrying at normal priority",
            definition.name
        );
        #[cfg(unix)]
        let mut retry = crate::scratch_cleanup::wrap_command(&retry)?;
        #[cfg(not(unix))]
        let mut retry = retry;
        #[cfg(unix)]
        isolate_agent_process(&mut retry);
        retry
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
    });
    let mut child = match spawn {
        Ok(child) => child,
        Err(error) => {
            storage_lease.cancel_process_start()?;
            return Err(format!("Could not start {}: {error}", definition.name));
        }
    };
    storage_lease.mark_started();
    #[cfg(unix)]
    if let Some(scratch) = runtime_scratch.as_mut() {
        if let Err(error) = scratch.mark_owner(child.id()) {
            let _ = stop_process(&mut child);
            return Err(format!("Could not record runtime scratch owner: {error}"));
        }
    }
    #[cfg(unix)]
    let scratch_owner = crate::scratch_cleanup::owner_identity_for_pid(child.id());
    if !is_test_agent {
        observe_agent_with_reef(&agent, child.id());
    }
    #[cfg(unix)]
    let watchdog = crate::child_watchdog::ChildWatchdog::start(child.id()).map_err(|error| {
        let _ = stop_process(&mut child);
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
        worktree: worktree.to_path_buf(),
        owner: owner.map(str::to_string),
        #[cfg(unix)]
        shared_build_directory,
        codex_workspace_access,
        runtime_path,
        environment_id,
        _storage_lease: Some(storage_lease),
        child: Mutex::new(child),
        #[cfg(unix)]
        scratch_owner,
        #[cfg(unix)]
        runtime_scratch: Mutex::new(runtime_scratch),
        #[cfg(unix)]
        watchdog: Mutex::new(watchdog),
        stopped: AtomicBool::new(false),
        released_owner: AtomicBool::new(false),
        idle_exit: AtomicBool::new(false),
        last_activity: Mutex::new(Instant::now()),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
        reader_progress: ReaderProgress::default(),
        permission_state: Mutex::new(PermissionState::default()),
        elicitation_state: Mutex::new(HashMap::new()),
        next_permission_generation: AtomicU64::new(1),
        prompt_state: Mutex::new(PromptState::default()),
        temp_cleanup_gate: Mutex::new(TempCleanupState::default()),
        prompt_dispatch: Mutex::new(()),
        cancelled_prompts: Mutex::new(HashSet::new()),
        next_id: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        capabilities: Mutex::new(Value::Null),
        session_directories: Mutex::new(HashMap::new()),
        session_configs: Mutex::new(HashMap::new()),
        per_load_tokens: Mutex::new(HashMap::new()),
        native_subagents: Mutex::new(NativeSubagentRegistry::default()),
        session_profiles: Mutex::new(HashMap::new()),
        session_ui: Mutex::new(HashMap::new()),
        pending_directory: Mutex::new(None),
        session_creation: Mutex::new(()),
        restores: Mutex::new(HashMap::new()),
        restore_ready: Condvar::new(),
        idle: Mutex::new(crate::acp_idle::IdleSessions::default()),
        ready: Condvar::new(),
        _owned_temp: owned_temp,
    });
    start_temp_cleanup_watcher(&runtime)?;
    start_idle_exit_watcher(&runtime, app.clone())?;
    let reader = Arc::clone(&runtime);
    let reader_manager = manager.clone();
    let agent_id = agent.clone();
    let worktree_fence = app.state::<AgentWorktreeFence>().inner().clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            reader.touch();
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
            if let Some(owner) = &reader.owner {
                translate_session_ids(&mut message, owner, false);
            }
            if message
                .get("method")
                .and_then(Value::as_str)
                .is_some_and(|method| method.starts_with("sail/"))
            {
                crate::diagnostics::record(
                    "acp_reserved_method",
                    json!({"agent":agent_id,"method":message.get("method")}),
                );
                continue;
            }
            if message.get("method").is_some() {
                if let Some(params) = message.get_mut("params").and_then(Value::as_object_mut) {
                    params.insert("sailCapabilityProfile".into(), profile.as_str().into());
                }
            }
            if agent_id == "codex" {
                if let Some(mut normalized) =
                    codex_native_activity_update(&message, reader.owner.as_deref())
                {
                    if let Some(params) =
                        normalized.get_mut("params").and_then(Value::as_object_mut)
                    {
                        params.insert("sailCapabilityProfile".into(), profile.as_str().into());
                    }
                    let parent_id = normalized
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str);
                    let update = normalized.pointer("/params/update");
                    if let (Some(parent_id), Some(update)) = (parent_id, update) {
                        if let Err(error) = record_native_subagent_update(
                            &app,
                            &reader_manager,
                            &worktree_fence,
                            &reader,
                            &agent_id,
                            parent_id,
                            update,
                        ) {
                            crate::diagnostics::record(
                                "acp_native_activity_rejected",
                                json!({"agent":agent_id,"sessionId":parent_id,"error":error}),
                            );
                        } else {
                            let _ = app.emit(
                                "acp-event",
                                AgentEvent {
                                    agent: agent_id.clone(),
                                    directory: session_directory(&reader, parent_id),
                                    worktree: Some(reader.worktree.to_string_lossy().into_owned()),
                                    message: normalized,
                                },
                            );
                        }
                    }
                }
            }
            if agent_id == "claude" {
                let mut normalized = claude_native_activity_update(&message, |parent, child| {
                    reader.native_subagents.lock().ok().is_some_and(|native| {
                        native
                            .0
                            .get(child)
                            .is_some_and(|entry| entry.parent_session_id == parent)
                    })
                });
                if let Some(normalized) = normalized.as_mut() {
                    if let Some(params) =
                        normalized.get_mut("params").and_then(Value::as_object_mut)
                    {
                        params.insert("sailCapabilityProfile".into(), profile.as_str().into());
                    }
                    let parent_id = normalized
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str);
                    let update = normalized.pointer("/params/update");
                    if let (Some(parent_id), Some(update)) = (parent_id, update) {
                        if let Err(error) = record_native_subagent_update(
                            &app,
                            &reader_manager,
                            &worktree_fence,
                            &reader,
                            &agent_id,
                            parent_id,
                            update,
                        ) {
                            crate::diagnostics::record(
                                "acp_native_activity_rejected",
                                json!({"agent":agent_id,"sessionId":parent_id,"error":error}),
                            );
                        } else {
                            let _ = app.emit(
                                "acp-event",
                                AgentEvent {
                                    agent: agent_id.clone(),
                                    directory: session_directory(&reader, parent_id),
                                    worktree: Some(reader.worktree.to_string_lossy().into_owned()),
                                    message: normalized.clone(),
                                },
                            );
                        }
                    }
                }
            }
            if let Some(update) = message.pointer("/params/update") {
                if let Some(session_id) =
                    message.pointer("/params/sessionId").and_then(Value::as_str)
                {
                    if let Ok(mut prompts) = reader.prompt_state.lock() {
                        prompts.observe_update(session_id, update);
                    }
                    if let Ok(mut idle) = reader.idle.lock() {
                        idle.observe_update(session_id, update);
                    }
                    if let Err(error) = reader.remember_session_ui(session_id, update) {
                        crate::diagnostics::record(
                            "acp_session_ui_cache_failed",
                            json!({"agent":agent_id,"sessionId":session_id,"error":error}),
                        );
                    }
                    if let Some((activity, active)) = native_activity_fence(update) {
                        if let Some(directory) = reader
                            .session_directories
                            .lock()
                            .ok()
                            .and_then(|directories| directories.get(session_id).cloned())
                        {
                            app.state::<crate::browser_agent::BrowserManager>()
                                .set_unattributed_native_activity(
                                    &agent_id, &directory, session_id, activity, active,
                                );
                        }
                    }
                    if matches!(
                        update.get("sessionUpdate").and_then(Value::as_str),
                        Some("subagent_spawned" | "subagent_state_update")
                    ) {
                        if let Err(error) = record_native_subagent_update(
                            &app,
                            &reader_manager,
                            &worktree_fence,
                            &reader,
                            &agent_id,
                            session_id,
                            update,
                        ) {
                            crate::diagnostics::record(
                                "acp_native_update_rejected",
                                json!({"agent":agent_id,"sessionId":session_id,"error":error}),
                            );
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
                                #[cfg(unix)]
                                let scratch_owner = runtime.scratch_owner.as_deref();
                                #[cfg(not(unix))]
                                let scratch_owner = None;
                                #[cfg(unix)]
                                let build_directory =
                                    runtime.shared_build_directory.clone().or_else(|| {
                                        runtime
                                            .runtime_scratch
                                            .lock()
                                            .ok()?
                                            .as_ref()
                                            .map(|scratch| scratch.path().join("build"))
                                    });
                                #[cfg(not(unix))]
                                let build_directory = None::<PathBuf>;
                                let session_id = params
                                    .get("sessionId")
                                    .and_then(Value::as_str)
                                    .map(str::to_string);
                                let handle_request = || {
                                    crate::acp_terminal::handle(
                                        &app,
                                        &manager,
                                        &agent,
                                        runtime.profile,
                                        &method,
                                        params,
                                        crate::acp_terminal::TerminalContext {
                                            directory,
                                            scratch_owner,
                                            build_directory: build_directory.as_deref(),
                                            runtime_path: Some(runtime.runtime_path.as_os_str()),
                                            environment_id: Some(runtime.environment_id.as_str()),
                                        },
                                    )
                                };
                                let result = if method == "terminal/create" {
                                    match session_id {
                                        Some(session_id) => with_active_terminal_prompt(
                                            &runtime,
                                            &session_id,
                                            handle_request,
                                        ),
                                        None => {
                                            Err("Terminal request requires a session ID.".into())
                                        }
                                    }
                                } else {
                                    handle_request()
                                };
                                let response = match result {
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
                    let _ = attach_cancelled_elicitation_session(
                        &mut message,
                        &reader.elicitation_state,
                    );
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
                                    directory: session_directory(&reader, &session_id),
                                    worktree: Some(reader.worktree.to_string_lossy().into_owned()),
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
                        directory: message
                            .pointer("/params/sessionId")
                            .and_then(Value::as_str)
                            .and_then(|session_id| session_directory(&reader, session_id)),
                        worktree: Some(reader.worktree.to_string_lossy().into_owned()),
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
        if let Err(error) =
            worktree_fence.native_disconnected(&reader.alive, &reader.native_subagents)
        {
            reader.alive.store(false, Ordering::Release);
            crate::diagnostics::record(
                "acp_native_disconnect_failed",
                json!({"agent":agent_id,"error":error}),
            );
        }
        if let Ok(mut configs) = reader.session_configs.lock() {
            let browser = app.state::<crate::browser_agent::BrowserManager>();
            for (_, config) in configs.drain() {
                browser.release(&config.token);
            }
        }
        if let Ok(mut tokens) = reader.per_load_tokens.lock() {
            let browser = app.state::<crate::browser_agent::BrowserManager>();
            release_all_per_load_tokens(&mut tokens, |token| browser.release(token));
        }
        let mut session_ids = reader
            .session_profiles
            .lock()
            .map(|profiles| profiles.keys().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        session_ids.sort();
        let session_directories = reader
            .session_directories
            .lock()
            .map(|directories| {
                session_ids
                    .iter()
                    .filter_map(|id| {
                        directories
                            .get(id)
                            .map(|path| (id.clone(), path.to_string_lossy().into_owned()))
                    })
                    .collect::<HashMap<_, _>>()
            })
            .unwrap_or_default();
        crate::diagnostics::record(
            "agent_disconnected",
            json!({"agent":agent_id,"profile":profile.as_str(),"sessionIds":session_ids}),
        );
        if let Err(error) = app
            .state::<crate::acp_terminal::AcpTerminalManager>()
            .stop_sessions(&agent_id, profile, &reader.worktree, &session_ids)
        {
            crate::diagnostics::record(
                "owned_process_cleanup_failed",
                json!({"agent":agent_id,"error":error}),
            );
        }
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
                directory: None,
                worktree: Some(reader.worktree.to_string_lossy().into_owned()),
                message: json!({"method":"sail/disconnected","params":{
                    "profile":profile.as_str(),"sessionIds":session_ids,
                    "sessionDirectories":session_directories,
                    "releasedOwner":reader.released_owner.load(Ordering::Acquire),
                    "idle":reader.idle_exit.load(Ordering::Acquire)
                }}),
            },
        );
    });
    let mut agents = manager.0.lock().map_err(|error| error.to_string())?;
    if manager.3.load(Ordering::Acquire) != startup_generation {
        drop(agents);
        drop(_startup);
        runtime.terminate()?;
        return Err("Agent startup was cancelled.".into());
    }
    agents.insert(key, Arc::clone(&runtime));
    drop(agents);
    drop(_startup);
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
            let _ = runtime.terminate();
        })?;
    if result.get("protocolVersion").and_then(Value::as_u64) != Some(1) {
        let _ = runtime.terminate();
        return Err("Agent does not support ACP v1.".into());
    }
    if let Err(error) = require_owned_restore(&result, owner, definition.name) {
        let _ = runtime.terminate();
        return Err(error);
    }
    *runtime
        .capabilities
        .lock()
        .map_err(|error| error.to_string())? = result.clone();
    runtime.ready.notify_all();
    Ok(result)
}

fn provider_can_restore_session(capabilities: &Value) -> bool {
    capabilities.pointer("/agentCapabilities/loadSession") == Some(&Value::Bool(true))
        || capabilities
            .pointer("/agentCapabilities/sessionCapabilities/resume")
            .is_some_and(Value::is_object)
}

fn require_owned_restore(
    capabilities: &Value,
    owner: Option<&str>,
    provider: &str,
) -> Result<(), String> {
    if owner.is_some() && !provider_can_restore_session(capabilities) {
        return Err(format!(
            "{provider} does not advertise session restore. Its Ship run was not started; use a provider with session/load or session/resume."
        ));
    }
    Ok(())
}

fn provider_supports_restore_method(capabilities: &Value, method: &str) -> bool {
    match method {
        "session/load" => {
            capabilities.pointer("/agentCapabilities/loadSession") == Some(&Value::Bool(true))
        }
        "session/resume" => capabilities
            .pointer("/agentCapabilities/sessionCapabilities/resume")
            .is_some_and(Value::is_object),
        _ => false,
    }
}

#[tauri::command]
pub async fn acp_pending_permissions(
    manager: State<'_, AgentManager>,
    agent: String,
    directory: String,
    session_id: String,
) -> Result<Vec<Value>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = connection_for_session(&manager, &agent, &session_id, Path::new(&directory))?;
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
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_pending_elicitations(
    manager: State<'_, AgentManager>,
    agent: String,
    directory: String,
    session_id: String,
    profile: String,
) -> Result<Vec<Value>, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let profile = parse_profile(Some(&profile))?;
        let runtime = connection_for_elicitation(
            &manager,
            &agent,
            profile,
            Path::new(&directory),
            &session_id,
        )?;
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
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpElicitationParams {
    agent: String,
    directory: String,
    session_id: String,
    profile: String,
    request_id: Value,
    action: String,
    content: Option<Value>,
}

#[tauri::command]
pub async fn acp_elicitation(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    params: AcpElicitationParams,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let profile = parse_profile(Some(&params.profile))?;
        let runtime = connection_for_elicitation(
            &manager,
            &params.agent,
            profile,
            Path::new(&params.directory),
            &params.session_id,
        )?;
        let key = params.request_id.to_string();
        let pending =
            claim_pending_elicitation(&runtime.elicitation_state, &key, &params.session_id)?;
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
        let _ = app.emit(
            "acp-event",
            AgentEvent {
                agent: params.agent,
                directory: Some(params.directory),
                worktree: Some(runtime.worktree.to_string_lossy().into_owned()),
                message: json!({"method":"sail/elicitation_resolved","params":{
                    "sessionId":params.session_id,"requestId":params.request_id
                }}),
            },
        );
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpNewSessionParams {
    agent: String,
    cwd: String,
    native_generation: Option<u64>,
    profile: Option<String>,
    owner: Option<String>,
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
        owner,
    } = params;
    if !PathBuf::from(&cwd).is_dir() {
        return Err("Repository directory does not exist.".into());
    }
    let profile = parse_profile(profile.as_deref())?;
    let manager = manager.inner().clone();
    let browser = browser.inner().clone();
    let fence = fence.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        connect_blocking_owned(
            app.clone(),
            &manager,
            agent.clone(),
            profile,
            Path::new(&cwd),
            owner.as_deref(),
        )?;
        let runtime =
            connection_for_owner(&manager, &agent, profile, Path::new(&cwd), owner.as_deref())?;
        let config = browser.config_for_profile(
            &cwd,
            None,
            Some(&agent),
            Some(profile.as_str()),
            crate::background_priority::enabled(&app),
        )?;
        let mut servers = session_servers(mcp_server(&config));
        with_context_server(
            &mut servers,
            crate::context::provider_mcp_server(&app, Path::new(&cwd)),
        );
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
        if per_load_mcp() {
            let mut tokens = runtime
                .per_load_tokens
                .lock()
                .map_err(|error| error.to_string())?;
            if !store_per_load_token(
                &runtime.alive,
                &mut tokens,
                id,
                config.token.clone(),
                |token| browser.release(token),
            ) {
                let _ = fence.finish_session(&directory, native_generation);
                return Err("Agent process stopped. Reopen the thread to reconnect.".into());
            }
        } else {
            let mut configs = runtime
                .session_configs
                .lock()
                .map_err(|error| error.to_string())?;
            if !store_session_config(
                &runtime.alive,
                &mut configs,
                id,
                SessionConfig {
                    cwd: cwd.clone(),
                    directory: canonical_directory(&cwd),
                    servers,
                    token: config.token.clone(),
                },
                |token| browser.release(token),
            ) {
                let _ = fence.finish_session(&directory, native_generation);
                return Err("Agent process stopped. Reopen the thread to reconnect.".into());
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
            let _ = fence.release_session(&agent, &directory, id);
            return Err(error);
        }
        runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?
            .forgotten
            .remove(id);
        runtime.remember_session_ui(id, &result)?;
        if NEEDS_FIRST_TURN_AGENTS.contains(&agent.as_str()) {
            if let Ok(mut idle) = runtime.idle.lock() {
                idle.mark_fresh(id);
            }
        }
        browser.identify(&config.token, id);
        register_native_task_connections(&runtime, &browser)?;
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn acp_release_session_fence(
    fence: State<'_, AgentWorktreeFence>,
    agent: String,
    directory: String,
    session_id: String,
) -> Result<(), String> {
    fence.release_session(&agent, Path::new(&directory), &session_id)
}

fn cancel_before_forget(
    prompts: &Mutex<PromptState>,
    dispatch: &Mutex<()>,
    session_id: &str,
    cancel: impl FnOnce() -> Result<(), String>,
    timeout: Duration,
) -> Result<(), String> {
    // Serialize deletion's fence and cancel with the prompt write. An adapter can ignore
    // cancellation sent before it receives the prompt.
    let active = {
        let _dispatch = dispatch.lock().map_err(|error| error.to_string())?;
        let active = {
            let mut prompts = prompts.lock().map_err(|error| error.to_string())?;
            prompts.mark_forgotten(session_id);
            prompts.active.contains_key(session_id)
        };
        if active {
            if let Err(error) = cancel() {
                prompts
                    .lock()
                    .map_err(|cause| cause.to_string())?
                    .finish_forget(session_id, false);
                return Err(error);
            }
        }
        active
    };
    let result = (|| {
        if !active {
            return Ok(());
        }
        let deadline = Instant::now() + timeout;
        loop {
            if !prompts
                .lock()
                .map_err(|error| error.to_string())?
                .active
                .contains_key(session_id)
            {
                return Ok(());
            }
            if Instant::now() >= deadline {
                return Err("Agent turn did not stop; browser token remains active.".into());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    })();
    if result.is_err() {
        prompts
            .lock()
            .map_err(|error| error.to_string())?
            .finish_forget(session_id, false);
    }
    result
}

fn dispatch_prompt_if_current<T>(
    dispatch: &Mutex<()>,
    prompts: &Mutex<PromptState>,
    session_id: &str,
    turn_id: &str,
    write: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _dispatch = dispatch.lock().map_err(|error| error.to_string())?;
    let prompts = prompts.lock().map_err(|error| error.to_string())?;
    prompts.ensure_prompt_available(session_id)?;
    if !prompts
        .active
        .get(session_id)
        .is_some_and(|prompt| prompt.turn_id == turn_id)
        || prompts.finishing.contains(session_id)
    {
        return Err("This agent turn is no longer active.".into());
    }
    drop(prompts);
    write()
}

fn complete_restore_if_current(
    manager: &AgentManager,
    prompts: &Mutex<PromptState>,
    agent: &str,
    directory: &str,
    session_id: &str,
    manager_generation: u64,
    runtime_generation: u64,
) -> Result<(), String> {
    if manager.forget_generation(agent, directory, session_id)? != manager_generation {
        return Err("This agent thread was deleted while reconnecting.".into());
    }
    prompts
        .lock()
        .map_err(|error| error.to_string())?
        .complete_restore(session_id, runtime_generation)
}

/// E2E specs share one app process; release their fixture runtimes between specs.
/// The command is only permitted by the E2E capability and has no production effect.
#[tauri::command]
pub async fn acp_reset_test_runtimes(manager: State<'_, AgentManager>) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        #[cfg(feature = "e2e")]
        {
            manager.shutdown();
            Ok(())
        }
        #[cfg(not(feature = "e2e"))]
        {
            let _ = manager;
            Err("ACP test runtime reset requires the E2E build".into())
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

/// Cancels a deleted thread's active turn before releasing its browser token.
#[tauri::command]
pub async fn acp_forget_session(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    directory: String,
    session_id: String,
) -> Result<(), String> {
    manager.mark_forget(&agent, &directory, &session_id)?;
    for profile in [
        CapabilityProfile::Explore,
        CapabilityProfile::Review,
        CapabilityProfile::Build,
        CapabilityProfile::Release,
    ] {
        let Ok(runtime) = connection_for_owner(
            &manager,
            &agent,
            profile,
            Path::new(&directory),
            session_owner(&session_id),
        ) else {
            continue;
        };
        let waiting = Arc::clone(&runtime);
        let waiting_session = session_id.clone();
        let waiting_agent = agent.clone();
        let waiting_app = app.clone();
        let stopped = tauri::async_runtime::spawn_blocking(move || {
            cancel_before_forget(
                &waiting.prompt_state,
                &waiting.prompt_dispatch,
                &waiting_session,
                || {
                    cancel_session_after_dispatch(
                        &waiting_app,
                        &waiting,
                        &waiting_agent,
                        &waiting_session,
                        None,
                    )
                },
                Duration::from_secs(30),
            )
        })
        .await;
        match stopped {
            Ok(Ok(())) => {}
            Ok(Err(error)) => return Err(error),
            Err(error) => {
                runtime
                    .prompt_state
                    .lock()
                    .map_err(|cause| cause.to_string())?
                    .finish_forget(&session_id, false);
                return Err(error.to_string());
            }
        }
        if let Err(error) = runtime
            .restores
            .lock()
            .map(|mut claims| claims.remove(&session_id))
        {
            runtime
                .prompt_state
                .lock()
                .map_err(|cause| cause.to_string())?
                .finish_forget(&session_id, false);
            return Err(error.to_string());
        }
        runtime.restore_ready.notify_all();
        let cleared = forget_registered_session(&runtime, &session_id);
        if let Err(error) = cleared {
            runtime
                .prompt_state
                .lock()
                .map_err(|cause| cause.to_string())?
                .finish_forget(&session_id, false);
            return Err(error);
        }
        let mut configs = match runtime.session_configs.lock() {
            Ok(configs) => configs,
            Err(error) => {
                runtime
                    .prompt_state
                    .lock()
                    .map_err(|cause| cause.to_string())?
                    .finish_forget(&session_id, false);
                return Err(error.to_string());
            }
        };
        let mut session_ui = match runtime.session_ui.lock() {
            Ok(session_ui) => session_ui,
            Err(error) => {
                drop(configs);
                runtime
                    .prompt_state
                    .lock()
                    .map_err(|cause| cause.to_string())?
                    .finish_forget(&session_id, false);
                return Err(error.to_string());
            }
        };
        let removed = configs.remove(&session_id);
        session_ui.remove(&session_id);
        drop((configs, session_ui));
        if let Some(config) = removed {
            browser.release(&config.token);
        }
        let mut tokens = runtime
            .per_load_tokens
            .lock()
            .map_err(|error| error.to_string())?;
        release_session_tokens(&mut tokens, &session_id, |token| browser.release(token));
        runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?
            .finish_forget(&session_id, true);
        if runtime.supports_session_close() {
            let closing = Arc::clone(&runtime);
            let closing_session = session_id.clone();
            tauri::async_runtime::spawn_blocking(move || {
                close_deleted_session(&closing, &closing_session, || {
                    closing.request(
                        "session/close",
                        json!({"sessionId":closing_session}),
                        Duration::from_secs(30),
                    )
                });
            });
        }
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_begin_session_restore(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
    cwd: String,
    session_id: String,
    profile: Option<String>,
) -> Result<Value, String> {
    let manager_generation = manager.forget_generation(&agent, &cwd, &session_id)?;
    let profile = parse_profile(profile.as_deref())?;
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        connect_blocking_owned(
            app,
            &manager,
            agent.clone(),
            profile,
            Path::new(&cwd),
            session_owner(&session_id),
        )?;
        let runtime = manager.with_current_forget_generation(
            &agent,
            &cwd,
            &session_id,
            manager_generation,
            || {
                register_session_detached(
                    &manager,
                    &agent,
                    profile,
                    &session_id,
                    PathBuf::from(&cwd),
                )
            },
        )?;
        runtime.touch_session(&session_id);
        let result = runtime.begin_restore(&session_id)?;
        if let Err(error) = manager.with_current_forget_generation(
            &agent,
            &cwd,
            &session_id,
            manager_generation,
            || Ok(()),
        ) {
            if let Some(token) = result.get("restoreToken").and_then(Value::as_str) {
                runtime.release_restore(&session_id, token)?;
            }
            // The delete landed after the reservation registered the thread.
            unregister_session(&runtime, &session_id)?;
            return Err(error);
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_end_session_restore(
    manager: State<'_, AgentManager>,
    agent: String,
    directory: String,
    session_id: String,
    restore_token: String,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        release_session_restore(
            &manager,
            &agent,
            Path::new(&directory),
            &session_id,
            &restore_token,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn release_session_restore(
    manager: &AgentManager,
    agent: &str,
    directory: &Path,
    session_id: &str,
    token: &str,
) -> Result<(), String> {
    let worktree = worktree_identity(directory);
    let runtimes = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .filter(|runtime| runtime.agent == agent && runtime.worktree == worktree)
        .cloned()
        .collect::<Vec<_>>();
    for runtime in runtimes {
        runtime.release_restore(session_id, token)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn acp_load_session(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    params: RestoreSessionCommand,
) -> Result<Value, String> {
    restore_session(manager, app, browser, params, "session/load").await
}

#[tauri::command]
pub async fn acp_resume_session(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    params: RestoreSessionCommand,
) -> Result<Value, String> {
    restore_session(manager, app, browser, params, "session/resume").await
}

fn shared_listing_connection(
    manager: &AgentManager,
    agent: &str,
    profile: CapabilityProfile,
) -> Result<Option<Arc<Connection>>, String> {
    Ok(manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .find(|runtime| {
            runtime.agent == agent
                && runtime.profile == profile
                && runtime.owner.is_none()
                && runtime.reusable()
                && runtime
                    .capabilities
                    .lock()
                    .is_ok_and(|capabilities| !capabilities.is_null())
        })
        .cloned())
}

/// OpenCode lists any directory's sessions from one agent, so the sidebar shares a single explore
/// agent instead of starting one per repository and worktree.
fn listing_connection(
    app: &AppHandle,
    manager: &AgentManager,
    agent: &str,
    profile: CapabilityProfile,
    cwd: &Path,
) -> Result<(Arc<Connection>, Value), String> {
    let shared = agent == "opencode" && profile == CapabilityProfile::Explore;
    let _gate = if shared {
        Some(manager.4.lock().map_err(|error| error.to_string())?)
    } else {
        None
    };
    if shared {
        let existing = shared_listing_connection(manager, agent, profile)?;
        if let Some(runtime) = existing {
            runtime.touch();
            let capabilities = runtime
                .capabilities
                .lock()
                .map_err(|error| error.to_string())?
                .clone();
            return Ok((runtime, capabilities));
        }
    }
    let capabilities = connect_blocking(app.clone(), manager, agent.to_string(), profile, cwd)?;
    let runtime = connection_for_profile(manager, agent, profile, cwd)?;
    Ok((runtime, capabilities))
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
        let directory = canonical_directory(&cwd);
        let mut attempts = 0;
        loop {
            attempts += 1;
            let (runtime, capabilities) =
                listing_connection(&app, &manager, &agent, profile, &directory)?;
            if capabilities
                .pointer("/agentCapabilities/sessionCapabilities/list")
                .is_none()
            {
                return Ok(json!({"sessions": []}));
            }
            let params = session_list_params(&directory, cursor.as_deref());
            let result = runtime.request("session/list", params, Duration::from_secs(30));
            // The shared agent may exit (idle, worktree removal) between lookup and request;
            // the next lookup respawns it.
            if result.is_err() && attempts < 2 && !runtime.reusable() {
                continue;
            }
            return result;
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RestoreSessionCommand {
    agent: String,
    cwd: String,
    session_id: String,
    profile: Option<String>,
    restore_token: Option<String>,
}

fn with_restore_claim<T>(
    runtime: &Connection,
    session_id: &str,
    token: Option<&str>,
    request: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _guard = token
        .map(|token| runtime.begin_restore_request(session_id, token))
        .transpose()?;
    request()
}

async fn restore_session(
    manager: State<'_, AgentManager>,
    app: AppHandle,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    params: RestoreSessionCommand,
    method: &'static str,
) -> Result<Value, String> {
    let manager = manager.inner().clone();
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        restore_session_blocking(app, &manager, &browser, params, method, false)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn restore_session_blocking(
    app: AppHandle,
    manager: &AgentManager,
    browser: &crate::browser_agent::BrowserManager,
    params: RestoreSessionCommand,
    method: &'static str,
    resume_claimed: bool,
) -> Result<Value, String> {
    let RestoreSessionCommand {
        agent,
        cwd,
        session_id,
        profile,
        restore_token,
    } = params;
    let manager_generation = manager.forget_generation(&agent, &cwd, &session_id)?;
    let profile = parse_profile(profile.as_deref())?;
    {
        let capabilities = connect_blocking_owned(
            app.clone(),
            manager,
            agent.clone(),
            profile,
            Path::new(&cwd),
            session_owner(&session_id),
        )?;
        if !provider_supports_restore_method(&capabilities, method) {
            return Err(format!(
                "The provider no longer supports {method}. The saved conversation remains available; install a compatible provider version or start a new thread."
            ));
        }
        let runtime = manager.with_current_forget_generation(
            &agent,
            &cwd,
            &session_id,
            manager_generation,
            || {
                register_session_detached(
                    manager,
                    &agent,
                    profile,
                    &session_id,
                    PathBuf::from(&cwd),
                )
            },
        )?;
        let loaded = std::cell::Cell::new(false);
        let outcome = with_restore_claim(&runtime, &session_id, restore_token.as_deref(), || {
            // A reattach already holds the claim for the thread it resumes.
            let mut resume = if resume_claimed {
                None
            } else {
                runtime.begin_attaching_restore(&session_id)?
            };
            // Forget must not finish while this restore mints a browser token.
            let (forget_generation, params, minted_token) = manager
                .with_current_forget_generation(
                    &agent,
                    &cwd,
                    &session_id,
                    manager_generation,
                    || {
                        let forget_generation = runtime
                            .prompt_state
                            .lock()
                            .map_err(|error| error.to_string())?
                            .forget_generation
                            .get(&session_id)
                            .copied()
                            .unwrap_or(0);
                        let (mut params, minted_token) = {
                            let mut configs = runtime
                                .session_configs
                                .lock()
                                .map_err(|error| error.to_string())?;
                            if !runtime.alive.load(Ordering::Acquire) {
                                return Err(
                                    "Agent process stopped. Reopen the thread to reconnect."
                                        .to_string(),
                                );
                            }
                            let mut tokens = runtime
                                .per_load_tokens
                                .lock()
                                .map_err(|error| error.to_string())?;
                            restore_params(
                                per_load_mcp(),
                                RestoreConfigState {
                                    alive: &runtime.alive,
                                    configs: &mut configs,
                                    per_load_tokens: &mut tokens,
                                },
                                &session_id,
                                &cwd,
                                || {
                                    browser.config_for_profile(
                                        &cwd,
                                        Some(&session_id),
                                        Some(&agent),
                                        Some(profile.as_str()),
                                        crate::background_priority::enabled(&app),
                                    )
                                },
                                |token| browser.release(token),
                            )?
                        };
                        let context = crate::context::provider_mcp_server(&app, Path::new(&cwd));
                        if let Some(servers) =
                            params.get_mut("mcpServers").and_then(Value::as_array_mut)
                        {
                            with_context_server(servers, context);
                            if let Ok(mut configs) = runtime.session_configs.lock() {
                                if let Some(config) = configs.get_mut(&session_id) {
                                    config.servers = servers.clone();
                                }
                            }
                        }
                        Ok((forget_generation, params, minted_token))
                    },
                )?;
            register_native_task_connections(&runtime, browser)?;
            browser.clear_unattributed_native_activity(
                &agent,
                &canonical_directory(&cwd),
                &session_id,
            );
            let result = runtime.request(method, params, Duration::from_secs(60));
            browser.clear_unattributed_native_activity(
                &agent,
                &canonical_directory(&cwd),
                &session_id,
            );
            if result.is_err() {
                if let Some(token) = minted_token {
                    let mut tokens = runtime
                        .per_load_tokens
                        .lock()
                        .map_err(|error| error.to_string())?;
                    release_per_load_token(&mut tokens, &session_id, &token, |token| {
                        browser.release(token)
                    });
                }
                unregister_session(&runtime, &session_id)?;
            }
            let result = result?;
            loaded.set(true);
            complete_restore_if_current(
                manager,
                &runtime.prompt_state,
                &agent,
                &cwd,
                &session_id,
                manager_generation,
                forget_generation,
            )?;
            let restored = manager.with_current_forget_generation(
                &agent,
                &cwd,
                &session_id,
                manager_generation,
                || {
                    runtime.remember_session_ui(&session_id, &result)?;
                    Ok(result)
                },
            )?;
            if let Some(resume) = &mut resume {
                resume.resumed = true;
            }
            Ok(restored)
        });
        // A delete that lands during the restore leaves nothing registered for the thread.
        if outcome.is_err()
            && unregister_if_deleted(&runtime, &session_id)?
            && loaded.get()
            && runtime.supports_session_close()
        {
            // The idle sweep no longer sees the thread, so release what the resume loaded.
            if let Err(error) = runtime.request(
                "session/close",
                json!({"sessionId":session_id}),
                Duration::from_secs(30),
            ) {
                crate::diagnostics::record(
                    "deleted_session_close_failed",
                    json!({"agent":agent,"sessionId":session_id,"error":error}),
                );
            }
        }
        outcome
    }
}

/// Unregisters a thread whose delete is committed or in progress, whether it began before or
/// during the failed restore. An aborted delete clears its fence, so a live thread stays registered.
fn unregister_if_deleted(runtime: &Connection, session_id: &str) -> Result<bool, String> {
    let forgotten = runtime
        .prompt_state
        .lock()
        .map_err(|error| error.to_string())?
        .forgotten
        .contains(session_id);
    if forgotten {
        unregister_session(runtime, session_id)?;
    }
    Ok(forgotten)
}

fn forget_registered_session(runtime: &Connection, session_id: &str) -> Result<(), String> {
    runtime
        .idle
        .lock()
        .map_err(|error| error.to_string())?
        .forget(session_id);
    unregister_session(runtime, session_id)
}

fn close_deleted_session(
    runtime: &Connection,
    session_id: &str,
    close: impl FnOnce() -> Result<Value, String>,
) {
    if let Err(error) = close() {
        crate::diagnostics::record(
            "deleted_session_close_failed",
            json!({"agent":runtime.agent,"sessionId":session_id,"error":error}),
        );
    }
}

fn unregister_session(runtime: &Connection, session_id: &str) -> Result<(), String> {
    runtime
        .session_directories
        .lock()
        .map_err(|error| error.to_string())?
        .remove(session_id);
    runtime
        .session_profiles
        .lock()
        .map_err(|error| error.to_string())?
        .remove(session_id);
    Ok(())
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
    directory: String,
    session_id: String,
    text: String,
    turn_id: String,
    image_paths: Vec<String>,
}

const TASK_REPORT_GUIDANCE: &str = "Sail Tasks: For this turn, read sail_tasks_read and report your work with sail_tasks_report before finishing. Use stable task IDs and honest pending/in_progress/done/blocked/skipped states; set focus to current in_progress work or null. Pass the read turnId and expectedRevision, and reread after stale errors. A report is accepted only when the tool succeeds. If there are no tasks, report tasks: [] and focus: null.";
const TASK_REPORT_CORRECTION: &str = "Sail did not receive a successful task report for this turn. Read sail_tasks_read, then call sail_tasks_report once with the actual task state and focus (or tasks: [] and focus: null if there is no work). Do not perform more work or repeat the user request. This is the only corrective request.";

fn prompt_completion_error(
    error: Option<&String>,
    explicitly_cancelled: bool,
    cancelled_result: bool,
    reported_interruption: bool,
) -> Option<String> {
    if let Some(error) = error.filter(|error| !error.trim().is_empty()) {
        return Some(error.clone());
    }
    if explicitly_cancelled {
        Some("Worker cancelled by an explicit stop request.".into())
    } else if cancelled_result {
        Some("Provider ended the worker turn with stop reason cancelled.".into())
    } else if reported_interruption {
        Some("Provider reported that the worker turn was interrupted; inspect its thread and task checkpoint before retrying.".into())
    } else {
        None
    }
}

#[cfg(test)]
mod prompt_completion_error_tests {
    use super::prompt_completion_error;

    #[test]
    fn interruption_causes_survive_successful_provider_responses() {
        assert!(prompt_completion_error(None, true, false, false)
            .unwrap()
            .contains("explicit stop request"));
        assert!(prompt_completion_error(None, false, true, false)
            .unwrap()
            .contains("stop reason cancelled"));
        assert!(prompt_completion_error(None, false, false, true)
            .unwrap()
            .contains("Provider reported"));
        assert_eq!(prompt_completion_error(None, false, false, false), None);
    }

    #[test]
    fn provider_error_is_preserved_over_cancellation_fallback() {
        assert_eq!(
            prompt_completion_error(
                Some(&"transport closed during cancellation".into()),
                true,
                true,
                true
            ),
            Some("transport closed during cancellation".into())
        );
    }
}

fn task_report_correction_eligible(response: &Value, cancelled: bool, interrupted: bool) -> bool {
    !cancelled
        && !interrupted
        && response.get("error").is_none()
        && response
            .pointer("/result/stopReason")
            .and_then(Value::as_str)
            == Some("end_turn")
        && response
            .pointer("/result/sailInterrupted")
            .and_then(Value::as_bool)
            != Some(true)
}

#[cfg(test)]
mod task_reporting_tests {
    use super::*;

    #[test]
    fn only_normal_completed_turns_request_missing_reports() {
        let ended = json!({"result":{"stopReason":"end_turn"}});
        assert!(task_report_correction_eligible(&ended, false, false));
        assert!(!task_report_correction_eligible(&ended, true, false));
        assert!(!task_report_correction_eligible(&ended, false, true));
        for response in [
            json!({"result":{"stopReason":"cancelled"}}),
            json!({"result":{"stopReason":"max_tokens"}}),
            json!({"result":{"stopReason":"end_turn","sailInterrupted":true}}),
            json!({"error":{"message":"provider failed"}}),
            json!({"result":null}),
        ] {
            assert!(!task_report_correction_eligible(&response, false, false));
        }
    }

    #[test]
    fn stop_cannot_overtake_a_corrective_prompt_write() {
        let dispatch = Arc::new(Mutex::new(()));
        let prompts = Arc::new(Mutex::new(PromptState::default()));
        prompts.lock().unwrap().active.insert(
            "session".into(),
            ActivePrompt {
                turn_id: "turn".into(),
                text: "task".into(),
                dispatched: true,
                memory_capture: crate::memory_capture::TurnCapture::default(),
                last_agent_message: String::new(),
                agent_message_open: false,
                agent_message_overflow: false,
                known_tool_calls: HashSet::new(),
            },
        );
        let writes = Arc::new(Mutex::new(Vec::new()));
        let (checked_tx, checked_rx) = mpsc::channel();
        let (release_tx, release_rx) = mpsc::channel();
        let writer = {
            let dispatch = Arc::clone(&dispatch);
            let prompts = Arc::clone(&prompts);
            let writes = Arc::clone(&writes);
            std::thread::spawn(move || {
                dispatch_prompt_if_current(&dispatch, &prompts, "session", "turn", || {
                    checked_tx.send(()).unwrap();
                    release_rx.recv().unwrap();
                    writes.lock().unwrap().push("prompt");
                    Ok(())
                })
            })
        };
        checked_rx.recv().unwrap();
        assert!(dispatch.try_lock().is_err());
        let (cancel_started_tx, cancel_started_rx) = mpsc::channel();
        let cancel = {
            let dispatch = Arc::clone(&dispatch);
            let prompts = Arc::clone(&prompts);
            let writes = Arc::clone(&writes);
            std::thread::spawn(move || {
                cancel_started_tx.send(()).unwrap();
                cancel_prompt_dispatch(&dispatch, || {
                    prompts.lock().unwrap().finishing.insert("session".into());
                    writes.lock().unwrap().push("cancel");
                    Ok(())
                })
            })
        };
        cancel_started_rx.recv().unwrap();
        assert!(writes.lock().unwrap().is_empty());
        release_tx.send(()).unwrap();
        writer.join().unwrap().unwrap();
        cancel.join().unwrap().unwrap();
        assert_eq!(*writes.lock().unwrap(), ["prompt", "cancel"]);
        assert!(dispatch_prompt_if_current(
            &dispatch,
            &prompts,
            "session",
            "turn",
            || -> Result<(), String> { panic!("A correction must not dispatch after Stop") }
        )
        .is_err());
    }
}

#[tauri::command]
pub async fn acp_prompt(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    params: AcpPromptParams,
) -> Result<Value, String> {
    let AcpPromptParams {
        agent,
        directory,
        session_id,
        text,
        turn_id,
        image_paths,
    } = params;
    let mut content = prepare_prompt_content(&app, &text, image_paths).await?;
    content.push(json!({"type":"text","text":TASK_REPORT_GUIDANCE}));
    let runtime = connection_for_session_reattaching(
        &app,
        &manager,
        &browser,
        &agent,
        &session_id,
        Path::new(&directory),
    )
    .await?;
    let preflight_runtime = Arc::clone(&runtime);
    let preflight_session = session_id.clone();
    let preflight_turn = turn_id.clone();
    let preflight_text = text.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let claims = preflight_runtime
            .restores
            .lock()
            .map_err(|error| error.to_string())?;
        let _claims = preflight_runtime.wait_for_restore(claims, &preflight_session)?;
        let _temp_gate = preflight_runtime
            .temp_cleanup_gate
            .lock()
            .map_err(|error| error.to_string())?;
        let mut prompts = preflight_runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?;
        prompts.ensure_prompt_available(&preflight_session)?;
        if !preflight_runtime
            .session_profiles
            .lock()
            .map_err(|error| error.to_string())?
            .contains_key(&preflight_session)
        {
            return Err("Agent session is not connected in this worktree.".to_string());
        }
        if preflight_runtime
            .cancelled_prompts
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&preflight_turn)
        {
            return Err("Agent turn was cancelled.".into());
        }
        if prompts.active.contains_key(&preflight_session)
            || prompts.finishing.contains(&preflight_session)
        {
            return Err("This agent thread already has an active turn.".to_string());
        }
        let processed_generation = preflight_runtime.reader_progress.processed()?;
        if !preflight_runtime
            .permission_state
            .lock()
            .map_err(|error| error.to_string())?
            .begin_turn(&preflight_session, processed_generation)
        {
            return Err("The previous cancelled turn is still settling.".into());
        }
        prompts.finished.remove(&preflight_session);
        prompts.active.insert(
            preflight_session,
            ActivePrompt {
                turn_id: preflight_turn,
                text: preflight_text,
                dispatched: false,
                memory_capture: crate::memory_capture::TurnCapture::default(),
                last_agent_message: String::new(),
                agent_message_open: false,
                agent_message_overflow: false,
                known_tool_calls: HashSet::new(),
            },
        );
        Ok::<(), String>(())
    })
    .await
    .map_err(|error| error.to_string())??;
    if let Err(error) = crate::settings::record_acp_turn_evidence(
        &app,
        crate::settings::AcpTurnEvidence {
            agent: agent.clone(),
            directory: directory.clone(),
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            status: "prepared".into(),
            error: None,
            updated_at: 0,
            post_turn_pending: true,
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
        let evidence_directory = directory.clone();
        let dispatch_phase = Arc::new(AtomicU8::new(0));
        let uncertain_phase = Arc::clone(&dispatch_phase);
        let dispatched_phase = Arc::clone(&dispatch_phase);
        let uncertain_app = app.clone();
        let uncertain_agent = agent.clone();
        let uncertain_session = session_id.clone();
        let uncertain_turn = turn_id.clone();
        let uncertain_directory = directory.clone();
        let dispatch_agent = agent.clone();
        let dispatch_session = session_id.clone();
        let dispatch_turn = turn_id.clone();
        let dispatch_directory = PathBuf::from(directory.clone());
        let writer = Arc::clone(&runtime);
        let mut response = runtime.request_response_around_write(
            "session/prompt",
            json!({
                "sessionId":session_id,"prompt":content
            }),
            Duration::from_secs(60 * 60 * 3),
            move |message| {
                dispatch_prompt_if_current(
                    &writer.prompt_dispatch,
                    &writer.prompt_state,
                    &dispatch_session,
                    &dispatch_turn,
                    || {
                        dispatch_fence.dispatch_session(
                            &dispatch_agent,
                            &dispatch_directory,
                            &dispatch_session,
                            || {
                                crate::settings::record_acp_turn_evidence(
                                    &uncertain_app,
                                    crate::settings::AcpTurnEvidence {
                                        agent: uncertain_agent,
                                        directory: uncertain_directory,
                                        session_id: uncertain_session,
                                        turn_id: uncertain_turn,
                                        status: "dispatch_uncertain".into(),
                                        error: None,
                                        updated_at: 0,
                                        post_turn_pending: false,
                                    },
                                )
                                .map_err(|error| {
                                    format!(
                                        "Cannot persist uncertain prompt dispatch before sending: {error}"
                                    )
                                })?;
                                uncertain_phase.store(1, Ordering::Release);
                                writer.write(message)?;
                                let mut prompts = writer
                                    .prompt_state
                                    .lock()
                                    .map_err(|error| error.to_string())?;
                                let prompt = prompts
                                    .active
                                    .get_mut(&dispatch_session)
                                    .filter(|prompt| prompt.turn_id == dispatch_turn)
                                    .ok_or("This agent turn is no longer active.")?;
                                prompt.dispatched = true;
                                Ok(())
                            },
                        )
                    },
                )
            },
            move || {
                match crate::settings::record_acp_turn_evidence(
                    &evidence_app,
                    crate::settings::AcpTurnEvidence {
                        agent: evidence_agent.clone(),
                        directory: evidence_directory.clone(),
                        session_id: evidence_session.clone(),
                        turn_id: evidence_turn.clone(),
                        status: "dispatched".into(),
                        error: None,
                        updated_at: 0,
                        post_turn_pending: false,
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
        let cancelled = runtime
            .cancelled_prompts
            .lock()
            .map(|cancelled| cancelled.contains(&turn_id))
            .unwrap_or(true);
        let interrupted = runtime
            .prompt_state
            .lock()
            .ok()
            .and_then(|prompts| prompts.active.get(&session_id).map(ActivePrompt::reports_interruption))
            .unwrap_or(false);
        if response.as_ref().is_ok_and(|response| {
            task_report_correction_eligible(&response.message, cancelled, interrupted)
        }) {
            let correction = app.state::<crate::browser_agent::BrowserManager>().check_task_report(
                &app, &agent, Path::new(&directory), &session_id, &turn_id,
            );
            match correction {
                Ok(true) => {
                    let writer = Arc::clone(&runtime);
                    let correction_session = session_id.clone();
                    let correction_turn = turn_id.clone();
                    response = runtime.request_response_around_write(
                        "session/prompt",
                        json!({"sessionId":session_id,"prompt":[{"type":"text","text":TASK_REPORT_CORRECTION}]}),
                        Duration::from_secs(60 * 60 * 3),
                        move |message| dispatch_prompt_if_current(
                            &writer.prompt_dispatch, &writer.prompt_state,
                            &correction_session, &correction_turn, || writer.write(message),
                        ),
                        || {},
                    );
                }
                Ok(false) => {}
                Err(error) => crate::diagnostics::record(
                    "task_report_check_failed",
                    json!({"agent":agent,"sessionId":session_id,"turnId":turn_id,"error":error}),
                ),
            }
        }
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
            .map(|cancelled| cancelled.contains(&turn_id))
            .unwrap_or(true);
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
        let interrupted = explicitly_cancelled
            || cancelled_result
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
        let notify = !explicitly_cancelled && !interrupted;
        let completion_error = prompt_completion_error(
            result.as_ref().err(),
            explicitly_cancelled,
            cancelled_result,
            reported_interruption && result.is_ok(),
        );
        if interrupted {
            if let (Ok(Value::Object(payload)), Some(reason)) = (&mut result, &completion_error) {
                payload.insert("sailInterruptionReason".into(), Value::String(reason.clone()));
            }
        }
        let completion_evidence = crate::settings::AcpTurnEvidence {
            agent: agent.clone(),
            directory: directory.clone(),
            session_id: session_id.clone(),
            turn_id: turn_id.clone(),
            status: evidence_status.into(),
            error: completion_error.clone(),
            updated_at: 0,
            post_turn_pending: evidence_status == "done" && notify,
        };
        let report_evidence_error = |error: &str| {
            crate::diagnostics::record(
                "acp_turn_evidence_failed",
                json!({"agent":agent,"sessionId":session_id,"turnId":turn_id,"error":error}),
            );
        };
        let completion_write_error = if completion_evidence.post_turn_pending {
            retry_completed_turn_evidence(
                || crate::settings::record_acp_turn_evidence(&app, completion_evidence.clone()),
                |error| report_evidence_error(error),
                std::thread::sleep,
                4,
            )
            .err()
        } else if let Err(error) =
            crate::settings::record_acp_turn_evidence(&app, completion_evidence.clone())
        {
            report_evidence_error(&error);
            None
        } else {
            None
        };
        crate::diagnostics::record("prompt_finished", json!({
            "agent":agent,"sessionId":session_id,"turnId":turn_id,
            "status":status,"explicitlyCancelled":explicitly_cancelled,
            "reportedInterruption":reported_interruption,
            "reportedErrorInterruption":reported_error_interruption,
            "stopReason":result.as_ref().ok().and_then(|value| value.get("stopReason")).and_then(Value::as_str)
        }));
        let stop_reason = result
            .as_ref()
            .ok()
            .and_then(|value| value.get("stopReason"))
            .and_then(Value::as_str);
        let directory = runtime
            .session_directories
            .lock()
            .ok()
            .and_then(|directories| directories.get(&session_id).cloned());
        let candidates = runtime
            .prompt_state
            .lock()
            .ok()
            .and_then(|prompts| {
                let directory = directory.as_ref()?;
                prompts.active.get(&session_id).map(|prompt| {
                    prompt.memory_capture.completed_candidates(
                        status,
                        stop_reason,
                        explicitly_cancelled,
                        &directory.to_string_lossy(),
                        &agent,
                        &session_id,
                    )
                })
            })
            .unwrap_or_default();
        if let Ok(mut cancelled) = runtime.cancelled_prompts.lock() {
            cancelled.remove(&turn_id);
        }
        crate::memory_capture::store_completed(&app, candidates);
        let mut process_cleanup_succeeded = false;
        let latest = finish_prompt_after_cleanup(
            &runtime.prompt_state,
            &session_id,
            &turn_id,
            PromptOutcome {
                status,
                notify,
                error: completion_error.clone(),
                turn_id: turn_id.clone(),
            },
            || {
                if let Some(directory) = directory.as_ref() {
                    app.state::<crate::browser_agent::BrowserManager>()
                        .clear_unattributed_native_activity(&agent, directory, &session_id);
                }
                if !runtime.stopped.load(Ordering::Acquire) {
                    if let Some(directory) = directory.as_ref() {
                    let _ = crate::settings::clear_interrupted_turn(
                        &app,
                        &agent,
                        &directory.to_string_lossy(),
                        &session_id,
                        &turn_id,
                    );
                    }
                }
                let clean = cleanup_session_processes(&app, &runtime, &agent, &session_id);
                process_cleanup_succeeded =
                    runtime.record_process_cleanup(&session_id, clean).is_ok() && clean;
            },
        );
        if latest && process_cleanup_succeeded {
            if let Err(error) = runtime.clear_idle_temp(true) {
                if let Some(lease) = &runtime._storage_lease {
                    lease.mark_temp_pending("turn-temp-cleanup-failed");
                }
                crate::diagnostics::record(
                    "turn_temp_cleanup_failed",
                    json!({"agent":agent,"turnId":turn_id,"error":error}),
                );
            }
        }
        let promotion_error = if latest {
            promote_idle_worktree(&app, &runtime.worktree).err()
        } else {
            None
        };
        let finished_event = AgentEvent {
            agent: agent.clone(),
            directory: directory.map(|path| path.to_string_lossy().into_owned()),
            worktree: Some(runtime.worktree.to_string_lossy().into_owned()),
            message: json!({"method":"sail/prompt_finished","params":{
                "sessionId":session_id,"turnId":turn_id,"status":status,"notify":notify,
                "error":completion_error,
                "gitPromotionError":promotion_error,
                "sailCapabilityProfile":runtime.profile.as_str()
            }}),
        };
        if let Some(write_error) = completion_write_error {
            if latest {
                let mut pending_event = finished_event.clone();
                pending_event.message["params"]["notify"] = Value::Bool(false);
                pending_event.message["params"]["evidenceError"] = Value::String(write_error);
                let _ = app.emit("acp-event", pending_event);
            }
            let retry_app = app.clone();
            let evidence_directory = completion_evidence.directory.clone();
            // The retry belongs to the app, not the ACP connection: disconnecting the agent
            // must not discard a completion whose check is still pending.
            drop(tauri::async_runtime::spawn(async move {
                retry_completion_evidence_after_cleanup(
                    || {
                        crate::settings::record_acp_turn_evidence(
                            &retry_app,
                            completion_evidence.clone(),
                        )
                    },
                    |error| {
                        crate::diagnostics::record(
                            "acp_turn_evidence_failed",
                            json!({"agent":agent,"sessionId":session_id,"turnId":turn_id,
                                "error":error}),
                        );
                    },
                    tokio::time::sleep,
                    || {
                        if latest {
                            let _ = retry_app.emit(
                                "acp-event",
                                AgentEvent {
                                    agent: finished_event.agent,
                                    directory: Some(evidence_directory),
                                    worktree: finished_event.worktree,
                                    message: json!({"method":"sail/post_turn_evidence_ready","params":{
                                        "sessionId":session_id,"turnId":turn_id
                                    }}),
                                },
                            );
                        }
                    },
                )
                .await;
            }));
        } else if latest {
            let _ = app.emit("acp-event", finished_event);
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
    directory: String,
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
        directory,
        session_id,
        text,
        image_paths,
    } = params;
    let runtime = connection_for_session(&manager, &agent, &session_id, Path::new(&directory))?;
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

fn runtime_has_live_children(root: u32, temp_directory: Option<&Path>) -> bool {
    let system = sysinfo::System::new_all();
    let root = sysinfo::Pid::from_u32(root);
    system.processes().values().any(|process| {
        if process.pid() == root
            || matches!(
                process.status(),
                sysinfo::ProcessStatus::Zombie | sysinfo::ProcessStatus::Dead
            )
        {
            return false;
        }
        #[cfg(unix)]
        if process.session_id() == Some(root) {
            return true;
        }
        if temp_directory
            .is_some_and(|directory| crate::worktree_storage::process_uses_temp(process, directory))
        {
            return true;
        }
        let mut parent = process.parent();
        while let Some(pid) = parent {
            if pid == root {
                return true;
            }
            parent = system.process(pid).and_then(sysinfo::Process::parent);
        }
        false
    })
}

/// The text `recoverMissingSession` retries on after reattaching the session.
const IDLE_EXIT_ERROR: &str = "Agent session is not connected in this worktree.";

const OPENCODE_IDLE_TIMEOUT: Duration = Duration::from_secs(600);

/// A listing-only agent has no session to resume, so it leaves well before a working agent does;
/// the next listing starts it again.
const OPENCODE_LISTING_IDLE_TIMEOUT: Duration = Duration::from_secs(120);

/// Idle limit for OpenCode agents; `SAIL_OPENCODE_IDLE_TIMEOUT_SECS=0` keeps them until app exit.
fn opencode_idle_timeout() -> Option<Duration> {
    match std::env::var("SAIL_OPENCODE_IDLE_TIMEOUT_SECS")
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
    {
        Some(0) => None,
        Some(seconds) => Some(Duration::from_secs(seconds)),
        None => Some(OPENCODE_IDLE_TIMEOUT),
    }
}

fn start_idle_exit_watcher(runtime: &Arc<Connection>, app: AppHandle) -> Result<(), String> {
    let Some(timeout) = opencode_idle_timeout() else {
        return Ok(());
    };
    if runtime.agent != "opencode" || runtime.owner.is_some() {
        return Ok(());
    }
    let weak = Arc::downgrade(runtime);
    let tick = (timeout / 4).clamp(Duration::from_millis(50), Duration::from_secs(5));
    std::thread::Builder::new()
        .name("sail-agent-idle-exit".into())
        .spawn(move || loop {
            std::thread::sleep(tick);
            let Some(runtime) = weak.upgrade() else {
                break;
            };
            if runtime.stopped.load(Ordering::Acquire) || !runtime.alive.load(Ordering::Acquire) {
                break;
            }
            let exited = runtime.exit_if_idle(timeout, || {
                let session_ids = runtime
                    .session_profiles
                    .lock()
                    .map(|profiles| profiles.keys().cloned().collect::<Vec<_>>())
                    .unwrap_or_default();
                app.state::<crate::acp_terminal::AcpTerminalManager>()
                    .has_running_sessions(
                        &runtime.agent,
                        runtime.profile,
                        &runtime.worktree,
                        &session_ids,
                    )
            });
            if exited {
                break;
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Cannot watch agent idle time: {error}"))
}

fn start_temp_cleanup_watcher(runtime: &Arc<Connection>) -> Result<(), String> {
    let weak = Arc::downgrade(runtime);
    std::thread::Builder::new()
        .name("sail-turn-temp-cleanup".into())
        .spawn(move || {
            let mut last_error = None;
            loop {
                std::thread::sleep(Duration::from_secs(1));
                let Some(runtime) = weak.upgrade() else {
                    break;
                };
                if runtime.stopped.load(Ordering::Acquire) {
                    break;
                }
                match runtime.clear_idle_temp(false) {
                    Ok(()) => last_error = None,
                    Err(error) => {
                        if let Some(lease) = &runtime._storage_lease {
                            lease.mark_temp_pending("turn-temp-cleanup-failed");
                        }
                        if last_error.as_ref() != Some(&error) {
                            crate::diagnostics::record(
                                "turn_temp_cleanup_failed",
                                json!({"agent":runtime.agent,"error":error}),
                            );
                            last_error = Some(error);
                        }
                    }
                }
            }
        })
        .map(|_| ())
        .map_err(|error| format!("Cannot watch private temporary cleanup: {error}"))
}

#[cfg(unix)]
struct PausedAgent {
    pid: u32,
    started_at: u64,
}

#[cfg(unix)]
impl PausedAgent {
    fn new(pid: u32) -> Result<Self, String> {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let system = sysinfo::System::new_all();
        let process = system
            .process(sysinfo::Pid::from_u32(pid))
            .ok_or("Agent exited before temporary cleanup.")?;
        if process.status() == sysinfo::ProcessStatus::Stop {
            return Err("Agent was already paused before temporary cleanup.".into());
        }
        let started_at = process.start_time();
        kill(Pid::from_raw(pid as i32), Signal::SIGSTOP)
            .map_err(|error| format!("Cannot pause agent for temporary cleanup: {error}"))?;
        let pause = Self { pid, started_at };
        let pid = sysinfo::Pid::from_u32(pid);
        for _ in 0..100 {
            let system = sysinfo::System::new_all();
            match system.process(pid) {
                Some(process)
                    if process.start_time() == started_at
                        && process.status() == sysinfo::ProcessStatus::Stop =>
                {
                    return Ok(pause);
                }
                None => return Err("Agent exited before temporary cleanup.".into()),
                _ => std::thread::sleep(Duration::from_millis(10)),
            }
        }
        Err("Agent did not pause for temporary cleanup.".into())
    }
}

#[cfg(unix)]
impl Drop for PausedAgent {
    fn drop(&mut self) {
        use nix::sys::signal::{kill, Signal};
        use nix::unistd::Pid;

        let system = sysinfo::System::new_all();
        if !system
            .process(sysinfo::Pid::from_u32(self.pid))
            .is_some_and(|process| process.start_time() == self.started_at)
        {
            return;
        }
        if let Err(error) = kill(Pid::from_raw(self.pid as i32), Signal::SIGCONT) {
            crate::diagnostics::record(
                "turn_temp_cleanup_failed",
                json!({"error":format!("Cannot resume agent after temporary cleanup: {error}")}),
            );
        }
    }
}

#[cfg(windows)]
struct PausedAgent(Vec<std::os::windows::io::OwnedHandle>);

#[cfg(windows)]
impl PausedAgent {
    fn new(pid: u32) -> Result<Self, String> {
        use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        };
        use windows::Win32::System::Threading::{OpenThread, SuspendThread, THREAD_SUSPEND_RESUME};

        let mut pause = Self(Vec::new());
        let mut suspended = HashSet::new();
        for _ in 0..16 {
            let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
                .map_err(|error| format!("Cannot inspect agent threads: {error}"))?;
            let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
            let mut entry = THREADENTRY32 {
                dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
                ..Default::default()
            };
            let mut first = true;
            let mut newly_suspended = 0;
            loop {
                let result = unsafe {
                    if first {
                        first = false;
                        Thread32First(HANDLE(snapshot.as_raw_handle() as _), &mut entry)
                    } else {
                        Thread32Next(HANDLE(snapshot.as_raw_handle() as _), &mut entry)
                    }
                };
                if result.is_err() {
                    break;
                }
                if entry.th32OwnerProcessID != pid || suspended.contains(&entry.th32ThreadID) {
                    continue;
                }
                let thread =
                    unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                        .map_err(|error| format!("Cannot open agent thread for pause: {error}"))?;
                let thread = unsafe { OwnedHandle::from_raw_handle(thread.0) };
                if unsafe { SuspendThread(HANDLE(thread.as_raw_handle() as _)) } == u32::MAX {
                    return Err(format!(
                        "Cannot pause agent thread: {}",
                        std::io::Error::last_os_error()
                    ));
                }
                pause.0.push(thread);
                suspended.insert(entry.th32ThreadID);
                newly_suspended += 1;
            }
            if newly_suspended == 0 {
                return if pause.0.is_empty() {
                    Err("Agent exited before temporary cleanup.".into())
                } else {
                    Ok(pause)
                };
            }
        }
        Err("Agent threads did not pause for temporary cleanup.".into())
    }
}

#[cfg(windows)]
impl Drop for PausedAgent {
    fn drop(&mut self) {
        use std::os::windows::io::AsRawHandle;
        use windows::Win32::Foundation::HANDLE;
        use windows::Win32::System::Threading::ResumeThread;

        for thread in self.0.iter().rev() {
            if unsafe { ResumeThread(HANDLE(thread.as_raw_handle() as _)) } == u32::MAX {
                crate::diagnostics::record(
                    "turn_temp_cleanup_failed",
                    json!({"error":format!("Cannot resume agent thread: {}", std::io::Error::last_os_error())}),
                );
            }
        }
    }
}

fn finish_prompt_after_cleanup(
    state: &Mutex<PromptState>,
    session_id: &str,
    turn_id: &str,
    outcome: PromptOutcome,
    cleanup: impl FnOnce(),
) -> bool {
    let latest = state.lock().is_ok_and(|mut prompts| {
        let latest = prompts
            .active
            .get(session_id)
            .is_some_and(|prompt| prompt.turn_id == turn_id);
        if latest {
            prompts.finishing.insert(session_id.to_string());
        }
        latest
    });
    if !latest {
        return false;
    }
    // Keep the old turn active while cleanup runs so the next turn cannot start.
    cleanup();
    let Ok(mut prompts) = state.lock() else {
        return false;
    };
    if !prompts
        .active
        .get(session_id)
        .is_some_and(|prompt| prompt.turn_id == turn_id)
    {
        return false;
    }
    prompts.active.remove(session_id);
    prompts.finishing.remove(session_id);
    prompts.finished.insert(session_id.to_string(), outcome);
    true
}

fn with_active_terminal_prompt_state<T>(
    state: &Mutex<PromptState>,
    session_id: &str,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let prompts = state.lock().map_err(|error| error.to_string())?;
    if !prompts.active.contains_key(session_id) || prompts.finishing.contains(session_id) {
        return Err("This agent turn is no longer accepting terminal commands.".into());
    }
    action()
}

fn with_active_terminal_prompt<T>(
    runtime: &Connection,
    session_id: &str,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    with_active_terminal_prompt_state(&runtime.prompt_state, session_id, action)
}

pub fn with_active_owned_terminal<T>(
    manager: &AgentManager,
    owner: &str,
    action: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let (directory, source) = owner
        .rsplit_once('\0')
        .ok_or("Terminal owner must identify an ACP session.")?;
    let source = source
        .strip_prefix("acp:")
        .ok_or("Terminal owner must identify an ACP session.")?;
    let (agent, session_id) = source
        .split_once(':')
        .ok_or("Terminal owner must identify an ACP session.")?;
    let runtime = connection_for_session(manager, agent, session_id, Path::new(directory))?;
    let current_directory = runtime
        .session_directories
        .lock()
        .map_err(|error| error.to_string())?
        .get(session_id)
        .cloned();
    if current_directory.as_deref() != Some(Path::new(directory)) {
        return Err("Terminal owner does not match the agent session directory.".into());
    }
    with_active_terminal_prompt(&runtime, session_id, action)
}

fn cleanup_session_processes(
    app: &AppHandle,
    runtime: &Connection,
    agent: &str,
    session_id: &str,
) -> bool {
    let mut clean = true;
    let directory = runtime
        .session_directories
        .lock()
        .ok()
        .and_then(|directories| directories.get(session_id).cloned());
    if let Some(directory) = directory {
        let owner = format!("{}\0acp:{}:{}", directory.display(), agent, session_id);
        if let Err(error) = crate::owned_processes::stop_run(&owner) {
            clean = false;
            crate::diagnostics::record(
                "owned_process_cleanup_failed",
                json!({
                    "run": owner, "error": error
                }),
            );
        }
        if let Err(error) = app
            .state::<crate::terminal::TerminalManager>()
            .stop_owner(&owner)
        {
            clean = false;
            crate::diagnostics::record(
                "owned_process_cleanup_failed",
                json!({"run":owner,"error":error}),
            );
        }
    }
    if let Err(error) = app
        .state::<crate::acp_terminal::AcpTerminalManager>()
        .stop_sessions(
            agent,
            runtime.profile,
            &runtime.worktree,
            &[session_id.to_string()],
        )
    {
        clean = false;
        crate::diagnostics::record(
            "owned_process_cleanup_failed",
            json!({"agent":agent,"sessionId":session_id,"error":error}),
        );
    }
    clean
}

#[tauri::command]
pub async fn acp_cancel(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
    directory: String,
    session_id: String,
    turn_id: Option<String>,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let runtime = connection_for_session(&manager, &agent, &session_id, Path::new(&directory))?;
        cancel_session(&app, &runtime, &agent, &session_id, turn_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn cancel_session(
    app: &AppHandle,
    runtime: &Connection,
    agent: &str,
    session_id: &str,
    turn_id: Option<String>,
) -> Result<(), String> {
    cancel_prompt_dispatch(&runtime.prompt_dispatch, || {
        cancel_session_after_dispatch(app, runtime, agent, session_id, turn_id)
    })
}

fn cancel_prompt_dispatch<T>(
    dispatch: &Mutex<()>,
    cancel: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let _dispatch = dispatch.lock().map_err(|error| error.to_string())?;
    cancel()
}

fn cancel_session_after_dispatch(
    app: &AppHandle,
    runtime: &Connection,
    agent: &str,
    session_id: &str,
    turn_id: Option<String>,
) -> Result<(), String> {
    let native_cancel = {
        let native = runtime
            .native_subagents
            .lock()
            .map_err(|error| error.to_string())?;
        native_cancel_eligible(&native, session_id, turn_id.as_deref())
    }?;
    let session_id = session_id.to_string();
    let agent = agent.to_string();
    let (plan, mut permission_state) = {
        let mut prompts = runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?;
        let mut cancelled_prompts = runtime
            .cancelled_prompts
            .lock()
            .map_err(|error| error.to_string())?;
        let mut permission_state = runtime
            .permission_state
            .lock()
            .map_err(|error| error.to_string())?;
        let plan = prepare_session_cancellation(
            &mut prompts,
            &mut cancelled_prompts,
            &mut permission_state,
            &session_id,
            turn_id,
        );
        if native_cancel && !plan.await_settlement {
            permission_state.begin_native_cancel(&session_id);
        }
        drop(cancelled_prompts);
        drop(prompts);
        (plan, permission_state)
    };
    crate::diagnostics::record(
        "cancel_requested",
        json!({
            "agent":agent,"sessionId":session_id,"turnId":plan.turn_id,
            "awaitSettlement":plan.await_settlement,
            "nativeChild":native_cancel
        }),
    );
    let result = dispatch_session_cancel(plan.await_settlement, native_cancel, || {
        runtime.notify("session/cancel", json!({"sessionId":session_id}))
    });
    if result.is_err() {
        permission_state.canceling_sessions.remove(&session_id);
        drop(permission_state);
        if plan.cleanup_current {
            if let Ok(mut prompts) = runtime.prompt_state.lock() {
                prompts.finishing.remove(&session_id);
            }
        }
        if plan.track_prompt {
            let turn_id = plan.turn_id.as_ref().expect("tracked cancellation turn");
            runtime
                .cancelled_prompts
                .lock()
                .map_err(|error| error.to_string())?
                .remove(turn_id);
        }
        return result;
    }
    if plan.cleanup_current {
        let clean = cleanup_session_processes(app, runtime, &agent, &session_id);
        if let Err(error) = runtime.record_process_cleanup(&session_id, clean) {
            if let Some(lease) = &runtime._storage_lease {
                lease.mark_temp_pending("turn-temp-process-cleanup-failed");
            }
            crate::diagnostics::record(
                "turn_temp_cleanup_failed",
                json!({"agent":agent,"sessionId":session_id,"error":error}),
            );
        }
    }
    if plan.cleanup_current || plan.await_settlement || native_cancel {
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
                        directory: session_directory(runtime, &session_id),
                        worktree: Some(runtime.worktree.to_string_lossy().into_owned()),
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
        )?;
    }
    Ok(())
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AcpPermissionParams {
    agent: String,
    directory: String,
    request_id: Value,
    option_id: Option<String>,
    session_id: String,
    request_generation: u64,
    request_fingerprint: String,
}

#[tauri::command]
pub async fn acp_permission(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    params: AcpPermissionParams,
) -> Result<(), String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let AcpPermissionParams {
            agent,
            directory,
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
        let runtime = connection_for_session(&manager, &agent, &session_id, Path::new(&directory))?;
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
                directory: Some(directory),
                worktree: Some(runtime.worktree.to_string_lossy().into_owned()),
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
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_set_config(
    app: AppHandle,
    agent: String,
    directory: String,
    session_id: String,
    config_id: String,
    value: String,
) -> Result<Value, String> {
    let manager = app.state::<AgentManager>().inner().clone();
    let browser = app
        .state::<crate::browser_agent::BrowserManager>()
        .inner()
        .clone();
    let runtime = connection_for_session_reattaching(
        &app,
        &manager,
        &browser,
        &agent,
        &session_id,
        Path::new(&directory),
    )
    .await?;
    tauri::async_runtime::spawn_blocking(move || {
        let result = runtime.request(
            "session/set_config_option",
            json!({"sessionId":session_id,"configId":config_id,"value":value}),
            Duration::from_secs(30),
        )?;
        runtime.remember_session_ui(&session_id, &result)?;
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_authenticate(
    manager: State<'_, AgentManager>,
    agent: String,
    directory: String,
    method_id: String,
    profile: Option<String>,
) -> Result<Value, String> {
    let profile = parse_profile(profile.as_deref())?;
    let runtime = connection_for_profile(&manager, &agent, profile, Path::new(&directory))?;
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

#[cfg(all(test, unix))]
fn spawn_test_session_process() -> std::process::Child {
    use std::os::unix::process::CommandExt;

    let mut command = Command::new("sleep");
    command.arg("30").stdin(Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if nix::libc::setsid() == -1 {
                Err(std::io::Error::last_os_error())
            } else {
                Ok(())
            }
        });
    }
    command.spawn().expect("test ACP runtime should start")
}

#[cfg(test)]
mod session_config_tests {
    use super::*;
    use crate::browser_agent::McpConfig;

    #[test]
    fn context_server_is_optional_and_registered_once() {
        let browser = json!({"name":"sail-browser", "args":["--browser-mcp"]});
        let context = json!({"name":"project-files", "args":["--context-mcp", "/project"]});
        let mut servers = session_servers(browser.clone());
        with_context_server(&mut servers, None);
        assert_eq!(servers, vec![browser.clone()]);
        with_context_server(&mut servers, Some(context.clone()));
        with_context_server(&mut servers, Some(context.clone()));
        assert_eq!(servers, vec![browser.clone(), context]);
        with_context_server(&mut servers, None);
        assert_eq!(servers, vec![browser]);
    }
    use std::collections::BTreeMap;

    #[test]
    fn retry_can_clean_cancelled_session_while_its_prompt_is_unanswered() {
        let mut prompts = PromptState::default();
        let prompt = |turn_id: &str| ActivePrompt {
            turn_id: turn_id.into(),
            text: String::new(),
            dispatched: false,
            memory_capture: crate::memory_capture::TurnCapture::default(),
            last_agent_message: String::new(),
            agent_message_open: false,
            agent_message_overflow: false,
            known_tool_calls: HashSet::new(),
        };
        prompts
            .active
            .insert("cancelled".into(), prompt("turn-cancelled"));
        prompts
            .active
            .insert("running".into(), prompt("turn-running"));
        prompts.finishing.insert("cancelled".into());
        let failed = HashSet::from([
            "cancelled".to_string(),
            "running".to_string(),
            "old".to_string(),
        ]);
        let cancelled_turns = HashSet::from(["turn-cancelled".to_string()]);

        let sessions = retryable_process_cleanup_sessions(&failed, &prompts, &cancelled_turns);
        assert_eq!(sessions, vec![("cancelled".to_string(), true)]);

        prompts.active.clear();
        prompts.finishing.clear();
        assert_eq!(
            retryable_process_cleanup_sessions(&failed, &prompts, &cancelled_turns).len(),
            3
        );
    }

    #[cfg(unix)]
    #[test]
    fn normal_priority_retry_keeps_its_own_session() {
        let mut command =
            crate::background_priority::worker_command(std::ffi::OsStr::new("/bin/sh"), true);
        command.args(["-c", "sleep 2"]);
        let mut retry = crate::background_priority::normal_priority_copy(&command);
        isolate_agent_process(&mut retry);
        let mut child = retry.spawn().unwrap();
        let session = unsafe { nix::libc::getsid(child.id() as i32) };
        assert_eq!(session, child.id() as i32);
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn temporary_cleanup_pauses_and_resumes_agent_process() {
        let mut child = super::spawn_test_session_process();
        let pause = PausedAgent::new(child.id()).unwrap();
        let system = sysinfo::System::new_all();
        assert_eq!(
            system
                .process(sysinfo::Pid::from_u32(child.id()))
                .map(sysinfo::Process::status),
            Some(sysinfo::ProcessStatus::Stop)
        );
        drop(pause);
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn temporary_cleanup_retries_after_worker_exits() {
        struct RuntimeGuard(Arc<Connection>);
        impl Drop for RuntimeGuard {
            fn drop(&mut self) {
                let _ = self.0.stop_child();
            }
        }
        let scratch =
            std::env::temp_dir().join(format!("sail-turn-temp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let identity = crate::worktree_directory_identity(&scratch).unwrap();
        let _scratch = OwnedTempDir(scratch.clone(), identity);
        let worktree = scratch.join("plain-folder");
        std::fs::create_dir(&worktree).unwrap();
        let cache = scratch.join("cache");
        let (_, lease) = crate::worktree_storage::register(&cache, &worktree).unwrap();
        lease.mark_started();
        let artifact = lease.temp_directory().join("turn-artifact");
        std::fs::write(&artifact, "complete").unwrap();

        let mut command = Command::new("/bin/sh");
        command
            .args([
                "-c",
                "exec 3<&0; (read -r release <&3) & wait; read -r release <&3",
            ])
            .stdin(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = command.spawn().unwrap();
        let mut runtime = test_runtime_with_child(
            "claude",
            CapabilityProfile::Build,
            &worktree,
            "session",
            child,
        );
        Arc::get_mut(&mut runtime).unwrap()._storage_lease = Some(lease);
        let _runtime = RuntimeGuard(runtime.clone());
        let root = runtime.child.lock().unwrap().id();
        for _ in 0..100 {
            if runtime_has_live_children(root, None) {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(runtime_has_live_children(root, None));
        start_temp_cleanup_watcher(&runtime).unwrap();
        runtime.clear_idle_temp(true).unwrap();
        assert!(artifact.exists());
        runtime
            .input
            .lock()
            .unwrap()
            .write_all(b"release\n")
            .unwrap();

        for _ in 0..100 {
            if !artifact.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            !artifact.exists(),
            "watcher did not reclaim completed-turn data"
        );
        runtime.stop_child().unwrap();
        drop(runtime);
    }

    #[cfg(unix)]
    #[test]
    fn temporary_cleanup_preserves_orphaned_worker() {
        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }

        let scratch =
            std::env::temp_dir().join(format!("sail-orphan-temp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let _scratch = Scratch(scratch.clone());
        let worktree = scratch.join("plain-folder");
        std::fs::create_dir(&worktree).unwrap();
        let (_, lease) =
            crate::worktree_storage::register(&scratch.join("cache"), &worktree).unwrap();
        lease.mark_started();
        let temp = lease.temp_directory().to_path_buf();
        let artifact = temp.join("artifact");
        let ready = scratch.join("ready");
        let code = r#"import os,sys
p=os.fork()
if p==0:
    p2=os.fork()
    if p2>0: os._exit(0)
    artifact=open(sys.argv[1], 'w')
    artifact.write('live')
    artifact.flush()
    open(sys.argv[2], 'w').write(str(os.getpid()))
    sys.stdin.buffer.read()
    os._exit(0)
os.waitpid(p, 0)
sys.stdin.buffer.read()
"#;
        let mut command = Command::new("python3");
        command
            .arg("-c")
            .arg(code)
            .arg(&artifact)
            .arg(&ready)
            .stdin(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = command.spawn().unwrap();
        let mut runtime = test_runtime_with_child(
            "claude",
            CapabilityProfile::Build,
            &worktree,
            "session",
            child,
        );
        Arc::get_mut(&mut runtime).unwrap()._storage_lease = Some(lease);
        for _ in 0..100 {
            if ready.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists());
        let root = runtime.child.lock().unwrap().id();
        assert!(runtime_has_live_children(root, Some(&temp)));
        runtime.clear_idle_temp(true).unwrap();
        assert_eq!(std::fs::read_to_string(&artifact).unwrap(), "live");
        runtime.stop_child().unwrap();
        drop(runtime);
    }

    #[cfg(unix)]
    #[test]
    fn temporary_cleanup_detects_detached_worker_with_temp_argument() {
        let scratch =
            std::env::temp_dir().join(format!("sail-detached-temp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let worktree = scratch.join("plain-folder");
        std::fs::create_dir(&worktree).unwrap();
        let (_, lease) =
            crate::worktree_storage::register(&scratch.join("cache"), &worktree).unwrap();
        lease.mark_started();
        let temp = lease.temp_directory().to_path_buf();
        let artifact = temp.join("artifact");
        let ready = scratch.join("ready");
        let code = r#"import os,sys,time
p=os.fork()
if p==0:
    p2=os.fork()
    if p2>0: os._exit(0)
    os.setsid()
    worker="import os,sys,time; open(sys.argv[1], 'w').write('live'); open(sys.argv[2], 'w').write(str(os.getpid())); time.sleep(10)"
    os.execve(sys.executable, [sys.executable, '-c', worker, sys.argv[1], sys.argv[2]], {})
os.waitpid(p, 0)
time.sleep(10)
"#;
        let mut command = Command::new("python3");
        command
            .arg("-c")
            .arg(code)
            .arg(&artifact)
            .arg(&ready)
            .stdin(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = command.spawn().unwrap();
        let mut runtime = test_runtime_with_child(
            "claude",
            CapabilityProfile::Build,
            &worktree,
            "session",
            child,
        );
        Arc::get_mut(&mut runtime).unwrap()._storage_lease = Some(lease);
        for _ in 0..100 {
            if ready.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists());
        let root = runtime.child.lock().unwrap().id();
        assert!(!runtime_has_live_children(root, None));
        assert!(runtime_has_live_children(root, Some(&temp)));
        runtime.clear_idle_temp(true).unwrap();
        assert_eq!(std::fs::read_to_string(&artifact).unwrap(), "live");
        let worker: i32 = std::fs::read_to_string(&ready).unwrap().parse().unwrap();
        nix::sys::signal::kill(
            nix::unistd::Pid::from_raw(worker),
            nix::sys::signal::Signal::SIGTERM,
        )
        .unwrap();
        runtime.stop_child().unwrap();
        drop(runtime);
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn temporary_cleanup_waits_for_inflight_session_request() {
        let scratch =
            std::env::temp_dir().join(format!("sail-request-temp-test-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&scratch).unwrap();
        let worktree = scratch.join("plain-folder");
        std::fs::create_dir(&worktree).unwrap();
        let (_, lease) =
            crate::worktree_storage::register(&scratch.join("cache"), &worktree).unwrap();
        lease.mark_started();
        let artifact = lease.temp_directory().join("init");
        std::fs::write(&artifact, "live").unwrap();
        let mut command = Command::new("sleep");
        command.arg("30").stdin(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = command.spawn().unwrap();
        let mut runtime = test_runtime_with_child(
            "claude",
            CapabilityProfile::Build,
            &worktree,
            "session",
            child,
        );
        Arc::get_mut(&mut runtime).unwrap()._storage_lease = Some(lease);
        let (started_tx, started_rx) = mpsc::channel();
        let request_runtime = Arc::clone(&runtime);
        let request = std::thread::spawn(move || {
            request_runtime.request_response_around_write(
                "session/new",
                json!({}),
                Duration::from_millis(500),
                |_| Ok(()),
                || started_tx.send(()).unwrap(),
            )
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        runtime.clear_idle_temp(true).unwrap();
        assert_eq!(std::fs::read_to_string(&artifact).unwrap(), "live");
        assert!(request.join().unwrap().is_err());
        runtime.clear_idle_temp(false).unwrap();
        assert!(!artifact.exists());
        runtime.stop_child().unwrap();
        drop(runtime);
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn failed_process_cleanup_stays_pending_until_retry_succeeds() {
        let scratch = std::env::temp_dir().join(format!(
            "sail-process-cleanup-temp-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&scratch).unwrap();
        let worktree = scratch.join("plain-folder");
        std::fs::create_dir(&worktree).unwrap();
        let (_, lease) =
            crate::worktree_storage::register(&scratch.join("cache"), &worktree).unwrap();
        lease.mark_started();
        let artifact = lease.temp_directory().join("artifact");
        std::fs::write(&artifact, "retain").unwrap();
        let mut runtime = test_runtime(
            "claude",
            CapabilityProfile::Build,
            &worktree,
            "session",
            None,
        );
        Arc::get_mut(&mut runtime).unwrap()._storage_lease = Some(lease);

        let owned = crate::scratch_cleanup::OwnedRuntimeScratch::create().unwrap();
        let owned_artifact = owned.path().join("tmp/artifact");
        let build_artifact = owned.path().join("build/artifact");
        std::fs::write(&owned_artifact, "retain").unwrap();
        std::fs::write(&build_artifact, "retain").unwrap();
        *runtime.runtime_scratch.lock().unwrap() = Some(owned);
        runtime.record_process_cleanup("session", false).unwrap();
        runtime.clear_idle_temp(false).unwrap();
        assert!(artifact.exists());
        assert!(owned_artifact.exists());
        assert!(
            crate::worktree_storage::cleanup_status(&scratch.join("cache"))
                .iter()
                .any(|item| item.reason == "turn-temp-cleanup-failed")
        );

        runtime.record_process_cleanup("session", true).unwrap();
        runtime.clear_idle_temp(false).unwrap();
        assert!(!artifact.exists());
        assert!(!owned_artifact.exists());
        assert!(build_artifact.exists());
        runtime.stop_child().unwrap();
        drop(runtime);
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unverified_detached_fd_owner_keeps_turn_temp_pending() {
        let scratch = std::env::temp_dir().join(format!(
            "sail-detached-fd-temp-test-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&scratch).unwrap();
        let worktree = scratch.join("plain-folder");
        std::fs::create_dir(&worktree).unwrap();
        let (_, lease) =
            crate::worktree_storage::register(&scratch.join("cache"), &worktree).unwrap();
        let temp = lease.temp_directory().to_path_buf();
        let artifact = temp.join("artifact");
        let ready = scratch.join("ready");
        lease.prepare_process_start().unwrap();
        let code = r#"import os,sys,time
fd=os.open(sys.argv[1], os.O_WRONLY|os.O_CREAT)
os.set_inheritable(fd, True)
p=os.fork()
if p==0:
    p2=os.fork()
    if p2>0: os._exit(0)
    os.setsid()
    os.chdir('/')
    worker="import os,sys,time; time.sleep(1); os.write(int(sys.argv[1]), b'live')"
    os.execve(sys.executable, [sys.executable, '-c', worker, str(fd)], {})
os.waitpid(p, 0)
open(sys.argv[2], 'w').write('ready')
time.sleep(10)
"#;
        let mut command = Command::new("python3");
        command
            .arg("-c")
            .arg(code)
            .arg(&artifact)
            .arg(&ready)
            .stdin(Stdio::piped());
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let child = command.spawn().unwrap();
        lease.mark_started();
        let mut runtime = test_runtime_with_child(
            "claude",
            CapabilityProfile::Build,
            &worktree,
            "session",
            child,
        );
        Arc::get_mut(&mut runtime).unwrap()._storage_lease = Some(lease);
        for _ in 0..100 {
            if ready.exists() {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(ready.exists());
        assert!(!runtime_has_live_children(
            runtime.child.lock().unwrap().id(),
            Some(&temp)
        ));
        runtime.clear_idle_temp(true).unwrap();
        for _ in 0..200 {
            if std::fs::read(&artifact).is_ok_and(|bytes| bytes == b"live") {
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert_eq!(std::fs::read(&artifact).unwrap(), b"live");
        runtime.stop_child().unwrap();
        drop(runtime);
        std::fs::remove_dir_all(scratch).unwrap();
    }

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

    #[cfg(unix)]
    pub(super) fn test_runtime(
        agent: &str,
        profile: CapabilityProfile,
        worktree: &Path,
        session_id: &str,
        owner: Option<&str>,
    ) -> Arc<Connection> {
        test_runtime_with_build(agent, profile, worktree, session_id, owner, None)
    }

    #[cfg(unix)]
    fn test_runtime_with_build(
        agent: &str,
        profile: CapabilityProfile,
        worktree: &Path,
        session_id: &str,
        owner: Option<&str>,
        build_directory: Option<PathBuf>,
    ) -> Arc<Connection> {
        test_runtime_with_child_and_build(
            agent,
            profile,
            worktree,
            session_id,
            owner,
            build_directory,
            super::spawn_test_session_process(),
        )
    }

    #[cfg(unix)]
    fn test_runtime_with_child(
        agent: &str,
        profile: CapabilityProfile,
        worktree: &Path,
        session_id: &str,
        child: Child,
    ) -> Arc<Connection> {
        test_runtime_with_child_and_build(agent, profile, worktree, session_id, None, None, child)
    }

    #[cfg(unix)]
    fn test_runtime_with_child_and_build(
        agent: &str,
        profile: CapabilityProfile,
        worktree: &Path,
        session_id: &str,
        owner: Option<&str>,
        build_directory: Option<PathBuf>,
        mut child: Child,
    ) -> Arc<Connection> {
        let input = child.stdin.take().expect("test runtime stdin");
        let watchdog = crate::child_watchdog::ChildWatchdog::start(child.id())
            .expect("test runtime watchdog should start");
        Arc::new(Connection {
            agent: agent.to_owned(),
            profile,
            // Production connect stores the canonical worktree identity. macOS temp paths
            // often pass through /var -> /private/var, so the test runtime must match it.
            worktree: super::worktree_identity(worktree),
            owner: owner.map(str::to_string),
            #[cfg(unix)]
            shared_build_directory: build_directory,
            codex_workspace_access: None,
            runtime_path: std::ffi::OsString::new(),
            environment_id: String::new(),
            _storage_lease: None,
            child: Mutex::new(child),
            scratch_owner: None,
            runtime_scratch: Mutex::new(None),
            watchdog: Mutex::new(watchdog),
            stopped: AtomicBool::new(false),
            released_owner: AtomicBool::new(false),
            idle_exit: AtomicBool::new(false),
            last_activity: Mutex::new(Instant::now()),
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            reader_progress: ReaderProgress::default(),
            permission_state: Mutex::new(PermissionState::default()),
            elicitation_state: Mutex::new(HashMap::from([(
                "7".to_string(),
                PendingElicitation {
                    message: json!({"method":"elicitation/create","id":7,"params":{"sessionId":session_id}}),
                    received_at: 1,
                },
            )])),
            next_permission_generation: AtomicU64::new(1),
            prompt_state: Mutex::new(PromptState::default()),
            temp_cleanup_gate: Mutex::new(TempCleanupState::default()),
            prompt_dispatch: Mutex::new(()),
            cancelled_prompts: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            capabilities: Mutex::new(Value::Null),
            session_directories: Mutex::new(HashMap::from([(
                session_id.to_owned(),
                worktree.to_path_buf(),
            )])),
            session_configs: Mutex::new(HashMap::new()),
            per_load_tokens: Mutex::new(HashMap::new()),
            native_subagents: Mutex::new(NativeSubagentRegistry::default()),
            session_profiles: Mutex::new(HashMap::from([(session_id.to_owned(), profile)])),
            session_ui: Mutex::new(HashMap::new()),
            pending_directory: Mutex::new(None),
            session_creation: Mutex::new(()),
            restores: Mutex::new(HashMap::new()),
            restore_ready: Condvar::new(),
            idle: Mutex::new(crate::acp_idle::IdleSessions::default()),
            ready: Condvar::new(),
            _owned_temp: None,
        })
    }

    #[cfg(unix)]
    fn idle_runtime(agent: &str, owner: Option<&str>) -> Arc<Connection> {
        let runtime = test_runtime(
            agent,
            CapabilityProfile::Explore,
            Path::new("/worktree"),
            "session",
            owner,
        );
        runtime.elicitation_state.lock().unwrap().clear();
        *runtime.capabilities.lock().unwrap() = json!({"agentCapabilities":{}});
        *runtime.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(60);
        runtime
    }

    #[cfg(unix)]
    #[test]
    fn silent_opencode_agent_exits_and_reports_idleness() {
        let runtime = idle_runtime("opencode", None);

        assert!(runtime.exit_if_idle(Duration::from_secs(30), || false));
        assert!(!runtime.alive.load(Ordering::Acquire));
        assert!(runtime.idle_exit.load(Ordering::Acquire));
        assert_eq!(
            runtime
                .request("session/prompt", json!({}), Duration::from_secs(1))
                .unwrap_err(),
            IDLE_EXIT_ERROR,
            "a request racing the idle exit must be recoverable by reattaching"
        );
    }

    #[cfg(unix)]
    #[test]
    fn listing_at_idle_shutdown_boundary_skips_the_terminating_agent() {
        let runtime = idle_runtime("opencode", None);
        runtime.session_profiles.lock().unwrap().clear();
        let manager = AgentManager::default();
        let key = super::connection_key("opencode", CapabilityProfile::Explore, &runtime.worktree);
        manager
            .0
            .lock()
            .unwrap()
            .insert(key.clone(), Arc::clone(&runtime));
        // Hold cleanup open after retirement has committed, without a timing-dependent sleep.
        let child = runtime.child.lock().unwrap();
        let retiring = Arc::clone(&runtime);
        let shutdown =
            std::thread::spawn(move || retiring.exit_if_idle(Duration::from_secs(30), || false));
        let deadline = Instant::now() + Duration::from_secs(1);
        while !runtime.idle_exit.load(Ordering::Acquire) && Instant::now() < deadline {
            std::thread::yield_now();
        }
        assert!(runtime.idle_exit.load(Ordering::Acquire));
        let request_runtime = Arc::clone(&runtime);
        let (finished, result) = mpsc::channel();
        let request = std::thread::spawn(move || {
            let started = Instant::now();
            let selected =
                super::shared_listing_connection(&manager, "opencode", CapabilityProfile::Explore)
                    .unwrap();
            let initialized = super::initialized_capabilities(&manager, &key).unwrap();
            let response =
                request_runtime.request("session/list", json!({}), Duration::from_secs(30));
            finished
                .send((
                    selected.is_none(),
                    initialized.is_none(),
                    response,
                    started.elapsed(),
                ))
                .unwrap();
        });
        let boundary = result.recv_timeout(Duration::from_secs(1));
        drop(child);
        assert!(shutdown.join().unwrap());
        request.join().unwrap();
        let (skipped, uninitialized, response, elapsed) =
            boundary.expect("listing must not wait for shutdown");
        assert!(skipped && uninitialized);
        assert_eq!(response.unwrap_err(), IDLE_EXIT_ERROR);
        assert!(elapsed < Duration::from_secs(1));
        assert!(runtime.child.lock().unwrap().try_wait().unwrap().is_some());
        assert!(runtime.pending.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn listing_dispatch_returns_each_response_once() {
        let runtime = idle_runtime("opencode", None);
        let mut requests = Vec::new();
        for index in 0..8 {
            let runtime = Arc::clone(&runtime);
            requests.push(std::thread::spawn(move || {
                runtime
                    .request_response_around_write(
                        "session/list",
                        json!({"cursor":index}),
                        Duration::from_secs(1),
                        |message| {
                            let id = message["id"].as_u64().unwrap();
                            let sender = runtime.pending.lock().unwrap().remove(&id).unwrap();
                            let message = json!({"result":{"cursor":message["params"]["cursor"]}});
                            sender
                                .send(PendingResponse {
                                    message,
                                    generation: 0,
                                })
                                .unwrap();
                            Ok(())
                        },
                        || {},
                    )
                    .unwrap()
                    .message["result"]["cursor"]
                    .as_u64()
                    .unwrap()
            }));
        }
        let mut results: Vec<_> = requests
            .into_iter()
            .map(|request| request.join().unwrap())
            .collect();
        results.sort_unstable();
        assert_eq!(results, (0..8).collect::<Vec<_>>());
        assert!(runtime.pending.lock().unwrap().is_empty());
        runtime.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn listing_only_agent_exits_before_the_idle_limit_of_a_working_agent() {
        let listing = idle_runtime("opencode", None);
        listing.session_profiles.lock().unwrap().clear();
        *listing.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(150);
        let working = idle_runtime("opencode", None);
        *working.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(150);

        assert!(listing.exit_if_idle(Duration::from_secs(600), || false));
        assert!(!working.exit_if_idle(Duration::from_secs(600), || false));
        assert!(working.alive.load(Ordering::Acquire));
        working.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn session_registered_at_idle_decision_keeps_listing_agent_alive() {
        let runtime = idle_runtime("opencode", None);
        runtime.session_profiles.lock().unwrap().clear();
        *runtime.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(150);
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key(
                "opencode",
                CapabilityProfile::Explore,
                Path::new("/worktree"),
            ),
            Arc::clone(&runtime),
        );

        assert!(!runtime.exit_if_idle(Duration::from_secs(600), || {
            register_session(
                &manager,
                "opencode",
                CapabilityProfile::Explore,
                "registered-at-boundary",
                PathBuf::from("/worktree"),
            )
            .unwrap();
            false
        }));
        assert!(runtime.alive.load(Ordering::Acquire));
        assert!(!runtime.idle_exit.load(Ordering::Acquire));
        runtime.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn registration_rejects_an_agent_committed_to_idle_exit() {
        let runtime = idle_runtime("opencode", None);
        runtime.session_profiles.lock().unwrap().clear();
        runtime.idle_exit.store(true, Ordering::Release);
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key(
                "opencode",
                CapabilityProfile::Explore,
                Path::new("/worktree"),
            ),
            Arc::clone(&runtime),
        );

        let error = register_session(
            &manager,
            "opencode",
            CapabilityProfile::Explore,
            "too-late",
            PathBuf::from("/worktree"),
        )
        .err()
        .unwrap();
        assert_eq!(error, IDLE_EXIT_ERROR);
        assert!(runtime.session_profiles.lock().unwrap().is_empty());
        runtime.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn restore_claim_keeps_listing_agent_alive_until_release() {
        let runtime = idle_runtime("opencode", None);
        runtime.session_profiles.lock().unwrap().clear();
        *runtime.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(150);
        let token = runtime.begin_restore("restoring").unwrap()["restoreToken"]
            .as_str()
            .unwrap()
            .to_owned();

        assert!(!runtime.exit_if_idle(Duration::from_secs(600), || false));
        assert!(runtime.alive.load(Ordering::Acquire));
        assert!(!runtime.idle_exit.load(Ordering::Acquire));
        runtime.release_restore("restoring", &token).unwrap();
        *runtime.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(150);
        assert!(runtime.exit_if_idle(Duration::from_secs(600), || false));
    }

    #[cfg(unix)]
    #[test]
    fn listing_only_agent_follows_a_shorter_configured_limit() {
        let runtime = idle_runtime("opencode", None);
        runtime.session_profiles.lock().unwrap().clear();
        *runtime.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(40);

        assert!(!runtime.exit_if_idle(Duration::from_secs(60), || false));
        assert!(runtime.exit_if_idle(Duration::from_secs(30), || false));
    }

    #[cfg(unix)]
    #[test]
    fn recent_activity_keeps_opencode_agent_alive() {
        let runtime = idle_runtime("opencode", None);
        runtime.touch();

        assert!(!runtime.exit_if_idle(Duration::from_secs(30), || false));
        assert!(runtime.alive.load(Ordering::Acquire));
        runtime.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn busy_opencode_agent_defers_idle_exit_by_a_full_timeout() {
        let runtime = idle_runtime("opencode", None);
        runtime.elicitation_state.lock().unwrap().insert(
            "7".into(),
            PendingElicitation {
                message: json!({"method":"elicitation/create","id":7,"params":{"sessionId":"session"}}),
                received_at: 1,
            },
        );
        assert!(!runtime.exit_if_idle(Duration::from_secs(30), || false));
        assert!(!runtime.idle_exit.load(Ordering::Acquire));
        runtime.elicitation_state.lock().unwrap().clear();
        assert!(
            !runtime.exit_if_idle(Duration::from_secs(30), || false),
            "a deferred check must wait out the timeout again"
        );

        *runtime.last_activity.lock().unwrap() = Instant::now() - Duration::from_secs(60);
        assert!(!runtime.exit_if_idle(Duration::from_secs(30), || true));
        runtime.terminate().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn idle_exit_applies_only_to_unowned_opencode_agents() {
        for runtime in [
            idle_runtime("codex", None),
            idle_runtime("opencode", Some("0b7a7c41-5f3e-4f4a-9f0c-8f6f3f0d9a11")),
        ] {
            assert!(!runtime.exit_if_idle(Duration::from_secs(30), || false));
            assert!(runtime.alive.load(Ordering::Acquire));
            runtime.terminate().unwrap();
        }
    }

    #[cfg(unix)]
    #[test]
    fn restore_claim_survives_backend_result_until_frontend_finalizes() {
        let runtime = test_runtime(
            "claude",
            CapabilityProfile::Build,
            Path::new("/worktree"),
            "session",
            None,
        );
        let token = runtime.begin_restore("session").unwrap()["restoreToken"]
            .as_str()
            .unwrap()
            .to_owned();
        with_restore_claim(&runtime, "session", Some(&token), || Ok(())).unwrap();
        let waiting = Arc::clone(&runtime);
        let (started, receiver) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let claims = waiting.restores.lock().unwrap();
            started.send(()).unwrap();
            let _claims = waiting.wait_for_restore(claims, "session").unwrap();
            waiting.prompt_state.lock().unwrap().active.insert(
                "session".into(),
                ActivePrompt {
                    turn_id: "new-turn".into(),
                    text: "hello".into(),
                    dispatched: false,
                    memory_capture: crate::memory_capture::TurnCapture::default(),
                    last_agent_message: String::new(),
                    agent_message_open: false,
                    agent_message_overflow: false,
                    known_tool_calls: HashSet::new(),
                },
            );
        });
        receiver.recv_timeout(Duration::from_secs(1)).unwrap();
        // The backend load has returned, but the frontend has not applied replay yet.
        assert!(runtime.prompt_state.lock().unwrap().active.is_empty());
        runtime.release_restore("session", &token).unwrap();
        worker.join().unwrap();
        runtime
            .remember_session_ui(
                "session",
                &json!({"configOptions":[{"id":"model","currentValue":"first"}],
                    "availableCommands":[{"name":"inspect"}]}),
            )
            .unwrap();
        runtime
            .remember_session_ui(
                "session",
                &json!({"configOptions":[{"id":"model","currentValue":"second"}]}),
            )
            .unwrap();
        let live = runtime.begin_restore("session").unwrap();
        assert_eq!(live["configOptions"][0]["currentValue"], "second");
        assert_eq!(live["availableCommands"][0]["name"], "inspect");
        assert_eq!(live["liveTurn"], "new-turn");
        runtime.child.lock().unwrap().kill().unwrap();
        runtime.child.lock().unwrap().wait().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn slow_restore_keeps_queued_prompt_out_of_replay() {
        let runtime = test_runtime(
            "claude",
            CapabilityProfile::Build,
            Path::new("/worktree"),
            "session",
            None,
        );
        let token = runtime.begin_restore("session").unwrap()["restoreToken"]
            .as_str()
            .unwrap()
            .to_owned();
        let waiting = Arc::clone(&runtime);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (dispatched_tx, dispatched_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let claims = waiting.restores.lock().unwrap();
            started_tx.send(()).unwrap();
            let _claims = waiting.wait_for_restore(claims, "session").unwrap();
            dispatched_tx.send(()).unwrap();
        });
        with_restore_claim(&runtime, "session", Some(&token), || {
            started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
            // Compress a slow backend request past the reservation's expiry.
            runtime
                .restores
                .lock()
                .unwrap()
                .get_mut("session")
                .unwrap()
                .expires = Instant::now() + Duration::from_millis(25);
            std::thread::sleep(Duration::from_millis(75));
            assert!(matches!(
                dispatched_rx.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            ));
            // A disappearing webview may release early, but replay still owns the session.
            runtime.release_restore("session", &token).unwrap();
            assert!(matches!(
                dispatched_rx.try_recv(),
                Err(std::sync::mpsc::TryRecvError::Empty)
            ));
            Ok(())
        })
        .unwrap();
        dispatched_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        worker.join().unwrap();
        runtime.child.lock().unwrap().kill().unwrap();
        runtime.child.lock().unwrap().wait().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn restore_finalizer_releases_claim_after_failed_load_forgets_session() {
        let directory = Path::new("/worktree");
        let runtime = test_runtime(
            "claude",
            CapabilityProfile::Build,
            directory,
            "session",
            None,
        );
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key("claude", CapabilityProfile::Build, directory),
            Arc::clone(&runtime),
        );
        let token = runtime.begin_restore("session").unwrap()["restoreToken"]
            .as_str()
            .unwrap()
            .to_owned();
        runtime.session_profiles.lock().unwrap().remove("session");
        runtime
            .session_directories
            .lock()
            .unwrap()
            .remove("session");
        release_session_restore(&manager, "claude", directory, "session", &token).unwrap();
        assert!(runtime.restores.lock().unwrap().is_empty());
        runtime.child.lock().unwrap().kill().unwrap();
        runtime.child.lock().unwrap().wait().unwrap();
    }

    #[test]
    fn runtime_temp_environment_ignores_long_storage_paths() {
        let data = Path::new("/private/tmp").join("terminal-worktrees".repeat(16));
        let legacy = data.join("turn-temp/run-long");
        let scratch = Path::new("/private/tmp/sail-runtime-fixture");
        let environment = runtime_environment(&data, &legacy, Some(scratch), None);
        for name in ["TMPDIR", "TEMP", "TMP"] {
            assert!(environment.contains(&(name, scratch.join("tmp"))));
        }
        assert!(environment.contains(&("GOTMPDIR", scratch.join("tmp/go-tmp"))));
        let fallback = runtime_environment(&data, &legacy, None, None);
        assert!(fallback.contains(&("TMPDIR", legacy)));
    }

    #[test]
    fn runtime_keys_and_build_caches_are_private_per_worktree() {
        let scratch = scratch("runtime-cache");
        let first = scratch.join("first");
        let second = scratch.join("second");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&second).unwrap();
        assert_ne!(
            connection_key("codex", CapabilityProfile::Build, &first),
            connection_key("codex", CapabilityProfile::Build, &second),
        );

        let cache = scratch.join("app-cache");
        let first_data = crate::acp_terminal::worktree_data_directory(&cache, &first);
        let second_data = crate::acp_terminal::worktree_data_directory(&cache, &second);
        let first_scratch = scratch.join("first-runtime");
        let second_scratch = scratch.join("second-runtime");
        let first_temp = first_data.join("turn-temp/run-one");
        let second_temp = second_data.join("turn-temp/run-two");
        prepare_runtime_directories(&first_data, &first_temp).unwrap();
        prepare_runtime_directories(&second_data, &second_temp).unwrap();
        let first_environment =
            runtime_environment(&first_data, &first_temp, Some(&first_scratch), None);
        let second_environment =
            runtime_environment(&second_data, &second_temp, Some(&second_scratch), None);
        assert!(
            first_environment
                .iter()
                .all(|(name, _)| *name != "MISE_STATE_DIR"),
            "agent runtimes must inherit mise's trusted configuration state"
        );
        let path = |environment: &[(&str, PathBuf)], name| {
            environment
                .iter()
                .find(|(key, _)| *key == name)
                .unwrap()
                .1
                .clone()
        };
        for name in [
            "TMPDIR",
            "XDG_CACHE_HOME",
            "CARGO_TARGET_DIR",
            "GOCACHE",
            "GOTMPDIR",
            "UV_TOOL_DIR",
            "UV_TOOL_BIN_DIR",
        ] {
            assert_ne!(
                path(&first_environment, name),
                path(&second_environment, name)
            );
        }
        assert_eq!(
            path(&first_environment, "CARGO_TARGET_DIR"),
            first_scratch.join("build/cargo-target")
        );
        for name in ["TMPDIR", "TEMP", "TMP"] {
            assert_eq!(path(&first_environment, name), first_scratch.join("tmp"));
        }
        assert_eq!(
            path(&first_environment, "GOTMPDIR"),
            first_scratch.join("tmp/go-tmp")
        );
        for directory in [
            first_temp.clone(),
            first_data.join("cache"),
            first_data.join("bin"),
            first_data.join("uv-tools"),
            first_temp.join("go-tmp"),
            second_temp.clone(),
            second_data.join("cache"),
            second_data.join("bin"),
            second_data.join("uv-tools"),
            second_temp.join("go-tmp"),
        ] {
            assert!(
                directory.is_dir(),
                "{} was not created",
                directory.display()
            );
        }
        for name in [
            "PIP_CACHE_DIR",
            "UV_CACHE_DIR",
            "POETRY_CACHE_DIR",
            "NPM_CONFIG_CACHE",
            "YARN_CACHE_FOLDER",
            "COREPACK_HOME",
        ] {
            assert_eq!(
                path(&first_environment, name),
                path(&second_environment, name)
            );
        }
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn environment_id_ignores_tool_directories_created_later() {
        let root = scratch("environment-id-late-tools");
        let data = root.join("agent-data");
        let before = environment_id_for(&data, Some(&root), None, false);

        std::fs::create_dir_all(root.join(".local/bin")).unwrap();
        std::fs::create_dir_all(root.join(".cargo/bin")).unwrap();

        assert_eq!(before, environment_id_for(&data, Some(&root), None, false));
        assert_ne!(
            before,
            environment_id_for(&root.join("other-data"), Some(&root), None, false)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn configured_tool_paths_prefer_repository_tool_shims() {
        let root = scratch("configured-tool-paths");
        let shims = root.join(".local/share/mise/shims");
        let local = root.join(".local/bin");
        let cargo = root.join(".cargo/bin");
        let local_app_data = root.join("AppData/Local");
        let windows_shims = local_app_data.join("mise/shims");
        for directory in [&shims, &local, &cargo, &windows_shims] {
            std::fs::create_dir_all(directory).unwrap();
        }

        assert_eq!(
            configured_tool_paths(Some(&root), None, false),
            vec![shims.clone(), local.clone(), cargo.clone()]
        );
        assert_eq!(
            configured_tool_paths(Some(&root), Some(&local_app_data), true),
            vec![windows_shims.clone(), local, cargo]
        );
        assert_eq!(
            configured_tool_paths(None, Some(&local_app_data), true),
            vec![windows_shims.clone()]
        );
        assert!(configured_tool_paths(None, None, false).is_empty());

        let scoped_bin = root.join("agent-data/bin");
        let inherited =
            std::env::join_paths([root.join("system/bin"), root.join("usr/bin")]).unwrap();
        let joined = agent_path(
            configured_tool_paths(Some(&root), None, false),
            scoped_bin.clone(),
            &inherited,
        )
        .unwrap();
        assert_eq!(
            std::env::split_paths(&joined).collect::<Vec<_>>(),
            vec![
                shims,
                scoped_bin.clone(),
                root.join(".local/bin"),
                root.join(".cargo/bin"),
                root.join("system/bin"),
                root.join("usr/bin")
            ]
        );
        let windows_joined = agent_path(
            configured_tool_paths(Some(&root), Some(&local_app_data), true),
            scoped_bin,
            &inherited,
        )
        .unwrap();
        assert_eq!(
            std::env::split_paths(&windows_joined).collect::<Vec<_>>(),
            vec![
                windows_shims,
                root.join("agent-data/bin"),
                root.join(".local/bin"),
                root.join(".cargo/bin"),
                root.join("system/bin"),
                root.join("usr/bin")
            ]
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn default_gnupg_access_is_limited_to_the_existing_directory() {
        let root = scratch("default-gnupg");
        let home = root.join("home");
        let assigned = root.join("assigned");
        let gnupg = home.join(".gnupg");
        let sibling = home.join(".ssh");
        for directory in [&assigned, &gnupg, &sibling] {
            std::fs::create_dir_all(directory).unwrap();
        }

        assert_eq!(default_gnupg_directory(Some(&home)), Some(gnupg.clone()));
        assert!(default_gnupg_directory(Some(&root.join("missing-home"))).is_none());
        assert!(default_gnupg_directory(None).is_none());

        let access = CodexWorkspaceAccess::capture(
            &assigned,
            std::slice::from_ref(&default_gnupg_directory(Some(&home)).unwrap()),
        )
        .unwrap();
        let rules = serde_json::from_str::<Value>(&access.profile_config().unwrap()).unwrap()
            ["configOverrides"][2]
            .as_str()
            .unwrap()
            .to_string();
        let writable_rule = |path: &Path| {
            format!(
                "{}=\"write\"",
                serde_json::to_string(path.to_str().unwrap()).unwrap()
            )
        };
        assert!(rules.contains(&writable_rule(&dunce::canonicalize(&gnupg).unwrap())));
        assert!(!rules.contains(&writable_rule(&dunce::canonicalize(&home).unwrap())));
        assert!(!rules.contains(&writable_rule(&dunce::canonicalize(&sibling).unwrap())));

        #[cfg(unix)]
        {
            std::fs::remove_dir(&gnupg).unwrap();
            std::os::unix::fs::symlink(&sibling, &gnupg).unwrap();
            assert!(default_gnupg_directory(Some(&home)).is_none());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn ship_it_checkpoint_access_is_limited_to_the_checkpoint_directory() {
        let root = scratch("ship-it-checkpoints");
        let home = root.join("home");
        let assigned = root.join("assigned");
        let data_home = root.join("xdg-data");
        let sibling = home.join(".local/share/sai/ship-it/evidence");
        for directory in [&assigned, &data_home, &sibling] {
            std::fs::create_dir_all(directory).unwrap();
        }
        let writable_rule = |path: &Path| {
            format!(
                "{}=\"write\"",
                serde_json::to_string(path.to_str().unwrap()).unwrap()
            )
        };

        let default = ship_it_checkpoint_directory(None, Some(&home)).unwrap();
        assert_eq!(default, home.join(".local/share/sai/ship-it/checkpoints"));
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = std::fs::metadata(&default).unwrap().permissions().mode();
            assert_eq!(mode & 0o777, 0o700);
        }
        for name in ["task.json.lock", "task.json.bak", ".task.json.tmp"] {
            std::fs::write(default.join(name), b"").unwrap();
        }

        let access =
            CodexWorkspaceAccess::capture(&assigned, std::slice::from_ref(&default)).unwrap();
        let rules = serde_json::from_str::<Value>(&access.profile_config().unwrap()).unwrap()
            ["configOverrides"][2]
            .as_str()
            .unwrap()
            .to_string();
        assert!(rules.contains(&writable_rule(&dunce::canonicalize(&default).unwrap())));
        for denied in [
            &home,
            &home.join(".local/share"),
            &home.join(".local/share/sai/ship-it"),
            &sibling,
        ] {
            assert!(!rules.contains(&writable_rule(&dunce::canonicalize(denied).unwrap())));
        }

        assert_eq!(
            ship_it_checkpoint_directory(Some(&data_home), Some(&home)),
            Some(data_home.join("sai/ship-it/checkpoints"))
        );
        assert_eq!(
            ship_it_checkpoint_directory(Some(Path::new("")), Some(&home)),
            Some(default.clone())
        );
        assert!(ship_it_checkpoint_directory(Some(Path::new("relative")), Some(&home)).is_none());
        assert!(ship_it_checkpoint_directory(None, None).is_none());

        let gnupg = home.join(".gnupg");
        std::fs::create_dir_all(&gnupg).unwrap();
        assert_eq!(
            user_writable_directories(Some(&home), Some(&data_home)),
            vec![gnupg.clone(), data_home.join("sai/ship-it/checkpoints")]
        );
        assert_eq!(
            user_writable_directories(Some(&home), None),
            vec![gnupg, default.clone()]
        );
        assert!(user_writable_directories(None, None).is_empty());

        #[cfg(unix)]
        {
            std::fs::remove_dir_all(&default).unwrap();
            std::os::unix::fs::symlink(&sibling, &default).unwrap();
            assert!(ship_it_checkpoint_directory(None, Some(&home)).is_none());
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn duplicate_elicitation_ids_route_to_the_requested_profile_and_session() {
        let scratch = scratch("elicitation-owner");
        let worktree = scratch.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let build = test_runtime(
            "codex",
            CapabilityProfile::Build,
            &worktree,
            "build-session",
            None,
        );
        let review = test_runtime(
            "codex",
            CapabilityProfile::Review,
            &worktree,
            "review-session",
            None,
        );
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key("codex", CapabilityProfile::Build, &worktree),
            Arc::clone(&build),
        );
        manager.0.lock().unwrap().insert(
            connection_key("codex", CapabilityProfile::Review, &worktree),
            Arc::clone(&review),
        );

        let selected = connection_for_elicitation(
            &manager,
            "codex",
            CapabilityProfile::Review,
            &worktree,
            "review-session",
        )
        .unwrap();
        assert!(Arc::ptr_eq(&selected, &review));
        assert!(connection_for_elicitation(
            &manager,
            "codex",
            CapabilityProfile::Review,
            &worktree,
            "build-session",
        )
        .is_err());
        assert!(
            claim_pending_elicitation(&selected.elicitation_state, "7", "build-session",).is_err()
        );
        let response =
            claim_pending_elicitation(&selected.elicitation_state, "7", "review-session").unwrap();
        assert_eq!(
            response
                .message
                .pointer("/params/sessionId")
                .and_then(Value::as_str),
            Some("review-session")
        );
        assert!(build.elicitation_state.lock().unwrap().contains_key("7"));

        manager.shutdown();
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn cancelled_elicitation_emits_its_original_session_id() {
        let pending = Mutex::new(HashMap::from([(
            "7".to_string(),
            PendingElicitation {
                message: json!({"method":"elicitation/create","id":7,"params":{"sessionId":"nested-session"}}),
                received_at: 1,
            },
        )]));
        let mut cancelled = json!({"method":"$/cancel_request","params":{"id":7}});

        assert_eq!(
            attach_cancelled_elicitation_session(&mut cancelled, &pending).as_deref(),
            Some("nested-session")
        );
        assert_eq!(
            cancelled
                .pointer("/params/sessionId")
                .and_then(Value::as_str),
            Some("nested-session")
        );
        assert!(pending.lock().unwrap().is_empty());
    }

    #[cfg(unix)]
    #[test]
    fn stopping_a_worktree_runtime_preserves_sibling_runtimes() {
        let scratch = scratch("runtime-stop");
        let first = scratch.join("first");
        let sibling = scratch.join("sibling");
        let nested = first.join("nested");
        std::fs::create_dir_all(&first).unwrap();
        std::fs::create_dir_all(&sibling).unwrap();
        std::fs::create_dir_all(&nested).unwrap();
        let spawn = |worktree: &Path| {
            let mut child = super::spawn_test_session_process();
            let input = child.stdin.take().expect("test runtime stdin");
            let watchdog = crate::child_watchdog::ChildWatchdog::start(child.id())
                .expect("test runtime watchdog should start");
            Arc::new(Connection {
                agent: "codex".into(),
                profile: CapabilityProfile::Build,
                worktree: worktree.to_path_buf(),
                owner: None,
                #[cfg(unix)]
                shared_build_directory: None,
                codex_workspace_access: None,
                runtime_path: std::ffi::OsString::new(),
                environment_id: String::new(),
                _storage_lease: None,
                child: Mutex::new(child),
                scratch_owner: None,
                runtime_scratch: Mutex::new(None),
                watchdog: Mutex::new(watchdog),
                stopped: AtomicBool::new(false),
                released_owner: AtomicBool::new(false),
                idle_exit: AtomicBool::new(false),
                last_activity: Mutex::new(Instant::now()),
                input: Mutex::new(input),
                pending: Mutex::new(HashMap::new()),
                reader_progress: ReaderProgress::default(),
                permission_state: Mutex::new(PermissionState::default()),
                elicitation_state: Mutex::new(HashMap::new()),
                next_permission_generation: AtomicU64::new(1),
                prompt_state: Mutex::new(PromptState::default()),
                temp_cleanup_gate: Mutex::new(TempCleanupState::default()),
                prompt_dispatch: Mutex::new(()),
                cancelled_prompts: Mutex::new(HashSet::new()),
                next_id: AtomicU64::new(1),
                alive: AtomicBool::new(true),
                capabilities: Mutex::new(Value::Null),
                session_directories: Mutex::new(HashMap::new()),
                session_configs: Mutex::new(HashMap::new()),
                per_load_tokens: Mutex::new(HashMap::new()),
                native_subagents: Mutex::new(NativeSubagentRegistry::default()),
                session_profiles: Mutex::new(HashMap::new()),
                session_ui: Mutex::new(HashMap::new()),
                pending_directory: Mutex::new(None),
                session_creation: Mutex::new(()),
                restores: Mutex::new(HashMap::new()),
                restore_ready: Condvar::new(),
                idle: Mutex::new(crate::acp_idle::IdleSessions::default()),
                ready: Condvar::new(),
                _owned_temp: None,
            })
        };
        let first_runtime = spawn(&first);
        let nested_runtime = spawn(&nested);
        let sibling_runtime = spawn(&sibling);
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key("codex", CapabilityProfile::Build, &first),
            first_runtime.clone(),
        );
        manager.0.lock().unwrap().insert(
            connection_key("codex", CapabilityProfile::Build, &nested),
            nested_runtime.clone(),
        );
        manager.0.lock().unwrap().insert(
            connection_key("codex", CapabilityProfile::Build, &sibling),
            sibling_runtime.clone(),
        );
        assert_eq!(
            manager.worktree_roots_in(&first).unwrap(),
            vec![worktree_identity(&first), worktree_identity(&nested)]
        );

        manager.stop_worktree(&first).unwrap();

        assert!(!first_runtime.alive.load(Ordering::Acquire));
        assert!(!nested_runtime.alive.load(Ordering::Acquire));
        assert!(sibling_runtime.alive.load(Ordering::Acquire));
        let agents = manager.0.lock().unwrap();
        assert!(!agents.contains_key(&connection_key("codex", CapabilityProfile::Build, &first)));
        assert!(!agents.contains_key(&connection_key("codex", CapabilityProfile::Build, &nested)));
        assert!(agents.contains_key(&connection_key("codex", CapabilityProfile::Build, &sibling)));
        drop(agents);
        manager.shutdown();
        std::fs::remove_dir_all(scratch).unwrap();
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
    fn provider_local_session_ids_remain_distinct_across_runs() {
        let first = "0d66d3a1-5c47-45d1-8c3d-4a789f129001";
        let second = "0d66d3a1-5c47-45d1-8c3d-4a789f129002";
        let mut first_event =
            json!({"params":{"sessionId":"session-1","update":{"subagentSessionId":"child-1"}}});
        let mut second_event = first_event.clone();

        translate_session_ids(&mut first_event, first, false);
        translate_session_ids(&mut second_event, second, false);

        assert_eq!(
            first_event["params"]["sessionId"],
            "sail-owned:0d66d3a1-5c47-45d1-8c3d-4a789f129001:session-1"
        );
        assert_eq!(
            second_event["params"]["sessionId"],
            "sail-owned:0d66d3a1-5c47-45d1-8c3d-4a789f129002:session-1"
        );
        assert_eq!(
            first_event["params"]["update"]["subagentSessionId"],
            "sail-owned:0d66d3a1-5c47-45d1-8c3d-4a789f129001:child-1"
        );
        translate_session_ids(&mut first_event, first, true);
        assert_eq!(first_event["params"]["sessionId"], "session-1");
        assert_eq!(
            first_event["params"]["update"]["subagentSessionId"],
            "child-1"
        );
    }

    #[test]
    fn run_launch_requires_a_restorable_provider_without_changing_normal_chat() {
        let unsupported = json!({"agentCapabilities":{}});
        let load = json!({"agentCapabilities":{"loadSession":true}});
        let resume = json!({"agentCapabilities":{"sessionCapabilities":{"resume":{}}}});
        let owner = "0d66d3a1-5c47-45d1-8c3d-4a789f129001";

        assert!(require_owned_restore(&unsupported, None, "Test agent").is_ok());
        assert!(require_owned_restore(&load, Some(owner), "Test agent").is_ok());
        assert!(require_owned_restore(&resume, Some(owner), "Test agent").is_ok());
        assert_eq!(
            require_owned_restore(&unsupported, Some(owner), "Test agent").unwrap_err(),
            "Test agent does not advertise session restore. Its Ship run was not started; use a provider with session/load or session/resume."
        );
    }

    #[cfg(unix)]
    #[test]
    fn sequential_gates_reuse_a_revision_target_and_concurrent_gates_do_not() {
        let root = scratch("shared-gate-target");
        let first = gate_build_directory(&root, "revision-a", "gate-1", false);
        let repeated = gate_build_directory(&root, "revision-a", "gate-2", false);
        let concurrent = gate_build_directory(&root, "revision-a", "gate-3", true);
        let changed = gate_build_directory(&root, "revision-b", "gate-4", false);
        assert_eq!(first, repeated);
        assert_ne!(first, concurrent);
        assert_ne!(first, changed);
        assert!(concurrent.starts_with(&first));
        let environment = runtime_environment(
            &root,
            &root.join("turn-temp"),
            Some(&root.join("gate")),
            Some(&first),
        );
        assert!(environment.contains(&("CARGO_TARGET_DIR", first.join("cargo-target"))));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn parent_run_keeps_shared_target_until_its_gate_finishes() {
        let worktree_root = scratch("shared-gate-owner");
        let worktree = worktree_root.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let worker_owner = "0d66d3a1-5c47-45d1-8c3d-4a789f129001";
        let gate_owner = "0d66d3a1-5c47-45d1-8c3d-4a789f129002";
        let worker = test_runtime(
            "codex",
            CapabilityProfile::Build,
            &worktree,
            &owned_session_id(worker_owner, "worker"),
            Some(worker_owner),
        );
        let scratch = crate::scratch_cleanup::OwnedRuntimeScratch::create().unwrap();
        let scratch_path = scratch.path().to_path_buf();
        *worker.runtime_scratch.lock().unwrap() = Some(scratch);
        let build = gate_build_directory(&scratch_path, "revision-a", gate_owner, false);
        std::fs::create_dir_all(&build).unwrap();
        std::fs::write(build.join("artifact"), "reused build output").unwrap();
        let gate = test_runtime_with_build(
            "codex",
            CapabilityProfile::Review,
            &worktree,
            &owned_session_id(gate_owner, "gate"),
            Some(gate_owner),
            Some(build),
        );
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key_for_owner(
                "codex",
                CapabilityProfile::Build,
                &worktree,
                Some(worker_owner),
            ),
            Arc::clone(&worker),
        );
        manager.0.lock().unwrap().insert(
            connection_key_for_owner(
                "codex",
                CapabilityProfile::Review,
                &worktree,
                Some(gate_owner),
            ),
            Arc::clone(&gate),
        );
        assert_eq!(
            manager.stop_owner(&worktree, worker_owner).unwrap_err(),
            "Agent run still has an active validation gate."
        );
        assert!(scratch_path.exists());
        manager.stop_owner(&worktree, gate_owner).unwrap();
        manager.stop_owner(&worktree, worker_owner).unwrap();
        assert!(!scratch_path.exists());
        std::fs::remove_dir_all(worktree_root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn run_owner_release_waits_for_turns_and_native_children() {
        let root = scratch("run-owner-release");
        let worktree = root.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let owner = "0d66d3a1-5c47-45d1-8c3d-4a789f129001";
        let session = owned_session_id(owner, "session-1");
        let child = owned_session_id(owner, "child-1");
        let runtime = test_runtime(
            "codex",
            CapabilityProfile::Build,
            &worktree,
            &session,
            Some(owner),
        );
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key_for_owner("codex", CapabilityProfile::Build, &worktree, Some(owner)),
            Arc::clone(&runtime),
        );
        runtime.prompt_state.lock().unwrap().active.insert(
            session.clone(),
            ActivePrompt {
                turn_id: "turn-1".into(),
                text: "first request".into(),
                dispatched: false,
                memory_capture: crate::memory_capture::TurnCapture::default(),
                last_agent_message: String::new(),
                agent_message_open: false,
                agent_message_overflow: false,
                known_tool_calls: HashSet::new(),
            },
        );

        assert_eq!(
            manager.stop_owner(&worktree, owner).unwrap_err(),
            "Agent run still has an active turn."
        );
        assert!(runtime.alive.load(Ordering::Acquire));
        runtime.prompt_state.lock().unwrap().active.remove(&session);
        runtime.prompt_state.lock().unwrap().active.insert(
            session.clone(),
            ActivePrompt {
                turn_id: "turn-2".into(),
                text: "follow-up request".into(),
                dispatched: false,
                memory_capture: crate::memory_capture::TurnCapture::default(),
                last_agent_message: String::new(),
                agent_message_open: false,
                agent_message_overflow: false,
                known_tool_calls: HashSet::new(),
            },
        );
        runtime
            .cancelled_prompts
            .lock()
            .unwrap()
            .insert("turn-2".into());
        assert_eq!(
            manager.stop_owner(&worktree, owner).unwrap_err(),
            "Agent run still has an active turn."
        );
        runtime.prompt_state.lock().unwrap().active.remove(&session);
        runtime
            .native_subagents
            .lock()
            .unwrap()
            .spawn(&session, &child, worktree.clone(), false)
            .unwrap();
        assert_eq!(
            manager.stop_owner(&worktree, owner).unwrap_err(),
            "Agent run still has an active native subagent."
        );
        assert!(runtime.alive.load(Ordering::Acquire));
        runtime
            .native_subagents
            .lock()
            .unwrap()
            .update(&session, &child, "completed")
            .unwrap();

        manager.stop_owner(&worktree, owner).unwrap();

        assert!(!runtime.alive.load(Ordering::Acquire));
        assert!(manager.0.lock().unwrap().is_empty());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn same_provider_wire_id_routes_to_its_own_run() {
        let root = scratch("run-session-route");
        let worktree = root.join("worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let first = "0d66d3a1-5c47-45d1-8c3d-4a789f129001";
        let second = "0d66d3a1-5c47-45d1-8c3d-4a789f129002";
        let first_id = owned_session_id(first, "session-1");
        let second_id = owned_session_id(second, "session-1");
        let first_runtime = test_runtime(
            "codex",
            CapabilityProfile::Build,
            &worktree,
            &first_id,
            Some(first),
        );
        let second_runtime = test_runtime(
            "codex",
            CapabilityProfile::Build,
            &worktree,
            &second_id,
            Some(second),
        );
        let manager = AgentManager::default();
        manager.0.lock().unwrap().insert(
            connection_key_for_owner("codex", CapabilityProfile::Build, &worktree, Some(first)),
            Arc::clone(&first_runtime),
        );
        manager.0.lock().unwrap().insert(
            connection_key_for_owner("codex", CapabilityProfile::Build, &worktree, Some(second)),
            Arc::clone(&second_runtime),
        );

        assert!(Arc::ptr_eq(
            &connection_for_session(&manager, "codex", &first_id, &worktree).unwrap(),
            &first_runtime
        ));
        assert!(Arc::ptr_eq(
            &connection_for_session(&manager, "codex", &second_id, &worktree).unwrap(),
            &second_runtime
        ));
        manager.stop_owner(&worktree, first).unwrap();
        assert!(second_runtime.alive.load(Ordering::Acquire));
        assert!(Arc::ptr_eq(
            &connection_for_session(&manager, "codex", &second_id, &worktree).unwrap(),
            &second_runtime
        ));
        manager.shutdown();
        std::fs::remove_dir_all(root).unwrap();
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
            let servers = session_servers(mcp_server(config));
            serde_json::to_string(&session_request_params(
                "/work/repo",
                Some("session"),
                &servers,
            ))
            .unwrap()
        };
        assert_eq!(params(&first), params(&second));
        assert_eq!(params(&first), params(&first));
        let servers = session_servers(mcp_server(&first));
        let request = session_request_params("/work/repo", None, &servers);
        let env = &request["mcpServers"][0]["env"];
        assert_eq!(env[0]["name"], "SAIL_BROWSER_PORT");
        assert_eq!(env[1]["name"], "SAIL_BROWSER_TOKEN");
        assert!(request.get("sessionId").is_none());

        let servers = session_servers(mcp_server(&first));
        let request = session_request_params("/work/repo", None, &servers);
        assert_eq!(request["mcpServers"].as_array().unwrap().len(), 1);
        assert_eq!(request["mcpServers"][0]["name"], "sail-browser");
    }

    #[cfg(windows)]
    #[test]
    fn codex_workspace_access_checks_windows_directory_ownership() {
        let assigned = std::env::current_dir().unwrap();
        CodexWorkspaceAccess::capture(&assigned, &[]).unwrap();
        let system = PathBuf::from(std::env::var_os("SystemRoot").expect("Windows system root"));
        let error = CodexWorkspaceAccess::capture(&system, &[]).unwrap_err();
        assert!(error.contains("not owned by this user"), "{error}");
    }

    #[cfg(unix)]
    #[test]
    fn codex_workspace_access_rejects_steering_and_stops_invalid_runtime() {
        let assigned = std::env::current_dir().unwrap();
        let previous = assigned.parent().unwrap();
        let runtime = test_runtime(
            "codex",
            CapabilityProfile::Build,
            &assigned,
            "session",
            None,
        );
        let mut runtime = Arc::try_unwrap(runtime).ok().unwrap();
        let mut access = CodexWorkspaceAccess::capture(&assigned, &[]).unwrap();
        access.directories[0].identity = crate::worktree_directory_identity(previous).unwrap();
        runtime.codex_workspace_access = Some(access);
        let error = runtime
            .request(
                "_session/steering",
                json!({"sessionId":"session"}),
                Duration::from_millis(100),
            )
            .unwrap_err();
        assert!(error.contains("replaced"), "{error}");
        assert!(!runtime.alive.load(Ordering::Acquire));
        assert!(runtime.pending.lock().unwrap().is_empty());
        assert!(runtime.child.lock().unwrap().try_wait().unwrap().is_some());
    }

    #[test]
    fn codex_workspace_access_is_canonical_and_survives_restore_checks() {
        let root = scratch("codex-access");
        let assigned = root.join("assigned");
        let owned = root.join("owned");
        let sibling = root.join("sibling");
        for path in [&assigned, &owned, &sibling] {
            std::fs::create_dir(path).unwrap();
        }
        let access =
            CodexWorkspaceAccess::capture(&assigned, std::slice::from_ref(&owned)).unwrap();
        access.validate(Some(assigned.to_str().unwrap())).unwrap();
        access.validate(Some(assigned.to_str().unwrap())).unwrap();
        assert!(access
            .validate(Some(sibling.to_str().unwrap()))
            .unwrap_err()
            .contains("outside"));
        let config: Value = serde_json::from_str(&access.profile_config().unwrap()).unwrap();
        let rules = config["configOverrides"][2].as_str().unwrap();
        let canonical_assigned = dunce::canonicalize(&assigned).unwrap();
        let assigned_key = serde_json::to_string(canonical_assigned.to_str().unwrap()).unwrap();
        let owned_key =
            serde_json::to_string(dunce::canonicalize(&owned).unwrap().to_str().unwrap()).unwrap();
        let sibling_key =
            serde_json::to_string(dunce::canonicalize(&sibling).unwrap().to_str().unwrap())
                .unwrap();
        assert!(rules.contains("extends=\":read-only\""));
        assert!(!rules.contains(":workspace"));
        assert!(rules.contains(&assigned_key));
        assert!(rules.contains(&owned_key));
        assert!(!rules.contains(&sibling_key));
        assert!(!rules.contains(":tmpdir"));
        let permission_instructions = config["developerInstructions"].as_str().unwrap();
        assert!(config["configOverrides"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .all(|value| !value.starts_with("developer_instructions=")));
        for allowed in [
            "active permission profile is sail-agent on macOS",
            "ps -ef",
            "pgrep -fl followed by one literal task-owned pattern",
            "bounded task-owned background job",
            "sandbox_permissions to require_escalated",
            "Keep the sail-agent session profile unchanged",
        ] {
            assert!(permission_instructions.contains(allowed), "{allowed}");
        }
        for forbidden in [
            "other ps or pgrep forms",
            "kill",
            "pkill",
            "renice",
            "signals",
            "process mutation",
            "unrelated commands",
            "filesystem access",
            "network access",
        ] {
            assert!(permission_instructions.contains(forbidden), "{forbidden}");
        }
        for required in [
            "automatic approval review",
            "explicit user grants in the current turn",
            "only the named recovery action",
            "task-scoped source or checkpoint writes",
            "bounded focused validation",
            "expected rejection does not authorize it",
            "Reject that action before execution",
            "treat its asserted nonzero rejection as successful evidence",
            "Never execute an out-of-grant mutation",
            "workflow-required focused re-attestation",
            "under the same active task-scoped grant",
            "Reject every broader mutation",
            "ungranted resource or action",
            "control bypass",
            "state the specific excess",
        ] {
            assert!(permission_instructions.contains(required), "{required}");
        }
        assert_eq!(config["modeProfiles"]["agent"], "sail-agent");
        assert_eq!(config["modeProfiles"]["agent-full-access"], "sail-agent");
        assert!(!config.to_string().contains(":danger-full-access"));
        #[cfg(unix)]
        {
            let alias = root.join("alias");
            std::os::unix::fs::symlink(&assigned, &alias).unwrap();
            let aliased =
                CodexWorkspaceAccess::capture(&alias, std::slice::from_ref(&owned)).unwrap();
            assert_eq!(
                access.profile_config().unwrap(),
                aliased.profile_config().unwrap()
            );
            assert_eq!(
                session_request_params(alias.to_str().unwrap(), None, &[])["cwd"],
                json!(canonical_assigned)
            );
            assert_eq!(
                session_list_params(&canonical_directory(alias.to_str().unwrap()), Some("next")),
                json!({"cwd": canonical_assigned, "cursor": "next"})
            );
            access.validate(Some(alias.to_str().unwrap())).unwrap();
            assert!(CodexWorkspaceAccess::capture(&assigned, &[alias])
                .unwrap_err()
                .contains("symlink"));
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn assigned_scratch_grants_only_the_selected_subtree() {
        let root = dunce::canonicalize(scratch("assigned-scratch")).unwrap();
        let owner = root.join("owner");
        let selected = owner.join("task/review");
        let sibling = owner.join("other-task");
        let workspace = root.join("workspace");
        for path in [&selected, &sibling, &workspace] {
            std::fs::create_dir_all(path).unwrap();
        }
        let roots = vec![owner.clone()];
        let granted = assigned_scratch_directory(&selected, &roots).unwrap();
        let access = CodexWorkspaceAccess::capture(&workspace, &[granted]).unwrap();
        let config: Value = serde_json::from_str(&access.profile_config().unwrap()).unwrap();
        let rules = config["configOverrides"]
            .as_array()
            .unwrap()
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n");
        let selected_key =
            serde_json::to_string(dunce::canonicalize(&selected).unwrap().to_str().unwrap())
                .unwrap();
        let sibling_key =
            serde_json::to_string(dunce::canonicalize(&sibling).unwrap().to_str().unwrap())
                .unwrap();
        assert!(rules.contains(&selected_key));
        assert!(!rules.contains(&sibling_key));
        #[cfg(target_os = "macos")]
        if let Some(codex) = std::env::var_os("SAIL_CODEX_SANDBOX_TEST") {
            let run = |path: &Path| {
                let mut command = Command::new(&codex);
                command
                    .args(["sandbox", "-P", "sail-agent", "-C"])
                    .arg(&workspace);
                for value in config["configOverrides"].as_array().unwrap() {
                    command.arg("-c").arg(value.as_str().unwrap());
                }
                command
                    .args(["--", "mkdir", "-p"])
                    .arg(path)
                    .output()
                    .unwrap()
            };
            let evidence = selected.join("review-worker/evidence");
            let allowed = run(&evidence);
            assert!(
                allowed.status.success(),
                "{}",
                String::from_utf8_lossy(&allowed.stderr)
            );
            assert!(evidence.is_dir());
            assert!(!run(&sibling.join("evidence")).status.success());
            assert!(!sibling.join("evidence").exists());
        }
        assert!(assigned_scratch_directory(&owner, &roots).is_err());
        assert!(assigned_scratch_directory(&workspace, &roots).is_err());
        assert!(assigned_scratch_directory(Path::new("task/review"), &roots).is_err());
        assert!(assigned_scratch_directory(&owner.join("missing"), &roots).is_err());
        #[cfg(unix)]
        {
            let alias = owner.join("alias");
            std::os::unix::fs::symlink(&selected, &alias).unwrap();
            assert!(assigned_scratch_directory(&alias, &roots).is_err());
            let escape = owner.join("escape");
            std::os::unix::fs::symlink(&workspace, &escape).unwrap();
            assert!(assigned_scratch_directory(&escape, &roots).is_err());
        }
        std::fs::rename(&selected, owner.join("previous")).unwrap();
        std::fs::create_dir(&selected).unwrap();
        assert!(access.validate(None).is_err());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn codex_workspace_access_rejects_missing_files_and_replaced_roots() {
        let root = scratch("codex-invalid-access");
        assert!(CodexWorkspaceAccess::capture(&root.join("missing"), &[]).is_err());
        let file = root.join("file");
        std::fs::write(&file, "data").unwrap();
        assert!(CodexWorkspaceAccess::capture(&file, &[]).is_err());
        let assigned = root.join("assigned");
        std::fs::create_dir(&assigned).unwrap();
        let access = CodexWorkspaceAccess::capture(&assigned, &[]).unwrap();
        std::fs::rename(&assigned, root.join("previous")).unwrap();
        std::fs::create_dir(&assigned).unwrap();
        assert!(access.validate(None).unwrap_err().contains("replaced"));
        #[cfg(unix)]
        {
            let unowned = Path::new("/");
            use std::os::unix::fs::MetadataExt;
            if std::fs::metadata(unowned).unwrap().uid() != unsafe { nix::libc::geteuid() } {
                assert!(CodexWorkspaceAccess::capture(unowned, &[])
                    .unwrap_err()
                    .contains("not owned"));
            }
        }
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codex_workspace_access_runs_format_and_build_inside_the_sandbox() {
        let Some(codex) = std::env::var_os("SAIL_CODEX_SANDBOX_TEST") else {
            return;
        };
        let root = scratch("codex-sandbox-access");
        let assigned = root.join("assigned");
        let owned = root.join("owned");
        let sibling = root.join("sibling");
        for path in [&assigned, &owned, &sibling] {
            std::fs::create_dir(path).unwrap();
        }
        let source = assigned.join("main.rs");
        std::fs::write(&source, "fn main(){println!(\"assigned workspace\");}").unwrap();
        let access =
            CodexWorkspaceAccess::capture(&assigned, std::slice::from_ref(&owned)).unwrap();
        let config: Value = serde_json::from_str(&access.profile_config().unwrap()).unwrap();
        let run = |cwd: &Path, arguments: &[&str]| {
            let mut command = Command::new(&codex);
            command
                .arg("sandbox")
                .args(["-P", "sail-agent", "-C"])
                .arg(cwd);
            for value in config["configOverrides"].as_array().unwrap() {
                command.arg("-c").arg(value.as_str().unwrap());
            }
            command.arg("--").args(arguments).output().unwrap()
        };
        let formatted = run(&assigned, &["rustfmt", source.to_str().unwrap()]);
        assert!(
            formatted.status.success(),
            "{}",
            String::from_utf8_lossy(&formatted.stderr)
        );
        let binary = owned.join("program");
        let built = run(
            &assigned,
            &[
                "rustc",
                source.to_str().unwrap(),
                "-o",
                binary.to_str().unwrap(),
            ],
        );
        assert!(
            built.status.success(),
            "{}",
            String::from_utf8_lossy(&built.stderr)
        );
        assert!(binary.is_file());
        let forbidden = sibling.join("denied");
        for cwd in [&assigned, &sibling] {
            let denied = run(cwd, &["/usr/bin/touch", forbidden.to_str().unwrap()]);
            assert!(!denied.status.success());
            assert!(!forbidden.exists());
        }
        let alias = root.join("alias");
        std::os::unix::fs::symlink(&assigned, &alias).unwrap();
        assert!(run(&alias, &["rustfmt", source.to_str().unwrap()])
            .status
            .success());
        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn codex_workspace_access_runs_gpg_without_granting_home() {
        let Some(codex) = std::env::var_os("SAIL_CODEX_SANDBOX_TEST") else {
            return;
        };
        let home = PathBuf::from(std::env::var_os("HOME").unwrap());
        let gnupg = default_gnupg_directory(Some(&home)).unwrap();
        let gpg = find_executable("gpg").unwrap();
        let assigned = scratch("codex-gpg-access");
        std::fs::create_dir_all(&assigned).unwrap();
        let access =
            CodexWorkspaceAccess::capture(&assigned, std::slice::from_ref(&gnupg)).unwrap();
        let config: Value = serde_json::from_str(&access.profile_config().unwrap()).unwrap();
        let run = |arguments: &[&str]| {
            let mut command = Command::new(&codex);
            command
                .arg("sandbox")
                .args(["-P", "sail-agent", "-C"])
                .arg(&assigned);
            for value in config["configOverrides"].as_array().unwrap() {
                command.arg("-c").arg(value.as_str().unwrap());
            }
            command.arg("--").args(arguments).output().unwrap()
        };

        let trustdb = run(&[gpg.to_str().unwrap(), "--check-trustdb"]);
        assert!(
            trustdb.status.success(),
            "{}",
            String::from_utf8_lossy(&trustdb.stderr)
        );

        let denied = home.join(format!(".sail-codex-gpg-denied-{}", std::process::id()));
        assert!(!denied.exists());
        let denied_write = run(&["/usr/bin/touch", denied.to_str().unwrap()]);
        assert!(!denied_write.status.success());
        assert!(!denied.exists());
        std::fs::remove_dir_all(assigned).unwrap();
    }

    #[test]
    fn linked_worktree_session_grants_only_its_private_git_overlay() {
        let root = scratch("linked-git");
        let main = root.join("main");
        let linked = root.join("linked");
        assert!(Command::new("git")
            .args(["init", "-q"])
            .arg(&main)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["-C"])
            .arg(&main)
            .args([
                "-c",
                "user.name=Test",
                "-c",
                "user.email=test@example.com",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-q",
                "--allow-empty",
                "-m",
                "initial"
            ])
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["-C"])
            .arg(&main)
            .args(["worktree", "add", "-q", "-b", "sail/test"])
            .arg(&linked)
            .status()
            .unwrap()
            .success());

        assert!(session_request_params(linked.to_str().unwrap(), None, &[])
            .get("additionalDirectories")
            .is_none());
        let overlay = crate::git_overlay::GitOverlay::ensure(&root.join("cache"), &linked)
            .unwrap()
            .unwrap();
        let request = session_request_params(linked.to_str().unwrap(), None, &[]);
        let common = main.join(".git").canonicalize().unwrap();
        let roots = request["additionalDirectories"].as_array().unwrap();
        assert_eq!(roots, &vec![json!(overlay.git_dir)]);
        assert!(!roots.iter().any(|root| root == &json!(common.join("refs"))));
        assert!(!roots
            .iter()
            .any(|root| root == &json!(common.join("logs/refs"))));
        assert!(!roots.iter().any(|root| root == &json!(common)));
        assert_eq!(
            worktree_identity(&linked),
            crate::acp_terminal::stable_worktree_identity(&linked.canonicalize().unwrap())
        );
        let build_cache = root.join("task-build-cache");
        let task_temp = root.join("task-tmp");
        std::fs::create_dir(&build_cache).unwrap();
        std::fs::create_dir(&task_temp).unwrap();
        let profile: Value = serde_json::from_str(
            &CodexWorkspaceAccess::capture(
                &linked,
                &[overlay.git_dir.clone(), task_temp, build_cache.clone()],
            )
            .unwrap()
            .profile_config()
            .unwrap(),
        )
        .unwrap();
        let overrides = profile["configOverrides"].as_array().unwrap();
        let linked_key =
            serde_json::to_string(dunce::canonicalize(&linked).unwrap().to_str().unwrap()).unwrap();
        assert!(overrides.iter().any(|value| {
            value
                .as_str()
                .is_some_and(|value| value.contains(&linked_key))
        }));
        assert!(overrides.iter().all(|value| !value
            .as_str()
            .is_some_and(|value| value.contains(&common.to_string_lossy().to_string()))));
        assert!(overrides.iter().all(|value| !value
            .as_str()
            .is_some_and(|value| value.contains("filesystem.\""))));
        assert!(overrides.iter().any(|value| {
            value.as_str().is_some_and(|value| {
                value.contains("filesystem")
                    && value.contains(
                        &serde_json::to_string(
                            &dunce::canonicalize(&overlay.git_dir)
                                .unwrap()
                                .to_string_lossy(),
                        )
                        .unwrap(),
                    )
            })
        }));
        assert!(overrides
            .iter()
            .any(|value| value.as_str().is_some_and(|value| value.contains(
                &serde_json::to_string(
                    &dunce::canonicalize(&build_cache).unwrap().to_string_lossy()
                )
                .unwrap()
            ))));
        let restored = session_request_params(linked.to_str().unwrap(), Some("session"), &[]);
        assert_eq!(
            restored["additionalDirectories"],
            request["additionalDirectories"]
        );
        assert!(session_request_params(main.to_str().unwrap(), None, &[])
            .get("additionalDirectories")
            .is_none());

        let copied = root.join("copied");
        std::fs::create_dir(&copied).unwrap();
        std::fs::copy(linked.join(".git"), copied.join(".git")).unwrap();
        assert!(session_request_params(copied.to_str().unwrap(), None, &[])
            .get("additionalDirectories")
            .is_none());

        let sibling = root.join("sibling");
        assert!(Command::new("git")
            .args(["-C"])
            .arg(&main)
            .args(["worktree", "add", "-q", "-b", "sail/sibling"])
            .arg(&sibling)
            .status()
            .unwrap()
            .success());
        assert!(Command::new("git")
            .args(["-C"])
            .arg(&linked)
            .args(["symbolic-ref", "HEAD", "refs/heads/sail/sibling"])
            .status()
            .unwrap()
            .success());
        assert!(crate::git_overlay::GitOverlay::existing(&root.join("cache"), &linked).is_err());
        assert!(Command::new("git")
            .args(["-C"])
            .arg(&linked)
            .args(["symbolic-ref", "HEAD", "refs/heads/sail/test"])
            .status()
            .unwrap()
            .success());
        #[cfg(unix)]
        {
            use std::os::unix::fs::symlink;
            let pointer = linked.join(".git");
            let original = linked.join(".git-original");
            std::fs::rename(&pointer, &original).unwrap();
            symlink(sibling.join(".git"), &pointer).unwrap();
            assert!(session_request_params(linked.to_str().unwrap(), None, &[])
                .get("additionalDirectories")
                .is_none());
            assert!(
                crate::git_overlay::GitOverlay::existing(&root.join("cache"), &linked).is_err()
            );
            std::fs::remove_file(&pointer).unwrap();
            std::fs::rename(&original, &pointer).unwrap();
        }

        std::fs::create_dir(linked.join("nested")).unwrap();
        assert_eq!(
            session_request_params(linked.join("nested").to_str().unwrap(), None, &[])
                ["additionalDirectories"],
            request["additionalDirectories"]
        );
        std::fs::remove_dir_all(root).unwrap();
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
        assert_eq!(second.servers.len(), 1);
        assert_eq!(
            session_request_params(&first.cwd, Some("session"), &first.servers),
            session_request_params(&second.cwd, Some("session"), &second.servers)
        );
        std::fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn the_per_load_switch_mints_parameters_for_every_load() {
        let mut configs = HashMap::new();
        let mut tokens = HashMap::new();
        let alive = AtomicBool::new(true);
        let mut minted = 0;
        let mut released = 0;
        let first = restore_params(
            true,
            RestoreConfigState {
                alive: &alive,
                configs: &mut configs,
                per_load_tokens: &mut tokens,
            },
            "session",
            "/work/repo",
            || {
                minted += 1;
                Ok(config("first", &[("SAIL_BROWSER_TOKEN", "first")]))
            },
            |_| released += 1,
        )
        .unwrap();
        let second = restore_params(
            true,
            RestoreConfigState {
                alive: &alive,
                configs: &mut configs,
                per_load_tokens: &mut tokens,
            },
            "session",
            "/work/repo",
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
        assert_eq!(tokens["session"], ["first", "second"]);
        assert_eq!(first.1.as_deref(), Some("first"));
        assert_eq!(second.1.as_deref(), Some("second"));
        assert_ne!(first, second);
    }

    #[test]
    fn failed_restore_releases_only_its_new_token() {
        let mut configs = HashMap::new();
        let mut tokens = HashMap::from([("session".to_string(), vec!["older".to_string()])]);
        let alive = AtomicBool::new(true);
        let (_, minted_token) = restore_params(
            true,
            RestoreConfigState {
                alive: &alive,
                configs: &mut configs,
                per_load_tokens: &mut tokens,
            },
            "session",
            "/work/repo",
            || Ok(config("failed", &[])),
            |_| unreachable!(),
        )
        .unwrap();

        let mut released = Vec::new();
        release_per_load_token(
            &mut tokens,
            "session",
            minted_token.as_deref().unwrap(),
            |token| released.push(token.to_string()),
        );
        assert_eq!(released, ["failed"]);
        assert_eq!(tokens["session"], ["older"]);

        release_per_load_token(&mut tokens, "session", "failed", |_| unreachable!());
    }

    #[test]
    fn a_stopped_agent_releases_the_config_instead_of_storing_it() {
        let alive = AtomicBool::new(false);
        let mut configs = HashMap::new();
        let mut released = Vec::new();
        let stored = store_session_config(
            &alive,
            &mut configs,
            "session",
            SessionConfig {
                cwd: "/work/repo".into(),
                directory: PathBuf::from("/work/repo"),
                servers: vec![],
                token: "stopped".into(),
            },
            |token| released.push(token.to_string()),
        );
        assert!(!stored);
        assert!(configs.is_empty());
        assert_eq!(released, ["stopped"]);
    }

    #[test]
    fn a_stopped_agent_releases_a_new_per_load_token() {
        let alive = AtomicBool::new(false);
        let mut configs = HashMap::new();
        let mut tokens = HashMap::new();
        let mut released = Vec::new();
        let result = restore_params(
            true,
            RestoreConfigState {
                alive: &alive,
                configs: &mut configs,
                per_load_tokens: &mut tokens,
            },
            "session",
            "/work/repo",
            || Ok(config("stopped", &[])),
            |token| released.push(token.to_string()),
        );
        assert!(result.is_err());
        assert!(tokens.is_empty());
        assert_eq!(released, ["stopped"]);
    }

    #[test]
    fn per_load_tokens_are_released_on_forget_and_reader_exit() {
        let mut tokens = HashMap::from([
            (
                "first".to_string(),
                vec!["new".to_string(), "load".to_string()],
            ),
            ("second".to_string(), vec!["other".to_string()]),
        ]);
        let mut released = Vec::new();
        release_session_tokens(&mut tokens, "first", |token| {
            released.push(token.to_string())
        });
        assert_eq!(released, ["new", "load"]);
        assert_eq!(tokens["second"], ["other"]);

        release_all_per_load_tokens(&mut tokens, |token| released.push(token.to_string()));
        assert_eq!(released, ["new", "load", "other"]);
        assert!(tokens.is_empty());
    }

    #[test]
    fn reuse_keeps_the_parameters_the_adapter_already_saw() {
        let directory = scratch("restore");
        let cwd = directory.to_string_lossy().into_owned();
        let mut configs = HashMap::new();
        let mut tokens = HashMap::new();
        let alive = AtomicBool::new(true);
        let mut minted = 0;
        let first = restore_params(
            false,
            RestoreConfigState {
                alive: &alive,
                configs: &mut configs,
                per_load_tokens: &mut tokens,
            },
            "session",
            &cwd,
            || {
                minted += 1;
                Ok(config("first", &[("SAIL_BROWSER_TOKEN", "first")]))
            },
            |_| unreachable!("a reused config releases no token"),
        )
        .unwrap();
        let second = restore_params(
            false,
            RestoreConfigState {
                alive: &alive,
                configs: &mut configs,
                per_load_tokens: &mut tokens,
            },
            "session",
            &cwd,
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

    #[test]
    fn a_live_session_keeps_its_original_browser_configuration() {
        let directory = scratch("browser-reuse");
        let cwd = directory.to_string_lossy().into_owned();
        let mut configs = HashMap::new();
        let first = reuse_session_config(
            &mut configs,
            "session",
            &cwd,
            || Ok(config("first", &[])),
            |_| {},
        )
        .unwrap();
        let restored = reuse_session_config(
            &mut configs,
            "session",
            &cwd,
            || Err("a live session must keep its original MCP fingerprint".into()),
            |_| {},
        )
        .unwrap();

        assert_eq!(first.servers.len(), 1);
        assert_eq!(restored.servers, first.servers);
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
            || Ok(config("first", &[])),
            |_| {},
        )
        .unwrap();
        let through_link = reuse_session_config(
            &mut configs,
            "session",
            &link.to_string_lossy(),
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
            || Ok(config("first", &[])),
            |token| released.push(token.to_string()),
        )
        .unwrap();
        let moved = reuse_session_config(
            &mut configs,
            "session",
            &second_directory.to_string_lossy(),
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
    fn changed_task_snapshot_gets_new_generation_even_before_reader_disconnect() {
        let directory = PathBuf::from("/repo");
        let mut state = WorktreeFenceState::default();
        let mut children = NativeSubagentRegistry::default();
        children
            .spawn("parent", "child", directory.clone(), false)
            .unwrap();
        children.task_scope("child", true, true);
        let live = children.snapshots("opencode", CapabilityProfile::Build, &directory);
        let before = state.native_snapshot_generation(&directory, &live);
        assert_eq!(state.native_snapshot_generation(&directory, &live), before);
        let mut disconnected = live.clone();
        disconnected[0].task_turn_id = None;
        disconnected[0].outcome = "unknown".into();
        let after = state.native_snapshot_generation(&directory, &disconnected);
        assert!(after > before);
        assert_eq!(
            state.native_snapshot_generation(&directory, &disconnected),
            after
        );
    }

    #[test]
    fn disconnect_changes_task_generation_atomically_and_clears_native_turns() {
        let fence = AgentWorktreeFence::default();
        let directory = PathBuf::from("/repo");
        let mut children = NativeSubagentRegistry::default();
        children
            .spawn("parent", "child", directory.clone(), false)
            .unwrap();
        children.task_scope("child", true, true);
        let native = Mutex::new(children);
        let alive = AtomicBool::new(true);
        let before = fence
            .0
            .lock()
            .unwrap()
            .generations
            .get(&directory)
            .copied()
            .unwrap_or(0);
        fence.native_disconnected(&alive, &native).unwrap();
        let after = fence.0.lock().unwrap().generations[&directory];
        assert!(after > before);
        assert!(!alive.load(Ordering::Acquire));
        let children = native.lock().unwrap();
        assert!(children.0["child"].task_turn_id.is_none());
        assert_eq!(children.0["child"].outcome, "unknown");
    }

    #[test]
    fn replayed_spawn_reports_whether_the_child_is_still_live() {
        let mut registry = NativeSubagentRegistry::default();
        let directory = PathBuf::from("/repo");
        assert!(registry
            .spawn("parent", "child", directory.clone(), false)
            .unwrap());
        assert!(registry
            .spawn("parent", "child", directory.clone(), true)
            .unwrap());
        for outcome in ["completed", "failed", "cancelled"] {
            registry.update("parent", "child", outcome).unwrap();
            assert!(!registry
                .spawn("parent", "child", directory.clone(), false)
                .unwrap());
        }
        registry.update("parent", "child", "working").unwrap();
        assert!(registry
            .spawn("parent", "child", directory.clone(), false)
            .unwrap());
        assert!(registry.spawn("other", "child", directory, false).is_err());
    }

    #[test]
    fn interaction_revives_a_settled_child_but_a_replayed_spawn_does_not() {
        let mut registry = NativeSubagentRegistry::default();
        let directory = PathBuf::from("/repo");
        registry
            .spawn("parent", "child", directory.clone(), false)
            .unwrap();
        registry.update("parent", "child", "completed").unwrap();
        assert!(!registry.spawn("parent", "child", directory, false).unwrap());
        assert_eq!(registry.0["child"].outcome, "completed");
        assert!(registry.revive("child"));
        assert_eq!(registry.0["child"].outcome, "working");
        registry.update("parent", "child", "completed").unwrap();
        assert!(!NativeSubagentRegistry::is_live(&registry.0["child"]));
        assert!(!registry.revive("unknown"));
    }

    #[test]
    fn codex_interaction_is_marked_as_a_revival() {
        let activity = |kind: &str| {
            json!({
                "method":"session/update",
                "params":{"sessionId":"parent","update":{
                    "sessionUpdate":"tool_call",
                    "toolCallId":format!("activity-{kind}"),
                    "subagent":true,
                    "status":"completed",
                    "input":{
                        "activityKind":kind,
                        "agentPath":"/root/child",
                        "agentThreadId":"child-thread"
                    }
                }}
            })
        };
        let interacted = codex_native_activity_update(&activity("interacted"), None).unwrap();
        assert_eq!(
            interacted.pointer("/params/update/revive"),
            Some(&json!(true))
        );
        let started = codex_native_activity_update(&activity("started"), None).unwrap();
        assert!(started.pointer("/params/update/revive").is_none());
    }

    #[test]
    fn native_task_turn_is_own_live_scope_and_settles_before_reopening() {
        let mut registry = NativeSubagentRegistry::default();
        registry
            .spawn("parent", "child", PathBuf::from("/repo"), false)
            .unwrap();
        registry.task_scope("child", true, false);
        assert!(registry.0["child"].task_turn_id.is_none());
        registry.task_scope("child", true, true);
        let turn = registry.0["child"].task_turn_id.clone().unwrap();
        registry.task_scope("child", true, true);
        assert_eq!(
            registry.0["child"].task_turn_id.as_deref(),
            Some(turn.as_str())
        );
        registry.update("parent", "child", "completed").unwrap();
        assert!(registry.0["child"].task_turn_id.is_none());
        registry.update("parent", "child", "working").unwrap();
        registry.task_scope("child", true, true);
        assert_ne!(
            registry.0["child"].task_turn_id.as_deref(),
            Some(turn.as_str())
        );
        registry.update("parent", "child", "cancelled").unwrap();
        assert!(registry.0["child"].task_turn_id.is_none());
        registry
            .spawn("parent", "observed", PathBuf::from("/repo"), false)
            .unwrap();
        registry.task_scope("observed", false, true);
        assert!(registry.0["observed"].task_turn_id.is_none());
    }

    #[test]
    fn settled_children_do_not_restrict_restored_parent_tasks() {
        for outcome in ["completed", "failed", "cancelled"] {
            let mut registry = NativeSubagentRegistry::default();
            registry
                .spawn("parent", "child", PathBuf::from("/repo"), false)
                .unwrap();
            registry.update("parent", "child", outcome).unwrap();

            assert!(registry.task_connections().is_empty(), "{outcome}");
        }
    }

    #[test]
    fn live_nested_child_restores_its_terminal_ancestor() {
        let mut registry = NativeSubagentRegistry::default();
        registry
            .spawn("parent", "child", PathBuf::from("/repo"), false)
            .unwrap();
        registry
            .spawn("child", "nested", PathBuf::from("/repo"), false)
            .unwrap();
        registry.update("parent", "child", "completed").unwrap();

        let connected = registry.task_connections();
        assert_eq!(connected.len(), 2);
        assert!(connected.contains_key("child"));
        assert!(connected.contains_key("nested"));

        registry.update("child", "nested", "completed").unwrap();
        assert!(registry.task_connections().is_empty());
    }

    #[test]
    fn null_turn_cancels_only_the_live_registered_capable_child_once() {
        let mut registry = NativeSubagentRegistry::default();
        let directory = PathBuf::from("/repo");
        registry
            .spawn("parent", "target", directory.clone(), true)
            .unwrap();
        registry
            .spawn("parent", "sibling", directory.clone(), true)
            .unwrap();
        registry
            .spawn("parent", "observed", directory, false)
            .unwrap();

        assert!(native_cancel_eligible(&registry, "target", None).unwrap());
        assert!(!native_cancel_eligible(&registry, "parent", None).unwrap());
        assert!(!native_cancel_eligible(&registry, "target", Some("turn")).unwrap());
        assert!(native_cancel_eligible(&registry, "observed", None).is_err());

        let mut sent = Vec::new();
        dispatch_session_cancel(false, true, || {
            sent.push("target".to_string());
            Ok(())
        })
        .unwrap();
        assert_eq!(sent, ["target"]);
        assert_eq!(registry.0["target"].outcome, "working");
        assert_eq!(registry.0["sibling"].outcome, "working");
        assert!(!registry.0.contains_key("parent"));

        registry.update("parent", "target", "cancelled").unwrap();
        assert_eq!(registry.0["target"].outcome, "interrupted");
        assert!(native_cancel_eligible(&registry, "target", None).is_err());
        assert!(native_cancel_eligible(&registry, "sibling", None).unwrap());
        assert_eq!(registry.0["sibling"].outcome, "working");
    }

    #[test]
    fn native_child_binding_rejects_reparenting_and_directory_change() {
        let directory = PathBuf::from("/repo");
        let mut registry = NativeSubagentRegistry::default();
        registry
            .spawn("parent", "child", directory.clone(), true)
            .unwrap();

        assert!(registry
            .spawn("sibling", "child", directory.clone(), true)
            .is_err());
        assert!(registry
            .spawn("parent", "child", PathBuf::from("/elsewhere"), true)
            .is_err());
        assert!(registry.update("sibling", "child", "completed").is_err());
        assert_eq!(registry.0["child"].parent_session_id, "parent");
        assert_eq!(registry.0["child"].directory, directory);
        assert_eq!(registry.0["child"].outcome, "working");

        let mut directories = HashMap::from([("child".into(), PathBuf::from("/repo"))]);
        assert!(
            bind_session_directory(&mut directories, "child", PathBuf::from("/elsewhere")).is_err()
        );
        assert_eq!(directories["child"], PathBuf::from("/repo"));
    }

    #[test]
    fn nested_native_sessions_are_active_for_outer_worktree_cleanup() {
        let scratch =
            std::env::temp_dir().join(format!("sail-nested-acp-{}", uuid::Uuid::new_v4()));
        let outer = scratch.join("outer");
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        let mut registry = NativeSubagentRegistry::default();
        registry
            .spawn("parent", "child", nested.clone(), false)
            .unwrap();

        assert_eq!(registry.active_in(&outer), vec!["child"]);

        std::fs::remove_dir_all(scratch).unwrap();
    }

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
            .cleanup(&agents, &directory, Some(0), false, || {
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
        use std::fs;

        let directory =
            std::env::temp_dir().join(format!("sail-active-turn-cleanup-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&directory).expect("create worktree fixture");
        let marker = directory.join("keep.txt");
        fs::write(&marker, b"active session data").expect("write worktree marker");
        let mut child = spawn_test_session_process();
        let input = child.stdin.take().expect("placeholder agent stdin");
        let watchdog = crate::child_watchdog::ChildWatchdog::start(child.id())
            .expect("placeholder watchdog should start");
        let runtime = Arc::new(Connection {
            agent: "opencode".into(),
            profile: CapabilityProfile::Build,
            worktree: directory.clone(),
            owner: None,
            #[cfg(unix)]
            shared_build_directory: None,
            codex_workspace_access: None,
            runtime_path: std::ffi::OsString::new(),
            environment_id: String::new(),
            _storage_lease: None,
            child: Mutex::new(child),
            scratch_owner: None,
            runtime_scratch: Mutex::new(None),
            watchdog: Mutex::new(watchdog),
            stopped: AtomicBool::new(false),
            released_owner: AtomicBool::new(false),
            idle_exit: AtomicBool::new(false),
            last_activity: Mutex::new(Instant::now()),
            input: Mutex::new(input),
            pending: Mutex::new(HashMap::new()),
            reader_progress: ReaderProgress::default(),
            permission_state: Mutex::new(PermissionState::default()),
            elicitation_state: Mutex::new(HashMap::new()),
            next_permission_generation: AtomicU64::new(1),
            prompt_state: Mutex::new(PromptState::default()),
            temp_cleanup_gate: Mutex::new(TempCleanupState::default()),
            prompt_dispatch: Mutex::new(()),
            cancelled_prompts: Mutex::new(HashSet::new()),
            next_id: AtomicU64::new(1),
            alive: AtomicBool::new(true),
            capabilities: Mutex::new(Value::Null),
            session_directories: Mutex::new(HashMap::new()),
            session_configs: Mutex::new(HashMap::new()),
            per_load_tokens: Mutex::new(HashMap::new()),
            native_subagents: Mutex::new(NativeSubagentRegistry::default()),
            session_profiles: Mutex::new(HashMap::new()),
            session_ui: Mutex::new(HashMap::new()),
            pending_directory: Mutex::new(None),
            session_creation: Mutex::new(()),
            restores: Mutex::new(HashMap::new()),
            restore_ready: Condvar::new(),
            idle: Mutex::new(crate::acp_idle::IdleSessions::default()),
            ready: Condvar::new(),
            _owned_temp: None,
        });
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
                dispatched: false,
                memory_capture: crate::memory_capture::TurnCapture::default(),
                last_agent_message: String::new(),
                agent_message_open: false,
                agent_message_overflow: false,
                known_tool_calls: HashSet::new(),
            },
        );
        let agents = AgentManager::default();
        agents.0.lock().unwrap().insert(
            connection_key("opencode", CapabilityProfile::Build, &directory),
            runtime,
        );
        let mut cleaned = false;

        let error = AgentWorktreeFence::default()
            .cleanup(&agents, &directory, None, false, || {
                cleaned = true;
                fs::remove_dir_all(&directory).expect("remove selected worktree");
                Ok(())
            })
            .expect_err("an active OpenCode turn must block worktree removal");

        assert_eq!(
            error,
            "Worktree has connected agent sessions: opencode:ses_open."
        );
        let mut promoted = false;
        let error = AgentWorktreeFence::default()
            .promote(&agents, &directory, || {
                promoted = true;
                Ok(())
            })
            .expect_err("an active turn must also block promotion");
        assert_eq!(
            error,
            "Worktree has active agent sessions: opencode:ses_open."
        );
        assert!(!promoted);
        assert!(!cleaned);
        assert_eq!(
            fs::read(&marker).expect("active worktree must remain"),
            b"active session data"
        );
        fs::remove_dir_all(directory).expect("remove worktree fixture");
    }

    #[cfg(unix)]
    #[test]
    fn connected_idle_session_blocks_worktree_cleanup() {
        let directory = std::env::temp_dir().join(format!(
            "sail-idle-session-cleanup-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir(&directory).expect("create worktree fixture");
        let marker = directory.join("keep.txt");
        std::fs::write(&marker, b"idle session data").expect("write worktree marker");
        let runtime = super::session_config_tests::test_runtime(
            "opencode",
            CapabilityProfile::Build,
            &directory,
            "ses_idle",
            None,
        );
        let agents = AgentManager::default();
        agents.0.lock().unwrap().insert(
            connection_key("opencode", CapabilityProfile::Build, &directory),
            runtime,
        );
        assert!(agents.active_sessions_in(&directory).unwrap().is_empty());
        assert_eq!(
            agents
                .sessions_blocking_cleanup_in(&directory)
                .unwrap()
                .len(),
            1
        );
        let mut promoted = false;
        AgentWorktreeFence::default()
            .promote(&agents, &directory, || {
                promoted = true;
                Ok(())
            })
            .expect("idle connected session must allow promotion");
        assert!(promoted);
        let error = AgentWorktreeFence::default()
            .cleanup(&agents, &directory, None, false, || {
                std::fs::remove_dir_all(&directory).expect("remove selected worktree");
                Ok(())
            })
            .expect_err("connected idle session must block cleanup");
        assert_eq!(
            error,
            "Worktree has connected agent sessions: opencode:ses_idle."
        );
        assert_eq!(
            std::fs::read(&marker).expect("idle worktree must remain"),
            b"idle session data"
        );
        agents.stop_worktree(&directory).unwrap();
        std::fs::remove_dir_all(directory).expect("remove worktree fixture");
    }

    #[test]
    fn queued_native_spawn_waits_until_worktree_cleanup_releases_its_fence() {
        let fence = AgentWorktreeFence::default();
        let agents = AgentManager::default();
        let directory = PathBuf::from("/worktree");
        let (started_tx, started_rx) = mpsc::channel();
        let (finished_tx, finished_rx) = mpsc::channel();

        let worker = fence
            .cleanup(&agents, &directory, Some(0), false, || {
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

        registry
            .spawn("retired", "late-child", directory.clone(), false)
            .unwrap();

        assert_eq!(registry.active_in(&directory), vec!["late-child"]);
        registry
            .update("retired", "late-child", "completed")
            .unwrap();
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
            .cleanup(&AgentManager::default(), &directory, Some(0), false, || {
                Ok(())
            })
            .expect_err("guarded replacement must keep cleanup fenced");
        assert_eq!(
            cleanup_error,
            "An agent session is starting in this worktree."
        );
        let mut promoted = false;
        let error = fence
            .promote(&AgentManager::default(), &directory, || {
                promoted = true;
                Ok(())
            })
            .expect_err("a starting session must also block promotion");
        assert_eq!(error, "An agent session is starting in this worktree.");
        assert!(!promoted);

        fence
            .record_native_update(&directory)
            .expect("late retired-parent spawn should advance the generation");
        let mut dispatched = false;

        let error = fence
            .dispatch_session("codex", &directory, "replacement", || {
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

    #[test]
    fn confirmed_cleanup_removes_worktree_with_starting_and_guarded_sessions() {
        let fence = AgentWorktreeFence::default();
        let directory =
            std::env::temp_dir().join(format!("sail-forced-cleanup-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir(&directory).expect("test worktree should exist");
        fence
            .begin_session(&directory, None)
            .expect("agent connection should start");
        fence
            .begin_session(&directory, Some(0))
            .expect("replacement should start");
        fence
            .arm_session("codex", "replacement", &directory, 0)
            .expect("replacement should remain guarded");

        fence
            .cleanup(&AgentManager::default(), &directory, None, true, || {
                std::fs::remove_dir(&directory).map_err(|error| error.to_string())
            })
            .expect("confirmed cleanup should remove the worktree");

        assert_eq!(
            fence.finish_session(&directory, None).unwrap_err(),
            "Repository directory no longer exists."
        );
        assert_eq!(
            fence
                .dispatch_session("codex", &directory, "replacement", || Ok(()))
                .unwrap_err(),
            "Task-owned subagents changed before replacement prompt dispatch."
        );
    }

    #[test]
    fn confirmed_cleanup_invalidates_nested_guarded_session() {
        let fence = AgentWorktreeFence::default();
        let outer =
            std::env::temp_dir().join(format!("sail-nested-cleanup-{}", uuid::Uuid::new_v4()));
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).expect("nested worktree should exist");
        fence
            .begin_session(&nested, Some(0))
            .expect("nested replacement should start");
        fence
            .arm_session("codex", "replacement", &nested, 0)
            .expect("nested replacement should remain guarded");

        fence
            .cleanup(&AgentManager::default(), &outer, None, true, || Ok(()))
            .expect("confirmed outer cleanup should run");

        assert_eq!(
            fence
                .dispatch_session("codex", &nested, "replacement", || Ok(()))
                .unwrap_err(),
            "Task-owned subagents changed before replacement prompt dispatch."
        );
        std::fs::remove_dir_all(outer).expect("test worktree should be removable");
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
    fn codex_activity_becomes_observed_native_child_updates() {
        let activity = |kind: &str| {
            json!({
                "method":"session/update",
                "params":{"sessionId":"parent","update":{
                    "sessionUpdate":"tool_call",
                    "toolCallId":format!("activity-{kind}"),
                    "subagent":true,
                    "status":"completed",
                    "input":{
                        "activityKind":kind,
                        "agentPath":"/root/child_identity",
                        "agentThreadId":"child-thread"
                    }
                }}
            })
        };

        assert_eq!(
            codex_native_activity_update(&activity("started"), None)
                .unwrap()
                .pointer("/params/update"),
            Some(&json!({
                "sessionUpdate":"subagent_spawned",
                "subagentSessionId":"child-thread",
                "name":"child_identity",
                "task":"child_identity"
            }))
        );
        assert_eq!(
            codex_native_activity_update(&activity("completed"), None)
                .unwrap()
                .pointer("/params/update"),
            Some(&json!({
                "sessionUpdate":"subagent_state_update",
                "subagentSessionId":"child-thread",
                "state":"completed"
            }))
        );
    }

    #[test]
    fn codex_activity_standard_client_keeps_trusted_child_lifecycle() {
        let activity = |kind: &str, tool_call_id: &str, title: &str| {
            json!({
                "method":"session/update",
                "params":{"sessionId":"01a13b13-ed9a-79d0-99ed-87e62f1d1ab4","update":{
                    "sessionUpdate":"tool_call",
                    "toolCallId":tool_call_id,
                    "title":title,
                    "status":"completed",
                    "rawInput":{
                        "activityKind":kind,
                        "agentPath":"/root/native_child_identity",
                        "agentThreadId":"01a13b14-8984-79c1-9f54-795b4ced3e11"
                    }
                }}
            })
        };

        let started = codex_native_activity_update(
            &activity(
                "started",
                "call_d70a5f1945ba4b44ad8c0cfcfa112f74",
                "Start subagent native_child_identity",
            ),
            None,
        )
        .unwrap();
        assert_eq!(
            started.pointer("/params/update"),
            Some(&json!({
                "sessionUpdate":"subagent_spawned",
                "subagentSessionId":"01a13b14-8984-79c1-9f54-795b4ced3e11",
                "name":"native_child_identity",
                "task":"native_child_identity"
            }))
        );

        let completed = codex_native_activity_update(
            &activity(
                "completed",
                "subagent-completed-01a13b14-89cd-7b21-99ac-38cd34441410",
                "Complete subagent native_child_identity",
            ),
            None,
        )
        .unwrap();
        assert_eq!(
            completed.pointer("/params/update"),
            Some(&json!({
                "sessionUpdate":"subagent_state_update",
                "subagentSessionId":"01a13b14-8984-79c1-9f54-795b4ced3e11",
                "state":"completed"
            }))
        );
    }

    #[test]
    fn codex_activity_requires_adapter_subagent_provenance_and_scopes_owned_children() {
        let owner = "0d66d3a1-5c47-45d1-8c3d-4a789f129001";
        let mut message = json!({
            "method":"session/update",
            "params":{"sessionId":owned_session_id(owner, "parent"),"update":{
                "sessionUpdate":"tool_call",
                "toolCallId":"activity-started",
                "subagent":true,
                "status":"completed",
                "rawInput":{
                    "activityKind":"started",
                    "agentPath":"/root/child",
                    "agentThreadId":"child-thread"
                }
            }}
        });
        assert_eq!(
            codex_native_activity_update(&message, Some(owner))
                .unwrap()
                .pointer("/params/update/subagentSessionId"),
            Some(&json!(owned_session_id(owner, "child-thread")))
        );
        message["params"]["update"]["subagent"] = json!(false);
        assert!(codex_native_activity_update(&message, Some(owner)).is_none());
        message["params"]["update"]["subagent"] = json!("true");
        assert!(codex_native_activity_update(&message, Some(owner)).is_none());
        message["params"]["update"]
            .as_object_mut()
            .unwrap()
            .remove("subagent");
        message["params"]["update"]["title"] = json!("Generic tool");
        assert!(codex_native_activity_update(&message, Some(owner)).is_none());
        message["params"]["update"]["title"] = json!("Start subagent child");
        assert!(codex_native_activity_update(&message, Some(owner)).is_some());
        message["params"]["update"]["rawInput"]["agentThreadId"] = Value::Null;
        assert!(codex_native_activity_update(&message, Some(owner)).is_none());
    }

    #[test]
    fn claude_activity_becomes_observed_native_child_updates() {
        let activity = |status: &str, subagent: Option<bool>, tool_call_id: &str| {
            let mut update = json!({
                "sessionUpdate":"tool_call_update",
                "toolCallId":tool_call_id,
                "title":"Child task identity check",
                "status":status,
                "input":{"description":"Child task identity check"}
            });
            if let Some(subagent) = subagent {
                update["subagent"] = json!(subagent);
            }
            json!({"method":"session/update","params":{"sessionId":"parent","update":update}})
        };
        let child = "parent:claude-subagent:toolu_child";

        let started = claude_native_activity_update(
            &activity("in_progress", Some(true), "toolu_child"),
            |_, _| false,
        )
        .unwrap();
        assert_eq!(
            started.pointer("/params/update"),
            Some(&json!({
                "sessionUpdate":"subagent_spawned",
                "subagentSessionId":child,
                "name":"Child task identity check",
                "task":"Child task identity check"
            }))
        );

        for (status, state) in [
            ("completed", "completed"),
            ("failed", "failed"),
            ("interrupted", "cancelled"),
        ] {
            let settled = claude_native_activity_update(
                &activity(status, None, "toolu_child"),
                |parent, candidate| parent == "parent" && candidate == child,
            )
            .unwrap();
            assert_eq!(
                settled.pointer("/params/update"),
                Some(&json!({
                    "sessionUpdate":"subagent_state_update",
                    "subagentSessionId":child,
                    "state":state
                }))
            );
        }
    }

    #[test]
    fn claude_adapter_agent_signature_becomes_observed_native_child_updates() {
        let partial = json!({
            "method":"session/update",
            "params":{"sessionId":"parent","update":{
                "sessionUpdate":"tool_call",
                "toolCallId":"toolu_01SP5UF44Tk2e4NNKGFz9Xua",
                "name":"Agent",
                "title":"Native child task identity",
                "status":"pending",
                "rawInput":{},
                "_meta":{"claudeCode":{"toolName":"Agent"}}
            }}
        });
        assert!(claude_native_activity_update(&partial, |_, _| false).is_none());

        let started = json!({
            "method":"session/update",
            "params":{"sessionId":"parent","update":{
                "sessionUpdate":"tool_call_update",
                "toolCallId":"toolu_01SP5UF44Tk2e4NNKGFz9Xua",
                "title":"Native child task identity",
                "rawInput":{
                    "description":"Native child task identity",
                    "subagent_type":"general-purpose",
                    "run_in_background":false,
                    "prompt":"Call Sail sail_tasks_read."
                },
                "_meta":{"claudeCode":{"toolName":"Agent"}}
            }}
        });
        let child = "parent:claude-subagent:toolu_01SP5UF44Tk2e4NNKGFz9Xua";

        let normalized = claude_native_activity_update(&started, |_, _| false).unwrap();
        assert_eq!(
            normalized.pointer("/params/update"),
            Some(&json!({
                "sessionUpdate":"subagent_spawned",
                "subagentSessionId":child,
                "name":"Native child task identity",
                "task":"Native child task identity"
            }))
        );

        let settled = json!({
            "method":"session/update",
            "params":{"sessionId":"parent","update":{
                "sessionUpdate":"tool_call_update",
                "toolCallId":"toolu_01SP5UF44Tk2e4NNKGFz9Xua",
                "status":"completed"
            }}
        });
        assert!(
            claude_native_activity_update(&settled, |parent, candidate| {
                parent == "parent" && candidate == child
            })
            .is_some()
        );
        assert!(claude_native_activity_update(&settled, |_, _| false).is_none());
    }

    #[test]
    fn claude_adapter_agent_signature_rejects_malformed_and_generic_tools() {
        let signature = || {
            json!({
                "method":"session/update",
                "params":{"sessionId":"parent","update":{
                    "sessionUpdate":"tool_call",
                    "toolCallId":"toolu_child",
                    "name":"Agent",
                    "status":"pending",
                    "rawInput":{
                        "subagent_type":"general-purpose",
                        "run_in_background":false
                    },
                    "_meta":{"claudeCode":{"toolName":"Agent"}}
                }}
            })
        };
        let rejects = |message: &Value| {
            assert!(claude_native_activity_update(message, |_, _| false).is_none())
        };

        let mut message = signature();
        message["params"]["update"]["name"] = json!("Bash");
        rejects(&message);

        let mut message = signature();
        message["params"]["update"]["_meta"]["claudeCode"]["toolName"] = json!("Bash");
        rejects(&message);

        let mut message = signature();
        message["params"]["update"]["rawInput"]["subagent_type"] = json!("");
        rejects(&message);

        let mut message = signature();
        message["params"]["update"]["rawInput"]["run_in_background"] = json!("false");
        rejects(&message);

        let mut message = signature();
        message["params"]["update"]["toolCallId"] = json!(" ");
        rejects(&message);

        let mut message = signature();
        message["params"]["update"]
            .as_object_mut()
            .unwrap()
            .remove("_meta");
        rejects(&message);
    }

    #[test]
    fn claude_activity_rejects_untrusted_and_mismatched_updates() {
        let activity = |status: &str, marker: Value, tool_call_id: &str| {
            json!({"method":"session/update","params":{"sessionId":"parent","update":{
                "sessionUpdate":"tool_call",
                "toolCallId":tool_call_id,
                "title":"Child task identity check",
                "status":status,
                "subagent":marker
            }}})
        };

        assert!(claude_native_activity_update(
            &activity("in_progress", json!(false), "toolu_child"),
            |_, _| false,
        )
        .is_none());
        assert!(claude_native_activity_update(
            &activity("in_progress", json!("true"), "toolu_child"),
            |_, _| false,
        )
        .is_none());
        assert!(claude_native_activity_update(
            &activity("completed", json!(true), "toolu_other"),
            |_, _| false,
        )
        .is_none());
        assert!(claude_native_activity_update(
            &json!({"method":"session/update","params":{"sessionId":"parent","update":{
                "sessionUpdate":"agent_message_chunk",
                "toolCallId":"toolu_child",
                "subagent":true
            }}}),
            |_, _| true,
        )
        .is_none());
    }

    #[test]
    fn settled_native_activity_reopens_parent_task_access() {
        let live = json!({"toolCallId":"agent-tool","subagent":true,"status":"in_progress"});
        let ordinary = json!({"toolCallId":"shell","status":"in_progress"});

        assert_eq!(native_activity_fence(&live), Some(("agent-tool", true)));
        assert_eq!(native_activity_fence(&ordinary), None);
        for status in ["completed", "failed", "cancelled", "interrupted"] {
            let settled = json!({"toolCallId":"agent-tool","status":status});
            assert_eq!(
                native_activity_fence(&settled),
                Some(("agent-tool", false)),
                "{status} must release the parent task-attribution fence"
            );
        }
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

#[cfg(all(test, unix))]
mod idle_close_tests {
    use super::*;

    fn runtime(session: &str) -> Arc<Connection> {
        let directory = std::env::temp_dir();
        let runtime = super::session_config_tests::test_runtime(
            "codex",
            CapabilityProfile::Build,
            &directory,
            session,
            None,
        );
        runtime.elicitation_state.lock().unwrap().clear();
        runtime.permission_state.lock().unwrap().pending.clear();
        runtime
    }

    #[test]
    fn pending_question_keeps_the_session_loaded() {
        let runtime = runtime("ses_question");
        runtime.elicitation_state.lock().unwrap().insert(
            "1".into(),
            PendingElicitation {
                message: json!({"method":"elicitation/create","id":1,"params":{"sessionId":"ses_question"}}),
                received_at: 1,
            },
        );
        assert!(holds_work(&runtime, "ses_question", false));
    }

    fn holds_work(runtime: &Connection, session: &str, terminal_running: bool) -> bool {
        let restores = runtime.restores.lock().unwrap();
        let prompts = runtime.prompt_state.lock().unwrap();
        runtime
            .session_holds_work(session, &prompts, &restores, terminal_running)
            .unwrap()
    }

    fn active_prompt() -> ActivePrompt {
        ActivePrompt {
            turn_id: "turn".into(),
            text: "task".into(),
            dispatched: true,
            memory_capture: crate::memory_capture::TurnCapture::default(),
            last_agent_message: String::new(),
            agent_message_open: false,
            agent_message_overflow: false,
            known_tool_calls: HashSet::new(),
        }
    }

    #[test]
    fn finished_session_without_work_may_close() {
        let runtime = runtime("ses_done");
        assert!(!holds_work(&runtime, "ses_done", false));
    }

    #[test]
    fn running_turn_keeps_the_session_loaded() {
        let runtime = runtime("ses_turn");
        runtime
            .prompt_state
            .lock()
            .unwrap()
            .active
            .insert("ses_turn".into(), active_prompt());
        assert!(holds_work(&runtime, "ses_turn", false));
    }

    #[test]
    fn running_terminal_keeps_the_session_loaded() {
        let runtime = runtime("ses_terminal");
        assert!(holds_work(&runtime, "ses_terminal", true));
    }

    #[test]
    fn background_task_keeps_the_session_loaded_until_it_ends() {
        let runtime = runtime("ses_task");
        let update = |value: Value| {
            runtime
                .idle
                .lock()
                .unwrap()
                .observe_update("ses_task", &value)
        };
        update(json!({"sessionUpdate":"async_task_spawned","asyncTaskId":"shell"}));
        assert!(holds_work(&runtime, "ses_task", false));
        update(
            json!({"sessionUpdate":"async_task_state_update","asyncTaskId":"shell","state":"completed"}),
        );
        assert!(!holds_work(&runtime, "ses_task", false));
    }

    #[test]
    fn live_subagent_keeps_its_parent_loaded_until_it_ends() {
        let runtime = runtime("ses_parent");
        runtime
            .native_subagents
            .lock()
            .unwrap()
            .spawn("ses_parent", "ses_child", std::env::temp_dir(), false)
            .unwrap();
        assert!(holds_work(&runtime, "ses_parent", false));
        assert!(holds_work(&runtime, "ses_child", false));
        runtime
            .native_subagents
            .lock()
            .unwrap()
            .update("ses_parent", "ses_child", "completed")
            .unwrap();
        assert!(!holds_work(&runtime, "ses_parent", false));
        assert!(!holds_work(&runtime, "ses_child", false));
    }

    #[test]
    fn fresh_session_and_background_shell_keep_the_session_loaded() {
        let runtime = runtime("ses_fresh");
        runtime.idle.lock().unwrap().mark_fresh("ses_fresh");
        assert!(holds_work(&runtime, "ses_fresh", false));
        runtime
            .idle
            .lock()
            .unwrap()
            .observe_update("ses_fresh", &json!({"sessionUpdate":"agent_message_chunk"}));
        assert!(!holds_work(&runtime, "ses_fresh", false));
        runtime.idle.lock().unwrap().observe_update(
            "ses_fresh",
            &json!({"sessionUpdate":"tool_call_update","rawInput":{"run_in_background":true}}),
        );
        assert!(holds_work(&runtime, "ses_fresh", false));
    }

    #[test]
    fn config_replay_restores_only_selections_the_resume_changed() {
        let option = |id: &str, current: &str, values: &[&str]| {
            json!({
                "id": id,
                "type": "select",
                "currentValue": current,
                "options": values.iter().map(|v| json!({"value": v})).collect::<Vec<_>>(),
            })
        };
        let previous = json!([
            option("model", "fast", &["test", "fast"]),
            option("mode", "plan", &["auto", "plan"]),
            option("effort", "high", &["medium", "high"]),
            {"id": "fast_mode", "type": "boolean", "currentValue": true},
        ]);
        let resumed = json!([
            option("model", "fast", &["test", "fast"]),
            option("mode", "auto", &["auto", "plan"]),
            option("effort", "medium", &["medium"]),
            {"id": "fast_mode", "type": "boolean", "currentValue": false},
        ]);
        assert_eq!(
            config_replays(&previous, &resumed),
            vec![("mode".to_string(), "plan".to_string())]
        );
        assert!(config_replays(&json!(null), &resumed).is_empty());
    }

    #[test]
    fn restoring_session_keeps_it_loaded() {
        let runtime = runtime("ses_restore");
        runtime.begin_restore("ses_restore").unwrap();
        assert!(holds_work(&runtime, "ses_restore", false));
    }

    #[test]
    fn expired_restore_reservation_does_not_keep_the_session_loaded() {
        let runtime = runtime("ses_abandoned");
        runtime.begin_restore("ses_abandoned").unwrap();
        runtime
            .restores
            .lock()
            .unwrap()
            .get_mut("ses_abandoned")
            .unwrap()
            .expires = Instant::now();
        assert!(!holds_work(&runtime, "ses_abandoned", false));
    }

    #[test]
    fn active_restore_keeps_the_session_loaded_after_reservation_expiry() {
        let runtime = runtime("ses_slow_restore");
        let reservation = runtime.begin_restore("ses_slow_restore").unwrap();
        let token = reservation["restoreToken"].as_str().unwrap();
        let request = runtime
            .begin_restore_request("ses_slow_restore", token)
            .unwrap();
        runtime
            .restores
            .lock()
            .unwrap()
            .get_mut("ses_slow_restore")
            .unwrap()
            .expires = Instant::now();
        assert!(holds_work(&runtime, "ses_slow_restore", false));
        drop(request);
        assert!(holds_work(&runtime, "ses_slow_restore", false));
    }

    #[test]
    fn close_support_requires_a_releasing_adapter_that_advertises_it() {
        let advertised = json!({"agentCapabilities":{"sessionCapabilities":{"close":{}}}});
        for (agent, closes) in [("claude", true), ("codex", true), ("opencode", false)] {
            let runtime = super::session_config_tests::test_runtime(
                agent,
                CapabilityProfile::Build,
                &std::env::temp_dir(),
                "ses_caps",
                None,
            );
            assert!(!runtime.supports_session_close(), "{agent} without close");
            *runtime.capabilities.lock().unwrap() = advertised.clone();
            assert_eq!(runtime.supports_session_close(), closes, "{agent}");
        }
    }

    fn closed_runtime(agent: &str, session: &str) -> Arc<Connection> {
        let runtime = super::session_config_tests::test_runtime(
            agent,
            CapabilityProfile::Build,
            &std::env::temp_dir(),
            session,
            None,
        );
        let mut idle = runtime.idle.lock().unwrap();
        idle.begin_close(session);
        idle.end_close(session);
        drop(idle);
        runtime
    }

    /// Stands in for `register_session`, which marks the session attached before the resume request.
    fn attach(runtime: &Connection, session: &str) {
        runtime
            .idle
            .lock()
            .unwrap()
            .mark_attached(session, Instant::now());
    }

    #[test]
    fn concurrent_calls_on_a_closed_thread_wait_for_one_resume() {
        for agent in ["codex", "claude"] {
            let session = format!("ses_race_{agent}");
            let runtime = closed_runtime(agent, &session);
            let resumes = Arc::new(std::sync::atomic::AtomicUsize::new(0));
            let (started_tx, started_rx) = mpsc::channel();
            let (release_tx, release_rx) = mpsc::channel::<()>();
            let first = {
                let (runtime, session, resumes) =
                    (Arc::clone(&runtime), session.clone(), Arc::clone(&resumes));
                std::thread::spawn(move || {
                    runtime.reattach_closed(&session, || {
                        resumes.fetch_add(1, Ordering::SeqCst);
                        attach(&runtime, &session);
                        started_tx.send(()).unwrap();
                        release_rx.recv().unwrap();
                        Ok(())
                    })
                })
            };
            started_rx.recv().unwrap();
            let second_done = Arc::new(AtomicBool::new(false));
            let second = {
                let (runtime, session, resumes, done) = (
                    Arc::clone(&runtime),
                    session.clone(),
                    Arc::clone(&resumes),
                    Arc::clone(&second_done),
                );
                std::thread::spawn(move || {
                    let result = runtime.reattach_closed(&session, || {
                        resumes.fetch_add(1, Ordering::SeqCst);
                        Ok(())
                    });
                    done.store(true, Ordering::SeqCst);
                    result
                })
            };
            std::thread::sleep(Duration::from_millis(150));
            assert!(
                !second_done.load(Ordering::SeqCst),
                "{agent}: the second caller must wait for the resume"
            );
            assert!(runtime.idle.lock().unwrap().is_closed(&session));
            release_tx.send(()).unwrap();
            assert_eq!(first.join().unwrap(), Ok(Some(())), "{agent}");
            assert_eq!(second.join().unwrap(), Ok(None), "{agent}");
            assert_eq!(resumes.load(Ordering::SeqCst), 1, "{agent}");
            assert!(!runtime.idle.lock().unwrap().is_closed(&session));
        }
    }

    #[test]
    fn failed_resume_leaves_the_thread_closed_so_the_next_call_retries() {
        for agent in ["codex", "claude"] {
            let session = format!("ses_retry_{agent}");
            let runtime = closed_runtime(agent, &session);
            let failed = runtime.reattach_closed(&session, || {
                attach(&runtime, &session);
                Err::<(), _>("Session not found".to_string())
            });
            assert_eq!(failed, Err("Session not found".to_string()), "{agent}");
            {
                let idle = runtime.idle.lock().unwrap();
                assert!(idle.is_closed(&session), "{agent}: closed marker kept");
                assert!(!idle.is_resuming(&session), "{agent}: claim released");
            }
            let retried = runtime.reattach_closed(&session, || {
                attach(&runtime, &session);
                Ok(())
            });
            assert_eq!(retried, Ok(Some(())), "{agent}");
            assert!(!runtime.idle.lock().unwrap().is_closed(&session));
            assert_eq!(runtime.reattach_closed(&session, || Ok(())), Ok(None));
        }
    }

    #[test]
    fn ui_restore_keeps_a_closed_thread_closed_until_its_resume_succeeds() {
        for agent in ["codex", "claude"] {
            let session = format!("ses_ui_restore_{agent}");
            let runtime = closed_runtime(agent, &session);
            let waiting_done = Arc::new(AtomicBool::new(false));
            let mut claim = runtime.begin_attaching_restore(&session).unwrap();
            assert!(claim.is_some(), "{agent}: the restore claims the resume");
            {
                let idle = runtime.idle.lock().unwrap();
                assert!(idle.is_closed(&session), "{agent}: closed while resuming");
                assert!(idle.is_resuming(&session), "{agent}: claim held");
            }
            let waiter = {
                let (runtime, session, done) = (
                    Arc::clone(&runtime),
                    session.clone(),
                    Arc::clone(&waiting_done),
                );
                std::thread::spawn(move || {
                    let result = runtime.reattach_closed(&session, || Ok(()));
                    done.store(true, Ordering::SeqCst);
                    result
                })
            };
            std::thread::sleep(Duration::from_millis(150));
            assert!(
                !waiting_done.load(Ordering::SeqCst),
                "{agent}: a call-driven reattach must wait for the UI resume"
            );
            claim.as_mut().unwrap().resumed = true;
            drop(claim);
            assert_eq!(waiter.join().unwrap(), Ok(None), "{agent}");
            assert!(!runtime.idle.lock().unwrap().is_closed(&session));
        }
    }

    #[test]
    fn failed_ui_restore_leaves_a_closed_thread_closed() {
        for agent in ["codex", "claude"] {
            let session = format!("ses_ui_failed_{agent}");
            let runtime = closed_runtime(agent, &session);
            drop(runtime.begin_attaching_restore(&session).unwrap());
            {
                let idle = runtime.idle.lock().unwrap();
                assert!(idle.is_closed(&session), "{agent}: closed marker kept");
                assert!(!idle.is_resuming(&session), "{agent}: claim released");
            }
            let retried = runtime.reattach_closed(&session, || Ok(()));
            assert_eq!(retried, Ok(Some(())), "{agent}: the next call resumes it");
        }
    }

    #[test]
    fn ui_restore_of_a_loaded_thread_takes_no_claim() {
        let runtime = runtime("ses_ui_loaded");
        assert!(runtime
            .begin_attaching_restore("ses_ui_loaded")
            .unwrap()
            .is_none());
        assert!(!runtime.idle.lock().unwrap().is_closed("ses_ui_loaded"));
    }

    #[test]
    fn deleting_loaded_or_just_restored_threads_unregisters_before_close() {
        for agent in ["codex", "claude"] {
            for restored in [false, true] {
                let session = format!("ses_loaded_delete_{agent}_{restored}");
                let runtime = closed_runtime(agent, &session);
                if restored {
                    let mut claim = runtime.begin_attaching_restore(&session).unwrap().unwrap();
                    claim.resumed = true;
                    drop(claim);
                    let token = runtime.begin_restore(&session).unwrap()["restoreToken"]
                        .as_str()
                        .unwrap()
                        .to_owned();
                    runtime.release_restore(&session, &token).unwrap();
                } else {
                    attach(&runtime, &session);
                }
                forget_registered_session(&runtime, &session).unwrap();
                close_deleted_session(&runtime, &session, || {
                    assert!(!runtime
                        .session_profiles
                        .lock()
                        .unwrap()
                        .contains_key(&session));
                    assert!(!runtime
                        .session_directories
                        .lock()
                        .unwrap()
                        .contains_key(&session));
                    Err("close failed".into())
                });
                let idle = runtime.idle.lock().unwrap();
                assert!(!idle.is_closed(&session));
                assert!(!idle.is_resuming(&session));
            }
        }
    }

    #[test]
    fn deleting_a_thread_during_its_restore_leaves_nothing_registered() {
        for agent in ["codex", "claude"] {
            let session = format!("ses_delete_{agent}");
            let runtime = closed_runtime(agent, &session);
            let claim = runtime.begin_attaching_restore(&session).unwrap();
            assert!(claim.is_some(), "{agent}");
            assert!(runtime
                .session_profiles
                .lock()
                .unwrap()
                .contains_key(&session));
            assert!(runtime
                .session_directories
                .lock()
                .unwrap()
                .contains_key(&session));
            // The delete drops the idle state while the resume is still in flight.
            runtime.idle.lock().unwrap().forget(&session);
            // An aborted delete leaves the thread live and clears its fence.
            assert!(!unregister_if_deleted(&runtime, &session).unwrap());
            assert!(runtime
                .session_profiles
                .lock()
                .unwrap()
                .contains_key(&session));
            runtime
                .prompt_state
                .lock()
                .unwrap()
                .mark_forgotten(&session);
            assert!(unregister_if_deleted(&runtime, &session).unwrap());
            drop(claim);
            assert!(!runtime
                .session_profiles
                .lock()
                .unwrap()
                .contains_key(&session));
            assert!(!runtime
                .session_directories
                .lock()
                .unwrap()
                .contains_key(&session));
            let idle = runtime.idle.lock().unwrap();
            assert!(!idle.is_closed(&session), "{agent}: no closed marker");
            assert!(!idle.is_resuming(&session), "{agent}: claim released");
            drop(idle);
            assert_eq!(runtime.reattach_closed(&session, || Ok(())), Ok(None));
        }
    }

    #[test]
    fn resuming_thread_is_never_chosen_for_an_idle_close() {
        let runtime = runtime("ses_resuming");
        assert!(!holds_work(&runtime, "ses_resuming", false));
        let mut idle = runtime.idle.lock().unwrap();
        idle.begin_close("ses_resuming");
        idle.end_close("ses_resuming");
        idle.claim_resume("ses_resuming");
        drop(idle);
        assert!(holds_work(&runtime, "ses_resuming", false));
    }

    #[test]
    fn unknown_session_close_errors_count_as_closed() {
        assert!(is_unknown_session_error("Session not found"));
        assert!(is_unknown_session_error("unknown thread abc"));
        assert!(!is_unknown_session_error("request timed out"));
    }
}
