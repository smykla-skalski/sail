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
use std::sync::Mutex;

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

/// Record files already reported as corrupt in this launch, and whether the
/// report named the key.
static REPORTED: Mutex<BTreeMap<PathBuf, bool>> = Mutex::new(BTreeMap::new());

#[cfg(test)]
thread_local! {
    static REPORTS: std::cell::RefCell<Vec<String>> = const { std::cell::RefCell::new(Vec::new()) };
}

fn emit(message: &str, key: Option<&str>, file: &Path, reason: &str) {
    #[cfg(test)]
    REPORTS.with(|reports| reports.borrow_mut().push(message.to_string()));
    #[cfg(not(test))]
    {
        eprintln!("{message}");
        crate::diagnostics::record(
            "corrupt_settings_record",
            serde_json::json!({"key": key, "file": file.display().to_string(), "reason": reason}),
        );
    }
    #[cfg(test)]
    let _ = (key, file, reason);
}

/// The fixed record key whose hash names `file`.
fn fixed_key(file: &Path) -> Option<String> {
    let name = file.file_name()?.to_str()?;
    RECORD_KEYS
        .iter()
        .find(|key| file_name(key) == name)
        .map(|key| (*key).to_string())
}

/// Names the key a corrupt record belongs to when the file still says so or its
/// name matches a fixed record key.
fn key_hint(contents: Option<&str>, file: &Path) -> Option<String> {
    contents
        .and_then(|text| serde_json::from_str::<serde_json::Value>(text).ok())
        .and_then(|value| value.get("key")?.as_str().map(str::to_string))
        .or_else(|| fixed_key(file))
}

/// A key read from a damaged file is untrusted; keep it short and on one line.
fn bounded(key: &str) -> String {
    const LIMIT: usize = 200;
    let mut shown: String = key.chars().take(LIMIT).collect();
    if key.chars().count() > LIMIT {
        shown.push('…');
    }
    shown
}

/// A corrupt record reads as absent; log it once per launch and keep the file so
/// it can be inspected. The next save of its key replaces it.
fn report_corrupt(file: &Path, key: Option<&str>, reason: &str) {
    // A full read cannot always name the key; report again once a read by key can.
    let key = key.map(bounded);
    let key = key.as_deref();
    let named = key.is_some();
    let report = REPORTED
        .lock()
        .map(|mut reported| match reported.get(file) {
            Some(&was_named) if was_named || !named => false,
            _ => {
                reported.insert(file.to_path_buf(), named);
                true
            }
        })
        .unwrap_or(true);
    if report {
        emit(
            &format!(
                "Corrupt settings record ignored: key {} file {:?}: {reason}",
                key.map_or_else(|| "unknown".to_string(), |key| format!("{key:?}")),
                file.display().to_string()
            ),
            key,
            file,
            reason,
        );
    }
}

fn forget_report(file: &Path) {
    if let Ok(mut reported) = REPORTED.lock() {
        reported.remove(file);
    }
}

