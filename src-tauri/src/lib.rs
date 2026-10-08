use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::ffi::OsString;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Arc, Condvar, Mutex};
use std::time::{Duration, Instant};
#[cfg(any(target_os = "macos", windows))]
use tauri::Emitter;
use tauri::{Manager, State};

const OPENCODE_VERSION: &str = "2.0.24";

#[derive(Clone, Default)]
struct WorktreeOperationLocks(Arc<WorktreeOperationLockState>);

#[derive(Default)]
struct WorktreeOperationLockState {
    active: Mutex<HashSet<PathBuf>>,
    available: Condvar,
}

struct WorktreeOperationGuard {
    state: Arc<WorktreeOperationLockState>,
    repository: PathBuf,
}

impl WorktreeOperationLocks {
    fn lock(&self, repository: &Path) -> Result<WorktreeOperationGuard, String> {
        let repository = git_common_directory(repository)?;
        let mut active = self
            .0
            .active
            .lock()
            .map_err(|_| "Worktree operations are unavailable.".to_string())?;
        while active.contains(&repository) {
            active = self
                .0
                .available
                .wait(active)
                .map_err(|_| "Worktree operations are unavailable.".to_string())?;
        }
        active.insert(repository.clone());
        Ok(WorktreeOperationGuard {
            state: Arc::clone(&self.0),
            repository,
        })
    }
}

/// Canonicalization git can consume. On Windows `std::fs::canonicalize` returns an
/// extended-length `\\?\` path, which git rejects when it creates worktrees and refs.
pub(crate) trait GitCanonical {
    fn git_canonical(&self) -> std::io::Result<PathBuf>;
}

impl GitCanonical for Path {
    fn git_canonical(&self) -> std::io::Result<PathBuf> {
        dunce::canonicalize(self)
    }
}

fn git_common_directory(repository: &Path) -> Result<PathBuf, String> {
    let repository = repository
        .git_canonical()
        .map_err(|_| "Repository folder no longer exists.".to_string())?;
    let common = git_reference(&repository, &["rev-parse", "--git-common-dir"])
        .ok_or("Cannot locate the repository Git directory.")?;
    let common = PathBuf::from(common);
    let common = if common.is_absolute() {
        common
    } else {
        repository.join(common)
    };
    common
        .git_canonical()
        .map_err(|_| "Repository Git directory no longer exists.".to_string())
}

impl Drop for WorktreeOperationGuard {
    fn drop(&mut self) {
        if let Ok(mut active) = self.state.active.lock() {
            active.remove(&self.repository);
            self.state.available.notify_all();
        }
    }
}

fn existing_shipping_worktree(
    repository: &Path,
    name: &str,
) -> Result<Option<CreatedWorktree>, String> {
    let listed = git_reference(repository, &["worktree", "list", "--porcelain", "-z"])
        .ok_or("Cannot inspect shipping worktrees.")?;
    let existing = parse_registered_worktrees(&listed)
        .into_iter()
        .find(|entry| entry.present && entry.branch.as_deref() == Some(name));
    let Some(existing) = existing else {
        return Ok(None);
    };
    let path = PathBuf::from(existing.path)
        .git_canonical()
        .map_err(|_| "Shipping worktree is missing.")?;
    let setup = worktree_config::read(&path)?
        .map(|config| config.setup)
        .unwrap_or_default();
    let shipping_target = shipping_target(repository, &path, name).ok();
    Ok(Some(CreatedWorktree {
        path: path.to_string_lossy().into_owned(),
        branch: name.to_string(),
        base: shipping_target
            .as_ref()
            .map(|target| target.base_ref.clone())
            .unwrap_or_else(|| worktree_base(repository)),
        setup,
        shipping_target,
    }))
}

fn shipping_fetch_source(repository: &Path, target: &str) -> Result<(String, bool), String> {
    let remotes = git_reference(repository, &["remote"]).ok_or("Cannot list Git remotes.")?;
    for remote in remotes.lines() {
        let Some(url) = git_reference(repository, &["remote", "get-url", remote]) else {
            continue;
        };
        if github::github_remote(&url).is_some_and(|name| name.eq_ignore_ascii_case(target)) {
            return Ok((remote.to_string(), true));
        }
    }
    let origin = git_reference(repository, &["remote", "get-url", "origin"])
        .ok_or("Cannot find origin remote.")?;
    if origin.starts_with("git@") || origin.starts_with("ssh://") {
        Ok((format!("git@github.com:{target}.git"), false))
    } else {
        Ok((format!("https://github.com/{target}.git"), false))
    }
}

fn shipping_default_branch(repository: &Path, source: &str) -> Result<String, String> {
    let advertised = git_reference(repository, &["ls-remote", "--symref", source, "HEAD"])
        .ok_or("Cannot read issue repository's default branch.")?;
    let branch = advertised
        .lines()
        .find_map(|line| {
            line.strip_prefix("ref: refs/heads/")?
                .strip_suffix("\tHEAD")
        })
        .ok_or("Issue repository does not advertise a default branch.")?;
    Ok(branch.to_string())
}

#[cfg(any(target_os = "macos", windows))]
fn configure_pane_menu(app: &tauri::AppHandle) -> tauri::Result<()> {
    use tauri::menu::{Menu, MenuItem};

    let menu = Menu::default(app)?;
    let close_pane = MenuItem::with_id(app, "close-pane", "Close Pane", true, Some("CmdOrCtrl+W"))?;
    let close_worktree = MenuItem::with_id(
        app,
        "close-worktree",
        "Close Session and Delete Worktree",
        true,
        Some("CmdOrCtrl+Shift+W"),
    )?;
    for item in menu.items()? {
        if let Some(submenu) = item.as_submenu() {
            for (index, entry) in submenu.items()?.into_iter().enumerate().rev() {
                if let Some(predefined) = entry.as_predefined_menuitem() {
                    if ["Close", "C&lose Window"].contains(&predefined.text()?.as_str()) {
                        submenu.remove_at(index)?;
                    }
                }
            }
            if submenu.text()? == "File" {
                submenu.insert(&close_pane, 0)?;
                submenu.insert(&close_worktree, 1)?;
            }
        }
    }
    app.set_menu(menu)?;
    app.on_menu_event(|app, event| {
        let event_name = match event.id().as_ref() {
            "close-pane" => "pane:close",
            "close-worktree" => "worktree:close",
            _ => return,
        };
        if let Some(settings) = app.get_webview_window("settings") {
            if settings.is_focused().unwrap_or(false) {
                if event_name == "pane:close" {
                    let _ = settings.close();
                }
                return;
            }
        }
        let _ = app.emit_to("main", event_name, ());
    });
    Ok(())
}

mod acp;
mod acp_terminal;
mod attention;
mod browser;
pub mod browser_agent;
#[cfg(unix)]
mod child_watchdog;
mod dev_servers;
mod diagnostics;
mod github;
pub mod hook_activity;
mod hook_inspector;
mod opencode_config;
mod post_turn_checks;
mod settings;
mod shell_command;
mod ship_actions;
mod stderr_log;
mod terminal;
mod worktree_config;
mod worktree_snapshots;

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct RuntimeInfo {
    url: String,
    password: String,
    binary_path: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickerEntry {
    name: String,
    path: String,
    is_directory: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickerDirectory {
    path: String,
    parent: Option<String>,
    entries: Vec<PickerEntry>,
}

fn picker_path(path: &Path) -> String {
    let path = path.to_string_lossy();
    #[cfg(windows)]
    {
        normalize_picker_path(&path)
    }
    #[cfg(not(windows))]
    path.into_owned()
}

#[cfg(any(windows, test))]
fn normalize_picker_path(path: &str) -> String {
    if let Some(rest) = path.strip_prefix(r"\\?\UNC\") {
        return format!(r"\\{rest}");
    }
    path.strip_prefix(r"\\?\")
        .map(str::to_owned)
        .unwrap_or_else(|| path.to_owned())
}

#[tauri::command]
fn list_picker_directory(path: Option<String>) -> Result<PickerDirectory, String> {
    let chosen = match path {
        Some(path) if !path.trim().is_empty() => PathBuf::from(path),
        _ => PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .ok_or("Cannot find the home folder")?,
        ),
    };
    let chosen = chosen.git_canonical().map_err(|error| error.to_string())?;
    if !chosen.is_dir() {
        return Err("Choose a folder to browse".to_string());
    }
    let mut entries = std::fs::read_dir(&chosen)
        .map_err(|error| error.to_string())?
        .filter_map(|item| {
            let item = item.ok()?;
            let path = item.path();
            let is_directory = path.is_dir();
            if !is_directory && !path.is_file() {
                return None;
            }
            Some(PickerEntry {
                name: item.file_name().to_string_lossy().into_owned(),
                path: picker_path(&path),
                is_directory,
            })
        })
        .collect::<Vec<_>>();
    entries.sort_by(|a, b| {
        b.is_directory
            .cmp(&a.is_directory)
            .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
    });
    Ok(PickerDirectory {
        parent: chosen.parent().map(picker_path),
        path: picker_path(&chosen),
        entries,
    })
}

struct OwnedRuntime {
    child: Child,
    #[cfg(unix)]
    watchdog: child_watchdog::ChildWatchdog,
    info: RuntimeInfo,
    binary: OsString,
}

fn stop_child(child: &mut Child) {
    #[cfg(unix)]
    {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
    }
    #[cfg(windows)]
    if child.try_wait().ok().flatten().is_none() {
        let _ = Command::new("taskkill")
            .args(["/PID", &child.id().to_string(), "/T", "/F"])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
    }
    let _ = child.kill();
    let _ = child.wait();
}

impl Drop for OwnedRuntime {
    fn drop(&mut self) {
        stop_child(&mut self.child);
        #[cfg(unix)]
        self.watchdog.stop();
    }
}

#[derive(Default)]
struct RuntimeManager(Mutex<Option<OwnedRuntime>>);

impl RuntimeManager {
    fn shutdown(&self) {
        let owned = self.0.lock().ok().and_then(|mut runtime| runtime.take());
        drop(owned);
    }
}

#[tauri::command]
async fn browser_detected_servers(
    directory: String,
    terminals: State<'_, terminal::TerminalManager>,
    acp_terminals: State<'_, acp_terminal::AcpTerminalManager>,
    agents: State<'_, acp::AgentManager>,
    runtime: State<'_, RuntimeManager>,
) -> Result<Vec<dev_servers::DetectedServer>, String> {
    let mut roots = terminals
        .server_roots()
        .into_iter()
        .chain(acp_terminals.server_roots())
        .map(|(directory, pid)| dev_servers::ServerRoot::Owned { directory, pid })
        .collect::<Vec<_>>();
    roots.extend(
        agents
            .server_roots()
            .into_iter()
            .map(|pid| dev_servers::ServerRoot::Shared { pid }),
    );
    if let Ok(mut runtime) = runtime.0.lock() {
        if let Some(owned) = runtime.as_mut() {
            if owned
                .child
                .try_wait()
                .map_err(|error| error.to_string())?
                .is_none()
            {
                roots.push(dev_servers::ServerRoot::Shared {
                    pid: owned.child.id(),
                });
            }
        }
    }
    tauri::async_runtime::spawn_blocking(move || dev_servers::detect(Path::new(&directory), &roots))
        .await
        .map_err(|error| error.to_string())?
}

fn candidate_paths() -> Vec<PathBuf> {
    let names: &[&str] = if cfg!(windows) {
        &["opencode.exe", "opencode.cmd", "opencode.bat"]
    } else {
        &["opencode"]
    };
    let mut directories = Vec::new();
    if let Some(paths) = std::env::var_os("PATH") {
        directories.extend(std::env::split_paths(&paths));
    }
    if let Some(home) = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }) {
        let home = PathBuf::from(home);
        directories.extend([
            home.join(".local/bin"),
            home.join(".opencode/bin"),
            home.join(".local/share/mise/shims"),
            home.join(".bun/bin"),
            home.join("scoop/shims"),
        ]);
    }
    if let Some(local) = std::env::var_os("LOCALAPPDATA") {
        directories.push(PathBuf::from(local).join("Programs/opencode"));
    }
    if let Some(roaming) = std::env::var_os("APPDATA") {
        directories.push(PathBuf::from(roaming).join("npm"));
    }
    directories.extend([
        PathBuf::from("/opt/homebrew/bin"),
        PathBuf::from("/usr/local/bin"),
        PathBuf::from("/usr/bin"),
        PathBuf::from("/snap/bin"),
    ]);
    directories
        .into_iter()
        .flat_map(|directory| names.iter().map(move |name| directory.join(name)))
        .collect()
}

fn version_number(output: &str) -> Option<&str> {
    let version = output.split_whitespace().last()?.trim_start_matches('v');
    if !version.is_empty() && version.chars().all(|c| c.is_ascii_digit() || c == '.') {
        Some(version)
    } else {
        None
    }
}

fn version_is_compatible(version: Option<&str>) -> bool {
    version == Some(OPENCODE_VERSION)
}

fn compatible_version(binary: &Path) -> Result<(), String> {
    let mut command = Command::new(binary);
    command.arg("--version");
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|_| {
            "OpenCode binary not found or cannot run. Choose an absolute binary path in settings."
                .to_string()
        })?;
    let stdout = child
        .stdout
        .take()
        .ok_or("OpenCode did not provide version output")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut line = String::new();
        let _ = BufReader::new(stdout).read_line(&mut line);
        let _ = sender.send(line);
    });
    let deadline = Instant::now() + Duration::from_secs(5);
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(50)),
            _ => {
                stop_child(&mut child);
                return Err(
                    "OpenCode version check timed out. Choose another binary in settings."
                        .to_string(),
                );
            }
        }
    };
    let output = receiver
        .recv_timeout(Duration::from_secs(1))
        .unwrap_or_default();
    let version = version_number(&output);
    if status.success() && version_is_compatible(version) {
        Ok(())
    } else {
        Err(format!(
            "OpenCode v{OPENCODE_VERSION} is required (found {}). Upgrade or choose a compatible binary in settings.",
            version.unwrap_or("an incompatible binary")
        ))
    }
}

fn resolve_binary(binary_path: Option<String>) -> Result<OsString, String> {
    if let Some(path) = binary_path.filter(|path| !path.trim().is_empty()) {
        let binary = PathBuf::from(path);
        if !binary.is_absolute() {
            return Err("OpenCode binary path must be absolute.".to_string());
        }
        compatible_version(&binary)?;
        return Ok(binary.into_os_string());
    }
    if let Some(path) =
        std::env::var_os("SAIL_OPENCODE_BIN").or_else(|| std::env::var_os("SAI_OPENCODE_BIN"))
    {
        let binary = PathBuf::from(path);
        compatible_version(&binary)?;
        return Ok(binary.into_os_string());
    }
    let mut incompatible = None;
    for binary in candidate_paths() {
        if binary.is_file() {
            match compatible_version(&binary) {
                Ok(()) => return Ok(binary.into_os_string()),
                Err(error) => incompatible = Some(error),
            }
        }
    }
    Err(incompatible.unwrap_or_else(|| {
        format!(
            "OpenCode v{OPENCODE_VERSION} was not found. Install it or choose an absolute binary path in settings."
        )
    }))
}

