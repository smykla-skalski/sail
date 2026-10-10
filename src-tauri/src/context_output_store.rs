use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::fs::{self, File, OpenOptions};
use std::io::{Read, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};
use uuid::Uuid;

const HEADER_LIMIT: usize = 4_096;
const ABSOLUTE_ITEM_LIMIT: usize = 16 * 1024 * 1024;
const ABSOLUTE_READ_LIMIT: usize = 64 * 1024;
const ABSOLUTE_ITEM_COUNT: usize = 1_024;
const ABSOLUTE_STORE_LIMIT: u64 = 256 * 1024 * 1024;
const ABSOLUTE_SCOPE_COUNT: usize = 1_024;
const ABSOLUTE_RETENTION_SECONDS: u64 = 365 * 24 * 60 * 60;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct OutputScope {
    pub repository: String,
    pub worktree: String,
    pub user: String,
    pub provider: String,
    pub session: String,
    pub revision: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutputLimits {
    pub max_item_bytes: usize,
    pub max_total_bytes: u64,
    pub max_items: usize,
    pub max_read_bytes: usize,
    pub summary_bytes: usize,
    pub retention_seconds: u64,
}

impl Default for OutputLimits {
    fn default() -> Self {
        Self {
            max_item_bytes: 8 * 1024 * 1024,
            max_total_bytes: 128 * 1024 * 1024,
            max_items: 512,
            max_read_bytes: 32 * 1024,
            summary_bytes: 256,
            retention_seconds: 7 * 24 * 60 * 60,
        }
    }
}

impl OutputLimits {
    fn validate(self) -> Result<Self, StoreWarning> {
        if self.max_item_bytes == 0
            || self.max_item_bytes > ABSOLUTE_ITEM_LIMIT
            || self.max_total_bytes == 0
            || self.max_total_bytes > ABSOLUTE_STORE_LIMIT
            || self.max_items == 0
            || self.max_items > ABSOLUTE_ITEM_COUNT
            || self.max_read_bytes == 0
            || self.max_read_bytes > ABSOLUTE_READ_LIMIT
            || self.summary_bytes > 512
            || self.retention_seconds == 0
            || self.retention_seconds > ABSOLUTE_RETENTION_SECONDS
        {
            return Err(StoreWarning::InvalidLimits);
        }
        Ok(self)
    }
}

/// A fixed, non-content-bearing warning safe to show when storage fails.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum StoreWarning {
    InvalidLimits,
    InvalidScope,
    TooLarge,
    QuotaExceeded,
    InvalidReference,
    NotFound,
    ReadLimitExceeded,
    StorageUnavailable,
}

impl StoreWarning {
    pub fn message(self) -> &'static str {
        match self {
            Self::InvalidLimits => "Output storage limits are invalid.",
            Self::InvalidScope => "Output storage scope is invalid.",
            Self::TooLarge => "Output exceeds the configured storage item limit.",
            Self::QuotaExceeded => "Output storage quota is full.",
            Self::InvalidReference => "Output reference is invalid.",
            Self::NotFound => "Output is unavailable in this scope.",
            Self::ReadLimitExceeded => "Requested output section exceeds the read limit.",
            Self::StorageUnavailable => "Output storage is unavailable.",
        }
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct StoredOutput {
    pub reference: String,
    pub bytes: u64,
    pub sha256: String,
    pub summary: String,
    pub expires_at_ms: u64,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OutputSection {
    pub bytes: Vec<u8>,
    pub offset: u64,
    pub total_bytes: u64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct OutputUsage {
    pub items: usize,
    pub bytes: u64,
}

#[derive(Clone, Debug)]
pub struct OutputStore {
    root: PathBuf,
    limits: OutputLimits,
}

#[derive(Deserialize, Serialize)]
struct RecordHeader {
    version: u8,
    scope: String,
    id: String,
    created_at_ms: u64,
    expires_at_ms: u64,
    bytes: u64,
    sha256: String,
    summary: String,
}

struct Record {
    header: RecordHeader,
    data_offset: u64,
}

fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}

fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|byte| format!("{byte:02x}")).collect()
}

