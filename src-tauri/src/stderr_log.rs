//! Bounded, redacted forwarding of adapter stderr to the diagnostics log.
//!
//! Limits per adapter process (a restarted adapter gets a fresh budget):
//! - at most `MAX_LINES` lines and `MAX_FORWARDED_BYTES` bytes are forwarded;
//!   the first lines are kept, later lines are only counted as dropped.
//! - each forwarded line is cut to `MAX_LINE_BYTES` bytes after redaction.
//! - at most `MAX_RAW_LINE_BYTES` bytes of one line are ever buffered.
//!
//! Redaction runs before truncation so a cut cannot leave half a secret.

use serde_json::{json, Value};
use std::io::Read;

pub const MAX_LINES: usize = 48;
pub const MAX_FORWARDED_BYTES: usize = 12 * 1024;
pub const MAX_LINE_BYTES: usize = 512;
const MAX_RAW_LINE_BYTES: usize = 8 * 1024;
const OVERFLOW_GUARD_BYTES: usize = 128;
const MIN_SECRET_LEN: usize = 8;
const REDACTED: &str = "[redacted]";
const REDACTED_WORD: &str = "redacted";

const SENSITIVE_KEYS: [&str; 17] = [
    "token",
    "secret",
    "password",
    "passwd",
    "apikey",
    "api_key",
    "api-key",
    "authorization",
    "credential",
    "private_key",
    "cookie",
    "passphrase",
    "access_key",
    "accesskey",
    "sessionid",
    "session_id",
    "session-id",
];
const SECRET_PREFIXES: [&str; 12] = [
    "sk-",
    "ghp_",
    "gho_",
    "ghu_",
    "ghs_",
    "ghr_",
    "github_pat_",
    "xoxb-",
    "xoxp-",
    "xoxa-",
    "xoxs-",
    "AIza",
];

fn is_word(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '.' | '~' | '+' | '/')
}

fn is_sensitive_key(word: &str) -> bool {
    let lower = word.to_ascii_lowercase();
    lower == "auth" || SENSITIVE_KEYS.iter().any(|key| lower.contains(key))
}

fn looks_like_secret(word: &str) -> bool {
    let long_enough = |prefix: &str| word.len() >= prefix.len() + 8;
    if SECRET_PREFIXES
        .iter()
        .any(|prefix| word.starts_with(prefix) && long_enough(prefix))
    {
        return true;
    }
    if word.starts_with("AKIA") && word.len() >= 20 {
        return true;
    }
    word.starts_with("eyJ") && word.split('.').count() == 3 && word.len() >= 20
}

fn redact_userinfo(line: &str) -> String {
    let mut output = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(index) = rest.find("://") {
        let (head, tail) = rest.split_at(index + 3);
        output.push_str(head);
        let end = tail
            .find(|c: char| c.is_whitespace() || matches!(c, '/' | '"' | '\'' | '?' | '#'))
            .unwrap_or(tail.len());
        match tail[..end].rfind('@') {
            Some(at) => {
                output.push_str(REDACTED);
                rest = &tail[at..];
            }
            None => rest = tail,
        }
    }
    output.push_str(rest);
    output
}

#[derive(Default)]
pub struct Redactor {
    pending_value: bool,
}

fn is_separator(c: char) -> bool {
    matches!(c, ':' | '=')
}

fn value_end(chars: &[char], start: usize) -> usize {
    let Some(&first) = chars.get(start) else {
        return start;
    };
    if matches!(first, '"' | '\'') {
        return chars[start + 1..]
            .iter()
            .position(|&c| c == first)
            .map_or(chars.len(), |offset| start + 2 + offset);
    }
    chars[start..]
        .iter()
        .position(|&c| c.is_whitespace() || matches!(c, ',' | ';' | '}' | ']'))
        .map_or(chars.len(), |offset| start + offset)
}

fn skip_blanks(chars: &[char], mut index: usize) -> usize {
    while index < chars.len() && chars[index].is_whitespace() {
        index += 1;
    }
    index
}