fn probe_runtime(info: &RuntimeInfo) -> Result<(), String> {
    let diagnostic = format!(
        "OpenCode did not respond with the compatible v{OPENCODE_VERSION} API. Check its configuration and retry."
    );
    let url = reqwest::Url::parse(&info.url).map_err(|_| diagnostic.to_string())?;
    if url.scheme() != "http" || url.host_str() != Some("127.0.0.1") || url.port().is_none() {
        return Err(diagnostic.to_string());
    }
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|_| diagnostic.to_string())?;
    let response = client
        .get(format!("{}/api/info", info.url.trim_end_matches('/')))
        .basic_auth("opencode", Some(&info.password))
        .send()
        .map_err(|_| diagnostic.to_string())?;
    if !response.status().is_success() {
        return Err(diagnostic.to_string());
    }
    let body: serde_json::Value = response.json().map_err(|_| diagnostic.to_string())?;
    if version_is_compatible(body.get("version").and_then(serde_json::Value::as_str)) {
        Ok(())
    } else {
        Err(diagnostic.to_string())
    }
}

fn server_args() -> Vec<&'static str> {
    let mut args = vec![
        "serve",
        "--hostname",
        "127.0.0.1",
        "--port",
        "0",
        "--cors",
        "tauri://localhost",
        "--cors",
        "http://tauri.localhost",
    ];
    if cfg!(debug_assertions) {
        args.extend([
            "--cors",
            "http://localhost:1420",
            "--cors",
            "http://127.0.0.1:1420",
        ]);
    }
    args
}

#[tauri::command]
fn start_runtime(
    manager: State<'_, RuntimeManager>,
    binary_path: Option<String>,
    restart: bool,
) -> Result<RuntimeInfo, String> {
    diagnostics::record(
        "runtime_start_requested",
        serde_json::json!({"restart":restart}),
    );
    let mut runtime = manager.0.lock().map_err(|error| error.to_string())?;
    let binary = resolve_binary(binary_path)?;
    if let Some(existing) = runtime.as_mut() {
        if !restart
            && existing.binary == binary
            && existing.child.try_wait().ok().flatten().is_none()
        {
            diagnostics::record(
                "runtime_reused",
                serde_json::json!({"pid":existing.child.id()}),
            );
            return Ok(existing.info.clone());
        }
    }

    let mut command = Command::new(&binary);
    command.args(server_args());
    command.env_remove("OPENCODE_CONFIG_DIR");
    #[cfg(unix)]
    command.process_group(0);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "Could not start OpenCode. Check the binary path and retry.".to_string())?;
    diagnostics::record("runtime_spawned", serde_json::json!({"pid":child.id()}));
    if let Some(mut stderr) = child.stderr.take() {
        std::thread::spawn(move || {
            let mut buffer = [0; 4096];
            let mut total_bytes = 0u64;
            loop {
                match stderr.read(&mut buffer) {
                    Ok(0) | Err(_) => break,
                    Ok(bytes) => total_bytes = total_bytes.saturating_add(bytes as u64),
                }
            }
            if total_bytes > 0 {
                diagnostics::record("runtime_stderr", serde_json::json!({"bytes":total_bytes}));
            }
        });
    }

    #[cfg(unix)]
    let watchdog = child_watchdog::ChildWatchdog::start(child.id()).map_err(|error| {
        stop_child(&mut child);
        format!("Could not start OpenCode watchdog: {error}")
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or("OpenCode did not provide startup output")?;
    let (sender, receiver) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut url = None;
        let mut password = None;
        let mut sender = Some(sender);
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if let Some(value) = line.strip_prefix("server listening on ") {
                url = Some(value.trim().to_string());
            }
            if let Some(value) = line.strip_prefix("server password ") {
                password = Some(value.trim().to_string());
            }
            if let (Some(url), Some(password)) = (url.as_ref(), password.as_ref()) {
                if let Some(sender) = sender.take() {
                    let _ = sender.send(RuntimeInfo {
                        url: url.clone(),
                        password: password.clone(),
                        binary_path: String::new(),
                    });
                }
            }
        }
    });

    let mut info = match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(info) => info,
        Err(_) => {
            let exit = child.try_wait().ok().flatten();
            diagnostics::record(
                "runtime_start_failed",
                serde_json::json!({
                    "reason":if exit.is_some() {"early_exit"} else {"timeout"},
                    "exitCode":exit.and_then(|status| status.code())
                }),
            );
            stop_child(&mut child);
            return Err(match exit {
                Some(status) => format!(
                    "OpenCode exited before becoming ready ({status}). Check its configuration and retry."
                ),
                None => "OpenCode did not become ready within 15 seconds. Retry or choose another binary."
                    .to_string(),
            });
        }
    };
    info.binary_path = Path::new(&binary).to_string_lossy().into_owned();
    let mut ready = false;
    for _ in 0..5 {
        if child.try_wait().ok().flatten().is_some() {
            break;
        }
        if probe_runtime(&info).is_ok() {
            ready = true;
            break;
        }
        std::thread::sleep(Duration::from_millis(200));
    }
    if !ready {
        diagnostics::record(
            "runtime_start_failed",
            serde_json::json!({"reason":"api_probe"}),
        );
        stop_child(&mut child);
        return Err(
            "OpenCode did not respond with a compatible v2 API. Check its configuration and retry."
                .to_string(),
        );
    }
    diagnostics::record("runtime_ready", serde_json::json!({"pid":child.id()}));
    *runtime = Some(OwnedRuntime {
        child,
        #[cfg(unix)]
        watchdog,
        info: info.clone(),
        binary,
    });
    Ok(info)
}

#[tauri::command]
fn repository_path_available(path: String) -> bool {
    let directory = Path::new(&path);
    directory.is_dir() && directory.join(".git").exists()
}

#[tauri::command]
fn validate_repository(path: String) -> Result<String, String> {
    let directory = Path::new(&path)
        .git_canonical()
        .map_err(|_| "Repository path does not exist. Choose an existing directory.".to_string())?;
    if !directory.is_dir() {
        return Err("Repository path is not a directory.".to_string());
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(&directory)
        .args(["rev-parse", "--show-toplevel"])
        .output()
        .map_err(|_| "Git is unavailable. Install Git to select a repository.".to_string())?;
    if !output.status.success() {
        return Err("Selected directory is not inside a Git repository.".to_string());
    }
    let root = String::from_utf8(output.stdout)
        .map_err(|_| "Git returned a repository path that cannot be displayed.".to_string())?;
    Ok(root.trim().to_string())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorkingDiff {
    file: String,
    patch: String,
    staged_patch: String,
    unstaged_patch: String,
    untracked: bool,
    additions: usize,
    deletions: usize,
    status: &'static str,
}

fn git_patch(root: &str, file: &str, area: &str, untracked: bool) -> Result<String, String> {
    let mut command = Command::new("git");
    command.args(["-C", root]);
    if untracked {
        command.args([
            "diff",
            "--no-index",
            "--binary",
            "--src-prefix=a/",
            "--dst-prefix=b/",
            "--",
            "/dev/null",
        ]);
        command.arg(file);
    } else {
        command.args([
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--no-renames",
            "--binary",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ]);
        if area == "staged" {
            command.arg("--cached");
        } else if area == "all" {
            command.arg("HEAD");
        }
        command.args(["--", &format!(":(literal){file}")]);
    }
    let output = command.output().map_err(|error| error.to_string())?;
    if !output.status.success() && !(untracked && output.status.code() == Some(1)) {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(String::from_utf8_lossy(&output.stdout).into_owned())
}

struct TemporaryIndex(PathBuf);

impl Drop for TemporaryIndex {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
        let _ = std::fs::remove_file(self.0.with_extension("lock"));
    }
}

/// A private index for read-only commands. Git refreshes stat data and writes it back to the
/// index it reads, and only some commands honour `--no-optional-locks`, so a read that must not
/// touch the user's index runs against a copy.
fn index_copy(root: &str, copy_current: bool) -> Result<TemporaryIndex, String> {
    let output = Command::new("git")
        .args(["-C", root, "rev-parse", "--git-path", "index"])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Could not locate the Git index.".into());
    }
    let index = String::from_utf8_lossy(&output.stdout).trim().to_string();
    let index = Path::new(&index);
    let index = if index.is_absolute() {
        index.to_path_buf()
    } else {
        Path::new(root).join(index)
    };
    let temporary =
        TemporaryIndex(index.with_file_name(format!("sail-index-{}", uuid::Uuid::new_v4())));
    if copy_current && index.exists() {
        std::fs::copy(&index, &temporary.0).map_err(|error| error.to_string())?;
    }
    Ok(temporary)
}

fn index_with_intent(
    root: &str,
    files: &[String],
    copy_current: bool,
) -> Result<TemporaryIndex, String> {
    let temporary = index_copy(root, copy_current)?;
    let pathspecs = files
        .iter()
        .map(|file| format!(":(literal){file}"))
        .collect::<Vec<_>>();
    let output = Command::new("git")
        .args(["-C", root, "add", "-N", "--"])
        .args(&pathspecs)
        .env("GIT_INDEX_FILE", &temporary.0)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err(String::from_utf8_lossy(&output.stderr).into_owned());
    }
    Ok(temporary)
}

fn git_patches(
    root: &str,
    area: &str,
    index: Option<&Path>,
) -> Result<HashMap<String, String>, String> {
    let run = |names: bool| -> Result<Vec<u8>, String> {
        let mut command = Command::new("git");
        command.args([
            "--no-optional-locks",
            "-C",
            root,
            "diff",
            "--no-ext-diff",
            "--no-color",
            "--no-renames",
            "--binary",
            "--src-prefix=a/",
            "--dst-prefix=b/",
        ]);
        if area == "staged" {
            command.arg("--cached");
        } else if area == "all" {
            command.arg("HEAD");
        }
        if names {
            command.args(["--name-only", "-z"]);
        }
        if let Some(index) = index {
            command.env("GIT_INDEX_FILE", index);
        }
        let output = command.output().map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(output.stdout)
    };
    let names_raw = run(true)?;
    let patch_raw = run(false)?;
    if run(true)? != names_raw {
        return Err("Changes moved during refresh. Retry.".into());
    }
    let names = names_raw
        .split(|byte| *byte == 0)
        .filter(|name| !name.is_empty())
        .map(|name| String::from_utf8_lossy(name).into_owned())
        .collect::<Vec<_>>();
    let patch = String::from_utf8_lossy(&patch_raw).into_owned();
    let mut chunks = Vec::new();
    for line in patch.split_inclusive('\n') {
        if line.starts_with("diff --git ") {
            chunks.push(String::new());
        }
        if let Some(chunk) = chunks.last_mut() {
            chunk.push_str(line);
        }
    }
    if names.len() != chunks.len() {
        return Err("Could not match Git patches to changed files.".into());
    }
    Ok(names.into_iter().zip(chunks).collect())
}

