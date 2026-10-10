#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    #[cfg(all(target_os = "macos", feature = "e2e"))]
    if std::env::args().nth(1).as_deref() == Some("--context-auth-unregister-probe") {
        match sail_lib::context::unregister_e2e_service() {
            Ok(()) => println!("unregistered"),
            Err(error) => {
                eprintln!("unregister: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(all(target_os = "macos", feature = "e2e"))]
    if std::env::args().nth(1).as_deref() == Some("--context-auth-approve-probe") {
        let args: Vec<_> = std::env::args().collect();
        if args.len() != 5 {
            std::process::exit(64);
        }
        match sail_lib::context::prepare_e2e_approval(
            std::path::Path::new(&args[2]),
            &args[3],
            std::path::Path::new(&args[4]),
        ) {
            Ok(()) => println!("approved"),
            Err(error) => {
                eprintln!("approval: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(all(target_os = "macos", feature = "e2e"))]
    if std::env::args().nth(1).as_deref() == Some("--context-auth-revoke-probe") {
        let Some(directory) = std::env::args().nth(2) else {
            std::process::exit(64);
        };
        match sail_lib::context::revoke_e2e_approval(std::path::Path::new(&directory)) {
            Ok(()) => println!("revoked"),
            Err(error) => {
                eprintln!("revoke: {error}");
                std::process::exit(1);
            }
        }
        return;
    }
    #[cfg(all(target_os = "macos", feature = "e2e"))]
    if std::env::args().nth(1).as_deref() == Some("--context-auth-probe") {
        use std::io::{self, BufRead, Write};
        let Some(directory) = std::env::args().nth(2) else {
            std::process::exit(64);
        };
        let session =
            match sail_lib::context::ContextSession::open(std::path::Path::new(&directory)) {
                Ok(session) => session,
                Err(error) => {
                    eprintln!("open: {error}");
                    std::process::exit(1);
                }
            };
        println!("opened");
        let _ = io::stdout().flush();
        for line in io::stdin().lock().lines() {
            match line.as_deref() {
                Ok("check") => match session.check() {
                    Ok(()) => println!("authorized"),
                    Err(error) => println!("rejected: {error}"),
                },
                Ok("close") => break,
                _ => println!("invalid request"),
            }
            let _ = io::stdout().flush();
        }
        return;
    }
    #[cfg(target_os = "macos")]
    if sail_lib::context::is_service_process() {
        std::process::exit(sail_lib::context::service_main());
    }
    if std::env::args().nth(1).as_deref() == Some("--hook-deliver") {
        sail_lib::hook_activity::deliver_from_stdin();
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--browser-mcp") {
        sail_lib::browser_agent::run_mcp_stdio();
        return;
    }
    if std::env::args().nth(1).as_deref() == Some("--memory-mcp") {
        sail_lib::memory::run_mcp_stdio();
        return;
    }
    sail_lib::run();
}
