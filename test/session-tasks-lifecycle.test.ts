import assert from 'node:assert/strict';
import test from 'node:test';
import { initializeSettings } from '../src/lib/settings.ts';
import { acp, recoverMissingSession } from '../src/lib/acp.ts';
import { sessionTasks } from '../src/lib/session-tasks.ts';

const local = new Map<string, string>([['sail-settings-migrated-v1', '1']]);
Object.defineProperty(globalThis, 'localStorage', {
  configurable: true,
  value: {
    getItem: (key: string) => local.get(key) ?? null,
    setItem: (key: string, value: string) => local.set(key, value),
    removeItem: (key: string) => local.delete(key),
  },
});
Object.defineProperty(globalThis, 'isTauri', { configurable: true, value: true });
let activeTurn: string | null = null;
let releasePreflight!: () => void;
let releasePrompt!: () => void;
let reachedPreflight!: () => void;
const preflight = new Promise<void>((resolve) => {
  reachedPreflight = resolve;
});
let resumed = false;
let attempts = 0;
Object.defineProperty(globalThis, 'window', {
  configurable: true,
  value: {
    addEventListener() {},
    __TAURI_INTERNALS__: {
      invoke: async (command: string, args: { params: { sessionId: string; turnId: string } }) => {
        if (command === 'load_settings') return {};
        if (command === 'save_setting') return undefined;
        if (command === 'acp_activity')
          return {
            codex: {
              alive: true,
              sessions: ['starting'],
              activeTurns: activeTurn ? { starting: activeTurn } : {},
            },
          };
        if (command !== 'acp_prompt') throw new Error(`Unexpected command ${command}`);
        if (args.params.sessionId === 'retry') {
          attempts += 1;
          if (!resumed) throw new Error('Session not found: retry');
          return { stopReason: 'end_turn' };
        }
        reachedPreflight();
        await new Promise<void>((resolve) => {
          releasePreflight = resolve;
        });
        activeTurn = args.params.turnId;
        await new Promise<void>((resolve) => {
          releasePrompt = resolve;
        });
        return { stopReason: 'end_turn' };
      },
    },
  },
});
await initializeSettings();

await test('activity refresh during backend preflight preserves reportable task ownership', async () => {
  const scope = { agent: 'codex', directory: '/repo', sessionId: 'starting' };
  const prompt = acp.prompt(
    'codex',
    '/repo',
    'starting',
    'Report tasks',
    'turn',
    [],
    undefined,
    true,
  );
  await preflight;
  const observed = sessionTasks().snapshot(scope);
  const runtime = (await acp.activity('/repo')).codex;
  await sessionTasks().reconcile(scope, runtime?.activeTurns.starting ?? null, observed.revision);
  releasePreflight();
  await new Promise((resolve) => setImmediate(resolve));
  const current = sessionTasks().snapshot(scope);
  await sessionTasks().report(scope, {
    turnId: 'turn',
    expectedRevision: current.revision,
    tasks: [{ id: 'inspect', title: 'Inspect', status: 'in_progress' }],
    focus: 'inspect',
  });
  assert.equal(sessionTasks().snapshot(scope).focus, 'inspect');
  releasePrompt();
  await prompt;
  assert.equal(sessionTasks().snapshot(scope).focus, null);
});
await test('session recovery retries its prompt without duplicating starting task identities', async () => {
  await recoverMissingSession(
    () => acp.prompt('codex', '/repo', 'retry', 'Report tasks', 'retry-turn', [], undefined, true),
    async () => {
      resumed = true;
    },
  );
  const tasks = sessionTasks().snapshot({
    agent: 'codex',
    directory: '/repo',
    sessionId: 'retry',
  }).tasks;
  assert.equal(attempts, 2);
  assert.deepEqual(
    tasks.map((task) => task.id),
    ['sail:retry-turn'],
  );
});
