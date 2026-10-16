import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acpUsage, contextUsageLabel } from '../src/lib/agent-usage.ts';

void test('ACP context uses reported numbers and hides invalid reports', () => {
  assert.deepEqual(acpUsage({ sessionUpdate: 'usage_update', used: 25, size: 100 }), {
    context: 25,
    contextTokens: 25,
    contextWindow: 100,
  });
  assert.deepEqual(acpUsage({ sessionUpdate: 'usage_update', used: 110, size: 100 }), {
    context: 100,
    contextTokens: 110,
    contextWindow: 100,
  });
  for (const [used, size] of [
    [null, 100],
    [10, 0],
    [-1, 100],
    [Infinity, 100],
  ])
    assert.deepEqual(acpUsage({ sessionUpdate: 'usage_update', used, size }), {
      context: undefined,
      contextTokens: undefined,
      contextWindow: undefined,
    });
  assert.equal(acpUsage({ sessionUpdate: 'agent_message_chunk' }), null);
});

void test('Claude quota appears only for reported utilization', () => {
  const usage = acpUsage({
    sessionUpdate: 'usage_update',
    used: 50,
    size: 100,
    _meta: {
      '_claude/rateLimit': {
        status: 'allowed',
        unifiedWindows: {
          five_hour: { utilization: 0.24 },
          seven_day: { utilization: 0.13 },
        },
      },
    },
  });
  assert.deepEqual(usage, {
    context: 50,
    contextTokens: 50,
    contextWindow: 100,
    rates: [
      { label: '5h', remaining: 76 },
      { label: '7d', remaining: 87 },
    ],
  });
  assert.deepEqual(
    acpUsage({
      sessionUpdate: 'usage_update',
      used: 50,
      size: 100,
      _meta: { '_claude/rateLimit': { status: 'allowed', resetsAt: 100 } },
    }),
    { context: 50, contextTokens: 50, contextWindow: 100, rates: [] },
  );
  assert.deepEqual(
    acpUsage({
      sessionUpdate: 'usage_update',
      used: 50,
      size: 100,
      _meta: { '_claude/rateLimit': { rateLimitType: 'five_hour', utilization: 2 } },
    }),
    { context: 50, contextTokens: 50, contextWindow: 100, rates: [] },
  );
  assert.deepEqual(
    acpUsage({
      sessionUpdate: 'usage_update',
      used: 50,
      size: 100,
      _meta: {
        '_claude/rateLimit': {
          rateLimitType: 'five_hour',
          utilization: 0.5,
          resetsAt: 1,
        },
      },
    }),
    { context: 50, contextTokens: 50, contextWindow: 100, rates: [] },
  );
});

void test('provider windows preserve absolute usage before rounding the percentage', () => {
  for (const size of [200_000, 258_400, 1_000_000]) {
    const usage = acpUsage({ sessionUpdate: 'usage_update', used: 99_999, size });
    assert.equal(usage?.contextTokens, 99_999);
    assert.equal(usage?.contextWindow, size);
    assert.match(contextUsageLabel(usage ?? {}), new RegExp(size.toLocaleString('en-US')));
  }
  assert.equal(contextUsageLabel({}), 'Context window unknown');
});
