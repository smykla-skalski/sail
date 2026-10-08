use serde::Serialize;
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};
use tauri::State;

const TIMEOUT: Duration = Duration::from_secs(10 * 60);
const MAX_COMMAND: usize = 16 * 1024;

#[derive(Default)]
pub struct ShellRuns(Arc<Mutex<HashMap<String, Arc<AtomicBool>>>>);

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellResult {
    status: String,
    code: Option<i32>,
    output: String,
    duration_ms: u64,
}

fn run(
    runs: &Mutex<HashMap<String, Arc<AtomicBool>>>,
    id: &str,
    directory: &str,
    command: &str,
    timeout: Duration,
) -> Result<ShellResult, String> {
    if id.is_empty() || command.trim().is_empty() {
        return Err("Shell command requires an id and a command.".into());
    }
    if command.len() > MAX_COMMAND {
        return Err("Shell command is too long.".into());
    }
    let directory = crate::post_turn_checks::canonical_directory(directory)?;
    let cancel = Arc::new(AtomicBool::new(false));
    {
        let mut active = runs.lock().map_err(|error| error.to_string())?;
        if active.contains_key(id) {
            return Err("Shell command is already running.".into());
        }
        active.insert(id.to_string(), cancel.clone());
    }
    let started = Instant::now();
    let result =
        crate::post_turn_checks::execute_with_timeout(&directory, command, timeout, Some(&cancel));
    if let Ok(mut active) = runs.lock() {
        active.remove(id);
    }
    let (status, code, output) = result?;
    Ok(ShellResult {
        status,
        code,
        output,
        duration_ms: started.elapsed().as_millis() as u64,
    })
}

#[tauri::command]
pub async fn run_shell_command(
    runs: State<'_, ShellRuns>,
    id: String,
    directory: String,
    command: String,
) -> Result<ShellResult, String> {
    let runs = runs.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || run(&runs, &id, &directory, &command, TIMEOUT))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_shell_command(runs: State<'_, ShellRuns>, id: String) -> Result<bool, String> {
    let active = runs.0.lock().map_err(|error| error.to_string())?;
    Ok(active
        .get(&id)
        .map(|flag| flag.store(true, Ordering::Relaxed))
        .is_some())
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    fn temp() -> String {
        std::env::temp_dir()
            .canonicalize()
            .unwrap()
            .to_string_lossy()
            .into_owned()
    }

    #[test]
    fn runs_in_directory_and_reports_exit_code() {
        let runs = Mutex::default();
        let directory = temp();
        let result = run(&runs, "a", &directory, "pwd; exit 3", TIMEOUT).unwrap();
        assert_eq!((result.status.as_str(), result.code), ("failed", Some(3)));
        let reported = std::path::Path::new(result.output.trim())
            .canonicalize()
            .unwrap();
        assert_eq!(reported.to_string_lossy(), directory);
        assert!(runs.lock().unwrap().is_empty());
    }

    #[test]
    fn rejects_blank_commands_and_missing_directories() {
        let runs = Mutex::default();
        assert!(run(&runs, "a", &temp(), "  ", TIMEOUT).is_err());
        assert!(run(&runs, "a", "/definitely/missing/sail", "true", TIMEOUT).is_err());
    }

    #[test]
    fn cancel_stops_a_running_command() {
        let runs: Arc<Mutex<HashMap<String, Arc<AtomicBool>>>> = Arc::default();
        let worker = {
            let runs = runs.clone();
            std::thread::spawn(move || run(&runs, "slow", &temp(), "sleep 30", TIMEOUT))
        };
        let started = Instant::now();
        while !runs.lock().unwrap().contains_key("slow") {
            assert!(started.elapsed() < Duration::from_secs(5));
            std::thread::sleep(Duration::from_millis(10));
        }
        runs.lock().unwrap()["slow"].store(true, Ordering::Relaxed);
        let result = worker.join().unwrap().unwrap();
        assert_eq!(result.status, "canceled");
        assert!(started.elapsed() < Duration::from_secs(5));
    }

    #[test]
    fn timeout_kills_the_command() {
        let runs = Mutex::default();
        let result = run(&runs, "a", &temp(), "sleep 30", Duration::from_millis(300)).unwrap();
        assert_eq!(result.status, "timed_out");
    }
}
