import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forgetPlanningState,
  loadNativePlan,
  saveNativePlan,
  type PlanningStateScope,
} from '../src/lib/planning-state.ts';

const values = new Map<string, string>();
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  },
  configurable: true,
});

const parent: PlanningStateScope = {
  agent: 'codex',
  directory: '/repo',
  sessionId: 'parent',
};

await test('native plans remain scoped to their exact session', () => {
  saveNativePlan(parent, {
    provider: 'codex',
    markdown: '# Parent plan',
    updated: 1,
    tasks: [],
  });
  const child = { ...parent, sessionId: 'child' };
  const otherProject = { ...parent, directory: '/other-repo' };
  saveNativePlan(child, {
    provider: 'codex',
    markdown: '# Child plan',
    updated: 2,
    tasks: [],
  });

  assert.equal(loadNativePlan(parent)?.markdown, '# Parent plan');
  assert.equal(loadNativePlan(child)?.markdown, '# Child plan');
  assert.equal(loadNativePlan(otherProject), null);
  forgetPlanningState(parent);
  forgetPlanningState(child);
});

await test('forgetting a session does not clear another session', () => {
  const sibling = { ...parent, sessionId: 'sibling' };
  saveNativePlan(parent, {
    provider: 'codex',
    markdown: '# Removed',
    updated: 1,
    tasks: [],
  });
  saveNativePlan(sibling, {
    provider: 'claude',
    markdown: '# Retained',
    updated: 2,
    tasks: [],
  });

  forgetPlanningState(parent);
  assert.equal(loadNativePlan(parent), null);
  assert.equal(loadNativePlan(sibling)?.markdown, '# Retained');
  forgetPlanningState(sibling);
});
