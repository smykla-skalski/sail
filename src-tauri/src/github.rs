use crate::GitCanonical;
use serde::{Deserialize, Serialize};
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
    mergeable: Option<bool>,
    #[serde(default)]
    checks: Vec<PullRequestCheck>,
}

#[derive(Clone, Debug, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingClaim {
    pub(crate) id: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) instance_id: Option<String>,
    pub(crate) holder: String,
    pub(crate) task: String,
    pub(crate) acquired_at: String,
    pub(crate) heartbeat_at: String,
    pub(crate) expires_at: String,
    pub(crate) status: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) released_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) release_reason: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) takeover_of: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) released_heartbeat_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) released_expires_at: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) released_comment_updated_at_millis: Option<i64>,
    #[serde(default)]
    pub(crate) comment_id: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub(crate) comment_updated_at_millis: Option<i64>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShippingClaimObservation {
    pub(crate) claim: ShippingClaim,
    pub(crate) active: bool,
    pub(crate) remaining_lease_millis: i64,
}

const MAX_CLAIM_LEASE_MILLIS: i64 = 5 * 60 * 1_000;
const RECENT_EQUIVALENT_PULL_REQUEST_MILLIS: i64 = 14 * 24 * 60 * 60 * 1_000;
fn valid_claim_value(value: &str, maximum: usize) -> bool {
    !value.trim().is_empty()
        && value.len() <= maximum
        && !value.contains('\n')
        && !value.contains('\r')
        && !value.contains("-->")
}

