use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::{ErrorKind, Read, Write};
use std::net::{Ipv4Addr, SocketAddrV4, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};

const MAX_EVENT_BYTES: u64 = 64 * 1024;
const MARKER: &str = "SAIL_HOOK_INTEGRATION=1";
const EVENTS: &[&str] = &[
    "PreToolUse",
    "PostToolUse",
    "PostToolUseFailure",
    "Stop",
    "SubagentStart",
    "SubagentStop",
];

#[derive(Clone, Default)]
pub struct HookActivityManager(Arc<Mutex<HookState>>);

#[derive(Default)]
struct HookState {
    bridge: Option<Bridge>,
    activities: Vec<HookActivity>,
}

struct Bridge {
    connection_file: PathBuf,
    last_error: Option<String>,
}

#[derive(Deserialize)]
struct Delivery {
    token: String,
    event: Value,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookActivity {
    id: String,
    provider: &'static str,
    session_id: String,
    event: String,
    source: &'static str,
    outcome: &'static str,
    action: Option<String>,
    reason: Option<String>,
    actor: Option<String>,
    created: u64,
    diagnostics: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookIntegrationPreview {
    provider: &'static str,
    scope: &'static str,
    file: String,
    commands: Vec<String>,
    events: Vec<&'static str>,
    trust_impact: &'static str,
    state: &'static str,
    detail: String,
    enabled: bool,
}

fn connection_override() -> Option<PathBuf> {
    std::env::var_os("SAIL_HOOK_CONNECTION_FILE").map(PathBuf::from)
}

fn connection_root() -> PathBuf {
    std::env::temp_dir().join("sail-hook-bridges")
}

fn read_connection(path: &Path) -> Option<(u16, String)> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut bytes = Vec::new();
    options
        .open(path)
        .ok()?
        .take(4097)
        .read_to_end(&mut bytes)
        .ok()?;
    if bytes.len() > 4096 {
        return None;
    }
    let connection: Value = serde_json::from_slice(&bytes).ok()?;
    let port = u16::try_from(connection.get("port")?.as_u64()?).ok()?;
    let token = connection.get("token")?.as_str()?;
    if port == 0 || token.is_empty() || token.len() > 256 {
        return None;
    }
    Some((port, token.to_string()))
}

fn integration_path(worktree: &Path) -> PathBuf {
    worktree.join(".claude/settings.local.json")
}

fn validate_integration_path(root: &Path) -> Result<PathBuf, String> {
    let directory = root.join(".claude");
    if let Ok(metadata) = fs::symlink_metadata(&directory) {
        if metadata.file_type().is_symlink() {
            return Err("The project .claude directory cannot be a symbolic link.".into());
        }
        let canonical = directory
            .canonicalize()
            .map_err(|error| format!("Cannot inspect the project .claude directory: {error}"))?;
        if !canonical.starts_with(root) || !canonical.is_dir() {
            return Err("The project .claude path is not a local directory.".into());
        }
    }
    let path = integration_path(root);
    if fs::symlink_metadata(&path).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
        return Err("The project hook configuration cannot be a symbolic link.".into());
    }
    Ok(path)
}

fn integration_command(executable: &Path) -> String {
    format!(
        "{MARKER} {} --hook-deliver",
        shell_words::quote(&executable.to_string_lossy())
    )
}

fn integration_executable() -> PathBuf {
    std::env::var_os("APPIMAGE")
        .filter(|path| !path.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| std::env::current_exe().unwrap_or_else(|_| PathBuf::from("Sail")))
}

fn is_sail_handler(value: &Value) -> bool {
    value
        .get("command")
        .and_then(Value::as_str)
        .is_some_and(|command| command.starts_with(MARKER) && command.ends_with(" --hook-deliver"))
}

fn read_config(path: &Path) -> Result<Value, String> {
    match fs::read(path) {
        Ok(bytes) if bytes.len() > 1024 * 1024 => Err("Hook configuration exceeds 1 MiB.".into()),
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Hook configuration is invalid JSON: {error}")),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(error) => Err(format!("Cannot read hook configuration: {error}")),
    }
}

fn has_integration(value: &Value) -> bool {
    value
        .get("hooks")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|hooks| hooks.values())
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|group| group.get("hooks").and_then(Value::as_array))
        .flatten()
        .any(is_sail_handler)
}

