use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::{Deserialize, Serialize};
use std::collections::{HashMap, VecDeque};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::ipc::Channel;
use tauri::{AppHandle, Emitter, State};
use uuid::Uuid;

const MAX_OUTPUT: usize = 4 * 1024 * 1024;

#[derive(Deserialize)]
pub struct TerminalSize {
    cols: u16,
    rows: u16,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalOpenParams {
    id: String,
    directory: String,
    command: Option<String>,
    size: TerminalSize,
    attachment: String,
}

#[derive(Clone, Serialize)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum TerminalEvent {
    Output { data: Vec<u8> },
    Exit { code: u32 },
}

#[derive(Clone, Serialize)]
struct TerminalExitNotice {
    id: String,
    code: u32,
}

struct TerminalOutput {
    history: VecDeque<u8>,
    start: u64,
    #[cfg(windows)]
    current_directory: PathBuf,
    #[cfg(windows)]
    osc_tail: Vec<u8>,
    exit_code: Option<u32>,
    subscriber: Option<(String, Channel<TerminalEvent>)>,
}

struct TerminalSession {
    inspect_id: String,
    owner: Option<String>,
    directory: PathBuf,
    process_id: Option<u32>,
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    write_busy: AtomicBool,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    #[cfg(unix)]
    watchdog: Mutex<Option<crate::child_watchdog::ChildWatchdog>>,
    output: Arc<Mutex<TerminalOutput>>,
    changed: Arc<Condvar>,
}

impl TerminalSession {
    fn stop(&self) {
        if self.owner.is_none()
            && self
                .output
                .lock()
                .is_ok_and(|output| output.exit_code.is_some())
        {
            return;
        }
        #[cfg(unix)]
        {
            if self.owner.is_some() {
                if let Ok(mut watchdog) = self.watchdog.lock() {
                    if let Some(mut watchdog) = watchdog.take() {
                        watchdog.kill_group();
                    }
                }
            } else if let Ok(master) = self.master.lock() {
                if let Some(group) = master.process_group_leader() {
                    let group = nix::unistd::Pid::from_raw(group);
                    if group.as_raw() > 0 && group != nix::unistd::getpgrp() {
                        let _ = nix::sys::signal::killpg(group, nix::sys::signal::Signal::SIGTERM);
                    }
                }
            }
        }
        if let Ok(mut killer) = self.killer.lock() {
            let _ = killer.kill();
        }
    }
}

fn default_editor() -> String {
    #[cfg(target_os = "macos")]
    {
        for candidate in [
            "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code",
            "/Applications/Zed.app/Contents/MacOS/cli",
        ] {
            if Path::new(candidate).is_file() {
                return shell_words::quote(candidate).into_owned();
            }
        }
    }
    "code".to_string()
}

#[cfg(test)]
mod tests {
    use super::{canonical_terminal_paths, default_editor, output_page, TerminalOutput};
    use std::collections::VecDeque;
    use std::path::Path;

    #[test]
    fn default_editor_path_survives_argument_parsing() {
        let editor = default_editor();
        let parts = shell_words::split(&editor).expect("valid default editor");
        assert_eq!(parts.len(), 1);
    }

    #[test]
    fn inspected_output_pages_and_marks_lost_history() {
        let output = TerminalOutput {
            history: VecDeque::from(b"abcdef".to_vec()),
            start: 3,
            #[cfg(windows)]
            current_directory: Path::new("/repo").to_path_buf(),
            #[cfg(windows)]
            osc_tail: Vec::new(),
            exit_code: Some(0),
            subscriber: None,
        };
        let first = output_page("one", Path::new("/repo"), &output, 0, 2, false);
        assert_eq!(first.output, "ab");
        assert_eq!(first.cursor, 5);
        assert!(first.truncated);
        assert_eq!(first.exit_code, Some(0));
        let second = output_page("one", Path::new("/repo"), &output, first.cursor, 2, false);
        assert_eq!(second.output, "cd");
        assert_eq!(second.cursor, 7);
        assert!(!second.truncated);
        let stale = output_page("one", Path::new("/repo"), &output, 99, 2, false);
        assert!(stale.reset);
        assert_eq!(stale.output, "ab");
    }

