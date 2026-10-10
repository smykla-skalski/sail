use std::fs;
use std::path::{Component, Path, PathBuf};
use std::process::{Command, Stdio};
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

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PreparedChange {
    repository: PathBuf,
    artifact: PathBuf,
    revision: String,
    reference: String,
    tree: String,
}

impl PreparedChange {
    pub fn artifact(&self) -> &Path {
        &self.artifact
    }

    pub fn revision(&self) -> &str {
        &self.revision
    }

    pub fn reference(&self) -> &str {
        &self.reference
    }
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
    if proposed_text.trim().is_empty()
        || proposed_text.len() > MAX_PROPOSAL_BYTES
        || proposed_text.contains('\0')
    {
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
    after.push_str(proposed_text);
    if !after.ends_with('\n') {
        after.push('\n');
    }
    check_git_content(&root, &revision, destination, &before, &after)?;
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
) -> Result<PreparedChange, String> {
    accept_with(repository, proposal, has_write_access, || {}, |_, _, _| {})
}

fn accept_with<F: FnOnce(), G: FnOnce(&Path, &str, &str)>(
    repository: &Path,
    proposal: &Proposal,
    has_write_access: bool,
    before_publish: F,
    after_publish: G,
) -> Result<PreparedChange, String> {
    if !has_write_access {
        return Err("Repository write access is required.".into());
    }
    let root = repository
        .canonicalize()
        .map_err(|_| "Repository is unavailable.")?;
    if root != proposal.repository {
        return Err("Proposal belongs to another repository; review it there.".into());
    }
    check_source(&root, proposal)?;
    if proposal.after == proposal.before
        || proposal.diff != unified_diff(&proposal.destination, &proposal.before, &proposal.after)
    {
        return Err("Proposal changed after preview.".into());
    }
    check_git_content(
        &root,
        &proposal.revision,
        &proposal.destination,
        &proposal.before,
        &proposal.after,
    )?;
    let scratch = reserve_artifact_directory()?;
    let mut retain_artifact = false;
    let result = (|| {
        let artifact = scratch.join("repo.git");
        init_artifact(&root, &artifact)?;
        let index = scratch.join("index");
        git_index(&artifact, &index, &["read-tree", &proposal.revision])?;
        let blob = write_blob(&artifact, proposal.after.as_bytes())?;
        let mode = tracked_mode(&root, &proposal.destination)?;
        let relative = proposal
            .destination
            .to_str()
            .ok_or("Invalid destination.")?;
        git_index(
            &artifact,
            &index,
            &[
                "update-index",
                "--cacheinfo",
                &format!("{mode},{blob},{relative}"),
            ],
        )?;
        let tree = git_index(&artifact, &index, &["write-tree"])?;
        before_publish();
        check_source(&root, proposal)?;
        let reference = publish_tree(&artifact, &tree)?;
        after_publish(&artifact, &reference, &tree);
        if let Err(error) = check_source(&root, proposal) {
            if delete_tree_ref(&artifact, &reference, &tree).is_err() {
                retain_artifact = true;
                return Err(format!(
                    "{error} Proposal ref changed; artifact retained at {}.",
                    artifact.display()
                ));
            }
            return Err(error);
        }
        Ok(PreparedChange {
            repository: root,
            artifact,
            revision: proposal.revision.clone(),
            reference,
            tree,
        })
    })();
    match result {
        Err(error) => {
            if !retain_artifact {
                fs::remove_dir_all(&scratch).map_err(|cleanup| {
                    format!("Cannot remove rejected proposal artifact: {cleanup}")
                })?;
            }
            Err(error)
        }
        Ok(prepared) => {
            if let Err(error) = fs::remove_file(scratch.join("index")) {
                delete_tree_ref(&prepared.artifact, &prepared.reference, &prepared.tree).map_err(
                    |_| {
                        format!(
                            "Cannot remove temporary index; artifact retained at {}.",
                            prepared.artifact.display()
                        )
                    },
                )?;
                fs::remove_dir_all(&scratch)
                    .map_err(|cleanup| format!("Cannot remove proposal artifact: {cleanup}"))?;
                return Err(format!("Cannot remove temporary proposal index: {error}"));
            }
            Ok(prepared)
        }
    }
}

pub fn discard(repository: &Path, prepared: &PreparedChange) -> Result<(), String> {
    let root = repository
        .canonicalize()
        .map_err(|_| "Repository is unavailable.")?;
    if root != prepared.repository {
        return Err("Prepared change belongs to another repository.".into());
    }
    delete_tree_ref(&prepared.artifact, &prepared.reference, &prepared.tree)?;
    fs::remove_dir_all(
        prepared
            .artifact
            .parent()
            .ok_or("Invalid proposal artifact.")?,
    )
    .map_err(|error| format!("Cannot remove proposal artifact: {error}"))
}

fn reserve_artifact_directory() -> Result<PathBuf, String> {
    loop {
        let path = std::env::temp_dir().join(format!(
            "sail-knowledge-artifact-{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => return Ok(path),
            Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(error) => return Err(format!("Cannot create proposal artifact: {error}")),
        }
    }
}

fn git_command() -> Command {
    let mut command = Command::new("git");
    for variable in [
        "GIT_DIR",
        "GIT_COMMON_DIR",
        "GIT_WORK_TREE",
        "GIT_INDEX_FILE",
        "GIT_OBJECT_DIRECTORY",
        "GIT_ALTERNATE_OBJECT_DIRECTORIES",
        "GIT_NAMESPACE",
    ] {
        command.env_remove(variable);
    }
    command.env("GIT_OPTIONAL_LOCKS", "0");
    command
}

fn init_artifact(root: &Path, artifact: &Path) -> Result<(), String> {
    let source_objects = git(
        root,
        &[
            "rev-parse",
            "--path-format=absolute",
            "--git-path",
            "objects",
        ],
    )?;
    if !git_command()
        .args(["init", "--bare", "--quiet"])
        .arg(artifact)
        .status()
        .map_err(|_| "Cannot initialize proposal artifact.")?
        .success()
    {
        return Err("Cannot initialize proposal artifact.".into());
    }
    fs::write(
        artifact.join("objects/info/alternates"),
        format!("{source_objects}\n"),
    )
    .map_err(|_| "Cannot link source objects to proposal artifact.".into())
}

fn git_index(artifact: &Path, index: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command()
        .arg("--git-dir")
        .arg(artifact)
        .env("GIT_INDEX_FILE", index)
        .args(args)
        .output()
        .map_err(|_| "Cannot prepare proposal tree.")?;
    if !output.status.success() {
        return Err("Cannot prepare proposal tree.".into());
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim_end().to_owned())
        .map_err(|_| "Invalid proposal tree response.".into())
}

fn write_blob(artifact: &Path, content: &[u8]) -> Result<String, String> {
    use std::io::Write;
    let mut child = git_command()
        .arg("--git-dir")
        .arg(artifact)
        .args(["hash-object", "-w", "--stdin"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "Cannot prepare proposal blob.")?;
    child
        .stdin
        .take()
        .ok_or("Cannot prepare proposal blob.")?
        .write_all(content)
        .map_err(|_| "Cannot prepare proposal blob.")?;
    let output = child
        .wait_with_output()
        .map_err(|_| "Cannot prepare proposal blob.")?;
    if !output.status.success() {
        return Err("Cannot prepare proposal blob.".into());
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim_end().to_owned())
        .map_err(|_| "Invalid proposal blob response.".into())
}

fn tracked_mode(root: &Path, destination: &Path) -> Result<&'static str, String> {
    let relative = destination.to_str().ok_or("Invalid destination.")?;
    let output = git_command()
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "--stage", "-z", "--", relative])
        .output()
        .map_err(|_| "Cannot inspect destination mode.")?;
    if !output.status.success() {
        return Err("Cannot inspect destination mode.".into());
    }
    let entry = output.stdout;
    if !entry.ends_with(format!("\t{relative}\0").as_bytes())
        || entry.iter().filter(|byte| **byte == 0).count() != 1
    {
        return Err("Invalid destination mode.".into());
    }
    match entry.split(|byte| *byte == b' ').next() {
        Some(b"100644") => Ok("100644"),
        Some(b"100755") => Ok("100755"),
        _ => Err("Invalid destination mode.".into()),
    }
}

