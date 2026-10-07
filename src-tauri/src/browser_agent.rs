use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet};
use std::io::{BufRead, BufReader, Write};
use std::net::{TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager, State};
use uuid::Uuid;

#[derive(Clone)]
struct Page {
    directory: PathBuf,
    pane_id: String,
    label: String,
    loaded_url: Option<String>,
}

#[derive(Clone)]
struct PaneRef {
    directory: PathBuf,
    id: String,
}

struct Client {
    directory: PathBuf,
    session: Option<String>,
    agent: Option<String>,
}

#[derive(Default)]
struct Inner {
    port: Mutex<u16>,
    pages: Mutex<Vec<Page>>,
    page_ready: Condvar,
    panes: Mutex<Vec<PaneRef>>,
    clients: Mutex<HashMap<String, Client>>,
    targets: Mutex<HashMap<String, String>>,
    guards: Mutex<HashMap<String, String>>,
    blocked: Mutex<HashMap<String, String>>,
    grants: Mutex<HashSet<String>>,
    origins: Mutex<HashSet<(String, String)>>,
    pending: Mutex<HashMap<String, mpsc::Sender<bool>>>,
    coordination: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    policies: Mutex<HashMap<PathBuf, bool>>,
    pickers: Mutex<HashSet<String>>,
}

