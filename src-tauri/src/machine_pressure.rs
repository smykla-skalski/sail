use serde::Serialize;
use sysinfo::{Disks, System};

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MachineReading {
    total_memory: u64,
    available_memory: u64,
    total_swap: u64,
    used_swap: u64,
    total_disk: u64,
    available_disk: u64,
}

#[tauri::command]
pub async fn machine_pressure(directory: Option<String>) -> Result<MachineReading, String> {
    let mut system = System::new();
    system.refresh_memory();
    let path = match directory {
        Some(path) => std::path::PathBuf::from(path),
        None => std::env::current_dir().map_err(|error| error.to_string())?,
    };
    let path = path.canonicalize().map_err(|error| error.to_string())?;
    let disks = Disks::new_with_refreshed_list();
    let disk = disks
        .list()
        .iter()
        .filter(|disk| path.starts_with(disk.mount_point()))
        .max_by_key(|disk| disk.mount_point().components().count())
        .ok_or_else(|| format!("No mounted disk contains {}", path.display()))?;
    Ok(MachineReading {
        total_memory: system.total_memory(),
        available_memory: system.available_memory(),
        total_swap: system.total_swap(),
        used_swap: system.used_swap(),
        total_disk: disk.total_space(),
        available_disk: disk.available_space(),
    })
}
