use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
#[cfg(not(feature = "e2e"))]
use tauri::Manager;

const CONFIG: &str = ".sail/worktree.json";
const MAX_CONFIG_BYTES: u64 = 64 * 1024;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct ContextPointer {
    manifest: String,
}

#[derive(Deserialize)]
struct WorktreePointer {
    context: Option<ContextPointer>,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    version: u8,
    providers: Vec<ProviderSpec>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ProviderSpec {
    id: String,
    #[serde(rename = "type")]
    kind: String,
    command: String,
    capabilities: Vec<String>,
    #[serde(default)]
    required: bool,
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct ApprovalStore {
    registry: BTreeMap<String, String>,
    approvals: BTreeMap<String, Approval>,
}

#[derive(Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
struct Approval {
    fingerprint: String,
    revision: String,
    #[serde(default)]
    command: String,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderStatus {
    state: String,
    id: Option<String>,
    command: Option<String>,
    executable: Option<String>,
    executable_sha256: Option<String>,
    capabilities: Vec<String>,
    fingerprint: Option<String>,
    revision: Option<String>,
    reason: Option<String>,
}

impl ProviderStatus {
    fn empty(state: &str, reason: Option<String>) -> Self {
        Self {
            state: state.into(),
            id: None,
            command: None,
            executable: None,
            executable_sha256: None,
            capabilities: Vec::new(),
            fingerprint: None,
            revision: None,
            reason,
        }
    }
}

#[derive(Debug)]
struct CommittedProvider {
    spec: ProviderSpec,
    manifest_path: String,
    manifest_hash: String,
    revision: String,
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn sha256(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn git(directory: &Path, args: &[&str]) -> Result<Vec<u8>, String> {
    let output = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(args)
        .output()
        .map_err(|error| format!("Cannot read committed context: {error}"))?;
    if !output.status.success() {
        return Err("Cannot read committed context.".into());
    }
    Ok(output.stdout)
}

fn committed_blob(directory: &Path, revision: &str, path: &str) -> Result<Option<Vec<u8>>, String> {
    let entries = git(directory, &["ls-tree", "-z", revision, "--", path])?;
    if entries.is_empty() {
        return Ok(None);
    }
    let entry = entries
        .split(|byte| *byte == b'\0')
        .find(|entry| !entry.is_empty())
        .ok_or("Invalid committed context entry.")?;
    let mode = entry
        .split(|byte| *byte == b' ')
        .next()
        .ok_or("Invalid committed context entry.")?;
    if mode != b"100644" && mode != b"100755" {
        return Err("Committed context must be a regular file, not a symlink.".into());
    }
    let object = format!("{revision}:{path}");
    let size = String::from_utf8(git(directory, &["cat-file", "-s", &object])?)
        .map_err(|_| "Invalid committed context size.")?;
    let size = size
        .trim()
        .parse::<u64>()
        .map_err(|_| "Invalid committed context size.")?;
    if size > MAX_CONFIG_BYTES {
        return Err("Committed context file exceeds 64 KiB.".into());
    }
    let bytes = git(directory, &["show", &object])?;
    if bytes.len() as u64 != size {
        return Err("Committed context changed while reading.".into());
    }
    Ok(Some(bytes))
}

fn valid_manifest_path(path: &str) -> bool {
    let path = Path::new(path);
    path.starts_with(".sail")
        && path != Path::new(CONFIG)
        && path
            .components()
            .all(|part| matches!(part, Component::Normal(_)))
}

fn valid_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || byte == b'-')
        && name.as_bytes()[0].is_ascii_lowercase()
}

fn committed_provider(directory: &Path) -> Result<Option<CommittedProvider>, String> {
    let revision = String::from_utf8(git(directory, &["rev-parse", "--verify", "HEAD^{commit}"])?)
        .map_err(|_| "Invalid Git revision.")?
        .trim()
        .to_owned();
    committed_provider_at(directory, &revision)
}

fn committed_provider_at(
    directory: &Path,
    revision: &str,
) -> Result<Option<CommittedProvider>, String> {
    let Some(config) = committed_blob(directory, revision, CONFIG)? else {
        return Ok(None);
    };
    let pointer: WorktreePointer = serde_json::from_slice(&config)
        .map_err(|error| format!("Invalid committed Sail context pointer: {error}"))?;
    let Some(pointer) = pointer.context else {
        return Ok(None);
    };
    if !valid_manifest_path(&pointer.manifest) {
        return Err("Context manifest path must stay under .sail.".into());
    }
    let manifest = committed_blob(directory, revision, &pointer.manifest)?
        .ok_or("Committed context manifest is missing.")?;
    let parsed: Manifest = serde_json::from_slice(&manifest)
        .map_err(|error| format!("Invalid committed context manifest: {error}"))?;
    if parsed.version != 1 {
        return Err("Unsupported context manifest version.".into());
    }
    if parsed.providers.len() != 1 {
        return Err("Context manifest must select exactly one local provider.".into());
    }
    let spec = parsed.providers.into_iter().next().unwrap();
    if !valid_name(&spec.id) || spec.id == "sail-browser" {
        return Err("Invalid or reserved context provider ID.".into());
    }
    if !valid_name(&spec.command) || spec.kind != "stdio" {
        return Err("Context provider must use a registry command and stdio transport.".into());
    }
    let allowed: HashSet<&str> = [
        "search",
        "get",
        "index",
        "execute",
        "memory-read",
        "memory-write",
    ]
    .into_iter()
    .collect();
    let capabilities: HashSet<&str> = spec.capabilities.iter().map(String::as_str).collect();
    if capabilities.len() != spec.capabilities.len()
        || capabilities.is_empty()
        || !capabilities.is_subset(&allowed)
    {
        return Err("Context provider capabilities are invalid or duplicated.".into());
    }
    if spec.required {
        return Err("Required providers are not supported before supervised startup.".into());
    }
    Ok(Some(CommittedProvider {
        spec,
        manifest_path: pointer.manifest,
        manifest_hash: sha256(&manifest),
        revision: revision.into(),
    }))
}

fn approval_revision_valid(
    directory: &Path,
    approved: &Approval,
    current: &CommittedProvider,
) -> bool {
    if approved.revision == current.revision {
        return true;
    }
    let range = format!("{}..{}", approved.revision, current.revision);
    if git(
        directory,
        &[
            "merge-base",
            "--is-ancestor",
            &approved.revision,
            &current.revision,
        ],
    )
    .is_err()
    {
        return false;
    }
    git(
        directory,
        &[
            "log",
            "--full-history",
            "--format=%H",
            &range,
            "--",
            CONFIG,
            &current.manifest_path,
        ],
    )
    .is_ok_and(|changes| changes.is_empty())
}

fn project_key(directory: &Path) -> Result<String, String> {
    let canonical = dunce::canonicalize(directory).map_err(|error| error.to_string())?;
    let common = String::from_utf8(git(directory, &["rev-parse", "--git-common-dir"])?)
        .map_err(|_| "Invalid Git common directory.")?;
    let common = PathBuf::from(common.trim());
    let common = if common.is_absolute() {
        common
    } else {
        canonical.join(common)
    };
    let common = dunce::canonicalize(common).map_err(|error| error.to_string())?;
    Ok(sha256(
        format!("{}\0{}", common.display(), canonical.display()).as_bytes(),
    ))
}

fn executable_hash(path: &Path) -> Result<String, String> {
    let metadata =
        fs::metadata(path).map_err(|_| "Registered provider executable is unavailable.")?;
    if !metadata.is_file() {
        return Err("Registered provider executable is not a file.".into());
    }
    #[cfg(unix)]
    if metadata.permissions().mode() & 0o111 == 0 {
        return Err("Registered provider file is not executable.".into());
    }
    let mut file =
        File::open(path).map_err(|_| "Registered provider executable is unavailable.")?;
    let mut digest = Sha256::new();
    let mut buffer = [0u8; 8192];
    loop {
        let count = file
            .read(&mut buffer)
            .map_err(|_| "Cannot hash provider executable.")?;
        if count == 0 {
            break;
        }
        digest.update(&buffer[..count]);
    }
    Ok(hex(&digest.finalize()))
}

fn status(directory: &Path, store: &ApprovalStore) -> ProviderStatus {
    let provider = match committed_provider(directory) {
        Ok(None) => return ProviderStatus::empty("not-configured", None),
        Ok(Some(provider)) => provider,
        Err(error) => return ProviderStatus::empty("invalid", Some(error)),
    };
    let mut result = ProviderStatus {
        state: "unavailable".into(),
        id: Some(provider.spec.id.clone()),
        command: Some(provider.spec.command.clone()),
        executable: None,
        executable_sha256: None,
        capabilities: provider.spec.capabilities.clone(),
        fingerprint: None,
        revision: Some(provider.revision.clone()),
        reason: None,
    };
    let Some(path) = store.registry.get(&provider.spec.command) else {
        result.reason = Some("Select this provider's executable in Sail before approval.".into());
        return result;
    };
    let canonical = match dunce::canonicalize(path) {
        Ok(path) => path,
        Err(_) => {
            result.reason = Some("Registered provider executable is unavailable.".into());
            return result;
        }
    };
    let hash = match executable_hash(&canonical) {
        Ok(hash) => hash,
        Err(error) => {
            result.reason = Some(error);
            return result;
        }
    };
    let key = match project_key(directory) {
        Ok(key) => key,
        Err(error) => {
            result.state = "invalid".into();
            result.reason = Some(error);
            return result;
        }
    };
    let fingerprint = sha256(
        format!(
            "{}\0{}\0{}\0{}\0{}",
            key,
            provider.manifest_hash,
            canonical.display(),
            hash,
            serde_json::to_string(&provider.spec).unwrap_or_default()
        )
        .as_bytes(),
    );
    result.state = if store.approvals.get(&key).is_some_and(|approval| {
        approval.fingerprint == fingerprint
            && approval.command == provider.spec.command
            && approval_revision_valid(directory, approval, &provider)
    }) {
        "approved"
    } else {
        "approval-required"
    }
    .into();
    result.executable = Some(canonical.to_string_lossy().into_owned());
    result.executable_sha256 = Some(hash);
    result.fingerprint = Some(fingerprint);
    result
}

fn approve(
    directory: &Path,
    store: &mut ApprovalStore,
    expected_fingerprint: &str,
) -> Result<ProviderStatus, String> {
    let mut current = status(directory, store);
    if current.state != "approval-required"
        || current.fingerprint.as_deref() != Some(expected_fingerprint)
    {
        return Err("Provider identity changed after review; inspect it again.".into());
    }
    let key = project_key(directory)?;
    let command = current
        .command
        .clone()
        .ok_or("Provider command is missing.")?;
    let revision = current
        .revision
        .clone()
        .ok_or("Provider revision is missing.")?;
    store.approvals.insert(
        key,
        Approval {
            fingerprint: expected_fingerprint.into(),
            revision,
            command,
        },
    );
    current.state = "approved".into();
    Ok(current)
}

fn revoke(directory: &Path, store: &mut ApprovalStore) -> Result<bool, String> {
    Ok(store.approvals.remove(&project_key(directory)?).is_some())
}

fn register(store: &mut ApprovalStore, command: &str, executable: &Path) {
    store
        .approvals
        .retain(|_, approval| approval.command != command);
    store
        .registry
        .insert(command.into(), executable.to_string_lossy().into_owned());
}

#[cfg(feature = "e2e")]
fn e2e_store_path() -> Result<PathBuf, String> {
    let root = std::env::var_os("SAIL_E2E_CONFIG_DIR")
        .ok_or("Set a private SAIL_E2E_CONFIG_DIR for context tests.")?;
    let root = PathBuf::from(root);
    if !root.is_absolute() {
        return Err("SAIL_E2E_CONFIG_DIR must be an absolute private path.".into());
    }
    Ok(root.join("context-providers.json"))
}

fn store_path(_app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        e2e_store_path()
    }
    #[cfg(not(feature = "e2e"))]
    {
        let config = _app
            .path()
            .config_dir()
            .map_err(|error| format!("Cannot locate Sail configuration: {error}"))?;
        Ok(config.join("sail").join("context-providers.json"))
    }
}

fn locked_store<T>(
    path: &Path,
    action: impl FnOnce(&mut ApprovalStore) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let parent = path
        .parent()
        .ok_or("Cannot locate provider store folder.")?;
    fs::create_dir_all(parent).map_err(|error| error.to_string())?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(|error| format!("Cannot open provider store lock: {error}"))?;
    lock.lock()
        .map_err(|error| format!("Cannot lock provider store: {error}"))?;
    let mut store = match fs::read(path) {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Invalid provider store: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ApprovalStore::default(),
        Err(error) => return Err(format!("Cannot read provider store: {error}")),
    };
    let (result, changed) = action(&mut store)?;
    if changed {
        let temporary = path.with_extension("json.tmp");
        let bytes = serde_json::to_vec_pretty(&store).map_err(|error| error.to_string())?;
        let mut options = OpenOptions::new();
        options.write(true).create(true).truncate(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| error.to_string())?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| error.to_string())?;
        drop(file);
        #[cfg(windows)]
        {
            let backup = path.with_extension("json.bak");
            if path.exists() {
                if backup.exists() {
                    fs::remove_file(&backup).map_err(|error| error.to_string())?;
                }
                fs::rename(path, &backup).map_err(|error| error.to_string())?;
            }
            if let Err(error) = fs::rename(&temporary, path) {
                if backup.exists() {
                    let _ = fs::rename(&backup, path);
                }
                return Err(error.to_string());
            }
            if backup.exists() {
                fs::remove_file(backup).map_err(|error| error.to_string())?;
            }
        }
        #[cfg(not(windows))]
        fs::rename(temporary, path).map_err(|error| error.to_string())?;
    }
    Ok(result)
}

#[tauri::command]
pub fn context_provider_status(
    app: tauri::AppHandle,
    directory: String,
) -> Result<ProviderStatus, String> {
    locked_store(&store_path(&app)?, |store| {
        Ok((status(Path::new(&directory), store), false))
    })
}

#[cfg(target_os = "macos")]
pub fn provider_mcp_server(app: &tauri::AppHandle, directory: &Path) -> Option<serde_json::Value> {
    let canonical = dunce::canonicalize(directory).ok()?;
    let current = locked_store(&store_path(app).ok()?, |store| {
        Ok((status(&canonical, store), false))
    })
    .ok()?;
    if current.state != "approved" {
        return None;
    }
    let executable = std::env::current_exe().ok()?;
    Some(serde_json::json!({
        "name": "sail-context",
        "command": executable.to_string_lossy(),
        "args": ["--context-mcp", canonical.to_string_lossy()],
        "env": []
    }))
}

#[cfg(not(target_os = "macos"))]
pub fn provider_mcp_server(_: &tauri::AppHandle, _: &Path) -> Option<serde_json::Value> {
    None
}

#[tauri::command]
pub fn context_register_provider(
    app: tauri::AppHandle,
    command: String,
    executable: String,
) -> Result<(), String> {
    if !valid_name(&command) {
        return Err("Invalid provider command name.".into());
    }
    let executable =
        dunce::canonicalize(executable).map_err(|_| "Provider executable is unavailable.")?;
    executable_hash(&executable)?;
    locked_store(&store_path(&app)?, |store| {
        register(store, &command, &executable);
        Ok(((), true))
    })
}

#[tauri::command]
pub fn context_approve_provider(
    app: tauri::AppHandle,
    directory: String,
    expected_fingerprint: String,
) -> Result<ProviderStatus, String> {
    locked_store(&store_path(&app)?, |store| {
        approve(Path::new(&directory), store, &expected_fingerprint).map(|status| (status, true))
    })
}

#[tauri::command]
pub fn context_revoke_provider(app: tauri::AppHandle, directory: String) -> Result<(), String> {
    let removed = locked_store(&store_path(&app)?, |store| {
        let removed = revoke(Path::new(&directory), store)?;
        Ok((removed, removed))
    })?;
    #[cfg(target_os = "macos")]
    if removed {
        stop_revoked_provider(Path::new(&directory))?;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = removed;
    Ok(())
}

#[cfg(target_os = "macos")]
fn service_store_path() -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    {
        e2e_store_path()
    }
    #[cfg(not(feature = "e2e"))]
    {
        let config = dirs::config_dir().ok_or("Cannot locate Sail configuration.")?;
        Ok(config.join("sail").join("context-providers.json"))
    }
}

#[cfg(all(target_os = "macos", feature = "e2e"))]
pub fn prepare_e2e_approval(
    directory: &Path,
    command: &str,
    executable: &Path,
) -> Result<(), String> {
    let executable =
        dunce::canonicalize(executable).map_err(|_| "Provider executable is unavailable.")?;
    executable_hash(&executable)?;
    locked_store(&service_store_path()?, |store| {
        register(store, command, &executable);
        let current = status(directory, store);
        let fingerprint = current
            .fingerprint
            .ok_or_else(|| current.reason.unwrap_or("Provider unavailable.".into()))?;
        approve(directory, store, &fingerprint)?;
        Ok(((), true))
    })
}

#[cfg(all(target_os = "macos", feature = "e2e"))]
pub fn revoke_e2e_approval(directory: &Path) -> Result<(), String> {
    let removed = locked_store(&service_store_path()?, |store| {
        let changed = revoke(directory, store)?;
        Ok((changed, changed))
    })?;
    if removed {
        stop_revoked_provider(directory)?;
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn stop_revoked_provider(directory: &Path) -> Result<(), String> {
    let key = std::ffi::CString::new(project_key(directory)?)
        .map_err(|_| "Invalid context project key.".to_string())?;
    let mut error = [0_i8; 512];
    if unsafe { sail_context_provider_revoke_remote(key.as_ptr(), error.as_mut_ptr(), error.len()) }
    {
        Ok(())
    } else {
        Err(format!(
            "Approval revoked, but provider stop failed: {}",
            unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }.to_string_lossy()
        ))
    }
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
/// # Safety
///
/// `directory` and non-null `expected` must point to valid NUL-terminated strings.
/// `output` must point to a writable buffer of at least `length` bytes.
pub unsafe extern "C" fn sail_context_validate_approval(
    directory: *const std::ffi::c_char,
    expected: *const std::ffi::c_char,
    output: *mut std::ffi::c_char,
    length: usize,
) -> bool {
    use std::ffi::CStr;

    if directory.is_null() || output.is_null() || length == 0 {
        return false;
    }
    let directory = match unsafe { CStr::from_ptr(directory) }.to_str() {
        Ok(directory) => directory,
        Err(_) => return false,
    };
    let expected = if expected.is_null() {
        None
    } else {
        match unsafe { CStr::from_ptr(expected) }.to_str() {
            Ok(value) => Some(value),
            Err(_) => return false,
        }
    };
    let Ok(directory) = dunce::canonicalize(directory) else {
        return false;
    };
    let Ok(store_path) = service_store_path() else {
        return false;
    };
    let Ok(Some((project_key, fingerprint, provider))) = locked_store(&store_path, |store| {
        let current = status(&directory, store);
        if current.state != "approved"
            || expected.is_some_and(|value| current.fingerprint.as_deref() != Some(value))
        {
            return Ok((None, false));
        }
        Ok((
            Some((
                project_key(&directory)?,
                current.fingerprint.clone().unwrap(),
                current,
            )),
            false,
        ))
    }) else {
        return false;
    };
    let Ok(serialized) = serde_json::to_vec(&serde_json::json!({
        "projectKey": project_key,
        "fingerprint": fingerprint,
        "providerId": provider.id,
        "executable": provider.executable,
    })) else {
        return false;
    };
    if serialized.len() >= length {
        return false;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(serialized.as_ptr(), output.cast::<u8>(), serialized.len());
        *output.add(serialized.len()) = 0;
    }
    true
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
    fn sail_context_service_main() -> i32;
    fn sail_context_session_open(
        directory: *const std::ffi::c_char,
        error: *mut std::ffi::c_char,
        error_length: usize,
    ) -> *mut std::ffi::c_void;
    fn sail_context_session_check(
        handle: *mut std::ffi::c_void,
        error: *mut std::ffi::c_char,
        error_length: usize,
    ) -> bool;
    fn sail_context_session_close(handle: *mut std::ffi::c_void);
    fn sail_context_session_request(
        handle: *mut std::ffi::c_void,
        request: *const std::ffi::c_char,
        output: *mut std::ffi::c_char,
        output_length: usize,
        error: *mut std::ffi::c_char,
        error_length: usize,
    ) -> bool;
    fn sail_context_provider_revoke_remote(
        key: *const std::ffi::c_char,
        error: *mut std::ffi::c_char,
        error_length: usize,
    ) -> bool;
    #[cfg(feature = "e2e")]
    fn sail_context_probe_replay(
        directory: *const std::ffi::c_char,
        error: *mut std::ffi::c_char,
        error_length: usize,
    ) -> bool;
    #[cfg(feature = "e2e")]
    fn sail_context_service_unregister(error: *mut std::ffi::c_char, error_length: usize) -> bool;
}

#[cfg(target_os = "macos")]
pub fn service_main() -> i32 {
    unsafe { sail_context_service_main() }
}

#[cfg(target_os = "macos")]
pub fn is_service_process() -> bool {
    std::env::args().nth(1).as_deref() == Some("--sail-context-service")
}

#[cfg(all(target_os = "macos", feature = "e2e"))]
pub fn unregister_e2e_service() -> Result<(), String> {
    let mut error = [0_i8; 512];
    if unsafe { sail_context_service_unregister(error.as_mut_ptr(), error.len()) } {
        Ok(())
    } else {
        Err(unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }
}

#[cfg(all(target_os = "macos", feature = "e2e"))]
pub fn probe_e2e_replay(directory: &Path) -> Result<(), String> {
    let directory = std::ffi::CString::new(directory.to_string_lossy().as_bytes())
        .map_err(|_| "Invalid context directory.".to_string())?;
    let mut error = [0_i8; 512];
    if unsafe { sail_context_probe_replay(directory.as_ptr(), error.as_mut_ptr(), error.len()) } {
        Ok(())
    } else {
        Err(unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }
            .to_string_lossy()
            .into_owned())
    }
}

#[cfg(target_os = "macos")]
pub struct ContextSession(*mut std::ffi::c_void);

#[cfg(target_os = "macos")]
impl ContextSession {
    pub fn open(directory: &Path) -> Result<Self, String> {
        let directory = std::ffi::CString::new(directory.to_string_lossy().as_bytes())
            .map_err(|_| "Invalid context directory.".to_string())?;
        let mut error = [0_i8; 512];
        let handle = unsafe {
            sail_context_session_open(directory.as_ptr(), error.as_mut_ptr(), error.len())
        };
        if handle.is_null() {
            return Err(unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned());
        }
        Ok(Self(handle))
    }

    pub fn check(&self) -> Result<(), String> {
        let mut error = [0_i8; 512];
        if unsafe { sail_context_session_check(self.0, error.as_mut_ptr(), error.len()) } {
            Ok(())
        } else {
            Err(unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned())
        }
    }

    pub fn request(&self, message: &str) -> Result<Option<String>, String> {
        let message = std::ffi::CString::new(message)
            .map_err(|_| "Context MCP request contains a NUL byte.".to_string())?;
        let mut output = vec![0_i8; 1024 * 1024 + 1];
        let mut error = [0_i8; 512];
        if !unsafe {
            sail_context_session_request(
                self.0,
                message.as_ptr(),
                output.as_mut_ptr(),
                output.len(),
                error.as_mut_ptr(),
                error.len(),
            )
        } {
            return Err(unsafe { std::ffi::CStr::from_ptr(error.as_ptr()) }
                .to_string_lossy()
                .into_owned());
        }
        let value = unsafe { std::ffi::CStr::from_ptr(output.as_ptr()) }
            .to_string_lossy()
            .into_owned();
        Ok((!value.is_empty()).then_some(value))
    }
}

#[cfg(target_os = "macos")]
pub fn run_mcp_stdio(directory: &Path) -> Result<(), String> {
    use crate::context_output_store::{OutputLimits, OutputScope, OutputStore};
    use std::io::{BufRead, Write};
    let canonical = dunce::canonicalize(directory).map_err(|error| error.to_string())?;
    let provider = locked_store(&service_store_path()?, |store| {
        Ok((status(&canonical, store), false))
    })?;
    if provider.state != "approved" {
        return Err("Context provider is not approved.".into());
    }
    let provider_id = provider.id.ok_or("Context provider ID is unavailable.")?;
    let revision = provider
        .revision
        .ok_or("Context provider revision is unavailable.")?;
    let common_dir = String::from_utf8(git(&canonical, &["rev-parse", "--git-common-dir"])?)
        .map_err(|_| "Context repository path is invalid.")?;
    let common_dir = common_dir.trim();
    let repository =
        dunce::canonicalize(canonical.join(common_dir)).map_err(|error| error.to_string())?;
    let scope = OutputScope {
        repository: repository.to_string_lossy().into_owned(),
        worktree: canonical.to_string_lossy().into_owned(),
        user: unsafe { nix::libc::geteuid() }.to_string(),
        provider: provider_id.clone(),
        session: uuid::Uuid::new_v4().to_string(),
        revision,
    };
    #[cfg(feature = "e2e")]
    let data_root = PathBuf::from(
        std::env::var_os("SAIL_E2E_CONFIG_DIR")
            .ok_or("Set SAIL_E2E_CONFIG_DIR for isolated broker data.")?,
    );
    #[cfg(not(feature = "e2e"))]
    let data_root = dirs::data_dir()
        .ok_or("Cannot locate broker data directory.")?
        .join("sail");
    fs::create_dir_all(&data_root).map_err(|error| error.to_string())?;
    let store = OutputStore::open(data_root.join("context-output"), OutputLimits::default())
        .map_err(|warning| warning.message().to_owned())?;
    let broker = crate::context_broker_mcp::BrokerMcp::new(provider_id, scope, store);
    let session = ContextSession::open(directory)?;
    let input = std::io::stdin();
    let mut input = input.lock();
    let mut initialized = false;
    let mut next_id = 1_u64;
    loop {
        if input
            .fill_buf()
            .map_err(|error| error.to_string())?
            .is_empty()
        {
            break;
        }
        let line = read_bounded_line(&mut input, 1024 * 1024 + 1)?;
        let line = line.trim_end_matches(['\r', '\n']);
        if session.check().is_err() {
            break;
        }
        if let Some(response) = broker.handle(line, |method, params| {
            broker_provider_call(&session, &mut initialized, &mut next_id, method, params)
        }) {
            writeln!(std::io::stdout(), "{response}").map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn broker_provider_call(
    session: &ContextSession,
    initialized: &mut bool,
    next_id: &mut u64,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ()> {
    if !*initialized {
        let response = broker_provider_request(
            session,
            next_id,
            "initialize",
            serde_json::json!({
                "protocolVersion":"2025-06-18",
                "capabilities":{},
                "clientInfo":{"name":"sail-context","version":env!("CARGO_PKG_VERSION")}
            }),
        )?;
        if response
            .pointer("/result/protocolVersion")
            .and_then(serde_json::Value::as_str)
            != Some("2025-06-18")
        {
            return Err(());
        }
        session
            .request(r#"{"jsonrpc":"2.0","method":"notifications/initialized"}"#)
            .map_err(|_| ())?;
        *initialized = true;
    }
    broker_provider_request(session, next_id, method, params)
}

#[cfg(target_os = "macos")]
fn broker_provider_request(
    session: &ContextSession,
    next_id: &mut u64,
    method: &str,
    params: serde_json::Value,
) -> Result<serde_json::Value, ()> {
    let id = *next_id;
    *next_id = next_id.checked_add(1).ok_or(())?;
    let request = serde_json::json!({
        "jsonrpc":"2.0","id":id,"method":method,"params":params
    });
    let response = session
        .request(&request.to_string())
        .map_err(|_| ())?
        .ok_or(())?;
    response
        .lines()
        .filter_map(|line| serde_json::from_str::<serde_json::Value>(line).ok())
        .find(|value| value.get("id").and_then(serde_json::Value::as_u64) == Some(id))
        .ok_or(())
}

#[cfg(target_os = "macos")]
struct ProviderProcess {
    fingerprint: String,
    initialization: Option<serde_json::Value>,
    initialized_notification_sent: bool,
    child: std::process::Child,
    stdin: std::process::ChildStdin,
    stdout: Option<std::io::BufReader<std::process::ChildStdout>>,
    stderr_tail: std::sync::Arc<std::sync::Mutex<std::collections::VecDeque<u8>>>,
    staged_executable: Option<StagedExecutable>,
}

#[cfg(target_os = "macos")]
struct StagedExecutable(PathBuf);

#[cfg(target_os = "macos")]
impl Drop for StagedExecutable {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}

#[cfg(target_os = "macos")]
impl ProviderProcess {
    fn error(&self, reason: &str) -> String {
        let tail = self
            .stderr_tail
            .lock()
            .map(|bytes| {
                String::from_utf8_lossy(&bytes.iter().copied().collect::<Vec<_>>()).into_owned()
            })
            .unwrap_or_default();
        if tail.trim().is_empty() {
            reason.into()
        } else {
            format!("{reason} Provider stderr: {}", tail.trim())
        }
    }
}

#[cfg(target_os = "macos")]
impl Drop for ProviderProcess {
    fn drop(&mut self) {
        use nix::sys::signal::{killpg, Signal};
        use nix::unistd::Pid;
        if self.child.try_wait().ok().flatten().is_none() {
            let _ = killpg(Pid::from_raw(self.child.id() as i32), Signal::SIGKILL);
        }
        let _ = self.child.wait();
        self.staged_executable.take();
    }
}

#[cfg(target_os = "macos")]
type ProviderSlot = std::sync::Arc<std::sync::Mutex<Option<ProviderProcess>>>;

#[cfg(target_os = "macos")]
static PROVIDERS: std::sync::OnceLock<std::sync::Mutex<BTreeMap<String, Option<ProviderSlot>>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
static PROVIDER_STOPPED: std::sync::Condvar = std::sync::Condvar::new();

#[cfg(target_os = "macos")]
static ACTIVE_SESSIONS: std::sync::OnceLock<std::sync::Mutex<HashSet<String>>> =
    std::sync::OnceLock::new();

#[cfg(target_os = "macos")]
fn active_sessions() -> &'static std::sync::Mutex<HashSet<String>> {
    ACTIVE_SESSIONS.get_or_init(|| std::sync::Mutex::new(HashSet::new()))
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
/// # Safety
/// `capability` must point to a valid NUL-terminated session capability.
pub unsafe extern "C" fn sail_context_session_activate(
    capability: *const std::ffi::c_char,
) -> bool {
    if capability.is_null() {
        return false;
    }
    let Ok(capability) = unsafe { std::ffi::CStr::from_ptr(capability) }.to_str() else {
        return false;
    };
    if capability.len() != 64 {
        return false;
    }
    active_sessions()
        .lock()
        .is_ok_and(|mut sessions| sessions.insert(capability.into()))
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
/// # Safety
/// `capability` must point to a valid NUL-terminated session capability.
pub unsafe extern "C" fn sail_context_session_deactivate(capability: *const std::ffi::c_char) {
    if capability.is_null() {
        return;
    }
    let Ok(capability) = unsafe { std::ffi::CStr::from_ptr(capability) }.to_str() else {
        return;
    };
    if let Ok(mut sessions) = active_sessions().lock() {
        sessions.remove(capability);
    }
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
/// # Safety
/// `key` must point to a valid NUL-terminated project key.
pub unsafe extern "C" fn sail_context_provider_stop(key: *const std::ffi::c_char) {
    if key.is_null() {
        return;
    }
    let Ok(key) = unsafe { std::ffi::CStr::from_ptr(key) }.to_str() else {
        return;
    };
    if let Some(providers) = PROVIDERS.get() {
        if let Ok(mut providers) = providers.lock() {
            let removed = providers.get_mut(key).and_then(Option::take);
            drop(providers);
            if let Some(slot) = removed {
                let key = key.to_owned();
                std::thread::spawn(move || {
                    if let Ok(mut provider) = slot.lock() {
                        provider.take();
                    }
                    if let Some(providers) = PROVIDERS.get() {
                        if let Ok(mut providers) = providers.lock() {
                            if providers.get(&key).is_some_and(Option::is_none) {
                                providers.remove(&key);
                                PROVIDER_STOPPED.notify_all();
                            }
                        }
                    }
                });
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn forget_provider(key: &str, slot: &ProviderSlot) {
    if let Some(providers) = PROVIDERS.get() {
        if let Ok(mut providers) = providers.lock() {
            if providers
                .get(key)
                .and_then(Option::as_ref)
                .is_some_and(|current| std::sync::Arc::ptr_eq(current, slot))
            {
                providers.remove(key);
            }
        }
    }
}

#[cfg(target_os = "macos")]
fn seatbelt_literal(path: &Path) -> String {
    path.to_string_lossy()
        .replace('\\', "\\\\")
        .replace('"', "\\\"")
}

#[cfg(target_os = "macos")]
fn make_provider_stdin_nonblocking(stdin: &std::process::ChildStdin) -> Result<(), String> {
    use std::os::fd::AsRawFd;
    let fd = stdin.as_raw_fd();
    let flags = unsafe { nix::libc::fcntl(fd, nix::libc::F_GETFL) };
    if flags < 0
        || unsafe { nix::libc::fcntl(fd, nix::libc::F_SETFL, flags | nix::libc::O_NONBLOCK) } < 0
    {
        return Err(format!(
            "Cannot configure provider stdin: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn write_provider_request(
    stdin: &mut std::process::ChildStdin,
    message: &str,
    timeout: std::time::Duration,
) -> Result<(), String> {
    use std::io::Write;
    let deadline = std::time::Instant::now() + timeout;
    for bytes in [message.as_bytes(), b"\n".as_slice()] {
        let mut remaining = bytes;
        while !remaining.is_empty() {
            match stdin.write(remaining) {
                Ok(0) => return Err("Provider stdin closed before request completed.".into()),
                Ok(count) => remaining = &remaining[count..],
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    let remaining_time =
                        deadline.saturating_duration_since(std::time::Instant::now());
                    if remaining_time.is_zero() {
                        return Err("Provider stdin write timed out.".into());
                    }
                    std::thread::sleep(remaining_time.min(std::time::Duration::from_millis(10)));
                }
                Err(error) => return Err(format!("Provider stdin write failed: {error}")),
            }
        }
    }
    Ok(())
}

#[cfg(target_os = "macos")]
fn staged_provider(
    executable: &Path,
    expected_hash: &str,
    data_root: &Path,
) -> Result<Option<StagedExecutable>, String> {
    if ["/System/Library", "/usr/bin", "/bin", "/sbin"]
        .iter()
        .any(|root| executable.starts_with(root))
    {
        return Ok(None);
    }
    let staging = data_root
        .parent()
        .ok_or("Provider data directory has no parent.")?
        .join("executables");
    fs::create_dir_all(&staging).map_err(|error| error.to_string())?;
    fs::set_permissions(&staging, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let staging = dunce::canonicalize(staging).map_err(|error| error.to_string())?;
    let path = staging.join(format!("provider-{}", uuid::Uuid::new_v4()));
    fs::copy(executable, &path)
        .map_err(|error| format!("Cannot stage provider executable: {error}"))?;
    let staged = StagedExecutable(path);
    fs::set_permissions(&staged.0, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    if executable_hash(&staged.0)? != expected_hash {
        return Err("Provider executable changed before launch.".into());
    }
    Ok(Some(staged))
}

#[cfg(target_os = "macos")]
fn spawn_provider(
    directory: &Path,
    current: &ProviderStatus,
    data_root: &Path,
) -> Result<ProviderProcess, String> {
    use std::os::unix::process::CommandExt;
    let executable = PathBuf::from(
        current
            .executable
            .as_deref()
            .ok_or("Provider executable missing.")?,
    );
    fs::create_dir_all(data_root).map_err(|error| error.to_string())?;
    fs::set_permissions(data_root, fs::Permissions::from_mode(0o700))
        .map_err(|error| error.to_string())?;
    let data_root = dunce::canonicalize(data_root).map_err(|error| error.to_string())?;
    let staged = staged_provider(
        &executable,
        current
            .executable_sha256
            .as_deref()
            .ok_or("Provider hash missing.")?,
        &data_root,
    )?;
    let launch = staged
        .as_ref()
        .map_or(executable.as_path(), |value| value.0.as_path());
    let profile = format!(
        "(version 1)\n(deny default)\n(allow file-read-data (literal \"/\"))\n\
         (allow file-read* (subpath \"/System\") (subpath \"/usr/lib\") \
         (subpath \"/Library/Apple\") (literal \"{}\") \
         (subpath \"{}\") (subpath \"{}\"))\n\
         (allow file-write* (subpath \"{}\"))\n\
         (allow process-exec (literal \"{}\"))\n\
         (allow sysctl-read (sysctl-name \"kern.bootargs\") \
         (sysctl-name \"security.mac.lockdown_mode_state\"))\n",
        seatbelt_literal(launch),
        seatbelt_literal(directory),
        seatbelt_literal(&data_root),
        seatbelt_literal(&data_root),
        seatbelt_literal(launch),
    );
    if !Path::new("/usr/bin/sandbox-exec").is_file() {
        return Err("Provider confinement is unavailable on this macOS installation.".into());
    }
    let mut child = Command::new("/usr/bin/sandbox-exec")
        .arg("-p")
        .arg(profile)
        .arg(launch)
        .current_dir(directory)
        .env_clear()
        .env("HOME", &data_root)
        .env("TMPDIR", &data_root)
        .env("PATH", "/usr/bin:/bin")
        .process_group(0)
        .stdin(std::process::Stdio::piped())
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped())
        .spawn()
        .map_err(|error| format!("Provider startup failed: {error}"))?;
    let stdin = child.stdin.take().ok_or("Provider stdin unavailable.")?;
    if let Err(error) = make_provider_stdin_nonblocking(&stdin) {
        let _ = child.kill();
        let _ = child.wait();
        return Err(error);
    }
    let stdout = child.stdout.take().ok_or("Provider stdout unavailable.")?;
    let mut stderr = child.stderr.take().ok_or("Provider stderr unavailable.")?;
    let stderr_tail = std::sync::Arc::new(std::sync::Mutex::new(std::collections::VecDeque::new()));
    let tail = stderr_tail.clone();
    std::thread::spawn(move || {
        let mut buffer = [0_u8; 1024];
        while let Ok(count) = stderr.read(&mut buffer) {
            if count == 0 {
                break;
            }
            if let Ok(mut tail) = tail.lock() {
                for byte in &buffer[..count] {
                    tail.push_back(*byte);
                }
                while tail.len() > 4096 {
                    tail.pop_front();
                }
            }
        }
    });
    Ok(ProviderProcess {
        fingerprint: current
            .fingerprint
            .clone()
            .ok_or("Provider fingerprint missing.")?,
        initialization: None,
        initialized_notification_sent: false,
        child,
        stdin,
        stdout: Some(std::io::BufReader::new(stdout)),
        stderr_tail,
        staged_executable: staged,
    })
}

#[cfg(target_os = "macos")]
fn provider_request(
    directory: &Path,
    expected: &str,
    capability: &str,
    message: &str,
) -> Result<Option<String>, String> {
    #[cfg(feature = "e2e")]
    let root = PathBuf::from(
        std::env::var_os("SAIL_E2E_CONFIG_DIR")
            .ok_or("Set SAIL_E2E_CONFIG_DIR for isolated provider data.")?,
    );
    #[cfg(not(feature = "e2e"))]
    let root = dirs::data_dir()
        .ok_or("Cannot locate provider data directory.")?
        .join("sail/context-providers");
    provider_request_at(
        directory,
        expected,
        Some(capability),
        message,
        &service_store_path()?,
        &root,
    )
}

#[cfg(target_os = "macos")]
fn provider_request_at(
    directory: &Path,
    expected: &str,
    capability: Option<&str>,
    message: &str,
    store_path: &Path,
    data_root: &Path,
) -> Result<Option<String>, String> {
    use std::time::Duration;
    if message.len() > 1024 * 1024 {
        return Err("Context MCP request exceeds 1 MiB.".into());
    }
    let request: serde_json::Value =
        serde_json::from_str(message).map_err(|_| "Invalid context MCP JSON-RPC request.")?;
    if !request.is_object()
        || request.get("jsonrpc").and_then(|value| value.as_str()) != Some("2.0")
        || request
            .get("method")
            .and_then(|value| value.as_str())
            .is_none()
    {
        return Err("Invalid context MCP JSON-RPC request.".into());
    }
    let canonical = dunce::canonicalize(directory).map_err(|error| error.to_string())?;
    let key = project_key(&canonical)?;
    let providers = PROVIDERS.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()));
    let deadline = std::time::Instant::now() + Duration::from_secs(35);
    let mut registry = providers.lock().map_err(|error| error.to_string())?;
    let slot = loop {
        if let Some(slot) = registry
            .entry(key.clone())
            .or_insert_with(|| Some(std::sync::Arc::new(std::sync::Mutex::new(None))))
            .clone()
        {
            break slot;
        }
        let remaining = deadline.saturating_duration_since(std::time::Instant::now());
        if remaining.is_zero() {
            return Err("Provider stop timed out during session handoff.".into());
        }
        (registry, _) = PROVIDER_STOPPED
            .wait_timeout(registry, remaining)
            .map_err(|error| error.to_string())?;
    };
    drop(registry);
    let mut provider = slot.lock().map_err(|error| error.to_string())?;
    let session_active = || -> Result<bool, String> {
        let sessions = active_sessions()
            .lock()
            .map_err(|error| error.to_string())?;
        Ok(capability.is_none_or(|capability| sessions.contains(capability)))
    };
    if !session_active()? {
        if provider.is_none() {
            drop(provider);
            forget_provider(&key, &slot);
        }
        return Err("Context session revoked before provider request.".into());
    }
    let current = locked_store(store_path, |store| Ok((status(&canonical, store), false)))?;
    if current.state != "approved" || current.fingerprint.as_deref() != Some(expected) {
        provider.take();
        drop(provider);
        forget_provider(&key, &slot);
        return Err("Context approval changed or was revoked.".into());
    }
    let stale = provider.as_mut().is_some_and(|current| {
        current.fingerprint != expected || current.child.try_wait().ok().flatten().is_some()
    });
    if stale {
        provider.take();
    }
    if !session_active()? {
        provider.take();
        drop(provider);
        forget_provider(&key, &slot);
        return Err("Context session revoked before provider launch.".into());
    }
    if provider.is_none() {
        match spawn_provider(&canonical, &current, &data_root.join(&key)) {
            Ok(process) => *provider = Some(process),
            Err(error) => {
                drop(provider);
                forget_provider(&key, &slot);
                return Err(error);
            }
        }
    }
    if !session_active()? {
        provider.take();
        drop(provider);
        forget_provider(&key, &slot);
        return Err("Context session revoked before provider request.".into());
    }
    let process = provider.as_mut().ok_or("Provider unavailable.")?;
    let method = request
        .get("method")
        .and_then(|value| value.as_str())
        .unwrap();
    if method == "initialize" {
        if let Some(result) = &process.initialization {
            let id = request
                .get("id")
                .ok_or("MCP initialize request has no ID.")?;
            return Ok(Some(
                serde_json::json!({"jsonrpc":"2.0","id":id,"result":result}).to_string(),
            ));
        }
    }
    if method == "notifications/initialized" && process.initialized_notification_sent {
        return Ok(None);
    }
    if let Err(error) = write_provider_request(&mut process.stdin, message, Duration::from_secs(30))
    {
        let detail = process.error(&error);
        provider.take();
        drop(provider);
        forget_provider(&key, &slot);
        return Err(detail);
    }
    if request.get("id").is_none() {
        if method == "notifications/initialized" {
            process.initialized_notification_sent = true;
        }
        return Ok(None);
    }
    let reader = process
        .stdout
        .take()
        .ok_or("Provider output unavailable.")?;
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    let request_id = request.get("id").cloned();
    std::thread::spawn(move || {
        let mut reader = reader;
        let result = (|| -> Result<String, String> {
            let mut messages = String::new();
            for _ in 0..32 {
                let line = read_bounded_line(&mut reader, 1024 * 1024 - messages.len())?;
                let value: serde_json::Value = serde_json::from_str(line.trim_end())
                    .map_err(|_| "Provider returned invalid JSON-RPC.".to_string())?;
                if value.get("jsonrpc").and_then(|version| version.as_str()) != Some("2.0") {
                    return Err("Provider returned invalid JSON-RPC.".into());
                }
                let matched = value.get("id") == request_id.as_ref();
                if value.get("id").is_some() && !matched {
                    return Err("Provider response ID did not match the request.".into());
                }
                if matched && value.get("result").is_none() && value.get("error").is_none() {
                    return Err("Provider returned a request instead of a response.".into());
                }
                if !matched
                    && value
                        .get("method")
                        .and_then(|method| method.as_str())
                        .is_none()
                {
                    return Err("Provider returned an invalid notification.".into());
                }
                messages.push_str(&line);
                if matched {
                    return Ok(messages);
                }
            }
            Err("Provider sent too many messages before its response.".into())
        })();
        let _ = send.send((result, reader));
    });
    let response = match receive.recv_timeout(Duration::from_secs(30)) {
        Ok((Ok(response), reader)) => {
            process.stdout = Some(reader);
            response
        }
        Ok((Err(error), _)) => {
            let detail = process.error(&error);
            provider.take();
            drop(provider);
            forget_provider(&key, &slot);
            return Err(detail);
        }
        Err(_) => {
            let detail = process.error("Provider response timed out.");
            provider.take();
            drop(provider);
            forget_provider(&key, &slot);
            return Err(detail);
        }
    };
    if method == "initialize" {
        if let Some(result) = response
            .lines()
            .last()
            .and_then(|line| serde_json::from_str::<serde_json::Value>(line).ok())
            .and_then(|value| value.get("result").cloned())
        {
            process.initialization = Some(result);
        }
    }
    Ok(Some(response.trim_end().to_string()))
}

#[cfg(target_os = "macos")]
fn read_bounded_line(reader: &mut impl std::io::BufRead, limit: usize) -> Result<String, String> {
    let mut output = Vec::new();
    loop {
        let available = reader.fill_buf().map_err(|error| error.to_string())?;
        if available.is_empty() {
            return Err("MCP message ended before a newline.".into());
        }
        let count = available
            .iter()
            .position(|byte| *byte == b'\n')
            .map_or(available.len(), |position| position + 1);
        if output.len() + count > limit {
            return Err("MCP message exceeds 1 MiB.".into());
        }
        let done = available[count - 1] == b'\n';
        output.extend_from_slice(&available[..count]);
        reader.consume(count);
        if done {
            return String::from_utf8(output).map_err(|error| error.to_string());
        }
    }
}

#[cfg(target_os = "macos")]
#[unsafe(no_mangle)]
/// # Safety
/// All pointers must reference valid buffers of the stated lengths.
pub unsafe extern "C" fn sail_context_provider_request(
    directory: *const std::ffi::c_char,
    expected: *const std::ffi::c_char,
    capability: *const std::ffi::c_char,
    message: *const std::ffi::c_char,
    output: *mut std::ffi::c_char,
    output_length: usize,
) -> bool {
    use std::ffi::CStr;
    if directory.is_null()
        || expected.is_null()
        || capability.is_null()
        || message.is_null()
        || output.is_null()
        || output_length == 0
    {
        return false;
    }
    let result = (|| {
        let directory = unsafe { CStr::from_ptr(directory) }
            .to_str()
            .map_err(|error| error.to_string())?;
        let expected = unsafe { CStr::from_ptr(expected) }
            .to_str()
            .map_err(|error| error.to_string())?;
        let capability = unsafe { CStr::from_ptr(capability) }
            .to_str()
            .map_err(|error| error.to_string())?;
        let message = unsafe { CStr::from_ptr(message) }
            .to_str()
            .map_err(|error| error.to_string())?;
        provider_request(Path::new(directory), expected, capability, message)
    })();
    let (ok, text) = match result {
        Ok(Some(response)) => (true, response),
        Ok(None) => (true, String::new()),
        Err(error) => (false, error),
    };
    if text.len() >= output_length {
        return false;
    }
    unsafe {
        std::ptr::copy_nonoverlapping(text.as_ptr(), output.cast::<u8>(), text.len());
        *output.add(text.len()) = 0;
    }
    ok
}

#[cfg(target_os = "macos")]
impl Drop for ContextSession {
    fn drop(&mut self) {
        unsafe { sail_context_session_close(self.0) };
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    struct Repository(PathBuf);

    #[cfg(target_os = "macos")]
    struct StopProvider(String);

    #[cfg(target_os = "macos")]
    impl Drop for StopProvider {
        fn drop(&mut self) {
            let key = std::ffi::CString::new(self.0.clone()).unwrap();
            unsafe { sail_context_provider_stop(key.as_ptr()) };
        }
    }

    impl Repository {
        fn new(name: &str) -> Self {
            let path =
                std::env::temp_dir().join(format!("sail-context-{name}-{}", uuid::Uuid::new_v4()));
            fs::create_dir_all(path.join(".sail")).unwrap();
            let repository = Self(path);
            repository.run(&["init", "-q"]);
            repository.run(&["config", "user.name", "Sail Test"]);
            repository.run(&["config", "user.email", "sail-test@example.invalid"]);
            repository
        }

        fn run(&self, args: &[&str]) {
            let output = Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "git {args:?}: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        fn write(&self, path: &str, text: &str) {
            let path = self.0.join(path);
            fs::create_dir_all(path.parent().unwrap()).unwrap();
            fs::write(path, text).unwrap();
        }

        fn commit(&self) {
            self.run(&["add", "."]);
            self.run(&["commit", "-qm", "fixture"]);
        }

        fn configure(&self) {
            self.write(CONFIG, r#"{"context":{"manifest":".sail/context.json"}}"#);
            self.write(
                ".sail/context.json",
                &json!({
                    "version":1,
                    "providers":[{"id":"project-files","type":"stdio","command":"fixture-provider","capabilities":["search","get"]}]
                })
                .to_string(),
            );
            self.commit();
        }

        #[cfg(target_os = "macos")]
        fn provider_fixture(&self) -> PathBuf {
            let executable = self.0.join("provider");
            let source =
                Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/fixtures/context-provider.c");
            assert!(Command::new("cc")
                .args(["-o"])
                .arg(&executable)
                .arg(source)
                .status()
                .unwrap()
                .success());
            assert!(Command::new("codesign")
                .args(["--force", "--sign", "-"])
                .arg(&executable)
                .status()
                .unwrap()
                .success());
            dunce::canonicalize(executable).unwrap()
        }
    }

    impl Drop for Repository {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn executable(root: &Path, contents: &str) -> PathBuf {
        let path = root.join("fixture-provider");
        fs::write(&path, contents).unwrap();
        #[cfg(unix)]
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    fn registered(repository: &Repository) -> ApprovalStore {
        let path = executable(&repository.0, "provider-v1");
        ApprovalStore {
            registry: BTreeMap::from([(
                "fixture-provider".into(),
                path.to_string_lossy().into_owned(),
            )]),
            approvals: BTreeMap::new(),
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn confined_provider_can_exchange_a_bounded_mcp_line() {
        let repository = Repository::new("confined-provider");
        repository.configure();
        let executable = repository.provider_fixture();
        let current = ProviderStatus {
            state: "approved".into(),
            id: Some("fixture".into()),
            command: Some("fixture".into()),
            executable: Some(executable.to_string_lossy().into_owned()),
            executable_sha256: Some(executable_hash(&executable).unwrap()),
            capabilities: vec!["get".into()],
            fingerprint: Some("fixture-fingerprint".into()),
            revision: None,
            reason: None,
        };
        let mut provider =
            spawn_provider(&repository.0, &current, &repository.0.join("data")).unwrap();
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"write"}"#;
        write_provider_request(
            &mut provider.stdin,
            request,
            std::time::Duration::from_secs(1),
        )
        .unwrap();
        let response = read_bounded_line(provider.stdout.as_mut().unwrap(), 1024)
            .unwrap_or_else(|error| panic!("{}", provider.error(&error)));
        let response: serde_json::Value = serde_json::from_str(&response).unwrap();
        assert_eq!(response["id"], 1);
        assert!(response["result"]["pid"].as_i64().unwrap() > 0);
        assert!(repository.0.join("data/written").exists());
        assert!(read_bounded_line(&mut std::io::Cursor::new(vec![b'x'; 5]), 4).is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn provider_requests_track_committed_approval_and_stop_after_change() {
        let repository = Repository::new("runtime-approval");
        repository.configure();
        let key = project_key(&repository.0).unwrap();
        let _stop = StopProvider(key.clone());
        let store_path = repository.0.join("approvals.json");
        let executable = repository.provider_fixture();
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let call = || {
            provider_request_at(
                &repository.0,
                &fingerprint,
                None,
                request,
                &store_path,
                &repository.0.join("data"),
            )
        };
        let first: serde_json::Value = serde_json::from_str(&call().unwrap().unwrap()).unwrap();
        assert_eq!(first["id"], 1);
        repository.write(
            ".sail/context.json",
            r#"{"version":1,"providers":[{"id":"project-files","type":"stdio","command":"fixture-provider","capabilities":["execute"]}]}"#,
        );
        let second: serde_json::Value = serde_json::from_str(&call().unwrap().unwrap()).unwrap();
        assert_eq!(first["result"]["pid"], second["result"]["pid"]);
        repository.commit();
        assert!(call().unwrap_err().contains("approval changed"));
        assert!(!PROVIDERS.get().unwrap().lock().unwrap().contains_key(&key));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn second_agent_reuses_provider_initialization() {
        let repository = Repository::new("runtime-initialize");
        repository.configure();
        let key = project_key(&repository.0).unwrap();
        let _stop = StopProvider(key);
        let store_path = repository.0.join("approvals.json");
        let executable = repository.provider_fixture();
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let call = |id| {
            provider_request_at(
                &repository.0,
                &fingerprint,
                None,
                &format!(r#"{{"jsonrpc":"2.0","id":{id},"method":"initialize"}}"#),
                &store_path,
                &repository.0.join("data"),
            )
            .unwrap()
            .unwrap()
        };
        let first: serde_json::Value = serde_json::from_str(&call(1)).unwrap();
        let second: serde_json::Value = serde_json::from_str(&call(2)).unwrap();
        assert_eq!(first["id"], 1);
        assert_eq!(second["id"], 2);
        assert_eq!(first["result"]["pid"], second["result"]["pid"]);
        assert_eq!(first["result"]["initializeCount"], 1);
        assert_eq!(second["result"]["initializeCount"], 1);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn provider_startup_failure_returns_an_error_without_a_live_process() {
        let repository = Repository::new("runtime-startup");
        repository.configure();
        let key = project_key(&repository.0).unwrap();
        let _stop = StopProvider(key.clone());
        let store_path = repository.0.join("approvals.json");
        let executable = dunce::canonicalize("/usr/bin/false").unwrap();
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let result = provider_request_at(
            &repository.0,
            &fingerprint,
            None,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
            &store_path,
            &repository.0.join("data"),
        );
        assert!(result.is_err());
        assert!(!PROVIDERS.get().unwrap().lock().unwrap().contains_key(&key));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn provider_spawn_failure_releases_project_slot() {
        let repository = Repository::new("runtime-spawn-failure");
        repository.configure();
        let key = project_key(&repository.0).unwrap();
        let _stop = StopProvider(key.clone());
        let store_path = repository.0.join("approvals.json");
        let executable = repository.provider_fixture();
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let data_root = repository.0.join("file-instead-of-directory");
        fs::write(&data_root, "occupied").unwrap();
        let error = provider_request_at(
            &repository.0,
            &fingerprint,
            None,
            r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
            &store_path,
            &data_root,
        )
        .unwrap_err();
        assert!(error.contains("Not a directory") || error.contains("not a directory"));
        assert!(!PROVIDERS.get().unwrap().lock().unwrap().contains_key(&key));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn executable_replacement_revokes_a_live_provider() {
        let repository = Repository::new("runtime-executable-change");
        repository.configure();
        let key = project_key(&repository.0).unwrap();
        let _stop = StopProvider(key.clone());
        let store_path = repository.0.join("approvals.json");
        let executable = repository.0.join("provider");
        repository.provider_fixture();
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let request = r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#;
        let call = || {
            provider_request_at(
                &repository.0,
                &fingerprint,
                None,
                request,
                &store_path,
                &repository.0.join("data"),
            )
        };
        let response: serde_json::Value = serde_json::from_str(&call().unwrap().unwrap()).unwrap();
        assert_eq!(response["id"], 1);
        let replacement = repository.0.join("replacement");
        fs::copy("/usr/bin/false", &replacement).unwrap();
        fs::rename(replacement, executable).unwrap();
        assert!(call().unwrap_err().contains("approval changed"));
        assert!(!PROVIDERS.get().unwrap().lock().unwrap().contains_key(&key));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn executable_replacement_between_check_and_launch_is_rejected() {
        let repository = Repository::new("runtime-launch-race");
        repository.configure();
        let executable = repository.provider_fixture();
        let store_path = repository.0.join("approvals.json");
        let current = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((status(&repository.0, store), true))
        })
        .unwrap();
        let replacement = repository.0.join("replacement");
        fs::copy("/usr/bin/false", &replacement).unwrap();
        fs::rename(replacement, executable).unwrap();
        let error = spawn_provider(&repository.0, &current, &repository.0.join("data"))
            .err()
            .unwrap();
        assert!(error.contains("changed before launch"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stopping_a_busy_provider_does_not_wait_on_its_project_lock() {
        let repository = Repository::new("runtime-stop-busy");
        repository.configure();
        let key = project_key(&repository.0).unwrap();
        let _stop = StopProvider(key.clone());
        let executable = repository.provider_fixture();
        let store_path = repository.0.join("approvals.json");
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let slot: ProviderSlot = std::sync::Arc::new(std::sync::Mutex::new(None));
        PROVIDERS
            .get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
            .lock()
            .unwrap()
            .insert(key.clone(), Some(slot.clone()));
        let guard = slot.lock().unwrap();
        let key = std::ffi::CString::new(key).unwrap();
        let start = std::time::Instant::now();
        unsafe { sail_context_provider_stop(key.as_ptr()) };
        assert!(start.elapsed() < std::time::Duration::from_millis(100));
        assert!(PROVIDERS
            .get()
            .unwrap()
            .lock()
            .unwrap()
            .get(key.to_str().unwrap())
            .is_some_and(Option::is_none));
        std::thread::scope(|scope| {
            let (send, receive) = std::sync::mpsc::channel();
            scope.spawn(move || {
                let result = provider_request_at(
                    &repository.0,
                    &fingerprint,
                    None,
                    r#"{"jsonrpc":"2.0","id":1,"method":"initialize"}"#,
                    &store_path,
                    &repository.0.join("data"),
                );
                send.send(result).unwrap();
            });
            assert!(receive
                .recv_timeout(std::time::Duration::from_millis(30))
                .is_err());
            drop(guard);
            let response = receive
                .recv_timeout(std::time::Duration::from_secs(2))
                .unwrap()
                .unwrap()
                .unwrap();
            let value: serde_json::Value = serde_json::from_str(&response).unwrap();
            assert_eq!(value["id"], 1);
        });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stalled_provider_stdin_does_not_block_session_close() {
        use std::os::unix::process::CommandExt;

        let repository = Repository::new("runtime-stalled-stdin");
        repository.configure();
        let store_path = repository.0.join("approvals.json");
        let executable = dunce::canonicalize("/usr/bin/yes").unwrap();
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let key = project_key(&repository.0).unwrap();
        let mut child = Command::new(&executable)
            .process_group(0)
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .stderr(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let stdin = child.stdin.take().unwrap();
        make_provider_stdin_nonblocking(&stdin).unwrap();
        let pid = child.id() as i32;
        let slot: ProviderSlot =
            std::sync::Arc::new(std::sync::Mutex::new(Some(ProviderProcess {
                fingerprint: fingerprint.clone(),
                initialization: None,
                initialized_notification_sent: false,
                stdout: Some(std::io::BufReader::new(child.stdout.take().unwrap())),
                child,
                stdin,
                stderr_tail: std::sync::Arc::new(std::sync::Mutex::new(
                    std::collections::VecDeque::new(),
                )),
                staged_executable: None,
            })));
        PROVIDERS
            .get_or_init(|| std::sync::Mutex::new(BTreeMap::new()))
            .lock()
            .unwrap()
            .insert(key, Some(slot.clone()));
        let capability = sha256(uuid::Uuid::new_v4().as_bytes());
        let capability_c = std::ffi::CString::new(capability.clone()).unwrap();
        assert!(unsafe { sail_context_session_activate(capability_c.as_ptr()) });
        let request = serde_json::json!({"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"payload":"x".repeat(900_000)}}).to_string();
        let directory = repository.0.clone();
        let data_root = repository.0.join("data");
        let worker = std::thread::spawn(move || {
            provider_request_at(
                &directory,
                &fingerprint,
                Some(&capability),
                &request,
                &store_path,
                &data_root,
            )
        });
        let start = std::time::Instant::now();
        while slot.try_lock().is_ok() && start.elapsed() < std::time::Duration::from_secs(2) {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        let entered_slot = slot.try_lock().is_err();
        std::thread::sleep(std::time::Duration::from_millis(100));
        let start = std::time::Instant::now();
        unsafe { sail_context_session_deactivate(capability_c.as_ptr()) };
        let close_elapsed = start.elapsed();
        let _ = nix::sys::signal::killpg(
            nix::unistd::Pid::from_raw(pid),
            nix::sys::signal::Signal::SIGKILL,
        );
        assert!(
            entered_slot,
            "Provider request did not enter its project slot"
        );
        assert!(close_elapsed < std::time::Duration::from_millis(100));
        assert!(worker.join().unwrap().is_err());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn provider_stdin_write_times_out_when_unread() {
        let mut child = Command::new("/usr/bin/yes")
            .stdin(std::process::Stdio::piped())
            .stdout(std::process::Stdio::piped())
            .spawn()
            .unwrap();
        let mut stdin = child.stdin.take().unwrap();
        make_provider_stdin_nonblocking(&stdin).unwrap();
        let error = write_provider_request(
            &mut stdin,
            &"x".repeat(900_000),
            std::time::Duration::from_millis(50),
        )
        .unwrap_err();
        child.kill().unwrap();
        child.wait().unwrap();
        assert!(error.contains("timed out"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn queued_request_does_not_launch_after_session_closes() {
        let repository = Repository::new("runtime-queued-revocation");
        repository.configure();
        let key = project_key(&repository.0).unwrap();
        let store_path = repository.0.join("approvals.json");
        let executable = dunce::canonicalize("/bin/cat").unwrap();
        let fingerprint = locked_store(&store_path, |store| {
            register(store, "fixture-provider", &executable);
            let fingerprint = status(&repository.0, store).fingerprint.unwrap();
            approve(&repository.0, store, &fingerprint)?;
            Ok((fingerprint, true))
        })
        .unwrap();
        let capability = sha256(uuid::Uuid::new_v4().as_bytes());
        let capability_c = std::ffi::CString::new(capability.clone()).unwrap();
        assert!(unsafe { sail_context_session_activate(capability_c.as_ptr()) });
        let providers = PROVIDERS.get_or_init(|| std::sync::Mutex::new(BTreeMap::new()));
        let guard = providers.lock().unwrap();
        let (started, waiting) = std::sync::mpsc::channel();
        let directory = repository.0.clone();
        let data_root = directory.join("data");
        let worker = std::thread::spawn(move || {
            started.send(()).unwrap();
            provider_request_at(
                &directory,
                &fingerprint,
                Some(&capability),
                r#"{"jsonrpc":"2.0","id":1,"method":"ping"}"#,
                &store_path,
                &data_root,
            )
        });
        waiting.recv().unwrap();
        unsafe { sail_context_session_deactivate(capability_c.as_ptr()) };
        drop(guard);
        assert!(worker
            .join()
            .unwrap()
            .unwrap_err()
            .contains("session revoked"));
        assert!(!providers.lock().unwrap().contains_key(&key));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn stalled_provider_does_not_block_another_project() {
        let slow = Repository::new("runtime-slow-project");
        let fast = Repository::new("runtime-fast-project");
        slow.configure();
        fast.configure();
        let slow_executable = slow.provider_fixture();
        let fast_executable = fast.provider_fixture();
        let configure = |repository: &Repository, executable: &Path| {
            let store_path = repository.0.join("approvals.json");
            let fingerprint = locked_store(&store_path, |store| {
                register(store, "fixture-provider", executable);
                let fingerprint = status(&repository.0, store).fingerprint.unwrap();
                approve(&repository.0, store, &fingerprint)?;
                Ok((fingerprint, true))
            })
            .unwrap();
            (store_path, fingerprint)
        };
        let (slow_store, slow_fingerprint) = configure(&slow, &slow_executable);
        let (fast_store, fast_fingerprint) = configure(&fast, &fast_executable);
        let slow_key = project_key(&slow.0).unwrap();
        let fast_key = project_key(&fast.0).unwrap();
        let _stop_slow = StopProvider(slow_key.clone());
        let _stop_fast = StopProvider(fast_key);
        let slow_data = slow.0.join("data");
        let slow_dir = slow.0.clone();
        let worker = std::thread::spawn(move || {
            provider_request_at(
                &slow_dir,
                &slow_fingerprint,
                None,
                r#"{"jsonrpc":"2.0","id":1,"method":"slow"}"#,
                &slow_store,
                &slow_data,
            )
        });
        std::thread::sleep(std::time::Duration::from_millis(500));
        assert!(
            !worker.is_finished(),
            "slow provider finished before fast request"
        );
        let start = std::time::Instant::now();
        let response = provider_request_at(
            &fast.0,
            &fast_fingerprint,
            None,
            r#"{"jsonrpc":"2.0","id":2,"method":"tools/list"}"#,
            &fast_store,
            &fast.0.join("data"),
        )
        .unwrap();
        assert!(response.is_some());
        assert!(start.elapsed() < std::time::Duration::from_millis(1500));
        assert!(worker.join().unwrap().is_ok());
    }

    #[test]
    fn absent_pointer_is_not_configured_but_missing_manifest_is_invalid() {
        let repository = Repository::new("missing");
        repository.write(CONFIG, "{}");
        repository.commit();
        assert_eq!(
            status(&repository.0, &ApprovalStore::default()).state,
            "not-configured"
        );
        repository.write(CONFIG, r#"{"context":{"manifest":".sail/context.json"}}"#);
        repository.commit();
        let status = status(&repository.0, &ApprovalStore::default());
        assert_eq!(status.state, "invalid");
        assert!(status.reason.unwrap().contains("missing"));
    }

    #[test]
    fn dirty_and_staged_config_remain_inactive() {
        let repository = Repository::new("dirty");
        repository.configure();
        let original = committed_provider(&repository.0).unwrap().unwrap();
        repository.write(
            ".sail/context.json",
            r#"{"version":1,"providers":[{"id":"bad","type":"stdio","command":"bad","capabilities":["execute"]}]}"#,
        );
        assert_eq!(
            committed_provider(&repository.0).unwrap().unwrap().spec.id,
            original.spec.id
        );
        repository.run(&["add", ".sail/context.json"]);
        assert_eq!(
            committed_provider(&repository.0).unwrap().unwrap().spec.id,
            original.spec.id
        );
    }

    #[test]
    fn pinned_revision_cannot_mix_commits_and_missing_head_is_invalid() {
        let repository = Repository::new("pinned");
        assert_eq!(
            status(&repository.0, &ApprovalStore::default()).state,
            "invalid"
        );
        repository.configure();
        let pinned = String::from_utf8(git(&repository.0, &["rev-parse", "HEAD"]).unwrap())
            .unwrap()
            .trim()
            .to_string();
        repository.write(
            ".sail/context.json",
            r#"{"version":1,"providers":[{"id":"new-provider","type":"stdio","command":"fixture-provider","capabilities":["get"]}]}"#,
        );
        repository.commit();
        assert_eq!(
            committed_provider_at(&repository.0, &pinned)
                .unwrap()
                .unwrap()
                .spec
                .id,
            "project-files"
        );
        assert_eq!(
            committed_provider(&repository.0).unwrap().unwrap().spec.id,
            "new-provider"
        );
    }

    #[cfg(unix)]
    #[test]
    fn committed_symlink_is_rejected() {
        let repository = Repository::new("symlink");
        repository.write(CONFIG, r#"{"context":{"manifest":".sail/context.json"}}"#);
        std::os::unix::fs::symlink("other.json", repository.0.join(".sail/context.json")).unwrap();
        repository.commit();
        assert!(committed_provider(&repository.0)
            .unwrap_err()
            .contains("symlink"));
    }

    #[test]
    fn invalid_paths_and_capabilities_do_not_resolve() {
        let repository = Repository::new("invalid");
        repository.write(CONFIG, r#"{"context":{"manifest":"../secret.json"}}"#);
        repository.commit();
        assert!(committed_provider(&repository.0)
            .unwrap_err()
            .contains(".sail"));
        repository.write(CONFIG, r#"{"context":{"manifest":".sail/context.json"}}"#);
        repository.write(
            ".sail/context.json",
            r#"{"version":1,"providers":[{"id":"bad","type":"stdio","command":"fixture-provider","capabilities":["search","search"]}]}"#,
        );
        repository.commit();
        assert!(committed_provider(&repository.0)
            .unwrap_err()
            .contains("duplicated"));
    }

    #[test]
    fn approval_rejects_stale_identity_and_is_project_scoped() {
        let first = Repository::new("approval-first");
        let second = Repository::new("approval-second");
        first.configure();
        second.configure();
        let mut store = registered(&first);
        let first_status = status(&first.0, &store);
        assert_eq!(first_status.state, "approval-required");
        let fingerprint = first_status.fingerprint.unwrap();
        let path = first.0.join("fixture-provider");
        fs::write(&path, "provider-v2").unwrap();
        assert!(approve(&first.0, &mut store, &fingerprint).is_err());
        let next = status(&first.0, &store).fingerprint.unwrap();
        assert_eq!(
            approve(&first.0, &mut store, &next).unwrap().state,
            "approved"
        );
        assert_eq!(status(&first.0, &store).state, "approved");
        assert_ne!(status(&second.0, &store).state, "approved");
        first.write("README.md", "unrelated change");
        first.commit();
        assert_eq!(status(&first.0, &store).state, "approved");
        first.write(
            ".sail/context.json",
            r#"{"version":1,"providers":[{"id":"project-files","type":"stdio","command":"fixture-provider","capabilities":["execute"]}]}"#,
        );
        first.commit();
        assert_eq!(status(&first.0, &store).state, "approval-required");
        first.write(
            ".sail/context.json",
            r#"{"version":1,"providers":[{"id":"project-files","type":"stdio","command":"fixture-provider","capabilities":["search","get"]}]}"#,
        );
        first.commit();
        assert_eq!(status(&first.0, &store).state, "approval-required");
    }

    #[test]
    fn approval_does_not_survive_context_change_hidden_by_merge() {
        let repository = Repository::new("merge-history");
        repository.configure();
        let mut store = registered(&repository);
        let fingerprint = status(&repository.0, &store).fingerprint.unwrap();
        approve(&repository.0, &mut store, &fingerprint).unwrap();

        repository.run(&["switch", "-c", "changed"]);
        repository.write(
            ".sail/context.json",
            r#"{"version":1,"providers":[{"id":"project-files","type":"stdio","command":"fixture-provider","capabilities":["execute"]}]}"#,
        );
        repository.commit();
        repository.run(&["switch", "-"]);
        repository.write("README.md", "unrelated work");
        repository.commit();
        repository.run(&[
            "merge",
            "--no-ff",
            "-s",
            "ours",
            "changed",
            "-m",
            "restore context",
        ]);
        executable(&repository.0, "provider-v1");

        let current = status(&repository.0, &store);
        assert_eq!(current.state, "approval-required", "{:?}", current.reason);
    }

    #[test]
    fn revoking_without_a_current_manifest_does_not_restore_old_approval() {
        let repository = Repository::new("revoke-no-manifest");
        repository.configure();
        let mut store = registered(&repository);
        let fingerprint = status(&repository.0, &store).fingerprint.unwrap();
        approve(&repository.0, &mut store, &fingerprint).unwrap();

        repository.run(&["switch", "-c", "without-context"]);
        repository.write(CONFIG, "{}");
        repository.commit();
        assert_eq!(status(&repository.0, &store).state, "not-configured");
        assert!(revoke(&repository.0, &mut store).unwrap());
        repository.run(&["switch", "-"]);
        executable(&repository.0, "provider-v1");

        let current = status(&repository.0, &store);
        assert_eq!(current.state, "approval-required", "{:?}", current.reason);
    }

    #[test]
    fn registering_executable_again_revokes_its_existing_approvals() {
        let repository = Repository::new("register-revokes");
        repository.configure();
        let mut store = registered(&repository);
        let fingerprint = status(&repository.0, &store).fingerprint.unwrap();
        approve(&repository.0, &mut store, &fingerprint).unwrap();
        let executable = repository.0.join("fixture-provider");

        register(&mut store, "fixture-provider", &executable);

        assert_eq!(status(&repository.0, &store).state, "approval-required");
    }

    #[test]
    fn failed_store_write_preserves_previous_approval() {
        let repository = Repository::new("store-failure");
        let path = repository.0.join("approvals.json");
        locked_store(&path, |store| {
            store.approvals.insert(
                "first".into(),
                Approval {
                    fingerprint: "approved".into(),
                    revision: "first".into(),
                    command: "fixture-provider".into(),
                },
            );
            Ok(((), true))
        })
        .unwrap();
        fs::create_dir(path.with_extension("json.tmp")).unwrap();
        assert!(locked_store(&path, |store| {
            store.approvals.insert(
                "second".into(),
                Approval {
                    fingerprint: "not-approved".into(),
                    revision: "second".into(),
                    command: "fixture-provider".into(),
                },
            );
            Ok(((), true))
        })
        .is_err());
        let saved: ApprovalStore = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(
            saved
                .approvals
                .get("first")
                .map(|record| record.fingerprint.as_str()),
            Some("approved")
        );
        assert!(!saved.approvals.contains_key("second"));
    }

    #[test]
    fn concurrent_store_updates_are_serialized() {
        let repository = Repository::new("concurrent");
        let path = repository.0.join("approvals.json");
        std::thread::scope(|scope| {
            for index in 0..8 {
                let path = path.clone();
                scope.spawn(move || {
                    locked_store(&path, |store| {
                        store.approvals.insert(
                            index.to_string(),
                            Approval {
                                fingerprint: index.to_string(),
                                revision: "fixture".into(),
                                command: "fixture-provider".into(),
                            },
                        );
                        Ok(((), true))
                    })
                    .unwrap();
                });
            }
        });
        let saved: ApprovalStore = serde_json::from_slice(&fs::read(path).unwrap()).unwrap();
        assert_eq!(saved.approvals.len(), 8);
    }
}
