use crate::memory::{MemoryRecord, MemorySearchResult};
use reqwest::blocking::{Client, Response};
use reqwest::{Method, StatusCode, Url};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::net::IpAddr;
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const CONFIG_PREFIX: &str = "sai-memory-provider:";
const CREDENTIAL_SERVICE: &str = "dev.sail.shared-memory.mem0";
const HOSTED_ENDPOINT: &str = "https://api.mem0.ai";
const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

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
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum CredentialStorage {
    Keychain,
    Memory,
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
    fn reconcile(&self, project_key: &str, memories: &[MemoryRecord]) -> Result<(), String>;
}

struct Mem0Provider {
    client: Client,
    kind: ProviderKind,
    endpoint: Url,
    api_key: String,
}

fn sync_locks() -> &'static Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>> {
    static LOCKS: OnceLock<Mutex<HashMap<String, std::sync::Arc<Mutex<()>>>>> = OnceLock::new();
    LOCKS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn session_credentials() -> &'static Mutex<HashMap<String, String>> {
    static CREDENTIALS: OnceLock<Mutex<HashMap<String, String>>> = OnceLock::new();
    CREDENTIALS.get_or_init(|| Mutex::new(HashMap::new()))
}

fn sync_lock(project_key: &str) -> Result<std::sync::Arc<Mutex<()>>, String> {
    let mut locks = sync_locks()
        .lock()
        .map_err(|_| "Memory provider synchronization is unavailable.".to_string())?;
    Ok(locks.entry(project_key.to_string()).or_default().clone())
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

fn load_api_key(project_key: &str) -> Result<String, String> {
    if let Ok(api_key) = credential(project_key).and_then(|entry| {
        entry
            .get_password()
            .map_err(|_| "Mem0 credentials are unavailable.".to_string())
    }) {
        return Ok(api_key);
    }
    session_credentials()
        .lock()
        .map_err(|_| "Mem0 credentials are unavailable.".to_string())?
        .get(project_key)
        .cloned()
        .ok_or_else(|| "Mem0 credentials are unavailable.".to_string())
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
    session_credentials().lock().ok().and_then(|credentials| {
        credentials
            .contains_key(project_key)
            .then_some(CredentialStorage::Memory)
    })
}

fn notice(storage: Option<CredentialStorage>) -> Option<String> {
    (storage == Some(CredentialStorage::Memory)).then(|| {
        "The OS credential store is unavailable. The API key is kept in memory for this Sail session only."
            .to_string()
    })
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

    fn list(&self, project_key: &str, limit: usize) -> Result<Vec<RemoteMemory>, String> {
        let value = match self.kind {
            ProviderKind::Mem0Hosted => {
                self.send(self.request(Method::POST, "/v3/memories/")?.json(&json!({
                    "filters": { "user_id": project_key },
                    "page": 1,
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
            ProviderKind::Local => return Ok(Vec::new()),
        };
        Ok(remote_memories(&value))
    }

    fn add(&self, project_key: &str, memory: &MemoryRecord) -> Result<(), String> {
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
        self.send(self.request(Method::POST, path)?.json(&body))?;
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
        self.list(project_key, 1).map(|_| ())
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

    fn reconcile(&self, project_key: &str, memories: &[MemoryRecord]) -> Result<(), String> {
        let remote = self.list(project_key, 1_000)?;
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
            self.add(project_key, memory)?;
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

fn sync(app: &tauri::AppHandle, directory: &str) -> Result<(), String> {
    let key = project_key(directory)?;
    let config = load_config(app, &key)?;
    if config.provider == ProviderKind::Local {
        return Ok(());
    }
    let lock = sync_lock(&key)?;
    let _guard = lock
        .lock()
        .map_err(|_| "Memory provider synchronization is unavailable.".to_string())?;
    let memories = crate::memory::list(app, directory, true)?;
    provider(&config, load_api_key(&key)?)?.reconcile(&key, &memories)
}

pub fn sync_later(app: tauri::AppHandle, directory: String) {
    std::thread::spawn(move || {
        let _ = sync(&app, &directory);
    });
}

pub fn search(
    app: &tauri::AppHandle,
    directory: &str,
    query: &str,
    limit: Option<usize>,
) -> Result<Vec<MemorySearchResult>, String> {
    let local = || crate::memory::search_local(app, directory, query, limit);
    let key = project_key(directory)?;
    let config = load_config(app, &key)?;
    if config.provider == ProviderKind::Local {
        return local();
    }
    let maximum = limit.unwrap_or(10).clamp(1, 100);
    let memories = crate::memory::list(app, directory, false)?;
    let canonical: HashMap<_, _> = memories
        .into_iter()
        .map(|memory| (memory.id.clone(), memory))
        .collect();
    remote_or_local(
        provider(&config, load_api_key(&key)?)
            .and_then(|provider| provider.search(&key, query, maximum))
            .map(|remote| map_remote_results(remote, &canonical, maximum)),
        local,
    )
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

fn remote_or_local<T>(
    remote: Result<T, String>,
    local: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    remote.or_else(|_| local())
}

#[tauri::command]
pub fn memory_provider_status(
    app: tauri::AppHandle,
    directory: String,
) -> Result<ProviderStatus, String> {
    let key = project_key(&directory)?;
    let config = load_config(&app, &key)?;
    let storage = credential_storage(&key);
    Ok(ProviderStatus {
        configured: config.provider != ProviderKind::Local,
        provider: config.provider,
        endpoint: config.endpoint,
        credential_storage: storage,
        notice: notice(storage),
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
    if config.provider == ProviderKind::Local {
        save_config(&app, &key, None)?;
        delete_api_key(&key);
        return Ok(ProviderStatus {
            provider: ProviderKind::Local,
            endpoint: None,
            configured: false,
            credential_storage: None,
            notice: None,
        });
    }
    let api_key = input
        .api_key
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or("A Mem0 API key is required.")?;
    provider(&config, api_key.to_string())?.verify(&key)?;
    let storage = store_api_key(&key, api_key)?;
    save_config(&app, &key, Some(&config))?;
    sync(&app, &directory)?;
    Ok(ProviderStatus {
        provider: config.provider,
        endpoint: config.endpoint,
        configured: true,
        credential_storage: Some(storage),
        notice: notice(Some(storage)),
    })
}

#[tauri::command]
pub fn sync_memory_provider(app: tauri::AppHandle, directory: String) -> Result<(), String> {
    sync(&app, &directory)
}

#[cfg(test)]
mod tests {
    use super::{
        normalize_config, remote_memories, remote_or_local, Mem0Provider, MemoryProvider,
        ProviderInput, ProviderKind,
    };
    use crate::memory::{MemoryKind, MemoryProvenance, MemoryRecord};
    use serde_json::json;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::atomic::{AtomicUsize, Ordering};
    use std::sync::Arc;

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
    fn provider_failure_uses_local_result() {
        let result = remote_or_local::<Vec<u8>>(Err("outage".into()), || Ok(vec![7])).unwrap();
        assert_eq!(result, vec![7]);
    }

    #[test]
    fn hosted_add_uses_v3_and_token_authentication() {
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
            respond(&mut stream, r#"{"results":[]}"#);
        });
        let provider = Mem0Provider {
            client: reqwest::blocking::Client::new(),
            kind: ProviderKind::Mem0Hosted,
            endpoint: reqwest::Url::parse(&endpoint).unwrap(),
            api_key: "secret".into(),
        };
        provider.add("project", &memory()).unwrap();
        server.join().unwrap();
    }

    #[test]
    fn reconciliation_retry_does_not_duplicate_memory() {
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
        provider.reconcile("project", &[memory()]).unwrap();
        provider.reconcile("project", &[memory()]).unwrap();
        server.join().unwrap();
        assert_eq!(adds.load(Ordering::SeqCst), 1);
    }
}
