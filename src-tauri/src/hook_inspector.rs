use serde::Serialize;
use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookEntry {
    provider: &'static str,
    source: String,
    event: String,
    identity: String,
    state: String,
    #[serde(skip_serializing)]
    trust_key: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookError {
    provider: &'static str,
    source: String,
    message: String,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HookReport {
    entries: Vec<HookEntry>,
    errors: Vec<HookError>,
}

impl HookReport {
    fn error(&mut self, provider: &'static str, path: &Path, message: impl ToString) {
        self.errors.push(HookError {
            provider,
            source: path.display().to_string(),
            message: message.to_string(),
        });
    }

    fn entry(
        &mut self,
        provider: &'static str,
        path: &Path,
        event: &str,
        identity: &str,
        state: &str,
    ) {
        self.entries.push(HookEntry {
            provider,
            source: path.display().to_string(),
            event: event.to_string(),
            identity: identity.to_string(),
            state: state.to_string(),
            trust_key: None,
        });
    }
}

fn read_json(report: &mut HookReport, provider: &'static str, path: &Path) -> Option<Value> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound && !path.is_symlink() => {
            return None
        }
        Err(error) => {
            report.error(provider, path, error);
            return None;
        }
    };
    let content = if path
        .extension()
        .is_some_and(|extension| extension == "jsonc")
    {
        match strip_jsonc(&content) {
            Ok(content) => content,
            Err(error) => {
                report.error(provider, path, error);
                return None;
            }
        }
    } else {
        content
    };
    match serde_json::from_str(&content) {
        Ok(value) => Some(value),
        Err(error) => {
            report.error(provider, path, error);
            None
        }
    }
}

fn strip_jsonc(content: &str) -> Result<String, &'static str> {
    let bytes = content.as_bytes();
    let mut result = Vec::with_capacity(bytes.len());
    let mut index = 0;
    let mut quoted = false;
    let mut escaped = false;
    while index < bytes.len() {
        let byte = bytes[index];
        if quoted {
            result.push(byte);
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
            index += 1;
            continue;
        }
        if byte == b'"' {
            quoted = true;
        } else if byte == b'/' && bytes.get(index + 1) == Some(&b'/') {
            index += 2;
            while index < bytes.len() && bytes[index] != b'\n' {
                index += 1;
            }
            continue;
        } else if byte == b'/' && bytes.get(index + 1) == Some(&b'*') {
            index += 2;
            while index + 1 < bytes.len() && !(bytes[index] == b'*' && bytes[index + 1] == b'/') {
                index += 1;
            }
            if index + 1 >= bytes.len() {
                return Err("unterminated block comment");
            }
            index = (index + 2).min(bytes.len());
            continue;
        }
        result.push(byte);
        index += 1;
    }
    let mut cleaned = Vec::with_capacity(result.len());
    let mut quoted = false;
    let mut escaped = false;
    for (index, byte) in result.iter().copied().enumerate() {
        if quoted {
            if escaped {
                escaped = false;
            } else if byte == b'\\' {
                escaped = true;
            } else if byte == b'"' {
                quoted = false;
            }
        } else if byte == b'"' {
            quoted = true;
        } else if byte == b',' {
            let next = result[index + 1..]
                .iter()
                .copied()
                .find(|byte| !byte.is_ascii_whitespace());
            if matches!(next, Some(b'}' | b']')) {
                continue;
            }
        }
        cleaned.push(byte);
    }
    Ok(String::from_utf8(cleaned).expect("JSONC is UTF-8"))
}

