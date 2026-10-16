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
use tauri::{AppHandle, Manager, State};

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
    shared: Option<worktree_storage::FileLock>,
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
        drop(active);
        let mut guard = WorktreeOperationGuard {
            state: Arc::clone(&self.0),
            repository: repository.clone(),
            shared: None,
        };
        // The condition variable coordinates commands in this Sail process.
        // The common Git directory also serializes other Sail processes.
        guard.shared = Some(worktree_storage::FileLock::acquire(
            &repository.join("sail-worktree-operations.lock"),
            true,
        )?);
        Ok(guard)
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

pub(crate) fn git_common_directory(repository: &Path) -> Result<PathBuf, String> {
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
        drop(self.shared.take());
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
    git_overlay::require_shared_current(&path)?;
    let setup = worktree_config::read(&path)?
        .map(|config| config.setup)
        .unwrap_or_default();
    let shipping_target = shipping_target(repository, &path, name).ok();
    Ok(Some(CreatedWorktree {
        path: path.to_string_lossy().into_owned(),
        branch: name.to_string(),
        generation: worktree_storage::generation(&path).ok(),
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
mod acp_idle;
mod acp_terminal;
mod attention;
pub mod background_priority;
mod browser;
pub mod browser_agent;
#[cfg(unix)]
mod child_watchdog;
pub mod context;
pub mod context_broker;
pub mod context_broker_mcp;
pub mod context_output_store;
mod dev_servers;
mod diagnostics;
#[cfg(feature = "e2e")]
mod e2e_config;
mod e2e_keyboard;
mod git_overlay;
mod github;
pub mod hook_activity;
mod hook_inspector;
mod local_claims;
mod machine_pressure;
pub mod memory;
mod memory_capture;
mod memory_import;
mod memory_install;
mod memory_provider;
mod opencode_config;
mod owned_processes;
mod post_turn_checks;
mod project_knowledge;
mod reef_admission;
mod reef_canary;
#[cfg(unix)]
mod scratch_cleanup;

#[cfg(unix)]
pub fn exec_with_scratch_owner() -> ! {
    scratch_cleanup::exec_with_scratch_owner()
}
mod settings;
mod settings_records;
mod shell_command;
mod ship_actions;
mod stderr_log;
mod terminal;
mod worktree_config;
mod worktree_snapshots;
mod worktree_storage;

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

#[tauri::command]
async fn browser_detected_servers(
    directory: String,
    terminals: State<'_, terminal::TerminalManager>,
    acp_terminals: State<'_, acp_terminal::AcpTerminalManager>,
    agents: State<'_, acp::AgentManager>,
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

#[tauri::command]
async fn repository_path_available(path: String) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let directory = Path::new(&path);
        if !directory.is_dir() || !directory.join(".git").exists() {
            return Ok(false);
        }
        let output = Command::new("git")
            .arg("-C")
            .arg(directory)
            .args(["rev-parse", "--show-toplevel"])
            .output()
            .map_err(|_| "Git is unavailable. Install Git to select a repository.".to_string())?;
        Ok(output.status.success())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
fn pending_cleanup_paths_absent(paths: Vec<String>) -> Result<bool, String> {
    if paths.is_empty() {
        return Err("Pending cleanup paths are missing.".into());
    }
    for path in paths {
        let path = Path::new(&path);
        if !path.is_absolute() {
            return Err("A pending cleanup path is not absolute.".into());
        }
        match path.symlink_metadata() {
            Ok(_) => return Ok(false),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!(
                    "Cannot verify pending cleanup path {}: {error}",
                    path.display()
                ));
            }
        }
    }
    Ok(true)
}

#[tauri::command]
fn pending_cleanup_overlay_absent(original_worktree: String) -> Result<bool, String> {
    let original = Path::new(&original_worktree);
    if !original.is_absolute() {
        return Err("A pending worktree path is not absolute.".into());
    }
    git_overlay::removed_worktree_overlay_absent(original)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PendingOverlayInfo {
    path: String,
    size_bytes: Option<u64>,
}

#[tauri::command]
fn pending_cleanup_overlay_status(
    original_worktree: String,
) -> Result<Option<PendingOverlayInfo>, String> {
    let original = Path::new(&original_worktree);
    if !original.is_absolute() {
        return Err("A pending worktree path is not absolute.".into());
    }
    Ok(
        git_overlay::removed_worktree_overlay_pending_path(original)?.map(|path| {
            PendingOverlayInfo {
                size_bytes: worktree_storage::pending_size(&path),
                path: path.to_string_lossy().into_owned(),
            }
        }),
    )
}

fn validate_repository_path(path: String) -> Result<String, String> {
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

#[tauri::command]
async fn validate_repository(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || validate_repository_path(path))
        .await
        .map_err(|error| error.to_string())?
}

fn task_git_command(directory: &Path) -> Result<Command, String> {
    let mut command = Command::new("git");
    if let Some((worktree, git_dir)) = git_overlay::registered_paths(directory) {
        command.env("GIT_DIR", git_dir);
        command.env("GIT_WORK_TREE", worktree);
        command.env_remove("GIT_COMMON_DIR");
        command.env_remove("GIT_INDEX_FILE");
    } else if let Some(worktree) = git_overlay::known_worktree(directory) {
        return Err(format!(
            "Private Git state for {} requires recovery; task Git command refused.",
            worktree.display()
        ));
    }
    Ok(command)
}

fn task_git_reference(repository: &Path, args: &[&str]) -> Result<Option<String>, String> {
    let output = task_git_command(repository)?
        .arg("-C")
        .arg(repository)
        .args(args)
        .output()
        .map_err(|error| error.to_string())?;
    if !output.status.success() {
        return Ok(None);
    }
    let value = String::from_utf8(output.stdout).map_err(|error| error.to_string())?;
    let value = value.trim();
    Ok((!value.is_empty()).then(|| value.to_string()))
}

fn task_worktree_base(repository: &Path) -> Result<String, String> {
    if let Some(reference) = task_git_reference(
        repository,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )? {
        return Ok(reference);
    }
    for reference in ["origin/main", "origin/master", "main", "master"] {
        if task_git_reference(repository, &["rev-parse", "--verify", reference])?.is_some() {
            return Ok(reference.to_string());
        }
    }
    Ok("HEAD".to_string())
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
    let mut command = task_git_command(Path::new(root))?;
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
    let output = task_git_command(Path::new(root))?
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
    let output = task_git_command(Path::new(root))?
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
        let mut command = task_git_command(Path::new(root))?;
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
        let root = validate_repository_path(path)?;
        let snapshot = index_copy(&root, true)?;
        let output = task_git_command(Path::new(&root))?
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
        let has_head = task_git_command(Path::new(&root))?
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
        let root = validate_repository_path(path)?;
        git_directory_revision(Path::new(&root))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn working_tree_generation(path: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository_path(path)?;
        git_directory_generation(Path::new(&root))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn working_tree_commit(path: String) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository_path(path)?;
        let status = task_git_command(Path::new(&root))?
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
        let head = task_git_command(Path::new(&root))?
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
        let root = validate_repository_path(path)?;
        let base = match base_ref {
            Some(value) if value.starts_with("refs/") && !value.contains(char::is_whitespace) => {
                value
            }
            Some(_) => return Err("Invalid shipping base reference.".to_string()),
            None => task_worktree_base(Path::new(&root))?,
        };
        task_git_reference(
            Path::new(&root),
            &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
        )?
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
        let root = validate_repository_path(path)?;
        let base = match base_revision {
            Some(base) => task_git_reference(
                Path::new(&root),
                &["rev-parse", "--verify", &format!("{base}^{{commit}}")],
            )?
            .ok_or("The selected shipping base commit no longer exists.")?,
            None => {
                let reference = task_worktree_base(Path::new(&root))?;
                task_git_reference(
                    Path::new(&root),
                    &["rev-parse", "--verify", &format!("{reference}^{{commit}}")],
                )?
                .ok_or("Cannot resolve the shipping base commit.")?
            }
        };
        let merge_base = task_git_reference(Path::new(&root), &["merge-base", "HEAD", &base])?
            .ok_or("Cannot find the merge base for validation.")?;
        let output = task_git_command(Path::new(&root))?
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
        let untracked = task_git_command(Path::new(&root))?
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
    git_state: Option<String>,
    error: Option<String>,
}

fn inspect_worktree(path: String) -> WorktreeOverview {
    let root = match validate_repository_path(path.clone()) {
        Ok(root) => root,
        Err(error) => {
            return WorktreeOverview {
                path,
                branch: None,
                changed_files: None,
                git_state: None,
                error: Some(error),
            };
        }
    };
    let branch = task_git_command(Path::new(&root))
        .and_then(|mut command| {
            command
                .args(["-C", &root, "symbolic-ref", "--quiet", "--short", "HEAD"])
                .output()
                .map_err(|error| error.to_string())
        })
        .ok()
        .filter(|output| output.status.success())
        .map(|output| String::from_utf8_lossy(&output.stdout).trim().to_string())
        .filter(|branch| !branch.is_empty())
        .or_else(|| Some("Detached HEAD".into()));
    let changes = task_git_command(Path::new(&root)).and_then(|mut command| {
        command
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
            .map_err(|error| error.to_string())
    });
    let git_state = git_overlay::known_worktree(Path::new(&root)).map(|_| {
        match (
            task_git_reference(Path::new(&root), &["rev-parse", "HEAD"]),
            git_reference(Path::new(&root), &["rev-parse", "HEAD"]),
        ) {
            (Ok(Some(private)), Some(shared))
                if private == shared
                    && git_overlay::index_differs(Path::new(&root)) == Some(false) =>
            {
                "Private Git state ready".into()
            }
            (Ok(Some(_)), Some(_)) => "Private Git changes pending".into(),
            _ => "Private Git state requires recovery".into(),
        }
    });
    match changes {
        Ok(output) if output.status.success() => WorktreeOverview {
            path,
            branch,
            git_state,
            changed_files: Some(
                output
                    .stdout
                    .split(|byte| *byte == 0)
                    .filter(|record| record.len() >= 4)
                    .count(),
            ),
            error: None,
        },
        Err(error) => WorktreeOverview {
            path,
            branch,
            changed_files: None,
            git_state,
            error: Some(error),
        },
        _ => WorktreeOverview {
            path,
            branch,
            changed_files: None,
            git_state,
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
    let output = task_git_command(root)?
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
    let head = task_git_command(root)?
        .arg("-C")
        .arg(root)
        .args(["rev-parse", "HEAD"])
        .output()
        .map_err(|error| error.to_string())?;
    if head.status.success() {
        head.stdout.hash(&mut hash);
    }
    let staged = task_git_command(root)?
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
    let output = task_git_command(root)?
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
        let root = validate_repository_path(path)?;
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
        let untracked = !task_git_command(Path::new(&root))?
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
        let mut command = task_git_command(Path::new(&root))?;
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
async fn diff_file_contents(
    path: String,
    file: String,
    side: String,
) -> Result<Option<String>, String> {
    tauri::async_runtime::spawn_blocking(move || diff_file_contents_sync(path, file, side))
        .await
        .map_err(|error| error.to_string())?
}

fn diff_file_contents_sync(
    path: String,
    file: String,
    side: String,
) -> Result<Option<String>, String> {
    let root = validate_repository_path(path)?;
    let relative = Path::new(&file);
    if relative.is_absolute()
        || relative
            .components()
            .any(|part| !matches!(part, std::path::Component::Normal(_)))
    {
        return Err("Invalid diff file path.".into());
    }
    if side == "old" {
        let output = task_git_command(Path::new(&root))?
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
    generation: Option<String>,
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
    git_overlay::require_shared_current(worktree)?;
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
        let repository = validate_repository_path(repository)?;
        let worktree = validate_repository_path(worktree)?;
        git_overlay::require_shared_current(Path::new(&worktree))?;
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

// For a worktree that is already gone: the branch still lives in the repository.
#[tauri::command]
async fn shipping_repository_target(
    repository: String,
    branch: String,
) -> Result<ShippingTarget, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = validate_repository_path(repository)?;
        shipping_target(Path::new(&repository), Path::new(&repository), &branch)
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
    generation: Option<String>,
}

#[tauri::command]
async fn registered_worktrees(
    repository: String,
    paths: Vec<String>,
) -> Result<Vec<RegisteredWorktree>, String> {
    tauri::async_runtime::spawn_blocking(move || registered_worktrees_sync(repository, paths))
        .await
        .map_err(|error| error.to_string())?
}

fn registered_worktrees_sync(
    repository: String,
    paths: Vec<String>,
) -> Result<Vec<RegisteredWorktree>, String> {
    let repository = validate_repository_path(repository)?;
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
            let generation = worktree_storage::generation(Path::new(&path)).ok();
            Some(RegisteredWorktree {
                path,
                branch: branch.clone(),
                present: true,
                generation,
            })
        })
        .collect())
}

#[tauri::command]
async fn repository_worktrees(repository: String) -> Result<Vec<RegisteredWorktree>, String> {
    tauri::async_runtime::spawn_blocking(move || repository_worktrees_inner(repository))
        .await
        .map_err(|error| error.to_string())?
}

fn repository_worktrees_inner(repository: String) -> Result<Vec<RegisteredWorktree>, String> {
    let repository = validate_repository_path(repository)?;
    let listed = git_reference(
        Path::new(&repository),
        &["worktree", "list", "--porcelain", "-z"],
    )
    .ok_or("Cannot inspect repository worktrees.")?;
    Ok(parse_registered_worktrees(&listed)
        .into_iter()
        .filter(|entry| entry.present)
        .filter_map(|mut entry| {
            let path = Path::new(&entry.path).git_canonical().ok()?;
            entry.path = path.to_string_lossy().into_owned();
            entry.generation = worktree_storage::generation(&path).ok();
            Some(entry)
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
                generation: None,
            })
        })
        .collect()
}

#[tauri::command]
async fn worktree_config(
    worktree: String,
) -> Result<Option<worktree_config::WorktreeConfig>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let root = validate_repository_path(worktree)?;
        worktree_config::read(Path::new(&root))
    })
    .await
    .map_err(|error| error.to_string())?
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

fn allow_worktree_terminal_creation(app: &AppHandle, worktree: &Path) {
    app.state::<terminal::TerminalManager>()
        .allow_worktree_terminals(worktree);
    app.state::<acp_terminal::AcpTerminalManager>()
        .allow_worktree_terminals(worktree);
}

fn default_worktree_parent(repository: &Path) -> Result<PathBuf, String> {
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" });
    worktree_parent(repository, std::env::var_os("SAIL_WORKTREE_ROOT"), home)
}

fn worktree_parent(
    repository: &Path,
    override_root: Option<std::ffi::OsString>,
    home: Option<std::ffi::OsString>,
) -> Result<PathBuf, String> {
    let root = if let Some(root) = override_root {
        let root = PathBuf::from(root);
        if !root.is_absolute() {
            return Err("SAIL_WORKTREE_ROOT must be an absolute path.".to_string());
        }
        root
    } else {
        let home = home.ok_or("Home directory is unavailable. Choose a worktree destination.")?;
        Path::new(&home).join(".sail").join("worktrees")
    };
    Ok(root.join(repository_namespace(repository)))
}

#[tauri::command]
async fn worktree_pressure_directory(repository: String) -> Result<String, String> {
    let repository = validate_repository_path(repository)?;
    let mut path = default_worktree_parent(Path::new(&repository))?;
    while !path.try_exists().map_err(|error| error.to_string())? {
        path = path
            .parent()
            .ok_or("Worktree destination has no existing parent.")?
            .to_path_buf();
    }
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn create_worktree(
    app: AppHandle,
    operation_locks: State<'_, WorktreeOperationLocks>,
    repository: String,
    name: String,
    destination_parent: Option<String>,
    base_ref: Option<String>,
) -> Result<CreatedWorktree, String> {
    let operation_locks = operation_locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = validate_repository_path(repository)?;
        let _lock = operation_locks.lock(Path::new(&repository))?;
        let created = add_worktree(repository, name, destination_parent, base_ref)?;
        allow_worktree_terminal_creation(&app, Path::new(&created.path));
        Ok(created)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn create_shipping_worktree(
    app: AppHandle,
    operation_locks: State<'_, WorktreeOperationLocks>,
    repository: String,
    name: String,
) -> Result<CreatedWorktree, String> {
    let operation_locks = operation_locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let checked = validate_repository_path(repository)?;
        let _lock = operation_locks.lock(Path::new(&checked))?;
        if let Some(existing) = existing_shipping_worktree(Path::new(&checked), &name)? {
            allow_worktree_terminal_creation(&app, Path::new(&existing.path));
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
        allow_worktree_terminal_creation(&app, Path::new(&created.path));
        Ok(created)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn replacement_shipping_worktree(
    repository: &Path,
    expected_repository: &str,
    issue_number: u64,
    pull_request: &str,
    checkpoint_revision: &str,
) -> Result<CreatedWorktree, String> {
    github::require_target_repository(repository, expected_repository)?;
    let (target, pull_number) = ship_actions::parse_pull_request_url(pull_request)?;
    if !target.eq_ignore_ascii_case(expected_repository) {
        return Err("The closed pull request belongs to another repository.".to_string());
    }
    let endpoint = format!("repos/{target}/pulls/{pull_number}");
    let details = github::gh_output(repository, &["api", &endpoint]).map_err(|error| {
        format!("Cannot verify the original pull request before replacement. Refresh Ship and retry. {error}")
    })?;
    let details: serde_json::Value = serde_json::from_str(&details).map_err(|_| {
        "Cannot verify the original pull request before replacement. GitHub returned invalid details."
            .to_string()
    })?;
    if details["state"] == "open" {
        return Err(
            "The original pull request reopened before replacement. Refresh Ship and continue it."
                .to_string(),
        );
    }
    if details["state"] != "closed" || details["merged"] != false {
        return Err(
            "The original pull request is not confirmed closed without merging. Refresh Ship before replacement."
                .to_string(),
        );
    }
    replacement_worktree_at_checkpoint(
        repository,
        issue_number,
        pull_number,
        checkpoint_revision,
        None,
    )
}

fn replacement_worktree_at_checkpoint(
    repository: &Path,
    issue_number: u64,
    pull_number: u64,
    checkpoint_revision: &str,
    destination_parent: Option<String>,
) -> Result<CreatedWorktree, String> {
    if issue_number == 0
        || (checkpoint_revision.len() != 40 && checkpoint_revision.len() != 64)
        || !checkpoint_revision
            .chars()
            .all(|character| character.is_ascii_hexdigit())
    {
        return Err("The checkpoint has no full Git revision for a replacement.".to_string());
    }
    let commit = git_reference(
        repository,
        &[
            "rev-parse",
            "--verify",
            &format!("{checkpoint_revision}^{{commit}}"),
        ],
    )
    .ok_or("The saved checkpoint commit is unavailable in this repository.")?;
    if !commit.eq_ignore_ascii_case(checkpoint_revision) {
        return Err("The checkpoint revision no longer identifies the saved commit.".to_string());
    }
    let name = format!("ship-issue-{issue_number}-replacement-{pull_number}");
    if let Some(existing) = existing_shipping_worktree(repository, &name)? {
        let head = git_reference(Path::new(&existing.path), &["rev-parse", "HEAD"])
            .ok_or("Cannot inspect the existing replacement worktree.")?;
        if head.eq_ignore_ascii_case(checkpoint_revision) {
            return Ok(existing);
        }
        return Err("The replacement worktree already exists at another revision. Inspect it before retrying.".to_string());
    }
    let branch = format!("refs/heads/{name}");
    let existing_branch = git_reference(repository, &["rev-parse", "--verify", &branch]);
    if existing_branch
        .as_ref()
        .is_some_and(|revision| !revision.eq_ignore_ascii_case(checkpoint_revision))
    {
        return Err("The replacement branch already exists at another revision. Inspect it before retrying.".to_string());
    }
    add_worktree_with_branch_creation(
        repository.to_string_lossy().into_owned(),
        name,
        destination_parent,
        Some(checkpoint_revision.to_string()),
        existing_branch.is_none(),
    )
}

#[tauri::command]
async fn create_shipping_replacement_worktree(
    app: AppHandle,
    operation_locks: State<'_, WorktreeOperationLocks>,
    repository: String,
    expected_repository: String,
    issue_number: u64,
    pull_request: String,
    checkpoint_revision: String,
) -> Result<CreatedWorktree, String> {
    let operation_locks = operation_locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = validate_repository_path(repository)?;
        let path = Path::new(&repository);
        let _lock = operation_locks.lock(path)?;
        let created = replacement_shipping_worktree(
            path,
            &expected_repository,
            issue_number,
            &pull_request,
            &checkpoint_revision,
        )?;
        allow_worktree_terminal_creation(&app, Path::new(&created.path));
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
        let repository = validate_repository_path(repository)?;
        existing_shipping_worktree(Path::new(&repository), &name)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn run_shipping_setup(path: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = validate_repository_path(path)?;
        if git_overlay::known_worktree(Path::new(&path)).is_some() {
            return Err(
                "Shipping setup cannot use shared Git metadata while a private Git overlay exists."
                    .into(),
            );
        }
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
    add_worktree_with_branch_creation(repository, name, destination_parent, base_ref, true)
}

fn add_worktree_with_branch_creation(
    repository: String,
    name: String,
    destination_parent: Option<String>,
    base_ref: Option<String>,
    create_branch: bool,
) -> Result<CreatedWorktree, String> {
    let repository = validate_repository_path(repository)?;
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
        None => default_worktree_parent(repository)?,
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
    let mut command = Command::new("git");
    command
        .args(["-c", "checkout.workers=8"])
        .arg("-C")
        .arg(repository)
        .args(["worktree", "add"]);
    if create_branch {
        command.args(["-b", name]);
    }
    let output = command
        .arg(&path)
        .arg(if create_branch { &base } else { name })
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
    let config =
        (|| -> Result<(Option<worktree_config::WorktreeConfig>, Option<String>), String> {
            let config = worktree_config::read(&path)?;
            if let Some(config) = &config {
                worktree_config::copy_ignored(repository, &path, config)?;
            }
            Ok((config, worktree_storage::generation(&path).ok()))
        })();
    let (config, generation) = match config {
        Ok(config) => config,
        Err(error) => {
            let removed = Command::new("git")
                .arg("-C")
                .arg(repository)
                .args(["worktree", "remove", "--force"])
                .arg(&path)
                .output();
            if create_branch && removed.is_ok_and(|output| output.status.success()) {
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
        generation,
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
    stop_agents: Option<bool>,
    expected_generation: Option<String>,
    expected_registered_worktrees: Option<Vec<ExpectedRegisteredWorktree>>,
    confirmed_unused: Option<bool>,
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct ExpectedRegisteredWorktree {
    path: String,
    generation: Option<String>,
}

fn ensure_expected_worktree_inventory(
    repository: &str,
    expected: Option<&[ExpectedRegisteredWorktree]>,
) -> Result<(), String> {
    let Some(expected) = expected else {
        return Ok(());
    };
    let current = repository_worktrees_inner(repository.to_string())?;
    let expected = expected
        .iter()
        .map(|entry| (entry.path.as_str(), entry.generation.as_deref()))
        .collect::<HashSet<_>>();
    let current = current
        .iter()
        .map(|entry| (entry.path.as_str(), entry.generation.as_deref()))
        .collect::<HashSet<_>>();
    if current != expected {
        return Err("Repository worktrees changed after preview. Refresh before deleting.".into());
    }
    Ok(())
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeRemovalPreview {
    path: String,
    branch: Option<String>,
    generation: String,
    revision: String,
    dirty: bool,
    active_sessions: Vec<String>,
    size_bytes: Option<u64>,
    inspection_error: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct WorktreeCleanupSummary {
    path: String,
    branch: Option<String>,
    generation: String,
    dirty: bool,
    active_sessions: Vec<String>,
}

struct WorktreeRemovalTarget {
    path: String,
    canonical: PathBuf,
    branch: Option<String>,
    generation: String,
}

fn worktree_size_bytes(root: &Path) -> Result<u64, String> {
    let mut size = 0_u64;
    let mut remaining = vec![root.to_path_buf()];
    while let Some(directory) = remaining.pop() {
        for entry in std::fs::read_dir(&directory).map_err(|error| {
            format!(
                "Cannot measure worktree at {}: {error}",
                directory.display()
            )
        })? {
            let entry = entry.map_err(|error| format!("Cannot measure worktree: {error}"))?;
            let metadata = entry
                .path()
                .symlink_metadata()
                .map_err(|error| format!("Cannot measure worktree: {error}"))?;
            if metadata.is_dir() {
                remaining.push(entry.path());
            } else {
                size = size.saturating_add(metadata.len());
            }
        }
    }
    Ok(size)
}

fn ensure_expected_worktree_generation(
    directory: &Path,
    expected: Option<&str>,
) -> Result<(), String> {
    if let Some(expected) = expected {
        if worktree_storage::generation(directory).ok().as_deref() != Some(expected) {
            return Err("Worktree identity changed after preview. Refresh before deleting.".into());
        }
    }
    Ok(())
}

fn tracked_worktree_matches_head(root: &Path) -> Result<bool, String> {
    use sha2::{Digest, Sha256};

    let listed = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--stage", "-v", "-z"])
        .output()
        .map_err(|error| format!("Cannot inspect tracked worktree files: {error}"))?;
    if !listed.status.success() {
        return Err("Cannot inspect tracked worktree files before deletion.".into());
    }
    let mut entries = Vec::new();
    for record in listed
        .stdout
        .split(|byte| *byte == 0)
        .filter(|part| !part.is_empty())
    {
        let Some(separator) = record.iter().position(|byte| *byte == b'\t') else {
            return Err("Cannot parse tracked worktree files before deletion.".into());
        };
        let (header, remainder) = record.split_at(separator);
        let path = &remainder[1..];
        let Some(path) = std::str::from_utf8(path).ok() else {
            return Ok(false);
        };
        let Some(header) = std::str::from_utf8(header).ok() else {
            return Ok(false);
        };
        let mut fields = header.split_ascii_whitespace();
        let (Some(tag), Some(mode), Some(object), Some("0"), None) = (
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
            fields.next(),
        ) else {
            return Ok(false);
        };
        if !matches!(tag, "H" | "h" | "S" | "s")
            || !matches!(mode, "100644" | "100755" | "120000")
            || Path::new(path).is_absolute()
            || Path::new(path)
                .components()
                .any(|part| matches!(part, std::path::Component::ParentDir))
        {
            return Ok(false);
        }
        entries.push((
            path.to_string(),
            object.to_string(),
            mode.to_string(),
            tag.eq_ignore_ascii_case("s"),
        ));
    }

    // Custom filters can discard user bytes and can depend on external state.
    // Their working-tree output is not a trustworthy deletion baseline.
    for chunk in entries.chunks(256) {
        let attributes = Command::new("git")
            .arg("-C")
            .arg(root)
            .args(["check-attr", "-z", "filter", "--"])
            .args(chunk.iter().map(|entry| entry.0.as_str()))
            .output()
            .map_err(|error| format!("Cannot inspect tracked worktree filters: {error}"))?;
        if !attributes.status.success() {
            return Err("Cannot inspect tracked worktree filters before deletion.".into());
        }
        let parts: Vec<_> = attributes.stdout.split(|byte| *byte == 0).collect();
        if parts.len() != chunk.len() * 3 + 1 || parts.last() != Some(&b"".as_slice()) {
            return Err("Cannot parse tracked worktree filters before deletion.".into());
        }
        for part in parts.as_chunks::<3>().0.iter().take(chunk.len()) {
            if part[1] != b"filter" || (part[2] != b"unspecified" && part[2] != b"unset") {
                return Ok(false);
            }
        }
    }

    fn digest(mut input: impl Read) -> Result<Vec<u8>, String> {
        let mut hash = Sha256::new();
        let mut buffer = [0u8; 64 * 1024];
        loop {
            let count = input
                .read(&mut buffer)
                .map_err(|error| format!("Cannot read tracked worktree content: {error}"))?;
            if count == 0 {
                break;
            }
            hash.update(&buffer[..count]);
        }
        Ok(hash.finalize().to_vec())
    }

    for (path, object, mode, sparse) in entries {
        let file = root.join(&path);
        let metadata = match std::fs::symlink_metadata(&file) {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound && sparse => continue,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(false),
            Err(error) => return Err(format!("Cannot inspect tracked worktree content: {error}")),
        };
        match mode.as_str() {
            "120000" if metadata.file_type().is_symlink() => {}
            "100644" | "100755" if metadata.file_type().is_file() => {
                #[cfg(unix)]
                {
                    use std::os::unix::fs::PermissionsExt;
                    let executable = metadata.permissions().mode() & 0o100 != 0;
                    if executable != (mode == "100755") {
                        return Ok(false);
                    }
                }
                #[cfg(not(unix))]
                if mode == "100755" {
                    return Ok(false);
                }
            }
            _ => return Ok(false),
        }
        let actual = if metadata.file_type().is_symlink() {
            let target = std::fs::read_link(&file)
                .map_err(|error| format!("Cannot read tracked worktree link: {error}"))?;
            let Some(target) = target.to_str() else {
                return Ok(false);
            };
            digest(target.as_bytes())?
        } else {
            let file = std::fs::File::open(&file)
                .map_err(|error| format!("Cannot read tracked worktree file: {error}"))?;
            digest(file)?
        };
        let mut expected = Command::new("git")
            .arg("-C")
            .arg(root)
            .arg("cat-file")
            .arg("--filters")
            .arg(format!("--path={path}"))
            .arg(&object)
            .stdout(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Cannot inspect committed worktree content: {error}"))?;
        let expected_digest = match digest(expected.stdout.take().expect("piped Git output")) {
            Ok(digest) => digest,
            Err(error) => {
                let _ = expected.kill();
                let _ = expected.wait();
                return Err(error);
            }
        };
        if !expected
            .wait()
            .map_err(|error| format!("Cannot finish committed content check: {error}"))?
            .success()
        {
            return Err("Cannot inspect committed worktree content before deletion.".into());
        }
        if actual != expected_digest {
            return Ok(false);
        }
    }
    Ok(true)
}

fn worktree_preview_state_with_hook<F>(
    root: &Path,
    after_status: F,
) -> Result<(String, bool), String>
where
    F: FnOnce(),
{
    let revision = git_directory_revision(root)?;
    let dirty = worktree_dirty(root)?;
    after_status();
    if git_directory_revision(root)? != revision {
        return Err(format!(
            "Worktree {} changed during preview. Refresh before deleting.",
            root.display()
        ));
    }
    Ok((revision, dirty))
}

fn worktree_dirty(root: &Path) -> Result<bool, String> {
    Ok(worktree_summary_dirty(root)? || !tracked_worktree_matches_head(root)?)
}

fn worktree_summary_dirty(root: &Path) -> Result<bool, String> {
    let status = Command::new("git")
        .arg("-C")
        .arg(root)
        .args([
            "status",
            "--porcelain=v1",
            "--ignored",
            "--untracked-files=normal",
            "--no-renames",
        ])
        .output()
        .map_err(|error| format!("Cannot inspect worktree changes: {error}"))?;
    if !status.status.success() {
        return Err(format!(
            "Cannot inspect changes in {}. Refresh before deleting.",
            root.display()
        ));
    }
    Ok(!status.stdout.is_empty())
}

fn worktree_removal_targets(
    repository: String,
    paths: Vec<String>,
) -> Result<Vec<WorktreeRemovalTarget>, String> {
    let repository = validate_repository_path(repository)?;
    let main = Path::new(&repository)
        .git_canonical()
        .map_err(|_| "Repository folder no longer exists.".to_string())?;
    let registered = repository_worktrees_inner(repository)?;
    let registered = registered
        .into_iter()
        .map(|entry| (PathBuf::from(&entry.path), entry))
        .collect::<std::collections::HashMap<_, _>>();
    let mut targets = Vec::with_capacity(paths.len());
    for path in paths {
        let canonical = Path::new(&path).git_canonical().map_err(|_| {
            format!(
                "Worktree {} no longer exists. Refresh before deleting.",
                path
            )
        })?;
        if canonical == main {
            return Err("Cannot delete the main repository.".to_string());
        }
        let entry = registered.get(&canonical).ok_or_else(|| {
            format!(
                "Worktree {} is no longer registered. Refresh before deleting.",
                path
            )
        })?;
        let generation = entry.generation.clone().ok_or_else(|| {
            format!(
                "Cannot verify Git worktree identity for {}.",
                canonical.display()
            )
        })?;
        targets.push(WorktreeRemovalTarget {
            path,
            canonical,
            branch: entry.branch.clone(),
            generation,
        });
    }
    Ok(targets)
}

fn worktree_cleanup_summary_inner(
    repository: String,
    paths: Vec<String>,
    agents: &acp::AgentManager,
) -> Result<Vec<WorktreeCleanupSummary>, String> {
    worktree_removal_targets(repository, paths)?
        .into_iter()
        .map(|target| {
            let dirty = worktree_summary_dirty(&target.canonical)?;
            let active_sessions = agents
                .sessions_blocking_cleanup_in(&target.canonical)?
                .into_iter()
                .map(|(agent, _, session)| format!("{agent}:{session}"))
                .collect();
            Ok(WorktreeCleanupSummary {
                path: target.path,
                branch: target.branch,
                generation: target.generation,
                dirty,
                active_sessions,
            })
        })
        .collect()
}

fn worktree_removal_preview_inner(
    repository: String,
    paths: Vec<String>,
    agents: &acp::AgentManager,
) -> Result<Vec<WorktreeRemovalPreview>, String> {
    worktree_removal_targets(repository, paths)?
        .into_iter()
        .map(|target| {
            let (revision, dirty) = worktree_preview_state_with_hook(&target.canonical, || {})?;
            let active_sessions = agents
                .sessions_blocking_cleanup_in(&target.canonical)?
                .into_iter()
                .map(|(agent, _, session)| format!("{agent}:{session}"))
                .collect();
            let size = worktree_size_bytes(&target.canonical);
            Ok(WorktreeRemovalPreview {
                path: target.path,
                branch: target.branch,
                generation: target.generation,
                revision,
                dirty: dirty || size.is_err(),
                active_sessions,
                size_bytes: size.as_ref().ok().copied(),
                inspection_error: size.err(),
            })
        })
        .collect()
}

#[tauri::command]
async fn worktree_cleanup_summary(
    repository: String,
    paths: Vec<String>,
    agents: State<'_, acp::AgentManager>,
) -> Result<Vec<WorktreeCleanupSummary>, String> {
    let started = std::time::Instant::now();
    let count = paths.len();
    let agents = agents.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        worktree_cleanup_summary_inner(repository, paths, &agents)
    })
    .await
    .map_err(|error| error.to_string())?;
    diagnostics::record(
        "worktree_cleanup_summary_finished",
        serde_json::json!({
            "elapsedMs":started.elapsed().as_millis(), "targets":count, "ok":result.is_ok(),
        }),
    );
    result
}

#[tauri::command]
async fn worktree_removal_preview(
    repository: String,
    paths: Vec<String>,
    agents: State<'_, acp::AgentManager>,
) -> Result<Vec<WorktreeRemovalPreview>, String> {
    let started = std::time::Instant::now();
    let count = paths.len();
    let agents = agents.inner().clone();
    let result = tauri::async_runtime::spawn_blocking(move || {
        worktree_removal_preview_inner(repository, paths, &agents)
    })
    .await
    .map_err(|error| error.to_string())?;
    diagnostics::record(
        "worktree_removal_preview_finished",
        serde_json::json!({
            "elapsedMs":started.elapsed().as_millis(), "targets":count, "ok":result.is_ok(),
        }),
    );
    result
}

#[tauri::command]
async fn delete_worktree(
    app: tauri::AppHandle,
    operation_locks: State<'_, WorktreeOperationLocks>,
    agents: State<'_, acp::AgentManager>,
    fence: State<'_, acp::AgentWorktreeFence>,
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
        stop_agents,
        expected_generation,
        expected_registered_worktrees,
        confirmed_unused,
    } = request;
    let operation_locks = operation_locks.inner().clone();
    let agents = agents.inner().clone();
    let fence = fence.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let checked = validate_repository_path(repository)?;
        let _lock = operation_locks.lock(Path::new(&checked))?;
        // Sail worktree creation takes this same Git-directory lock.
        ensure_expected_worktree_inventory(&checked, expected_registered_worktrees.as_deref())?;
        if archive_ignored == Some(true) {
            return Err(
                "Automatic ignored-file archival is unavailable. The worktree remains registered for pending cleanup."
                    .into(),
            );
        }
        if expected_revision.is_some()
            && expected_generation.is_some()
            && confirmed_unused != Some(true)
        {
            return Err(
                "Worktree remains registered pending explicit confirmation that it is unused."
                    .into(),
            );
        }
        let directory = PathBuf::from(&worktree)
            .git_canonical()
            .unwrap_or_else(|_| PathBuf::from(&worktree));
        ensure_expected_worktree_generation(&directory, expected_generation.as_deref())?;
        let cache_directory = app
            .path()
            .app_cache_dir()
            .map_err(|error| error.to_string())?;
        let managed_terminal_data =
            worktree_storage::data_directory_for_removal(&cache_directory, &directory)?
                .unwrap_or_else(|| acp_terminal::worktree_data_directory(&cache_directory, &directory));
        let terminals = app.state::<acp_terminal::AcpTerminalManager>().inner();
        let terminal_manager = app.state::<terminal::TerminalManager>();
        let acp_roots = match terminals.begin_worktree_removal(&directory) {
            Ok(roots) => roots,
            Err(error) => {
                terminals.allow_worktree_terminals(&directory);
                return Err(error);
            }
        };
        let terminal_roots = match terminal_manager.begin_worktree_removal(&directory) {
            Ok(roots) => roots,
            Err(error) => {
                terminal_manager.allow_worktree_terminals(&directory);
                terminals.allow_worktree_terminals(&directory);
                return Err(error);
            }
        };
        let mut removed_from_git = false;
        let mut managed_data_paths = Vec::new();
        let result = (|| {
            let persisted_roots =
                discover_nested_worktree_terminal_roots(&cache_directory, &directory)?;
            let runtime_roots = agents.worktree_roots_in(&directory)?;
            let roots = acp_roots
                .into_iter()
                .chain(terminal_roots)
                .chain(persisted_roots)
                .chain(runtime_roots)
                .collect::<Vec<_>>();
            let managed_data = persist_worktree_data_manifest(
                &cache_directory,
                &managed_terminal_data,
                &directory,
                &roots,
            )?;
            managed_data_paths = managed_data.clone();
            if stop_agents == Some(true) {
                fence.stop_sessions_in(&app, &agents, &directory)?;
            }
            fence.cleanup(
                &agents,
                &directory,
                native_generation,
                stop_agents == Some(true),
                || {
                    terminal_manager.stop_worktree(&directory)?;
                    terminals.stop_worktree(&directory)?;
                    agents.stop_worktree(&directory)?;
                    if expected_revision.is_some() && expected_generation.is_some() {
                        worktree_storage::ensure_ready_before_worktree_removal(
                            &cache_directory,
                            &managed_data,
                        )?;
                    } else {
                        if directory.is_dir() {
                            let overlay = if git_overlay::known_worktree(&directory).is_some() {
                                git_overlay::GitOverlay::ensure(&cache_directory, &directory)?
                            } else {
                                git_overlay::GitOverlay::existing(&cache_directory, &directory)?
                            };
                            if let Some(mut overlay) = overlay {
                                overlay.promote_quiescent(|| Ok(()))?;
                            }
                        }
                    }
                    remove_worktree_then_private_data_many(
                        &cache_directory,
                        &managed_data,
                        expected_revision.is_some() && expected_generation.is_some(),
                        || {
                            ensure_expected_worktree_generation(
                                &directory,
                                expected_generation.as_deref(),
                            )?;
                            remove_worktree_guarded_with_hook(
                                checked,
                                worktree,
                                force,
                                expected_revision.as_deref(),
                                expected_branch.as_deref(),
                                expected_generation.as_deref(),
                                || {
                                    removed_from_git = true;
                                    Ok(())
                                },
                            )?;
                            Ok(None)
                        },
                    )
                },
            )
        })();
        if result.is_err() && !removed_from_git {
            terminal_manager.allow_worktree_terminals(&directory);
            terminals.allow_worktree_terminals(&directory);
        }
        match result {
            Err(reason) if removed_from_git => {
                let inspected = worktree_storage::retained_selected_storage_locations(
                    &cache_directory,
                    &managed_data_paths,
                );
                let retained = match &inspected {
                    Ok(paths) if !paths.is_empty() => paths.clone(),
                    _ => managed_data_paths
                        .iter()
                        .filter_map(|path| {
                            path.file_name()
                                .and_then(|name| name.to_str())
                                .map(|key| (key.to_owned(), path.clone()))
                        })
                        .collect::<Vec<_>>(),
                };
                let retained_size = retained.iter().try_fold(0_u64, |total, (_, path)| {
                    worktree_size_bytes(path).map(|size| total.saturating_add(size))
                });
                let overlay_cleanup_pending =
                    !git_overlay::removed_worktree_overlay_absent(&directory).unwrap_or(false);
                let reason = match inspected {
                    Ok(paths) if !paths.is_empty() => reason,
                    Ok(_) if overlay_cleanup_pending => reason,
                    Ok(_) => format!("{reason} Retained private storage location could not be verified."),
                    Err(error) => format!("{reason} {error}"),
                };
                Err(format!(
                    "SAIL_STORAGE_PENDING:{}",
                    serde_json::json!({
                        "originalPath": directory.to_string_lossy(),
                        "recoveryPath": directory.to_string_lossy(),
                        "storagePaths": retained.iter().map(|(_, path)| path.to_string_lossy().into_owned()).collect::<Vec<_>>(),
                        "storageKeys": retained.iter().map(|(key, _)| key).collect::<Vec<_>>(),
                        "sizeBytes": retained_size.ok(),
                        "reason": reason,
                        "overlayCleanupPending": overlay_cleanup_pending,
                    })
                ))
            }
            other => other,
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
async fn restore_pending_worktree(
    operation_locks: State<'_, WorktreeOperationLocks>,
    agents: State<'_, acp::AgentManager>,
    repository: String,
    recovery_path: String,
    original_path: String,
    expected_generation: String,
) -> Result<(), String> {
    let operation_locks = operation_locks.inner().clone();
    let agents = agents.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let repository = PathBuf::from(validate_repository_path(repository)?)
            .git_canonical()
            .map_err(|_| "Repository folder no longer exists.".to_string())?;
        let _lock = operation_locks.lock(&repository)?;
        if !agents
            .sessions_blocking_cleanup_in(Path::new(&recovery_path))?
            .is_empty()
        {
            return Err("The recovery worktree has connected agent sessions. Finish them before restoring its path.".into());
        }
        restore_pending_worktree_inner(
            &repository,
            Path::new(&recovery_path),
            Path::new(&original_path),
            &expected_generation,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

fn restore_pending_worktree_inner(
    repository: &Path,
    recovery_path: &Path,
    original_path: &Path,
    expected_generation: &str,
) -> Result<(), String> {
    let recovery = recovery_path
        .git_canonical()
        .map_err(|_| "Pending recovery checkout no longer exists.".to_string())?;
    let original = acp_terminal::stable_worktree_identity(original_path);
    if original.symlink_metadata().is_ok() {
        return Err(format!(
            "Original path {} is occupied. The recovery worktree remains intact.",
            original.display()
        ));
    }
    if recovery == repository || original == repository {
        return Err("Cannot restore over the main repository.".into());
    }
    ensure_expected_worktree_generation(&recovery, Some(expected_generation))?;
    git_overlay::require_shared_current(&recovery)?;
    git_overlay::require_recoverable_private_state_at_missing(&original, &recovery)?;
    move_worktree_for_removal(repository, &recovery, &original)?;
    ensure_expected_worktree_generation(&original, Some(expected_generation))?;
    Ok(())
}

#[tauri::command]
async fn retry_removed_worktree_overlay_cleanup(
    operation_locks: State<'_, WorktreeOperationLocks>,
    repository: String,
    original_worktree: String,
    expected_generation: String,
    confirmed_unused: bool,
) -> Result<(), String> {
    if !confirmed_unused || expected_generation.is_empty() {
        return Err("Private Git cleanup requires a confirmed worktree generation.".into());
    }
    let operation_locks = operation_locks.inner().clone();
    tauri::async_runtime::spawn_blocking(move || {
        let checked = validate_repository_path(repository)?;
        let repository = PathBuf::from(&checked)
            .git_canonical()
            .map_err(|_| "Repository folder no longer exists.".to_string())?;
        let original = PathBuf::from(original_worktree);
        if !original.is_absolute() || original == repository {
            return Err("Cannot retry private Git cleanup for this worktree path.".into());
        }
        let _lock = operation_locks.lock(&repository)?;
        let registered = repository_worktrees_inner(checked)?;
        if registered.iter().any(|item| item.generation.is_none()) {
            return Err("A registered worktree identity cannot be verified. Private Git state remains intact.".into());
        }
        if registered
            .iter()
            .any(|item| item.generation.as_deref() == Some(expected_generation.as_str()))
        {
            return Err("The selected Git generation is still registered. Private Git state remains intact.".into());
        }
        // An interrupted overlay has no enforceable writer lease. Keep it for
        // separate recovery instead of using a prior checkout confirmation to
        // authorize deletion of bytes that may have changed since the failure.
        if let Some(path) = git_overlay::removed_worktree_overlay_pending_path(&original)? {
            return Err(format!(
                "Private Git state at {} cannot be verified unused after interruption. Its bytes remain pending for separate recovery.",
                path.display()
            ));
        }
        git_overlay::forget_removed_worktree_for_repository(&original, &repository)
    })
    .await
    .map_err(|error| error.to_string())?
}

fn remove_worktree_then_private_data_many<T>(
    cache_directory: &Path,
    managed_data: &[PathBuf],
    require_private_cleanup: bool,
    remove_worktree: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let result = remove_worktree()?;
    if let Err(error) =
        worktree_storage::remove_after_worktree_removal(cache_directory, managed_data)
    {
        diagnostics::record(
            "worktree_private_cleanup_pending",
            serde_json::json!({"error": error}),
        );
        if require_private_cleanup {
            return Err(error);
        }
    }
    Ok(result)
}

#[cfg(test)]
fn remove_worktree_then_terminal_data<T>(
    managed_data: &Path,
    remove_worktree: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    remove_worktree_then_terminal_data_many(&[managed_data.to_path_buf()], remove_worktree)
}

#[cfg(test)]
fn remove_worktree_then_terminal_data_many<T>(
    managed_data: &[PathBuf],
    remove_worktree: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let result = remove_worktree()?;
    for directory in managed_data {
        match std::fs::remove_dir_all(directory) {
            Ok(()) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => {
                return Err(format!("Cannot remove worktree terminal data: {error}"));
            }
        }
    }
    Ok(result)
}

const NESTED_WORKTREE_MANIFEST_PREFIX: &str = "nw-";
const NESTED_WORKTREE_MANIFEST_HEADER: &str = "sail-terminal-worktrees-v2";
const WORKTREE_DATA_OWNER_FILE: &str = "worktree-owner-v1";

#[cfg(test)]
pub(crate) fn register_worktree_terminal_data(
    cache_directory: &Path,
    worktree: &Path,
) -> Result<PathBuf, String> {
    let worktree = acp_terminal::stable_worktree_identity(worktree);
    let data_directory = acp_terminal::worktree_data_directory(cache_directory, &worktree);
    std::fs::create_dir_all(&data_directory).map_err(|error| error.to_string())?;
    let owner_file = data_directory.join(WORKTREE_DATA_OWNER_FILE);
    let contents = format!(
        "{NESTED_WORKTREE_MANIFEST_HEADER}\n{}\n",
        encode_manifest_path(&worktree)
    );
    if owner_file.exists() {
        validate_worktree_data_owner(&owner_file, &worktree)?;
        return Ok(data_directory);
    }
    let temporary = data_directory.join(format!(".owner-{}.tmp", uuid::Uuid::new_v4()));
    let write_result = (|| {
        use std::io::Write as _;
        let mut file = std::fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(contents.as_bytes())
            .map_err(|error| error.to_string())?;
        file.sync_all().map_err(|error| error.to_string())?;
        rename_without_replace(&temporary, &owner_file).map_err(|error| error.to_string())
    })();
    if write_result.is_err() {
        let _ = std::fs::remove_file(&temporary);
        if owner_file.exists() {
            validate_worktree_data_owner(&owner_file, &worktree)?;
            return Ok(data_directory);
        }
    }
    write_result?;
    Ok(data_directory)
}

pub(crate) fn register_worktree_storage(
    cache_directory: &Path,
    worktree: &Path,
) -> Result<(PathBuf, std::sync::Arc<worktree_storage::WorktreeDataLease>), String> {
    worktree_storage::register(cache_directory, worktree)
}

#[cfg(test)]
fn validate_worktree_data_owner(owner_file: &Path, expected: &Path) -> Result<(), String> {
    if !owner_file
        .symlink_metadata()
        .map_err(|error| error.to_string())?
        .file_type()
        .is_file()
    {
        return Err("Terminal cache owner metadata is not a regular file.".into());
    }
    let contents = std::fs::read_to_string(owner_file).map_err(|error| error.to_string())?;
    let mut lines = contents.lines();
    if lines.next() != Some(NESTED_WORKTREE_MANIFEST_HEADER) {
        return Err("Terminal cache owner metadata is malformed.".into());
    }
    let stored = decode_manifest_path(
        lines
            .next()
            .ok_or("Terminal cache owner metadata is incomplete.")?,
    )?;
    if lines.next().is_some()
        || acp_terminal::stable_worktree_identity(&stored)
            != acp_terminal::stable_worktree_identity(expected)
    {
        return Err("Terminal cache owner metadata does not match its worktree.".into());
    }
    Ok(())
}

fn discover_nested_worktree_terminal_roots(
    cache_directory: &Path,
    outer_worktree: &Path,
) -> Result<Vec<PathBuf>, String> {
    let outer_worktree = acp_terminal::stable_worktree_identity(outer_worktree);
    let cache_root = cache_directory.join("terminal-worktrees");
    let entries = match std::fs::read_dir(&cache_root) {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.to_string()),
    };
    let mut roots = Vec::new();
    for entry in entries {
        let entry = match entry {
            Ok(entry) => entry,
            Err(_) => {
                diagnostics::record("terminal_cache_owner_unclassified", serde_json::json!({}));
                continue;
            }
        };
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let file_type = match entry.file_type() {
            Ok(file_type) => file_type,
            Err(_) => {
                report_unclassified_terminal_cache(name);
                continue;
            }
        };
        if !file_type.is_dir() {
            continue;
        }
        if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
            continue;
        }
        let owner_file = entry.path().join(WORKTREE_DATA_OWNER_FILE);
        let owner_metadata = match owner_file.symlink_metadata() {
            Ok(metadata) => metadata,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(_) => {
                report_unclassified_terminal_cache(name);
                continue;
            }
        };
        if !owner_metadata.file_type().is_file() {
            report_unclassified_terminal_cache(name);
            continue;
        }
        let contents = match std::fs::read_to_string(&owner_file) {
            Ok(contents) => contents,
            Err(_) => {
                report_unclassified_terminal_cache(name);
                continue;
            }
        };
        let mut lines = contents.lines();
        if lines.next() != Some(NESTED_WORKTREE_MANIFEST_HEADER) {
            report_unclassified_terminal_cache(name);
            continue;
        }
        let encoded_root = match lines.next() {
            Some(root) => root,
            None => {
                report_unclassified_terminal_cache(name);
                continue;
            }
        };
        let decoded_root = match decode_manifest_path(encoded_root) {
            Ok(root) => root,
            Err(_) => {
                report_unclassified_terminal_cache(name);
                continue;
            }
        };
        let root = acp_terminal::stable_worktree_identity(&decoded_root);
        if lines.next().is_some()
            || acp_terminal::worktree_data_directory(cache_directory, &root) != entry.path()
        {
            report_unclassified_terminal_cache(name);
            continue;
        }
        if root != outer_worktree && root.starts_with(&outer_worktree) {
            roots.push(root);
        }
    }
    Ok(roots)
}

fn report_unclassified_terminal_cache(cache_key: &str) {
    diagnostics::record(
        "terminal_cache_owner_unclassified",
        serde_json::json!({"cacheKey": cache_key}),
    );
}

fn persist_worktree_data_manifest(
    cache_directory: &Path,
    outer_data: &Path,
    outer_worktree: &Path,
    discovered_roots: &[PathBuf],
) -> Result<Vec<PathBuf>, String> {
    let outer_worktree = acp_terminal::stable_worktree_identity(outer_worktree);
    for root in discovered_roots {
        let root = acp_terminal::stable_worktree_identity(root);
        if root != outer_worktree {
            validate_nested_worktree_root(&outer_worktree, &root)?;
        }
    }
    if !worktree_storage::is_managed_directory(outer_data) {
        // Legacy terminal caches without a Git identity remain outside this
        // generation-scoped cleanup. A current Git worktree with existing but
        // unverifiable storage must stop before its checkout is removed.
        if worktree_storage::generation(&outer_worktree).is_err() {
            return Ok(Vec::new());
        }
        let current =
            worktree_storage::data_directory_for_removal(cache_directory, &outer_worktree)?;
        if current.is_none()
            && outer_data
                .symlink_metadata()
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
        {
            return Ok(Vec::new());
        }
        return Err(format!(
            "Selected private storage at {} has an unverifiable owner. Its files were kept.",
            outer_data.display()
        ));
    }
    if worktree_storage::data_directory_for_removal(cache_directory, &outer_worktree)?.as_deref()
        != Some(outer_data)
    {
        return Err("Selected worktree storage generation changed before cleanup.".into());
    }
    let mut data_directories = HashSet::from([outer_data.to_path_buf()]);
    if outer_data.is_dir() {
        for entry in std::fs::read_dir(outer_data).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            let name = entry.file_name();
            let name = name.to_string_lossy();
            if !name.starts_with(NESTED_WORKTREE_MANIFEST_PREFIX) || !name.ends_with(".manifest") {
                continue;
            }
            if !entry
                .file_type()
                .map_err(|error| error.to_string())?
                .is_file()
            {
                return Err("Nested worktree manifest is not a regular file.".into());
            }
            let contents =
                std::fs::read_to_string(entry.path()).map_err(|error| error.to_string())?;
            let mut lines = contents.lines();
            if lines.next() != Some(NESTED_WORKTREE_MANIFEST_HEADER) {
                return Err("Nested worktree manifest is malformed.".into());
            }
            for line in lines {
                if line.is_empty() {
                    continue;
                }
                let data_directory = decode_manifest_path(line)?;
                if worktree_storage::data_directory_owned_by(
                    cache_directory,
                    &data_directory,
                    &outer_worktree,
                )?
                .is_some()
                {
                    data_directories.insert(data_directory);
                }
            }
        }
    }
    for root in discovered_roots {
        let root = acp_terminal::stable_worktree_identity(root);
        if root != outer_worktree {
            validate_nested_worktree_root(&outer_worktree, &root)?;
            if let Some(data_directory) =
                worktree_storage::data_directory_for_root(cache_directory, &root)
            {
                if worktree_storage::data_directory_owned_by(
                    cache_directory,
                    &data_directory,
                    &outer_worktree,
                )?
                .is_some()
                {
                    data_directories.insert(data_directory);
                }
            }
        }
    }
    for data_directory in
        worktree_storage::discover_data_directories(cache_directory, &outer_worktree)
    {
        data_directories.insert(data_directory);
    }
    let mut nested = data_directories
        .into_iter()
        .filter(|data_directory| data_directory != outer_data)
        .collect::<Vec<_>>();
    nested.sort_by_key(|data_directory| {
        worktree_storage::data_directory_owned_by(cache_directory, data_directory, &outer_worktree)
            .map(|root| std::cmp::Reverse(root.map_or(0, |path| path.components().count())))
            .unwrap_or(std::cmp::Reverse(0))
    });
    if !nested.is_empty() {
        let mut contents = format!("{NESTED_WORKTREE_MANIFEST_HEADER}\n");
        for data_directory in &nested {
            contents.push_str(&encode_manifest_path(data_directory));
            contents.push('\n');
        }
        let temporary = outer_data.join(format!(
            ".{NESTED_WORKTREE_MANIFEST_PREFIX}{}.tmp",
            uuid::Uuid::new_v4()
        ));
        let published = outer_data.join(format!(
            "{NESTED_WORKTREE_MANIFEST_PREFIX}{}.manifest",
            uuid::Uuid::new_v4()
        ));
        let write_result = (|| {
            use std::io::Write as _;
            let mut file = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&temporary)
                .map_err(|error| error.to_string())?;
            file.write_all(contents.as_bytes())
                .map_err(|error| error.to_string())?;
            file.sync_all().map_err(|error| error.to_string())?;
            rename_without_replace(&temporary, &published).map_err(|error| error.to_string())?;
            Ok::<(), String>(())
        })();
        if write_result.is_err() {
            let _ = std::fs::remove_file(&temporary);
        }
        write_result?;
    }
    nested.push(outer_data.to_path_buf());
    Ok(nested)
}

fn validate_nested_worktree_root(outer: &Path, candidate: &Path) -> Result<(), String> {
    let outer = acp_terminal::stable_worktree_identity(outer);
    let candidate = acp_terminal::stable_worktree_identity(candidate);
    if candidate == outer || !candidate.starts_with(&outer) {
        return Err(
            "Nested worktree manifest contains a path outside the selected worktree.".into(),
        );
    }
    Ok(())
}

fn encode_manifest_path(path: &Path) -> String {
    #[cfg(unix)]
    let bytes = {
        use std::os::unix::ffi::OsStrExt;
        path.as_os_str().as_bytes().to_vec()
    };
    #[cfg(windows)]
    let bytes = {
        use std::os::windows::ffi::OsStrExt;
        path.as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    #[cfg(not(any(unix, windows)))]
    let bytes = path.to_string_lossy().as_bytes().to_vec();
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn decode_manifest_path(encoded: &str) -> Result<PathBuf, String> {
    if encoded.len() & 1 != 0 || !encoded.bytes().all(|byte| byte.is_ascii_hexdigit()) {
        return Err("Nested worktree manifest contains an invalid path encoding.".into());
    }
    let bytes = encoded
        .as_bytes()
        .chunks(2)
        .map(|pair| {
            let high = (pair[0] as char).to_digit(16).unwrap_or_default() as u8;
            let low = (pair[1] as char).to_digit(16).unwrap_or_default() as u8;
            (high << 4) | low
        })
        .collect::<Vec<_>>();
    #[cfg(unix)]
    let path = {
        use std::os::unix::ffi::OsStringExt;
        PathBuf::from(OsString::from_vec(bytes))
    };
    #[cfg(windows)]
    let path = {
        use std::os::windows::ffi::OsStringExt;
        if bytes.len() & 1 != 0 {
            return Err("Nested worktree manifest contains an invalid Windows path.".into());
        }
        PathBuf::from(OsString::from_wide(
            &bytes
                .chunks(2)
                .map(|pair| u16::from_le_bytes([pair[0], pair[1]]))
                .collect::<Vec<_>>(),
        ))
    };
    #[cfg(not(any(unix, windows)))]
    let path = PathBuf::from(String::from_utf8(bytes).map_err(|error| error.to_string())?);
    Ok(path)
}

#[cfg(test)]
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
pub(crate) fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
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
pub(crate) fn rename_without_replace(source: &Path, destination: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    use windows_sys::Win32::Storage::FileSystem::MoveFileExW;

    let source = extended_windows_path(source)
        .as_os_str()
        .encode_wide()
        .chain(std::iter::once(0))
        .collect::<Vec<_>>();
    let destination = extended_windows_path(destination)
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

#[cfg(windows)]
fn extended_windows_path(path: &Path) -> PathBuf {
    use std::os::windows::ffi::{OsStrExt, OsStringExt};

    let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let slash = b'\\' as u16;
    let question = b'?' as u16;
    let prefix = [slash, slash, question, slash];
    if wide.starts_with(&prefix) {
        return path.to_path_buf();
    }

    let mut extended = Vec::new();
    if wide.starts_with(&[slash, slash]) {
        extended.extend([slash, slash, question, slash]);
        extended.extend("UNC\\".encode_utf16());
        extended.extend(wide.iter().skip(2));
    } else if wide.len() >= 3 && wide[1] == b':' as u16 && wide[2] == slash {
        extended.extend(prefix);
        extended.extend(wide);
    } else {
        return path.to_path_buf();
    }
    PathBuf::from(std::ffi::OsString::from_wide(&extended))
}

#[cfg(test)]
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

#[cfg(test)]
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
        remove_worktree(
            repository,
            worktree.to_string_lossy().into_owned(),
            None,
            expected_revision.as_deref(),
            expected_branch.as_deref(),
        )?;
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

struct WorktreeHeadLock {
    path: PathBuf,
    token: String,
}

struct WorktreeRegistrationLock {
    path: PathBuf,
    reason: String,
}

impl WorktreeRegistrationLock {
    fn release(self) -> Result<(), String> {
        if std::fs::read_to_string(&self.path).ok().as_deref() != Some(&self.reason) {
            return Err("Git worktree registration changed during deletion.".into());
        }
        std::fs::remove_file(&self.path)
            .map_err(|error| format!("Cannot unlock the Git worktree before deletion: {error}"))
    }
}

impl Drop for WorktreeRegistrationLock {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.path).ok().as_deref() == Some(&self.reason) {
            let _ = std::fs::remove_file(&self.path);
        }
    }
}

fn lock_worktree_registration(worktree: &Path) -> Result<WorktreeRegistrationLock, String> {
    use std::fs::OpenOptions;

    let admin = git_reference(worktree, &["rev-parse", "--absolute-git-dir"])
        .ok_or("Cannot locate the worktree registration before deletion.")?;
    let path = PathBuf::from(admin).join("locked");
    let reason = format!("Sail deletion {}\n", uuid::Uuid::new_v4());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&path)
        .map_err(|error| format!("Cannot lock the Git worktree before deletion: {error}"))?;
    if let Err(error) = file
        .write_all(reason.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = std::fs::remove_file(&path);
        return Err(format!(
            "Cannot lock the Git worktree before deletion: {error}"
        ));
    }
    Ok(WorktreeRegistrationLock { path, reason })
}

impl Drop for WorktreeHeadLock {
    fn drop(&mut self) {
        if std::fs::read_to_string(&self.path).ok().as_deref() == Some(&self.token) {
            let _ = std::fs::remove_file(&self.path);
        }
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
    let token = format!("Sail checkout lock {}\n", uuid::Uuid::new_v4());
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&lock)
        .map_err(|error| format!("Cannot lock the worktree checkout before deletion: {error}"))?;
    if let Err(error) = file
        .write_all(token.as_bytes())
        .and_then(|()| file.sync_all())
    {
        let _ = std::fs::remove_file(&lock);
        return Err(format!(
            "Cannot lock the worktree checkout before deletion: {error}"
        ));
    }
    Ok(WorktreeHeadLock { path: lock, token })
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

fn preserve_detached_head(repository: &Path, head: &str) -> Result<String, String> {
    // Removing the worktree also removes the only ref to a detached commit.
    let reference = format!(
        "refs/sail/preserved-detached/{}",
        uuid::Uuid::new_v4().simple()
    );
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["update-ref", &reference, head])
        .output()
        .map_err(|error| format!("Cannot preserve the detached commit: {error}"))?;
    if !output.status.success() {
        return Err(format!(
            "Cannot preserve the detached commit: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    Ok(reference)
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

fn move_worktree_for_removal(repository: &Path, from: &Path, to: &Path) -> Result<(), String> {
    if to.symlink_metadata().is_ok() {
        return Err(format!(
            "Cannot move the worktree for deletion because {} already exists.",
            to.display()
        ));
    }
    let output = Command::new("git")
        .arg("-C")
        .arg(repository)
        .args(["worktree", "move", "--force", "--force"])
        .arg(from)
        .arg(to)
        .output()
        .map_err(|error| format!("Cannot start Git to move the worktree: {error}"))?;
    if output.status.success() {
        Ok(())
    } else {
        Err(format!(
            "Cannot move the worktree for deletion: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ))
    }
}

fn pending_recovery_error(
    repository: &Path,
    original: &Path,
    recovery: &Path,
    expected_generation: Option<&str>,
    reason: &str,
) -> String {
    let mut reason = reason.to_string();
    if expected_generation.is_some()
        && worktree_storage::generation(recovery).ok().as_deref() != expected_generation
    {
        let repaired = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(["worktree", "repair"])
            .arg(recovery)
            .output();
        if !repaired.is_ok_and(|output| output.status.success()) {
            reason.push_str(" Git could not repair the recovery checkout registration.");
        }
    }
    if expected_generation.is_some()
        && worktree_storage::generation(recovery).ok().as_deref() != expected_generation
    {
        reason.push_str(" The recovery checkout identity needs manual inspection.");
    }
    let size_bytes = worktree_size_bytes(recovery).ok();
    format!(
        "SAIL_PENDING_RECOVERY:{}",
        serde_json::json!({
            "originalPath": original.to_string_lossy(),
            "recoveryPath": recovery.to_string_lossy(),
            "sizeBytes": size_bytes,
            "reason": reason,
        })
    )
}

#[cfg(test)]
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

#[cfg(test)]
fn remove_worktree_guarded(
    repository: String,
    worktree: String,
    force: Option<bool>,
    expected_revision: Option<&str>,
    expected_branch: Option<&str>,
    expected_generation: Option<&str>,
) -> Result<(), String> {
    remove_worktree_guarded_with_hook(
        repository,
        worktree,
        force,
        expected_revision,
        expected_branch,
        expected_generation,
        || Ok(()),
    )
}

fn remove_worktree_guarded_with_hook<F>(
    repository: String,
    worktree: String,
    force: Option<bool>,
    expected_revision: Option<&str>,
    expected_branch: Option<&str>,
    expected_generation: Option<&str>,
    after_remove: F,
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
        expected_generation,
        (|| Ok(()), || Ok(()), || Ok(()), |_| Ok(()), after_remove),
    )
}

fn git_remove_worktree(
    repository: &Path,
    worktree: &Path,
    force: bool,
    original_directory: Option<&WorktreeDirectoryIdentity>,
    mut check_identity: impl FnMut(bool) -> Result<(), String>,
) -> Result<(), String> {
    let attempts = if force { 6 } else { 1 };
    for attempt in 0..attempts {
        let listed = git_reference(repository, &["worktree", "list", "--porcelain", "-z"])
            .ok_or("Cannot inspect repository worktrees before deletion.")?;
        let registered = parse_registered_worktrees(&listed)
            .into_iter()
            .any(|entry| {
                acp_terminal::stable_worktree_identity(Path::new(&entry.path)) == worktree
            });
        check_identity(registered)?;
        // Git unregisters a worktree even when removing its files fails.
        // The caller still verifies the original directory before each retry.
        if !registered && force {
            if let Some(original_directory) = original_directory {
                return remove_remaining_worktree_files(worktree, original_directory);
            }
            return if std::fs::symlink_metadata(worktree)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                Ok(())
            } else {
                Err(
                    "Worktree path was recreated during deletion. Refresh before continuing."
                        .into(),
                )
            };
        }
        let mut command = Command::new("git");
        command
            .arg("-C")
            .arg(repository)
            .args(["worktree", "remove"]);
        if force {
            command.args(["--force", "--force"]);
        }
        let output = command
            .arg(worktree)
            .output()
            .map_err(|error| format!("Cannot start Git: {error}"))?;
        if output.status.success() {
            return Ok(());
        }
        let listed = git_reference(repository, &["worktree", "list", "--porcelain", "-z"])
            .ok_or("Cannot inspect repository worktrees after failed deletion.")?;
        let registered = parse_registered_worktrees(&listed)
            .into_iter()
            .any(|entry| {
                acp_terminal::stable_worktree_identity(Path::new(&entry.path)) == worktree
            });
        if !registered && !worktree.exists() {
            return Ok(());
        }
        let error = format!(
            "Cannot delete worktree: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        );
        if attempt + 1 == attempts {
            return Err(error);
        }
        diagnostics::record(
            "worktree_removal_retry",
            serde_json::json!({
                "worktree": worktree, "attempt": attempt + 1, "error": error,
            }),
        );
        std::thread::sleep(std::time::Duration::from_millis(100 << attempt));
    }
    unreachable!()
}

fn remove_remaining_worktree_files(
    worktree: &Path,
    original: &WorktreeDirectoryIdentity,
) -> Result<(), String> {
    let quarantine = worktree
        .parent()
        .ok_or("Cannot locate worktree parent.")?
        .join(format!(".sail-delete-{}", uuid::Uuid::new_v4()));
    match rename_without_replace(worktree, &quarantine) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(format!("Cannot isolate remaining worktree files: {error}")),
    }
    let result = (|| {
        let current =
            worktree_directory_identity(&quarantine).map_err(|error| error.to_string())?;
        if !same_worktree_directory(original, &current) {
            return Err(
                "Worktree identity changed during deletion. Refresh before continuing.".into(),
            );
        }
        for attempt in 0..6 {
            match make_worktree_files_removable(&quarantine)
                .and_then(|()| std::fs::remove_dir_all(&quarantine))
            {
                Ok(()) => return Ok(()),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                Err(error) if attempt == 5 => {
                    return Err(format!("Cannot delete remaining worktree files: {error}"))
                }
                Err(error) => diagnostics::record(
                    "worktree_removal_retry",
                    serde_json::json!({
                        "worktree": worktree, "attempt": attempt + 1, "error": error.to_string(),
                    }),
                ),
            }
            std::thread::sleep(std::time::Duration::from_millis(100 << attempt));
        }
        unreachable!()
    })();
    if let Err(error) = result {
        return match rename_without_replace(&quarantine, worktree) {
            Ok(()) => Err(error),
            Err(restore) => Err(format!(
                "{error} Remaining files are preserved at {}: {restore}",
                quarantine.display()
            )),
        };
    }
    Ok(())
}

fn make_worktree_files_removable(path: &Path) -> std::io::Result<()> {
    let metadata = match std::fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error),
    };
    if metadata.file_type().is_symlink() {
        return Ok(());
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mut permissions = metadata.permissions();
        if metadata.is_dir() {
            permissions.set_mode(permissions.mode() | 0o700);
        }
        if permissions != metadata.permissions() {
            std::fs::set_permissions(path, permissions)?;
        }
    }
    #[cfg(windows)]
    {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_READONLY,
        };
        let attributes = metadata.file_attributes();
        if attributes & FILE_ATTRIBUTE_READONLY != 0 {
            let path = extended_windows_path(path)
                .as_os_str()
                .encode_wide()
                .chain(std::iter::once(0))
                .collect::<Vec<_>>();
            if unsafe { SetFileAttributesW(path.as_ptr(), attributes & !FILE_ATTRIBUTE_READONLY) }
                == 0
            {
                return Err(std::io::Error::last_os_error());
            }
        }
    }
    if metadata.is_dir() {
        for entry in std::fs::read_dir(path)? {
            make_worktree_files_removable(&entry?.path())?;
        }
    }
    Ok(())
}

#[derive(Debug, Eq, PartialEq)]
struct WorktreeDirectoryIdentity {
    #[cfg(unix)]
    device: u64,
    #[cfg(unix)]
    inode: u64,
    #[cfg(windows)]
    volume: u64,
    #[cfg(windows)]
    file: [u8; 16],
}

fn worktree_directory_identity(path: &Path) -> std::io::Result<WorktreeDirectoryIdentity> {
    let metadata = std::fs::symlink_metadata(path)?;
    if !metadata.file_type().is_dir() {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Worktree path is not a directory.",
        ));
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        Ok(WorktreeDirectoryIdentity {
            device: metadata.dev(),
            inode: metadata.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Storage::FileSystem::{
            FileIdInfo, GetFileInformationByHandleEx, FILE_FLAG_BACKUP_SEMANTICS,
            FILE_FLAG_OPEN_REPARSE_POINT, FILE_ID_INFO, FILE_READ_ATTRIBUTES,
        };
        let file = std::fs::OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(extended_windows_path(path))?;
        let mut info = FILE_ID_INFO::default();
        if unsafe {
            GetFileInformationByHandleEx(
                file.as_raw_handle(),
                FileIdInfo,
                std::ptr::from_mut(&mut info).cast(),
                std::mem::size_of::<FILE_ID_INFO>() as u32,
            )
        } == 0
        {
            return Err(std::io::Error::last_os_error());
        }
        Ok(WorktreeDirectoryIdentity {
            volume: info.VolumeSerialNumber,
            file: info.FileId.Identifier,
        })
    }
}

fn same_worktree_directory(
    original: &WorktreeDirectoryIdentity,
    current: &WorktreeDirectoryIdentity,
) -> bool {
    original == current
}

#[cfg(test)]
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
        None,
        (before_remove, || Ok(()), || Ok(()), |_| Ok(()), || Ok(())),
    )
}

fn remove_worktree_with_hooks<F, G, H, I, J>(
    repository: String,
    worktree: String,
    force: Option<bool>,
    expected_revision: Option<&str>,
    expected_branch: Option<&str>,
    expected_generation: Option<&str>,
    hooks: (F, G, H, I, J),
) -> Result<(), String>
where
    F: FnOnce() -> Result<(), String>,
    G: FnOnce() -> Result<(), String>,
    H: FnOnce() -> Result<(), String>,
    I: FnOnce(&Path) -> Result<(), String>,
    J: FnOnce() -> Result<(), String>,
{
    let (
        before_final_identity_check,
        after_final_identity_check,
        after_unlock,
        before_git_remove,
        after_remove,
    ) = hooks;
    let repository = PathBuf::from(validate_repository_path(repository)?)
        .git_canonical()
        .map_err(|_| "Repository folder no longer exists.".to_string())?;
    let requested_worktree = acp_terminal::stable_worktree_identity(Path::new(&worktree));
    let worktree = match Path::new(&worktree).git_canonical() {
        Ok(worktree) => worktree,
        Err(_) if !requested_worktree.exists() => {
            if expected_generation.is_some() {
                return Err(
                    "Worktree identity changed after preview. Refresh before deleting.".into(),
                );
            }
            let force_missing =
                force == Some(true) && expected_revision.is_none() && expected_branch.is_none();
            if force_missing {
                git_overlay::forget_removed_worktree(&requested_worktree)?;
            } else {
                git_overlay::require_no_private_state_at_missing(&requested_worktree)?;
            }
            let listed = git_reference(&repository, &["worktree", "list", "--porcelain", "-z"])
                .ok_or("Cannot inspect repository worktrees.")?;
            let still_registered = parse_registered_worktrees(&listed)
                .into_iter()
                .any(|entry| {
                    acp_terminal::stable_worktree_identity(Path::new(&entry.path))
                        == requested_worktree
                });
            if still_registered {
                if !force_missing {
                    return Err("Worktree folder no longer exists but is still registered. Refresh before deleting.".into());
                }
                git_remove_worktree(&repository, &requested_worktree, true, None, |_| {
                    if std::fs::symlink_metadata(&requested_worktree).is_ok() {
                        return Err("Worktree path was recreated during deletion. Refresh before continuing.".into());
                    }
                    Ok(())
                })?;
            }
            after_remove()?;
            return Ok(());
        }
        Err(_) => return Err("Worktree folder no longer exists.".to_string()),
    };
    if worktree == repository {
        return Err("Cannot delete the main repository.".to_string());
    }
    git_overlay::require_shared_current(&worktree)?;
    let listed = git_reference(&repository, &["worktree", "list", "--porcelain"])
        .ok_or("Cannot inspect repository worktrees.")?;
    let registered = listed
        .lines()
        .filter_map(|line| line.strip_prefix("worktree "))
        .filter_map(|path| Path::new(path).git_canonical().ok())
        .collect::<Vec<_>>();
    if !registered.iter().any(|path| {
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
    let preview_guarded = expected_revision.is_some() && expected_generation.is_some();
    if expected_generation.is_some() && !preview_guarded && force != Some(true) {
        return Err(
            "Worktree remains registered pending a revision-bound cleanup preview and unused confirmation."
                .into(),
        );
    }
    let stage_guarded = expected_generation.is_some() && (preview_guarded || force != Some(true));
    let ensure_expected_branch = || -> Result<(), String> {
        let Some(expected) = expected_branch else {
            if preview_guarded
                && git_reference(&worktree, &["symbolic-ref", "--quiet", "HEAD"]).is_some()
            {
                return Err(
                    "Worktree attached to a branch after preview. Revalidate before deleting it."
                        .into(),
                );
            }
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
    // A descendant's confirmed preview carries a revision and generation. Git's
    // ordinary remove must reject content written after Sail's final check.
    let ensure_nonforce_clean = || -> Result<(), String> {
        if force && !preview_guarded {
            return Ok(());
        }
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
        if expected_generation.is_some() && !status.stdout.is_empty() {
            return Err(
                "Worktree contains modified or untracked files. Clean it and retry deletion."
                    .into(),
            );
        }
        if expected_generation.is_some() && !tracked_worktree_matches_head(&worktree)? {
            return Err(
                "Worktree contains modified or untracked files. Clean it and retry deletion."
                    .into(),
            );
        }
        Ok(())
    };
    ensure_nonforce_clean()?;
    ensure_expected_revision()?;
    ensure_expected_branch()?;
    let guarded = guarded_removal_state(
        &worktree,
        expected_revision.is_some() || expected_branch.is_some() || expected_generation.is_some(),
    )?;
    before_final_identity_check()?;
    let registration_lock = expected_generation
        .map(|_| lock_worktree_registration(&worktree))
        .transpose()?;
    ensure_expected_worktree_generation(&worktree, expected_generation)?;
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
    git_overlay::require_shared_current(&worktree)?;
    ensure_expected_worktree_generation(&worktree, expected_generation)?;
    ensure_expected_revision()?;
    ensure_expected_branch()?;
    ensure_nonforce_clean()?;
    let preserved_detached_ref = guarded
        .as_ref()
        .filter(|state| state.reference.is_none())
        .map(|state| preserve_detached_head(&repository, &state.head))
        .transpose()?;
    let staged_worktree = if stage_guarded {
        // Move the confirmed generation while its Git registration is locked.
        // An external replacement at the old path cannot become the remove target.
        let mut parent = worktree
            .parent()
            .ok_or("Cannot stage the worktree outside its directory.")?
            .to_path_buf();
        while registered.iter().any(|path| parent.starts_with(path)) {
            parent = parent
                .parent()
                .ok_or("Cannot stage the worktree outside registered worktrees.")?
                .to_path_buf();
        }
        let staged = parent.join(format!(".sail-removing-{}", uuid::Uuid::new_v4()));
        if let Err(error) = move_worktree_for_removal(&repository, &worktree, &staged) {
            if worktree_storage::generation(&staged).ok().as_deref() == expected_generation {
                if let Err(restore) = move_worktree_for_removal(&repository, &staged, &worktree) {
                    return Err(pending_recovery_error(
                        &repository,
                        &worktree,
                        &staged,
                        expected_generation,
                        &format!("{error} The original path is unavailable: {restore}"),
                    ));
                }
            } else if staged.exists() && !worktree.exists() {
                return Err(pending_recovery_error(
                    &repository,
                    &worktree,
                    &staged,
                    expected_generation,
                    &error,
                ));
            }
            return Err(error);
        }
        Some(staged)
    } else {
        None
    };
    let removal_target = staged_worktree.as_deref().unwrap_or(&worktree);
    let remove_result = (|| -> Result<(), String> {
        if stage_guarded {
            ensure_expected_worktree_generation(removal_target, expected_generation)?;
            let actual = guarded_removal_state(removal_target, true)?
                .ok_or("Cannot inspect the staged worktree before deletion.")?;
            if guarded.as_ref() != Some(&actual) {
                return Err(
                    "Worktree checkout changed during deletion. Revalidate before deleting it."
                        .into(),
                );
            }
            registration_lock
                .ok_or("Cannot unlock the Git worktree before deletion.")?
                .release()?;
            after_unlock()?;
            ensure_expected_worktree_generation(removal_target, expected_generation)?;
            if let Some(expected) = expected_revision {
                if git_directory_revision(removal_target)? != expected {
                    return Err(
                        "Worktree changed after validation. Revalidate before deleting it.".into(),
                    );
                }
            }
            if let Some(expected) = expected_branch {
                let expected = expected.strip_prefix("refs/heads/").unwrap_or(expected);
                let actual = git_reference(
                    removal_target,
                    &["symbolic-ref", "--quiet", "--short", "HEAD"],
                )
                .ok_or("Cannot read the staged worktree branch before deletion.")?;
                if actual != expected {
                    return Err(format!("Worktree branch changed from {expected} to {actual}. Revalidate before deleting it."));
                }
            } else if preview_guarded
                && git_reference(removal_target, &["symbolic-ref", "--quiet", "HEAD"]).is_some()
            {
                return Err(
                    "Worktree attached to a branch after preview. Revalidate before deleting it."
                        .into(),
                );
            }
            before_git_remove(removal_target)?;
            let status = Command::new("git")
                .arg("-C")
                .arg(removal_target)
                .args([
                    "status",
                    "--porcelain=v1",
                    "--ignored",
                    "--untracked-files=normal",
                ])
                .output()
                .map_err(|error| format!("Cannot start Git: {error}"))?;
            if !status.status.success() {
                return Err("Cannot inspect the staged worktree files before deletion.".into());
            }
            if !status.stdout.is_empty() {
                return Err("Worktree contains modified, untracked or ignored files. Clean it and retry deletion.".into());
            }
            if !tracked_worktree_matches_head(removal_target)? {
                return Err("Worktree contains modified, untracked or ignored files. Clean it and retry deletion.".into());
            }
        } else {
            before_git_remove(removal_target)?;
        }
        if stage_guarded {
            let mut command = Command::new("git");
            command
                .arg("-C")
                .arg(&repository)
                .args(["worktree", "remove"]);
            if !preview_guarded && expected_generation.is_some() {
                // Git requires two force flags to remove a worktree under our lock.
                command.args(["--force", "--force"]);
            }
            let output = command
                .arg(removal_target)
                .output()
                .map_err(|error| format!("Cannot start Git: {error}"))?;
            if !output.status.success() {
                return Err(format!(
                    "Cannot delete worktree: {}",
                    String::from_utf8_lossy(&output.stderr).trim()
                ));
            }
        } else {
            let pointer = std::fs::read(worktree.join(".git")).map_err(|error| {
                format!("Cannot capture worktree identity before deletion: {error}")
            })?;
            let directory_identity = worktree_directory_identity(&worktree).map_err(|error| {
                format!("Cannot capture worktree directory before deletion: {error}")
            })?;
            let mut first_attempt = true;
            git_remove_worktree(
                &repository,
                &worktree,
                force,
                Some(&directory_identity),
                |registered| {
                    match worktree_directory_identity(&worktree) {
                        Ok(current) => {
                            let current_pointer = std::fs::read(worktree.join(".git"));
                            if !same_worktree_directory(&directory_identity, &current)
                                || (registered
                                    && current_pointer.as_deref().ok() != Some(pointer.as_slice()))
                                || current_pointer.is_ok_and(|current| current != pointer)
                            {
                                return Err(
                                    "Worktree identity changed during deletion. Refresh before continuing."
                                        .into(),
                                );
                            }
                            if !first_attempt && registered {
                                ensure_expected_revision()?;
                                ensure_expected_branch()?;
                                git_overlay::require_shared_current(&worktree)?;
                            }
                        }
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                        Err(error) => {
                            return Err(format!(
                                "Cannot verify worktree directory before deletion: {error}"
                            ))
                        }
                    }
                    first_attempt = false;
                    Ok(())
                },
            )?;
        }
        Ok(())
    })();
    if let Err(error) = remove_result {
        if let Some(staged) = staged_worktree.as_ref().filter(|path| path.exists()) {
            if let Err(restore) = move_worktree_for_removal(&repository, staged, &worktree) {
                return Err(pending_recovery_error(
                    &repository,
                    &worktree,
                    staged,
                    expected_generation,
                    &format!("{error} The original path is unavailable: {restore}"),
                ));
            }
        }
        return Err(error);
    }
    after_remove()?;
    let listed = git_reference(&repository, &["worktree", "list", "--porcelain", "-z"])
        .ok_or("Cannot verify repository worktrees after deletion.")?;
    let re_registered = parse_registered_worktrees(&listed)
        .into_iter()
        .any(|entry| {
            let registered = Path::new(&entry.path);
            let same_path = registered == worktree
                || registered == removal_target
                || registered
                    .git_canonical()
                    .is_ok_and(|registered| registered == worktree);
            same_path
                && (!stage_guarded
                    || entry.path == removal_target.to_string_lossy()
                    || worktree_storage::generation(&worktree).ok().as_deref()
                        == expected_generation)
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
            .or(preserved_detached_ref.as_deref())
            .ok_or("Cannot verify the removed worktree commit.")?;
        let current = git_reference(&repository, &["rev-parse", "--verify", reference]);
        if current.as_deref() != Some(state.head.as_str()) {
            if state.reference.is_some() {
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
            return Err(format!(
                "Detached worktree was removed, but its preserved ref {reference} changed. The original commit was {}.",
                state.head
            ));
        }
    }
    git_overlay::forget_removed_worktree(&worktree)?;
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let builder = tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .setup(|_app| {
            _app.manage(reef_admission::StartupMode(
                settings::string_setting(_app.handle(), "sai-reef-admission-enabled")?.as_deref()
                    == Some("true"),
            ));
            if let Err(error) = diagnostics::init(_app.handle()) {
                eprintln!("Sail diagnostics unavailable: {error}");
            }
            let cache_directory = _app.path().app_cache_dir().ok();
            if let Some(cache_directory) = cache_directory.as_ref() {
                git_overlay::configure(cache_directory);
            }
            std::thread::Builder::new()
                .name("sail-startup-maintenance".into())
                .spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(2));
                    let started = std::time::Instant::now();
                    diagnostics::record("startup_maintenance_started", serde_json::json!({}));
                    let mut phases = serde_json::Map::new();
                    let mut timed = |name: &str, run: &mut dyn FnMut()| {
                        let phase_started = std::time::Instant::now();
                        run();
                        phases.insert(
                            format!("{name}Ms"),
                            serde_json::json!(phase_started.elapsed().as_millis() as u64),
                        );
                    };
                    if let Some(cache_directory) = cache_directory.as_ref() {
                        timed("worktreeStorage", &mut || {
                            worktree_storage::reconcile(cache_directory);
                        });
                        timed("gitOverlay", &mut || {
                            git_overlay::restore_registered(cache_directory);
                        });
                    }
                    #[cfg(unix)]
                    timed("scratchSweep", &mut || {
                        scratch_cleanup::sweep_on_startup(cache_directory.as_deref());
                    });
                    phases.insert(
                        "elapsedMs".into(),
                        serde_json::json!(started.elapsed().as_millis() as u64),
                    );
                    diagnostics::record(
                        "startup_maintenance_finished",
                        serde_json::Value::Object(phases),
                    );
                })
                .map_err(std::io::Error::other)?;
            #[cfg(unix)]
            {
                let app = _app.handle().clone();
                if let Err(error) = scratch_cleanup::spawn_runtime_sweeper(move |root| {
                    app.try_state::<acp::AgentManager>()
                        .is_none_or(|manager| acp::runtime_root_in_use(&manager, root))
                }) {
                    eprintln!("Sail runtime scratch sweep unavailable: {error}");
                }
            }
            let process_directory = _app.path().app_config_dir()?.join("owned-processes");
            owned_processes::init(process_directory).map_err(std::io::Error::other)?;
            browser_agent::start_bridge(_app.handle())?;
            acp::start_idle_session_sweeper(_app.handle().clone());
            if let Err(error) = hook_activity::start_bridge(_app.handle()) {
                eprintln!("Sail hook receiver unavailable: {error}");
            }
            #[cfg(any(target_os = "macos", windows))]
            configure_pane_menu(_app.handle())?;
            Ok(())
        })
        .manage(WorktreeOperationLocks::default())
        .manage(acp::AgentManager::default())
        .manage(acp::AgentWorktreeFence::default())
        .manage(acp_terminal::AcpTerminalManager::default())
        .manage(terminal::TerminalManager::default())
        .manage(post_turn_checks::CheckLock::default())
        .manage(shell_command::ShellRuns::default())
        .manage(browser_agent::BrowserManager::default())
        .manage(browser::CaptureStore::default())
        .manage(project_knowledge::PendingProposal::default())
        .manage(hook_activity::HookActivityManager::default())
        .invoke_handler(tauri::generate_handler![
            diagnostics::diagnostic_event,
            worktree_storage_cleanup_status,
            retry_worktree_storage_cleanup,
            retry_selected_removed_worktree_storage,
            selected_removed_worktree_storage,
            worktree_cache_status,
            set_worktree_cache_limit,
            clean_pending_worktree_temp,
            settings::reset_test_settings,
            e2e_keyboard::send_test_tab,
            settings::load_settings,
            settings::migrate_settings,
            settings::save_setting,
            machine_pressure::machine_pressure,
            reef_admission::reef_admission_mode,
            reef_admission::reef_admission_request,
            reef_admission::reef_admission_status,
            reef_admission::reef_admission_release,
            settings::list_interrupted_agent_turns,
            settings::finish_interrupted_agent_turn,
            settings::get_acp_turn_evidence,
            settings::list_pending_acp_post_turn_checks,
            settings::finish_acp_post_turn_checks,
            memory::memory_project_key,
            memory::memory_status,
            memory::memory_list,
            memory::memory_search,
            memory::memory_remember,
            memory::memory_supersede,
            memory::memory_mark_conflict,
            memory::memory_inspect,
            memory::memory_forget,
            memory::memory_set_expiry,
            memory::memory_rate,
            project_knowledge::preview_project_knowledge,
            project_knowledge::accept_project_knowledge,
            project_knowledge::reject_project_knowledge,
            memory_import::preview_memory_import,
            memory_import::import_agent_memories,
            memory_provider::memory_provider_status,
            memory_provider::verify_memory_provider,
            memory_provider::set_memory_provider,
            memory_provider::sync_memory_provider,
            memory_provider::resolve_memory_provider_pending,
            repository_path_available,
            pending_cleanup_paths_absent,
            pending_cleanup_overlay_absent,
            pending_cleanup_overlay_status,
            opencode_config::opencode_plan_review_plugin,
            validate_repository,
            list_picker_directory,
            working_tree_diff,
            working_tree_revision,
            working_tree_generation,
            working_tree_commit,
            shipping_base_revision,
            shipping_worktree_target,
            shipping_repository_target,
            shipping_changed_paths,
            worktree_overviews,
            worktree_snapshots::record_turn_snapshot,
            worktree_snapshots::list_turn_snapshots,
            worktree_snapshots::restore_turn_snapshot,
            git_change_action,
            diff_file_contents,
            create_worktree,
            worktree_pressure_directory,
            create_shipping_worktree,
            create_shipping_replacement_worktree,
            find_shipping_worktree,
            run_shipping_setup,
            registered_worktrees,
            repository_worktrees,
            worktree_cleanup_summary,
            worktree_removal_preview,
            restore_pending_worktree,
            retry_removed_worktree_overlay_cleanup,
            delete_worktree,
            worktree_config,
            context::context_provider_status,
            context::context_register_provider,
            context::context_approve_provider,
            context::context_revoke_provider,
            post_turn_checks::approve_post_turn_check,
            post_turn_checks::is_post_turn_check_approved,
            post_turn_checks::cancel_post_turn_check,
            post_turn_checks::list_post_turn_checks,
            post_turn_checks::run_post_turn_check,
            shell_command::run_shell_command,
            shell_command::cancel_shell_command,
            hook_inspector::inspect_agent_hooks,
            memory_install::memory_agent_status,
            memory_install::preview_memory_agent_install,
            memory_install::preview_memory_agent_uninstall,
            memory_install::install_memory_agent,
            memory_install::install_memory_agents,
            memory_install::uninstall_memory_agent,
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
            local_claims::acquire_shipping_claim,
            local_claims::observe_shipping_claim,
            local_claims::complete_predecessor_shipping_claim_fence,
            local_claims::heartbeat_shipping_claim,
            local_claims::release_shipping_claim,
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
            acp::acp_agents,
            acp::acp_connect,
            acp::acp_release_owner,
            acp::acp_new_session,
            acp::acp_reset_test_runtimes,
            acp::acp_forget_session,
            acp::acp_release_session_fence,
            acp::acp_load_session,
            acp::acp_begin_session_restore,
            acp::acp_end_session_restore,
            acp::acp_resume_session,
            acp::acp_list_sessions,
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
            acp::acp_session_visible,
            acp::acp_set_idle_close_timeout,
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
                if let Err(error) = owned_processes::shutdown() {
                    diagnostics::record(
                        "owned_process_cleanup_failed",
                        serde_json::json!({"error": error}),
                    );
                }
                if let Some(manager) = app.try_state::<hook_activity::HookActivityManager>() {
                    hook_activity::cleanup(&manager);
                }
            }
        });
}

#[tauri::command]
async fn worktree_storage_cleanup_status(
    app: tauri::AppHandle,
) -> Result<Vec<worktree_storage::CleanupPending>, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || worktree_storage::cleanup_status(&cache))
        .await
        .map_err(|error| error.to_string())
}

#[tauri::command]
async fn retry_worktree_storage_cleanup(
    app: tauri::AppHandle,
) -> Result<Vec<worktree_storage::CleanupPending>, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree_storage::forget_reported_pending();
        app.state::<acp::AgentManager>()
            .retry_turn_temp_cleanup(&app);
        worktree_storage::retry_cleanup(&cache)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
fn retry_selected_removed_worktree_storage(
    app: tauri::AppHandle,
    repository: String,
    original_worktree: String,
    expected_generation: String,
    cache_key: String,
    confirmed_unused: bool,
) -> Result<(), String> {
    if !confirmed_unused || !Path::new(&original_worktree).is_absolute() {
        return Err("Confirm that the selected worktree storage is unused before retrying.".into());
    }
    let repository = validate_repository_path(repository)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    worktree_storage::retry_selected_removed_worktree_storage(
        &cache,
        Path::new(&repository),
        Path::new(&original_worktree),
        &expected_generation,
        &cache_key,
    )
}

#[tauri::command]
fn selected_removed_worktree_storage(
    app: tauri::AppHandle,
    repository: String,
    original_worktree: String,
    expected_generation: String,
) -> Result<Vec<worktree_storage::SelectedStorageLocation>, String> {
    if !Path::new(&original_worktree).is_absolute() {
        return Err("The selected original worktree path is invalid.".into());
    }
    let repository = validate_repository_path(repository)?;
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    worktree_storage::selected_removed_storage_locations(
        &cache,
        Path::new(&repository),
        Path::new(&original_worktree),
        &expected_generation,
    )
}

#[tauri::command]
async fn worktree_cache_status(
    app: tauri::AppHandle,
    current_worktree: String,
    known_worktrees: Vec<String>,
) -> Result<Vec<worktree_storage::CacheUsage>, String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let known_worktrees = known_worktrees
            .iter()
            .map(PathBuf::from)
            .collect::<Vec<_>>();
        worktree_storage::cache_status(&cache, Path::new(&current_worktree), &known_worktrees)
    })
    .await
    .map_err(|error| error.to_string())
}

#[tauri::command]
async fn set_worktree_cache_limit(
    app: tauri::AppHandle,
    worktree_token: String,
    limit_bytes: u64,
) -> Result<(), String> {
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree_storage::set_cache_limit_token(&cache, &worktree_token, limit_bytes)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(serde::Deserialize)]
#[serde(rename_all = "camelCase")]
struct PendingTempPreview {
    path: String,
    owner_path: String,
    directory_id: String,
    size_bytes: Option<u64>,
    reason: String,
}

#[tauri::command]
async fn clean_pending_worktree_temp(
    app: tauri::AppHandle,
    token: String,
    expected_preview: PendingTempPreview,
    confirmed_unused: bool,
) -> Result<Vec<worktree_storage::CleanupPending>, String> {
    if !confirmed_unused {
        return Err("Confirm that no process is using this temporary data.".into());
    }
    if !Path::new(&expected_preview.path).is_absolute()
        || !Path::new(&expected_preview.owner_path).is_absolute()
        || expected_preview.directory_id.is_empty()
        || expected_preview.reason.is_empty()
    {
        return Err("The selected temporary data path or owner is invalid.".into());
    }
    let cache = app
        .path()
        .app_cache_dir()
        .map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        worktree_storage::clean_pending_temp_checked(
            &cache,
            &token,
            Path::new(&expected_preview.path),
            Path::new(&expected_preview.owner_path),
            &expected_preview.directory_id,
            expected_preview.size_bytes,
            &expected_preview.reason,
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    #[cfg(any(unix, windows))]
    use super::working_tree_generation;
    use super::{
        add_worktree, archive_ignored_and_remove, archive_ignored_and_remove_with_hook,
        discover_nested_worktree_terminal_roots, encode_manifest_path,
        ensure_expected_worktree_generation, ensure_expected_worktree_inventory,
        existing_shipping_worktree, git_change_action, git_patch, git_reference,
        move_worktree_for_removal, normalize_picker_path, parse_registered_worktrees,
        pending_cleanup_paths_absent, persist_worktree_data_manifest,
        register_worktree_terminal_data, registered_worktrees_sync,
        remove_remaining_worktree_files, remove_worktree, remove_worktree_guarded,
        remove_worktree_then_private_data_many, remove_worktree_then_terminal_data,
        remove_worktree_then_terminal_data_many, remove_worktree_with_hook,
        remove_worktree_with_hooks, replacement_worktree_at_checkpoint, repository_namespace,
        repository_worktrees_inner, restore_pending_worktree_inner, shipping_base_revision,
        shipping_changed_paths, shipping_default_branch, shipping_fetch_source,
        version_is_compatible, version_number, working_tree_diff, worktree_overviews,
        worktree_preview_state_with_hook, ExpectedRegisteredWorktree, WorktreeOperationLocks,
        NESTED_WORKTREE_MANIFEST_HEADER, WORKTREE_DATA_OWNER_FILE,
    };
    use super::{working_tree_commit, working_tree_revision};
    #[cfg(unix)]
    use super::{worktree_size_bytes, worktree_summary_dirty};
    use crate::worktree_storage;
    use crate::GitCanonical;
    use std::fs;
    use std::path::{Path, PathBuf};
    use std::process::Command;

    #[test]
    fn pending_cleanup_completion_requires_every_path_to_be_absent() {
        let root = std::env::temp_dir().join(format!(
            "sail-pending-cleanup-presence-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let original = root.join("original");
        let recovery = root.join("recovery");
        let paths = || {
            vec![
                original.to_string_lossy().into_owned(),
                recovery.to_string_lossy().into_owned(),
            ]
        };

        assert!(pending_cleanup_paths_absent(paths()).unwrap());
        fs::write(&recovery, b"retained").unwrap();
        assert!(!pending_cleanup_paths_absent(paths()).unwrap());
        fs::remove_file(&recovery).unwrap();
        fs::create_dir(&original).unwrap();
        assert!(!pending_cleanup_paths_absent(paths()).unwrap());
        fs::remove_dir(&original).unwrap();
        assert!(pending_cleanup_paths_absent(paths()).unwrap());
        assert!(pending_cleanup_paths_absent(vec!["relative".into()]).is_err());
        assert!(pending_cleanup_paths_absent(vec![]).is_err());
        fs::remove_dir(&root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn pending_cleanup_dangling_symlink_is_still_present() {
        let root = std::env::temp_dir().join(format!(
            "sail-pending-cleanup-link-test-{}",
            uuid::Uuid::new_v4()
        ));
        fs::create_dir_all(&root).unwrap();
        let link = root.join("recovery");
        std::os::unix::fs::symlink(root.join("missing"), &link).unwrap();
        assert!(!pending_cleanup_paths_absent(vec![link.to_string_lossy().into_owned()]).unwrap());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_data_survives_failed_removal_and_is_deleted_after_success() {
        let root = std::env::temp_dir().join(format!(
            "sail-terminal-cleanup-test-{}",
            uuid::Uuid::new_v4()
        ));
        let managed = root.join("managed");
        let sibling = root.join("sibling");
        fs::create_dir_all(&managed).unwrap();
        fs::create_dir_all(&sibling).unwrap();
        fs::write(managed.join("cache"), "keep until worktree removal").unwrap();
        fs::write(sibling.join("cache"), "leave unrelated data alone").unwrap();

        let stop_failure = remove_worktree_then_terminal_data(&managed, || {
            Err::<(), _>("Terminal stop failed".to_string())
        });
        assert_eq!(stop_failure.unwrap_err(), "Terminal stop failed");
        assert!(managed.join("cache").exists());

        let removal_failure = remove_worktree_then_terminal_data(&managed, || {
            Err::<(), _>("Git removal failed".to_string())
        });
        assert_eq!(removal_failure.unwrap_err(), "Git removal failed");
        assert!(managed.join("cache").exists());

        remove_worktree_then_terminal_data(&managed, || Ok(()))
            .expect("managed data should be deleted after successful removal");
        assert!(!managed.exists());
        assert!(sibling.join("cache").exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn worktree_creation_survives_generation_marker_failure() {
        use std::os::unix::fs::PermissionsExt;

        let root = std::env::temp_dir().join(format!(
            "sail-worktree-marker-failure-test-{}",
            uuid::Uuid::new_v4()
        ));
        let repository = root.join("repository");
        let worktrees = root.join("worktrees");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&worktrees).unwrap();
        let repository_arg = repository.to_str().unwrap();
        git(repository_arg, &["init", "-q"]);
        git(repository_arg, &["config", "user.name", "Sail Test"]);
        git(
            repository_arg,
            &["config", "user.email", "sail@example.test"],
        );
        fs::write(repository.join("tracked"), "fixture").unwrap();
        git(repository_arg, &["add", "tracked"]);
        git(repository_arg, &["commit", "--quiet", "-m", "fixture"]);

        let hooks = root.join("hooks");
        fs::create_dir_all(&hooks).unwrap();
        let hook = hooks.join("post-checkout");
        fs::write(
            &hook,
            "#!/bin/sh\ngit_dir=$(git rev-parse --absolute-git-dir) || exit 1\nprintf 'invalid\n' > \"$git_dir/sail-worktree-generation-v1\"\n",
        )
        .unwrap();
        fs::set_permissions(&hook, fs::Permissions::from_mode(0o755)).unwrap();
        git(
            repository_arg,
            &["config", "core.hooksPath", hooks.to_str().unwrap()],
        );

        let created = add_worktree(
            repository_arg.to_string(),
            "created".to_string(),
            Some(worktrees.to_string_lossy().into_owned()),
            None,
        )
        .expect("Git worktree creation must survive an unavailable generation marker");
        assert!(Path::new(&created.path).join("tracked").exists());
        assert_eq!(created.generation, None);
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn cleanup_manifest_does_not_select_a_prior_generation_at_a_reused_path() {
        let root = std::env::temp_dir().join(format!(
            "sail-worktree-generation-manifest-test-{}",
            uuid::Uuid::new_v4()
        ));
        let repository = root.join("repository");
        let worktree = root.join("worktree");
        let cache = root.join("cache");
        fs::create_dir_all(&repository).unwrap();
        let repository_arg = repository.to_str().unwrap();
        let worktree_arg = worktree.to_str().unwrap();
        git(repository_arg, &["init", "-q"]);
        git(repository_arg, &["config", "user.name", "Sail Test"]);
        git(
            repository_arg,
            &["config", "user.email", "sail@example.test"],
        );
        fs::write(repository.join("tracked"), "fixture").unwrap();
        git(repository_arg, &["add", "tracked"]);
        git(repository_arg, &["commit", "--quiet", "-m", "fixture"]);
        git(
            repository_arg,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                worktree_arg,
                "HEAD",
            ],
        );
        let (old_data, old_lease) = worktree_storage::register(&cache, &worktree).unwrap();
        old_lease.release_clean().unwrap();
        fs::write(
            old_data.join("nw-prior.manifest"),
            format!(
                "{NESTED_WORKTREE_MANIFEST_HEADER}\n{}\n",
                encode_manifest_path(&old_data)
            ),
        )
        .unwrap();
        git(
            repository_arg,
            &["worktree", "remove", "--force", worktree_arg],
        );
        git(
            repository_arg,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                worktree_arg,
                "HEAD",
            ],
        );
        let (new_data, new_lease) = worktree_storage::register(&cache, &worktree).unwrap();
        new_lease.release_clean().unwrap();
        assert_ne!(old_data, new_data);

        let selected = persist_worktree_data_manifest(&cache, &new_data, &worktree, &[]).unwrap();
        assert_eq!(selected, vec![new_data.clone()]);
        git(
            repository_arg,
            &["worktree", "remove", "--force", worktree_arg],
        );
        worktree_storage::remove_after_worktree_removal(&cache, &selected).unwrap();

        assert!(!new_data.exists());
        assert!(old_data.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unreadable_current_storage_owner_refuses_worktree_cleanup() {
        let root = std::env::temp_dir().join(format!(
            "sail-unreadable-storage-owner-test-{}",
            uuid::Uuid::new_v4()
        ));
        let repository = root.join("repository");
        let worktree = root.join("worktree");
        let cache = root.join("cache");
        fs::create_dir_all(&repository).unwrap();
        let repository_arg = repository.to_str().unwrap();
        let worktree_arg = worktree.to_str().unwrap();
        git(repository_arg, &["init", "-q"]);
        git(repository_arg, &["config", "user.name", "Sail Test"]);
        git(
            repository_arg,
            &["config", "user.email", "sail@example.test"],
        );
        git(
            repository_arg,
            &["commit", "--allow-empty", "--quiet", "-m", "fixture"],
        );
        git(
            repository_arg,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                worktree_arg,
                "HEAD",
            ],
        );
        let (data, lease) = worktree_storage::register(&cache, &worktree).unwrap();
        lease.release_clean().unwrap();
        let retained = data.join("keep.txt");
        fs::write(&retained, "retained private data").unwrap();
        fs::write(data.join("worktree-owner-v2"), "unreadable owner").unwrap();

        let error = worktree_storage::data_directory_for_removal(&cache, &worktree).unwrap_err();
        assert!(error.contains("unverifiable owner"), "{error}");
        let error = persist_worktree_data_manifest(&cache, &data, &worktree, &[]).unwrap_err();
        assert!(error.contains("unverifiable owner"), "{error}");
        assert!(worktree.exists());
        assert_eq!(
            fs::read_to_string(&retained).unwrap(),
            "retained private data"
        );

        git(
            repository_arg,
            &["worktree", "remove", "--force", worktree_arg],
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn legacy_nested_terminal_data_survives_partial_stop_and_is_reported_pending() {
        let root = std::env::temp_dir().join(format!(
            "sail-nested-terminal-cleanup-test-{}",
            uuid::Uuid::new_v4()
        ));
        let cache = root.join("cache");
        let outer = root.join("worktrees/outer");
        let nested = outer.join("nested");
        fs::create_dir_all(&nested).unwrap();
        let outer_data = crate::acp_terminal::worktree_data_directory(&cache, &outer);
        let nested_data = register_worktree_terminal_data(&cache, &nested).unwrap();
        fs::write(nested_data.join("cache"), "nested terminal data").unwrap();
        fs::create_dir_all(&outer_data).unwrap();
        fs::write(outer_data.join("cache"), "outer terminal data").unwrap();

        let discovered_roots = discover_nested_worktree_terminal_roots(&cache, &outer)
            .expect("find nested terminal caches without active sessions");
        assert_eq!(
            discovered_roots,
            vec![crate::acp_terminal::stable_worktree_identity(&nested)]
        );
        let first_attempt =
            persist_worktree_data_manifest(&cache, &outer_data, &outer, &discovered_roots)
                .expect("persist roots before stopping terminals");
        let error = remove_worktree_then_terminal_data_many(&first_attempt, || {
            Err::<(), _>("second terminal stop failed".to_string())
        })
        .unwrap_err();
        assert_eq!(error, "second terminal stop failed");
        assert!(nested_data.join("cache").exists());
        assert!(outer_data.join("cache").exists());

        fs::remove_dir_all(&outer).unwrap();
        let retry = persist_worktree_data_manifest(&cache, &outer_data, &outer, &[])
            .expect("retry should recover roots from the manifest");
        assert!(
            retry.is_empty(),
            "legacy caches have no durable Git identity"
        );
        remove_worktree_then_terminal_data_many(&retry, || Ok(()))
            .expect("unknown legacy caches should remain untouched");
        assert!(nested_data.join("cache").exists());
        assert!(outer_data.join("cache").exists());
        assert!(!worktree_storage::cleanup_status(&cache).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn nested_terminal_data_manifest_rejects_outside_roots_before_cleanup() {
        let root = std::env::temp_dir().join(format!(
            "sail-nested-terminal-manifest-validation-{}",
            uuid::Uuid::new_v4()
        ));
        let repository = root.join("repository");
        let cache = root.join("cache");
        let outer = root.join("worktrees/outer");
        let outside = root.join("unrelated-worktree");
        fs::create_dir_all(&repository).unwrap();
        let repository_arg = repository.to_str().unwrap();
        let outer_arg = outer.to_str().unwrap();
        let outside_arg = outside.to_str().unwrap();
        git(repository_arg, &["init", "-q"]);
        git(repository_arg, &["config", "user.name", "Sail Test"]);
        git(
            repository_arg,
            &["config", "user.email", "sail@example.test"],
        );
        fs::write(repository.join("tracked"), "fixture").unwrap();
        git(repository_arg, &["add", "tracked"]);
        git(repository_arg, &["commit", "--quiet", "-m", "fixture"]);
        git(
            repository_arg,
            &["worktree", "add", "--quiet", "--detach", outer_arg, "HEAD"],
        );
        git(
            repository_arg,
            &[
                "worktree",
                "add",
                "--quiet",
                "--detach",
                outside_arg,
                "HEAD",
            ],
        );
        let (outer_data, outer_lease) = worktree_storage::register(&cache, &outer).unwrap();
        outer_lease.release_clean().unwrap();
        let (outside_data, outside_lease) = worktree_storage::register(&cache, &outside).unwrap();
        outside_lease.release_clean().unwrap();
        fs::write(outside_data.join("cache"), "unrelated cache").unwrap();
        let manifest = outer_data.join("nw-invalid.manifest");
        fs::write(
            &manifest,
            format!(
                "{NESTED_WORKTREE_MANIFEST_HEADER}\n{}\n",
                encode_manifest_path(&outside_data)
            ),
        )
        .unwrap();

        let error = persist_worktree_data_manifest(&cache, &outer_data, &outer, &[])
            .expect_err("outside roots must be rejected");
        assert!(error.contains("does not match the selected worktree"));
        assert!(outside_data.join("cache").exists());
        assert!(outer_data.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn unverifiable_legacy_nested_terminal_owners_are_retained_and_reported() {
        let root = std::env::temp_dir().join(format!(
            "sail-nested-terminal-owner-corruption-{}",
            uuid::Uuid::new_v4()
        ));
        let cache = root.join("cache");
        let outer = root.join("worktrees/outer");
        let nested = outer.join("nested-inactive");
        let active_nested = outer.join("nested-active");
        let unrelated = root.join("worktrees/unrelated");
        fs::create_dir_all(&nested).unwrap();
        fs::create_dir_all(&active_nested).unwrap();
        fs::create_dir_all(&unrelated).unwrap();
        let nested_data = register_worktree_terminal_data(&cache, &nested).unwrap();
        fs::write(nested_data.join("cache"), "inactive nested cache").unwrap();

        let active_data = crate::acp_terminal::worktree_data_directory(&cache, &active_nested);
        fs::create_dir_all(&active_data).unwrap();
        fs::write(active_data.join("cache"), "active nested cache").unwrap();
        fs::write(
            active_data.join(WORKTREE_DATA_OWNER_FILE),
            "corrupted owner metadata",
        )
        .unwrap();
        let unrelated_data = crate::acp_terminal::worktree_data_directory(&cache, &unrelated);
        fs::create_dir_all(&unrelated_data).unwrap();
        fs::write(unrelated_data.join("cache"), "unrelated cache").unwrap();
        fs::write(
            unrelated_data.join(WORKTREE_DATA_OWNER_FILE),
            "corrupted owner metadata",
        )
        .unwrap();

        let discovered = discover_nested_worktree_terminal_roots(&cache, &outer).unwrap();
        assert_eq!(
            discovered,
            vec![crate::acp_terminal::stable_worktree_identity(&nested)]
        );
        let outer_data = crate::acp_terminal::worktree_data_directory(&cache, &outer);
        let cleanup = persist_worktree_data_manifest(
            &cache,
            &outer_data,
            &outer,
            &[discovered[0].clone(), active_nested.clone()],
        )
        .unwrap();
        remove_worktree_then_terminal_data_many(&cleanup, || Ok(()))
            .expect("unknown legacy metadata must not be deleted");
        assert!(nested_data.join("cache").exists());
        assert!(active_data.join("cache").exists());
        assert!(unrelated_data.join("cache").exists());
        assert!(!worktree_storage::cleanup_status(&cache).is_empty());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn terminal_data_is_cleaned_when_worktree_is_already_missing() {
        let root = std::env::temp_dir().join(format!(
            "sail-terminal-missing-worktree-test-{}",
            uuid::Uuid::new_v4()
        ));
        let repository = root.join("repository");
        let worktree = root.join("worktrees/missing");
        let managed = root.join("managed");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(worktree.parent().unwrap()).unwrap();
        fs::create_dir_all(&managed).unwrap();
        fs::write(managed.join("cache"), "stale terminal data").unwrap();
        git(repository.to_str().unwrap(), &["init", "-q"]);

        let archived = remove_worktree_then_terminal_data(&managed, || {
            archive_ignored_and_remove(
                repository.to_string_lossy().into_owned(),
                worktree.to_string_lossy().into_owned(),
                None,
                None,
            )
        })
        .expect("an already-removed worktree should finish terminal cleanup");

        assert_eq!(archived, None);
        assert!(!managed.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn archived_removal_keeps_terminal_data_when_missing_worktree_is_still_registered() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-archive-registered-missing-test");
        let managed = root.join("managed-terminal-data");
        fs::create_dir_all(&managed).unwrap();
        fs::write(
            managed.join("cache"),
            "retain while Git still registers worktree",
        )
        .unwrap();
        fs::remove_dir_all(&worktree).unwrap();

        let error = remove_worktree_then_terminal_data(&managed, || {
            archive_ignored_and_remove(repository.clone(), worktree.clone(), Some(expected), None)
        })
        .unwrap_err();

        assert!(error.contains("still registered"), "{error}");
        assert_eq!(
            fs::read_to_string(managed.join("cache")).unwrap(),
            "retain while Git still registers worktree"
        );
        let listed = git_reference(
            Path::new(&repository),
            &["worktree", "list", "--porcelain", "-z"],
        )
        .expect("list registered worktrees");
        let registered = parse_registered_worktrees(&listed);
        assert!(
            registered
                .iter()
                .any(|entry| entry.branch.as_deref() == Some("child") && !entry.present),
            "Git must still list the missing child worktree"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_registered_worktree_dotdot_alias_keeps_terminal_data() {
        let (root, repository, worktree, expected) =
            ignored_archive_fixture("sail-archive-registered-dotdot-test");
        let managed = root.join("managed-terminal-data");
        fs::create_dir_all(&managed).unwrap();
        fs::write(
            managed.join("cache"),
            "retain while Git still registers worktree",
        )
        .unwrap();
        fs::remove_dir_all(&worktree).unwrap();
        let worktree_path = Path::new(&worktree);
        let parent = worktree_path.parent().unwrap();
        let alias = parent
            .join("..")
            .join(parent.file_name().unwrap())
            .join(worktree_path.file_name().unwrap());

        let error = remove_worktree_then_terminal_data(&managed, || {
            archive_ignored_and_remove(
                repository.clone(),
                alias.to_string_lossy().into_owned(),
                Some(expected),
                None,
            )
        })
        .unwrap_err();

        assert!(error.contains("still registered"), "{error}");
        assert_eq!(
            fs::read_to_string(managed.join("cache")).unwrap(),
            "retain while Git still registers worktree"
        );
        fs::remove_dir_all(root).unwrap();
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
        let child = root.join("sail/worktrees/repository/legacy");
        let hidden = root.join(".sail/worktrees/repository/new");
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

        git(
            repository_path,
            &["worktree", "add", "-qb", "hidden", hidden.to_str().unwrap()],
        );

        let alias = child.join(".").to_string_lossy().into_owned();
        let matched =
            registered_worktrees_sync(repository_path.into(), vec![alias.clone()]).unwrap();
        assert_eq!(matched.len(), 1);
        assert_eq!(matched[0].path, alias);
        assert_eq!(matched[0].branch.as_deref(), Some("child"));
        let discovered = repository_worktrees_inner(repository_path.into()).unwrap();
        let canonical_child = child.git_canonical().unwrap();
        assert!(discovered
            .iter()
            .any(|entry| entry.path == canonical_child.to_string_lossy()
                && entry.generation.is_some()));

        let canonical_hidden = hidden.git_canonical().unwrap();
        assert!(discovered
            .iter()
            .any(|entry| entry.path == canonical_hidden.to_string_lossy()
                && entry.generation.is_some()));
        let targets = super::worktree_removal_targets(
            repository_path.into(),
            vec![
                child.to_string_lossy().into_owned(),
                hidden.to_string_lossy().into_owned(),
            ],
        )
        .unwrap();
        assert_eq!(targets.len(), 2);
        assert!(targets
            .iter()
            .any(|target| target.canonical == canonical_child));
        assert!(targets
            .iter()
            .any(|target| target.canonical == canonical_hidden));

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
    fn worktree_removal_retry_recovers_after_git_already_removed_it() {
        let root = std::env::temp_dir().join(format!("sail-delete-retry-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repository");
        let parent = root.join("worktrees");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&parent).unwrap();
        let repository = repository.git_canonical().unwrap();
        let repository_path = repository.to_str().unwrap();
        git(repository_path, &["init", "-q"]);
        fs::write(repository.join("seed"), "seed").unwrap();
        git(repository_path, &["add", "seed"]);
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
        remove_worktree(
            repository_path.into(),
            created.path.clone(),
            Some(true),
            None,
            None,
        )
        .unwrap();
        assert!(!Path::new(&created.path).exists());
        remove_worktree(repository_path.into(), created.path, Some(true), None, None)
            .expect("retry after successful Git removal should be idempotent");
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

    #[test]
    fn guarded_removal_rejects_branch_attached_after_detached_preview() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-delete-detached-branch-switch");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        git(&worktree, &["checkout", "--detach", "-q"]);
        let revision =
            tauri::async_runtime::block_on(working_tree_revision(worktree.clone())).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        git(&worktree, &["switch", "-q", "child"]);

        assert_eq!(
            tauri::async_runtime::block_on(working_tree_revision(worktree.clone())).unwrap(),
            revision
        );
        let error = remove_worktree_guarded(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            None,
            Some(&generation),
        )
        .unwrap_err();
        assert!(
            error.contains("attached to a branch after preview"),
            "{error}"
        );
        assert!(Path::new(&worktree).exists());

        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn force_removal_deletes_a_locked_worktree_and_preserves_its_branch() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-delete-locked-test");
        git(&repository, &["worktree", "lock", &worktree]);
        let head = git_reference(Path::new(&worktree), &["rev-parse", "HEAD"]).unwrap();
        remove_worktree(repository.clone(), worktree.clone(), Some(true), None, None).unwrap();
        assert!(!Path::new(&worktree).exists());
        assert_eq!(
            git_reference(Path::new(&repository), &["rev-parse", "child"]),
            Some(head)
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn deletion_succeeds_when_private_cache_cleanup_is_pending_and_can_resume() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-delete-cache-test");
        let cache = root.join("cache");
        let (data, lease) = worktree_storage::register(&cache, Path::new(&worktree)).unwrap();
        remove_worktree_then_private_data_many(&cache, std::slice::from_ref(&data), false, || {
            remove_worktree(repository.clone(), worktree.clone(), Some(true), None, None)
        })
        .unwrap();
        assert!(!Path::new(&worktree).exists());
        assert!(data.is_dir(), "Data in active use must remain pending");
        assert!(worktree_storage::cleanup_status(&cache)
            .iter()
            .any(|pending| pending.reason == "active-use"));
        lease.release_clean().unwrap();
        remove_worktree_then_private_data_many(
            &cache,
            &[data.clone(), cache.join("already-removed")],
            false,
            || remove_worktree(repository, worktree, Some(true), None, None),
        )
        .unwrap();
        assert!(!data.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_deletion_reports_private_storage_reacquired_after_unused_check() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-selected-delete-cache-test");
        let cache = root.join("cache");
        let (data, lease) = worktree_storage::register(&cache, Path::new(&worktree)).unwrap();
        lease.release_clean().unwrap();
        worktree_storage::ensure_ready_before_worktree_removal(&cache, std::slice::from_ref(&data))
            .unwrap();
        let (registered, rival_lease) =
            worktree_storage::register(&cache, Path::new(&worktree)).unwrap();
        assert_eq!(registered, data);
        let error = remove_worktree_then_private_data_many(
            &cache,
            std::slice::from_ref(&data),
            true,
            || remove_worktree(repository.clone(), worktree.clone(), Some(true), None, None),
        )
        .unwrap_err();
        assert!(
            error.contains("another Sail process is still using it"),
            "{error}"
        );
        assert!(
            !Path::new(&worktree).exists(),
            "Git removal already completed"
        );
        assert!(data.is_dir(), "Active private data must remain pending");
        assert!(worktree_storage::cleanup_status(&cache)
            .iter()
            .any(|pending| pending.reason == "active-use"));
        rival_lease.release_clean().unwrap();
        remove_worktree_then_private_data_many(&cache, std::slice::from_ref(&data), true, || {
            Ok::<_, String>(())
        })
        .unwrap();
        assert!(!data.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn force_removal_cleans_only_the_requested_missing_registration() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-delete-missing-test");
        let sibling = root.join("sibling");
        git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "sibling",
                sibling.to_str().unwrap(),
            ],
        );
        fs::remove_dir_all(&worktree).unwrap();
        fs::remove_dir_all(&sibling).unwrap();
        remove_worktree(repository.clone(), worktree.clone(), Some(true), None, None).unwrap();
        remove_worktree(repository.clone(), worktree.clone(), Some(true), None, None).unwrap();
        let listed = git_reference(
            Path::new(&repository),
            &["worktree", "list", "--porcelain", "-z"],
        )
        .unwrap();
        let registered = parse_registered_worktrees(&listed);
        assert!(!registered
            .iter()
            .any(|entry| entry.branch.as_deref() == Some("child")));
        assert!(registered
            .iter()
            .any(|entry| entry.branch.as_deref() == Some("sibling")));
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn force_removal_retries_files_after_git_unregisters_the_worktree() {
        use std::os::unix::fs::PermissionsExt;
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-delete-partial-test");
        let protected = Path::new(&worktree).join("protected");
        fs::create_dir(&protected).unwrap();
        fs::write(protected.join("file"), "transient obstruction").unwrap();
        fs::set_permissions(&protected, fs::Permissions::from_mode(0o555)).unwrap();
        remove_worktree(repository.clone(), worktree.clone(), Some(true), None, None).unwrap();
        assert!(!Path::new(&worktree).exists());
        assert!(git_reference(Path::new(&repository), &["rev-parse", "child"]).is_some());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn remaining_file_cleanup_preserves_a_recreated_directory() {
        let root =
            std::env::temp_dir().join(format!("sail-delete-replaced-{}", uuid::Uuid::new_v4()));
        let worktree = root.join("worktree");
        let original_path = root.join("original");
        fs::create_dir_all(&worktree).unwrap();
        fs::write(worktree.join("original.txt"), "original").unwrap();
        let original = super::worktree_directory_identity(&worktree).unwrap();
        fs::rename(&worktree, &original_path).unwrap();
        fs::create_dir(&worktree).unwrap();
        fs::write(worktree.join("replacement.txt"), "retain replacement").unwrap();
        let error = remove_remaining_worktree_files(&worktree, &original).unwrap_err();
        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            fs::read_to_string(worktree.join("replacement.txt")).unwrap(),
            "retain replacement"
        );
        assert_eq!(
            fs::read_to_string(original_path.join("original.txt")).unwrap(),
            "original"
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn remaining_file_cleanup_clears_readonly_without_changing_other_windows_attributes() {
        use std::os::windows::ffi::OsStrExt;
        use std::os::windows::fs::MetadataExt;
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileAttributesW, FILE_ATTRIBUTE_HIDDEN, FILE_ATTRIBUTE_READONLY,
        };
        let root =
            std::env::temp_dir().join(format!("sail-delete-readonly-{}", uuid::Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let file = root.join("file.txt");
        fs::write(&file, "read-only content").unwrap();
        let attributes = fs::metadata(&file).unwrap().file_attributes()
            | FILE_ATTRIBUTE_READONLY
            | FILE_ATTRIBUTE_HIDDEN;
        let wide = super::extended_windows_path(&file)
            .as_os_str()
            .encode_wide()
            .chain(std::iter::once(0))
            .collect::<Vec<_>>();
        assert_ne!(unsafe { SetFileAttributesW(wide.as_ptr(), attributes) }, 0);
        assert!(fs::metadata(&file).unwrap().permissions().readonly());

        super::make_worktree_files_removable(&root).unwrap();

        assert!(!fs::metadata(&file).unwrap().permissions().readonly());
        assert_ne!(
            fs::metadata(&file).unwrap().file_attributes() & FILE_ATTRIBUTE_HIDDEN,
            0
        );
        assert_eq!(fs::read_to_string(&file).unwrap(), "read-only content");
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(windows)]
    #[test]
    fn remaining_file_cleanup_preserves_replacement_with_the_same_windows_creation_time() {
        use std::os::windows::fs::{MetadataExt, OpenOptionsExt};
        use std::os::windows::io::AsRawHandle;
        use windows_sys::Win32::Foundation::FILETIME;
        use windows_sys::Win32::Storage::FileSystem::{
            SetFileTime, FILE_FLAG_BACKUP_SEMANTICS, FILE_WRITE_ATTRIBUTES,
        };
        let root =
            std::env::temp_dir().join(format!("sail-delete-tunneling-{}", uuid::Uuid::new_v4()));
        let worktree = root.join("worktree");
        let saved = root.join("original");
        fs::create_dir_all(&worktree).unwrap();
        let creation_time = fs::metadata(&worktree).unwrap().creation_time();
        let original = super::worktree_directory_identity(&worktree).unwrap();
        fs::rename(&worktree, &saved).unwrap();
        fs::create_dir(&worktree).unwrap();
        fs::write(worktree.join("replacement.txt"), "preserve replacement").unwrap();
        let handle = fs::OpenOptions::new()
            .access_mode(FILE_WRITE_ATTRIBUTES)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS)
            .open(&worktree)
            .unwrap();
        let creation = FILETIME {
            dwLowDateTime: creation_time as u32,
            dwHighDateTime: (creation_time >> 32) as u32,
        };
        assert_ne!(
            unsafe {
                SetFileTime(
                    handle.as_raw_handle(),
                    &creation,
                    std::ptr::null(),
                    std::ptr::null(),
                )
            },
            0
        );
        drop(handle);
        assert_eq!(
            fs::metadata(&worktree).unwrap().creation_time(),
            creation_time
        );

        let error = remove_remaining_worktree_files(&worktree, &original).unwrap_err();

        assert!(error.contains("identity changed"), "{error}");
        assert_eq!(
            fs::read_to_string(worktree.join("replacement.txt")).unwrap(),
            "preserve replacement"
        );
        assert!(saved.is_dir());
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
    fn removal_rejects_a_replaced_worktree_generation() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-removal-generation");
        let original = worktree_storage::generation(Path::new(&worktree)).unwrap();
        assert!(ensure_expected_worktree_generation(Path::new(&worktree), Some(&original)).is_ok());
        git(&repository, &["worktree", "remove", "--force", &worktree]);
        git(
            &repository,
            &["worktree", "add", "-b", "replacement", &worktree, "HEAD"],
        );
        let replacement = worktree_storage::generation(Path::new(&worktree)).unwrap();
        assert_ne!(original, replacement);
        assert!(
            ensure_expected_worktree_generation(Path::new(&worktree), Some(&original))
                .unwrap_err()
                .contains("identity changed after preview")
        );
        assert!(
            ensure_expected_worktree_generation(Path::new(&worktree), Some(&replacement)).is_ok()
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_keeps_an_external_replacement_with_the_same_branch_and_commit() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-late-replacement");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let original = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&original),
            (
                || {
                    git(&repository, &["worktree", "remove", "--force", &worktree]);
                    git(&repository, &["worktree", "add", "-q", &worktree, "child"]);
                    fs::write(Path::new(&worktree).join("replacement.tmp"), "preserve").unwrap();
                    Ok(())
                },
                || Ok(()),
                || Ok(()),
                |_| Ok(()),
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(error.contains("identity changed after preview"), "{error}");
        assert_ne!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            original
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("replacement.tmp")).unwrap(),
            "preserve"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_holds_a_git_lock_through_final_check() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-registration-lock");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || {
                    let attempted = Command::new("git")
                        .arg("-C")
                        .arg(&repository)
                        .args(["worktree", "remove", "--force", &worktree])
                        .output()
                        .unwrap();
                    assert!(!attempted.status.success());
                    assert!(String::from_utf8_lossy(&attempted.stderr).contains("locked"));
                    Ok(())
                },
                || Ok(()),
                |_| Ok(()),
                || Ok(()),
            ),
        )
        .unwrap();

        assert!(!Path::new(&worktree).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_keeps_a_dirty_descendant_changed_in_the_final_window() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-final-dirty-change");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || {
                    fs::write(Path::new(&worktree).join("tracked.txt"), "new edits\n").unwrap();
                    Ok(())
                },
                || Ok(()),
                |_| Ok(()),
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(error.contains("changed after validation"), "{error}");
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("tracked.txt")).unwrap(),
            "new edits\n"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_signals_git_success_before_later_cleanup_error() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-post-git-error");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        let signalled = std::cell::Cell::new(false);

        let error = super::remove_worktree_guarded_with_hook(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            || {
                signalled.set(true);
                Err("post-Git cleanup failed".into())
            },
        )
        .unwrap_err();

        assert!(signalled.get());
        assert!(error.contains("post-Git cleanup failed"));
        assert!(!Path::new(&worktree).exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_preserves_a_file_written_after_the_final_guard() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-post-guard-write");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        let late_file = Path::new(&worktree).join("late.txt");

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || Ok(()),
                |staged| {
                    fs::write(staged.join("late.txt"), "must survive").unwrap();
                    Ok(())
                },
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(
            error.contains("modified, untracked or ignored files"),
            "{error}"
        );
        assert_eq!(fs::read_to_string(&late_file).unwrap(), "must survive");
        assert_eq!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            generation
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_preserves_hidden_tracked_edit_before_preview() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-hidden-tracked-edit");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let tracked = Path::new(&worktree).join("tracked.txt");
        fs::OpenOptions::new()
            .write(true)
            .open(&tracked)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000))
            .unwrap();
        git(&worktree, &["update-index", "--refresh"]);
        git(&worktree, &["config", "core.trustctime", "false"]);
        git(&worktree, &["config", "core.checkStat", "minimal"]);
        let modified = fs::metadata(&tracked).unwrap().modified().unwrap();
        fs::write(&tracked, "change\n").unwrap();
        fs::OpenOptions::new()
            .write(true)
            .open(&tracked)
            .unwrap()
            .set_modified(modified)
            .unwrap();
        let status = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["status", "--porcelain=v1"])
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(status.stdout.is_empty());

        let (_, dirty) = worktree_preview_state_with_hook(Path::new(&worktree), || {}).unwrap();
        assert!(dirty);
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        let error = remove_worktree_guarded(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
        )
        .unwrap_err();
        assert!(error.contains("modified or untracked files"), "{error}");
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "change\n");
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_preserves_bytes_hidden_by_lossy_clean_filter() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-lossy-filter");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        git(
            &repository,
            &[
                "config",
                "filter.generated.clean",
                "git cat-file blob HEAD:tracked.txt",
            ],
        );
        fs::write(
            Path::new(&repository).join(".git/info/attributes"),
            "tracked.txt filter=generated\n",
        )
        .unwrap();
        let tracked = Path::new(&worktree).join("tracked.txt");
        fs::write(&tracked, "private edits\n").unwrap();
        git(
            &worktree,
            &["update-index", "--assume-unchanged", "tracked.txt"],
        );
        let status = Command::new("git")
            .arg("-C")
            .arg(&worktree)
            .args(["status", "--porcelain=v1"])
            .output()
            .unwrap();
        assert!(status.status.success());
        assert!(status.stdout.is_empty());

        let (_, dirty) = worktree_preview_state_with_hook(Path::new(&worktree), || {}).unwrap();
        assert!(dirty);
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        let error = remove_worktree_guarded(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
        )
        .unwrap_err();
        assert!(error.contains("modified or untracked files"), "{error}");
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "private edits\n");
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn tracked_content_check_rejects_symlink_replaced_by_equal_bytes() {
        use std::os::unix::fs::symlink;

        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-removal-tracked-link-type");
        let link = Path::new(&worktree).join("link");
        symlink("tracked.txt", &link).unwrap();
        git(&worktree, &["add", "link"]);
        git(&worktree, &["update-index", "--assume-unchanged", "link"]);
        assert!(super::tracked_worktree_matches_head(Path::new(&worktree)).unwrap());

        fs::remove_file(&link).unwrap();
        fs::write(&link, "tracked.txt").unwrap();
        assert!(!super::tracked_worktree_matches_head(Path::new(&worktree)).unwrap());
        assert_eq!(fs::read_to_string(&link).unwrap(), "tracked.txt");
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn guarded_removal_preserves_hidden_executable_mode_change() {
        use std::os::unix::fs::PermissionsExt;

        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-tracked-mode");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let tracked = Path::new(&worktree).join("tracked.txt");
        let mut permissions = fs::metadata(&tracked).unwrap().permissions();
        permissions.set_mode(permissions.mode() | 0o111);
        fs::set_permissions(&tracked, permissions).unwrap();
        git(
            &worktree,
            &["update-index", "--assume-unchanged", "tracked.txt"],
        );
        assert!(!super::tracked_worktree_matches_head(Path::new(&worktree)).unwrap());
        let (_, dirty) = worktree_preview_state_with_hook(Path::new(&worktree), || {}).unwrap();
        assert!(dirty);
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        let error = remove_worktree_guarded(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
        )
        .unwrap_err();
        assert!(error.contains("modified or untracked files"), "{error}");
        assert_eq!(fs::read_to_string(&tracked).unwrap(), "before\n");
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_preserves_filtered_bytes_written_after_staging() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-staged-lossy-filter");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || Ok(()),
                |staged| {
                    git(
                        &repository,
                        &[
                            "config",
                            "filter.generated.clean",
                            "git cat-file blob HEAD:tracked.txt",
                        ],
                    );
                    fs::write(
                        Path::new(&repository).join(".git/info/attributes"),
                        "tracked.txt filter=generated\n",
                    )
                    .unwrap();
                    fs::write(staged.join("tracked.txt"), "late private edits\n").unwrap();
                    git(
                        &staged.to_string_lossy(),
                        &["update-index", "--assume-unchanged", "tracked.txt"],
                    );
                    Ok(())
                },
                || Ok(()),
            ),
        )
        .unwrap_err();
        assert!(
            error.contains("modified, untracked or ignored files"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("tracked.txt")).unwrap(),
            "late private edits\n"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn tracked_content_check_accepts_clean_crlf_checkout() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-removal-clean-crlf");
        fs::write(
            Path::new(&repository).join(".git/info/attributes"),
            "tracked.txt text eol=crlf\n",
        )
        .unwrap();
        fs::write(Path::new(&worktree).join("tracked.txt"), b"before\r\n").unwrap();
        assert_eq!(
            fs::read(Path::new(&worktree).join("tracked.txt")).unwrap(),
            b"before\r\n"
        );
        assert!(super::tracked_worktree_matches_head(Path::new(&worktree)).unwrap());
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn clean_sparse_worktree_content_is_verified() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-removal-sparse-clean");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let outside = Path::new(&worktree).join("outside/tracked.txt");
        fs::create_dir_all(outside.parent().unwrap()).unwrap();
        fs::write(&outside, "outside\n").unwrap();
        git(&worktree, &["add", "outside/tracked.txt"]);
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
                "outside file",
            ],
        );
        git(&worktree, &["sparse-checkout", "init", "--cone"]);
        git(&worktree, &["sparse-checkout", "set", "another-directory"]);
        assert!(!outside.exists());
        assert!(super::tracked_worktree_matches_head(Path::new(&worktree)).unwrap());
        let (_, dirty) = worktree_preview_state_with_hook(Path::new(&worktree), || {}).unwrap();
        assert!(!dirty);
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_preserves_hidden_tracked_edit_after_staging() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-staged-hidden-edit");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let tracked = Path::new(&worktree).join("tracked.txt");
        fs::OpenOptions::new()
            .write(true)
            .open(&tracked)
            .unwrap()
            .set_modified(std::time::UNIX_EPOCH + std::time::Duration::from_secs(1_600_000_000))
            .unwrap();
        git(&worktree, &["update-index", "--refresh"]);
        git(&worktree, &["config", "core.trustctime", "false"]);
        git(&worktree, &["config", "core.checkStat", "minimal"]);
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || Ok(()),
                |staged| {
                    let tracked = staged.join("tracked.txt");
                    let modified = fs::metadata(&tracked).unwrap().modified().unwrap();
                    fs::write(&tracked, "change\n").unwrap();
                    fs::OpenOptions::new()
                        .write(true)
                        .open(&tracked)
                        .unwrap()
                        .set_modified(modified)
                        .unwrap();
                    let status = Command::new("git")
                        .arg("-C")
                        .arg(staged)
                        .args(["status", "--porcelain=v1"])
                        .output()
                        .unwrap();
                    assert!(status.status.success());
                    assert!(status.stdout.is_empty());
                    Ok(())
                },
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(
            error.contains("modified, untracked or ignored files"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("tracked.txt")).unwrap(),
            "change\n"
        );
        assert_eq!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            generation
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_preserves_ignored_file_written_before_git_remove() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-late-ignored");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || Ok(()),
                |staged| {
                    fs::write(staged.join("late.tmp"), "must survive").unwrap();
                    Ok(())
                },
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(
            error.contains("modified, untracked or ignored files"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("late.tmp")).unwrap(),
            "must survive"
        );
        assert_eq!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            generation
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_nonforce_removal_requires_a_revision_bound_cleanup_preview() {
        let (root, repository, worktree, _) = ignored_archive_fixture("sail-removal-nonforce-late");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            None,
            None,
            None,
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || Ok(()),
                |_| panic!("unconfirmed cleanup must not reach Git removal"),
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(
            error.contains("pending a revision-bound cleanup preview"),
            "{error}"
        );
        assert!(Path::new(&worktree).is_dir());
        assert_eq!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            generation
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_nonforce_removal_preserves_a_clean_worktree_pending_confirmation() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-removal-nonforce-clean");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_guarded(
            repository.clone(),
            worktree.clone(),
            None,
            None,
            None,
            Some(&generation),
        )
        .unwrap_err();

        assert!(
            error.contains("pending a revision-bound cleanup preview"),
            "{error}"
        );
        assert!(Path::new(&worktree).exists());
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_preserves_an_external_replacement_after_unlock() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-after-unlock-replacement");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || {
                    git(
                        &repository,
                        &[
                            "worktree",
                            "add",
                            "-q",
                            "-b",
                            "replacement",
                            &worktree,
                            "HEAD",
                        ],
                    );
                    Ok(())
                },
                |_| Ok(()),
                || Ok(()),
            ),
        )
        .unwrap();

        assert_ne!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            generation
        );
        assert_eq!(
            git_reference(Path::new(&worktree), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("replacement")
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_reports_a_preserved_stage_when_rollback_path_is_occupied() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-occupied-rollback");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        let mut staged_path = None;

        let error = remove_worktree_with_hooks(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || {
                    git(
                        &repository,
                        &[
                            "worktree",
                            "add",
                            "-q",
                            "-b",
                            "replacement",
                            &worktree,
                            "HEAD",
                        ],
                    );
                    Ok(())
                },
                |staged| {
                    staged_path = Some(staged.to_path_buf());
                    fs::write(staged.join("late.txt"), "keep staged content").unwrap();
                    Ok(())
                },
                || Ok(()),
            ),
        )
        .unwrap_err();

        let staged = staged_path.unwrap();
        let pending: serde_json::Value = serde_json::from_str(
            error
                .strip_prefix("SAIL_PENDING_RECOVERY:")
                .expect("recovery must be a structured pending result"),
        )
        .unwrap();
        assert_eq!(pending["originalPath"], worktree);
        assert_eq!(pending["recoveryPath"], staged.to_string_lossy().as_ref());
        assert!(pending["sizeBytes"].as_u64().unwrap() > 0);
        assert_eq!(worktree_storage::generation(&staged).unwrap(), generation);
        let registered = git_reference(
            Path::new(&repository),
            &["worktree", "list", "--porcelain", "-z"],
        )
        .unwrap();
        let staged_canonical = staged.git_canonical().unwrap();
        assert!(parse_registered_worktrees(&registered).iter().any(|entry| {
            Path::new(&entry.path).git_canonical().ok().as_ref() == Some(&staged_canonical)
        }));
        assert_eq!(
            fs::read_to_string(staged.join("late.txt")).unwrap(),
            "keep staged content"
        );
        assert_eq!(
            git_reference(Path::new(&worktree), &["symbolic-ref", "--short", "HEAD"]).as_deref(),
            Some("replacement")
        );
        remove_worktree(repository.clone(), worktree, Some(true), None, None).unwrap();
        remove_worktree(
            repository,
            staged.to_string_lossy().into_owned(),
            Some(true),
            None,
            None,
        )
        .unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pending_recovery_never_overwrites_a_replacement_and_restores_when_path_is_free() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-pending-recovery-restore");
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();
        let recovery = root.join("pending-recovery");
        move_worktree_for_removal(Path::new(&repository), Path::new(&worktree), &recovery).unwrap();
        git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "replacement",
                &worktree,
                "HEAD",
            ],
        );
        let replacement_generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = restore_pending_worktree_inner(
            Path::new(&repository),
            &recovery,
            Path::new(&worktree),
            &generation,
        )
        .unwrap_err();
        assert!(error.contains("occupied"), "{error}");
        assert_eq!(worktree_storage::generation(&recovery).unwrap(), generation);
        assert_eq!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            replacement_generation
        );
        assert_eq!(fs::read_to_string(recovery.join("one.tmp")).unwrap(), "one");

        remove_worktree(repository.clone(), worktree.clone(), Some(true), None, None).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(root.join("missing-target"), &worktree).unwrap();
            let error = restore_pending_worktree_inner(
                Path::new(&repository),
                &recovery,
                Path::new(&worktree),
                &generation,
            )
            .unwrap_err();
            assert!(error.contains("occupied"), "{error}");
            assert!(Path::new(&worktree).symlink_metadata().is_ok());
            fs::remove_file(&worktree).unwrap();
        }
        restore_pending_worktree_inner(
            Path::new(&repository),
            &recovery,
            Path::new(&worktree),
            &generation,
        )
        .unwrap();
        assert!(!recovery.exists());
        assert_eq!(
            worktree_storage::generation(Path::new(&worktree)).unwrap(),
            generation
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("one.tmp")).unwrap(),
            "one"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_stages_outside_a_registered_ancestor() {
        let (root, repository, parent, _) = ignored_archive_fixture("sail-removal-nested-stage");
        let child = Path::new(&parent).join("nested").join("grandchild");
        fs::create_dir_all(child.parent().unwrap()).unwrap();
        git(
            &repository,
            &[
                "worktree",
                "add",
                "-q",
                "-b",
                "grandchild",
                child.to_str().unwrap(),
            ],
        );
        let revision = super::git_directory_revision(&child).unwrap();
        let generation = worktree_storage::generation(&child).unwrap();
        let child_path = child.to_string_lossy().into_owned();

        remove_worktree_with_hooks(
            repository.clone(),
            child_path.clone(),
            Some(true),
            Some(&revision),
            Some("grandchild"),
            Some(&generation),
            (
                || Ok(()),
                || Ok(()),
                || Ok(()),
                |staged| {
                    assert!(!staged.starts_with(Path::new(&parent)));
                    Ok(())
                },
                || Ok(()),
            ),
        )
        .unwrap();

        assert!(!child.exists());
        assert!(Path::new(&parent).exists());
        remove_worktree(repository, parent, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_removal_keeps_previewed_ignored_files_for_retry() {
        let (root, repository, worktree, revision) =
            ignored_archive_fixture("sail-removal-previewed-ignored");
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_guarded(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            Some("child"),
            Some(&generation),
        )
        .unwrap_err();

        assert!(error.contains("ignored files"), "{error}");
        assert!(Path::new(&worktree).join("one.tmp").exists());
        assert!(Path::new(&worktree).join("two.tmp").exists());
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_nonforce_removal_preserves_modified_files() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-removal-locked-nonforce");
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        fs::write(Path::new(&worktree).join("tracked.txt"), "modified\n").unwrap();
        let generation = worktree_storage::generation(Path::new(&worktree)).unwrap();

        let error = remove_worktree_guarded(
            repository.clone(),
            worktree.clone(),
            None,
            None,
            None,
            Some(&generation),
        )
        .unwrap_err();

        assert!(
            error.contains("pending a revision-bound cleanup preview"),
            "{error}"
        );
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("tracked.txt")).unwrap(),
            "modified\n"
        );
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn replacement_worktree_uses_the_saved_commit_and_recovers_after_a_retry() {
        let root = std::env::temp_dir().join(format!("sail-replacement-{}", uuid::Uuid::new_v4()));
        let repository = root.join("repository");
        let parent = root.join("worktrees");
        fs::create_dir_all(&repository).unwrap();
        fs::create_dir_all(&parent).unwrap();
        let repository = repository.git_canonical().unwrap();
        let repo = repository.to_string_lossy().into_owned();
        git(&repo, &["init", "-q"]);
        fs::write(repository.join("saved.txt"), "checkpoint").unwrap();
        git(&repo, &["add", "saved.txt"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "checkpoint",
            ],
        );
        let checkpoint = git_reference(&repository, &["rev-parse", "HEAD"]).unwrap();
        fs::write(repository.join("later.txt"), "later").unwrap();
        git(&repo, &["add", "later.txt"]);
        git(
            &repo,
            &[
                "-c",
                "user.name=Sail Test",
                "-c",
                "user.email=sail@example.test",
                "-c",
                "commit.gpgsign=false",
                "commit",
                "-qm",
                "later",
            ],
        );
        let destination = Some(parent.to_string_lossy().into_owned());
        let created = replacement_worktree_at_checkpoint(
            &repository,
            15,
            9,
            &checkpoint,
            destination.clone(),
        )
        .unwrap();
        assert_eq!(created.branch, "ship-issue-15-replacement-9");
        assert_eq!(
            git_reference(Path::new(&created.path), &["rev-parse", "HEAD"]),
            Some(checkpoint.clone())
        );
        assert!(!Path::new(&created.path).join("later.txt").exists());
        let retried = replacement_worktree_at_checkpoint(
            &repository,
            15,
            9,
            &checkpoint,
            destination.clone(),
        )
        .unwrap();
        assert_eq!(retried.path, created.path);
        assert!(replacement_worktree_at_checkpoint(
            &repository,
            15,
            10,
            "not-a-revision",
            destination,
        )
        .is_err());
        git(&repo, &["worktree", "remove", &created.path]);
        let restored = replacement_worktree_at_checkpoint(
            &repository,
            15,
            9,
            &checkpoint,
            Some(parent.to_string_lossy().into_owned()),
        )
        .unwrap();
        assert_eq!(restored.branch, created.branch);
        assert_eq!(
            git_reference(Path::new(&restored.path), &["rev-parse", "HEAD"]),
            Some(checkpoint.clone())
        );
        git(&repo, &["worktree", "remove", &restored.path]);
        git(&repo, &["branch", "-f", &created.branch, "HEAD"]);
        let error = replacement_worktree_at_checkpoint(
            &repository,
            15,
            9,
            &checkpoint,
            Some(parent.to_string_lossy().into_owned()),
        )
        .err()
        .unwrap();
        assert!(error.contains("already exists at another revision"));
        assert!(!Path::new(&created.path).exists());
        fs::remove_dir_all(root).unwrap();
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
    fn removal_race_keeps_checkout_when_branch_moves_before_git_remove() {
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
            None,
            (
                || Ok(()),
                || {
                    git(&repository, &["update-ref", "refs/heads/child", "HEAD"]);
                    Ok(())
                },
                || Ok(()),
                |_| Ok(()),
                || Ok(()),
            ),
        )
        .unwrap_err();

        assert!(error.contains("changed after validation"), "{error}");
        assert!(Path::new(&worktree).is_dir());
        assert_eq!(
            fs::read_to_string(Path::new(&worktree).join("tracked.txt")).unwrap(),
            "before\n"
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
            None,
            (
                || Ok(()),
                || Ok(()),
                || Ok(()),
                |_| Ok(()),
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
    fn preview_rejects_a_file_created_between_status_and_revision_reads() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-preview-status-race-test");
        let new_file = Path::new(&worktree).join("new.txt");

        let error = worktree_preview_state_with_hook(Path::new(&worktree), || {
            fs::write(&new_file, "keep this file").unwrap();
        })
        .unwrap_err();

        assert!(error.contains("changed during preview"), "{error}");
        assert_eq!(fs::read_to_string(&new_file).unwrap(), "keep this file");
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn preview_marks_ignored_only_checkout_dirty() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-preview-ignored-only-test");

        let (_, dirty) = worktree_preview_state_with_hook(Path::new(&worktree), || {}).unwrap();

        assert!(dirty);
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_ignored_directory_does_not_require_discarding_the_checkout() {
        use std::os::unix::fs::PermissionsExt;

        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-preview-unreadable-ignored-test");
        let unreadable = Path::new(&worktree).join("blocked.tmp");
        fs::create_dir(&unreadable).unwrap();
        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o000)).unwrap();

        let dirty = worktree_summary_dirty(Path::new(&worktree)).unwrap();
        let size = worktree_size_bytes(Path::new(&worktree));

        fs::set_permissions(&unreadable, fs::Permissions::from_mode(0o700)).unwrap();
        assert!(dirty, "the fast summary still reports ignored content");
        assert!(
            size.is_err(),
            "an unreadable directory needs an unknown size"
        );
        assert!(Path::new(&worktree).is_dir());
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_detached_removal_preserves_changes_after_preview() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-detached-preview-race-test");
        git(&worktree, &["checkout", "--detach"]);
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let (revision, dirty) =
            worktree_preview_state_with_hook(Path::new(&worktree), || {}).unwrap();
        assert!(!dirty);
        let new_file = Path::new(&worktree).join("new.txt");
        fs::write(&new_file, "keep this file").unwrap();

        let error = remove_worktree(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            None,
        )
        .unwrap_err();

        assert!(error.contains("changed after validation"), "{error}");
        assert_eq!(fs::read_to_string(&new_file).unwrap(), "keep this file");
        remove_worktree(repository, worktree, Some(true), None, None).unwrap();
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn guarded_detached_removal_preserves_its_commit() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-detached-clean-removal-test");
        git(&worktree, &["checkout", "--detach"]);
        fs::write(
            Path::new(&worktree).join("tracked.txt"),
            "detached commit\n",
        )
        .unwrap();
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
                "detached",
            ],
        );
        fs::remove_file(Path::new(&worktree).join("one.tmp")).unwrap();
        fs::remove_file(Path::new(&worktree).join("two.tmp")).unwrap();
        let head = git_reference(Path::new(&worktree), &["rev-parse", "HEAD"]).unwrap();
        let (revision, dirty) =
            worktree_preview_state_with_hook(Path::new(&worktree), || {}).unwrap();
        assert!(!dirty);

        remove_worktree(
            repository.clone(),
            worktree.clone(),
            Some(true),
            Some(&revision),
            None,
        )
        .unwrap();

        assert!(!Path::new(&worktree).exists());
        assert_eq!(
            git_reference(
                Path::new(&repository),
                &[
                    "for-each-ref",
                    "--format=%(objectname)",
                    "refs/sail/preserved-detached",
                ],
            )
            .as_deref(),
            Some(head.as_str())
        );
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn changed_worktree_inventory_keeps_parent_and_new_child() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-new-descendant-during-removal-test");
        let expected = repository_worktrees_inner(repository.clone())
            .unwrap()
            .into_iter()
            .map(|entry| ExpectedRegisteredWorktree {
                path: entry.path,
                generation: entry.generation,
            })
            .collect::<Vec<_>>();
        let child = add_worktree(
            worktree.clone(),
            "new-descendant".into(),
            Some(root.join("worktrees").to_string_lossy().into_owned()),
            None,
        )
        .unwrap();
        let locks = WorktreeOperationLocks::default();
        let _guard = locks.lock(Path::new(&repository)).unwrap();

        let error = ensure_expected_worktree_inventory(&repository, Some(&expected)).unwrap_err();

        assert!(error.contains("changed after preview"), "{error}");
        assert!(Path::new(&worktree).exists());
        assert!(Path::new(&child.path).exists());
        remove_worktree(repository.clone(), child.path, Some(true), None, None).unwrap();
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
    fn worktree_operation_lock_child() {
        let Ok(repository) = std::env::var("SAIL_WORKTREE_LOCK_PROBE_REPOSITORY") else {
            return;
        };
        let ready = Path::new(&repository).join("child-ready");
        let acquired = Path::new(&repository).join("child-acquired");
        fs::write(ready, "ready").unwrap();
        let _guard = WorktreeOperationLocks::default()
            .lock(Path::new(&repository))
            .unwrap();
        fs::write(acquired, "acquired").unwrap();
    }

    #[test]
    fn worktree_operations_serialize_across_processes() {
        let (root, repository, worktree, _) =
            ignored_archive_fixture("sail-cross-process-worktree-lock-test");
        let guard = WorktreeOperationLocks::default()
            .lock(Path::new(&repository))
            .unwrap();
        let ready = Path::new(&repository).join("child-ready");
        let acquired = Path::new(&repository).join("child-acquired");
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args([
                "--exact",
                "tests::worktree_operation_lock_child",
                "--nocapture",
            ])
            .env("SAIL_WORKTREE_LOCK_PROBE_REPOSITORY", &repository)
            .spawn()
            .unwrap();
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !ready.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(ready.exists(), "child process did not reach the lock");
        std::thread::sleep(std::time::Duration::from_millis(200));
        assert!(!acquired.exists(), "child bypassed the cross-process lock");
        drop(guard);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(5);
        while !acquired.exists() && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(10));
        }
        assert!(acquired.exists(), "child did not acquire the released lock");
        assert!(child.wait().unwrap().success());

        fs::remove_file(ready).unwrap();
        fs::remove_file(acquired).unwrap();
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
    fn default_worktree_location_is_hidden_and_override_is_preserved() {
        let home = std::env::temp_dir().join("sail-home");
        let repository = home.join("repository");
        let namespace = repository_namespace(&repository);
        assert_eq!(
            super::worktree_parent(&repository, None, Some(home.clone().into_os_string())).unwrap(),
            home.join(".sail/worktrees").join(&namespace)
        );
        let custom = home.join("custom");
        assert_eq!(
            super::worktree_parent(&repository, Some(custom.clone().into_os_string()), None)
                .unwrap(),
            custom.join(&namespace)
        );
        assert!(super::worktree_parent(&repository, Some("relative".into()), None).is_err());
        assert!(super::worktree_parent(&repository, None, None).is_err());
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
}
