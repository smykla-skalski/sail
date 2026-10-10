use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::{Component, Path, PathBuf};
use std::process::Command;
use std::sync::atomic::{AtomicU64, Ordering};

static NEXT_TEMP: AtomicU64 = AtomicU64::new(0);
const MAX_DOCUMENT_BYTES: usize = 1024 * 1024;
const MAX_PROPOSAL_BYTES: usize = 4 * 1024;

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectedMemory {
    pub id: String,
    pub content: String,
    pub source_session: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Proposal {
    repository: PathBuf,
    memory: SelectedMemory,
    destination: PathBuf,
    revision: String,
    before: String,
    after: String,
    diff: String,
}

impl Proposal {
    pub fn memory(&self) -> &SelectedMemory {
        &self.memory
    }
    pub fn destination(&self) -> &Path {
        &self.destination
    }
    pub fn revision(&self) -> &str {
        &self.revision
    }
    pub fn diff(&self) -> &str {
        &self.diff
    }
}

pub fn preview(
    repository: &Path,
    memory: SelectedMemory,
    destination: &Path,
    proposed_text: &str,
    has_write_access: bool,
) -> Result<Proposal, String> {
    if !has_write_access {
        return Err("Repository write access is required.".into());
    }
    if memory.id.trim().is_empty()
        || memory.content.trim().is_empty()
        || memory.source_session.trim().is_empty()
    {
        return Err("Select a private memory with a source session.".into());
    }
    let text = proposed_text.trim();
    if text.is_empty() || text.len() > MAX_PROPOSAL_BYTES || text.contains('\0') {
        return Err("Proposed text must contain 1 to 4096 bytes.".into());
    }
    let root = repository
        .canonicalize()
        .map_err(|_| "Repository is unavailable.")?;
    let top_level = PathBuf::from(git(&root, &["rev-parse", "--show-toplevel"])?);
    if !root.is_dir()
        || top_level
            .canonicalize()
            .map_err(|_| "Cannot inspect repository.")?
            != root
    {
        return Err("Select a repository root.".into());
    }
    let target = checked_target(&root, destination)?;
    check_index_state(&root, destination)?;
    let revision = git(&root, &["rev-parse", "--verify", "HEAD"])?;
    let before = read_document(&target)?;
    if !git(
        &root,
        &[
            "status",
            "--porcelain",
            "--",
            destination.to_str().ok_or("Invalid destination.")?,
        ],
    )?
    .is_empty()
    {
        return Err("Destination has uncommitted changes.".into());
    }
    let mut after = before.clone();
    if !after.ends_with('\n') {
        after.push('\n');
    }
    if !after.ends_with("\n\n") {
        after.push('\n');
    }
    after.push_str(text);
    after.push('\n');
    let diff = unified_diff(destination, &before, &after);
    Ok(Proposal {
        repository: root,
        memory,
        destination: destination.to_owned(),
        revision,
        before,
        after,
        diff,
    })
}

pub fn accept(
    repository: &Path,
    proposal: &Proposal,
    has_write_access: bool,
) -> Result<(), String> {
    if !has_write_access {
        return Err("Repository write access is required.".into());
    }
    let root = repository
        .canonicalize()
        .map_err(|_| "Repository is unavailable.")?;
    if root != proposal.repository {
        return Err("Proposal belongs to another repository; review it there.".into());
    }
    let target = checked_target(&root, &proposal.destination)?;
    check_index_state(&root, &proposal.destination)?;
    if git(&root, &["rev-parse", "--verify", "HEAD"])? != proposal.revision
        || read_document(&target)? != proposal.before
        || !git(
            &root,
            &[
                "status",
                "--porcelain",
                "--",
                proposal
                    .destination
                    .to_str()
                    .ok_or("Invalid destination.")?,
            ],
        )?
        .is_empty()
    {
        return Err("Destination changed after preview; review a new proposal.".into());
    }
    if proposal.after == proposal.before
        || proposal.diff != unified_diff(&proposal.destination, &proposal.before, &proposal.after)
    {
        return Err("Proposal changed after preview.".into());
    }
    let parent = target.parent().ok_or("Invalid destination.")?;
    let name = format!(
        ".sail-knowledge-{}-{}.tmp",
        std::process::id(),
        NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
    );
    let temporary = parent.join(name);
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&temporary)
            .map_err(|error| format!("Cannot prepare proposal: {error}"))?;
        let permissions = fs::metadata(&target)
            .map_err(|error| error.to_string())?
            .permissions();
        file.set_permissions(permissions)
            .map_err(|error| error.to_string())?;
        file.write_all(proposal.after.as_bytes())
            .and_then(|()| file.sync_all())
            .map_err(|error| format!("Cannot prepare proposal: {error}"))?;
        if checked_target(&root, &proposal.destination)? != target
            || check_index_state(&root, &proposal.destination).is_err()
            || read_document(&target)? != proposal.before
            || git(&root, &["rev-parse", "--verify", "HEAD"])? != proposal.revision
        {
            return Err("Destination changed after preview; review a new proposal.".into());
        }
        fs::rename(&temporary, &target).map_err(|error| format!("Cannot accept proposal: {error}"))
    })();
    if result.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    result
}