fn now_ms() -> Result<u64, StoreWarning> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| StoreWarning::StorageUnavailable)?;
    u64::try_from(elapsed.as_millis()).map_err(|_| StoreWarning::StorageUnavailable)
}

fn private_directory(path: &Path) -> Result<(), StoreWarning> {
    match fs::symlink_metadata(path) {
        Ok(metadata) if !metadata.is_dir() || metadata.file_type().is_symlink() => {
            return Err(StoreWarning::StorageUnavailable);
        }
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            fs::create_dir(path).map_err(|_| StoreWarning::StorageUnavailable)?;
        }
        Err(_) => return Err(StoreWarning::StorageUnavailable),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))
            .map_err(|_| StoreWarning::StorageUnavailable)?;
    }
    Ok(())
}

fn private_file(path: &Path) -> Result<File, StoreWarning> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
    }
    options
        .open(path)
        .map_err(|_| StoreWarning::StorageUnavailable)
}

fn open_record(path: &Path) -> Result<(File, Record), StoreWarning> {
    let entry = fs::symlink_metadata(path).map_err(|_| StoreWarning::NotFound)?;
    if !entry.is_file() || entry.file_type().is_symlink() {
        return Err(StoreWarning::StorageUnavailable);
    }
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(nix::libc::O_NOFOLLOW);
    }
    let mut file = options
        .open(path)
        .map_err(|_| StoreWarning::StorageUnavailable)?;
    let metadata = file
        .metadata()
        .map_err(|_| StoreWarning::StorageUnavailable)?;
    if !metadata.is_file() {
        return Err(StoreWarning::StorageUnavailable);
    }
    let mut prefix = Vec::with_capacity(HEADER_LIMIT);
    Read::by_ref(&mut file)
        .take(HEADER_LIMIT as u64)
        .read_to_end(&mut prefix)
        .map_err(|_| StoreWarning::StorageUnavailable)?;
    let line_end = prefix
        .iter()
        .position(|byte| *byte == b'\n')
        .ok_or(StoreWarning::StorageUnavailable)?;
    let header: RecordHeader = serde_json::from_slice(&prefix[..line_end])
        .map_err(|_| StoreWarning::StorageUnavailable)?;
    let data_offset = u64::try_from(line_end + 1).map_err(|_| StoreWarning::StorageUnavailable)?;
    if header.version != 1
        || header.bytes > ABSOLUTE_ITEM_LIMIT as u64
        || metadata.len() != data_offset.saturating_add(header.bytes)
        || header.id.len() != 36
        || Uuid::parse_str(&header.id).is_err()
    {
        return Err(StoreWarning::StorageUnavailable);
    }
    Ok((
        file,
        Record {
            header,
            data_offset,
        },
    ))
}

impl OutputScope {
    fn key(&self) -> Result<String, StoreWarning> {
        for value in [
            &self.repository,
            &self.worktree,
            &self.user,
            &self.provider,
            &self.session,
            &self.revision,
        ] {
            if value.is_empty() || value.len() > 1_024 || value.chars().any(char::is_control) {
                return Err(StoreWarning::InvalidScope);
            }
        }
        let encoded = serde_json::to_vec(self).map_err(|_| StoreWarning::InvalidScope)?;
        Ok(digest(&encoded))
    }
}

impl OutputStore {
    pub fn open(root: PathBuf, limits: OutputLimits) -> Result<Self, StoreWarning> {
        let limits = limits.validate()?;
        private_directory(&root)?;
        Ok(Self { root, limits })
    }

    fn lock(&self) -> Result<File, StoreWarning> {
        private_directory(&self.root)?;
        let path = self.root.join(".lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600).custom_flags(nix::libc::O_NOFOLLOW);
        }
        let file = options
            .open(path)
            .map_err(|_| StoreWarning::StorageUnavailable)?;
        if !file
            .metadata()
            .map_err(|_| StoreWarning::StorageUnavailable)?
            .is_file()
        {
            return Err(StoreWarning::StorageUnavailable);
        }
        file.lock().map_err(|_| StoreWarning::StorageUnavailable)?;
        Ok(file)
    }

