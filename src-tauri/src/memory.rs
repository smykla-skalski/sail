use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::cmp::Reverse;
use std::fs::{self, File, OpenOptions};
use std::io::{BufRead, Write};
use std::path::{Path, PathBuf};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};
use tauri::Manager;
use uuid::Uuid;

const STORE_VERSION: u32 = 1;
const MAX_CONTENT_CHARS: usize = 4_000;

#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum MemoryKind {
    Decision,
    Constraint,
    Discovery,
    Preference,
    Handoff,
    #[default]
    Other,
}

#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryProvenance {
    pub agent: Option<String>,
    pub session_id: Option<String>,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRating {
    pub value: i8,
    pub updated_at: u64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryRecord {
    pub id: String,
    pub content: String,
    pub kind: MemoryKind,
    pub tags: Vec<String>,
    pub created_at: u64,
    pub updated_at: u64,
    pub provenance: MemoryProvenance,
    pub rating: Option<MemoryRating>,
    pub forgotten_at: Option<u64>,
}

#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryInput {
    pub content: String,
    pub kind: Option<MemoryKind>,
    pub tags: Option<Vec<String>>,
    pub provenance: Option<MemoryProvenance>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemorySearchResult {
    pub memory: MemoryRecord,
    pub score: u64,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatus {
    pub mode: String,
    pub enabled: bool,
    pub project_key: String,
    pub count: usize,
    pub forgotten_count: usize,
}

#[derive(Debug, Default, Deserialize, Serialize)]
struct MemoryStore {
    version: u32,
    memories: Vec<MemoryRecord>,
}

struct StorePaths {
    data: PathBuf,
    lock: PathBuf,
}

fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

pub fn project_key_for(directory: &Path) -> Result<String, String> {
    let common = crate::git_common_directory(directory)?;
    let mut digest = Sha256::new();
    digest.update(common.to_string_lossy().as_bytes());
    Ok(digest
        .finalize()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect())
}

fn memory_root(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(root) = std::env::var_os("SAIL_E2E_CONFIG_DIR") {
        return Ok(PathBuf::from(root).join("memory"));
    }
    app.path()
        .app_local_data_dir()
        .map(|path| path.join("memory"))
        .map_err(|error| format!("Cannot locate shared memory storage: {error}"))
}

pub fn standalone_paths(app: &tauri::AppHandle) -> Result<(PathBuf, PathBuf), String> {
    Ok((memory_root(app)?, crate::settings::settings_path(app)?))
}

pub fn acp_mcp_server(
    app: &tauri::AppHandle,
    directory: &str,
    agent: &str,
) -> Result<Option<Value>, String> {
    if mode(app, directory)? == "off" {
        return Ok(None);
    }
    let executable = std::env::current_exe()
        .map_err(|error| format!("Cannot locate Sail executable: {error}"))?;
    let (root, settings) = standalone_paths(app)?;
    Ok(Some(json!({
        "name": "sail-memory",
        "command": executable.to_string_lossy(),
        "args": ["--memory-mcp"],
        "env": [
            {"name": "SAIL_MEMORY_ACCESS", "value": "sail"},
            {"name": "SAIL_MEMORY_AGENT", "value": agent},
            {"name": "SAIL_MEMORY_PROJECT_DIR", "value": directory},
            {"name": "SAIL_MEMORY_ROOT", "value": root.to_string_lossy()},
            {"name": "SAIL_SETTINGS_PATH", "value": settings.to_string_lossy()}
        ]
    })))
}

fn paths(root: &Path, key: &str) -> StorePaths {
    StorePaths {
        data: root.join(format!("{key}.json")),
        lock: root.join(format!("{key}.lock")),
    }
}

fn backup_path(data: &Path) -> PathBuf {
    data.with_extension("json.bak")
}

fn recover_interrupted_replace(paths: &StorePaths) -> Result<(), String> {
    if paths.data.exists() {
        return Ok(());
    }
    let backup = backup_path(&paths.data);
    if backup.exists() {
        fs::rename(&backup, &paths.data)
            .map_err(|error| format!("Cannot recover shared memory backup: {error}"))?;
    }
    Ok(())
}

fn lock_store(paths: &StorePaths) -> Result<File, String> {
    fs::create_dir_all(
        paths
            .lock
            .parent()
            .ok_or("Cannot locate shared memory storage.")?,
    )
    .map_err(|error| format!("Cannot create shared memory storage: {error}"))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(&paths.lock)
        .map_err(|error| format!("Cannot open shared memory lock: {error}"))?;
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        match lock.try_lock() {
            Ok(()) => break,
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("Shared memory is locked.".into());
            }
            Err(std::fs::TryLockError::Error(error)) => {
                return Err(format!("Cannot lock shared memory: {error}"));
            }
        }
    }
    recover_interrupted_replace(paths)?;
    Ok(lock)
}

