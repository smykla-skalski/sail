use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::ffi::OsString;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};

#[derive(Serialize, Deserialize)]
pub struct PullRequest {
    number: u64,
    url: String,
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
    title: String,
    body: String,
    depends_on: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IssueGraphDraft {
    umbrella_number: Option<u64>,
    title: String,
    body: String,
    issues: Vec<IssueDraft>,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublishedIssue {
    id: String,
    number: u64,
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
        title: issue_field(value, "title")?,
        body: value["body"].as_str().unwrap_or_default().to_string(),
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

fn issue_parent(directory: &Path, target: &str, number: u64) -> Result<Option<u64>, String> {
    let endpoint = format!("repos/{target}/issues/{number}/parent");
    match gh_command(directory, &["api", &endpoint]) {
        Ok(output) => {
            let parent: serde_json::Value = serde_json::from_str(&output)
                .map_err(|_| "GitHub returned an invalid parent issue.".to_string())?;
            parent["number"]
                .as_u64()
                .map(Some)
                .ok_or("GitHub parent issue has no number.".into())
        }
        Err(error) if error.contains("HTTP 404") => Ok(None),
        Err(error) => Err(format!("Cannot inspect parent of #{number}: {error}")),
    }
}

fn validate_graph(graph: &IssueGraphDraft) -> Result<(), String> {
    use std::collections::{HashMap, HashSet};
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
    for issue in &graph.issues {
        if issue.id.trim().is_empty() || !ids.insert(issue.id.as_str()) {
            return Err(format!("Duplicate or empty issue ID: {}.", issue.id));
        }
        if issue.title.trim().is_empty() {
            return Err(format!("Enter a title for {}.", issue.id));
        }
        if let Some(number) = issue.number {
            if number == 0 || !numbers.insert(number) {
                return Err(format!("Invalid or duplicate issue #{number}."));
            }
            if Some(number) == graph.umbrella_number {
                return Err("An umbrella cannot be its own child.".into());
            }
        }
        let mut dependencies = HashSet::new();
        for dependency in &issue.depends_on {
            if !dependencies.insert(dependency) {
                return Err(format!("{} repeats dependency {dependency}.", issue.id));
            }
        }
    }
    let by_id: HashMap<&str, &IssueDraft> = graph
        .issues
        .iter()
        .map(|issue| (issue.id.as_str(), issue))
        .collect();
    fn visit<'a>(
        id: &'a str,
        by_id: &HashMap<&'a str, &'a IssueDraft>,
        visiting: &mut HashSet<&'a str>,
        visited: &mut HashSet<&'a str>,
    ) -> Result<(), String> {
        if visited.contains(id) {
            return Ok(());
        }
        if !visiting.insert(id) {
            return Err(format!("Dependency cycle includes {id}."));
        }
        let issue = by_id
            .get(id)
            .ok_or_else(|| format!("Missing issue {id}."))?;
        for dependency in &issue.depends_on {
            visit(dependency, by_id, visiting, visited)?;
        }
        visiting.remove(id);
        visited.insert(id);
        Ok(())
    }
    let mut visiting = HashSet::new();
    let mut visited = HashSet::new();
    for issue in &graph.issues {
        visit(&issue.id, &by_id, &mut visiting, &mut visited)?;
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

fn publish_graph(repository: String, graph: IssueGraphDraft) -> Result<PublishedGraph, String> {
    validate_graph(&graph)?;
    let (repository, target) = issue_repository(repository)?;
    let umbrella = graph
        .umbrella_number
        .map(|number| github_issue(&repository, &target, number))
        .transpose()?;
    if let Some(value) = &umbrella {
        let issue = published_issue(value, "umbrella".into())?;
        if issue.state != "OPEN" {
            return Err(format!("Umbrella #{} is closed.", issue.number));
        }
    }
    let mut existing = HashMap::new();
    for draft in &graph.issues {
        if let Some(number) = draft.number {
            let value = github_issue(&repository, &target, number)?;
            let issue = published_issue(&value, draft.id.clone())?;
            if issue.state != "OPEN" {
                return Err(format!("Issue #{number} is closed."));
            }
            if let Some(parent) = issue_parent(&repository, &target, number)? {
                if Some(parent) != graph.umbrella_number {
                    return Err(format!(
                        "Issue #{number} already belongs to umbrella #{parent}."
                    ));
                }
            }
            existing.insert(draft.id.clone(), value);
        }
    }
    let mut umbrella = umbrella;
    if graph.issues.len() > 1 && umbrella.is_none() {
        umbrella = Some(create_issue(
            &repository,
            &target,
            &graph.title,
            &graph.body,
        )?);
    }
    let mut issues = Vec::new();
    for draft in &graph.issues {
        let value = match existing.remove(&draft.id) {
            Some(value) => value,
            None => create_issue(&repository, &target, &draft.title, &draft.body)?,
        };
        let mut issue = published_issue(&value, draft.id.clone())?;
        issue.depends_on = draft.depends_on.clone();
        issues.push((issue, value));
    }
    if let Some(umbrella) = &umbrella {
        let parent = published_issue(umbrella, "umbrella".into())?;
        let linked = issue_pages(
            &repository,
            &format!("repos/{target}/issues/{}/sub_issues", parent.number),
        )?;
        let linked: std::collections::HashSet<u64> = linked
            .iter()
            .filter_map(|value| value["number"].as_u64())
            .collect();
        for (issue, value) in &issues {
            if !linked.contains(&issue.number) {
                issue_api(
                    &repository,
                    &[
                        "-X",
                        "POST",
                        &format!("repos/{target}/issues/{}/sub_issues", parent.number),
                        "-F",
                        &format!(
                            "sub_issue_id={}",
                            value["id"].as_u64().ok_or("GitHub issue has no ID.")?
                        ),
                    ],
                )?;
            }
        }
    }
    for (issue, _) in &issues {
        if issue.depends_on.is_empty() {
            continue;
        }
        let blocked_by = issue_pages(
            &repository,
            &format!(
                "repos/{target}/issues/{}/dependencies/blocked_by",
                issue.number
            ),
        )?;
        let blocked_by: std::collections::HashSet<u64> = blocked_by
            .iter()
            .filter_map(|value| value["number"].as_u64())
            .collect();
        for dependency in &issue.depends_on {
            let (_, blocker) = issues
                .iter()
                .find(|(candidate, _)| &candidate.id == dependency)
                .ok_or("Missing dependency.")?;
            if !blocked_by.contains(
                &blocker["number"]
                    .as_u64()
                    .ok_or("GitHub issue has no number.")?,
            ) {
                issue_api(
                    &repository,
                    &[
                        "-X",
                        "POST",
                        &format!(
                            "repos/{target}/issues/{}/dependencies/blocked_by",
                            issue.number
                        ),
                        "-F",
                        &format!(
                            "issue_id={}",
                            blocker["id"].as_u64().ok_or("GitHub issue has no ID.")?
                        ),
                    ],
                )?;
            }
        }
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
            let number = value["number"]
                .as_u64()
                .ok_or("GitHub subissue has no number.")?;
            let mut issue = published_issue(&value, number.to_string())?;
            let blockers = issue_pages(
                &repository,
                &format!("repos/{target}/issues/{number}/dependencies/blocked_by"),
            )?;
            issue.depends_on = blockers
                .iter()
                .map(|blocker| {
                    blocker["number"]
                        .as_u64()
                        .map(|number| number.to_string())
                        .ok_or("GitHub dependency has no number.".to_string())
                })
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

fn github_remote(url: &str) -> Option<String> {
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

fn target_repository(worktree: &Path) -> Result<String, String> {
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

fn checked_worktree(repository: String, worktree: String, branch: &str) -> Result<PathBuf, String> {
    let repository = PathBuf::from(crate::validate_repository(repository)?);
    let worktree = Path::new(&worktree)
        .canonicalize()
        .map_err(|_| "Worktree folder no longer exists.".to_string())?;
    let listed = crate::git_reference(&repository, &["worktree", "list", "--porcelain"])
        .ok_or("Cannot inspect repository worktrees.")?;
    if worktree == repository
        || !listed
            .lines()
            .filter_map(|line| line.strip_prefix("worktree "))
            .any(|path| {
                Path::new(path)
                    .canonicalize()
                    .is_ok_and(|registered| registered == worktree)
            })
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
                    checked_worktree(repository.clone(), entry.path.clone(), &entry.branch)?;
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
        let worktree = checked_worktree(repository, worktree, &branch)?;
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
        let worktree = checked_worktree(repository, worktree, &branch)?;
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
    use super::{validate_external_url, validate_graph, IssueDraft, IssueGraphDraft};

    #[test]
    fn graph_rejects_cycles_and_duplicate_existing_issues() {
        let mut graph = IssueGraphDraft {
            umbrella_number: None,
            title: "Umbrella".into(),
            body: String::new(),
            issues: vec![
                IssueDraft {
                    id: "a".into(),
                    number: Some(3),
                    title: "A".into(),
                    body: String::new(),
                    depends_on: vec![],
                },
                IssueDraft {
                    id: "b".into(),
                    number: Some(4),
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
        graph.issues[1].number = Some(3);
        assert!(validate_graph(&graph).unwrap_err().contains("duplicate"));
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
