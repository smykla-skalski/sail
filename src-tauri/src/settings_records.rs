//! Per-key record store for Sail state that does not belong in `settings.json`.
//!
//! Caches, receipts, turn evidence and run records change often and can grow to
//! megabytes. Each key lives in its own file under `records/`, so saving one key
//! writes one file instead of re-encoding every setting.

use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};
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

/// A record file. `modified` marks a key a save changed, so a later import of
/// older webview data does not overwrite it; it lives in the record so the
/// first save of a key writes one file.
fn parse(contents: &str) -> Option<(String, String, bool)> {
    let value: serde_json::Value = serde_json::from_str(contents).ok()?;
    Some((
        value.get("key")?.as_str()?.to_string(),
        value.get("value")?.as_str()?.to_string(),
        value
            .get("modified")
            .and_then(serde_json::Value::as_bool)
            .unwrap_or(false),
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
/// it can be inspected. The next save or delete of its key replaces it.
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
        Some((saved, _, _)) if saved != key => Some("holds a different key"),
        Some(_) => None,
    }
}

/// Like `sync_directory`, for callers that drop the old copy of a value only
/// after the flush succeeds.
fn flush_directory(directory: &Path) -> Result<(), String> {
    #[cfg(unix)]
    return fs::File::open(directory)
        .and_then(|handle| handle.sync_all())
        .map_err(|error| format!("Cannot flush settings records: {error}"));
    #[cfg(not(unix))]
    {
        let _ = directory;
        Ok(())
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
            Ok(contents
                .as_deref()
                .and_then(parse)
                .map(|(_, value, _)| value))
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(error) => {
            report_corrupt(&file, Some(key), &format!("unreadable: {error}"));
            Ok(None)
        }
    }
}

/// Every readable record, and the keys whose record is marked modified.
pub(crate) fn read_all(settings: &Path) -> Result<(Records, BTreeSet<String>), String> {
    let mut records = Records::new();
    let mut modified = BTreeSet::new();
    let entries = match fs::read_dir(directory(settings)) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok((records, modified));
        }
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
            Some((key, value, marked))
                if path.file_name().and_then(|name| name.to_str()) == Some(&file_name(&key)) =>
            {
                if marked {
                    modified.insert(key.clone());
                }
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
    Ok((records, modified))
}

/// Whether the key's record exists and is marked modified.
pub(crate) fn is_marked(settings: &Path, key: &str) -> bool {
    fs::read(directory(settings).join(file_name(key)))
        .ok()
        .and_then(|bytes| String::from_utf8(bytes).ok())
        .and_then(|contents| parse(&contents))
        .is_some_and(|(saved, _, marked)| marked && saved == key)
}

#[cfg(test)]
thread_local! {
    static WRITES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}

/// Record files written on this thread since the last call.
#[cfg(test)]
pub(crate) fn take_write_count() -> usize {
    WRITES.with(std::cell::Cell::take)
}

/// How hard to flush a record before it replaces the old one.
#[derive(Clone, Copy, PartialEq)]
enum Flush {
    /// Reach the drive's permanent storage before returning.
    Full,
    /// Hand the data to the drive; the batch's final directory flush commits it.
    Queued,
}

/// A full drive flush costs milliseconds on macOS. `fsync` only queues the data,
/// so a batch queues each file and pays for one full flush at the end.
fn flush_file(file: &fs::File, flush: Flush) -> std::io::Result<()> {
    #[cfg(target_os = "macos")]
    if flush == Flush::Queued {
        return nix::unistd::fsync(file).map_err(std::io::Error::from);
    }
    let _ = flush;
    file.sync_all()
}

fn ensure_directory(directory: &Path) -> Result<(), String> {
    if !directory.exists() {
        fs::create_dir_all(directory)
            .map_err(|error| format!("Cannot create settings records folder: {error}"))?;
        if let Some(parent) = directory.parent() {
            sync_directory(parent);
        }
    }
    Ok(())
}

/// Moves a directory sitting where a record file belongs to a sibling name, so
/// the record can be written; its contents are kept, never deleted.
fn move_directory_aside(path: &Path, key: &str) -> Result<(), String> {
    if !fs::symlink_metadata(path).is_ok_and(|metadata| metadata.is_dir()) {
        return Ok(());
    }
    let name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or_default();
    for attempt in 0..1000 {
        let aside = path.with_file_name(format!("{name}.dir-{attempt}"));
        if fs::symlink_metadata(&aside).is_ok() {
            continue;
        }
        fs::rename(path, &aside)
            .map_err(|error| format!("Cannot move aside settings record folder: {error}"))?;
        forget_report(path);
        emit(
            &format!(
                "Settings record path was a directory; moved to {:?}",
                aside.display().to_string()
            ),
            Some(&bounded(key)),
            path,
            "path is a directory",
        );
        return Ok(());
    }
    Err("Cannot move aside settings record folder: no free name".to_string())
}

/// Replaces one record file atomically; the caller flushes the directory.
fn stage(
    directory: &Path,
    key: &str,
    value: &str,
    modified: bool,
    flush: Flush,
) -> Result<PathBuf, String> {
    let name = file_name(key);
    let temporary = directory.join(format!("{name}.tmp"));
    let mut record = serde_json::json!({ "key": key, "value": value });
    if modified {
        record["modified"] = serde_json::Value::Bool(true);
    }
    let contents = serde_json::to_vec(&record)
        .map_err(|error| format!("Cannot encode settings record: {error}"))?;
    move_directory_aside(&temporary, key)?;
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
        .and_then(|()| flush_file(&file, flush))
        .map_err(|error| format!("Cannot write settings record: {error}"))?;
    drop(file);
    let target = directory.join(name);
    move_directory_aside(&target, key)?;
    fs::rename(&temporary, &target)
        .map_err(|error| format!("Cannot save settings record: {error}"))?;
    forget_report(&target);
    #[cfg(test)]
    WRITES.with(|writes| writes.set(writes.get() + 1));
    Ok(target)
}

/// Saves one record. `mark` flags the key as modified; without it the record
/// keeps whatever mark it already had.
pub(crate) fn write(settings: &Path, key: &str, value: &str, mark: bool) -> Result<(), String> {
    let directory = directory(settings);
    ensure_directory(&directory)?;
    let modified = mark || is_marked(settings, key);
    stage(&directory, key, value, modified, Flush::Full)?;
    sync_directory(&directory);
    Ok(())
}

/// Saves many records with one durable flush instead of one per record. Each
/// file is replaced atomically, so a crash leaves every record either old or
/// new; only after this returns is it safe to drop the values from another file.
pub(crate) fn write_batch(settings: &Path, entries: &[(&str, &str)]) -> Result<(), String> {
    if entries.is_empty() {
        return Ok(());
    }
    let directory = directory(settings);
    ensure_directory(&directory)?;
    for (key, value) in entries {
        let modified = is_marked(settings, key);
        stage(&directory, key, value, modified, Flush::Queued)?;
    }
    flush_directory(&directory)
}

/// Deletes the key's record file, valid or corrupt, so a deleted key leaves
/// nothing behind. A directory in its place is moved aside, not deleted.
pub(crate) fn remove(settings: &Path, key: &str) -> Result<(), String> {
    let directory = directory(settings);
    let file = directory.join(file_name(key));
    if fs::symlink_metadata(&file).is_ok_and(|metadata| metadata.is_dir()) {
        move_directory_aside(&file, key)?;
        sync_directory(&directory);
        return Ok(());
    }
    match fs::remove_file(&file) {
        Ok(()) => {
            sync_directory(&directory);
            forget_report(&file);
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
        write(&path, "sai-ship-runs", "[1]", false).unwrap();
        write(&path, "sai-acp-plans", "[2]", false).unwrap();
        write(&path, "sai-ship-runs", "[3]", false).unwrap();
        assert_eq!(
            read(&path, "sai-ship-runs").unwrap().as_deref(),
            Some("[3]")
        );
        assert_eq!(read_all(&path).unwrap().0.len(), 2);
        remove(&path, "sai-ship-runs").unwrap();
        remove(&path, "sai-ship-runs").unwrap();
        assert_eq!(read(&path, "sai-ship-runs").unwrap(), None);
        assert!(!path.exists());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_torn_temporary_file_never_replaces_the_saved_value() {
        let path = scratch("torn");
        write(&path, "sai-ship-runs", "[old]", false).unwrap();
        let temporary = directory(&path).join(format!("{}.tmp", file_name("sai-ship-runs")));
        fs::write(&temporary, b"{\"key\":\"sai-ship-ru").unwrap();
        assert_eq!(
            read(&path, "sai-ship-runs").unwrap().as_deref(),
            Some("[old]")
        );
        assert_eq!(read_all(&path).unwrap().0.len(), 1);
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
            write(&path, "sai-acp-plans", "[good]", false).unwrap();
            write(&path, key, "[old]", false).unwrap();
            take_reports();
            let file = directory(&path).join(file_name(key));
            fs::write(&file, bytes).unwrap();

            assert_eq!(read(&path, key).unwrap(), None, "{label}");
            assert_eq!(read(&path, key).unwrap(), None, "{label}");
            let all = read_all(&path).unwrap().0;
            assert_eq!(all.len(), 1, "{label}");
            assert_eq!(all.get("sai-acp-plans").map(String::as_str), Some("[good]"));

            let reports = take_reports();
            assert_eq!(reports.len(), 1, "{label}: {reports:?}");
            assert!(reports[0].contains(key), "{label}: {}", reports[0]);
            assert!(
                reports[0].contains(&format!("{:?}", file.display().to_string())),
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
        write(&path, "sai-ship-runs", "[old]", false).unwrap();
        take_reports();
        let file = directory(&path).join(file_name("sai-ship-runs"));
        fs::write(&file, b"").unwrap();
        assert!(read_all(&path).unwrap().0.is_empty());
        assert!(read_all(&path).unwrap().0.is_empty());
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(reports[0].contains("sai-ship-runs"), "{}", reports[0]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn saving_a_key_replaces_its_corrupt_record() {
        let path = scratch("replace");
        let key = "sai-ship-runs";
        write(&path, key, "[old]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        fs::write(&file, b"{\"key\"").unwrap();
        assert_eq!(read(&path, key).unwrap(), None);

        write(&path, key, "[new]", false).unwrap();
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
        write(&path, "sai-ship-runs", "[1]", false).unwrap();
        take_reports();
        assert_eq!(
            read(&path, "sai-ship-runs").unwrap().as_deref(),
            Some("[1]")
        );
        assert_eq!(read(&path, "sai-acp-plans").unwrap(), None);
        assert_eq!(read_all(&path).unwrap().0.len(), 1);
        assert!(take_reports().is_empty());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn an_unreadable_record_reads_as_absent_and_is_logged() {
        let path = scratch("unreadable");
        let key = "sai-ship-runs";
        write(&path, key, "[old]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        fs::remove_file(&file).unwrap();
        fs::create_dir(&file).unwrap();
        take_reports();
        assert_eq!(read(&path, key).unwrap(), None);
        assert_eq!(read(&path, key).unwrap(), None);
        assert!(read_all(&path).unwrap().0.is_empty());
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(reports[0].contains(key), "{}", reports[0]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_prefixed_key_is_named_once_a_read_by_key_knows_it() {
        let path = scratch("prefixed");
        let key = "sai-session:ses_1";
        write(&path, key, "[old]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        fs::write(&file, b"").unwrap();
        take_reports();
        assert!(read_all(&path).unwrap().0.is_empty());
        assert_eq!(read(&path, key).unwrap(), None);
        assert_eq!(read(&path, key).unwrap(), None);
        assert!(read_all(&path).unwrap().0.is_empty());
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
        write(&path, key, "[old]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        let claimed = format!("evil\nFAKE LOG LINE\u{1b}[31m{}", "k".repeat(20_000));
        let contents = serde_json::json!({"key": claimed, "value": 5}).to_string();
        fs::write(&file, contents).unwrap();
        take_reports();
        assert!(read_all(&path).unwrap().0.is_empty());
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(!reports[0].contains('\n') && !reports[0].contains('\u{1b}'));
        assert!(reports[0].len() < 1_000, "{}", reports[0].len());
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_record_filed_under_another_keys_name_is_reported_for_that_name() {
        let path = scratch("misfiled");
        write(&path, "sai-ship-runs", "[old]", false).unwrap();
        let file = directory(&path).join(file_name("sai-ship-runs"));
        fs::write(&file, br#"{"key":"sai-acp-plans","value":"[1]"}"#).unwrap();
        take_reports();
        assert!(read_all(&path).unwrap().0.is_empty());
        assert_eq!(read(&path, "sai-ship-runs").unwrap(), None);
        let reports = take_reports();
        assert_eq!(reports.len(), 1, "{reports:?}");
        assert!(reports[0].contains("sai-ship-runs"), "{}", reports[0]);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_batch_writes_every_record_and_keeps_existing_marks() {
        let path = scratch("batch");
        write(&path, "sai-ship-runs", "[old]", true).unwrap();
        take_write_count();

        let entries: Vec<(String, String)> = (0..40)
            .map(|n| (format!("sai-session:{n}"), format!("[{n}]")))
            .chain([("sai-ship-runs".to_string(), "[new]".to_string())])
            .collect();
        let borrowed: Vec<(&str, &str)> = entries
            .iter()
            .map(|(key, value)| (key.as_str(), value.as_str()))
            .collect();
        write_batch(&path, &borrowed).unwrap();

        assert_eq!(take_write_count(), 41);
        let (records, marked) = read_all(&path).unwrap();
        assert_eq!(records.len(), 41);
        assert_eq!(records["sai-ship-runs"], "[new]");
        assert_eq!(marked, BTreeSet::from(["sai-ship-runs".to_string()]));
        let leftovers = fs::read_dir(directory(&path))
            .unwrap()
            .filter(|entry| entry.as_ref().unwrap().path().extension().unwrap() != "json")
            .count();
        assert_eq!(leftovers, 0);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_marked_record_keeps_the_fields_the_previous_version_reads() {
        let path = scratch("compat");
        write(&path, "sai-ship-runs", "[1]", true).unwrap();
        let contents =
            fs::read_to_string(directory(&path).join(file_name("sai-ship-runs"))).unwrap();
        let value: serde_json::Value = serde_json::from_str(&contents).unwrap();
        assert_eq!(value["key"].as_str(), Some("sai-ship-runs"));
        assert_eq!(value["value"].as_str(), Some("[1]"));
        assert!(is_marked(&path, "sai-ship-runs"));
        write(&path, "sai-ship-runs", "[2]", false).unwrap();
        assert!(
            is_marked(&path, "sai-ship-runs"),
            "a plain write keeps the mark"
        );
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    fn aside_names(path: &Path) -> Vec<String> {
        let mut names: Vec<String> = fs::read_dir(directory(path))
            .unwrap()
            .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
            .filter(|name| name.contains(".dir-"))
            .collect();
        names.sort();
        names
    }

    #[test]
    fn saving_a_key_whose_record_path_is_a_directory_moves_it_aside() {
        let path = scratch("dir-save");
        let key = "sai-ship-runs";
        write(&path, "sai-acp-plans", "[good]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        fs::create_dir(&file).unwrap();
        fs::write(file.join("keep.txt"), b"precious").unwrap();
        assert_eq!(read(&path, key).unwrap(), None);
        take_reports();

        write(&path, key, "[new]", true).unwrap();

        assert_eq!(read(&path, key).unwrap().as_deref(), Some("[new]"));
        assert!(file.is_file());
        let aside = aside_names(&path);
        assert_eq!(aside.len(), 1, "{aside:?}");
        assert_eq!(
            fs::read(directory(&path).join(&aside[0]).join("keep.txt")).unwrap(),
            b"precious"
        );
        assert_eq!(read_all(&path).unwrap().0.len(), 2);
        assert_eq!(take_reports().len(), 1, "the move is logged");

        write(&path, key, "[newer]", false).unwrap();
        assert_eq!(aside_names(&path).len(), 1, "a file is not moved aside");
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_second_directory_gets_its_own_aside_name() {
        let path = scratch("dir-twice");
        let key = "sai-ship-runs";
        write(&path, key, "[1]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        for round in 0..2 {
            fs::remove_file(&file).unwrap();
            fs::create_dir(&file).unwrap();
            fs::write(file.join("n"), [round]).unwrap();
            write(&path, key, "[2]", false).unwrap();
        }
        assert_eq!(aside_names(&path).len(), 2);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_batch_save_moves_a_directory_aside_too() {
        let path = scratch("dir-batch");
        let key = "sai-ship-runs";
        write(&path, "sai-acp-plans", "[1]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        fs::create_dir(&file).unwrap();
        write_batch(&path, &[(key, "[new]"), ("sai-acp-plans", "[2]")]).unwrap();
        assert_eq!(read(&path, key).unwrap().as_deref(), Some("[new]"));
        assert_eq!(aside_names(&path).len(), 1);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn a_directory_in_the_temporary_path_is_moved_aside() {
        let path = scratch("dir-temporary");
        let key = "sai-ship-runs";
        write(&path, "sai-acp-plans", "[1]", false).unwrap();
        fs::create_dir(directory(&path).join(format!("{}.tmp", file_name(key)))).unwrap();
        write(&path, key, "[new]", false).unwrap();
        assert_eq!(read(&path, key).unwrap().as_deref(), Some("[new]"));
        assert_eq!(aside_names(&path).len(), 1);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }

    #[test]
    fn removing_a_key_deletes_its_corrupt_record_and_moves_a_directory_aside() {
        let path = scratch("remove-corrupt");
        let key = "sai-ship-runs";
        write(&path, key, "[old]", false).unwrap();
        let file = directory(&path).join(file_name(key));
        fs::write(&file, b"{\"key\"").unwrap();
        remove(&path, key).unwrap();
        assert!(!file.exists());

        fs::create_dir(&file).unwrap();
        remove(&path, key).unwrap();
        assert!(!file.exists());
        assert_eq!(aside_names(&path).len(), 1);
        fs::remove_dir_all(path.parent().unwrap()).unwrap();
    }
}