fn publish_tree(root: &Path, tree: &str) -> Result<String, String> {
    publish_tree_with(root, tree, || {
        format!(
            "refs/sail/knowledge/{}-{}",
            std::process::id(),
            NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
        )
    })
}

fn publish_tree_with<F: FnMut() -> String>(
    root: &Path,
    tree: &str,
    mut next_reference: F,
) -> Result<String, String> {
    loop {
        let reference = next_reference();
        let output = git_command()
            .arg("-C")
            .arg(root)
            .args(["update-ref", &reference, tree, ""])
            .output()
            .map_err(|_| "Cannot publish proposal tree.")?;
        if output.status.success() {
            return Ok(reference);
        }
        if !git_command()
            .arg("-C")
            .arg(root)
            .args(["show-ref", "--verify", "--quiet", &reference])
            .status()
            .is_ok_and(|status| status.success())
        {
            return Err("Cannot publish proposal tree.".into());
        }
    }
}

fn delete_tree_ref(root: &Path, reference: &str, tree: &str) -> Result<(), String> {
    let output = git_command()
        .arg("-C")
        .arg(root)
        .args(["update-ref", "-d", reference, tree])
        .output()
        .map_err(|_| "Cannot remove proposal ref.")?;
    if !output.status.success() {
        return Err("Cannot remove proposal ref.".into());
    }
    Ok(())
}

