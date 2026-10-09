#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
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