    fn scope_dir(&self, key: &str) -> PathBuf {
        self.root.join(key)
    }

    fn item_path(&self, key: &str, id: Uuid) -> PathBuf {
        self.scope_dir(key).join(format!("{id}.out"))
    }

    fn entries(&self) -> Result<Vec<(PathBuf, String)>, StoreWarning> {
        let mut records = Vec::new();
        let mut scopes = 0;
        for directory in fs::read_dir(&self.root).map_err(|_| StoreWarning::StorageUnavailable)? {
            let directory = directory.map_err(|_| StoreWarning::StorageUnavailable)?;
            if directory.file_name() == ".lock" {
                continue;
            }
            let name = directory.file_name().to_string_lossy().into_owned();
            if name.len() != 64 || !name.bytes().all(|byte| byte.is_ascii_hexdigit()) {
                return Err(StoreWarning::StorageUnavailable);
            }
            if !directory
                .file_type()
                .map_err(|_| StoreWarning::StorageUnavailable)?
                .is_dir()
            {
                return Err(StoreWarning::StorageUnavailable);
            }
            scopes += 1;
            if scopes > ABSOLUTE_SCOPE_COUNT {
                return Err(StoreWarning::StorageUnavailable);
            }
            let mut entries =
                fs::read_dir(directory.path()).map_err(|_| StoreWarning::StorageUnavailable)?;
            if entries.next().is_none() {
                fs::remove_dir(directory.path()).map_err(|_| StoreWarning::StorageUnavailable)?;
                continue;
            }
            for item in
                fs::read_dir(directory.path()).map_err(|_| StoreWarning::StorageUnavailable)?
            {
                let item = item.map_err(|_| StoreWarning::StorageUnavailable)?;
                let path = item.path();
                if !item
                    .file_type()
                    .map_err(|_| StoreWarning::StorageUnavailable)?
                    .is_file()
                {
                    return Err(StoreWarning::StorageUnavailable);
                }
                if path.extension().is_some_and(|ext| ext == "tmp") {
                    fs::remove_file(path).map_err(|_| StoreWarning::StorageUnavailable)?;
                    continue;
                }
                if path.extension().is_none_or(|ext| ext != "out") {
                    return Err(StoreWarning::StorageUnavailable);
                }
                records.push((path, name.clone()));
                if records.len() > ABSOLUTE_ITEM_COUNT {
                    return Err(StoreWarning::StorageUnavailable);
                }
            }
        }
        Ok(records)
    }

    fn usage_locked(&self, scope: Option<&str>) -> Result<OutputUsage, StoreWarning> {
        let mut usage = OutputUsage { items: 0, bytes: 0 };
        for (path, directory_key) in self.entries()? {
            if scope.is_some_and(|key| key != directory_key) {
                continue;
            }
            let bytes = match open_record(&path) {
                Ok((_, record)) if record.header.scope == directory_key => record.header.bytes,
                _ => {
                    let metadata = fs::symlink_metadata(&path)
                        .map_err(|_| StoreWarning::StorageUnavailable)?;
                    if !metadata.is_file() || metadata.file_type().is_symlink() {
                        return Err(StoreWarning::StorageUnavailable);
                    }
                    metadata.len()
                }
            };
            usage.items += 1;
            usage.bytes = usage
                .bytes
                .checked_add(bytes)
                .ok_or(StoreWarning::StorageUnavailable)?;
        }
        Ok(usage)
    }

    pub fn usage(&self, scope: Option<&OutputScope>) -> Result<OutputUsage, StoreWarning> {
        let key = scope.map(OutputScope::key).transpose()?;
        let _lock = self.lock()?;
        self.usage_locked(key.as_deref())
    }

