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

#[derive(Default)]
pub struct IdleSessions {
    touched: HashMap<String, Instant>,
    closed: HashSet<String>,
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

    pub fn mark_closed(&mut self, session_id: &str) {
        self.closed.insert(session_id.to_string());
        self.async_tasks.remove(session_id);
    }

    pub fn is_closed(&self, session_id: &str) -> bool {
        self.closed.contains(session_id)
    }

    pub fn mark_attached(&mut self, session_id: &str, now: Instant) {
        self.closed.remove(session_id);
        self.touch(session_id, now);
    }

    pub fn has_async_tasks(&self, session_id: &str) -> bool {
        self.async_tasks
            .get(session_id)
            .is_some_and(|tasks| !tasks.is_empty())
    }

    /// Tracks adapter background tasks (shells) so a thread running one is never closed.
    pub fn observe_update(&mut self, session_id: &str, update: &Value) {
        let Some(task) = update.get("asyncTaskId").and_then(Value::as_str) else {
            return;
        };
        match update.get("sessionUpdate").and_then(Value::as_str) {
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
    fn attaching_a_closed_session_reopens_it() {
        let now = Instant::now();
        let mut idle = IdleSessions::default();
        idle.mark_closed("a");
        assert!(idle.is_closed("a"));
        idle.mark_attached("a", now);
        assert!(!idle.is_closed("a"));
    }
}