#[derive(Clone, Default)]
pub struct BrowserManager(Arc<Inner>);

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct AccessRequest {
    id: String,
    session_id: String,
    directory: String,
    origin: Option<String>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct NavigateRequest {
    pane_id: String,
    url: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct CoordinationRequest {
    id: String,
    session_id: String,
    source_agent: Option<String>,
    directory: String,
    name: String,
    arguments: Value,
    expires_at: u64,
}

#[derive(Clone, Serialize)]
struct ActionEvent {
    label: String,
    action: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolRequest {
    token: String,
    session_id: Option<String>,
    name: String,
    arguments: Value,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct McpConfig {
    pub command: String,
    pub args: Vec<String>,
    pub env: HashMap<String, String>,
    pub token: String,
}

impl BrowserManager {
    pub fn config(
        &self,
        directory: &str,
        session: Option<&str>,
        agent: Option<&str>,
    ) -> Result<McpConfig, String> {
        let directory = PathBuf::from(directory)
            .canonicalize()
            .map_err(|error| format!("Cannot find browser project: {error}"))?;
        let token = Uuid::new_v4().to_string();
        self.0
            .clients
            .lock()
            .map_err(|error| error.to_string())?
            .insert(
                token.clone(),
                Client {
                    directory,
                    session: session.map(str::to_string),
                    agent: agent.map(str::to_string),
                },
            );
        let port = *self.0.port.lock().map_err(|error| error.to_string())?;
        if port == 0 {
            return Err("Browser tool bridge is unavailable.".into());
        }
        Ok(McpConfig {
            command: std::env::current_exe()
                .map_err(|error| error.to_string())?
                .to_string_lossy()
                .into_owned(),
            args: vec!["--browser-mcp".into()],
            env: HashMap::from([
                ("SAIL_BROWSER_PORT".into(), port.to_string()),
                ("SAIL_BROWSER_TOKEN".into(), token.clone()),
            ]),
            token,
        })
    }

    pub fn identify(&self, token: &str, session: &str) {
        if let Ok(mut clients) = self.0.clients.lock() {
            if let Some(client) = clients.get_mut(token) {
                client.session = Some(session.to_string());
            }
        }
    }

    pub fn register(&self, directory: &str, pane_id: &str, label: &str) -> Result<(), String> {
        let directory = PathBuf::from(directory)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut pages = self.0.pages.lock().map_err(|error| error.to_string())?;
        pages.retain(|page| page.label != label);
        pages.push(Page {
            directory,
            pane_id: pane_id.to_string(),
            label: label.to_string(),
            loaded_url: None,
        });
        self.0.page_ready.notify_all();
        Ok(())
    }

    pub fn loaded(&self, label: &str, url: &str) {
        if let Ok(mut pages) = self.0.pages.lock() {
            if let Some(page) = pages.iter_mut().find(|page| page.label == label) {
                page.loaded_url = Some(url.to_string());
                self.0.page_ready.notify_all();
            }
        }
    }

    pub fn allow_navigation(&self, pane_id: &str, url: &tauri::Url) -> bool {
        let allowed = match self.0.guards.lock() {
            Ok(guards) => guards.get(pane_id).cloned(),
            Err(_) => return false,
        };
        let Some(allowed) = allowed else {
            return true;
        };
        if url.origin().ascii_serialization() == allowed {
            return true;
        }
        if let Ok(mut blocked) = self.0.blocked.lock() {
            blocked.insert(pane_id.to_string(), url.to_string());
        }
        self.0.page_ready.notify_all();
        false
    }

    fn blocked_navigation(&self, pane_id: &str) -> Result<(), String> {
        if let Some(url) = self
            .0
            .blocked
            .lock()
            .map_err(|error| error.to_string())?
            .remove(pane_id)
        {
            return Err(format!(
                "External navigation to {url} needs approval. Use the navigate tool with that URL."
            ));
        }
        Ok(())
    }

    pub fn clear_guard(&self, label: &str) {
        if let Ok(pages) = self.0.pages.lock() {
            if let Some(page) = pages.iter().find(|page| page.label == label) {
                if let Ok(mut guards) = self.0.guards.lock() {
                    guards.remove(&page.pane_id);
                }
                if let Ok(mut blocked) = self.0.blocked.lock() {
                    blocked.remove(&page.pane_id);
                }
            }
        }
    }

    fn guard(&self, pane_id: &str, origin: String) -> Result<(), String> {
        self.0
            .blocked
            .lock()
            .map_err(|error| error.to_string())?
            .remove(pane_id);
        self.0
            .guards
            .lock()
            .map_err(|error| error.to_string())?
            .insert(pane_id.to_string(), origin);
        Ok(())
    }

    fn loading(&self, label: &str) {
        if let Ok(mut pages) = self.0.pages.lock() {
            if let Some(page) = pages.iter_mut().find(|page| page.label == label) {
                page.loaded_url = None;
            }
        }
    }

    fn wait_loaded(&self, pane_id: &str) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(20);
        let mut pages = self.0.pages.lock().map_err(|error| error.to_string())?;
        loop {
            self.blocked_navigation(pane_id)?;
            if pages
                .iter()
                .rev()
                .find(|page| page.pane_id == pane_id)
                .is_some_and(|page| page.loaded_url.is_some())
            {
                return Ok(());
            }
            let remaining = deadline.saturating_duration_since(Instant::now());
            if remaining.is_zero() {
                return Err("Browser page did not finish loading. Check the browser pane.".into());
            }
            let (next, _) = self
                .0
                .page_ready
                .wait_timeout(pages, remaining)
                .map_err(|error| error.to_string())?;
            pages = next;
        }
    }

    pub fn unregister(&self, label: &str) {
        self.cancel_picker(label);
        if let Ok(mut pages) = self.0.pages.lock() {
            let pane_id = pages
                .iter()
                .find(|page| page.label == label)
                .map(|page| page.pane_id.clone());
            pages.retain(|page| page.label != label);
            if let Some(pane_id) = pane_id {
                if let Ok(mut guards) = self.0.guards.lock() {
                    guards.remove(&pane_id);
                }
                if let Ok(mut blocked) = self.0.blocked.lock() {
                    blocked.remove(&pane_id);
                }
            }
            self.0.page_ready.notify_all();
        }
    }

    pub fn set_picker(&self, label: &str, enabled: bool) -> Result<(), String> {
        let mut pickers = self.0.pickers.lock().map_err(|error| error.to_string())?;
        if enabled {
            pickers.insert(label.to_string());
        } else {
            pickers.remove(label);
        }
        Ok(())
    }

    pub fn take_picker(&self, label: &str) -> Result<(), String> {
        if self
            .0
            .pickers
            .lock()
            .map_err(|error| error.to_string())?
            .remove(label)
        {
            Ok(())
        } else {
            Err("Element picker is not active".to_string())
        }
    }

    pub fn cancel_picker(&self, label: &str) {
        if let Ok(mut pickers) = self.0.pickers.lock() {
            pickers.remove(label);
        }
    }

    pub fn pane(&self, directory: &str, id: &str, open: bool) -> Result<(), String> {
        let directory = PathBuf::from(directory)
            .canonicalize()
            .map_err(|error| error.to_string())?;
        let mut panes = self.0.panes.lock().map_err(|error| error.to_string())?;
        panes.retain(|pane| pane.directory != directory || pane.id != id);
        if open {
            panes.push(PaneRef {
                directory,
                id: id.to_string(),
            });
        }
        Ok(())
    }

    pub fn focus(&self, label: &str) {
        if let Ok(mut pages) = self.0.pages.lock() {
            if let Some(index) = pages.iter().position(|page| page.label == label) {
                let page = pages.remove(index);
                pages.push(page);
            }
        }
    }

    fn ask(
        &self,
        app: &AppHandle,
        session: &str,
        directory: &Path,
        origin: Option<&str>,
    ) -> Result<(), String> {
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        self.0
            .pending
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id.clone(), sender);
        let event = AccessRequest {
            id: id.clone(),
            session_id: session.to_string(),
            directory: directory.to_string_lossy().into_owned(),
            origin: origin.map(str::to_string),
        };
        if let Err(error) = app.emit_to("main", "browser:access-request", event) {
            self.0
                .pending
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&id));
            return Err(error.to_string());
        }
        let granted = receiver
            .recv_timeout(Duration::from_secs(120))
            .unwrap_or(false);
        self.0
            .pending
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&id));
        if granted {
            Ok(())
        } else {
            Err("Browser access was denied or timed out.".into())
        }
    }

    fn authorize(
        &self,
        app: &AppHandle,
        token: &str,
        session: &str,
        directory: &Path,
        origin: Option<&str>,
    ) -> Result<(), String> {
        let policy = self
            .0
            .policies
            .lock()
            .map_err(|error| error.to_string())?
            .get(directory)
            .copied();
        if policy == Some(false)
            || (policy.is_none()
                && crate::settings::load_settings(app.clone())?
                    .get(&format!("sai-browser-disabled:{}", directory.display()))
                    .is_some_and(|value| value == "true"))
        {
            return Err("Agent browser access is disabled for this project.".into());
        }
        let key = format!("{token}:{session}");
        if !self
            .0
            .grants
            .lock()
            .map_err(|error| error.to_string())?
            .contains(&key)
        {
            self.ask(app, session, directory, None)?;
            self.0
                .grants
                .lock()
                .map_err(|error| error.to_string())?
                .insert(key.clone());
        }
        if let Some(origin) = origin {
            let origin_key = (key, origin.to_string());
            if !self
                .0
                .origins
                .lock()
                .map_err(|error| error.to_string())?
                .contains(&origin_key)
            {
                self.ask(app, session, directory, Some(origin))?;
                self.0
                    .origins
                    .lock()
                    .map_err(|error| error.to_string())?
                    .insert(origin_key);
            }
        }
        if self
            .0
            .policies
            .lock()
            .map_err(|error| error.to_string())?
            .get(directory)
            == Some(&false)
        {
            return Err("Agent browser access is disabled for this project.".into());
        }
        Ok(())
    }

    fn coordinate(
        &self,
        app: &AppHandle,
        session: &str,
        source_agent: Option<&str>,
        directory: &Path,
        name: &str,
        arguments: Value,
    ) -> Result<Value, String> {
        let setting = match name {
            "worktree_create" | "worktree_list" | "worktree_info" | "agent_spawn"
            | "validation_gate" | "agent_status" | "agent_wait" | "agent_result"
            | "terminal_list" | "terminal_read" | "terminal_wait" => {
                Some("sai-agent-worktrees-enabled")
            }
            "terminal_create" | "terminal_write" | "terminal_stop" => {
                Some("sai-agent-terminals-enabled")
            }
            "worktree_status" => Some("sai-agent-status-enabled"),
            "project_threads" => Some("sai-agent-thread-list-enabled"),
            "thread_message" => Some("sai-agent-messages-enabled"),
            // Progress belongs to the owning Ship run and must remain available when
            // cross-validation and other coordination actions are disabled.
            "ship_progress"
            | "task_checkpoint_read"
            | "task_checkpoint_update"
            | "task_evidence_record"
            | "validation_policy" => None,
            _ => return Err("Unknown coordination action.".into()),
        };
        let settings = crate::settings::load_settings(app.clone())?;
        if let Some(setting) = setting {
            let enabled = settings.get(setting).is_some_and(|value| value == "true");
            if (setting == "sai-agent-terminals-enabled" && !enabled)
                || (setting != "sai-agent-terminals-enabled"
                    && settings.get(setting).is_some_and(|value| value == "false"))
            {
                return Err("This agent coordination action is disabled in settings.".into());
            }
        }
        let id = Uuid::new_v4().to_string();
        let (sender, receiver) = mpsc::channel();
        self.0
            .coordination
            .lock()
            .map_err(|error| error.to_string())?
            .insert(id.clone(), sender);
        let event = CoordinationRequest {
            id: id.clone(),
            session_id: session.to_string(),
            source_agent: source_agent.map(str::to_string),
            directory: directory.to_string_lossy().into_owned(),
            name: name.to_string(),
            arguments,
            expires_at: std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_err(|error| error.to_string())?
                .as_millis() as u64
                + 110_000,
        };
        if let Err(error) = app.emit_to("main", "agent:coordination-request", event) {
            self.0
                .coordination
                .lock()
                .ok()
                .and_then(|mut map| map.remove(&id));
            return Err(error.to_string());
        }
        let response = receiver.recv_timeout(Duration::from_secs(300));
        self.0
            .coordination
            .lock()
            .ok()
            .and_then(|mut map| map.remove(&id));
        let response = response.map_err(|_| "Agent coordination request timed out.".to_string())?;
        if let Some(error) = response.get("error").and_then(Value::as_str) {
            return Err(error.to_string());
        }
        Ok(response.get("value").cloned().unwrap_or(Value::Null))
    }

    fn perform(&self, app: &AppHandle, request: ToolRequest) -> Result<Value, String> {
        let clients = self.0.clients.lock().map_err(|error| error.to_string())?;
        let client = clients
            .get(&request.token)
            .ok_or("Unknown browser tool connection.")?;
        if matches!(
            request.name.as_str(),
            "terminal_create" | "terminal_write" | "terminal_stop"
        ) && (client.session.is_none() || client.agent.is_none())
        {
            return Err("Terminal control requires a session-bound agent connection.".into());
        }
        let directory = client.directory.clone();
        let source_agent = client.agent.clone();
        let session = request.session_id.as_deref();
        let session = client
            .session
            .as_deref()
            .or(session)
            .unwrap_or(&request.token)
            .to_string();
        drop(clients);
        if matches!(
            request.name.as_str(),
            "worktree_create"
                | "worktree_list"
                | "worktree_info"
                | "agent_spawn"
                | "validation_policy"
                | "validation_gate"
                | "ship_progress"
                | "task_checkpoint_read"
                | "task_checkpoint_update"
                | "task_evidence_record"
                | "agent_status"
                | "agent_wait"
                | "agent_result"
                | "terminal_list"
                | "terminal_read"
                | "terminal_wait"
                | "terminal_create"
                | "terminal_write"
                | "terminal_stop"
                | "worktree_status"
                | "project_threads"
                | "thread_message"
        ) {
            return self.coordinate(
                app,
                &session,
                source_agent.as_deref(),
                &directory,
                &request.name,
                request.arguments,
            );
        }
        let target_key = format!("{}:{session}", request.token);
        let chosen_pane = self
            .0
            .targets
            .lock()
            .map_err(|error| error.to_string())?
            .get(&target_key)
            .cloned();
        if request.name == "navigate" {
            let target = required(&request.arguments, "url")?;
            let url = tauri::Url::parse(target).map_err(|error| error.to_string())?;
            if !["http", "https"].contains(&url.scheme()) {
                return Err("Browser URL must use HTTP or HTTPS.".into());
            }
            let has_page = self
                .0
                .pages
                .lock()
                .map_err(|error| error.to_string())?
                .iter()
                .any(|page| page.directory == directory);
            let has_pane = self
                .0
                .panes
                .lock()
                .map_err(|error| error.to_string())?
                .iter()
                .any(|pane| pane.directory == directory);
            if !has_page && !has_pane {
                return Err(
                    "No browser pane is open in this worktree. Open a browser pane first.".into(),
                );
            }
            let external = match url.host_str() {
                Some("localhost" | "127.0.0.1" | "::1") => None,
                _ => Some(url.origin().ascii_serialization()),
            };
            self.authorize(
                app,
                &request.token,
                &session,
                &directory,
                external.as_deref(),
            )?;
            let page = self
                .0
                .pages
                .lock()
                .map_err(|error| error.to_string())?
                .iter()
                .rev()
                .find(|page| {
                    page.directory == directory
                        && chosen_pane.as_ref().is_none_or(|id| &page.pane_id == id)
                })
                .cloned();
            let pane_id;
            if let Some(page) = page {
                pane_id = page.pane_id.clone();
                let webview = app
                    .get_webview(&page.label)
                    .ok_or("Browser pane is closed.")?;
                self.loading(&page.label);
                self.guard(&pane_id, url.origin().ascii_serialization())?;
                let _ = app.emit_to(
                    "main",
                    "browser:agent-action",
                    ActionEvent {
                        label: page.label,
                        action: request.name.clone(),
                    },
                );
                webview.navigate(url).map_err(|error| error.to_string())?;
                self.0
                    .targets
                    .lock()
                    .map_err(|error| error.to_string())?
                    .insert(target_key, pane_id.clone());
                if let Err(error) = self.wait_loaded(&pane_id) {
                    if let Some(previous) = page.loaded_url {
                        if let Ok(previous) = tauri::Url::parse(&previous) {
                            self.guard(&pane_id, previous.origin().ascii_serialization())?;
                            webview
                                .navigate(previous)
                                .map_err(|cause| cause.to_string())?;
                            self.wait_loaded(&pane_id)?;
                        }
                    }
                    return Err(error);
                }
                return Ok(json!({"url":target}));
            } else {
                let pane = self
                    .0
                    .panes
                    .lock()
                    .map_err(|error| error.to_string())?
                    .iter()
                    .rev()
                    .find(|pane| {
                        pane.directory == directory
                            && chosen_pane.as_ref().is_none_or(|id| &pane.id == id)
                    })
                    .cloned()
                    .ok_or(
                        "No browser pane is open in this worktree. Open a browser pane first.",
                    )?;
                pane_id = pane.id.clone();
                self.guard(&pane_id, url.origin().ascii_serialization())?;
                app.emit_to(
                    "main",
                    "browser:agent-navigate",
                    NavigateRequest {
                        pane_id: pane.id,
                        url: target.to_string(),
                    },
                )
                .map_err(|error| error.to_string())?;
            }
            self.0
                .targets
                .lock()
                .map_err(|error| error.to_string())?
                .insert(target_key, pane_id.clone());
            self.wait_loaded(&pane_id)?;
            return Ok(json!({"url":target}));
        }
        let page = self
            .0
            .pages
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .rev()
            .find(|page| {
                page.directory == directory
                    && chosen_pane.as_ref().is_none_or(|id| &page.pane_id == id)
            })
            .cloned()
            .ok_or("No browser pane is open in this worktree. Open a browser pane first.")?;
        self.blocked_navigation(&page.pane_id)?;
        self.0
            .targets
            .lock()
            .map_err(|error| error.to_string())?
            .insert(target_key, page.pane_id.clone());
        let webview = app
            .get_webview(&page.label)
            .ok_or("Browser pane is closed. Open a browser pane first.")?;
        let target = page
            .loaded_url
            .as_deref()
            .ok_or("Browser page has not loaded. Navigate to an approved URL first.")?;
        let url = tauri::Url::parse(target).map_err(|error| error.to_string())?;
        if !["http", "https"].contains(&url.scheme()) {
            return Err("Browser URL must use HTTP or HTTPS.".into());
        }
        let external = match url.host_str() {
            Some("localhost" | "127.0.0.1" | "::1") => None,
            _ => Some(url.origin().ascii_serialization()),
        };
        self.authorize(
            app,
            &request.token,
            &session,
            &directory,
            external.as_deref(),
        )?;
        if request.name == "run_script" {
            self.authorize(
                app,
                &request.token,
                &session,
                &directory,
                Some("external sites through page actions"),
            )?;
        }
        if matches!(request.name.as_str(), "click" | "type") {
            self.guard(&page.pane_id, url.origin().ascii_serialization())?;
        }
        let _ = app.emit_to(
            "main",
            "browser:agent-action",
            ActionEvent {
                label: page.label.clone(),
                action: request.name.clone(),
            },
        );
        let result = match request.name.as_str() {
            "read_page" => evaluate(&webview, "({title:document.title,url:location.href,text:document.body?.innerText.slice(0,50000)??''})"),
            "click" => {
                let selector = required(&request.arguments, "selector")?;
                evaluate(&webview, &format!("(()=>{{const el=document.querySelector({});if(!el)throw Error('Element not found');el.scrollIntoView();el.click();return {{clicked:true,url:location.href}}}})()", json!(selector)))
            }
            "type" => {
                let selector = required(&request.arguments, "selector")?;
                let value = required(&request.arguments, "text")?;
                evaluate(&webview, &format!("(()=>{{const el=document.querySelector({});if(!el)throw Error('Element not found');el.focus();if('value' in el){{const setter=Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el),'value')?.set;setter?.call(el,{});el.dispatchEvent(new Event('input',{{bubbles:true}}));el.dispatchEvent(new Event('change',{{bubbles:true}}));}}else if(el.isContentEditable){{el.textContent={};el.dispatchEvent(new InputEvent('input',{{bubbles:true}}));}}else throw Error('Element is not editable');return {{typed:true}}}})()", json!(selector), json!(value), json!(value)))
            }
            "run_script" => {
                let script = required(&request.arguments, "script")?;
                evaluate(&webview, &format!("(()=>{{{script}}})()"))
            }
            "screenshot" => {
                let png = screenshot(&webview)?;
                if png.len() > 20 * 1024 * 1024 {
                    return Err("Browser snapshot exceeds 20 MiB.".into());
                }
                Ok(json!({"content":[{"type":"image","data":base64::engine::general_purpose::STANDARD.encode(png),"mimeType":"image/png"}]}))
            }
            _ => Err("Unknown browser action.".into()),
        };
        self.blocked_navigation(&page.pane_id)?;
        result
    }
}