    pub fn put(&self, scope: &OutputScope, output: &[u8]) -> Result<StoredOutput, StoreWarning> {
        self.put_at(scope, output, now_ms()?)
    }

    fn put_at(
        &self,
        scope: &OutputScope,
        output: &[u8],
        now: u64,
    ) -> Result<StoredOutput, StoreWarning> {
        let key = scope.key()?;
        if output.len() > self.limits.max_item_bytes {
            return Err(StoreWarning::TooLarge);
        }
        let _lock = self.lock()?;
        self.purge_expired_locked(now)?;
        let usage = self.usage_locked(None)?;
        if usage.items >= self.limits.max_items
            || usage
                .bytes
                .checked_add(output.len() as u64)
                .is_none_or(|bytes| bytes > self.limits.max_total_bytes)
        {
            return Err(StoreWarning::QuotaExceeded);
        }
        let directory = self.scope_dir(&key);
        private_directory(&directory)?;
        let id = Uuid::new_v4();
        let reference = format!("out:v1:{id}");
        let summary = self.summary(output);
        let expires_at_ms = now
            .checked_add(self.limits.retention_seconds.saturating_mul(1_000))
            .ok_or(StoreWarning::InvalidLimits)?;
        let header = RecordHeader {
            version: 1,
            scope: key.clone(),
            id: id.to_string(),
            created_at_ms: now,
            expires_at_ms,
            bytes: output.len() as u64,
            sha256: digest(output),
            summary: summary.clone(),
        };
        let mut encoded =
            serde_json::to_vec(&header).map_err(|_| StoreWarning::StorageUnavailable)?;
        encoded.push(b'\n');
        if encoded.len() > HEADER_LIMIT {
            return Err(StoreWarning::StorageUnavailable);
        }
        let path = self.item_path(&key, id);
        let temporary = directory.join(format!("{id}.tmp"));
        let mut file = private_file(&temporary)?;
        if file
            .write_all(&encoded)
            .and_then(|()| file.write_all(output))
            .and_then(|()| file.sync_all())
            .is_err()
        {
            let _ = fs::remove_file(&temporary);
            return Err(StoreWarning::StorageUnavailable);
        }
        drop(file);
        if fs::rename(&temporary, &path).is_err() {
            let _ = fs::remove_file(&temporary);
            return Err(StoreWarning::StorageUnavailable);
        }
        Ok(StoredOutput {
            reference,
            bytes: output.len() as u64,
            sha256: header.sha256,
            summary,
            expires_at_ms,
        })
    }

    fn summary(&self, output: &[u8]) -> String {
        if std::str::from_utf8(output).is_err() {
            return "[binary output]"
                .chars()
                .take(self.limits.summary_bytes)
                .collect();
        }
        let text = std::str::from_utf8(output).unwrap_or_default();
        let mut result = String::new();
        for character in text.chars() {
            let character = if character.is_control() {
                ' '
            } else {
                character
            };
            if result.len() + character.len_utf8() > self.limits.summary_bytes {
                break;
            }
            result.push(character);
        }
        result
    }

    pub fn read_range(
        &self,
        scope: &OutputScope,
        reference: &str,
        offset: u64,
        bytes: usize,
    ) -> Result<OutputSection, StoreWarning> {
        self.read_range_at(scope, reference, offset, bytes, now_ms()?)
    }

