use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};

const RELEASE_POLICY: &str = ".sai/ship-it-release.json";
const INSTRUCTION_FILES: [&str; 4] = [
    "AGENTS.md",
    "CLAUDE.md",
    "CONTRIBUTING.md",
    ".github/PULL_REQUEST_TEMPLATE.md",
];
const STRATEGIES: [&str; 3] = ["squash", "merge", "rebase"];
const MAX_INSTRUCTION_BYTES: usize = 1 << 20;

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) enum MergeMethod {
    Github,
    BotComment(String),
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub(crate) struct MergePolicy {
    pub method: MergeMethod,
    pub strategy: String,
    pub source: String,
}

fn read_text(path: &Path) -> Option<String> {
    let bytes = std::fs::read(path).ok()?;
    let bytes = &bytes[..bytes.len().min(MAX_INSTRUCTION_BYTES)];
    Some(String::from_utf8_lossy(bytes).into_owned())
}

fn backtick_spans(line: &str) -> Vec<&str> {
    line.split('`').skip(1).step_by(2).collect()
}

/// The exact PR comment a repository instruction says merges with, such as
/// "Merge by posting a PR comment with exact body `squash`".
fn prose_bot_comment(text: &str) -> Option<String> {
    text.lines().find_map(|line| {
        let lower = line.to_lowercase();
        if !lower.contains("comment") || !(lower.contains("exact") || lower.contains("body")) {
            return None;
        }
        backtick_spans(line)
            .into_iter()
            .find(|span| STRATEGIES.contains(span))
            .map(str::to_string)
    })
}

fn instruction_texts(root: &Path) -> Vec<(String, String)> {
    INSTRUCTION_FILES
        .iter()
        .filter_map(|name| read_text(&root.join(name)).map(|text| ((*name).to_string(), text)))
        .collect()
}

fn instructions_cite_comment(texts: &[(String, String)], comment: &str) -> bool {
    let quoted = format!("`{comment}`");
    texts.iter().any(|(_, text)| {
        text.lines()
            .any(|line| line.to_lowercase().contains("comment") && line.contains(&quoted))
    })
}

fn structured_policy(
    value: &serde_json::Value,
    texts: &[(String, String)],
) -> Result<Option<MergePolicy>, String> {
    let Some(merge) = value.get("merge") else {
        return Ok(None);
    };
    let invalid = || format!("Fix the merge settings in {RELEASE_POLICY}.");
    let object = merge.as_object().ok_or_else(invalid)?;
    if object
        .keys()
        .any(|key| !["method", "strategy", "bot_comment"].contains(&key.as_str()))
    {
        return Err(invalid());
    }
    let strategy = object
        .get("strategy")
        .and_then(serde_json::Value::as_str)
        .filter(|strategy| STRATEGIES.contains(strategy))
        .ok_or_else(invalid)?
        .to_string();
    match object.get("method").and_then(serde_json::Value::as_str) {
        Some("github")
            if object
                .get("bot_comment")
                .is_none_or(serde_json::Value::is_null) =>
        {
            Ok(Some(MergePolicy {
                method: MergeMethod::Github,
                strategy,
                source: RELEASE_POLICY.to_string(),
            }))
        }
        Some("bot-comment") => {
            let comment = object
                .get("bot_comment")
                .and_then(serde_json::Value::as_str)
                .filter(|comment| !comment.trim().is_empty() && !comment.contains('\n'))
                .ok_or_else(invalid)?;
            if !instructions_cite_comment(texts, comment) {
                return Err(format!(
                    "{RELEASE_POLICY} merges with the comment `{comment}`, but no repository instruction names that exact comment."
                ));
            }
            Ok(Some(MergePolicy {
                method: MergeMethod::BotComment(comment.to_string()),
                strategy,
                source: RELEASE_POLICY.to_string(),
            }))
        }
        _ => Err(invalid()),
    }
}

/// Structured policy first, then repository instructions, then the conservative
/// default: a squash merge through GitHub.
pub(crate) fn resolve_merge_policy(root: &Path) -> Result<MergePolicy, String> {
    let texts = instruction_texts(root);
    if let Some(text) = read_text(&root.join(RELEASE_POLICY)) {
        let value: serde_json::Value = serde_json::from_str(&text)
            .map_err(|_| format!("Fix the JSON in {RELEASE_POLICY}."))?;
        if let Some(policy) = structured_policy(&value, &texts)? {
            return Ok(policy);
        }
    }
    for (name, text) in &texts {
        if let Some(comment) = prose_bot_comment(text) {
            return Ok(MergePolicy {
                strategy: comment.clone(),
                method: MergeMethod::BotComment(comment),
                source: name.clone(),
            });
        }
    }
    Ok(MergePolicy {
        method: MergeMethod::Github,
        strategy: "squash".to_string(),
        source: "default".to_string(),
    })
}

pub(crate) fn parse_pull_request_url(url: &str) -> Result<(String, u64), String> {
    let invalid = || "Invalid pull request URL.".to_string();
    let path = url
        .strip_prefix("https://github.com/")
        .ok_or_else(invalid)?
        .trim_end_matches('/');
    let parts: Vec<&str> = path.split('/').collect();
    let [owner, repo, "pull", number] = parts.as_slice() else {
        return Err(invalid());
    };
    let valid = |part: &str| {
        !part.is_empty()
            && part
                .chars()
                .all(|character| character.is_ascii_alphanumeric() || "-_.".contains(character))
    };
    let number = number.parse::<u64>().map_err(|_| invalid())?;
    if !valid(owner) || !valid(repo) || number == 0 {
        return Err(invalid());
    }
    Ok((format!("{owner}/{repo}"), number))
}

fn valid_revision(value: &str) -> bool {
    (7..=64).contains(&value.len()) && value.chars().all(|character| character.is_ascii_hexdigit())
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ShipMergeRequest {
    repository: String,
    policy_directory: Option<String>,
    expected_repository: String,
    pull_request: String,
    expected_head: String,
    evidence_ready: bool,
}

#[derive(Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct ShipMergeOutcome {
    method: String,
    strategy: String,
    comment: Option<String>,
    head: String,
    pull_request: String,
    policy_source: String,
}

/// Arguments for the GitHub call that merges. A bot-comment repository never
/// reaches the merge endpoint, and no argument bypasses branch protection.
fn merge_call(policy: &MergePolicy, target: &str, number: u64, head: &str) -> Vec<String> {
    match &policy.method {
        MergeMethod::BotComment(comment) => vec![
            "api".to_string(),
            "--method".to_string(),
            "POST".to_string(),
            format!("repos/{target}/issues/{number}/comments"),
            "-f".to_string(),
            format!("body={comment}"),
        ],
        MergeMethod::Github => vec![
            "api".to_string(),
            "--method".to_string(),
            "PUT".to_string(),
            format!("repos/{target}/pulls/{number}/merge"),
            "-f".to_string(),
            format!("merge_method={}", policy.strategy),
            "-f".to_string(),
            format!("sha={head}"),
        ],
    }
}

fn short(revision: &str) -> &str {
    &revision[..revision.len().min(8)]
}

pub(crate) fn merge_pull_request(
    request: &ShipMergeRequest,
    policy: &MergePolicy,
    github: &mut dyn FnMut(Vec<String>) -> Result<String, String>,
) -> Result<ShipMergeOutcome, String> {
    if !request.evidence_ready {
        return Err(
            "Merge evidence is not ready for this revision. Refresh Ship first.".to_string(),
        );
    }
    if !valid_revision(&request.expected_head) {
        return Err("The checkpoint has no revision to merge.".to_string());
    }
    let (target, number) = parse_pull_request_url(&request.pull_request)?;
    if !target.eq_ignore_ascii_case(&request.expected_repository) {
        return Err(format!(
            "The pull request belongs to {target}, not {}.",
            request.expected_repository
        ));
    }
    let details = github(vec![
        "api".to_string(),
        format!("repos/{target}/pulls/{number}"),
    ])?;
    let details: serde_json::Value = serde_json::from_str(&details)
        .map_err(|_| "GitHub returned invalid pull request details.".to_string())?;
    if details["state"] != "open" || details["merged"] == true {
        return Err("The pull request is no longer open.".to_string());
    }
    if details["draft"] == true {
        return Err("The pull request is a draft.".to_string());
    }
    let head = details["head"]["sha"]
        .as_str()
        .ok_or("GitHub returned a pull request without a head revision.")?;
    if !head.eq_ignore_ascii_case(&request.expected_head) {
        return Err(format!(
            "The pull request head {} differs from the checkpoint revision {}. Refresh Ship and review the new commits before merging.",
            short(head),
            short(&request.expected_head)
        ));
    }
    github(merge_call(policy, &target, number, head))?;
    let (method, comment) = match &policy.method {
        MergeMethod::Github => ("github".to_string(), None),
        MergeMethod::BotComment(comment) => ("bot-comment".to_string(), Some(comment.clone())),
    };
    Ok(ShipMergeOutcome {
        method,
        strategy: policy.strategy.clone(),
        comment,
        head: head.to_string(),
        pull_request: request.pull_request.clone(),
        policy_source: policy.source.clone(),
    })
}

#[tauri::command]
pub async fn ship_merge_pull_request(
    request: ShipMergeRequest,
) -> Result<ShipMergeOutcome, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = PathBuf::from(crate::validate_repository(request.repository.clone())?);
        crate::github::require_target_repository(&repository, &request.expected_repository)?;
        let policy_root = match request
            .policy_directory
            .as_ref()
            .filter(|path| !path.trim().is_empty())
        {
            Some(path) => PathBuf::from(crate::validate_repository(path.clone())?),
            None => repository.clone(),
        };
        let policy = resolve_merge_policy(&policy_root)?;
        merge_pull_request(&request, &policy, &mut |arguments| {
            let arguments: Vec<&str> = arguments.iter().map(String::as_str).collect();
            crate::github::gh_output(&repository, &arguments)
        })
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn ship_issue_title(repository: String, reference: String) -> Result<String, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = PathBuf::from(crate::validate_repository(repository)?);
        let (target, number) = match reference.split_once('#') {
            Some((target, number)) => (target.to_string(), number.to_string()),
            None => (crate::github::target_repository_of(&repository)?, reference),
        };
        let number = number
            .parse::<u64>()
            .map_err(|_| "Invalid issue number.".to_string())?;
        let valid_target = target.split('/').count() == 2
            && target.split('/').all(|part| {
                !part.is_empty()
                    && part.chars().all(|character| {
                        character.is_ascii_alphanumeric() || "-_.".contains(character)
                    })
            });
        if number == 0 || !valid_target {
            return Err("Invalid issue reference.".to_string());
        }
        crate::github::gh_output(
            &repository,
            &[
                "api",
                &format!("repos/{target}/issues/{number}"),
                "--jq",
                ".title",
            ],
        )
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(files: &[(&str, &str)]) -> PathBuf {
        let root = std::env::temp_dir().join(format!("sail-merge-policy-{}", uuid::Uuid::new_v4()));
        for (name, text) in files {
            let path = root.join(name);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(path, text).unwrap();
        }
        std::fs::create_dir_all(&root).unwrap();
        root
    }

    const HEAD: &str = "0123456789abcdef0123456789abcdef01234567";

    fn request(head: &str, ready: bool) -> ShipMergeRequest {
        ShipMergeRequest {
            repository: "repo".to_string(),
            policy_directory: None,
            expected_repository: "Owner/Repo".to_string(),
            pull_request: "https://github.com/owner/repo/pull/7".to_string(),
            expected_head: head.to_string(),
            evidence_ready: ready,
        }
    }

    fn bot(comment: &str) -> MergePolicy {
        MergePolicy {
            method: MergeMethod::BotComment(comment.to_string()),
            strategy: "squash".to_string(),
            source: "AGENTS.md".to_string(),
        }
    }

    fn open_pull_request(head: &str) -> String {
        format!(r#"{{"state":"open","merged":false,"draft":false,"head":{{"sha":"{head}"}}}}"#)
    }

    #[test]
    fn a_repository_without_merge_instructions_merges_through_github() {
        let root = fixture(&[("AGENTS.md", "Run the tests before pushing.\n")]);
        let policy = resolve_merge_policy(&root).unwrap();
        assert_eq!(policy.method, MergeMethod::Github);
        assert_eq!(policy.strategy, "squash");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn repository_instructions_choose_the_exact_bot_comment() {
        let root = fixture(&[(
            "AGENTS.md",
            "# Merging\r\n\r\n- Merge by posting a PR comment with exact body `squash`; the bot merges.\r\n",
        )]);
        let policy = resolve_merge_policy(&root).unwrap();
        assert_eq!(policy.method, MergeMethod::BotComment("squash".to_string()));
        assert_eq!(policy.source, "AGENTS.md");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn structured_policy_wins_when_instructions_cite_its_comment() {
        let root = fixture(&[
            (
                ".sai/ship-it-release.json",
                r#"{"schema_version":"sai.ship-it.release-policy/v1","merge":{"method":"bot-comment","strategy":"squash","bot_comment":"squash"}}"#,
            ),
            (
                "CONTRIBUTING.md",
                "Post a comment with the exact body `squash`.\n",
            ),
        ]);
        let policy = resolve_merge_policy(&root).unwrap();
        assert_eq!(policy.method, MergeMethod::BotComment("squash".to_string()));
        assert_eq!(policy.source, RELEASE_POLICY);
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn structured_policy_is_rejected_when_no_instruction_cites_its_comment() {
        let root = fixture(&[(
            ".sai/ship-it-release.json",
            r#"{"merge":{"method":"bot-comment","strategy":"squash","bot_comment":"ship it"}}"#,
        )]);
        assert!(resolve_merge_policy(&root)
            .unwrap_err()
            .contains("no repository instruction names that exact comment"));
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn structured_policy_rejects_unknown_fields_and_methods() {
        for merge in [
            r#"{"method":"github","strategy":"squash","admin":true}"#,
            r#"{"method":"github","strategy":"fast-forward"}"#,
            r#"{"method":"github","strategy":"squash","bot_comment":"squash"}"#,
            r#"{"method":"carrier-pigeon","strategy":"squash"}"#,
        ] {
            let root = fixture(&[(
                ".sai/ship-it-release.json",
                &format!(r#"{{"merge":{merge}}}"#),
            )]);
            assert!(resolve_merge_policy(&root).is_err(), "{merge}");
            std::fs::remove_dir_all(root).unwrap();
        }
    }

    #[test]
    fn a_github_policy_with_a_strategy_merges_through_github() {
        let root = fixture(&[(
            ".sai/ship-it-release.json",
            r#"{"merge":{"method":"github","strategy":"rebase","bot_comment":null}}"#,
        )]);
        let policy = resolve_merge_policy(&root).unwrap();
        assert_eq!(policy.method, MergeMethod::Github);
        assert_eq!(policy.strategy, "rebase");
        std::fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn pull_request_urls_are_parsed_strictly() {
        assert_eq!(
            parse_pull_request_url("https://github.com/owner/repo/pull/7").unwrap(),
            ("owner/repo".to_string(), 7)
        );
        for url in [
            "https://github.com/owner/repo/issues/7",
            "https://example.com/owner/repo/pull/7",
            "https://github.com/owner/repo/pull/0",
            "https://github.com/owner/repo/pull/7/files",
            "https://github.com/owner//pull/7",
        ] {
            assert!(parse_pull_request_url(url).is_err(), "{url}");
        }
    }

    #[test]
    fn a_bot_comment_repository_posts_exactly_the_comment() {
        let mut calls: Vec<Vec<String>> = Vec::new();
        let outcome = merge_pull_request(&request(HEAD, true), &bot("squash"), &mut |arguments| {
            calls.push(arguments.clone());
            Ok(open_pull_request(HEAD))
        })
        .unwrap();
        assert_eq!(calls.len(), 2);
        assert_eq!(
            calls[1],
            [
                "api",
                "--method",
                "POST",
                "repos/owner/repo/issues/7/comments",
                "-f",
                "body=squash"
            ]
        );
        assert_eq!(outcome.method, "bot-comment");
        assert_eq!(outcome.comment.as_deref(), Some("squash"));
        assert!(calls
            .iter()
            .flatten()
            .all(|argument| !argument.contains("/merge") && argument != "pr"));
    }

    #[test]
    fn a_github_policy_pins_the_head_and_strategy() {
        let policy = MergePolicy {
            method: MergeMethod::Github,
            strategy: "squash".to_string(),
            source: "default".to_string(),
        };
        let mut calls: Vec<Vec<String>> = Vec::new();
        merge_pull_request(&request(HEAD, true), &policy, &mut |arguments| {
            calls.push(arguments);
            Ok(open_pull_request(HEAD))
        })
        .unwrap();
        assert_eq!(
            calls[1],
            [
                "api",
                "--method",
                "PUT",
                "repos/owner/repo/pulls/7/merge",
                "-f",
                "merge_method=squash",
                "-f",
                &format!("sha={HEAD}")
            ]
        );
    }

    #[test]
    fn merge_refuses_when_the_head_differs_from_the_checkpoint_revision() {
        let mut posted = 0;
        let moved = "fedcba9876543210fedcba9876543210fedcba98";
        let error = merge_pull_request(&request(HEAD, true), &bot("squash"), &mut |arguments| {
            if arguments
                .iter()
                .any(|argument| argument == "POST" || argument == "PUT")
            {
                posted += 1;
            }
            Ok(open_pull_request(moved))
        })
        .unwrap_err();
        assert_eq!(posted, 0);
        assert!(
            error.contains("differs from the checkpoint revision"),
            "{error}"
        );
    }

    #[test]
    fn merge_refuses_without_evidence_or_for_the_wrong_pull_request() {
        let never =
            &mut |_: Vec<String>| -> Result<String, String> { panic!("must not call GitHub") };
        assert!(
            merge_pull_request(&request(HEAD, false), &bot("squash"), never)
                .unwrap_err()
                .contains("evidence")
        );
        let mut other = request(HEAD, true);
        other.expected_repository = "owner/other".to_string();
        assert!(merge_pull_request(&other, &bot("squash"), never)
            .unwrap_err()
            .contains("belongs to owner/repo"));
        assert!(merge_pull_request(&request("", true), &bot("squash"), never).is_err());
    }

    #[test]
    fn merge_refuses_closed_and_draft_pull_requests() {
        for details in [
            r#"{"state":"closed","merged":true,"draft":false,"head":{"sha":"0123456789abcdef0123456789abcdef01234567"}}"#,
            r#"{"state":"open","merged":false,"draft":true,"head":{"sha":"0123456789abcdef0123456789abcdef01234567"}}"#,
        ] {
            let error =
                merge_pull_request(&request(HEAD, true), &bot("squash"), &mut |arguments| {
                    assert!(!arguments.contains(&"POST".to_string()));
                    Ok(details.to_string())
                })
                .unwrap_err();
            assert!(
                error.contains("no longer open") || error.contains("draft"),
                "{error}"
            );
        }
    }

    #[test]
    fn no_admin_override_appears_in_the_merge_path() {
        let source = include_str!("ship_actions.rs");
        let production = source.split("#[cfg(test)]").next().unwrap();
        assert!(!production.to_lowercase().contains("admin"));
        assert!(!production.contains("pr\", \"merge"));
        for policy in [
            bot("squash"),
            MergePolicy {
                method: MergeMethod::Github,
                strategy: "squash".to_string(),
                source: "default".to_string(),
            },
        ] {
            for argument in merge_call(&policy, "owner/repo", 7, HEAD) {
                assert!(!argument.to_lowercase().contains("admin"), "{argument}");
            }
        }
    }
}
