import assert from 'node:assert/strict';
import test from 'node:test';
import {
  annotateDiffs,
  parsePatch,
  patchUnavailableReason,
  repoPath,
  selectedDiffFile,
  type FileDiffInfo,
} from '../src/lib/diff.ts';
import type { Plan } from '../src/lib/plan.ts';
import {
  commentRange,
  formatComments,
  reconcileComments,
  withSnapshot,
} from '../src/lib/diff-comments.ts';

function diffFile(patch: string): FileDiffInfo {
  return { file: 'src/a.ts', patch, additions: 1, deletions: 1, status: 'modified' };
}

await test('repository path matching keeps same-name files distinct', () => {
  assert.equal(repoPath('/repo/src/a.ts', '/repo'), 'src/a.ts');
  assert.equal(repoPath('src/./a.ts', '/repo'), 'src/a.ts');
  assert.equal(repoPath('/other/src/a.ts', '/repo'), null);
  assert.equal(repoPath('../other/a.ts', '/repo'), null);
  assert.equal(repoPath('C:\\Repo\\src\\a.ts', 'c:\\repo'), 'src/a.ts');
});

await test('annotate session diff with touched steps and drift', () => {
  const files: FileDiffInfo[] = ['src/a.ts', 'test/a.ts', 'src/b.ts'].map((file) => ({
    file,
    patch: '',
    additions: 1,
    deletions: 0,
    status: 'modified',
  }));
  const plan: Plan = {
    title: 'Plan',
    summary: 'Summary',
    sessionID: 'session',
    version: 1,
    state: 'executing',
    reviewReason: 'plan',
    createdAt: 1,
    outside: ['test/a.ts'],
    steps: [
      {
        id: 's1',
        title: 'Build',
        detail: 'Detail',
        files: ['src/a.ts'],
        risk: 'low',
        status: 'in_progress',
        origin: 'plan',
        touched: ['src/a.ts', 'src/b.ts'],
      },
    ],
  };
  const result = annotateDiffs(files, plan, '/repo');
  assert.deepEqual(result['src/a.ts'], {
    steps: ['Build'],
    drift: [],
    unattributed: false,
  });
  assert.deepEqual(result['test/a.ts'], {
    steps: [],
    drift: [],
    unattributed: true,
  });
  assert.deepEqual(result['src/b.ts'], {
    steps: ['Build'],
    drift: ['Build'],
    unattributed: false,
  });
  assert.equal(selectedDiffFile(files, '/repo/src/b.ts', '/repo'), 'src/b.ts');
  assert.equal(selectedDiffFile(files, 'src/b.ts', '/repo'), 'src/b.ts');
  assert.equal(selectedDiffFile([], 'src/b.ts', '/repo'), null);
});

await test('parse only a selected readable patch and reject huge or empty patches', () => {
  assert.deepEqual(
    parsePatch('@@ -1 +1 @@\n-old\n+new\n context').map((line) => line.kind),
    ['hunk', 'deleted', 'added', 'context'],
  );
  assert.equal(parsePatch(''), null);
  assert.equal(parsePatch('x'.repeat(250_001)), null);
  assert.equal(parsePatch('Binary files a and b differ'), null);
  assert.equal(patchUnavailableReason('Binary files a and b differ'), 'binary');
});

await test('diff comments track line ranges across edits and mark removed lines outdated', () => {
  const original = parsePatch('@@ -1,3 +1,3 @@\n alpha\n-target\n+target\n omega')!;
  assert.deepEqual(
    original.map((line) => [line.oldLine, line.newLine]),
    [
      [undefined, undefined],
      [1, 1],
      [2, undefined],
      [undefined, 2],
      [3, 3],
    ],
  );
  const comment = commentRange('src/a.ts', original, 3, 3, 'Fix this button')!;
  assert.equal(comment.start, 2);
  assert.equal(comment.side, 'new');
  assert.equal(commentRange('src/a.ts', original, 2, 3, 'Mixed sides'), null);
  const shifted = reconcileComments(
    [comment],
    [diffFile('@@ -1,3 +1,4 @@\n+intro\n alpha\n-target\n+target\n omega')],
  )[0];
  assert.equal(shifted.start, 3);
  assert.equal(shifted.outdated, false);
  const deleted = reconcileComments(
    [shifted],
    [diffFile('@@ -1,3 +1,3 @@\n alpha\n-target\n+other\n omega')],
  )[0];
  assert.equal(deleted.outdated, true);
  assert.match(formatComments([deleted]), /src\/a\.ts:3 \(new lines, outdated\)/);
});

await test('pending comment does not jump to a duplicate after its line is removed', () => {
  const original = parsePatch('@@ -1,4 +1,6 @@\n alpha\n+target\n beta\n+target\n gamma\n delta')!;
  const comment = commentRange('src/a.ts', original, 2, 2, 'Change the first one')!;
  const refreshed = reconcileComments(
    [comment],
    [diffFile('@@ -1,4 +1,5 @@\n alpha\n beta\n+target\n gamma\n delta')],
  )[0];
  assert.equal(refreshed.outdated, true);
  assert.equal(refreshed.start, comment.start);
});