    fn read_range_at(
        &self,
        scope: &OutputScope,
        reference: &str,
        offset: u64,
        bytes: usize,
        now: u64,
    ) -> Result<OutputSection, StoreWarning> {
        if bytes == 0 || bytes > self.limits.max_read_bytes {
            return Err(StoreWarning::ReadLimitExceeded);
        }
        let id = reference
            .strip_prefix("out:v1:")
            .and_then(|value| Uuid::parse_str(value).ok())
            .ok_or(StoreWarning::InvalidReference)?;
        let key = scope.key()?;
        let _lock = self.lock()?;
        let (mut file, record) = open_record(&self.item_path(&key, id))?;
        if record.header.scope != key
            || record.header.id != id.to_string()
            || record.header.expires_at_ms <= now
        {
            return Err(StoreWarning::NotFound);
        }
        if offset > record.header.bytes {
            return Err(StoreWarning::InvalidReference);
        }
        file.seek(SeekFrom::Start(record.data_offset))
            .map_err(|_| StoreWarning::StorageUnavailable)?;
        let mut remaining = record.header.bytes;
        let mut digest = Sha256::new();
        let mut buffer = [0_u8; 32 * 1024];
        while remaining > 0 {
            let count = buffer.len().min(remaining as usize);
            file.read_exact(&mut buffer[..count])
                .map_err(|_| StoreWarning::StorageUnavailable)?;
            digest.update(&buffer[..count]);
            remaining -= count as u64;
        }
        if hex(&digest.finalize()) != record.header.sha256 {
            return Err(StoreWarning::StorageUnavailable);
        }
        let count = bytes.min((record.header.bytes - offset) as usize);
        file.seek(SeekFrom::Start(record.data_offset + offset))
            .map_err(|_| StoreWarning::StorageUnavailable)?;
        let mut content = vec![0; count];
        file.read_exact(&mut content)
            .map_err(|_| StoreWarning::StorageUnavailable)?;
        Ok(OutputSection {
            bytes: content,
            offset,
            total_bytes: record.header.bytes,
        })
    }

    fn purge_expired_locked(&self, now: u64) -> Result<usize, StoreWarning> {
        let mut removed = 0;
        let mut touched = std::collections::HashSet::new();
        for (path, key) in self.entries()? {
            let Ok((_, record)) = open_record(&path) else {
                continue;
            };
            if record.header.scope == key && record.header.expires_at_ms <= now {
                fs::remove_file(&path).map_err(|_| StoreWarning::StorageUnavailable)?;
                touched.insert(key);
                removed += 1;
            }
        }
        for key in touched {
            let _ = fs::remove_dir(self.scope_dir(&key));
        }
        Ok(removed)
    }

    pub fn purge_expired(&self) -> Result<usize, StoreWarning> {
        let _lock = self.lock()?;
        self.purge_expired_locked(now_ms()?)
    }

