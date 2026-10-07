use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

struct AgentDefinition {
    id: &'static str,
    name: &'static str,
    executable: &'static str,
    package: &'static str,
    binary_env: Option<&'static str>,
    min_node_major: u32,
}

const AGENTS: &[AgentDefinition] = &[
    AgentDefinition {
        id: "claude",
        name: "Claude",
        executable: "claude",
        package: "@agentclientprotocol/claude-agent-acp@0.84.0",
        binary_env: None,
        min_node_major: 22,
    },
    AgentDefinition {
        id: "codex",
        name: "Codex",
        executable: "codex",
        package: "@agentclientprotocol/codex-acp@2.0.0",
        binary_env: Some("CODEX_PATH"),
        min_node_major: 18,
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

struct Connection {
    agent: String,
    child: Mutex<Child>,
    #[cfg(unix)]
    watchdog: Mutex<crate::child_watchdog::ChildWatchdog>,
    stopped: AtomicBool,
    input: Mutex<ChildStdin>,
    pending: Mutex<HashMap<u64, mpsc::Sender<Value>>>,
    permissions: Mutex<HashMap<String, PendingPermission>>,
    prompt_state: Mutex<PromptState>,
    cancelled_prompts: Mutex<HashSet<String>>,
    next_id: AtomicU64,
    alive: AtomicBool,
    capabilities: Mutex<Value>,
    session_directories: Mutex<HashMap<String, PathBuf>>,
    pending_directory: Mutex<Option<PathBuf>>,
    session_creation: Mutex<()>,
    ready: Condvar,
}

struct PendingPermission {
    message: Value,
    received_at: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PendingPermissionInfo {
    agent: String,
    message: Value,
    received_at: u64,
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

    fn request(&self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
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
            self.write(&json!({"jsonrpc":"2.0","id":id,"method":method,"params":params}))
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
        crate::diagnostics::record(
            "acp_request_finished",
            json!({
                "method":method,"requestId":id,"elapsedMs":started.elapsed().as_millis(),
                "agent":self.agent,"sessionId":session_id,
                "ok":response.get("error").is_none(),
                "stopReason":response.pointer("/result/stopReason").and_then(Value::as_str)
            }),
        );
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

    fn respond(&self, id: Value, result: Value) -> Result<(), String> {
        self.write(&json!({"jsonrpc":"2.0","id":id,"result":result}))?;
        self.permissions
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&id.to_string());
        Ok(())
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

#[derive(Clone, Default)]
pub struct AgentManager(Arc<Mutex<HashMap<String, Arc<Connection>>>>);

impl AgentManager {
    pub fn record_interrupted_turns(&self, app: &AppHandle) -> Result<(), String> {
        let agents = self.0.lock().map_err(|error| error.to_string())?;
        for (agent, runtime) in agents.iter() {
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
                        agent: agent.clone(),
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
}

struct ActivePrompt {
    turn_id: String,
    text: String,
    last_agent_message: String,
    agent_message_open: bool,
    agent_message_overflow: bool,
    known_tool_calls: HashSet<String>,
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
        !self.agent_message_overflow
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
    agents
        .iter()
        .map(|(agent, runtime)| {
            let alive = runtime.alive.load(Ordering::Acquire);
            let prompts = runtime
                .prompt_state
                .lock()
                .map_err(|error| error.to_string())?;
            let active = prompts.active.keys().cloned().collect();
            let active_turns = prompts
                .active
                .iter()
                .map(|(session, prompt)| (session.clone(), prompt.turn_id.clone()))
                .collect();
            let finished = prompts.finished.clone();
            let sessions = runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?
                .keys()
                .cloned()
                .collect();
            let waiting = runtime
                .permissions
                .lock()
                .map_err(|error| error.to_string())?
                .values()
                .filter_map(|pending| {
                    pending
                        .message
                        .pointer("/params/sessionId")
                        .and_then(Value::as_str)
                })
                .map(str::to_string)
                .collect();
            Ok((
                agent.clone(),
                AgentActivity {
                    alive,
                    active,
                    active_turns,
                    waiting,
                    sessions,
                    finished,
                },
            ))
        })
        .collect()
}

#[tauri::command]
pub fn acp_pending_inbox(
    manager: State<'_, AgentManager>,
) -> Result<Vec<PendingPermissionInfo>, String> {
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    let mut pending = Vec::new();
    for (agent, runtime) in agents.iter() {
        if !runtime.alive.load(Ordering::Acquire) {
            continue;
        }
        for permission in runtime
            .permissions
            .lock()
            .map_err(|error| error.to_string())?
            .values()
        {
            pending.push(PendingPermissionInfo {
                agent: agent.clone(),
                message: permission.message.clone(),
                received_at: permission.received_at,
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

fn connection(manager: &AgentManager, id: &str) -> Result<Arc<Connection>, String> {
    let agents = manager.0.lock().map_err(|error| error.to_string())?;
    agents
        .get(id)
        .cloned()
        .ok_or_else(|| "Agent is not connected.".into())
}

#[tauri::command]
pub fn acp_agents() -> Vec<AgentAvailability> {
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("SAIL_ACP_TEST_AGENT") {
        return AGENTS
            .iter()
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
        .map(|agent| {
            let binary = find_executable(agent.executable);
            AgentAvailability {
                id: agent.id.into(),
                name: agent.name.into(),
                binary_path: binary
                    .as_ref()
                    .map(|path| path.to_string_lossy().into_owned()),
                available: binary.is_some()
                    && npx.is_some()
                    && major.is_some_and(|version| version >= agent.min_node_major),
                reason: if binary.is_none() {
                    Some(format!("Install {} first.", agent.name))
                } else if npx.is_none() || node.is_none() {
                    Some("Node.js and npx are required for the ACP adapter.".into())
                } else if major.is_none_or(|version| version < agent.min_node_major) {
                    Some(format!(
                        "{} requires Node.js {} or newer.",
                        agent.name, agent.min_node_major
                    ))
                } else {
                    None
                },
            }
        })
        .collect()
}

#[tauri::command]
pub async fn acp_connect(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
) -> Result<Value, String> {
    let manager = manager.inner().clone();
    tauri::async_runtime::spawn_blocking(move || connect_blocking(app, &manager, agent))
        .await
        .map_err(|error| error.to_string())?
}

fn connect_blocking(
    app: AppHandle,
    manager: &AgentManager,
    agent: String,
) -> Result<Value, String> {
    let definition = definition(&agent)?;
    let mut agents = manager.0.lock().map_err(|error| error.to_string())?;
    if let Some(existing) = agents.get(&agent) {
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
    let availability = acp_agents()
        .into_iter()
        .find(|item| item.id == agent)
        .ok_or("Unknown agent.")?;
    if !availability.available {
        return Err(availability
            .reason
            .unwrap_or_else(|| "Agent unavailable.".into()));
    }
    let node = find_executable("node").ok_or("Node.js not found.")?;
    let original_path = std::env::var_os("PATH").unwrap_or_default();
    let mut paths = vec![node.parent().ok_or("Invalid Node.js path.")?.to_path_buf()];
    paths.extend(std::env::split_paths(&original_path));
    #[cfg(feature = "e2e")]
    let test_agent = std::env::var_os("SAIL_ACP_TEST_AGENT");
    let mut command = {
        #[cfg(feature = "e2e")]
        if let Some(path) = test_agent {
            let mut command = Command::new(&node);
            command.arg(path).arg(&agent);
            command
        } else {
            let npx = find_executable("npx").ok_or("npx not found.")?;
            let mut command = Command::new(npx);
            command.args(["--yes", definition.package]);
            command
        }
        #[cfg(not(feature = "e2e"))]
        {
            let npx = find_executable("npx").ok_or("npx not found.")?;
            let mut command = Command::new(npx);
            command.args(["--yes", definition.package]);
            command
        }
    };
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
    if let Some(mut stderr) = child.stderr.take() {
        let stderr_agent = agent.clone();
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            let mut total_bytes = 0u64;
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(bytes) => total_bytes = total_bytes.saturating_add(bytes as u64),
                }
            }
            if total_bytes > 0 {
                crate::diagnostics::record(
                    "agent_stderr",
                    json!({"agent":stderr_agent,"bytes":total_bytes}),
                );
            }
        });
    }
    let runtime = Arc::new(Connection {
        agent: agent.clone(),
        child: Mutex::new(child),
        #[cfg(unix)]
        watchdog: Mutex::new(watchdog),
        stopped: AtomicBool::new(false),
        input: Mutex::new(input),
        pending: Mutex::new(HashMap::new()),
        permissions: Mutex::new(HashMap::new()),
        prompt_state: Mutex::new(PromptState::default()),
        cancelled_prompts: Mutex::new(HashSet::new()),
        next_id: AtomicU64::new(1),
        alive: AtomicBool::new(true),
        capabilities: Mutex::new(Value::Null),
        session_directories: Mutex::new(HashMap::new()),
        pending_directory: Mutex::new(None),
        session_creation: Mutex::new(()),
        ready: Condvar::new(),
    });
    let reader = Arc::clone(&runtime);
    let agent_id = agent.clone();
    std::thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let Ok(line) = line else { break };
            let Ok(message) = serde_json::from_str::<Value>(&line) else {
                crate::diagnostics::record(
                    "acp_invalid_json",
                    json!({"agent":agent_id,"bytes":line.len()}),
                );
                continue;
            };
            if let Some(update) = message.pointer("/params/update") {
                if let Some(session_id) =
                    message.pointer("/params/sessionId").and_then(Value::as_str)
                {
                    if let Ok(mut prompts) = reader.prompt_state.lock() {
                        if let Some(prompt) = prompts.active.get_mut(session_id) {
                            prompt.observe_update(update);
                        }
                    }
                }
                if update.get("sessionUpdate").and_then(Value::as_str) == Some("subagent_spawned") {
                    let parent_id = message.pointer("/params/sessionId").and_then(Value::as_str);
                    let child_id = update.get("subagentSessionId").and_then(Value::as_str);
                    if let (Some(parent_id), Some(child_id)) = (parent_id, child_id) {
                        if parent_id != child_id {
                            if let Ok(mut directories) = reader.session_directories.lock() {
                                if let Some(directory) = directories.get(parent_id).cloned() {
                                    directories.entry(child_id.to_string()).or_insert(directory);
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
                                    &app, &manager, &agent, &method, params, directory,
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
                if message.get("method").and_then(Value::as_str)
                    == Some("session/request_permission")
                {
                    if let Some(id) = message.get("id") {
                        if let Ok(mut permissions) = reader.permissions.lock() {
                            let received_at = std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)
                                .unwrap_or_default()
                                .as_millis() as u64;
                            permissions.insert(
                                id.to_string(),
                                PendingPermission {
                                    message: message.clone(),
                                    received_at,
                                },
                            );
                        }
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
                    let _ = sender.send(message);
                }
            }
        }
        reader.alive.store(false, Ordering::Release);
        crate::diagnostics::record("agent_disconnected", json!({"agent":agent_id}));
        app.state::<crate::acp_terminal::AcpTerminalManager>()
            .stop_agent(&agent_id);
        reader.ready.notify_all();
        if let Ok(mut permissions) = reader.permissions.lock() {
            permissions.clear();
        }
        if let Ok(mut pending) = reader.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(json!({"error":{"message":"Agent process exited."}}));
            }
        }
        let _ = app.emit(
            "acp-event",
            AgentEvent {
                agent: agent_id,
                message: json!({"method":"sail/disconnected"}),
            },
        );
    });
    agents.insert(agent, Arc::clone(&runtime));
    drop(agents);
    let result = runtime
        .request(
            "initialize",
            json!({
                "protocolVersion": 1,
                "clientCapabilities": {
                    "fs":{"readTextFile":false,"writeTextFile":false},
                    "terminal":true,
                    "subagents":{}
                },
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
    let runtime = connection(&manager, &agent)?;
    let permissions = runtime
        .permissions
        .lock()
        .map_err(|error| error.to_string())?;
    Ok(permissions
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
pub async fn acp_new_session(
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    cwd: String,
) -> Result<Value, String> {
    if !PathBuf::from(&cwd).is_dir() {
        return Err("Repository directory does not exist.".into());
    }
    let runtime = connection(&manager, &agent)?;
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = browser.config(&cwd, None, Some(&agent))?;
        let mcp_server = json!({"name":"sail-browser","command":config.command,"args":config.args,
            "env":config.env.iter().map(|(name,value)| json!({"name":name,"value":value})).collect::<Vec<_>>()});
        let _serial = runtime
            .session_creation
            .lock()
            .map_err(|error| error.to_string())?;
        *runtime
            .pending_directory
            .lock()
            .map_err(|error| error.to_string())? = Some(PathBuf::from(&cwd));
        let result = runtime.request(
            "session/new",
            json!({"cwd":cwd,"mcpServers":[mcp_server]}),
            Duration::from_secs(60),
        );
        *runtime
            .pending_directory
            .lock()
            .map_err(|error| error.to_string())? = None;
        let result = result?;
        if let Some(id) = result.get("sessionId").and_then(Value::as_str) {
            browser.identify(&config.token, id);
            runtime
                .session_directories
                .lock()
                .map_err(|error| error.to_string())?
                .insert(id.to_string(), PathBuf::from(cwd));
        }
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acp_load_session(
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    cwd: String,
    session_id: String,
) -> Result<Value, String> {
    restore_session(manager, browser, agent, cwd, session_id, "session/load").await
}

#[tauri::command]
pub async fn acp_resume_session(
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    cwd: String,
    session_id: String,
) -> Result<Value, String> {
    restore_session(manager, browser, agent, cwd, session_id, "session/resume").await
}

async fn restore_session(
    manager: State<'_, AgentManager>,
    browser: State<'_, crate::browser_agent::BrowserManager>,
    agent: String,
    cwd: String,
    session_id: String,
    method: &'static str,
) -> Result<Value, String> {
    let runtime = connection(&manager, &agent)?;
    let browser = browser.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let config = browser.config(&cwd, Some(&session_id), Some(&agent))?;
        let mcp_server = json!({"name":"sail-browser","command":config.command,"args":config.args,
            "env":config.env.iter().map(|(name,value)| json!({"name":name,"value":value})).collect::<Vec<_>>()});
        runtime
            .session_directories
            .lock()
            .map_err(|error| error.to_string())?
            .insert(session_id.clone(), PathBuf::from(&cwd));
        let result = runtime.request(
            method,
            json!({"cwd":cwd,"sessionId":session_id,"mcpServers":[mcp_server]}),
            Duration::from_secs(60),
        );
        if result.is_err() {
            runtime
                .session_directories
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
    let runtime = connection(&manager, &agent)?;
    {
        let mut prompts = runtime
            .prompt_state
            .lock()
            .map_err(|error| error.to_string())?;
        if prompts.active.contains_key(&session_id) {
            return Err("This agent thread already has an active turn.".to_string());
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
    crate::diagnostics::record(
        "prompt_started",
        json!({
            "agent":agent,"sessionId":session_id,"turnId":turn_id
        }),
    );
    tauri::async_runtime::spawn_blocking(move || {
        let mut result = runtime.request(
            "session/prompt",
            json!({
                "sessionId":session_id,"prompt":content
            }),
            Duration::from_secs(60 * 60 * 3),
        );
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
        let interrupted =
            cancelled_result || reported_interruption || (explicitly_cancelled && result.is_err());
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
        crate::diagnostics::record("prompt_finished", json!({
            "agent":agent,"sessionId":session_id,"turnId":turn_id,
            "status":status,"explicitlyCancelled":explicitly_cancelled,
            "reportedInterruption":reported_interruption,
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
                        "error":result.as_ref().err()
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
    let runtime = connection(&manager, &agent)?;
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
    manager: State<'_, AgentManager>,
    agent: String,
    session_id: String,
    turn_id: Option<String>,
) -> Result<(), String> {
    let runtime = connection(&manager, &agent)?;
    let current_turn = runtime
        .prompt_state
        .lock()
        .map_err(|error| error.to_string())?
        .active
        .get(&session_id)
        .map(|prompt| prompt.turn_id.clone());
    let cancelled_turn = turn_id.or(current_turn);
    crate::diagnostics::record(
        "cancel_requested",
        json!({
            "agent":agent,"sessionId":session_id,"turnId":cancelled_turn
        }),
    );
    if let Some(turn_id) = cancelled_turn {
        runtime
            .cancelled_prompts
            .lock()
            .map_err(|error| error.to_string())?
            .insert(turn_id);
    }
    runtime.notify("session/cancel", json!({"sessionId":session_id}))
}

#[tauri::command]
pub fn acp_permission(
    app: AppHandle,
    manager: State<'_, AgentManager>,
    agent: String,
    request_id: Value,
    option_id: Option<String>,
) -> Result<(), String> {
    let outcome = option_id
        .map(|id| json!({"outcome":"selected","optionId":id}))
        .unwrap_or_else(|| json!({"outcome":"cancelled"}));
    let runtime = connection(&manager, &agent)?;
    let session_id = runtime
        .permissions
        .lock()
        .map_err(|error| error.to_string())?
        .get(&request_id.to_string())
        .and_then(|pending| {
            pending
                .message
                .pointer("/params/sessionId")
                .and_then(Value::as_str)
                .map(str::to_string)
        });
    runtime.respond(request_id.clone(), json!({"outcome":outcome}))?;
    if let Some(session_id) = session_id {
        let _ = app.emit(
            "acp-event",
            AgentEvent {
                agent,
                message: json!({"method":"sail/permission_resolved","params":{
                    "sessionId":session_id,"requestId":request_id
                }}),
            },
        );
    }
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
    let runtime = connection(&manager, &agent)?;
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
) -> Result<Value, String> {
    let runtime = connection(&manager, &agent)?;
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
