use serde::Serialize;
use serde_json::json;
use std::collections::HashSet;
use tauri::Emitter;

const MAX_CAPTURE_BYTES: usize = 32 * 1024;
const MAX_CANDIDATE_CHARS: usize = 500;
const MAX_CANDIDATES: usize = 5;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryCaptureCandidate {
    pub directory: String,
    pub agent: String,
    pub session_id: String,
    pub kind: &'static str,
    pub content: String,
    pub confirmation_reason: Option<&'static str>,
}

#[derive(Default)]
pub struct TurnCapture {
    text: String,
    overflow: bool,
}

impl TurnCapture {
    pub fn push(&mut self, text: &str, new_message: bool) {
        if self.overflow {
            return;
        }
        let separator = usize::from(new_message && !self.text.is_empty());
        if self
            .text
            .len()
            .saturating_add(separator)
            .saturating_add(text.len())
            > MAX_CAPTURE_BYTES
        {
            self.text.clear();
            self.overflow = true;
            return;
        }
        if separator == 1 {
            self.text.push('\n');
        }
        self.text.push_str(text);
    }

    pub fn candidates(
        &self,
        directory: &str,
        agent: &str,
        session_id: &str,
    ) -> Vec<MemoryCaptureCandidate> {
        if self.overflow {
            return Vec::new();
        }
        candidates(&self.text, directory, agent, session_id)
    }

    pub fn completed_candidates(
        &self,
        status: &str,
        stop_reason: Option<&str>,
        explicitly_cancelled: bool,
        directory: &str,
        agent: &str,
        session_id: &str,
    ) -> Vec<MemoryCaptureCandidate> {
        if explicitly_cancelled || status != "done" || stop_reason != Some("end_turn") {
            return Vec::new();
        }
        self.candidates(directory, agent, session_id)
    }
}

fn kind(value: &str) -> crate::memory::MemoryKind {
    match value {
        "decision" => crate::memory::MemoryKind::Decision,
        "constraint" => crate::memory::MemoryKind::Constraint,
        "discovery" => crate::memory::MemoryKind::Discovery,
        "preference" => crate::memory::MemoryKind::Preference,
        "handoff" => crate::memory::MemoryKind::Handoff,
        _ => crate::memory::MemoryKind::Other,
    }
}

fn enabled(app: &tauri::AppHandle, directory: &str) -> Result<bool, String> {
    if crate::memory::mode(app, directory)? == "off" {
        return Ok(false);
    }
    let project_key = crate::memory::memory_project_key(directory.to_string())?;
    let settings = crate::settings::load_settings(app.clone())?;
    Ok(settings
        .get(&format!("sai-memory-auto-capture:{project_key}"))
        .is_some_and(|value| value == "true"))
}

pub fn store_completed(app: &tauri::AppHandle, candidates: Vec<MemoryCaptureCandidate>) {
    if candidates.is_empty() {
        return;
    }
    let app = app.clone();
    std::thread::spawn(move || {
        for candidate in candidates {
            match enabled(&app, &candidate.directory) {
                Ok(false) => continue,
                Err(error) => {
                    crate::diagnostics::record(
                        "memory_capture_failed",
                        json!({"agent":candidate.agent,"sessionId":candidate.session_id,
                            "stage":"settings","error":error}),
                    );
                    continue;
                }
                Ok(true) => {}
            }
            if candidate.confirmation_reason.is_some() {
                let _ = app.emit("memory:capture-candidate", candidate);
                continue;
            }
            let input = crate::memory::MemoryInput {
                content: candidate.content,
                kind: Some(kind(candidate.kind)),
                tags: Some(vec!["automatic-capture".into()]),
                provenance: Some(crate::memory::MemoryProvenance {
                    agent: Some(candidate.agent.clone()),
                    session_id: Some(candidate.session_id.clone()),
                }),
            };
            if let Err(error) = crate::memory::remember(&app, &candidate.directory, input) {
                crate::diagnostics::record(
                    "memory_capture_failed",
                    json!({"agent":candidate.agent,"sessionId":candidate.session_id,
                        "stage":"store","error":error}),
                );
            }
        }
    });
}

fn strip_marker(line: &str) -> &str {
    line.trim()
        .trim_start_matches(|character: char| {
            matches!(
                character,
                '-' | '*' | '+' | '>' | '#' | '0'..='9' | '.' | ')' | ' '
            )
        })
        .trim()
}