fn checked_target(root: &Path, destination: &Path) -> Result<PathBuf, String> {
    let parts: Vec<_> = destination.components().collect();
    let allowed = matches!(parts.as_slice(), [Component::Normal(name)] if *name == "AGENTS.md" || *name == "CLAUDE.md")
        || matches!(parts.as_slice(), [Component::Normal(dir), Component::Normal(name)] if *dir == "docs" && Path::new(name).extension().is_some_and(|ext| ext == "md") && name.to_str().is_some_and(|name| !name.starts_with('.') && !name.chars().any(char::is_control)));
    if !allowed {
        return Err("Select an existing repository instruction or docs Markdown file.".into());
    }
    let mut target = root.to_owned();
    for part in parts {
        target.push(part.as_os_str());
        if fs::symlink_metadata(&target)
            .map_err(|_| "Destination is unavailable.")?
            .file_type()
            .is_symlink()
        {
            return Err("Destination cannot contain a symlink.".into());
        }
    }
    if !target.starts_with(root)
        || !fs::metadata(&target)
            .map_err(|_| "Destination is unavailable.")?
            .is_file()
    {
        return Err("Destination must be a regular repository file.".into());
    }
    let relative = destination.to_str().ok_or("Invalid destination.")?;
    let output = Command::new("git")
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--error-unmatch", "--", relative])
        .output()
        .map_err(|_| "Cannot inspect tracked destination.")?;
    if !output.status.success() {
        return Err("Destination must already be tracked.".into());
    }
    Ok(target)
}

fn check_index_state(root: &Path, destination: &Path) -> Result<(), String> {
    let relative = destination.to_str().ok_or("Invalid destination.")?;
    let flags = git(root, &["ls-files", "-v", "--", relative])?;
    if flags != format!("H {relative}") {
        return Err("Destination has hidden or changed Git index state.".into());
    }
    Ok(())
}

fn read_document(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|_| "Destination is unavailable.")?;
    if metadata.len() as usize > MAX_DOCUMENT_BYTES || metadata.permissions().readonly() {
        return Err("Destination is too large or is read-only.".into());
    }
    let bytes = fs::read(path).map_err(|_| "Cannot read destination.")?;
    String::from_utf8(bytes).map_err(|_| "Destination must be UTF-8 Markdown.".into())
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = Command::new("git")
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(root)
        .args(args)
        .output()
        .map_err(|_| "Cannot inspect repository.")?;
    if !output.status.success() {
        return Err("Cannot inspect repository.".into());
    }
    String::from_utf8(output.stdout)
        .map(|text| text.trim_end().to_owned())
        .map_err(|_| "Invalid repository response.".into())
}

