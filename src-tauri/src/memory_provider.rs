use crate::memory::{MemoryRecord, MemorySearchResult};
use reqwest::blocking::{Client, Response};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
use std::net::IpAddr;
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const CONFIG_PREFIX: &str = "sai-memory-provider:";
const CREDENTIAL_SERVICE: &str = "dev.sail.shared-memory.mem0";
const HOSTED_ENDPOINT: &str = "https://api.mem0.ai";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;
const HOSTED_PAGE_SIZE: usize = 100;
const MAX_RECONCILE_RECORDS: usize = 100_000;
const SELF_HOSTED_SAFE_LIMIT: usize = 1_000;
const EVENT_POLL_ATTEMPTS: usize = 25;
const EVENT_POLL_INTERVAL: Duration = Duration::from_millis(200);

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProviderKind {
    Local,
    Mem0Hosted,
    Mem0SelfHosted,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
struct ProviderConfig {
    provider: ProviderKind,
    endpoint: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderInput {
    provider: ProviderKind,
    endpoint: Option<String>,
    api_key: Option<String>,
}

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    provider: ProviderKind,
    endpoint: Option<String>,
    configured: bool,
    credential_storage: Option<CredentialStorage>,
    notice: Option<String>,
    sync_error: Option<String>,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStorage {
    Keychain,
    Memory,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
struct PendingEvent {
    event_id: Option<String>,
    updated_at: u64,
}

type PendingEvents = HashMap<String, PendingEvent>;

#[derive(Clone, Debug, Default, Deserialize, Serialize)]
struct ProviderRuntimeStatus {
    sync_error: Option<String>,
}

#[derive(Clone, Debug)]
pub(crate) struct RemoteMemory {
    pub(crate) id: String,
    pub(crate) sail_id: String,
    pub(crate) updated_at: u64,
    pub(crate) score: Option<f64>,
}

pub(crate) trait MemoryProvider {
    fn verify(&self, project_key: &str) -> Result<(), String>;
    fn search(
        &self,
        project_key: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMemory>, String>;
    fn reconcile(
        &self,
        root: &Path,
        project_key: &str,
        memories: &[MemoryRecord],
    ) -> Result<(), String>;
}

struct Mem0Provider {
    client: Client,
    kind: ProviderKind,
    endpoint: Url,
    api_key: String,
}

fn session_credentials() -> &'static Mutex<HashMap<String, String>> {
    static CREDENTIALS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CREDENTIALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn project_key(directory: &str) -> Result<String, String> {
    crate::memory::project_key_for(Path::new(directory))
}

fn config_key(project_key: &str) -> String {
    format!("{CONFIG_PREFIX}{project_key}")
}

fn load_config(app: &tauri::AppHandle, project_key: &str) -> Result<ProviderConfig, String> {
    let Some(raw) = crate::settings::string_setting(app, &config_key(project_key))? else {
        return Ok(ProviderConfig {
            provider: ProviderKind::Local,
            endpoint: None,
        });
    };
    serde_json::from_str(&raw).map_err(|_| "Memory provider settings are invalid.".to_string())
}

fn load_config_at(settings: &Path, project_key: &str) -> Result<ProviderConfig, String> {
    let contents = match fs::read_to_string(settings) {
        Ok(contents) => contents,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => String::from("{}"),
        Err(_) => return Err("Cannot read memory provider settings.".into()),
    };
    let settings: HashMap<String, String> = serde_json::from_str(&contents)
        .map_err(|_| "Memory provider settings are invalid.".to_string())?;
    let Some(raw) = settings.get(&config_key(project_key)) else {
        return Ok(ProviderConfig {
            provider: ProviderKind::Local,
            endpoint: None,
        });
    };
    serde_json::from_str(raw).map_err(|_| "Memory provider settings are invalid.".to_string())
}

fn provider_lock(root: &Path, project_key: &str) -> Result<File, String> {
    fs::create_dir_all(root)
        .map_err(|_| "Cannot create memory provider synchronization lock.".to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(format!("{project_key}.provider.lock")))
        .map_err(|_| "Cannot open memory provider synchronization lock.".to_string())?;
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        match lock.try_lock() {
            Ok(()) => return Ok(lock),
            Err(std::fs::TryLockError::WouldBlock) if Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(10));
            }
            Err(std::fs::TryLockError::WouldBlock) => {
                return Err("Memory provider synchronization is locked.".into());
            }
            Err(std::fs::TryLockError::Error(_)) => {
                return Err("Cannot lock memory provider synchronization.".into());
            }
        }
    }
}

fn pending_events_path(root: &Path, project_key: &str) -> PathBuf {
    root.join(format!("{project_key}.mem0-events.json"))
}

fn runtime_status_path(root: &Path, project_key: &str) -> PathBuf {
    root.join(format!("{project_key}.provider-status.json"))
}

fn state_backup_path(path: &Path) -> PathBuf {
    path.with_extension("json.bak")
}

fn read_json<T: for<'de> Deserialize<'de> + Default>(path: &Path) -> Result<T, String> {
    let contents = match fs::read(path) {
        Ok(contents) => serde_json::from_slice(&contents)
            .map_err(|_| "Memory provider state is corrupt.".to_string())?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let backup = state_backup_path(path);
            match fs::read(&backup) {
                Ok(contents) => {
                    fs::rename(&backup, path)
                        .map_err(|_| "Cannot recover memory provider state.".to_string())?;
                    serde_json::from_slice(&contents)
                        .map_err(|_| "Memory provider state is corrupt.".to_string())?
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                    return Ok(T::default())
                }
                Err(_) => return Err("Cannot read memory provider state.".to_string()),
            }
        }
        Err(_) => return Err("Cannot read memory provider state.".to_string()),
    };
    Ok(contents)
}

fn write_json<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or("Memory provider state path is invalid.")?;
    fs::create_dir_all(parent).map_err(|_| "Cannot create memory provider state.".to_string())?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let contents = serde_json::to_vec(value)
        .map_err(|_| "Cannot encode memory provider state.".to_string())?;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options
        .open(&temporary)
        .map_err(|_| "Cannot write memory provider state.".to_string())?;
    if file
        .write_all(&contents)
        .and_then(|()| file.sync_all())
        .is_err()
    {
        let _ = fs::remove_file(&temporary);
        return Err("Cannot write memory provider state.".into());
    }
    drop(file);
    if let Err(error) = replace_state(&temporary, path) {
        let _ = fs::remove_file(&temporary);
        return Err(error);
    }
    Ok(())
}

#[cfg(not(windows))]
fn replace_state(temporary: &Path, destination: &Path) -> Result<(), String> {
    fs::rename(temporary, destination)
        .map_err(|error| format!("Cannot save memory provider state: {error}"))
}