fn required<'a>(value: &'a Value, name: &str) -> Result<&'a str, String> {
    value
        .get(name)
        .and_then(Value::as_str)
        .ok_or_else(|| format!("{name} is required"))
}

fn evaluate(webview: &tauri::Webview, script: &str) -> Result<Value, String> {
    let script = format!("(()=>{{try{{return {{ok:true,value:{script}}}}}catch(error){{return {{ok:false,error:String(error)}}}}}})()");
    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .eval_with_callback(script, move |result| {
            let _ = sender.send(result);
        })
        .map_err(|error| error.to_string())?;
    let result = receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Browser script timed out.".to_string())?;
    let result: Value = serde_json::from_str(&result).map_err(|error| error.to_string())?;
    if result.get("ok") == Some(&Value::Bool(false)) {
        return Err(result
            .get("error")
            .and_then(Value::as_str)
            .unwrap_or("Browser script failed.")
            .to_string());
    }
    Ok(result.get("value").cloned().unwrap_or(Value::Null))
}

#[cfg(target_os = "macos")]
pub(crate) fn screenshot(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use objc2::runtime::AnyObject;
    use objc2::AnyThread;
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSBitmapImageRepPropertyKey, NSImage,
    };
    use objc2_foundation::NSDictionary;
    use objc2_web_kit::WKWebView;

    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let block = block2::RcBlock::new(move |image: *mut NSImage, _error| {
                let result = (|| -> Result<Vec<u8>, String> {
                    let image = unsafe { image.as_ref() }.ok_or("Browser snapshot failed.")?;
                    let tiff = image
                        .TIFFRepresentation()
                        .ok_or("Browser snapshot is empty.")?;
                    let bitmap = NSBitmapImageRep::initWithData(NSBitmapImageRep::alloc(), &tiff)
                        .ok_or("Cannot encode browser snapshot.")?;
                    let properties = NSDictionary::<NSBitmapImageRepPropertyKey, AnyObject>::new();
                    let png = unsafe {
                        bitmap.representationUsingType_properties(
                            NSBitmapImageFileType::PNG,
                            &properties,
                        )
                    }
                    .ok_or("Cannot encode browser snapshot as PNG.")?;
                    Ok(png.to_vec())
                })();
                let _ = sender.send(result);
            });
            let view = unsafe { &*(platform.inner() as *const WKWebView) };
            unsafe { view.takeSnapshotWithConfiguration_completionHandler(None, &block) };
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Browser snapshot timed out.".to_string())?
}