fn scan_hooks(
    report: &mut HookReport,
    provider: &'static str,
    path: &Path,
    value: &Value,
    disabled: bool,
) {
    let Some(events) = value.get("hooks").and_then(Value::as_object) else {
        if value.get("hooks").is_some() {
            report.error(provider, path, "hooks must be an object");
        }
        return;
    };
    for (event, groups) in events {
        if provider == "Codex" && event == "state" {
            continue;
        }
        let Some(groups) = groups.as_array() else {
            report.error(provider, path, format!("{event} must be an array"));
            continue;
        };
        for (index, group) in groups.iter().enumerate() {
            let Some(handlers) = group.get("hooks").and_then(Value::as_array) else {
                report.error(
                    provider,
                    path,
                    format!("{event}[{index}].hooks must be an array"),
                );
                continue;
            };
            let matcher = group.get("matcher").and_then(Value::as_str).unwrap_or("");
            for (handler_index, handler) in handlers.iter().enumerate() {
                let identity = handler
                    .get("command")
                    .and_then(Value::as_str)
                    .or_else(|| handler.get("url").and_then(Value::as_str))
                    .or_else(|| handler.get("type").and_then(Value::as_str))
                    .unwrap_or("Unknown handler");
                let identity = if matcher.is_empty() {
                    identity.to_string()
                } else {
                    format!("{identity} · {matcher}")
                };
                let state = if disabled
                    || handler.get("disabled").and_then(Value::as_bool) == Some(true)
                    || handler.get("enabled").and_then(Value::as_bool) == Some(false)
                {
                    "Disabled"
                } else {
                    "Review in provider"
                };
                if !handler.is_object() {
                    report.error(
                        provider,
                        path,
                        format!("{event}[{index}].hooks[{handler_index}] must be an object"),
                    );
                    continue;
                }
                report.entry(provider, path, event, &identity, state);
                if provider == "Codex" {
                    let mut event_key = String::new();
                    for (position, letter) in event.chars().enumerate() {
                        if letter.is_uppercase() && position > 0 {
                            event_key.push('_');
                        }
                        event_key.extend(letter.to_lowercase());
                    }
                    report.entries.last_mut().unwrap().trust_key = Some(format!(
                        "{}:{event_key}:{index}:{handler_index}",
                        path.display()
                    ));
                }
            }
        }
    }
}

fn scan_claude(report: &mut HookReport, root: &Path, config_root: &Path, plugin_root: &Path) {
    let mut configs = Vec::new();
    for path in [
        config_root.join("settings.json"),
        root.join(".claude/settings.json"),
        root.join(".claude/settings.local.json"),
    ] {
        if let Some(value) = read_json(report, "Claude", &path) {
            configs.push((path, value));
        }
    }
    let disabled = configs
        .iter()
        .filter_map(|(_, value)| value.get("disableAllHooks").and_then(Value::as_bool))
        .next_back()
        == Some(true);
    let mut enabled_plugins = HashMap::new();
    for (path, value) in &configs {
        if let Some(plugins) = value.get("enabledPlugins").and_then(Value::as_object) {
            for (id, enabled) in plugins {
                if let Some(enabled) = enabled.as_bool() {
                    enabled_plugins
                        .insert(id.clone(), (enabled, path.clone(), path.starts_with(root)));
                } else {
                    report.error(
                        "Claude",
                        path,
                        format!("enabledPlugins.{id} must be a boolean"),
                    );
                }
            }
        }
    }
    for (path, value) in configs {
        scan_hooks(report, "Claude", &path, &value, disabled);
    }
    scan_claude_plugins(report, plugin_root, &enabled_plugins, disabled);
}

fn scan_claude_plugins(
    report: &mut HookReport,
    plugin_root: &Path,
    enabled_plugins: &HashMap<String, (bool, PathBuf, bool)>,
    disabled_hooks: bool,
) {
    let registry_path = plugin_root.join("installed_plugins.json");
    let registry = read_json(report, "Claude", &registry_path);
    let installed = registry
        .as_ref()
        .and_then(|value| value.get("plugins"))
        .and_then(Value::as_object);
    for (id, (enabled, setting_path, project_enabled)) in enabled_plugins {
        if !enabled {
            report.entry("Claude", setting_path, "Plugin", id, "Disabled");
            continue;
        }
        let mut found = false;
        let mut seen = HashSet::new();
        if let Some(installs) = installed
            .and_then(|plugins| plugins.get(id))
            .and_then(Value::as_array)
        {
            for install in installs {
                let scope = install.get("scope").and_then(Value::as_str).unwrap_or("");
                if scope != "user" && !project_enabled {
                    continue;
                }
                let Some(path) = install.get("installPath").and_then(Value::as_str) else {
                    report.error("Claude", &registry_path, format!("{id} has no installPath"));
                    continue;
                };
                let path = PathBuf::from(path);
                let path = match path.canonicalize() {
                    Ok(path) if path.is_dir() => path,
                    _ => {
                        report.error(
                            "Claude",
                            &path,
                            format!("{id} install directory is unreadable"),
                        );
                        continue;
                    }
                };
                if !seen.insert(path.clone()) {
                    continue;
                }
                found = true;
                report.entry("Claude", &path, "Plugin", id, "Enabled in Claude settings");
                scan_claude_plugin(report, &path, disabled_hooks);
            }
        }
        if !found {
            report.entry(
                "Claude",
                setting_path,
                "Plugin",
                id,
                "Enabled; inspect in Claude",
            );
        }
    }
}

