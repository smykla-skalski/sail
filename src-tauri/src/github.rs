use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::ffi::OsString;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Output, Stdio};
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, UNIX_EPOCH};
use wait_timeout::ChildExt;

#[cfg(unix)]
use nix::{sys::signal, unistd::Pid};
#[cfg(unix)]
use std::os::unix::process::CommandExt;
#[cfg(windows)]
use std::os::windows::io::AsRawHandle;
#[cfg(windows)]
use std::os::windows::process::CommandExt;
#[cfg(windows)]
use windows::core::PCWSTR;
#[cfg(windows)]
use windows::Win32::{
    Foundation::{CloseHandle, HANDLE},
    System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, Thread32First, Thread32Next, TH32CS_SNAPTHREAD, THREADENTRY32,
    },
    System::JobObjects::{
        AssignProcessToJobObject, CreateJobObjectW, JobObjectBasicAccountingInformation,
        JobObjectExtendedLimitInformation, QueryInformationJobObject, SetInformationJobObject,
        TerminateJobObject, JOBOBJECT_BASIC_ACCOUNTING_INFORMATION,
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION, JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
    },
    System::Threading::{OpenThread, ResumeThread, CREATE_SUSPENDED, THREAD_SUSPEND_RESUME},
};

static GRAPH_PUBLISH_LOCK: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Serialize, Deserialize)]
pub struct PullRequest {
    number: u64,
    url: String,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingPullRequest {
    number: u64,
    url: String,
    state: String,
    merged_at: Option<String>,
    head_ref_oid: String,
    #[serde(default)]
    checks: Vec<PullRequestCheck>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingClaim {
    id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    instance_id: Option<String>,
    holder: String,
    task: String,
    acquired_at: String,
    heartbeat_at: String,
    expires_at: String,
    status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    released_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    release_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    takeover_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    released_heartbeat_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    released_expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    released_comment_updated_at_millis: Option<i64>,
    #[serde(default)]
    comment_id: u64,
    #[serde(skip)]
    comment_created_at_millis: Option<i64>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    comment_updated_at_millis: Option<i64>,
    #[serde(skip)]
    eligible_author: bool,
    #[serde(skip)]
    comment_author: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingClaimObservation {
    claim: ShippingClaim,
    active: bool,
}

const CLAIM_PREFIX: &str = "<!-- sail-claim:v1 ";
const CLAIM_SUFFIX: &str = " -->";
const MAX_CLAIM_LEASE_MILLIS: i64 = 5 * 60 * 1_000;
const RECENT_EQUIVALENT_PULL_REQUEST_MILLIS: i64 = 14 * 24 * 60 * 60 * 1_000;
const CLAIM_LOCK_DESCRIPTION_PREFIX: &str = "sail-lock:v1:";
const CLAIM_LOCK_SLOTS: usize = 16;

#[derive(Clone, Debug, Eq, PartialEq)]
struct ClaimLockOwner {
    claim_token: String,
    operation_token: Option<String>,
    expires_at: Option<i64>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
enum RepositoryLabelState {
    Missing,
    Unmanaged,
    Managed {
        owner: ClaimLockOwner,
        node_id: String,
    },
}

#[derive(Clone, Debug)]
struct ClaimLock {
    name: String,
    owner: Option<ClaimLockOwner>,
    node_id: Option<String>,
}

fn valid_claim_value(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum
        && !value.contains('\n')
        && !value.contains('\r')
        && !value.contains("-->")
}

fn claim_time_millis(value: &str) -> Option<i64> {
    let bytes = value.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
        || bytes.iter().enumerate().any(|(index, byte)| {
            !matches!(index, 4 | 7 | 10 | 13 | 16 | 19 | 23) && !byte.is_ascii_digit()
        })
    {
        return None;
    }
    let number = |start: usize, end: usize| value[start..end].parse::<i64>().ok();
    let year = number(0, 4)?;
    let month = number(5, 7)?;
    let day = number(8, 10)?;
    let hour = number(11, 13)?;
    let minute = number(14, 16)?;
    let second = number(17, 19)?;
    let millis = number(20, 23)?;
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let month_days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return None,
    };
    if year < 1970 || day == 0 || day > month_days || hour > 23 || minute > 59 || second > 59 {
        return None;
    }
    let prior_year = year - 1;
    let leap_days = prior_year / 4 - prior_year / 100 + prior_year / 400;
    let epoch_prior_year = 1969;
    let epoch_leap_days = epoch_prior_year / 4 - epoch_prior_year / 100 + epoch_prior_year / 400;
    let days_before_year = (year - 1970) * 365 + leap_days - epoch_leap_days;
    let days_before_month = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334]
        [(month - 1) as usize]
        + i64::from(leap && month > 2);
    Some(
        (((days_before_year + days_before_month + day - 1) * 24 + hour) * 60 + minute) * 60 * 1_000
            + second * 1_000
            + millis,
    )
}

fn valid_claim_time(value: &str) -> bool {
    claim_time_millis(value).is_some()
}

fn github_time_millis(value: &str) -> Option<i64> {
    if value.len() == 20 && value.ends_with('Z') {
        return claim_time_millis(&format!("{}.000Z", &value[..19]));
    }
    claim_time_millis(value)
}

fn claim_body(claim: &ShippingClaim) -> Result<String, String> {
    let mut marker = claim.clone();
    marker.comment_id = 0;
    marker.comment_created_at_millis = None;
    marker.comment_updated_at_millis = None;
    let marker = serde_json::to_string(&marker).map_err(|error| error.to_string())?;
    let mut body = format!(
        "{CLAIM_PREFIX}{marker}{CLAIM_SUFFIX}\nSail work claim for **{}**.\n\n- Holder: `{}`\n- Task: `{}`\n- Acquired: `{}`\n- Last heartbeat: `{}`\n- Expires: `{}`\n- Status: `{}`",
        claim.task,
        claim.holder,
        claim.task,
        claim.acquired_at,
        claim.heartbeat_at,
        claim.expires_at,
        claim.status,
    );
    if let Some(takeover) = &claim.takeover_of {
        body.push_str(&format!("\n- Takeover of expired claim: `{takeover}`"));
    }
    if let Some(released) = &claim.released_at {
        body.push_str(&format!("\n- Released: `{released}`"));
    }
    if let Some(reason) = &claim.release_reason {
        body.push_str(&format!("\n- Release reason: `{reason}`"));
    }
    Ok(body)
}

fn parse_claim(body: &str, comment_id: u64) -> Option<ShippingClaim> {
    let start = body.find(CLAIM_PREFIX)? + CLAIM_PREFIX.len();
    let tail = &body[start..];
    let end = tail.find(CLAIM_SUFFIX)?;
    let mut claim: ShippingClaim = serde_json::from_str(&tail[..end]).ok()?;
    claim.comment_id = comment_id;
    claim.comment_created_at_millis = None;
    claim.comment_updated_at_millis = None;
    claim.eligible_author = false;
    claim.comment_author = None;
    valid_stored_claim(&claim).then_some(claim)
}

fn valid_stored_claim(claim: &ShippingClaim) -> bool {
    if validated_claim_input(claim).is_err()
        || claim.comment_id == 0
        || claim
            .takeover_of
            .as_deref()
            .is_some_and(|value| !valid_claim_value(value, 100))
    {
        return false;
    }
    match claim.status.as_str() {
        "active" => claim.released_at.is_none() && claim.release_reason.is_none(),
        "released" => {
            claim.released_at.as_deref().is_some_and(valid_claim_time)
                && claim
                    .released_at
                    .as_ref()
                    .is_some_and(|released| released >= &claim.acquired_at)
                && claim
                    .release_reason
                    .as_deref()
                    .is_some_and(|reason| valid_claim_value(reason, 200))
                && claim
                    .released_heartbeat_at
                    .as_deref()
                    .is_some_and(valid_claim_time)
                && claim
                    .released_expires_at
                    .as_deref()
                    .is_some_and(valid_claim_time)
        }
        _ => false,
    }
}

fn issue_comments(
    directory: &Path,
    target: &str,
    number: u64,
) -> Result<Vec<ShippingClaim>, String> {
    let endpoint = format!("repos/{target}/issues/{number}/comments?per_page=100");
    let output = gh_command(directory, &["api", "--paginate", "--slurp", &endpoint])?;
    let pages: Vec<Vec<serde_json::Value>> = serde_json::from_str(&output)
        .map_err(|_| "GitHub returned invalid issue comments.".to_string())?;
    Ok(pages
        .into_iter()
        .flatten()
        .filter_map(|comment| {
            let mut claim = parse_claim(comment["body"].as_str()?, comment["id"].as_u64()?)?;
            claim.comment_created_at_millis = github_time_millis(comment["created_at"].as_str()?);
            claim.comment_updated_at_millis = github_time_millis(comment["updated_at"].as_str()?);
            claim.eligible_author = eligible_claim_author(comment["author_association"].as_str()?);
            claim.comment_author = Some(comment["user"]["login"].as_str()?.to_ascii_lowercase());
            claim
                .comment_created_at_millis
                .zip(claim.comment_updated_at_millis)
                .map(|_| claim)
        })
        .collect())
}

fn issue_claim_comment(
    directory: &Path,
    target: &str,
    comment_id: u64,
) -> Result<ShippingClaim, String> {
    let endpoint = format!("repos/{target}/issues/comments/{comment_id}");
    let output = gh_command(directory, &["api", &endpoint])?;
    let value: serde_json::Value = serde_json::from_str(&output)
        .map_err(|_| "GitHub returned an invalid claim comment.".to_string())?;
    claim_from_comment(&value)
        .ok_or_else(|| "GitHub claim comment no longer contains a valid claim.".to_string())
}

fn claim_from_comment(value: &serde_json::Value) -> Option<ShippingClaim> {
    let mut claim = parse_claim(value["body"].as_str()?, value["id"].as_u64()?)?;
    claim.comment_created_at_millis = github_time_millis(value["created_at"].as_str()?);
    claim.comment_updated_at_millis = github_time_millis(value["updated_at"].as_str()?);
    claim.eligible_author = eligible_claim_author(value["author_association"].as_str()?);
    claim.comment_author = Some(value["user"]["login"].as_str()?.to_ascii_lowercase());
    claim
        .comment_created_at_millis
        .zip(claim.comment_updated_at_millis)
        .map(|_| claim)
}

fn eligible_claim_author(author_association: &str) -> bool {
    matches!(author_association, "OWNER" | "MEMBER" | "COLLABORATOR")
}

fn claim_server_expiry(claim: &ShippingClaim) -> Option<i64> {
    let duration = claim_time_millis(&claim.expires_at)? - claim_time_millis(&claim.heartbeat_at)?;
    let server_expiry = claim.comment_updated_at_millis?.checked_add(duration)?;
    Some(server_expiry.min(claim_time_millis(&claim.expires_at)?))
}

fn initial_claim_window(
    claim: &ShippingClaim,
    observed_at: i64,
) -> Result<(String, String), String> {
    let acquired_at = claim_time_millis(&claim.acquired_at)
        .ok_or("Shipping claim has an invalid acquisition time.")?;
    let lease_millis = claim_time_millis(&claim.expires_at)
        .zip(claim_time_millis(&claim.heartbeat_at))
        .map(|(expires_at, heartbeat_at)| expires_at - heartbeat_at)
        .filter(|lease| (1..=MAX_CLAIM_LEASE_MILLIS).contains(lease))
        .ok_or("Invalid shipping claim lease.")?;
    let heartbeat_at = observed_at.max(acquired_at);
    let expires_at = heartbeat_at
        .checked_add(lease_millis)
        .ok_or("Shipping claim expiry is out of range.")?;
    Ok((
        claim_time_from_millis(heartbeat_at)?,
        claim_time_from_millis(expires_at)?,
    ))
}

fn claim_released(claims: &[ShippingClaim], claim: &ShippingClaim) -> bool {
    claims.iter().any(|candidate| {
        candidate.eligible_author
            && candidate.id == claim.id
            && candidate.status == "released"
            && candidate.comment_author == claim.comment_author
            && candidate.instance_id == claim.instance_id
            && candidate.holder == claim.holder
            && candidate.task == claim.task
            && candidate.acquired_at == claim.acquired_at
            && candidate.released_heartbeat_at.as_deref() == Some(claim.heartbeat_at.as_str())
            && candidate.released_expires_at.as_deref() == Some(claim.expires_at.as_str())
            && candidate
                .released_comment_updated_at_millis
                .is_none_or(|revision| Some(revision) == claim.comment_updated_at_millis)
    })
}

fn matching_claim_release<'a>(
    claims: &'a [ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
) -> Option<&'a ShippingClaim> {
    claims.iter().find(|candidate| {
        candidate.eligible_author
            && candidate.status == "released"
            && candidate.id == claim.id
            && candidate.comment_author.as_deref() == Some(authenticated_user)
            && candidate.instance_id == claim.instance_id
            && candidate.holder == claim.holder
            && candidate.task == claim.task
            && candidate.acquired_at == claim.acquired_at
            && candidate.released_heartbeat_at.as_deref() == Some(claim.heartbeat_at.as_str())
            && candidate.released_expires_at.as_deref() == Some(claim.expires_at.as_str())
            && candidate.released_comment_updated_at_millis == claim.comment_updated_at_millis
    })
}

fn same_claim_identity(left: &ShippingClaim, right: &ShippingClaim) -> bool {
    left.id == right.id
        && left.instance_id == right.instance_id
        && left.holder == right.holder
        && left.task == right.task
        && left.acquired_at == right.acquired_at
}

fn acquisition_retry_claim<'a>(
    claims: &'a [ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
) -> Result<Option<&'a ShippingClaim>, String> {
    let same_id = claims.iter().filter(|candidate| candidate.id == claim.id);
    let mut found = false;
    for candidate in same_id {
        found = true;
        if candidate.eligible_author
            && candidate.comment_author.as_deref() == Some(authenticated_user)
            && candidate.status == "active"
            && same_claim_identity(candidate, claim)
        {
            return Ok(Some(candidate));
        }
    }
    if found {
        return Err("Shipping claim id already belongs to another claim.".to_string());
    }
    Ok(None)
}

fn acquisition_retry_outcome<'a>(
    claims: &'a [ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
    observed_at: i64,
) -> Result<Option<(&'a ShippingClaim, Option<&'a ShippingClaim>)>, String> {
    let Some(retry) = acquisition_retry_claim(claims, claim, authenticated_user)? else {
        return Ok(None);
    };
    Ok(Some((retry, active_claim_winner(claims, observed_at))))
}

fn released_claim_marker(
    claim: &ShippingClaim,
    observed_at: i64,
    reason: &str,
) -> Result<ShippingClaim, String> {
    let acquired_at = claim_time_millis(&claim.acquired_at)
        .ok_or("Shipping claim has an invalid acquisition time.")?;
    let mut released = claim.clone();
    released.status = "released".to_string();
    released.released_at = Some(claim_time_from_millis(observed_at.max(acquired_at))?);
    released.release_reason = Some(reason.to_string());
    released.released_heartbeat_at = Some(claim.heartbeat_at.clone());
    released.released_expires_at = Some(claim.expires_at.clone());
    released.released_comment_updated_at_millis = claim.comment_updated_at_millis;
    Ok(released)
}

fn posted_release_claim(
    mut released: ShippingClaim,
    response: Result<serde_json::Value, String>,
    context: &str,
) -> Result<ShippingClaim, String> {
    let value =
        response.map_err(|error| format!("{context}; compensating release failed: {error}"))?;
    released.comment_id = value["id"]
        .as_u64()
        .ok_or("GitHub claim release comment has no id.")?;
    Ok(released)
}

fn heartbeat_stored_claim<'a>(
    claims: &'a [ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
) -> Result<&'a ShippingClaim, String> {
    let stored = claims
        .iter()
        .find(|stored| stored.comment_id == claim.comment_id && stored.id == claim.id)
        .ok_or("Shipping claim comment no longer exists.")?;
    if !stored.eligible_author
        || stored.comment_author.as_deref() != Some(authenticated_user)
        || stored.status != "active"
        || !same_claim_identity(stored, claim)
    {
        return Err("Shipping claim identity no longer matches its comment.".to_string());
    }
    if stored.heartbeat_at != claim.heartbeat_at || stored.expires_at != claim.expires_at {
        return Err("Shipping claim heartbeat is stale.".to_string());
    }
    if let Some(revision) = claim.comment_updated_at_millis {
        if stored.comment_updated_at_millis != Some(revision) {
            return Err("Shipping claim update revision is stale.".to_string());
        }
    }
    Ok(stored)
}

fn heartbeat_retry_claim<'a>(
    claims: &'a [ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
    instance_id: &str,
) -> Result<&'a ShippingClaim, String> {
    if claim.instance_id.as_deref() != Some(instance_id) {
        return Err("Shipping claim belongs to another Sail instance.".to_string());
    }
    match heartbeat_stored_claim(claims, claim, authenticated_user) {
        Ok(stored) => Ok(stored),
        Err(error) => claims
            .iter()
            .find(|candidate| {
                candidate.eligible_author
                    && candidate.comment_author.as_deref() == Some(authenticated_user)
                    && candidate.status == "active"
                    && candidate.comment_id == claim.comment_id
                    && candidate.instance_id.as_deref() == Some(instance_id)
                    && same_claim_identity(candidate, claim)
            })
            .ok_or(error),
    }
}

fn exact_heartbeat_marker(
    candidate: &ShippingClaim,
    submitted: &ShippingClaim,
    authenticated_user: &str,
    verified_at: i64,
) -> bool {
    candidate.eligible_author
        && candidate.comment_author.as_deref() == Some(authenticated_user)
        && candidate.comment_id == submitted.comment_id
        && candidate.status == "active"
        && same_claim_identity(candidate, submitted)
        && candidate.heartbeat_at == submitted.heartbeat_at
        && candidate.expires_at == submitted.expires_at
        && candidate.takeover_of == submitted.takeover_of
        && candidate.comment_updated_at_millis == Some(verified_at)
}

fn submitted_heartbeat_still_current(
    claims: &[ShippingClaim],
    submitted: &ShippingClaim,
    authenticated_user: &str,
    verified_at: i64,
) -> bool {
    claims
        .iter()
        .find(|candidate| candidate.comment_id == submitted.comment_id)
        .is_some_and(|candidate| {
            exact_heartbeat_marker(candidate, submitted, authenticated_user, verified_at)
        })
}

fn reconciled_heartbeat_revision(
    claims: &[ShippingClaim],
    submitted: &ShippingClaim,
    authenticated_user: &str,
) -> Option<i64> {
    let candidate = claims
        .iter()
        .find(|candidate| candidate.comment_id == submitted.comment_id)?;
    let revision = candidate.comment_updated_at_millis?;
    exact_heartbeat_marker(candidate, submitted, authenticated_user, revision).then_some(revision)
}

fn rollback_unapplied_heartbeat_fence(
    observed: &ShippingClaim,
    previous: &ShippingClaim,
    authenticated_user: &str,
    rollback: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    if !unapplied_heartbeat_revision(observed, previous, authenticated_user) {
        return Err(
            "Heartbeat update is unresolved; claim fence cannot be rolled back.".to_string(),
        );
    }
    rollback()
}

fn unapplied_heartbeat_revision(
    observed: &ShippingClaim,
    previous: &ShippingClaim,
    authenticated_user: &str,
) -> bool {
    observed.eligible_author
        && observed.comment_author.as_deref() == Some(authenticated_user)
        && observed.comment_id == previous.comment_id
        && observed.status == "active"
        && same_claim_identity(observed, previous)
        && observed.heartbeat_at == previous.heartbeat_at
        && observed.expires_at == previous.expires_at
        && observed.comment_updated_at_millis == previous.comment_updated_at_millis
}

fn merge_heartbeat_response(
    mut claims: Vec<ShippingClaim>,
    response: Option<ShippingClaim>,
    submitted: &ShippingClaim,
    authenticated_user: &str,
) -> Vec<ShippingClaim> {
    let Some(response) = response.filter(|candidate| {
        candidate.comment_updated_at_millis.is_some_and(|revision| {
            exact_heartbeat_marker(candidate, submitted, authenticated_user, revision)
        })
    }) else {
        return claims;
    };
    if claims.iter().any(|candidate| {
        candidate.comment_id == response.comment_id
            && candidate.comment_updated_at_millis >= response.comment_updated_at_millis
    }) {
        return claims;
    }
    claims.retain(|candidate| candidate.comment_id != response.comment_id);
    claims.push(response);
    claims
}

fn reconciled_active_revision(
    claims: &[ShippingClaim],
    submitted: &ShippingClaim,
    authenticated_user: &str,
) -> Option<i64> {
    let candidate = claims
        .iter()
        .find(|candidate| candidate.comment_id == submitted.comment_id)?;
    let revision = candidate.comment_updated_at_millis?;
    exact_heartbeat_marker(candidate, submitted, authenticated_user, revision).then_some(revision)
}

fn reconciled_claim_release<'a>(
    claims: &'a [ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
    observed_at: i64,
) -> Result<(&'a ShippingClaim, Option<&'a ShippingClaim>), String> {
    let stored = claims
        .iter()
        .find(|stored| stored.comment_id == claim.comment_id && stored.id == claim.id)
        .ok_or("Shipping claim comment no longer exists.")?;
    if !stored.eligible_author
        || stored.comment_author.as_deref() != Some(authenticated_user)
        || stored.instance_id != claim.instance_id
        || stored.holder != claim.holder
        || stored.task != claim.task
        || stored.acquired_at != claim.acquired_at
    {
        return Err("Shipping claim identity no longer matches its comment.".to_string());
    }
    let pre_patch_release = (stored.status == "released").then(|| ShippingClaim {
        comment_updated_at_millis: stored.released_comment_updated_at_millis,
        ..stored.clone()
    });
    if let Some(released) =
        matching_claim_release(claims, stored, authenticated_user).or_else(|| {
            pre_patch_release
                .as_ref()
                .and_then(|original| matching_claim_release(claims, original, authenticated_user))
        })
    {
        return Ok((stored, Some(released)));
    }
    if stored.status == "active"
        && matching_claim_release(claims, claim, authenticated_user).is_some()
    {
        return Err("Shipping claim release revision is stale.".to_string());
    }
    if stored.status != "active" {
        return Err(
            "Shipping claim release has no matching authenticated release record.".to_string(),
        );
    }
    let stale_revision = stored.heartbeat_at != claim.heartbeat_at
        || stored.expires_at != claim.expires_at
        || stored.comment_updated_at_millis != claim.comment_updated_at_millis;
    if stale_revision && claim_server_expiry(stored).is_none_or(|expiry| expiry > observed_at) {
        return Err("Shipping claim release revision is stale.".to_string());
    }
    Ok((stored, None))
}

fn has_active_takeover(claims: &[ShippingClaim], claim: &ShippingClaim, processed_at: i64) -> bool {
    let expiry = claim_server_expiry(claim);
    claims.iter().any(|candidate| {
        candidate.eligible_author
            && candidate.status == "active"
            && candidate.takeover_of.as_deref() == Some(claim.id.as_str())
            && claim_server_expiry(candidate).is_some_and(|expires| expires > processed_at)
            && candidate
                .comment_created_at_millis
                .zip(expiry)
                .is_some_and(|(created, expiry)| created >= expiry)
    })
}

fn effectively_active_claim<'a>(
    claims: &'a [ShippingClaim],
    claim: &'a ShippingClaim,
    processed_at: i64,
) -> bool {
    claim.status == "active"
        && claim.eligible_author
        && !claim_released(claims, claim)
        && claim_server_expiry(claim).is_some_and(|expires| expires > processed_at)
        && !has_active_takeover(claims, claim, processed_at)
}

fn active_claim_winner(claims: &[ShippingClaim], observed_at: i64) -> Option<&ShippingClaim> {
    claims
        .iter()
        .filter(|candidate| effectively_active_claim(claims, candidate, observed_at))
        .min_by_key(|candidate| (candidate.comment_created_at_millis, candidate.comment_id))
}

fn has_issue_reference_keyword(line: &str, reference_start: usize) -> bool {
    let words = line[..reference_start]
        .split(|character: char| !character.is_ascii_alphabetic())
        .filter(|word| !word.is_empty())
        .rev()
        .take(8)
        .map(str::to_ascii_lowercase)
        .collect::<Vec<_>>();
    let is_keyword = |word: &str| {
        matches!(
            word,
            "close"
                | "closes"
                | "closed"
                | "fix"
                | "fixes"
                | "fixed"
                | "resolve"
                | "resolves"
                | "resolved"
                | "ref"
                | "refs"
                | "reference"
                | "references"
        )
    };
    let keyword_index = match words.first().map(String::as_str) {
        Some(word) if is_keyword(word) => 0,
        Some("issue") if words.get(1).is_some_and(|word| is_keyword(word)) => 1,
        Some("issue")
            if words.get(1).is_some_and(|word| word == "github")
                && words.get(2).is_some_and(|word| is_keyword(word)) =>
        {
            2
        }
        _ => return false,
    };
    let Some(keyword) = words.get(keyword_index) else {
        return false;
    };
    is_keyword(keyword)
        && !words
            .iter()
            .skip(keyword_index + 1)
            .any(|word| matches!(word.as_str(), "not" | "never" | "doesnt"))
        && !words
            .windows(2)
            .any(|pair| pair[0] == "t" && pair[1] == "doesn")
}

fn reference_is_in_code_span(line: &str, reference_start: usize) -> bool {
    let bytes = line.as_bytes();
    let mut opening = 0;
    while opening < bytes.len() {
        if bytes[opening] != b'`' || escaped_backtick(bytes, opening) {
            opening += 1;
            continue;
        }
        let opening_end = bytes[opening..]
            .iter()
            .position(|byte| *byte != b'`')
            .map_or(bytes.len(), |offset| opening + offset);
        let delimiter_length = opening_end - opening;
        let mut closing = opening_end;
        while closing < bytes.len() {
            if bytes[closing] != b'`' || escaped_backtick(bytes, closing) {
                closing += 1;
                continue;
            }
            let closing_end = bytes[closing..]
                .iter()
                .position(|byte| *byte != b'`')
                .map_or(bytes.len(), |offset| closing + offset);
            if closing_end - closing == delimiter_length {
                if (opening_end..closing).contains(&reference_start) {
                    return true;
                }
                opening = closing_end;
                break;
            }
            closing = closing_end;
        }
        if closing >= bytes.len() {
            opening = opening_end;
        }
    }
    false
}

fn reference_is_quoted(line: &str, reference_start: usize) -> bool {
    let paired = line[..reference_start]
        .chars()
        .filter(|value| *value == '"')
        .count()
        % 2
        == 1;
    let single = line[..reference_start]
        .match_indices('\'')
        .any(|(index, _)| {
            line[..index]
                .chars()
                .next_back()
                .is_none_or(|character| !character.is_ascii_alphanumeric())
                && line[index + 1..]
                    .chars()
                    .next()
                    .is_some_and(|character| character.is_ascii_alphanumeric())
                && line[reference_start..].contains('\'')
        });
    reference_is_in_code_span(line, reference_start) || paired || single
}

fn affirmative_reference_line(line: &str, reference_start: usize, reference_end: usize) -> bool {
    let trimmed = line.trim_start();
    if trimmed.starts_with('>')
        || reference_is_quoted(line, reference_start)
        || !has_issue_reference_keyword(line, reference_start)
    {
        return false;
    }
    let clause_start = line[..reference_start]
        .rfind(['.', ';', '!', '?'])
        .map_or(0, |index| index + 1);
    let clause_end = line[reference_end..]
        .find(['.', ';', '!', '?'])
        .map_or(line.len(), |index| reference_end + index);
    let clause = line[clause_start..clause_end].to_ascii_lowercase();
    ![
        " example",
        "example ",
        " sample",
        "sample ",
        " only ",
        " not ",
        "never",
        "doesn't",
        "does not",
        "quoted",
        "hypothetical",
    ]
    .iter()
    .any(|marker| clause.contains(marker))
}

fn markdown_fence(line: &str, maximum_indent: usize) -> Option<(u8, usize, &str, usize)> {
    let indentation = line.bytes().take_while(|byte| *byte == b' ').count();
    if indentation > maximum_indent {
        return None;
    }
    let mut content = &line[indentation..];
    let list_marker = content
        .strip_prefix("- ")
        .or_else(|| content.strip_prefix("+ "))
        .or_else(|| content.strip_prefix("* "))
        .or_else(|| {
            let digits = content.bytes().take_while(u8::is_ascii_digit).count();
            (1..=9)
                .contains(&digits)
                .then(|| content.get(digits..))
                .flatten()
                .and_then(|rest| rest.strip_prefix(". ").or_else(|| rest.strip_prefix(") ")))
        });
    let content_indent = if let Some(rest) = list_marker {
        content = rest.trim_start_matches(' ');
        line.len() - content.len()
    } else {
        indentation
    };
    let marker = *content.as_bytes().first()?;
    if !matches!(marker, b'`' | b'~') {
        return None;
    }
    let length = content.bytes().take_while(|byte| *byte == marker).count();
    (length >= 3).then(|| (marker, length, &content[length..], content_indent + 3))
}

