import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { reefAdmission } from '../src/lib/reef-admission.ts';

void test('unavailable Reef keeps work queued and retries into admission', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const released: string[] = [];
  const requests: string[] = [];
  const reasons: string[] = [];
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string, args: { id: string }) => {
          if (command === 'reef_admission_request') {
            requests.push(args.id);
            return undefined;
          }
          if (command === 'reef_admission_release') {
            released.push(args.id);
            return undefined;
          }
          assert.equal(command, 'reef_admission_status');
          return requests.length === 1
            ? { state: 'failed', reason: 'Reef scheduler unavailable' }
            : { state: 'granted', reason: '' };
        },
      },
    },
  });
  try {
    const controller = new AbortController();
    let started = false;
    const pending = reefAdmission('agent')(controller.signal, (reason) =>
      reasons.push(reason),
    ).then((release) => {
      started = true;
      return release;
    });
    await setImmediate();
    assert.equal(started, false);
    assert.deepEqual(reasons, ['Reef scheduler unavailable']);
    assert.equal(released.length, 1);
    t.mock.timers.tick(3000);
    const release = await pending;
    assert.equal(started, true);
    assert.equal(requests.length, 2);
    assert.notEqual(requests[0], requests[1]);
    release();
    assert.equal(released.length, 2);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});

void test('cancelling queued admission releases the backend and stops retries', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let requests = 0;
  let releases = 0;
  const original = Object.getOwnPropertyDescriptor(globalThis, 'window');
  Object.defineProperty(globalThis, 'window', {
    configurable: true,
    value: {
      __TAURI_INTERNALS__: {
        invoke: async (command: string) => {
          if (command === 'reef_admission_request') {
            requests++;
            return undefined;
          }
          if (command === 'reef_admission_release') {
            releases++;
            return undefined;
          }
          return { state: 'queued', reason: 'memory budget in use' };
        },
      },
    },
  });
  try {
    const controller = new AbortController();
    const pending = reefAdmission('browser')(controller.signal, () => {});
    const rejected = assert.rejects(pending, /cancelled/);
    await setImmediate();
    controller.abort();
    await rejected;
    t.mock.timers.tick(30000);
    await setImmediate();
    assert.equal(requests, 1);
    assert.ok(releases >= 1);
  } finally {
    if (original) Object.defineProperty(globalThis, 'window', original);
    else Reflect.deleteProperty(globalThis, 'window');
  }
});
