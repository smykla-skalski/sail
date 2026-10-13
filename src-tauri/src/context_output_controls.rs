use crate::context_output_store::{
    default_root, load_preferences, save_preferences, OutputPreferences, OutputStore, StoreWarning,
};
use serde::Serialize;

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OutputStorageStatus {
    items: usize,
    bytes: u64,
    retention_days: u64,
    max_total_mib: u64,
    max_retention_days: u64,
    max_size_mib: u64,
}

fn warning(error: StoreWarning) -> String {
    error.message().to_owned()
}

fn status() -> Result<OutputStorageStatus, StoreWarning> {
    let root = default_root()?;
    let preferences = load_preferences(&root)?;
    let store = OutputStore::open(root, preferences.limits()?)?;
    let usage = store.usage(None)?;
    Ok(OutputStorageStatus {
        items: usage.items,
        bytes: usage.bytes,
        retention_days: preferences.retention_days,
        max_total_mib: preferences.max_total_mib,
        max_retention_days: 365,
        max_size_mib: 256,
    })
}

#[tauri::command]
pub fn context_output_status() -> Result<OutputStorageStatus, String> {
    status().map_err(warning)
}

#[tauri::command]
pub fn context_output_save_limits(
    retention_days: u64,
    max_total_mib: u64,
) -> Result<OutputStorageStatus, String> {
    let preferences = OutputPreferences {
        retention_days,
        max_total_mib,
    };
    preferences.limits().map_err(warning)?;
    save_preferences(&default_root().map_err(warning)?, preferences).map_err(warning)?;
    status().map_err(warning)
}

#[tauri::command]
pub fn context_output_purge() -> Result<OutputStorageStatus, String> {
    let root = default_root().map_err(warning)?;
    let preferences = load_preferences(&root).map_err(warning)?;
    let store = OutputStore::open(root, preferences.limits().map_err(warning)?).map_err(warning)?;
    store.purge_all().map_err(warning)?;
    status().map_err(warning)
}