fn scan_claude_plugin(report: &mut HookReport, root: &Path, disabled: bool) {
    let manifest = root.join(".claude-plugin/plugin.json");
    let config = read_json(report, "Claude", &manifest);
    match config.as_ref().and_then(|value| value.get("hooks")) {
        Some(Value::Array(values)) => {
            for value in values {
                scan_plugin_hook(report, "Claude", root, &manifest, value, disabled);
            }
        }
        Some(value) => scan_plugin_hook(report, "Claude", root, &manifest, value, disabled),
        None => {
            let path = root.join("hooks/hooks.json");
            if let Some(value) = read_json(report, "Claude", &path) {
                scan_hooks(report, "Claude", &path, &value, disabled);
            }
        }
    }
}

fn scan_codex(report: &mut HookReport, root: &Path, home: &Path, config_root: &Path) {
    let mut enabled_plugins = HashMap::new();
    let mut plugin_sources = HashMap::new();
    let mut trust_records = HashSet::new();
    for base in [config_root.to_path_buf(), root.join(".codex")] {
        let path = base.join("hooks.json");
        if let Some(value) = read_json(report, "Codex", &path) {
            scan_hooks(report, "Codex", &path, &value, false);
        }
        let path = base.join("config.toml");
        let content = match fs::read_to_string(&path) {
            Ok(content) => content,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                report.error("Codex", &path, error);
                continue;
            }
        };
        match toml::from_str::<Value>(&content) {
            Ok(value) => {
                scan_hooks(report, "Codex", &path, &value, false);
                if let Some(state) = value.pointer("/hooks/state").and_then(Value::as_object) {
                    for (key, record) in state {
                        if record.get("trusted_hash").and_then(Value::as_str).is_some() {
                            trust_records.insert(key.clone());
                        }
                    }
                }
                if let Some(plugins) = value.get("plugins").and_then(Value::as_object) {
                    for (id, plugin) in plugins {
                        if let Some(enabled) = plugin.get("enabled").and_then(Value::as_bool) {
                            enabled_plugins.insert(id.clone(), enabled);
                            plugin_sources.insert(id.clone(), path.clone());
                        }
                    }
                }
            }
            Err(error) => report.error("Codex", &path, error),
        }
    }
    let mut found_plugins =
        scan_codex_cache(report, &config_root.join("plugins/cache"), &enabled_plugins);
    for (marketplace, base) in [
        (home.join(".agents/plugins/marketplace.json"), home),
        (root.join(".agents/plugins/marketplace.json"), root),
        (root.join(".claude-plugin/marketplace.json"), root),
    ] {
        scan_codex_marketplace(
            report,
            &marketplace,
            base,
            &enabled_plugins,
            &mut found_plugins,
        );
    }
    for (id, enabled) in &enabled_plugins {
        if found_plugins.contains(id) {
            continue;
        }
        let source = plugin_sources.get(id).unwrap();
        report.entry(
            "Codex",
            source,
            "Plugin",
            id,
            if *enabled {
                "Enabled; inspect in Codex"
            } else {
                "Disabled"
            },
        );
    }
    for entry in &mut report.entries {
        if entry.state == "Review in provider"
            && entry
                .trust_key
                .as_ref()
                .is_some_and(|key| trust_records.contains(key))
        {
            entry.state = "Trust hash saved; verify in Codex".into();
        }
    }
}

