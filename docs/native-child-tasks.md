# Native child Tasks

- Open a native child from the sidebar or its parent's subagent card to see that child's Tasks. Parent and child tasks are stored under separate provider, worktree, and session identities.
- A verified OpenCode child receives its own live task turn. Read `sail_tasks_read` before reporting stable task IDs and focus with `sail_tasks_report`.
- Completion, failure, interruption, and disconnected restoration clear child focus. Durable child task history remains available after restoration. A resumed child receives a fresh turn; reports from the earlier turn are rejected.
- Children without attributable task calls show **Observed activity**. That activity is provider telemetry, and cannot update another session's tasks or focus.

## Provider contract

| Provider | Native child task identity                                                                                                                         | Bridge behavior                                                                                                                                                   |
| -------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OpenCode | The trusted ACP child extension registers the child under its parent. OpenCode attaches `ai.opencode/sessionID` to each MCP call. Both must match. | Registered children write their own scope; parent calls retain the parent scope. Unknown, ambiguous, or absent metadata is rejected after native child discovery. |
| Codex    | Its adapter marks native activity as `subagent` and supplies `agentThreadId`, but Sail MCP calls do not identify the originating child.            | Trusted adapter activity creates an observed child and settles it on completion or interruption. Task writes remain unavailable while identity is ambiguous.      |
| Claude   | Its adapter marks native child tool activity, but the activity and replay identities do not identify the originating child's Sail MCP call.        | While marked child activity is live, identity-free task writes are rejected. Terminal activity reopens the parent scope. Child activity remains observed.         |

- An inherited parent token alone is insufficient child authority. Tool arguments, model-provided child fields, and generic `sessionID` metadata cannot select a child scope. Only adapter-marked activity can create or clear the attribution fence.
- Descendant registration is restricted to the same parent connection, provider, capability profile, and worktree. A token for another parent does not gain access to that child.
- Where identity is unavailable, Sail skips the missing-report corrective prompt. The task report error remains explicit; the child cannot silently write the parent's task list.

## Checks

- `test/native-session-tasks.test.ts` exercises separate parent/child tasks, rejected old-turn writes, completion, interruption, failure, stale snapshots, and durable restoration.
- Rust `native_task_identity_tests` exercise provider metadata, descendant registration, nested children, ambiguous IDs, owned session aliases, and cross-parent/provider/worktree rejection.
- `test/e2e/native-session-tasks.spec.ts` drives fixture child flows for all three providers through the real desktop bridge. OpenCode succeeds with provider metadata; Claude and Codex display observed activity and explicit task identity errors.
- Authenticated provider runs require a private provider environment authorized for this issue. Fixture coverage does not establish installed provider conformance.

- `test/e2e/native-session-tasks-real.spec.ts` runs only with `SAIL_REAL_TASK_PROVIDER` in an explicitly authorized private provider environment. It spawns one native child, separates the parent report from the child report, and asserts supported OpenCode attribution or observed Codex/Claude limitations without editing files or inspecting credentials.
