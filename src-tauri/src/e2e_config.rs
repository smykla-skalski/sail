use std::ffi::OsString;
use std::fs;
use std::io::ErrorKind;
use std::path::{Component, Path, PathBuf};

/// Resolve E2E storage only inside this app process's private temporary directory.
pub(crate) fn root() -> Result<PathBuf, String> {
    let value = std::env::var_os("SAIL_E2E_CONFIG_DIR")
        .ok_or("E2E storage requires SAIL_E2E_CONFIG_DIR")?;
    private_root(Path::new(&value), &std::env::temp_dir())
}

fn private_root(root: &Path, temporary: &Path) -> Result<PathBuf, String> {
    if !root.is_absolute()
        || root
            .components()
            .any(|part| matches!(part, Component::CurDir | Component::ParentDir))
    {
        return Err("SAIL_E2E_CONFIG_DIR must be an absolute private path".into());
    }

    let temporary = fs::canonicalize(temporary)
        .map_err(|error| format!("Cannot resolve the E2E temporary directory: {error}"))?;
    let mut existing = root;
    let mut missing: Vec<OsString> = Vec::new();
    let mut resolved = loop {
        match fs::canonicalize(existing) {
            Ok(path) => break path,
            Err(error) if error.kind() == ErrorKind::NotFound => {
                if fs::symlink_metadata(existing)
                    .map(|metadata| metadata.file_type().is_symlink())
                    .unwrap_or(false)
                {
                    return Err("SAIL_E2E_CONFIG_DIR contains a dangling symlink".into());
                }
                let name = existing
                    .file_name()
                    .ok_or("Cannot resolve SAIL_E2E_CONFIG_DIR")?;
                missing.push(name.to_os_string());
                existing = existing
                    .parent()
                    .ok_or("Cannot resolve SAIL_E2E_CONFIG_DIR")?;
            }
            Err(error) => {
                return Err(format!("Cannot resolve SAIL_E2E_CONFIG_DIR: {error}"));
            }
        }
    };
    for name in missing.into_iter().rev() {
        resolved.push(name);
    }
    if resolved == temporary || !resolved.starts_with(&temporary) {
        return Err("SAIL_E2E_CONFIG_DIR must be inside the E2E temporary directory".into());
    }
    Ok(resolved)
}

#[cfg(test)]
mod tests {
    use super::private_root;
    use std::fs;
    use std::path::PathBuf;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct Fixture(PathBuf);

    impl Fixture {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sail-e2e-config-test-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&path).unwrap();
            Self(path)
        }
    }

    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn config_root_accepts_only_a_private_temp_descendant() {
        let fixture = Fixture::new();
        let temporary = fixture.0.join("temporary");
        let outside = fixture.0.join("production-config");
        fs::create_dir_all(&temporary).unwrap();
        fs::create_dir_all(&outside).unwrap();

        let private = temporary.join("run").join("config");
        assert_eq!(
            private_root(&private, &temporary).unwrap(),
            temporary.canonicalize().unwrap().join("run/config")
        );
        assert!(private_root(&temporary, &temporary).is_err());
        assert!(private_root(&outside, &temporary).is_err());
        assert!(private_root(&temporary.join("../production-config"), &temporary).is_err());
        assert!(private_root(&PathBuf::from("relative"), &temporary).is_err());
    }

    #[cfg(unix)]
    #[test]
    fn config_root_rejects_symlink_alias_to_user_state() {
        use std::os::unix::fs::symlink;

        let fixture = Fixture::new();
        let temporary = fixture.0.join("temporary");
        let outside = fixture.0.join("production-config");
        fs::create_dir_all(&temporary).unwrap();
        fs::create_dir_all(&outside).unwrap();
        symlink(&outside, temporary.join("alias")).unwrap();
        assert!(private_root(&temporary.join("alias"), &temporary).is_err());
        assert!(private_root(&temporary.join("alias/new-config"), &temporary).is_err());

        symlink(fixture.0.join("missing"), temporary.join("dangling")).unwrap();
        assert!(private_root(&temporary.join("dangling/new-config"), &temporary).is_err());
    }
}
