//! Idle-thread bookkeeping. A Codex app-server or Claude adapter keeps one set of MCP servers for
//! every thread it has loaded, so a finished thread nobody is looking at is closed after an idle
//! timeout.

use serde_json::Value;
use std::collections::{HashMap, HashSet};
use std::sync::atomic::{AtomicU64, Ordering};
use std::time::{Duration, Instant};

const DEFAULT_IDLE_SECONDS: u64 = 10 * 60;
const NO_OVERRIDE: u64 = u64::MAX;

static OVERRIDE_SECONDS: AtomicU64 = AtomicU64::new(NO_OVERRIDE);

/// Lets an E2E run shorten the timeout without restarting the shared app process.
#[cfg(feature = "e2e")]
pub fn override_idle_seconds(seconds: Option<u64>) {
    OVERRIDE_SECONDS.store(seconds.unwrap_or(NO_OVERRIDE), Ordering::Release);
}

/// How long a finished thread may stay loaded unseen. `SAIL_ACP_IDLE_CLOSE_SECS=0` disables closing.
pub fn idle_timeout() -> Option<Duration> {
    let overridden = OVERRIDE_SECONDS.load(Ordering::Acquire);
    let seconds = if overridden == NO_OVERRIDE {
        std::env::var("SAIL_ACP_IDLE_CLOSE_SECS")
            .ok()
            .and_then(|value| value.trim().parse::<u64>().ok())
            .unwrap_or(DEFAULT_IDLE_SECONDS)
    } else {
        overridden
    };
    (seconds > 0).then(|| Duration::from_secs(seconds))
}

/// What a caller that needs a closed session finds when it asks to reattach it.
#[derive(Debug, PartialEq, Eq)]
pub enum ResumeClaim {
    /// The session is loaded; nothing to resume.
    Open,
    /// A close or another caller's resume is in flight; ask again shortly.
    Wait,
    /// The caller resumes the session and must call `end_resume`.
    Claimed,
}

#[derive(Default)]
pub struct IdleSessions {
    touched: HashMap<String, Instant>,
    closed: HashSet<String>,
    closing: HashSet<String>,
    resuming: HashSet<String>,
    fresh: HashSet<String>,
    background: HashSet<String>,
    async_tasks: HashMap<String, HashSet<String>>,
}

impl IdleSessions {
    pub fn touch(&mut self, session_id: &str, now: Instant) {
        self.touched.insert(session_id.to_string(), now);
    }

    /// A session nobody touched yet counts as touched now, so a fresh attach never closes at once.
    pub fn expired(&mut self, session_id: &str, now: Instant, idle: Duration) -> bool {
        let touched = *self.touched.entry(session_id.to_string()).or_insert(now);
        now.saturating_duration_since(touched) >= idle
    }

    /// Starts a close: reattaches wait for `end_close` so a resume never races the adapter teardown.
    pub fn begin_close(&mut self, session_id: &str) {
        self.closed.insert(session_id.to_string());
        self.closing.insert(session_id.to_string());
        self.async_tasks.remove(session_id);
    }

    pub fn end_close(&mut self, session_id: &str) {
        self.closing.remove(session_id);
    }

    #[cfg(test)]
    pub fn is_closing(&self, session_id: &str) -> bool {
        self.closing.contains(session_id)
    }

    /// A deleted thread keeps no idle state, so nothing can reopen it. A resume in flight stays
    /// claimed: its guard releases the claim.
    pub fn forget(&mut self, session_id: &str) {
        self.touched.remove(session_id);
        self.closed.remove(session_id);
        self.closing.remove(session_id);
        self.fresh.remove(session_id);
        self.background.remove(session_id);
        self.async_tasks.remove(session_id);
    }

    /// A session no turn has written to yet. Some adapters keep no transcript for it, so it cannot resume.
    pub fn mark_fresh(&mut self, session_id: &str) {
        self.fresh.insert(session_id.to_string());
    }

    pub fn is_fresh(&self, session_id: &str) -> bool {
        self.fresh.contains(session_id)
    }

    /// A shell or monitor started with `run_in_background` dies with the adapter's session.
    pub fn has_background_work(&self, session_id: &str) -> bool {
        self.background.contains(session_id)
    }

    pub fn is_closed(&self, session_id: &str) -> bool {
        self.closed.contains(session_id)
    }

