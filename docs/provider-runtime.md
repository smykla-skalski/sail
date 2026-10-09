# Provider runtime decisions — 2026-10-09

## Scope

- Sail needs fixed runtime constraints before Context Hub providers become hard to reverse. This record decides provider confinement, credential storage, OpenCode remote MCP registration behavior, provider lifecycle cleanup, and the fallback for every platform gap found during the work.
- The decisions cover context providers that Sail runs locally on behalf of agents, and remote context providers that agents reach over the network. They do not cover shipping production provider support or the Context Hub interface (issue #300, parent #299). Production provider connection is issue #301.

## Decision principles

- A provider is either fully confined for its platform or it requires an explicit user approval that names the reduced isolation. No code path silently downgrades confinement.
- Sail owns every provider process. A provider never runs inside the agent process, the webview, or the Tauri main process.
- Long-lived user credentials stay in the OS keychain and are exchanged for short-lived capability tokens. A leaked token is bounded to one provider binding, matching the browser MCP token pattern in `src-tauri/src/browser_agent.rs`.
- Every reduction, gap, and fallback in this record is visible in the product surface that starts the provider, not only in documentation.

## DR-1: Local provider confinement

- Decision: Sail launches each local provider as a child process of the Tauri main process with an explicitly constructed environment (allowlist, not inherited), a dedicated per-provider data directory, and the strongest confinement the platform offers without root or kernel changes.
- macOS: the provider runs under a `sandbox-exec` Seatbelt profile that denies by default and allows only the provider's data directory, read-only project paths, and outbound network to the provider's approved endpoint. `sandbox-exec` is deprecated by Apple; Sail treats its absence as a confinement gap that requires explicit approval, never as a reason to launch unconfined.
- Linux: the provider runs under a Landlock ruleset (unprivileged): read-only file access for project paths, read-write only for the provider data directory, and network connect restrictions through `LANDLOCK_ACCESS_NET`. Kernels before 6.7 lack network restrictions; Sail then applies file confinement only and requires explicit approval for the unrestricted network.
- Windows: no unprivileged general-purpose sandbox exists for child processes. Sail runs the provider inside a Job Object (process-tree, memory, and CPU limits) with an explicit allowlisted environment, and requires explicit approval that names the missing network and file confinement.
- On every platform the provider process is started in its own process group (POSIX) or Job Object (Windows), receives no Sail credentials in its environment, and never receives the user's shell environment.

## DR-2: Credential storage

- Decision: provider credentials are stored only in the OS credential store through the `keyring` crate: Keychain on macOS, Credential Manager on Windows, Secret Service (libsecret) on Linux. Sail never writes a provider credential to `settings.json`, `opencode.json`, or any file.
- Fallback: when the OS credential store is unavailable (headless Linux without a Secret Service), Sail refuses to store the credential and keeps it in process memory for the session only, with an explicit notice. There is no plaintext-on-disk fallback.
- Who can read which secret:

| Secret                                           | Stored in                       | Written by                | Read by                                                                                      |
| ------------------------------------------------ | ------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| Provider credential (API key, OAuth token)       | OS credential store             | Sail (Tauri main process) | Only the Sail main process                                                                   |
| Capability token minted for one provider binding | Memory of the Sail main process | Sail at bind time         | Sail and the one provider process bound to it, through environment or URL injection at spawn |
| OpenCode MCP static header value                 | `opencode.json` in plaintext    | Sail or the user          | Any process that can read the repository                                                     |

- The probe in this change confirmed that OpenCode 2.0.24 stores remote MCP headers in plaintext in the project `opencode.json` and that `opencode mcp auth` stores OAuth material in `~/.local/share/opencode/mcp-auth.json`. Consequence: credentialed context providers must not pass long-lived secrets through OpenCode MCP headers. Sail registers remote providers with short-lived capability tokens minted per binding, and treats every value in `opencode.json` as readable by anything that can read the repository.

## DR-3: OpenCode remote MCP registration (verified)

- Baseline: OpenCode CLI `2.0.24`, the version pinned in `src-tauri/src/lib.rs` and `docs/validation.md`. Evidence run: 2026-10-09, macOS 26.6.2 arm64, via `node scripts/opencode-remote-mcp-probe.mjs --json`; all ten findings passed.
- Verified behavior of the pinned client:

| Probe finding                     | Verified behavior                                                                                                                                                           |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `add-remote`                      | `opencode mcp add <name> --url <url> --header k=v` exits 0 and writes `mcp.servers.<name>` with `type: "remote"`, the URL, and the headers into the project `opencode.json` |
| `headers-are-plaintext`           | The header value is stored in plaintext in the project config file                                                                                                          |
| `replace-overwrites`              | Re-running `mcp add` with the same name overwrites the entry; unspecified fields (such as a previously written header) are dropped, not merged                              |
| `remove-has-no-command`           | There is no `mcp remove` subcommand; the CLI reports `Unknown subcommand "remove"`                                                                                          |
| `remove-via-config`               | Deleting the entry from `opencode.json` removes the server; `mcp list` no longer reports it while other servers stay listed                                                 |
| `authenticate-header`             | `mcp list` performs a live connect and sends the configured `Authorization` header; the probe server recorded a matching bearer token and the server reported `connected`   |
| `unauthenticated-rejected`        | A server registered without a header receives a 401 and `mcp list` reports `needs authentication`                                                                           |
| `unauthenticated-oauth-discovery` | A 401 makes the client probe `/.well-known/oauth-protected-resource` and related OAuth discovery endpoints automatically                                                    |
| `auth-is-interactive`             | `mcp auth` is an interactive OAuth flow; headless without a browser it exits without completing authentication                                                              |
| `logout-without-credentials`      | `mcp logout` for a server without stored credentials reports `No stored credentials` without corrupting config                                                              |

- Two CLI behaviors constrain automation and are part of the contract: the first `mcp list` after a fresh background service start can report `No MCP servers configured` before the service loads the project config, so callers must poll until the configured servers appear; and MCP subcommands reject `--standalone` and talk to a per-user background service whose managed port defaults to a fixed value (49374 on the evidence host). Isolated runs must set a unique port with `opencode service set port <port>` inside an isolated `HOME`.
- Consequences for Sail: Sail manages `mcp.servers` entries itself (add, replace, remove through config writes) and uses the CLI only as documented above; it must never rely on `mcp remove` existing; it polls `mcp list` to a settled state before judging connectivity; and it cannot trust static headers with long-lived secrets (DR-2).

## DR-4: Provider lifecycle cleanup

- Decision: cleanup is idempotent, runs on the Sail side for every lifecycle event, and each event has an owner and a defined end state:

| Event                                              | Sail cleanup                                                                                                                                                                          |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Provider startup failure                           | Kill the process group or Job Object, release any minted capability tokens, remove the half-written provider state directory, and surface the failure with the provider's stderr tail |
| Session failure (provider crash or protocol error) | Kill and restart the provider process with a fresh capability token; the old token is released and rejected from that moment                                                          |
| Cancellation                                       | Kill the process group or Job Object, release the capability token, and keep the provider data directory for provenance                                                               |
| Runtime restart (app restart)                      | Treat orphaned provider processes from the previous run as unknown: detect them through the recorded process identity, stop them, and release their tokens before binding new ones    |
| Provider removal                                   | Stop the process, release tokens, delete the provider data directory after user confirmation, and remove its OpenCode MCP registration from `opencode.json`                           |

- Capability tokens follow the existing browser MCP release pattern (`BrowserManager.release`), extended with rejection after release so a released token cannot be reused by a lingering process.
- Orphan prevention: providers always run in a process group (POSIX) or Job Object with kill-on-close (Windows), so a Sail crash cannot leave a running provider with a live token.

## DR-5: Platform gaps and fallback behavior

| Gap                                                                               | Fallback                                                                                                                                                                     | Never silent                                                                         |
| --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| `sandbox-exec` removed or refused on macOS                                        | Start only after explicit approval that names the lost file and network confinement                                                                                          | The approval dialog names the exact lost guarantees                                  |
| Linux kernel without `LANDLOCK_ACCESS_NET` (before 6.7)                           | File confinement only, plus explicit approval for unrestricted network                                                                                                       | The approval dialog names the unrestricted network                                   |
| Windows without an unprivileged confinement primitive                             | Job Object limits plus explicit approval for missing file and network confinement                                                                                            | The approval dialog names the missing confinement                                    |
| No OS credential store (headless Linux)                                           | Memory-only credential for the session, explicit notice, no plaintext disk fallback                                                                                          | The notice appears before the provider starts                                        |
| OpenCode OAuth flows unusable headless (`mcp auth`)                               | Sail uses static capability-token headers for managed providers; OAuth-based providers are out of scope for managed registration until the CLI supports non-interactive auth | The provider configuration marks OAuth providers as unsupported in this Sail version |
| OpenCode `mcp list` reports no servers before the background service loads config | Callers poll to a settled state and treat an empty first result as indeterminate, not as failure or success                                                                  | Documented in DR-3 and encoded in the probe                                          |

## Reproducing the registration evidence

- Run `node scripts/opencode-remote-mcp-probe.mjs` with the pinned OpenCode on `PATH` (or pass `--bin <path>`). The probe isolates `HOME` and the XDG directories in a temporary root, sets a unique managed-service port, starts a local MCP server that requires a bearer token, and records the client's observed behavior as structured findings.
- `--json` prints machine-readable findings; `--keep` preserves the scratch root for inspection. Exit codes: 0 survey completed, 1 probe infrastructure failure, 2 no OpenCode binary found.
- `npm test` includes `test/opencode-remote-mcp.test.ts`, which runs the probe and asserts the contract above. It skips when no OpenCode binary is on `PATH` or the binary is not the pinned `2.0.24`, so CI without the pinned client stays green while a desktop run with the pinned client re-verifies the contract.
- Re-run the probe whenever the OpenCode pin in `src-tauri/src/lib.rs` changes and update this record and `docs/validation.md` together with the pin.