fn read_store(paths: &StorePaths) -> Result<MemoryStore, String> {
    let contents = match fs::read_to_string(&paths.data) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            return Ok(MemoryStore {
                version: STORE_VERSION,
                memories: Vec::new(),
            });
        }
        Err(error) => return Err(format!("Cannot read shared memory: {error}")),
    };
    let store: MemoryStore = serde_json::from_str(&contents)
        .map_err(|error| format!("Shared memory is corrupt: {error}"))?;
    if store.version != STORE_VERSION {
        return Err(format!(
            "Shared memory version {} is unsupported.",
            store.version
        ));
    }
    Ok(store)
}

fn write_store(paths: &StorePaths, store: &MemoryStore) -> Result<(), String> {
    let temporary = paths.data.with_extension(format!("{}.tmp", Uuid::new_v4()));
    let contents = serde_json::to_vec_pretty(store)
        .map_err(|error| format!("Cannot encode shared memory: {error}"))?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|error| format!("Cannot write shared memory: {error}"))?;
    if let Err(error) = file.write_all(&contents).and_then(|()| file.sync_all()) {
        let _ = fs::remove_file(&temporary);
        return Err(format!("Cannot write shared memory: {error}"));
    }
    drop(file);
    replace(&temporary, &paths.data)
}

#[cfg(not(windows))]
fn replace(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination)
        .map_err(|error| format!("Cannot save shared memory: {error}"))
}