    /// A session being resumed stays closed until `end_resume` confirms it, so callers that arrive
    /// meanwhile wait instead of reaching an agent that has not loaded the thread yet.
    pub fn mark_attached(&mut self, session_id: &str, now: Instant) {
        if !self.resuming.contains(session_id) {
            self.closed.remove(session_id);
        }
        self.closing.remove(session_id);
        self.touch(session_id, now);
    }

    pub fn claim_resume(&mut self, session_id: &str) -> ResumeClaim {
        if !self.closed.contains(session_id) {
            return ResumeClaim::Open;
        }
        if self.closing.contains(session_id) || self.resuming.contains(session_id) {
            return ResumeClaim::Wait;
        }
        self.resuming.insert(session_id.to_string());
        ResumeClaim::Claimed
    }

    /// A failed resume leaves the session closed, so the next caller retries it.
    pub fn end_resume(&mut self, session_id: &str, resumed: bool, now: Instant) {
        self.resuming.remove(session_id);
        if resumed {
            self.closed.remove(session_id);
            self.closing.remove(session_id);
            self.touch(session_id, now);
        }
    }

    pub fn is_resuming(&self, session_id: &str) -> bool {
        self.resuming.contains(session_id)
    }

    pub fn has_async_tasks(&self, session_id: &str) -> bool {
        self.async_tasks
            .get(session_id)
            .is_some_and(|tasks| !tasks.is_empty())
    }

    /// Tracks adapter background tasks (shells) so a thread running one is never closed.
    pub fn observe_update(&mut self, session_id: &str, update: &Value) {
        let kind = update.get("sessionUpdate").and_then(Value::as_str);
        if matches!(
            kind,
            Some(
                "agent_message_chunk"
                    | "agent_thought_chunk"
                    | "user_message_chunk"
                    | "tool_call"
                    | "tool_call_update"
            )
        ) {
            self.fresh.remove(session_id);
        }
        if matches!(kind, Some("tool_call" | "tool_call_update")) && starts_background_work(update)
        {
            self.background.insert(session_id.to_string());
        }
        let Some(task) = update.get("asyncTaskId").and_then(Value::as_str) else {
            return;
        };
        match kind {
            Some("async_task_spawned") => {
                self.async_tasks
                    .entry(session_id.to_string())
                    .or_default()
                    .insert(task.to_string());
            }
            Some("async_task_state_update") => {
                let finished = !matches!(
                    update.get("state").and_then(Value::as_str),
                    Some("running" | "stopping")
                );
                if finished {
                    if let Some(tasks) = self.async_tasks.get_mut(session_id) {
                        tasks.remove(task);
                    }
                }
            }
            _ => {}
        }
    }
}

