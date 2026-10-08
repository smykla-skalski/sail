use serde::Serialize;
use serde_json::Value;
use std::path::{Path, PathBuf};

const PLUGIN_MARKER: &str = "plan-review";
const CONFIG_NAMES: [&str; 3] = ["opencode.json", "opencode.jsonc", "config.json"];
const PARENT_LIMIT: usize = 12;

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanReviewPlugin {
    pub source: String,
    pub entry: String,
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

fn plugin_specs(config: &Value) -> Vec<String> {
    let mut specs = Vec::new();
    for key in ["plugin", "plugins"] {
        let Some(entries) = config.get(key).and_then(Value::as_array) else {
            continue;
        };
        for entry in entries {
            match entry {
                Value::String(spec) => specs.push(spec.clone()),
                Value::Array(parts) => {
                    if let Some(spec) = parts.first().and_then(Value::as_str) {
                        specs.push(spec.to_string());
                    }
                }
                Value::Object(fields) => {
                    for field in ["package", "name", "path", "module"] {
                        if let Some(spec) = fields.get(field).and_then(Value::as_str) {
                            specs.push(spec.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
    }
    specs
}

fn marks_plan_review(spec: &str) -> bool {
    let spec = spec.to_lowercase();
    spec.contains(PLUGIN_MARKER) || spec.contains("plan_review")
}

fn config_plugin(path: &Path) -> Option<PlanReviewPlugin> {
    let text = std::fs::read_to_string(path).ok()?;
    let config: Value = serde_json::from_str(&strip_jsonc(&text)).ok()?;
    let entry = plugin_specs(&config)
        .into_iter()
        .find(|spec| marks_plan_review(spec))?;
    Some(PlanReviewPlugin {
        source: path.to_string_lossy().into_owned(),
        entry,
    })
}

fn plugin_file(directory: &Path) -> Option<PlanReviewPlugin> {
    for name in ["plugin", "plugins"] {
        let Ok(entries) = std::fs::read_dir(directory.join(name)) else {
            continue;
        };
        for entry in entries.flatten() {
            let file = entry.file_name().to_string_lossy().into_owned();
            if marks_plan_review(&file) {
                return Some(PlanReviewPlugin {
                    source: directory.join(name).to_string_lossy().into_owned(),
                    entry: file,
                });
            }
        }
    }
    None
}

fn directory_plugin(directory: &Path) -> Option<PlanReviewPlugin> {
    CONFIG_NAMES
        .iter()
        .find_map(|name| config_plugin(&directory.join(name)))
        .or_else(|| plugin_file(directory))
}

/// Where OpenCode would find the plan-review plugin for a worktree: the user's config
/// directory, an explicit config file, and every `opencode.json`/`.opencode` up the tree.
pub fn find_plan_review_plugin(
    directory: &Path,
    global: Option<&Path>,
    explicit: Option<&Path>,
) -> Option<PlanReviewPlugin> {
    if let Some(found) = global.and_then(directory_plugin) {
        return Some(found);
    }
    if let Some(found) = explicit.and_then(config_plugin) {
        return Some(found);
    }
    for ancestor in directory.ancestors().take(PARENT_LIMIT) {
        if let Some(found) = ["opencode.json", "opencode.jsonc"]
            .iter()
            .find_map(|name| config_plugin(&ancestor.join(name)))
            .or_else(|| directory_plugin(&ancestor.join(".opencode")))
        {
            return Some(found);
        }
    }
    None
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

/// Reports an enabled OpenCode plan-review plugin, which would add a second plan tool set
/// next to Sail's own.
#[tauri::command]
pub fn opencode_plan_review_plugin(directory: String) -> Option<PlanReviewPlugin> {
    let explicit = std::env::var_os("OPENCODE_CONFIG").map(PathBuf::from);
    find_plan_review_plugin(
        Path::new(&directory),
        global_config_directory().as_deref(),
        explicit.as_deref(),
    )
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
    fn jsonc_comments_and_trailing_commas_are_ignored() {
        let value: Value = serde_json::from_str(&strip_jsonc(
            "{\n// comment\n\"url\": \"http://x//y\", /* block */ \"plugin\": [\"a\", ],\n}",
        ))
        .unwrap();
        assert_eq!(value["url"], "http://x//y");
        assert_eq!(plugin_specs(&value), vec!["a".to_string()]);
    }

    #[test]
    fn a_comment_after_a_trailing_comma_still_parses() {
        let value: Value = serde_json::from_str(&strip_jsonc(
            "{\n  \"plugin\": [\n    \"opencode-plan-review\", // enabled\n  ]\n}",
        ))
        .unwrap();
        assert_eq!(
            plugin_specs(&value),
            vec!["opencode-plan-review".to_string()]
        );
    }

    #[test]
    fn plugin_entries_come_in_every_supported_shape() {
        let config = serde_json::json!({
            "plugin": ["one", ["two", {"gateway": "plan-review-not-a-plugin"}]],
            "plugins": [{"package": "three"}]
        });
        assert_eq!(plugin_specs(&config), vec!["one", "two", "three"]);
    }

    #[test]
    fn the_global_config_is_checked_and_options_are_not_plugins() {
        let global = scratch("global");
        let work = scratch("work");
        std::fs::write(
            global.join("opencode.json"),
            r#"{"plugin": [["file:///x/kong.ts", {"note": "plan-review"}]]}"#,
        )
        .unwrap();
        assert_eq!(find_plan_review_plugin(&work, Some(&global), None), None);

        std::fs::write(
            global.join("opencode.jsonc"),
            "{\n  // enabled\n  \"plugin\": [\"opencode-plugin-plan-review@1.2.0\"],\n}",
        )
        .unwrap();
        let found = find_plan_review_plugin(&work, Some(&global), None).unwrap();
        assert_eq!(found.entry, "opencode-plugin-plan-review@1.2.0");
        assert!(found.source.ends_with("opencode.jsonc"));
    }

    #[test]
    fn project_configs_and_plugin_files_are_found_up_the_tree() {
        let root = scratch("project");
        let nested = root.join("packages").join("app");
        std::fs::create_dir_all(&nested).unwrap();
        assert_eq!(find_plan_review_plugin(&nested, None, None), None);

        std::fs::create_dir_all(root.join(".opencode").join("plugin")).unwrap();
        std::fs::write(
            root.join(".opencode").join("plugin").join("plan-review.ts"),
            "",
        )
        .unwrap();
        let found = find_plan_review_plugin(&nested, None, None).unwrap();
        assert_eq!(found.entry, "plan-review.ts");

        std::fs::remove_dir_all(root.join(".opencode")).unwrap();
        std::fs::write(
            root.join("opencode.json"),
            r#"{"plugin": ["smykla.plan-review"]}"#,
        )
        .unwrap();
        assert_eq!(
            find_plan_review_plugin(&nested, None, None).unwrap().entry,
            "smykla.plan-review"
        );
    }

    #[test]
    fn unreadable_configs_are_ignored() {
        let work = scratch("broken");
        std::fs::write(work.join("opencode.json"), "{not json").unwrap();
        assert_eq!(find_plan_review_plugin(&work, None, None), None);
        let explicit = work.join("missing.json");
        assert_eq!(find_plan_review_plugin(&work, None, Some(&explicit)), None);
    }
}
