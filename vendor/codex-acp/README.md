# Sail's Codex ACP adapter

Sail bundles a modified build of `@agentclientprotocol/codex-acp@2.0.0`.
The upstream source is commit `2eebebc` in
[agentclientprotocol/codex-acp](https://github.com/agentclientprotocol/codex-acp).
The source changes are in `sail-permissions.patch`. They adapt the named
permission profile work from
[upstream PR #357](https://github.com/agentclientprotocol/codex-acp/pull/357)
to version 2.0.0 and preserve it across Codex process restarts and ACP forks.

The distribution is licensed under Apache-2.0; see `LICENSE`. Sail changed
the upstream distribution to select launch-provided permission profiles and to
keep the selected profile through session lifecycle operations.
For Sail permission profiles, turns inherit the globally configured approval
reviewer instead of applying the ACP mode reviewer preset. The mode approval
policy and explicit filesystem profile remain enforced. Legacy adapter sessions
retain their mode reviewer presets.

Sail stores the generated JavaScript as `dist/index.js.txt`, then stages it as
`index.mjs` in the connection's private temporary directory at launch.

To rebuild `dist/index.js`, create an isolated worktree from upstream commit
`2eebebc`, apply `sail-permissions.patch` with
`git apply --unidiff-zero`, then run:

```sh
npm ci --ignore-scripts
npm run typecheck
npx vitest run src/__tests__/CodexACPAgent/CodexAcpClient.test.ts src/__tests__/CodexACPAgent/session-config-options.test.ts --no-file-parallelism
npm run build
cp dist/index.js /path/to/sail/vendor/codex-acp/dist/index.js.txt
```

The committed bundle's SHA-256 is
`87474ec40d66c3e2dac0e513e86a1f2f65cdcdd9c455fdda2f56cbdb252bcc02`.