fn scan_codex_cache(
    report: &mut HookReport,
    cache: &Path,
    enabled_plugins: &HashMap<String, bool>,
) -> HashSet<String> {
    let mut found = HashSet::new();
    for (id, enabled) in enabled_plugins {
        if !enabled {
            continue;
        }
        let Some((plugin, marketplace)) = id.rsplit_once('@') else {
            continue;
        };
        let plugin_dir = cache.join(marketplace).join(plugin);
        let versions = match fs::read_dir(&plugin_dir) {
            Ok(versions) => versions,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => {
                report.error("Codex", &plugin_dir, error);
                continue;
            }
        };
        let mut paths = Vec::new();
        for version in versions {
            match version {
                Ok(version) if version.path().is_dir() => paths.push(version.path()),
                Ok(_) => {}
                Err(error) => report.error("Codex", &plugin_dir, error),
            }
        }
        paths.sort();
        for path in &paths {
            report.entry(
                "Codex",
                path,
                "Plugin",
                id,
                if paths.len() == 1 {
                    "Enabled in Codex config"
                } else {
                    "Cached version; verify in Codex"
                },
            );
            let first_hook = report.entries.len();
            scan_codex_plugin(report, path);
            if paths.len() > 1 {
                for entry in &mut report.entries[first_hook..] {
                    if entry.state == "Review in provider" {
                        entry.state = "Cached version; verify in Codex".into();
                    }
                }
            }
        }
        if !paths.is_empty() {
            found.insert(id.clone());
        }
    }
    found
}

fn scan_codex_marketplace(
    report: &mut HookReport,
    marketplace: &Path,
    base: &Path,
    enabled_plugins: &HashMap<String, bool>,
    found_plugins: &mut HashSet<String>,
) {
    let Some(value) = read_json(report, "Codex", marketplace) else {
        return;
    };
    let Some(name) = value.get("name").and_then(Value::as_str) else {
        report.error("Codex", marketplace, "marketplace name is missing");
        return;
    };
    let Some(plugins) = value.get("plugins").and_then(Value::as_array) else {
        report.error("Codex", marketplace, "marketplace plugins must be an array");
        return;
    };
    for (index, plugin) in plugins.iter().enumerate() {
        let Some(plugin_name) = plugin.get("name").and_then(Value::as_str) else {
            report.error(
                "Codex",
                marketplace,
                format!("plugins[{index}].name is missing"),
            );
            continue;
        };
        let id = format!("{plugin_name}@{name}");
        if enabled_plugins.get(&id) != Some(&true) || found_plugins.contains(&id) {
            continue;
        }
        let source = plugin.get("source");
        if source
            .and_then(|source| source.get("source"))
            .and_then(Value::as_str)
            .is_some_and(|kind| kind != "local")
        {
            report.entry(
                "Codex",
                marketplace,
                "Plugin",
                &id,
                "Enabled; inspect in Codex",
            );
            found_plugins.insert(id);
            continue;
        }
        let relative = source.and_then(Value::as_str).or_else(|| {
            source
                .and_then(|source| source.get("path"))
                .and_then(Value::as_str)
        });
        let Some(relative) = relative.filter(|relative| relative.starts_with("./")) else {
            report.error(
                "Codex",
                marketplace,
                format!("{plugin_name} has no local source path"),
            );
            continue;
        };
        let Ok(base) = base.canonicalize() else {
            report.error("Codex", marketplace, "marketplace root is unreadable");
            continue;
        };
        let path = base.join(relative);
        let Ok(path) = path.canonicalize() else {
            report.error("Codex", &path, "enabled plugin directory is missing");
            continue;
        };
        if !path.starts_with(&base) || !path.is_dir() {
            report.error("Codex", &path, "plugin source leaves the marketplace root");
            continue;
        }
        report.entry("Codex", &path, "Plugin", &id, "Enabled in Codex config");
        scan_codex_plugin(report, &path);
        found_plugins.insert(id);
    }
}

fn scan_codex_plugin(report: &mut HookReport, root: &Path) {
    let portable_path = root.join("plugin.json");
    let portable = read_json(report, "Codex", &portable_path);
    let legacy_path = root.join(".codex-plugin/plugin.json");
    let legacy = if portable
        .as_ref()
        .and_then(|value| value.pointer("/extensions/com.openai"))
        .is_none()
    {
        read_json(report, "Codex", &legacy_path)
    } else {
        None
    };
    let hooks = portable
        .as_ref()
        .and_then(|value| value.pointer("/extensions/com.openai/hooks"))
        .or_else(|| legacy.as_ref().and_then(|value| value.get("hooks")));
    let manifest = if legacy.is_some() {
        &legacy_path
    } else {
        &portable_path
    };
    match hooks {
        Some(Value::Array(values)) => {
            for value in values {
                scan_plugin_hook(report, "Codex", root, manifest, value, false);
            }
        }
        Some(value) => scan_plugin_hook(report, "Codex", root, manifest, value, false),
        None => {
            let path = root.join("hooks/hooks.json");
            if let Some(value) = read_json(report, "Codex", &path) {
                scan_hooks(report, "Codex", &path, &value, false);
            }
        }
    }
}

