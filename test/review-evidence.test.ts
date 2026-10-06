import assert from 'node:assert/strict';
import test from 'node:test';
import type { WorkingDiffInfo } from '../src/lib/diff.ts';
import type { PostTurnCheck } from '../src/lib/post-turn-checks.ts';
import { leaves, type Pane } from '../src/lib/panes.ts';
import {
  browserReviewPreviews,
  evidenceFreshness,
  groupReviewCaptures,
  groupReviewChecks,
  retainCaptureMetadata,
  reviewFiles,
  selectReviewPreview,
} from '../src/lib/review-evidence.ts';

function capture(id: string, turn: string | null, created: number) {
  return {
    id,
    paneId: 'main',
    phase: 'before' as const,
    source: 'example.com',
    url: 'https://example.com',
    previewUrl: `data:image/png;base64,${id}`,
    created,
    thread: turn ? 'acp:codex:session' : null,
    turn,
  };
}

function diffFile(file: string, patch: string, additions = 1, deletions = 0): WorkingDiffInfo {
  return {
    file,
    patch,
    additions,
    deletions,
    status: 'modified',
    stagedPatch: '',
    unstagedPatch: patch,
    untracked: false,
  };
}

function check(turn: string, command: string, updated: number): PostTurnCheck {
  return {
    id: `${turn}:${command}`,
    updated,
    directory: '/repo',
    thread: 'acp:codex:session',
    turn,
    source: 'repository',
    command,
    status: 'passed',
    output: '',
    code: 0,
  };
}

await test('review files preserve readable and fallback evidence', () => {
  assert.deepEqual(
    reviewFiles([
      diffFile('src/readable.ts', '@@ -1 +1 @@\n-old\n+new', 1, 1),
      diffFile('public/logo.png', 'Binary files a and b differ'),
      diffFile('generated.txt', 'x'.repeat(250_001)),
      diffFile('renamed.ts', ''),
    ]).map(({ path, state }) => ({ path, state })),
    [
      { path: 'src/readable.ts', state: 'available' },
      { path: 'public/logo.png', state: 'binary' },
      { path: 'generated.txt', state: 'large' },
      { path: 'renamed.ts', state: 'metadata' },
    ],
  );
});

await test('review checks stay grouped by turn and newest turn appears first', () => {
  const groups = groupReviewChecks([
    check('turn-old', 'npm test', 100),
    check('turn-new', 'npm run lint', 300),
    check('turn-new', 'npm run check', 200),
  ]);
  assert.deepEqual(
    groups.map(({ turn, updated }) => ({ turn, updated })),
    [
      { turn: 'turn-new', updated: 300 },
      { turn: 'turn-old', updated: 100 },
    ],
  );
  assert.deepEqual(
    groups[0].checks.map(({ command }) => command),
    ['npm run check', 'npm run lint'],
  );
});

await test('capture metadata survives preview eviction', () => {
  const captures = Array.from({ length: 21 }, (_, index) =>
    capture(`capture-${index}`, 'turn', index),
  );
  const retained = retainCaptureMetadata(captures);
  assert.equal(retained.length, 21);
  assert.equal(retained[0].previewUrl, null);
  assert.equal(retained[1].previewUrl, 'data:image/png;base64,capture-1');
});

await test('captures stay grouped by originating turn', () => {
  const groups = groupReviewCaptures([
    capture('old', 'turn-old', 100),
    capture('draft', null, 300),
    capture('new', 'turn-new', 200),
  ]);
  assert.deepEqual(
    groups.map(({ turn, updated }) => ({ turn, updated })),
    [
      { turn: null, updated: 300 },
      { turn: 'turn-new', updated: 200 },
      { turn: 'turn-old', updated: 100 },
    ],
  );
});

await test('review evidence becomes stale after five minutes', () => {
  const updated = 1_000;
  assert.equal(evidenceFreshness(updated, updated + 5 * 60_000), 'current');
  assert.equal(evidenceFreshness(updated, updated + 5 * 60_000 + 1), 'stale');
});

await test('browser evidence opens the exact recorded tab', () => {
  const pane: Pane = {
    id: 'split',
    direction: 'row',
    ratio: 0.5,
    first: { id: 'main', agent: 'claude', thread: null },
    second: {
      id: 'browser',
      agent: null,
      thread: null,
      kind: 'browser',
      tabs: [
        { id: 'one', history: ['https://example.com/one'], index: 0 },
        { id: 'two', history: ['https://example.com/two'], index: 0 },
      ],
      activeTab: 'one',
    },
  };
  const previews = browserReviewPreviews(pane);
  assert.deepEqual(
    previews.map(({ tabId, url }) => ({ tabId, url })),
    [
      { tabId: 'one', url: 'https://example.com/one' },
      { tabId: 'two', url: 'https://example.com/two' },
    ],
  );
  const selected = selectReviewPreview(pane, previews[1]);
  const selectedBrowser = selected && leaves(selected).find((leaf) => leaf.id === 'browser');
  assert.equal(selectedBrowser?.kind === 'browser' ? selectedBrowser.activeTab : null, 'two');
  assert.equal(selectReviewPreview(pane, { ...previews[1], tabId: 'missing' }), null);
});