fn closes_markdown_fence(
    line: &str,
    maximum_indent: usize,
    opening_marker: u8,
    opening_length: usize,
) -> bool {
    let indentation = line.bytes().take_while(|byte| *byte == b' ').count();
    if indentation > maximum_indent {
        return false;
    }
    let content = &line[indentation..];
    let length = content
        .bytes()
        .take_while(|byte| *byte == opening_marker)
        .count();
    length >= opening_length && content[length..].trim().is_empty()
}

fn mask_code_segment(body: &str) -> String {
    let bytes = body.as_bytes();
    let mut masked = bytes.to_vec();
    let mut opening = 0;
    while opening < bytes.len() {
        if bytes[opening] != b'`' || escaped_backtick(bytes, opening) {
            opening += 1;
            continue;
        }
        let opening_end = bytes[opening..]
            .iter()
            .position(|byte| *byte != b'`')
            .map_or(bytes.len(), |offset| opening + offset);
        let delimiter_length = opening_end - opening;
        let mut closing = opening_end;
        let mut match_end = None;
        while closing < bytes.len() {
            if bytes[closing] != b'`' || escaped_backtick(bytes, closing) {
                closing += 1;
                continue;
            }
            let closing_end = bytes[closing..]
                .iter()
                .position(|byte| *byte != b'`')
                .map_or(bytes.len(), |offset| closing + offset);
            if closing_end - closing == delimiter_length {
                match_end = Some(closing_end);
                break;
            }
            closing = closing_end;
        }
        if let Some(end) = match_end {
            for byte in &mut masked[opening..end] {
                if *byte != b'\n' && *byte != b'\r' {
                    *byte = b' ';
                }
            }
            opening = end;
        } else {
            opening = opening_end;
        }
    }
    String::from_utf8(masked).expect("ASCII masking preserves UTF-8")
}

fn escaped_backtick(bytes: &[u8], index: usize) -> bool {
    let mut preceding = index;
    while preceding > 0 && bytes[preceding - 1] == b'\\' {
        preceding -= 1;
    }
    (index - preceding) % 2 == 1
}

fn mask_inline_code_spans(body: &str) -> String {
    let mut masked = String::with_capacity(body.len());
    let mut segment_start = 0;
    let mut offset = 0;
    let mut fence = None;
    for raw_line in body.split_inclusive('\n') {
        let line = raw_line.trim_end_matches(['\r', '\n']);
        let boundary = if let Some((marker, length, maximum_indent)) = fence {
            if closes_markdown_fence(line, maximum_indent, marker, length) {
                fence = None;
            }
            true
        } else if let Some((marker, length, info, maximum_indent)) = markdown_fence(line, 3) {
            if marker == b'~' || !info.contains('`') {
                fence = Some((marker, length, maximum_indent));
                true
            } else {
                false
            }
        } else {
            line.trim().is_empty()
        };
        if boundary {
            masked.push_str(&mask_code_segment(&body[segment_start..offset]));
            masked.push_str(raw_line);
            segment_start = offset + raw_line.len();
        }
        offset += raw_line.len();
    }
    masked.push_str(&mask_code_segment(&body[segment_start..]));
    masked
}

fn references_issue(body: &str, target: &str, number: u64) -> bool {
    let mut fence = None;
    let mut html_comment = false;
    let visible_body = mask_inline_code_spans(body);
    let mut lines = body.lines().zip(visible_body.lines());
    lines.any(|(original_line, line)| {
        if let Some((opening_marker, opening_length, maximum_indent)) = fence {
            if closes_markdown_fence(
                original_line,
                maximum_indent,
                opening_marker,
                opening_length,
            ) {
                fence = None;
            }
            return false;
        }
        let mut visible = String::new();
        let mut rest = line;
        loop {
            if html_comment {
                let Some(end) = rest.find("-->") else {
                    break;
                };
                rest = &rest[end + 3..];
                html_comment = false;
            } else if let Some(start) = rest.find("<!--") {
                visible.push_str(&rest[..start]);
                rest = &rest[start + 4..];
                html_comment = true;
            } else {
                visible.push_str(rest);
                break;
            }
        }
        if let Some((marker, length, info, maximum_indent)) = markdown_fence(original_line, 3) {
            if marker == b'~' || !info.contains('`') {
                fence = Some((marker, length, maximum_indent));
            }
            return false;
        }
        if original_line.starts_with("    ") || original_line.starts_with('\t') {
            return false;
        }
        references_issue_line(&visible, target, number)
    })
}

fn references_issue_line(body: &str, target: &str, number: u64) -> bool {
    let lowercase = body.to_ascii_lowercase();
    let url = format!(
        "https://github.com/{}/issues/{number}",
        target.to_ascii_lowercase()
    );
    if lowercase.match_indices(&url).any(|(index, _)| {
        affirmative_reference_line(body, index, index + url.len())
            && lowercase[index + url.len()..]
                .chars()
                .next()
                .is_none_or(|character| !character.is_ascii_alphanumeric() && character != '_')
    }) {
        return true;
    }
    let needle = format!("#{number}");
    body.match_indices(&needle).any(|(index, _)| {
        let after = index + needle.len();
        let continuation = body[after..].chars().next().is_some_and(|character| {
            character.is_ascii_alphanumeric()
                || character == '_'
                || (character == '-'
                    && body[after + character.len_utf8()..]
                        .chars()
                        .next()
                        .is_some_and(|next| next.is_ascii_alphanumeric() || next == '_'))
        });
        let bounded = body[..index]
            .chars()
            .next_back()
            .is_none_or(|character| !character.is_ascii_digit())
            && !continuation;
        if !bounded {
            return false;
        }
        let qualifier = body[..index]
            .rsplit(|character: char| {
                !(character.is_ascii_alphanumeric() || "-_/.".contains(character))
            })
            .next()
            .unwrap_or("");
        let reference_start = index - qualifier.len();
        affirmative_reference_line(body, reference_start, after)
            && (qualifier.is_empty() || qualifier.eq_ignore_ascii_case(target))
    })
}

fn equivalent_pull_request(
    directory: &Path,
    target: &str,
    number: u64,
    state: &str,
    recent_since: &str,
) -> Result<Option<String>, String> {
    let search = format!("{number} in:title,body");
    let output = gh_command(
        directory,
        &[
            "pr",
            "list",
            "--repo",
            target,
            "--state",
            state,
            "--search",
            &search,
            "--limit",
            "100",
            "--json",
            "title,body,url,mergedAt",
        ],
    )?;
    let values: Vec<serde_json::Value> = serde_json::from_str(&output)
        .map_err(|_| "GitHub returned invalid pull requests.".to_string())?;
    Ok(equivalent_pull_request_match(
        values,
        target,
        number,
        state,
        recent_since,
    ))
}

fn equivalent_pull_request_match(
    values: Vec<serde_json::Value>,
    target: &str,
    number: u64,
    state: &str,
    recent_since: &str,
) -> Option<String> {
    values.into_iter().find_map(|value| {
        let recent = state != "merged"
            || value["mergedAt"]
                .as_str()
                .is_some_and(|merged| merged >= recent_since);
        let referenced = ["title", "body"].iter().any(|field| {
            value[*field]
                .as_str()
                .is_some_and(|text| references_issue(text, target, number))
        });
        (recent && referenced).then(|| value["url"].as_str().unwrap_or("pull request").to_string())
    })
}

fn equivalent_shipping_work(
    directory: &Path,
    target: &str,
    number: u64,
) -> Result<Option<String>, String> {
    let observed_at = github_server_time_millis(directory)?;
    let recent_since = recent_equivalent_pull_request_cutoff(observed_at)?;
    if let Some(url) = equivalent_pull_request(directory, target, number, "open", &recent_since)? {
        return Ok(Some(format!(
            "Open pull request already covers issue #{number}: {url}"
        )));
    }
    Ok(
        equivalent_pull_request(directory, target, number, "merged", &recent_since)?.map(|url| {
            format!("Recently merged pull request already covers issue #{number}: {url}")
        }),
    )
}

fn reject_equivalent_work_after_claim(
    conflict: Result<Option<String>, String>,
    compensate: impl FnOnce() -> Result<(), String>,
) -> Result<(), String> {
    let conflict = match conflict {
        Ok(None) => return Ok(()),
        Ok(Some(conflict)) => conflict,
        Err(error) => format!("Equivalent work recheck failed: {error}"),
    };
    compensate().map_err(|error| format!("{conflict}; compensating release failed: {error}"))?;
    Err(conflict)
}

fn update_claim_comment(
    directory: &Path,
    target: &str,
    claim: &ShippingClaim,
) -> Result<serde_json::Value, String> {
    let endpoint = format!("repos/{target}/issues/comments/{}", claim.comment_id);
    let body = claim_body(claim)?;
    let output = gh_command(
        directory,
        &[
            "api",
            "--method",
            "PATCH",
            &endpoint,
            "-f",
            &format!("body={body}"),
        ],
    )?;
    serde_json::from_str(&output)
        .map_err(|_| "GitHub returned an invalid claim comment.".to_string())
}

fn post_claim_comment(
    directory: &Path,
    target: &str,
    number: u64,
    claim: &ShippingClaim,
) -> Result<serde_json::Value, String> {
    let endpoint = format!("repos/{target}/issues/{number}/comments");
    let body = claim_body(claim)?;
    let output = gh_command(
        directory,
        &[
            "api",
            "--method",
            "POST",
            &endpoint,
            "-f",
            &format!("body={body}"),
        ],
    )?;
    serde_json::from_str(&output)
        .map_err(|_| "GitHub returned an invalid claim comment.".to_string())
}

fn claim_lock_token(value: &str) -> String {
    let digest = Sha256::digest(value.as_bytes());
    digest[..16]
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn claim_lock_name(target: &str, scope: &str, slot: usize) -> String {
    let key = format!("{}:{scope}", target.to_ascii_lowercase());
    format!("sail-internal-v1-{}-{slot}", claim_lock_token(&key))
}

fn claim_fence_scope(number: u64) -> String {
    format!("claim:{number}")
}

fn claim_transition_scope(number: u64, comment_id: u64) -> String {
    format!("claim:{number}:transition:{comment_id}")
}

fn claim_lock_owner(claim_id: &str) -> ClaimLockOwner {
    ClaimLockOwner {
        claim_token: claim_lock_token(claim_id),
        operation_token: None,
        expires_at: None,
    }
}

fn claim_revision_lock_owner(claim: &ShippingClaim) -> Result<ClaimLockOwner, String> {
    let expiry =
        claim_time_millis(&claim.expires_at).ok_or("Shipping claim has an invalid expiry.")?;
    Ok(ClaimLockOwner {
        claim_token: claim_lock_token(&claim.id),
        operation_token: Some(claim_lock_token(&format!(
            "{}:{}:{}",
            claim.id, claim.heartbeat_at, claim.expires_at
        ))),
        expires_at: Some(expiry.saturating_add(MAX_CLAIM_LEASE_MILLIS)),
    })
}

fn pending_claim_revision_lock_owner(
    claim: &ShippingClaim,
    observed_at: i64,
) -> Result<ClaimLockOwner, String> {
    let lease_millis = claim_time_millis(&claim.expires_at)
        .zip(claim_time_millis(&claim.heartbeat_at))
        .map(|(expires_at, heartbeat_at)| expires_at - heartbeat_at)
        .filter(|lease| (1..=MAX_CLAIM_LEASE_MILLIS).contains(lease))
        .ok_or("Invalid shipping claim lease.")?;
    let expires_at = observed_at
        .checked_add(lease_millis)
        .and_then(|expiry| expiry.checked_add(MAX_CLAIM_LEASE_MILLIS))
        .ok_or("Shipping claim fence expiry is out of range.")?;
    let mut owner = claim_revision_lock_owner(claim)?;
    owner.expires_at = Some(expires_at);
    Ok(owner)
}

fn claim_revision_matches(owner: &ClaimLockOwner, claim: &ShippingClaim) -> bool {
    let expected = claim_revision_lock_owner(claim).ok();
    expected.as_ref().is_some_and(|expected| {
        owner.claim_token == expected.claim_token
            && owner.operation_token == expected.operation_token
    })
}

fn fence_matches_claim(fence: &ClaimLock, claim: &ShippingClaim) -> bool {
    fence
        .owner
        .as_ref()
        .is_some_and(|owner| claim_revision_matches(owner, claim))
        || fence.owner.as_ref() == Some(&claim_lock_owner(&claim.id))
}

fn expired_pending_fence(fence: &ClaimLock, claim: &ShippingClaim, observed_at: i64) -> bool {
    fence.owner.as_ref().is_some_and(|owner| {
        owner.claim_token == claim_lock_token(&claim.id)
            && owner.operation_token.is_some()
            && owner.expires_at.is_some_and(|expiry| expiry <= observed_at)
    })
}

fn transition_lock_owner(claim_id: &str, operation_id: &str, observed_at: i64) -> ClaimLockOwner {
    ClaimLockOwner {
        claim_token: claim_lock_token(claim_id),
        operation_token: Some(claim_lock_token(operation_id)),
        expires_at: Some(observed_at.saturating_add(MAX_CLAIM_LEASE_MILLIS)),
    }
}

fn predecessor_stop_lock_owner(
    claim: &ShippingClaim,
    recovery_id: &str,
    observed_at: i64,
) -> ClaimLockOwner {
    transition_lock_owner(
        &claim.id,
        &format!(
            "predecessor-stop:{recovery_id}:{}:{}:{}",
            claim.comment_id, claim.heartbeat_at, claim.expires_at
        ),
        observed_at,
    )
}

fn predecessor_stop_lock_matches(
    owner: &ClaimLockOwner,
    claim: &ShippingClaim,
    recovery_id: &str,
) -> bool {
    let expected = predecessor_stop_lock_owner(claim, recovery_id, 0);
    owner.claim_token == expected.claim_token && owner.operation_token == expected.operation_token
}

fn claim_lock_description(owner: &ClaimLockOwner) -> String {
    format!(
        "{CLAIM_LOCK_DESCRIPTION_PREFIX}{}:{}:{}",
        owner.claim_token,
        owner.operation_token.as_deref().unwrap_or("-"),
        owner
            .expires_at
            .map_or_else(|| "-".to_string(), |value| value.to_string())
    )
}

fn valid_lock_token(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn parse_claim_lock_owner(description: &str) -> Option<ClaimLockOwner> {
    let mut fields = description
        .strip_prefix(CLAIM_LOCK_DESCRIPTION_PREFIX)?
        .split(':');
    let claim_token = fields.next()?;
    let operation = fields.next()?;
    let expiry = fields.next()?;
    if fields.next().is_some() || !valid_lock_token(claim_token) {
        return None;
    }
    let operation_token = match operation {
        "-" => None,
        value if valid_lock_token(value) => Some(value.to_string()),
        _ => return None,
    };
    let expires_at = match expiry {
        "-" => None,
        value => Some(value.parse::<i64>().ok().filter(|expiry| *expiry >= 0)?),
    };
    if operation_token.is_some() != expires_at.is_some() {
        return None;
    }
    Some(ClaimLockOwner {
        claim_token: claim_token.to_string(),
        operation_token,
        expires_at,
    })
}

fn select_claim_lock(
    target: &str,
    scope: &str,
    labels: &HashMap<String, RepositoryLabelState>,
) -> Result<ClaimLock, String> {
    let mut missing = None;
    let mut managed = None;
    for slot in 0..CLAIM_LOCK_SLOTS {
        let name = claim_lock_name(target, scope, slot);
        match labels
            .get(&name)
            .cloned()
            .unwrap_or(RepositoryLabelState::Missing)
        {
            RepositoryLabelState::Missing => {
                missing.get_or_insert(name);
            }
            RepositoryLabelState::Unmanaged => continue,
            RepositoryLabelState::Managed { owner, node_id } => {
                if managed.is_some() {
                    return Err("GitHub has conflicting managed claim fences.".to_string());
                }
                managed = Some(ClaimLock {
                    name,
                    owner: Some(owner),
                    node_id: Some(node_id),
                });
            }
        }
    }
    managed
        .or_else(|| {
            missing.map(|name| ClaimLock {
                name,
                owner: None,
                node_id: None,
            })
        })
        .ok_or("GitHub claim fence namespace is occupied by repository labels.".to_string())
}

fn repository_claim_lock(directory: &Path, target: &str, scope: &str) -> Result<ClaimLock, String> {
    let endpoint = format!("repos/{target}/labels?per_page=100");
    let output = gh_command(directory, &["api", "--paginate", "--slurp", &endpoint])?;
    let pages: Vec<Vec<serde_json::Value>> = serde_json::from_str(&output)
        .map_err(|_| "GitHub returned invalid repository labels.".to_string())?;
    let labels = pages
        .into_iter()
        .flatten()
        .filter_map(|label| {
            let name = label["name"].as_str()?.to_ascii_lowercase();
            let state = label["description"]
                .as_str()
                .and_then(parse_claim_lock_owner)
                .and_then(|owner| {
                    label["node_id"]
                        .as_str()
                        .map(|node_id| RepositoryLabelState::Managed {
                            owner,
                            node_id: node_id.to_string(),
                        })
                })
                .unwrap_or(RepositoryLabelState::Unmanaged);
            Some((name, state))
        })
        .collect();
    select_claim_lock(target, scope, &labels)
}

fn create_repository_label(
    directory: &Path,
    target: &str,
    name: &str,
    owner: &ClaimLockOwner,
) -> Result<bool, String> {
    let endpoint = format!("repos/{target}/labels");
    match gh_command(
        directory,
        &[
            "api",
            "--method",
            "POST",
            &endpoint,
            "-f",
            &format!("name={name}"),
            "-f",
            "color=0969da",
            "-f",
            &format!("description={}", claim_lock_description(owner)),
        ],
    ) {
        Ok(_) => Ok(true),
        Err(error) if error.contains("HTTP 422") || error.contains("already_exists") => Ok(false),
        Err(error) => Err(error),
    }
}

fn delete_repository_label(directory: &Path, node_id: &str) -> Result<(), String> {
    const MUTATION: &str = "mutation($id:ID!){deleteLabel(input:{id:$id}){clientMutationId}}";
    match gh_command(
        directory,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={MUTATION}"),
            "-f",
            &format!("id={node_id}"),
        ],
    ) {
        Ok(_) => Ok(()),
        Err(error)
            if error.contains("Could not resolve to a node") || error.contains("NOT_FOUND") =>
        {
            Ok(())
        }
        Err(error) => Err(error),
    }
}

fn delete_repository_label_strict(directory: &Path, node_id: &str) -> Result<(), String> {
    const MUTATION: &str = "mutation($id:ID!){deleteLabel(input:{id:$id}){clientMutationId}}";
    let output = gh_command(
        directory,
        &[
            "api",
            "graphql",
            "-f",
            &format!("query={MUTATION}"),
            "-f",
            &format!("id={node_id}"),
        ],
    )?;
    let value: serde_json::Value = serde_json::from_str(&output)
        .map_err(|_| "GitHub returned an invalid label deletion response.".to_string())?;
    if value["data"]["deleteLabel"].is_object() && value["errors"].is_null() {
        Ok(())
    } else {
        Err("GitHub did not confirm deletion of the observed claim fence.".to_string())
    }
}

fn acquire_repository_lock(
    directory: &Path,
    target: &str,
    scope: &str,
    desired: &ClaimLockOwner,
) -> Result<ClaimLock, String> {
    let mut lock = repository_claim_lock(directory, target, scope)?;
    if let Some(owner) = lock.owner.as_ref() {
        return (owner == desired)
            .then_some(lock)
            .ok_or("Another operation holds the shipping claim lock.".to_string());
    }
    if create_repository_label(directory, target, &lock.name, desired)? {
        lock.owner = Some(desired.clone());
        return Ok(lock);
    }
    lock = repository_claim_lock(directory, target, scope)?;
    (lock.owner.as_ref() == Some(desired))
        .then_some(lock)
        .ok_or("Another operation won the shipping claim lock.".to_string())
}

fn delete_repository_lock_if_owned(
    directory: &Path,
    target: &str,
    scope: &str,
    expected: &ClaimLockOwner,
) -> Result<(), String> {
    let lock = repository_claim_lock(directory, target, scope)?;
    delete_observed_repository_lock_if_owned(&lock, expected, |node_id| {
        delete_repository_label(directory, node_id)
    })
}

fn delete_observed_repository_lock_if_owned(
    lock: &ClaimLock,
    expected: &ClaimLockOwner,
    delete: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    if lock.owner.as_ref() == Some(expected) {
        let node_id = lock
            .node_id
            .as_deref()
            .ok_or("GitHub claim lock has no immutable node id.")?;
        delete(node_id)?;
    }
    Ok(())
}

fn claim_for_lock_owner<'a>(
    claims: &'a [ShippingClaim],
    owner: &ClaimLockOwner,
) -> Option<&'a ShippingClaim> {
    claims
        .iter()
        .find(|claim| claim_lock_token(&claim.id) == owner.claim_token)
}

fn transition_lock_recoverable(
    owner: &ClaimLockOwner,
    claims: &[ShippingClaim],
    observed_at: i64,
) -> bool {
    owner.expires_at.is_some_and(|expiry| expiry <= observed_at)
        || claim_for_lock_owner(claims, owner).is_some_and(|claim| claim_released(claims, claim))
}

fn finish_claim_transition<T>(
    result: Result<T, String>,
    cleanup: impl FnOnce() -> Result<(), String>,
) -> Result<T, String> {
    let cleanup = cleanup();
    match (result, cleanup) {
        (Ok(value), Ok(())) => Ok(value),
        (Err(error), Ok(())) => Err(error),
        (Ok(_), Err(cleanup)) => Err(format!(
            "Shipping claim transition cleanup failed: {cleanup}"
        )),
        (Err(error), Err(cleanup)) => Err(format!(
            "{error}; shipping claim transition cleanup failed: {cleanup}"
        )),
    }
}

fn with_claim_transition<T>(
    directory: &Path,
    target: &str,
    scope: &str,
    claim: &ShippingClaim,
    claims: &[ShippingClaim],
    observed_at: i64,
    operation: impl FnOnce() -> Result<T, String>,
) -> Result<T, String> {
    let owner = transition_lock_owner(&claim.id, &uuid::Uuid::new_v4().to_string(), observed_at);
    let existing = repository_claim_lock(directory, target, scope)?;
    if let Some(existing_owner) = existing.owner.as_ref() {
        if !transition_lock_recoverable(existing_owner, claims, observed_at) {
            return Err("Another claimant is reconciling the shipping claim.".to_string());
        }
        delete_repository_lock_if_owned(directory, target, scope, existing_owner)?;
    }
    acquire_repository_lock(directory, target, scope, &owner)?;
    let result = operation();
    finish_claim_transition(result, || {
        delete_repository_lock_if_owned(directory, target, scope, &owner)
    })
}

fn acquire_predecessor_stop_lock(
    directory: &Path,
    target: &str,
    number: u64,
    claim: &ShippingClaim,
    claims: &[ShippingClaim],
    recovery_id: &str,
    observed_at: i64,
) -> Result<ClaimLockOwner, String> {
    let scope = claim_transition_scope(number, claim.comment_id);
    let desired = predecessor_stop_lock_owner(claim, recovery_id, observed_at);
    let existing = repository_claim_lock(directory, target, &scope)?;
    if let Some(owner) = existing.owner.as_ref() {
        if predecessor_stop_lock_matches(owner, claim, recovery_id)
            && owner.expires_at.is_some_and(|expiry| expiry > observed_at)
        {
            return Ok(owner.clone());
        }
        if !transition_lock_recoverable(owner, claims, observed_at) {
            return Err("Another claimant is reconciling the shipping claim.".to_string());
        }
        delete_repository_lock_if_owned(directory, target, &scope, owner)?;
    }
    acquire_repository_lock(directory, target, &scope, &desired)?;
    Ok(desired)
}

fn delete_predecessor_stop_lock_if_owned(
    lock: &ClaimLock,
    claim: &ShippingClaim,
    recovery_id: &str,
    delete: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    let Some(owner) = lock.owner.as_ref() else {
        return Ok(());
    };
    if predecessor_stop_lock_matches(owner, claim, recovery_id) {
        return delete(
            lock.node_id
                .as_deref()
                .ok_or("GitHub predecessor stop fence has no immutable node id.")?,
        );
    }
    if owner.claim_token == claim_lock_token(&claim.id) {
        return Err("Another Sail instance holds the predecessor stop fence.".to_string());
    }
    Ok(())
}

fn with_verified_claim_takeover<T>(
    observed_fence: &ClaimLock,
    current_fence: &ClaimLock,
    observed_claim: &ShippingClaim,
    current_claim: &ShippingClaim,
    observed_at: i64,
    operation: impl FnOnce(&str) -> Result<T, String>,
) -> Result<T, String> {
    if current_fence.owner != observed_fence.owner
        || current_fence.node_id != observed_fence.node_id
    {
        return Err("Shipping claim fence changed during takeover.".to_string());
    }
    if !fence_matches_claim(current_fence, current_claim)
        && !expired_pending_fence(current_fence, current_claim, observed_at)
    {
        return Err("Shipping claim fence revision changed during takeover.".to_string());
    }
    if current_claim.id != observed_claim.id
        || current_claim.comment_id != observed_claim.comment_id
        || !same_claim_identity(current_claim, observed_claim)
        || current_claim.status != observed_claim.status
        || current_claim.takeover_of != observed_claim.takeover_of
        || current_claim.heartbeat_at != observed_claim.heartbeat_at
        || current_claim.expires_at != observed_claim.expires_at
        || current_claim.comment_updated_at_millis != observed_claim.comment_updated_at_millis
    {
        return Err("Shipping claim changed during takeover; retry with fresh state.".to_string());
    }
    if claim_server_expiry(current_claim).is_none_or(|expiry| expiry > observed_at) {
        return Err("Shipping claim renewed during takeover; retry with fresh state.".to_string());
    }
    let node_id = current_fence
        .node_id
        .as_deref()
        .ok_or("GitHub claim fence has no immutable node id.")?;
    operation(node_id)
}

fn acquire_claim_fence(
    directory: &Path,
    target: &str,
    number: u64,
    claim: &ShippingClaim,
    claims: &[ShippingClaim],
    observed_at: i64,
) -> Result<(), String> {
    let fence_scope = claim_fence_scope(number);
    let desired = claim_revision_lock_owner(claim)?;
    let fence = repository_claim_lock(directory, target, &fence_scope)?;
    if fence.owner.is_none() {
        acquire_repository_lock(directory, target, &fence_scope, &desired)?;
        return Ok(());
    }
    let owner = fence.owner.as_ref().unwrap();
    if owner == &desired || owner == &claim_lock_owner(&claim.id) {
        return Ok(());
    }
    let Some(previous) = claim_for_lock_owner(claims, owner) else {
        return Err(
            "Shipping claim fence is held by an unobserved claimant; retry after GitHub converges."
                .to_string(),
        );
    };
    if effectively_active_claim(claims, previous, observed_at) {
        return Err(format!(
            "Issue #{number} is already claimed by {} until {}.",
            previous.holder, previous.expires_at
        ));
    }

    let transition_scope = claim_transition_scope(number, previous.comment_id);
    with_claim_transition(
        directory,
        target,
        &transition_scope,
        claim,
        claims,
        observed_at,
        || {
            let current = repository_claim_lock(directory, target, &fence_scope)?;
            let current_previous = issue_claim_comment(directory, target, previous.comment_id)?;
            let verified_at = github_server_time_millis(directory)?;
            with_verified_claim_takeover(
                &fence,
                &current,
                previous,
                &current_previous,
                verified_at,
                |node_id| {
                    delete_repository_label_strict(directory, node_id)?;
                    acquire_repository_lock(directory, target, &fence_scope, &desired)
                        .map(|_| ())
                        .map_err(|_| {
                            "Another claimant won the shipping claim takeover.".to_string()
                        })
                },
            )
        },
    )
}

fn delete_claim_fence_if_owned(
    directory: &Path,
    target: &str,
    number: u64,
    claim: &ShippingClaim,
) -> Result<(), String> {
    let fence = repository_claim_lock(directory, target, &claim_fence_scope(number))?;
    delete_verified_claim_fence(&fence, claim, |node_id| {
        delete_repository_label_strict(directory, node_id)
    })
}