fn scan_plugin_hook(
    report: &mut HookReport,
    provider: &'static str,
    root: &Path,
    manifest: &Path,
    hook: &Value,
    disabled: bool,
) {
    if let Some(relative) = hook.as_str() {
        if !relative.starts_with("./") {
            report.error(provider, manifest, "plugin hook path must start with ./");
            return;
        }
        let path = root.join(relative);
        let Ok(canonical) = path.canonicalize() else {
            report.error(provider, &path, "plugin hook file is missing");
            return;
        };
        if !canonical.starts_with(root) {
            report.error(provider, &path, "plugin hook path leaves its root");
            return;
        }
        if let Some(value) = read_json(report, provider, &path) {
            scan_hooks(report, provider, &path, &value, disabled);
        }
    } else if hook.is_object() {
        let value = if hook.get("hooks").is_some() {
            hook.clone()
        } else {
            serde_json::json!({"hooks":hook})
        };
        scan_hooks(report, provider, manifest, &value, disabled);
    } else {
        report.error(provider, manifest, "plugin hooks must be a path or object");
    }
}

fn scan_opencode_config(report: &mut HookReport, path: &Path, controls: &mut Vec<(String, bool)>) {
    let Some(value) = read_json(report, "OpenCode", path) else {
        return;
    };
    let plugins = value.get("plugin").or_else(|| value.get("plugins"));
    let Some(plugins) = plugins else { return };
    let Some(plugins) = plugins.as_array() else {
        report.error("OpenCode", path, "plugin list must be an array");
        return;
    };
    for (index, plugin) in plugins.iter().enumerate() {
        let identity = plugin
            .as_str()
            .or_else(|| plugin.get("package").and_then(Value::as_str));
        match identity {
            Some(identity) => {
                let (enabled, id) = match identity.strip_prefix('-') {
                    Some(id) => (false, id),
                    None => (true, identity),
                };
                controls.push((id.to_string(), enabled));
                if id == "*" || id.ends_with(".*") {
                    report.entry(
                        "OpenCode",
                        path,
                        "Plugin control",
                        identity,
                        "Review in OpenCode",
                    );
                } else {
                    report.entry("OpenCode", path, "Plugin", id, "Review in OpenCode");
                }
            }
            None => report.error(
                "OpenCode",
                path,
                format!("plugin[{index}] needs a package identity"),
            ),
        }
    }
}

fn apply_opencode_controls(report: &mut HookReport, controls: &[(String, bool)]) {
    for entry in &mut report.entries {
        if entry.provider != "OpenCode" || entry.event != "Plugin" {
            continue;
        }
        let selected = controls.iter().rev().find(|(pattern, _)| {
            pattern == "*"
                || pattern == &entry.identity
                || pattern
                    .strip_suffix(".*")
                    .is_some_and(|prefix| entry.identity.starts_with(&format!("{prefix}.")))
        });
        entry.state = match selected {
            Some((_, true)) => "Enabled in OpenCode config".into(),
            Some((_, false)) => "Disabled".into(),
            None => "Review in OpenCode".into(),
        };
    }
}

fn scan_plugin_dir(report: &mut HookReport, path: &Path) {
    let items = match fs::read_dir(path) {
        Ok(items) => items,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return,
        Err(error) => {
            report.error("OpenCode", path, error);
            return;
        }
    };
    for item in items {
        match item {
            Ok(item) => {
                let file = item.path();
                let source_file = file.is_file()
                    && matches!(
                        file.extension().and_then(|x| x.to_str()),
                        Some("js" | "ts" | "mjs")
                    );
                let source_dir = file.is_dir()
                    && ["index.ts", "index.js", "index.mjs"]
                        .iter()
                        .any(|name| file.join(name).is_file());
                if source_file || source_dir {
                    report.entry(
                        "OpenCode",
                        &file,
                        "Plugin",
                        &item.file_name().to_string_lossy(),
                        "Review in OpenCode",
                    );
                }
            }
            Err(error) => report.error("OpenCode", path, error),
        }
    }
}

