import assert from 'node:assert/strict';
import test from 'node:test';
import {
  composerDraftKey,
  recallComposerDraft,
  rememberComposerDraft,
} from '../src/lib/composer-drafts.ts';

await test('composer drafts preserve selection per exact child thread', () => {
  const parent = composerDraftKey('/repo', 'codex', 'parent');
  const child = composerDraftKey('/repo/child', 'codex', 'child');
  rememberComposerDraft(parent, { text: 'Parent draft', selectionStart: 2, selectionEnd: 8 });
  rememberComposerDraft(child, { text: 'Child draft', selectionStart: 1, selectionEnd: 3 });

  assert.deepEqual(recallComposerDraft(parent), {
    text: 'Parent draft',
    selectionStart: 2,
    selectionEnd: 8,
  });
  assert.equal(recallComposerDraft(child)?.text, 'Child draft');
});

await test('composer drafts clamp selection and clear empty entries', () => {
  const key = composerDraftKey('/repo', 'opencode', 'thread');
  rememberComposerDraft(key, { text: 'draft', selectionStart: -1, selectionEnd: 99 });
  assert.deepEqual(recallComposerDraft(key), {
    text: 'draft',
    selectionStart: 0,
    selectionEnd: 5,
  });
  rememberComposerDraft(key, { text: '', selectionStart: 0, selectionEnd: 0 });
  assert.equal(recallComposerDraft(key), null);
});
