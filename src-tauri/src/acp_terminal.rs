use base64::Engine;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::collections::{HashMap, HashSet, VecDeque};
use std::io::Read;
#[cfg(unix)]
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, State};

#[cfg(windows)]
use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle};

use crate::browser_agent::CapabilityProfile;

static NEXT_TERMINAL: AtomicU64 = AtomicU64::new(1);

#[derive(Default)]
pub struct AcpTerminalManager {
    active: Mutex<HashMap<String, Arc<AcpTerminal>>>,
    archived: Mutex<VecDeque<(String, TerminalSnapshot)>>,
    worktrees_being_removed: Mutex<HashSet<PathBuf>>,
}

pub fn worktree_data_directory(cache_directory: &Path, worktree: &Path) -> PathBuf {
    let worktree = stable_worktree_identity(worktree);
    #[cfg(unix)]
    let identity = {
        use std::os::unix::ffi::OsStrExt;
        worktree.as_os_str().as_bytes().to_vec()
    };
    #[cfg(windows)]
    let identity = {
        use std::os::windows::ffi::OsStrExt;
        worktree
            .as_os_str()
            .encode_wide()
            .flat_map(u16::to_le_bytes)
            .collect::<Vec<_>>()
    };
    #[cfg(not(any(unix, windows)))]
    let identity = worktree.to_string_lossy().as_bytes().to_vec();
    let digest = Sha256::digest(identity);
    let name = digest
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    cache_directory.join("terminal-worktrees").join(name)
}

fn terminal_worktree_root(directory: &Path) -> PathBuf {
    crate::terminal::git_worktree_root(directory)
}

pub(crate) fn stable_worktree_identity(worktree: &Path) -> PathBuf {
    if let Ok(canonical) = dunce::canonicalize(worktree) {
        return canonical;
    }

    let absolute = if worktree.is_absolute() {
        worktree.to_path_buf()
    } else {
        std::env::current_dir()
            .map(|directory| directory.join(worktree))
            .unwrap_or_else(|_| worktree.to_path_buf())
    };
    let mut ancestor = absolute.as_path();
    let mut missing = Vec::new();
    loop {
        if let Ok(mut canonical) = dunce::canonicalize(ancestor) {
            for component in missing.iter().rev() {
                canonical.push(component);
            }
            return canonical;
        }
        let Some(name) = ancestor.file_name() else {
            return absolute;
        };
        missing.push(name.to_os_string());
        let Some(parent) = ancestor.parent() else {
            return absolute;
        };
        ancestor = parent;
    }
}

pub(crate) fn worktree_contains(root: &Path, candidate: &Path) -> bool {
    let root = stable_worktree_identity(root);
    let candidate = stable_worktree_identity(candidate);
    candidate == root || candidate.starts_with(&root)
}

pub(crate) fn terminal_environment(data_directory: &Path) -> Vec<(&'static str, PathBuf)> {
    let shared_download_cache = data_directory
        .parent()
        .and_then(Path::parent)
        .unwrap_or(data_directory)
        .join("terminal-package-downloads");
    vec![
        ("TMPDIR", data_directory.join("tmp")),
        ("TEMP", data_directory.join("tmp")),
        ("TMP", data_directory.join("tmp")),
        ("XDG_CACHE_HOME", data_directory.join("cache")),
        ("PIP_CACHE_DIR", shared_download_cache.join("pip")),
        ("UV_CACHE_DIR", shared_download_cache.join("uv")),
        ("POETRY_CACHE_DIR", shared_download_cache.join("poetry")),
    ]
}

#[cfg(windows)]
pub(crate) struct WindowsTerminalJob(OwnedHandle);

#[cfg(windows)]
unsafe impl Send for WindowsTerminalJob {}

#[cfg(windows)]
impl WindowsTerminalJob {
    pub(crate) fn new() -> Result<Self, String> {
        use windows::Win32::System::JobObjects::{
            CreateJobObjectW, JobObjectExtendedLimitInformation, SetInformationJobObject,
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
        };

        let handle = unsafe { CreateJobObjectW(None, windows::core::PCWSTR::null()) }
            .map_err(|error| format!("Cannot create terminal process job: {error}"))?;
        let handle = unsafe { OwnedHandle::from_raw_handle(handle.0) };
        let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
        unsafe {
            SetInformationJobObject(
                windows::Win32::Foundation::HANDLE(handle.as_raw_handle() as _),
                JobObjectExtendedLimitInformation,
                (&limits as *const JOBOBJECT_EXTENDED_LIMIT_INFORMATION).cast(),
                std::mem::size_of_val(&limits) as u32,
            )
        }
        .map_err(|error| format!("Cannot configure terminal process job: {error}"))?;
        Ok(Self(handle))
    }

    pub(crate) fn raw_handle(&self) -> std::os::windows::io::RawHandle {
        self.0.as_raw_handle()
    }

