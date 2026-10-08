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

// Registers before the command starts so a Stop that arrives first still cancels it.
fn register(
    runs: &Mutex<HashMap<String, Arc<AtomicBool>>>,
    id: &str,
) -> Result<Arc<AtomicBool>, String> {
    let mut active = runs.lock().map_err(|error| error.to_string())?;
    Ok(active.entry(id.to_string()).or_default().clone())
}

fn run(
    runs: &Mutex<HashMap<String, Arc<AtomicBool>>>,
    id: &str,
    directory: &str,
    command: &str,
    timeout: Duration,
) -> Result<ShellResult, String> {
    let cancel = register(runs, id)?;
    let result = execute(directory, command, timeout, &cancel);
    if let Ok(mut active) = runs.lock() {
        active.remove(id);
    }
    result
}

fn execute(
    directory: &str,
    command: &str,
    timeout: Duration,
    cancel: &AtomicBool,
) -> Result<ShellResult, String> {
    if command.trim().is_empty() {
        return Err("Shell command is empty.".into());
    }
    if command.len() > MAX_COMMAND {
        return Err("Shell command is too long.".into());
    }
    let directory = crate::post_turn_checks::canonical_directory(directory)?;
    let started = Instant::now();
    let (status, code, output) = if cancel.load(Ordering::Relaxed) {
        ("canceled".into(), None, String::new())
    } else {
        crate::post_turn_checks::execute_with_timeout(&directory, command, timeout, Some(cancel))?
    };
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
    if id.is_empty() {
        return Err("Shell command requires an id.".into());
    }
    let runs = runs.inner().0.clone();
    tauri::async_runtime::spawn_blocking(move || run(&runs, &id, &directory, &command, TIMEOUT))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn cancel_shell_command(runs: State<'_, ShellRuns>, id: String) -> Result<(), String> {
    if id.is_empty() {
        return Err("Shell command requires an id.".into());
    }
    register(&runs.0, &id)?.store(true, Ordering::Relaxed);
    Ok(())
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
    fn stop_before_start_skips_the_command() {
        let runs = Mutex::default();
        register(&runs, "early")
            .unwrap()
            .store(true, Ordering::Relaxed);
        let marker = std::env::temp_dir().join(format!("sail-shell-{}", std::process::id()));
        let command = format!("touch '{}'", marker.display());
        let result = run(&runs, "early", &temp(), &command, TIMEOUT).unwrap();
        assert_eq!(result.status, "canceled");
        assert!(!marker.exists());
        assert!(runs.lock().unwrap().is_empty());
    }

    #[test]
    fn timeout_kills_the_command() {
        let runs = Mutex::default();
        let result = run(&runs, "a", &temp(), "sleep 30", Duration::from_millis(300)).unwrap();
        assert_eq!(result.status, "timed_out");
    }
}
