use serde::Serialize;
use std::collections::HashMap;
use std::ffi::OsString;
use std::hash::{Hash, Hasher};
use std::io::{BufRead, BufReader, Read, Write};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};
#[cfg(any(target_os = "macos", windows))]
use tauri::Emitter;
use tauri::{Manager, State};

static SHIPPING_WORKTREE_LOCK: Mutex<()> = Mutex::new(());

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
        .canonicalize()
        .map_err(|_| "Shipping worktree is missing.")?;
    let setup = worktree_config::read(&path)?
        .map(|config| config.setup)
        .unwrap_or_default();
    Ok(Some(CreatedWorktree {
        path: path.to_string_lossy().into_owned(),
        branch: name.to_string(),
        base: worktree_base(repository),
        setup,
    }))
}

fn shipping_default_ref(repository: &Path) -> Result<String, String> {
    let advertised = git_reference(repository, &["ls-remote", "--symref", "origin", "HEAD"])
        .ok_or("Cannot read origin's default branch.")?;
    let branch = advertised
        .lines()
        .find_map(|line| {
            line.strip_prefix("ref: refs/heads/")?
                .strip_suffix("\tHEAD")
        })
        .ok_or("Origin does not advertise a default branch.")?;
    Ok(format!("refs/remotes/origin/{branch}"))
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
mod hook_inspector;
mod post_turn_checks;
mod settings;
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
    let chosen = chosen.canonicalize().map_err(|error| error.to_string())?;
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
    if status.success() && version.is_some_and(|value| value.starts_with("2.")) {
        Ok(())
    } else {
        Err(format!(
            "OpenCode v2 is required (found {}). Choose a compatible binary in settings.",
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
        "OpenCode v2 was not found. Install it or choose an absolute binary path in settings."
            .to_string()
    }))
}