    fn assign_and_resume(&self, child: &std::process::Child) -> Result<(), String> {
        use windows::Win32::System::Diagnostics::ToolHelp::{
            CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
        };
        use windows::Win32::System::JobObjects::AssignProcessToJobObject;
        use windows::Win32::System::Threading::{OpenThread, ResumeThread, THREAD_SUSPEND_RESUME};

        unsafe {
            AssignProcessToJobObject(
                windows::Win32::Foundation::HANDLE(self.0.as_raw_handle() as _),
                windows::Win32::Foundation::HANDLE(child.as_raw_handle() as _),
            )
        }
        .map_err(|error| format!("Cannot assign terminal process job: {error}"))?;

        let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
            .map_err(|error| format!("Cannot inspect terminal process threads: {error}"))?;
        let snapshot = unsafe { OwnedHandle::from_raw_handle(snapshot.0) };
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        let mut first = true;
        let thread_id = loop {
            let result = unsafe {
                if first {
                    first = false;
                    Thread32First(
                        windows::Win32::Foundation::HANDLE(snapshot.as_raw_handle() as _),
                        &mut entry,
                    )
                } else {
                    Thread32Next(
                        windows::Win32::Foundation::HANDLE(snapshot.as_raw_handle() as _),
                        &mut entry,
                    )
                }
            };
            if result.is_err() {
                break None;
            }
            if entry.th32OwnerProcessID == child.id() {
                break Some(entry.th32ThreadID);
            }
        }
        .ok_or("Cannot find terminal process primary thread.")?;
        let thread = unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, thread_id) }
            .map_err(|error| format!("Cannot resume terminal process: {error}"))?;
        let thread = unsafe { OwnedHandle::from_raw_handle(thread.0) };
        if unsafe {
            ResumeThread(windows::Win32::Foundation::HANDLE(
                thread.as_raw_handle() as _
            ))
        } == u32::MAX
        {
            return Err(format!(
                "Cannot resume terminal process: {}",
                std::io::Error::last_os_error()
            ));
        }
        Ok(())
    }

    fn spawn(command: &mut Command) -> Result<(Child, Self), String> {
        use std::os::windows::process::CommandExt;
        use windows::Win32::System::Threading::CREATE_SUSPENDED;

        let job = Self::new()?;
        command.creation_flags(CREATE_SUSPENDED.0);
        let mut child = command
            .spawn()
            .map_err(|error| format!("Cannot start command: {error}"))?;
        if let Err(error) = job.assign_and_resume(&child) {
            let _ = child.kill();
            let _ = job.stop();
            let _ = child.wait();
            return Err(error);
        }
        Ok((child, job))
    }

    pub(crate) fn stop(&self) -> Result<(), String> {
        use windows::Win32::System::JobObjects::TerminateJobObject;

        if self.active_processes()? == 0 {
            return Ok(());
        }
        unsafe {
            TerminateJobObject(
                windows::Win32::Foundation::HANDLE(self.0.as_raw_handle() as _),
                1,
            )
        }
        .map_err(|error| format!("Cannot stop terminal process job: {error}"))?;
        for _ in 0..100 {
            if self.active_processes()? == 0 {
                return Ok(());
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        Err("Cannot confirm terminal process job stopped.".to_string())
    }

    pub(crate) fn active_processes(&self) -> Result<usize, String> {
        use windows::Win32::System::JobObjects::{
            JobObjectBasicAccountingInformation, QueryInformationJobObject,
            JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        };
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(windows::Win32::Foundation::HANDLE(
                    self.0.as_raw_handle() as _
                )),
                JobObjectBasicAccountingInformation,
                (&mut accounting as *mut JOBOBJECT_BASIC_ACCOUNTING_INFORMATION).cast(),
                std::mem::size_of_val(&accounting) as u32,
                None,
            )
        }
        .map_err(|error| error.to_string())?;
        Ok(accounting.ActiveProcesses as usize)
    }
}