#[cfg(test)]
fn inspect(root: &Path, home: &Path, config_home: &Path, claude_plugins: &Path) -> HookReport {
    let claude_config = home.join(".claude");
    let codex_config = home.join(".codex");
    inspect_with_paths(
        root,
        home,
        &ScanLocations {
            claude_config: &claude_config,
            codex_config: &codex_config,
            config_home,
            claude_plugins,
            opencode_config: None,
            opencode_dir: None,
        },
    )
}

struct ScanLocations<'a> {
    claude_config: &'a Path,
    codex_config: &'a Path,
    config_home: &'a Path,
    claude_plugins: &'a Path,
    opencode_config: Option<&'a Path>,
    opencode_dir: Option<&'a Path>,
}

fn inspect_with_paths(root: &Path, home: &Path, locations: &ScanLocations<'_>) -> HookReport {
    let mut report = HookReport::default();
    scan_claude(
        &mut report,
        root,
        locations.claude_config,
        locations.claude_plugins,
    );
    scan_codex(&mut report, root, home, locations.codex_config);
    let global = locations.config_home.join("opencode");
    let mut controls = Vec::new();
    for name in ["opencode.json", "opencode.jsonc"] {
        scan_opencode_config(&mut report, &global.join(name), &mut controls);
    }
    if let Some(path) = locations.opencode_config {
        scan_opencode_config(&mut report, path, &mut controls);
    }
    for base in [root, &root.join(".opencode")] {
        for name in ["opencode.json", "opencode.jsonc"] {
            scan_opencode_config(&mut report, &base.join(name), &mut controls);
        }
    }
    if let Some(base) = locations.opencode_dir {
        for name in ["opencode.json", "opencode.jsonc"] {
            scan_opencode_config(&mut report, &base.join(name), &mut controls);
        }
    }
    scan_plugin_dir(&mut report, &global.join("plugins"));
    scan_plugin_dir(&mut report, &root.join(".opencode/plugins"));
    if let Some(base) = locations.opencode_dir {
        scan_plugin_dir(&mut report, &base.join("plugins"));
    }
    apply_opencode_controls(&mut report, &controls);
    report
}

