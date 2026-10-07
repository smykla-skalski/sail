use serde::{Deserialize, Serialize};
use std::path::{Component, Path, PathBuf};
use std::process::Command;

const CONFIG: &str = ".sail/worktree.json";

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ShipRisk {
    Low,
    Medium,
    High,
}

#[derive(Clone, Copy, Deserialize, Serialize, PartialEq, Eq, Hash)]
pub enum ShipGate {
    #[serde(rename = "code-adversary")]
    Code,
    #[serde(rename = "findings-adversary")]
    Findings,
    #[serde(rename = "test-adversary")]
    Test,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct ShipPathRisk {
    pub pattern: String,
    pub risk: ShipRisk,
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ShipValidationConfig {
    #[serde(default = "default_ship_risk")]
    pub default_risk: ShipRisk,
    pub low: Vec<ShipGate>,
    pub medium: Vec<ShipGate>,
    pub high: Vec<ShipGate>,
    #[serde(default)]
    pub paths: Vec<ShipPathRisk>,
}

fn default_ship_risk() -> ShipRisk {
    ShipRisk::Medium
}

#[derive(Clone, Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct WorktreeConfig {
    #[serde(default)]
    pub setup: String,
    #[serde(default)]
    pub run: String,
    #[serde(default)]
    pub archive: String,
    #[serde(default)]
    pub copy: Vec<String>,
    #[serde(default, rename = "postTurnChecks")]
    pub post_turn_checks: Vec<String>,
    pub validation: Option<ShipValidationConfig>,
}

fn validate(config: &WorktreeConfig) -> Result<(), String> {
    if config
        .post_turn_checks
        .iter()
        .any(|command| command.trim().is_empty())
    {
        return Err("Post-turn check command cannot be empty.".to_string());
    }
    if let Some(validation) = &config.validation {
        let unique = |gates: &[ShipGate]| {
            gates.iter().collect::<std::collections::HashSet<_>>().len() == gates.len()
        };
        if !unique(&validation.low) || !unique(&validation.medium) || !unique(&validation.high) {
            return Err("Validation gates must be unique within each risk level.".to_string());
        }
        if validation
            .low
            .iter()
            .any(|gate| !validation.medium.contains(gate) || !validation.high.contains(gate))
        {
            return Err("Higher risks must retain every low-risk gate.".to_string());
        }
        if validation
            .medium
            .iter()
            .any(|gate| !validation.high.contains(gate))
        {
            return Err("High risk must retain every medium-risk gate.".to_string());
        }
        if validation
            .paths
            .iter()
            .any(|rule| rule.pattern.trim().is_empty())
        {
            return Err("Validation path pattern cannot be empty.".to_string());
        }
    }
    Ok(())
}

pub fn read(directory: &Path) -> Result<Option<WorktreeConfig>, String> {
    let path = directory.join(CONFIG);
    if !path.exists() {
        return Ok(None);
    }
    let tracked = Command::new("git")
        .arg("-C")
        .arg(directory)
        .args(["ls-files", "--error-unmatch", "--", CONFIG])
        .output()
        .map_err(|error| format!("Cannot inspect Sail config: {error}"))?;
    if !tracked.status.success() {
        return Err("Sail worktree config must be committed to the repository.".to_string());
    }
    let metadata = std::fs::symlink_metadata(&path).map_err(|error| error.to_string())?;
    if !metadata.is_file() || metadata.len() > 64 * 1024 {
        return Err("Sail worktree config must be a file smaller than 64 KiB.".to_string());
    }
    let value = std::fs::read(&path).map_err(|error| error.to_string())?;
    let config: WorktreeConfig = serde_json::from_slice(&value)
        .map_err(|error| format!("Invalid Sail worktree config: {error}"))?;
    validate(&config)?;
    for item in &config.copy {
        let path = Path::new(item);
        if item.is_empty()
            || !path
                .components()
                .all(|part| matches!(part, Component::Normal(_)))
        {
            return Err(format!("Invalid copied path: {item}"));
        }
    }
    Ok(Some(config))
}

fn copy_entry(source: &Path, destination: &Path) -> Result<(), String> {
    let metadata = std::fs::symlink_metadata(source).map_err(|error| error.to_string())?;
    if metadata.file_type().is_symlink() {
        return Err(format!(
            "Copied path contains a symlink: {}",
            source.display()
        ));
    }
    if metadata.is_dir() {
        std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
        for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
            let entry = entry.map_err(|error| error.to_string())?;
            copy_entry(&entry.path(), &destination.join(entry.file_name()))?;
        }
    } else if metadata.is_file() {
        if let Some(parent) = destination.parent() {
            std::fs::create_dir_all(parent).map_err(|error| error.to_string())?;
        }
        std::fs::copy(source, destination).map_err(|error| error.to_string())?;
    } else {
        return Err(format!(
            "Copied path is not a file or folder: {}",
            source.display()
        ));
    }
    Ok(())
}

fn reject_symlink_components(root: &Path, relative: &Path) -> Result<(), String> {
    let mut path = root.to_path_buf();
    for component in relative.components() {
        path.push(component);
        match std::fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.file_type().is_symlink() => {
                return Err(format!(
                    "Copied path contains a symlink: {}",
                    path.display()
                ));
            }
            Ok(_) => {}
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => break,
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

pub fn copy_ignored(
    repository: &Path,
    worktree: &Path,
    config: &WorktreeConfig,
) -> Result<(), String> {
    for item in &config.copy {
        let relative = PathBuf::from(item);
        let source = repository.join(&relative);
        reject_symlink_components(repository, &relative)?;
        if !source.exists() {
            continue;
        }
        let ignored = Command::new("git")
            .arg("-C")
            .arg(repository)
            .args(["check-ignore", "-q", "--"])
            .arg(&relative)
            .status()
            .map_err(|error| format!("Cannot check ignored path: {error}"))?;
        if !ignored.success() {
            return Err(format!("Configured copied path is not gitignored: {item}"));
        }
        let destination = worktree.join(&relative);
        reject_symlink_components(worktree, &relative)?;
        if destination.exists() {
            return Err(format!("Copied path already exists in worktree: {item}"));
        }
        copy_entry(&source, &destination)?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validation_policy_requires_monotonic_unique_gates() {
        let valid: WorktreeConfig = serde_json::from_value(serde_json::json!({
            "validation": {
                "defaultRisk": "low",
                "low": ["test-adversary"],
                "medium": ["code-adversary", "test-adversary"],
                "high": ["code-adversary", "findings-adversary", "test-adversary"],
                "paths": [{"pattern": "src-tauri/**", "risk": "high"}]
            }
        }))
        .unwrap();
        assert!(validate(&valid).is_ok());
        assert_eq!(
            serde_json::to_value(&valid).unwrap()["validation"]["low"][0],
            "test-adversary"
        );

        let non_monotonic: WorktreeConfig = serde_json::from_value(serde_json::json!({
            "validation": {
                "low": ["test-adversary"],
                "medium": [],
                "high": ["test-adversary"]
            }
        }))
        .unwrap();
        assert!(validate(&non_monotonic)
            .unwrap_err()
            .contains("retain every low-risk gate"));
    }
}