#[tauri::command]
async fn working_tree_diff(path: String) -> Result<Vec<WorkingDiff>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        let snapshot = index_copy(&root, true)?;
        let output = Command::new("git")
            .args([
                "--no-optional-locks",
                "-C",
                &root,
                "status",
                "--porcelain=v1",
                "-z",
                "--no-renames",
                "--untracked-files=all",
            ])
            .env("GIT_INDEX_FILE", &snapshot.0)
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err("Could not read working tree changes.".into());
        }
        let has_head = Command::new("git")
            .args(["-C", &root, "rev-parse", "--verify", "HEAD"])
            .output()
            .is_ok_and(|result| result.status.success());
        let records = output
            .stdout
            .split(|byte| *byte == 0)
            .filter(|record| !record.is_empty())
            .filter(|record| record.len() >= 4)
            .map(|record| {
                let file = String::from_utf8_lossy(&record[3..]).into_owned();
                let untracked = &record[..2] == b"??";
                let status = if untracked || record[..2].contains(&b'A') {
                    "added"
                } else if record[..2].contains(&b'D') {
                    "deleted"
                } else {
                    "modified"
                };
                (file, untracked, status)
            })
            .collect::<Vec<_>>();
        if records.is_empty() {
            return Ok(Vec::new());
        }
        let untracked = records
            .iter()
            .filter(|(_, untracked, _)| *untracked)
            .map(|(file, _, _)| file.clone())
            .collect::<Vec<_>>();
        let temporary = if untracked.is_empty() {
            None
        } else {
            Some(index_with_intent(&root, &untracked, true)?)
        };
        let staged = git_patches(&root, "staged", Some(&snapshot.0))?;
        let unstaged = git_patches(
            &root,
            "unstaged",
            Some(temporary.as_ref().unwrap_or(&snapshot).0.as_path()),
        )?;
        let all = if has_head {
            git_patches(&root, "all", Some(&snapshot.0))?
        } else {
            let existing = records
                .iter()
                .filter(|(file, _, _)| Path::new(&root).join(file).symlink_metadata().is_ok())
                .map(|(file, _, _)| file.clone())
                .collect::<Vec<_>>();
            if existing.is_empty() {
                HashMap::new()
            } else {
                let empty_index = index_with_intent(&root, &existing, false)?;
                git_patches(&root, "unstaged", Some(&empty_index.0))?
            }
        };
        let mut files = Vec::new();
        for (file, untracked, status) in records {
            let staged_patch = staged.get(&file).cloned().unwrap_or_default();
            let unstaged_patch = unstaged.get(&file).cloned().unwrap_or_default();
            let patch = if untracked && has_head {
                unstaged_patch.clone()
            } else {
                all.get(&file).cloned().unwrap_or_default()
            };
            let additions = patch
                .lines()
                .filter(|line| line.starts_with('+') && !line.starts_with("+++ "))
                .count();
            let deletions = patch
                .lines()
                .filter(|line| line.starts_with('-') && !line.starts_with("--- "))
                .count();
            files.push(WorkingDiff {
                file,
                patch,
                staged_patch,
                unstaged_patch,
                untracked,
                additions,
                deletions,
                status,
            });
        }
        Ok(files)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn working_tree_revision(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        git_directory_revision(Path::new(&root))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn working_tree_generation(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        git_directory_generation(Path::new(&root))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn working_tree_commit(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        let status = Command::new("git")
            .args([
                "-C",
                &root,
                "status",
                "--porcelain=v1",
                "--untracked-files=all",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !status.status.success() {
            return Err("Could not read working tree changes.".into());
        }
        if !status.stdout.is_empty() {
            return Ok(None);
        }
        let head = Command::new("git")
            .args(["-C", &root, "rev-parse", "HEAD"])
            .output()
            .map_err(|error| error.to_string())?;
        if !head.status.success() {
            return Err("Could not read the working tree commit.".into());
        }
        Ok(Some(
            String::from_utf8_lossy(&head.stdout).trim().to_string(),
        ))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn shipping_base_revision(path: String, base_ref: Option<String>) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        let base = match base_ref {
            Some(value) if value.starts_with("refs/") && !value.contains(char::is_whitespace) => {
                value
            }
            Some(_) => return Err("Invalid shipping base reference.".to_string()),
            None => worktree_base(Path::new(&root)),
        };
        git_reference(
            Path::new(&root),
            &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
        )
        .ok_or("Cannot resolve the shipping base commit.".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn shipping_changed_paths(
    path: String,
    base_revision: Option<String>,
) -> Result<Vec<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        let base = match base_revision {
            Some(base) => git_reference(
                Path::new(&root),
                &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
            )
            .ok_or("The selected shipping base commit no longer exists.")?,
            None => {
                let reference = worktree_base(Path::new(&root));
                git_reference(
                    Path::new(&root),
                    &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
                )
                .ok_or("Cannot resolve the shipping base commit.")?
            }
        };
        let merge_base = git_reference(Path::new(&root), &["merge-base", "HEAD", &base])
            .ok_or("Cannot find the merge base for validation.")?;
        let output = Command::new("git")
            .args([
                "-C",
                &root,
                "diff",
                "--name-only",
                "-z",
                "--no-renames",
                &merge_base,
                "--",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        let untracked = Command::new("git")
            .args([
                "-C",
                &root,
                "ls-files",
                "--others",
                "--exclude-standard",
                "-z",
                "--",
            ])
            .output()
            .map_err(|error| error.to_string())?;
        if !untracked.status.success() {
            return Err(String::from_utf8_lossy(&untracked.stderr).into_owned());
        }
        Ok(output
            .stdout
            .split(|byte| *byte == 0)
            .chain(untracked.stdout.split(|byte| *byte == 0))
            .filter(|name| !name.is_empty())
            .map(|name| String::from_utf8_lossy(name).into_owned())
            .collect::<std::collections::BTreeSet<_>>()
            .into_iter()
            .collect())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeOverview {
    path: String,
    branch: Option<String>,
    changed_files: Option<usize>,
    error: Option<String>,
}

fn inspect_worktree(path: String) -> WorktreeOverview {
    let root = match validate_repository(path.clone()) {
        Ok(root) => root,
        Err(error) => {
            return WorktreeOverview {
                path,
                branch: None,
                changed_files: None,
                error: Some(error),
            };
        }
    };
    let branch = Command::new("git")
        .args(["-C", &root, "symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|branch| !branch.is_empty())
        .or_else(|| Some("Detached HEAD".into()));
    let changes = Command::new("git")
        .args([
            "-C",
            &root,
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
        ])
        .output();
    match changes {
        Ok(output) if output.status.success() => WorktreeOverview {
            path,
            branch,
            changed_files: Some(
                output
                    .stdout
                    .split(|byte| *byte == 0)
                    .filter(|record| record.len() >= 4)
                    .count(),
            ),
            error: None,
        },
        _ => WorktreeOverview {
            path,
            branch,
            changed_files: None,
            error: Some("Could not read working tree status.".into()),
        },
    }
}

#[tauri::command]
async fn worktree_overviews(paths: Vec<String>) -> Vec<WorktreeOverview> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut unique = Vec::new();
        for path in paths.into_iter().take(500) {
            if !unique.contains(&path) {
                unique.push(path);
            }
        }
        unique.into_iter().map(inspect_worktree).collect()
    })
    .await
    .unwrap_or_default()
}

fn git_directory_revision(root: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "status",
            "--porcelain=v1",
            "-z",
            "--no-renames",
            "--untracked-files=all",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Could not read working tree changes.".into());
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    output.stdout.hash(&mut hash);
    for record in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|record| record.len() >= 4)
    {
        let path = String::from_utf8_lossy(&record[3..]);
        let file_path = root.join(path.as_ref());
        if let Ok(metadata) = file_path.symlink_metadata() {
            #[cfg(unix)]
            {
                use std::os::unix::fs::PermissionsExt;
                metadata.permissions().mode().hash(&mut hash);
            }
            #[cfg(not(unix))]
            metadata.permissions().readonly().hash(&mut hash);
            if metadata.file_type().is_symlink() {
                std::fs::read_link(&file_path)
                    .map_err(|error| error.to_string())?
                    .hash(&mut hash);
            } else if metadata.is_file() {
                let mut file =
                    std::fs::File::open(&file_path).map_err(|error| error.to_string())?;
                let mut buffer = [0_u8; 8192];
                loop {
                    let count = file.read(&mut buffer).map_err(|error| error.to_string())?;
                    if count == 0 {
                        break;
                    }
                    buffer[..count].hash(&mut hash);
                }
            } else if metadata.is_dir() && file_path.join(".git").exists() {
                git_directory_revision(&file_path)?.hash(&mut hash);
            }
        }
    }
    let head = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|error| error.to_string())?;
    if head.status.success() {
        head.stdout.hash(&mut hash);
    }
    let staged = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["diff", "--cached", "--binary", "--no-ext-diff"])
        .output()
        .map_err(|error| error.to_string())?;
    if !staged.status.success() {
        return Err("Could not read staged working tree changes.".into());
    }
    staged.stdout.hash(&mut hash);
    Ok(format!("{:016x}", hash.finish()))
}

fn git_directory_generation(root: &Path) -> Result<String, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "ls-files",
            "-z",
            "--cached",
            "--others",
            "--exclude-standard",
        ])
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Err("Could not inspect working tree files.".into());
    }
    let mut hash = std::collections::hash_map::DefaultHasher::new();
    let mut directories = std::collections::HashSet::from([root.to_path_buf()]);
    for record in output
        .stdout
        .split(|byte| *byte == 0)
        .filter(|item| !item.is_empty())
    {
        record.hash(&mut hash);
        let file = root.join(String::from_utf8_lossy(record).as_ref());
        if let Some(parent) = file.parent() {
            let mut current = Some(parent);
            while let Some(directory) = current {
                if !directory.starts_with(root) {
                    break;
                }
                directories.insert(directory.to_path_buf());
                current = directory.parent();
            }
        }
        if let Ok(metadata) = file.symlink_metadata() {
            metadata.len().hash(&mut hash);
            #[cfg(unix)]
            {
                use std::os::unix::fs::MetadataExt;
                metadata.mode().hash(&mut hash);
                metadata.ino().hash(&mut hash);
                metadata.mtime().hash(&mut hash);
                metadata.mtime_nsec().hash(&mut hash);
                metadata.ctime().hash(&mut hash);
                metadata.ctime_nsec().hash(&mut hash);
            }
            #[cfg(windows)]
            {
                use std::os::windows::fs::MetadataExt;
                metadata.file_attributes().hash(&mut hash);
                metadata.creation_time().hash(&mut hash);
                metadata.last_write_time().hash(&mut hash);
                metadata.file_size().hash(&mut hash);
            }
        }
    }
    let mut directories = directories.into_iter().collect::<Vec<_>>();
    directories.sort();
    for directory in directories {
        directory
            .strip_prefix(root)
            .unwrap_or(&directory)
            .hash(&mut hash);
        #[cfg(unix)]
        if let Ok(metadata) = directory.symlink_metadata() {
            use std::os::unix::fs::MetadataExt;
            metadata.ino().hash(&mut hash);
            metadata.mtime().hash(&mut hash);
            metadata.mtime_nsec().hash(&mut hash);
            metadata.ctime().hash(&mut hash);
            metadata.ctime_nsec().hash(&mut hash);
        }
        #[cfg(windows)]
        if let Ok(metadata) = directory.symlink_metadata() {
            use std::os::windows::fs::MetadataExt;
            metadata.file_attributes().hash(&mut hash);
            metadata.creation_time().hash(&mut hash);
            metadata.last_write_time().hash(&mut hash);
            metadata.file_size().hash(&mut hash);
        }
    }
    Ok(format!("{hash:016x}", hash = hash.finish()))
}

fn selected_hunk(patch: &str, ordinal: usize) -> Result<String, String> {
    let lines = patch.split_inclusive('\n').collect::<Vec<_>>();
    let headers = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| line.starts_with("@@ ").then_some(index))
        .collect::<Vec<_>>();
    let start = *headers
        .get(ordinal)
        .ok_or_else(|| "The selected hunk is no longer available.".to_string())?;
    let end = headers.get(ordinal + 1).copied().unwrap_or(lines.len());
    Ok(lines[..headers[0]]
        .iter()
        .filter(|line| !line.starts_with("old mode ") && !line.starts_with("new mode "))
        .chain(&lines[start..end])
        .copied()
        .collect())
}

