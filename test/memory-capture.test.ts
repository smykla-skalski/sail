import assert from 'node:assert/strict';
import test from 'node:test';
import { automaticCaptureControl, persistAutomaticCapture } from '../src/lib/memory-capture.ts';

await test('automatic capture is unavailable while shared memory is off', () => {
  const control = automaticCaptureControl({ enabled: false, projectKey: 'project-key' }, 'true');

  assert.deepEqual(control, {
    available: false,
    enabled: false,
    settingKey: 'sai-memory-auto-capture:project-key',
  });
});

await test('automatic capture stays off until the project opts in', () => {
  const control = automaticCaptureControl({ enabled: true, projectKey: 'project-key' }, null);

  assert.deepEqual(control, {
    available: true,
    enabled: false,
    settingKey: 'sai-memory-auto-capture:project-key',
  });
});

await test('automatic capture reflects a saved project opt-in', () => {
  const control = automaticCaptureControl({ enabled: true, projectKey: 'project-key' }, 'true');

  assert.deepEqual(control, {
    available: true,
    enabled: true,
    settingKey: 'sai-memory-auto-capture:project-key',
  });
});

await test('the project control persists both opt-in choices', async () => {
  const values = new Map<string, string>();
  const write = async (key: string, value: string) => {
    values.set(key, value);
  };

  await persistAutomaticCapture('project-key', true, write);
  assert.equal(values.get('sai-memory-auto-capture:project-key'), 'true');

  await persistAutomaticCapture('project-key', false, write);
  assert.equal(values.get('sai-memory-auto-capture:project-key'), 'false');
});
