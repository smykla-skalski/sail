import assert from 'node:assert/strict';
import test from 'node:test';
import {
  createSerialExecutor,
  exportMemories,
  parseMemoryMode,
  parseMemoryTags,
  type MemoryRecord,
} from '../src/lib/shared-memory.ts';

void test('serialized memory changes finish in selection order', async () => {
  const serialize = createSerialExecutor();
  const completed: string[] = [];
  let releaseFirst!: () => void;
  const first = serialize(
    () =>
      new Promise<void>((resolve) => {
        releaseFirst = () => {
          completed.push('sail');
          resolve();
        };
      }),
  );
  const second = serialize(async () => {
    completed.push('off');
  });
  await Promise.resolve();
  assert.deepEqual(completed, []);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(completed, ['sail', 'off']);
});

void test('memory mode defaults to off and accepts explicit opt-in modes', () => {
  assert.equal(parseMemoryMode(null), 'off');
  assert.equal(parseMemoryMode('invalid'), 'off');
  assert.equal(parseMemoryMode('sail'), 'sail');
  assert.equal(parseMemoryMode('system'), 'system');
});

void test('memory tags are trimmed, empty values removed, and duplicates collapsed', () => {
  assert.deepEqual(parseMemoryTags(' architecture, decision,architecture, , ux '), [
    'architecture',
    'decision',
    'ux',
  ]);
});

void test('memory export is a versioned JSON document containing canonical records', () => {
  const record: MemoryRecord = {
    id: 'memory-1',
    content: 'Use SQLite for canonical storage.',
    kind: 'decision',
    tags: ['storage'],
    createdAt: 1_791_529_200_000,
    updatedAt: 1_791_529_200_000,
    provenance: { agent: 'codex', sessionId: 'session-1' },
  };
  const exported: unknown = JSON.parse(exportMemories([record]));
  assert.ok(exported && typeof exported === 'object');
  assert.equal(exported.format, 'sail-shared-memory');
  assert.equal(exported.version, 1);
  assert.deepEqual(exported.memories, [record]);
  assert.equal(typeof exported.exportedAt, 'string');
});