fn classify(line: &str) -> Option<(&'static str, Option<&'static str>)> {
    let lower = line.to_ascii_lowercase();
    let marked = |name: &str| lower.starts_with(&format!("{name}:"));
    if marked("preference")
        || lower.contains(" prefer ")
        || lower.starts_with("prefer ")
        || lower.contains(" preference ")
    {
        return Some(("preference", Some("broader_scope")));
    }
    if marked("handoff")
        || lower.contains("next step")
        || lower.contains("remaining work")
        || lower.contains("left to do")
    {
        return Some(("handoff", None));
    }
    if marked("decision")
        || lower.contains(" decided ")
        || lower.starts_with("decided ")
        || lower.contains("we will use ")
        || lower.contains("we chose ")
    {
        return Some(("decision", None));
    }
    if marked("constraint")
        || lower.contains(" must ")
        || lower.starts_with("must ")
        || lower.contains(" cannot ")
        || lower.contains(" is required")
    {
        return Some(("constraint", None));
    }
    if marked("discovery")
        || lower.contains("root cause")
        || lower.contains("found that ")
        || lower.contains("discovered that ")
    {
        return Some(("discovery", None));
    }
    None
}

fn is_refusal(line: &str) -> bool {
    let lower = line.to_ascii_lowercase();
    [
        "i cannot provide",
        "i can't provide",
        "i cannot help",
        "i can't help",
        "i cannot comply",
        "i can't comply",
        "i am unable to",
        "i'm unable to",
        "i’m unable to",
        "i must refuse",
        "i refuse",
    ]
    .iter()
    .any(|phrase| lower.contains(phrase))
}

fn redact_sensitive_codes(line: &str) -> String {
    const LABELS: [&str; 7] = [
        "pin",
        "passcode",
        "otp",
        "one-time code",
        "one time code",
        "recovery code",
        "verification code",
    ];
    let lower = line.to_ascii_lowercase();
    let bounded_label = |label: &str| {
        lower.match_indices(label).find_map(|(index, _)| {
            let before = lower[..index].chars().next_back();
            let after = lower[index + label.len()..].chars().next();
            (!before.is_some_and(char::is_alphanumeric)
                && !after.is_some_and(char::is_alphanumeric))
            .then_some(index)
        })
    };
    let Some(label_start) = LABELS.iter().filter_map(|label| bounded_label(label)).min() else {
        return line.to_string();
    };
    let mut ranges = Vec::new();
    let mut start = None;
    for (index, character) in line
        .char_indices()
        .filter(|(index, _)| *index >= label_start)
    {
        if character.is_ascii_digit() {
            start.get_or_insert(index);
        } else if let Some(value_start) = start.take() {
            let digits = index - value_start;
            if (4..=12).contains(&digits) {
                ranges.push((value_start, index));
            }
        }
    }
    if let Some(value_start) = start {
        let digits = line.len() - value_start;
        if (4..=12).contains(&digits) {
            ranges.push((value_start, line.len()));
        }
    }
    if ranges.is_empty() {
        return line.to_string();
    }
    let mut redacted = String::with_capacity(line.len());
    let mut copied = 0;
    for (start, end) in ranges {
        redacted.push_str(&line[copied..start]);
        redacted.push_str("[redacted]");
        copied = end;
    }
    redacted.push_str(&line[copied..]);
    redacted
}

fn truncate_chars(value: &str, limit: usize) -> String {
    if value.chars().count() <= limit {
        return value.to_string();
    }
    value.chars().take(limit).collect::<String>() + "…"
}