fn unified_diff(path: &Path, before: &str, after: &str) -> String {
    let old: Vec<_> = before.split_terminator('\n').collect();
    let new: Vec<_> = after.split_terminator('\n').collect();
    let mut diff = format!(
        "--- a/{}\n+++ b/{}\n@@ -1,{} +1,{} @@\n",
        path.display(),
        path.display(),
        old.len(),
        new.len()
    );
    for line in old {
        diff.push('-');
        diff.push_str(line);
        diff.push('\n');
    }
    if !before.is_empty() && !before.ends_with('\n') {
        diff.push_str("\\ No newline at end of file\n");
    }
    for line in new {
        diff.push('+');
        diff.push_str(line);
        diff.push('\n');
    }
    if !after.is_empty() && !after.ends_with('\n') {
        diff.push_str("\\ No newline at end of file\n");
    }
    diff
}

#[cfg(test)]
mod tests {
    use super::*;

    struct Repo(PathBuf);

    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sail-knowledge-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            let repo = Self(path);
            repo.git(&["init", "-q"]);
            repo.git(&["config", "user.name", "Sail Test"]);
            repo.git(&["config", "user.email", "sail-test@example.invalid"]);
            fs::write(repo.0.join("AGENTS.md"), "# Rules\n").unwrap();
            fs::create_dir(repo.0.join("docs")).unwrap();
            fs::write(repo.0.join("docs/project.md"), "# Project\n").unwrap();
            repo.git(&["add", "."]);
            repo.git(&["commit", "-qm", "fixture"]);
            repo
        }
        fn git(&self, args: &[&str]) {
            assert!(Command::new("git")
                .arg("-C")
                .arg(&self.0)
                .args(args)
                .status()
                .unwrap()
                .success());
        }
        fn memory() -> SelectedMemory {
            SelectedMemory {
                id: "one".into(),
                content: "private observation".into(),
                source_session: "session-1".into(),
            }
        }
        fn preview(&self) -> Proposal {
            preview(
                &self.0,
                Self::memory(),
                Path::new("AGENTS.md"),
                "## New rule\n\nCheck output.",
                true,
            )
            .unwrap()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            fs::remove_dir_all(&self.0).unwrap();
        }
    }

    #[test]
    fn preview_and_reject_never_write_private_memory() {
        let repo = Repo::new();
        let proposal = repo.preview();
        assert_eq!(proposal.memory().content, "private observation");
        assert_eq!(proposal.memory().source_session, "session-1");
        assert_eq!(proposal.destination(), Path::new("AGENTS.md"));
        assert!(proposal.diff().contains("+## New rule"));
        assert!(!proposal.diff().contains("private observation"));
        drop(proposal);
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "# Rules\n"
        );
        assert!(git(&repo.0, &["status", "--porcelain"]).unwrap().is_empty());
    }

    #[test]
    fn accept_writes_only_the_explicit_destination_as_uncommitted_change() {
        let repo = Repo::new();
        let proposal = repo.preview();
        accept(&repo.0, &proposal, true).unwrap();
        let content = fs::read_to_string(repo.0.join("AGENTS.md")).unwrap();
        assert!(content.ends_with("## New rule\n\nCheck output.\n"));
        assert!(!content.contains("private observation"));
        assert_eq!(
            fs::read_to_string(repo.0.join("docs/project.md")).unwrap(),
            "# Project\n"
        );
        assert_eq!(
            git(&repo.0, &["status", "--porcelain"]).unwrap(),
            " M AGENTS.md"
        );
    }

    #[test]
    fn permission_and_stale_content_fail_closed() {
        let repo = Repo::new();
        assert!(preview(
            &repo.0,
            Repo::memory(),
            Path::new("AGENTS.md"),
            "change",
            false
        )
        .is_err());
        let proposal = repo.preview();
        assert!(accept(&repo.0, &proposal, false).is_err());
        fs::write(repo.0.join("AGENTS.md"), "updated elsewhere\n").unwrap();
        assert!(accept(&repo.0, &proposal, true).is_err());
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "updated elsewhere\n"
        );
    }

    #[test]
    fn changed_revision_requires_fresh_review() {
        let repo = Repo::new();
        let proposal = repo.preview();
        fs::write(repo.0.join("docs/project.md"), "new version\n").unwrap();
        repo.git(&["add", "docs/project.md"]);
        repo.git(&["commit", "-qm", "next"]);
        assert!(accept(&repo.0, &proposal, true).is_err());
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "# Rules\n"
        );
    }

    #[test]
    fn proposal_cannot_be_accepted_in_another_clone_at_the_same_revision() {
        let repo = Repo::new();
        let proposal = repo.preview();
        let other_path = std::env::temp_dir().join(format!(
            "sail-knowledge-clone-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        assert!(Command::new("git")
            .args(["clone", "-q"])
            .arg(&repo.0)
            .arg(&other_path)
            .status()
            .unwrap()
            .success());
        assert!(accept(&other_path, &proposal, true).is_err());
        assert_eq!(
            fs::read_to_string(other_path.join("AGENTS.md")).unwrap(),
            "# Rules\n"
        );
        fs::remove_dir_all(other_path).unwrap();
    }

    #[test]
    fn hidden_index_flags_cannot_hide_the_reviewable_change() {
        let repo = Repo::new();
        let proposal = repo.preview();
        repo.git(&["update-index", "--assume-unchanged", "AGENTS.md"]);
        assert!(accept(&repo.0, &proposal, true).is_err());
        assert!(preview(
            &repo.0,
            Repo::memory(),
            Path::new("AGENTS.md"),
            "change",
            true
        )
        .is_err());
        repo.git(&["update-index", "--no-assume-unchanged", "AGENTS.md"]);
        repo.git(&["update-index", "--skip-worktree", "AGENTS.md"]);
        assert!(accept(&repo.0, &proposal, true).is_err());
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "# Rules\n"
        );
    }

    #[test]
    fn unsafe_destinations_are_rejected() {
        let repo = Repo::new();
        for path in [
            "../AGENTS.md",
            ".git/config",
            "docs/../AGENTS.md",
            "/tmp/AGENTS.md",
            "docs/unknown.md",
        ] {
            assert!(
                preview(&repo.0, Repo::memory(), Path::new(path), "change", true).is_err(),
                "{path}"
            );
        }
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("project.md", repo.0.join("docs/link.md")).unwrap();
            assert!(preview(
                &repo.0,
                Repo::memory(),
                Path::new("docs/link.md"),
                "change",
                true
            )
            .is_err());
        }
    }

    #[test]
    fn explicit_docs_destination_is_supported_without_a_default() {
        let repo = Repo::new();
        let proposal = preview(
            &repo.0,
            Repo::memory(),
            Path::new("docs/project.md"),
            "## Finding",
            true,
        )
        .unwrap();
        assert_eq!(proposal.destination(), Path::new("docs/project.md"));
        assert!(proposal
            .diff()
            .starts_with("--- a/docs/project.md\n+++ b/docs/project.md\n"));
        assert_eq!(
            fs::read_to_string(repo.0.join("docs/project.md")).unwrap(),
            "# Project\n"
        );
    }

    #[test]
    fn destination_swap_after_preview_is_rejected() {
        let repo = Repo::new();
        let proposal = repo.preview();
        fs::remove_file(repo.0.join("AGENTS.md")).unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink("docs/project.md", repo.0.join("AGENTS.md")).unwrap();
            assert!(accept(&repo.0, &proposal, true).is_err());
            assert_eq!(
                fs::read_to_string(repo.0.join("docs/project.md")).unwrap(),
                "# Project\n"
            );
        }
    }

    #[test]
    fn cannot_propose_unselected_memory_or_blank_change() {
        let repo = Repo::new();
        let mut memory = Repo::memory();
        memory.source_session.clear();
        assert!(preview(&repo.0, memory, Path::new("AGENTS.md"), "change", true).is_err());
        assert!(preview(&repo.0, Repo::memory(), Path::new("AGENTS.md"), "  ", true).is_err());
    }
}
