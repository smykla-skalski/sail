import assert from 'node:assert/strict';
import test from 'node:test';
import { composerTaskLocation, resolveTaskLocation } from '../src/lib/task-location.ts';

await test('uses repository and branch metadata without changing Unicode text', () => {
  assert.deepEqual(resolveTaskLocation('/work/żagiel', '/projects/סירה', 'feature/مرحبا-日本語'), {
    directory: '/work/żagiel',
    repository: 'סירה',
    branch: 'feature/مرحبا-日本語',
    known: true,
  });
});

await test('reports missing or malformed metadata as unknown', () => {
  assert.deepEqual(resolveTaskLocation('/work/sail', '/projects/sail', null), {
    directory: '/work/sail',
    repository: 'sail',
    branch: '',
    known: false,
  });
  assert.equal(resolveTaskLocation('/work/sail', '/projects/sail', 'bad\nbranch').known, false);
  assert.equal(resolveTaskLocation('', '/projects/sail', 'main').known, false);
});

await test('rejects stale and cross-pane task locations', () => {
  const location = resolveTaskLocation('/work/one', '/projects/sail', 'one');
  assert.equal(composerTaskLocation(location, '/work/two').known, false);
  assert.equal(composerTaskLocation(location, '/work/one', '/work/two').known, false);
  assert.deepEqual(composerTaskLocation(location, '/work/one', '/work/one'), location);
});