#[cfg(target_os = "linux")]
pub(crate) fn screenshot(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use webkit2gtk::WebViewExt;

    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            platform.inner().snapshot(
                webkit2gtk::SnapshotRegion::Visible,
                webkit2gtk::SnapshotOptions::NONE,
                None::<&webkit2gtk::gio::Cancellable>,
                move |result| {
                    let result = result
                        .map_err(|error| error.to_string())
                        .and_then(|surface| {
                            let mut png = Vec::new();
                            surface
                                .write_to_png(&mut png)
                                .map_err(|error| error.to_string())?;
                            Ok(png)
                        });
                    let _ = sender.send(result);
                },
            );
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Browser snapshot timed out.".to_string())?
}

#[cfg(windows)]
pub(crate) fn screenshot(webview: &tauri::Webview) -> Result<Vec<u8>, String> {
    use webview2_com::{
        CapturePreviewCompletedHandler,
        Microsoft::Web::WebView2::Win32::COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
    };
    use windows::Win32::Foundation::HGLOBAL;
    use windows::Win32::System::Com::{
        StructuredStorage::CreateStreamOnHGlobal, STREAM_SEEK_END, STREAM_SEEK_SET,
    };

    let (sender, receiver) = mpsc::sync_channel(1);
    webview
        .with_webview(move |platform| {
            let result = (|| -> Result<(), String> {
                let controller = platform.controller();
                let core =
                    unsafe { controller.CoreWebView2() }.map_err(|error| error.to_string())?;
                let stream = unsafe { CreateStreamOnHGlobal(HGLOBAL(std::ptr::null_mut()), true) }
                    .map_err(|error| error.to_string())?;
                let capture = stream.clone();
                let callback_sender = sender.clone();
                let handler = CapturePreviewCompletedHandler::create(Box::new(move |status| {
                    let result = (|| -> Result<Vec<u8>, String> {
                        status.map_err(|error| error.to_string())?;
                        let mut length = 0u64;
                        unsafe { capture.Seek(0, STREAM_SEEK_END, Some(&mut length)) }
                            .map_err(|error| error.to_string())?;
                        if length > 20 * 1024 * 1024 {
                            return Err("Browser snapshot exceeds 20 MiB.".into());
                        }
                        unsafe { capture.Seek(0, STREAM_SEEK_SET, None) }
                            .map_err(|error| error.to_string())?;
                        let mut png = vec![0u8; length as usize];
                        let mut read = 0u32;
                        unsafe {
                            capture.Read(png.as_mut_ptr().cast(), png.len() as u32, Some(&mut read))
                        }
                        .ok()
                        .map_err(|error| error.to_string())?;
                        png.truncate(read as usize);
                        Ok(png)
                    })();
                    let _ = callback_sender.send(result);
                    Ok(())
                }));
                unsafe {
                    core.CapturePreview(
                        COREWEBVIEW2_CAPTURE_PREVIEW_IMAGE_FORMAT_PNG,
                        &stream,
                        &handler,
                    )
                }
                .map_err(|error| error.to_string())?;
                Ok(())
            })();
            if let Err(error) = result {
                let _ = sender.send(Err(error));
            }
        })
        .map_err(|error| error.to_string())?;
    receiver
        .recv_timeout(Duration::from_secs(15))
        .map_err(|_| "Browser snapshot timed out.".to_string())?
}

