import assert from 'node:assert/strict';
import test from 'node:test';
import {
  loadAgentThreads,
  mergeAgentThreadActivity,
  mergeAgentThreadListing,
  mergeAgentThreadRename,
  mergeAgentThreadUpdate,
  normalizeAgentThreadKeywords,
  type AgentThread,
} from '../src/lib/acp.ts';

const thread: AgentThread = {
  agent: 'codex',
  directory: '/repo',
  sessionId: 'session',
  title: 'Work',
  updated: 2,
};

void test('thread keywords normalize whitespace and case-insensitive duplicates', () => {
  assert.deepEqual(
    normalizeAgentThreadKeywords(['  command   palette ', 'Fuzzy Search', 'fuzzy search']),
    ['command palette', 'Fuzzy Search'],
  );
  assert.throws(() => normalizeAgentThreadKeywords('search'), /must be an array/);
  assert.throws(() => normalizeAgentThreadKeywords(['']), /cannot be empty/);
  assert.throws(() => normalizeAgentThreadKeywords(Array(11).fill('search')), /at most 10/);
  assert.throws(() => normalizeAgentThreadKeywords(['x'.repeat(41)]), /at most 40/);
  assert.deepEqual(normalizeAgentThreadKeywords(['𠮷'.repeat(21)]), ['𠮷'.repeat(21)]);
  assert.throws(() => normalizeAgentThreadKeywords(['𠮷'.repeat(41)]), /at most 40/);
});

void test('thread activity updates preserve keywords unless explicitly replaced', () => {
  const previous = { ...thread, keywords: ['command palette'], renamed: true };
  assert.deepEqual(mergeAgentThreadUpdate(previous, { ...thread, title: 'Stale', updated: 1 }), {
    ...previous,
    updated: 2,
  });
  assert.deepEqual(mergeAgentThreadUpdate(previous, { ...thread, keywords: [] }).keywords, []);
});

void test('thread rename preserves keywords published after the dialog opened', () => {
  const stale = { ...thread, keywords: ['old'] };
  const current = mergeAgentThreadUpdate(stale, { ...stale, keywords: ['new'] });

  assert.deepEqual(mergeAgentThreadRename(current, stale, 'Renamed'), {
    ...current,
    title: 'Renamed',
    renamed: true,
  });
});

void test('thread activity cannot restore stale keywords after replacement or clearing', () => {
  const stale = { ...thread, updated: 1, keywords: ['old'] };
  const activity = { ...stale, updated: 3 };
  const replaced = mergeAgentThreadUpdate(stale, { ...stale, keywords: ['new'] });
  const cleared = mergeAgentThreadUpdate(stale, { ...stale, keywords: [] });

  assert.deepEqual(mergeAgentThreadActivity(replaced, activity).keywords, ['new']);
  assert.deepEqual(mergeAgentThreadActivity(cleared, activity).keywords, []);
});

void test('newer provider listings retain Sail keyword metadata', () => {
  const saved = { ...thread, keywords: ['command palette'] };
  const listed = { ...thread, title: 'Provider title', updated: 3 };
  assert.deepEqual(mergeAgentThreadListing(saved, listed), {
    ...listed,
    keywords: saved.keywords,
  });
});

void test('loading malformed keyword metadata keeps the saved thread', () => {
  const values = new Map<string, string>([
    ['sail-agent-threads', JSON.stringify([{ ...thread, keywords: ['x'.repeat(41)] }])],
  ]);
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage');
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => void values.set(key, value),
    },
  });
  try {
    assert.deepEqual(loadAgentThreads(), [thread]);
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous);
    else delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});