impl Redactor {
    /// Remove secrets from one line of adapter output.
    ///
    /// `secrets` are exact values (for example `SAIL_BROWSER_TOKEN`s);
    /// credential-shaped words and values of sensitive keys are removed too.
    /// A sensitive key at the end of a line redacts the start of the next one.
    pub fn redact(&mut self, line: &str, secrets: &[String]) -> String {
        let mut text: String = line
            .chars()
            .map(|c| if c.is_control() && c != '\t' { ' ' } else { c })
            .collect();
        for secret in secrets {
            if secret.len() >= MIN_SECRET_LEN {
                text = text.replace(secret.as_str(), REDACTED);
            }
        }
        let text = redact_userinfo(&text);
        let chars: Vec<char> = text.chars().collect();
        let mut output = String::with_capacity(text.len());
        let mut index = 0;
        if std::mem::take(&mut self.pending_value) {
            let start = skip_blanks(&chars, 0);
            let end = value_end(&chars, start);
            output.extend(&chars[..start]);
            if end > start {
                output.push_str(REDACTED);
            }
            index = end;
        }
        let mut redact_next = false;
        while index < chars.len() {
            if !is_word(chars[index]) {
                output.push(chars[index]);
                index += 1;
                continue;
            }
            let start = index;
            while index < chars.len() && is_word(chars[index]) {
                index += 1;
            }
            let word: String = chars[start..index].iter().collect();
            if word == REDACTED_WORD {
                output.push_str(&word);
                continue;
            }
            let lower = word.to_ascii_lowercase();
            if redact_next {
                redact_next = false;
                output.push_str(REDACTED);
                continue;
            }
            if looks_like_secret(&word) {
                output.push_str(REDACTED);
                continue;
            }
            output.push_str(&word);
            if matches!(lower.as_str(), "bearer" | "basic") {
                redact_next = true;
                continue;
            }
            if !is_sensitive_key(&word) {
                continue;
            }
            let mut cursor = index;
            while cursor < chars.len() && matches!(chars[cursor], ' ' | '"' | '\'' | '\t') {
                cursor += 1;
            }
            let separated = cursor < chars.len() && is_separator(chars[cursor]);
            if !separated && !word.starts_with("--") {
                continue;
            }
            if separated {
                cursor += 1;
            } else {
                cursor = index;
            }
            let value_start = skip_blanks(&chars, cursor);
            output.extend(&chars[index..value_start]);
            if lower.contains("cookie") {
                output.push_str(REDACTED);
                break;
            }
            if value_start >= chars.len() {
                self.pending_value = true;
                break;
            }
            let mut end = value_end(&chars, value_start);
            let value: String = chars[value_start..end].iter().collect();
            if matches!(
                value.to_ascii_lowercase().as_str(),
                "bearer" | "basic" | "token"
            ) {
                end = value_end(&chars, skip_blanks(&chars, end));
            }
            output.push_str(REDACTED);
            index = end;
        }
        output
    }
}

#[cfg(test)]
fn redact(line: &str, secrets: &[String]) -> String {
    Redactor::default().redact(line, secrets)
}

fn truncate_utf8(mut text: String, max: usize) -> String {
    if text.len() <= max {
        return text;
    }
    let mut end = max;
    while !text.is_char_boundary(end) {
        end -= 1;
    }
    text.truncate(end);
    text.push('…');
    text
}

#[derive(Debug, Default, PartialEq, Eq)]
pub struct StderrSummary {
    pub total_bytes: u64,
    pub forwarded_lines: u64,
    pub forwarded_bytes: u64,
    pub dropped_lines: u64,
}

impl StderrSummary {
    pub fn dropped_bytes(&self) -> u64 {
        self.total_bytes.saturating_sub(self.forwarded_bytes)
    }
}

#[derive(Default)]
struct LineLimiter {
    pending: Vec<u8>,
    overflowed: bool,
    redactor: Redactor,
    summary: StderrSummary,
}

impl LineLimiter {
    fn push(&mut self, chunk: &[u8], secrets: &[String], out: &mut Vec<String>) {
        self.summary.total_bytes = self.summary.total_bytes.saturating_add(chunk.len() as u64);
        for &byte in chunk {
            if byte == b'\n' {
                self.finish_line(secrets, out);
            } else if self.pending.len() < MAX_RAW_LINE_BYTES {
                self.pending.push(byte);
            } else {
                self.overflowed = true;
            }
        }
    }

    fn finish_line(&mut self, secrets: &[String], out: &mut Vec<String>) {
        let mut raw = std::mem::take(&mut self.pending);
        if std::mem::take(&mut self.overflowed) {
            raw.truncate(raw.len().saturating_sub(OVERFLOW_GUARD_BYTES));
        }
        let text = String::from_utf8_lossy(&raw);
        let text = text.trim();
        if text.is_empty() {
            return;
        }
        let line = truncate_utf8(self.redactor.redact(text, secrets), MAX_LINE_BYTES);
        let within_budget = (self.summary.forwarded_lines as usize) < MAX_LINES
            && self.summary.forwarded_bytes as usize + line.len() <= MAX_FORWARDED_BYTES;
        if within_budget {
            self.summary.forwarded_lines += 1;
            self.summary.forwarded_bytes += line.len() as u64;
            out.push(line);
        } else {
            self.summary.dropped_lines += 1;
        }
    }
}