pub fn start_bridge(app: &AppHandle) -> Result<(), Box<dyn std::error::Error>> {
    let listener = TcpListener::bind(("127.0.0.1", 0))?;
    let manager = app.state::<BrowserManager>().inner().clone();
    *manager.0.port.lock().map_err(|error| error.to_string())? = listener.local_addr()?.port();
    let app = app.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let manager = manager.clone();
            let app = app.clone();
            std::thread::spawn(move || handle_stream(&manager, &app, stream));
        }
    });
    Ok(())
}

fn handle_stream(manager: &BrowserManager, app: &AppHandle, mut stream: TcpStream) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(30)));
    let mut line = String::new();
    let result = BufReader::new(&mut stream).read_line(&mut line);
    let response = match result {
        Ok(size) if size > 0 && size < 256 * 1024 => {
            match serde_json::from_str::<ToolRequest>(&line) {
                Ok(request) => {
                    let image = request.name == "screenshot";
                    match manager.perform(app, request) {
                        Ok(value) if image => value,
                        Ok(value) => json!({"content":[{"type":"text","text":value.to_string()}]}),
                        Err(error) => {
                            json!({"content":[{"type":"text","text":error}],"isError":true})
                        }
                    }
                }
                Err(error) => {
                    json!({"content":[{"type":"text","text":error.to_string()}],"isError":true})
                }
            }
        }
        _ => {
            json!({"content":[{"type":"text","text":"Invalid browser tool request."}],"isError":true})
        }
    };
    let _ = serde_json::to_writer(&mut stream, &response);
    let _ = stream.write_all(b"\n");
}

#[tauri::command]
pub fn browser_access_reply(
    manager: State<'_, BrowserManager>,
    id: String,
    allow: bool,
) -> Result<(), String> {
    if let Some(sender) = manager
        .0
        .pending
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id)
    {
        let _ = sender.send(allow);
    }
    Ok(())
}

#[tauri::command]
pub fn agent_coordination_reply(
    manager: State<'_, BrowserManager>,
    id: String,
    result: Value,
) -> Result<(), String> {
    if let Some(sender) = manager
        .0
        .coordination
        .lock()
        .map_err(|error| error.to_string())?
        .remove(&id)
    {
        let _ = sender.send(result);
    }
    Ok(())
}

#[tauri::command]
pub fn browser_project_access(
    manager: State<'_, BrowserManager>,
    directory: String,
    enabled: bool,
) -> Result<(), String> {
    let directory = PathBuf::from(directory)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    let mut policies = manager
        .0
        .policies
        .lock()
        .map_err(|error| error.to_string())?;
    policies.insert(directory, enabled);
    Ok(())
}

#[tauri::command]
pub fn browser_mcp_config(
    manager: State<'_, BrowserManager>,
    directory: String,
    session: Option<String>,
    agent: Option<String>,
) -> Result<McpConfig, String> {
    manager.config(&directory, session.as_deref(), agent.as_deref())
}

#[tauri::command]
pub fn browser_pane_register(
    manager: State<'_, BrowserManager>,
    directory: String,
    pane_id: String,
    open: bool,
) -> Result<(), String> {
    manager.pane(&directory, &pane_id, open)
}

const SAIL_SKILL: &str = include_str!("../../skills/sail/SKILL.md");
const SHIP_IT_SKILL: &str = include_str!("../../skills/ship-it/SKILL.md");
const SHIP_IT_REFERENCES: &[(&str, &str)] = &[
    (
        "inputs.md",
        include_str!("../../skills/ship-it/references/inputs.md"),
    ),
    (
        "fallbacks.md",
        include_str!("../../skills/ship-it/references/fallbacks.md"),
    ),
    (
        "pr-loop.md",
        include_str!("../../skills/ship-it/references/pr-loop.md"),
    ),
];
const ADVERSARIAL_REVIEW_SKILL: &str = include_str!("../../skills/adversarial-review/SKILL.md");
const ADVERSARIAL_REVIEW_REFERENCES: &[(&str, &str)] = &[
    (
        "code-adversary.md",
        include_str!("../../skills/adversarial-review/references/code-adversary.md"),
    ),
    (
        "findings-adversary.md",
        include_str!("../../skills/adversarial-review/references/findings-adversary.md"),
    ),
];
const ADVERSARIAL_TEST_SKILL: &str = include_str!("../../skills/adversarial-test/SKILL.md");
const ADVERSARIAL_TEST_REFERENCES: &[(&str, &str)] = &[(
    "test-adversary.md",
    include_str!("../../skills/adversarial-test/references/test-adversary.md"),
)];