/// Why `contents` is not a record for `key`, or `None` when it is one.
fn corruption(contents: &str, key: &str) -> Option<&'static str> {
    match parse(contents) {
        None => Some("not a valid record"),
        Some((saved, _)) if saved != key => Some("holds a different key"),
        Some(_) => None,
    }
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
    match fs::read(&file) {
        Ok(bytes) => {
            let contents = String::from_utf8(bytes).ok();
            let problem = match contents.as_deref() {
                Some(text) => corruption(text, key),
                None => Some("not valid UTF-8"),
            };
            if let Some(reason) = problem {
                report_corrupt(&file, Some(key), reason);
                return Ok(None);
            }
            Ok(contents.as_deref().and_then(parse).map(|(_, value)| value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            report_corrupt(&file, Some(key), &format!("unreadable: {error}"));
            Ok(None)
        }
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
        let contents = match fs::read(&path) {
            Ok(bytes) => String::from_utf8(bytes).ok(),
            Err(error) => {
                report_corrupt(&path, key_hint(None, &path).as_deref(), &error.to_string());
                continue;
            }
        };
        let Some(contents) = contents else {
            report_corrupt(&path, key_hint(None, &path).as_deref(), "not valid UTF-8");
            continue;
        };
        match parse(&contents) {
            Some((key, value))
                if path.file_name().and_then(|name| name.to_str()) == Some(&file_name(&key)) =>
            {
                records.insert(key, value);
            }
            Some(_) => report_corrupt(
                &path,
                fixed_key(&path).as_deref(),
                "named for a different key",
            ),
            None => report_corrupt(
                &path,
                key_hint(Some(&contents), &path).as_deref(),
                "not a valid record",
            ),
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
    let target = directory.join(name);
    fs::rename(&temporary, &target)
        .map_err(|error| format!("Cannot save settings record: {error}"))?;
    sync_directory(&directory);
    forget_report(&target);
    Ok(())
}

pub(crate) fn remove(settings: &Path, key: &str) -> Result<(), String> {
    let directory = directory(settings);
    match fs::remove_file(directory.join(file_name(key))) {
        Ok(()) => {
            sync_directory(&directory);
            forget_report(&directory.join(file_name(key)));
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

    fn take_reports() -> Vec<String> {
        REPORTS.with(|reports| reports.take())
    }

    const CORRUPT_CONTENTS: [(&str, &[u8]); 5] = [
        ("truncated", b"{\"key\":\"sai-ship-runs\",\"val"),
        ("empty", b""),
        ("not-json", b"this is not json"),
        ("binary", &[0xff, 0xfe, 0x00, 0x80]),
        ("wrong-shape", b"{\"key\":\"sai-ship-runs\",\"value\":7}"),
    ];

    #[test]
    fn a_corrupt_record_reads_as_absent_and_is_logged_once() {
        for (label, bytes) in CORRUPT_CONTENTS {
            let path = scratch(label);
            let key = "sai-ship-runs";
            write(&path, "sai-acp-plans", "[good]").unwrap();
            write(&path, key, "[old]").unwrap();
            take_reports();
            let file = directory(&path).join(file_name(key));
            fs::write(&file, bytes).unwrap();

            assert_eq!(read(&path, key).unwrap(), None, "{label}");
            assert_eq!(read(&path, key).unwrap(), None, "{label}");
            let all = read_all(&path).unwrap();
            assert_eq!(all.len(), 1, "{label}");
            assert_eq!(all.get("sai-acp-plans").map(String::as_str), Some("[good]"));

            let reports = take_reports();
            assert_eq!(reports.len(), 1, "{label}: {reports:?}");
            assert!(reports[0].contains(key), "{label}: {}", reports[0]);
            assert!(
                reports[0].contains(&file.display().to_string()),
                "{label}: {}",
                reports[0]
            );
            assert_eq!(fs::read(&file).unwrap(), bytes, "{label}: file kept");
            fs::remove_dir_all(path.parent().unwrap()).unwrap();
        }
    }

    #[test]
    fn a_corrupt_record_found_by_a_full_read_names_its_key() {
        let path = scratch("full-read");
        write(&path, "sai-ship-runs", "[old]").unwrap();
        take_reports();
        let file = directory(&path).join(file_name("sai-ship-runs"));
        fs::write(&file, b"").unwrap();
        assert!(read_all(&path).unwrap().is_empty());
        assert!(read_all(&path).unwrap().is_empty());
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(reports[0].contains("sai-ship-runs"), "{}", reports[0]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn saving_a_key_replaces_its_corrupt_record() {
        let path = scratch("replace");
        let key = "sai-ship-runs";
        write(&path, key, "[old]").unwrap();
        let file = directory(&path).join(file_name(key));
        fs::write(&file, b"{\"key\"").unwrap();
        assert_eq!(read(&path, key).unwrap(), None);

        write(&path, key, "[new]").unwrap();
        assert_eq!(read(&path, key).unwrap().as_deref(), Some("[new]"));

        fs::write(&file, b"").unwrap();
        take_reports();
        assert_eq!(read(&path, key).unwrap(), None);
        assert_eq!(take_reports().len(), 1, "a new corruption is logged again");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn valid_records_are_not_logged() {
        let path = scratch("valid");
        write(&path, "sai-ship-runs", "[1]").unwrap();
        take_reports();
        assert_eq!(
            read(&path, "sai-ship-runs").unwrap().as_deref(),
            Some("[1]")
        );
        assert_eq!(read(&path, "sai-acp-plans").unwrap(), None);
        assert_eq!(read_all(&path).unwrap().len(), 1);
        assert!(take_reports().is_empty());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn an_unreadable_record_reads_as_absent_and_is_logged() {
        let path = scratch("unreadable");
        let key = "sai-ship-runs";
        write(&path, key, "[old]").unwrap();
        let file = directory(&path).join(file_name(key));
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        take_reports();
        assert_eq!(read(&path, key).unwrap(), None);
        assert_eq!(read(&path, key).unwrap(), None);
        assert!(read_all(&path).unwrap().is_empty());
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(reports[0].contains(key), "{}", reports[0]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_prefixed_key_is_named_once_a_read_by_key_knows_it() {
        let path = scratch("prefixed");
        let key = "sai-session:ses_1";
        write(&path, key, "[old]").unwrap();
        let file = directory(&path).join(file_name(key));
        fs::write(&file, b"").unwrap();
        take_reports();
        assert!(read_all(&path).unwrap().is_empty());
        assert_eq!(read(&path, key).unwrap(), None);
        assert_eq!(read(&path, key).unwrap(), None);
        assert!(read_all(&path).unwrap().is_empty());
        let reports = take_reports();
        assert_eq!(reports.len(), 2, "{reports:?}");
        assert!(reports[0].contains("key unknown"), "{}", reports[0]);
        assert!(reports[1].contains(key), "{}", reports[1]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_hostile_key_in_a_corrupt_record_is_logged_on_one_bounded_line() {
        let path = scratch("hostile");
        let key = "sai-ship-runs";
        write(&path, key, "[old]").unwrap();
        let file = directory(&path).join(file_name(key));
        let claimed = format!("evil\nFAKE LOG LINE\u{1b}[31m{}", "k".repeat(20_000));
        let contents = serde_json::json!({"key": claimed, "value": 5}).to_string();
        fs::write(&file, contents).unwrap();
        take_reports();
        assert!(read_all(&path).unwrap().is_empty());
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(!reports[0].contains('\n') && !reports[0].contains('\u{1b}'));
        assert!(reports[0].len() < 1_000, "{}", reports[0].len());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_record_filed_under_another_keys_name_is_reported_for_that_name() {
        let path = scratch("misfiled");
        write(&path, "sai-ship-runs", "[old]").unwrap();
        let file = directory(&path).join(file_name("sai-ship-runs"));
        fs::write(&file, br#"{"key":"sai-acp-plans","value":"[1]"}"#).unwrap();
        take_reports();
        assert!(read_all(&path).unwrap().is_empty());
        assert_eq!(read(&path, "sai-ship-runs").unwrap(), None);
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(reports[0].contains("sai-ship-runs"), "{}", reports[0]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
