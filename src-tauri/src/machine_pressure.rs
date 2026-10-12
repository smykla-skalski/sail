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
    let reading = MachineReading {
        total_memory: system.total_memory(),
        available_memory: system.available_memory(),
        total_swap: system.total_swap(),
        used_swap: system.used_swap(),
        total_disk: disk.total_space(),
        available_disk: disk.available_space(),
    };
    #[cfg(feature = "e2e")]
    let reading = e2e_machine_reading(reading)?;
    Ok(reading)
}

#[cfg(feature = "e2e")]
fn e2e_machine_reading(mut reading: MachineReading) -> Result<MachineReading, String> {
    let Some(value) = std::env::var_os("SAIL_E2E_MACHINE_READING") else {
        return Ok(reading);
    };
    if value != "healthy" {
        return Err("SAIL_E2E_MACHINE_READING must be 'healthy' in E2E builds.".into());
    }
    reading.total_memory = 32_u64 * 1024 * 1024 * 1024;
    reading.available_memory = 24_u64 * 1024 * 1024 * 1024;
    reading.total_swap = 8_u64 * 1024 * 1024 * 1024;
    reading.used_swap = 0;
    Ok(reading)
}