fn bundled_skill(name: &str) -> Option<(&'static str, &'static [(&'static str, &'static str)])> {
    match name {
        "ship-it" => Some((SHIP_IT_SKILL, SHIP_IT_REFERENCES)),
        "adversarial-review" => Some((ADVERSARIAL_REVIEW_SKILL, ADVERSARIAL_REVIEW_REFERENCES)),
        "adversarial-test" => Some((ADVERSARIAL_TEST_SKILL, ADVERSARIAL_TEST_REFERENCES)),
        _ => None,
    }
}

fn content_version(content: &str) -> String {
    let digest = Sha256::digest(content.as_bytes());
    format!(
        "sha256:{}",
        digest
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect::<String>()
    )
}

fn skill_reference(arguments: &Value) -> Result<Value, String> {
    let skill = required(arguments, "skill")?;
    let (core, references) = bundled_skill(skill).ok_or("Unknown bundled skill.")?;
    let reference = match arguments.get("reference") {
        None => {
            return Ok(json!({
            "content":[{"type":"text","text":format!(
                "Bundled skill: {skill}\nCore version: {}\nReferences:\n{}",
                content_version(core),
                references.iter().map(|(name, content)| format!("- {name} ({})", content_version(content))).collect::<Vec<_>>().join("\n")
            )}],
            "structuredContent":{
                "skill":skill,
                "coreVersion":content_version(core),
                "references":references.iter().map(|(name, content)| json!({"name":name,"version":content_version(content)})).collect::<Vec<_>>()
            }
            }));
        }
        Some(Value::String(reference)) => reference.as_str(),
        Some(_) => return Err("Bundled skill reference must be a string.".into()),
    };
    let (_, content) = references
        .iter()
        .find(|(name, _)| *name == reference)
        .ok_or("Unknown bundled skill reference.")?;
    let core_version = content_version(core);
    let version = content_version(content);
    Ok(json!({
        "content":[{"type":"text","text":format!(
            "Bundled skill: {skill}\nCore version: {core_version}\nReference: {reference}\nReference version: {version}\n\n{content}"
        )}],
        "structuredContent":{
            "skill":skill,
            "coreVersion":core_version,
            "reference":reference,
            "version":version
        }
    }))
}

