# Local context broker provider profile

The Sail broker uses MCP 2025-06-18 over the approved local stdio relay. This profile applies only to a provider selected by the committed worktree manifest and approved by the user. The broker advertises `sail_context_sources`, `sail_context_search`, `sail_context_get`, and `sail_context_health` to Claude, Codex, and OpenCode; it does not advertise the provider's tool catalog.

A provider exposes MCP tools named `sources`, `search`, and `get` in `tools/list`; Sail follows at most 16 pages and 128 tool entries. This first profile uses fixed names because the manifest does not yet map capabilities to arbitrary tool names. Its result shape uses `structuredContent`, `sourceUri`, and `revision`, as in the draft #307 conformance profile. The conformance kit is still a draft and does not define this production profile.

## Sources

The broker calls `sources` with `{"limit":8}`. The result has `structuredContent.sources`, an array of objects with `sourceUri`, `revision`, and positive `timestampMs`. Sail caps the agent result at eight sources and 4 KiB by default. Malformed source entries receive source-specific errors while valid sources remain visible.

## Search

The broker calls `search` with `{"query":"text","limit":8}`. The result has `structuredContent.items`, an array of at most 128 objects. Each object contains `id`, `sourceUri`, `revision`, `timestampMs` (positive Unix milliseconds), and UTF-8 `content`. IDs and source URIs are at most 256 bytes, revisions at most 128 bytes, and each content value at most 16 MiB. The approved provider ID comes from Sail, not from the result. Sail computes the content hash and limits search hits and the complete serialized agent result to 8 items and 4 KiB by default.

```json
{"result":{"structuredContent":{"items":[{"id":"doc-1","sourceUri":"file:///project/AGENTS.md","revision":"abc123","timestampMs":1760122800000,"content":"A short match"}]}}}
```

## Get

The broker calls `get` with `{"id":"doc-1"}`. The result has one `structuredContent` object with the same fields as a search item. The returned ID must match the requested ID. Sail stores the content under a scope derived from the trusted repository, worktree, operating-system user, approved provider, broker session, and approved commit revision. The agent receives a bounded summary, Sail-computed hash, opaque reference, and a base64 section of at most 1024 exact bytes. The same `sail_context_get` tool reads later sections with `reference`, `offset`, and `length` up to 1024. A reference from another scope or an expired record is unavailable.

Provider errors, malformed content, storage failure, and revoked approval never pass raw provider output through to the agent. Sail returns a bounded error with the approved provider and source. The direct provider tool catalog remains hidden in this profile; a separate explicit user opt-in is required before direct tools can be exposed.

This profile covers one approved local provider per worktree. General terminal, test, and browser output retention and storage settings remain in #304. Signed native relay acceptance remains in #553.