    #[test]
    fn terminal_allowlist_resolves_path_aliases() {
        let root = std::env::temp_dir();
        let alias = format!("{}/.", root.display());
        assert_eq!(
            canonical_terminal_paths(&[alias]),
            vec![root.canonicalize().unwrap()]
        );
    }
}

fn editor_program(program: &str) -> PathBuf {
    #[cfg(target_os = "macos")]
    if !Path::new(program).is_absolute() {
        let candidate = match program {
            "code" => Some("/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"),
            "zed" => Some("/Applications/Zed.app/Contents/MacOS/cli"),
            _ => None,
        };
        if let Some(candidate) = candidate.filter(|path| Path::new(path).is_file()) {
            return PathBuf::from(candidate);
        }
    }
    PathBuf::from(program)
}

#[derive(Default)]
pub struct TerminalManager(Mutex<HashMap<String, Arc<TerminalSession>>>);

impl Drop for TerminalManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl TerminalManager {
    pub fn stop_owner(&self, owner: &str) {
        let sessions = self
            .0
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter(|session| session.owner.as_deref() == Some(owner))
                    .cloned()
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in sessions {
            session.stop();
        }
    }

    pub fn shutdown(&self) {
        let sessions = self
            .0
            .lock()
            .ok()
            .map(|mut sessions| {
                sessions
                    .drain()
                    .map(|(_, session)| session)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for session in sessions {
            session.stop();
        }
    }

    pub fn server_roots(&self) -> Vec<(PathBuf, u32)> {
        self.0
            .lock()
            .ok()
            .map(|sessions| {
                sessions
                    .values()
                    .filter_map(|session| {
                        if session.output.lock().ok()?.exit_code.is_some() {
                            return None;
                        }
                        Some((session.directory.clone(), session.process_id?))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    fn inspect(&self, id: &str, allowed: &[PathBuf]) -> Result<Arc<TerminalSession>, String> {
        let session = self
            .0
            .lock()
            .map_err(|error| error.to_string())?
            .values()
            .find(|session| session.inspect_id == id)
            .cloned()
            .ok_or("Unknown terminal ID.")?;
        if !allowed.contains(&session.directory) {
            return Err("Unknown terminal ID.".to_string());
        }
        Ok(session)
    }
}

pub(crate) fn canonical_terminal_paths(allowed: &[String]) -> Vec<PathBuf> {
    allowed
        .iter()
        .filter_map(|path| Path::new(path).canonicalize().ok())
        .collect()
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedTerminal {
    terminal_id: String,
    pane_id: String,
    worktree: String,
    state: &'static str,
    exit_code: Option<u32>,
    cursor: u64,
    base_cursor: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedOutput {
    terminal_id: String,
    worktree: String,
    state: &'static str,
    exit_code: Option<u32>,
    output: String,
    output_base64: String,
    cursor: u64,
    base_cursor: u64,
    truncated: bool,
    reset: bool,
    timed_out: bool,
}

fn output_page(
    id: &str,
    directory: &Path,
    output: &TerminalOutput,
    cursor: u64,
    max_bytes: usize,
    timed_out: bool,
) -> InspectedOutput {
    let end = output.start + output.history.len() as u64;
    let truncated = cursor < output.start;
    let reset = cursor > end;
    let offset = if truncated || reset {
        0
    } else {
        (cursor - output.start) as usize
    };
    let bytes: Vec<_> = output
        .history
        .iter()
        .skip(offset)
        .take(max_bytes)
        .copied()
        .collect();
    InspectedOutput {
        terminal_id: format!("shell:{id}"),
        worktree: directory.to_string_lossy().into_owned(),
        state: if output.exit_code.is_some() {
            "exited"
        } else {
            "running"
        },
        exit_code: output.exit_code,
        output: String::from_utf8_lossy(&bytes).into_owned(),
        output_base64: base64::engine::general_purpose::STANDARD.encode(&bytes),
        cursor: output.start + offset as u64 + bytes.len() as u64,
        base_cursor: output.start,
        truncated,
        reset,
        timed_out,
    }
}

#[tauri::command]
pub fn terminal_inspect_list(
    manager: State<'_, TerminalManager>,
    allowed: Vec<String>,
) -> Result<Vec<InspectedTerminal>, String> {
    let allowed = canonical_terminal_paths(&allowed);
    let sessions = manager.0.lock().map_err(|error| error.to_string())?;
    sessions
        .iter()
        .filter(|(_, session)| allowed.contains(&session.directory))
        .map(|(id, session)| {
            let output = session.output.lock().map_err(|error| error.to_string())?;
            Ok(InspectedTerminal {
                terminal_id: format!("shell:{}", session.inspect_id),
                pane_id: id.clone(),
                worktree: session.directory.to_string_lossy().into_owned(),
                state: if output.exit_code.is_some() {
                    "exited"
                } else {
                    "running"
                },
                exit_code: output.exit_code,
                cursor: output.start + output.history.len() as u64,
                base_cursor: output.start,
            })
        })
        .collect()
}

#[tauri::command]
pub fn terminal_inspect_read(
    manager: State<'_, TerminalManager>,
    id: String,
    allowed: Vec<String>,
    cursor: u64,
    max_bytes: usize,
) -> Result<InspectedOutput, String> {
    let id = id.strip_prefix("shell:").ok_or("Unknown terminal ID.")?;
    let allowed = canonical_terminal_paths(&allowed);
    let session = manager.inspect(id, &allowed)?;
    let output = session.output.lock().map_err(|error| error.to_string())?;
    Ok(output_page(
        id,
        &session.directory,
        &output,
        cursor,
        max_bytes.clamp(1, 65_536),
        false,
    ))
}

fn wait_for_terminal(
    session: Arc<TerminalSession>,
    id: String,
    cursor: u64,
    max_bytes: usize,
    timeout_ms: u64,
) -> Result<InspectedOutput, String> {
    let output = session.output.lock().map_err(|error| error.to_string())?;
    let end = output.start + output.history.len() as u64;
    let (output, timed_out) = if cursor >= output.start
        && cursor == end
        && output.exit_code.is_none()
        && timeout_ms > 0
    {
        let (state, result) = session
            .changed
            .wait_timeout_while(
                output,
                Duration::from_millis(timeout_ms.min(30_000)),
                |state| {
                    state.start + state.history.len() as u64 == cursor && state.exit_code.is_none()
                },
            )
            .map_err(|error| error.to_string())?;
        (state, result.timed_out())
    } else {
        let timed_out = cursor == end && timeout_ms == 0 && output.exit_code.is_none();
        (output, timed_out)
    };
    Ok(output_page(
        &id,
        &session.directory,
        &output,
        cursor,
        max_bytes.clamp(1, 65_536),
        timed_out,
    ))
}

#[tauri::command]
pub async fn terminal_inspect_wait(
    manager: State<'_, TerminalManager>,
    id: String,
    allowed: Vec<String>,
    cursor: u64,
    max_bytes: usize,
    timeout_ms: u64,
) -> Result<InspectedOutput, String> {
    let id = id
        .strip_prefix("shell:")
        .ok_or("Unknown terminal ID.")?
        .to_string();
    let allowed = canonical_terminal_paths(&allowed);
    let session = manager.inspect(&id, &allowed)?;
    tauri::async_runtime::spawn_blocking(move || {
        wait_for_terminal(session, id, cursor, max_bytes, timeout_ms)
    })
    .await
    .map_err(|error| error.to_string())?
}

pub(crate) fn shell() -> PathBuf {
    #[cfg(windows)]
    return std::env::var_os("COMSPEC")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("cmd.exe"));
    #[cfg(not(windows))]
    return std::env::var_os("SHELL")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from("/bin/sh"));
}

fn spawn(
    directory: PathBuf,
    cols: u16,
    rows: u16,
    script: Option<&str>,
    id: String,
    app: AppHandle,
    owner: Option<String>,
) -> Result<TerminalSession, String> {
    let pair = native_pty_system()
        .openpty(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut command = CommandBuilder::new(shell());
    #[cfg(not(windows))]
    if let Some(script) = script {
        command.arg("-lc");
        command.arg(script);
    } else {
        command.arg("-l");
    }
    #[cfg(windows)]
    if let Some(script) = script {
        command.arg("/C");
        command.arg(script);
    }
    command.cwd(&directory);
    command.env("TERM", "xterm-256color");
    command.env("COLORTERM", "truecolor");
    #[cfg(windows)]
    command.env("PROMPT", "$E]9;9;$P$E\\$P$G");
    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|error| error.to_string())?;
    drop(pair.slave);
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|error| error.to_string())?;
    let writer = pair
        .master
        .take_writer()
        .map_err(|error| error.to_string())?;
    let output = Arc::new(Mutex::new(TerminalOutput {
        history: VecDeque::new(),
        start: 0,
        #[cfg(windows)]
        current_directory: directory.clone(),
        #[cfg(windows)]
        osc_tail: Vec::new(),
        exit_code: None,
        subscriber: None,
    }));
    let changed = Arc::new(Condvar::new());
    let process_id = child.process_id();
    #[cfg(unix)]
    let mut watchdog = None;
    if let Some(owner) = owner.as_deref() {
        let Some(pid) = process_id else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cannot identify terminal process.".into());
        };
        #[cfg(unix)]
        let group = pair.master.process_group_leader();
        #[cfg(windows)]
        let group = Some(pid as i32);
        let Some(group) = group else {
            let _ = child.kill();
            let _ = child.wait();
            return Err("Cannot identify terminal process group.".into());
        };
        if let Err(error) = crate::owned_processes::register(owner, pid, group as u32) {
            #[cfg(unix)]
            if group > 0 && group != nix::unistd::getpgrp().as_raw() {
                let _ = nix::sys::signal::killpg(
                    nix::unistd::Pid::from_raw(group),
                    nix::sys::signal::Signal::SIGKILL,
                );
            }
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("Cannot track terminal ownership: {error}"));
        }
        #[cfg(unix)]
        {
            watchdog = Some(
                crate::child_watchdog::ChildWatchdog::start(group as u32).map_err(|error| {
                    let _ = nix::sys::signal::killpg(
                        nix::unistd::Pid::from_raw(group),
                        nix::sys::signal::Signal::SIGKILL,
                    );
                    let _ = child.wait();
                    format!("Cannot start terminal watchdog: {error}")
                })?,
            );
        }
    }
    let killer = child.clone_killer();
    let child = Arc::new(Mutex::new(child));
    let background_output = Arc::clone(&output);
    let background_changed = Arc::clone(&changed);
    let background_child = Arc::clone(&child);
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(size) => {
                    if let Ok(mut state) = background_output.lock() {
                        state.history.extend(&buffer[..size]);
                        let excess = state.history.len().saturating_sub(MAX_OUTPUT);
                        state.history.drain(..excess);
                        state.start += excess as u64;
                        background_changed.notify_all();
                        #[cfg(windows)]
                        update_windows_directory(&mut state, &buffer[..size]);
                        if let Some((_, channel)) = &state.subscriber {
                            let _ = channel.send(TerminalEvent::Output {
                                data: buffer[..size].to_vec(),
                            });
                        }
                    }
                }
            }
        }
        let code = background_child
            .lock()
            .ok()
            .and_then(|mut child| child.wait().ok())
            .map(|status| status.exit_code())
            .unwrap_or(1);
        crate::diagnostics::record("terminal_exit", serde_json::json!({"id":&id,"code":code}));
        if let Ok(mut state) = background_output.lock() {
            state.exit_code = Some(code);
            background_changed.notify_all();
            if let Some((_, channel)) = &state.subscriber {
                let _ = channel.send(TerminalEvent::Exit { code });
            }
        }
        let _ = app.emit("terminal:exit", TerminalExitNotice { id, code });
    });
    Ok(TerminalSession {
        inspect_id: Uuid::new_v4().to_string(),
        owner,
        directory,
        process_id,
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        write_busy: AtomicBool::new(false),
        killer: Mutex::new(killer),
        #[cfg(unix)]
        watchdog: Mutex::new(watchdog),
        output,
        changed,
    })
}