impl AcpTerminalManager {
    pub fn shutdown(&self) {
        let terminals = self
            .active
            .lock()
            .ok()
            .map(|mut terminals| {
                terminals
                    .drain()
                    .map(|(_, terminal)| terminal)
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for terminal in terminals {
            let _ = stop(&terminal);
        }
    }

    pub fn server_roots(&self) -> Vec<(PathBuf, u32)> {
        self.active
            .lock()
            .ok()
            .map(|active| {
                active
                    .values()
                    .filter_map(|terminal| {
                        #[allow(unused_mut)]
                        let mut child = terminal.child.lock().ok()?;
                        #[cfg(unix)]
                        if exited_without_reaping(&child).ok()? {
                            return None;
                        }
                        #[cfg(not(unix))]
                        if child.try_wait().ok()?.is_some() {
                            return None;
                        }
                        Some((terminal.directory.clone(), child.id()))
                    })
                    .collect()
            })
            .unwrap_or_default()
    }

    pub fn stop_sessions(&self, agent: &str, profile: CapabilityProfile, session_ids: &[String]) {
        let terminals = self
            .active
            .lock()
            .ok()
            .map(|active| {
                active
                    .iter()
                    .filter(|(_, terminal)| {
                        terminal_belongs_to_connection(
                            &terminal.agent,
                            terminal.profile,
                            &terminal.session_id,
                            agent,
                            profile,
                            session_ids,
                        )
                    })
                    .map(|(id, terminal)| (id.clone(), Arc::clone(terminal)))
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        for (id, terminal) in terminals {
            let _ = self.archive(id, &terminal);
        }
    }

    pub fn stop_worktree(&self, worktree: &Path) -> Result<(), String> {
        let worktree = stable_worktree_identity(worktree);
        let mut blocked = self
            .worktrees_being_removed
            .lock()
            .map_err(|error| error.to_string())?;
        blocked.insert(worktree.clone());
        let terminals = self
            .active
            .lock()
            .map_err(|error| error.to_string())?
            .iter()
            .filter(|(_, terminal)| worktree_contains(&worktree, &terminal.directory))
            .map(|(id, terminal)| (id.clone(), Arc::clone(terminal)))
            .collect::<Vec<_>>();
        for (id, terminal) in terminals {
            if let Err(error) = self.archive(id, &terminal) {
                blocked.remove(&worktree);
                return Err(error);
            }
        }
        Ok(())
    }

    pub fn begin_worktree_removal(&self, worktree: &Path) -> Result<Vec<PathBuf>, String> {
        let worktree = stable_worktree_identity(worktree);
        let mut blocked = self
            .worktrees_being_removed
            .lock()
            .map_err(|error| error.to_string())?;
        blocked.insert(worktree.clone());
        let terminals = self.active.lock().map_err(|error| error.to_string())?;
        Ok(terminals
            .values()
            .filter(|terminal| worktree_contains(&worktree, &terminal.directory))
            .map(|terminal| stable_worktree_identity(&terminal.directory))
            .collect())
    }

    pub fn allow_worktree_terminals(&self, worktree: &Path) {
        let worktree = stable_worktree_identity(worktree);
        if let Ok(mut blocked) = self.worktrees_being_removed.lock() {
            blocked.remove(&worktree);
        }
    }

    fn with_worktree_creation<T>(
        &self,
        directory: &Path,
        create: impl FnOnce(&Path) -> Result<T, String>,
    ) -> Result<T, String> {
        let blocked = self
            .worktrees_being_removed
            .lock()
            .map_err(|error| error.to_string())?;
        let worktree = stable_worktree_identity(&terminal_worktree_root(directory));
        if blocked
            .iter()
            .any(|removed| worktree_contains(removed, &worktree))
        {
            return Err("Worktree is being removed.".to_string());
        }
        let current = dunce::canonicalize(&worktree)
            .map_err(|_| "Worktree folder no longer exists.".to_string())?;
        if !current.is_dir() || current != worktree {
            return Err("Worktree folder changed while creating terminal.".to_string());
        }
        create(&worktree)
    }

    fn archive(&self, id: String, terminal: &AcpTerminal) -> Result<(), String> {
        stop(terminal)?;
        {
            let mut output = terminal.output.lock().map_err(|error| error.to_string())?;
            output.released = true;
            terminal.changed.notify_all();
            for _ in 0..20 {
                if output.exit.is_some() && output.output_complete {
                    break;
                }
                let (next, _) = terminal
                    .changed
                    .wait_timeout(output, Duration::from_millis(50))
                    .map_err(|error| error.to_string())?;
                output = next;
            }
        }
        let mut archived = snapshot(terminal)?;
        if archived.bytes.len() > 256 * 1024 {
            let mut start = archived.bytes.len() - 256 * 1024;
            if let Ok(text) = std::str::from_utf8(&archived.bytes) {
                while !text.is_char_boundary(start) {
                    start += 1;
                }
            }
            archived.bytes.drain(..start);
            archived.output = String::from_utf8_lossy(&archived.bytes).into_owned();
            archived.base_cursor += start as u64;
            archived.truncated = true;
        }
        self.active
            .lock()
            .map_err(|error| error.to_string())?
            .remove(&id);
        let mut history = self.archived.lock().map_err(|error| error.to_string())?;
        history.push_back((id, archived));
        while history.len() > 128 {
            history.pop_front();
        }
        Ok(())
    }
}

fn terminal_belongs_to_connection(
    terminal_agent: &str,
    terminal_profile: CapabilityProfile,
    terminal_session_id: &str,
    agent: &str,
    profile: CapabilityProfile,
    session_ids: &[String],
) -> bool {
    terminal_agent == agent
        && terminal_profile == profile
        && session_ids
            .iter()
            .any(|session_id| session_id == terminal_session_id)
}

impl Drop for AcpTerminalManager {
    fn drop(&mut self) {
        self.shutdown();
    }
}

struct AcpTerminal {
    agent: String,
    profile: CapabilityProfile,
    session_id: String,
    directory: PathBuf,
    child: Mutex<Child>,
    #[cfg(windows)]
    job: WindowsTerminalJob,
    #[cfg(unix)]
    watchdog: Mutex<crate::child_watchdog::ChildWatchdog>,
    stopped: AtomicBool,
    output: Mutex<TerminalOutput>,
    changed: Condvar,
    limit: usize,
}

struct TerminalOutput {
    bytes: VecDeque<u8>,
    start: u64,
    truncated: bool,
    exit: Option<ExitStatus>,
    output_complete: bool,
    released: bool,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ExitStatus {
    exit_code: Option<i32>,
    signal: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CreateParams {
    session_id: String,
    command: String,
    #[serde(default)]
    args: Vec<String>,
    #[serde(default)]
    env: Vec<EnvVariable>,
    cwd: Option<String>,
    output_byte_limit: Option<usize>,
}

#[derive(Deserialize)]
struct EnvVariable {
    name: String,
    value: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalParams {
    session_id: String,
    terminal_id: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalSnapshot {
    output: String,
    #[serde(skip_serializing)]
    bytes: Vec<u8>,
    truncated: bool,
    exit_status: Option<ExitStatus>,
    released: bool,
    directory: String,
    base_cursor: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDelta {
    output_base64: String,
    cursor: u64,
    reset: bool,
    truncated: bool,
    exit_status: Option<ExitStatus>,
    output_complete: bool,
    released: bool,
}

fn append(session: &AcpTerminal, bytes: &[u8]) {
    if let Ok(mut output) = session.output.lock() {
        output.bytes.extend(bytes);
        if output.bytes.len() > session.limit {
            let excess = output.bytes.len() - session.limit;
            output.bytes.drain(..excess);
            output.start += excess as u64;
            output.truncated = true;
            while output
                .bytes
                .front()
                .is_some_and(|byte| byte & 0b1100_0000 == 0b1000_0000)
            {
                output.bytes.pop_front();
                output.start += 1;
            }
        }
        session.changed.notify_all();
    }
}

fn delta(session: &AcpTerminal, cursor: u64) -> Result<TerminalDelta, String> {
    let output = session.output.lock().map_err(|error| error.to_string())?;
    let end = output.start + output.bytes.len() as u64;
    let reset = cursor < output.start || cursor > end;
    let skip = if reset {
        0
    } else {
        (cursor - output.start) as usize
    };
    let bytes: Vec<u8> = output.bytes.iter().skip(skip).copied().collect();
    Ok(TerminalDelta {
        output_base64: base64::engine::general_purpose::STANDARD.encode(bytes),
        cursor: end,
        reset,
        truncated: output.truncated,
        exit_status: output.exit.clone(),
        output_complete: output.output_complete,
        released: output.released,
    })
}

fn snapshot(session: &AcpTerminal) -> Result<TerminalSnapshot, String> {
    let output = session.output.lock().map_err(|error| error.to_string())?;
    let bytes: Vec<u8> = output.bytes.iter().copied().collect();
    Ok(TerminalSnapshot {
        output: String::from_utf8_lossy(&bytes).into_owned(),
        bytes,
        truncated: output.truncated,
        exit_status: output.exit.clone(),
        released: output.released,
        directory: session.directory.to_string_lossy().into_owned(),
        base_cursor: output.start,
    })
}

fn session(
    manager: &AcpTerminalManager,
    agent: &str,
    profile: CapabilityProfile,
    params: Value,
) -> Result<Arc<AcpTerminal>, String> {
    let params: TerminalParams =
        serde_json::from_value(params).map_err(|error| error.to_string())?;
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(&params.terminal_id)
        .cloned()
        .ok_or("Unknown terminal ID.")?;
    if terminal.agent != agent
        || terminal.profile != profile
        || terminal.session_id != params.session_id
    {
        return Err("Unknown terminal ID.".to_string());
    }
    if terminal
        .output
        .lock()
        .map_err(|error| error.to_string())?
        .released
    {
        return Err("Terminal was released.".to_string());
    }
    Ok(terminal)
}

fn stop(terminal: &AcpTerminal) -> Result<(), String> {
    if terminal.stopped.load(Ordering::Acquire) {
        return Ok(());
    }
    let mut child = terminal.child.lock().map_err(|error| error.to_string())?;
    if terminal.stopped.load(Ordering::Acquire) {
        return Ok(());
    }
    #[cfg(unix)]
    {
        crate::terminal::kill_terminal_process_groups(child.id())?;
        child
            .wait()
            .map_err(|error| format!("Cannot wait for terminal process to stop: {error}"))?;
    }
    #[cfg(windows)]
    terminal.job.stop()?;
    #[cfg(windows)]
    child
        .wait()
        .map_err(|error| format!("Cannot wait for terminal process to stop: {error}"))?;
    #[cfg(unix)]
    if let Ok(mut watchdog) = terminal.watchdog.lock() {
        watchdog.stop();
    }
    terminal.stopped.store(true, Ordering::Release);
    Ok(())
}

#[cfg(unix)]
fn exited_without_reaping(child: &std::process::Child) -> Result<bool, String> {
    let mut status = unsafe { std::mem::zeroed::<nix::libc::siginfo_t>() };
    let result = unsafe {
        nix::libc::waitid(
            nix::libc::P_PID,
            child.id(),
            &mut status,
            nix::libc::WEXITED | nix::libc::WNOWAIT | nix::libc::WNOHANG,
        )
    };
    if result != 0 {
        return Err(format!(
            "Cannot inspect terminal process: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(unsafe { status.si_pid() } == child.id() as i32)
}

pub fn handle(
    app: &AppHandle,
    manager: &AcpTerminalManager,
    agent: &str,
    profile: CapabilityProfile,
    method: &str,
    params: Value,
    session_directory: Option<PathBuf>,
) -> Result<Value, String> {
    if method == "terminal/create" {
        let params: CreateParams =
            serde_json::from_value(params).map_err(|error| error.to_string())?;
        if params.command.is_empty()
            || params.command.contains('\0')
            || params.session_id.is_empty()
        {
            return Err("Command and session ID are required.".to_string());
        }
        if params.args.iter().any(|arg| arg.contains('\0'))
            || params.env.iter().any(|variable| {
                variable.name.is_empty()
                    || variable.name.contains(['=', '\0'])
                    || variable.value.contains('\0')
            })
        {
            return Err("Command arguments or environment are invalid.".to_string());
        }
        let fallback = session_directory
            .ok_or("Unknown agent session.")?
            .canonicalize()
            .map_err(|error| error.to_string())?;
        return manager.with_worktree_creation(&fallback, |worktree| {
            let directory = params.cwd.as_deref().map(Path::new).unwrap_or(&fallback);
            if !directory.is_absolute() || !directory.is_dir() {
                return Err(
                    "Terminal working directory must be an existing absolute folder.".to_string(),
                );
            }
            let data_directory = crate::register_worktree_terminal_data(
                &app.path()
                    .app_cache_dir()
                    .map_err(|error| error.to_string())?,
                worktree,
            )?;
            let temp_directory = data_directory.join("tmp");
            let cache_directory = data_directory.join("cache");
            std::fs::create_dir_all(&temp_directory).map_err(|error| error.to_string())?;
            std::fs::create_dir_all(&cache_directory).map_err(|error| error.to_string())?;
            let mut command = Command::new(&params.command);
            command.args(&params.args).current_dir(directory);
            #[cfg(unix)]
            unsafe {
                command.pre_exec(|| {
                    if nix::libc::setsid() == -1 {
                        Err(std::io::Error::last_os_error())
                    } else {
                        Ok(())
                    }
                });
            }
            for variable in params.env {
                command.env(variable.name, variable.value);
            }
            for (name, value) in terminal_environment(&data_directory) {
                command.env(name, value);
            }
            command.stdout(Stdio::piped()).stderr(Stdio::piped());
            #[cfg(windows)]
            let (mut child, job) = WindowsTerminalJob::spawn(&mut command)?;
            #[cfg(not(windows))]
            let mut child = command
                .spawn()
                .map_err(|error| format!("Cannot start command: {error}"))?;
            #[cfg(unix)]
            let watchdog =
                crate::child_watchdog::ChildWatchdog::start(child.id()).map_err(|error| {
                    use nix::sys::signal::{killpg, Signal};
                    use nix::unistd::Pid;
                    let _ = killpg(Pid::from_raw(child.id() as i32), Signal::SIGKILL);
                    let _ = child.wait();
                    format!("Cannot start command watchdog: {error}")
                })?;
            let stdout = child
                .stdout
                .take()
                .ok_or("Command stdout is unavailable.")?;
            let stderr = child
                .stderr
                .take()
                .ok_or("Command stderr is unavailable.")?;
            let id = format!(
                "{}-{}",
                std::process::id(),
                NEXT_TERMINAL.fetch_add(1, Ordering::Relaxed)
            );
            let terminal = Arc::new(AcpTerminal {
                agent: agent.to_string(),
                profile,
                session_id: params.session_id.clone(),
                directory: worktree.to_path_buf(),
                child: Mutex::new(child),
                #[cfg(windows)]
                job,
                #[cfg(unix)]
                watchdog: Mutex::new(watchdog),
                stopped: AtomicBool::new(false),
                output: Mutex::new(TerminalOutput {
                    bytes: VecDeque::new(),
                    start: 0,
                    truncated: false,
                    exit: None,
                    output_complete: false,
                    released: false,
                }),
                changed: Condvar::new(),
                limit: params
                    .output_byte_limit
                    .unwrap_or(1024 * 1024)
                    .min(16 * 1024 * 1024),
            });
            manager
                .active
                .lock()
                .map_err(|error| error.to_string())?
                .insert(id.clone(), Arc::clone(&terminal));
            let readers_done = Arc::new(AtomicU64::new(0));
            for mut stream in [Box::new(stdout) as Box<dyn Read + Send>, Box::new(stderr)] {
                let terminal = Arc::clone(&terminal);
                let done = Arc::clone(&readers_done);
                std::thread::spawn(move || {
                    let mut buffer = [0; 8192];
                    loop {
                        match stream.read(&mut buffer) {
                            Ok(0) | Err(_) => break,
                            Ok(size) => append(&terminal, &buffer[..size]),
                        }
                    }
                    if done.fetch_add(1, Ordering::AcqRel) == 1 {
                        if let Ok(mut output) = terminal.output.lock() {
                            output.output_complete = true;
                            terminal.changed.notify_all();
                        }
                    }
                });
            }
            let waiting = Arc::clone(&terminal);
            std::thread::spawn(move || loop {
                #[cfg(unix)]
                let status = {
                    let exited = waiting
                        .child
                        .lock()
                        .ok()
                        .and_then(|child| exited_without_reaping(&child).ok())
                        .unwrap_or(false);
                    if exited || waiting.stopped.load(Ordering::Acquire) {
                        if exited {
                            let _ = stop(&waiting);
                        }
                        waiting
                            .child
                            .lock()
                            .ok()
                            .and_then(|mut child| child.try_wait().ok())
                            .flatten()
                    } else {
                        None
                    }
                };
                #[cfg(not(unix))]
                let status = waiting
                    .child
                    .lock()
                    .ok()
                    .and_then(|mut child| child.try_wait().ok())
                    .flatten();
                if let Some(status) = status {
                    #[cfg(not(unix))]
                    let _ = stop(&waiting);
                    for _ in 0..20 {
                        if readers_done.load(Ordering::Acquire) == 2 {
                            break;
                        }
                        std::thread::sleep(Duration::from_millis(50));
                    }
                    #[cfg(unix)]
                    let signal = std::os::unix::process::ExitStatusExt::signal(&status)
                        .and_then(|signal| nix::sys::signal::Signal::try_from(signal).ok())
                        .map(|signal| format!("{signal:?}"));
                    #[cfg(not(unix))]
                    let signal = None;
                    if let Ok(mut output) = waiting.output.lock() {
                        output.exit = Some(ExitStatus {
                            exit_code: status.code(),
                            signal,
                        });
                        waiting.changed.notify_all();
                    }
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            });
            let _ = app.emit(
                "acp-terminal-created",
                json!({
                    "agent": agent,
                    "sessionId": params.session_id,
                    "terminalId": id,
                    "command": params.command,
                    "directory": directory,
                }),
            );
            Ok(json!({"terminalId":id}))
        });
    }
    let terminal_id = params
        .get("terminalId")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_string();
    let terminal = session(manager, agent, profile, params)?;
    match method {
        "terminal/output" => {
            let snapshot = snapshot(&terminal)?;
            let mut result = json!({
                "output": snapshot.output,
                "truncated": snapshot.truncated,
            });
            if let Some(status) = snapshot.exit_status {
                result["exitStatus"] = json!(status);
            }
            Ok(result)
        }
        "terminal/wait_for_exit" => {
            let mut output = terminal.output.lock().map_err(|error| error.to_string())?;
            while output.exit.is_none() && !output.released {
                output = terminal
                    .changed
                    .wait(output)
                    .map_err(|error| error.to_string())?;
            }
            output
                .exit
                .clone()
                .map(|status| json!(status))
                .ok_or("Terminal was released.".to_string())
        }
        "terminal/kill" => {
            stop(&terminal)?;
            Ok(json!({}))
        }
        "terminal/release" => {
            manager.archive(terminal_id, &terminal)?;
            Ok(json!({}))
        }
        _ => Err("Unknown terminal method.".to_string()),
    }
}

#[tauri::command]
pub fn acp_terminal_snapshot(
    manager: State<'_, AcpTerminalManager>,
    id: String,
) -> Result<TerminalSnapshot, String> {
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = terminal {
        return snapshot(&terminal);
    }
    manager
        .archived
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .find(|(stored, _)| stored == &id)
        .map(|(_, snapshot)| snapshot.clone())
        .ok_or("Terminal is no longer available.".to_string())
}

#[tauri::command]
pub fn acp_terminal_delta(
    manager: State<'_, AcpTerminalManager>,
    id: String,
    cursor: u64,
) -> Result<TerminalDelta, String> {
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned();
    if let Some(terminal) = terminal {
        return delta(&terminal, cursor);
    }
    let archived = manager.archived.lock().map_err(|error| error.to_string())?;
    let snapshot = archived
        .iter()
        .find(|(stored, _)| stored == &id)
        .map(|(_, snapshot)| snapshot)
        .ok_or("Terminal is no longer available.")?;
    let bytes = &snapshot.bytes;
    let end = snapshot.base_cursor + bytes.len() as u64;
    let reset = cursor < snapshot.base_cursor || cursor > end;
    let skip = if reset {
        0
    } else {
        (cursor - snapshot.base_cursor) as usize
    };
    Ok(TerminalDelta {
        output_base64: base64::engine::general_purpose::STANDARD.encode(&bytes[skip..]),
        cursor: end,
        reset,
        truncated: snapshot.truncated,
        exit_status: snapshot.exit_status.clone(),
        output_complete: true,
        released: snapshot.released,
    })
}

#[tauri::command]
pub fn acp_terminal_stop(manager: State<'_, AcpTerminalManager>, id: String) -> Result<(), String> {
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(&id)
        .cloned()
        .ok_or("Terminal is no longer available.")?;
    stop(&terminal)
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedTerminal {
    terminal_id: String,
    worktree: String,
    state: &'static str,
    exit_code: Option<i32>,
    cursor: u64,
    base_cursor: u64,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InspectedOutput {
    terminal_id: String,
    worktree: String,
    state: &'static str,
    exit_code: Option<i32>,
    output: String,
    output_base64: String,
    cursor: u64,
    base_cursor: u64,
    truncated: bool,
    reset: bool,
    timed_out: bool,
}

struct PageSource<'a> {
    id: &'a str,
    directory: &'a Path,
    bytes: &'a [u8],
    base: u64,
    exit_code: Option<i32>,
    exited: bool,
}

fn inspected_page(
    source: PageSource<'_>,
    cursor: u64,
    max_bytes: usize,
    timed_out: bool,
) -> InspectedOutput {
    let end = source.base + source.bytes.len() as u64;
    let truncated = cursor < source.base;
    let reset = cursor > end;
    let offset = if truncated || reset {
        0
    } else {
        (cursor - source.base) as usize
    };
    let page = &source.bytes[offset..(offset + max_bytes.clamp(1, 65_536)).min(source.bytes.len())];
    InspectedOutput {
        terminal_id: format!("agent:{}", source.id),
        worktree: source.directory.to_string_lossy().into_owned(),
        state: if source.exited { "exited" } else { "running" },
        exit_code: source.exit_code,
        output: String::from_utf8_lossy(page).into_owned(),
        output_base64: base64::engine::general_purpose::STANDARD.encode(page),
        cursor: source.base + offset as u64 + page.len() as u64,
        base_cursor: source.base,
        truncated,
        reset,
        timed_out,
    }
}

fn inspected_active(
    manager: &AcpTerminalManager,
    id: &str,
    allowed: &[PathBuf],
) -> Result<Option<Arc<AcpTerminal>>, String> {
    let terminal = manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .get(id)
        .cloned();
    Ok(terminal.filter(|item| allowed.contains(&item.directory)))
}

fn inspected_archived(
    manager: &AcpTerminalManager,
    id: &str,
    allowed: &[PathBuf],
) -> Result<Option<TerminalSnapshot>, String> {
    Ok(manager
        .archived
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
        .find(|(stored, snapshot)| {
            stored == id
                && allowed
                    .iter()
                    .any(|path| path == Path::new(&snapshot.directory))
        })
        .map(|(_, snapshot)| snapshot.clone()))
}

#[tauri::command]
pub fn acp_terminal_inspect_list(
    manager: State<'_, AcpTerminalManager>,
    allowed: Vec<String>,
) -> Result<Vec<InspectedTerminal>, String> {
    let allowed = crate::terminal::canonical_terminal_paths(&allowed);
    let mut result = Vec::new();
    for (id, terminal) in manager
        .active
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
    {
        if !allowed.contains(&terminal.directory) {
            continue;
        }
        let output = terminal.output.lock().map_err(|error| error.to_string())?;
        result.push(InspectedTerminal {
            terminal_id: format!("agent:{id}"),
            worktree: terminal.directory.to_string_lossy().into_owned(),
            state: if output.exit.is_some() || output.released {
                "exited"
            } else {
                "running"
            },
            exit_code: output.exit.as_ref().and_then(|status| status.exit_code),
            cursor: output.start + output.bytes.len() as u64,
            base_cursor: output.start,
        });
    }
    for (id, snapshot) in manager
        .archived
        .lock()
        .map_err(|error| error.to_string())?
        .iter()
    {
        if !allowed
            .iter()
            .any(|path| path == Path::new(&snapshot.directory))
        {
            continue;
        }
        result.push(InspectedTerminal {
            terminal_id: format!("agent:{id}"),
            worktree: snapshot.directory.clone(),
            state: "exited",
            exit_code: snapshot
                .exit_status
                .as_ref()
                .and_then(|status| status.exit_code),
            cursor: snapshot.base_cursor + snapshot.bytes.len() as u64,
            base_cursor: snapshot.base_cursor,
        });
    }
    Ok(result)
}

#[tauri::command]
pub fn acp_terminal_inspect_read(
    manager: State<'_, AcpTerminalManager>,
    id: String,
    allowed: Vec<String>,
    cursor: u64,
    max_bytes: usize,
) -> Result<InspectedOutput, String> {
    let id = id.strip_prefix("agent:").ok_or("Unknown terminal ID.")?;
    let allowed = crate::terminal::canonical_terminal_paths(&allowed);
    if let Some(terminal) = inspected_active(&manager, id, &allowed)? {
        let output = terminal.output.lock().map_err(|error| error.to_string())?;
        let bytes: Vec<_> = output.bytes.iter().copied().collect();
        return Ok(inspected_page(
            PageSource {
                id,
                directory: &terminal.directory,
                bytes: &bytes,
                base: output.start,
                exit_code: output.exit.as_ref().and_then(|status| status.exit_code),
                exited: output.exit.is_some() || output.released,
            },
            cursor,
            max_bytes,
            false,
        ));
    }
    let snapshot = inspected_archived(&manager, id, &allowed)?.ok_or("Unknown terminal ID.")?;
    Ok(inspected_page(
        PageSource {
            id,
            directory: Path::new(&snapshot.directory),
            bytes: &snapshot.bytes,
            base: snapshot.base_cursor,
            exit_code: snapshot
                .exit_status
                .as_ref()
                .and_then(|status| status.exit_code),
            exited: true,
        },
        cursor,
        max_bytes,
        false,
    ))
}

fn wait_for_agent_terminal(
    terminal: Arc<AcpTerminal>,
    id: String,
    cursor: u64,
    max_bytes: usize,
    timeout_ms: u64,
) -> Result<InspectedOutput, String> {
    let output = terminal.output.lock().map_err(|error| error.to_string())?;
    let end = output.start + output.bytes.len() as u64;
    let (output, timed_out) =
        if cursor == end && output.exit.is_none() && !output.released && timeout_ms > 0 {
            let (state, result) = terminal
                .changed
                .wait_timeout_while(
                    output,
                    Duration::from_millis(timeout_ms.min(30_000)),
                    |state| {
                        state.start + state.bytes.len() as u64 == cursor
                            && state.exit.is_none()
                            && !state.released
                    },
                )
                .map_err(|error| error.to_string())?;
            (state, result.timed_out())
        } else {
            let timed_out =
                cursor == end && timeout_ms == 0 && output.exit.is_none() && !output.released;
            (output, timed_out)
        };
    let bytes: Vec<_> = output.bytes.iter().copied().collect();
    Ok(inspected_page(
        PageSource {
            id: &id,
            directory: &terminal.directory,
            bytes: &bytes,
            base: output.start,
            exit_code: output.exit.as_ref().and_then(|status| status.exit_code),
            exited: output.exit.is_some() || output.released,
        },
        cursor,
        max_bytes,
        timed_out,
    ))
}

#[tauri::command]
pub async fn acp_terminal_inspect_wait(
    manager: State<'_, AcpTerminalManager>,
    id: String,
    allowed: Vec<String>,
    cursor: u64,
    max_bytes: usize,
    timeout_ms: u64,
) -> Result<InspectedOutput, String> {
    let id = id
        .strip_prefix("agent:")
        .ok_or("Unknown terminal ID.")?
        .to_string();
    let allowed = crate::terminal::canonical_terminal_paths(&allowed);
    let Some(terminal) = inspected_active(&manager, &id, &allowed)? else {
        let snapshot =
            inspected_archived(&manager, &id, &allowed)?.ok_or("Unknown terminal ID.")?;
        return Ok(inspected_page(
            PageSource {
                id: &id,
                directory: Path::new(&snapshot.directory),
                bytes: &snapshot.bytes,
                base: snapshot.base_cursor,
                exit_code: snapshot
                    .exit_status
                    .as_ref()
                    .and_then(|status| status.exit_code),
                exited: true,
            },
            cursor,
            max_bytes,
            false,
        ));
    };
    tauri::async_runtime::spawn_blocking(move || {
        wait_for_agent_terminal(terminal, id, cursor, max_bytes, timeout_ms)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_terminal_creation_is_serialized_with_worktree_stop() {
        let manager = Arc::new(AcpTerminalManager::default());
        let worktree =
            std::env::temp_dir().join(format!("sail-acp-terminal-fence-{}", uuid::Uuid::new_v4()));
        let external_cwd = worktree.with_extension("external-cwd");
        std::fs::create_dir_all(&worktree).unwrap();
        std::fs::create_dir_all(&external_cwd).unwrap();
        let (creating_tx, creating_rx) = std::sync::mpsc::channel();
        let (finish_create_tx, finish_create_rx) = std::sync::mpsc::channel();
        let creator_manager = Arc::clone(&manager);
        let creator_worktree = worktree.clone();
        let creator = std::thread::spawn(move || {
            creator_manager.with_worktree_creation(&creator_worktree, |_| {
                creating_tx.send(()).unwrap();
                finish_create_rx.recv().unwrap();
                Ok(())
            })
        });
        creating_rx.recv().unwrap();

        let (stopping_tx, stopping_rx) = std::sync::mpsc::channel();
        let stopping_manager = Arc::clone(&manager);
        let stopping_worktree = worktree.clone();
        let stopper = std::thread::spawn(move || {
            stopping_tx.send(()).unwrap();
            stopping_manager.stop_worktree(&stopping_worktree)
        });
        stopping_rx.recv().unwrap();
        finish_create_tx.send(()).unwrap();

        creator.join().unwrap().unwrap();
        stopper.join().unwrap().unwrap();
        std::fs::remove_dir_all(&worktree).unwrap();
        let mut created_after_removal = false;
        let create_after_stop = manager.with_worktree_creation(&worktree, |_| {
            assert!(external_cwd.is_dir());
            created_after_removal = true;
            Ok(())
        });
        assert_eq!(create_after_stop.unwrap_err(), "Worktree is being removed.");
        assert!(!created_after_removal);
        std::fs::create_dir_all(&worktree).unwrap();
        let blocked_recreation = manager.with_worktree_creation(&worktree, |_| {
            created_after_removal = true;
            Ok(())
        });
        assert_eq!(
            blocked_recreation.unwrap_err(),
            "Worktree is being removed."
        );
        assert!(!created_after_removal);
        manager.allow_worktree_terminals(&worktree);
        assert!(manager
            .with_worktree_creation(&worktree, |_| Ok(()))
            .is_ok());
        std::fs::remove_dir_all(worktree).unwrap();
        std::fs::remove_dir_all(external_cwd).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn stop_kills_process_group_after_its_leader_exits() {
        use std::os::unix::process::CommandExt;

        let marker =
            std::env::temp_dir().join(format!("sail-terminal-survivor-{}", uuid::Uuid::new_v4()));
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "set -m; (sleep 1; touch \"$1\") & exit 0", "sh"]);
        command.arg(&marker);
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        let mut child = command.spawn().expect("spawn terminal leader and job");
        let process_id = child.id();
        let mut status = unsafe { std::mem::zeroed::<nix::libc::siginfo_t>() };
        let waited = unsafe {
            nix::libc::waitid(
                nix::libc::P_PID,
                process_id,
                &mut status,
                nix::libc::WEXITED | nix::libc::WNOWAIT,
            )
        };
        assert_eq!(waited, 0, "observe leader exit without releasing its PID");
        assert_eq!(unsafe { status.si_pid() }, process_id as i32);

        crate::terminal::kill_terminal_process_groups(process_id)
            .expect("stop every group in the surviving terminal session");
        child.wait().expect("reap leader after group cleanup");
        std::thread::sleep(Duration::from_millis(1200));

        assert!(
            !marker.exists(),
            "process group child survived terminal stop"
        );
    }

    #[test]
    fn worktree_terminal_data_is_stable_and_private_per_worktree() {
        let cache = Path::new("/sail-cache");
        let first = worktree_data_directory(cache, Path::new("/repo/first"));
        let same = worktree_data_directory(cache, Path::new("/repo/first"));
        let second = worktree_data_directory(cache, Path::new("/repo/second"));

        assert_eq!(first, same);
        assert_ne!(first, second);
        assert!(first.starts_with(cache.join("terminal-worktrees")));
    }

    #[cfg(unix)]
    #[test]
    fn nested_agent_terminal_uses_root_cache_and_stops_with_worktree() {
        use std::os::unix::process::CommandExt;

        let scratch =
            std::env::temp_dir().join(format!("sail-acp-nested-worktree-{}", uuid::Uuid::new_v4()));
        let worktree = scratch.join("worktree");
        let nested = worktree.join("subdir");
        std::fs::create_dir_all(&nested).unwrap();
        assert!(Command::new("git")
            .args(["init", "--quiet"])
            .arg(&worktree)
            .status()
            .unwrap()
            .success());

        let canonical_root = dunce::canonicalize(&worktree).unwrap();
        let session_worktree = terminal_worktree_root(&nested);
        assert_eq!(session_worktree, canonical_root);
        let cache = scratch.join("cache");
        let session_data = worktree_data_directory(&cache, &session_worktree);
        let deletion_data = worktree_data_directory(&cache, &canonical_root);
        assert_eq!(session_data, deletion_data);
        assert_ne!(
            session_data,
            worktree_data_directory(&cache, &nested),
            "nested cwd must not create a second cache identity"
        );

        let marker = scratch.join("surviving-process-marker");
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "sleep 2; touch \"$1\"", "sh"]);
        command.arg(&marker);
        unsafe {
            command.pre_exec(|| {
                if nix::libc::setsid() == -1 {
                    Err(std::io::Error::last_os_error())
                } else {
                    Ok(())
                }
            });
        }
        command.stdout(Stdio::null()).stderr(Stdio::null());
        let child = command.spawn().unwrap();
        let watchdog = crate::child_watchdog::ChildWatchdog::start(child.id()).unwrap();
        let terminal = Arc::new(AcpTerminal {
            agent: "codex".to_string(),
            profile: CapabilityProfile::Review,
            session_id: "nested-session".to_string(),
            directory: nested.clone(),
            child: Mutex::new(child),
            watchdog: Mutex::new(watchdog),
            stopped: AtomicBool::new(false),
            output: Mutex::new(TerminalOutput {
                bytes: VecDeque::new(),
                start: 0,
                truncated: false,
                exit: None,
                output_complete: false,
                released: false,
            }),
            changed: Condvar::new(),
            limit: 1024,
        });
        let manager = AcpTerminalManager::default();
        manager
            .active
            .lock()
            .unwrap()
            .insert("nested-terminal".to_string(), terminal);

        manager.stop_worktree(&canonical_root).unwrap();
        assert!(manager.active.lock().unwrap().is_empty());
        std::fs::remove_dir_all(worktree.join(".git")).unwrap();
        let mut created_after_stop = false;
        let create_after_stop = manager.with_worktree_creation(&nested, |_| {
            created_after_stop = true;
            Ok(())
        });
        assert_eq!(create_after_stop.unwrap_err(), "Worktree is being removed.");
        assert!(!created_after_stop);
        std::thread::sleep(Duration::from_millis(2_200));
        assert!(!marker.exists(), "nested terminal process survived removal");
        std::fs::remove_dir_all(scratch).unwrap();
    }

    #[test]
    fn missing_worktree_retry_keeps_canonical_parent_identity() {
        let root = std::env::temp_dir().join(format!(
            "sail-terminal-identity-retry-{}",
            uuid::Uuid::new_v4()
        ));
        let parent = root.join("parent");
        std::fs::create_dir_all(&parent).unwrap();
        let worktree = parent.join("removed-worktree");
        std::fs::create_dir_all(&worktree).unwrap();
        let cache = root.join("cache");
        let before_removal = worktree_data_directory(&cache, &worktree);
        let canonical_parent = dunce::canonicalize(&parent).unwrap();
        std::fs::remove_dir_all(&worktree).unwrap();
        let after_removal =
            worktree_data_directory(&cache, &canonical_parent.join("removed-worktree"));

        assert_eq!(before_removal, after_removal);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn missing_worktree_identity_normalizes_dotdot_aliases() {
        let root = std::env::temp_dir().join(format!(
            "sail-terminal-identity-dotdot-{}",
            uuid::Uuid::new_v4()
        ));
        let parent = root.join("parent");
        std::fs::create_dir_all(&parent).unwrap();
        let missing = parent.join("worktree");
        let alias = parent.join("..").join("parent").join("worktree");

        assert_eq!(
            stable_worktree_identity(&missing),
            stable_worktree_identity(&alias)
        );
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn outer_worktree_contains_nested_git_worktree_identity() {
        let root =
            std::env::temp_dir().join(format!("sail-terminal-nested-git-{}", uuid::Uuid::new_v4()));
        let outer = root.join("outer");
        let nested = outer.join("nested");
        std::fs::create_dir_all(&nested).unwrap();
        for path in [&outer, &nested] {
            assert!(Command::new("git")
                .args(["init", "--quiet"])
                .arg(path)
                .status()
                .unwrap()
                .success());
        }
        let outer = dunce::canonicalize(outer).unwrap();
        let nested = terminal_worktree_root(&nested);

        assert_ne!(outer, nested, "nested repository keeps its own identity");
        assert!(worktree_contains(&outer, &nested));
        assert!(!worktree_contains(&nested, &outer));

        std::fs::remove_dir_all(root).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn worktree_terminal_data_distinguishes_non_utf8_paths() {
        use std::os::unix::ffi::OsStringExt;

        let cache = Path::new("/sail-cache");
        let first = PathBuf::from(std::ffi::OsString::from_vec(b"/repo/tree-\xff".to_vec()));
        let second = PathBuf::from(std::ffi::OsString::from_vec(b"/repo/tree-\xfe".to_vec()));

        assert_ne!(
            worktree_data_directory(cache, &first),
            worktree_data_directory(cache, &second)
        );
    }

    #[test]
    fn terminal_environment_keeps_package_download_caches_shared() {
        let root = Path::new("/sail-cache/terminal-worktrees/worktree");
        let environment = terminal_environment(root);

        assert!(environment.contains(&("TMPDIR", root.join("tmp"))));
        assert!(environment.contains(&("XDG_CACHE_HOME", root.join("cache"))));
        let shared = Path::new("/sail-cache/terminal-package-downloads");
        assert!(environment.contains(&("PIP_CACHE_DIR", shared.join("pip"))));
        assert!(environment.contains(&("UV_CACHE_DIR", shared.join("uv"))));
        assert!(environment.contains(&("POETRY_CACHE_DIR", shared.join("poetry"))));
        assert!(!environment.iter().any(|(name, _)| {
            matches!(
                *name,
                "HOME" | "XDG_CONFIG_HOME" | "NPM_CONFIG_CACHE" | "CARGO_HOME"
            )
        }));
    }

    #[cfg(windows)]
    #[test]
    fn windows_terminal_job_stops_descendant_after_direct_child_exits() {
        let marker = std::env::temp_dir().join(format!(
            "sail-windows-terminal-descendant-{}.txt",
            uuid::Uuid::new_v4()
        ));
        let marker_literal = marker.to_string_lossy().replace('\'', "''");
        let script = format!(
            "Start-Process -FilePath 'powershell.exe' -ArgumentList @('-NoProfile','-Command','Start-Sleep -Seconds 5; Set-Content -LiteralPath ''{marker_literal}'' done'); exit 0"
        );
        let mut command = Command::new("powershell.exe");
        command
            .args(["-NoProfile", "-Command", &script])
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        let (mut child, job) = WindowsTerminalJob::spawn(&mut command).unwrap();
        let deadline = std::time::Instant::now() + Duration::from_secs(10);
        while child.try_wait().unwrap().is_none() {
            assert!(
                std::time::Instant::now() < deadline,
                "terminal command did not exit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(
            job.active_processes().unwrap() > 0,
            "descendant remains in job"
        );

        job.stop()
            .expect("terminate descendants after direct child exit");
        assert_eq!(job.active_processes().unwrap(), 0);
        std::thread::sleep(Duration::from_secs(6));
        assert!(!marker.exists(), "descendant survived terminal stop");
        let _ = std::fs::remove_file(marker);
    }

    #[test]
    fn connection_cleanup_only_matches_its_agent_sessions() {
        let disconnected = vec!["review-session".to_string(), "review-child".to_string()];

        assert!(terminal_belongs_to_connection(
            "codex",
            CapabilityProfile::Review,
            "review-session",
            "codex",
            CapabilityProfile::Review,
            &disconnected,
        ));
        assert!(!terminal_belongs_to_connection(
            "codex",
            CapabilityProfile::Build,
            "review-session",
            "codex",
            CapabilityProfile::Review,
            &disconnected,
        ));
        assert!(!terminal_belongs_to_connection(
            "codex",
            CapabilityProfile::Review,
            "build-session",
            "codex",
            CapabilityProfile::Review,
            &disconnected,
        ));
        assert!(!terminal_belongs_to_connection(
            "claude",
            CapabilityProfile::Review,
            "review-session",
            "codex",
            CapabilityProfile::Review,
            &disconnected,
        ));
    }
}