#[tauri::command]
async fn git_change_action(
    path: String,
    file: String,
    area: String,
    action: String,
    expected_patch: String,
    hunk: Option<usize>,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository(path)?;
        let relative = Path::new(&file);
        if relative.is_absolute()
            || relative
                .components()
                .any(|part| !matches!(part, std::path::Component::Normal(_)))
        {
            return Err("Invalid diff file path.".to_string());
        }
        if !matches!(area.as_str(), "staged" | "unstaged")
            || !matches!(
                (area.as_str(), action.as_str()),
                ("unstaged", "stage" | "revert") | ("staged", "unstage")
            )
        {
            return Err("Invalid change action.".to_string());
        }
        let pathspec = format!(":(literal){file}");
        let untracked = !Command::new("git")
            .args(["-C", &root, "ls-files", "--error-unmatch", "--", &pathspec])
            .output()
            .map_err(|error| error.to_string())?
            .status
            .success();
        let current = git_patch(&root, &file, &area, untracked && area == "unstaged")?;
        if current.is_empty() || current != expected_patch {
            return Err("The diff changed. Refresh before applying this action.".into());
        }
        let patch = if let Some(ordinal) = hunk {
            selected_hunk(&current, ordinal)?
        } else {
            current
        };
        let mut command = Command::new("git");
        command.args(["-C", &root, "apply"]);
        if area == "staged" || action == "stage" {
            command.arg("--cached");
        }
        if action != "stage" {
            command.arg("--reverse");
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| error.to_string())?;
        child
            .stdin
            .take()
            .ok_or_else(|| "Could not apply selected change.".to_string())?
            .write_all(patch.as_bytes())
            .map_err(|error| error.to_string())?;
        let output = child
            .wait_with_output()
            .map_err(|error| error.to_string())?;
        if !output.status.success() {
            return Err(String::from_utf8_lossy(&output.stderr).into_owned());
        }
        Ok(())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn diff_file_contents(path: String, file: String, side: String) -> Result<Option<String>, String> {
    let root = validate_repository(path)?;
    let relative = Path::new(&file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Invalid diff file path.".into());
    }
    if side == "old" {
        let output = Command::new("git")
            .args(["-C", &root, "show", &format!("HEAD:{file}")])
            .output()
            .map_err(|error| error.to_string())?;
        return Ok(output
            .status
            .success()
            .then(|| String::from_utf8_lossy(&output.stdout).into_owned()));
    }
    if side != "new" {
        return Err("Invalid diff side.".into());
    }
    let target = Path::new(&root).join(relative);
    if !target.exists() {
        return Ok(None);
    }
    let canonical = target.git_canonical().map_err(|error| error.to_string())?;
    if !canonical.starts_with(&root) || !canonical.is_file() {
        return Err("Diff file is outside the repository.".into());
    }
    Ok(Some(
        std::fs::read_to_string(canonical).map_err(|error| error.to_string())?,
    ))
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct CreatedWorktree {
    path: String,
    branch: String,
    base: String,
    setup: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    shipping_target: Option<ShippingTarget>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShippingTarget {
    repository: String,
    remote: String,
    base_branch: String,
    base_ref: String,
    base_revision: String,
}

fn shipping_target(
    repository: &Path,
    worktree: &Path,
    branch: &str,
) -> Result<ShippingTarget, String> {
    let target = github::target_repository(repository)?;
    let (remote, configured_remote) = shipping_fetch_source(repository, &target)?;
    let base_branch = shipping_default_branch(repository, &remote)?;
    let base_ref = if configured_remote {
        format!("refs/remotes/{remote}/{base_branch}")
    } else {
        "refs/sail-shipping/default".to_string()
    };
    let base_revision = git_reference(worktree, &["merge-base", branch, &base_ref])
        .or_else(|| {
            git_reference(
                repository,
                &["rev-parse", "--verify", &format!("{base_ref}^{{commit}}")],
            )
        })
        .ok_or("Cannot resolve the shipping base commit.".to_string())?;
    Ok(ShippingTarget {
        repository: target,
        remote,
        base_branch,
        base_ref,
        base_revision,
    })
}

#[tauri::command]
async fn shipping_worktree_target(
    repository: String,
    worktree: String,
    branch: String,
) -> Result<ShippingTarget, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = validate_repository(repository)?;
        let worktree = validate_repository(worktree)?;
        let actual_branch = git_reference(Path::new(&worktree), &["branch", "--show-current"])
            .ok_or("Shipping worktree is detached.".to_string())?;
        if actual_branch != branch {
            return Err("Shipping worktree branch changed.".to_string());
        }
        shipping_target(Path::new(&repository), Path::new(&worktree), &branch)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct RegisteredWorktree {
    path: String,
    branch: Option<String>,
    present: bool,
}

#[tauri::command]
fn registered_worktrees(
    repository: String,
    paths: Vec<String>,
) -> Result<Vec<RegisteredWorktree>, String> {
    let repository = validate_repository(repository)?;
    let listed = git_reference(
        Path::new(&repository),
        &["worktree", "list", "--porcelain", "-z"],
    )
    .ok_or("Cannot inspect repository worktrees.")?;
    let registered = parse_registered_worktrees(&listed)
        .into_iter()
        .filter(|entry| entry.present)
        .filter_map(|entry| {
            Path::new(&entry.path)
                .git_canonical()
                .ok()
                .map(|path| (path, entry.branch))
        })
        .collect::<std::collections::HashMap<_, _>>();
    Ok(paths
        .into_iter()
        .filter_map(|path| {
            let branch = registered.get(&Path::new(&path).git_canonical().ok()?)?;
            Some(RegisteredWorktree {
                path,
                branch: branch.clone(),
                present: true,
            })
        })
        .collect())
}

fn parse_registered_worktrees(listed: &str) -> Vec<RegisteredWorktree> {
    listed
        .split("\0\0")
        .filter_map(|entry| {
            let path = entry
                .split('\0')
                .find_map(|line| line.strip_prefix("worktree "))?;
            let branch = entry
                .split('\0')
                .find_map(|line| line.strip_prefix("branch refs/heads/"))
                .map(str::to_string);
            let prunable = entry
                .split('\0')
                .any(|line| line == "prunable" || line.starts_with("prunable "));
            Some(RegisteredWorktree {
                path: path.to_string(),
                branch,
                present: !prunable && Path::new(path).is_dir(),
            })
        })
        .collect()
}

#[tauri::command]
fn worktree_config(worktree: String) -> Result<Option<worktree_config::WorktreeConfig>, String> {
    let root = validate_repository(worktree)?;
    worktree_config::read(Path::new(&root))
}

fn git_reference(repository: &Path, args: &[&str]) -> Option<String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(args)
        .output()
        .ok()?;
    if !output.status.success() {
        return None;
    }
    let value = String::from_utf8(output.stdout).ok()?;
    let value = value.trim();
    (!value.is_empty()).then(|| value.to_string())
}

fn worktree_base(repository: &Path) -> String {
    if let Some(reference) = git_reference(
        repository,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    ) {
        return reference;
    }
    for reference in ["origin/main", "origin/master", "main", "master"] {
        if git_reference(repository, &["rev-parse", "--verify", reference]).is_some() {
            return reference.to_string();
        }
    }
    if let Some(worktrees) = git_reference(repository, &["worktree", "list", "--porcelain"]) {
        if let Some(branch) = worktrees.split("\n\n").next().and_then(|entry| {
            entry
                .lines()
                .find_map(|line| line.strip_prefix("branch refs/heads/"))
        }) {
            return branch.to_string();
        }
    }
    "HEAD".to_string()
}

fn repository_namespace(repository: &Path) -> String {
    let mut hash = 0xcbf29ce484222325_u64;
    for byte in repository.to_string_lossy().as_bytes() {
        hash = (hash ^ u64::from(*byte)).wrapping_mul(0x100000001b3);
    }
    let name = repository.file_name().unwrap_or_default().to_string_lossy();
    format!("{name}-{hash:016x}")
}

#[tauri::command]
async fn create_worktree(
    operation_locks: State<'_, WorktreeOperationLocks>,
    repository: String,
    name: String,
    destination_parent: Option<String>,
    base_ref: Option<String>,
) -> Result<CreatedWorktree, String> {
    let operation_locks = operation_locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = validate_repository(repository)?;
        let _lock = operation_locks.lock(Path::new(&repository))?;
        add_worktree(repository, name, destination_parent, base_ref)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn create_shipping_worktree(
    operation_locks: State<'_, WorktreeOperationLocks>,
    repository: String,
    name: String,
) -> Result<CreatedWorktree, String> {
    let operation_locks = operation_locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let checked = validate_repository(repository)?;
        let _lock = operation_locks.lock(Path::new(&checked))?;
        if let Some(existing) = existing_shipping_worktree(Path::new(&checked), &name)? {
            return Ok(existing);
        }
        let target = github::target_repository(Path::new(&checked))?;
        let (source, configured_remote) = shipping_fetch_source(Path::new(&checked), &target)?;
        let branch = shipping_default_branch(Path::new(&checked), &source)?;
        let default_ref = if configured_remote {
            format!("refs/remotes/{source}/{branch}")
        } else {
            "refs/sail-shipping/default".to_string()
        };
        let output = Command::new("git")
            .arg("-C")
            .arg(&checked)
            .args([
                "fetch",
                &source,
                &format!("+refs/heads/{branch}:{default_ref}"),
            ])
            .output()
            .map_err(|error| format!("Cannot fetch default branch: {error}"))?;
        if !output.status.success() {
            return Err(format!(
                "Cannot fetch default branch: {}",
                String::from_utf8_lossy(&output.stderr).trim()
            ));
        }
        let base_revision = git_reference(
            Path::new(&checked),
            &[
                "rev-parse",
                "--verify",
                &format!("{default_ref}^{{commit}}"),
            ],
        )
        .ok_or("Cannot resolve the fetched shipping base commit.".to_string())?;
        let mut created = add_worktree(checked, name, None, Some(default_ref.clone()))?;
        created.shipping_target = Some(ShippingTarget {
            repository: target,
            remote: source,
            base_branch: branch,
            base_ref: default_ref,
            base_revision,
        });
        Ok(created)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn find_shipping_worktree(
    repository: String,
    name: String,
) -> Result<Option<CreatedWorktree>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = validate_repository(repository)?;
        existing_shipping_worktree(Path::new(&repository), &name)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_shipping_setup(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validate_repository(path)?;
        let command = worktree_config::read(Path::new(&path))?
            .ok_or("Worktree setup is no longer configured.")?
            .setup;
        let shell = if cfg!(windows) { "cmd" } else { "sh" };
        let flag = if cfg!(windows) { "/C" } else { "-c" };
        let log_path =
            std::env::temp_dir().join(format!("sail-shipping-setup-{}.log", uuid::Uuid::new_v4()));
        let result = (|| {
            let log = std::fs::File::create(&log_path)
                .map_err(|error| format!("Cannot capture worktree setup: {error}"))?;
            let mut process = Command::new(shell);
            process.args([flag, &command]).current_dir(path);
            #[cfg(unix)]
            process.process_group(0);
            let mut child = process
                .stdout(Stdio::from(log.try_clone().map_err(|error| {
                    format!("Cannot capture worktree setup: {error}")
                })?))
                .stderr(Stdio::from(log))
                .spawn()
                .map_err(|error| format!("Cannot start worktree setup: {error}"))?;
            let started = Instant::now();
            loop {
                let status = match child.try_wait() {
                    Ok(status) => status,
                    Err(error) => {
                        stop_child(&mut child);
                        return Err(format!("Cannot inspect worktree setup: {error}"));
                    }
                };
                if let Some(status) = status {
                    if status.success() {
                        return Ok(());
                    }
                    let output = std::fs::read(&log_path).unwrap_or_default();
                    return Err(format!(
                        "Worktree setup failed: {}",
                        String::from_utf8_lossy(&output[output.len().saturating_sub(8192)..])
                            .trim()
                    ));
                }
                if started.elapsed() >= Duration::from_secs(600) {
                    stop_child(&mut child);
                    return Err("Worktree setup timed out after 10 minutes.".to_string());
                }
                std::thread::sleep(Duration::from_millis(100));
            }
        })();
        let _ = std::fs::remove_file(log_path);
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

fn add_worktree(
    repository: String,
    name: String,
    destination_parent: Option<String>,
    base_ref: Option<String>,
) -> Result<CreatedWorktree, String> {
    let repository = validate_repository(repository)?;
    let repository = Path::new(&repository);
    let name = name.trim();
    if name.is_empty()
        || name.len() > 64
        || !name.chars().all(|character| {
            character.is_ascii_alphanumeric() || character == '-' || character == '_'
        })
    {
        return Err(
            "Use 1–64 letters, numbers, dashes, or underscores for the worktree name.".to_string(),
        );
    }
    let valid_branch = Command::new("git")
        .args(["check-ref-format", "--branch", name])
        .output()
        .map_err(|_| "Git is unavailable. Install Git to create a worktree.".to_string())?;
    if !valid_branch.status.success() {
        return Err("This name is not a valid Git branch name.".to_string());
    }
    let parent = match destination_parent {
        Some(path) => {
            let parent = Path::new(&path)
                .git_canonical()
                .map_err(|_| "Worktree destination does not exist.".to_string())?;
            if !parent.is_dir() {
                return Err("Worktree destination is not a directory.".to_string());
            }
            parent
        }
        None => {
            let root = if let Some(root) = std::env::var_os("SAIL_WORKTREE_ROOT") {
                let root = PathBuf::from(root);
                if !root.is_absolute() {
                    return Err("SAIL_WORKTREE_ROOT must be an absolute path.".to_string());
                }
                root
            } else {
                let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                    .ok_or("Home directory is unavailable. Choose a worktree destination.")?;
                Path::new(&home).join("sail").join("worktrees")
            };
            root.join(repository_namespace(repository))
        }
    };
    let path = parent.join(name);
    if path.exists() {
        return Err("A folder with this worktree name already exists.".to_string());
    }
    std::fs::create_dir_all(&parent)
        .map_err(|error| format!("Cannot create worktree folder: {error}"))?;
    let base = if let Some(reference) = base_ref.filter(|value| !value.trim().is_empty()) {
        let reference = reference.trim();
        if reference.starts_with('-')
            || git_reference(repository, &["rev-parse", "--verify", reference]).is_none()
        {
            return Err("Base branch or reference does not exist.".to_string());
        }
        reference.to_string()
    } else {
        worktree_base(repository)
    };
    let output = Command::new("git")
        .args(["-c", "checkout.workers=8"])
        .arg("-C")
        .arg(repository)
        .args(["worktree", "add", "-b", name])
        .arg(&path)
        .arg(&base)
        .output()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot create worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let path = path
        .git_canonical()
        .map_err(|error| format!("Cannot resolve new worktree: {error}"))?;
    let config = (|| -> Result<Option<worktree_config::WorktreeConfig>, String> {
        let config = worktree_config::read(&path)?;
        if let Some(config) = &config {
            worktree_config::copy_ignored(repository, &path, config)?;
        }
        Ok(config)
    })();
    let config = match config {
        Ok(config) => config,
        Err(error) => {
            let removed = Command::new("git")
                .arg("-C")
                .arg(repository)
                .args(["worktree", "remove", "--force"])
                .arg(&path)
                .output();
            if removed.is_ok_and(|output| output.status.success()) {
                let _ = Command::new("git")
                    .arg("-C")
                    .arg(repository)
                    .args(["branch", "-D", name])
                    .output();
            }
            return Err(error);
        }
    };
    Ok(CreatedWorktree {
        path: path.to_string_lossy().into_owned(),
        branch: name.to_string(),
        base,
        setup: config.map(|config| config.setup).unwrap_or_default(),
        shipping_target: None,
    })
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeleteWorktreeRequest {
    repository: String,
    worktree: String,
    force: Option<bool>,
    archive_ignored: Option<bool>,
    expected_revision: Option<String>,
    expected_branch: Option<String>,
    native_generation: Option<u64>,
    open_code_session_ids: Option<Vec<String>>,
}

#[derive(serde::Deserialize)]
struct OpenCodeCleanupSession {
    id: String,
    #[serde(rename = "parentID")]
    parent_id: Option<String>,
}

#[derive(serde::Deserialize)]
struct OpenCodeCleanupCursor {
    next: Option<String>,
}

#[derive(serde::Deserialize)]
struct OpenCodeCleanupPage {
    data: Vec<OpenCodeCleanupSession>,
    cursor: OpenCodeCleanupCursor,
}

#[derive(serde::Deserialize)]
struct OpenCodeCleanupActive {
    data: HashMap<String, serde_json::Value>,
}

#[derive(serde::Deserialize)]
struct OpenCodeCleanupInbox {
    data: Vec<serde_json::Value>,
}

fn verify_open_code_cleanup_state(
    expected: &HashSet<String>,
    sessions: &[OpenCodeCleanupSession],
    active: &HashSet<String>,
    queued: &HashSet<String>,
) -> Result<HashSet<String>, String> {
    let mut owned = expected.clone();
    loop {
        let previous = owned.len();
        for session in sessions {
            if session
                .parent_id
                .as_ref()
                .is_some_and(|parent_id| owned.contains(parent_id))
            {
                owned.insert(session.id.clone());
            }
        }
        if owned.len() == previous {
            break;
        }
    }
    if owned.iter().any(|id| !expected.contains(id)) {
        return Err("OpenCode task sessions changed before worktree cleanup.".into());
    }
    if owned
        .iter()
        .any(|id| active.contains(id) || queued.contains(id))
    {
        return Err("An OpenCode task session is active in this worktree.".into());
    }
    Ok(owned)
}

fn load_open_code_cleanup_sessions(
    client: &reqwest::blocking::Client,
    info: &RuntimeInfo,
    directory: &str,
) -> Result<Vec<OpenCodeCleanupSession>, String> {
    let diagnostic = "Cannot verify OpenCode task sessions before worktree cleanup.";
    let base = info.url.trim_end_matches('/');
    let mut sessions = Vec::new();
    let mut cursor: Option<String> = None;
    let mut seen = HashSet::new();
    loop {
        let mut url = reqwest::Url::parse(&format!("{base}/api/session"))
            .map_err(|_| diagnostic.to_string())?;
        match cursor.as_ref() {
            Some(cursor) => {
                url.query_pairs_mut().append_pair("cursor", cursor);
            }
            None => {
                url.query_pairs_mut()
                    .append_pair("directory", directory)
                    .append_pair("limit", "50")
                    .append_pair("order", "asc");
            }
        }
        let response = client
            .get(url)
            .basic_auth("opencode", Some(&info.password))
            .send()
            .map_err(|_| diagnostic.to_string())?;
        if !response.status().is_success() {
            return Err(diagnostic.into());
        }
        let page: OpenCodeCleanupPage = response.json().map_err(|_| diagnostic.to_string())?;
        sessions.extend(page.data);
        let Some(next) = page.cursor.next else {
            break;
        };
        if !seen.insert(next.clone()) {
            return Err(diagnostic.into());
        }
        cursor = Some(next);
    }
    Ok(sessions)
}

fn load_open_code_cleanup_activity<Inbox, Active>(
    owned: &HashSet<String>,
    sessions: &[OpenCodeCleanupSession],
    mut load_inbox: Inbox,
    load_active: Active,
) -> Result<(HashSet<String>, HashSet<String>), String>
where
    Inbox: FnMut(&str) -> Result<bool, String>,
    Active: FnOnce() -> Result<HashSet<String>, String>,
{
    let mut queued = HashSet::new();
    for id in owned {
        if sessions.iter().any(|session| session.id == *id) && load_inbox(id)? {
            queued.insert(id.clone());
        }
    }
    Ok((load_active()?, queued))
}

fn verify_open_code_cleanup(
    info: &RuntimeInfo,
    directory: &Path,
    expected_ids: Vec<String>,
) -> Result<(), String> {
    let diagnostic = "Cannot verify OpenCode task sessions before worktree cleanup.";
    let client = reqwest::blocking::Client::builder()
        .timeout(Duration::from_secs(2))
        .no_proxy()
        .build()
        .map_err(|_| diagnostic.to_string())?;
    let base = info.url.trim_end_matches('/');
    let authorize = |request: reqwest::blocking::RequestBuilder| {
        request.basic_auth("opencode", Some(&info.password))
    };
    let directory = directory.to_string_lossy().into_owned();
    let sessions = load_open_code_cleanup_sessions(&client, info, &directory)?;
    let expected = expected_ids.into_iter().collect::<HashSet<_>>();
    verify_open_code_cleanup_state(&expected, &sessions, &HashSet::new(), &HashSet::new())?;
    let sessions = load_open_code_cleanup_sessions(&client, info, &directory)?;
    let owned =
        verify_open_code_cleanup_state(&expected, &sessions, &HashSet::new(), &HashSet::new())?;
    let (active, queued) = load_open_code_cleanup_activity(
        &owned,
        &sessions,
        |id| {
            let response = authorize(client.get(format!("{base}/api/session/{id}/inbox")))
                .send()
                .map_err(|_| diagnostic.to_string())?;
            if !response.status().is_success() {
                return Err(diagnostic.into());
            }
            let inbox: OpenCodeCleanupInbox =
                response.json().map_err(|_| diagnostic.to_string())?;
            Ok(!inbox.data.is_empty())
        },
        || {
            let response = authorize(client.get(format!("{base}/api/session/active")))
                .send()
                .map_err(|_| diagnostic.to_string())?;
            if !response.status().is_success() {
                return Err(diagnostic.into());
            }
            let active: OpenCodeCleanupActive =
                response.json().map_err(|_| diagnostic.to_string())?;
            Ok(active.data.into_keys().collect())
        },
    )?;
    let sessions = load_open_code_cleanup_sessions(&client, info, &directory)?;
    verify_open_code_cleanup_state(&expected, &sessions, &active, &queued)?;
    Ok(())
}

#[tauri::command]
async fn delete_worktree(
    operation_locks: State<'_, WorktreeOperationLocks>,
    agents: State<'_, acp::AgentManager>,
    fence: State<'_, acp::AgentWorktreeFence>,
    runtime: State<'_, RuntimeManager>,
    request: DeleteWorktreeRequest,
) -> Result<Option<String>, String> {
    let DeleteWorktreeRequest {
        repository,
        worktree,
        force,
        archive_ignored,
        expected_revision,
        expected_branch,
        native_generation,
        open_code_session_ids,
    } = request;
    let operation_locks = operation_locks.inner().clone();
    let agents = agents.inner().clone();
    let fence = fence.inner().clone();
    let runtime_info = runtime
        .0
        .lock()
        .map_err(|error| error.to_string())?
        .as_ref()
        .map(|runtime| runtime.info.clone());
    tauri::async_runtime::spawn_blocking(move || {
        let checked = validate_repository(repository)?;
        let _lock = operation_locks.lock(Path::new(&checked))?;
        let directory = PathBuf::from(&worktree)
            .git_canonical()
            .unwrap_or_else(|_| PathBuf::from(&worktree));
        fence.cleanup(&agents, &directory, native_generation, || {
            if let Some(session_ids) = open_code_session_ids {
                let info = runtime_info
                    .as_ref()
                    .ok_or("Cannot verify OpenCode task sessions before worktree cleanup.")?;
                verify_open_code_cleanup(info, &directory, session_ids)?;
            }
            if archive_ignored == Some(true) {
                archive_ignored_and_remove(checked, worktree, expected_revision, expected_branch)
            } else {
                remove_worktree(
                    checked,
                    worktree,
                    force,
                    expected_revision.as_deref(),
                    expected_branch.as_deref(),
                )?;
                Ok(None)
            }
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn archive_ignored_and_remove(
    repository: String,
    worktree: String,
    expected_revision: Option<String>,
    expected_branch: Option<String>,
) -> Result<Option<String>, String> {
    archive_ignored_and_remove_with_hook(
        repository,
        worktree,
        expected_revision,
        expected_branch,
        |_| Ok(()),
    )
}

#[cfg(unix)]
fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::ffi::CString;
    use std::os::unix::ffi::OsStrExt;

    let source = CString::new(source.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    let destination = CString::new(destination.as_os_str().as_bytes())
        .map_err(|error| std::io::Error::new(std::io::ErrorKind::InvalidInput, error))?;
    #[cfg(target_os = "macos")]
    let result = unsafe {
        nix::libc::renamex_np(
            source.as_ptr(),
            destination.as_ptr(),
            nix::libc::RENAME_EXCL,
        )
    };
    #[cfg(target_os = "linux")]
    let result = unsafe {
        nix::libc::renameat2(
            nix::libc::AT_FDCWD,
            source.as_ptr(),
            nix::libc::AT_FDCWD,
            destination.as_ptr(),
            nix::libc::RENAME_NOREPLACE,
        )
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

#[cfg(windows)]
fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source = source
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = destination
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    // Omitting MOVEFILE_REPLACE_EXISTING makes the native rename fail atomically
    // when another process has recreated the destination.
    let result = unsafe { MoveFileExW(source.as_ptr(), destination.as_ptr(), 0) };
    if result != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}

fn rollback_staged_archive(
    staging: &Path,
    worktree: &Path,
    moved: &[PathBuf],
) -> Result<(), String> {
    let mut failures = Vec::new();
    for relative in moved.iter().rev() {
        let source = staging.join(relative);
        let destination = worktree.join(relative);
        if let Some(parent) = destination.parent() {
            if let Err(error) = std::fs::create_dir_all(parent) {
                failures.push(format!("{}: {error}", relative.display()));
                continue;
            }
        }
        if let Err(error) = rename_without_replace(&source, &destination) {
            failures.push(format!(
                "{}: {error}; original remains staged at {}",
                relative.display(),
                source.display()
            ));
        }
    }
    if failures.is_empty() {
        let _ = std::fs::remove_dir_all(staging);
        Ok(())
    } else {
        Err(format!(
            "Could not restore archived worktree files: {}. Recovery staging: {}",
            failures.join(", "),
            staging.display()
        ))
    }
}

fn archive_ignored_and_remove_with_hook<F>(
    repository: String,
    worktree: String,
    expected_revision: Option<String>,
    expected_branch: Option<String>,
    mut after_move: F,
) -> Result<Option<String>, String>
where
    F: FnMut(&Path) -> Result<(), String>,
{
    const IGNORED: &str = "Worktree has ignored files. Move or remove them before deleting.";
    let worktree = PathBuf::from(worktree);
    let parent = worktree.parent().ok_or("Worktree parent is missing.")?;
    let archive_root = parent.join(".sail-shipping-archive");
    let worktree_name = worktree.file_name().ok_or("Worktree name is missing.")?;
    let archive = archive_root.join(worktree_name);
    let saved_archive = || {
        archive
            .exists()
            .then(|| archive.to_string_lossy().into_owned())
    };
    if !worktree.exists() {
        validate_repository(repository)?;
        return Ok(saved_archive());
    }
    match remove_worktree(
        repository.clone(),
        worktree.to_string_lossy().into_owned(),
        None,
        expected_revision.as_deref(),
        expected_branch.as_deref(),
    ) {
        Ok(()) => return Ok(saved_archive()),
        Err(error) if error == IGNORED => {}
        Err(error) => return Err(error),
    }
    let status = Command::new("git")
        .arg("-C")
        .arg(&worktree)
        .args([
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=normal",
            "-z",
        ])
        .output()
        .map_err(|error| format!("Cannot inspect worktree files before cleanup: {error}"))?;
    if !status.status.success() {
        return Err("Cannot inspect worktree files before cleanup.".to_string());
    }
    let mut ignored = Vec::new();
    for entry in status
        .stdout
        .split(|byte| *byte == 0)
        .filter(|entry| !entry.is_empty())
    {
        if !entry.starts_with(b"!! ") {
            return Err(
                "Worktree has changes outside ignored files. Inspect them before cleanup."
                    .to_string(),
            );
        }
        let path = PathBuf::from(
            String::from_utf8(entry[3..].to_vec())
                .map_err(|_| "Cannot archive a non-UTF-8 ignored path.")?,
        );
        if !path
            .components()
            .all(|part| matches!(part, std::path::Component::Normal(_)))
        {
            return Err("Cannot archive an invalid ignored path.".to_string());
        }
        ignored.push(path);
    }
    if ignored.is_empty() {
        return Err("Ignored worktree files changed during cleanup. Retry.".to_string());
    }
    if archive.exists() {
        return Err(format!(
            "Ignored file archive already exists. Inspect {} before retrying.",
            archive.display()
        ));
    }
    std::fs::create_dir_all(&archive_root)
        .map_err(|error| format!("Cannot prepare ignored file archive: {error}"))?;
    let staging = archive_root.join(format!(
        ".staging-{}-{}",
        worktree_name.to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    std::fs::create_dir(&staging)
        .map_err(|error| format!("Cannot prepare ignored file archive: {error}"))?;
    let mut moved = Vec::new();
    for relative in ignored {
        let destination = staging.join(&relative);
        std::fs::create_dir_all(destination.parent().ok_or("Invalid archive path.")?).map_err(
            |error| {
                let rollback = rollback_staged_archive(&staging, &worktree, &moved);
                format!(
                    "Cannot prepare ignored file archive: {error}{}",
                    rollback
                        .err()
                        .map(|failure| format!("; {failure}"))
                        .unwrap_or_default()
                )
            },
        )?;
        if let Err(error) = std::fs::rename(worktree.join(&relative), &destination) {
            let rollback = rollback_staged_archive(&staging, &worktree, &moved);
            return Err(format!(
                "Cannot archive ignored worktree files to {}: {error}",
                archive.display(),
            ) + &rollback
                .err()
                .map(|failure| format!("; {failure}"))
                .unwrap_or_default());
        }
        moved.push(relative.clone());
        if let Err(error) = after_move(&relative) {
            let rollback = rollback_staged_archive(&staging, &worktree, &moved);
            return Err(error
                + &rollback
                    .err()
                    .map(|failure| format!("; {failure}"))
                    .unwrap_or_default());
        }
    }
    if let Err(error) = remove_worktree(
        repository,
        worktree.to_string_lossy().into_owned(),
        None,
        expected_revision.as_deref(),
        expected_branch.as_deref(),
    ) {
        let rollback = rollback_staged_archive(&staging, &worktree, &moved);
        return Err(error
            + &rollback
                .err()
                .map(|failure| format!("; {failure}"))
                .unwrap_or_default());
    }
    std::fs::rename(&staging, &archive).map_err(|error| {
        format!(
            "Worktree was removed, but its ignored files remain preserved at {}: {error}",
            staging.display()
        )
    })?;
    Ok(saved_archive())
}

#[derive(Debug, Eq, PartialEq)]
struct GuardedRemovalState {
    reference: Option<String>,
    head: String,
}

struct WorktreeHeadLock(PathBuf);

impl Drop for WorktreeHeadLock {
    fn drop(&mut self) {
        let _ = std::fs::remove_file(&self.0);
    }
}

fn lock_worktree_head(worktree: &Path) -> Result<WorktreeHeadLock, String> {
    use std::ffi::OsString;
    use std::fs::OpenOptions;

    let head = git_reference(worktree, &["rev-parse", "--git-path", "HEAD"])
        .ok_or("Cannot locate the worktree HEAD before deletion.")?;
    let head = PathBuf::from(head);
    let head = if head.is_absolute() {
        head
    } else {
        worktree.join(head)
    };
    let mut lock_name = OsString::from(head.as_os_str());
    lock_name.push(".lock");
    let lock = PathBuf::from(lock_name);
    OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|error| format!("Cannot lock the worktree checkout before deletion: {error}"))?;
    Ok(WorktreeHeadLock(lock))
}

fn guarded_removal_state(
    worktree: &Path,
    guarded: bool,
) -> Result<Option<GuardedRemovalState>, String> {
    if !guarded {
        return Ok(None);
    }
    let reference = git_reference(worktree, &["symbolic-ref", "-q", "HEAD"]);
    let head = git_reference(worktree, &["rev-parse", "HEAD"])
        .ok_or("Cannot capture the worktree commit before deletion.")?;
    Ok(Some(GuardedRemovalState { reference, head }))
}

fn restore_changed_worktree(
    repository: &Path,
    worktree: &Path,
    state: &GuardedRemovalState,
) -> Result<(), String> {
    let branch = state
        .reference
        .as_deref()
        .ok_or("Cannot restore a detached worktree after it changed during deletion.")?
        .strip_prefix("refs/heads/")
        .ok_or("Cannot restore a non-local worktree branch.")?;
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["worktree", "add"])
        .arg(worktree)
        .arg(branch)
        .output()
        .map_err(|error| format!("Cannot restore the changed worktree: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Cannot restore the changed worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn remove_worktree(
    repository: String,
    worktree: String,
    force: Option<bool>,
    expected_revision: Option<&str>,
    expected_branch: Option<&str>,
) -> Result<(), String> {
    remove_worktree_with_hook(
        repository,
        worktree,
        force,
        expected_revision,
        expected_branch,
        || Ok(()),
    )
}

fn remove_worktree_with_hook<F>(
    repository: String,
    worktree: String,
    force: Option<bool>,
    expected_revision: Option<&str>,
    expected_branch: Option<&str>,
    before_remove: F,
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
{
    remove_worktree_with_hooks(
        repository,
        worktree,
        force,
        expected_revision,
        expected_branch,
        (before_remove, || Ok(()), || Ok(())),
    )
}

fn remove_worktree_with_hooks<F, G, H>(
    repository: String,
    worktree: String,
    force: Option<bool>,
    expected_revision: Option<&str>,
    expected_branch: Option<&str>,
    hooks: (F, G, H),
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
    G: FnOnce() -> Result<(), String>,
    H: FnOnce() -> Result<(), String>,
{
    let (before_final_identity_check, after_final_identity_check, after_remove) = hooks;
    let repository = PathBuf::from(validate_repository(repository)?)
        .git_canonical()
        .map_err(|_| "Repository folder no longer exists.".to_string())?;
    let worktree = Path::new(&worktree)
        .git_canonical()
        .map_err(|_| "Worktree folder no longer exists.".to_string())?;
    if worktree == repository {
        return Err("Cannot delete the main repository.".to_string());
    }
    let listed = git_reference(&repository, &["worktree", "list", "--porcelain"])
        .ok_or("Cannot inspect repository worktrees.")?;
    let registered = listed
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "));
    if !registered.into_iter().any(|path| {
        Path::new(path)
            .git_canonical()
            .is_ok_and(|registered| registered == worktree)
    }) {
        return Err("This folder is not a worktree of the selected repository.".to_string());
    }
    let ensure_expected_revision = || -> Result<(), String> {
        let Some(expected) = expected_revision else {
            return Ok(());
        };
        let actual = git_directory_revision(&worktree)?;
        if actual != expected {
            return Err(
                "Worktree changed after validation. Revalidate before deleting it.".to_string(),
            );
        }
        Ok(())
    };
    let ensure_expected_branch = || -> Result<(), String> {
        let Some(expected) = expected_branch else {
            return Ok(());
        };
        let expected = expected.strip_prefix("refs/heads/").unwrap_or(expected);
        let actual = git_reference(&worktree, &["symbolic-ref", "--quiet", "--short", "HEAD"])
            .ok_or("Cannot read the worktree branch before deletion.")?;
        if actual != expected {
            return Err(format!(
                "Worktree branch changed from {expected} to {actual}. Revalidate before deleting it."
            ));
        }
        Ok(())
    };
    ensure_expected_revision()?;
    ensure_expected_branch()?;
    let force = force == Some(true);
    if !force {
        let status = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args([
                "status",
                "--porcelain=v1",
                "--ignored",
                "--untracked-files=normal",
            ])
            .output()
            .map_err(|error| format!("Cannot start Git: {error}"))?;
        if !status.status.success() {
            return Err("Cannot inspect worktree files before deletion.".to_string());
        }
        if String::from_utf8_lossy(&status.stdout)
            .lines()
            .any(|line| line.starts_with("!! "))
        {
            return Err(
                "Worktree has ignored files. Move or remove them before deleting.".to_string(),
            );
        }
    }
    ensure_expected_revision()?;
    ensure_expected_branch()?;
    let guarded = guarded_removal_state(
        &worktree,
        expected_revision.is_some() || expected_branch.is_some(),
    )?;
    if guarded
        .as_ref()
        .is_some_and(|state| state.reference.is_none())
    {
        return Err(
            "Guarded cleanup requires a branch checkout; the worktree is detached.".to_string(),
        );
    }
    before_final_identity_check()?;
    let _head_lock = guarded
        .as_ref()
        .map(|_| lock_worktree_head(&worktree))
        .transpose()?;
    if let Some(state) = guarded.as_ref() {
        let actual = guarded_removal_state(&worktree, true)?
            .ok_or("Cannot capture the worktree identity before deletion.")?;
        if actual != *state {
            return Err(
                "Worktree checkout changed during deletion. Revalidate before deleting it."
                    .to_string(),
            );
        }
    }
    after_final_identity_check()?;
    let mut command = Command::new("git");
    command
        .arg("-C")
        .arg(&repository)
        .args(["worktree", "remove"]);
    if force {
        command.arg("--force");
    }
    let output = command
        .arg(&worktree)
        .output()
        .map_err(|error| format!("Cannot start Git: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot delete worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    after_remove()?;
    let listed = git_reference(&repository, &["worktree", "list", "--porcelain", "-z"])
        .ok_or("Cannot verify repository worktrees after deletion.")?;
    let re_registered = parse_registered_worktrees(&listed)
        .into_iter()
        .any(|entry| {
            let registered = Path::new(&entry.path);
            registered == worktree
                || registered
                    .git_canonical()
                    .is_ok_and(|registered| registered == worktree)
        });
    if re_registered {
        return Err(
            "The worktree path was registered again during deletion. Refresh before continuing."
                .to_string(),
        );
    }
    if let Some(state) = guarded {
        let reference = state
            .reference
            .as_deref()
            .ok_or("Cannot verify the removed detached worktree.")?;
        let current = git_reference(&repository, &["rev-parse", "--verify", reference]);
        if current.as_deref() != Some(state.head.as_str()) {
            let restore = restore_changed_worktree(&repository, &worktree, &state);
            return Err(format!(
                "Worktree changed during deletion. Its branch {} preserves the new commit.{}",
                reference,
                restore
                    .err()
                    .map(|error| format!(" {error}"))
                    .unwrap_or_else(|| " The checkout was restored.".to_string())
            ));
        }
    }
    Ok(())
}

#[tauri::command]
fn local_plugin_version(path: String) -> Option<String> {
    let source = Path::new(&path);
    let directory = if source.is_dir() {
        source
    } else {
        source.parent()?
    };
    let package_path = directory.join("package.json");
    let metadata = std::fs::metadata(&package_path).ok()?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return None;
    }
    let package = std::fs::read_to_string(package_path).ok()?;
    let package: serde_json::Value = serde_json::from_str(&package).ok()?;
    if package.get("name")?.as_str()? != "@smykla-skalski/opencode-plugin-plan-review" {
        return None;
    }
    package.get("version")?.as_str().map(str::to_string)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            if let Err(error) = diagnostics::init(_app.handle()) {
                eprintln!("Sail diagnostics unavailable: {error}");
            }
            browser_agent::start_bridge(_app.handle())?;
            if let Err(error) = hook_activity::start_bridge(_app.handle()) {
                eprintln!("Sail hook receiver unavailable: {error}");
            }
            #[cfg(any(target_os = "macos", windows))]
            configure_pane_menu(_app.handle())?;
            Ok(())
        })
        .manage(RuntimeManager::default())
        .manage(WorktreeOperationLocks::default())
        .manage(acp::AgentManager::default())
        .manage(acp::AgentWorktreeFence::default())
        .manage(acp_terminal::AcpTerminalManager::default())
        .manage(terminal::TerminalManager::default())
        .manage(post_turn_checks::CheckLock::default())
        .manage(shell_command::ShellRuns::default())
        .manage(browser_agent::BrowserManager::default())
        .manage(browser::CaptureStore::default())
        .manage(hook_activity::HookActivityManager::default())
        .invoke_handler(tauri::generate_handler![
            diagnostics::diagnostic_event,
            settings::load_settings,
            settings::migrate_settings,
            settings::save_setting,
            settings::list_interrupted_agent_turns,
            settings::finish_interrupted_agent_turn,
            settings::get_acp_turn_evidence,
            start_runtime,
            repository_path_available,
            opencode_config::opencode_plan_review_plugin,
            validate_repository,
            list_picker_directory,
            working_tree_diff,
            working_tree_revision,
            working_tree_generation,
            working_tree_commit,
            shipping_base_revision,
            shipping_worktree_target,
            shipping_changed_paths,
            worktree_overviews,
            worktree_snapshots::record_turn_snapshot,
            worktree_snapshots::list_turn_snapshots,
            worktree_snapshots::restore_turn_snapshot,
            git_change_action,
            diff_file_contents,
            create_worktree,
            create_shipping_worktree,
            find_shipping_worktree,
            run_shipping_setup,
            registered_worktrees,
            delete_worktree,
            worktree_config,
            post_turn_checks::approve_post_turn_check,
            post_turn_checks::is_post_turn_check_approved,
            post_turn_checks::cancel_post_turn_check,
            post_turn_checks::list_post_turn_checks,
            post_turn_checks::run_post_turn_check,
            shell_command::run_shell_command,
            shell_command::cancel_shell_command,
            hook_inspector::inspect_agent_hooks,
            hook_activity::inspect_hook_integration,
            hook_activity::enable_hook_integration,
            hook_activity::remove_hook_integration,
            hook_activity::list_hook_activity,
            github::create_pull_request,
            github::list_open_issues,
            github::open_issue,
            github::github_issue_repository,
            github::publish_issue_graph,
            github::load_issue_graph,
            github::shipping_target_repository,
            github::shipping_pull_request,
            github::shipping_dependency_closed,
            github::acquire_shipping_claim,
            github::observe_shipping_claim,
            github::complete_predecessor_shipping_claim_fence,
            github::heartbeat_shipping_claim,
            github::release_shipping_claim,
            ship_actions::ship_merge_pull_request,
            ship_actions::ship_reopen_pull_request,
            ship_actions::ship_issue_title,
            github::pull_request_checks,
            github::failed_check_log,
            github::open_pull_request,
            github::open_check_url,
            github::open_external_url,
            acp_terminal::acp_terminal_snapshot,
            acp_terminal::acp_terminal_delta,
            acp_terminal::acp_terminal_stop,
            acp_terminal::acp_terminal_inspect_list,
            acp_terminal::acp_terminal_inspect_read,
            acp_terminal::acp_terminal_inspect_wait,
            local_plugin_version,
            acp::acp_agents,
            acp::acp_connect,
            acp::acp_new_session,
            acp::acp_forget_session,
            acp::acp_release_session_fence,
            acp::acp_load_session,
            acp::acp_resume_session,
            acp::acp_prompt,
            acp::acp_steer,
            acp::acp_cancel,
            acp::acp_permission,
            acp::acp_permission_resources_trusted,
            acp::acp_pending_permissions,
            acp::acp_pending_elicitations,
            acp::acp_elicitation,
            acp::acp_pending_inbox,
            acp::acp_activity,
            acp::acp_native_subagents,
            acp::acp_prepare_restart,
            acp::acp_set_config,
            acp::acp_authenticate,
            attention::show_attention_notification,
            attention::set_attention_badge,
            terminal::terminal_open,
            terminal::terminal_detach,
            terminal::terminal_write,
            terminal::terminal_owned_create,
            terminal::terminal_owned_write,
            terminal::terminal_owned_stop,
            terminal::terminal_resize,
            terminal::terminal_close,
            terminal::terminal_open_file,
            terminal::terminal_inspect_list,
            terminal::terminal_inspect_read,
            terminal::terminal_inspect_wait,
            browser::browser_open,
            browser::browser_bounds,
            browser::browser_navigate,
            browser::browser_reload,
            browser::browser_visibility,
            browser::browser_devtools,
            browser::browser_close,
            browser::browser_focus,
            browser::browser_shortcut,
            browser::browser_route,
            browser::browser_picker,
            browser::browser_pick_selection,
            browser::browser_pick_cancel,
            browser::browser_capture,
            browser::browser_save_capture,
            browser::browser_remove_capture,
            browser::clipboard_save_file,
            browser::clipboard_remove_file,
            browser_agent::browser_access_reply,
            browser_agent::agent_coordination_reply,
            browser_agent::browser_project_access,
            browser_agent::browser_mcp_config,
            browser_agent::browser_pane_register,
            browser_detected_servers
        ]);
    #[cfg(feature = "e2e")]
    let builder = builder
        .plugin(tauri_plugin_wdio::init())
        .plugin(tauri_plugin_wdio_webdriver::init());
    builder
        .build(tauri::generate_context!())
        .expect("failed to build Sail")
        .run(|app, event| {
            if let tauri::RunEvent::Exit = event {
                diagnostics::record("app_exit", serde_json::json!({}));
                if let Some(agents) = app.try_state::<acp::AgentManager>() {
                    if agents.record_interrupted_turns(app).is_err() {
                        diagnostics::record("agent_recovery_save_failed", serde_json::json!({}));
                    }
                    agents.shutdown();
                }
                if let Some(terminals) = app.try_state::<acp_terminal::AcpTerminalManager>() {
                    terminals.shutdown();
                }
                if let Some(terminals) = app.try_state::<terminal::TerminalManager>() {
                    terminals.shutdown();
                }
                if let Some(runtime) = app.try_state::<RuntimeManager>() {
                    runtime.shutdown();
                }
                if let Some(manager) = app.try_state::<hook_activity::HookActivityManager>() {
                    hook_activity::cleanup(&manager);
                }
            }
        });
}

#[cfg(test)]
mod tests {
    #[cfg(any(unix, windows))]
    use super::working_tree_generation;
    use super::{
        add_worktree, archive_ignored_and_remove, archive_ignored_and_remove_with_hook,
        existing_shipping_worktree, git_change_action, git_patch, git_reference,
        load_open_code_cleanup_activity, normalize_picker_path, parse_registered_worktrees,
        registered_worktrees, remove_worktree, remove_worktree_with_hook,
        remove_worktree_with_hooks, repository_namespace, server_args, shipping_base_revision,
        shipping_changed_paths, shipping_default_branch, shipping_fetch_source,
        verify_open_code_cleanup_state, version_is_compatible, version_number, working_tree_diff,
        worktree_overviews, OpenCodeCleanupSession, WorktreeOperationLocks,
    };
    use super::{working_tree_commit, working_tree_revision};
    use crate::GitCanonical;
    use std::collections::HashSet;
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    #[cfg(unix)]
    #[test]
    fn shutdown_reaps_runtime_child() {
        let mut command = Command::new("sleep");
        command.arg("30").process_group(0);
        let child = command.spawn().unwrap();
        let watchdog = super::child_watchdog::ChildWatchdog::start(child.id()).unwrap();
        let pid = nix::unistd::Pid::from_raw(child.id() as i32);
        let runtime = super::RuntimeManager(std::sync::Mutex::new(Some(super::OwnedRuntime {
            child,
            watchdog,
            info: super::RuntimeInfo {
                url: String::new(),
                password: String::new(),
                binary_path: String::new(),
            },
            binary: "sleep".into(),
        })));

        runtime.shutdown();

        assert!(matches!(
            nix::sys::signal::kill(pid, None),
            Err(nix::errno::Errno::ESRCH)
        ));
    }

    #[test]
    fn parses_registered_and_prunable_worktrees() {
        let present = std::env::temp_dir();
        let missing = present.join(format!("sail-missing-\n{}", uuid::Uuid::new_v4()));
        let listed = format!(
            "worktree {}\0HEAD abc\0branch refs/heads/main\0\0worktree {}\0HEAD def\0detached\0prunable gitdir missing\0\0",
            present.display(),
            missing.display()
        );
        let worktrees = parse_registered_worktrees(&listed);
        assert_eq!(worktrees.len(), 2);
        assert_eq!(worktrees[0].branch.as_deref(), Some("main"));
        assert!(worktrees[0].present);
        assert_eq!(worktrees[1].branch, None);
        assert_eq!(worktrees[1].path, missing.to_string_lossy());
        assert!(!worktrees[1].present);
    }

    #[test]
    fn registered_worktrees_match_canonical_path_aliases() {
        let root =
            std::env::temp_dir().join(format!("sail-worktree-test-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repository");
        let child = root.join("child");
        fs::create_dir_all(&repository).unwrap();
        let repository = repository.git_canonical().unwrap();
        let repository_path = repository.to_str().unwrap();
        git(repository_path, &["init", "-q"]);
        git(
            repository_path,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "seed",
            ],
        );
        git(
            repository_path,
            &["worktree", "add", "-qb", "child", child.to_str().unwrap()],
        );

        let alias = child.join(".").to_string_lossy().into_owned();
        let matched = registered_worktrees(repository_path.into(), vec![alias.clone()]).unwrap();
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].path, alias);
        assert_eq!(matched[0].branch.as_deref(), Some("child"));

        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn recovers_shipping_worktree_after_interrupted_launch() {
        let root =
            std::env::temp_dir().join(format!("sail-shipping-test-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repository");
        let child = root.join("child");
        fs::create_dir_all(&repository).unwrap();
        let repository = repository.git_canonical().unwrap();
        let repository_path = repository.to_str().unwrap();
        git(repository_path, &["init", "-q"]);
        git(
            repository_path,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "seed",
            ],
        );
        assert!(existing_shipping_worktree(&repository, "ship-issue-7-test")
            .unwrap()
            .is_none());
        git(
            repository_path,
            &[
                "worktree",
                "add",
                "-qb",
                "ship-issue-7-test",
                child.to_str().unwrap(),
            ],
        );
        let recovered = existing_shipping_worktree(&repository, "ship-issue-7-test")
            .unwrap()
            .unwrap();
        assert_eq!(
            recovered.path,
            child.git_canonical().unwrap().to_str().unwrap()
        );
        assert_eq!(recovered.branch, "ship-issue-7-test");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shipping_uses_advertised_default_without_local_origin_head() {
        let root = std::env::temp_dir().join(format!("sail-default-test-{}", uuid::Uuid::new_v4()));
        let remote = root.join("remote.git");
        let repository = root.join("repository");
        fs::create_dir_all(&root).unwrap();
        git(
            root.to_str().unwrap(),
            &["init", "--bare", "-q", remote.to_str().unwrap()],
        );
        git(
            remote.to_str().unwrap(),
            &["symbolic-ref", "HEAD", "refs/heads/develop"],
        );
        fs::create_dir_all(&repository).unwrap();
        let repository_path = repository.to_str().unwrap();
        git(repository_path, &["init", "-q"]);
        git(
            repository_path,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        git(
            repository_path,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "--allow-empty",
                "-qm",
                "seed",
            ],
        );
        git(repository_path, &["branch", "-M", "develop"]);
        git(repository_path, &["push", "-q", "origin", "develop"]);
        git(repository_path, &["checkout", "-qb", "feature"]);
        assert_eq!(
            shipping_default_branch(&repository, "origin").unwrap(),
            "develop"
        );
        git(
            repository_path,
            &["remote", "set-url", "origin", "git@github.com:me/fork.git"],
        );
        git(
            repository_path,
            &["remote", "add", "upstream", "git@github.com:owner/repo.git"],
        );
        assert_eq!(
            shipping_fetch_source(&repository, "owner/repo").unwrap(),
            ("upstream".to_string(), true)
        );
        assert_eq!(
            shipping_fetch_source(&repository, "other/repo").unwrap(),
            ("git@github.com:other/repo.git".to_string(), false)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktree_removal_detects_ignored_directories_and_force_removes_them() {
        let root = std::env::temp_dir().join(format!("sail-delete-test-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repository");
        let parent = root.join("worktrees");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&parent).unwrap();
        let repository = repository.git_canonical().unwrap();
        let repository_path = repository.to_str().unwrap();
        git(repository_path, &["init", "-q"]);
        fs::write(repository.join(".gitignore"), "node_modules/\n").unwrap();
        git(repository_path, &["add", ".gitignore"]);
        git(
            repository_path,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "seed",
            ],
        );
        let created = add_worktree(
            repository_path.into(),
            "child".into(),
            Some(parent.to_string_lossy().into_owned()),
            Some("HEAD".into()),
        )
        .unwrap();
        let ignored = Path::new(&created.path).join("node_modules/package/file.js");
        fs::create_dir_all(ignored.parent().unwrap()).unwrap();
        fs::write(&ignored, "content").unwrap();
        let result = remove_worktree(
            repository_path.into(),
            created.path.clone(),
            None,
            None,
            None,
        );
        assert!(result.unwrap_err().contains("ignored files"));
        assert!(ignored.exists());
        let untracked = Path::new(&created.path).join("notes.txt");
        fs::write(&untracked, "keep").unwrap();
        assert!(archive_ignored_and_remove(
            repository_path.into(),
            created.path.clone(),
            None,
            None
        )
        .unwrap_err()
        .contains("changes outside ignored"));
        assert!(ignored.exists());
        fs::remove_file(untracked).unwrap();
        let archive =
            archive_ignored_and_remove(repository_path.into(), created.path.clone(), None, None)
                .unwrap()
                .unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&archive).join("node_modules/package/file.js")).unwrap(),
            "content"
        );
        assert!(!Path::new(&created.path).exists());
        assert_eq!(
            archive_ignored_and_remove(repository_path.into(), created.path.clone(), None, None)
                .unwrap(),
            Some(archive)
        );
        let forced = add_worktree(
            repository_path.into(),
            "forced".into(),
            Some(parent.to_string_lossy().into_owned()),
            Some("HEAD".into()),
        )
        .unwrap();
        fs::create_dir_all(Path::new(&forced.path).join("node_modules")).unwrap();
        fs::write(Path::new(&forced.path).join("node_modules/file"), "content").unwrap();
        remove_worktree(
            repository_path.into(),
            forced.path.clone(),
            Some(true),
            None,
            None,
        )
        .unwrap();
        assert!(!Path::new(&forced.path).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktree_removal_rejects_a_new_clean_commit() {
        let root = std::env::temp_dir().join(format!(
            "sail-delete-revision-test-{}",
            uuid::Uuid::new_v4()
        ));
        let repository = root.join("repository");
        let parent = root.join("worktrees");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&parent).unwrap();
        let repository = repository.git_canonical().unwrap();
        let repository_path = repository.to_str().unwrap();
        git(repository_path, &["init", "-q"]);
        fs::write(repository.join("tracked.txt"), "before\n").unwrap();
        git(repository_path, &["add", "tracked.txt"]);
        git(
            repository_path,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "seed",
            ],
        );
        let created = add_worktree(
            repository_path.into(),
            "child".into(),
            Some(parent.to_string_lossy().into_owned()),
            Some("HEAD".into()),
        )
        .unwrap();
        let expected =
            tauri::async_runtime::block_on(working_tree_revision(created.path.clone())).unwrap();
        fs::write(Path::new(&created.path).join("tracked.txt"), "after\n").unwrap();
        git(&created.path, &["add", "tracked.txt"]);
        git(
            &created.path,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "new clean commit",
            ],
        );

        let error = remove_worktree(
            repository_path.into(),
            created.path.clone(),
            None,
            Some(&expected),
            None,
        )
        .unwrap_err();

        assert!(error.contains("changed after validation"));
        assert!(Path::new(&created.path).exists());
        remove_worktree(
            repository_path.into(),
            created.path.clone(),
            Some(true),
            None,
            None,
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktree_removal_rejects_a_same_commit_branch_switch() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-delete-branch-test");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        git(&worktree, &["switch", "-q", "-c", "other"]);
        let switched =
            tauri::async_runtime::block_on(working_tree_revision(worktree.clone())).unwrap();

        let error = remove_worktree(
            repository.clone(),
            worktree.clone(),
            None,
            Some(&expected),
            Some("child"),
        )
        .unwrap_err();

        assert_eq!(switched, expected);
        assert!(error.contains("branch changed from child to other"));
        assert!(Path::new(&worktree).exists());
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    fn ignored_archive_fixture(prefix: &str) -> (PathBuf, String, String, String) {
        let root = std::env::temp_dir().join(format!("{prefix}-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repository");
        let parent = root.join("worktrees");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&parent).unwrap();
        let repository = repository.git_canonical().unwrap();
        let repository_path = repository.to_string_lossy().into_owned();
        git(&repository_path, &["init", "-q"]);
        fs::write(repository.join(".gitignore"), "*.tmp\n").unwrap();
        fs::write(repository.join("tracked.txt"), "before\n").unwrap();
        git(&repository_path, &["add", ".gitignore", "tracked.txt"]);
        git(
            &repository_path,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "seed",
            ],
        );
        let created = add_worktree(
            repository_path.clone(),
            "child".into(),
            Some(parent.to_string_lossy().into_owned()),
            Some("HEAD".into()),
        )
        .unwrap();
        fs::write(Path::new(&created.path).join("one.tmp"), "one").unwrap();
        fs::write(Path::new(&created.path).join("two.tmp"), "two").unwrap();
        let expected =
            tauri::async_runtime::block_on(working_tree_revision(created.path.clone())).unwrap();
        (root, repository_path, created.path, expected)
    }

    #[test]
    fn archive_failure_restores_every_moved_ignored_file() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-archive-rollback-test");
        let mut moved = 0;

        let error = archive_ignored_and_remove_with_hook(
            repository.clone(),
            worktree.clone(),
            Some(expected),
            None,
            |_| {
                moved += 1;
                if moved == 1 {
                    Err("injected archive failure".to_string())
                } else {
                    Ok(())
                }
            },
        )
        .unwrap_err();

        assert!(error.contains("injected archive failure"));
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("one.tmp")).unwrap(),
            "one"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("two.tmp")).unwrap(),
            "two"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_rollback_never_clobbers_a_recreated_path() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-archive-no-clobber-test");
        let mut recreated = None;

        let error = archive_ignored_and_remove_with_hook(
            repository.clone(),
            worktree.clone(),
            Some(expected),
            None,
            |relative| {
                fs::write(Path::new(&worktree).join(relative), "recreated").unwrap();
                recreated = Some(relative.to_path_buf());
                Err("injected archive failure".to_string())
            },
        )
        .unwrap_err();

        let recreated = recreated.unwrap();
        assert!(error.contains("Recovery staging:"));
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join(&recreated)).unwrap(),
            "recreated"
        );
        let archive_root = root.join("worktrees/.sail-shipping-archive");
        let staging = fs::read_dir(&archive_root)
            .unwrap()
            .map(|entry| entry.unwrap().path())
            .find(|path| {
                path.file_name()
                    .unwrap()
                    .to_string_lossy()
                    .starts_with(".staging-")
            })
            .unwrap();
        assert!(staging.join(recreated).exists());
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archive_revision_drift_restores_every_moved_ignored_file() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-archive-drift-test");
        let mut changed = false;

        let error = archive_ignored_and_remove_with_hook(
            repository.clone(),
            worktree.clone(),
            Some(expected),
            None,
            |_| {
                if !changed {
                    fs::write(Path::new(&worktree).join("tracked.txt"), "after\n").unwrap();
                    git(&worktree, &["add", "tracked.txt"]);
                    git(
                        &worktree,
                        &[
                            "-c",
                            "user.name=Sail Test",
                            "-c",
                            "user.email=sail@example.test",
                            "-c",
                            "commit.gpgsign=false",
                            "commit",
                            "-qm",
                            "race commit",
                        ],
                    );
                    changed = true;
                }
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("changed after validation"));
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("one.tmp")).unwrap(),
            "one"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("two.tmp")).unwrap(),
            "two"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_race_restores_checkout_at_the_new_commit() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-delete-race-test");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        fs::write(Path::new(&repository).join("tracked.txt"), "after\n").unwrap();
        git(&repository, &["add", "tracked.txt"]);
        git(
            &repository,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "racing commit",
            ],
        );

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&expected),
            None,
            (
                || Ok(()),
                || {
                    git(&repository, &["update-ref", "refs/heads/child", "HEAD"]);
                    Ok(())
                },
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(error.contains("changed during deletion"), "{error}");
        assert!(error.contains("checkout was restored"));
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("tracked.txt")).unwrap(),
            "after\n"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_rejects_a_same_commit_branch_switch_before_removal() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-delete-branch-race-test");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        git(&repository, &["branch", "replacement", "HEAD"]);

        let error = remove_worktree_with_hook(
            repository.clone(),
            worktree.clone(),
            None,
            Some(&expected),
            Some("child"),
            || {
                git(&worktree, &["switch", "replacement"]);
                Ok(())
            },
        )
        .unwrap_err();

        assert!(error.contains("checkout changed during deletion"));
        assert!(Path::new(&worktree).is_dir());
        assert_eq!(
            git_reference(Path::new(&worktree), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("replacement")
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn removal_reports_a_worktree_recreated_at_the_same_path() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-delete-reregister-test");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            None,
            Some(&expected),
            Some("child"),
            (
                || Ok(()),
                || Ok(()),
                || {
                    git(&repository, &["worktree", "add", &worktree, "child"]);
                    Ok(())
                },
            ),
        )
        .unwrap_err();

        assert!(error.contains("registered again during deletion"));
        assert!(Path::new(&worktree).is_dir());
        assert_eq!(
            git_reference(Path::new(&worktree), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("child")
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn worktree_operations_share_a_common_git_directory_lock() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-common-dir-lock-test");
        let locks = WorktreeOperationLocks::default();
        let main_guard = locks.lock(Path::new(&repository)).unwrap();
        let linked_locks = locks.clone();
        let linked = worktree.clone();
        let (ready, started) = std::sync::mpsc::channel();
        let (acquired, received) = std::sync::mpsc::channel();
        let waiter = std::thread::spawn(move || {
            ready.send(()).unwrap();
            let _guard = linked_locks.lock(Path::new(&linked)).unwrap();
            acquired.send(()).unwrap();
        });

        started.recv().unwrap();
        assert!(matches!(
            received.recv_timeout(std::time::Duration::from_millis(100)),
            Err(std::sync::mpsc::RecvTimeoutError::Timeout)
        ));
        drop(main_guard);
        received
            .recv_timeout(std::time::Duration::from_secs(2))
            .unwrap();
        waiter.join().unwrap();

        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn picker_paths_remove_windows_verbatim_prefixes() {
        assert_eq!(
            normalize_picker_path(r"\\?\C:\Users\me\a.txt"),
            r"C:\Users\me\a.txt"
        );
        assert_eq!(
            normalize_picker_path(r"\\?\UNC\server\share\a.txt"),
            r"\\server\share\a.txt"
        );
    }

    fn git(root: &str, args: &[&str]) {
        let result = Command::new("git")
            .args(["-C", root])
            .args(args)
            .output()
            .expect("run git");
        assert!(
            result.status.success(),
            "{}",
            String::from_utf8_lossy(&result.stderr)
        );
        // Git checks out CRLF by default on Windows, and these fixtures compare exact bytes.
        // Best effort: `init` with a path argument creates the repository elsewhere.
        if args.first() == Some(&"init") {
            let _ = Command::new("git")
                .args(["-C", root, "config", "core.autocrlf", "false"])
                .output();
        }
    }

    #[cfg(unix)]
    #[test]
    fn working_tree_revision_detects_mode_changes_to_modified_files() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("sail-revision-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        git(path, &["config", "core.filemode", "true"]);
        let file = root.join("file.txt");
        fs::write(&file, "original\n").unwrap();
        git(path, &["add", "file.txt"]);
        git(path, &["commit", "-qm", "seed"]);
        fs::write(&file, "altered!\n").unwrap();
        let before = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_mode(permissions.mode() ^ 0o111);
        fs::set_permissions(&file, permissions).unwrap();
        let after = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        assert_ne!(before, after);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn working_tree_revision_ignores_index_metadata_refresh() {
        let root =
            std::env::temp_dir().join(format!("sail-revision-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        fs::write(root.join("file.txt"), "original\n").unwrap();
        git(path, &["add", "file.txt"]);
        git(path, &["commit", "-qm", "seed"]);
        let before = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        let index = root.join(".git/index");
        assert!(Command::new("touch").arg(index).status().unwrap().success());
        let after = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        assert_eq!(before, after);
        git(path, &["commit", "--allow-empty", "-qm", "next"]);
        let committed = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        assert_ne!(after, committed);
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(any(unix, windows))]
    #[test]
    fn working_tree_generation_detects_reverted_edits() {
        let root =
            std::env::temp_dir().join(format!("sail-generation-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        let file = root.join("file.txt");
        fs::write(&file, "original\n").unwrap();
        git(path, &["add", "file.txt"]);
        git(path, &["commit", "-qm", "seed"]);
        let revision = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        let generation =
            tauri::async_runtime::block_on(working_tree_generation(path.into())).unwrap();
        fs::write(&file, "changed\n").unwrap();
        fs::write(&file, "original\n").unwrap();
        let restored = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        let changed_generation =
            tauri::async_runtime::block_on(working_tree_generation(path.into())).unwrap();
        assert_eq!(revision, restored);
        assert_ne!(generation, changed_generation);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn working_tree_commit_requires_a_clean_checkout() {
        let root = std::env::temp_dir().join(format!("sail-commit-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        fs::write(root.join("file.txt"), "original\n").unwrap();
        git(path, &["add", "file.txt"]);
        git(path, &["commit", "-qm", "seed"]);
        let head = tauri::async_runtime::block_on(working_tree_commit(path.into())).unwrap();
        assert!(head.is_some());
        fs::write(root.join("file.txt"), "changed\n").unwrap();
        let dirty = tauri::async_runtime::block_on(working_tree_commit(
            root.to_string_lossy().into_owned(),
        ))
        .unwrap();
        assert_eq!(dirty, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn working_tree_revision_detects_edits_in_dirty_submodules() {
        let root =
            std::env::temp_dir().join(format!("sail-revision-test-{}", uuid::Uuid::new_v4()));
        let source = root.join("source");
        let parent = root.join("parent");
        fs::create_dir_all(&source).unwrap();
        fs::create_dir(&parent).unwrap();
        let source_path = source.to_str().unwrap();
        let parent_path = parent.to_str().unwrap();
        for path in [source_path, parent_path] {
            git(path, &["init", "-q"]);
            git(path, &["config", "user.name", "Sail Test"]);
            git(path, &["config", "user.email", "sail@example.test"]);
        }
        fs::write(source.join("file.txt"), "original\n").unwrap();
        git(source_path, &["add", "file.txt"]);
        git(source_path, &["commit", "-qm", "seed"]);
        git(
            parent_path,
            &[
                "-c",
                "protocol.file.allow=always",
                "submodule",
                "add",
                source_path,
                "nested",
            ],
        );
        git(parent_path, &["commit", "-qm", "submodule"]);
        fs::write(parent.join("nested/file.txt"), "first\n").unwrap();
        let before =
            tauri::async_runtime::block_on(working_tree_revision(parent_path.into())).unwrap();
        fs::write(parent.join("nested/file.txt"), "second\n").unwrap();
        let after =
            tauri::async_runtime::block_on(working_tree_revision(parent_path.into())).unwrap();
        assert_ne!(before, after);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shipping_paths_include_commits_and_uncommitted_files_since_base() {
        let root =
            std::env::temp_dir().join(format!("sail-shipping-paths-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q", "-b", "main"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(path, &["add", "base.txt"]);
        git(path, &["commit", "-qm", "seed"]);
        git(path, &["checkout", "-qb", "feature"]);
        fs::write(root.join("committed.txt"), "commit\n").unwrap();
        git(path, &["add", "committed.txt"]);
        git(path, &["commit", "-qm", "feature"]);
        fs::write(root.join("base.txt"), "changed\n").unwrap();
        fs::write(root.join("untracked.txt"), "new\n").unwrap();

        let paths =
            tauri::async_runtime::block_on(shipping_changed_paths(path.into(), None)).unwrap();
        assert_eq!(paths, ["base.txt", "committed.txt", "untracked.txt"]);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn shipping_paths_use_the_captured_base_commit_after_the_ref_moves() {
        let root = std::env::temp_dir().join(format!(
            "sail-shipping-base-race-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q", "-b", "main"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        fs::write(root.join("base.txt"), "base\n").unwrap();
        git(path, &["add", "base.txt"]);
        git(path, &["commit", "-qm", "seed"]);
        git(path, &["checkout", "-qb", "feature"]);
        let captured =
            tauri::async_runtime::block_on(shipping_base_revision(path.into(), None)).unwrap();
        fs::write(root.join("feature.txt"), "feature\n").unwrap();
        git(path, &["add", "feature.txt"]);
        git(path, &["commit", "-qm", "feature"]);
        git(path, &["branch", "-f", "main", "HEAD"]);

        let captured_paths = tauri::async_runtime::block_on(shipping_changed_paths(
            path.into(),
            Some(captured.clone()),
        ))
        .unwrap();
        let moved =
            tauri::async_runtime::block_on(shipping_base_revision(path.into(), None)).unwrap();
        let current_paths = tauri::async_runtime::block_on(shipping_changed_paths(
            path.into(),
            Some(moved.clone()),
        ))
        .unwrap();

        assert_ne!(captured, moved);
        assert_eq!(captured_paths, ["feature.txt"]);
        assert!(current_paths.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn overview_reports_branch_changes_and_missing_repositories() {
        let root =
            std::env::temp_dir().join(format!("sail-overview-test-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repository");
        let missing = root.join("missing");
        fs::create_dir_all(&repository).unwrap();
        let repository = repository.git_canonical().unwrap();
        let path = repository.to_str().unwrap();
        git(path, &["init", "-q", "-b", "overview-test"]);
        fs::write(repository.join("changed.txt"), "change\n").unwrap();

        let result = tauri::async_runtime::block_on(worktree_overviews(vec![
            path.into(),
            path.into(),
            missing.to_string_lossy().into_owned(),
        ]));

        assert_eq!(result.len(), 2);
        assert_eq!(result[0].branch.as_deref(), Some("overview-test"));
        assert_eq!(result[0].changed_files, Some(1));
        assert!(result[0].error.is_none());
        assert!(result[1].branch.is_none());
        assert!(result[1].changed_files.is_none());
        assert!(result[1].error.is_some());

        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        git(path, &["add", "changed.txt"]);
        git(
            path,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        git(path, &["checkout", "--detach", "-q"]);
        let detached = tauri::async_runtime::block_on(worktree_overviews(vec![path.into()]));
        assert_eq!(detached[0].branch.as_deref(), Some("Detached HEAD"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_change_actions_handle_hunks_stale_patches_and_untracked_files() {
        let root = std::env::temp_dir().join(format!("sail-change-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        let original = (1..=16)
            .map(|number| format!("line {number}\n"))
            .collect::<String>();
        fs::write(root.join("file.txt"), &original).unwrap();
        git(path, &["add", "--", "file.txt"]);
        git(
            path,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        let changed = original
            .replace("line 2\n", "changed 2\n")
            .replace("line 14\n", "changed 14\n");
        fs::write(root.join("file.txt"), changed).unwrap();
        let patch = git_patch(path, "file.txt", "unstaged", false).unwrap();
        assert_eq!(
            patch.lines().filter(|line| line.starts_with("@@ ")).count(),
            2
        );
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.txt".into(),
            "unstaged".into(),
            "stage".into(),
            patch.clone(),
            Some(0),
        ))
        .unwrap();
        assert!(git_patch(path, "file.txt", "staged", false)
            .unwrap()
            .contains("changed 2"));
        assert!(git_patch(path, "file.txt", "unstaged", false)
            .unwrap()
            .contains("changed 14"));
        let mixed = tauri::async_runtime::block_on(working_tree_diff(path.into())).unwrap();
        let mixed_file = mixed
            .iter()
            .find(|change| change.file == "file.txt")
            .unwrap();
        assert!(!mixed_file.staged_patch.is_empty());
        assert!(!mixed_file.unstaged_patch.is_empty());
        assert!(tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.txt".into(),
            "unstaged".into(),
            "revert".into(),
            patch,
            Some(1),
        ))
        .is_err());
        let staged = git_patch(path, "file.txt", "staged", false).unwrap();
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.txt".into(),
            "staged".into(),
            "unstage".into(),
            staged,
            Some(0),
        ))
        .unwrap();
        assert!(git_patch(path, "file.txt", "staged", false)
            .unwrap()
            .is_empty());
        let unstaged = git_patch(path, "file.txt", "unstaged", false).unwrap();
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.txt".into(),
            "unstaged".into(),
            "revert".into(),
            unstaged,
            Some(1),
        ))
        .unwrap();
        assert!(!fs::read_to_string(root.join("file.txt"))
            .unwrap()
            .contains("changed 14"));
        let remaining = git_patch(path, "file.txt", "unstaged", false).unwrap();
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.txt".into(),
            "unstaged".into(),
            "revert".into(),
            remaining,
            None,
        ))
        .unwrap();
        assert_eq!(fs::read_to_string(root.join("file.txt")).unwrap(), original);
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(root.join("file.txt")).unwrap().permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(root.join("file.txt"), permissions).unwrap();
            fs::write(
                root.join("file.txt"),
                original.replace("line 2\n", "mode test\n"),
            )
            .unwrap();
            let mode_patch = git_patch(path, "file.txt", "unstaged", false).unwrap();
            tauri::async_runtime::block_on(git_change_action(
                path.into(),
                "file.txt".into(),
                "unstaged".into(),
                "stage".into(),
                mode_patch,
                Some(0),
            ))
            .unwrap();
            assert!(!git_patch(path, "file.txt", "staged", false)
                .unwrap()
                .contains("new mode"));
        }
        fs::write(root.join("new.txt"), "new line\n").unwrap();
        let real_index = fs::read(root.join(".git/index")).unwrap();
        let changes = tauri::async_runtime::block_on(working_tree_diff(path.into())).unwrap();
        assert_eq!(fs::read(root.join(".git/index")).unwrap(), real_index);
        let untracked = changes
            .iter()
            .find(|change| change.file == "new.txt")
            .unwrap();
        assert!(untracked.untracked);
        assert!(!untracked.unstaged_patch.is_empty());
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "new.txt".into(),
            "unstaged".into(),
            "stage".into(),
            untracked.unstaged_patch.clone(),
            None,
        ))
        .unwrap();
        assert!(!git_patch(path, "new.txt", "staged", false)
            .unwrap()
            .is_empty());
        let new_staged = git_patch(path, "new.txt", "staged", false).unwrap();
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "new.txt".into(),
            "staged".into(),
            "unstage".into(),
            new_staged,
            Some(0),
        ))
        .unwrap();
        assert!(git_patch(path, "new.txt", "staged", false)
            .unwrap()
            .is_empty());
        assert!(root.join("new.txt").exists());
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("/outside/sail-missing-target", root.join("linked"))
                .unwrap();
            let link_patch = git_patch(path, "linked", "unstaged", true).unwrap();
            tauri::async_runtime::block_on(git_change_action(
                path.into(),
                "linked".into(),
                "unstaged".into(),
                "revert".into(),
                link_patch,
                None,
            ))
            .unwrap();
            assert!(fs::symlink_metadata(root.join("linked")).is_err());
        }
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unstage_file_before_first_commit_preserves_worktree() {
        let root = std::env::temp_dir().join(format!("sail-unborn-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        fs::write(root.join("new.txt"), "new line\n").unwrap();
        git(path, &["add", "--", "new.txt"]);
        fs::write(root.join("new.txt"), "new line\nmore work\n").unwrap();
        let changes = tauri::async_runtime::block_on(working_tree_diff(path.into())).unwrap();
        let new = changes
            .iter()
            .find(|change| change.file == "new.txt")
            .unwrap();
        assert!(new.patch.contains("new line"));
        assert!(new.patch.contains("more work"));
        assert!(!new.staged_patch.is_empty());
        assert!(!new.unstaged_patch.is_empty());
        let staged = git_patch(path, "new.txt", "staged", false).unwrap();
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "new.txt".into(),
            "staged".into(),
            "unstage".into(),
            staged,
            None,
        ))
        .unwrap();
        assert!(root.join("new.txt").exists());
        assert!(fs::read_to_string(root.join("new.txt"))
            .unwrap()
            .contains("more work"));
        assert!(git_patch(path, "new.txt", "staged", false)
            .unwrap()
            .is_empty());
        fs::write(root.join("gone.txt"), "staged then removed\n").unwrap();
        git(path, &["add", "--", "gone.txt"]);
        fs::remove_file(root.join("gone.txt")).unwrap();
        let changes = tauri::async_runtime::block_on(working_tree_diff(path.into())).unwrap();
        let gone = changes
            .iter()
            .find(|change| change.file == "gone.txt")
            .unwrap();
        assert!(gone.patch.is_empty());
        assert!(!gone.staged_patch.is_empty());
        assert!(!gone.unstaged_patch.is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn file_actions_use_literal_pathspecs() {
        let root = std::env::temp_dir().join(format!("sail-literal-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        // `*` is not a legal Windows filename, and `[` is magic to git on both platforms.
        let magic = if cfg!(windows) { "a[1].txt" } else { "*.txt" };
        fs::write(root.join(magic), "literal\n").unwrap();
        fs::write(root.join("other.txt"), "other\n").unwrap();
        git(
            path,
            &["add", "--", &format!(":(literal){magic}"), "other.txt"],
        );
        git(
            path,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        fs::write(root.join(magic), "changed literal\n").unwrap();
        fs::write(root.join("other.txt"), "changed other\n").unwrap();
        let changes = tauri::async_runtime::block_on(working_tree_diff(path.into())).unwrap();
        assert!(changes
            .iter()
            .find(|change| change.file == magic)
            .unwrap()
            .patch
            .contains("changed literal"));
        assert!(changes
            .iter()
            .find(|change| change.file == "other.txt")
            .unwrap()
            .patch
            .contains("changed other"));
        let patch = git_patch(path, magic, "unstaged", false).unwrap();
        assert!(patch.contains("changed literal"));
        assert!(!patch.contains("changed other"));
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            magic.into(),
            "unstaged".into(),
            "stage".into(),
            patch,
            None,
        ))
        .unwrap();
        assert!(git_patch(path, magic, "staged", false)
            .unwrap()
            .contains("changed literal"));
        assert!(git_patch(path, "other.txt", "staged", false)
            .unwrap()
            .is_empty());
        assert!(git_patch(path, "other.txt", "unstaged", false)
            .unwrap()
            .contains("changed other"));
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn binary_file_actions_apply_complete_patches() {
        let root = std::env::temp_dir().join(format!("sail-binary-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.git_canonical().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        let original = [0, 1, 2, 3];
        fs::write(root.join("file.bin"), original).unwrap();
        git(path, &["add", "--", "file.bin"]);
        git(
            path,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        fs::write(root.join("file.bin"), [0, 4, 5, 6]).unwrap();
        let patch = git_patch(path, "file.bin", "unstaged", false).unwrap();
        assert!(patch.contains("GIT binary patch"));
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.bin".into(),
            "unstaged".into(),
            "stage".into(),
            patch,
            None,
        ))
        .unwrap();
        let staged = git_patch(path, "file.bin", "staged", false).unwrap();
        assert!(staged.contains("GIT binary patch"));
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.bin".into(),
            "staged".into(),
            "unstage".into(),
            staged,
            None,
        ))
        .unwrap();
        let patch = git_patch(path, "file.bin", "unstaged", false).unwrap();
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "file.bin".into(),
            "unstaged".into(),
            "revert".into(),
            patch,
            None,
        ))
        .unwrap();
        assert_eq!(fs::read(root.join("file.bin")).unwrap(), original);
        fs::write(root.join("new.bin"), [0, 7, 8, 9]).unwrap();
        let changes = tauri::async_runtime::block_on(working_tree_diff(path.into())).unwrap();
        let new = changes
            .iter()
            .find(|change| change.file == "new.bin")
            .unwrap();
        assert!(new.unstaged_patch.contains("GIT binary patch"));
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "new.bin".into(),
            "unstaged".into(),
            "stage".into(),
            new.unstaged_patch.clone(),
            None,
        ))
        .unwrap();
        assert!(!git_patch(path, "new.bin", "staged", false)
            .unwrap()
            .is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn same_named_repositories_have_distinct_worktree_folders() {
        assert_ne!(
            repository_namespace(Path::new("/first/service")),
            repository_namespace(Path::new("/second/service"))
        );
    }

    #[test]
    fn accepts_real_opencode_version_output() {
        assert_eq!(version_number("opencode v2.0.24\n"), Some("2.0.24"));
        assert_eq!(version_number("2.1.0\n"), Some("2.1.0"));
        assert!(version_is_compatible(Some("2.0.24")));
        assert!(!version_is_compatible(Some("2.0.22")));
        assert!(!version_is_compatible(Some("2.1.0")));
    }

    #[test]
    fn late_opencode_child_after_confirmation_blocks_cleanup() {
        let expected = HashSet::from(["root".to_string()]);
        let sessions = vec![
            OpenCodeCleanupSession {
                id: "root".into(),
                parent_id: None,
            },
            OpenCodeCleanupSession {
                id: "late-child".into(),
                parent_id: Some("root".into()),
            },
        ];

        let error =
            verify_open_code_cleanup_state(&expected, &sessions, &HashSet::new(), &HashSet::new())
                .expect_err("a provider child created after confirmation must block cleanup");

        assert_eq!(
            error,
            "OpenCode task sessions changed before worktree cleanup."
        );
    }

    #[test]
    fn opencode_prompt_dequeue_during_cleanup_blocks_removal() {
        use std::cell::Cell;

        let owned = HashSet::from(["root".to_string()]);
        let sessions = vec![OpenCodeCleanupSession {
            id: "root".into(),
            parent_id: None,
        }];
        let state = Cell::new(0);
        let advance = || state.set(state.get() + 1);

        let (active, queued) = load_open_code_cleanup_activity(
            &owned,
            &sessions,
            |_| {
                let is_queued = state.get() == 0;
                advance();
                Ok(is_queued)
            },
            || {
                let is_active = state.get() == 1;
                advance();
                Ok(if is_active {
                    HashSet::from(["root".to_string()])
                } else {
                    HashSet::new()
                })
            },
        )
        .unwrap();

        let error = verify_open_code_cleanup_state(&owned, &sessions, &active, &queued)
            .expect_err("a prompt transitioning from queued to active must block cleanup");

        assert_eq!(
            error,
            "An OpenCode task session is active in this worktree."
        );
    }

    #[test]
    fn server_is_loopback_and_only_allows_packaged_origins_in_release() {
        let args = server_args();
        assert!(args
            .windows(2)
            .any(|pair| pair == ["--hostname", "127.0.0.1"]));
        assert!(args.windows(2).any(|pair| pair == ["--port", "0"]));
        assert!(args.contains(&"tauri://localhost"));
        assert!(args.contains(&"http://tauri.localhost"));
        if !cfg!(debug_assertions) {
            assert!(!args.contains(&"http://localhost:1420"));
            assert!(!args.contains(&"http://127.0.0.1:1420"));
        }
    }
}
