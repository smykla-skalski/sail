import assert from 'node:assert/strict';
import test from 'node:test';
import { toolAlert } from '../src/lib/tool-alerts.ts';

void test('tool errors loaded from history stay silent', () => {
  const seen = new Set<string>();
  const input = { id: 't1', error: 'boom', mountedError: 'boom', mountedLive: false };
  assert.equal(toolAlert(input, seen), '');
  assert.equal(toolAlert({ ...input, error: '', mountedError: '' }, seen), '');
});

void test('a card that mounts already failed while live announces once, even after a remount', () => {
  const seen = new Set<string>();
  const input = { id: 't1', error: 'boom', mountedError: 'boom', mountedLive: true };
  assert.equal(toolAlert(input, seen), 'boom');
  assert.equal(toolAlert(input, seen), '');
  assert.equal(toolAlert({ ...input }, seen), '');
});

void test('an error that arrives or changes after mount announces', () => {
  const seen = new Set<string>();
  assert.equal(
    toolAlert({ id: 't1', error: 'boom', mountedError: '', mountedLive: false }, seen),
    'boom',
  );
  assert.equal(
    toolAlert({ id: 't2', error: 'second', mountedError: 'first', mountedLive: false }, seen),
    'second',
  );
});

void test('cards without an id announce every new error', () => {
  const seen = new Set<string>();
  const input = { id: undefined, error: 'boom', mountedError: '', mountedLive: false };
  assert.equal(toolAlert(input, seen), 'boom');
  assert.equal(toolAlert(input, seen), 'boom');
  assert.equal(seen.size, 0);
});