const TOOLS: &[(&str, &str, &str)] = &[
    (
        "sail_skill",
        "Read the Sail skill for using this session's worktree, agent, terminal, thread, and embedded browser tools.",
        "",
    ),
    (
        "skill_reference",
        "List or load an offline bundled workflow reference. Responses include the exact SHA-256 content version; calls remain visible in the task transcript.",
        "skill",
    ),
    (
        "worktree_list",
        "List this project's main checkout and known worktrees with their live state and known agent threads.",
        "",
    ),
    (
        "worktree_info",
        "Inspect one known worktree in this project by its path from worktree_list.",
        "path",
    ),
    (
        "worktree_create",
        "Ask the user to create a worktree, start a new agent thread there, and send its starting prompt.",
        "name,prompt",
    ),
    (
        "agent_spawn",
        "Start Claude, Codex, or OpenCode with a prompt in a new worktree by default. An explicit existing target shares its files. Agent spawns start without interactive approval. Pass UUID receiptId and accessKey together to inspect queued or starting state before launch returns.",
        "provider,prompt",
    ),
    (
        "validation_policy",
        "Select and persist this Ship task's validation risk before validation. Sail combines the explicit choice with repository defaults and changed-path rules, never lowers a prior selection, and returns the required gates and policy sources.",
        "risk",
    ),
    (
        "validation_gate",
        "Start one fresh Ship It validation pass in this worktree using a selected available agent and model. Returns its actual provider, model, and launch receipt. Run passes in order and wait for each result.",
        "gate,prompt",
    ),
    (
        "ship_progress",
        "Report your assigned Ship issue stage, an inline gate verdict, or your own validation verdict. Structured reports appear in the native Ship view. Blocked or failing reports require a reason.",
        "",
    ),
    (
        "task_checkpoint_read",
        "Read the canonical checkpoint for this thread's Ship task and reconcile it with the current worktree and known GitHub delivery state before resuming.",
        "",
    ),
    (
        "task_checkpoint_update",
        "Compare-and-swap canonical Ship task fields after a phase, blocker, question, revision, required-gate, or next-action change. Pass the sequence and revision returned by read; explicitly rebind after inspecting worktree drift.",
        "checkpoint",
    ),
    (
        "task_evidence_record",
        "Record a bounded command result against its execution revision and map it to zero or more acceptance criteria. Read the checkpoint before the command and pass its revision as expectedRevision.",
        "command,result,criteria,outputReference,expectedRevision",
    ),
    (
        "agent_status",
        "Inspect a launch receipt with its ID and access key. Only the launching thread can read it.",
        "receiptId,accessKey",
    ),
    (
        "agent_wait",
        "Wait up to 30 seconds for a launch receipt to finish or require input. Supply its ID and access key; returns timedOut on expiry.",
        "receiptId,accessKey",
    ),
    (
        "agent_result",
        "Read a bounded completion result using the launch receipt ID and access key. Only the launching thread can read it.",
        "receiptId,accessKey",
    ),
    (
        "terminal_list",
        "List Sail-owned shell and agent command terminals in this project and its known worktrees.",
        "",
    ),
    (
        "terminal_read",
        "Read up to 65536 bytes of terminal output from a byte cursor. Returns the next cursor, state, exit code, and truncation marker.",
        "terminalId",
    ),
    (
        "terminal_wait",
        "Wait up to 30 seconds for new terminal output or exit, then read a bounded page from a byte cursor.",
        "terminalId",
    ),
    (
        "terminal_create",
        "Run a command in a new Sail terminal in this source worktree. Requires the user's terminal execution setting. Returns an owned terminal ID.",
        "command",
    ),
    (
        "terminal_write",
        "Send bounded UTF-8 input to a terminal created by this source session.",
        "terminalId,data",
    ),
    (
        "terminal_stop",
        "Stop a terminal created by this source session. Read or wait for its actual exit code.",
        "terminalId",
    ),
    (
        "worktree_status",
        "Set a short status comment on the current worktree in the Sail sidebar. Empty text clears it.",
        "comment",
    ),
    (
        "project_threads",
        "List other agent threads in this Git project and its worktrees.",
        "",
    ),
    (
        "thread_message",
        "Send a message to another thread in this Git project, shown with this agent as sender.",
        "threadId,text",
    ),
    (
        "navigate",
        "Navigate the open Sail browser pane to an HTTP or HTTPS URL.",
        "url",
    ),
    (
        "read_page",
        "Read the current page title, URL, and visible text.",
        "",
    ),
    (
        "screenshot",
        "Capture the current browser pane as an image.",
        "",
    ),
    ("click", "Click an element selected with CSS.", "selector"),
    (
        "type",
        "Type text into an editable element selected with CSS.",
        "selector,text",
    ),
    (
        "run_script",
        "Run JavaScript in the current browser page; use return to send a value.",
        "script",
    ),
];

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
        let method = message.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "initialize" => mcp_initialize(),
            "ping" => json!({}),
            "tools/list" => json!({"tools": TOOLS.iter().map(|(name, description, fields)| {
                if *name == "skill_reference" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object",
                        "properties":{
                            "skill":{"type":"string","enum":["ship-it","adversarial-review","adversarial-test"]},
                            "reference":{"type":"string"}
                        },
                        "required":["skill"]
                    }});
                }
                if *name == "agent_spawn" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object",
                        "properties":{
                            "provider":{"type":"string","enum":["claude","codex","opencode"]},
                            "prompt":{"type":"string"},
                            "receiptId":{"type":"string","format":"uuid"},
                            "accessKey":{"type":"string","format":"uuid"},
                            "target":{"oneOf":[
                                {"type":"object","properties":{"kind":{"const":"new"},"name":{"type":"string"}},"required":["kind","name"]},
                                {"type":"object","properties":{"kind":{"const":"existing"},"path":{"type":"string"}},"required":["kind","path"]}
                            ]}
                        },
                        "required":["provider","prompt"]
                    }});
                }
                if *name == "validation_gate" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object",
                        "properties":{
                            "gate":{"type":"string","enum":["code-adversary","findings-adversary","test-adversary"]},
                            "prompt":{"type":"string"},
                            "implementingModels":{"type":"array","items":{"type":"string"}}
                        },
                        "required":["gate","prompt","implementingModels"]
                    }});
                }
                if *name == "validation_policy" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object",
                        "properties":{"risk":{"type":"string","enum":["low","medium","high"]}},
                        "required":["risk"]
                    }});
                }
                if *name == "ship_progress" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object","properties":{
                            "stage":{"type":"string","enum":["implementing","reviewing","testing","pull_request","ci","merging"]},
                            "status":{"type":"string","enum":["running","blocked"]},
                            "gate":{"type":"string","enum":["code-adversary","findings-adversary","test-adversary"]},
                            "verdict":{"type":"string","enum":["CLEAN","NEEDS_FIXES","PASS","FAIL","BLOCKED"]},
                            "reason":{"type":"string","maxLength":2000},
                            "criteria":{"type":"array","items":{"type":"string","minLength":1,"maxLength":2000},"maxItems":100},
                            "outputReference":{"type":"string","minLength":1,"maxLength":2000},
                            "revision":{"type":"string","minLength":1}
                        },"oneOf":[{"required":["stage","status"]},{"required":["verdict"]}]
                    }});
                }
                if *name == "task_checkpoint_update" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object","properties":{
                            "checkpoint":{
                                "type":"object",
                                "properties":{
                                    "objective":{"type":"string","minLength":1},
                                    "acceptanceCriteria":{"type":"array","items":{"type":"string","minLength":1},"minItems":1},
                                    "phase":{"type":"string","enum":["resolve","orchestrate","explore","branch","implement","review","test","pr","complete"]},
                                    "status":{"type":"string","enum":["active","blocked","completed"]},
                                    "requiredGates":{"type":"array","items":{"type":"string","minLength":1}},
                                    "blocker":{"type":["string","null"]},
                                    "unresolvedQuestions":{"type":"array","items":{"type":"string","minLength":1}},
                                    "nextAction":{"type":"string","minLength":1}
                                },
                                "additionalProperties":false
                            },
                            "expectedSequence":{"type":"integer","minimum":0},
                            "expectedRevision":{"type":["string","null"]},
                            "rebindRevision":{"type":"boolean"}
                        },"required":["checkpoint","expectedSequence","expectedRevision"]
                    }});
                }
                if *name == "task_evidence_record" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object","properties":{
                            "command":{"type":"string","minLength":1,"maxLength":1000},
                            "result":{"type":"string","enum":["passed","failed","pending","blocked"]},
                            "criteria":{"type":"array","items":{"type":"string","minLength":1,"maxLength":2000},"maxItems":100},
                            "outputReference":{"type":"string","minLength":1,"maxLength":2000}
                            ,"expectedRevision":{"type":"string","minLength":1}
                        },"required":["command","result","criteria","outputReference","expectedRevision"]
                    }});
                }
                if *name == "agent_wait" {
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object","properties":{
                            "receiptId":{"type":"string"},
                            "accessKey":{"type":"string"},
                            "timeoutMs":{"type":"integer","minimum":0,"maximum":30000}
                        },"required":["receiptId","accessKey"]
                    }});
                }
                if *name == "terminal_read" || *name == "terminal_wait" {
                    let mut properties = serde_json::Map::new();
                    properties.insert("terminalId".into(), json!({"type":"string"}));
                    properties.insert("cursor".into(), json!({"type":"integer","minimum":0}));
                    properties.insert("maxBytes".into(), json!({"type":"integer","minimum":1,"maximum":65536}));
                    if *name == "terminal_wait" {
                        properties.insert("timeoutMs".into(), json!({"type":"integer","minimum":0,"maximum":30000}));
                    }
                    return json!({"name":name,"description":description,"inputSchema":{
                        "type":"object","properties":properties,"required":["terminalId"]
                    }});
                }
                let properties: serde_json::Map<String, Value> = fields.split(',').filter(|field| !field.is_empty()).map(|field| (field.to_string(), json!({"type":"string"}))).collect();
                json!({"name":name,"description":description,"inputSchema":{"type":"object","properties":properties,"required":properties.keys().collect::<Vec<_>>()}})
            }).collect::<Vec<_>>() }),
            "tools/call" => call_bridge(message.get("params").unwrap_or(&Value::Null)),
            _ => json!({"error":"Unknown MCP method."}),
        };
        let response = json!({"jsonrpc":"2.0","id":id,"result":result});
        if serde_json::to_writer(&mut output, &response).is_err() {
            break;
        }
        if output.write_all(b"\n").is_err() || output.flush().is_err() {
            break;
        }
    }
}

