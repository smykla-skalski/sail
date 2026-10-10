import assert from 'node:assert/strict';
import test from 'node:test';
import {
  forgetPlanningState,
  clearStructuredQuestions,
  loadNativePlan,
  loadStructuredQuestions,
  removeStructuredQuestion,
  saveNativePlan,
  saveStructuredQuestions,
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

function questionFor(sessionId: string) {
  return [{ id: 42, sessionId, message: `${sessionId} question`, schema: {} }];
}

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

await test('structured questions are replayed only for their session', () => {
  const child = { ...parent, sessionId: 'child' };
  saveStructuredQuestions(parent, [
    { id: 'request-1', sessionId: parent.sessionId, message: 'Parent?', schema: {} },
  ]);
  saveStructuredQuestions(child, [
    { id: 'request-2', sessionId: child.sessionId, message: 'Child?', schema: {} },
  ]);

  assert.deepEqual(
    loadStructuredQuestions(parent).map((item) => item.message),
    ['Parent?'],
  );
  assert.deepEqual(
    loadStructuredQuestions(child).map((item) => item.message),
    ['Child?'],
  );
  saveStructuredQuestions(parent, []);
  assert.deepEqual(loadStructuredQuestions(parent), []);
  assert.deepEqual(
    loadStructuredQuestions(child).map((item) => item.message),
    ['Child?'],
  );
  forgetPlanningState(child);
});

await test('cancelling a question preserves unrelated session state', () => {
  const child = { ...parent, sessionId: 'child' };
  saveStructuredQuestions(parent, [
    { id: 4, sessionId: parent.sessionId, message: 'Parent?', schema: {} },
  ]);
  saveStructuredQuestions(child, [
    { id: 5, sessionId: child.sessionId, message: 'Child?', schema: {} },
  ]);

  removeStructuredQuestion('codex', parent.directory, parent.sessionId, 4);
  assert.deepEqual(loadStructuredQuestions(parent), []);
  assert.deepEqual(
    loadStructuredQuestions(child).map((item) => item.message),
    ['Child?'],
  );
  forgetPlanningState(child);
});

await test('disconnect clears questions but retains the replayable plan', () => {
  saveNativePlan(parent, {
    provider: 'codex',
    markdown: '# Parent plan',
    updated: 1,
    tasks: [],
  });
  saveStructuredQuestions(parent, [
    { id: 6, sessionId: parent.sessionId, message: 'Parent?', schema: {} },
  ]);

  clearStructuredQuestions(parent.agent, parent.directory, parent.sessionId);
  assert.equal(loadNativePlan(parent)?.markdown, '# Parent plan');
  assert.deepEqual(loadStructuredQuestions(parent), []);
  forgetPlanningState(parent);
});

await test('question cancellation and disconnect stay within one worktree', () => {
  const sibling = { ...parent, directory: '/sibling-repo' };
  const otherSession = { ...parent, sessionId: 'other-session' };
  saveStructuredQuestions(parent, questionFor(parent.sessionId));
  saveStructuredQuestions(sibling, questionFor(sibling.sessionId));
  saveStructuredQuestions(otherSession, questionFor(otherSession.sessionId));

  removeStructuredQuestion(parent.agent, parent.directory, parent.sessionId, 42);
  assert.deepEqual(loadStructuredQuestions(parent), []);
  assert.equal(loadStructuredQuestions(sibling)[0]?.message, `${sibling.sessionId} question`);
  assert.equal(
    loadStructuredQuestions(otherSession)[0]?.message,
    `${otherSession.sessionId} question`,
  );

  saveStructuredQuestions(parent, questionFor(parent.sessionId));
  clearStructuredQuestions(parent.agent, parent.directory, parent.sessionId);
  assert.deepEqual(loadStructuredQuestions(parent), []);
  assert.equal(loadStructuredQuestions(sibling)[0]?.message, `${sibling.sessionId} question`);
  assert.equal(
    loadStructuredQuestions(otherSession)[0]?.message,
    `${otherSession.sessionId} question`,
  );
  forgetPlanningState(parent);
  forgetPlanningState(sibling);
  forgetPlanningState(otherSession);
});
