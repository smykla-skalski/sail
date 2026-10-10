# Context provider integration kit (profile v1)

Sail uses the [MCP 2025-06-18 protocol](https://modelcontextprotocol.io/specification/2025-06-18/basic/lifecycle) for provider sessions. A provider can use [stdio or Streamable HTTP](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports). The standalone conformance command below tests both transports without launching an agent or making a model request.

## Current Sail support

The committed `.sail/worktree.json` pointer selects `.sail/context.json`. The current runtime accepts manifest version `1` with exactly one optional `stdio` provider. Its `command` is a registry key for a locally selected executable, not a shell command from the repository:

```json
{
  "version": 1,
  "providers": [
    {
      "id": "project-files",
      "type": "stdio",
      "command": "project-files",
      "capabilities": ["search", "get"],
      "required": false
    }
  ]
}
```

Provider IDs and registry keys start with a lowercase ASCII letter and contain only lowercase ASCII letters, digits and hyphens, up to 64 bytes. `sail-browser` is reserved. Capabilities are `search`, `get`, `index`, `execute`, `memory-read`, or `memory-write`; choose each at most once. The manifest has a 64 KiB limit, rejects unknown fields, and is read from one committed Git revision. Sail rejects unsupported manifest versions with `Unsupported context manifest version.` and does not activate dirty or staged changes. The provider registration, project approval and revocation commands are documented in `src-tauri/src/context.rs`.

The standalone suite accepts Streamable HTTP endpoints today, but Sail does not yet launch or register them. Provider delivery to Claude, Codex and OpenCode is also pending the broker and agent integration work. Passing the suite is a protocol check, not evidence of agent parity or provider isolation.

## Provider behavior

MCP messages are UTF-8 JSON-RPC 2.0. A stdio server writes one JSON-RPC message per stdout line, logs only to stderr, and does not write banners to stdout. An HTTP server accepts POST at one endpoint, includes either JSON or SSE responses, returns 202 for accepted notifications, and follows the negotiated `MCP-Protocol-Version` and optional `Mcp-Session-Id` headers. The suite checks protocol version `2025-06-18` exactly; another negotiated version fails with a compatibility message.

The provider advertises tools in `tools/list`. At least one safe, read-only tool must return a bounded result with source and revision provenance. The profile points to these values in the tool's result with JSON Pointers, so authors can test existing MCP output shapes without a Sail-specific tool name. A second tool must exercise an error path: the suite sends a sentinel secret in its arguments and fails if the error response repeats it. The sentinel comes from an environment variable and is never stored in the profile or report.

Profile v1 limits each transport response and tool result to 64 KiB, advertised tools to 128 across at most 16 pages, and `structuredContent.items` to 20 when present. Requests time out after five seconds. These are conformance limits for this kit; the production broker owns its eventual per-provider policy. A passing report contains check names only, not provider output, arguments, tokens or credentials.

## Run the offline suite

Create a local JSON profile. The `command` and `args` here belong to this developer-run test, never to the committed Sail manifest. Replace the fixture with your provider and choose a harmless read-only probe:

```json
{
  "version": 1,
  "transport": {
    "type": "stdio",
    "command": "/absolute/path/to/node",
    "args": ["/absolute/path/to/provider.mjs"]
  },
  "probe": {
    "tool": "search_docs",
    "arguments": { "query": "AGENTS.md" },
    "sourcePointer": "/structuredContent/items/0/sourceUri",
    "revisionPointer": "/structuredContent/items/0/revision",
    "expectedSource": "file:///project/AGENTS.md",
    "expectedRevision": "abc123"
  },
  "errorProbe": {
    "tool": "reject_bad_input",
    "arguments": { "secret": "$SECRET" },
    "secretEnvironment": "SAIL_CONFORMANCE_SECRET"
  }
}
```

Set `SAIL_CONFORMANCE_SECRET` to a disposable sentinel, then run:

```sh
node scripts/context-provider-conformance.mjs --config /absolute/path/to/profile.json
```

For Streamable HTTP, replace `transport` with:

```json
{
  "type": "streamable-http",
  "url": "https://context.example.com/mcp",
  "headerEnvironment": { "Authorization": "SAIL_CONFORMANCE_AUTHORIZATION" }
}
```

The suite reads header values from the named environment variables. It accepts plain HTTP only on loopback, rejects URL credentials and query strings, and does not follow redirects. Run against an endpoint that permits these harmless probes; the suite does not certify provider security or authorization controls.

The command exits nonzero for a failed check. Unsupported profile versions report `Unsupported conformance profile version; expected 1.` Keep a copy of the profile and report with the provider release so a later revision can be tested against the same contract. `node --test test/context-provider-conformance.test.ts` runs local stdio and HTTP fixtures without paid model calls.

## Remaining integration work

- Add a reviewed MCP import preview that maps each discovered server to an explicit provider and permission. The current one-provider registry cannot represent every imported server.
- Connect approved providers through the Sail broker, then prove the same provider works in Claude, Codex and OpenCode sessions.
- Recheck conformance after the broker contract and remote transport are implemented. Keep issue #307 open until those runs and the import preview exist.