fn installed_commands(value: &Value) -> Vec<String> {
    let mut commands: Vec<String> = value
        .get("hooks")
        .and_then(Value::as_object)
        .into_iter()
        .flat_map(|hooks| hooks.values())
        .filter_map(Value::as_array)
        .flatten()
        .filter_map(|group| group.get("hooks").and_then(Value::as_array))
        .flatten()
        .filter(|handler| is_sail_handler(handler))
        .filter_map(|handler| handler.get("command").and_then(Value::as_str))
        .map(str::to_string)
        .collect();
    commands.sort();
    commands.dedup();
    commands
}

fn integration_complete(value: &Value, expected: &str) -> bool {
    let Some(hooks) = value.get("hooks").and_then(Value::as_object) else {
        return false;
    };
    let event_handlers = |event: &str| {
        hooks
            .get(event)
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|group| group.get("hooks").and_then(Value::as_array))
            .flatten()
            .filter(|handler| handler.get("command").and_then(Value::as_str) == Some(expected))
            .count()
    };
    EVENTS.iter().all(|event| event_handlers(event) == 1)
        && hooks
            .keys()
            .map(|event| event_handlers(event))
            .sum::<usize>()
            == EVENTS.len()
        && installed_commands(value) == [expected.to_string()]
}

fn remove_handlers(value: &mut Value) {
    let Some(hooks) = value.get_mut("hooks").and_then(Value::as_object_mut) else {
        return;
    };
    hooks.retain(|_, groups| {
        let Some(groups) = groups.as_array_mut() else {
            return true;
        };
        groups.retain_mut(|group| {
            let Some(handlers) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                return true;
            };
            handlers.retain(|handler| !is_sail_handler(handler));
            !handlers.is_empty()
        });
        !groups.is_empty()
    });
}

fn write_config(path: &Path, value: &Value) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Hook configuration has no parent directory.")?;
    fs::create_dir_all(parent).map_err(|error| format!("Cannot create hook directory: {error}"))?;
    let temporary = parent.join(format!(".settings.local.{}.tmp", uuid::Uuid::new_v4()));
    let mut bytes = serde_json::to_vec_pretty(value).map_err(|error| error.to_string())?;
    bytes.push(b'\n');
    let existing_permissions = fs::metadata(path)
        .ok()
        .map(|metadata| metadata.permissions());
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Cannot write hook configuration: {error}"))?;
    file.write_all(&bytes)
        .map_err(|error| format!("Cannot write hook configuration: {error}"))?;
    if let Some(permissions) = existing_permissions {
        file.set_permissions(permissions)
            .map_err(|error| format!("Cannot preserve hook configuration permissions: {error}"))?;
    }
    fs::rename(&temporary, path).map_err(|error| {
        let _ = fs::remove_file(&temporary);
        format!("Cannot replace hook configuration: {error}")
    })
}

fn canonical_worktree(worktree: &str) -> Result<PathBuf, String> {
    let root = Path::new(worktree)
        .canonicalize()
        .map_err(|_| "Worktree does not exist.".to_string())?;
    if !root.is_dir() {
        return Err("Worktree is not a directory.".into());
    }
    Ok(root)
}

fn bridge_state(manager: &HookActivityManager) -> (bool, Option<String>) {
    manager
        .0
        .lock()
        .map(|state| {
            state
                .bridge
                .as_ref()
                .map(|bridge| (true, bridge.last_error.clone()))
                .unwrap_or((false, None))
        })
        .unwrap_or((false, Some("Hook receiver state is unavailable.".into())))
}

fn preview(root: &Path, manager: &HookActivityManager) -> HookIntegrationPreview {
    let file = integration_path(root);
    let expected = integration_command(&integration_executable());
    match validate_integration_path(root).and_then(|path| read_config(&path)) {
        Ok(value) => {
            let enabled = has_integration(&value);
            let commands = installed_commands(&value);
            let complete = integration_complete(&value, &expected);
            let (active, delivery_error) = bridge_state(manager);
            HookIntegrationPreview {
                provider: "Claude",
                scope: "This worktree",
                file: file.display().to_string(),
                commands: if commands.is_empty() { vec![expected] } else { commands },
                events: EVENTS.to_vec(),
                trust_impact: "Claude will run the Sail executable for these project hook events. Review and trust the project in Claude before use.",
                state: if (enabled && !complete) || delivery_error.is_some() { "failing" } else if enabled && active { "enabled" } else if enabled { "disconnected" } else { "trust-required" },
                detail: if enabled && !complete { "Installed handlers are stale, partial, or inconsistent. Remove them before enabling again.".into() } else if let Some(error) = delivery_error { format!("Last delivery failed: {error}") } else if enabled && active { "Connected to this Sail process.".into() } else if enabled { "Configured, but no Sail hook receiver is available.".into() } else { "Not enabled. Claude will request project trust before running project hooks.".into() },
                enabled,
            }
        }
        Err(error) => HookIntegrationPreview {
            provider: "Claude",
            scope: "This worktree",
            file: file.display().to_string(),
            commands: vec![expected],
            events: EVENTS.to_vec(),
            trust_impact: "Configuration must be repaired before Sail can safely edit it.",
            state: "failing",
            detail: error,
            enabled: false,
        },
    }
}