#[cfg(windows)]
fn replace_state(temporary: &Path, destination: &Path) -> Result<(), String> {
    let backup = state_backup_path(destination);
    if destination.exists() {
        if backup.exists() {
            fs::remove_file(&backup)
                .map_err(|error| format!("Cannot replace memory provider backup: {error}"))?;
        }
        fs::rename(destination, &backup)
            .map_err(|error| format!("Cannot back up memory provider state: {error}"))?;
    }
    if let Err(error) = fs::rename(temporary, destination) {
        if backup.exists() {
            let _ = fs::rename(&backup, destination);
        }
        return Err(format!("Cannot save memory provider state: {error}"));
    }
    if backup.exists() {
        let _ = fs::remove_file(backup);
    }
    Ok(())
}

fn load_pending_events(root: &Path, project_key: &str) -> Result<PendingEvents, String> {
    read_json(&pending_events_path(root, project_key))
}

fn save_pending_events(
    root: &Path,
    project_key: &str,
    events: &PendingEvents,
) -> Result<(), String> {
    let path = pending_events_path(root, project_key);
    if events.is_empty() {
        let result = match fs::remove_file(&path) {
            Ok(()) => Ok(()),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(()),
            Err(_) => Err("Cannot clear memory provider event state.".into()),
        };
        if result.is_ok() {
            let _ = fs::remove_file(state_backup_path(&path));
        }
        result
    } else {
        write_json(&path, events)
    }
}

fn load_runtime_status(root: &Path, project_key: &str) -> ProviderRuntimeStatus {
    read_json(&runtime_status_path(root, project_key)).unwrap_or_else(|error| {
        ProviderRuntimeStatus {
            sync_error: Some(error),
        }
    })
}

fn save_runtime_error(root: &Path, project_key: &str, error: Option<&str>) {
    let path = runtime_status_path(root, project_key);
    if error.is_none() {
        let _ = fs::remove_file(&path);
        let _ = fs::remove_file(state_backup_path(&path));
        return;
    }
    let _ = write_json(
        &path,
        &ProviderRuntimeStatus {
            sync_error: error.map(str::to_string),
        },
    );
}

fn save_config(
    app: &tauri::AppHandle,
    project_key: &str,
    config: Option<&ProviderConfig>,
) -> Result<(), String> {
    let value = config
        .map(serde_json::to_string)
        .transpose()
        .map_err(|_| "Cannot encode memory provider settings.".to_string())?;
    crate::settings::save_setting(app.clone(), config_key(project_key), value)
}

fn credential(project_key: &str) -> Result<keyring::Entry, String> {
    keyring::Entry::new(CREDENTIAL_SERVICE, project_key)
        .map_err(|_| "Cannot access the system credential store.".to_string())
}

fn load_api_key_with<F>(project_key: &str, load_keychain: F) -> Result<String, String>
where
    F: FnOnce() -> Result<String, String>,
{
    if let Some(api_key) = session_credentials()
        .lock()
        .map_err(|_| "Mem0 credentials are unavailable.".to_string())?
        .get(project_key)
        .cloned()
    {
        return Ok(api_key);
    }
    load_keychain()
}

fn load_api_key(project_key: &str) -> Result<String, String> {
    load_api_key_with(project_key, || {
        credential(project_key).and_then(|entry| {
            entry
                .get_password()
                .map_err(|_| "Mem0 credentials are unavailable.".to_string())
        })
    })
}

fn store_api_key(project_key: &str, api_key: &str) -> Result<CredentialStorage, String> {
    if credential(project_key)
        .and_then(|entry| {
            entry
                .set_password(api_key)
                .map_err(|_| "Cannot save Mem0 credentials.".to_string())
        })
        .is_ok()
    {
        session_credentials()
            .lock()
            .map_err(|_| "Cannot save Mem0 credentials.".to_string())?
            .remove(project_key);
        return Ok(CredentialStorage::Keychain);
    }
    session_credentials()
        .lock()
        .map_err(|_| "Cannot save Mem0 credentials.".to_string())?
        .insert(project_key.to_string(), api_key.to_string());
    Ok(CredentialStorage::Memory)
}

fn delete_api_key(project_key: &str) {
    if let Ok(entry) = credential(project_key) {
        let _ = entry.delete_credential();
    }
    if let Ok(mut credentials) = session_credentials().lock() {
        credentials.remove(project_key);
    }
}

fn credential_storage(project_key: &str) -> Option<CredentialStorage> {
    if session_credentials()
        .lock()
        .is_ok_and(|credentials| credentials.contains_key(project_key))
    {
        return Some(CredentialStorage::Memory);
    }
    if credential(project_key)
        .and_then(|entry| {
            entry
                .get_password()
                .map_err(|_| "Mem0 credentials are unavailable.".to_string())
        })
        .is_ok()
    {
        return Some(CredentialStorage::Keychain);
    }
    None
}

fn provider_change_resets_pending(previous: &ProviderConfig, next: &ProviderConfig) -> bool {
    previous.provider != ProviderKind::Local && previous != next
}

fn notice(storage: Option<CredentialStorage>, configured: bool) -> Option<String> {
    match storage {
        Some(CredentialStorage::Memory) => Some(
            "The OS credential store is unavailable. The API key is kept in memory for this Sail session only. Standalone agent memory uses local search until the key can be stored in the OS credential store."
                .to_string(),
        ),
        None if configured => Some(
            "The Mem0 credential is unavailable. Enter the API key again to reconnect.".to_string(),
        ),
        _ => None,
    }
}

fn normalize_config(input: &ProviderInput) -> Result<ProviderConfig, String> {
    match input.provider {
        ProviderKind::Local => Ok(ProviderConfig {
            provider: ProviderKind::Local,
            endpoint: None,
        }),
        ProviderKind::Mem0Hosted => Ok(ProviderConfig {
            provider: ProviderKind::Mem0Hosted,
            endpoint: Some(HOSTED_ENDPOINT.to_string()),
        }),
        ProviderKind::Mem0SelfHosted => {
            let raw = input
                .endpoint
                .as_deref()
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .ok_or("A self-hosted Mem0 endpoint is required.")?;
            let mut endpoint = Url::parse(raw).map_err(|_| "The Mem0 endpoint is invalid.")?;
            if endpoint.username() != "" || endpoint.password().is_some() {
                return Err("The Mem0 endpoint cannot contain credentials.".into());
            }
            if endpoint.query().is_some() || endpoint.fragment().is_some() {
                return Err("The Mem0 endpoint cannot contain a query or fragment.".into());
            }
            let loopback = endpoint.host_str().is_some_and(|host| {
                host.eq_ignore_ascii_case("localhost")
                    || host
                        .parse::<IpAddr>()
                        .is_ok_and(|address| address.is_loopback())
            });
            if endpoint.scheme() != "https" && !(endpoint.scheme() == "http" && loopback) {
                return Err(
                    "The Mem0 endpoint must use HTTPS (HTTP is allowed for localhost).".into(),
                );
            }
            let path = endpoint.path().trim_end_matches('/').to_string();
            endpoint.set_path(&path);
            Ok(ProviderConfig {
                provider: ProviderKind::Mem0SelfHosted,
                endpoint: Some(endpoint.to_string().trim_end_matches('/').to_string()),
            })
        }
    }
}

