# Sail

A desktop workspace for coding-agent work. Sail hosts OpenCode planning sessions and Claude or Codex threads in its own interface.

## Plan workspace

- Pick a repository, start an Architect chat, and resume earlier plan sessions.
- Organize repositories into named sidebar groups and switch between them without losing each repository's last session.
- Create a Git worktree from a repository row; Sail opens the new checkout and lists it beneath its repository.
- Resize the entire interface with Command/Ctrl + minus or plus; Command/Ctrl + 0 resets it.
- See live OpenCode messages alongside structured questions, Mermaid diagrams, alternatives, and per-step decisions.
- Send answers, request revisions, or approve a plan for the build agent through [opencode-plugin-plan-review](https://github.com/smykla-skalski/opencode-plugin-plan-review).
- The desktop app starts a local, password-protected OpenCode server and stops it on exit.

## Claude and Codex threads

- Install Claude Code or Codex and Node.js with `npx` (Node.js 22 or newer for Claude). Sail detects the installed binaries and shows them in **Agent settings**.
- Choose a repository, then use **+ Claude** or **+ Codex** in the sidebar. They use the same conversation and resizable Changes workspace as OpenCode; messages, tool activity, permissions, and model or mode choices stay in Sail.
- Press ⇧⌘W (Ctrl+Shift+W on Windows and Linux) to close the current session and delete its worktree after confirming. On a repository's main checkout it shows an error instead.
- Open **Changes** or press ⌘L to inspect the repository working tree while an agent runs.
- In **Changes**, click a diff line or Shift-click a range, write a comment, and add it to the draft list. Press ⌘Enter to send all pending comments to that agent in one message. Comments follow matching lines after a refresh; removed lines appear as outdated.
- Switch a changed file between **All**, **Staged**, and **Unstaged** to stage or unstage a file or hunk. Revert unstaged changes after confirming; Sail rejects actions when the diff has changed since it loaded.
- Sail runs pinned ACP adapters on demand. The first launch downloads the adapter through `npx`; later launches use npm's cache. Each agent uses its own authentication and configuration. Codex can open its ChatGPT sign-in flow inside Sail when needed.
- Threads are saved per repository and agent. Reopening a thread replays its history from the agent. The Architect plan and review workflow remains on OpenCode.

## Development

For packaged development builds, see [installation and first project](docs/install.md). The [release checklist](docs/validation.md#release-checklist) covers platform smoke tests and signing status.

Prerequisites: [mise](https://mise.jdx.dev/), [OpenCode v2](https://opencode.ai/v2/docs/), and the platform dependencies required by [Tauri](https://tauri.app/start/prerequisites/). Configure [opencode-plugin-plan-review](https://github.com/smykla-skalski/opencode-plugin-plan-review) before planning. See the [tested version matrix and release smoke](docs/validation.md); the published `0.2.0` plugin lacks the history RPC required by this app. Install the tested Git revision:

```sh
opencode plugin add github:smykla-skalski/opencode-plugin-plan-review#fdc575ba5ffccc6420ad5b3b68372f99f70290f5
```

For a local checkout, add its path to the selected repository's `opencode.jsonc`:

```jsonc
{ "plugins": ["/absolute/path/to/opencode-plugin-plan-review"] }
```

Mise installs the latest stable Node.js and Rust toolchains. The development task installs JavaScript dependencies when needed.

```sh
mise run dev
```

Select the repository in the app and complete the repository setup checks, then describe the work in chat. The first message creates an Architect session. The app detects OpenCode in common installation locations. Open **OpenCode settings** to see the detected binary or set an absolute path; the app remembers an override. You can also set `SAIL_OPENCODE_BIN` before starting the app.

Sail connects its MCP server to each Claude, Codex, and OpenCode agent session. The server sends the bundled [Sail skill](skills/sail/SKILL.md) during initialization and exposes it through the `sail_skill` tool, so agents can discover how to use Sail's worktree, agent, terminal, thread, and embedded browser tools.

Bundled workflow prompts include only their core contract. Agents load detailed references on demand through `skill_reference`; the files stay embedded for offline use, every response carries an exact SHA-256 content version, and each load remains visible in the task transcript.

The bundled [Ship It skill](skills/ship-it/SKILL.md) follows the ship-it contract from [sai](https://github.com/smykla-skalski/sai/tree/main/plugins/ship-it): risk-selected gates, GitHub work claims, repository release policy, CI triage and phase capabilities. Its Sail mode section adds Sail's gate routing, task checkpoint, evidence and `ship_progress` reporting, plus the merge-owner rule: when Sail's prompt says the user merges, the worker stops at a mergeable pull request and Sail shows it as awaiting merge. Repository instructions, such as `AGENTS.md` or release-policy prose, that say who merges take precedence in either direction. A natively installed `ship-it` skill replaces the bundled copy, and Sail's prompt still asks it for the same stage reports.

Every Ship task also has one durable checkpoint in Sail's persisted run state. The owning agent reads it through `task_checkpoint_read` before resuming and updates objective, acceptance criteria, phase, revision, gates, blockers, questions, and next action through `task_checkpoint_update`. Sail binds each update to the live worktree revision and refreshes GitHub delivery state before returning reconciliation facts, so stale conversation context cannot silently resume work.

Ship task evidence is stored in bounded manifests keyed by the exact worktree revision. Command results, validation gates, and CI checks record their provider, model, result, timestamp, output reference, and acceptance-criteria mapping in the same manifest. A source change makes older manifests stale, and Sail withholds merge-ready status until the current revision has passing required gates and evidence for every acceptance criterion.

Use **+ Group** and **+ Repo** in the sidebar to organize saved repositories. Each repository row has a **+** control to create a worktree. Sail uses the remote default branch when Git records one, then `main` or `master`, then the main checkout branch. Enter a base branch in the form to choose another starting point. By default, new worktrees live in `~/sail/worktrees/<repository>-<id>/<name>` so repositories with the same name stay separate; choose a different parent folder in the form when needed. `SAIL_WORKTREE_ROOT` overrides the default root.

To customize worktrees, commit `.sail/worktree.json` in the repository:

```json
{
  "setup": "mise install",
  "run": "mise run dev",
  "archive": "mise run cleanup",
  "postTurnChecks": ["mise run test", "mise run lint"],
  "copy": [".env", "config/local"]
}
```

Sail copies listed Git-ignored files and folders into each new worktree, then opens `setup` in a visible terminal. It waits for setup to succeed before starting a selected agent. **Run project** starts `run` in a terminal. On deletion, Sail opens `archive` in a terminal and asks before proceeding if it fails. Deleting a configured worktree also removes its local uncommitted and ignored files after confirmation. Without this config, worktree creation and deletion retain their normal behavior.

Post-turn checks run after a successful Claude, Codex, or OpenCode turn. Add personal commands in **Settings → Agents → Post-turn checks**; both personal and repository commands run in the active worktree. Sail asks you to review each repository command before its first run and whenever it changes. Results and output appear in the thread. Failed, canceled, or timed-out checks offer Retry and leave agent status unchanged. Checks time out after two minutes; Sail runs each command once per completed turn.

Agents can use the browser pane in their own worktree to navigate, read, click, type, run JavaScript, and capture screenshots. Open a browser pane first; an agent can navigate its blank tab. Sail asks before a thread first controls the pane and before it accesses external sites. Use **Agent browser on/off** in the top bar to disable or restore access for the selected project.

The browser pane lists HTTP ports started by Sail terminals and agents for its worktree. Select a port to open that server; stopped servers disappear automatically.

Select **Pick element** in a browser pane to highlight a page element, then click it. Sail adds its HTML, computed styles, and a cropped screenshot to the nearest agent prompt so you can add a comment before sending. Press Escape to cancel picking.

Sail saves repositories, groups, selected sessions, drafts, and preferences to `sail/settings.json` in the OS config directory (`~/Library/Application Support` on macOS, `$XDG_CONFIG_HOME` or `~/.config` on Linux, `%APPDATA%` on Windows). `mise run dev` and packaged Sail use the same file. Existing WebView settings migrate on first launch from each origin.

Sail writes structured JSON line diagnostics to its app log directory: `~/Library/Logs/dev.smykla.sai-harness/sail.log` on macOS, and the OS local data directory under `dev.smykla.sai-harness/logs/sail.log` on Linux and Windows. It rotates at 2 MiB and keeps three archives (`sail.log.1` through `.3`). The log records app, frontend error, OpenCode runtime, and Claude/Codex ACP lifecycle events. It includes session and turn IDs, but excludes prompts, tool output, and agent stderr text. A running Sail app must be restarted from an updated build before these logs appear.

Other tasks:

```sh
mise run web    # frontend preview; desktop runtime unavailable in a browser
mise run lint   # strict Oxlint, ESLint, Prettier, rustfmt, Clippy
mise run check  # lint, Svelte typecheck, frontend build
mise run format # format frontend and Rust sources
mise run build  # desktop bundle
```

Pull requests run frontend checks and Rust checks on Linux, macOS, and Windows when Rust files change. The frontend lint configuration follows the [Harness panel](https://github.com/smykla-skalski/harness/tree/main/crates/harness-panel/frontend); Rust uses its Clippy settings.

## Architecture

```text
Svelte + SUI ── OpenCode v2 client ── local OpenCode server
      │                                    └── plan-review plugin RPC + storage
      └── Tauri ── ACP process bridge ── Claude / Codex adapters
```

OpenCode owns Architect sessions and execution. The plan-review plugin owns plans and decisions. Claude and Codex own their ACP sessions; Sail renders their threads and approvals in the desktop UI. Adding another ACP agent requires one entry in the Tauri agent registry.

## License

MIT