#[tauri::command]
pub fn terminal_open(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    params: TerminalOpenParams,
    on_event: Channel<TerminalEvent>,
) -> Result<bool, String> {
    let TerminalOpenParams {
        id,
        directory,
        command,
        size,
        attachment,
    } = params;
    let TerminalSize { cols, rows } = size;
    if id.is_empty() {
        return Err("Terminal ID is required".to_string());
    }
    let directory = Path::new(&directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !directory.is_dir() {
        return Err("Terminal directory is not a folder".to_string());
    }
    let mut sessions = manager.0.lock().map_err(|error| error.to_string())?;
    let existed = sessions.contains_key(&id);
    let session = if let Some(session) = sessions.get(&id) {
        if session.directory != directory {
            return Err("Terminal belongs to another directory".to_string());
        }
        Arc::clone(session)
    } else {
        if command
            .as_ref()
            .is_some_and(|script| script.trim().is_empty())
        {
            return Err("Command is empty".to_string());
        }
        let session = Arc::new(spawn(
            directory,
            cols,
            rows,
            command.as_deref(),
            id.clone(),
            app,
            None,
        )?);
        sessions.insert(id, Arc::clone(&session));
        session
    };
    drop(sessions);
    session
        .master
        .lock()
        .map_err(|error| error.to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string())?;
    let mut output = session.output.lock().map_err(|error| error.to_string())?;
    output.subscriber = Some((attachment, on_event.clone()));
    for slice in [output.history.as_slices().0, output.history.as_slices().1] {
        for chunk in slice.chunks(8192) {
            on_event
                .send(TerminalEvent::Output {
                    data: chunk.to_vec(),
                })
                .map_err(|error| error.to_string())?;
        }
    }
    if let Some(code) = output.exit_code {
        on_event
            .send(TerminalEvent::Exit { code })
            .map_err(|error| error.to_string())?;
    }
    Ok(existed)
}

#[tauri::command]
pub fn terminal_detach(
    manager: State<'_, TerminalManager>,
    id: String,
    attachment: String,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned();
    if let Some(session) = session {
        let mut output = session.output.lock().map_err(|error| error.to_string())?;
        if output
            .subscriber
            .as_ref()
            .is_some_and(|(current, _)| current == &attachment)
        {
            output.subscriber = None;
        }
    }
    Ok(())
}

#[tauri::command]
pub fn terminal_write(
    manager: State<'_, TerminalManager>,
    id: String,
    data: Vec<u8>,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let result = session
        .writer
        .lock()
        .map_err(|error| error.to_string())?
        .write_all(&data)
        .map_err(|error| error.to_string());
    result
}

fn owned_session(
    manager: &TerminalManager,
    terminal_id: &str,
    owner: &str,
) -> Result<Arc<TerminalSession>, String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .values()
        .find(|session| format!("shell:{}", session.inspect_id) == terminal_id)
        .cloned()
        .ok_or("Unknown terminal ID.")?;
    if session.owner.as_deref() != Some(owner) {
        return Err("Terminal belongs to another source session.".into());
    }
    Ok(session)
}

