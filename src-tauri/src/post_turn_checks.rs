use serde::{Deserialize, Serialize};
use std::collections::HashSet;
use std::io::Read;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{mpsc, Arc, Mutex};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::{AppHandle, State};

const APPROVALS_KEY: &str = "sai-post-turn-approvals";
const HISTORY_KEY: &str = "sai-post-turn-history";
const PERSONAL_KEY: &str = "sai-post-turn-personal";
const MAX_OUTPUT: usize = 32 * 1024;
const TIMEOUT: Duration = Duration::from_secs(120);

#[derive(Default)]
pub struct CheckLock(pub Arc<Mutex<HashSet<String>>>);

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckResult {
    #[serde(default)]
    pub id: String,
    #[serde(default)]
    pub updated: u64,
    pub directory: String,
    pub thread: String,
    pub turn: String,
    pub source: String,
    pub command: String,
    pub status: String,
    pub output: String,
    pub code: Option<i32>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CheckRunRequest {
    directory: String,
    thread: String,
    turn: String,
    source: String,
    command: String,
    retry: bool,
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

fn check_id(directory: &str, thread: &str, turn: &str, source: &str, command: &str) -> String {
    serde_json::to_string(&(directory, thread, turn, source, command)).unwrap_or_default()
}

fn settings(app: &AppHandle, key: &str) -> Result<String, String> {
    Ok(crate::settings::load_settings(app.clone())?
        .remove(key)
        .unwrap_or_default())
}

fn history(app: &AppHandle) -> Result<Vec<CheckResult>, String> {
    let raw = settings(app, HISTORY_KEY)?;
    if raw.is_empty() {
        return Ok(Vec::new());
    }
    serde_json::from_str(&raw).map_err(|error| format!("Cannot read check history: {error}"))
}

fn save_history(app: &AppHandle, checks: &[CheckResult]) -> Result<(), String> {
    crate::settings::save_setting(
        app.clone(),
        HISTORY_KEY.into(),
        Some(serde_json::to_string(checks).map_err(|error| error.to_string())?),
    )
}

fn canonical_directory(directory: &str) -> Result<String, String> {
    let path = Path::new(directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !path.is_dir() {
        return Err("Check directory is not a folder.".into());
    }
    Ok(path.to_string_lossy().into_owned())
}

fn configured(
    app: &AppHandle,
    directory: &str,
    source: &str,
    command: &str,
) -> Result<bool, String> {
    let commands = match source {
        "repository" => crate::worktree_config::read(Path::new(directory))?
            .map(|config| config.post_turn_checks)
            .unwrap_or_default(),
        "personal" => {
            serde_json::from_str::<Vec<String>>(&settings(app, PERSONAL_KEY)?).unwrap_or_default()
        }
        _ => return Err("Unknown check source.".into()),
    };
    Ok(commands.iter().any(|item| item == command))
}

#[tauri::command]
pub fn approve_post_turn_check(
    app: AppHandle,
    directory: String,
    command: String,
) -> Result<(), String> {
    let directory = canonical_directory(&directory)?;
    if !configured(&app, &directory, "repository", &command)? {
        return Err("Repository check changed. Review its new command.".into());
    }
    let mut approvals: HashSet<String> =
        serde_json::from_str(&settings(&app, APPROVALS_KEY)?).unwrap_or_default();
    approvals.insert(serde_json::to_string(&(&directory, &command)).map_err(|e| e.to_string())?);
    crate::settings::save_setting(
        app,
        APPROVALS_KEY.into(),
        Some(serde_json::to_string(&approvals).map_err(|e| e.to_string())?),
    )
}

#[tauri::command]
pub fn is_post_turn_check_approved(
    app: AppHandle,
    directory: String,
    command: String,
) -> Result<bool, String> {
    let directory = canonical_directory(&directory)?;
    let approvals: HashSet<String> =
        serde_json::from_str(&settings(&app, APPROVALS_KEY)?).unwrap_or_default();
    let key = serde_json::to_string(&(&directory, &command)).map_err(|e| e.to_string())?;
    Ok(approvals.contains(&key))
}

#[tauri::command]
pub fn cancel_post_turn_check(
    app: AppHandle,
    lock: State<'_, CheckLock>,
    directory: String,
    thread: String,
    turn: String,
    source: String,
    command: String,
) -> Result<CheckResult, String> {
    let _guard = lock.0.lock().map_err(|error| error.to_string())?;
    let directory = canonical_directory(&directory)?;
    if !configured(&app, &directory, &source, &command)? {
        return Err("Check command changed. Reload its configuration.".into());
    }
    let mut checks = history(&app)?;
    if let Some(existing) = checks.iter().find(|item| {
        item.directory == directory
            && item.thread == thread
            && item.turn == turn
            && item.source == source
            && item.command == command
    }) {
        return Ok(existing.clone());
    }
    let result = CheckResult {
        id: check_id(&directory, &thread, &turn, &source, &command),
        updated: now_ms(),
        directory,
        thread,
        turn,
        source,
        command,
        status: "canceled".into(),
        output: "Repository command was not approved.".into(),
        code: None,
    };
    checks.push(result.clone());
    save_history(&app, &checks)?;
    Ok(result)
}

#[tauri::command]
pub fn list_post_turn_checks(
    app: AppHandle,
    lock: State<'_, CheckLock>,
) -> Result<Vec<CheckResult>, String> {
    let active = lock.0.lock().map_err(|error| error.to_string())?;
    let mut checks = history(&app)?;
    let mut changed = false;
    for check in &mut checks {
        if check.status == "running" && !active.contains(&check.id) {
            check.status = "canceled".into();
            check.updated = now_ms();
            check.output = "Sail closed while this check was running.".into();
            changed = true;
        }
    }
    if changed {
        save_history(&app, &checks)?;
    }
    Ok(checks)
}

#[tauri::command]
pub async fn run_post_turn_check(
    app: AppHandle,
    lock: State<'_, CheckLock>,
    request: CheckRunRequest,
) -> Result<CheckResult, String> {
    let CheckRunRequest {
        directory,
        thread,
        turn,
        source,
        command,
        retry,
    } = request;
    if thread.is_empty() || turn.is_empty() || command.trim().is_empty() {
        return Err("Check requires a thread, turn, and command.".into());
    }
    let directory = canonical_directory(&directory)?;
    let mutex = lock.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || {
        if !configured(&app, &directory, &source, &command)? {
            return Err("Check command changed. Reload its configuration.".into());
        }
        if source == "repository" {
            let approvals: HashSet<String> =
                serde_json::from_str(&settings(&app, APPROVALS_KEY)?).unwrap_or_default();
            let key = serde_json::to_string(&(&directory, &command)).map_err(|e| e.to_string())?;
            if !approvals.contains(&key) {
                return Err("Repository check needs approval.".into());
            }
        }
        let mut active = mutex.lock().map_err(|error| error.to_string())?;
        let mut checks = history(&app)?;
        let position = checks.iter().position(|item| {
            item.directory == directory
                && item.thread == thread
                && item.turn == turn
                && item.source == source
                && item.command == command
        });
        if let Some(index) = position {
            if !retry
                || !matches!(
                    checks[index].status.as_str(),
                    "failed" | "timed_out" | "canceled"
                )
            {
                return Ok(checks[index].clone());
            }
        }
        let mut result = CheckResult {
            id: check_id(&directory, &thread, &turn, &source, &command),
            updated: now_ms(),
            directory: directory.clone(),
            thread,
            turn,
            source,
            command: command.clone(),
            status: "running".into(),
            output: String::new(),
            code: None,
        };
        if let Some(index) = position {
            checks[index] = result.clone();
        } else {
            checks.push(result.clone());
        }
        save_history(&app, &checks)?;
        active.insert(result.id.clone());
        drop(active);
        match execute(&directory, &command) {
            Ok((status, code, output)) => {
                result.status = status;
                result.code = code;
                result.output = output;
            }
            Err(error) => {
                result.status = "failed".into();
                result.output = error;
            }
        }
        result.updated = now_ms();
        let mut active = mutex.lock().map_err(|error| error.to_string())?;
        active.remove(&result.id);
        let mut checks = history(&app)?;
        if let Some(item) = checks.iter_mut().find(|item| {
            item.directory == result.directory
                && item.thread == result.thread
                && item.turn == result.turn
                && item.source == result.source
                && item.command == result.command
        }) {
            *item = result.clone();
        }
        save_history(&app, &checks)?;
        Ok(result)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn execute(directory: &str, command: &str) -> Result<(String, Option<i32>, String), String> {
    execute_with_timeout(directory, command, TIMEOUT)
}

fn terminate_group(child: &mut std::process::Child) {
    #[cfg(unix)]
    let _ = nix::sys::signal::killpg(
        nix::unistd::Pid::from_raw(child.id() as i32),
        nix::sys::signal::Signal::SIGKILL,
    );
    let _ = child.kill();
    let _ = child.wait();
}

fn collect(mut stream: impl Read + Send + 'static) -> mpsc::Receiver<Vec<u8>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let mut chunk = [0u8; 4096];
        while let Ok(count) = stream.read(&mut chunk) {
            if count == 0 {
                break;
            }
            if output.len() < MAX_OUTPUT {
                output.extend_from_slice(&chunk[..count.min(MAX_OUTPUT - output.len())]);
            }
        }
        let _ = sender.send(output);
    });
    receiver
}

fn execute_with_timeout(
    directory: &str,
    command: &str,
    timeout: Duration,
) -> Result<(String, Option<i32>, String), String> {
    let mut runner = Command::new(crate::terminal::shell());
    #[cfg(unix)]
    runner.args(["-lc", command]);
    #[cfg(windows)]
    runner.args(["/C", command]);
    runner
        .current_dir(directory)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        runner.process_group(0);
    }
    let mut child = runner
        .spawn()
        .map_err(|error| format!("Cannot start check: {error}"))?;
    let stdout = collect(child.stdout.take().ok_or("Cannot read check output")?);
    let stderr = collect(child.stderr.take().ok_or("Cannot read check errors")?);
    let started = Instant::now();
    let (mut status, mut code) = loop {
        if let Some(exit) = child.try_wait().map_err(|error| error.to_string())? {
            break (
                if exit.success() { "passed" } else { "failed" },
                exit.code(),
            );
        }
        if started.elapsed() >= timeout {
            break ("timed_out", None);
        }
        std::thread::sleep(Duration::from_millis(100));
    };
    terminate_group(&mut child);
    let grace = Duration::from_secs(1);
    let first = stdout.recv_timeout(grace);
    let second = stderr.recv_timeout(grace);
    if first.is_err() || second.is_err() {
        status = "timed_out";
        code = None;
    }
    let mut output = first.unwrap_or_default();
    output.extend(second.unwrap_or_default());
    output.truncate(MAX_OUTPUT);
    if status == "timed_out" {
        output.extend_from_slice(b"\nCheck timed out or background process held output open.");
    }
    Ok((
        status.into(),
        code,
        String::from_utf8_lossy(&output).into_owned(),
    ))
}

#[cfg(all(test, unix))]
mod tests {
    use super::{execute, execute_with_timeout};
    use std::time::{Duration, Instant};

    #[test]
    fn commands_capture_success_and_failure() {
        let directory = std::env::temp_dir();
        let path = directory.to_str().unwrap();
        let (status, code, output) = execute(path, "printf 'ready'; printf 'warning' >&2").unwrap();
        assert_eq!((status.as_str(), code), ("passed", Some(0)));
        assert_eq!(output, "readywarning");
        let (status, code, output) = execute(path, "printf 'failed' >&2; exit 7").unwrap();
        assert_eq!((status.as_str(), code), ("failed", Some(7)));
        assert_eq!(output, "failed");
    }

    #[test]
    fn background_child_cannot_hold_check_open() {
        let directory = std::env::temp_dir();
        let started = Instant::now();
        let (status, _, _) = execute_with_timeout(
            directory.to_str().unwrap(),
            "sh -c 'sleep 5 &'",
            Duration::from_millis(500),
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(3));
        assert!(status == "passed" || status == "timed_out");
    }
}
