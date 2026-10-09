use serde_json::Value;
use std::path::{Path, PathBuf};

const PLUGIN_MARKER: &str = "plan-review";
const CONFIG_NAMES: [&str; 3] = ["opencode.json", "opencode.jsonc", "config.json"];

/// A private OpenCode configuration directory used by one Sail ACP process.
///
/// OpenCode merges plugin lists from every configuration source, so an empty plugin
/// list cannot override a plugin inherited from the user's global configuration.
/// Sail therefore starts OpenCode with a filtered copy of that configuration instead.
pub struct IsolatedConfig {
    root: PathBuf,
}

impl IsolatedConfig {
    pub fn xdg_config_home(&self) -> &Path {
        &self.root
    }
}

impl Drop for IsolatedConfig {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.root);
    }
}

/// Removes comments so an OpenCode JSONC file parses once trailing commas are dropped.
fn strip_comments(text: &str) -> String {
    let chars: Vec<char> = text.chars().collect();
    let mut output = String::with_capacity(text.len());
    let mut index = 0;
    let mut in_string = false;
    while index < chars.len() {
        let current = chars[index];
        if in_string {
            output.push(current);
            if current == '\\' && index + 1 < chars.len() {
                output.push(chars[index + 1]);
                index += 1;
            } else if current == '"' {
                in_string = false;
            }
        } else if current == '"' {
            in_string = true;
            output.push(current);
        } else if current == '/' && chars.get(index + 1) == Some(&'/') {
            while index < chars.len() && chars[index] != '\n' {
                index += 1;
            }
            continue;
        } else if current == '/' && chars.get(index + 1) == Some(&'*') {
            index += 2;
            while index + 1 < chars.len() && !(chars[index] == '*' && chars[index + 1] == '/') {
                index += 1;
            }
            index += 2;
            continue;
        } else {
            output.push(current);
        }
        index += 1;
    }
    output
}

/// Removes comments and trailing commas so an OpenCode JSONC file parses as JSON.
fn strip_jsonc(text: &str) -> String {
    let chars: Vec<char> = strip_comments(text).chars().collect();
    let mut output = String::with_capacity(chars.len());
    let mut in_string = false;
    let mut escaped = false;
    for (index, current) in chars.iter().enumerate() {
        if in_string {
            output.push(*current);
            if escaped {
                escaped = false;
            } else if *current == '\\' {
                escaped = true;
            } else if *current == '"' {
                in_string = false;
            }
        } else if *current == '"' {
            in_string = true;
            output.push(*current);
        } else if *current == ',' {
            let next = chars[index + 1..].iter().find(|c| !c.is_whitespace());
            if !matches!(next, Some('}' | ']')) {
                output.push(*current);
            }
        } else {
            output.push(*current);
        }
    }
    output
}

fn marks_plan_review(spec: &str) -> bool {
    let spec = spec.to_lowercase();
    spec.contains(PLUGIN_MARKER) || spec.contains("plan_review")
}

fn global_config_directory() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("OPENCODE_CONFIG_DIR") {
        return Some(PathBuf::from(dir));
    }
    if let Some(dir) = std::env::var_os("XDG_CONFIG_HOME") {
        return Some(PathBuf::from(dir).join("opencode"));
    }
    std::env::var_os("HOME").map(|home| PathBuf::from(home).join(".config").join("opencode"))
}

fn plugin_entry_is_plan_review(entry: &Value) -> bool {
    match entry {
        Value::String(spec) => marks_plan_review(spec),
        Value::Array(parts) => parts
            .first()
            .and_then(Value::as_str)
            .is_some_and(marks_plan_review),
        Value::Object(fields) => ["package", "name", "path", "module"]
            .iter()
            .filter_map(|field| fields.get(*field).and_then(Value::as_str))
            .any(marks_plan_review),
        _ => false,
    }
}

fn filter_plan_review_plugin(config: &mut Value) {
    let Some(fields) = config.as_object_mut() else {
        return;
    };
    for key in ["plugin", "plugins"] {
        if let Some(entries) = fields.get_mut(key).and_then(Value::as_array_mut) {
            entries.retain(|entry| !plugin_entry_is_plan_review(entry));
        }
    }
}

fn copy_config_directory(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    std::fs::create_dir_all(destination).map_err(|error| error.to_string())?;
    for entry in std::fs::read_dir(source).map_err(|error| error.to_string())? {
        let entry = entry.map_err(|error| error.to_string())?;
        let path = entry.path();
        let target = destination.join(entry.file_name());
        if path.is_dir() {
            copy_config_directory(&path, &target)?;
        } else if !path.is_file() {
            continue;
        } else if marks_plan_review(&entry.file_name().to_string_lossy()) {
            continue;
        } else if CONFIG_NAMES.iter().any(|name| *name == entry.file_name()) {
            let text = std::fs::read_to_string(&path).map_err(|error| error.to_string())?;
            let mut config: Value = serde_json::from_str(&strip_jsonc(&text)).map_err(|error| {
                format!(
                    "Could not isolate OpenCode configuration {}: {error}",
                    path.display()
                )
            })?;
            filter_plan_review_plugin(&mut config);
            let text = serde_json::to_string_pretty(&config).map_err(|error| error.to_string())?;
            std::fs::write(target, format!("{text}\n")).map_err(|error| error.to_string())?;
        } else {
            std::fs::copy(&path, target).map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

/// Makes an isolated OpenCode config for a Sail-managed process.
///
/// The child receives this directory as `XDG_CONFIG_HOME`; its user-owned config and
/// project-level config are never modified. Project config is disabled by the caller
/// because OpenCode merges plugins from it after loading the global config.
pub fn isolate_for_sail() -> Result<IsolatedConfig, String> {
    let root = std::env::temp_dir().join(format!("sail-opencode-config-{}", uuid::Uuid::new_v4()));
    let config = root.join("opencode");
    if let Some(source) = global_config_directory() {
        if let Err(error) = copy_config_directory(&source, &config) {
            let _ = std::fs::remove_dir_all(&root);
            return Err(error);
        }
    }
    Ok(IsolatedConfig { root })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn scratch(name: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "sail-opencode-config-{name}-{}",
            uuid::Uuid::new_v4()
        ));
        std::fs::create_dir_all(&path).unwrap();
        path
    }

    #[test]
    fn preserves_non_plan_settings_when_filtering_jsonc() {
        let mut value: Value = serde_json::from_str(&strip_jsonc(
            "{\n// comment\n\"url\": \"http://x//y\", /* block */ \"plugin\": [\"keep\", \"opencode-plan-review\", ],\n}",
        ))
        .unwrap();

        filter_plan_review_plugin(&mut value);

        assert_eq!(
            value,
            serde_json::json!({"url":"http://x//y","plugin":["keep"]})
        );
    }

    #[test]
    fn copies_other_plugins_and_skips_plan_review_plugin_files() {
        let source = scratch("source");
        let destination = scratch("destination");
        std::fs::create_dir_all(source.join("plugins")).unwrap();
        std::fs::write(
            source.join("plugins").join("useful.ts"),
            "export default {};",
        )
        .unwrap();
        std::fs::write(
            source.join("plugins").join("plan-review.ts"),
            "export default {};",
        )
        .unwrap();

        copy_config_directory(&source, &destination).unwrap();

        assert!(destination.join("plugins").join("useful.ts").is_file());
        assert!(!destination.join("plugins").join("plan-review.ts").exists());
        std::fs::remove_dir_all(source).unwrap();
        std::fs::remove_dir_all(destination).unwrap();
    }
}