#[tauri::command]
pub fn inspect_hook_integration(
    worktree: String,
    manager: State<'_, HookActivityManager>,
) -> Result<HookIntegrationPreview, String> {
    Ok(preview(&canonical_worktree(&worktree)?, &manager))
}

#[tauri::command]
pub fn enable_hook_integration(
    worktree: String,
    manager: State<'_, HookActivityManager>,
) -> Result<HookIntegrationPreview, String> {
    let root = canonical_worktree(&worktree)?;
    let path = validate_integration_path(&root)?;
    let mut value = read_config(&path)?;
    if !value.is_object() {
        return Err("Hook configuration root must be an object.".into());
    }
    remove_handlers(&mut value);
    let hooks = value
        .as_object_mut()
        .unwrap()
        .entry("hooks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .ok_or("The hooks setting must be an object.")?;
    let command = integration_command(&integration_executable());
    for event in EVENTS {
        let groups = hooks
            .entry((*event).to_string())
            .or_insert_with(|| json!([]));
        let groups = groups
            .as_array_mut()
            .ok_or_else(|| format!("The {event} hook setting must be an array."))?;
        groups.push(json!({"hooks":[{"type":"command","command":command,"timeout":5}]}));
    }
    write_config(&path, &value)?;
    Ok(preview(&root, &manager))
}

#[tauri::command]
pub fn remove_hook_integration(
    worktree: String,
    manager: State<'_, HookActivityManager>,
) -> Result<HookIntegrationPreview, String> {
    let root = canonical_worktree(&worktree)?;
    let path = validate_integration_path(&root)?;
    let mut value = read_config(&path)?;
    remove_handlers(&mut value);
    write_config(&path, &value)?;
    Ok(preview(&root, &manager))
}

#[tauri::command]
pub fn list_hook_activity(
    session_id: String,
    manager: State<'_, HookActivityManager>,
) -> Result<Vec<HookActivity>, String> {
    if session_id.is_empty() || session_id.len() > 256 {
        return Err("A valid session ID is required.".into());
    }
    Ok(manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .activities
        .iter()
        .filter(|activity| activity.session_id == session_id)
        .cloned()
        .collect())
}

fn string(event: &Value, names: &[&str], limit: usize) -> Option<String> {
    names.iter().find_map(|name| {
        event
            .get(name)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .map(|value| value.chars().take(limit).collect())
    })
}

fn activity(event: Value) -> Result<HookActivity, String> {
    let session_id =
        string(&event, &["session_id", "sessionId"], 256).ok_or("Hook event has no session ID.")?;
    let name = string(&event, &["hook_event_name", "hookEventName"], 80)
        .ok_or("Hook event has no event name.")?;
    if !EVENTS.contains(&name.as_str()) {
        return Err("Unsupported hook event.".into());
    }
    let outcome = match name.as_str() {
        "Stop" | "SubagentStop" => "completed",
        _ => "observed",
    };
    Ok(HookActivity {
        id: uuid::Uuid::new_v4().to_string(),
        provider: "Claude",
        session_id,
        event: name,
        source: "Sail-managed project hook",
        outcome,
        action: string(&event, &["tool_name", "toolName"], 120),
        reason: None,
        actor: string(
            &event,
            &["agent_id", "agentId", "agent_type", "agentType"],
            120,
        ),
        created: std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64,
        diagnostics: event,
    })
}

fn parse_delivery(expected_token: &str, line: &[u8]) -> Result<HookActivity, String> {
    if line.len() > MAX_EVENT_BYTES as usize {
        return Err("Hook event is too large.".into());
    }
    let delivery: Delivery =
        serde_json::from_slice(line).map_err(|_| "Malformed hook delivery.".to_string())?;
    if delivery.token.as_bytes() != expected_token.as_bytes() {
        return Err("Hook delivery authentication failed.".into());
    }
    activity(delivery.event)
}

fn handle_stream(
    app: &AppHandle,
    manager: &HookActivityManager,
    token: &str,
    mut stream: TcpStream,
) {
    let _ = stream.set_read_timeout(Some(Duration::from_millis(100)));
    let mut bytes = Vec::new();
    let deadline = Instant::now() + Duration::from_secs(2);
    let result = loop {
        if Instant::now() >= deadline {
            break Err("Hook delivery timed out.".into());
        }
        let mut chunk = [0_u8; 4096];
        match stream.read(&mut chunk) {
            Ok(0) => break parse_delivery(token, &bytes),
            Ok(count) => {
                bytes.extend_from_slice(&chunk[..count]);
                if bytes.len() > MAX_EVENT_BYTES as usize {
                    break Err("Hook event is too large.".into());
                }
            }
            Err(error) if matches!(error.kind(), ErrorKind::TimedOut | ErrorKind::WouldBlock) => {}
            Err(error) if error.kind() == ErrorKind::Interrupted => {}
            Err(error) => break Err(error.to_string()),
        }
    };
    if let Ok(mut state) = manager.0.lock() {
        if let Some(bridge) = state.bridge.as_mut() {
            bridge.last_error = result.as_ref().err().cloned();
        }
        if let Ok(activity) = &result {
            state.activities.push(activity.clone());
            if state.activities.len() > 500 {
                state.activities.remove(0);
            }
        }
    }
    if let Ok(activity) = &result {
        let _ = app.emit("sail:hook-activity", activity.clone());
    }
    let _ = stream.write_all(if result.is_ok() {
        b"ok\n"
    } else {
        b"rejected\n"
    });
}

pub fn start_bridge(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let token = uuid::Uuid::new_v4().to_string();
    let (connection_file, exclusive) = if let Some(path) = connection_override() {
        (path, false)
    } else {
        let root = connection_root();
        if fs::symlink_metadata(&root).is_ok_and(|metadata| metadata.file_type().is_symlink()) {
            return Err("Hook bridge directory cannot be a symbolic link.".into());
        }
        fs::create_dir_all(&root)?;
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&root, fs::Permissions::from_mode(0o700))?;
        }
        (
            root.join(format!(
                "{}-{}.json",
                std::process::id(),
                uuid::Uuid::new_v4()
            )),
            true,
        )
    };
    let mut options = OpenOptions::new();
    options.write(true);
    if exclusive {
        options.create_new(true);
    } else {
        options.create(true).truncate(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut file = options.open(&connection_file)?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        file.set_permissions(fs::Permissions::from_mode(0o600))?;
    }
    file.write_all(&serde_json::to_vec(
        &json!({"port":listener.local_addr()?.port(),"token":token}),
    )?)?;
    let manager = app.state::<HookActivityManager>().inner().clone();
    manager.0.lock().map_err(|error| error.to_string())?.bridge = Some(Bridge {
        connection_file,
        last_error: None,
    });
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            handle_stream(&app, &manager, &token, stream);
        }
    });
    Ok(())
}