impl Mem0Provider {
    fn new(config: &ProviderConfig, api_key: String) -> Result<Self, String> {
        let endpoint = config
            .endpoint
            .as_deref()
            .ok_or("The Mem0 endpoint is missing.")?;
        Ok(Self {
            client: Client::builder()
                .connect_timeout(Duration::from_secs(2))
                .timeout(Duration::from_secs(5))
                .build()
                .map_err(|_| "Cannot initialize the Mem0 connection.".to_string())?,
            kind: config.provider,
            endpoint: Url::parse(endpoint).map_err(|_| "The Mem0 endpoint is invalid.")?,
            api_key,
        })
    }

    fn url(&self, path: &str) -> Result<Url, String> {
        let base = self.endpoint.as_str().trim_end_matches('/');
        Url::parse(&format!("{base}{path}"))
            .map_err(|_| "Cannot construct the Mem0 request.".to_string())
    }

    fn request(
        &self,
        method: Method,
        path: &str,
    ) -> Result<reqwest::blocking::RequestBuilder, String> {
        let request = self.client.request(method, self.url(path)?);
        Ok(match self.kind {
            ProviderKind::Mem0Hosted => {
                request.header("Authorization", format!("Token {}", self.api_key))
            }
            ProviderKind::Mem0SelfHosted => request.header("X-API-Key", &self.api_key),
            ProviderKind::Local => return Err("The local provider has no remote endpoint.".into()),
        })
    }

    fn authenticate(
        &self,
        request: reqwest::blocking::RequestBuilder,
    ) -> Result<reqwest::blocking::RequestBuilder, String> {
        Ok(match self.kind {
            ProviderKind::Mem0Hosted => {
                request.header("Authorization", format!("Token {}", self.api_key))
            }
            ProviderKind::Mem0SelfHosted => request.header("X-API-Key", &self.api_key),
            ProviderKind::Local => return Err("The local provider has no remote endpoint.".into()),
        })
    }

    fn send(&self, request: reqwest::blocking::RequestBuilder) -> Result<Value, String> {
        let response = request
            .send()
            .map_err(|_| "Mem0 is unavailable.".to_string())?;
        parse_response(response)
    }

    fn list_page(
        &self,
        project_key: &str,
        page: usize,
        limit: usize,
    ) -> Result<(Vec<RemoteMemory>, usize), String> {
        let value = match self.kind {
            ProviderKind::Mem0Hosted => {
                self.send(self.request(Method::POST, "/v3/memories/")?.json(&json!({
                    "filters": { "user_id": project_key },
                    "page": page,
                    "page_size": limit,
                })))?
            }
            ProviderKind::Mem0SelfHosted => {
                let mut url = self.url("/memories")?;
                url.query_pairs_mut()
                    .append_pair("user_id", project_key)
                    .append_pair("limit", &limit.to_string());
                let request = self.client.request(Method::GET, url);
                self.send(self.authenticate(request)?)?
            }
            ProviderKind::Local => return Ok((Vec::new(), 0)),
        };
        let count = result_array(&value).len();
        Ok((remote_memories(&value), count))
    }

    fn list_all(&self, project_key: &str) -> Result<Vec<RemoteMemory>, String> {
        if self.kind == ProviderKind::Mem0SelfHosted {
            let (memories, count) = self.list_page(project_key, 1, SELF_HOSTED_SAFE_LIMIT)?;
            if count >= SELF_HOSTED_SAFE_LIMIT {
                return Err(
                    "Self-hosted Mem0 returned more memories than can be reconciled safely.".into(),
                );
            }
            return Ok(memories);
        }
        let mut all = Vec::new();
        for page in 1..=(MAX_RECONCILE_RECORDS / HOSTED_PAGE_SIZE) + 1 {
            let (mut memories, count) = self.list_page(project_key, page, HOSTED_PAGE_SIZE)?;
            all.append(&mut memories);
            if count < HOSTED_PAGE_SIZE {
                return Ok(all);
            }
            if all.len() >= MAX_RECONCILE_RECORDS {
                return Err("Hosted Mem0 has too many memories to reconcile safely.".into());
            }
        }
        Err("Hosted Mem0 pagination did not terminate safely.".into())
    }

    fn event_status(&self, event_id: &str) -> Result<String, String> {
        if event_id.is_empty()
            || !event_id
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || character == '-')
        {
            return Err("Mem0 returned an invalid event identifier.".into());
        }
        let value = self.send(self.request(Method::GET, &format!("/v1/event/{event_id}/"))?)?;
        value
            .get("status")
            .and_then(Value::as_str)
            .map(str::to_string)
            .ok_or_else(|| "Mem0 returned an invalid event status.".to_string())
    }

    fn wait_for_event(&self, event_id: &str) -> Result<(), String> {
        for attempt in 0..EVENT_POLL_ATTEMPTS {
            match self.event_status(event_id)?.as_str() {
                "SUCCEEDED" => return Ok(()),
                "FAILED" => return Err("Mem0 failed to process the memory.".into()),
                "PENDING" | "RUNNING" | "PROCESSING" => {}
                _ => return Err("Mem0 returned an unknown event status.".into()),
            }
            if attempt + 1 < EVENT_POLL_ATTEMPTS {
                std::thread::sleep(EVENT_POLL_INTERVAL);
            }
        }
        Err("Mem0 is still processing the memory.".into())
    }

    fn wait_until_visible(
        &self,
        project_key: &str,
        sail_id: &str,
        updated_at: u64,
    ) -> Result<Vec<RemoteMemory>, String> {
        for attempt in 0..EVENT_POLL_ATTEMPTS {
            let remote = self.list_all(project_key)?;
            if remote
                .iter()
                .any(|item| item.sail_id == sail_id && item.updated_at == updated_at)
            {
                return Ok(remote);
            }
            if attempt + 1 < EVENT_POLL_ATTEMPTS {
                std::thread::sleep(EVENT_POLL_INTERVAL);
            }
        }
        Err("Mem0 accepted the memory but it is not visible yet.".into())
    }

    fn add(
        &self,
        root: &Path,
        project_key: &str,
        memory: &MemoryRecord,
        pending: &mut PendingEvents,
    ) -> Result<(), String> {
        let path = if self.kind == ProviderKind::Mem0Hosted {
            "/v3/memories/add/"
        } else {
            "/memories"
        };
        let body = json!({
            "messages": [{ "role": "user", "content": memory.content }],
            "user_id": project_key,
            "infer": false,
            "metadata": metadata(memory),
        });
        if self.kind != ProviderKind::Mem0Hosted {
            self.send(self.request(Method::POST, path)?.json(&body))?;
            return Ok(());
        }

        pending.insert(
            memory.id.clone(),
            PendingEvent {
                event_id: None,
                updated_at: memory.updated_at,
            },
        );
        save_pending_events(root, project_key, pending)?;
        let value = self.send(self.request(Method::POST, path)?.json(&body))?;
        let event_id = value
            .get("event_id")
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
            .ok_or("Mem0 did not return an event identifier.")?
            .to_string();
        pending.insert(
            memory.id.clone(),
            PendingEvent {
                event_id: Some(event_id.clone()),
                updated_at: memory.updated_at,
            },
        );
        save_pending_events(root, project_key, pending)?;
        self.wait_for_event(&event_id)?;
        self.wait_until_visible(project_key, &memory.id, memory.updated_at)?;
        pending.remove(&memory.id);
        save_pending_events(root, project_key, pending)?;
        Ok(())
    }

    fn delete(&self, id: &str) -> Result<(), String> {
        let path = if self.kind == ProviderKind::Mem0Hosted {
            format!("/v1/memories/{id}/")
        } else {
            format!("/memories/{id}")
        };
        self.send(self.request(Method::DELETE, &path)?)?;
        Ok(())
    }
}