#[tauri::command]
pub fn inspect_agent_hooks(worktree: String) -> Result<HookReport, String> {
    let root = PathBuf::from(worktree)
        .canonicalize()
        .map_err(|error| error.to_string())?;
    if !root.is_dir() {
        return Err("Worktree must be a directory".into());
    }
    let home = std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
        .map(PathBuf::from)
        .ok_or("Cannot find the home folder")?;
    let config_home = std::env::var_os("XDG_CONFIG_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".config"));
    let claude_config = std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".claude"));
    let codex_config = std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or_else(|| home.join(".codex"));
    let claude_plugins = std::env::var_os("CLAUDE_CODE_PLUGIN_CACHE_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|| claude_config.join("plugins"));
    let opencode_config = std::env::var_os("OPENCODE_CONFIG").map(PathBuf::from);
    let opencode_dir = std::env::var_os("OPENCODE_CONFIG_DIR").map(PathBuf::from);
    Ok(inspect_with_paths(
        &root,
        &home,
        &ScanLocations {
            claude_config: &claude_config,
            codex_config: &codex_config,
            config_home: &config_home,
            claude_plugins: &claude_plugins,
            opencode_config: opencode_config.as_deref(),
            opencode_dir: opencode_dir.as_deref(),
        },
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reports_independent_sources_and_malformed_handlers() {
        let base = std::env::temp_dir().join(format!("sail-hooks-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let home = base.join("home");
        fs::create_dir_all(root.join(".claude")).unwrap();
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::create_dir_all(home.join(".claude")).unwrap();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"echo done"}]}]}}"#,
        )
        .unwrap();
        fs::write(root.join(".claude/settings.json"), "{").unwrap();
        fs::write(
            root.join(".claude/settings.local.json"),
            r#"{"disableAllHooks":true}"#,
        )
        .unwrap();
        fs::write(root.join(".codex/hooks.json"), r#"{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"check"}]}]}}"#).unwrap();
        fs::write(
            root.join(".codex/config.toml"),
            format!(
                "[hooks]\nStop = [{{ hooks = [{{ type = 'command', command = 'echo stop' }}] }}]\n[hooks.state.'{}:pre_tool_use:0:0']\ntrusted_hash = 'sha256:old'",
                root.join(".codex/hooks.json").display()
            ),
        )
        .unwrap();
        fs::write(root.join("opencode.json"), r#"{"plugin":["reviewer"]}"#).unwrap();
        fs::write(
            root.join("opencode.jsonc"),
            "{ // note\n \"plugins\": [\"-blocked\",], }",
        )
        .unwrap();
        let report = inspect(
            &root,
            &home,
            &home.join(".config"),
            &home.join(".claude/plugins"),
        );
        assert_eq!(report.entries.len(), 5);
        assert_eq!(report.errors.len(), 1);
        assert_eq!(report.entries[1].event, "PreToolUse");
        assert_eq!(report.entries[0].state, "Disabled");
        assert!(report.entries[1].identity.contains("Bash"));
        assert_eq!(report.entries[1].state, "Trust hash saved; verify in Codex");
        assert_eq!(report.entries[4].event, "Plugin");
        assert_eq!(report.entries[4].identity, "blocked");
        assert_eq!(report.entries[4].state, "Disabled");
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn reads_jsonc_without_changing_string_values() {
        let value: Value = serde_json::from_str(
            &strip_jsonc(
                "{ // comment\n \"plugins\": [\"https://example.com/a,b\", /* note */], }",
            )
            .unwrap(),
        )
        .unwrap();
        assert_eq!(value["plugins"][0], "https://example.com/a,b");
        assert_eq!(strip_jsonc("{} /*"), Err("unterminated block comment"));
    }

    #[test]
    fn finds_enabled_local_codex_plugin_hooks() {
        let base = std::env::temp_dir().join(format!("sail-plugin-hooks-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let home = base.join("home");
        fs::create_dir_all(root.join(".agents/plugins")).unwrap();
        fs::create_dir_all(root.join(".codex")).unwrap();
        fs::create_dir_all(root.join("plugins/policy/hooks")).unwrap();
        fs::create_dir_all(&home).unwrap();
        fs::write(
            root.join(".codex/config.toml"),
            "[plugins.'policy@local-repo']\nenabled = true\n[plugins.'empty@local-repo']\nenabled = true\n[plugins.'off@local-repo']\nenabled = false",
        )
        .unwrap();
        fs::write(root.join(".agents/plugins/marketplace.json"), r#"{"name":"local-repo","plugins":[{"name":"policy","source":{"source":"local","path":"./plugins/policy"}},{"name":"empty","source":{"source":"local","path":"./plugins/empty"}},{"name":"off","source":{"source":"local","path":"./plugins/off"}}]}"#).unwrap();
        fs::create_dir_all(root.join("plugins/empty")).unwrap();
        fs::write(
            root.join("plugins/empty/plugin.json"),
            r#"{"name":"empty"}"#,
        )
        .unwrap();
        fs::write(root.join("plugins/policy/hooks/hooks.json"), r#"{"hooks":{"SessionStart":[{"hooks":[{"type":"command","command":"check policy"}]}]}}"#).unwrap();
        let report = inspect(
            &root,
            &home,
            &home.join(".config"),
            &home.join(".claude/plugins"),
        );
        assert!(report.errors.is_empty());
        assert_eq!(report.entries.len(), 4);
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.event == "SessionStart"));
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "empty@local-repo"));
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "off@local-repo" && entry.state == "Disabled"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn finds_installed_codex_plugin_without_marketplace_file() {
        let base = std::env::temp_dir().join(format!("sail-plugin-cache-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let home = base.join("home");
        let plugin = home.join(".codex/plugins/cache/sai/policy/1.0.0");
        let newer = home.join(".codex/plugins/cache/sai/policy/2.0.0");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(plugin.join("hooks")).unwrap();
        fs::create_dir_all(newer.join("hooks")).unwrap();
        fs::write(
            home.join(".codex/config.toml"),
            "[plugins.'policy@sai']\nenabled = true",
        )
        .unwrap();
        fs::write(
            plugin.join("hooks/hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"check cached"}]}]}}"#,
        )
        .unwrap();
        fs::write(
            newer.join("hooks/hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"check newer"}]}]}}"#,
        )
        .unwrap();
        let report = inspect(
            &root,
            &home,
            &home.join(".config"),
            &home.join(".claude/plugins"),
        );
        assert!(report.errors.is_empty());
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.event == "Stop" && entry.source.contains("/cache/")));
        assert!(report
            .entries
            .iter()
            .filter(|entry| entry.event == "Stop")
            .all(|entry| entry.state == "Cached version; verify in Codex"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn finds_only_enabled_claude_plugin_hooks() {
        let base =
            std::env::temp_dir().join(format!("sail-claude-plugins-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let home = base.join("home");
        let plugins = home.join(".claude/plugins");
        let policy = plugins.join("cache/local/policy/1.0.0");
        let off = plugins.join("cache/local/off/1.0.0");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(policy.join("hooks")).unwrap();
        fs::create_dir_all(off.join("hooks")).unwrap();
        fs::write(
            home.join(".claude/settings.json"),
            r#"{"enabledPlugins":{"policy@local":true,"off@local":false}}"#,
        )
        .unwrap();
        fs::write(plugins.join("installed_plugins.json"), format!(r#"{{"version":2,"plugins":{{"policy@local":[{{"scope":"user","installPath":"{}","version":"1.0.0"}}],"off@local":[{{"scope":"user","installPath":"{}","version":"1.0.0"}}]}}}}"#, policy.display(), off.display())).unwrap();
        fs::write(
            policy.join("hooks/hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"check policy"}]}]}}"#,
        )
        .unwrap();
        fs::write(
            off.join("hooks/hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"check off"}]}]}}"#,
        )
        .unwrap();
        let report = inspect(&root, &home, &home.join(".config"), &plugins);
        assert!(report.errors.is_empty());
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "check policy" && entry.event == "Stop"));
        assert!(!report
            .entries
            .iter()
            .any(|entry| entry.identity == "check off"));
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "off@local" && entry.state == "Disabled"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn opencode_controls_apply_in_order_across_configs() {
        let base = std::env::temp_dir().join(format!("sail-opencode-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let home = base.join("home");
        let global = home.join(".config/opencode");
        fs::create_dir_all(&root).unwrap();
        fs::create_dir_all(&global).unwrap();
        fs::write(
            global.join("opencode.json"),
            r#"{"plugins":["foo","acme.one"]}"#,
        )
        .unwrap();
        fs::write(
            root.join("opencode.json"),
            r#"{"plugins":["-foo","-acme.*","acme.one"]}"#,
        )
        .unwrap();
        let report = inspect(
            &root,
            &home,
            &home.join(".config"),
            &home.join(".claude/plugins"),
        );
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "foo" && entry.state == "Disabled"));
        assert!(report.entries.iter().any(
            |entry| entry.identity == "acme.one" && entry.state == "Enabled in OpenCode config"
        ));
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "-acme.*" && entry.event == "Plugin control"));
        fs::remove_dir_all(base).unwrap();
    }

    #[test]
    fn reads_provider_override_locations() {
        let base =
            std::env::temp_dir().join(format!("sail-hook-overrides-{}", uuid::Uuid::new_v4()));
        let root = base.join("repo");
        let home = base.join("home");
        let claude = base.join("claude");
        let codex = base.join("codex");
        let open_file = base.join("custom.json");
        let open_dir = base.join("open-dir");
        for path in [&root, &home, &claude, &codex, &open_dir] {
            fs::create_dir_all(path).unwrap();
        }
        fs::write(
            claude.join("settings.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"claude override"}]}]}}"#,
        )
        .unwrap();
        fs::write(
            codex.join("hooks.json"),
            r#"{"hooks":{"Stop":[{"hooks":[{"command":"codex override"}]}]}}"#,
        )
        .unwrap();
        fs::write(&open_file, r#"{"plugins":["custom.plugin"]}"#).unwrap();
        fs::write(
            open_dir.join("opencode.json"),
            r#"{"plugins":["-custom.plugin"]}"#,
        )
        .unwrap();
        let report = inspect_with_paths(
            &root,
            &home,
            &ScanLocations {
                claude_config: &claude,
                codex_config: &codex,
                config_home: &home.join(".config"),
                claude_plugins: &claude.join("plugins"),
                opencode_config: Some(&open_file),
                opencode_dir: Some(&open_dir),
            },
        );
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "claude override"));
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "codex override"));
        assert!(report
            .entries
            .iter()
            .any(|entry| entry.identity == "custom.plugin" && entry.state == "Disabled"));
        fs::remove_dir_all(base).unwrap();
    }
}