pub(crate) fn claim_time_millis(value: &str) -> Option<i64> {
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

pub(crate) fn equivalent_shipping_work(
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

pub(crate) fn claim_time_from_millis(value: i64) -> Result<String, String> {
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

pub(crate) fn validated_claim_input(claim: &ShippingClaim) -> Result<(), String> {
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
    pr.mergeable = details["mergeable"].as_bool();
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
    #[serde(skip_serializing_if = "Option::is_none")]
    revision: Option<String>,
    workflow: String,
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

pub(crate) fn gh_output(directory: &Path, args: &[&str]) -> Result<String, String> {
    gh_command(directory, args)
}

pub(crate) fn require_target_repository(
    worktree: &Path,
    expected_repository: &str,
) -> Result<String, String> {
    expected_target_repository(worktree, expected_repository)
}

pub(crate) fn target_repository_of(worktree: &Path) -> Result<String, String> {
    target_repository(worktree)
}

fn gh_command(directory: &Path, args: &[&str]) -> Result<String, String> {
    if args.first() == Some(&"api")
        && args
            .iter()
            .any(|argument| argument.contains("/issues/") && argument.contains("/comments"))
        && args.windows(2).any(|pair| {
            pair[0] == "--method" && matches!(pair[1], "POST" | "PATCH" | "PUT" | "DELETE")
        })
    {
        return Err("Sail does not write GitHub comments.".to_string());
    }
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

fn require_expected_target_repository(
    expected_repository: &str,
    target: String,
) -> Result<String, String> {
    if target.eq_ignore_ascii_case(expected_repository) {
        return Ok(target);
    }
    Err(format!(
        "Shipping target changed from {expected_repository} to {target}. Refresh and retry."
    ))
}

fn expected_target_repository(
    worktree: &Path,
    expected_repository: &str,
) -> Result<String, String> {
    require_expected_target_repository(expected_repository, target_repository(worktree)?)
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
        .git_canonical()
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
                        .git_canonical()
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
                "number,url,headRefOid,statusCheckRollup,headRepositoryOwner,headRefName",
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
            let name = check["name"]
                .as_str()
                .or_else(|| check["context"].as_str())
                .unwrap_or("Unknown check")
                .to_string();
            let workflow = name
                .split_once(" / ")
                .map_or("GitHub Actions", |(workflow, _)| workflow)
                .to_string();
            PullRequestCheck {
                name,
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
                revision: pr["headRefOid"].as_str().map(str::to_string),
                workflow,
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

fn bounded_failure_log(log: &str) -> String {
    const MAX_LINES: usize = 80;
    const MAX_CHARACTERS: usize = 12_000;
    const CONTEXT: usize = 3;
    let lines = log.lines().collect::<Vec<_>>();
    let mut selected = vec![false; lines.len()];
    for (index, line) in lines.iter().enumerate() {
        let lower = line.to_ascii_lowercase();
        if ![
            "error",
            "failed",
            "failure",
            "panic",
            "fatal",
            "timeout",
            "exception",
            "assertion",
        ]
        .iter()
        .any(|marker| lower.contains(marker))
        {
            continue;
        }
        let start = index.saturating_sub(CONTEXT);
        let end = (index + CONTEXT + 1).min(lines.len());
        selected[start..end].fill(true);
    }
    let mut excerpt = lines
        .iter()
        .enumerate()
        .filter_map(|(index, line)| selected[index].then_some(*line))
        .collect::<Vec<_>>();
    if excerpt.is_empty() {
        excerpt = lines.into_iter().rev().take(MAX_LINES).collect();
        excerpt.reverse();
    } else if excerpt.len() > MAX_LINES {
        excerpt = excerpt.split_off(excerpt.len() - MAX_LINES);
    }
    let excerpt = excerpt.join("\n");
    let start = excerpt
        .char_indices()
        .rev()
        .nth(MAX_CHARACTERS - 1)
        .map_or(0, |(index, _)| index);
    excerpt[start..].trim().to_string()
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
        Ok(bounded_failure_log(&log))
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
    use super::*;
    use crate::GitCanonical;
    use std::{fs, process::Command, time::Duration};

    #[cfg(windows)]
    use super::{terminate_command_tree, CommandTreeHandle};
    #[cfg(windows)]
    use wait_timeout::ChildExt;
    #[cfg(windows)]
    use windows::Win32::Foundation::HANDLE;

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
    fn shipping_pull_request_reports_github_mergeability() {
        let listed = serde_json::json!({
            "number": 17,
            "url": "https://github.com/upstream/repo/pull/17",
            "state": "OPEN",
            "mergedAt": null,
            "headRefOid": "head-a",
            "statusCheckRollup": []
        });
        let mut details = serde_json::json!({
            "head": { "ref": "fix/issue", "repo": { "full_name": "fork/repo" }, "sha": "head-a" },
            "base": { "ref": "main", "repo": { "full_name": "upstream/repo" } },
            "mergeable": true
        });
        let snapshot = |details: &serde_json::Value| {
            shipping_pull_request_snapshot(
                &listed,
                details,
                "fork/repo",
                "upstream/repo",
                "fix/issue",
                "main",
            )
            .ok()
            .flatten()
            .unwrap()
        };

        assert_eq!(snapshot(&details).mergeable, Some(true));
        details["mergeable"] = serde_json::json!(false);
        assert_eq!(snapshot(&details).mergeable, Some(false));
        details["mergeable"] = serde_json::Value::Null;
        assert_eq!(snapshot(&details).mergeable, None);
        details.as_object_mut().unwrap().remove("mergeable");
        let value = serde_json::to_value(snapshot(&details)).unwrap();
        assert!(value["mergeable"].is_null());
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
        let path = root.git_canonical().unwrap().to_string_lossy().into_owned();

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
        assert_eq!(check.workflow, "GitHub Actions");
        assert!(!check.identity_uncertain);
    }

    #[test]
    fn failed_check_logs_keep_only_bounded_failure_context() {
        let log = (0..200)
            .map(|index| {
                if index == 100 {
                    "error: compilation failed".to_string()
                } else {
                    format!("ordinary output {index}")
                }
            })
            .collect::<Vec<_>>()
            .join("\n");
        let excerpt = bounded_failure_log(&log);
        assert!(excerpt.contains("error: compilation failed"));
        assert!(excerpt.contains("ordinary output 97"));
        assert!(excerpt.contains("ordinary output 103"));
        assert!(!excerpt.contains("ordinary output 0\n"));
        assert!(excerpt.len() <= 12_000);
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
}