fn check_source(root: &Path, proposal: &Proposal) -> Result<(), String> {
    let target = checked_target(root, &proposal.destination)?;
    check_index_state(root, &proposal.destination)?;
    if git(root, &["rev-parse", "--verify", "HEAD"])? != proposal.revision
        || read_document(&target)? != proposal.before
        || !git(
            root,
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
    Ok(())
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
    let output = git_command()
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
    let output = git_command()
        .arg("--literal-pathspecs")
        .arg("-C")
        .arg(root)
        .args(["ls-files", "-z", "-v", "--", relative])
        .output()
        .map_err(|_| "Cannot inspect repository.")?;
    if !output.status.success() || !plain_index_entry(&output.stdout, relative) {
        return Err("Destination has hidden or changed Git index state.".into());
    }
    Ok(())
}

fn plain_index_entry(output: &[u8], relative: &str) -> bool {
    output == format!("H {relative}\0").as_bytes()
}

fn read_document(path: &Path) -> Result<String, String> {
    let metadata = fs::metadata(path).map_err(|_| "Destination is unavailable.")?;
    if metadata.len() as usize > MAX_DOCUMENT_BYTES || metadata.permissions().readonly() {
        return Err("Destination is too large or is read-only.".into());
    }
    let bytes = fs::read(path).map_err(|_| "Cannot read destination.")?;
    String::from_utf8(bytes).map_err(|_| "Destination must be UTF-8 Markdown.".into())
}

fn check_git_content(
    root: &Path,
    revision: &str,
    destination: &Path,
    before: &str,
    after: &str,
) -> Result<(), String> {
    let relative = destination.to_str().ok_or("Invalid destination.")?;
    let blob = Command::new("git")
        .arg("-C")
        .arg(root)
        .args(["cat-file", "blob", &format!("{revision}:{relative}")])
        .output()
        .map_err(|_| "Cannot inspect tracked destination content.")?;
    if !blob.status.success() {
        return Err("Cannot inspect tracked destination content.".into());
    }
    if blob.stdout != before.as_bytes()
        || hash_content(root, None, after.as_bytes())?
            != hash_content(root, Some(relative), after.as_bytes())?
    {
        return Err(
            "Destination uses Git content conversion; choose a file without filters.".into(),
        );
    }
    Ok(())
}

fn hash_content(root: &Path, path: Option<&str>, content: &[u8]) -> Result<String, String> {
    use std::io::Write;
    let mut command = Command::new("git");
    command.arg("-C").arg(root).arg("hash-object");
    if let Some(path) = path {
        command.arg(format!("--path={path}"));
    }
    let mut child = command
        .arg("--stdin")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .map_err(|_| "Cannot inspect Git content conversion.")?;
    child
        .stdin
        .take()
        .ok_or("Cannot inspect Git content conversion.")?
        .write_all(content)
        .map_err(|_| "Cannot inspect Git content conversion.")?;
    let output = child
        .wait_with_output()
        .map_err(|_| "Cannot inspect Git content conversion.")?;
    if !output.status.success() {
        return Err("Cannot inspect Git content conversion.".into());
    }
    String::from_utf8(output.stdout)
        .map(|value| value.trim_end().to_owned())
        .map_err(|_| "Invalid Git content conversion response.".into())
}

fn git(root: &Path, args: &[&str]) -> Result<String, String> {
    let output = git_command()
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
    use std::cell::{Cell, RefCell};

    struct Repo(PathBuf, RefCell<Vec<PreparedChange>>);

    impl Repo {
        fn new() -> Self {
            let path = std::env::temp_dir().join(format!(
                "sail-knowledge-{}-{}",
                std::process::id(),
                NEXT_TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            let repo = Self(path, RefCell::new(Vec::new()));
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
        fn accept(
            &self,
            proposal: &Proposal,
            has_write_access: bool,
        ) -> Result<PreparedChange, String> {
            let result = accept(&self.0, proposal, has_write_access);
            if let Ok(prepared) = &result {
                self.1.borrow_mut().push(prepared.clone());
            }
            result
        }
        fn prepared_text(&self, prepared: &PreparedChange, destination: &str) -> String {
            let output = Command::new("git")
                .arg("--git-dir")
                .arg(prepared.artifact())
                .arg("show")
                .arg(format!("{}:{destination}", prepared.reference()))
                .output()
                .unwrap();
            assert!(output.status.success());
            String::from_utf8(output.stdout).unwrap()
        }
    }

    impl Drop for Repo {
        fn drop(&mut self) {
            for prepared in self.1.borrow().iter() {
                if prepared.artifact().exists() {
                    discard(&self.0, prepared).unwrap();
                }
            }
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
    fn crlf_working_copy_is_rejected_before_preview() {
        let repo = Repo::new();
        fs::write(repo.0.join(".gitattributes"), "AGENTS.md text eol=crlf\n").unwrap();
        repo.git(&["add", ".gitattributes"]);
        repo.git(&["commit", "-qm", "set line endings"]);
        fs::write(repo.0.join("AGENTS.md"), "# Rules\r\n").unwrap();
        repo.git(&["add", "AGENTS.md"]);
        assert!(git(&repo.0, &["status", "--porcelain", "--", "AGENTS.md"])
            .unwrap()
            .is_empty());

        let error = preview(
            &repo.0,
            Repo::memory(),
            Path::new("AGENTS.md"),
            "## New rule",
            true,
        )
        .unwrap_err();
        assert!(error.contains("Git content conversion"), "{error}");
        assert!(git(&repo.0, &["for-each-ref", "refs/sail/knowledge"])
            .unwrap()
            .is_empty());
        assert!(git(&repo.0, &["fsck", "--unreachable", "--no-reflogs"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn clean_filter_that_changes_proposal_is_rejected() {
        let repo = Repo::new();
        repo.git(&["config", "filter.sail-test.clean", "sed s/secret/public/g"]);
        fs::write(
            repo.0.join(".gitattributes"),
            "AGENTS.md filter=sail-test\n",
        )
        .unwrap();
        repo.git(&["add", ".gitattributes"]);
        repo.git(&["commit", "-qm", "set filter"]);

        let error = preview(
            &repo.0,
            Repo::memory(),
            Path::new("AGENTS.md"),
            "secret",
            true,
        )
        .unwrap_err();
        assert!(error.contains("Git content conversion"), "{error}");
        assert!(git(&repo.0, &["fsck", "--unreachable", "--no-reflogs"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn filter_enabled_after_preview_blocks_acceptance() {
        let repo = Repo::new();
        let proposal = preview(
            &repo.0,
            Repo::memory(),
            Path::new("AGENTS.md"),
            "secret",
            true,
        )
        .unwrap();
        repo.git(&["config", "filter.sail-test.clean", "sed s/secret/public/g"]);
        fs::write(
            repo.0.join(".gitattributes"),
            "AGENTS.md filter=sail-test\n",
        )
        .unwrap();
        let published = Cell::new(false);
        let error = accept_with(&repo.0, &proposal, true, || published.set(true)).unwrap_err();
        assert!(error.contains("Git content conversion"), "{error}");
        assert!(!published.get());
        assert!(git(&repo.0, &["for-each-ref", "refs/sail/knowledge"])
            .unwrap()
            .is_empty());
        assert!(git(&repo.0, &["fsck", "--unreachable", "--no-reflogs"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn accept_prepares_only_the_reviewed_destination_in_a_git_tree() {
        let repo = Repo::new();
        let proposal = repo.preview();
        let prepared = repo.accept(&proposal, true).unwrap();
        let content = repo.prepared_text(&prepared, "AGENTS.md");
        assert!(content.ends_with("## New rule\n\nCheck output.\n"));
        assert!(!content.contains("private observation"));
        assert_eq!(
            repo.prepared_text(&prepared, "docs/project.md"),
            "# Project\n"
        );
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "# Rules\n"
        );
        assert!(git(&repo.0, &["status", "--porcelain"]).unwrap().is_empty());
        assert_eq!(prepared.revision(), proposal.revision());
        assert_eq!(
            git(
                prepared.artifact(),
                &[
                    "diff",
                    "--name-only",
                    prepared.revision(),
                    prepared.reference()
                ]
            )
            .unwrap(),
            "AGENTS.md"
        );
        assert!(git(&repo.0, &["for-each-ref", "refs/sail/knowledge"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn discarded_text_is_absent_from_source_objects() {
        let repo = Repo::new();
        let private_text = "private proposal 592-unique-sentence";
        let proposal = preview(
            &repo.0,
            Repo::memory(),
            Path::new("AGENTS.md"),
            private_text,
            true,
        )
        .unwrap();
        let prepared = repo.accept(&proposal, true).unwrap();
        let artifact = prepared.artifact().to_owned();
        let blob = git(
            &artifact,
            &["rev-parse", &format!("{}:AGENTS.md", prepared.reference())],
        )
        .unwrap();
        assert!(!Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["cat-file", "-e", &blob])
            .status()
            .unwrap()
            .success());
        discard(&repo.0, &prepared).unwrap();
        assert!(!artifact.exists());
        assert!(!Command::new("git")
            .arg("-C")
            .arg(&repo.0)
            .args(["cat-file", "-e", &blob])
            .status()
            .unwrap()
            .success());
        assert!(git(&repo.0, &["fsck", "--unreachable", "--no-reflogs"])
            .unwrap()
            .is_empty());
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
        assert!(repo.accept(&proposal, false).is_err());
        fs::write(repo.0.join("AGENTS.md"), "updated elsewhere\n").unwrap();
        assert!(repo.accept(&proposal, true).is_err());
        assert!(git(&repo.0, &["for-each-ref", "refs/sail/knowledge"])
            .unwrap()
            .is_empty());
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "updated elsewhere\n"
        );
    }

    #[test]
    fn editor_save_after_review_does_not_change_the_prepared_diff() {
        let repo = Repo::new();
        let proposal = repo.preview();
        let prepared = repo.accept(&proposal, true).unwrap();
        fs::write(repo.0.join("AGENTS.md"), "editor's newer text\n").unwrap();
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "editor's newer text\n"
        );
        assert_eq!(
            repo.prepared_text(&prepared, "AGENTS.md"),
            "# Rules\n\n## New rule\n\nCheck output.\n"
        );
        assert_eq!(
            git(
                prepared.artifact(),
                &[
                    "diff",
                    "--name-only",
                    prepared.revision(),
                    prepared.reference()
                ]
            )
            .unwrap(),
            "AGENTS.md"
        );
    }

    #[test]
    fn editor_save_during_acceptance_leaves_no_proposal_ref() {
        let repo = Repo::new();
        let proposal = repo.preview();
        let result = accept_with(
            &repo.0,
            &proposal,
            true,
            || {
                fs::write(repo.0.join("AGENTS.md"), "editor's concurrent save\n").unwrap();
            },
            |_, _, _| {},
        );
        assert!(result.is_err());
        assert_eq!(
            fs::read_to_string(repo.0.join("AGENTS.md")).unwrap(),
            "editor's concurrent save\n"
        );
        assert!(git(&repo.0, &["for-each-ref", "refs/sail/knowledge"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn inherited_git_environment_cannot_redirect_proposal_writes() {
        if std::env::var_os("SAIL_KNOWLEDGE_ENV_TEST_CHILD").is_none() {
            assert!(Command::new(std::env::current_exe().unwrap())
                .args([
                    "--exact",
                    "tests::inherited_git_environment_cannot_redirect_proposal_writes",
                ])
                .env("SAIL_KNOWLEDGE_ENV_TEST_CHILD", "1")
                .status()
                .unwrap()
                .success());
            return;
        }

        let repo = Repo::new();
        let source_index = repo.0.join(".git/index");
        std::thread::sleep(std::time::Duration::from_millis(1100));
        fs::write(repo.0.join("AGENTS.md"), "# Rules\n").unwrap();
        let index_before = fs::read(&source_index).unwrap();
        std::env::set_var("GIT_OBJECT_DIRECTORY", repo.0.join(".git/objects"));
        std::env::set_var("GIT_INDEX_FILE", repo.0.join("nonexistent-index"));
        std::env::set_var(
            "GIT_ALTERNATE_OBJECT_DIRECTORIES",
            repo.0.join("no-alternates"),
        );
        std::env::set_var("GIT_DIR", repo.0.join("no-git-dir"));
        std::env::set_var("GIT_COMMON_DIR", repo.0.join("no-common-dir"));
        std::env::set_var("GIT_WORK_TREE", repo.0.join("no-work-tree"));
        std::env::set_var("GIT_NAMESPACE", "another-namespace");
        let proposal = repo.preview();
        let prepared = repo.accept(&proposal, true).unwrap();
        let blob = git(
            prepared.artifact(),
            &["rev-parse", &format!("{}:AGENTS.md", prepared.reference())],
        )
        .unwrap();
        assert_eq!(fs::read(&source_index).unwrap(), index_before);
        assert!(!git_command()
            .arg("-C")
            .arg(&repo.0)
            .args(["cat-file", "-e", &blob])
            .status()
            .unwrap()
            .success());
        discard(&repo.0, &prepared).unwrap();
    }

    #[test]
    fn changed_ref_survives_failed_acceptance_cleanup() {
        let repo = Repo::new();
        let proposal = repo.preview();
        let other_tree = git(&repo.0, &["rev-parse", "HEAD^{tree}"]).unwrap();
        let retained = RefCell::new(None);
        let result = accept_with(
            &repo.0,
            &proposal,
            true,
            || {},
            |artifact, reference, tree| {
                retained.replace(Some((artifact.to_owned(), reference.to_owned())));
                assert!(git_command()
                    .arg("--git-dir")
                    .arg(artifact)
                    .args(["update-ref", reference, &other_tree, tree])
                    .status()
                    .unwrap()
                    .success());
                fs::write(repo.0.join("AGENTS.md"), "changed concurrently\n").unwrap();
            },
        );
        assert!(result.unwrap_err().contains("artifact retained"));
        let (artifact, reference) = retained.into_inner().unwrap();
        assert_eq!(
            git(&artifact, &["rev-parse", &reference]).unwrap(),
            other_tree
        );
        fs::remove_dir_all(artifact.parent().unwrap()).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn swapped_docs_directory_cannot_redirect_proposal_write() {
        let repo = Repo::new();
        let proposal = preview(
            &repo.0,
            Repo::memory(),
            Path::new("docs/project.md"),
            "## New rule",
            true,
        )
        .unwrap();
        let outside = repo.0.join("outside");
        fs::create_dir(&outside).unwrap();
        fs::write(outside.join("project.md"), "outside content\n").unwrap();
        fs::rename(repo.0.join("docs"), repo.0.join("old-docs")).unwrap();
        std::os::unix::fs::symlink(&outside, repo.0.join("docs")).unwrap();
        assert!(repo.accept(&proposal, true).is_err());
        assert_eq!(
            fs::read_to_string(outside.join("project.md")).unwrap(),
            "outside content\n"
        );
        assert!(git(&repo.0, &["for-each-ref", "refs/sail/knowledge"])
            .unwrap()
            .is_empty());
    }

    #[test]
    fn occupied_reference_is_not_replaced() {
        let repo = Repo::new();
        let proposal = repo.preview();
        let prepared = repo.accept(&proposal, true).unwrap();
        let tree = git(&repo.0, &["rev-parse", "HEAD^{tree}"]).unwrap();
        let occupied = "refs/sail/knowledge/occupied";
        let free = "refs/sail/knowledge/free";
        assert!(Command::new("git")
            .arg("--git-dir")
            .arg(prepared.artifact())
            .args(["update-ref", occupied, &tree])
            .status()
            .unwrap()
            .success());
        let mut candidates = [occupied, free].into_iter();
        assert_eq!(
            publish_tree_with(prepared.artifact(), &tree, || candidates
                .next()
                .unwrap()
                .to_owned())
            .unwrap(),
            free
        );
        assert_eq!(
            git(prepared.artifact(), &["rev-parse", occupied]).unwrap(),
            tree
        );
        delete_tree_ref(prepared.artifact(), occupied, &tree).unwrap();
        delete_tree_ref(prepared.artifact(), free, &tree).unwrap();
    }

    #[test]
    fn discard_removes_only_the_exact_prepared_tree() {
        let repo = Repo::new();
        let proposal = repo.preview();
        let prepared = repo.accept(&proposal, true).unwrap();
        let other_tree = git(&repo.0, &["rev-parse", "HEAD^{tree}"]).unwrap();
        assert!(Command::new("git")
            .arg("--git-dir")
            .arg(prepared.artifact())
            .args([
                "update-ref",
                prepared.reference(),
                &other_tree,
                &prepared.tree
            ])
            .status()
            .unwrap()
            .success());
        assert!(discard(&repo.0, &prepared).is_err());
        assert_eq!(
            git(prepared.artifact(), &["rev-parse", prepared.reference()]).unwrap(),
            other_tree
        );
        assert!(Command::new("git")
            .arg("--git-dir")
            .arg(prepared.artifact())
            .args([
                "update-ref",
                prepared.reference(),
                &prepared.tree,
                &other_tree
            ])
            .status()
            .unwrap()
            .success());
    }

    #[test]
    fn changed_revision_requires_fresh_review() {
        let repo = Repo::new();
        let proposal = repo.preview();
        fs::write(repo.0.join("docs/project.md"), "new version\n").unwrap();
        repo.git(&["add", "docs/project.md"]);
        repo.git(&["commit", "-qm", "next"]);
        assert!(repo.accept(&proposal, true).is_err());
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
        assert!(repo.accept(&proposal, true).is_err());
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
        assert!(repo.accept(&proposal, true).is_err());
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
            assert!(repo.accept(&proposal, true).is_err());
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

    #[test]
    fn unicode_document_requires_one_visible_tracked_index_entry() {
        let repo = Repo::new();
        let name = "docs/café.md";
        fs::write(repo.0.join(name), "# Café\n").unwrap();
        assert!(preview(&repo.0, Repo::memory(), Path::new(name), "add", true).is_err());
        repo.git(&["add", name]);
        repo.git(&["commit", "-qm", "add unicode document"]);
        let proposal = preview(&repo.0, Repo::memory(), Path::new(name), "  code\n", true).unwrap();
        let prepared = repo.accept(&proposal, true).unwrap();
        assert_eq!(repo.prepared_text(&prepared, name), "# Café\n\n  code\n");
        assert_eq!(fs::read_to_string(repo.0.join(name)).unwrap(), "# Café\n");

        repo.git(&["update-index", "--assume-unchanged", name]);
        assert!(preview(&repo.0, Repo::memory(), Path::new(name), "add", true).is_err());
        repo.git(&["update-index", "--no-assume-unchanged", name]);
        repo.git(&["update-index", "--skip-worktree", name]);
        assert!(preview(&repo.0, Repo::memory(), Path::new(name), "add", true).is_err());
    }

    #[test]
    fn malformed_or_ambiguous_index_response_is_rejected() {
        let name = "docs/café.md";
        assert!(plain_index_entry(format!("H {name}\0").as_bytes(), name));
        for response in [
            format!("H {name}"),
            format!("h {name}\0"),
            format!("S {name}\0"),
            "H docs/other.md\0".to_string(),
            format!("H {name}\0H {name}\0"),
            format!("H {name}\0garbage"),
        ] {
            assert!(
                !plain_index_entry(response.as_bytes(), name),
                "{response:?}"
            );
        }
    }

    #[test]
    fn proposed_markdown_spacing_survives_preview_and_acceptance() {
        let repo = Repo::new();
        let text = "    indented code  \n\n  next line\t\n\n";
        let proposal =
            preview(&repo.0, Repo::memory(), Path::new("AGENTS.md"), text, true).unwrap();
        assert!(proposal.diff().contains("+    indented code  \n"));
        assert!(proposal.diff().contains("+  next line\t\n+\n"));
        let prepared = repo.accept(&proposal, true).unwrap();
        assert_eq!(
            repo.prepared_text(&prepared, "AGENTS.md"),
            format!("# Rules\n\n{text}")
        );
        assert!(preview(
            &repo.0,
            Repo::memory(),
            Path::new("docs/project.md"),
            " \n\t ",
            true
        )
        .is_err());
    }
}
