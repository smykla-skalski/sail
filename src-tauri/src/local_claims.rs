use crate::github::{self, ShippingClaim, ShippingClaimObservation};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

#[derive(Default, Deserialize, Serialize)]
struct ClaimStore {
    next_id: u64,
    claims: BTreeMap<String, ShippingClaim>,
}

fn now_millis() -> Result<i64, String> {
    let elapsed = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "System clock precedes the Unix epoch.".to_string())?;
    i64::try_from(elapsed.as_millis()).map_err(|_| "System clock is out of range.".to_string())
}

fn store_path(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    Ok(crate::settings::settings_path(app)?.with_file_name("shipping-claims.json"))
}

#[cfg(feature = "e2e")]
pub(crate) fn reset_test_store(app: &tauri::AppHandle) -> Result<(), String> {
    with_store(&store_path(app)?, |store| {
        *store = ClaimStore::default();
        Ok(((), true))
    })
}

fn with_store<T>(
    path: &Path,
    operation: impl FnOnce(&mut ClaimStore) -> Result<(T, bool), String>,
) -> Result<T, String> {
    let parent = path.parent().ok_or("Cannot locate Sail claim folder.")?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Cannot create Sail claim folder: {error}"))?;
    let lock = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(path.with_extension("lock"))
        .map_err(|error| format!("Cannot open Sail claim lock: {error}"))?;
    lock.lock()
        .map_err(|error| format!("Cannot lock Sail claims: {error}"))?;
    let saved = fs::read(path).or_else(|error| {
        if error.kind() == std::io::ErrorKind::NotFound {
            fs::read(path.with_extension("json.bak"))
        } else {
            Err(error)
        }
    });
    let mut store = match saved {
        Ok(bytes) => serde_json::from_slice(&bytes)
            .map_err(|error| format!("Cannot parse Sail claims: {error}"))?,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => ClaimStore::default(),
        Err(error) => return Err(format!("Cannot read Sail claims: {error}")),
    };
    let (result, changed) = operation(&mut store)?;
    if changed {
        let temporary = path.with_extension(format!("json.{}.tmp", uuid::Uuid::new_v4()));
        let bytes = serde_json::to_vec(&store)
            .map_err(|error| format!("Cannot encode Sail claims: {error}"))?;
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options
            .open(&temporary)
            .map_err(|error| format!("Cannot write Sail claims: {error}"))?;
        file.write_all(&bytes)
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Cannot write Sail claims: {error}"))?;
        drop(file);
        #[cfg(windows)]
        {
            let backup = path.with_extension("json.bak");
            if path.exists() {
                if backup.exists() {
                    fs::remove_file(&backup)
                        .map_err(|error| format!("Cannot replace Sail claims backup: {error}"))?;
                }
                fs::rename(path, &backup)
                    .map_err(|error| format!("Cannot back up Sail claims: {error}"))?;
            }
            if let Err(error) = fs::rename(&temporary, path) {
                if backup.exists() {
                    let _ = fs::rename(&backup, path);
                }
                return Err(format!("Cannot save Sail claims: {error}"));
            }
            if backup.exists() {
                let _ = fs::remove_file(backup);
            }
        }
        #[cfg(not(windows))]
        fs::rename(&temporary, path)
            .map_err(|error| format!("Cannot save Sail claims: {error}"))?;
    }
    Ok(result)
}

fn claim_key(target: &str, number: u64) -> Result<String, String> {
    if number == 0 {
        return Err("Invalid shipping claim target.".to_string());
    }
    Ok(format!("{}#{number}", target.to_ascii_lowercase()))
}

fn same_claim(stored: &ShippingClaim, submitted: &ShippingClaim) -> bool {
    stored.id == submitted.id
        && stored.comment_id == submitted.comment_id
        && stored.instance_id == submitted.instance_id
        && stored.task == submitted.task
        && stored.acquired_at == submitted.acquired_at
}

fn active(claim: &ShippingClaim, now: i64) -> bool {
    claim.status == "active"
        && github::claim_time_millis(&claim.expires_at).is_some_and(|expiry| expiry > now)
}

