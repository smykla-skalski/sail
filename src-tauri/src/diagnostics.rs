use serde::Deserialize;
use serde_json::json;
use std::fs::{self, File, OpenOptions};
use std::io::Write;
use std::path::PathBuf;
use std::sync::{Mutex, OnceLock};
use std::time::{SystemTime, UNIX_EPOCH};
use tauri::Manager;

const MAX_BYTES: u64 = 2 * 1024 * 1024;
const MAX_ENTRY_BYTES: usize = 8 * 1024;
const ARCHIVES: usize = 3;
static LOG: OnceLock<Mutex<LogFile>> = OnceLock::new();

struct LogFile {
    path: PathBuf,
    lock: File,
}

impl LogFile {
    fn open(path: PathBuf) -> std::io::Result<Self> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent)?;
        }
        let lock = OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path.with_extension("log.lock"))?;
        Ok(Self { path, lock })
    }

    fn write(&mut self, line: &[u8]) -> std::io::Result<()> {
        self.lock.lock()?;
        let result = self.write_locked(line);
        let unlock = self.lock.unlock();
        result.and(unlock)
    }

    fn write_locked(&self, line: &[u8]) -> std::io::Result<()> {
        let mut file = OpenOptions::new()
            .create(true)
            .append(true)
            .open(&self.path)?;
        if file.metadata()?.len() + line.len() as u64 + 1 > MAX_BYTES {
            drop(file);
            self.rotate()?;
            file = OpenOptions::new()
                .create(true)
                .append(true)
                .open(&self.path)?;
        }
        file.write_all(line)?;
        file.write_all(b"\n")?;
        Ok(())
    }

    fn rotate(&self) -> std::io::Result<()> {
        for index in (1..ARCHIVES).rev() {
            let source = self.path.with_extension(format!("log.{index}"));
            let target = self.path.with_extension(format!("log.{}", index + 1));
            if source.exists() {
                if target.exists() {
                    fs::remove_file(&target)?;
                }
                fs::rename(source, target)?;
            }
        }
        if self.path.exists() {
            let target = self.path.with_extension("log.1");
            if target.exists() {
                fs::remove_file(&target)?;
            }
            fs::rename(&self.path, target)?;
        }
        Ok(())
    }
}

pub fn init(app: &tauri::AppHandle) -> Result<(), String> {
    let path = app
        .path()
        .app_log_dir()
        .map_err(|error| error.to_string())?
        .join("sail.log");
    let log = LogFile::open(path).map_err(|error| error.to_string())?;
    let _ = LOG.set(Mutex::new(log));
    let previous = std::panic::take_hook();
    std::panic::set_hook(Box::new(move |panic| {
        let location = panic.location();
        record(
            "backend_panic",
            json!({
                "file":location.map(|location| location.file()),
                "line":location.map(|location| location.line())
            }),
        );
        previous(panic);
    }));
    record("app_started", json!({}));
    Ok(())
}

pub fn record(event: &str, details: serde_json::Value) {
    let Some(log) = LOG.get() else { return };
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis();
    let mut line = json!({"timestampMs":timestamp,"event":event,"details":details}).to_string();
    if line.len() > MAX_ENTRY_BYTES {
        line = json!({"timestampMs":timestamp,"event":"oversized_event","details":{
            "originalEvent":event,"bytes":line.len()
        }})
        .to_string();
    }
    if let Ok(mut log) = log.lock() {
        let _ = log.write(line.as_bytes());
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UiDiagnostic {
    event: String,
    agent: Option<String>,
    session_id: Option<String>,
    turn_id: Option<String>,
    queue_length: Option<usize>,
    error_name: Option<String>,
    message: Option<String>,
    source: Option<String>,
    line: Option<u32>,
    column: Option<u32>,
    phase: Option<String>,
}

#[tauri::command]
pub fn diagnostic_event(details: UiDiagnostic) {
    if !matches!(
        details.event.as_str(),
        "message_queued"
            | "queue_dispatch_started"
            | "queue_paused"
            | "stop_requested"
            | "escape_cancel"
            | "turn_failed"
            | "frontend_error"
            | "frontend_unhandled_rejection"
            | "frontend_start_failed"
            | "opencode_event_stream_failed"
            | "opencode_event_stream_ended"
    ) || details
        .agent
        .as_deref()
        .is_some_and(|agent| !matches!(agent, "claude" | "codex"))
    {
        return;
    }
    record(
        &details.event,
        json!({
            "agent":details.agent,
            "sessionId":details.session_id,
            "turnId":details.turn_id,
            "queueLength":details.queue_length,
            "errorName":details.error_name.as_deref().map(|name| name.chars().take(80).collect::<String>()),
            "message":details.message.as_deref().map(|message| message.chars().take(500).collect::<String>()),
            "source":details.source.as_deref().map(|source| source.chars().take(160).collect::<String>()),
            "line":details.line,
            "column":details.column,
            "phase":details.phase.as_deref().filter(|phase| matches!(*phase, "session" | "config" | "snapshot" | "prompt")),
        }),
    );
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rotates_and_keeps_three_archives() {
        let directory =
            std::env::temp_dir().join(format!("sail-log-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("sail.log");
        let mut log = LogFile::open(path.clone()).unwrap();
        for _ in 0..5 {
            log.write(&vec![b'x'; MAX_BYTES as usize]).unwrap();
        }
        assert!(path.exists());
        for index in 1..=ARCHIVES {
            assert!(path.with_extension(format!("log.{index}")).exists());
        }
        assert!(!path.with_extension("log.4").exists());
        drop(log);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn concurrent_instances_share_one_log() {
        let directory =
            std::env::temp_dir().join(format!("sail-log-test-{}", uuid::Uuid::new_v4()));
        let path = directory.join("sail.log");
        let handles: Vec<_> = (0..2)
            .map(|_| {
                let path = path.clone();
                std::thread::spawn(move || {
                    let mut log = LogFile::open(path).unwrap();
                    for _ in 0..100 {
                        log.write(b"entry").unwrap();
                    }
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        assert_eq!(fs::read_to_string(path).unwrap().lines().count(), 200);
        fs::remove_dir_all(directory).unwrap();
    }
}