/// Drain `reader`, send bounded redacted lines to `sink("agent_stderr_line", ..)`
/// and finish with one `agent_stderr` summary that keeps the total byte count.
pub fn forward(
    mut reader: impl Read,
    agent: &str,
    secrets: impl Fn() -> Vec<String>,
    mut sink: impl FnMut(&str, Value),
) {
    let mut limiter = LineLimiter::default();
    let mut buffer = [0; 4096];
    let mut lines = Vec::new();
    loop {
        let read = match reader.read(&mut buffer) {
            Ok(0) | Err(_) => break,
            Ok(read) => read,
        };
        limiter.push(&buffer[..read], &secrets(), &mut lines);
        for line in lines.drain(..) {
            sink("agent_stderr_line", json!({"agent":agent,"line":line}));
        }
    }
    limiter.finish_line(&secrets(), &mut lines);
    for line in lines.drain(..) {
        sink("agent_stderr_line", json!({"agent":agent,"line":line}));
    }
    let summary = limiter.summary;
    if summary.total_bytes > 0 {
        sink(
            "agent_stderr",
            json!({
                "agent":agent,
                "bytes":summary.total_bytes,
                "forwardedLines":summary.forwarded_lines,
                "forwardedBytes":summary.forwarded_bytes,
                "droppedLines":summary.dropped_lines,
                "droppedBytes":summary.dropped_bytes(),
            }),
        );
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(input: &[u8], secrets: Vec<String>) -> Vec<(String, Value)> {
        let mut events = Vec::new();
        forward(
            std::io::Cursor::new(input.to_vec()),
            "claude",
            move || secrets.clone(),
            |event, details| events.push((event.to_string(), details)),
        );
        events
    }

    fn lines(events: &[(String, Value)]) -> Vec<String> {
        events
            .iter()
            .filter(|(event, _)| event == "agent_stderr_line")
            .map(|(_, details)| details["line"].as_str().unwrap().to_string())
            .collect()
    }

    #[test]
    fn forwards_lines_with_agent_and_total_bytes() {
        let events = run(b"first failure\r\nsecond failure\n", vec![]);
        assert_eq!(lines(&events), ["first failure", "second failure"]);
        assert!(events
            .iter()
            .all(|(_, details)| details["agent"] == "claude"));
        let (event, summary) = events.last().unwrap();
        assert_eq!(event, "agent_stderr");
        assert_eq!(summary["bytes"], 30);
        assert_eq!(summary["droppedLines"], 0);
    }

    #[test]
    fn unterminated_final_line_is_forwarded() {
        let events = run(b"crashed", vec![]);
        assert_eq!(lines(&events), ["crashed"]);
    }

    #[test]
    fn empty_stderr_records_nothing() {
        assert!(run(b"", vec![]).is_empty());
    }

    #[test]
    fn volume_is_bounded_and_drops_are_counted() {
        let input = ("x".repeat(200) + "\n").repeat(10_000);
        let events = run(input.as_bytes(), vec![]);
        let forwarded = lines(&events);
        let bytes: usize = forwarded.iter().map(String::len).sum();
        assert!(forwarded.len() <= MAX_LINES);
        assert!(bytes <= MAX_FORWARDED_BYTES);
        let summary = &events.last().unwrap().1;
        assert_eq!(summary["bytes"], input.len() as u64);
        assert_eq!(summary["forwardedLines"], forwarded.len() as u64);
        assert_eq!(summary["droppedLines"], 10_000 - forwarded.len() as u64);
        assert_eq!(summary["droppedBytes"], input.len() as u64 - bytes as u64);
        assert!(events.len() <= MAX_LINES + 1);
    }

    #[test]
    fn long_lines_are_truncated_and_never_buffered_unbounded() {
        let input = "a".repeat(5 * 1024 * 1024) + "\nnext\n";
        let events = run(input.as_bytes(), vec![]);
        let forwarded = lines(&events);
        assert!(forwarded[0].len() <= MAX_LINE_BYTES + '…'.len_utf8());
        assert_eq!(forwarded[1], "next");
        assert_eq!(events.last().unwrap().1["bytes"], input.len() as u64);
    }

    #[test]
    fn truncation_keeps_utf8_valid() {
        let input = "é".repeat(600) + "\n";
        let forwarded = lines(&run(input.as_bytes(), vec![]));
        assert!(forwarded[0].len() <= MAX_LINE_BYTES + '…'.len_utf8());
    }

    #[test]
    fn redacts_browser_token_values_wherever_they_appear() {
        let token = "6f1c2d3e-aaaa-bbbb-cccc-0123456789ab".to_string();
        let input = format!(
            "SAIL_BROWSER_TOKEN={token}\nconnect http://127.0.0.1/{token}/x failed\n{{\"env\":{{\"SAIL_BROWSER_TOKEN\":\"{token}\"}}}}\n"
        );
        let events = run(input.as_bytes(), vec![token.clone()]);
        let out = lines(&events).join("\n");
        assert!(!out.contains(&token), "{out}");
        assert!(out.contains("SAIL_BROWSER_TOKEN"));
    }

    #[test]
    fn redacts_browser_token_even_when_not_in_known_list() {
        let out = redact("SAIL_BROWSER_TOKEN=abc123def456", &[]);
        assert!(!out.contains("abc123def456"), "{out}");
    }

    #[test]
    fn redacts_common_credentials() {
        let cases = [
            "key sk-ant-api03-AbCdEfGhIjKlMnOpQrStUv in env",
            "sk-proj-1234567890abcdefghij",
            "token ghp_abcdefghijklmnopqrstuvwxyz0123456789",
            "github_pat_11AAAAAAA0abcdefghijklmnop",
            "aws AKIAIOSFODNN7EXAMPLE used",
            "gcp AIzaSyA-abcdefghijklmnopqrstuvwxyz12345",
            "slack xoxb-123456789012-abcdefghijkl",
            "jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N",
            "Authorization: Bearer abcdef0123456789",
            "authorization: basic dXNlcjpwYXNz",
            "curl --api-key hunter2hunter2 now",
            "password=hunter2",
            "{\"apiKey\": \"hunter2\"}",
            "{\"password\":\"hunter2\"}",
            "connect postgres://admin:hunter2@db.local:5432/app",
            "Cookie: session=hunter2",
        ];
        let secrets = [
            "AbCdEfGhIjKlMnOpQrStUv",
            "1234567890abcdefghij",
            "abcdefghijklmnopqrstuvwxyz0123456789",
            "11AAAAAAA0abcdefghijklmnop",
            "AKIAIOSFODNN7EXAMPLE",
            "SyA-abcdefghijklmnopqrstuvwxyz12345",
            "123456789012-abcdefghijkl",
            "dozjgNryP4J3jVmNHl0w5N",
            "abcdef0123456789",
            "dXNlcjpwYXNz",
            "hunter2",
        ];
        for case in cases {
            let out = redact(case, &[]);
            for secret in secrets {
                assert!(!out.contains(secret), "{case:?} -> {out:?}");
            }
        }
    }

    #[test]
    fn redacts_whole_values_with_punctuation_and_spaces() {
        let cases = [
            ("password=p@ss!word", "ss!word"),
            ("SAIL_BROWSER_TOKEN=ab$cd%ef&gh", "cd%ef"),
            ("api_key=\"a b c d9z\" next", "d9z"),
            ("{\"password\": \"x y/z#9\", \"user\": \"bob\"}", "y/z#9"),
            ("--token ab!cd#ef", "cd#ef"),
            ("passphrase: correct horse", "correct horse"),
            ("access_key=AK/123+xyz", "123+xyz"),
            ("sessionid=abc.def!ghi", "def!ghi"),
        ];
        for (case, secret) in cases {
            let out = redact(case, &[]);
            assert!(!out.contains(secret), "{case:?} -> {out:?}");
        }
        assert!(redact("{\"password\": \"x\", \"user\": \"bob\"}", &[]).contains("bob"));
    }

    #[test]
    fn redacts_a_value_on_the_line_after_its_key() {
        let events = run(
            b"{\n  \"password\":\n    \"hunter2 and more\",\n  \"user\": \"bob\"\n}\n",
            vec![],
        );
        let out = lines(&events).join("\n");
        assert!(!out.contains("hunter2") && !out.contains("more"), "{out}");
        assert!(out.contains("bob"));
    }

    #[test]
    fn keeps_ordinary_diagnostics_readable() {
        let line = "Error: spawn npx ENOENT at /usr/bin/node:12 (invalid token provided)";
        assert_eq!(redact(line, &[]), line);
    }

    #[test]
    fn strips_control_sequences() {
        assert_eq!(redact("\u{1b}[31mfail\u{1b}[0m", &[]), " [31mfail [0m");
    }

    #[test]
    fn a_secret_at_the_raw_line_limit_is_not_left_half_written() {
        let secret = "sk-0123456789abcdefghijklmnop";
        let mut input = "a ".repeat(MAX_RAW_LINE_BYTES / 2 - 10);
        input.push_str(secret);
        input.push_str(&"b".repeat(1000));
        input.push('\n');
        let out = lines(&run(input.as_bytes(), vec![])).join("");
        assert!(!out.contains("sk-0123"), "{out}");
    }
}