fn probe_runtime(info: &RuntimeInfo) -> Result<(), String> {
    let diagnostic =
        "OpenCode did not respond with a compatible v2 API. Check its configuration and retry.";
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
    if body
        .get("version")
        .and_then(serde_json::Value::as_str)
        .is_some_and(|version| version.starts_with("2."))
    {
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
fn validate_repository(path: String) -> Result<String, String> {
    let directory = Path::new(&path)
        .canonicalize()
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

fn index_with_intent(
    root: &str,
    files: &[String],
    copy_current: bool,
) -> Result<TemporaryIndex, String> {
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
        let output = Command::new("git")
            .args([
                "-C",
                &root,
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
        let staged = git_patches(&root, "staged", None)?;
        let unstaged = git_patches(
            &root,
            "unstaged",
            temporary.as_ref().map(|index| index.0.as_path()),
        )?;
        let all = if has_head {
            git_patches(&root, "all", None)?
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
        let output = Command::new("git")
            .args([
                "-C",
                &root,
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
            if let Ok(metadata) = Path::new(&root).join(path.as_ref()).symlink_metadata() {
                metadata.len().hash(&mut hash);
                metadata.modified().ok().hash(&mut hash);
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    metadata.permissions().mode().hash(&mut hash);
                }
                #[cfg(not(unix))]
                metadata.permissions().readonly().hash(&mut hash);
            }
        }
        let index = Command::new("git")
            .args(["-C", &root, "rev-parse", "--git-path", "index"])
            .output()
            .map_err(|error| error.to_string())?;
        if index.status.success() {
            let path = String::from_utf8_lossy(&index.stdout);
            let path = Path::new(path.trim());
            let path = if path.is_absolute() {
                path.to_path_buf()
            } else {
                Path::new(&root).join(path)
            };
            if let Ok(metadata) = path.metadata() {
                metadata.len().hash(&mut hash);
                metadata.modified().ok().hash(&mut hash);
            }
        }
        Ok(format!("{:016x}", hash.finish()))
    })
    .await
    .map_err(|error| error.to_string())?
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
    let canonical = target.canonicalize().map_err(|error| error.to_string())?;
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
                .canonicalize()
                .ok()
                .map(|path| (path, entry.branch))
        })
        .collect::<std::collections::HashMap<_, _>>();
    Ok(paths
        .into_iter()
        .filter_map(|path| {
            let branch = registered.get(&Path::new(&path).canonicalize().ok()?)?;
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
    repository: String,
    name: String,
    destination_parent: Option<String>,
    base_ref: Option<String>,
) -> Result<CreatedWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        add_worktree(repository, name, destination_parent, base_ref)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn create_shipping_worktree(
    repository: String,
    name: String,
) -> Result<CreatedWorktree, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let _lock = SHIPPING_WORKTREE_LOCK
            .lock()
            .map_err(|_| "Shipping worktree creation is unavailable.")?;
        let checked = validate_repository(repository.clone())?;
        if let Some(existing) = existing_shipping_worktree(Path::new(&checked), &name)? {
            return Ok(existing);
        }
        let default_ref = shipping_default_ref(Path::new(&checked))?;
        let branch = default_ref
            .strip_prefix("refs/remotes/origin/")
            .ok_or("Invalid origin default branch.")?;
        let output = Command::new("git")
            .arg("-C")
            .arg(&checked)
            .args([
                "fetch",
                "origin",
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
        add_worktree(repository, name, None, Some(default_ref))
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
                .canonicalize()
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
        .canonicalize()
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
    })
}

#[tauri::command]
async fn delete_worktree(
    repository: String,
    worktree: String,
    force: Option<bool>,
    archive_ignored: Option<bool>,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if archive_ignored == Some(true) {
            archive_ignored_and_remove(repository, worktree)
        } else {
            remove_worktree(repository, worktree, force)?;
            Ok(None)
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

fn archive_ignored_and_remove(
    repository: String,
    worktree: String,
) -> Result<Option<String>, String> {
    const IGNORED: &str = "Worktree has ignored files. Move or remove them before deleting.";
    match remove_worktree(repository.clone(), worktree.clone(), None) {
        Ok(()) => return Ok(None),
        Err(error) if error == IGNORED => {}
        Err(error) => return Err(error),
    }
    let worktree = PathBuf::from(worktree);
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
    let parent = worktree.parent().ok_or("Worktree parent is missing.")?;
    let archive = parent.join(".sail-shipping-archive").join(format!(
        "{}-{}",
        worktree.file_name().unwrap_or_default().to_string_lossy(),
        uuid::Uuid::new_v4()
    ));
    for relative in ignored {
        let destination = archive.join(&relative);
        std::fs::create_dir_all(destination.parent().ok_or("Invalid archive path.")?)
            .map_err(|error| format!("Cannot prepare ignored file archive: {error}"))?;
        std::fs::rename(worktree.join(relative), destination)
            .map_err(|error| format!("Cannot archive ignored worktree files: {error}"))?;
    }
    remove_worktree(repository, worktree.to_string_lossy().into_owned(), None)?;
    Ok(Some(archive.to_string_lossy().into_owned()))
}

fn remove_worktree(
    repository: String,
    worktree: String,
    force: Option<bool>,
) -> Result<(), String> {
    let repository = PathBuf::from(validate_repository(repository)?)
        .canonicalize()
        .map_err(|_| "Repository folder no longer exists.".to_string())?;
    let worktree = Path::new(&worktree)
        .canonicalize()
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
            .canonicalize()
            .is_ok_and(|registered| registered == worktree)
    }) {
        return Err("This folder is not a worktree of the selected repository.".to_string());
    }
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
        .setup(|_app| {
            if let Err(error) = diagnostics::init(_app.handle()) {
                eprintln!("Sail diagnostics unavailable: {error}");
            }
            browser_agent::start_bridge(_app.handle())?;
            #[cfg(any(target_os = "macos", windows))]
            configure_pane_menu(_app.handle())?;
            Ok(())
        })
        .manage(RuntimeManager::default())
        .manage(acp::AgentManager::default())
        .manage(acp_terminal::AcpTerminalManager::default())
        .manage(terminal::TerminalManager::default())
        .manage(post_turn_checks::CheckLock::default())
        .manage(browser_agent::BrowserManager::default())
        .manage(browser::CaptureStore::default())
        .invoke_handler(tauri::generate_handler![
            diagnostics::diagnostic_event,
            settings::load_settings,
            settings::migrate_settings,
            settings::save_setting,
            settings::list_interrupted_agent_turns,
            settings::finish_interrupted_agent_turn,
            start_runtime,
            validate_repository,
            list_picker_directory,
            working_tree_diff,
            working_tree_revision,
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
            hook_inspector::inspect_agent_hooks,
            github::create_pull_request,
            github::list_open_issues,
            github::open_issue,
            github::publish_issue_graph,
            github::load_issue_graph,
            github::shipping_pull_request,
            github::shipping_dependency_closed,
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
            acp::acp_load_session,
            acp::acp_resume_session,
            acp::acp_prompt,
            acp::acp_steer,
            acp::acp_cancel,
            acp::acp_permission,
            acp::acp_pending_permissions,
            acp::acp_pending_inbox,
            acp::acp_activity,
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
            }
        });
}

#[cfg(test)]
mod tests {
    #[cfg(unix)]
    use super::working_tree_revision;
    use super::{
        add_worktree, archive_ignored_and_remove, existing_shipping_worktree, git_change_action,
        git_patch, normalize_picker_path, parse_registered_worktrees, registered_worktrees,
        remove_worktree, repository_namespace, server_args, shipping_default_ref, version_number,
        working_tree_diff,
    };
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::process::CommandExt;
    use std::path::Path;
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
        let repository = repository.canonicalize().unwrap();
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
        let repository = repository.canonicalize().unwrap();
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
            child.canonicalize().unwrap().to_str().unwrap()
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
            shipping_default_ref(&repository).unwrap(),
            "refs/remotes/origin/develop"
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
        let repository = repository.canonicalize().unwrap();
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
        let result = remove_worktree(repository_path.into(), created.path.clone(), None);
        assert!(result.unwrap_err().contains("ignored files"));
        assert!(ignored.exists());
        let untracked = Path::new(&created.path).join("notes.txt");
        fs::write(&untracked, "keep").unwrap();
        assert!(
            archive_ignored_and_remove(repository_path.into(), created.path.clone())
                .unwrap_err()
                .contains("changes outside ignored")
        );
        assert!(ignored.exists());
        fs::remove_file(untracked).unwrap();
        let archive = archive_ignored_and_remove(repository_path.into(), created.path.clone())
            .unwrap()
            .unwrap();
        assert_eq!(
            fs::read_to_string(Path::new(&archive).join("node_modules/package/file.js")).unwrap(),
            "content"
        );
        assert!(!Path::new(&created.path).exists());
        let forced = add_worktree(
            repository_path.into(),
            "forced".into(),
            Some(parent.to_string_lossy().into_owned()),
            Some("HEAD".into()),
        )
        .unwrap();
        fs::create_dir_all(Path::new(&forced.path).join("node_modules")).unwrap();
        fs::write(Path::new(&forced.path).join("node_modules/file"), "content").unwrap();
        remove_worktree(repository_path.into(), forced.path.clone(), Some(true)).unwrap();
        assert!(!Path::new(&forced.path).exists());
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
    }

    #[cfg(unix)]
    #[test]
    fn working_tree_revision_detects_mode_changes_to_modified_files() {
        use std::os::unix::fs::PermissionsExt;

        let root =
            std::env::temp_dir().join(format!("sail-revision-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        git(path, &["config", "core.filemode", "true"]);
        let file = root.join("file.txt");
        fs::write(&file, "original\n").unwrap();
        git(path, &["add", "file.txt"]);
        git(path, &["commit", "-qm", "seed"]);
        fs::write(&file, "changed\n").unwrap();
        let before = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        let mut permissions = fs::metadata(&file).unwrap().permissions();
        permissions.set_mode(permissions.mode() ^ 0o111);
        fs::set_permissions(&file, permissions).unwrap();
        let after = tauri::async_runtime::block_on(working_tree_revision(path.into())).unwrap();
        assert_ne!(before, after);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn git_change_actions_handle_hunks_stale_patches_and_untracked_files() {
        let root = std::env::temp_dir().join(format!("sail-change-test-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
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
        let root = root.canonicalize().unwrap();
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
        let root = root.canonicalize().unwrap();
        let path = root.to_str().unwrap();
        git(path, &["init", "-q"]);
        git(path, &["config", "user.name", "Sail Test"]);
        git(path, &["config", "user.email", "sail@example.test"]);
        fs::write(root.join("*.txt"), "literal\n").unwrap();
        fs::write(root.join("other.txt"), "other\n").unwrap();
        git(path, &["add", "--", ":(literal)*.txt", "other.txt"]);
        git(
            path,
            &["-c", "commit.gpgsign=false", "commit", "-qm", "base"],
        );
        fs::write(root.join("*.txt"), "changed literal\n").unwrap();
        fs::write(root.join("other.txt"), "changed other\n").unwrap();
        let changes = tauri::async_runtime::block_on(working_tree_diff(path.into())).unwrap();
        assert!(changes
            .iter()
            .find(|change| change.file == "*.txt")
            .unwrap()
            .patch
            .contains("changed literal"));
        assert!(changes
            .iter()
            .find(|change| change.file == "other.txt")
            .unwrap()
            .patch
            .contains("changed other"));
        let patch = git_patch(path, "*.txt", "unstaged", false).unwrap();
        assert!(patch.contains("changed literal"));
        assert!(!patch.contains("changed other"));
        tauri::async_runtime::block_on(git_change_action(
            path.into(),
            "*.txt".into(),
            "unstaged".into(),
            "stage".into(),
            patch,
            None,
        ))
        .unwrap();
        assert!(git_patch(path, "*.txt", "staged", false)
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
        let root = root.canonicalize().unwrap();
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
        assert_eq!(version_number("opencode v2.0.19\n"), Some("2.0.19"));
        assert_eq!(version_number("2.1.0\n"), Some("2.1.0"));
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
