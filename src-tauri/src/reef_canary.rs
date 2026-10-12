#[cfg(unix)]
use std::path::{Path, PathBuf};
#[cfg(unix)]
use std::process::Command;
use tauri::AppHandle;

const SETTING: &str = "sai-reef-canary-percent";

pub(crate) fn configured_percent(app: &AppHandle) -> Result<Option<u8>, String> {
    parse_percent(crate::settings::string_setting(app, SETTING)?.as_deref())
}

fn parse_percent(value: Option<&str>) -> Result<Option<u8>, String> {
    let Some(value) = value.filter(|value| *value != "off") else {
        return Ok(None);
    };
    let percent = value
        .parse::<u8>()
        .map_err(|_| "Invalid Reef canary percentage in Sail settings.".to_string())?;
    if percent > 100 {
        return Err("Invalid Reef canary percentage in Sail settings.".into());
    }
    Ok(Some(percent))
}

#[cfg(unix)]
pub(crate) fn verify_executable(reef: Option<PathBuf>) -> Result<PathBuf, String> {
    let reef = reef.ok_or("Reef canary is enabled, but reef was not found on PATH.")?;
    let output = Command::new(&reef)
        .args(["agents", "launch", "--help"])
        .output()
        .map_err(|error| format!("Could not check Reef canary support: {error}"))?;
    if !output.status.success() || !String::from_utf8_lossy(&output.stdout).contains("--exec") {
        return Err("Upgrade Reef to a version with ACP adapter --exec support.".into());
    }
    Ok(reef)
}

#[cfg(unix)]
pub(crate) fn wrap_command(
    command: &Command,
    reef: &Path,
    agent: &str,
    percent: u8,
) -> Result<Command, String> {
    if !Path::new(command.get_program()).is_absolute() {
        return Err("Reef canary needs an absolute ACP adapter executable.".into());
    }
    let mut wrapped = Command::new(reef);
    wrapped
        .args(["agents", "launch", agent, "--canary-percent"])
        .arg(percent.to_string())
        .arg("--exec")
        .arg(command.get_program())
        .arg("--")
        .args(command.get_args());
    if let Some(directory) = command.get_current_dir() {
        wrapped.current_dir(directory);
    }
    for (name, value) in command.get_envs() {
        if let Some(value) = value {
            wrapped.env(name, value);
        } else {
            wrapped.env_remove(name);
        }
    }
    Ok(wrapped)
}

#[cfg(test)]
mod tests {
    use super::parse_percent;

    #[test]
    fn absent_or_off_leaves_launch_unchanged_but_zero_measures_control() {
        assert_eq!(parse_percent(None).unwrap(), None);
        assert_eq!(parse_percent(Some("off")).unwrap(), None);
        assert_eq!(parse_percent(Some("0")).unwrap(), Some(0));
        assert_eq!(parse_percent(Some("10")).unwrap(), Some(10));
        assert_eq!(parse_percent(Some("100")).unwrap(), Some(100));
    }

    #[test]
    fn invalid_percent_does_not_silently_disable_the_canary() {
        for value in ["", "abc", "101", "-1", "10.5"] {
            assert!(parse_percent(Some(value)).is_err(), "{value}");
        }
    }

    #[cfg(unix)]
    #[test]
    fn wrapper_preserves_adapter_args_environment_and_directory() {
        use std::ffi::OsStr;
        use std::path::Path;
        use std::process::Command;

        let mut original = Command::new("/usr/bin/nice");
        original
            .args(["-n", "10", "/usr/bin/node", "/private/adapter.mjs"])
            .current_dir("/private/worktree")
            .env("CODEX_PATH", "/private/codex")
            .env_remove("OPENCODE_CONFIG_DIR");
        let wrapped =
            super::wrap_command(&original, Path::new("/opt/homebrew/bin/reef"), "codex", 10)
                .unwrap();
        assert_eq!(wrapped.get_program(), OsStr::new("/opt/homebrew/bin/reef"));
        assert_eq!(
            wrapped.get_args().collect::<Vec<_>>(),
            [
                "agents",
                "launch",
                "codex",
                "--canary-percent",
                "10",
                "--exec",
                "/usr/bin/nice",
                "--",
                "-n",
                "10",
                "/usr/bin/node",
                "/private/adapter.mjs",
            ]
            .map(OsStr::new)
        );
        assert_eq!(
            wrapped.get_current_dir(),
            Some(Path::new("/private/worktree"))
        );
        let environment: Vec<_> = wrapped.get_envs().collect();
        assert_eq!(environment.len(), 2);
        assert_eq!(
            environment[0],
            (OsStr::new("CODEX_PATH"), Some(OsStr::new("/private/codex")))
        );
        assert_eq!(environment[1], (OsStr::new("OPENCODE_CONFIG_DIR"), None));
    }
}
