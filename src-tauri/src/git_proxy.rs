use std::ffi::{OsStr, OsString};
use std::path::{Path, PathBuf};
use std::process::Command;

const ROUTING: [&str; 4] = [
    "GIT_DIR",
    "GIT_WORK_TREE",
    "GIT_COMMON_DIR",
    "GIT_INDEX_FILE",
];

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
    let path = command
        .get_envs()
        .find(|(name, _)| *name == OsStr::new("PATH"))
        .and_then(|(_, value)| value.map(OsStr::to_os_string))
        .or_else(|| std::env::var_os("PATH"))
        .unwrap_or_default();
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
        std::env::join_paths(std::iter::once(bin).chain(paths))
            .map_err(|error| error.to_string())?,
    );
    for name in ROUTING {
        command.env_remove(name);
    }
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