#[cfg(windows)]
fn replace(temporary: &Path, destination: &Path) -> Result<(), String> {
    let backup = backup_path(destination);
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("Cannot replace shared memory backup: {error}"))?;
        }
        fs::rename(destination, &backup)
            .map_err(|error| format!("Cannot back up shared memory: {error}"))?;
    }
    if let Err(error) = fs::rename(temporary, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(format!("Cannot save shared memory: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn validate(mut input: MemoryInput) -> Result<MemoryInput, String> {
    input.content = input.content.trim().to_string();
    if input.content.is_empty() {
        return Err("Memory content is required.".into());
    }
    if input.content.chars().count() > MAX_CONTENT_CHARS {
        return Err(format!(
            "Memory content exceeds {MAX_CONTENT_CHARS} characters. Store a concise durable fact, not a transcript or tool output."
        ));
    }
    let tags = input.tags.get_or_insert_default();
    if tags.len() > 16 {
        return Err("A memory can have at most 16 tags.".into());
    }
    for tag in tags.iter_mut() {
        *tag = tag.trim().to_lowercase();
        if tag.is_empty() || tag.chars().count() > 64 {
            return Err("Memory tags must contain 1 to 64 characters.".into());
        }
    }
    tags.sort();
    tags.dedup();
    Ok(input)
}

fn list_at(root: &Path, key: &str, forgotten: bool) -> Result<Vec<MemoryRecord>, String> {
    let paths = paths(root, key);
    if !paths.data.exists() {
        return Ok(Vec::new());
    }
    let _lock = lock_store(&paths)?;
    let mut memories = read_store(&paths)?.memories;
    if !forgotten {
        memories.retain(|memory| memory.forgotten_at.is_none());
    }
    memories.sort_by_key(|memory| Reverse(memory.updated_at));
    Ok(memories)
}

pub fn list(
    app: &tauri::AppHandle,
    directory: &str,
    include_forgotten: bool,
) -> Result<Vec<MemoryRecord>, String> {
    ensure_enabled(app, directory)?;
    let (root, key) = context(app, directory)?;
    list_at(&root, &key, include_forgotten)
}

fn remember_at(root: &Path, key: &str, input: MemoryInput) -> Result<MemoryRecord, String> {
    let input = validate(input)?;
    let paths = paths(root, key);
    let _lock = lock_store(&paths)?;
    let mut store = read_store(&paths)?;
    let timestamp = now();
    let memory = MemoryRecord {
        id: Uuid::new_v4().to_string(),
        content: input.content,
        kind: input.kind.unwrap_or_default(),
        tags: input.tags.unwrap_or_default(),
        created_at: timestamp,
        updated_at: timestamp,
        provenance: input.provenance.unwrap_or_default(),
        rating: None,
        forgotten_at: None,
    };
    store.memories.push(memory.clone());
    write_store(&paths, &store)?;
    Ok(memory)
}

fn inspect_at(root: &Path, key: &str, id: &str) -> Result<MemoryRecord, String> {
    list_at(root, key, false)?
        .into_iter()
        .find(|memory| memory.id == id)
        .ok_or_else(|| "Memory not found.".to_string())
}

fn mutate_at(
    root: &Path,
    key: &str,
    id: &str,
    mutate: impl FnOnce(&mut MemoryRecord) -> Result<(), String>,
) -> Result<MemoryRecord, String> {
    let paths = paths(root, key);
    let _lock = lock_store(&paths)?;
    let mut store = read_store(&paths)?;
    let memory = store
        .memories
        .iter_mut()
        .find(|memory| memory.id == id && memory.forgotten_at.is_none())
        .ok_or("Memory not found.")?;
    mutate(memory)?;
    memory.updated_at = now();
    let result = memory.clone();
    write_store(&paths, &store)?;
    Ok(result)
}

fn forget_at(root: &Path, key: &str, id: &str) -> Result<MemoryRecord, String> {
    mutate_at(root, key, id, |memory| {
        memory.content.clear();
        memory.tags.clear();
        memory.rating = None;
        memory.forgotten_at = Some(now());
        Ok(())
    })
}

fn rate_at(root: &Path, key: &str, id: &str, rating: i8) -> Result<MemoryRecord, String> {
    if !(-1..=1).contains(&rating) {
        return Err("Memory rating must be -1, 0, or 1.".into());
    }
    mutate_at(root, key, id, |memory| {
        memory.rating = (rating != 0).then(|| MemoryRating {
            value: rating,
            updated_at: now(),
        });
        Ok(())
    })
}

fn search_at(
    root: &Path,
    key: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    if query.chars().count() > 1_000 {
        return Err("Memory search query exceeds 1000 characters.".into());
    }
    let query = query.trim().to_lowercase();
    let terms: Vec<_> = query.split_whitespace().collect();
    let mut results: Vec<_> = list_at(root, key, false)?
        .into_iter()
        .filter_map(|memory| {
            let haystack = format!(
                "{} {} {:?}",
                memory.content,
                memory.tags.join(" "),
                memory.kind
            )
            .to_lowercase();
            let mut score = u64::from(!query.is_empty() && haystack.contains(&query)) * 25;
            score += terms
                .iter()
                .map(|term| haystack.match_indices(term).count() as u64 * 5)
                .sum::<u64>();
            (query.is_empty() || score > 0).then_some(MemorySearchResult { memory, score })
        })
        .collect();
    results.sort_by_key(|result| (Reverse(result.score), Reverse(result.memory.updated_at)));
    results.truncate(limit.unwrap_or(10).clamp(1, 100));
    Ok(results)
}

fn context(app: &tauri::AppHandle, directory: &str) -> Result<(PathBuf, String), String> {
    Ok((memory_root(app)?, project_key_for(Path::new(directory))?))
}

pub fn mode(app: &tauri::AppHandle, directory: &str) -> Result<String, String> {
    let settings = crate::settings::load_settings(app.clone())?;
    let key = format!("sai-memory-mode:{}", project_key_for(Path::new(directory))?);
    Ok(match settings.get(&key).map(String::as_str) {
        Some("sail") => "sail",
        Some("system") => "system",
        _ => "off",
    }
    .to_string())
}

pub fn ensure_enabled(app: &tauri::AppHandle, directory: &str) -> Result<(), String> {
    if mode(app, directory)? == "off" {
        Err("Shared memory is disabled.".into())
    } else {
        Ok(())
    }
}

pub fn remember(
    app: &tauri::AppHandle,
    directory: &str,
    input: MemoryInput,
) -> Result<MemoryRecord, String> {
    let (root, key) = context(app, directory)?;
    let memory = remember_at(&root, &key, input)?;
    crate::memory_provider::sync_later(app.clone(), directory.to_string());
    Ok(memory)
}

pub fn search(
    app: &tauri::AppHandle,
    directory: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    crate::memory_provider::search(app, directory, query, limit)
}

pub(crate) fn search_local(
    app: &tauri::AppHandle,
    directory: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    let (root, key) = context(app, directory)?;
    search_at(&root, &key, query, limit)
}

pub fn inspect(app: &tauri::AppHandle, directory: &str, id: &str) -> Result<MemoryRecord, String> {
    let (root, key) = context(app, directory)?;
    inspect_at(&root, &key, id)
}

pub fn forget(app: &tauri::AppHandle, directory: &str, id: &str) -> Result<MemoryRecord, String> {
    let (root, key) = context(app, directory)?;
    let memory = forget_at(&root, &key, id)?;
    crate::memory_provider::sync_later(app.clone(), directory.to_string());
    Ok(memory)
}

pub fn rate(
    app: &tauri::AppHandle,
    directory: &str,
    id: &str,
    rating: i8,
) -> Result<MemoryRecord, String> {
    let (root, key) = context(app, directory)?;
    let memory = rate_at(&root, &key, id, rating)?;
    crate::memory_provider::sync_later(app.clone(), directory.to_string());
    Ok(memory)
}

#[tauri::command]
pub fn memory_project_key(directory: String) -> Result<String, String> {
    project_key_for(Path::new(&directory))
}

fn status_at(root: &Path, key: String, mode: String) -> Result<MemoryStatus, String> {
    if mode == "off" {
        return Ok(MemoryStatus {
            mode,
            enabled: false,
            project_key: key,
            count: 0,
            forgotten_count: 0,
        });
    }
    let memories = list_at(root, &key, true)?;
    let forgotten_count = memories
        .iter()
        .filter(|memory| memory.forgotten_at.is_some())
        .count();
    Ok(MemoryStatus {
        enabled: true,
        mode,
        project_key: key,
        count: memories.len() - forgotten_count,
        forgotten_count,
    })
}

#[tauri::command]
pub fn memory_status(app: tauri::AppHandle, directory: String) -> Result<MemoryStatus, String> {
    let (root, key) = context(&app, &directory)?;
    let mode = mode(&app, &directory)?;
    status_at(&root, key, mode)
}

#[tauri::command]
pub fn memory_list(
    app: tauri::AppHandle,
    directory: String,
    include_forgotten: Option<bool>,
) -> Result<Vec<MemoryRecord>, String> {
    list(&app, &directory, include_forgotten.unwrap_or(false))
}

#[tauri::command]
pub fn memory_search(
    app: tauri::AppHandle,
    directory: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    ensure_enabled(&app, &directory)?;
    search(&app, &directory, &query, limit)
}

#[tauri::command]
pub fn memory_remember(
    app: tauri::AppHandle,
    directory: String,
    input: MemoryInput,
) -> Result<MemoryRecord, String> {
    ensure_enabled(&app, &directory)?;
    remember(&app, &directory, input)
}

#[tauri::command]
pub fn memory_inspect(
    app: tauri::AppHandle,
    directory: String,
    id: String,
) -> Result<MemoryRecord, String> {
    ensure_enabled(&app, &directory)?;
    inspect(&app, &directory, &id)
}

#[tauri::command]
pub fn memory_forget(
    app: tauri::AppHandle,
    directory: String,
    id: String,
) -> Result<MemoryRecord, String> {
    ensure_enabled(&app, &directory)?;
    forget(&app, &directory, &id)
}

#[tauri::command]
pub fn memory_rate(
    app: tauri::AppHandle,
    directory: String,
    id: String,
    rating: i8,
) -> Result<MemoryRecord, String> {
    ensure_enabled(&app, &directory)?;
    rate(&app, &directory, &id, rating)
}

fn standalone_context() -> Result<(PathBuf, PathBuf, String), String> {
    let root = std::env::var_os("SAIL_MEMORY_ROOT")
        .map(PathBuf::from)
        .ok_or("SAIL_MEMORY_ROOT is not configured.")?;
    let settings = std::env::var_os("SAIL_SETTINGS_PATH")
        .map(PathBuf::from)
        .ok_or("SAIL_SETTINGS_PATH is not configured.")?;
    let directory = match std::env::var_os("SAIL_MEMORY_PROJECT_DIR") {
        Some(directory) => PathBuf::from(directory),
        None => std::env::current_dir()
            .map_err(|error| format!("Cannot locate the project directory: {error}"))?,
    };
    Ok((root, settings, project_key_for(&directory)?))
}

fn standalone_enabled_for(
    settings: &Path,
    project_key: &str,
    sail_access: bool,
) -> Result<(), String> {
    let contents = fs::read_to_string(settings)
        .map_err(|error| format!("Cannot read Sail memory settings: {error}"))?;
    let settings: serde_json::Map<String, serde_json::Value> = serde_json::from_str(&contents)
        .map_err(|error| format!("Cannot parse Sail memory settings: {error}"))?;
    let key = format!("sai-memory-mode:{project_key}");
    let mode = settings.get(&key).and_then(serde_json::Value::as_str);
    let enabled = if sail_access {
        matches!(mode, Some("sail" | "system"))
    } else {
        mode == Some("system")
    };
    if !enabled {
        return Err(if sail_access {
            "Shared memory is disabled for this project."
        } else {
            "System-wide shared memory is disabled for this project."
        }
        .into());
    }
    Ok(())
}

fn standalone_enabled(settings: &Path, project_key: &str) -> Result<(), String> {
    standalone_enabled_for(
        settings,
        project_key,
        std::env::var("SAIL_MEMORY_ACCESS").as_deref() == Ok("sail"),
    )
}

fn standalone_call(name: &str, arguments: Value, session: Option<&str>) -> Result<Value, String> {
    let (root, settings, key) = standalone_context()?;
    standalone_enabled(&settings, &key)?;
    match name {
        "memory_remember" => {
            let mut input: MemoryInput =
                serde_json::from_value(arguments).map_err(|error| error.to_string())?;
            input.provenance = Some(MemoryProvenance {
                agent: std::env::var("SAIL_MEMORY_AGENT").ok(),
                session_id: session.map(str::to_string),
            });
            serde_json::to_value(remember_at(&root, &key, input)?)
                .map_err(|error| error.to_string())
        }
        "memory_search" => {
            let query = arguments
                .get("query")
                .and_then(Value::as_str)
                .ok_or("query is required")?;
            let limit = arguments
                .get("limit")
                .and_then(Value::as_u64)
                .and_then(|value| usize::try_from(value).ok());
            serde_json::to_value(search_at(&root, &key, query, limit)?)
                .map_err(|error| error.to_string())
        }
        "memory_inspect" => serde_json::to_value(inspect_at(
            &root,
            &key,
            arguments
                .get("id")
                .and_then(Value::as_str)
                .ok_or("id is required")?,
        )?)
        .map_err(|error| error.to_string()),
        "memory_forget" => serde_json::to_value(forget_at(
            &root,
            &key,
            arguments
                .get("id")
                .and_then(Value::as_str)
                .ok_or("id is required")?,
        )?)
        .map_err(|error| error.to_string()),
        "memory_rate" => {
            let id = arguments
                .get("id")
                .and_then(Value::as_str)
                .ok_or("id is required")?;
            let rating = arguments
                .get("rating")
                .and_then(Value::as_i64)
                .and_then(|value| i8::try_from(value).ok())
                .ok_or("rating is required")?;
            serde_json::to_value(rate_at(&root, &key, id, rating)?)
                .map_err(|error| error.to_string())
        }
        _ => Err("Unknown memory action.".into()),
    }
}

fn memory_tools() -> Value {
    json!({"tools":[
        {"name":"memory_remember","description":"Store one concise durable project fact. Never store raw transcripts, complete tool output, secrets, or temporary progress.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"content":{"type":"string","minLength":1,"maxLength":4000},"kind":{"type":"string","enum":["decision","constraint","discovery","preference","handoff","other"]},"tags":{"type":"array","items":{"type":"string","minLength":1,"maxLength":64},"maxItems":16}},"required":["content"]}},
        {"name":"memory_search","description":"Search durable memories shared by this Git project and its linked worktrees.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"query":{"type":"string","maxLength":1000},"limit":{"type":"integer","minimum":1,"maximum":100}},"required":["query"]}},
        {"name":"memory_inspect","description":"Inspect one project memory by ID.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","format":"uuid"}},"required":["id"]}},
        {"name":"memory_forget","description":"Forget one project memory by ID and remove its stored content.","inputSchema":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","format":"uuid"}},"required":["id"]}},
        {"name":"memory_rate","description":"Rate one project memory as unhelpful (-1), unrated (0), or helpful (1).","inputSchema":{"type":"object","additionalProperties":false,"properties":{"id":{"type":"string","format":"uuid"},"rating":{"type":"integer","enum":[-1,0,1]}},"required":["id","rating"]}}
    ]})
}

pub fn run_mcp_stdio() {
    let input = std::io::stdin();
    let mut output = std::io::stdout().lock();
    for line in input.lock().lines().map_while(Result::ok) {
        let Ok(message) = serde_json::from_str::<Value>(&line) else {
            continue;
        };
        let Some(id) = message.get("id") else {
            continue;
        };
        let result = match message.get("method").and_then(Value::as_str).unwrap_or("") {
            "initialize" => {
                json!({"protocolVersion":"2024-11-05","capabilities":{"tools":{}},"serverInfo":{"name":"sail-memory","version":env!("CARGO_PKG_VERSION")}})
            }
            "ping" => json!({}),
            "tools/list" => memory_tools(),
            "tools/call" => {
                let params = message.get("params").unwrap_or(&Value::Null);
                let name = params.get("name").and_then(Value::as_str).unwrap_or("");
                let arguments = params
                    .get("arguments")
                    .cloned()
                    .unwrap_or_else(|| json!({}));
                let session = params
                    .get("_meta")
                    .and_then(|meta| {
                        meta.get("ai.opencode/sessionID")
                            .or_else(|| meta.get("sessionID"))
                    })
                    .and_then(Value::as_str);
                match standalone_call(name, arguments, session) {
                    Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                    Err(error) => json!({"content":[{"type":"text","text":error}],"isError":true}),
                }
            }
            _ => json!({"error":"Unknown MCP method."}),
        };
        let response = json!({"jsonrpc":"2.0","id":id,"result":result});
        if serde_json::to_writer(&mut output, &response).is_err()
            || output.write_all(b"\n").is_err()
            || output.flush().is_err()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::Command;

    fn temporary(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sail-memory-{name}-{}-{}",
            std::process::id(),
            Uuid::new_v4()
        ));
        fs::create_dir_all(&path).unwrap();
        path
    }

    fn input(content: &str) -> MemoryInput {
        MemoryInput {
            content: content.into(),
            kind: Some(MemoryKind::Decision),
            tags: Some(vec!["Rust".into(), "rust".into()]),
            provenance: Some(MemoryProvenance {
                agent: Some("codex".into()),
                session_id: Some("session".into()),
            }),
        }
    }

    fn git(root: &Path, args: &[&str]) {
        assert!(Command::new("git")
            .arg("-C")
            .arg(root)
            .args(args)
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn linked_worktrees_share_a_project_key() {
        let root = temporary("project-key");
        let repository = root.join("repository");
        let worktree = root.join("linked");
        fs::create_dir_all(&repository).unwrap();
        git(&repository, &["init", "-q"]);
        git(&repository, &["config", "user.email", "test@example.com"]);
        git(&repository, &["config", "user.name", "Test"]);
        git(&repository, &["config", "commit.gpgsign", "false"]);
        fs::write(repository.join("file"), "one").unwrap();
        git(&repository, &["add", "file"]);
        git(&repository, &["commit", "-qm", "initial"]);
        git(
            &repository,
            &["worktree", "add", "-q", worktree.to_str().unwrap()],
        );
        assert_eq!(
            project_key_for(&repository).unwrap(),
            project_key_for(&worktree).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unrelated_repositories_have_distinct_project_keys() {
        let root = temporary("isolated");
        let one = root.join("one");
        let two = root.join("two");
        fs::create_dir_all(&one).unwrap();
        fs::create_dir_all(&two).unwrap();
        git(&one, &["init", "-q"]);
        git(&two, &["init", "-q"]);
        assert_ne!(
            project_key_for(&one).unwrap(),
            project_key_for(&two).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn memory_lifecycle_removes_forgotten_content() {
        let root = temporary("lifecycle");
        let saved = remember_at(&root, "project", input("Use SQLite for durable state")).unwrap();
        assert_eq!(saved.tags, vec!["rust"]);
        assert_eq!(
            search_at(&root, "project", "sqlite durable", None)
                .unwrap()
                .len(),
            1
        );
        assert_eq!(
            rate_at(&root, "project", &saved.id, 1)
                .unwrap()
                .rating
                .unwrap()
                .value,
            1
        );
        assert!(forget_at(&root, "project", &saved.id)
            .unwrap()
            .content
            .is_empty());
        assert!(inspect_at(&root, "project", &saved.id).is_err());
        assert!(list_at(&root, "project", false).unwrap().is_empty());
        assert_eq!(list_at(&root, "project", true).unwrap().len(), 1);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn concurrent_writers_preserve_every_memory() {
        let root = temporary("concurrent");
        let writers: Vec<_> = (0..12)
            .map(|index| {
                let root = root.clone();
                std::thread::spawn(move || {
                    remember_at(&root, "project", input(&format!("memory {index}"))).unwrap()
                })
            })
            .collect();
        for writer in writers {
            writer.join().unwrap();
        }
        assert_eq!(list_at(&root, "project", false).unwrap().len(), 12);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn corrupt_storage_returns_an_error() {
        let root = temporary("corrupt");
        let paths = paths(&root, "project");
        fs::write(&paths.data, "not json").unwrap();
        assert!(read_store(&paths).unwrap_err().contains("corrupt"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn off_status_does_not_read_corrupt_storage() {
        let root = temporary("off-corrupt");
        let paths = paths(&root, "project");
        fs::write(&paths.data, "not json").unwrap();
        let status = status_at(&root, "project".into(), "off".into()).unwrap();
        assert!(!status.enabled);
        assert_eq!(status.count, 0);
        assert_eq!(status.forgotten_count, 0);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn store_lock_recovers_an_interrupted_windows_replace() {
        let root = temporary("recover-backup");
        let paths = paths(&root, "project");
        let backup = backup_path(&paths.data);
        fs::write(
            &backup,
            serde_json::to_vec(&MemoryStore {
                version: STORE_VERSION,
                memories: vec![remember_at(&root, "seed", input("recovered")).unwrap()],
            })
            .unwrap(),
        )
        .unwrap();

        let lock = lock_store(&paths).unwrap();

        assert!(!backup.exists());
        assert_eq!(read_store(&paths).unwrap().memories[0].content, "recovered");
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovery_never_replaces_a_completed_new_store() {
        let root = temporary("keep-new-store");
        let paths = paths(&root, "project");
        let current = MemoryStore {
            version: STORE_VERSION,
            memories: vec![remember_at(&root, "current", input("current")).unwrap()],
        };
        let backup = MemoryStore {
            version: STORE_VERSION,
            memories: vec![remember_at(&root, "backup", input("stale")).unwrap()],
        };
        fs::write(&paths.data, serde_json::to_vec(&current).unwrap()).unwrap();
        fs::write(
            backup_path(&paths.data),
            serde_json::to_vec(&backup).unwrap(),
        )
        .unwrap();

        let lock = lock_store(&paths).unwrap();

        assert_eq!(read_store(&paths).unwrap().memories[0].content, "current");
        drop(lock);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn standalone_access_requires_system_mode_for_the_project() {
        let root = temporary("standalone-mode");
        let settings = root.join("settings.json");
        fs::write(
            &settings,
            r#"{"sai-memory-mode:one":"sail","sai-memory-mode:two":"system"}"#,
        )
        .unwrap();
        assert!(standalone_enabled_for(&settings, "one", false).is_err());
        assert!(standalone_enabled_for(&settings, "missing", false).is_err());
        assert!(standalone_enabled_for(&settings, "two", false).is_ok());
        assert!(standalone_enabled_for(&settings, "one", true).is_ok());
        assert!(standalone_enabled_for(&settings, "two", true).is_ok());
        fs::remove_dir_all(root).unwrap();
    }
}
