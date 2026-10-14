//! Per-key record store for Sail state that does not belong in `settings.json`.
//!
//! Caches, receipts, turn evidence and run records change often and can grow to
//! megabytes. Each key lives in its own file under `records/`, so saving one key
//! writes one file instead of re-encoding every setting.

use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};

pub(crate) type Records = BTreeMap<String, String>;

const RECORD_KEYS: &[&str] = &[
    "sai-acp-plans",
    "sai-acp-turn-evidence",
    "sai-activity-history",
    "sai-agent-spawn-receipts",
    "sai-agent-transcript-cache",
    "sai-attention-ledger",
    "sai-coordination-messages",
    "sai-inbox-outcomes",
    "sai-interrupted-agent-turns",
    "sai-planning-state",
    "sai-post-turn-history",
    "sai-recent-agent-threads",
    "sai-recent-native-threads",
    "sai-session-tasks",
    "sai-settings-deletions",
    "sai-settings-modified",
    "sai-ship-runs",
    "sai-thread-attention",
];

const RECORD_PREFIXES: &[&str] = &[
    "sai-agent-failed-draft:",
    "sai-pending-worktree-start:",
    "sai-implementation-",
    "sai-issue-graph:",
    "sai-plan-draft:",
    "sai-plan-expanded:",
    "sai-questions-",
    "sai-session:",
    "sai-ship-it-owner:",
    "sai-workspace-activity:",
];

/// Keys stored as records instead of in `settings.json`.
pub(crate) fn is_record_key(key: &str) -> bool {
    RECORD_KEYS.contains(&key) || RECORD_PREFIXES.iter().any(|prefix| key.starts_with(prefix))
}

fn directory(settings: &Path) -> PathBuf {
    settings.with_file_name("records")
}

fn file_name(key: &str) -> String {
    let digest = Sha256::digest(key.as_bytes());
    let name: String = digest.iter().map(|byte| format!("{byte:02x}")).collect();
    format!("{name}.json")
}

fn parse(contents: &str) -> Option<(String, String)> {
    let value: serde_json::Value = serde_json::from_str(contents).ok()?;
    Some((
        value.get("key")?.as_str()?.to_string(),
        value.get("value")?.as_str()?.to_string(),
    ))
}

pub(crate) fn sync_directory(directory: &Path) {
    #[cfg(unix)]
    if let Ok(handle) = fs::File::open(directory) {
        let _ = handle.sync_all();
    }
    #[cfg(not(unix))]
    let _ = directory;
}

pub(crate) fn read(settings: &Path, key: &str) -> Result<Option<String>, String> {
    let file = directory(settings).join(file_name(key));
    match fs::read_to_string(&file) {
        Ok(contents) => Ok(parse(&contents)
            .filter(|(saved, _)| saved == key)
            .map(|(_, value)| value)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => Err(format!("Cannot read settings record: {error}")),
    }
}

pub(crate) fn read_all(settings: &Path) -> Result<Records, String> {
    let mut records = Records::new();
    let entries = match fs::read_dir(directory(settings)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(records),
        Err(error) => return Err(format!("Cannot read settings records: {error}")),
    };
    for entry in entries {
        let path = entry
            .map_err(|error| format!("Cannot read settings records: {error}"))?
            .path();
        if path.extension().and_then(|extension| extension.to_str()) != Some("json") {
            continue;
        }
        let Ok(contents) = fs::read_to_string(&path) else {
            continue;
        };
        if let Some((key, value)) = parse(&contents) {
            if path.file_name().and_then(|name| name.to_str()) == Some(&file_name(&key)) {
                records.insert(key, value);
            }
        }
    }
    Ok(records)
}

pub(crate) fn write(settings: &Path, key: &str, value: &str) -> Result<(), String> {
    let directory = directory(settings);
    if !directory.exists() {
        fs::create_dir_all(&directory)
            .map_err(|error| format!("Cannot create settings records folder: {error}"))?;
        if let Some(parent) = directory.parent() {
            sync_directory(parent);
        }
    }
    let name = file_name(key);
    let temporary = directory.join(format!("{name}.tmp"));
    let contents = serde_json::to_vec(&serde_json::json!({ "key": key, "value": value }))
        .map_err(|error| format!("Cannot encode settings record: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Cannot write settings record: {error}"))?;
    file.write_all(&contents)
        .and_then(|()| file.sync_all())
        .map_err(|error| format!("Cannot write settings record: {error}"))?;
    drop(file);
    fs::rename(&temporary, directory.join(name))
        .map_err(|error| format!("Cannot save settings record: {error}"))?;
    sync_directory(&directory);
    Ok(())
}

pub(crate) fn remove(settings: &Path, key: &str) -> Result<(), String> {
    let directory = directory(settings);
    match fs::remove_file(directory.join(file_name(key))) {
        Ok(()) => {
            sync_directory(&directory);
            Ok(())
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot remove settings record: {error}")),
    }
}

#[cfg(feature = "e2e")]
pub(crate) fn clear(settings: &Path) -> Result<(), String> {
    match fs::remove_dir_all(directory(settings)) {
        Ok(()) => Ok(()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(error) => Err(format!("Cannot clear settings records: {error}")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let root = std::env::temp_dir().join(format!(
            "sail-records-{name}-{}-{}",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        fs::create_dir_all(&root).unwrap();
        root.join("settings.json")
    }

    #[test]
    fn routes_state_keys_but_not_user_settings() {
        for key in [
            "sai-agent-transcript-cache",
            "sai-agent-spawn-receipts",
            "sai-acp-turn-evidence",
            "sai-acp-plans",
            "sai-issue-graph:/repo:ses_1:1",
            "sai-implementation-pending:/repo",
        ] {
            assert!(is_record_key(key), "{key}");
        }
        for key in ["sai-theme", "sai-project-catalog", "sail-agent-threads"] {
            assert!(!is_record_key(key), "{key}");
        }
    }

    #[test]
    fn records_round_trip_one_file_per_key() {
        let path = scratch("round-trip");
        write(&path, "sai-ship-runs", "[1]").unwrap();
        write(&path, "sai-acp-plans", "[2]").unwrap();
        write(&path, "sai-ship-runs", "[3]").unwrap();
        assert_eq!(
            read(&path, "sai-ship-runs").unwrap().as_deref(),
            Some("[3]")
        );
        assert_eq!(read_all(&path).unwrap().len(), 2);
        remove(&path, "sai-ship-runs").unwrap();
        remove(&path, "sai-ship-runs").unwrap();
        assert_eq!(read(&path, "sai-ship-runs").unwrap(), None);
        assert!(!path.exists());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_torn_temporary_file_never_replaces_the_saved_value() {
        let path = scratch("torn");
        write(&path, "sai-ship-runs", "[old]").unwrap();
        let temporary = directory(&path).join(format!("{}.tmp", file_name("sai-ship-runs")));
        fs::write(&temporary, b"{\"key\":\"sai-ship-ru").unwrap();
        assert_eq!(
            read(&path, "sai-ship-runs").unwrap().as_deref(),
            Some("[old]")
        );
        assert_eq!(read_all(&path).unwrap().len(), 1);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