fn starts_background_work(update: &Value) -> bool {
    let claude = update.pointer("/_meta/claudeCode");
    update.pointer("/rawInput/run_in_background") == Some(&Value::Bool(true))
        || claude
            .and_then(|meta| meta.pointer("/toolResponse/backgroundTaskId"))
            .is_some_and(Value::is_string)
        || claude
            .and_then(|meta| meta.get("toolName"))
            .and_then(Value::as_str)
            == Some("Monitor")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn untouched_session_is_not_expired_until_the_timeout_passes() {
        let start = Instant::now();
        let mut idle = IdleSessions::default();
        let timeout = Duration::from_secs(600);
        assert!(!idle.expired("a", start, timeout));
        assert!(!idle.expired("a", start + Duration::from_secs(599), timeout));
        assert!(idle.expired("a", start + timeout, timeout));
        idle.touch("a", start + timeout);
        assert!(!idle.expired("a", start + timeout + Duration::from_secs(1), timeout));
    }

    #[test]
    fn background_task_blocks_until_it_finishes() {
        let mut idle = IdleSessions::default();
        idle.observe_update(
            "a",
            &json!({"sessionUpdate":"async_task_spawned","asyncTaskId":"t1"}),
        );
        assert!(idle.has_async_tasks("a"));
        idle.observe_update(
            "a",
            &json!({"sessionUpdate":"async_task_state_update","asyncTaskId":"t1","state":"running"}),
        );
        assert!(idle.has_async_tasks("a"));
        idle.observe_update(
            "a",
            &json!({"sessionUpdate":"async_task_state_update","asyncTaskId":"t1","state":"completed"}),
        );
        assert!(!idle.has_async_tasks("a"));
        assert!(!idle.has_async_tasks("b"));
    }

    #[test]
    fn forgetting_a_session_drops_its_idle_state() {
        let now = Instant::now();
        let mut idle = IdleSessions::default();
        idle.touch("a", now);
        idle.mark_fresh("a");
        idle.begin_close("a");
        idle.observe_update(
            "a",
            &json!({"sessionUpdate":"tool_call","rawInput":{"run_in_background":true}}),
        );
        idle.forget("a");
        assert!(!idle.is_closed("a"));
        assert!(!idle.is_closing("a"));
        assert!(!idle.is_fresh("a"));
        assert!(!idle.has_background_work("a"));
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Open);
    }

    #[test]
    fn forgetting_a_session_keeps_an_in_flight_resume_claimed() {
        let mut idle = IdleSessions::default();
        idle.begin_close("a");
        idle.end_close("a");
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Claimed);
        idle.forget("a");
        assert!(idle.is_resuming("a"));
        idle.end_resume("a", false, Instant::now());
        assert!(!idle.is_resuming("a"));
        assert!(!idle.is_closed("a"));
    }

    #[test]
    fn attaching_a_closed_session_reopens_it() {
        let now = Instant::now();
        let mut idle = IdleSessions::default();
        idle.begin_close("a");
        assert!(idle.is_closed("a"));
        assert!(idle.is_closing("a"));
        idle.mark_attached("a", now);
        assert!(!idle.is_closed("a"));
        assert!(!idle.is_closing("a"));
    }

    #[test]
    fn one_caller_resumes_a_closed_session_and_the_rest_wait() {
        let now = Instant::now();
        let mut idle = IdleSessions::default();
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Open);
        idle.begin_close("a");
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Wait);
        idle.end_close("a");
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Claimed);
        assert!(idle.is_resuming("a"));
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Wait);
        idle.mark_attached("a", now);
        assert!(idle.is_closed("a"), "attaching mid-resume keeps it closed");
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Wait);
        idle.end_resume("a", true, now);
        assert!(!idle.is_resuming("a"));
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Open);
    }

    #[test]
    fn a_failed_resume_leaves_the_session_closed_for_a_retry() {
        let now = Instant::now();
        let mut idle = IdleSessions::default();
        idle.begin_close("a");
        idle.end_close("a");
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Claimed);
        idle.mark_attached("a", now);
        idle.end_resume("a", false, now);
        assert!(idle.is_closed("a"));
        assert_eq!(idle.claim_resume("a"), ResumeClaim::Claimed);
    }

    #[test]
    fn a_close_stays_in_flight_until_it_ends() {
        let mut idle = IdleSessions::default();
        idle.begin_close("a");
        assert!(idle.is_closing("a"));
        idle.end_close("a");
        assert!(!idle.is_closing("a"));
        assert!(idle.is_closed("a"));
    }

    #[test]
    fn fresh_session_stays_loaded_until_a_turn_writes_to_it() {
        let mut idle = IdleSessions::default();
        idle.mark_fresh("a");
        idle.observe_update("a", &json!({"sessionUpdate":"available_commands_update"}));
        idle.observe_update("a", &json!({"sessionUpdate":"config_option_update"}));
        assert!(idle.is_fresh("a"));
        idle.observe_update("a", &json!({"sessionUpdate":"agent_message_chunk"}));
        assert!(!idle.is_fresh("a"));
    }

    #[test]
    fn background_shell_keeps_the_session_loaded_for_good() {
        let mut idle = IdleSessions::default();
        idle.observe_update(
            "a",
            &json!({"sessionUpdate":"tool_call_update","rawInput":{"command":"sleep 9"}}),
        );
        assert!(!idle.has_background_work("a"));
        idle.observe_update(
            "a",
            &json!({"sessionUpdate":"tool_call_update","rawInput":{"command":"sleep 9","run_in_background":true}}),
        );
        assert!(idle.has_background_work("a"));
        idle.observe_update(
            "b",
            &json!({"sessionUpdate":"tool_call_update","_meta":{"claudeCode":{"toolResponse":{"backgroundTaskId":"t1"}}}}),
        );
        assert!(idle.has_background_work("b"));
        idle.observe_update(
            "c",
            &json!({"sessionUpdate":"tool_call","_meta":{"claudeCode":{"toolName":"Monitor"}}}),
        );
        assert!(idle.has_background_work("c"));
        assert!(!idle.has_background_work("d"));
    }
}