impl MemoryProvider for Mem0Provider {
    fn verify(&self, project_key: &str) -> Result<(), String> {
        self.list_page(project_key, 1, 1).map(|_| ())
    }

    fn search(
        &self,
        project_key: &str,
        query: &str,
        limit: usize,
    ) -> Result<Vec<RemoteMemory>, String> {
        let value = match self.kind {
            ProviderKind::Mem0Hosted => self.send(
                self.request(Method::POST, "/v3/memories/search/")?
                    .json(&json!({
                        "query": query,
                        "filters": { "user_id": project_key },
                        "top_k": limit,
                    })),
            )?,
            ProviderKind::Mem0SelfHosted => {
                self.send(self.request(Method::POST, "/search")?.json(&json!({
                    "query": query,
                    "user_id": project_key,
                    "limit": limit,
                })))?
            }
            ProviderKind::Local => return Ok(Vec::new()),
        };
        Ok(remote_memories(&value))
    }

    fn reconcile(
        &self,
        root: &Path,
        project_key: &str,
        memories: &[MemoryRecord],
    ) -> Result<(), String> {
        let mut remote = self.list_all(project_key)?;
        let mut pending = load_pending_events(root, project_key)?;
        for (sail_id, event) in pending.clone() {
            if remote
                .iter()
                .any(|item| item.sail_id == sail_id && item.updated_at == event.updated_at)
            {
                pending.remove(&sail_id);
                save_pending_events(root, project_key, &pending)?;
                continue;
            }
            let Some(event_id) = event.event_id else {
                return Err(
                    "A previous Mem0 submission has an unknown outcome. Local memory remains available; switch to local before explicitly reconnecting Mem0."
                        .into(),
                );
            };
            match self.wait_for_event(&event_id) {
                Ok(()) => {
                    remote = self.wait_until_visible(project_key, &sail_id, event.updated_at)?;
                    pending.remove(&sail_id);
                    save_pending_events(root, project_key, &pending)?;
                }
                Err(error) if error == "Mem0 failed to process the memory." => {
                    pending.remove(&sail_id);
                    save_pending_events(root, project_key, &pending)?;
                    return Err(error);
                }
                Err(error) => return Err(error),
            }
        }
        let mut by_sail_id: HashMap<&str, Vec<&RemoteMemory>> = HashMap::new();
        for memory in &remote {
            by_sail_id.entry(&memory.sail_id).or_default().push(memory);
        }
        for memory in memories {
            let existing = by_sail_id.remove(memory.id.as_str()).unwrap_or_default();
            if memory.forgotten_at.is_some() {
                for item in existing {
                    self.delete(&item.id)?;
                }
                continue;
            }
            let current = existing
                .iter()
                .position(|item| item.updated_at == memory.updated_at);
            if current.is_some() && existing.len() == 1 {
                continue;
            }
            for item in existing {
                self.delete(&item.id)?;
            }
            self.add(root, project_key, memory, &mut pending)?;
        }
        for duplicates in by_sail_id.into_values() {
            for duplicate in duplicates {
                self.delete(&duplicate.id)?;
            }
        }
        Ok(())
    }
}

fn parse_response(mut response: Response) -> Result<Value, String> {
    let status = response.status();
    if !status.is_success() {
        return Err(match status {
            StatusCode::UNAUTHORIZED | StatusCode::FORBIDDEN => {
                "Mem0 rejected the credentials.".to_string()
            }
            _ => format!("Mem0 returned HTTP {}.", status.as_u16()),
        });
    }
    let mut bytes = Vec::new();
    response
        .by_ref()
        .take((MAX_RESPONSE_BYTES + 1) as u64)
        .read_to_end(&mut bytes)
        .map_err(|_| "Cannot read the Mem0 response.".to_string())?;
    if bytes.len() > MAX_RESPONSE_BYTES {
        return Err("The Mem0 response is too large.".into());
    }
    if bytes.is_empty() {
        return Ok(Value::Null);
    }
    serde_json::from_slice(&bytes).map_err(|_| "Mem0 returned an invalid response.".to_string())
}

fn result_array(value: &Value) -> &[Value] {
    value
        .as_array()
        .or_else(|| value.get("results").and_then(Value::as_array))
        .or_else(|| value.get("memories").and_then(Value::as_array))
        .map(Vec::as_slice)
        .unwrap_or_default()
}

fn remote_memories(value: &Value) -> Vec<RemoteMemory> {
    result_array(value)
        .iter()
        .filter_map(|item| {
            let metadata = item.get("metadata")?;
            Some(RemoteMemory {
                id: item.get("id")?.as_str()?.to_string(),
                sail_id: metadata.get("sail_memory_id")?.as_str()?.to_string(),
                updated_at: metadata.get("sail_updated_at")?.as_u64()?,
                score: item.get("score").and_then(Value::as_f64),
            })
        })
        .collect()
}

fn metadata(memory: &MemoryRecord) -> Value {
    json!({
        "sail_memory_id": memory.id,
        "sail_updated_at": memory.updated_at,
        "sail_kind": memory.kind,
        "sail_tags": memory.tags,
        "sail_provenance": memory.provenance,
        "sail_rating": memory.rating,
    })
}

