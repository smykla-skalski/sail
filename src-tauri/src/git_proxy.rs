use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

const ROUTING: [&str; 4] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
];

fn environment(command: &Command, name: &str) -> Option<OsString> {
    command
        .get_envs()
        .find(|(key, _)| *key == name)
        .map(|(_, value)| value.map(OsStr::to_os_string))
        .unwrap_or_else(|| std::env::var_os(name))
}

#[cfg(unix)]
fn publish_startup(path: &Path, script: &str) -> Result<(), String> {
    let temporary = path.with_extension(uuid::Uuid::new_v4().to_string());
    std::fs::write(&temporary, script).map_err(|error| error.to_string())?;
    if let Err(error) = std::fs::rename(&temporary, path) {
        let _ = std::fs::remove_file(&temporary);
        return Err(error.to_string());
    }
    Ok(())
}

#[cfg(unix)]
fn prepare_shells(command: &mut Command, bin: &Path) -> Result<(), String> {
    let startup = bin.join("zsh");
    std::fs::create_dir_all(&startup).map_err(|error| error.to_string())?;
    let original = environment(command, "ZDOTDIR");
    if original.as_deref() != Some(startup.as_os_str()) {
        let home = environment(command, "HOME").ok_or("Cannot find the session home directory.")?;
        command.env("SAIL_GIT_USER_ZDOTDIR", original.unwrap_or(home));
    }
    for name in [".zshenv", ".zprofile", ".zshrc", ".zlogin", ".zlogout"] {
        let script = format!(
            r#"_sail_git_startup=$ZDOTDIR
ZDOTDIR=$SAIL_GIT_USER_ZDOTDIR
if [ -r "$ZDOTDIR/{name}" ]; then . "$ZDOTDIR/{name}"; fi
export SAIL_GIT_USER_ZDOTDIR="${{ZDOTDIR:-$HOME}}"
export ZDOTDIR=$_sail_git_startup
unset _sail_git_startup
case "$PATH" in "$SAIL_GIT_BIN"|"$SAIL_GIT_BIN":*) ;; *) export PATH="$SAIL_GIT_BIN:$PATH" ;; esac
"#
        );
        publish_startup(&startup.join(name), &script)?;
    }
    command.env("ZDOTDIR", startup);
    let bash_env = bin.join("bash-env");
    let original = environment(command, "BASH_ENV");
    if original.as_deref() != Some(bash_env.as_os_str()) {
        command.env("SAIL_GIT_USER_BASH_ENV", original.unwrap_or_default());
    }
    publish_startup(
        &bash_env,
        r#"if [ -n "$SAIL_GIT_USER_BASH_ENV" ] && [ -r "$SAIL_GIT_USER_BASH_ENV" ]; then . "$SAIL_GIT_USER_BASH_ENV"; fi
case "$PATH" in "$SAIL_GIT_BIN"|"$SAIL_GIT_BIN":*) ;; *) export PATH="$SAIL_GIT_BIN:$PATH" ;; esac
"#,
    )?;
    command.env("BASH_ENV", bash_env);
    command.env("SAIL_GIT_BIN", bin);
    Ok(())
}

fn global_arguments(args: &[OsString]) -> Option<&[OsString]> {
    let mut index = 0;
    while let Some(arg) = args.get(index) {
        let arg = arg.to_str()?;
        match arg {
            "init" | "clone" => return None,
            "--bare" | "--git-dir" | "--work-tree" => return None,
            "-C" | "-c" | "--config-env" => index += 2,
            _ if arg.starts_with("--git-dir=") || arg.starts_with("--work-tree=") => return None,
            _ if arg.starts_with('-') => index += 1,
            _ => return Some(&args[..index]),
        }
    }
    None
}

pub(crate) fn command(
    binary: &Path,
    git_dir: &Path,
    worktree: &Path,
    directory: &Path,
    args: &[OsString],
) -> Command {
    let mut command = Command::new(binary);
    command.args(args).current_dir(directory);
    // Explicit caller routing takes precedence over Sail's default.
    if ROUTING.iter().any(|name| std::env::var_os(name).is_some()) {
        return command;
    }
    if let Some(global) = global_arguments(args) {
        let root = Command::new(binary)
            .args(global)
            .args(["rev-parse", "--show-toplevel"])
            .current_dir(directory)
            .output()
            .ok()
            .filter(|output| output.status.success())
            .map(|output| crate::terminal::git_root_path(output.stdout));
        if root
            .and_then(|root| dunce::canonicalize(root).ok())
            .is_some_and(|root| {
                dunce::canonicalize(worktree).is_ok_and(|worktree| root == worktree)
            })
        {
            command.env("GIT_DIR", git_dir);
            command.env("GIT_WORK_TREE", worktree);
        }
    }
    command
}

