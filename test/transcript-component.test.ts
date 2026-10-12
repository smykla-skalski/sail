import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import { createServer, type ViteDevServer } from 'vite';
import type { TranscriptItem } from '../src/lib/transcript.ts';

let vite: ViteDevServer;
let renderTranscript: (items: TranscriptItem[]) => string;

before(async () => {
  vite = await createServer({
    configFile: false,
    plugins: [svelte()],
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, watch: null, hmr: false },
  });
  const { default: Transcript } = await vite.ssrLoadModule('/src/Transcript.svelte');
  const { render } = await vite.ssrLoadModule('svelte/server');
  renderTranscript = (items) =>
    render(Transcript, { props: { items } })
      .body.replace(/<!--[\s\S]*?-->/g, '')
      .replace(/\bsvelte-[\w-]+\b/g, 'svelte-COMPONENT')
      .replace(/(<time\b[^>]*>)[^<]*(<\/time>)/g, '$1TIME$2')
      .replace(/style="--harness-mask:[^"]*"/g, 'style="ICON"')
      .replace(/\s+/g, ' ')
      .replace(/> </g, '><')
      .trim();
});

after(async () => {
  await vite?.close();
});

function snapshot(name: string, items: TranscriptItem[]) {
  const file = fileURLToPath(new URL(`./snapshots/${name}.snap`, import.meta.url));
  const actual = renderTranscript(items);
  if (process.env.UPDATE_SNAPSHOTS === '1') writeFileSync(file, `${actual}\n`);
  assert.equal(actual, readFileSync(file, 'utf8').trim());
}

await test('Transcript renders policy outcomes and reasons in chronological order', () => {
  snapshot('transcript-policy', [
    {
      kind: 'message',
      id: 'user-1',
      role: 'user',
      author: 'You',
      text: 'Format notes',
      created: 1,
      provider: 'opencode',
    },
    {
      kind: 'decision',
      id: 'allow-1',
      created: 2,
      title: 'Format notes',
      outcome: 'allowed',
      reason: 'Allowed by repository policy.',
    },
    {
      kind: 'message',
      id: 'thought-1',
      role: 'thought',
      author: 'OpenCode · thinking',
      text: 'Checking the result.',
      created: 3,
      provider: 'opencode',
    },
    {
      kind: 'decision',
      id: 'reject-1',
      created: 4,
      title: 'Delete notes',
      outcome: 'rejected',
      reason: 'Denied by repository policy.',
    },
  ]);
});

await test('Transcript renders hook and post-turn check cards between messages', () => {
  snapshot('transcript-activity', [
    {
      kind: 'message',
      id: 'user-1',
      role: 'user',
      author: 'You',
      text: 'Check files',
      created: 1,
      provider: 'opencode',
    },
    {
      kind: 'hook',
      id: 'hook-1',
      created: 2,
      activity: {
        id: 'hook-1',
        provider: 'opencode',
        sessionId: 'ses-1',
        event: 'PreToolUse',
        source: 'repository',
        outcome: 'blocked',
        reason: 'Protected path',
        created: 2,
        diagnostics: null,
      },
    },
    {
      kind: 'message',
      id: 'assistant-1',
      role: 'assistant',
      author: 'OpenCode',
      text: 'I stopped at the hook.',
      created: 3,
      provider: 'opencode',
    },
    {
      kind: 'checks',
      id: 'checks-1',
      created: 4,
      checks: [
        {
          id: 'check-1',
          updated: 4,
          directory: '/repo',
          thread: 'ses-1',
          turn: 'turn-1',
          source: 'repository',
          command: 'npm test',
          status: 'passed',
          output: 'ok',
          code: 0,
        },
      ],
    },
  ]);
});