fn delete_claim_fence_after_verified_release(
    directory: &Path,
    target: &str,
    number: u64,
    claim: &ShippingClaim,
) -> Result<(), String> {
    let fence = repository_claim_lock(directory, target, &claim_fence_scope(number))?;
    delete_verified_claim_fence_after_release(&fence, claim, |node_id| {
        delete_repository_label_strict(directory, node_id)
    })
}

fn compensate_equivalent_claim(
    directory: &Path,
    target: &str,
    number: u64,
    claim: &ShippingClaim,
) -> Result<(), String> {
    let observed_at = github_server_time_millis(directory)?;
    let released = released_claim_marker(claim, observed_at, "equivalent work appeared")?;
    let response = post_claim_comment(directory, target, number, &released);
    let released = posted_release_claim(
        released,
        response,
        "Equivalent work appeared during acquisition",
    )?;
    mark_original_claim_released(directory, target, claim, &released)?;
    delete_claim_fence_after_verified_release(directory, target, number, claim)
}

fn delete_verified_claim_fence_after_release(
    fence: &ClaimLock,
    claim: &ShippingClaim,
    delete: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    if fence.owner.is_none() {
        return Ok(());
    }
    delete_verified_claim_fence(fence, claim, delete)
}

fn mark_original_claim_released(
    directory: &Path,
    target: &str,
    original: &ShippingClaim,
    release: &ShippingClaim,
) -> Result<(), String> {
    if original.status == "released" {
        return Ok(());
    }
    let mut updated = release.clone();
    updated.comment_id = original.comment_id;
    update_claim_comment(directory, target, &updated)?;
    Ok(())
}

fn delete_verified_claim_fence(
    fence: &ClaimLock,
    claim: &ShippingClaim,
    delete: impl FnOnce(&str) -> Result<(), String>,
) -> Result<(), String> {
    if !fence_matches_claim(fence, claim) {
        return Err("Shipping claim fence revision is stale.".to_string());
    }
    delete(
        fence
            .node_id
            .as_deref()
            .ok_or("GitHub claim fence has no immutable node id.")?,
    )
}

fn require_claim_fence_owner(
    directory: &Path,
    target: &str,
    number: u64,
    claim: &ShippingClaim,
) -> Result<(), String> {
    let fence = repository_claim_lock(directory, target, &claim_fence_scope(number))?;
    if fence_matches_claim(&fence, claim) {
        Ok(())
    } else {
        Err("Shipping claim fence is no longer owned by this claim.".to_string())
    }
}

fn rotate_claim_fence(
    directory: &Path,
    target: &str,
    number: u64,
    previous: &ShippingClaim,
    renewed: &ShippingClaim,
    observed_at: i64,
) -> Result<(), String> {
    let scope = claim_fence_scope(number);
    let fence = repository_claim_lock(directory, target, &scope)?;
    if !fence_matches_claim(&fence, previous) {
        return Err("Shipping claim fence revision is stale.".to_string());
    }
    delete_repository_label_strict(
        directory,
        fence
            .node_id
            .as_deref()
            .ok_or("GitHub claim fence has no immutable node id.")?,
    )?;
    acquire_repository_lock(
        directory,
        target,
        &scope,
        &pending_claim_revision_lock_owner(renewed, observed_at)?,
    )?;
    Ok(())
}

fn authenticated_github_user(directory: &Path) -> Result<String, String> {
    let login = gh_command(directory, &["api", "user", "--jq", ".login"])?;
    let login = login.trim().to_ascii_lowercase();
    if !valid_claim_value(&login, 100) {
        return Err("GitHub returned an invalid authenticated user.".to_string());
    }
    Ok(login)
}

fn github_server_time_millis(directory: &Path) -> Result<i64, String> {
    let response = gh_command(directory, &["api", "--include", "rate_limit"])?;
    let value = response
        .lines()
        .filter_map(|line| line.split_once(':'))
        .find_map(|(name, value)| name.eq_ignore_ascii_case("date").then(|| value.trim()))
        .ok_or("GitHub response has no server date.")?;
    let time = httpdate::parse_http_date(value)
        .map_err(|_| "GitHub response has an invalid server date.".to_string())?;
    let millis = time
        .duration_since(UNIX_EPOCH)
        .map_err(|_| "GitHub response has a pre-epoch server date.".to_string())?
        .as_millis();
    i64::try_from(millis).map_err(|_| "GitHub server date is out of range.".to_string())
}

fn claim_time_from_millis(value: i64) -> Result<String, String> {
    chrono::DateTime::from_timestamp_millis(value)
        .map(|time| time.format("%Y-%m-%dT%H:%M:%S%.3fZ").to_string())
        .ok_or("Shipping claim time is out of range.".to_string())
}

fn recent_equivalent_pull_request_cutoff(observed_at: i64) -> Result<String, String> {
    let cutoff = observed_at
        .checked_sub(RECENT_EQUIVALENT_PULL_REQUEST_MILLIS)
        .ok_or("GitHub server date is out of range.")?;
    claim_time_from_millis(cutoff)
}

fn renewed_claim_window(
    stored: &ShippingClaim,
    observed_at: i64,
    lease_millis: i64,
) -> Result<(String, String), String> {
    if !(1..=MAX_CLAIM_LEASE_MILLIS).contains(&lease_millis) {
        return Err("Invalid shipping claim heartbeat lease.".to_string());
    }
    let stored_heartbeat = claim_time_millis(&stored.heartbeat_at)
        .ok_or("Shipping claim has an invalid stored heartbeat.")?;
    let heartbeat_at = observed_at.max(stored_heartbeat.saturating_add(1));
    let expires_at = heartbeat_at
        .checked_add(lease_millis)
        .ok_or("Shipping claim expiry is out of range.")?;
    Ok((
        claim_time_from_millis(heartbeat_at)?,
        claim_time_from_millis(expires_at)?,
    ))
}

fn validated_claim_input(claim: &ShippingClaim) -> Result<(), String> {
    let acquired = claim_time_millis(&claim.acquired_at);
    let heartbeat = claim_time_millis(&claim.heartbeat_at);
    let expires = claim_time_millis(&claim.expires_at);
    if !valid_claim_value(&claim.id, 100)
        || !valid_claim_value(&claim.holder, 200)
        || !valid_claim_value(&claim.task, 300)
        || claim
            .instance_id
            .as_deref()
            .is_some_and(|value| !valid_claim_value(value, 100))
        || !valid_claim_time(&claim.acquired_at)
        || !valid_claim_time(&claim.heartbeat_at)
        || !valid_claim_time(&claim.expires_at)
        || heartbeat < acquired
        || expires <= heartbeat
        || expires
            .zip(heartbeat)
            .is_none_or(|(expires, heartbeat)| expires - heartbeat > MAX_CLAIM_LEASE_MILLIS)
    {
        return Err("Invalid shipping claim.".to_string());
    }
    Ok(())
}