pub(crate) fn prepare(
    command: &mut Command,
    git_dir: &Path,
    worktree: &Path,
) -> Result<(), String> {
    let executable = std::env::current_exe().map_err(|error| error.to_string())?;
    let version = executable
        .metadata()
        .and_then(|metadata| metadata.modified())
        .map_err(|error| error.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| error.to_string())?
        .as_nanos();
    let bin = git_dir.join("sail-bin").join(version.to_string());
    std::fs::create_dir_all(&bin).map_err(|error| error.to_string())?;
    let proxy = bin.join(if cfg!(windows) { "git.exe" } else { "git" });
    if !proxy.exists() {
        #[cfg(unix)]
        std::os::unix::fs::symlink(&executable, &proxy)
            .or_else(|error| {
                if error.kind() == std::io::ErrorKind::AlreadyExists {
                    Ok(())
                } else {
                    Err(error)
                }
            })
            .map_err(|error| error.to_string())?;
        #[cfg(windows)]
        {
            let temporary = bin.join(format!("git-{}.exe", uuid::Uuid::new_v4()));
            std::fs::copy(&executable, &temporary).map_err(|error| error.to_string())?;
            if let Err(error) = std::fs::rename(&temporary, &proxy) {
                let _ = std::fs::remove_file(&temporary);
                if !proxy.exists() {
                    return Err(error.to_string());
                }
            }
        }
    }
    let path = environment(command, "PATH").unwrap_or_default();
    let paths: Vec<_> = std::env::split_paths(&path)
        .filter(|path| path != &bin)
        .collect();
    let binary = paths
        .iter()
        .map(|path| path.join(if cfg!(windows) { "git.exe" } else { "git" }))
        .find(|path| {
            path.is_file()
                && !path
                    .parent()
                    .and_then(Path::parent)
                    .is_some_and(|parent| parent.ends_with("sail-bin"))
        })
        .ok_or("Cannot find Git for the session worktree.")?;
    command.env("SAIL_GIT_BINARY", binary);
    command.env("SAIL_GIT_DIR", git_dir);
    command.env("SAIL_GIT_WORK_TREE", worktree);
    command.env(
        "PATH",
        std::env::join_paths(std::iter::once(bin.clone()).chain(paths))
            .map_err(|error| error.to_string())?,
    );
    for name in ROUTING {
        command.env_remove(name);
    }
    #[cfg(unix)]
    prepare_shells(command, &bin)?;
    Ok(())
}

pub fn run() -> ! {
    let result = (|| {
        let read = |name| {
            std::env::var_os(name)
                .map(PathBuf::from)
                .ok_or_else(|| format!("Missing {name}"))
        };
        let args: Vec<_> = std::env::args_os().skip(1).collect();
        let mut command = command(
            &read("SAIL_GIT_BINARY")?,
            &read("SAIL_GIT_DIR")?,
            &read("SAIL_GIT_WORK_TREE")?,
            &std::env::current_dir().map_err(|error| error.to_string())?,
            &args,
        );
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            Err(command.exec().to_string())
        }
        #[cfg(not(unix))]
        command
            .status()
            .map(|status| status.code().unwrap_or(1))
            .map_err(|error| error.to_string())
    })();
    match result {
        Ok(code) => std::process::exit(code),
        Err(error) => {
            eprintln!("Sail Git: {error}");
            std::process::exit(1);
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;

    #[test]
    fn login_shells_keep_the_proxy_after_loading_user_startup() {
        let root = std::env::temp_dir().join(format!("sail-git-login-{}", uuid::Uuid::new_v4()));
        struct Scratch(PathBuf);
        impl Drop for Scratch {
            fn drop(&mut self) {
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _scratch = Scratch(root.clone());
        let home = root.join("home");
        std::fs::create_dir_all(&home).unwrap();
        let reset = "export PATH=/usr/bin:/bin\nexport SAIL_USER_PROFILE=loaded\n";
        for name in [".zprofile", ".bash_profile"] {
            std::fs::write(home.join(name), reset).unwrap();
        }
        for shell in ["/bin/zsh", "/bin/bash"] {
            if !Path::new(shell).is_file() {
                continue;
            }
            let mut command = Command::new(shell);
            command
                .env("HOME", &home)
                .env("ZDOTDIR", &home)
                .env_remove("BASH_ENV");
            command.env("PATH", "/usr/bin:/bin");
            prepare(&mut command, &root.join("overlay"), &root).unwrap();
            let bin = environment(&command, "SAIL_GIT_BIN").unwrap();
            command.args([
                "-lc",
                "printf '%s\\n' \"$SAIL_USER_PROFILE\"; command -v git",
            ]);
            let output = command.output().unwrap();
            assert!(
                output.status.success(),
                "{}",
                String::from_utf8_lossy(&output.stderr)
            );
            let expected = format!("loaded\n{}\n", Path::new(&bin).join("git").display());
            assert_eq!(
                String::from_utf8(output.stdout).unwrap(),
                expected,
                "{shell}"
            );
        }
    }
}