fn provider(config: &ProviderConfig, api_key: String) -> Result<Box<dyn MemoryProvider>, String> {
    match config.provider {
        ProviderKind::Local => Err("The local provider does not require a connection.".into()),
        ProviderKind::Mem0Hosted | ProviderKind::Mem0SelfHosted => {
            Ok(Box::new(Mem0Provider::new(config, api_key)?))
        }
    }
}

fn sync_at(root: &Path, settings: &Path, key: &str) -> Result<(), String> {
    let _lock = provider_lock(root, key)?;
    let config = load_config_at(settings, key)?;
    if config.provider == ProviderKind::Local {
        save_runtime_error(root, key, None);
        return Ok(());
    }
    let memories = crate::memory::list_at(root, key, true)?;
    let result = provider(&config, load_api_key(key)?)?.reconcile(root, key, &memories);
    match result {
        Ok(()) => {
            save_runtime_error(root, key, None);
            Ok(())
        }
        Err(error) => {
            save_runtime_error(root, key, Some(&error));
            Err(error)
        }
    }
}

fn sync(app: &tauri::AppHandle, directory: &str) -> Result<(), String> {
    let (root, settings) = crate::memory::standalone_paths(app)?;
    sync_at(&root, &settings, &project_key(directory)?)
}

fn sync_with_retry(root: &Path, settings: &Path, key: &str) {
    for attempt in 0..3 {
        if sync_at(root, settings, key).is_ok() {
            return;
        }
        if attempt < 2 {
            std::thread::sleep(Duration::from_millis(100 * (attempt + 1)));
        }
    }
}

pub fn sync_later(app: tauri::AppHandle, directory: String) {
    let Ok((root, settings)) = crate::memory::standalone_paths(&app) else {
        return;
    };
    let Ok(key) = project_key(&directory) else {
        return;
    };
    std::thread::spawn(move || {
        sync_with_retry(&root, &settings, &key);
    });
}

pub(crate) fn sync_standalone_later(root: PathBuf, settings: PathBuf, key: String) {
    std::thread::spawn(move || sync_with_retry(&root, &settings, &key));
}

pub fn search(
    app: &tauri::AppHandle,
    directory: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    let (root, settings) = crate::memory::standalone_paths(app)?;
    let key = project_key(directory)?;
    search_standalone(&root, &settings, &key, query, limit)
}

pub(crate) fn search_standalone(
    root: &Path,
    settings: &Path,
    key: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    let local = || crate::memory::search_at(root, key, query, limit);
    let _lock = match provider_lock(root, key) {
        Ok(lock) => lock,
        Err(_) => return local(),
    };
    let config = match load_config_at(settings, key) {
        Ok(config) => config,
        Err(_) => return local(),
    };
    if config.provider == ProviderKind::Local {
        return local();
    }
    let maximum = limit.unwrap_or(10).clamp(1, 100);
    let memories = crate::memory::list_at(root, key, true)?;
    let remote = load_api_key(key)
        .and_then(|api_key| provider(&config, api_key))
        .and_then(|provider| {
            provider.reconcile(root, key, &memories)?;
            provider.search(key, query, maximum)
        });
    match remote {
        Ok(remote) => {
            let local_results = local()?;
            // Linearize returned records after all remote I/O so completed forgets win.
            let canonical: HashMap<_, _> = crate::memory::list_at(root, key, false)?
                .into_iter()
                .map(|memory| (memory.id.clone(), memory))
                .collect();
            save_runtime_error(root, key, None);
            Ok(merge_results(
                map_remote_results(remote, &canonical, maximum),
                local_results
                    .into_iter()
                    .filter(|result| canonical.contains_key(&result.memory.id))
                    .collect(),
                maximum,
            ))
        }
        Err(error) => {
            save_runtime_error(root, key, Some(&error));
            local()
        }
    }
}

fn map_remote_results(
    remote: Vec<RemoteMemory>,
    canonical: &HashMap<String, MemoryRecord>,
    maximum: usize,
) -> Vec<MemorySearchResult> {
    remote
        .into_iter()
        .filter_map(|result| {
            canonical
                .get(&result.sail_id)
                .cloned()
                .map(|memory| MemorySearchResult {
                    memory,
                    score: (result.score.unwrap_or_default().clamp(0.0, 1.0) * 1_000.0) as u64,
                })
        })
        .take(maximum)
        .collect()
}

fn merge_results(
    mut remote: Vec<MemorySearchResult>,
    local: Vec<MemorySearchResult>,
    maximum: usize,
) -> Vec<MemorySearchResult> {
    let mut ids: HashSet<String> = remote
        .iter()
        .map(|result| result.memory.id.clone())
        .collect();
    for result in local {
        if ids.insert(result.memory.id.clone()) {
            remote.push(result);
        }
    }
    remote.truncate(maximum);
    remote
}

#[tauri::command]
pub fn memory_provider_status(
    app: tauri::AppHandle,
    directory: String,
) -> Result<ProviderStatus, String> {
    let key = project_key(&directory)?;
    let config = load_config(&app, &key)?;
    let (root, _) = crate::memory::standalone_paths(&app)?;
    let storage = credential_storage(&key);
    let configured = config.provider != ProviderKind::Local;
    let runtime = load_runtime_status(&root, &key);
    Ok(ProviderStatus {
        configured,
        provider: config.provider,
        endpoint: config.endpoint,
        credential_storage: storage,
        notice: notice(storage, configured),
        sync_error: runtime.sync_error,
    })
}

#[tauri::command]
pub fn verify_memory_provider(
    directory: String,
    input: ProviderInput,
) -> Result<ProviderStatus, String> {
    let key = project_key(&directory)?;
    let config = normalize_config(&input)?;
    if config.provider != ProviderKind::Local {
        let api_key = input
            .api_key
            .as_deref()
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or("A Mem0 API key is required.")?;
        provider(&config, api_key.to_string())?.verify(&key)?;
    }
    Ok(ProviderStatus {
        configured: false,
        provider: config.provider,
        endpoint: config.endpoint,
        credential_storage: None,
        notice: None,
        sync_error: None,
    })
}