fn shipping_claim_observation(
    claims: &[ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
    observed_at: i64,
) -> Result<ShippingClaimObservation, String> {
    let stored = claims
        .iter()
        .find(|stored| stored.comment_id == claim.comment_id && stored.id == claim.id)
        .ok_or("Shipping claim comment no longer exists.")?;
    if !stored.eligible_author
        || stored.comment_author.as_deref() != Some(authenticated_user)
        || !same_claim_identity(stored, claim)
    {
        return Err("Shipping claim identity no longer matches its comment.".to_string());
    }
    let active = active_claim_winner(claims, observed_at)
        .is_some_and(|winner| winner.id == stored.id && winner.comment_id == stored.comment_id);
    Ok(ShippingClaimObservation {
        claim: stored.clone(),
        active,
    })
}

fn shipping_claim_observation_with_current(
    claims: &[ShippingClaim],
    claim: &ShippingClaim,
    authenticated_user: &str,
    observed_at: i64,
    current: ShippingClaim,
) -> Result<ShippingClaimObservation, String> {
    let mut claims = claims.to_vec();
    claims.retain(|candidate| candidate.comment_id != current.comment_id);
    claims.push(current);
    shipping_claim_observation(&claims, claim, authenticated_user, observed_at)
}

#[tauri::command]
pub async fn observe_shipping_claim(
    repository: String,
    number: u64,
    claim: ShippingClaim,
    recovery_id: String,
) -> Result<ShippingClaimObservation, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if number == 0 {
            return Err("Invalid shipping claim target.".to_string());
        }
        validated_claim_input(&claim)?;
        if !valid_claim_value(&recovery_id, 100) {
            return Err("Invalid shipping claim recovery identity.".to_string());
        }
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = target_repository(&repository)?;
        let authenticated_user = authenticated_github_user(&repository)?;
        let claims = issue_comments(&repository, &target, number)?;
        let observed_at = github_server_time_millis(&repository)?;
        let observation =
            shipping_claim_observation(&claims, &claim, &authenticated_user, observed_at)?;
        if observation.active {
            return Ok(observation);
        }
        let transition_scope = claim_transition_scope(number, observation.claim.comment_id);
        let stop_owner = acquire_predecessor_stop_lock(
            &repository,
            &target,
            number,
            &observation.claim,
            &claims,
            &recovery_id,
            observed_at,
        )?;
        let result = (|| {
            let current = issue_claim_comment(&repository, &target, observation.claim.comment_id)?;
            let verified_at = github_server_time_millis(&repository)?;
            let verified = shipping_claim_observation_with_current(
                &claims,
                &claim,
                &authenticated_user,
                verified_at,
                current,
            )?;
            Ok(verified)
        })();
        if result.as_ref().is_ok_and(|verified| verified.active) || result.is_err() {
            finish_claim_transition(result, || {
                delete_repository_lock_if_owned(
                    &repository,
                    &target,
                    &transition_scope,
                    &stop_owner,
                )
            })
        } else {
            result
        }
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn complete_predecessor_shipping_claim_fence(
    repository: String,
    number: u64,
    claim: ShippingClaim,
    recovery_id: String,
) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        if number == 0 {
            return Err("Invalid shipping claim target.".to_string());
        }
        validated_claim_input(&claim)?;
        if !valid_claim_value(&recovery_id, 100) {
            return Err("Invalid shipping claim recovery identity.".to_string());
        }
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = target_repository(&repository)?;
        let scope = claim_transition_scope(number, claim.comment_id);
        let lock = repository_claim_lock(&repository, &target, &scope)?;
        delete_predecessor_stop_lock_if_owned(&lock, &claim, &recovery_id, |node_id| {
            delete_repository_label_strict(&repository, node_id)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn acquire_shipping_claim(
    repository: String,
    number: u64,
    mut claim: ShippingClaim,
) -> Result<ShippingClaim, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if number == 0 {
            return Err("Invalid shipping claim target.".to_string());
        }
        validated_claim_input(&claim)?;
        if claim.instance_id.is_none() {
            return Err("Shipping claim has no Sail instance identity.".to_string());
        }
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = target_repository(&repository)?;
        if let Some(conflict) = equivalent_shipping_work(&repository, &target, number)? {
            return Err(conflict);
        }
        let authenticated_user = authenticated_github_user(&repository)?;
        let existing = issue_comments(&repository, &target, number)?;
        let observed_at = github_server_time_millis(&repository)?;
        if let Some((retry, winner)) =
            acquisition_retry_outcome(&existing, &claim, &authenticated_user, observed_at)?
        {
            if winner.is_some_and(|winner| {
                winner.id == retry.id && winner.comment_id == retry.comment_id
            }) {
                acquire_claim_fence(
                    &repository,
                    &target,
                    number,
                    retry,
                    &existing,
                    observed_at,
                )?;
                reject_equivalent_work_after_claim(
                    equivalent_shipping_work(&repository, &target, number),
                    || compensate_equivalent_claim(&repository, &target, number, retry),
                )?;
                return Ok(retry.clone());
            }
            let released =
                released_claim_marker(retry, observed_at, "lost acquisition reconciliation")?;
            post_claim_comment(&repository, &target, number, &released)
                .map_err(|error| format!("Losing claim release failed: {error}"))?;
            return match winner {
                Some(winner) => Err(format!(
                    "Issue #{number} was claimed concurrently by {} until {}.",
                    winner.holder, winner.expires_at
                )),
                None => Err("Existing shipping claim retry is no longer active.".to_string()),
            };
        }
        if let Some(winner) = active_claim_winner(&existing, observed_at) {
            return Err(format!(
                "Issue #{number} is already claimed by {} until {}.",
                winner.holder, winner.expires_at
            ));
        }
        let (heartbeat_at, expires_at) = initial_claim_window(&claim, observed_at)?;
        claim.heartbeat_at = heartbeat_at;
        claim.expires_at = expires_at;
        claim.status = "active".to_string();
        claim.released_at = None;
        claim.release_reason = None;
        claim.takeover_of = None;
        if let Some(conflict) = equivalent_shipping_work(&repository, &target, number)? {
            return Err(conflict);
        }
        let post_error = post_claim_comment(&repository, &target, number, &claim).err();
        let mut candidates = match issue_comments(&repository, &target, number) {
            Ok(candidates) => candidates,
            Err(error) => {
                let released = released_claim_marker(
                    &claim,
                    observed_at,
                    "acquisition verification failed",
                )?;
                let compensation = post_claim_comment(&repository, &target, number, &released);
                return Err(format!(
                    "{}claim reconciliation failed: {error}; compensating release: {}",
                    post_error.map_or_else(String::new, |value| format!("{value}; ")),
                    compensation.err().unwrap_or_else(|| "posted".to_string())
                ));
            }
        };
        let stored = match acquisition_retry_claim(&candidates, &claim, &authenticated_user) {
            Ok(Some(stored)) => stored,
            outcome => {
                let released = released_claim_marker(
                    &claim,
                    observed_at,
                    "acquisition marker verification failed",
                )?;
                let compensation = post_claim_comment(&repository, &target, number, &released);
                let verification_error = match outcome {
                    Ok(None) => post_error.unwrap_or_else(|| {
                        "Shipping claim was not visible after acquisition.".to_string()
                    }),
                    Err(error) => error,
                    Ok(Some(_)) => unreachable!(),
                };
                return Err(format!(
                    "{verification_error}; compensating release: {}",
                    compensation.err().unwrap_or_else(|| "posted".to_string())
                ));
            }
        };
        claim = stored.clone();
        let mut processed_at = match github_server_time_millis(&repository) {
            Ok(processed_at) => processed_at,
            Err(error) => {
                let released = released_claim_marker(
                    &claim,
                    claim.comment_updated_at_millis.unwrap_or_else(|| {
                        claim_time_millis(&claim.acquired_at).unwrap_or_default()
                    }),
                    "acquisition time verification failed",
                )?;
                post_claim_comment(&repository, &target, number, &released).map_err(
                    |release_error| {
                        format!(
                            "GitHub server time failed: {error}; compensating release failed: {release_error}"
                        )
                    },
                )?;
                return Err(format!("GitHub server time failed: {error}"));
            }
        };
        let winner = candidates
            .iter()
            .filter(|candidate| effectively_active_claim(&candidates, candidate, processed_at))
            .min_by_key(|candidate| (candidate.comment_created_at_millis, candidate.comment_id));
        if winner
            .as_ref()
            .is_none_or(|winner| winner.id != claim.id || winner.comment_id != claim.comment_id)
        {
            let reason = winner
                .as_ref()
                .map_or("not active after acquisition", |_| "lost acquisition race");
            let released = released_claim_marker(&claim, processed_at, reason)?;
            let _ = post_claim_comment(&repository, &target, number, &released)?;
            return match winner {
                Some(winner) => Err(format!(
                    "Issue #{number} was claimed concurrently by {} until {}.",
                    winner.holder, winner.expires_at
                )),
                None => Err("Shipping claim was not active after acquisition.".to_string()),
            };
        }
        claim.takeover_of = candidates
            .iter()
            .filter(|candidate| {
                candidate.id != claim.id
                    && candidate.eligible_author
                    && candidate.status == "active"
                    && claim_server_expiry(candidate).is_some_and(|expires| expires <= processed_at)
            })
            .max_by_key(|candidate| (claim_server_expiry(candidate), candidate.comment_id))
            .map(|candidate| candidate.id.clone());
        if claim.takeover_of.is_some() {
            let update_error = update_claim_comment(&repository, &target, &claim).err();
            candidates = match issue_comments(&repository, &target, number) {
                Ok(candidates) => candidates,
                Err(error) => {
                    let mut unverified = claim.clone();
                    unverified.comment_updated_at_millis = None;
                    let released = released_claim_marker(
                        &unverified,
                        processed_at,
                        "takeover audit verification failed",
                    )?;
                    let compensation = post_claim_comment(&repository, &target, number, &released);
                    return Err(format!(
                        "{}takeover audit reconciliation failed: {error}; compensating release: {}",
                        update_error.map_or_else(String::new, |value| format!("{value}; ")),
                        compensation.err().unwrap_or_else(|| "posted".to_string())
                    ));
                }
            };
            let Some(revision) =
                reconciled_active_revision(&candidates, &claim, &authenticated_user)
            else {
                let mut unverified = claim.clone();
                unverified.comment_updated_at_millis = None;
                let released = released_claim_marker(
                    &unverified,
                    processed_at,
                    "takeover audit update failed",
                )?;
                post_claim_comment(&repository, &target, number, &released).map_err(
                    |release_error| {
                        format!(
                            "{}takeover audit update was not applied; compensating release failed: {release_error}",
                            update_error
                                .as_deref()
                                .map_or_else(String::new, |value| format!("{value}; "))
                        )
                    },
                )?;
                return Err(update_error.unwrap_or_else(|| {
                    "Takeover audit update was not applied.".to_string()
                }));
            };
            claim.comment_updated_at_millis = Some(revision);
            processed_at = match github_server_time_millis(&repository) {
                Ok(processed_at) => processed_at,
                Err(error) => {
                    let released = released_claim_marker(
                        &claim,
                        revision,
                        "takeover audit time verification failed",
                    )?;
                    post_claim_comment(&repository, &target, number, &released).map_err(
                        |release_error| {
                            format!(
                                "GitHub server time failed: {error}; compensating release failed: {release_error}"
                            )
                        },
                    )?;
                    return Err(format!("GitHub server time failed: {error}"));
                }
            };
            let winner = candidates
                .iter()
                .filter(|candidate| effectively_active_claim(&candidates, candidate, processed_at))
                .min_by_key(|candidate| {
                    (candidate.comment_created_at_millis, candidate.comment_id)
                });
            if winner
                .is_none_or(|winner| winner.id != claim.id || winner.comment_id != claim.comment_id)
            {
                let released =
                    released_claim_marker(&claim, processed_at, "lost acquisition race")?;
                let _ = post_claim_comment(&repository, &target, number, &released)?;
                return Err("Shipping claim lost acquisition verification.".to_string());
            }
        }
        if let Err(error) = acquire_claim_fence(
            &repository,
            &target,
            number,
            &claim,
            &candidates,
            processed_at,
        ) {
            let released = released_claim_marker(&claim, processed_at, "lost acquisition fence")?;
            post_claim_comment(&repository, &target, number, &released).map_err(|release_error| {
                format!("{error}; losing claim release failed: {release_error}")
            })?;
            return Err(error);
        }
        reject_equivalent_work_after_claim(
            equivalent_shipping_work(&repository, &target, number),
            || compensate_equivalent_claim(&repository, &target, number, &claim),
        )?;
        Ok(claim)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn heartbeat_shipping_claim(
    repository: String,
    number: u64,
    mut claim: ShippingClaim,
    instance_id: String,
    lease_millis: i64,
) -> Result<ShippingClaim, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if number == 0 || !(1..=MAX_CLAIM_LEASE_MILLIS).contains(&lease_millis) {
            return Err("Invalid shipping claim heartbeat.".to_string());
        }
        validated_claim_input(&claim)?;
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = target_repository(&repository)?;
        let authenticated_user = authenticated_github_user(&repository)?;
        let comments = issue_comments(&repository, &target, number)?;
        let observed_at = github_server_time_millis(&repository)?;
        if !valid_claim_value(&instance_id, 100) {
            return Err("Invalid Sail instance identity.".to_string());
        }
        let stored =
            heartbeat_retry_claim(&comments, &claim, &authenticated_user, &instance_id)?.clone();
        claim = stored.clone();
        let transition_scope = claim_transition_scope(number, stored.comment_id);
        with_claim_transition(
            &repository,
            &target,
            &transition_scope,
            &stored,
            &comments,
            observed_at,
            || {
        let current = issue_claim_comment(&repository, &target, stored.comment_id)?;
        heartbeat_stored_claim(std::slice::from_ref(&current), &claim, &authenticated_user)?;
        require_claim_fence_owner(&repository, &target, number, &stored)?;
        claim.comment_updated_at_millis = stored.comment_updated_at_millis;
        let prior_expiry = claim_server_expiry(&stored).ok_or("Shipping claim has no expiry.")?;
        if prior_expiry <= observed_at {
            return Err("Shipping claim expired before heartbeat.".to_string());
        }
        if has_active_takeover(&comments, &stored, observed_at) {
            return Err("Shipping claim was superseded by an active takeover.".to_string());
        }
        let winner = active_claim_winner(&comments, observed_at)
            .ok_or("Shipping claim expired or was released.")?;
        if winner.id != claim.id || winner.comment_id != claim.comment_id {
            return Err(format!(
                "Shipping claim was superseded by {} until {}.",
                winner.holder, winner.expires_at
            ));
        }
        (claim.heartbeat_at, claim.expires_at) =
            renewed_claim_window(&stored, observed_at, lease_millis)?;
        claim.status = "active".to_string();
        rotate_claim_fence(
            &repository,
            &target,
            number,
            &stored,
            &claim,
            observed_at,
        )?;
        let update = update_claim_comment(&repository, &target, &claim);
        let response_claim = update.as_ref().ok().and_then(claim_from_comment);
        let mut candidates = match issue_comments(&repository, &target, number) {
            Ok(candidates) => merge_heartbeat_response(
                candidates,
                response_claim.clone(),
                &claim,
                &authenticated_user,
            ),
            Err(read_error) => {
                let direct = issue_claim_comment(&repository, &target, stored.comment_id).ok();
                if let Some(observed) = direct.as_ref() {
                    if unapplied_heartbeat_revision(observed, &stored, &authenticated_user) {
                        rollback_unapplied_heartbeat_fence(
                            observed,
                            &stored,
                            &authenticated_user,
                            || {
                                rotate_claim_fence(
                                    &repository,
                                    &target,
                                    number,
                                    &claim,
                                    &stored,
                                    observed_at,
                                )
                            },
                        )?;
                        return Err(format!("Heartbeat reconciliation failed: {read_error}; fence restored."));
                    }
                }
                let Some(applied) = response_claim.or(direct).filter(|candidate| {
                    let Some(revision) = candidate.comment_updated_at_millis else {
                        return false;
                    };
                    exact_heartbeat_marker(candidate, &claim, &authenticated_user, revision)
                }) else {
                    return Err(format!(
                        "{}heartbeat reconciliation failed: {read_error}",
                        update.err().map_or_else(String::new, |error| format!("{error}; "))
                    ));
                };
                let revision = applied.comment_updated_at_millis.unwrap_or_default();
                let released = released_claim_marker(
                    &applied,
                    revision,
                    "heartbeat verification read failed",
                )?;
                let release_response = post_claim_comment(&repository, &target, number, &released);
                let released = posted_release_claim(
                    released,
                    release_response,
                    &format!("Heartbeat verification read failed: {read_error}"),
                )?;
                delete_claim_fence_if_owned(&repository, &target, number, &applied)?;
                return Ok(released);
            }
        };
        let verified_at = reconciled_heartbeat_revision(&candidates, &claim, &authenticated_user)
            .ok_or_else(|| match update {
                Ok(_) => "Heartbeat reconciliation found no submitted update.".to_string(),
                Err(error) => {
                    format!("{error}; heartbeat reconciliation found no submitted update")
                }
            });
        let verified_at = match verified_at {
            Ok(revision) => revision,
            Err(error) => {
                if candidates.iter().any(|candidate| candidate.comment_id == stored.comment_id) {
                    let current = issue_claim_comment(&repository, &target, stored.comment_id)?;
                    if unapplied_heartbeat_revision(&current, &stored, &authenticated_user) {
                        rollback_unapplied_heartbeat_fence(
                            &current,
                            &stored,
                            &authenticated_user,
                            || {
                                rotate_claim_fence(
                                    &repository,
                                    &target,
                                    number,
                                    &claim,
                                    &stored,
                                    observed_at,
                                )
                            },
                        )?;
                        return Err(error);
                    }
                    if current.comment_updated_at_millis.is_some_and(|revision| {
                        exact_heartbeat_marker(&current, &claim, &authenticated_user, revision)
                    }) {
                        candidates.retain(|candidate| candidate.comment_id != current.comment_id);
                        candidates.push(current);
                        reconciled_heartbeat_revision(&candidates, &claim, &authenticated_user)
                            .ok_or(error)?
                    } else {
                        return Err(error);
                    }
                } else {
                    return Err(error);
                }
            }
        };
        claim.comment_updated_at_millis = Some(verified_at);
        let return_observed_at = verified_at;
        let exact = submitted_heartbeat_still_current(
            &candidates,
            &claim,
            &authenticated_user,
            verified_at,
        );
        let winner = active_claim_winner(&candidates, return_observed_at);
        if return_observed_at >= prior_expiry
            || !exact
            || has_active_takeover(&candidates, &claim, return_observed_at)
            || winner
                .is_none_or(|winner| winner.id != claim.id || winner.comment_id != claim.comment_id)
        {
            let fresh = issue_comments(&repository, &target, number).map_err(|error| {
                format!("Shipping claim heartbeat verification failed; safe release check failed: {error}")
            })?;
            let still_submitted = submitted_heartbeat_still_current(
                &fresh,
                &claim,
                &authenticated_user,
                verified_at,
            );
            if !still_submitted {
                return Err("Shipping claim heartbeat was superseded by a newer update.".to_string());
            }
            let released = released_claim_marker(
                &claim,
                verified_at,
                "superseded during heartbeat",
            )?;
            return match post_claim_comment(&repository, &target, number, &released) {
                Ok(_) => {
                    delete_claim_fence_if_owned(&repository, &target, number, &claim)?;
                    Err("Shipping claim was superseded during heartbeat.".to_string())
                }
                Err(error) => Err(format!(
                    "Shipping claim was superseded during heartbeat; compensating release failed: {error}"
                )),
            };
        }
        Ok(claim)
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn release_shipping_claim(
    repository: String,
    number: u64,
    claim: ShippingClaim,
    instance_id: String,
    reason: String,
) -> Result<ShippingClaim, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if number == 0 || !valid_claim_value(&reason, 200) {
            return Err("Invalid shipping claim release.".to_string());
        }
        validated_claim_input(&claim)?;
        if !valid_claim_value(&instance_id, 100)
            || claim.instance_id.as_deref() != Some(instance_id.as_str())
        {
            return Err("Shipping claim belongs to another Sail instance.".to_string());
        }
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let target = target_repository(&repository)?;
        let authenticated_user = authenticated_github_user(&repository)?;
        let existing = issue_comments(&repository, &target, number)?;
        let observed_at = github_server_time_millis(&repository)?;
        let transition_scope = claim_transition_scope(number, claim.comment_id);
        with_claim_transition(
            &repository,
            &target,
            &transition_scope,
            &claim,
            &existing,
            observed_at,
            || {
                let current = issue_claim_comment(&repository, &target, claim.comment_id)?;
                let mut current_comments = existing.clone();
                current_comments.retain(|candidate| candidate.comment_id != current.comment_id);
                current_comments.push(current);
                let (stored, released) = reconciled_claim_release(
                    &current_comments,
                    &claim,
                    &authenticated_user,
                    observed_at,
                )?;
                if let Some(released) = released {
                    mark_original_claim_released(&repository, &target, stored, released)?;
                    delete_claim_fence_after_verified_release(
                        &repository,
                        &target,
                        number,
                        stored,
                    )?;
                    return Ok(released.clone());
                }
                require_claim_fence_owner(&repository, &target, number, stored)?;
                let mut released = released_claim_marker(stored, observed_at, &reason)?;
                let value = post_claim_comment(&repository, &target, number, &released)?;
                released.comment_id = value["id"]
                    .as_u64()
                    .ok_or("GitHub claim release comment has no id.")?;
                mark_original_claim_released(&repository, &target, stored, &released)?;
                delete_claim_fence_after_verified_release(&repository, &target, number, stored)?;
                Ok(released)
            },
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn shipping_target_repository(repository: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = crate::validate_repository(repository)?;
        target_repository(Path::new(&repository))
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn shipping_pull_request(
    repository: String,
    branch: String,
    target_repository: Option<String>,
    base_branch: String,
) -> Result<Option<ShippingPullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = crate::validate_repository(repository)?;
        if branch.is_empty() || branch.starts_with('-') || branch.contains(char::is_whitespace) {
            return Err("Invalid shipping branch.".to_string());
        }
        if base_branch.is_empty()
            || base_branch.starts_with('-')
            || base_branch.contains(char::is_whitespace)
        {
            return Err("Invalid shipping base branch.".to_string());
        }
        let worktree = Path::new(&repository);
        let target = target_repository
            .filter(|value| !value.trim().is_empty())
            .ok_or("Shipping target repository is missing. Refresh the shipping worktree.")?;
        if target.starts_with('-')
            || target.split('/').count() != 2
            || target.split('/').any(str::is_empty)
            || !target
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_/.".contains(character))
        {
            return Err("Invalid shipping target repository.".to_string());
        }
        let remote = branch_remote(worktree, &branch)?;
        let source = source_repository(worktree, &remote)?;
        let head = pull_request_head(&source, &target, &branch);
        let output = gh_command(
            worktree,
            &[
                "pr",
                "list",
                "--repo",
                &target,
                "--head",
                &head,
                "--state",
                "all",
                "--json",
                "number,url,state,mergedAt,headRefOid,statusCheckRollup",
                "--limit",
                "100",
            ],
        )?;
        let values: Vec<serde_json::Value> =
            serde_json::from_str(&output).map_err(|error| error.to_string())?;
        let mut prs = Vec::new();
        for value in &values {
            let number = value["number"]
                .as_u64()
                .ok_or("GitHub returned a pull request without a number.")?;
            let details = gh_command(
                worktree,
                &["api", &format!("repos/{target}/pulls/{number}")],
            )?;
            let details: serde_json::Value = serde_json::from_str(&details)
                .map_err(|_| "GitHub returned invalid pull request details.".to_string())?;
            if let Some(mut pr) = shipping_pull_request_snapshot(
                value,
                &details,
                &source,
                &target,
                &branch,
                &base_branch,
            )? {
                let mut enriched = value.clone();
                enriched["statusCheckRollup"] = complete_check_rollup_or_original(
                    value,
                    check_rollup_with_identities(worktree, &target, &pr.head_ref_oid),
                );
                pr.checks = parse_pull_request_checks(&enriched)?.checks;
                prs.push(pr);
            }
        }
        if prs.len() > 1 {
            return Err("Multiple pull requests use this shipping branch.".to_string());
        }
        Ok(prs.pop())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn shipping_pull_request_head_matches(
    listed: &serde_json::Value,
    details: &serde_json::Value,
) -> bool {
    let Some(listed_sha) = listed["headRefOid"].as_str().filter(|sha| !sha.is_empty()) else {
        return false;
    };
    details["head"]["sha"].as_str() == Some(listed_sha)
}

fn shipping_pull_request_snapshot(
    listed: &serde_json::Value,
    details: &serde_json::Value,
    source: &str,
    target: &str,
    branch: &str,
    base_branch: &str,
) -> Result<Option<ShippingPullRequest>, String> {
    if !shipping_pull_request_matches(details, source, target, branch, base_branch) {
        return Ok(None);
    }
    if !shipping_pull_request_head_matches(listed, details) {
        return Err(
            "Pull request head changed while loading checks. Refresh and retry.".to_string(),
        );
    }
    let mut pr: ShippingPullRequest =
        serde_json::from_value(listed.clone()).map_err(|error| error.to_string())?;
    pr.checks = parse_pull_request_checks(listed)?.checks;
    Ok(Some(pr))
}

fn shipping_pull_request_matches(
    value: &serde_json::Value,
    source: &str,
    target: &str,
    branch: &str,
    base_branch: &str,
) -> bool {
    value["head"]["ref"].as_str() == Some(branch)
        && value["head"]["repo"]["full_name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(source))
        && value["base"]["ref"].as_str() == Some(base_branch)
        && value["base"]["repo"]["full_name"]
            .as_str()
            .is_some_and(|name| name.eq_ignore_ascii_case(target))
}

#[tauri::command]
pub async fn shipping_dependency_closed(
    repository: String,
    reference: String,
) -> Result<bool, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = crate::validate_repository(repository)?;
        let (target, number) = if let Some((target, number)) = reference.split_once('#') {
            if target.split('/').count() != 2
                || target.split('/').any(str::is_empty)
                || !target.chars().all(|character| {
                    character.is_ascii_alphanumeric() || "-_/.".contains(character)
                })
            {
                return Err("Invalid dependency repository.".to_string());
            }
            (target.to_string(), number.to_string())
        } else {
            (target_repository(Path::new(&repository))?, reference)
        };
        let number = number
            .parse::<u64>()
            .map_err(|_| "Invalid dependency issue number.".to_string())?;
        if number == 0 {
            return Err("Invalid dependency issue number.".to_string());
        }
        let output = gh_command(
            Path::new(&repository),
            &[
                "api",
                &format!("repos/{target}/issues/{number}"),
                "--jq",
                ".state",
            ],
        )?;
        Ok(output.trim() == "closed")
    })
    .await
    .map_err(|error| error.to_string())?
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestCheck {
    name: String,
    state: String,
    url: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    database_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    run_id: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    attempt: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    status_context_id: Option<String>,
    identity_uncertain: bool,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PullRequestChecks {
    number: u64,
    url: String,
    checks: Vec<PullRequestCheck>,
}

#[derive(Deserialize)]
pub struct WorktreeBranch {
    path: String,
    branch: String,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RepositoryChecks {
    checks: HashMap<String, Option<PullRequestChecks>>,
    errors: HashMap<String, String>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct GitHubIssue {
    number: u64,
    title: String,
    body: String,
    url: String,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueDraft {
    id: String,
    number: Option<u64>,
    repository: Option<String>,
    title: String,
    body: String,
    depends_on: Vec<String>,
}

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueGraphDraft {
    repository: Option<String>,
    umbrella_number: Option<u64>,
    source: String,
    #[serde(default)]
    replace_existing: bool,
    title: String,
    body: String,
    issues: Vec<IssueDraft>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedIssue {
    id: String,
    number: u64,
    repository: String,
    title: String,
    body: String,
    url: String,
    state: String,
    depends_on: Vec<String>,
}

#[derive(Serialize)]
pub struct PublishedGraph {
    umbrella: Option<PublishedIssue>,
    issues: Vec<PublishedIssue>,
}

fn issue_api(directory: &Path, args: &[&str]) -> Result<serde_json::Value, String> {
    let mut command = vec!["api"];
    command.extend_from_slice(args);
    let output = gh_command(directory, &command)?;
    serde_json::from_str(&output).map_err(|_| "GitHub returned invalid issue data.".to_string())
}

fn github_issue(directory: &Path, target: &str, number: u64) -> Result<serde_json::Value, String> {
    issue_api(directory, &[&format!("repos/{target}/issues/{number}")])
        .map_err(|error| format!("Cannot access issue #{number}: {error}"))
}

fn issue_field(value: &serde_json::Value, field: &str) -> Result<String, String> {
    value[field]
        .as_str()
        .map(str::to_string)
        .ok_or_else(|| format!("GitHub issue has no {field}."))
}

fn issue_repository_name(value: &serde_json::Value) -> Result<String, String> {
    let url = issue_field(value, "repository_url")?;
    let name = url
        .strip_prefix("https://api.github.com/repos/")
        .ok_or("GitHub issue has an invalid repository.")?;
    if name.split('/').count() != 2 || name.split('/').any(str::is_empty) {
        return Err("GitHub issue has an invalid repository.".into());
    }
    Ok(name.to_string())
}

fn draft_repository<'a>(draft: &'a IssueDraft, target: &'a str) -> Result<&'a str, String> {
    let name = draft.repository.as_deref().unwrap_or(target);
    let (owner, repo) = name.split_once('/').ok_or("Invalid issue repository.")?;
    let target_owner = target.split('/').next().unwrap_or_default();
    let valid = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_' | '.'))
    };
    if !owner.eq_ignore_ascii_case(target_owner) || !valid(owner) || !valid(repo) {
        return Err("Subissues must belong to repositories under the same owner.".into());
    }
    if draft.number.is_none() && !name.eq_ignore_ascii_case(target) {
        return Err("Choose an existing issue number for a different repository.".into());
    }
    Ok(name)
}

fn dependency_repository<'a>(
    reference: &'a str,
    target: &'a str,
) -> Result<(&'a str, u64), String> {
    let (repository, number) = if let Some((repository, number)) = reference.rsplit_once('#') {
        (repository, number)
    } else {
        (target, reference)
    };
    let number = number
        .parse::<u64>()
        .ok()
        .filter(|number| *number > 0)
        .ok_or_else(|| format!("Missing dependency {reference}."))?;
    let probe = IssueDraft {
        id: String::new(),
        number: Some(number),
        repository: Some(repository.to_string()),
        title: String::new(),
        body: String::new(),
        depends_on: Vec::new(),
    };
    draft_repository(&probe, target)?;
    Ok((repository, number))
}

fn issue_reference(repository: &str, number: u64, target: &str) -> String {
    if repository.eq_ignore_ascii_case(target) {
        number.to_string()
    } else {
        format!("{repository}#{number}")
    }
}

fn value_reference(value: &serde_json::Value, target: &str) -> Result<String, String> {
    let number = value["number"]
        .as_u64()
        .ok_or("GitHub issue has no number.")?;
    Ok(issue_reference(
        &issue_repository_name(value)?,
        number,
        target,
    ))
}

fn published_issue(value: &serde_json::Value, id: String) -> Result<PublishedIssue, String> {
    let number = value["number"]
        .as_u64()
        .ok_or("GitHub issue has no number.")?;
    if value.get("pull_request").is_some() {
        return Err(format!("#{number} is a pull request, not an issue."));
    }
    Ok(PublishedIssue {
        id,
        number,
        repository: issue_repository_name(value)?,
        title: issue_field(value, "title")?,
        body: value["body"]
            .as_str()
            .unwrap_or_default()
            .split_once("\n\n<!-- sail-graph:")
            .map_or_else(
                || value["body"].as_str().unwrap_or_default(),
                |(body, _)| body,
            )
            .to_string(),
        url: issue_field(value, "html_url")?,
        state: issue_field(value, "state")?.to_uppercase(),
        depends_on: Vec::new(),
    })
}

fn issue_pages(directory: &Path, endpoint: &str) -> Result<Vec<serde_json::Value>, String> {
    let pages = issue_api(
        directory,
        &[
            "-X",
            "GET",
            endpoint,
            "--paginate",
            "--slurp",
            "-F",
            "per_page=100",
        ],
    )?;
    let pages = pages
        .as_array()
        .ok_or("GitHub returned invalid issue pages.")?;
    let mut entries = Vec::new();
    for page in pages {
        entries.extend(
            page.as_array()
                .ok_or("GitHub returned an invalid issue page.")?
                .iter()
                .cloned(),
        );
    }
    Ok(entries)
}

fn issue_parent(
    directory: &Path,
    target: &str,
    number: u64,
) -> Result<Option<(String, u64)>, String> {
    let endpoint = format!("repos/{target}/issues/{number}/parent");
    match gh_command(directory, &["api", &endpoint]) {
        Ok(output) => {
            let parent: serde_json::Value = serde_json::from_str(&output)
                .map_err(|_| "GitHub returned an invalid parent issue.".to_string())?;
            let number = parent["number"]
                .as_u64()
                .ok_or("GitHub parent issue has no number.")?;
            Ok(Some((issue_repository_name(&parent)?, number)))
        }
        Err(error) if error.contains("HTTP 404") => Ok(None),
        Err(error) => Err(format!("Cannot inspect parent of #{number}: {error}")),
    }
}

fn graph_aliases(graph: &IssueGraphDraft) -> HashMap<String, String> {
    let mut aliases = graph
        .issues
        .iter()
        .map(|issue| {
            (
                alias_key(&issue.id, graph.repository.as_deref()),
                issue.id.clone(),
            )
        })
        .collect::<HashMap<_, _>>();
    for issue in &graph.issues {
        aliases.insert(issue.id.clone(), issue.id.clone());
    }
    for issue in &graph.issues {
        if let Some(number) = issue.number {
            if let Some(repo) = issue.repository.as_ref().or(graph.repository.as_ref()) {
                aliases.insert(
                    alias_key(&format!("{repo}#{number}"), graph.repository.as_deref()),
                    issue.id.clone(),
                );
            }
            if issue.repository.as_ref().is_none_or(|repo| {
                graph
                    .repository
                    .as_ref()
                    .is_some_and(|target| repo.eq_ignore_ascii_case(target))
            }) {
                aliases.insert(number.to_string(), issue.id.clone());
            }
        }
    }
    aliases
}

fn alias_key(reference: &str, target: Option<&str>) -> String {
    if let Some((repository, number)) = reference.rsplit_once('#') {
        if repository.contains('/') {
            if let Some(number) = number.parse::<u64>().ok().filter(|number| *number > 0) {
                if target.is_some_and(|target| repository.eq_ignore_ascii_case(target)) {
                    return number.to_string();
                }
                return format!("{}#{number}", repository.to_ascii_lowercase());
            }
        }
    }
    if let Some(number) = reference.parse::<u64>().ok().filter(|number| *number > 0) {
        return number.to_string();
    }
    reference.to_string()
}

fn validate_graph(graph: &IssueGraphDraft) -> Result<(), String> {
    use std::collections::{HashMap, HashSet};
    if graph.source.trim().is_empty() {
        return Err("Issue graph has no source.".into());
    }
    if graph.issues.is_empty() {
        return Err("Add at least one issue.".into());
    }
    if graph.issues.len() > 1 && graph.umbrella_number.is_none() && graph.title.trim().is_empty() {
        return Err("Enter an umbrella title.".into());
    }
    if graph.umbrella_number == Some(0) {
        return Err("Enter a valid umbrella number.".into());
    }
    let mut ids = HashSet::new();
    let mut numbers = HashSet::new();
    let aliases = graph_aliases(graph);
    for issue in &graph.issues {
        if issue.id == "umbrella" {
            return Err("Issue ID umbrella is reserved.".into());
        }
        if issue.id.trim().is_empty() || !ids.insert(issue.id.as_str()) {
            return Err(format!("Duplicate or empty issue ID: {}.", issue.id));
        }
        if aliases.get(&alias_key(&issue.id, graph.repository.as_deref())) != Some(&issue.id) {
            return Err(format!(
                "Issue ID {} conflicts with an issue reference.",
                issue.id
            ));
        }
        if issue.title.trim().is_empty() {
            return Err(format!("Enter a title for {}.", issue.id));
        }
        if let Some(number) = issue.number {
            let local = issue.repository.as_ref().is_none_or(|repo| {
                graph
                    .repository
                    .as_ref()
                    .is_some_and(|target| repo.eq_ignore_ascii_case(target))
            });
            let key = (
                if local {
                    "local"
                } else {
                    issue.repository.as_deref().unwrap_or("local")
                },
                number,
            );
            if number == 0 || !numbers.insert(key) {
                return Err(format!("Invalid or duplicate issue #{number}."));
            }
            if local && Some(number) == graph.umbrella_number {
                return Err("An umbrella cannot be its own child.".into());
            }
        }
        let mut dependencies = HashSet::new();
        for dependency in &issue.depends_on {
            let key = alias_key(dependency, graph.repository.as_deref());
            let canonical = aliases.get(&key).cloned().unwrap_or(key);
            if !dependencies.insert(canonical) {
                return Err(format!("{} repeats dependency {dependency}.", issue.id));
            }
        }
    }
    let by_id: HashMap<&str, &IssueDraft> = graph
        .issues
        .iter()
        .map(|issue| (issue.id.as_str(), issue))
        .collect();
    fn visit(
        id: &str,
        by_id: &HashMap<&str, &IssueDraft>,
        aliases: &HashMap<String, String>,
        target: Option<&str>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> Result<(), String> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id.to_string()) {
            return Err(format!("Dependency cycle includes {id}."));
        }
        let issue = by_id
            .get(id)
            .ok_or_else(|| format!("Missing issue {id}."))?;
        for dependency in &issue.depends_on {
            if let Some(local) = aliases.get(&alias_key(dependency, target)) {
                visit(local, by_id, aliases, target, visiting, visited)?;
            } else if dependency
                .parse::<u64>()
                .ok()
                .filter(|number| *number > 0)
                .is_some()
            {
            } else if let Some((repository, number)) = dependency.rsplit_once('#') {
                let valid_repo = repository.split_once('/').is_some_and(|(owner, name)| {
                    !owner.is_empty() && !name.is_empty() && !name.contains('/')
                });
                if !valid_repo
                    || number
                        .parse::<u64>()
                        .ok()
                        .filter(|number| *number > 0)
                        .is_none()
                {
                    return Err(format!("Missing dependency {dependency}."));
                }
            } else {
                return Err(format!("Missing dependency {dependency}."));
            }
        }
        visiting.remove(id);
        visited.insert(id.to_string());
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for issue in &graph.issues {
        visit(
            &issue.id,
            &by_id,
            &aliases,
            graph.repository.as_deref(),
            &mut visiting,
            &mut visited,
        )?;
    }
    Ok(())
}

fn create_issue(
    directory: &Path,
    target: &str,
    title: &str,
    body: &str,
) -> Result<serde_json::Value, String> {
    issue_api(
        directory,
        &[
            "-X",
            "POST",
            &format!("repos/{target}/issues"),
            "-f",
            &format!("title={title}"),
            "-f",
            &format!("body={body}"),
        ],
    )
}

fn marker(source: &str, id: &str) -> String {
    let key = format!("{source}:{id}");
    let encoded = key
        .as_bytes()
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect::<String>();
    format!("<!-- sail-graph:{encoded} -->")
}

fn marked_issue<'a>(
    issues: &'a [serde_json::Value],
    marker: &str,
) -> Result<Option<&'a serde_json::Value>, String> {
    let matches = issues
        .iter()
        .filter(|issue| {
            issue["body"]
                .as_str()
                .is_some_and(|body| body.contains(marker))
        })
        .collect::<Vec<_>>();
    if matches.len() > 1 {
        return Err(format!("Multiple issues carry graph marker {marker}."));
    }
    Ok(matches.first().copied())
}

fn issue_body(body: &str, marker: &str) -> String {
    format!("{}\n\n{marker}", body.trim_end())
}

fn save_issue(
    directory: &Path,
    target: &str,
    existing: Option<serde_json::Value>,
    title: &str,
    body: &str,
    marker: &str,
) -> Result<serde_json::Value, String> {
    let has_marker = existing.as_ref().is_none_or(|issue| {
        issue["body"]
            .as_str()
            .is_some_and(|body| body.contains(marker))
    });
    let desired = if has_marker {
        issue_body(body, marker)
    } else {
        body.to_string()
    };
    if let Some(issue) = existing {
        if issue["title"].as_str() == Some(title) && issue["body"].as_str() == Some(&desired) {
            return Ok(issue);
        }
        let number = issue["number"]
            .as_u64()
            .ok_or("GitHub issue has no number.")?;
        issue_api(
            directory,
            &[
                "-X",
                "PATCH",
                &format!("repos/{target}/issues/{number}"),
                "-f",
                &format!("title={title}"),
                "-f",
                &format!("body={desired}"),
            ],
        )
    } else {
        create_issue(directory, target, title, &desired)
    }
}

fn delete_issue_link(directory: &Path, endpoint: &str, field: &str, id: u64) -> Result<(), String> {
    gh_command(
        directory,
        &[
            "api",
            "-X",
            "DELETE",
            endpoint,
            "-F",
            &format!("{field}={id}"),
        ],
    )
    .map(|_| ())
}

fn validate_reachable_dependencies(
    directory: &Path,
    graph: &IssueGraphDraft,
    existing: &HashMap<String, serde_json::Value>,
    external: &HashMap<String, serde_json::Value>,
) -> Result<(), String> {
    use std::collections::HashSet;
    let draft_nodes = existing
        .iter()
        .map(|(id, value)| {
            Ok((
                value["id"].as_u64().ok_or("GitHub issue has no ID.")?,
                format!("draft:{id}"),
            ))
        })
        .collect::<Result<HashMap<_, _>, String>>()?;
    let mut edges: HashMap<String, Vec<String>> = HashMap::new();
    let mut pending = Vec::new();
    for draft in &graph.issues {
        let mut blockers = Vec::new();
        for dependency in &draft.depends_on {
            if graph.issues.iter().any(|issue| issue.id == *dependency) {
                blockers.push(format!("draft:{dependency}"));
            } else {
                let value = external.get(dependency).ok_or("Missing dependency.")?;
                let id = value["id"].as_u64().ok_or("GitHub dependency has no ID.")?;
                blockers.push(format!("external:{id}"));
                pending.push(value.clone());
            }
        }
        edges.insert(format!("draft:{}", draft.id), blockers);
    }
    let mut seen = HashSet::new();
    while let Some(value) = pending.pop() {
        let id = value["id"].as_u64().ok_or("GitHub dependency has no ID.")?;
        if !seen.insert(id) {
            continue;
        }
        if seen.len() > 10_000 {
            return Err("Dependency graph is too large to validate.".into());
        }
        let repository = issue_repository_name(&value)?;
        let number = value["number"]
            .as_u64()
            .ok_or("GitHub dependency has no number.")?;
        let blockers = issue_pages(
            directory,
            &format!("repos/{repository}/issues/{number}/dependencies/blocked_by"),
        )?;
        let mut next = Vec::new();
        for blocker in blockers {
            let blocker_id = blocker["id"]
                .as_u64()
                .ok_or("GitHub dependency has no ID.")?;
            if let Some(draft) = draft_nodes.get(&blocker_id) {
                next.push(draft.clone());
            } else {
                next.push(format!("external:{blocker_id}"));
                pending.push(blocker);
            }
        }
        edges.insert(format!("external:{id}"), next);
    }
    fn visit(
        node: &str,
        edges: &HashMap<String, Vec<String>>,
        visiting: &mut HashSet<String>,
        visited: &mut HashSet<String>,
    ) -> Result<(), String> {
        if visited.contains(node) {
            return Ok(());
        }
        if !visiting.insert(node.to_string()) {
            return Err(format!("Dependency cycle includes {node}."));
        }
        if let Some(next) = edges.get(node) {
            for blocker in next {
                visit(blocker, edges, visiting, visited)?;
            }
        }
        visiting.remove(node);
        visited.insert(node.to_string());
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for draft in &graph.issues {
        visit(
            &format!("draft:{}", draft.id),
            &edges,
            &mut visiting,
            &mut visited,
        )?;
    }
    Ok(())
}

fn publish_graph(repository: String, mut graph: IssueGraphDraft) -> Result<PublishedGraph, String> {
    let (repository, target) = issue_repository(repository)?;
    let _publish_guard = GRAPH_PUBLISH_LOCK
        .get_or_init(|| Mutex::new(()))
        .lock()
        .map_err(|_| "Issue publication lock failed.")?;
    graph.repository = Some(target.clone());
    validate_graph(&graph)?;
    let needs_lookup = (graph.issues.len() > 1 && graph.umbrella_number.is_none())
        || graph.issues.iter().any(|issue| issue.number.is_none());
    let all_issues = if needs_lookup {
        issue_pages(&repository, &format!("repos/{target}/issues?state=all"))?
    } else {
        Vec::new()
    };
    let umbrella_marker = marker(&graph.source, "umbrella");
    let umbrella = if let Some(number) = graph.umbrella_number {
        Some(github_issue(&repository, &target, number)?)
    } else if graph.issues.len() > 1 {
        marked_issue(&all_issues, &umbrella_marker)?.cloned()
    } else {
        None
    };
    if let Some(value) = &umbrella {
        let issue = published_issue(value, "umbrella".into())?;
        if issue.state != "OPEN" {
            return Err(format!("Umbrella #{} is closed.", issue.number));
        }
    }
    let umbrella_number = umbrella.as_ref().and_then(|value| value["number"].as_u64());
    let mut existing = HashMap::new();
    let mut old_parent = None;
    let mut resolved_numbers = std::collections::HashSet::new();
    for draft in &graph.issues {
        let issue_repo = draft_repository(draft, &target)?;
        let value = if let Some(number) = draft.number {
            Some(github_issue(&repository, issue_repo, number)?)
        } else {
            marked_issue(&all_issues, &marker(&graph.source, &draft.id))?.cloned()
        };
        if let Some(value) = value {
            let issue = published_issue(&value, draft.id.clone())?;
            if !resolved_numbers.insert((issue.repository.clone(), issue.number)) {
                return Err(format!(
                    "Issue {} appears twice.",
                    issue_reference(&issue.repository, issue.number, &target)
                ));
            }
            if issue.state != "OPEN" {
                return Err(format!("Issue #{} is closed.", issue.number));
            }
            if let Some((parent_repo, parent_number)) =
                issue_parent(&repository, issue_repo, issue.number)?
            {
                if !parent_repo.eq_ignore_ascii_case(&target)
                    || Some(parent_number) != umbrella_number
                {
                    let parent_issue = github_issue(&repository, &parent_repo, parent_number)?;
                    let owned_parent = umbrella_number.is_none()
                        && graph.issues.len() == 1
                        && parent_issue["body"]
                            .as_str()
                            .is_some_and(|body| body.contains(&umbrella_marker));
                    if owned_parent {
                        old_parent = Some((
                            parent_repo.clone(),
                            parent_number,
                            value["id"].as_u64().ok_or("GitHub issue has no ID.")?,
                        ));
                    } else {
                        return Err(format!(
                            "Issue {} already belongs to umbrella {}.",
                            issue_reference(&issue.repository, issue.number, &target),
                            issue_reference(&parent_repo, parent_number, &target)
                        ));
                    }
                }
            }
            existing.insert(draft.id.clone(), value);
        }
    }
    let recovered_umbrella = umbrella
        .as_ref()
        .and_then(|value| value["body"].as_str())
        .is_some_and(|body| body.contains(&umbrella_marker));
    let recovered_single = umbrella.is_none()
        && existing.iter().any(|(id, value)| {
            value["body"]
                .as_str()
                .is_some_and(|body| body.contains(&marker(&graph.source, id)))
        });
    let replace_existing = graph.replace_existing || recovered_umbrella || recovered_single;
    let mut resolved_graph = graph.clone();
    for draft in &mut resolved_graph.issues {
        if let Some(value) = existing.get(&draft.id) {
            draft.number = value["number"].as_u64();
        }
    }
    let aliases = graph_aliases(&resolved_graph);
    for draft in &mut resolved_graph.issues {
        for dependency in &mut draft.depends_on {
            if let Some(id) = aliases.get(&alias_key(dependency, graph.repository.as_deref())) {
                *dependency = id.clone();
            }
        }
    }
    validate_graph(&resolved_graph)?;
    graph = resolved_graph;
    let mut external = HashMap::new();
    for draft in &graph.issues {
        for dependency in &draft.depends_on {
            if graph.issues.iter().any(|issue| issue.id == *dependency) {
                continue;
            }
            let (dependency_repo, number) = dependency_repository(dependency, &target)?;
            let value = github_issue(&repository, dependency_repo, number)?;
            let issue = published_issue(&value, dependency.clone())?;
            if draft.number == Some(issue.number)
                && draft_repository(draft, &target)?.eq_ignore_ascii_case(&issue.repository)
            {
                return Err(format!("Issue #{} cannot block itself.", issue.number));
            }
            if issue.state != "OPEN" {
                return Err(format!("Dependency #{number} is closed."));
            }
            external.insert(dependency.clone(), value);
        }
    }
    for draft in &graph.issues {
        let mut seen = std::collections::HashSet::new();
        for dependency in &draft.depends_on {
            if let Some(value) = existing
                .get(dependency)
                .or_else(|| external.get(dependency))
            {
                let id = value["id"].as_u64().ok_or("GitHub dependency has no ID.")?;
                if !seen.insert(id) {
                    return Err(format!("{} repeats dependency {dependency}.", draft.id));
                }
            }
        }
    }
    validate_reachable_dependencies(&repository, &graph, &existing, &external)?;
    if !replace_existing {
        if let Some(parent) = &umbrella {
            let parent_number = parent["number"]
                .as_u64()
                .ok_or("GitHub umbrella has no number.")?;
            let linked = issue_pages(
                &repository,
                &format!("repos/{target}/issues/{parent_number}/sub_issues"),
            )?;
            let wanted = existing
                .values()
                .filter_map(|value| value["id"].as_u64())
                .collect::<std::collections::HashSet<_>>();
            for child in linked {
                let id = child["id"].as_u64().ok_or("GitHub subissue has no ID.")?;
                if !wanted.contains(&id) {
                    return Err(format!("Umbrella #{parent_number} already has child {}; load the umbrella before editing its split.", value_reference(&child, &target)?));
                }
            }
        }
        for draft in &graph.issues {
            let Some(value) = existing.get(&draft.id) else {
                continue;
            };
            let number = value["number"]
                .as_u64()
                .ok_or("GitHub issue has no number.")?;
            let issue_repo = issue_repository_name(value)?;
            let current = issue_pages(
                &repository,
                &format!("repos/{issue_repo}/issues/{number}/dependencies/blocked_by"),
            )?;
            let desired = draft
                .depends_on
                .iter()
                .filter_map(|dependency| {
                    existing
                        .get(dependency)
                        .or_else(|| external.get(dependency))
                        .and_then(|value| value["id"].as_u64())
                })
                .collect::<std::collections::HashSet<_>>();
            for blocker in current {
                let id = blocker["id"]
                    .as_u64()
                    .ok_or("GitHub dependency has no ID.")?;
                if !desired.contains(&id) {
                    return Err(format!(
                        "Issue {} already has blocker {}; load its umbrella before editing links.",
                        issue_reference(&issue_repo, number, &target),
                        value_reference(&blocker, &target)?
                    ));
                }
            }
        }
    }
    let mut umbrella = umbrella;
    if graph.issues.len() > 1 || umbrella.is_some() {
        umbrella = Some(save_issue(
            &repository,
            &target,
            umbrella,
            &graph.title,
            &graph.body,
            &umbrella_marker,
        )?);
    }
    let mut issues = Vec::new();
    for draft in &graph.issues {
        let issue_repo = draft_repository(draft, &target)?;
        let value = save_issue(
            &repository,
            issue_repo,
            existing.remove(&draft.id),
            &draft.title,
            &draft.body,
            &marker(&graph.source, &draft.id),
        )
        .map_err(|error| format!("Cannot save {}: {error}", draft.id))?;
        let mut issue = published_issue(&value, draft.id.clone())?;
        issue.depends_on = draft.depends_on.clone();
        issues.push((issue, value));
    }
    if let Some((parent_repo, parent, child_id)) = old_parent {
        delete_issue_link(
            &repository,
            &format!("repos/{parent_repo}/issues/{parent}/sub_issue"),
            "sub_issue_id",
            child_id,
        )?;
    }
    if let Some(parent_value) = &umbrella {
        let parent = published_issue(parent_value, "umbrella".into())?;
        let linked = issue_pages(
            &repository,
            &format!("repos/{target}/issues/{}/sub_issues", parent.number),
        )?;
        let wanted = issues
            .iter()
            .filter_map(|(_, value)| value["id"].as_u64())
            .collect::<std::collections::HashSet<_>>();
        if replace_existing {
            for old in &linked {
                let id = old["id"].as_u64().ok_or("GitHub subissue has no ID.")?;
                if !wanted.contains(&id) {
                    delete_issue_link(
                        &repository,
                        &format!("repos/{target}/issues/{}/sub_issue", parent.number),
                        "sub_issue_id",
                        id,
                    )?;
                }
            }
        }
        let linked_ids = linked
            .iter()
            .filter_map(|value| value["id"].as_u64())
            .collect::<std::collections::HashSet<_>>();
        for (issue, value) in &issues {
            let id = value["id"].as_u64().ok_or("GitHub issue has no ID.")?;
            if !linked_ids.contains(&id) {
                issue_api(
                    &repository,
                    &[
                        "-X",
                        "POST",
                        &format!("repos/{target}/issues/{}/sub_issues", parent.number),
                        "-F",
                        &format!("sub_issue_id={id}"),
                    ],
                )
                .map_err(|error| {
                    format!(
                        "Cannot attach #{} to umbrella #{}: {error}",
                        issue.number, parent.number
                    )
                })?;
            }
        }
    }
    let mut pending_blockers = Vec::new();
    for (issue, _) in &issues {
        let blocked_by = issue_pages(
            &repository,
            &format!(
                "repos/{}/issues/{}/dependencies/blocked_by",
                issue.repository, issue.number
            ),
        )?;
        let desired = issue
            .depends_on
            .iter()
            .map(|dependency| {
                let value = issues
                    .iter()
                    .find(|(candidate, _)| candidate.id == *dependency)
                    .map(|(_, value)| value)
                    .or_else(|| external.get(dependency))
                    .ok_or("Missing dependency.")?;
                Ok((
                    value_reference(value, &target)?,
                    value["id"].as_u64().ok_or("GitHub issue has no ID.")?,
                ))
            })
            .collect::<Result<Vec<(String, u64)>, String>>()?;
        let wanted = desired
            .iter()
            .map(|(_, id)| *id)
            .collect::<std::collections::HashSet<_>>();
        if replace_existing {
            for old in &blocked_by {
                let id = old["id"].as_u64().ok_or("GitHub dependency has no ID.")?;
                if !wanted.contains(&id) {
                    gh_command(
                        &repository,
                        &[
                            "api",
                            "-X",
                            "DELETE",
                            &format!(
                                "repos/{}/issues/{}/dependencies/blocked_by/{id}",
                                issue.repository, issue.number
                            ),
                        ],
                    )?;
                }
            }
        }
        let current = blocked_by
            .iter()
            .filter_map(|value| value["id"].as_u64())
            .collect::<std::collections::HashSet<_>>();
        for (reference, id) in desired {
            if !current.contains(&id) {
                pending_blockers.push((issue.repository.clone(), issue.number, reference, id));
            }
        }
    }
    for (issue_repo, number, reference, id) in pending_blockers {
        issue_api(
            &repository,
            &[
                "-X",
                "POST",
                &format!("repos/{issue_repo}/issues/{number}/dependencies/blocked_by"),
                "-F",
                &format!("issue_id={id}"),
            ],
        )
        .map_err(|error| format!("Cannot add blocker {reference} to #{number}: {error}"))?;
    }
    Ok(PublishedGraph {
        umbrella: umbrella
            .as_ref()
            .map(|value| published_issue(value, "umbrella".into()))
            .transpose()?,
        issues: issues.into_iter().map(|(issue, _)| issue).collect(),
    })
}

#[tauri::command]
pub async fn publish_issue_graph(
    repository: String,
    graph: serde_json::Value,
) -> Result<PublishedGraph, String> {
    let graph: IssueGraphDraft =
        serde_json::from_value(graph).map_err(|error| format!("Invalid issue graph: {error}"))?;
    tauri::async_runtime::spawn_blocking(move || publish_graph(repository, graph))
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn load_issue_graph(
    repository: String,
    umbrella_number: u64,
) -> Result<PublishedGraph, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if umbrella_number == 0 {
            return Err("Enter an umbrella number.".into());
        }
        let (repository, target) = issue_repository(repository)?;
        let umbrella = published_issue(
            &github_issue(&repository, &target, umbrella_number)?,
            "umbrella".into(),
        )?;
        let children = issue_pages(
            &repository,
            &format!("repos/{target}/issues/{umbrella_number}/sub_issues"),
        )?;
        let mut issues = Vec::new();
        for value in children {
            let child_repo = issue_repository_name(&value)?;
            let number = value["number"]
                .as_u64()
                .ok_or("GitHub subissue has no number.")?;
            let mut issue = published_issue(&value, issue_reference(&child_repo, number, &target))?;
            let blockers = issue_pages(
                &repository,
                &format!("repos/{child_repo}/issues/{number}/dependencies/blocked_by"),
            )?;
            issue.depends_on = blockers
                .iter()
                .map(|blocker| value_reference(blocker, &target))
                .collect::<Result<Vec<_>, _>>()?;
            issues.push(issue);
        }
        Ok(PublishedGraph {
            umbrella: Some(umbrella),
            issues,
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn gh_binary() -> OsString {
    let name = if cfg!(windows) { "gh.exe" } else { "gh" };
    if let Some(path) = std::env::var_os("PATH")
        .into_iter()
        .flat_map(|path| std::env::split_paths(&path).collect::<Vec<_>>())
        .map(|directory| directory.join(name))
        .find(|path| path.is_file())
    {
        return path.into_os_string();
    }
    let candidates = if cfg!(windows) {
        vec![PathBuf::from(r"C:\Program Files\GitHub CLI\gh.exe")]
    } else {
        vec![
            PathBuf::from("/opt/homebrew/bin/gh"),
            PathBuf::from("/usr/local/bin/gh"),
        ]
    };
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .map_or_else(|| OsString::from(name), PathBuf::into_os_string)
}

fn run(directory: &Path, binary: &str, args: &[&str]) -> Result<Output, String> {
    Command::new(binary)
        .current_dir(directory)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Cannot start {binary}: {error}"))
}

fn output_or_error(output: Output, action: &str) -> Result<String, String> {
    if output.status.success() {
        Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
    } else {
        let error = String::from_utf8_lossy(&output.stderr).trim().to_string();
        Err(format!(
            "{action}: {}",
            if error.is_empty() {
                "Command failed"
            } else {
                &error
            }
        ))
    }
}

pub(crate) fn github_remote(url: &str) -> Option<String> {
    let path = url
        .strip_prefix("git@github.com:")
        .or_else(|| url.strip_prefix("ssh://git@github.com/"))
        .or_else(|| url.strip_prefix("https://github.com/"))?
        .trim_end_matches(".git");
    let (owner, repo) = path.split_once('/')?;
    if owner.is_empty() || repo.is_empty() || repo.contains('/') {
        return None;
    }
    Some(format!("{owner}/{repo}"))
}

#[tauri::command]
pub async fn github_issue_repository(repository: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || issue_repository(repository).map(|(_, name)| name))
        .await
        .map_err(|error| error.to_string())?
}

fn gh_command(directory: &Path, args: &[&str]) -> Result<String, String> {
    let mut command = Command::new(gh_binary());
    command
        .current_dir(directory)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0");
    let output = command_output_with_timeout(&mut command, Duration::from_secs(15))?;
    output_or_error(output, "GitHub CLI failed")
}

#[cfg(windows)]
struct CommandTreeHandle(HANDLE);

#[cfg(not(windows))]
struct CommandTreeHandle;

#[cfg(windows)]
impl Drop for CommandTreeHandle {
    fn drop(&mut self) {
        unsafe {
            let _ = CloseHandle(self.0);
        }
    }
}

#[cfg(windows)]
fn attach_command_tree(child: &mut Child) -> Result<CommandTreeHandle, String> {
    let job = unsafe { CreateJobObjectW(None, PCWSTR::null()) }
        .map_err(|error| format!("Cannot create GitHub CLI job object: {error}"))?;
    let handle = CommandTreeHandle(job);
    let mut limits = JOBOBJECT_EXTENDED_LIMIT_INFORMATION::default();
    limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
    unsafe {
        SetInformationJobObject(
            job,
            JobObjectExtendedLimitInformation,
            std::ptr::from_ref(&limits).cast(),
            std::mem::size_of_val(&limits) as u32,
        )
        .map_err(|error| format!("Cannot configure GitHub CLI job object: {error}"))?;
        let process = HANDLE(child.as_raw_handle());
        AssignProcessToJobObject(job, process)
            .map_err(|error| format!("Cannot assign GitHub CLI to its job object: {error}"))?;
    }
    Ok(handle)
}

#[cfg(windows)]
fn resume_attached_command(child: &Child) -> Result<(), String> {
    let snapshot = unsafe { CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0) }
        .map_err(|error| format!("Cannot inspect suspended GitHub CLI: {error}"))?;
    let thread = (|| {
        let mut entry = THREADENTRY32 {
            dwSize: std::mem::size_of::<THREADENTRY32>() as u32,
            ..Default::default()
        };
        unsafe { Thread32First(snapshot, &mut entry) }
            .map_err(|error| format!("Cannot inspect suspended GitHub CLI thread: {error}"))?;
        loop {
            if entry.th32OwnerProcessID == child.id() {
                return unsafe { OpenThread(THREAD_SUSPEND_RESUME, false, entry.th32ThreadID) }
                    .map_err(|error| format!("Cannot open suspended GitHub CLI thread: {error}"));
            }
            if unsafe { Thread32Next(snapshot, &mut entry) }.is_err() {
                break;
            }
        }
        Err("Cannot find suspended GitHub CLI thread.".to_string())
    })();
    unsafe {
        let _ = CloseHandle(snapshot);
    }
    let thread = thread?;
    let resumed = unsafe { ResumeThread(thread) };
    unsafe {
        let _ = CloseHandle(thread);
    }
    if resumed == u32::MAX {
        return Err(format!(
            "Cannot resume suspended GitHub CLI: {}",
            windows::core::Error::from_thread()
        ));
    }
    Ok(())
}

#[cfg(not(windows))]
fn attach_command_tree(_child: &mut Child) -> Result<CommandTreeHandle, String> {
    Ok(CommandTreeHandle)
}

#[cfg(unix)]
fn terminate_command_tree(child: &mut Child, _tree: &mut CommandTreeHandle) -> Result<(), String> {
    match signal::killpg(Pid::from_raw(child.id() as i32), signal::Signal::SIGKILL) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = child.kill();
            Err(format!(
                "Cannot terminate GitHub CLI process group: {error}"
            ))
        }
    }
}

#[cfg(windows)]
fn terminate_command_tree(child: &mut Child, tree: &mut CommandTreeHandle) -> Result<(), String> {
    if let Err(error) = unsafe { TerminateJobObject(tree.0, 1) } {
        let fallback = child.kill().err();
        return Err(format!(
            "Cannot terminate GitHub CLI job object: {error}.{}",
            fallback.map_or_else(String::new, |cause| {
                format!(" Fallback kill failed: {cause}.")
            })
        ));
    }
    let deadline = std::time::Instant::now() + Duration::from_secs(5);
    loop {
        let mut accounting = JOBOBJECT_BASIC_ACCOUNTING_INFORMATION::default();
        unsafe {
            QueryInformationJobObject(
                Some(tree.0),
                JobObjectBasicAccountingInformation,
                std::ptr::from_mut(&mut accounting).cast(),
                std::mem::size_of_val(&accounting) as u32,
                None,
            )
        }
        .map_err(|error| format!("Cannot verify GitHub CLI job termination: {error}"))?;
        if accounting.ActiveProcesses == 0 {
            break;
        }
        if std::time::Instant::now() >= deadline {
            return Err("GitHub CLI job did not confirm termination.".to_string());
        }
        std::thread::sleep(Duration::from_millis(10));
    }
    let _ = child.kill();
    Ok(())
}

#[cfg(not(any(unix, windows)))]
fn terminate_command_tree(child: &mut Child, _tree: &mut CommandTreeHandle) -> Result<(), String> {
    child
        .kill()
        .map_err(|error| format!("Cannot terminate GitHub CLI: {error}"))
}

fn command_reader_output(
    receiver: &std::sync::mpsc::Receiver<std::io::Result<Vec<u8>>>,
    stream: &str,
    timeout: Duration,
) -> Result<Vec<u8>, String> {
    receiver
        .recv_timeout(timeout)
        .map_err(|_| format!("GitHub CLI {stream} reader did not stop."))?
        .map_err(|error| format!("Cannot read GitHub CLI {stream}: {error}"))
}

fn reap_terminated_child(
    child: &mut Child,
    timeout: Duration,
) -> Result<std::process::ExitStatus, String> {
    match child
        .wait_timeout(timeout)
        .map_err(|error| format!("Cannot wait for terminated GitHub CLI: {error}"))?
    {
        Some(status) => Ok(status),
        None => {
            let _ = child.kill();
            child
                .wait_timeout(Duration::from_secs(1))
                .map_err(|error| format!("Cannot reap terminated GitHub CLI: {error}"))?
                .ok_or_else(|| "GitHub CLI did not stop after termination.".to_string())
        }
    }
}

fn command_output_with_timeout(command: &mut Command, timeout: Duration) -> Result<Output, String> {
    command_output_with_timeouts(command, timeout, Duration::from_secs(2))
}

fn command_output_with_timeouts(
    command: &mut Command,
    timeout: Duration,
    reader_timeout: Duration,
) -> Result<Output, String> {
    #[cfg(unix)]
    command.process_group(0);
    #[cfg(windows)]
    command.creation_flags(CREATE_SUSPENDED.0);
    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Cannot start GitHub CLI: {error}"))?;
    let mut command_tree = match attach_command_tree(&mut child) {
        Ok(tree) => tree,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    #[cfg(windows)]
    if let Err(error) = resume_attached_command(&child) {
        let termination = terminate_command_tree(&mut child, &mut command_tree).err();
        let reaping = reap_terminated_child(&mut child, Duration::from_secs(5)).err();
        return Err([Some(error), termination, reaping]
            .into_iter()
            .flatten()
            .collect::<Vec<_>>()
            .join(" "));
    }
    let mut stdout = child
        .stdout
        .take()
        .ok_or("GitHub CLI stdout is unavailable.")?;
    let mut stderr = child
        .stderr
        .take()
        .ok_or("GitHub CLI stderr is unavailable.")?;
    let (stdout_sender, stdout_receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = stdout.read_to_end(&mut output).map(|_| output);
        let _ = stdout_sender.send(result);
    });
    let (stderr_sender, stderr_receiver) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let mut output = Vec::new();
        let result = stderr.read_to_end(&mut output).map(|_| output);
        let _ = stderr_sender.send(result);
    });
    let timed_out;
    let mut termination_error = None;
    let status = match child
        .wait_timeout(timeout)
        .map_err(|error| format!("Cannot wait for GitHub CLI: {error}"))?
    {
        Some(status) => {
            timed_out = false;
            status
        }
        None => {
            timed_out = true;
            termination_error = terminate_command_tree(&mut child, &mut command_tree).err();
            reap_terminated_child(&mut child, Duration::from_secs(5)).map_err(|error| {
                termination_error
                    .as_ref()
                    .map_or(error.clone(), |termination| {
                        format!("{termination} {error}")
                    })
            })?
        }
    };
    let stdout = match command_reader_output(&stdout_receiver, "stdout", reader_timeout) {
        Ok(stdout) => stdout,
        Err(error) => {
            let termination = terminate_command_tree(&mut child, &mut command_tree).err();
            let _ = stdout_receiver.recv_timeout(reader_timeout);
            let _ = stderr_receiver.recv_timeout(reader_timeout);
            return Err(match termination {
                Some(termination) => format!("{error} {termination}"),
                None => error,
            });
        }
    };
    let stderr = match command_reader_output(&stderr_receiver, "stderr", reader_timeout) {
        Ok(stderr) => stderr,
        Err(error) => {
            let termination = terminate_command_tree(&mut child, &mut command_tree).err();
            let _ = stderr_receiver.recv_timeout(reader_timeout);
            return Err(match termination {
                Some(termination) => format!("{error} {termination}"),
                None => error,
            });
        }
    };
    if let Some(error) = termination_error {
        return Err(error);
    }
    if timed_out {
        return Err(format!(
            "GitHub CLI timed out after {} milliseconds.",
            timeout.as_millis()
        ));
    }
    Ok(Output {
        status,
        stdout,
        stderr,
    })
}

fn pull_request_repos(
    worktree: &Path,
    remote: &str,
    branch: &str,
) -> Result<(String, String), String> {
    let source = source_repository(worktree, remote)?;
    let target = target_repository(worktree)?;
    let head = pull_request_head(&source, &target, branch);
    Ok((target, head))
}

fn pull_request_head(source: &str, target: &str, branch: &str) -> String {
    if source.eq_ignore_ascii_case(target) {
        branch.to_string()
    } else {
        format!("{}:{branch}", source.split('/').next().unwrap_or_default())
    }
}

fn source_repository(worktree: &Path, remote: &str) -> Result<String, String> {
    let remote_url = output_or_error(
        run(worktree, "git", &["remote", "get-url", "--push", remote])?,
        "Cannot find push remote",
    )?;
    github_remote(&remote_url).ok_or("Push remote must be a github.com repository.".to_string())
}

pub(crate) fn target_repository(worktree: &Path) -> Result<String, String> {
    let repository = gh_command(
        worktree,
        &["repo", "view", "--json", "nameWithOwner,isFork,parent"],
    )?;
    let repository: serde_json::Value = serde_json::from_str(&repository)
        .map_err(|_| "GitHub CLI returned an invalid repository.".to_string())?;
    let selected = repository["nameWithOwner"]
        .as_str()
        .ok_or("GitHub CLI returned an invalid repository.")?;
    let target = if repository["isFork"].as_bool() == Some(true) {
        repository["parent"]["nameWithOwner"]
            .as_str()
            .unwrap_or(selected)
    } else {
        selected
    };
    Ok(target.to_string())
}

fn issue_repository(repository: String) -> Result<(PathBuf, String), String> {
    let repository = PathBuf::from(crate::validate_repository(repository)?);
    let remotes = output_or_error(run(&repository, "git", &["remote"])?, "Cannot list remotes")?;
    let has_github_remote = remotes.lines().any(|remote| {
        run(&repository, "git", &["remote", "get-url", remote])
            .ok()
            .and_then(|output| output_or_error(output, "Cannot read remote").ok())
            .and_then(|url| github_remote(&url))
            .is_some()
    });
    if !has_github_remote {
        return Err("This project has no github.com remote. Add one to browse issues.".to_string());
    }
    let target = target_repository(&repository)?;
    Ok((repository, target))
}

#[tauri::command]
pub async fn list_open_issues(
    repository: String,
    query: String,
) -> Result<Vec<GitHubIssue>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let (repository, target) = issue_repository(repository)?;
        let query = query.trim();
        if query.len() > 200 {
            return Err("Issue search is too long.".to_string());
        }
        let mut args = vec![
            "issue",
            "list",
            "--repo",
            &target,
            "--state",
            "open",
            "--limit",
            "30",
            "--json",
            "number,title,body,url",
        ];
        if !query.is_empty() {
            args.extend(["--search", query]);
        }
        let response = gh_command(&repository, &args)?;
        serde_json::from_str(&response)
            .map_err(|_| "GitHub CLI returned invalid issues.".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn open_issue(repository: String, number: u64) -> Result<GitHubIssue, String> {
    tauri::async_runtime::spawn_blocking(move || {
        if number == 0 {
            return Err("Choose an issue.".to_string());
        }
        let (repository, target) = issue_repository(repository)?;
        let number = number.to_string();
        let response = gh_command(
            &repository,
            &[
                "issue",
                "view",
                &number,
                "--repo",
                &target,
                "--json",
                "number,title,body,url,state",
            ],
        )?;
        let value: serde_json::Value = serde_json::from_str(&response)
            .map_err(|_| "GitHub CLI returned an invalid issue.".to_string())?;
        if value["state"] != "OPEN" {
            return Err("This issue is no longer open. Search again.".to_string());
        }
        serde_json::from_value(value)
            .map_err(|_| "GitHub CLI returned an invalid issue.".to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

fn checked_worktree(
    repository: String,
    worktree: String,
    branch: &str,
    allow_repository: bool,
) -> Result<PathBuf, String> {
    let repository = PathBuf::from(crate::validate_repository(repository)?);
    let worktree = Path::new(&worktree)
        .canonicalize()
        .map_err(|_| "Worktree folder no longer exists.".to_string())?;
    let listed = crate::git_reference(&repository, &["worktree", "list", "--porcelain"])
        .ok_or("Cannot inspect repository worktrees.")?;
    if (!allow_repository && worktree == repository)
        || (worktree != repository
            && !listed
                .lines()
                .filter_map(|line| line.strip_prefix("worktree "))
                .any(|path| {
                    Path::new(path)
                        .canonicalize()
                        .is_ok_and(|registered| registered == worktree)
                }))
    {
        return Err("This folder is not a worktree of the selected repository.".to_string());
    }
    let actual = crate::git_reference(&worktree, &["symbolic-ref", "--short", "HEAD"])
        .ok_or("Worktree has no active branch.".to_string())?;
    if actual != branch {
        return Err(format!(
            "Worktree branch changed to {actual}. Refresh the repository."
        ));
    }
    Ok(worktree)
}

#[tauri::command]
pub async fn pull_request_checks(
    repository: String,
    worktrees: Vec<WorktreeBranch>,
) -> Result<RepositoryChecks, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = crate::validate_repository(repository)?;
        let target = target_repository(Path::new(&repository))?;
        let response = gh_command(
            Path::new(&repository),
            &[
                "pr",
                "list",
                "--repo",
                &target,
                "--state",
                "open",
                "--limit",
                "500",
                "--json",
                "number,url,statusCheckRollup,headRepositoryOwner,headRefName",
            ],
        )?;
        let prs: Vec<serde_json::Value> = serde_json::from_str(&response)
            .map_err(|_| "GitHub CLI returned invalid pull request checks.".to_string())?;
        let mut checks = HashMap::new();
        let mut errors = HashMap::new();
        for entry in worktrees {
            let result = (|| {
                let worktree =
                    checked_worktree(repository.clone(), entry.path.clone(), &entry.branch, true)?;
                let remote = branch_remote(&worktree, &entry.branch)?;
                let source = source_repository(&worktree, &remote)?;
                let owner = source.split('/').next().unwrap_or_default();
                let Some(pr) = prs.iter().find(|pr| {
                    pr["headRefName"].as_str() == Some(&entry.branch)
                        && pr["headRepositoryOwner"]["login"]
                            .as_str()
                            .is_some_and(|login| login.eq_ignore_ascii_case(owner))
                }) else {
                    return Ok(None);
                };
                Ok(Some(parse_pull_request_checks(pr)?))
            })();
            match result {
                Ok(pr) => {
                    checks.insert(entry.path, pr);
                }
                Err(cause) => {
                    errors.insert(entry.path, cause);
                }
            }
        }
        Ok(RepositoryChecks { checks, errors })
    })
    .await
    .map_err(|error| error.to_string())?
}

fn branch_remote(worktree: &Path, branch: &str) -> Result<String, String> {
    let remote = run(
        worktree,
        "git",
        &["config", "--get", &format!("branch.{branch}.remote")],
    )?;
    if remote.status.success() {
        output_or_error(remote, "Cannot find branch remote")
    } else {
        Ok("origin".to_string())
    }
}

fn parse_pull_request_checks(pr: &serde_json::Value) -> Result<PullRequestChecks, String> {
    let number = pr["number"].as_u64().ok_or("Pull request has no number.")?;
    let url = pr["url"]
        .as_str()
        .ok_or("Pull request has no link.")?
        .to_string();
    let checks = pr["statusCheckRollup"]
        .as_array()
        .into_iter()
        .flatten()
        .map(|check| {
            let state = if check["__typename"] == "StatusContext" {
                check["state"].as_str().unwrap_or("PENDING")
            } else if check["status"] != "COMPLETED" {
                "PENDING"
            } else {
                check["conclusion"].as_str().unwrap_or("PENDING")
            };
            PullRequestCheck {
                name: check["name"]
                    .as_str()
                    .or_else(|| check["context"].as_str())
                    .unwrap_or("Unknown check")
                    .to_string(),
                state: state.to_string(),
                url: check["detailsUrl"]
                    .as_str()
                    .or_else(|| check["targetUrl"].as_str())
                    .unwrap_or("")
                    .to_string(),
                database_id: check["databaseId"].as_u64(),
                run_id: check["checkSuite"]["workflowRun"]["databaseId"]
                    .as_u64()
                    .or_else(|| check["checkSuite"]["workflowRun"]["runDatabaseId"].as_u64()),
                attempt: check["checkSuite"]["workflowRun"]["runAttempt"]
                    .as_u64()
                    .or_else(|| check["checkSuite"]["workflowRun"]["attempt"].as_u64()),
                status_context_id: check["id"].as_str().map(str::to_string),
                identity_uncertain: check["databaseId"].as_u64().is_none()
                    && check["checkSuite"]["workflowRun"]["databaseId"]
                        .as_u64()
                        .is_none()
                    && check["checkSuite"]["workflowRun"]["runDatabaseId"]
                        .as_u64()
                        .is_none()
                    && check["id"].as_str().is_none(),
            }
        })
        .collect();
    Ok(PullRequestChecks {
        number,
        url,
        checks,
    })
}

fn check_rollup_with_identities(
    worktree: &Path,
    target: &str,
    oid: &str,
) -> Result<serde_json::Value, String> {
    let (owner, name) = target
        .split_once('/')
        .ok_or("GitHub repository identity is invalid.")?;
    let query = r#"query($owner:String!,$name:String!,$oid:GitObjectID!,$after:String){repository(owner:$owner,name:$name){object(oid:$oid){... on Commit{statusCheckRollup{contexts(first:100,after:$after){nodes{__typename ... on CheckRun{databaseId name status conclusion detailsUrl checkSuite{workflowRun{databaseId runAttempt}}} ... on StatusContext{id context state targetUrl createdAt}} pageInfo{hasNextPage endCursor}}}}}}}"#;
    let owner_argument = format!("owner={owner}");
    let name_argument = format!("name={name}");
    let oid_argument = format!("oid={oid}");
    let query_argument = format!("query={query}");
    collect_check_rollup_pages(|cursor| {
        let cursor_argument = cursor.map(|value| format!("after={value}"));
        let mut arguments = vec![
            "api",
            "graphql",
            "-f",
            &owner_argument,
            "-f",
            &name_argument,
            "-f",
            &oid_argument,
            "-f",
            &query_argument,
        ];
        if let Some(argument) = &cursor_argument {
            arguments.extend(["-f", argument]);
        }
        let output = gh_command(worktree, &arguments)?;
        serde_json::from_str(&output).map_err(|error| error.to_string())
    })
}

fn collect_check_rollup_pages(
    mut fetch: impl FnMut(Option<&str>) -> Result<serde_json::Value, String>,
) -> Result<serde_json::Value, String> {
    let mut cursor: Option<String> = None;
    let mut checks = Vec::new();
    loop {
        let response = fetch(cursor.as_deref())?;
        let contexts = &response["data"]["repository"]["object"]["statusCheckRollup"]["contexts"];
        checks.extend(
            contexts["nodes"]
                .as_array()
                .cloned()
                .ok_or("GitHub GraphQL returned invalid check identities.")?,
        );
        match contexts["pageInfo"]["hasNextPage"].as_bool() {
            Some(false) => return Ok(serde_json::Value::Array(checks)),
            Some(true) => {}
            None => return Err("GitHub GraphQL returned invalid check pagination.".to_string()),
        }
        let next = contexts["pageInfo"]["endCursor"]
            .as_str()
            .filter(|next| Some(*next) != cursor.as_deref())
            .ok_or("GitHub GraphQL returned an incomplete check identity page.")?;
        cursor = Some(next.to_string());
    }
}

fn complete_check_rollup_or_original(
    original: &serde_json::Value,
    enrichment: Result<serde_json::Value, String>,
) -> serde_json::Value {
    enrichment.unwrap_or_else(|_| original["statusCheckRollup"].clone())
}

#[tauri::command]
pub async fn failed_check_log(
    repository: String,
    worktree: String,
    branch: String,
    url: String,
) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = checked_worktree(repository, worktree, &branch, false)?;
        let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid check link.")?;
        let parts = parsed
            .path_segments()
            .ok_or("Invalid check link.")?
            .collect::<Vec<_>>();
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("github.com")
            || parts.len() != 7
            || parts[2] != "actions"
            || parts[3] != "runs"
            || parts[5] != "job"
            || parts[4].parse::<u64>().is_err()
            || parts[6].parse::<u64>().is_err()
        {
            return Err("This check has no GitHub Actions job log. Open its link instead.".into());
        }
        let check_repo = format!("{}/{}", parts[0], parts[1]);
        let remote = branch_remote(&worktree, &branch)?;
        let source = source_repository(&worktree, &remote)?;
        let target = target_repository(&worktree)?;
        if !check_repo.eq_ignore_ascii_case(&source) && !check_repo.eq_ignore_ascii_case(&target) {
            return Err("Check log belongs to another repository.".to_string());
        }
        let log = gh_command(
            &worktree,
            &[
                "run",
                "view",
                parts[4],
                "--repo",
                &check_repo,
                "--job",
                parts[6],
                "--log",
            ],
        )?;
        let start = log
            .char_indices()
            .rev()
            .nth(99_999)
            .map_or(0, |(index, _)| index);
        Ok(log[start..].to_string())
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn create_pull_request(
    repository: String,
    worktree: String,
    branch: String,
    base: String,
    title: String,
    body: String,
    draft: bool,
) -> Result<PullRequest, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let worktree = checked_worktree(repository, worktree, &branch, false)?;
        let base = base.trim();
        let title = title.trim();
        if base.is_empty() || base.starts_with('-') || title.is_empty() {
            return Err("Enter a base branch and pull request title.".to_string());
        }
        let upstream = run(
            &worktree,
            "git",
            &[
                "rev-parse",
                "--abbrev-ref",
                "--symbolic-full-name",
                "@{upstream}",
            ],
        )?;
        let remote = if upstream.status.success() {
            output_or_error(
                run(
                    &worktree,
                    "git",
                    &["config", "--get", &format!("branch.{branch}.remote")],
                )?,
                "Cannot find upstream remote",
            )?
        } else {
            "origin".to_string()
        };
        if upstream.status.success() {
            output_or_error(run(&worktree, "git", &["push"])?, "Cannot push branch")?;
        } else {
            output_or_error(
                run(&worktree, "git", &["push", "-u", &remote, &branch])?,
                "Cannot push branch",
            )?;
        }
        let (target, head) = pull_request_repos(&worktree, &remote, &branch)?;
        let gh = gh_binary();
        let mut command = Command::new(&gh);
        command
            .current_dir(&worktree)
            .env("GH_PROMPT_DISABLED", "1")
            .env("GIT_TERMINAL_PROMPT", "0")
            .args([
                "pr", "create", "--repo", &target, "--base", base, "--head", &head, "--title",
                title, "--body", &body,
            ]);
        if draft {
            command.arg("--draft");
        }
        let output = output_or_error(
            command
                .output()
                .map_err(|error| format!("Cannot start GitHub CLI: {error}"))?,
            "Cannot create pull request",
        )?;
        let url = output.lines().last().unwrap_or_default();
        let parsed = tauri::Url::parse(url)
            .map_err(|_| "GitHub CLI returned an invalid pull request link.".to_string())?;
        let parts = parsed
            .path_segments()
            .ok_or("GitHub CLI returned an invalid pull request link.")?
            .collect::<Vec<_>>();
        let number = parts.get(3).and_then(|number| number.parse::<u64>().ok());
        if parsed.scheme() != "https"
            || parsed.host_str() != Some("github.com")
            || parts.len() != 4
            || parts[2] != "pull"
            || number.is_none_or(|number| number == 0)
        {
            return Err("GitHub CLI returned an invalid pull request link.".to_string());
        }
        Ok(PullRequest {
            number: number.unwrap_or_default(),
            url: url.to_string(),
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn open_pull_request(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid pull request link.")?;
    let parts = parsed
        .path_segments()
        .ok_or("Invalid pull request link.")?
        .collect::<Vec<_>>();
    if parsed.scheme() != "https"
        || parsed.host_str() != Some("github.com")
        || parsed.query().is_some()
        || parsed.fragment().is_some()
        || parts.len() != 4
        || parts[0].is_empty()
        || parts[1].is_empty()
        || parts[2] != "pull"
        || parts[3].parse::<u64>().is_err()
    {
        return Err("Invalid pull request link.".to_string());
    }
    open_url(url)
}

#[tauri::command]
pub fn open_check_url(url: String) -> Result<(), String> {
    let parsed = tauri::Url::parse(&url).map_err(|_| "Invalid check link.")?;
    if parsed.scheme() != "https" || parsed.host_str().is_none() {
        return Err("Invalid check link.".to_string());
    }
    open_url(url)
}

#[tauri::command]
pub fn open_external_url(url: String) -> Result<(), String> {
    open_url(validate_external_url(&url)?)
}

fn validate_external_url(url: &str) -> Result<String, String> {
    let parsed = tauri::Url::parse(url).map_err(|_| "Invalid external link.")?;
    match parsed.scheme() {
        "http" | "https" if parsed.host_str().is_some() => Ok(parsed.to_string()),
        "mailto" if !parsed.path().is_empty() => Ok(parsed.to_string()),
        _ => Err("Invalid external link.".to_string()),
    }
}

fn open_url(url: String) -> Result<(), String> {
    #[cfg(feature = "e2e")]
    if let Some(path) = std::env::var_os("SAIL_E2E_OPEN_URL_LOG") {
        return std::fs::write(path, url).map_err(|error| error.to_string());
    }
    #[cfg(target_os = "macos")]
    let mut command = Command::new("/usr/bin/open");
    #[cfg(target_os = "linux")]
    let mut command = Command::new("xdg-open");
    #[cfg(target_os = "windows")]
    let mut command = Command::new("explorer.exe");
    command
        .arg(url)
        .spawn()
        .map_err(|error| error.to_string())?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        acquisition_retry_claim, acquisition_retry_outcome, active_claim_winner, checked_worktree,
        claim_body, claim_from_comment, claim_lock_description, claim_lock_name, claim_lock_owner,
        claim_released, claim_revision_lock_owner, claim_server_expiry, claim_time_from_millis,
        claim_time_millis, command_output_with_timeout, command_output_with_timeouts,
        delete_observed_repository_lock_if_owned, delete_predecessor_stop_lock_if_owned,
        delete_verified_claim_fence, delete_verified_claim_fence_after_release,
        effectively_active_claim, eligible_claim_author, equivalent_pull_request_match,
        exact_heartbeat_marker, fence_matches_claim, finish_claim_transition, has_active_takeover,
        heartbeat_retry_claim, heartbeat_stored_claim, initial_claim_window, marked_issue, marker,
        matching_claim_release, merge_heartbeat_response, parse_claim, parse_claim_lock_owner,
        pending_claim_revision_lock_owner, posted_release_claim, predecessor_stop_lock_matches,
        predecessor_stop_lock_owner, pull_request_head, recent_equivalent_pull_request_cutoff,
        reconciled_active_revision, reconciled_claim_release, reconciled_heartbeat_revision,
        references_issue, reject_equivalent_work_after_claim, released_claim_marker,
        renewed_claim_window, rollback_unapplied_heartbeat_fence, select_claim_lock,
        shipping_claim_observation, shipping_claim_observation_with_current,
        shipping_pull_request_matches, shipping_pull_request_snapshot,
        submitted_heartbeat_still_current, transition_lock_owner, transition_lock_recoverable,
        collect_check_rollup_pages, complete_check_rollup_or_original, valid_claim_time,
        valid_stored_claim, validate_external_url, validate_graph, validated_claim_input,
        with_verified_claim_takeover, ClaimLock, IssueDraft, IssueGraphDraft,
        RepositoryLabelState, ShippingClaim, parse_pull_request_checks,
    };
    use std::{cell::Cell, collections::HashMap, fs, process::Command, time::Duration};

    #[cfg(unix)]
    #[test]
    fn github_commands_stop_after_their_deadline() {
        let mut command = Command::new("/bin/sh");
        command.args(["-c", "while :; do :; done"]);

        let error = command_output_with_timeout(&mut command, Duration::from_millis(10))
            .expect_err("hung command must time out");

        assert_eq!(error, "GitHub CLI timed out after 10 milliseconds.");
    }

    #[cfg(unix)]
    #[test]
    fn timed_out_github_wrapper_cannot_leave_a_mutating_descendant() {
        let marker = std::env::temp_dir().join(format!(
            "sail-gh-timeout-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        let mut command = Command::new("/bin/sh");
        command.env("SAIL_TIMEOUT_MARKER", &marker).args([
            "-c",
            "/bin/sh -c 'sleep 0.5; printf late > \"$SAIL_TIMEOUT_MARKER\"' & wait",
        ]);

        let error = command_output_with_timeout(&mut command, Duration::from_millis(100))
            .expect_err("wrapper and descendant must time out");
        std::thread::sleep(Duration::from_millis(600));
        let descendant_mutated = marker.exists();
        let _ = fs::remove_file(marker);

        assert_eq!(error, "GitHub CLI timed out after 100 milliseconds.");
        assert!(
            !descendant_mutated,
            "descendant survived its wrapper timeout"
        );
    }

    #[cfg(unix)]
    #[test]
    fn exited_github_wrapper_cannot_leave_a_pipe_holding_descendant() {
        let marker = std::env::temp_dir().join(format!(
            "sail-gh-reader-timeout-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        let mut command = Command::new("/bin/sh");
        command.env("SAIL_TIMEOUT_MARKER", &marker).args([
            "-c",
            "/bin/sh -c 'sleep 0.2; printf late > \"$SAIL_TIMEOUT_MARKER\"' & exit 0",
        ]);

        let error = command_output_with_timeouts(
            &mut command,
            Duration::from_secs(1),
            Duration::from_millis(20),
        )
        .expect_err("pipe-holding descendant must be terminated");
        std::thread::sleep(Duration::from_millis(250));
        let descendant_mutated = marker.exists();
        let _ = fs::remove_file(marker);

        assert_eq!(error, "GitHub CLI stdout reader did not stop.");
        assert!(!descendant_mutated, "descendant survived reader timeout");
    }

    #[cfg(windows)]
    #[test]
    fn timed_out_windows_wrapper_cannot_leave_a_mutating_descendant() {
        let marker = std::env::temp_dir().join(format!(
            "sail-gh-timeout-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        let marker_value = marker.to_string_lossy().into_owned();
        let mut command = Command::new("cmd.exe");
        command.env("SAIL_TIMEOUT_MARKER", &marker_value).args([
            "/C",
            "start \"\" /B cmd.exe /C \"ping 127.0.0.1 -n 2 >NUL & echo late>\"%SAIL_TIMEOUT_MARKER%\"\" & ping 127.0.0.1 -n 30 >NUL",
        ]);

        let error = command_output_with_timeout(&mut command, Duration::from_millis(100))
            .expect_err("wrapper and descendant must time out");
        std::thread::sleep(Duration::from_secs(2));
        let descendant_mutated = marker.exists();
        let _ = fs::remove_file(marker);

        assert_eq!(error, "GitHub CLI timed out after 100 milliseconds.");
        assert!(
            !descendant_mutated,
            "Windows descendant survived its wrapper timeout"
        );
    }

    #[cfg(windows)]
    #[test]
    fn exited_windows_wrapper_cannot_leave_a_pipe_holding_descendant() {
        let marker = std::env::temp_dir().join(format!(
            "sail-gh-reader-timeout-descendant-{}",
            uuid::Uuid::new_v4()
        ));
        let marker_value = marker.to_string_lossy().into_owned();
        let mut command = Command::new("cmd.exe");
        command.env("SAIL_TIMEOUT_MARKER", &marker_value).args([
            "/C",
            "start \"\" /B cmd.exe /C \"ping 127.0.0.1 -n 2 >NUL & echo late>\"%SAIL_TIMEOUT_MARKER%\"\" & exit /B 0",
        ]);

        command_output_with_timeouts(
            &mut command,
            Duration::from_secs(1),
            Duration::from_millis(20),
        )
        .expect_err("pipe-holding descendant must be terminated");
        std::thread::sleep(Duration::from_secs(2));
        let descendant_mutated = marker.exists();
        let _ = fs::remove_file(marker);

        assert!(
            !descendant_mutated,
            "Windows descendant survived reader timeout"
        );
    }

    #[cfg(windows)]
    #[test]
    fn windows_job_termination_failure_kills_the_direct_child() {
        let mut child = Command::new("cmd.exe")
            .args(["/C", "ping 127.0.0.1 -n 30 >NUL"])
            .spawn()
            .expect("spawn long-running child");
        let mut invalid_job = CommandTreeHandle(HANDLE::default());

        let error = terminate_command_tree(&mut child, &mut invalid_job)
            .expect_err("invalid job must fail termination");
        let stopped = child
            .wait_timeout(Duration::from_secs(2))
            .expect("wait for fallback kill")
            .is_some();

        assert!(error.contains("Cannot terminate GitHub CLI job object"));
        assert!(stopped, "fallback kill left the direct child running");
    }

    #[test]
    fn pull_request_head_qualifies_fork_branches() {
        assert_eq!(
            pull_request_head("fork-owner/repo", "upstream/repo", "feature"),
            "fork-owner:feature"
        );
        assert_eq!(
            pull_request_head("upstream/repo", "UPSTREAM/repo", "feature"),
            "feature"
        );
    }

    #[test]
    fn shipping_pull_request_rejects_wrong_base_or_repository() {
        let matching = serde_json::json!({
            "head": { "ref": "fix/issue", "repo": { "full_name": "fork/repo" } },
            "base": { "ref": "main", "repo": { "full_name": "upstream/repo" } }
        });
        assert!(shipping_pull_request_matches(
            &matching,
            "fork/repo",
            "upstream/repo",
            "fix/issue",
            "main"
        ));
        let mut wrong_base = matching.clone();
        wrong_base["base"]["ref"] = serde_json::json!("release");
        assert!(!shipping_pull_request_matches(
            &wrong_base,
            "fork/repo",
            "upstream/repo",
            "fix/issue",
            "main"
        ));
        assert!(!shipping_pull_request_matches(
            &serde_json::json!({
                "head": { "ref": "fix/issue", "repo": { "full_name": "fork/repo" } },
                "base": { "ref": "main", "repo": { "full_name": "other/repo" } }
            }),
            "fork/repo",
            "upstream/repo",
            "fix/issue",
            "main"
        ));
    }

    #[test]
    fn shipping_pull_request_rejects_checks_from_an_old_head() {
        let listed = serde_json::json!({
            "number": 17,
            "url": "https://github.com/upstream/repo/pull/17",
            "state": "OPEN",
            "mergedAt": null,
            "headRefOid": "head-a",
            "statusCheckRollup": [{
                "__typename": "CheckRun", "name": "build", "status": "COMPLETED",
                "conclusion": "SUCCESS", "detailsUrl": "https://example.com/build-a"
            }]
        });
        let mut details = serde_json::json!({
            "head": { "ref": "fix/issue", "repo": { "full_name": "fork/repo" }, "sha": "head-b" },
            "base": { "ref": "main", "repo": { "full_name": "upstream/repo" } }
        });

        let rejected = shipping_pull_request_snapshot(
            &listed,
            &details,
            "fork/repo",
            "upstream/repo",
            "fix/issue",
            "main",
        );
        assert_eq!(
            rejected.err().as_deref(),
            Some("Pull request head changed while loading checks. Refresh and retry.")
        );

        details["head"]["sha"] = serde_json::json!("head-a");
        let accepted = shipping_pull_request_snapshot(
            &listed,
            &details,
            "fork/repo",
            "upstream/repo",
            "fix/issue",
            "main",
        )
        .ok()
        .flatten()
        .unwrap();
        assert_eq!(accepted.head_ref_oid, "head-a");
        assert_eq!(accepted.checks[0].state, "SUCCESS");

        details["head"].as_object_mut().unwrap().remove("sha");
        assert!(shipping_pull_request_snapshot(
            &listed,
            &details,
            "fork/repo",
            "upstream/repo",
            "fix/issue",
            "main",
        )
        .is_err());
    }

    #[test]
    fn check_probe_accepts_repository_root_only_when_requested() {
        let root = std::env::temp_dir().join(format!("sail-root-check-{}", uuid::Uuid::new_v4()));
        fs::create_dir_all(&root).unwrap();
        let status = Command::new("git")
            .args(["-C", root.to_str().unwrap(), "init", "-q", "-b", "main"])
            .status()
            .unwrap();
        assert!(status.success());
        let path = root.canonicalize().unwrap().to_string_lossy().into_owned();

        assert!(checked_worktree(path.clone(), path.clone(), "main", true).is_ok());
        assert!(checked_worktree(path.clone(), path, "main", false).is_err());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_request_checks_preserve_stable_run_identity_and_attempt() {
        let pr = serde_json::json!({
            "number": 1,
            "url": "https://github.test/pull/1",
            "statusCheckRollup": [{
                "__typename": "CheckRun",
                "databaseId": 50,
                "name": "build",
                "status": "IN_PROGRESS",
                "conclusion": null,
                "detailsUrl": null,
                "checkSuite": { "workflowRun": { "databaseId": 10, "runAttempt": 2 } }
            }]
        });
        let parsed = parse_pull_request_checks(&pr).unwrap();
        let check = &parsed.checks[0];
        assert_eq!(check.url, "");
        assert_eq!(check.state, "PENDING");
        assert_eq!(check.database_id, Some(50));
        assert_eq!(check.run_id, Some(10));
        assert_eq!(check.attempt, Some(2));
        assert!(!check.identity_uncertain);
    }

    #[test]
    fn pull_request_checks_preserve_stable_status_context_identity() {
        let pr = serde_json::json!({
            "number": 1,
            "url": "https://github.test/pull/1",
            "statusCheckRollup": [{
                "__typename": "StatusContext",
                "id": "SC_kwDOStatusContext1",
                "context": "external/build",
                "state": "SUCCESS",
                "targetUrl": "https://ci.test/build/1",
                "createdAt": "2026-10-08T04:00:00Z"
            }]
        });

        let parsed = parse_pull_request_checks(&pr).unwrap();
        let check = &parsed.checks[0];
        assert_eq!(check.name, "external/build");
        assert_eq!(
            check.status_context_id.as_deref(),
            Some("SC_kwDOStatusContext1")
        );
        assert!(!check.identity_uncertain);
    }

    #[test]
    fn incomplete_second_check_page_keeps_the_complete_cli_fallback() {
        let mut calls = 0;
        let result = collect_check_rollup_pages(|cursor| {
            calls += 1;
            if cursor.is_some() {
                return Err("page two failed".to_string());
            }
            Ok(serde_json::json!({
                "data": { "repository": { "object": { "statusCheckRollup": {
                    "contexts": {
                        "nodes": (0..100).map(|index| serde_json::json!({"name": index})).collect::<Vec<_>>(),
                        "pageInfo": { "hasNextPage": true, "endCursor": "page-2" }
                    }
                } } } }
            }))
        });

        assert_eq!(calls, 2);
        assert_eq!(result.as_ref().unwrap_err(), "page two failed");
        let original = serde_json::json!({
            "statusCheckRollup": (0..101).map(|index| serde_json::json!({"name": index})).collect::<Vec<_>>()
        });
        let retained = complete_check_rollup_or_original(&original, result);
        assert_eq!(retained.as_array().unwrap().len(), 101);
    }

    #[test]
    fn markers_recover_only_the_matching_issue() {
        let first = marker("session", "first");
        let second = marker("session", "second");
        let issues = vec![
            serde_json::json!({"number": 1, "body": format!("Scope\n\n{first}")}),
            serde_json::json!({"number": 2, "body": format!("Scope\n\n{second}")}),
        ];
        assert_eq!(marked_issue(&issues, &first).unwrap().unwrap()["number"], 1);
        assert!(marked_issue(&issues, &marker("other", "first"))
            .unwrap()
            .is_none());
        let duplicates = vec![issues[0].clone(), issues[0].clone()];
        assert!(marked_issue(&duplicates, &first).is_err());
    }

    #[test]
    fn graph_rejects_cycles_and_duplicate_existing_issues() {
        let mut graph = IssueGraphDraft {
            umbrella_number: None,
            source: "test".into(),
            repository: None,
            replace_existing: false,
            title: "Umbrella".into(),
            body: String::new(),
            issues: vec![
                IssueDraft {
                    id: "a".into(),
                    number: Some(3),
                    repository: None,
                    title: "A".into(),
                    body: String::new(),
                    depends_on: vec![],
                },
                IssueDraft {
                    id: "b".into(),
                    number: Some(4),
                    repository: None,
                    title: "B".into(),
                    body: String::new(),
                    depends_on: vec!["a".into()],
                },
            ],
        };
        assert!(validate_graph(&graph).is_ok());
        graph.issues[0].depends_on.push("b".into());
        assert!(validate_graph(&graph).unwrap_err().contains("cycle"));
        graph.issues[0].depends_on.clear();
        graph.issues[1].depends_on = vec!["3".into()];
        graph.issues[0].depends_on = vec!["b".into()];
        assert!(validate_graph(&graph).unwrap_err().contains("cycle"));
        graph.issues[0].depends_on.clear();
        graph.issues[1].depends_on = vec!["a".into(), "3".into()];
        assert!(validate_graph(&graph).unwrap_err().contains("repeats"));
        graph.issues[1].depends_on.clear();
        graph.issues[1].number = Some(3);
        assert!(validate_graph(&graph).unwrap_err().contains("duplicate"));
    }

    #[test]
    fn graph_accepts_distinct_repositories_with_same_number() {
        let graph = IssueGraphDraft {
            repository: Some("owner/main".into()),
            umbrella_number: Some(7),
            source: "test".into(),
            replace_existing: true,
            title: "Umbrella".into(),
            body: String::new(),
            issues: vec![
                IssueDraft {
                    id: "local".into(),
                    number: Some(3),
                    repository: None,
                    title: "Local".into(),
                    body: String::new(),
                    depends_on: vec![],
                },
                IssueDraft {
                    id: "owner/other#3".into(),
                    number: Some(3),
                    repository: Some("owner/other".into()),
                    title: "Other".into(),
                    body: String::new(),
                    depends_on: vec!["local".into()],
                },
            ],
        };
        assert!(validate_graph(&graph).is_ok());
        assert_eq!(
            super::dependency_repository("owner/other#3", "owner/main").unwrap(),
            ("owner/other", 3)
        );
    }

    #[test]
    fn graph_qualifies_local_aliases_and_reserves_umbrella_marker() {
        let mut graph = IssueGraphDraft {
            repository: Some("owner/main".into()),
            umbrella_number: None,
            source: "test".into(),
            replace_existing: false,
            title: "Umbrella".into(),
            body: String::new(),
            issues: vec![
                IssueDraft {
                    id: "a".into(),
                    number: Some(3),
                    repository: None,
                    title: "A".into(),
                    body: String::new(),
                    depends_on: vec!["b".into()],
                },
                IssueDraft {
                    id: "b".into(),
                    number: Some(4),
                    repository: None,
                    title: "B".into(),
                    body: String::new(),
                    depends_on: vec!["owner/main#3".into()],
                },
            ],
        };
        assert!(validate_graph(&graph).unwrap_err().contains("cycle"));
        graph.issues[1].depends_on = vec!["Owner/Main#3".into()];
        assert!(validate_graph(&graph).unwrap_err().contains("cycle"));
        graph.issues[1].depends_on = vec!["Owner/Main#003".into()];
        assert!(validate_graph(&graph).unwrap_err().contains("cycle"));
        graph.issues[1].depends_on = vec!["003".into()];
        assert!(validate_graph(&graph).unwrap_err().contains("cycle"));
        graph.issues[0].depends_on.clear();
        graph.issues[1].depends_on = vec!["11".into(), "Owner/Main#11".into()];
        assert!(validate_graph(&graph).unwrap_err().contains("repeats"));
        graph.issues[1].depends_on = vec!["a".into(), "owner/main#3".into()];
        assert!(validate_graph(&graph).unwrap_err().contains("repeats"));
        graph.issues[1].depends_on.clear();
        graph.issues[1].id = "umbrella".into();
        assert!(validate_graph(&graph).unwrap_err().contains("reserved"));
    }

    #[test]
    fn external_links_use_browser_safe_schemes() {
        assert_eq!(
            validate_external_url("https://example.com/path").unwrap(),
            "https://example.com/path"
        );
        assert_eq!(
            validate_external_url("mailto:user@example.com").unwrap(),
            "mailto:user@example.com"
        );
        for url in [
            "javascript:alert(1)",
            "file:///etc/passwd",
            "data:text/html,bad",
            "//example.com",
            "http://",
            "mailto:",
        ] {
            assert!(validate_external_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn claim_comments_round_trip_every_lifecycle_field() {
        let claim = ShippingClaim {
            id: "claim-1".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail codex (run-1)".into(),
            task: "ship:run-1:issue-7".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:01:00.000Z".into(),
            expires_at: "2026-10-07T10:03:00.000Z".into(),
            status: "released".into(),
            released_at: Some("2026-10-07T10:02:00.000Z".into()),
            release_reason: Some("merged".into()),
            takeover_of: Some("expired-claim".into()),
            released_heartbeat_at: Some("2026-10-07T10:01:00.000Z".into()),
            released_expires_at: Some("2026-10-07T10:03:00.000Z".into()),
            released_comment_updated_at_millis: Some(
                claim_time_millis("2026-10-07T10:01:00.000Z").unwrap(),
            ),
            comment_id: 99,
            comment_created_at_millis: None,
            comment_updated_at_millis: None,
            eligible_author: false,
            comment_author: None,
        };

        let parsed = parse_claim(&claim_body(&claim).unwrap(), 99).unwrap();

        assert_eq!(parsed.id, claim.id);
        assert_eq!(parsed.holder, claim.holder);
        assert_eq!(parsed.task, claim.task);
        assert_eq!(parsed.acquired_at, claim.acquired_at);
        assert_eq!(parsed.heartbeat_at, claim.heartbeat_at);
        assert_eq!(parsed.expires_at, claim.expires_at);
        assert_eq!(parsed.status, "released");
        assert_eq!(parsed.released_at, claim.released_at);
        assert_eq!(parsed.release_reason, claim.release_reason);
        assert_eq!(parsed.takeover_of, claim.takeover_of);
        assert_eq!(parsed.released_heartbeat_at, claim.released_heartbeat_at);
        assert_eq!(parsed.released_expires_at, claim.released_expires_at);
        assert_eq!(
            parsed.released_comment_updated_at_millis,
            claim.released_comment_updated_at_millis
        );
        assert_eq!(parsed.comment_id, 99);
        assert!(validated_claim_input(&parsed).is_ok());
        let reversed = ShippingClaim {
            heartbeat_at: "2026-10-07T10:04:00.000Z".into(),
            ..parsed
        };
        assert!(validated_claim_input(&reversed).is_err());
    }

    #[test]
    fn pull_request_matching_uses_exact_issue_numbers() {
        assert!(references_issue("Closes #271", "owner/repo", 271));
        assert!(references_issue("Refs #271", "owner/repo", 271));
        assert!(references_issue("Fix issue #271", "owner/repo", 271));
        assert!(references_issue("Fix GitHub issue #271", "owner/repo", 271));
        assert!(!references_issue(
            "Fix typo found while debugging GitHub issue #271",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "References owner/repo#271",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "Closes owner/repo#271.",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "Closes OWNER/REPO#271.",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "Depends on owner/other#271",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "Closes https://github.com/owner/repo/issues/271",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "Closes https://github.com/owner/other/issues/271",
            "owner/repo",
            271
        ));
        assert!(!references_issue("Refs owner/other#271", "owner/repo", 271));
        assert!(!references_issue("Refs #2710", "owner/repo", 271));
        assert!(!references_issue("Refs ticket#271", "owner/repo", 271));
        assert!(!references_issue(
            "Closes https://github.com/owner/repo/issues/2710",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "Closes https://github.com/owner/repo/issues/271st",
            "owner/repo",
            271
        ));
        assert!(!references_issue("Closes #271abc", "owner/repo", 271));
        assert!(!references_issue("Closes #271-old", "owner/repo", 271));
        assert!(!references_issue("Closes ticket#271", "owner/repo", 271));
        assert!(!references_issue("Does not fix #271", "owner/repo", 271));
        assert!(!references_issue(
            "Does not fix issue #271",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "This doesn't fix #271",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "This does not currently fix #271",
            "owner/repo",
            271
        ));
        assert!(!references_issue("Blocked by #271", "owner/repo", 271));
        assert!(!references_issue("Closes #2710", "owner/repo", 271));
        assert!(!references_issue("Closes #1271", "owner/repo", 271));
        assert!(!references_issue("Unrelated 271", "owner/repo", 271));
        assert!(!references_issue(
            "Refs #271 is only an example; this PR addresses #42",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "> Refs #271\n\nThis PR addresses #42",
            "owner/repo",
            271
        ));
        assert!(!references_issue("`Refs #271`", "owner/repo", 271));
        assert!(!references_issue("\"Refs #271\"", "owner/repo", 271));
        assert!(!references_issue("'Refs #271'", "owner/repo", 271));
        assert!(references_issue(
            "Here's what fixes #271.",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "```markdown\nRefs #271\n```",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "~~~markdown\nFixes #271\n~~~",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "- ~~~text\n  Refs #271\n  ~~~\nRefs #42",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "1. ```markdown\n   Refs #271\n   ```",
            "owner/repo",
            271
        ));
        assert!(references_issue("\\` Refs #271", "owner/repo", 271));
        assert!(references_issue("\\` Refs #271 \\`", "owner/repo", 271));
        assert!(!references_issue(
            "````markdown\n```\nFixes #271\n````",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "```markdown\n- ```\nFixes #271\n```",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "<!-- Closes #271 -->\nThis PR addresses #42",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "    Closes #271\nThis PR addresses #42",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "Implements the new lease protocol.\n\nRefs #271",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "This change fixes #271.",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "- ```markdown\n    Refs #42\n    ```\nRefs #271",
            "owner/repo",
            271
        ));
        assert!(!references_issue(
            "- ```markdown\n    Refs #271\n    ```\nRefs #42",
            "owner/repo",
            271
        ));
        assert!(references_issue(
            "  - ~~~text\n    Refs #42\n    ~~~\nRefs #271",
            "owner/repo",
            271
        ));
    }

    #[test]
    fn equivalent_pull_request_discovers_title_only_exact_references() {
        let candidates = vec![
            serde_json::json!({"title": "Refs #2710", "body": "", "url": "wrong", "mergedAt": null}),
            serde_json::json!({"title": "Refs #271", "body": "Example: `Refs #271`", "url": "title", "mergedAt": null}),
        ];
        assert_eq!(
            equivalent_pull_request_match(candidates, "owner/repo", 271, "open", ""),
            Some("title".into())
        );
        assert_eq!(
            equivalent_pull_request_match(
                vec![
                    serde_json::json!({"title": "Fix issue #271", "body": "", "url": "fix-title", "mergedAt": null})
                ],
                "owner/repo",
                271,
                "open",
                ""
            ),
            Some("fix-title".into())
        );
        assert_eq!(
            equivalent_pull_request_match(
                vec![
                    serde_json::json!({"title": "Does not fix issue #271", "body": "", "url": "negated", "mergedAt": null})
                ],
                "owner/repo",
                271,
                "open",
                ""
            ),
            None
        );
        assert_eq!(
            equivalent_pull_request_match(
                vec![
                    serde_json::json!({"title": "Refs owner/other#271", "body": "`Refs #271`", "url": "wrong", "mergedAt": null})
                ],
                "owner/repo",
                271,
                "open",
                ""
            ),
            None
        );
    }

    #[test]
    fn merged_pull_request_cutoff_uses_github_time_despite_client_clock_skew() {
        let observed_at = claim_time_millis("2026-10-08T00:00:00.000Z").unwrap();
        let cutoff = recent_equivalent_pull_request_cutoff(observed_at).unwrap();
        let candidate = serde_json::json!({
            "title": "Fixes #271",
            "body": "",
            "url": "recent",
            "mergedAt": "2026-09-25T00:00:00.000Z"
        });

        assert_eq!(cutoff, "2026-09-24T00:00:00.000Z");
        assert_eq!(
            equivalent_pull_request_match(
                vec![candidate.clone()],
                "owner/repo",
                271,
                "merged",
                "2026-10-16T00:00:00.000Z",
            ),
            None
        );
        assert_eq!(
            equivalent_pull_request_match(vec![candidate], "owner/repo", 271, "merged", &cutoff),
            Some("recent".into())
        );
    }

    #[test]
    fn equivalent_work_appearing_during_acquisition_releases_provisional_claim() {
        let mut active = true;
        reject_equivalent_work_after_claim(Ok(None), || {
            active = false;
            Ok(())
        })
        .unwrap();
        assert!(active);

        let result = reject_equivalent_work_after_claim(
            Ok(Some(
                "Open pull request already covers issue #271: concurrent".to_string(),
            )),
            || {
                active = false;
                Ok(())
            },
        );

        assert!(result.is_err());
        assert!(!active);
    }

    #[test]
    fn pull_request_matching_ignores_commonmark_inline_code_spans() {
        let cases = [
            ("single backtick", "`Refs #271`", false),
            ("double backtick", "``Refs #271``", false),
            (
                "embedded triple backtick",
                "Example: ```Refs #271```.",
                false,
            ),
            (
                "long delimiter containing shorter run",
                "Example: ````Refs `#271` with ticks````.",
                false,
            ),
            (
                "closed span before reference",
                "``example`` Refs #271",
                true,
            ),
            ("unmatched delimiter", "``Refs #271", true),
            ("multiline span", "`example\nRefs #271\nmore`", false),
            (
                "multiline long delimiter",
                "````example `\nRefs #271\n` more````",
                false,
            ),
            (
                "shorter run does not close",
                "``example `\nRefs #271\n` more``",
                false,
            ),
            (
                "reference after multiline span",
                "`example\nRefs #271`\nRefs #271",
                true,
            ),
            (
                "unmatched span before a new paragraph",
                "`example\n\nRefs #271 and `another item",
                true,
            ),
            (
                "fence with a longer closer before real reference",
                "````markdown\nRefs #271\n`````\nRefs #271 and ````example````",
                true,
            ),
        ];

        for (name, body, expected) in cases {
            assert_eq!(
                references_issue(body, "owner/repo", 271),
                expected,
                "{name}"
            );
        }
    }

    #[test]
    fn malformed_claim_markers_are_ignored() {
        let malformed = r#"<!-- sail-claim:v1 {"id":"bad","holder":"x","task":"x","acquiredAt":"bad","heartbeatAt":"bad","expiresAt":"zzzz","status":"active","commentId":0} -->"#;
        let unknown_status = r#"<!-- sail-claim:v1 {"id":"bad","holder":"x","task":"x","acquiredAt":"2026-10-07T10:00:00.000Z","heartbeatAt":"2026-10-07T10:01:00.000Z","expiresAt":"2026-10-07T10:03:00.000Z","status":"paused","commentId":0} -->"#;

        assert!(parse_claim(malformed, 1).is_none());
        assert!(parse_claim(unknown_status, 2).is_none());
    }

    #[test]
    fn organization_members_can_publish_claims() {
        for association in ["OWNER", "MEMBER", "COLLABORATOR"] {
            assert!(eligible_claim_author(association), "{association}");
        }
        for association in [
            "CONTRIBUTOR",
            "FIRST_TIMER",
            "FIRST_TIME_CONTRIBUTOR",
            "NONE",
        ] {
            assert!(!eligible_claim_author(association), "{association}");
        }
    }

    #[test]
    fn claim_times_use_one_lexically_ordered_utc_format() {
        assert!(valid_claim_time("2026-10-07T10:03:00.000Z"));
        for invalid in [
            "2026-10-07T10:03:00Z",
            "2026-13-07T10:03:00.000Z",
            "2026-02-29T10:03:00.000Z",
            "2026-04-31T10:03:00.000Z",
            "2026-10-07T25:03:00.000Z",
            "not-a-time",
        ] {
            assert!(!valid_claim_time(invalid), "{invalid}");
        }
        assert!(valid_claim_time("2028-02-29T10:03:00.000Z"));
    }

    #[test]
    fn claims_reject_unbounded_leases_and_active_takeovers() {
        let claim = ShippingClaim {
            id: "claim-a".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail A".into(),
            task: "issue-271".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:01:00.000Z".into(),
            expires_at: "2026-10-07T10:07:00.001Z".into(),
            status: "active".into(),
            released_at: None,
            release_reason: None,
            takeover_of: None,
            released_heartbeat_at: None,
            released_expires_at: None,
            released_comment_updated_at_millis: None,
            comment_id: 1,
            comment_created_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
        };
        assert!(validated_claim_input(&claim).is_err());

        let takeover = ShippingClaim {
            id: "claim-b".into(),
            acquired_at: "2026-10-07T10:02:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:02:00.000Z".into(),
            expires_at: "2026-10-07T10:04:00.000Z".into(),
            takeover_of: Some(claim.id.clone()),
            comment_id: 2,
            comment_created_at_millis: Some(claim_time_millis("2026-10-07T10:02:00.000Z").unwrap()),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:02:00.000Z").unwrap()),
            eligible_author: true,
            comment_author: Some("sail-b".into()),
            ..claim.clone()
        };
        assert!(!has_active_takeover(
            std::slice::from_ref(&takeover),
            &claim,
            claim_time_millis("2026-10-07T10:03:00.000Z").unwrap()
        ));
        let valid_takeover = ShippingClaim {
            acquired_at: "2026-10-07T10:07:01.000Z".into(),
            heartbeat_at: "2026-10-07T10:07:01.000Z".into(),
            expires_at: "2026-10-07T10:10:00.000Z".into(),
            comment_created_at_millis: Some(claim_time_millis("2026-10-07T10:07:01.000Z").unwrap()),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:07:01.000Z").unwrap()),
            ..takeover
        };
        assert!(has_active_takeover(
            std::slice::from_ref(&valid_takeover),
            &claim,
            claim_time_millis("2026-10-07T10:08:00.000Z").unwrap()
        ));
        assert!(!has_active_takeover(
            std::slice::from_ref(&valid_takeover),
            &claim,
            claim_time_millis("2026-10-07T10:10:00.000Z").unwrap()
        ));
        let forged_release = ShippingClaim {
            status: "released".into(),
            released_at: Some("2026-10-07T10:03:00.000Z".into()),
            release_reason: Some("forged".into()),
            released_heartbeat_at: Some(claim.heartbeat_at.clone()),
            released_expires_at: Some(claim.expires_at.clone()),
            released_comment_updated_at_millis: claim.comment_updated_at_millis,
            comment_author: Some("other-user".into()),
            ..claim.clone()
        };
        assert!(!claim_released(
            std::slice::from_ref(&forged_release),
            &claim
        ));
        let genuine_release = ShippingClaim {
            comment_author: claim.comment_author.clone(),
            ..forged_release
        };
        assert!(claim_released(
            std::slice::from_ref(&genuine_release),
            &claim
        ));
        let claims = vec![claim, valid_takeover];
        let after_original_expiry = claim_time_millis("2026-10-07T10:08:00.000Z").unwrap();
        assert!(!effectively_active_claim(
            &claims,
            &claims[0],
            after_original_expiry
        ));
        assert!(effectively_active_claim(
            &claims,
            &claims[1],
            after_original_expiry
        ));
    }

    #[test]
    fn acquisition_preflight_uses_server_observed_time() {
        let server_updated = claim_time_millis("2026-10-07T10:00:00.000Z").unwrap();
        let claim = ShippingClaim {
            id: "claim-a".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail A".into(),
            task: "issue-271".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:00:00.000Z".into(),
            expires_at: "2026-10-07T10:02:00.000Z".into(),
            status: "active".into(),
            released_at: None,
            release_reason: None,
            takeover_of: None,
            released_heartbeat_at: None,
            released_expires_at: None,
            released_comment_updated_at_millis: None,
            comment_id: 1,
            comment_created_at_millis: Some(server_updated),
            comment_updated_at_millis: Some(server_updated),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
        };
        let claims = vec![claim];
        let fast_client_time = claim_time_millis("2026-10-07T10:03:00.000Z").unwrap();
        let observed_at = server_updated;

        assert_eq!(
            active_claim_winner(&claims, observed_at).map(|claim| claim.id.as_str()),
            Some("claim-a")
        );
        assert!(active_claim_winner(&claims, fast_client_time).is_none());
    }

    #[test]
    fn matching_release_requires_eligible_author_and_exact_identity() {
        let original = ShippingClaim {
            id: "claim-a".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail A".into(),
            task: "issue-271".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:01:00.000Z".into(),
            expires_at: "2026-10-07T10:03:00.000Z".into(),
            status: "active".into(),
            released_at: None,
            release_reason: None,
            takeover_of: None,
            released_heartbeat_at: None,
            released_expires_at: None,
            released_comment_updated_at_millis: None,
            comment_id: 1,
            comment_created_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:01:00.000Z").unwrap()),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
        };
        let released = ShippingClaim {
            status: "released".into(),
            released_at: Some("2026-10-07T10:02:00.000Z".into()),
            release_reason: Some("failed".into()),
            released_heartbeat_at: Some(original.heartbeat_at.clone()),
            released_expires_at: Some(original.expires_at.clone()),
            released_comment_updated_at_millis: original.comment_updated_at_millis,
            comment_id: 2,
            ..original.clone()
        };
        let ineligible = ShippingClaim {
            eligible_author: false,
            ..released.clone()
        };
        let wrong_author = ShippingClaim {
            comment_author: Some("other-user".into()),
            ..released.clone()
        };
        let wrong_instance = ShippingClaim {
            instance_id: Some("instance-b".into()),
            ..released.clone()
        };

        assert!(matching_claim_release(
            &[ineligible, wrong_author, wrong_instance],
            &original,
            "sail-a"
        )
        .is_none());
        assert_eq!(
            matching_claim_release(std::slice::from_ref(&released), &original, "sail-a")
                .map(|claim| claim.comment_id),
            Some(2)
        );
        let changed_release = ShippingClaim {
            released_at: Some("2026-10-07T10:02:30.000Z".into()),
            release_reason: Some("retry after response loss".into()),
            ..released
        };
        let submitted = ShippingClaim {
            comment_created_at_millis: None,
            eligible_author: false,
            comment_author: None,
            ..original.clone()
        };
        assert_eq!(
            reconciled_claim_release(
                &[original.clone(), changed_release.clone()],
                &submitted,
                "sail-a",
                claim_time_millis("2026-10-07T10:02:30.000Z").unwrap(),
            )
            .unwrap()
            .1
            .map(|claim| claim.comment_id),
            Some(2)
        );
        assert!(reconciled_claim_release(
            &[ShippingClaim {
                eligible_author: false,
                ..original.clone()
            }],
            &original,
            "sail-a",
            claim_time_millis("2026-10-07T10:02:30.000Z").unwrap(),
        )
        .is_err());
        assert!(reconciled_claim_release(
            std::slice::from_ref(&original),
            &original,
            "other-user",
            claim_time_millis("2026-10-07T10:02:30.000Z").unwrap(),
        )
        .is_err());
        assert!(reconciled_claim_release(
            &[ShippingClaim {
                instance_id: Some("instance-b".into()),
                ..original.clone()
            }],
            &original,
            "sail-a",
            claim_time_millis("2026-10-07T10:02:30.000Z").unwrap(),
        )
        .is_err());
        let renewed = ShippingClaim {
            heartbeat_at: "2026-10-07T10:02:00.000Z".into(),
            expires_at: "2026-10-07T10:04:00.000Z".into(),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:02:00.000Z").unwrap()),
            ..original.clone()
        };
        assert!(!claim_released(
            std::slice::from_ref(&changed_release),
            &renewed
        ));
        assert!(reconciled_claim_release(
            &[renewed.clone(), changed_release.clone()],
            &submitted,
            "sail-a",
            claim_time_millis("2026-10-07T10:03:00.000Z").unwrap(),
        )
        .is_err());
        assert!(reconciled_claim_release(
            std::slice::from_ref(&renewed),
            &submitted,
            "sail-a",
            claim_time_millis("2026-10-07T10:03:59.999Z").unwrap(),
        )
        .is_err());
        let (reconciled, release) = reconciled_claim_release(
            std::slice::from_ref(&renewed),
            &submitted,
            "sail-a",
            claim_time_millis("2026-10-07T10:04:00.000Z").unwrap(),
        )
        .unwrap();
        assert_eq!(reconciled.heartbeat_at, renewed.heartbeat_at);
        assert!(release.is_none());
        assert!(matching_claim_release(
            std::slice::from_ref(&ShippingClaim {
                holder: "Sail B".into(),
                ..changed_release
            }),
            &original,
            "sail-a",
        )
        .is_none());
        let renewed_release = ShippingClaim {
            status: "released".into(),
            released_at: Some("2026-10-07T10:03:00.000Z".into()),
            release_reason: Some("heartbeat time verification failed".into()),
            released_heartbeat_at: Some(renewed.heartbeat_at.clone()),
            released_expires_at: Some(renewed.expires_at.clone()),
            released_comment_updated_at_millis: renewed.comment_updated_at_millis,
            comment_id: 3,
            ..renewed.clone()
        };
        assert_eq!(
            reconciled_claim_release(
                &[renewed, renewed_release.clone()],
                &submitted,
                "sail-a",
                claim_time_millis("2026-10-07T10:05:00.000Z").unwrap(),
            )
            .unwrap()
            .1
            .map(|claim| claim.comment_id),
            Some(3)
        );
    }

    #[test]
    fn release_marker_from_failed_patch_cannot_release_renewed_claim_or_fence() {
        let (_, original, revision) = heartbeat_response_loss_fixture();
        let stale_release = ShippingClaim {
            comment_id: 2,
            eligible_author: true,
            comment_author: Some("sail-a".into()),
            ..released_claim_marker(&original, revision, "completed").unwrap()
        };
        let submitted = original.clone();
        let renewed = ShippingClaim {
            heartbeat_at: "2026-10-07T10:05:00.001Z".into(),
            expires_at: "2026-10-07T10:07:00.001Z".into(),
            comment_updated_at_millis: Some(revision + 1_000),
            ..original
        };
        let comments = vec![renewed.clone(), stale_release];
        let fence = ClaimLock {
            name: "claim-fence".into(),
            owner: Some(claim_revision_lock_owner(&renewed).unwrap()),
            node_id: Some("renewed-node".into()),
        };
        let deleted = Cell::new(false);

        for observed_at in [
            revision + 2_000,
            claim_time_millis(&renewed.expires_at).unwrap(),
        ] {
            assert!(
                reconciled_claim_release(&comments, &submitted, "sail-a", observed_at).is_err()
            );
        }
        assert!(
            delete_verified_claim_fence_after_release(&fence, &submitted, |_| {
                deleted.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!deleted.get());
    }

    #[test]
    fn claim_retries_require_the_authenticated_immutable_identity() {
        let existing = ShippingClaim {
            id: "stable-id".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail A".into(),
            task: "issue-271".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:00:00.000Z".into(),
            expires_at: "2026-10-07T10:02:00.000Z".into(),
            status: "active".into(),
            released_at: None,
            release_reason: None,
            takeover_of: None,
            released_heartbeat_at: None,
            released_expires_at: None,
            released_comment_updated_at_millis: None,
            comment_id: 7,
            comment_created_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
        };
        let requested = ShippingClaim {
            comment_id: 0,
            comment_created_at_millis: None,
            comment_updated_at_millis: None,
            eligible_author: false,
            comment_author: None,
            ..existing.clone()
        };

        assert_eq!(
            acquisition_retry_claim(std::slice::from_ref(&existing), &requested, "sail-a")
                .unwrap()
                .map(|claim| claim.comment_id),
            Some(7)
        );
        assert!(
            acquisition_retry_claim(std::slice::from_ref(&existing), &requested, "other-user")
                .is_err()
        );
        assert!(acquisition_retry_claim(
            std::slice::from_ref(&existing),
            &ShippingClaim {
                holder: "Sail B".into(),
                ..requested
            },
            "sail-a"
        )
        .is_err());

        let competing = ShippingClaim {
            id: "other-claim".into(),
            holder: "Sail B".into(),
            task: "issue-271".into(),
            comment_id: 2,
            comment_author: Some("sail-b".into()),
            ..existing.clone()
        };
        let claims = vec![existing.clone(), competing];
        let (ours, winner) = acquisition_retry_outcome(
            &claims,
            &ShippingClaim {
                comment_id: 0,
                comment_created_at_millis: None,
                comment_updated_at_millis: None,
                eligible_author: false,
                comment_author: None,
                ..existing.clone()
            },
            "sail-a",
            claim_time_millis("2026-10-07T10:01:00.000Z").unwrap(),
        )
        .unwrap()
        .unwrap();
        assert_eq!(ours.id, "stable-id");
        assert_eq!(winner.unwrap().id, "other-claim");
        let released = released_claim_marker(
            ours,
            claim_time_millis("2026-10-07T10:01:00.000Z").unwrap(),
            "lost acquisition reconciliation",
        )
        .unwrap();
        assert_eq!(released.id, "stable-id");
        assert_eq!(released.comment_id, 7);
    }

    #[test]
    fn heartbeat_rejects_replay_stale_state_and_expiry() {
        let updated = claim_time_millis("2026-10-07T10:01:00.000Z").unwrap();
        let stored = ShippingClaim {
            id: "claim-a".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail A".into(),
            task: "issue-271".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:01:00.000Z".into(),
            expires_at: "2026-10-07T10:03:00.000Z".into(),
            status: "active".into(),
            released_at: None,
            release_reason: None,
            takeover_of: None,
            released_heartbeat_at: None,
            released_expires_at: None,
            released_comment_updated_at_millis: None,
            comment_id: 7,
            comment_created_at_millis: Some(updated - 60_000),
            comment_updated_at_millis: Some(updated),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
        };

        assert!(heartbeat_stored_claim(std::slice::from_ref(&stored), &stored, "sail-a").is_ok());
        assert!(
            heartbeat_stored_claim(std::slice::from_ref(&stored), &stored, "other-user").is_err()
        );
        assert!(heartbeat_stored_claim(
            std::slice::from_ref(&stored),
            &ShippingClaim {
                heartbeat_at: "2026-10-07T10:00:30.000Z".into(),
                ..stored.clone()
            },
            "sail-a"
        )
        .is_err());
        assert!(heartbeat_stored_claim(
            std::slice::from_ref(&stored),
            &ShippingClaim {
                comment_updated_at_millis: None,
                ..stored.clone()
            },
            "sail-a"
        )
        .is_ok());
        assert!(heartbeat_stored_claim(
            std::slice::from_ref(&stored),
            &ShippingClaim {
                holder: "Sail B".into(),
                comment_updated_at_millis: None,
                ..stored.clone()
            },
            "sail-a"
        )
        .is_err());
        assert!(heartbeat_stored_claim(
            std::slice::from_ref(&stored),
            &ShippingClaim {
                comment_updated_at_millis: Some(updated - 1),
                ..stored.clone()
            },
            "sail-a"
        )
        .is_err());
        let stale_local_copy = ShippingClaim {
            heartbeat_at: "2026-10-07T10:00:30.000Z".into(),
            expires_at: "2026-10-07T10:02:30.000Z".into(),
            comment_updated_at_millis: Some(updated - 1),
            ..stored.clone()
        };
        assert_eq!(
            heartbeat_retry_claim(
                std::slice::from_ref(&stored),
                &stale_local_copy,
                "sail-a",
                "instance-a",
            )
            .unwrap()
            .comment_updated_at_millis,
            Some(updated)
        );
        assert!(heartbeat_retry_claim(
            std::slice::from_ref(&stored),
            &ShippingClaim {
                holder: "Sail B".into(),
                ..stale_local_copy.clone()
            },
            "sail-a",
            "instance-a",
        )
        .is_err());
        assert!(heartbeat_retry_claim(
            std::slice::from_ref(&stored),
            &stale_local_copy,
            "sail-a",
            "instance-b",
        )
        .is_err());
        assert_eq!(claim_server_expiry(&stored), Some(updated + 120_000));
        assert!(active_claim_winner(&[stored], updated + 120_000).is_none());
    }

    #[test]
    fn delayed_initial_post_cannot_extend_advertised_expiry() {
        let (_, renewed, _) = heartbeat_response_loss_fixture();
        let initial = ShippingClaim {
            heartbeat_at: renewed.acquired_at.clone(),
            expires_at: "2026-10-07T10:02:00.000Z".into(),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:00:30.000Z").unwrap()),
            ..renewed
        };
        let advertised = claim_time_millis(&initial.expires_at).unwrap();
        assert_eq!(claim_server_expiry(&initial), Some(advertised));
        assert!(effectively_active_claim(
            std::slice::from_ref(&initial),
            &initial,
            advertised - 1
        ));
        assert!(!effectively_active_claim(
            std::slice::from_ref(&initial),
            &initial,
            advertised
        ));
    }

    #[test]
    fn initial_claim_window_uses_server_time_when_client_is_over_one_lease_behind() {
        let client_heartbeat = claim_time_millis("2026-10-07T09:57:00.000Z").unwrap();
        let server_time = claim_time_millis("2026-10-07T10:00:00.000Z").unwrap();
        let claim = ShippingClaim {
            acquired_at: claim_time_from_millis(client_heartbeat).unwrap(),
            heartbeat_at: claim_time_from_millis(client_heartbeat).unwrap(),
            expires_at: claim_time_from_millis(client_heartbeat + 120_000).unwrap(),
            ..heartbeat_response_loss_fixture().1
        };

        let (heartbeat_at, expires_at) = initial_claim_window(&claim, server_time).unwrap();
        let stored = ShippingClaim {
            heartbeat_at,
            expires_at,
            comment_updated_at_millis: Some(server_time),
            ..claim
        };

        assert_eq!(claim_server_expiry(&stored), Some(server_time + 120_000));
        assert_eq!(
            active_claim_winner(std::slice::from_ref(&stored), server_time)
                .map(|winner| winner.id.as_str()),
            Some(stored.id.as_str())
        );
    }

    #[test]
    fn heartbeat_window_survives_local_clock_rollback_and_verifies_exactly() {
        let stored = ShippingClaim {
            id: "claim-a".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail A".into(),
            task: "issue-271".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:05:00.000Z".into(),
            expires_at: "2026-10-07T10:07:00.000Z".into(),
            status: "active".into(),
            released_at: None,
            release_reason: None,
            takeover_of: None,
            released_heartbeat_at: None,
            released_expires_at: None,
            released_comment_updated_at_millis: None,
            comment_id: 7,
            comment_created_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
        };
        let observed = claim_time_millis("2026-10-07T10:01:00.000Z").unwrap();
        let (heartbeat, expiry) = renewed_claim_window(&stored, observed, 120_000).unwrap();
        let submitted = ShippingClaim {
            heartbeat_at: heartbeat,
            expires_at: expiry,
            ..stored.clone()
        };

        assert_eq!(submitted.heartbeat_at, "2026-10-07T10:05:00.001Z");
        assert_eq!(submitted.expires_at, "2026-10-07T10:07:00.001Z");
        assert!(exact_heartbeat_marker(
            &submitted,
            &submitted,
            "sail-a",
            stored.comment_updated_at_millis.unwrap()
        ));
        assert!(!exact_heartbeat_marker(
            &ShippingClaim {
                expires_at: "2026-10-07T10:07:00.002Z".into(),
                ..submitted.clone()
            },
            &submitted,
            "sail-a",
            stored.comment_updated_at_millis.unwrap()
        ));
        let newer = ShippingClaim {
            heartbeat_at: "2026-10-07T10:05:30.000Z".into(),
            expires_at: "2026-10-07T10:07:30.000Z".into(),
            comment_updated_at_millis: Some(stored.comment_updated_at_millis.unwrap() + 30_000),
            ..submitted.clone()
        };
        assert!(!submitted_heartbeat_still_current(
            &[newer],
            &submitted,
            "sail-a",
            stored.comment_updated_at_millis.unwrap()
        ));
    }

    fn heartbeat_response_loss_fixture() -> (ShippingClaim, ShippingClaim, i64) {
        let revision = claim_time_millis("2026-10-07T10:05:00.000Z").unwrap();
        let submitted = ShippingClaim {
            id: "claim-a".into(),
            instance_id: Some("instance-a".into()),
            holder: "Sail A".into(),
            task: "issue-271".into(),
            acquired_at: "2026-10-07T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-07T10:05:00.000Z".into(),
            expires_at: "2026-10-07T10:07:00.000Z".into(),
            status: "active".into(),
            released_at: None,
            release_reason: None,
            takeover_of: None,
            released_heartbeat_at: None,
            released_expires_at: None,
            released_comment_updated_at_millis: None,
            comment_id: 7,
            comment_created_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            comment_updated_at_millis: Some(revision - 60_000),
            eligible_author: false,
            comment_author: None,
        };
        let applied = ShippingClaim {
            comment_updated_at_millis: Some(revision),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
            ..submitted.clone()
        };
        (submitted, applied, revision)
    }

    #[test]
    fn heartbeat_response_loss_accepts_the_applied_patch() {
        let (submitted, applied, revision) = heartbeat_response_loss_fixture();

        assert_eq!(
            reconciled_heartbeat_revision(std::slice::from_ref(&applied), &submitted, "sail-a"),
            Some(revision)
        );
    }

    #[test]
    fn foreign_claim_observation_uses_server_expiry_before_worker_takeover() {
        let (_, active, _) = heartbeat_response_loss_fixture();
        let before_expiry = claim_time_millis("2026-10-07T10:06:59.999Z").unwrap();
        let at_expiry = claim_time_millis("2026-10-07T10:07:00.000Z").unwrap();

        let observed = shipping_claim_observation(
            std::slice::from_ref(&active),
            &active,
            "sail-a",
            before_expiry,
        )
        .unwrap();
        let expired =
            shipping_claim_observation(std::slice::from_ref(&active), &active, "sail-a", at_expiry)
                .unwrap();

        assert!(observed.active);
        assert!(!expired.active);
    }

    #[test]
    fn renewal_between_claim_list_and_server_time_prevents_worker_fencing() {
        let (_, stale, _) = heartbeat_response_loss_fixture();
        let observed_at = claim_time_millis("2026-10-07T10:07:00.000Z").unwrap();
        let renewed = ShippingClaim {
            heartbeat_at: "2026-10-07T10:06:30.000Z".into(),
            expires_at: "2026-10-07T10:08:30.000Z".into(),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:06:30.000Z").unwrap()),
            ..stale.clone()
        };

        let stale_observation =
            shipping_claim_observation(std::slice::from_ref(&stale), &stale, "sail-a", observed_at)
                .unwrap();
        let verified = shipping_claim_observation_with_current(
            std::slice::from_ref(&stale),
            &stale,
            "sail-a",
            observed_at,
            renewed.clone(),
        )
        .unwrap();

        assert!(!stale_observation.active);
        assert!(verified.active);
        assert_eq!(verified.claim.heartbeat_at, renewed.heartbeat_at);
        assert_eq!(verified.claim.expires_at, renewed.expires_at);
    }

    #[test]
    fn stale_reloaded_claim_releases_the_applied_heartbeat_after_expiry() {
        let (submitted, applied, _) = heartbeat_response_loss_fixture();
        let expiry = claim_server_expiry(&applied).unwrap();

        assert!(reconciled_claim_release(
            std::slice::from_ref(&applied),
            &submitted,
            "sail-a",
            expiry - 1,
        )
        .is_err());
        let (reconciled, release) =
            reconciled_claim_release(std::slice::from_ref(&applied), &submitted, "sail-a", expiry)
                .unwrap();
        assert_eq!(
            reconciled.comment_updated_at_millis,
            applied.comment_updated_at_millis
        );
        assert!(release.is_none());

        let mut released = released_claim_marker(reconciled, expiry, "claim lost").unwrap();
        released.comment_id = 8;
        let claims_after_reload = [applied, released.clone()];
        assert_eq!(
            reconciled_claim_release(&claims_after_reload, &submitted, "sail-a", expiry)
                .unwrap()
                .1
                .map(|claim| claim.comment_id),
            Some(released.comment_id)
        );
    }

    #[test]
    fn internal_claim_locks_avoid_and_survive_repository_label_collisions() {
        let target = "owner/repo";
        let scope = "claim:271";
        let primary = claim_lock_name(target, scope, 0);
        assert_ne!(primary, "sail-claim-271");

        let mut labels = HashMap::from([(primary, RepositoryLabelState::Unmanaged)]);
        let fallback = select_claim_lock(target, scope, &labels).unwrap();
        assert_eq!(fallback.name, claim_lock_name(target, scope, 1));
        assert!(fallback.owner.is_none());

        let owner = claim_lock_owner("claim-a");
        labels.insert(
            fallback.name.clone(),
            RepositoryLabelState::Managed {
                owner: owner.clone(),
                node_id: "label-a".into(),
            },
        );
        let observed = select_claim_lock(target, scope, &labels).unwrap();
        assert_eq!(observed.name, fallback.name);
        assert_eq!(observed.owner, Some(owner));
        assert_eq!(observed.node_id.as_deref(), Some("label-a"));
    }

    #[test]
    fn stale_recoverer_cannot_delete_replacement_lock_by_node_id() {
        let target = "owner/repo";
        let scope = "claim:271:transition:7";
        let name = claim_lock_name(target, scope, 0);
        let expired = transition_lock_owner("claim-a", "expired", 0);
        let labels = HashMap::from([(
            name.clone(),
            RepositoryLabelState::Managed {
                owner: expired.clone(),
                node_id: "label-expired".into(),
            },
        )]);
        let observed_by_a = select_claim_lock(target, scope, &labels).unwrap();
        let observed_by_b = select_claim_lock(target, scope, &labels).unwrap();
        let owner_a = transition_lock_owner("claim-a", "operation-a", 1_000);
        let mut repository =
            HashMap::from([(name.clone(), ("label-expired".to_string(), expired.clone()))]);

        delete_observed_repository_lock_if_owned(&observed_by_a, &expired, |deleted| {
            repository.retain(|_, (node_id, _)| node_id != deleted);
            Ok(())
        })
        .unwrap();
        repository.insert(name.clone(), ("label-a".to_string(), owner_a));
        delete_observed_repository_lock_if_owned(&observed_by_b, &expired, |deleted| {
            repository.retain(|_, (node_id, _)| node_id != deleted);
            Ok(())
        })
        .unwrap();
        let second_create_won = !repository.contains_key(&name);

        assert_eq!(observed_by_a.node_id.as_deref(), Some("label-expired"));
        assert_eq!(observed_by_b.node_id.as_deref(), Some("label-expired"));
        assert_eq!(
            repository.get(&name).map(|(node_id, _)| node_id.as_str()),
            Some("label-a")
        );
        assert!(
            !second_create_won,
            "the second create sees the replacement name occupied"
        );
    }

    #[test]
    fn claim_lock_metadata_is_typed_and_operation_specific() {
        let main = claim_lock_owner("claim-a");
        assert_eq!(
            parse_claim_lock_owner(&claim_lock_description(&main)),
            Some(main)
        );
        assert!(parse_claim_lock_owner("").is_none());
        assert!(parse_claim_lock_owner("unrelated description").is_none());

        let first = transition_lock_owner("claim-a", "operation-a", 1_000);
        let second = transition_lock_owner("claim-a", "operation-b", 1_000);
        assert_ne!(first, second);
        assert!(claim_lock_description(&first).len() <= 100);
        assert_eq!(
            parse_claim_lock_owner(&claim_lock_description(&first)),
            Some(first)
        );
    }

    #[test]
    fn transition_cleanup_runs_on_success_and_failure() {
        for result in [Ok(()), Err("operation failed".to_string())] {
            let cleaned = Cell::new(false);
            let expected_success = result.is_ok();
            let outcome = finish_claim_transition(result, || {
                cleaned.set(true);
                Ok(())
            });
            assert!(cleaned.get());
            assert_eq!(outcome.is_ok(), expected_success);
        }

        let error = finish_claim_transition::<()>(Err("operation failed".into()), || {
            Err("delete failed".into())
        })
        .unwrap_err();
        assert!(error.contains("operation failed"));
        assert!(error.contains("delete failed"));
    }

    #[test]
    fn stale_transition_is_recoverable_but_live_operation_is_not() {
        let (_, active, observed_at) = heartbeat_response_loss_fixture();
        let owner = transition_lock_owner(&active.id, "operation-a", observed_at);
        assert!(!transition_lock_recoverable(
            &owner,
            std::slice::from_ref(&active),
            observed_at
        ));
        assert!(!transition_lock_recoverable(
            &owner,
            std::slice::from_ref(&active),
            claim_server_expiry(&active).unwrap()
        ));
        assert!(transition_lock_recoverable(
            &owner,
            std::slice::from_ref(&active),
            owner.expires_at.unwrap()
        ));

        let mut released = released_claim_marker(&active, observed_at, "failed takeover").unwrap();
        released.comment_id += 1;
        assert!(transition_lock_recoverable(
            &owner,
            &[active, released],
            observed_at
        ));
    }

    #[test]
    fn predecessor_stop_fence_blocks_takeover_until_worker_fencing_times_out() {
        let (_, expired, observed_at) = heartbeat_response_loss_fixture();
        let owner = predecessor_stop_lock_owner(&expired, "recovery-a", observed_at);
        let lock = ClaimLock {
            name: "predecessor-stop".into(),
            owner: Some(owner.clone()),
            node_id: Some("predecessor-stop-node".into()),
        };
        let deleted = Cell::new(false);

        assert!(predecessor_stop_lock_matches(
            &owner,
            &expired,
            "recovery-a"
        ));
        assert!(!transition_lock_recoverable(
            &owner,
            std::slice::from_ref(&expired),
            claim_server_expiry(&expired).unwrap(),
        ));
        assert!(transition_lock_recoverable(
            &owner,
            std::slice::from_ref(&expired),
            owner.expires_at.unwrap(),
        ));
        delete_predecessor_stop_lock_if_owned(&lock, &expired, "recovery-b", |_| {
            deleted.set(true);
            Ok(())
        })
        .unwrap_err();
        assert!(!deleted.get());
        delete_predecessor_stop_lock_if_owned(&lock, &expired, "recovery-a", |node_id| {
            assert_eq!(node_id, "predecessor-stop-node");
            deleted.set(true);
            Ok(())
        })
        .unwrap();
        assert!(deleted.get());
    }

    #[test]
    fn heartbeat_between_takeover_snapshot_and_lock_preserves_fence() {
        let (_, expired_snapshot, expiry) = heartbeat_response_loss_fixture();
        let renewed_claim = ShippingClaim {
            heartbeat_at: "2026-10-07T10:06:00.000Z".into(),
            expires_at: "2026-10-07T10:08:00.000Z".into(),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:06:00.000Z").unwrap()),
            ..expired_snapshot.clone()
        };
        let owner = claim_lock_owner(&expired_snapshot.id);
        let fence = ClaimLock {
            name: "claim-fence".into(),
            owner: Some(owner),
            node_id: Some("live-fence-node".into()),
        };
        let deleted = Cell::new(false);

        let error = with_verified_claim_takeover(
            &fence,
            &fence,
            &expired_snapshot,
            &renewed_claim,
            expiry,
            |_| {
                deleted.set(true);
                Ok(())
            },
        )
        .unwrap_err();

        assert_eq!(
            error,
            "Shipping claim changed during takeover; retry with fresh state."
        );
        assert!(!deleted.get());
    }

    #[test]
    fn stale_takeover_response_cannot_delete_renewed_fence() {
        let (_, expired, _) = heartbeat_response_loss_fixture();
        let expiry = claim_server_expiry(&expired).unwrap();
        let renewed = ShippingClaim {
            heartbeat_at: "2026-10-07T10:06:00.000Z".into(),
            expires_at: "2026-10-07T10:08:00.000Z".into(),
            ..expired.clone()
        };
        let old_fence = ClaimLock {
            name: "claim-fence".into(),
            owner: Some(claim_revision_lock_owner(&expired).unwrap()),
            node_id: Some("old-node".into()),
        };
        let live_fence = ClaimLock {
            owner: Some(claim_revision_lock_owner(&renewed).unwrap()),
            node_id: Some("live-node".into()),
            ..old_fence.clone()
        };
        let deleted = Cell::new(false);
        let error = with_verified_claim_takeover(
            &old_fence,
            &live_fence,
            &expired,
            &expired,
            expiry,
            |_| {
                deleted.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(error.contains("fence changed"));
        assert!(!deleted.get());

        let stale_label_error = with_verified_claim_takeover(
            &old_fence,
            &old_fence,
            &expired,
            &expired,
            expiry,
            |node_id| {
                if node_id != live_fence.node_id.as_deref().unwrap() {
                    return Err("Could not resolve to a node".into());
                }
                deleted.set(true);
                Ok(())
            },
        )
        .unwrap_err();
        assert!(stale_label_error.contains("Could not resolve"));
        assert!(!deleted.get());
    }

    #[test]
    fn stale_release_response_cannot_delete_renewed_fence() {
        let (_, old, _) = heartbeat_response_loss_fixture();
        let renewed = ShippingClaim {
            heartbeat_at: "2026-10-07T10:06:00.000Z".into(),
            expires_at: "2026-10-07T10:08:00.000Z".into(),
            ..old.clone()
        };
        let live_fence = ClaimLock {
            name: "claim-fence".into(),
            owner: Some(claim_revision_lock_owner(&renewed).unwrap()),
            node_id: Some("live-node".into()),
        };
        let deleted = Cell::new(false);
        assert!(!fence_matches_claim(&live_fence, &old));
        assert!(delete_verified_claim_fence(&live_fence, &old, |_| {
            deleted.set(true);
            Ok(())
        })
        .is_err());
        assert!(!deleted.get());

        let stale_fence = ClaimLock {
            owner: Some(claim_revision_lock_owner(&old).unwrap()),
            node_id: Some("old-node".into()),
            ..live_fence
        };
        assert!(delete_verified_claim_fence(&stale_fence, &old, |node_id| {
            if node_id != "live-node" {
                return Err("Could not resolve to a node".into());
            }
            deleted.set(true);
            Ok(())
        })
        .is_err());
        assert!(!deleted.get());
    }

    #[test]
    fn release_retry_accepts_absent_fence_only_after_matching_release() {
        let (submitted, claim, revision) = heartbeat_response_loss_fixture();
        let absent = ClaimLock {
            name: "claim-fence".into(),
            owner: None,
            node_id: None,
        };
        let deleted = Cell::new(false);
        let release = released_claim_marker(&claim, revision, "completed").unwrap();
        let release = ShippingClaim {
            comment_id: 2,
            eligible_author: true,
            comment_author: Some("sail-a".into()),
            ..release
        };
        let claims = vec![claim.clone(), release.clone()];
        let stale_submission = ShippingClaim {
            heartbeat_at: "2026-10-07T10:03:00.000Z".into(),
            expires_at: "2026-10-07T10:05:00.000Z".into(),
            ..submitted.clone()
        };
        let (stored, matched) =
            reconciled_claim_release(&claims, &stale_submission, "sail-a", revision).unwrap();
        assert_eq!(matched.map(|claim| claim.comment_id), Some(2));
        let held = ClaimLock {
            name: "claim-fence".into(),
            owner: Some(claim_revision_lock_owner(stored).unwrap()),
            node_id: Some("held-node".into()),
        };
        assert!(
            delete_verified_claim_fence_after_release(&held, &stale_submission, |_| Ok(()))
                .is_err()
        );
        delete_verified_claim_fence_after_release(&held, stored, |node_id| {
            assert_eq!(node_id, "held-node");
            deleted.set(true);
            Ok(())
        })
        .unwrap();
        assert!(deleted.get());
        deleted.set(false);
        let patched_original = ShippingClaim {
            comment_id: claim.comment_id,
            comment_updated_at_millis: Some(revision + 1_000),
            ..release.clone()
        };
        assert!(reconciled_claim_release(
            &[patched_original, release.clone()],
            &submitted,
            "sail-a",
            revision + 1_000,
        )
        .unwrap()
        .1
        .is_some());
        delete_verified_claim_fence_after_release(&absent, &claim, |_| {
            deleted.set(true);
            Ok(())
        })
        .unwrap();
        assert!(!deleted.get());
        let forged = ShippingClaim {
            comment_author: Some("other-user".into()),
            ..release
        };
        assert!(
            reconciled_claim_release(&[claim.clone(), forged], &submitted, "sail-a", revision)
                .is_err()
        );
        let foreign = ClaimLock {
            owner: Some(
                claim_revision_lock_owner(&ShippingClaim {
                    id: "other".into(),
                    ..claim.clone()
                })
                .unwrap(),
            ),
            node_id: Some("foreign-node".into()),
            ..absent
        };
        assert!(delete_verified_claim_fence_after_release(&foreign, &claim, |_| Ok(())).is_err());
    }

    #[test]
    fn failed_heartbeat_patch_restores_only_the_original_fence_revision() {
        let (_, previous, _) = heartbeat_response_loss_fixture();
        let submitted = ShippingClaim {
            heartbeat_at: "2026-10-07T10:06:00.000Z".into(),
            expires_at: "2026-10-07T10:08:00.000Z".into(),
            ..previous.clone()
        };
        let restored = Cell::new(false);
        rollback_unapplied_heartbeat_fence(&previous, &previous, "sail-a", || {
            restored.set(true);
            Ok(())
        })
        .unwrap();
        assert!(restored.get());
        restored.set(false);
        assert!(
            rollback_unapplied_heartbeat_fence(&submitted, &previous, "sail-a", || {
                restored.set(true);
                Ok(())
            })
            .is_err()
        );
        assert!(!restored.get());
    }

    #[test]
    fn expired_pending_heartbeat_fence_can_be_reclaimed() {
        let (_, old, _) = heartbeat_response_loss_fixture();
        let pending = ShippingClaim {
            heartbeat_at: "2026-10-07T10:06:00.000Z".into(),
            expires_at: "2026-10-07T10:08:00.000Z".into(),
            ..old.clone()
        };
        let owner = claim_revision_lock_owner(&pending).unwrap();
        let reclaim_at = owner.expires_at.unwrap();
        let fence = ClaimLock {
            name: "claim-fence".into(),
            owner: Some(owner),
            node_id: Some("pending-node".into()),
        };
        let deleted = Cell::new(false);
        assert!(
            with_verified_claim_takeover(&fence, &fence, &old, &old, reclaim_at - 1, |_| {
                deleted.set(true);
                Ok(())
            },)
            .is_err()
        );
        assert!(!deleted.get());
        with_verified_claim_takeover(&fence, &fence, &old, &old, reclaim_at, |_| {
            deleted.set(true);
            Ok(())
        })
        .unwrap();
        assert!(deleted.get());

        let delayed = ShippingClaim {
            comment_updated_at_millis: Some(reclaim_at - 1),
            ..pending
        };
        assert_eq!(
            claim_server_expiry(&delayed),
            claim_time_millis(&delayed.expires_at)
        );
    }

    #[test]
    fn pending_heartbeat_fence_with_fast_client_clock_has_bounded_server_expiry() {
        let server_time = claim_time_millis("2026-10-07T10:01:00.000Z").unwrap();
        let old = ShippingClaim {
            acquired_at: "2026-10-08T10:00:00.000Z".into(),
            heartbeat_at: "2026-10-08T10:00:00.000Z".into(),
            expires_at: "2026-10-08T10:02:00.000Z".into(),
            comment_updated_at_millis: Some(claim_time_millis("2026-10-07T10:00:00.000Z").unwrap()),
            ..heartbeat_response_loss_fixture().1
        };
        let pending = ShippingClaim {
            heartbeat_at: "2026-10-08T10:00:00.001Z".into(),
            expires_at: "2026-10-08T10:02:00.001Z".into(),
            ..old.clone()
        };

        let owner = pending_claim_revision_lock_owner(&pending, server_time).unwrap();
        let reclaim_at = claim_time_millis("2026-10-07T10:08:00.000Z").unwrap();

        assert_eq!(owner.expires_at, Some(reclaim_at));
        let fence = ClaimLock {
            name: "claim-fence".into(),
            owner: Some(owner),
            node_id: Some("pending-node".into()),
        };
        assert!(
            with_verified_claim_takeover(&fence, &fence, &old, &old, reclaim_at, |_| Ok(()))
                .is_ok()
        );
    }

    #[test]
    fn failed_heartbeat_compensation_is_never_reported_as_released() {
        let (_, applied, _) = heartbeat_response_loss_fixture();

        let error = posted_release_claim(
            applied,
            Err("network unavailable".into()),
            "Heartbeat verification read failed: stale replica",
        )
        .unwrap_err();

        assert_eq!(
            error,
            "Heartbeat verification read failed: stale replica; compensating release failed: network unavailable"
        );
    }

    #[test]
    fn heartbeat_patch_response_preserves_the_verified_revision_when_reads_fail() {
        let (submitted, applied, revision) = heartbeat_response_loss_fixture();
        let value = serde_json::json!({
            "id": applied.comment_id,
            "body": claim_body(&applied).unwrap(),
            "created_at": "2026-10-07T10:00:00Z",
            "updated_at": "2026-10-07T10:05:00Z",
            "author_association": "MEMBER",
            "user": { "login": "sail-a" }
        });
        let reconciled = claim_from_comment(&value).unwrap();

        assert_eq!(reconciled.comment_updated_at_millis, Some(revision));
        assert!(exact_heartbeat_marker(
            &reconciled,
            &submitted,
            "sail-a",
            revision
        ));
        let released =
            released_claim_marker(&reconciled, revision, "heartbeat verification read failed")
                .unwrap();
        assert_eq!(released.released_comment_updated_at_millis, Some(revision));
    }

    #[test]
    fn heartbeat_patch_response_replaces_an_eventually_consistent_read() {
        let (submitted, applied, revision) = heartbeat_response_loss_fixture();
        let stale = ShippingClaim {
            heartbeat_at: "2026-10-07T10:04:00.000Z".into(),
            expires_at: "2026-10-07T10:06:00.000Z".into(),
            comment_updated_at_millis: Some(revision - 60_000),
            eligible_author: true,
            comment_author: Some("sail-a".into()),
            ..submitted.clone()
        };
        let merged =
            merge_heartbeat_response(vec![stale], Some(applied.clone()), &submitted, "sail-a");

        assert_eq!(merged.len(), 1);
        assert_eq!(merged[0].heartbeat_at, applied.heartbeat_at);
        assert_eq!(merged[0].comment_updated_at_millis, Some(revision));
        assert_eq!(
            reconciled_heartbeat_revision(&merged, &submitted, "sail-a"),
            Some(revision)
        );
    }

    #[test]
    fn heartbeat_patch_response_does_not_replace_a_newer_read() {
        let (submitted, applied, revision) = heartbeat_response_loss_fixture();
        let newer = ShippingClaim {
            heartbeat_at: "2026-10-07T10:05:30.000Z".into(),
            expires_at: "2026-10-07T10:07:30.000Z".into(),
            comment_updated_at_millis: Some(revision + 30_000),
            ..applied.clone()
        };

        let merged =
            merge_heartbeat_response(vec![newer.clone()], Some(applied), &submitted, "sail-a");

        assert_eq!(merged[0].heartbeat_at, newer.heartbeat_at);
        assert_eq!(merged[0].comment_updated_at_millis, Some(revision + 30_000));
        assert_eq!(
            reconciled_heartbeat_revision(&merged, &submitted, "sail-a"),
            None
        );
    }

    #[test]
    fn heartbeat_patch_response_fences_an_equal_revision_conflict() {
        let (submitted, applied, revision) = heartbeat_response_loss_fixture();
        let conflict = ShippingClaim {
            heartbeat_at: "2026-10-07T10:05:00.001Z".into(),
            expires_at: "2026-10-07T10:07:00.001Z".into(),
            ..applied.clone()
        };

        let merged =
            merge_heartbeat_response(vec![conflict.clone()], Some(applied), &submitted, "sail-a");

        assert_eq!(merged[0].heartbeat_at, conflict.heartbeat_at);
        assert_eq!(merged[0].comment_updated_at_millis, Some(revision));
        assert_eq!(
            reconciled_heartbeat_revision(&merged, &submitted, "sail-a"),
            None
        );
    }

    #[test]
    fn release_uses_server_observation_when_the_local_clock_rolls_back() {
        let (submitted, _, _) = heartbeat_response_loss_fixture();
        let server_time = claim_time_millis("2026-10-07T10:06:00.000Z").unwrap();
        let local_time_after_rollback = claim_time_millis("2025-01-01T00:00:00.000Z").unwrap();
        let released = released_claim_marker(&submitted, server_time, "completed").unwrap();

        assert!(local_time_after_rollback < claim_time_millis(&submitted.acquired_at).unwrap());
        assert_eq!(
            released.released_at.as_deref(),
            Some("2026-10-07T10:06:00.000Z")
        );
        assert!(valid_stored_claim(&released));
    }

    #[test]
    fn heartbeat_response_loss_rejects_a_failed_patch() {
        let (submitted, applied, _) = heartbeat_response_loss_fixture();

        assert_eq!(
            reconciled_heartbeat_revision(
                &[ShippingClaim {
                    heartbeat_at: "2026-10-07T10:04:00.000Z".into(),
                    expires_at: "2026-10-07T10:06:00.000Z".into(),
                    ..applied
                }],
                &submitted,
                "sail-a"
            ),
            None
        );
        assert_eq!(
            reconciled_heartbeat_revision(&[], &submitted, "sail-a"),
            None
        );
    }

    #[test]
    fn takeover_audit_response_loss_reconciles_only_the_exact_marker() {
        let (mut submitted, mut applied, revision) = heartbeat_response_loss_fixture();
        submitted.takeover_of = Some("expired-claim".into());
        applied.takeover_of = submitted.takeover_of.clone();

        assert_eq!(
            reconciled_active_revision(std::slice::from_ref(&applied), &submitted, "sail-a"),
            Some(revision)
        );
        assert_eq!(
            reconciled_active_revision(
                &[ShippingClaim {
                    takeover_of: Some("different-claim".into()),
                    ..applied
                }],
                &submitted,
                "sail-a"
            ),
            None
        );
    }

    #[test]
    fn acquisition_compensation_without_a_revision_releases_only_that_lease() {
        let (submitted, mut active, revision) = heartbeat_response_loss_fixture();
        let mut unverified = submitted.clone();
        unverified.comment_updated_at_millis = None;
        let mut released = released_claim_marker(
            &unverified,
            claim_time_millis(&submitted.heartbeat_at).unwrap(),
            "acquisition verification failed",
        )
        .unwrap();
        released.eligible_author = true;
        released.comment_author = Some("sail-a".into());

        assert!(valid_stored_claim(&released));
        assert!(claim_released(&[released.clone()], &active));
        active.heartbeat_at = "2026-10-07T10:05:00.001Z".into();
        active.expires_at = "2026-10-07T10:07:00.001Z".into();
        active.comment_updated_at_millis = Some(revision + 1);
        assert!(!claim_released(&[released], &active));
    }

    #[test]
    fn heartbeat_compensation_binds_the_verified_renewal_revision() {
        let (mut submitted, applied, revision) = heartbeat_response_loss_fixture();
        submitted.comment_updated_at_millis = Some(revision);
        let mut released = released_claim_marker(
            &submitted,
            claim_time_millis("2026-10-07T10:08:00.000Z").unwrap(),
            "superseded during heartbeat",
        )
        .unwrap();
        released.eligible_author = true;
        released.comment_author = Some("sail-a".into());

        assert_eq!(released.released_comment_updated_at_millis, Some(revision));
        assert!(claim_released(&[released], &applied));
    }
}