fn acquire_at(
    store: &mut ClaimStore,
    key: &str,
    mut claim: ShippingClaim,
    now: i64,
) -> Result<(ShippingClaim, bool), String> {
    github::validated_claim_input(&claim)?;
    if claim.instance_id.is_none() || claim.comment_id != 0 {
        return Err("Invalid local shipping claim acquisition.".to_string());
    }
    if let Some(previous) = store.claims.get(key) {
        if active(previous, now) {
            if previous.id == claim.id
                && previous.instance_id == claim.instance_id
                && previous.task == claim.task
            {
                return Ok((previous.clone(), false));
            }
            return Err(format!(
                "Issue is already claimed locally by {} until {}.",
                previous.holder, previous.expires_at
            ));
        }
        claim.takeover_of = Some(previous.id.clone());
    }
    let duration = github::claim_time_millis(&claim.expires_at)
        .zip(github::claim_time_millis(&claim.heartbeat_at))
        .map(|(expiry, heartbeat)| expiry - heartbeat)
        .ok_or("Invalid shipping claim lease.")?;
    claim.heartbeat_at = github::claim_time_from_millis(now)?;
    claim.expires_at = github::claim_time_from_millis(now.saturating_add(duration))?;
    claim.status = "active".to_string();
    claim.released_at = None;
    claim.release_reason = None;
    store.next_id = store
        .next_id
        .checked_add(1)
        .ok_or("Sail claim IDs are exhausted.")?;
    claim.comment_id = store.next_id;
    claim.comment_updated_at_millis = Some(now);
    store.claims.insert(key.to_string(), claim.clone());
    Ok((claim, true))
}

fn heartbeat_at(
    store: &mut ClaimStore,
    key: &str,
    claim: &ShippingClaim,
    instance_id: &str,
    lease_millis: i64,
    now: i64,
) -> Result<(ShippingClaim, bool), String> {
    if !(1..=300_000).contains(&lease_millis) || claim.instance_id.as_deref() != Some(instance_id) {
        return Err("Invalid local shipping claim heartbeat.".to_string());
    }
    let stored = store
        .claims
        .get_mut(key)
        .ok_or("Local shipping claim no longer exists.")?;
    if !same_claim(stored, claim) || !active(stored, now) {
        return Err("Local shipping claim is no longer owned or has expired.".to_string());
    }
    let heartbeat = now.max(
        github::claim_time_millis(&stored.heartbeat_at)
            .ok_or("Invalid stored claim heartbeat.")?
            .saturating_add(1),
    );
    stored.heartbeat_at = github::claim_time_from_millis(heartbeat)?;
    stored.expires_at = github::claim_time_from_millis(heartbeat.saturating_add(lease_millis))?;
    stored.comment_updated_at_millis = Some(now);
    Ok((stored.clone(), true))
}

fn release_at(
    store: &mut ClaimStore,
    key: &str,
    claim: &ShippingClaim,
    instance_id: &str,
    reason: &str,
    now: i64,
) -> Result<(ShippingClaim, bool), String> {
    if reason.trim().is_empty()
        || reason.len() > 200
        || claim.instance_id.as_deref() != Some(instance_id)
    {
        return Err("Invalid local shipping claim release.".to_string());
    }
    let stored = store
        .claims
        .get_mut(key)
        .ok_or("Local shipping claim no longer exists.")?;
    if !same_claim(stored, claim) {
        return Err("Local shipping claim is no longer owned by this instance.".to_string());
    }
    if stored.status == "released" {
        return Ok((stored.clone(), false));
    }
    stored.released_heartbeat_at = Some(stored.heartbeat_at.clone());
    stored.released_expires_at = Some(stored.expires_at.clone());
    stored.released_comment_updated_at_millis = stored.comment_updated_at_millis;
    stored.status = "released".to_string();
    stored.released_at = Some(github::claim_time_from_millis(now)?);
    stored.release_reason = Some(reason.to_string());
    stored.comment_updated_at_millis = Some(now);
    Ok((stored.clone(), true))
}

