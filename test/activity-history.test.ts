import assert from 'node:assert/strict';
import test from 'node:test';
import {
  activityWorkspaces,
  loadActivityHistory,
  recentActivityEvents,
  saveActivityHistory,
} from '../src/lib/activity-history.ts';
import { permissionDecisionTitle } from '../src/lib/capability-profiles.ts';
import { acpPermissionActivitySourceId } from '../src/lib/acp-permissions.ts';

await test('activity history deduplicates provider updates with latest scoped outcome', () => {
  const events = recentActivityEvents([
    {
      workspace: '/repo/a',
      kind: 'tool',
      source: 'Codex',
      sourceId: 'tool-1',
      title: 'Run tests',
      outcome: 'working',
      at: 10,
      agent: 'codex',
      sessionId: 'session-1',
    },
    {
      workspace: '/repo/a',
      kind: 'tool',
      source: 'Codex',
      sourceId: 'tool-1',
      title: 'Run tests',
      outcome: 'completed',
      at: 20,
      agent: 'codex',
      sessionId: 'session-1',
    },
  ]);

  assert.equal(events.length, 1);
  assert.equal(events[0].outcome, 'completed');
  assert.equal(events[0].at, 20);
});

await test('activity history excludes events without an authoritative timestamp', () => {
  const events = recentActivityEvents([
    {
      workspace: '/repo/a',
      kind: 'decision',
      source: 'OpenCode',
      sourceId: 'permission',
      title: 'Allow command?',
      outcome: 'waiting',
      at: Number.NaN,
    },
    {
      workspace: '/repo/b',
      kind: 'check',
      source: 'repository',
      sourceId: 'check',
      title: 'npm test',
      outcome: 'passed',
      at: 30,
    },
  ]);

  assert.deepEqual(
    events.map((event) => event.sourceId),
    ['check'],
  );
  assert.deepEqual(activityWorkspaces(events), ['/repo/b']);
});

await test('activity history stays bounded in reverse chronological order', () => {
  const events = recentActivityEvents(
    Array.from({ length: 150 }, (_, index) => ({
      workspace: '/repo/a',
      kind: 'parent' as const,
      source: 'OpenCode',
      sourceId: `session-${index}`,
      title: `Session ${index}`,
      outcome: 'done',
      at: index + 1,
    })),
  );

  assert.equal(events.length, 100);
  assert.equal(events[0].sourceId, 'session-149');
  assert.equal(events.at(-1)?.sourceId, 'session-50');
});

await test('activity history bounds display text without storing output', () => {
  const [event] = recentActivityEvents([
    {
      workspace: '/repo/a',
      kind: 'decision',
      source: 'OpenCode',
      sourceId: 'question',
      title: 'x'.repeat(2_000),
      outcome: 'waiting',
      at: Date.now(),
    },
  ]);

  assert.equal(event.title.length, 240);
  assert.equal(event.title.endsWith('…'), true);
  assert.equal('output' in event, false);
});

await test('permission history retains policy context when the provider title is oversized', () => {
  const title = permissionDecisionTitle('x'.repeat(240), {
    profile: 'explore',
    risk: 'low',
    recommendation: 'allow',
    optionId: 'allow',
    reason: 'Low-risk action is enabled for exploration.',
    policyRevision: '2026-10-07.1',
  });

  const [event] = recentActivityEvents([
    {
      workspace: '/repo/a',
      kind: 'decision',
      source: 'Codex',
      sourceId: 'permission',
      title,
      outcome: 'completed',
      at: 10,
    },
  ]);

  assert.match(
    event.title,
    /^explore · low risk · policy 2026-10-07\.1 — Allowed by policy: Low-risk action is enabled for exploration\./,
  );
  assert.equal(event.title.length, 240);
  assert.equal(event.title.endsWith('…'), true);
});

await test('permission history describes the actual rejected settlement', () => {
  const title = permissionDecisionTitle(
    'Read README.md',
    {
      profile: 'explore',
      risk: 'low',
      recommendation: 'allow',
      optionId: 'allow',
      reason: 'Low-risk action is enabled for exploration.',
      policyRevision: '2026-10-07.1',
    },
    'rejected',
  );

  assert.match(title, /— Rejected:/);
  assert.doesNotMatch(title, /Allowed by policy/);
});

await test('activity history reloads only valid bounded durable events', () => {
  const stored = saveActivityHistory(
    Array.from({ length: 110 }, (_, index) => ({
      id: `event-${index}`,
      workspace: '/repo/a',
      kind: 'decision' as const,
      source: 'Codex',
      sourceId: `decision-${index}`,
      title: `Decision ${index}`,
      outcome: 'completed',
      at: index + 1,
      agent: 'codex',
      sessionId: 'session-1',
    })),
  );

  const restored = loadActivityHistory(stored);
  assert.equal(restored.length, 100);
  assert.equal(restored[0].id, 'event-109');
  assert.deepEqual(loadActivityHistory('{"kind":"tool"}'), []);
  assert.deepEqual(loadActivityHistory('[{"kind":"invented"}]'), []);
});

await test('sequential ACP decisions retain reused provider request IDs', () => {
  const events = recentActivityEvents([
    {
      workspace: '/repo/a',
      kind: 'decision',
      source: 'Codex',
      sourceId: acpPermissionActivitySourceId(7, 1, 'first-fingerprint'),
      title: 'Read first file',
      outcome: 'completed',
      at: 10,
      agent: 'codex',
      sessionId: 'session-1',
    },
    {
      workspace: '/repo/a',
      kind: 'decision',
      source: 'Codex',
      sourceId: acpPermissionActivitySourceId(7, 2, 'second-fingerprint'),
      title: 'Read second file',
      outcome: 'completed',
      at: 20,
      agent: 'codex',
      sessionId: 'session-1',
    },
  ]);

  assert.deepEqual(
    events.map((event) => event.title),
    ['Read second file', 'Read first file'],
  );
});

void test('automatic decisions keep their reason through save and load', () => {
  const saved = saveActivityHistory(
    recentActivityEvents([
      {
        workspace: '/repo',
        kind: 'decision',
        source: 'claude',
        sourceId: 'req-1',
        title: 'Read .env',
        outcome: 'rejected',
        at: 5,
        agent: 'claude',
        sessionId: 's',
        automatic: true,
        reason: `Secrets ${'x'.repeat(300)}`,
      },
    ]),
  );
  const [loaded] = loadActivityHistory(saved);
  assert.equal(loaded.automatic, true);
  assert.equal(loaded.reason?.length, 240);
  assert.deepEqual(loadActivityHistory(JSON.stringify([{ ...loaded, reason: 3 }])), []);
});