#[tauri::command]
pub fn set_memory_provider(
    app: tauri::AppHandle,
    directory: String,
    input: ProviderInput,
) -> Result<ProviderStatus, String> {
    let key = project_key(&directory)?;
    let config = normalize_config(&input)?;
    let (root, _) = crate::memory::standalone_paths(&app)?;
    let _lock = provider_lock(&root, &key)?;
    let previous = load_config(&app, &key)?;
    if provider_change_resets_pending(&previous, &config) {
        save_pending_events(&root, &key, &PendingEvents::new())?;
        save_runtime_error(&root, &key, None);
    }
    if config.provider == ProviderKind::Local {
        save_config(&app, &key, None)?;
        delete_api_key(&key);
        save_pending_events(&root, &key, &PendingEvents::new())?;
        save_runtime_error(&root, &key, None);
        return Ok(ProviderStatus {
            provider: ProviderKind::Local,
            endpoint: None,
            configured: false,
            credential_storage: None,
            notice: None,
            sync_error: None,
        });
    }
    crate::memory::ensure_enabled(&app, &directory)?;
    let api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("A Mem0 API key is required.")?;
    let provider = provider(&config, api_key.to_string())?;
    provider.verify(&key)?;
    provider.reconcile(&root, &key, &crate::memory::list(&app, &directory, true)?)?;
    let storage = store_api_key(&key, api_key)?;
    save_config(&app, &key, Some(&config))?;
    Ok(ProviderStatus {
        provider: config.provider,
        endpoint: config.endpoint,
        configured: true,
        credential_storage: Some(storage),
        notice: notice(Some(storage), true),
        sync_error: None,
    })
}

#[tauri::command]
pub fn sync_memory_provider(app: tauri::AppHandle, directory: String) -> Result<(), String> {
    crate::memory::ensure_enabled(&app, &directory)?;
    sync(&app, &directory)
}

#[cfg(test)]
mod tests {
    use super::{
        config_key, credential_storage, load_api_key_with, load_pending_events,
        load_runtime_status, merge_results, normalize_config, notice,
        provider_change_resets_pending, provider_lock, remote_memories, search_standalone,
        session_credentials, sync_at, CredentialStorage, Mem0Provider, MemoryProvider,
        PendingEvents, ProviderConfig, ProviderInput, ProviderKind, HOSTED_ENDPOINT,
        HOSTED_PAGE_SIZE, SELF_HOSTED_SAFE_LIMIT,
    };
    use crate::memory::{
        forget_at, remember_at, MemoryInput, MemoryKind, MemoryProvenance, MemoryRecord,
        MemorySearchResult,
    };
    use serde_json::json;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;
    use uuid::Uuid;

    fn memory() -> MemoryRecord {
        MemoryRecord {
            id: "local-id".into(),
            content: "Prefer concise status updates".into(),
            kind: MemoryKind::Preference,
            tags: vec!["communication".into()],
            created_at: 40,
            updated_at: 42,
            provenance: MemoryProvenance::default(),
            rating: None,
            forgotten_at: None,
        }
    }