pub fn deliver_from_stdin() {
    let mut input = Vec::new();
    if std::io::stdin()
        .take(MAX_EVENT_BYTES + 1)
        .read_to_end(&mut input)
        .is_err()
        || input.len() > MAX_EVENT_BYTES as usize
    {
        return;
    }
    let Ok(event): Result<Value, _> = serde_json::from_slice(&input) else {
        return;
    };
    let Some(path) = connection_override() else {
        return;
    };
    let Some((port, token)) = read_connection(&path) else {
        return;
    };
    let address = SocketAddrV4::new(Ipv4Addr::LOCALHOST, port);
    let Ok(mut stream) = TcpStream::connect_timeout(&address.into(), Duration::from_millis(300))
    else {
        return;
    };
    let _ = stream.set_write_timeout(Some(Duration::from_millis(300)));
    let _ = serde_json::to_writer(&mut stream, &json!({"token":token,"event":event}));
}

pub fn connection_file(manager: &HookActivityManager) -> Option<PathBuf> {
    manager
        .0
        .lock()
        .ok()?
        .bridge
        .as_ref()
        .map(|bridge| bridge.connection_file.clone())
}

pub fn cleanup(manager: &HookActivityManager) {
    if let Ok(mut state) = manager.0.lock() {
        if let Some(bridge) = state.bridge.take() {
            let _ = fs::remove_file(bridge.connection_file);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn root() -> PathBuf {
        let path =
            std::env::temp_dir().join(format!("sail-hook-activity-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn managed_handlers_preserve_unrelated_configuration() {
        let root = root();
        let path = integration_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        let mut value = json!({"permissions":{"allow":["Bash"]},"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"check"}]}]}});
        let command = integration_command(Path::new("/Applications/Sail App"));
        value["hooks"]["PreToolUse"]
            .as_array_mut()
            .unwrap()
            .push(json!({"hooks":[{"type":"command","command":command}]}));
        write_config(&path, &value).unwrap();
        let mut saved = read_config(&path).unwrap();
        assert!(has_integration(&saved));
        remove_handlers(&mut saved);
        assert!(!has_integration(&saved));
        assert_eq!(saved["permissions"]["allow"][0], "Bash");
        assert_eq!(
            saved["hooks"]["PreToolUse"][0]["hooks"][0]["command"],
            "check"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn integration_requires_one_current_handler_per_event() {
        let command = integration_command(Path::new("/Applications/Sail"));
        let mut value = json!({"hooks":{}});
        for event in EVENTS {
            value["hooks"][event] = json!([{"hooks":[{"type":"command","command":command}]}]);
        }
        assert!(integration_complete(&value, &command));
        value["hooks"]["Stop"] = json!([]);
        assert!(!integration_complete(&value, &command));
    }

    #[test]
    fn public_activity_omits_sensitive_fields() {
        let item = activity(json!({
            "session_id":"parent",
            "hook_event_name":"PreToolUse",
            "tool_name":"Bash",
            "tool_input":{"command":"secret"},
            "prompt":"private",
            "permission_decision":"deny",
            "permission_decision_reason":"Policy denied it"
        }))
        .unwrap();
        let public = serde_json::to_value(&item).unwrap();
        assert_eq!(public["sessionId"], "parent");
        assert_eq!(public["outcome"], "observed");
        assert_eq!(public["action"], "Bash");
        assert!(public["reason"].is_null());
        assert!(public.get("toolInput").is_none());
        assert_eq!(public["diagnostics"]["tool_input"]["command"], "secret");
    }

    #[test]
    fn malformed_and_unsupported_events_are_rejected() {
        assert!(activity(json!({"hook_event_name":"Stop"})).is_err());
        assert!(activity(json!({"session_id":"s","hook_event_name":"Unknown"})).is_err());
    }

    #[test]
    fn delivery_requires_the_token_and_enforces_the_size_limit() {
        let event = json!({"session_id":"s","hook_event_name":"Stop"});
        let valid = serde_json::to_vec(&json!({"token":"secret","event":event})).unwrap();
        assert!(parse_delivery("secret", &valid).is_ok());
        assert!(parse_delivery("wrong", &valid).is_err());
        assert!(parse_delivery("secret", b"not json").is_err());
        assert!(parse_delivery("secret", &vec![b'x'; MAX_EVENT_BYTES as usize + 1]).is_err());
    }

    #[test]
    fn malformed_connection_metadata_is_ignored() {
        let root = root();
        let path = root.join("connection.json");
        fs::write(&path, br#"{"port":65536,"token":"secret"}"#).unwrap();
        assert!(read_connection(&path).is_none());
        fs::write(&path, br#"{"port":1234,"token":""}"#).unwrap();
        assert!(read_connection(&path).is_none());
        fs::write(&path, br#"{"port":1234,"token":"secret"}"#).unwrap();
        assert_eq!(read_connection(&path), Some((1234, "secret".into())));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn integration_rejects_symlinked_configuration_paths() {
        use std::os::unix::fs::symlink;

        let root = root();
        let outside = root.with_extension("outside");
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, root.join(".claude")).unwrap();
        assert!(validate_integration_path(&root).is_err());
        fs::remove_dir_all(root).unwrap();
        fs::remove_dir_all(outside).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn integration_preserves_existing_permissions() {
        use std::os::unix::fs::PermissionsExt;

        let root = root();
        let path = integration_path(&root);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, b"{}\n").unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        write_config(&path, &json!({"hooks":{}})).unwrap();
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        fs::remove_dir_all(root).unwrap();
    }
}