await test('identical surrounding context still marks a removed duplicate outdated', () => {
  const original = parsePatch(
    '@@ -1,6 +1,8 @@\n before\n+target\n after\n middle\n before\n+target\n after\n tail',
  )!;
  const comment = commentRange('src/a.ts', original, 2, 2, 'First target')!;
  const refreshed = reconcileComments(
    [comment],
    [diffFile('@@ -1,6 +1,7 @@\n before\n after\n middle\n before\n+target\n after\n tail')],
  )[0];
  assert.equal(refreshed.outdated, true);
  assert.equal(refreshed.start, comment.start);
  const surviving = commentRange('src/a.ts', original, 6, 6, 'Second target')!;
  const sameRefresh = reconcileComments(
    [surviving],
    [diffFile('@@ -1,6 +1,7 @@\n before\n after\n middle\n before\n+target\n after\n tail')],
  )[0];
  assert.equal(sameRefresh.outdated, false);
  assert.equal(sameRefresh.start, 5);
});

await test('comment outside refreshed hunks retains its anchor', () => {
  const original = parsePatch('@@ -1,3 +1,4 @@\n before\n context\n+added\n after')!;
  const comment = commentRange('src/a.ts', original, 2, 2, 'Keep this context')!;
  const refreshed = reconcileComments(
    [comment],
    [diffFile('@@ -20,2 +20,3 @@\n other\n+change\n end')],
  )[0];
  assert.equal(refreshed.outdated, false);
  assert.equal(refreshed.start, comment.start);
});

await test('file snapshots distinguish deleted duplicates from shifted survivors', () => {
  const original = 'before\ntarget\nafter\nmiddle\nbefore\ntarget\nafter\ntail\n';
  const patch = parsePatch(
    '@@ -1,6 +1,8 @@\n before\n+target\n after\n middle\n before\n+target\n after\n tail',
  )!;
  const first = withSnapshot(commentRange('src/a.ts', patch, 2, 2, 'First')!, original);
  const second = withSnapshot(commentRange('src/a.ts', patch, 6, 6, 'Second')!, original);
  const changed = 'before\nafter\nmiddle\nbefore\ntarget\nafter\ntail\n';
  const result = reconcileComments([first, second], [diffFile('')], {
    'src/a.ts\0new': changed,
  });
  assert.equal(result[0].outdated, true);
  assert.equal(result[1].outdated, false);
  assert.equal(result[1].start, 5);
  const inserted = 'one\ntwo\nthree\nfour\nfive\n' + original;
  const shifted = reconcileComments([first, second], [diffFile('')], {
    'src/a.ts\0new': inserted,
  });
  assert.deepEqual(
    shifted.map((item) => [item.start, item.outdated]),
    [
      [7, false],
      [11, false],
    ],
  );
});

await test('file snapshot marks deleted line outdated even when its hunk disappears', () => {
  const patch = parsePatch('@@ -1,2 +1,3 @@\n before\n+target\n after')!;
  const comment = withSnapshot(
    commentRange('src/a.ts', patch, 2, 2, 'Target')!,
    'before\ntarget\nafter\n',
  );
  const refreshed = reconcileComments([comment], [diffFile('@@ -20 +20,2 @@\n other\n+change')], {
    'src/a.ts\0new': 'before\nafter\n',
  })[0];
  assert.equal(refreshed.outdated, true);
  assert.equal(
    reconcileComments([comment], [diffFile('')], { 'src/a.ts\0new': null })[0].outdated,
    true,
  );
});

await test('CRLF diff lines match their file snapshot', () => {
  const patch = parsePatch('@@ -0,0 +1 @@\n+target\r\n')!;
  const comment = withSnapshot(commentRange('src/a.ts', patch, 1, 1, 'Check')!, 'target\r\n');
  assert.equal(comment.lines[0], 'target');
});

await test('unchanged duplicate lines keep their own location', () => {
  const contents = `${Array.from({ length: 20 }, () => 'same').join('\n')}\n`;
  const patch = parsePatch(`@@ -0,0 +1,20 @@\n${contents.replaceAll(/^/gm, '+').trimEnd()}`)!;
  const comment = withSnapshot(commentRange('src/a.ts', patch, 10, 10, 'Tenth')!, contents);
  const refreshed = reconcileComments([comment], [diffFile('')], { 'src/a.ts\0new': contents })[0];
  assert.equal(refreshed.outdated, false);
  assert.equal(refreshed.start, 10);
});

await test('context and deleted lines form an old-side range', () => {
  const patch = parsePatch('@@ -1,3 +1,2 @@\n keep\n-remove\n end')!;
  const comment = commentRange('src/a.ts', patch, 1, 2, 'Review both')!;
  assert.equal(comment.side, 'old');
  assert.equal(comment.start, 1);
  assert.equal(comment.end, 2);
  const anchored = withSnapshot(comment, 'keep\nremove\nend\n');
  const restored = reconcileComments(
    [anchored],
    [diffFile('@@ -1,3 +1,3 @@\n keep\n remove\n end')],
    {
      'src/a.ts\0old': 'keep\nremove\nend\n',
    },
  )[0];
  assert.equal(restored.outdated, true);
  const shifted = reconcileComments(
    [anchored],
    [diffFile('@@ -1,4 +1,3 @@\n intro\n keep\n-remove\n end')],
    { 'src/a.ts\0old': 'intro\nkeep\nremove\nend\n' },
  )[0];
  assert.equal(shifted.outdated, false);
  assert.equal(shifted.start, 2);
});