    pub fn purge_scope(&self, scope: &OutputScope) -> Result<usize, StoreWarning> {
        let key = scope.key()?;
        let _lock = self.lock()?;
        let directory = self.scope_dir(&key);
        if !directory.exists() {
            return Ok(0);
        }
        let metadata =
            fs::symlink_metadata(&directory).map_err(|_| StoreWarning::StorageUnavailable)?;
        if !metadata.is_dir() || metadata.file_type().is_symlink() {
            return Err(StoreWarning::StorageUnavailable);
        }
        let mut removed = 0;
        for entry in fs::read_dir(&directory).map_err(|_| StoreWarning::StorageUnavailable)? {
            let entry = entry.map_err(|_| StoreWarning::StorageUnavailable)?;
            let path = entry.path();
            if !entry
                .file_type()
                .map_err(|_| StoreWarning::StorageUnavailable)?
                .is_file()
            {
                return Err(StoreWarning::StorageUnavailable);
            }
            match path.extension().and_then(|extension| extension.to_str()) {
                Some("out") => removed += 1,
                Some("tmp") => {}
                _ => return Err(StoreWarning::StorageUnavailable),
            }
            fs::remove_file(path).map_err(|_| StoreWarning::StorageUnavailable)?;
        }
        fs::remove_dir(directory).map_err(|_| StoreWarning::StorageUnavailable)?;
        Ok(removed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    struct TestRoot(PathBuf);

    impl TestRoot {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!("sail-output-{}", Uuid::new_v4()));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for TestRoot {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    fn scope() -> OutputScope {
        OutputScope {
            repository: "github.com/example/project".into(),
            worktree: "/worktrees/feature".into(),
            user: "user-a".into(),
            provider: "codex".into(),
            session: "session-a".into(),
            revision: "abc123-dirty:1".into(),
        }
    }

    #[test]
    fn exact_ranges_survive_reopening() {
        let root = TestRoot::new();
        let store = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        let input = b"first line\nsecond line\n\xff";
        let saved = store.put(&scope(), input).unwrap();
        let reopened = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        let section = reopened
            .read_range(&scope(), &saved.reference, 9, 10)
            .unwrap();
        assert_eq!(section.bytes, input[9..19]);
        assert_eq!(section.total_bytes, input.len() as u64);
        assert_eq!(saved.sha256, digest(input));
        assert_eq!(saved.summary, "[binary output]");
    }

    #[test]
    fn all_identity_fields_and_revision_isolate_references() {
        let root = TestRoot::new();
        let store = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        let saved = store.put(&scope(), b"secret").unwrap();
        for field in 0..6 {
            let mut wrong = scope();
            match field {
                0 => wrong.repository.push('x'),
                1 => wrong.worktree.push('x'),
                2 => wrong.user.push('x'),
                3 => wrong.provider.push('x'),
                4 => wrong.session.push('x'),
                _ => wrong.revision.push('x'),
            }
            assert_eq!(
                store.read_range(&wrong, &saved.reference, 0, 10),
                Err(StoreWarning::NotFound)
            );
        }
    }

    #[test]
    fn quotas_and_reads_have_hard_bounds() {
        let root = TestRoot::new();
        let limits = OutputLimits {
            max_item_bytes: 5,
            max_total_bytes: 8,
            max_items: 2,
            max_read_bytes: 3,
            ..OutputLimits::default()
        };
        let store = OutputStore::open(root.0.clone(), limits).unwrap();
        assert_eq!(store.put(&scope(), b"123456"), Err(StoreWarning::TooLarge));
        let first = store.put(&scope(), b"1234").unwrap();
        store.put(&scope(), b"5678").unwrap();
        assert_eq!(store.put(&scope(), b"x"), Err(StoreWarning::QuotaExceeded));
        assert_eq!(
            store.read_range(&scope(), &first.reference, 0, 4),
            Err(StoreWarning::ReadLimitExceeded)
        );
        assert_eq!(
            store.usage(None).unwrap(),
            OutputUsage { items: 2, bytes: 8 }
        );
    }

    #[test]
    fn expiry_and_purge_remove_only_target_scope() {
        let root = TestRoot::new();
        let limits = OutputLimits {
            retention_seconds: 1,
            ..OutputLimits::default()
        };
        let store = OutputStore::open(root.0.clone(), limits).unwrap();
        let first = store.put_at(&scope(), b"old", 1_000).unwrap();
        let mut other = scope();
        other.session = "session-b".into();
        let second = store.put_at(&other, b"new", 1_500).unwrap();
        assert_eq!(
            store.read_range_at(&scope(), &first.reference, 0, 3, 2_000),
            Err(StoreWarning::NotFound)
        );
        assert_eq!(store.purge_expired_locked(2_000).unwrap(), 1);
        assert_eq!(store.purge_scope(&other).unwrap(), 1);
        assert_eq!(store.usage(None).unwrap().items, 0);
        assert_eq!(
            store.read_range_at(&other, &second.reference, 0, 3, 2_000),
            Err(StoreWarning::NotFound)
        );
    }

    #[test]
    fn malformed_references_and_storage_failures_stay_bounded() {
        let root = TestRoot::new();
        let store = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        assert_eq!(
            store.read_range(&scope(), "out:v1:../../private", 0, 1),
            Err(StoreWarning::InvalidReference)
        );
        let saved = store.put(&scope(), b"secret").unwrap();
        let id = saved.reference.strip_prefix("out:v1:").unwrap();
        let path = store.item_path(&scope().key().unwrap(), Uuid::parse_str(id).unwrap());
        fs::write(path, b"corrupt").unwrap();
        assert_eq!(
            store.read_range(&scope(), &saved.reference, 0, 6),
            Err(StoreWarning::StorageUnavailable)
        );
        assert!(StoreWarning::StorageUnavailable.message().len() < 80);
    }

    #[test]
    fn tampering_and_orphan_writes_do_not_return_content() {
        let root = TestRoot::new();
        let store = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        let saved = store.put(&scope(), b"secret").unwrap();
        let id = saved.reference.strip_prefix("out:v1:").unwrap();
        let directory = store.scope_dir(&scope().key().unwrap());
        let path = store.item_path(&scope().key().unwrap(), Uuid::parse_str(id).unwrap());
        let mut file = OpenOptions::new().write(true).open(path).unwrap();
        file.seek(SeekFrom::End(-1)).unwrap();
        file.write_all(b"x").unwrap();
        assert_eq!(
            store.read_range(&scope(), &saved.reference, 0, 6),
            Err(StoreWarning::StorageUnavailable)
        );
        fs::write(directory.join("interrupted.tmp"), b"partial").unwrap();
        assert_eq!(store.usage(None), Ok(OutputUsage { items: 1, bytes: 6 }));
        assert!(!directory.join("interrupted.tmp").exists());
        assert_eq!(store.purge_scope(&scope()), Ok(1));
    }

    #[test]
    fn corrupt_record_does_not_block_another_scope() {
        let root = TestRoot::new();
        let store = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        let damaged = store.put(&scope(), b"damaged").unwrap();
        let damaged_id =
            Uuid::parse_str(damaged.reference.strip_prefix("out:v1:").unwrap()).unwrap();
        fs::write(
            store.item_path(&scope().key().unwrap(), damaged_id),
            b"corrupt",
        )
        .unwrap();

        let mut other = scope();
        other.session = "healthy-session".into();
        let healthy = store.put(&other, b"healthy").unwrap();
        assert_eq!(
            store
                .read_range(&other, &healthy.reference, 0, 7)
                .unwrap()
                .bytes,
            b"healthy"
        );
        assert_eq!(store.usage(None).unwrap().items, 2);
        assert_eq!(
            store.read_range(&scope(), &damaged.reference, 0, 7),
            Err(StoreWarning::StorageUnavailable)
        );
        assert_eq!(store.purge_scope(&scope()), Ok(1));
        assert_eq!(store.usage(None).unwrap().items, 1);
    }

    #[test]
    fn purging_an_empty_scope_succeeds() {
        let root = TestRoot::new();
        let store = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        let directory = store.scope_dir(&scope().key().unwrap());
        fs::create_dir(&directory).unwrap();
        assert_eq!(store.purge_scope(&scope()), Ok(0));
        assert!(!directory.exists());
    }

    #[test]
    fn concurrent_writers_cannot_exceed_item_quota() {
        let root = TestRoot::new();
        let limits = OutputLimits {
            max_items: 3,
            ..OutputLimits::default()
        };
        let store = OutputStore::open(root.0.clone(), limits).unwrap();
        let writers = (0..12)
            .map(|_| {
                let store = store.clone();
                std::thread::spawn(move || store.put(&scope(), b"data").is_ok())
            })
            .collect::<Vec<_>>();
        let saved = writers
            .into_iter()
            .map(|writer| writer.join().unwrap())
            .filter(|saved| *saved)
            .count();
        assert_eq!(saved, 3);
        assert_eq!(store.usage(None).unwrap().items, 3);
    }

    #[cfg(unix)]
    #[test]
    fn symlinked_items_are_rejected() {
        use std::os::unix::fs::symlink;
        let root = TestRoot::new();
        let store = OutputStore::open(root.0.clone(), OutputLimits::default()).unwrap();
        let saved = store.put(&scope(), b"secret").unwrap();
        let id = Uuid::parse_str(saved.reference.strip_prefix("out:v1:").unwrap()).unwrap();
        let path = store.item_path(&scope().key().unwrap(), id);
        fs::remove_file(&path).unwrap();
        symlink(root.0.join(".lock"), &path).unwrap();
        assert_eq!(
            store.read_range(&scope(), &saved.reference, 0, 6),
            Err(StoreWarning::StorageUnavailable)
        );
    }
}