#[tauri::command]
pub async fn acquire_shipping_claim(
    app: tauri::AppHandle,
    repository: String,
    expected_repository: String,
    number: u64,
    claim: ShippingClaim,
) -> Result<ShippingClaim, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = github::require_target_repository(&repository, &expected_repository)?;
        if let Some(conflict) = github::equivalent_shipping_work(&repository, &target, number)? {
            return Err(conflict);
        }
        let key = claim_key(&target, number)?;
        let path = store_path(&app)?;
        with_store(&path, |store| acquire_at(store, &key, claim, now_millis()?))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn heartbeat_shipping_claim(
    app: tauri::AppHandle,
    repository: String,
    expected_repository: String,
    number: u64,
    claim: ShippingClaim,
    instance_id: String,
    lease_millis: i64,
) -> Result<ShippingClaim, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::validated_claim_input(&claim)?;
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = github::require_target_repository(&repository, &expected_repository)?;
        let key = claim_key(&target, number)?;
        with_store(&store_path(&app)?, |store| {
            heartbeat_at(
                store,
                &key,
                &claim,
                &instance_id,
                lease_millis,
                now_millis()?,
            )
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn release_shipping_claim(
    app: tauri::AppHandle,
    repository: String,
    expected_repository: String,
    number: u64,
    claim: ShippingClaim,
    instance_id: String,
    reason: String,
) -> Result<ShippingClaim, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::validated_claim_input(&claim)?;
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = github::require_target_repository(&repository, &expected_repository)?;
        let key = claim_key(&target, number)?;
        with_store(&store_path(&app)?, |store| {
            release_at(store, &key, &claim, &instance_id, &reason, now_millis()?)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn observe_shipping_claim(
    app: tauri::AppHandle,
    repository: String,
    number: u64,
    claim: ShippingClaim,
    recovery_id: String,
) -> Result<ShippingClaimObservation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::validated_claim_input(&claim)?;
        if recovery_id.trim().is_empty() {
            return Err("Invalid shipping claim recovery identity.".to_string());
        }
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = github::target_repository_of(&repository)?;
        let key = claim_key(&target, number)?;
        with_store(&store_path(&app)?, |store| {
            let now = now_millis()?;
            let stored = store
                .claims
                .get(&key)
                .filter(|stored| same_claim(stored, &claim));
            let claim = stored.cloned().unwrap_or(claim);
            let active = stored.is_some_and(|stored| active(stored, now));
            let remaining_lease_millis = if active {
                github::claim_time_millis(&claim.expires_at)
                    .unwrap_or_default()
                    .saturating_sub(now)
            } else {
                0
            };
            Ok((
                ShippingClaimObservation {
                    claim,
                    active,
                    remaining_lease_millis,
                },
                false,
            ))
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn complete_predecessor_shipping_claim_fence(
    app: tauri::AppHandle,
    repository: String,
    number: u64,
    claim: ShippingClaim,
    recovery_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        github::validated_claim_input(&claim)?;
        if recovery_id.trim().is_empty() {
            return Err("Invalid shipping claim recovery identity.".to_string());
        }
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = github::target_repository_of(&repository)?;
        let key = claim_key(&target, number)?;
        with_store(&store_path(&app)?, |store| {
            let now = now_millis()?;
            if store
                .claims
                .get(&key)
                .is_some_and(|stored| same_claim(stored, &claim) && active(stored, now))
            {
                return Err("Predecessor shipping claim is still active.".to_string());
            }
            Ok(((), false))
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn claim(id: &str, instance: &str) -> ShippingClaim {
        serde_json::from_value(serde_json::json!({
            "id": id,
            "instanceId": instance,
            "holder": instance,
            "task": "ship:owner/repo#7",
            "acquiredAt": "2026-10-12T09:00:00.000Z",
            "heartbeatAt": "2026-10-12T09:00:00.000Z",
            "expiresAt": "2026-10-12T09:02:00.000Z",
            "status": "active",
            "commentId": 0
        }))
        .unwrap()
    }

    #[test]
    fn local_claims_exclude_other_instances_and_release_without_remote_state() {
        let mut store = ClaimStore::default();
        let now = github::claim_time_millis("2026-10-12T09:00:01.000Z").unwrap();
        let (first, _) = acquire_at(&mut store, "owner/repo#7", claim("a", "one"), now).unwrap();
        assert_eq!(first.comment_id, 1);
        assert!(acquire_at(&mut store, "owner/repo#7", claim("b", "two"), now).is_err());
        let (renewed, _) = heartbeat_at(
            &mut store,
            "owner/repo#7",
            &first,
            "one",
            120_000,
            now + 30_000,
        )
        .unwrap();
        assert!(heartbeat_at(
            &mut store,
            "owner/repo#7",
            &first,
            "two",
            120_000,
            now + 31_000
        )
        .is_err());
        let (released, _) = release_at(
            &mut store,
            "owner/repo#7",
            &renewed,
            "one",
            "completed",
            now + 40_000,
        )
        .unwrap();
        assert_eq!(released.status, "released");
        let (second, _) =
            acquire_at(&mut store, "owner/repo#7", claim("b", "two"), now + 41_000).unwrap();
        assert_eq!(second.takeover_of.as_deref(), Some("a"));
        assert!(release_at(
            &mut store,
            "owner/repo#7",
            &first,
            "one",
            "late",
            now + 42_000
        )
        .is_err());
    }

    #[test]
    fn concurrent_local_claims_have_one_winner() {
        use std::sync::{Arc, Barrier};

        let root = std::env::temp_dir().join(format!("sail-claims-test-{}", uuid::Uuid::new_v4()));
        let path = root.join("shipping-claims.json");
        let now = github::claim_time_millis("2026-10-12T09:00:01.000Z").unwrap();
        let barrier = Arc::new(Barrier::new(2));
        let attempts = ["one", "two"].map(|instance| {
            let path = path.clone();
            let barrier = Arc::clone(&barrier);
            std::thread::spawn(move || {
                barrier.wait();
                with_store(&path, |store| {
                    acquire_at(store, "owner/repo#7", claim(instance, instance), now)
                })
            })
        });
        let outcomes = attempts.map(|attempt| attempt.join().unwrap());
        assert_eq!(outcomes.iter().filter(|outcome| outcome.is_ok()).count(), 1);
        let seen = with_store(&path, |store| {
            Ok((store.claims.get("owner/repo#7").cloned(), false))
        })
        .unwrap();
        assert_eq!(seen.unwrap().comment_id, 1);
        fs::remove_dir_all(root).unwrap();
    }
}