    fn temporary() -> std::path::PathBuf {
        let root = std::env::temp_dir().join(format!("sail-provider-test-{}", Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        root
    }

    fn write_provider_settings(path: &std::path::Path, key: &str, endpoint: &str) {
        let config = ProviderConfig {
            provider: ProviderKind::Mem0SelfHosted,
            endpoint: Some(endpoint.into()),
        };
        fs::write(
            path,
            json!({ config_key(key): serde_json::to_string(&config).unwrap() }).to_string(),
        )
        .unwrap();
    }

    fn remember_local(root: &std::path::Path, key: &str) -> MemoryRecord {
        remember_at(
            root,
            key,
            MemoryInput {
                content: "Prefer concise status updates".into(),
                kind: Some(MemoryKind::Preference),
                tags: Some(vec!["communication".into()]),
                provenance: None,
            },
        )
        .unwrap()
    }

    fn read_request(stream: &mut std::net::TcpStream) -> String {
        stream
            .set_read_timeout(Some(std::time::Duration::from_secs(2)))
            .unwrap();
        let mut request = Vec::new();
        let mut buffer = [0_u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            request.extend_from_slice(&buffer[..count]);
            let header_end = request.windows(4).position(|part| part == b"\r\n\r\n");
            if let Some(header_end) = header_end {
                let headers = String::from_utf8_lossy(&request[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        line.to_ascii_lowercase()
                            .strip_prefix("content-length: ")
                            .and_then(|value| value.parse::<usize>().ok())
                    })
                    .unwrap_or_default();
                if request.len() >= header_end + 4 + content_length {
                    break;
                }
            }
        }
        String::from_utf8(request).unwrap()
    }

    fn respond(stream: &mut std::net::TcpStream, body: &str) {
        write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    }

    fn respond_status(stream: &mut std::net::TcpStream, status: &str, body: &str) {
        write!(
            stream,
            "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            body.len(),
            body
        )
        .unwrap();
    }

    #[test]
    fn provider_config_never_serializes_api_key() {
        let input = ProviderInput {
            provider: ProviderKind::Mem0Hosted,
            endpoint: None,
            api_key: Some("secret".into()),
        };
        let encoded = serde_json::to_string(&normalize_config(&input).unwrap()).unwrap();
        assert!(!encoded.contains("secret"));
        assert!(!encoded.contains("apiKey"));
    }

    #[test]
    fn memory_only_credentials_explain_standalone_fallback() {
        let message = notice(Some(CredentialStorage::Memory), true).unwrap();
        assert!(message.contains("Standalone agent memory uses local search"));
    }

    #[test]
    fn session_credential_overrides_stale_keychain_value() {
        let key = Uuid::new_v4().to_string();
        session_credentials()
            .lock()
            .unwrap()
            .insert(key.clone(), "current".into());
        assert_eq!(
            load_api_key_with(&key, || Ok("stale".into())).unwrap(),
            "current"
        );
        assert_eq!(credential_storage(&key), Some(CredentialStorage::Memory));
        session_credentials().lock().unwrap().remove(&key);
    }

    #[test]
    fn failed_first_enable_preserves_pending_submission() {
        let local = ProviderConfig {
            provider: ProviderKind::Local,
            endpoint: None,
        };
        let hosted = ProviderConfig {
            provider: ProviderKind::Mem0Hosted,
            endpoint: Some(HOSTED_ENDPOINT.into()),
        };
        assert!(!provider_change_resets_pending(&local, &hosted));
        assert!(!provider_change_resets_pending(&hosted, &hosted));

        let self_hosted = ProviderConfig {
            provider: ProviderKind::Mem0SelfHosted,
            endpoint: Some("https://mem0.example".into()),
        };
        assert!(provider_change_resets_pending(&hosted, &self_hosted));
    }

    #[test]
    fn self_hosted_endpoint_requires_https_except_loopback() {
        for endpoint in ["http://example.com", "ftp://localhost:8000"] {
            let input = ProviderInput {
                provider: ProviderKind::Mem0SelfHosted,
                endpoint: Some(endpoint.into()),
                api_key: Some("secret".into()),
            };
            assert!(normalize_config(&input).is_err());
        }
        for endpoint in ["https://example.com/", "http://127.0.0.1:8000/"] {
            let input = ProviderInput {
                provider: ProviderKind::Mem0SelfHosted,
                endpoint: Some(endpoint.into()),
                api_key: Some("secret".into()),
            };
            assert!(normalize_config(&input).is_ok());
        }
    }

    #[test]
    fn remote_results_require_canonical_identity_metadata() {
        let parsed = remote_memories(&json!({ "results": [
            { "id": "remote", "score": 0.75, "metadata": {
                "sail_memory_id": "local", "sail_updated_at": 42
            }},
            { "id": "unmanaged", "memory": "ignore me" }
        ]}));
        assert_eq!(parsed.len(), 1);
        assert_eq!(parsed[0].id, "remote");
        assert_eq!(parsed[0].sail_id, "local");
        assert_eq!(parsed[0].updated_at, 42);
        assert_eq!(parsed[0].score, Some(0.75));
    }

    #[test]
    fn remote_results_keep_distinct_local_matches() {
        let first = memory();
        let mut second = memory();
        second.id = "second".into();
        let merged = merge_results(
            vec![MemorySearchResult {
                memory: first.clone(),
                score: 900,
            }],
            vec![
                MemorySearchResult {
                    memory: first,
                    score: 25,
                },
                MemorySearchResult {
                    memory: second,
                    score: 20,
                },
            ],
            10,
        );
        assert_eq!(merged.len(), 2);
        assert_eq!(merged[1].memory.id, "second");
    }

    #[test]
    fn hosted_add_uses_v3_and_token_authentication() {
        let root = temporary();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("POST /v3/memories/add/ HTTP/1.1"));
            assert!(request
                .to_ascii_lowercase()
                .contains("authorization: token secret"));
            assert!(request.contains("\"infer\":false"));
            assert!(request.contains("\"sail_memory_id\":\"local-id\""));
            respond(&mut stream, r#"{"event_id":"event-1","status":"PENDING"}"#);
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0Hosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        let mut pending = PendingEvents::new();
        let error = provider
            .add(&root, "project", &memory(), &mut pending)
            .unwrap_err();
        assert_eq!(error, "Mem0 is unavailable.");
        assert_eq!(pending["local-id"].event_id.as_deref(), Some("event-1"));
        server.join().unwrap();
    }

    #[test]
    fn hosted_retry_resolves_saved_event_without_duplicate_post() {
        let root = temporary();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let adds = Arc::new(AtomicUsize::new(0));
        let server_adds = adds.clone();
        let server = std::thread::spawn(move || {
            for request_number in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                match request_number {
                    0 => respond(&mut stream, r#"{"results":[]}"#),
                    1 => {
                        assert!(request.starts_with("POST /v3/memories/add/ HTTP/1.1"));
                        server_adds.fetch_add(1, Ordering::SeqCst);
                        respond(&mut stream, r#"{"event_id":"event-1","status":"PENDING"}"#);
                    }
                    2 => {
                        assert!(request.starts_with("GET /v1/event/event-1/ HTTP/1.1"));
                        respond_status(&mut stream, "503 Unavailable", r#"{"error":"later"}"#);
                    }
                    _ => respond(
                        &mut stream,
                        r#"{"results":[{"id":"remote-id","metadata":{"sail_memory_id":"local-id","sail_updated_at":42}}]}"#,
                    ),
                }
            }
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0Hosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        assert!(provider.reconcile(&root, "project", &[memory()]).is_err());
        assert!(provider.reconcile(&root, "project", &[memory()]).is_ok());
        assert!(load_pending_events(&root, "project").unwrap().is_empty());
        server.join().unwrap();
        assert_eq!(adds.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hosted_add_polls_event_until_memory_is_visible() {
        let root = temporary();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for request_number in 0..5 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                match request_number {
                    0 => respond(&mut stream, r#"{"results":[]}"#),
                    1 => {
                        assert!(request.starts_with("POST /v3/memories/add/ HTTP/1.1"));
                        respond(&mut stream, r#"{"event_id":"event-1","status":"PENDING"}"#);
                    }
                    2 => respond(&mut stream, r#"{"status":"PENDING"}"#),
                    3 => respond(&mut stream, r#"{"status":"SUCCEEDED"}"#),
                    _ => respond(
                        &mut stream,
                        r#"{"results":[{"id":"remote-id","metadata":{"sail_memory_id":"local-id","sail_updated_at":42}}]}"#,
                    ),
                }
            }
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0Hosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        provider.reconcile(&root, "project", &[memory()]).unwrap();
        assert!(load_pending_events(&root, "project").unwrap().is_empty());
        server.join().unwrap();
    }

    #[test]
    fn hosted_unknown_submission_is_not_automatically_reposted() {
        let root = temporary();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let adds = Arc::new(AtomicUsize::new(0));
        let server_adds = adds.clone();
        let server = std::thread::spawn(move || {
            for request_number in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                if request_number == 1 {
                    assert!(request.starts_with("POST /v3/memories/add/ HTTP/1.1"));
                    server_adds.fetch_add(1, Ordering::SeqCst);
                    respond(&mut stream, r#"{"status":"PENDING"}"#);
                } else {
                    assert!(request.starts_with("POST /v3/memories/ HTTP/1.1"));
                    respond(&mut stream, r#"{"results":[]}"#);
                }
            }
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0Hosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        assert!(provider.reconcile(&root, "project", &[memory()]).is_err());
        let error = provider
            .reconcile(&root, "project", &[memory()])
            .unwrap_err();
        assert!(error.contains("unknown outcome"));
        server.join().unwrap();
        assert_eq!(adds.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn reconciliation_retry_does_not_duplicate_memory() {
        let root = temporary();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let adds = Arc::new(AtomicUsize::new(0));
        let server_adds = adds.clone();
        let server = std::thread::spawn(move || {
            for request_number in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                assert!(request.to_ascii_lowercase().contains("x-api-key: secret"));
                match request_number {
                    0 => {
                        assert!(request.starts_with("GET /memories?"));
                        respond(&mut stream, r#"{"results":[]}"#);
                    }
                    1 => {
                        assert!(request.starts_with("POST /memories HTTP/1.1"));
                        server_adds.fetch_add(1, Ordering::SeqCst);
                        respond(&mut stream, r#"{"results":[]}"#);
                    }
                    _ => {
                        assert!(request.starts_with("GET /memories?"));
                        respond(
                            &mut stream,
                            r#"{"results":[{"id":"remote-id","metadata":{"sail_memory_id":"local-id","sail_updated_at":42}}]}"#,
                        );
                    }
                }
            }
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0SelfHosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        provider.reconcile(&root, "project", &[memory()]).unwrap();
        provider.reconcile(&root, "project", &[memory()]).unwrap();
        server.join().unwrap();
        assert_eq!(adds.load(Ordering::SeqCst), 1);
    }

    #[test]
    fn hosted_reconciliation_pages_before_deciding_to_add() {
        let root = temporary();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            for page in 1..=2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                assert!(request.starts_with("POST /v3/memories/ HTTP/1.1"));
                assert!(request.contains(&format!("\"page\":{page}")));
                let results = if page == 1 {
                    (0..HOSTED_PAGE_SIZE)
                        .map(|index| json!({ "id": format!("unmanaged-{index}") }))
                        .collect::<Vec<_>>()
                } else {
                    vec![json!({
                        "id": "remote-id",
                        "metadata": {
                            "sail_memory_id": "local-id",
                            "sail_updated_at": 42
                        }
                    })]
                };
                respond(&mut stream, &json!({ "results": results }).to_string());
            }
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0Hosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        provider.reconcile(&root, "project", &[memory()]).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn self_hosted_full_page_fails_before_mutating_remote() {
        let root = temporary();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("GET /memories?"));
            assert!(request.contains(&format!("limit={SELF_HOSTED_SAFE_LIMIT}")));
            let results = (0..SELF_HOSTED_SAFE_LIMIT)
                .map(|index| json!({ "id": format!("unmanaged-{index}") }))
                .collect::<Vec<_>>();
            respond(&mut stream, &json!({ "results": results }).to_string());
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0SelfHosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        assert!(provider.reconcile(&root, "project", &[memory()]).is_err());
        server.join().unwrap();
    }

    #[test]
    fn standalone_search_reconciles_then_keeps_local_match_when_remote_is_empty() {
        let root = temporary();
        let settings = root.join("settings.json");
        let key = Uuid::new_v4().to_string();
        let local = remember_local(&root, &key);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        write_provider_settings(&settings, &key, &endpoint);
        session_credentials()
            .lock()
            .unwrap()
            .insert(key.clone(), "secret".into());
        let server = std::thread::spawn(move || {
            for request_number in 0..3 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                match request_number {
                    0 => {
                        assert!(request.starts_with("GET /memories?"));
                        respond(&mut stream, r#"{"results":[]}"#);
                    }
                    1 => {
                        assert!(request.starts_with("POST /memories HTTP/1.1"));
                        respond(&mut stream, r#"{"results":[]}"#);
                    }
                    _ => {
                        assert!(request.starts_with("POST /search HTTP/1.1"));
                        respond(&mut stream, r#"{"results":[]}"#);
                    }
                }
            }
        });
        let results = search_standalone(&root, &settings, &key, "concise", Some(10)).unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].memory.id, local.id);
        server.join().unwrap();
        session_credentials().lock().unwrap().remove(&key);
    }

    #[test]
    fn standalone_search_filters_memory_forgotten_during_remote_request() {
        let root = temporary();
        let settings = root.join("settings.json");
        let key = Uuid::new_v4().to_string();
        let local = remember_local(&root, &key);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        write_provider_settings(&settings, &key, &endpoint);
        session_credentials()
            .lock()
            .unwrap()
            .insert(key.clone(), "secret".into());
        let (search_started_tx, search_started_rx) = std::sync::mpsc::channel();
        let (continue_tx, continue_rx) = std::sync::mpsc::channel();
        let remote_id = local.id.clone();
        let remote_updated_at = local.updated_at;
        let server = std::thread::spawn(move || {
            for request_number in 0..2 {
                let (mut stream, _) = listener.accept().unwrap();
                let request = read_request(&mut stream);
                let body = json!({ "results": [{
                    "id": "remote-id",
                    "score": 0.9,
                    "metadata": {
                        "sail_memory_id": remote_id,
                        "sail_updated_at": remote_updated_at
                    }
                }] })
                .to_string();
                if request_number == 0 {
                    assert!(request.starts_with("GET /memories?"));
                    respond(&mut stream, &body);
                } else {
                    assert!(request.starts_with("POST /search HTTP/1.1"));
                    search_started_tx.send(()).unwrap();
                    continue_rx.recv().unwrap();
                    respond(&mut stream, &body);
                }
            }
        });
        let search_root = root.clone();
        let search_settings = settings.clone();
        let search_key = key.clone();
        let search = std::thread::spawn(move || {
            search_standalone(
                &search_root,
                &search_settings,
                &search_key,
                "concise",
                Some(10),
            )
        });
        search_started_rx.recv().unwrap();
        forget_at(&root, &key, &local.id).unwrap();
        continue_tx.send(()).unwrap();
        assert!(search.join().unwrap().unwrap().is_empty());
        server.join().unwrap();
        session_credentials().lock().unwrap().remove(&key);
    }

    #[test]
    fn self_hosted_capacity_fallback_is_visible_in_provider_status() {
        let root = temporary();
        let settings = root.join("settings.json");
        let key = Uuid::new_v4().to_string();
        let local = remember_local(&root, &key);
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}", listener.local_addr().unwrap());
        write_provider_settings(&settings, &key, &endpoint);
        session_credentials()
            .lock()
            .unwrap()
            .insert(key.clone(), "secret".into());
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let request = read_request(&mut stream);
            assert!(request.starts_with("GET /memories?"));
            let results = (0..SELF_HOSTED_SAFE_LIMIT)
                .map(|index| json!({ "id": format!("unmanaged-{index}") }))
                .collect::<Vec<_>>();
            respond(&mut stream, &json!({ "results": results }).to_string());
        });
        let results = search_standalone(&root, &settings, &key, "concise", Some(10)).unwrap();
        assert_eq!(results[0].memory.id, local.id);
        let status = load_runtime_status(&root, &key);
        let sync_error = status.sync_error.unwrap();
        assert!(
            sync_error.contains("reconciled safely"),
            "unexpected status: {sync_error}"
        );
        server.join().unwrap();
        session_credentials().lock().unwrap().remove(&key);
    }

    #[test]
    fn sync_loads_provider_config_only_after_serialization_lock() {
        let root = temporary();
        let settings = root.join("settings.json");
        let key = Uuid::new_v4().to_string();
        remember_local(&root, &key);
        write_provider_settings(&settings, &key, "http://127.0.0.1:1");
        let lock = provider_lock(&root, &key).unwrap();
        let thread_root = root.clone();
        let thread_settings = settings.clone();
        let thread_key = key.clone();
        let sync = std::thread::spawn(move || sync_at(&thread_root, &thread_settings, &thread_key));
        std::thread::sleep(std::time::Duration::from_millis(50));
        fs::write(&settings, "{}").unwrap();
        drop(lock);
        assert_eq!(sync.join().unwrap(), Ok(()));
    }
}
