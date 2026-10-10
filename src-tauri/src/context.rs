use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashSet};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Write};
#[cfg(unix)]
use std::os::unix::fs::PermissionsExt;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
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

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(root) = std::env::var_os("SAIL_E2E_CONFIG_DIR") {
        return Ok(PathBuf::from(root).join("context-providers.json"));
    }
    let config = app
        .path()
        .config_dir()
        .map_err(|error| format!("Cannot locate Sail configuration: {error}"))?;
    Ok(config.join("sail").join("context-providers.json"))
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
    locked_store(&store_path(&app)?, |store| {
        let removed = revoke(Path::new(&directory), store)?;
        Ok(((), removed))
    })
}

#[cfg(target_os = "macos")]
fn service_store_path() -> Result<PathBuf, String> {
    #[cfg(feature = "e2e")]
    if let Some(root) = std::env::var_os("SAIL_E2E_CONFIG_DIR") {
        return Ok(PathBuf::from(root).join("context-providers.json"));
    }
    let config = dirs::config_dir().ok_or("Cannot locate Sail configuration.")?;
    Ok(config.join("sail").join("context-providers.json"))
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
    locked_store(&service_store_path()?, |store| {
        let changed = revoke(directory, store)?;
        Ok(((), changed))
    })
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
    let Ok(Some((project_key, fingerprint))) = locked_store(&store_path, |store| {
        let current = status(&directory, store);
        if current.state != "approved"
            || expected.is_some_and(|value| current.fingerprint.as_deref() != Some(value))
        {
            return Ok((None, false));
        }
        Ok((
            Some((project_key(&directory)?, current.fingerprint.unwrap())),
            false,
        ))
    }) else {
        return false;
    };
    let Ok(serialized) = serde_json::to_vec(&serde_json::json!({
        "projectKey": project_key,
        "fingerprint": fingerprint,
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