#[tauri::command]
pub fn terminal_owned_create(
    app: AppHandle,
    manager: State<'_, TerminalManager>,
    agents: State<'_, crate::acp::AgentManager>,
    pane_id: String,
    directory: String,
    command: String,
    owner: String,
) -> Result<String, String> {
    if pane_id.is_empty() || owner.is_empty() || command.trim().is_empty() {
        return Err("Terminal pane, owner, and command are required.".into());
    }
    if command.len() > 16_384 {
        return Err("Terminal command exceeds 16384 bytes.".into());
    }
    let directory = Path::new(&directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !directory.is_dir() {
        return Err("Terminal directory is not a folder.".into());
    }
    crate::acp::with_active_owned_terminal(&agents, &owner, || {
        let mut sessions = manager.0.lock().map_err(|error| error.to_string())?;
        if sessions.contains_key(&pane_id) {
            return Err("Terminal pane already exists.".into());
        }
        let session = Arc::new(spawn(
            directory,
            80,
            24,
            Some(&command),
            pane_id.clone(),
            app,
            Some(owner.clone()),
        )?);
        let terminal_id = format!("shell:{}", session.inspect_id);
        sessions.insert(pane_id, session);
        Ok(terminal_id)
    })
}

#[tauri::command]
pub async fn terminal_owned_write(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    owner: String,
    data: String,
) -> Result<(), String> {
    if data.is_empty() || data.len() > 16_384 {
        return Err("Terminal input must be 1–16384 bytes.".into());
    }
    let session = owned_session(&manager, &terminal_id, &owner)?;
    if session
        .output
        .lock()
        .map_err(|error| error.to_string())?
        .exit_code
        .is_some()
    {
        return Err("Terminal has exited.".into());
    }
    if session.write_busy.swap(true, Ordering::AcqRel) {
        return Err("Terminal input is already in progress.".into());
    }
    let task = tauri::async_runtime::spawn_blocking(move || {
        let result = session
            .writer
            .lock()
            .map_err(|error| error.to_string())
            .and_then(|mut writer| {
                writer
                    .write_all(data.as_bytes())
                    .map_err(|error| error.to_string())
            });
        session.write_busy.store(false, Ordering::Release);
        result
    });
    task.await.map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn terminal_owned_stop(
    manager: State<'_, TerminalManager>,
    terminal_id: String,
    owner: String,
) -> Result<(), String> {
    owned_session(&manager, &terminal_id, &owner)?.stop();
    Ok(())
}

#[tauri::command]
pub fn terminal_resize(
    manager: State<'_, TerminalManager>,
    id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let result = session
        .master
        .lock()
        .map_err(|error| error.to_string())?
        .resize(PtySize {
            rows: rows.max(1),
            cols: cols.max(1),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|error| error.to_string());
    result
}

#[tauri::command]
pub fn terminal_close(manager: State<'_, TerminalManager>, id: String) -> Result<(), String> {
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id);
    if let Some(session) = session {
        session.stop();
    }
    Ok(())
}

fn shell_directory(session: &TerminalSession) -> PathBuf {
    #[cfg(windows)]
    if let Ok(output) = session.output.lock() {
        return output.current_directory.clone();
    }
    #[cfg(target_os = "linux")]
    if let Some(pid) = session.process_id {
        if let Ok(directory) = std::fs::read_link(format!("/proc/{pid}/cwd")) {
            return directory;
        }
    }
    #[cfg(target_os = "macos")]
    if let Some(pid) = session.process_id {
        if let Ok(output) = Command::new("/usr/sbin/lsof")
            .args(["-a", "-p", &pid.to_string(), "-d", "cwd", "-Fn"])
            .output()
        {
            if output.status.success() {
                if let Some(directory) = String::from_utf8_lossy(&output.stdout)
                    .lines()
                    .find_map(|line| line.strip_prefix('n'))
                {
                    return PathBuf::from(directory);
                }
            }
        }
    }
    session.directory.clone()
}

#[cfg(windows)]
fn update_windows_directory(output: &mut TerminalOutput, bytes: &[u8]) {
    output.osc_tail.extend_from_slice(bytes);
    for start in 0..output.osc_tail.len().saturating_sub(3) {
        if !output.osc_tail[start..].starts_with(b"\x1b]9;9;") {
            continue;
        }
        if let Some(end) = output.osc_tail[start + 6..]
            .windows(2)
            .position(|pair| pair == b"\x1b\\")
        {
            let path = &output.osc_tail[start + 6..start + 6 + end];
            if let Ok(path) = std::str::from_utf8(path) {
                let directory = PathBuf::from(path);
                if directory.is_dir() {
                    output.current_directory = directory;
                }
            }
        }
    }
    if output.osc_tail.len() > 8192 {
        let excess = output.osc_tail.len() - 8192;
        output.osc_tail.drain(..excess);
    }
}

#[tauri::command]
pub fn terminal_open_file(
    manager: State<'_, TerminalManager>,
    id: String,
    path: String,
    line: u32,
) -> Result<(), String> {
    if line == 0 {
        return Err("Line number must be positive".to_string());
    }
    let session = manager
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is closed")?;
    let directory = shell_directory(&session);
    let candidate = Path::new(&path);
    let file = if candidate.is_absolute() {
        candidate.to_path_buf()
    } else {
        directory.join(candidate)
    }
    .canonicalize()
    .map_err(|error| error.to_string())?;
    if !file.is_file() {
        return Err("Terminal link is not a file".to_string());
    }
    let editor = std::env::var("SAIL_EDITOR")
        .or_else(|_| std::env::var("VISUAL"))
        .or_else(|_| std::env::var("EDITOR"))
        .unwrap_or_else(|_| default_editor());
    let parts = shell_words::split(&editor).map_err(|error| error.to_string())?;
    let (program, arguments) = parts.split_first().ok_or("Editor is empty")?;
    let name = Path::new(program)
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or(program);
    let terminal_editor = ["vim", "nvim", "vi", "nano", "emacs"].contains(&name);
    let mut command = if terminal_editor {
        #[cfg(target_os = "macos")]
        {
            let ghostty = Path::new("/Applications/Ghostty.app/Contents/MacOS/ghostty");
            if ghostty.is_file() {
                let mut command = Command::new(ghostty);
                command.arg("-e").arg(program);
                command
            } else {
                let invocation = std::iter::once(program.as_str())
                    .chain(arguments.iter().map(String::as_str))
                    .chain(
                        [format!("+{line}"), file.to_string_lossy().into_owned()]
                            .iter()
                            .map(String::as_str),
                    )
                    .map(shell_words::quote)
                    .collect::<Vec<_>>()
                    .join(" ");
                Command::new("/usr/bin/osascript")
                    .args([
                        "-e",
                        "on run argv",
                        "-e",
                        "tell application \"Terminal\" to do script (item 1 of argv)",
                        "-e",
                        "end run",
                        "--",
                        &invocation,
                    ])
                    .spawn()
                    .map_err(|error| error.to_string())?;
                return Ok(());
            }
        }
        #[cfg(target_os = "linux")]
        {
            let mut command = Command::new("x-terminal-emulator");
            command.arg("-e").arg(program);
            command
        }
        #[cfg(windows)]
        {
            let mut command = Command::new("wt.exe");
            command.arg(program);
            command
        }
    } else {
        Command::new(editor_program(program))
    };
    command.args(arguments);
    if ["code", "codium", "cursor"].contains(&name) {
        command.arg("--goto");
        command.arg(format!("{}:{line}", file.display()));
    } else if terminal_editor {
        command.arg(format!("+{line}"));
        command.arg(file);
    } else {
        command.arg(format!("{}:{line}", file.display()));
    }
    command.spawn().map_err(|error| error.to_string())?;
    Ok(())
}
