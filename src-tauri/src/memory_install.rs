use jsonc_parser::cst::{CstInputValue, CstRootNode};
use jsonc_parser::ParseOptions;
use serde::Serialize;
use serde_json::Value;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use tauri::AppHandle;
use toml_edit::{value, Array, DocumentMut, Item, Table};

const SERVER: &str = "sail-shared-memory";
const OWNER: &str = "SAIL_MEMORY_MANAGED";

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Agent {
    Claude,
    Codex,
    OpenCode,
}

impl Agent {
    fn parse(id: &str) -> Result<Self, String> {
        match id {
            "claude" => Ok(Self::Claude),
            "codex" => Ok(Self::Codex),
            "opencode" => Ok(Self::OpenCode),
            _ => Err(format!("Unsupported memory agent: {id}")),
        }
    }

    fn id(self) -> &'static str {
        match self {
            Self::Claude => "claude",
            Self::Codex => "codex",
            Self::OpenCode => "opencode",
        }
    }

    fn name(self) -> &'static str {
        match self {
            Self::Claude => "Claude Code",
            Self::Codex => "Codex",
            Self::OpenCode => "OpenCode",
        }
    }

    fn executable(self) -> &'static str {
        self.id()
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryAgentStatus {
    id: &'static str,
    name: &'static str,
    detected: bool,
    installed: bool,
    healthy: bool,
    detail: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInstallPreview {
    agent: &'static str,
    path: String,
    before: String,
    after: String,
    changed: bool,
}

fn home() -> Result<PathBuf, String> {
    std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("Cannot find the home folder.".into())
}

fn path_for(agent: Agent) -> Result<PathBuf, String> {
    let home = home()?;
    Ok(match agent {
        Agent::Claude => home.join(".claude.json"),
        Agent::Codex => std::env::var_os("CODEX_HOME")
            .map(PathBuf::from)
            .unwrap_or_else(|| home.join(".codex"))
            .join("config.toml"),
        Agent::OpenCode => {
            let directory = std::env::var_os("OPENCODE_CONFIG_DIR")
                .map(PathBuf::from)
                .or_else(|| {
                    std::env::var_os("XDG_CONFIG_HOME").map(|p| PathBuf::from(p).join("opencode"))
                })
                .unwrap_or_else(|| home.join(".config").join("opencode"));
            let json = directory.join("opencode.json");
            let jsonc = directory.join("opencode.jsonc");
            if json.exists() || !jsonc.exists() {
                json
            } else {
                jsonc
            }
        }
    })
}

fn ensure_regular(path: &Path) -> Result<(), String> {
    if let Ok(meta) = fs::symlink_metadata(path) {
        if !meta.file_type().is_file() {
            return Err(format!(
                "Configuration is not a regular file: {}",
                path.display()
            ));
        }
    }
    Ok(())
}

fn read(path: &Path) -> Result<String, String> {
    ensure_regular(path)?;
    match fs::read_to_string(path) {
        Ok(text) => Ok(text),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(String::new()),
        Err(error) => Err(format!("Cannot read {}: {error}", path.display())),
    }
}

fn binary() -> Result<String, String> {
    std::env::current_exe()
        .map_err(|error| format!("Cannot locate Sail executable: {error}"))?
        .to_str()
        .map(str::to_owned)
        .ok_or("Sail executable path is not UTF-8.".into())
}

fn runtime_paths(app: &AppHandle) -> Result<(String, String), String> {
    let (root, settings) = crate::memory::standalone_paths(app)?;
    let root = root.to_str().ok_or("Memory path is not UTF-8.")?.to_owned();
    let settings = settings
        .to_str()
        .ok_or("Settings path is not UTF-8.")?
        .to_owned();
    Ok((root, settings))
}

fn json_owned(entry: &Value) -> bool {
    entry
        .get("env")
        .or_else(|| entry.get("environment"))
        .and_then(|env| env.get(OWNER))
        .and_then(Value::as_str)
        == Some("1")
}

fn json_entry(agent: Agent, binary: &str, paths: (&str, &str)) -> CstInputValue {
    let env = CstInputValue::Object(vec![
        (OWNER.into(), "1".into()),
        ("SAIL_MEMORY_AGENT".into(), agent.id().into()),
        ("SAIL_MEMORY_ROOT".into(), paths.0.into()),
        ("SAIL_SETTINGS_PATH".into(), paths.1.into()),
    ]);
    match agent {
        Agent::Claude => CstInputValue::Object(vec![
            ("type".into(), "stdio".into()),
            ("command".into(), binary.into()),
            (
                "args".into(),
                vec![CstInputValue::from("--memory-mcp")].into(),
            ),
            ("env".into(), env),
        ]),
        Agent::OpenCode => CstInputValue::Object(vec![
            ("type".into(), "local".into()),
            (
                "command".into(),
                vec![
                    CstInputValue::from(binary),
                    CstInputValue::from("--memory-mcp"),
                ]
                .into(),
            ),
            ("environment".into(), env),
        ]),
        Agent::Codex => unreachable!(),
    }
}

fn json_root(text: &str, agent: Agent) -> Result<CstRootNode, String> {
    CstRootNode::parse(
        if text.trim().is_empty() { "{}" } else { text },
        &ParseOptions::default(),
    )
    .map_err(|error| format!("Cannot parse {} config: {error}", agent.name()))
}

fn json_property(agent: Agent, text: &str) -> Result<Option<Value>, String> {
    if text.trim().is_empty() {
        return Ok(None);
    }
    let root = json_root(text, agent)?;
    let object = root
        .object_value()
        .ok_or("Agent configuration must be a JSON object.")?;
    let entry = if agent == Agent::Claude {
        object
            .object_value("mcpServers")
            .and_then(|servers| servers.get(SERVER))
    } else {
        object
            .object_value("mcp")
            .and_then(|mcp| mcp.object_value("servers"))
            .and_then(|servers| servers.get(SERVER))
    };
    Ok(entry.and_then(|entry| entry.to_serde_value()))
}

fn toml_owned(entry: &Item) -> bool {
    entry
        .get("env")
        .and_then(|env| env.get(OWNER))
        .and_then(Item::as_str)
        == Some("1")
}

fn render(
    agent: Agent,
    before: &str,
    binary: &str,
    paths: (&str, &str),
    install: bool,
) -> Result<String, String> {
    if agent == Agent::Codex {
        let mut document: DocumentMut = before
            .parse()
            .map_err(|error| format!("Cannot parse Codex config: {error}"))?;
        if !document.as_table().contains_key("mcp_servers") {
            document["mcp_servers"] = Item::Table(Table::new());
        }
        let servers = document["mcp_servers"]
            .as_table_mut()
            .ok_or("mcp_servers must be a table.")?;
        if let Some(existing) = servers.get(SERVER) {
            if !toml_owned(existing) {
                return Err(format!("Codex already has an unmanaged {SERVER} entry."));
            }
        }
        if install {
            let mut entry = Table::new();
            entry["command"] = value(binary);
            let mut args = Array::new();
            args.push("--memory-mcp");
            entry["args"] = value(args);
            entry["required"] = value(false);
            let mut env = Table::new();
            env[OWNER] = value("1");
            env["SAIL_MEMORY_AGENT"] = value(agent.id());
            env["SAIL_MEMORY_ROOT"] = value(paths.0);
            env["SAIL_SETTINGS_PATH"] = value(paths.1);
            entry["env"] = Item::Table(env);
            servers[SERVER] = Item::Table(entry);
        } else {
            servers.remove(SERVER);
        }
        return Ok(document.to_string());
    }
    let document = json_root(before, agent)?;
    let root = document
        .object_value()
        .ok_or("Agent configuration must be a JSON object.")?;
    let parent = root
        .object_value_or_create(if agent == Agent::Claude {
            "mcpServers"
        } else {
            "mcp"
        })
        .ok_or("Memory server parent must be an object.")?;
    let servers = if agent == Agent::Claude {
        parent
    } else {
        parent
            .object_value_or_create("servers")
            .ok_or("mcp.servers must be an object.")?
    };
    if let Some(existing) = servers.get(SERVER) {
        if !existing.to_serde_value().as_ref().is_some_and(json_owned) {
            return Err(format!(
                "{} already has an unmanaged {SERVER} entry.",
                agent.name()
            ));
        }
    }
    if install {
        if let Some(existing) = servers.get(SERVER) {
            existing.set_value(json_entry(agent, binary, paths));
        } else {
            servers.append(SERVER, json_entry(agent, binary, paths));
        }
    } else if let Some(existing) = servers.get(SERVER) {
        existing.remove();
    }
    let mut result = document.to_string();
    if !result.ends_with('\n') {
        result.push('\n');
    }
    Ok(result)
}

fn installed(agent: Agent, text: &str) -> Result<bool, String> {
    if text.trim().is_empty() {
        return Ok(false);
    }
    if agent == Agent::Codex {
        let document: DocumentMut = text
            .parse()
            .map_err(|error| format!("Cannot parse Codex config: {error}"))?;
        return Ok(document
            .get("mcp_servers")
            .and_then(|item| item.get(SERVER))
            .is_some_and(toml_owned));
    }
    Ok(json_property(agent, text)?.as_ref().is_some_and(json_owned))
}

fn preview_entry(agent: Agent, text: &str) -> Result<String, String> {
    if text.trim().is_empty() {
        return Ok("(absent)".into());
    }
    if agent == Agent::Codex {
        let document: DocumentMut = text
            .parse()
            .map_err(|error| format!("Cannot parse Codex config: {error}"))?;
        return Ok(document
            .get("mcp_servers")
            .and_then(|item| item.get(SERVER))
            .map(ToString::to_string)
            .unwrap_or_else(|| "(absent)".into()));
    }
    json_property(agent, text)?
        .as_ref()
        .map(serde_json::to_string_pretty)
        .transpose()
        .map_err(|error| error.to_string())
        .map(|entry| entry.unwrap_or_else(|| "(absent)".into()))
}

fn detected(agent: Agent) -> bool {
    crate::acp::find_executable(agent.executable()).is_some()
}

fn write_atomic(path: &Path, text: &str) -> Result<(), String> {
    let parent = path.parent().ok_or("Cannot locate configuration folder.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    ensure_regular(path)?;
    let temporary = parent.join(format!(".sail-memory-{}.tmp", uuid::Uuid::new_v4()));
    let result = (|| -> Result<(), String> {
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(text.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        if let Ok(metadata) = fs::metadata(path) {
            fs::set_permissions(&temporary, metadata.permissions())
                .map_err(|error| error.to_string())?;
        }
        #[cfg(windows)]
        {
            let backup = parent.join(format!(".sail-memory-{}.bak", uuid::Uuid::new_v4()));
            if path.exists() {
                fs::rename(path, &backup).map_err(|error| error.to_string())?;
            }
            if let Err(error) = fs::rename(&temporary, path) {
                if backup.exists() {
                    let _ = fs::rename(&backup, path);
                }
                return Err(error.to_string());
            }
            if backup.exists() {
                let _ = fs::remove_file(backup);
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temporary, path).map_err(|error| error.to_string())?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result.map_err(|error| format!("Cannot update {}: {error}", path.display()))
}

fn lock(path: &Path) -> Result<File, String> {
    let parent = path.parent().ok_or("Cannot locate configuration folder.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create {}: {error}", parent.display()))?;
    let lock_path = parent.join(format!(
        ".sail-memory-{}.lock",
        path.file_name().unwrap_or_default().to_string_lossy()
    ));
    let file = OpenOptions::new()
        .create(true)
        .read(true)
        .write(true)
        .truncate(false)
        .open(&lock_path)
        .map_err(|error| format!("Cannot open {}: {error}", lock_path.display()))?;
    file.lock()
        .map_err(|error| format!("Cannot lock {}: {error}", path.display()))?;
    Ok(file)
}

#[tauri::command]
pub fn memory_agent_status(app: AppHandle) -> Vec<MemoryAgentStatus> {
    let runtime = runtime_paths(&app);
    let executable = binary();
    [Agent::Claude, Agent::Codex, Agent::OpenCode]
        .into_iter()
        .map(|agent| {
            let status = (|| -> Result<(bool, bool), String> {
                let path = path_for(agent)?;
                let text = read(&path)?;
                if !installed(agent, &text)? {
                    return Ok((false, false));
                }
                let runtime = runtime.as_ref().map_err(Clone::clone)?;
                let executable = executable.as_ref().map_err(Clone::clone)?;
                let expected = render(agent, &text, executable, (&runtime.0, &runtime.1), true)?;
                Ok((
                    true,
                    preview_entry(agent, &text)? == preview_entry(agent, &expected)?,
                ))
            })();
            let (installed, healthy, detail) = match status {
                Ok((installed, healthy)) => (
                    installed,
                    healthy,
                    if installed && !healthy {
                        Some("Sail memory entry is out of date; reinstall it.".into())
                    } else {
                        None
                    },
                ),
                Err(error) => (false, false, Some(error)),
            };
            MemoryAgentStatus {
                id: agent.id(),
                name: agent.name(),
                detected: detected(agent),
                installed,
                healthy,
                detail,
            }
        })
        .collect()
}

#[tauri::command]
pub fn preview_memory_agent_install(
    app: AppHandle,
    agent: String,
) -> Result<MemoryInstallPreview, String> {
    preview(app, agent, true)
}

#[tauri::command]
pub fn preview_memory_agent_uninstall(
    app: AppHandle,
    agent: String,
) -> Result<MemoryInstallPreview, String> {
    preview(app, agent, false)
}

fn preview(app: AppHandle, agent: String, install: bool) -> Result<MemoryInstallPreview, String> {
    let agent = Agent::parse(&agent)?;
    let path = path_for(agent)?;
    let before = read(&path)?;
    let paths = runtime_paths(&app)?;
    let after = if !install && !installed(agent, &before)? {
        before.clone()
    } else {
        render(agent, &before, &binary()?, (&paths.0, &paths.1), install)?
    };
    Ok(MemoryInstallPreview {
        agent: agent.id(),
        path: path.to_string_lossy().into_owned(),
        changed: before != after,
        before: preview_entry(agent, &before)?,
        after: preview_entry(agent, &after)?,
    })
}

fn change(app: &AppHandle, agent: Agent, install: bool) -> Result<(), String> {
    let path = path_for(agent)?;
    let _guard = lock(&path)?;
    let before = read(&path)?;
    if !install && !installed(agent, &before)? {
        return Ok(());
    }
    let paths = runtime_paths(app)?;
    let after = render(agent, &before, &binary()?, (&paths.0, &paths.1), install)?;
    if before != after {
        write_atomic(&path, &after)?;
    }
    Ok(())
}

#[tauri::command]
pub fn install_memory_agent(app: AppHandle, agent: String) -> Result<(), String> {
    change(&app, Agent::parse(&agent)?, true)
}

#[tauri::command]
pub fn install_memory_agents(app: AppHandle, agents: Vec<String>) -> Result<(), String> {
    let mut selected = agents
        .iter()
        .map(|id| Agent::parse(id))
        .collect::<Result<Vec<_>, _>>()?;
    selected.sort_by_key(|agent| agent.id());
    selected.dedup();
    let paths = selected
        .iter()
        .map(|agent| path_for(*agent))
        .collect::<Result<Vec<_>, _>>()?;
    let mut guards = Vec::with_capacity(paths.len());
    for path in &paths {
        guards.push(lock(path)?);
    }
    let executable = binary()?;
    let runtime = runtime_paths(&app)?;
    let mut changes = Vec::with_capacity(paths.len());
    for (agent, path) in selected.iter().zip(&paths) {
        let before = read(path)?;
        let after = render(*agent, &before, &executable, (&runtime.0, &runtime.1), true)?;
        changes.push((path.clone(), path.exists(), before, after));
    }
    for (applied, (path, _, before, after)) in changes.iter().enumerate() {
        if before != after {
            if let Err(error) = write_atomic(path, after) {
                let mut rollback_errors = Vec::new();
                for (old_path, existed, old_text, _) in changes[..applied].iter().rev() {
                    let result = if *existed {
                        write_atomic(old_path, old_text)
                    } else {
                        fs::remove_file(old_path).map_err(|error| error.to_string())
                    };
                    if let Err(rollback_error) = result {
                        rollback_errors.push(rollback_error);
                    }
                }
                if rollback_errors.is_empty() {
                    return Err(error);
                }
                return Err(format!(
                    "{error}; rollback failed: {}",
                    rollback_errors.join("; ")
                ));
            }
        }
    }
    drop(guards);
    Ok(())
}

#[tauri::command]
pub fn uninstall_memory_agent(app: AppHandle, agent: String) -> Result<(), String> {
    change(&app, Agent::parse(&agent)?, false)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn installs_each_agent_without_losing_unrelated_config() {
        for (agent, before) in [
            (
                Agent::Claude,
                r#"{"theme":"dark","mcpServers":{"other":{"command":"other"}}}"#,
            ),
            (
                Agent::OpenCode,
                r#"{"model":"fast","mcp":{"servers":{"other":{"type":"local","command":["other"]}}}}"#,
            ),
            (
                Agent::Codex,
                "model = 'fast'\n[mcp_servers.other]\ncommand = 'other'\n",
            ),
        ] {
            let after = render(
                agent,
                before,
                "/opt/sail",
                ("/data/memory", "/config/settings.json"),
                true,
            )
            .unwrap();
            assert!(installed(agent, &after).unwrap());
            assert!(after.contains("other"));
            assert_eq!(
                render(
                    agent,
                    &after,
                    "/opt/sail",
                    ("/data/memory", "/config/settings.json"),
                    true
                )
                .unwrap(),
                after
            );
            let removed = render(
                agent,
                &after,
                "/opt/sail",
                ("/data/memory", "/config/settings.json"),
                false,
            )
            .unwrap();
            assert!(!installed(agent, &removed).unwrap());
            assert!(removed.contains("other"));
        }
    }

    #[test]
    fn refuses_to_replace_an_unmanaged_entry() {
        let before = r#"{"mcpServers":{"sail-shared-memory":{"command":"custom"}}}"#;
        assert!(render(
            Agent::Claude,
            before,
            "/opt/sail",
            ("/data/memory", "/config/settings.json"),
            true
        )
        .is_err());
        assert!(render(
            Agent::Claude,
            before,
            "/opt/sail",
            ("/data/memory", "/config/settings.json"),
            false
        )
        .is_err());
    }

    #[test]
    fn preserves_opencode_jsonc_comments() {
        let before = "{\n  // keep this explanation\n  \"model\": \"fast\",\n  \"mcp\": {\n    \"servers\": {},\n  },\n}\n";
        let after = render(
            Agent::OpenCode,
            before,
            "/opt/sail",
            ("/data/memory", "/config/settings.json"),
            true,
        )
        .unwrap();
        assert!(after.contains("// keep this explanation"));
        assert!(after.contains("\"model\": \"fast\""));
        assert!(installed(Agent::OpenCode, &after).unwrap());
    }
}