fn mcp_initialize() -> Value {
    json!({
        "protocolVersion":"2024-11-05",
        "capabilities":{"tools":{}},
        "serverInfo":{"name":"sail-browser","version":env!("CARGO_PKG_VERSION")},
        "instructions":SAIL_SKILL
    })
}

fn call_bridge(params: &Value) -> Value {
    if params.get("name").and_then(Value::as_str) == Some("sail_skill") {
        return json!({"content":[{"type":"text","text":SAIL_SKILL}]});
    }
    if params.get("name").and_then(Value::as_str) == Some("skill_reference") {
        return skill_reference(params.get("arguments").unwrap_or(&Value::Null)).unwrap_or_else(
            |error| json!({"content":[{"type":"text","text":error}],"isError":true}),
        );
    }
    let port = match std::env::var("SAIL_BROWSER_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
    {
        Some(port) => port,
        None => {
            return json!({"content":[{"type":"text","text":"Sail browser bridge is unavailable."}],"isError":true})
        }
    };
    let token = std::env::var("SAIL_BROWSER_TOKEN").unwrap_or_default();
    let request = json!({
        "token":token,
        "sessionId":mcp_session_id(params),
        "name":params.get("name").and_then(Value::as_str),
        "arguments":params.get("arguments").cloned().unwrap_or_else(|| json!({})),
    });
    let response = (|| -> Result<Value, String> {
        let mut stream =
            TcpStream::connect(("127.0.0.1", port)).map_err(|error| error.to_string())?;
        stream
            .set_read_timeout(Some(Duration::from_secs(330)))
            .map_err(|error| error.to_string())?;
        serde_json::to_writer(&mut stream, &request).map_err(|error| error.to_string())?;
        stream.write_all(b"\n").map_err(|error| error.to_string())?;
        let mut line = String::new();
        BufReader::new(stream)
            .read_line(&mut line)
            .map_err(|error| error.to_string())?;
        serde_json::from_str(&line).map_err(|error| error.to_string())
    })();
    response.unwrap_or_else(|error| json!({"content":[{"type":"text","text":format!("Sail browser bridge: {error}")}],"isError":true}))
}

fn mcp_session_id(params: &Value) -> Option<&str> {
    let meta = params.get("_meta")?;
    meta.get("ai.opencode/sessionID")
        .and_then(Value::as_str)
        .or_else(|| meta.get("sessionID").and_then(Value::as_str))
}

#[cfg(test)]
mod picker_tests {
    use super::BrowserManager;

    #[test]
    fn selection_requires_one_active_picker() {
        let manager = BrowserManager::default();
        assert!(manager.take_picker("browser-one").is_err());
        manager.set_picker("browser-one", true).unwrap();
        assert!(manager.take_picker("browser-two").is_err());
        assert!(manager.take_picker("browser-one").is_ok());
        assert!(manager.take_picker("browser-one").is_err());
        manager.set_picker("browser-one", true).unwrap();
        manager.cancel_picker("browser-one");
        assert!(manager.take_picker("browser-one").is_err());
    }
}

#[cfg(test)]
mod skill_tests {
    use super::{call_bridge, mcp_initialize, SAIL_SKILL, TOOLS};
    use serde_json::json;

    #[test]
    fn skill_is_announced_and_readable_without_a_browser_bridge() {
        assert_eq!(mcp_initialize()["instructions"], SAIL_SKILL);
        assert!(TOOLS.iter().any(|(name, _, _)| *name == "sail_skill"));
        assert!(TOOLS
            .iter()
            .any(|(name, _, _)| *name == "task_checkpoint_read"));
        assert!(TOOLS
            .iter()
            .any(|(name, _, _)| *name == "task_checkpoint_update"));
        assert!(TOOLS
            .iter()
            .any(|(name, _, _)| *name == "task_evidence_record"));
        assert!(TOOLS
            .iter()
            .any(|(name, _, _)| *name == "validation_policy"));
        assert_eq!(
            call_bridge(&json!({"name":"sail_skill","arguments":{}}))["content"][0]["text"],
            SAIL_SKILL
        );
    }

    #[test]
    fn bundled_references_are_discoverable_versioned_and_offline() {
        assert!(TOOLS.iter().any(|(name, _, _)| *name == "skill_reference"));
        let listed = call_bridge(&json!({
            "name":"skill_reference",
            "arguments":{"skill":"ship-it"}
        }));
        assert_eq!(listed["structuredContent"]["skill"], "ship-it");
        assert!(listed["structuredContent"]["coreVersion"]
            .as_str()
            .is_some_and(|version| version.starts_with("sha256:")));
        assert_eq!(
            listed["structuredContent"]["references"]
                .as_array()
                .map(Vec::len),
            Some(3)
        );

        let loaded = call_bridge(&json!({
            "name":"skill_reference",
            "arguments":{"skill":"ship-it","reference":"inputs.md"}
        }));
        assert_eq!(loaded["structuredContent"]["reference"], "inputs.md");
        assert_eq!(
            loaded["structuredContent"]["coreVersion"],
            listed["structuredContent"]["coreVersion"]
        );
        assert!(loaded["content"][0]["text"]
            .as_str()
            .is_some_and(|text| text.contains("# Resolving the ship-it input")));
    }

    #[test]
    fn bundled_reference_rejects_unknown_names_without_the_bridge() {
        let result = call_bridge(&json!({
            "name":"skill_reference",
            "arguments":{"skill":"ship-it","reference":"../SKILL.md"}
        }));
        assert_eq!(result["isError"], true);
        assert_eq!(
            result["content"][0]["text"],
            "Unknown bundled skill reference."
        );

        for reference in [json!(null), json!(42), json!(["inputs.md"])] {
            let result = call_bridge(&json!({
                "name":"skill_reference",
                "arguments":{"skill":"ship-it","reference":reference}
            }));
            assert_eq!(result["isError"], true);
            assert_eq!(
                result["content"][0]["text"],
                "Bundled skill reference must be a string."
            );
        }
    }
}

#[cfg(test)]
mod mcp_session_tests {
    use super::mcp_session_id;
    use serde_json::json;

    #[test]
    fn accepts_opencode_and_acp_session_metadata() {
        let opencode = json!({"_meta":{"ai.opencode/sessionID":"ses_opencode"}});
        let acp = json!({"_meta":{"sessionID":"acp-session"}});
        assert_eq!(mcp_session_id(&opencode), Some("ses_opencode"));
        assert_eq!(mcp_session_id(&acp), Some("acp-session"));
    }
}
