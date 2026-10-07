use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::{Mutex, OnceLock};

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
) -> Result<Option<ShippingPullRequest>, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let repository = crate::validate_repository(repository)?;
        if branch.is_empty() || branch.starts_with('-') || branch.contains(char::is_whitespace) {
            return Err("Invalid shipping branch.".to_string());
        }
        let worktree = Path::new(&repository);
        let target = target_repository(worktree)?;
        let output = gh_command(
            worktree,
            &[
                "pr",
                "list",
                "--repo",
                &target,
                "--head",
                &branch,
                "--state",
                "all",
                "--json",
                "number,url,state,mergedAt,headRefOid,statusCheckRollup",
                "--limit",
                "2",
            ],
        )?;
        let values: Vec<serde_json::Value> =
            serde_json::from_str(&output).map_err(|error| error.to_string())?;
        let mut prs = values
            .iter()
            .map(|value| {
                let mut pr: ShippingPullRequest =
                    serde_json::from_value(value.clone()).map_err(|error| error.to_string())?;
                pr.checks = parse_pull_request_checks(value)?.checks;
                Ok(pr)
            })
            .collect::<Result<Vec<_>, String>>()?;
        if prs.len() > 1 {
            return Err("Multiple pull requests use this shipping branch.".to_string());
        }
        Ok(prs.pop())
    })
    .await
    .map_err(|error| error.to_string())?
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
    let output = Command::new(gh_binary())
        .current_dir(directory)
        .args(args)
        .env("GH_PROMPT_DISABLED", "1")
        .env("GIT_TERMINAL_PROMPT", "0")
        .output()
        .map_err(|error| format!("Cannot start GitHub CLI: {error}"))?;
    output_or_error(output, "GitHub CLI failed")
}

fn pull_request_repos(
    worktree: &Path,
    remote: &str,
    branch: &str,
) -> Result<(String, String), String> {
    let source = source_repository(worktree, remote)?;
    let target = target_repository(worktree)?;
    let head = if source.eq_ignore_ascii_case(&target) {
        branch.to_string()
    } else {
        format!("{}:{branch}", source.split('/').next().unwrap_or_default())
    };
    Ok((target, head))
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
            }
        })
        .collect();
    Ok(PullRequestChecks {
        number,
        url,
        checks,
    })
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
        checked_worktree, marked_issue, marker, validate_external_url, validate_graph, IssueDraft,
        IssueGraphDraft,
    };
    use std::{fs, process::Command};

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
}
