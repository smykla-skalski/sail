use sha2::{Digest, Sha256};
use std::collections::BTreeSet;
use std::path::Path;

pub fn check(root: &Path) -> Result<(), String> {
    let pin_path = root.join("skills/sai-pin.json");
    println!("cargo:rerun-if-changed={}", pin_path.display());
    let pin: serde_json::Value = serde_json::from_str(
        &std::fs::read_to_string(&pin_path).map_err(|error| error.to_string())?,
    )
    .map_err(|error| error.to_string())?;
    let files = pin["files"]
        .as_object()
        .ok_or("Missing pinned skill files")?;
    let skills = pin["skills"].as_object().ok_or("Missing pinned skills")?;
    let mut actual: BTreeSet<_> = pin["metadata"]
        .as_object()
        .ok_or("Missing pinned plugin metadata")?
        .keys()
        .cloned()
        .collect();
    for name in skills.keys() {
        visit(root, &root.join("skills").join(name), &mut actual)?;
    }
    let expected: BTreeSet<_> = files.keys().cloned().collect();
    if actual != expected {
        return Err("Bundled sai file list differs from skills/sai-pin.json".into());
    }
    for (path, digest) in files {
        println!("cargo:rerun-if-changed={}", root.join(path).display());
        let bytes = std::fs::read(root.join(path)).map_err(|error| error.to_string())?;
        let actual: String = Sha256::digest(bytes)
            .iter()
            .map(|byte| format!("{byte:02x}"))
            .collect();
        if Some(actual.as_str()) != digest.as_str() {
            return Err(format!("Bundled sai file drifted: {path}"));
        }
    }
    Ok(())
}

fn visit(root: &Path, directory: &Path, files: &mut BTreeSet<String>) -> Result<(), String> {
    println!("cargo:rerun-if-changed={}", directory.display());
    for entry in std::fs::read_dir(directory).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let kind = entry.file_type().map_err(|error| error.to_string())?;
        if kind.is_dir() {
            visit(root, &path, files)?;
        } else if kind.is_file() {
            if directory
                .file_name()
                .is_some_and(|name| name == "__pycache__")
                && path.extension().is_some_and(|extension| extension == "pyc")
            {
                continue;
            }
            files.insert(
                path.strip_prefix(root)
                    .map_err(|error| error.to_string())?
                    .to_string_lossy()
                    .replace('\\', "/"),
            );
        } else {
            return Err(format!(
                "Unsupported bundled skill entry: {}",
                path.display()
            ));
        }
    }
    Ok(())
}