fn candidates(
    text: &str,
    directory: &str,
    agent: &str,
    session_id: &str,
) -> Vec<MemoryCaptureCandidate> {
    let mut found = Vec::new();
    let mut seen = HashSet::new();
    let mut redactor = crate::stderr_log::Redactor::default();
    for raw in text.lines() {
        let line = strip_marker(raw);
        let redacted = redact_sensitive_codes(&redactor.redact(line, &[]));
        if is_refusal(line) {
            continue;
        }
        let Some((kind, broader_reason)) = classify(line) else {
            continue;
        };
        if line.len() < 8 {
            continue;
        }
        let sensitive = redacted != line;
        let content = truncate_chars(redacted.trim(), MAX_CANDIDATE_CHARS);
        if content.is_empty() || !seen.insert((kind, content.clone())) {
            continue;
        }
        found.push(MemoryCaptureCandidate {
            directory: directory.to_string(),
            agent: agent.to_string(),
            session_id: session_id.to_string(),
            kind,
            content,
            confirmation_reason: sensitive.then_some("sensitive").or(broader_reason),
        });
        if found.len() == MAX_CANDIDATES {
            break;
        }
    }
    found
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extracts_only_curated_memory_kinds() {
        let capture = TurnCapture {
            text: [
                "All tests pass.",
                "Decision: We chose SQLite for durable local storage.",
                "Constraint: The provider must never block session startup.",
                "Discovery: The root cause is an incorrect project key.",
                "Handoff: Remaining work is wiring the settings UI.",
                "Preference: The user prefers compact summaries.",
            ]
            .join("\n"),
            overflow: false,
        };
        let candidates = capture.candidates("/repo", "codex", "session");
        assert_eq!(candidates.len(), 5);
        assert_eq!(candidates[0].kind, "decision");
        assert_eq!(candidates[4].confirmation_reason, Some("broader_scope"));
    }

    #[test]
    fn redacts_secrets_before_emitting_a_confirmation_candidate() {
        let capture = TurnCapture {
            text: "Constraint: API_KEY=sk-0123456789abcdefghijklmnop".into(),
            overflow: false,
        };
        let candidates = capture.candidates("/repo", "codex", "session");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].confirmation_reason, Some("sensitive"));
        assert!(!candidates[0].content.contains("sk-0123456789"));
        assert!(candidates[0].content.contains("[redacted]"));
    }

    #[test]
    fn overflow_discards_partial_turn_content() {
        let mut capture = TurnCapture::default();
        capture.push(&"x".repeat(MAX_CAPTURE_BYTES), false);
        capture.push("Decision: save this incomplete tail", false);
        assert!(capture.candidates("/repo", "codex", "session").is_empty());
    }

    #[test]
    fn bounds_and_deduplicates_candidates() {
        let line = "Decision: We chose the repository formatter.";
        let capture = TurnCapture {
            text: std::iter::repeat_n(line, 8).collect::<Vec<_>>().join("\n"),
            overflow: false,
        };
        assert_eq!(capture.candidates("/repo", "codex", "session").len(), 1);
    }

    #[test]
    fn failed_interrupted_and_tool_only_turns_produce_nothing() {
        let capture = TurnCapture {
            text: "Decision: We chose SQLite.".into(),
            overflow: false,
        };
        for status in ["failed", "interrupted"] {
            assert!(capture
                .completed_candidates(status, Some("end_turn"), false, "/repo", "codex", "session")
                .is_empty());
        }
        assert!(TurnCapture::default()
            .completed_candidates("done", Some("end_turn"), false, "/repo", "codex", "session")
            .is_empty());
    }

    #[test]
    fn partial_and_refused_completions_produce_nothing() {
        let capture = TurnCapture {
            text: "Decision: We chose SQLite.".into(),
            overflow: false,
        };
        let cases = [
            ("missing reason", None),
            ("token limit", Some("max_tokens")),
            ("turn limit", Some("max_turn_requests")),
            ("refusal", Some("refusal")),
            ("cancellation", Some("cancelled")),
        ];
        for (name, stop_reason) in cases {
            assert!(
                capture
                    .completed_candidates("done", stop_reason, false, "/repo", "codex", "session")
                    .is_empty(),
                "{name}"
            );
        }
    }

    #[test]
    fn natural_completion_produces_candidates() {
        let capture = TurnCapture {
            text: "Decision: We chose SQLite.".into(),
            overflow: false,
        };
        assert_eq!(
            capture
                .completed_candidates("done", Some("end_turn"), false, "/repo", "codex", "session")
                .len(),
            1
        );
    }

    #[test]
    fn explicitly_cancelled_completion_produces_nothing() {
        let capture = TurnCapture {
            text: "Decision: We chose SQLite.".into(),
            overflow: false,
        };

        let candidates = capture.completed_candidates(
            "done",
            Some("end_turn"),
            true,
            "/repo",
            "codex",
            "session",
        );

        assert!(candidates.is_empty());
    }

    #[test]
    fn numeric_recovery_codes_are_redacted_and_require_confirmation() {
        let capture = TurnCapture {
            text: "Decision: Our recovery PIN is 123456.".into(),
            overflow: false,
        };

        let candidates = capture.candidates("/repo", "codex", "session");

        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].confirmation_reason, Some("sensitive"));
        assert_eq!(
            candidates[0].content,
            "Decision: Our recovery PIN is [redacted]."
        );
    }

    #[test]
    fn refusal_language_is_never_captured() {
        let capture = TurnCapture {
            text: "Constraint: I cannot provide that information.".into(),
            overflow: false,
        };

        let candidates = capture.completed_candidates(
            "done",
            Some("end_turn"),
            false,
            "/repo",
            "codex",
            "session",
        );

        assert!(candidates.is_empty());
    }
}
