import assert from 'node:assert/strict';
import test from 'node:test';
import {
  enqueueShellResults,
  queuedAgentMessages,
  queuedTurnDisposition,
  saveQueuedAgentMessages,
  setAgentQueuePaused,
  agentQueuePaused,
} from '../src/lib/agent-queue.ts';
import { splitShellCommands, type ShellRun } from '../src/lib/shell-command.ts';

const shellRun = (overrides: Partial<ShellRun> = {}): ShellRun => ({
  id: 'run',
  directory: '/repo',
  session: 'origin',
  command: 'printf hello',
  status: 'passed',
  code: 0,
  output: 'hello',
  created: 1,
  ...overrides,
});

void test('completed shell commands become standalone queued messages exactly once', () => {
  const existing = { text: 'Already queued', images: [], attachments: [] };
  const running = shellRun({ id: 'running', status: 'running' });
  const result = enqueueShellResults('shell-test', [shellRun(), running], 'origin', [existing]);
  assert.deepEqual(result.runs, [running]);
  assert.equal(result.queue[0], existing);
  assert.equal(result.queue.length, 2);
  assert.deepEqual(splitShellCommands(result.queue[1].text), [
    {
      type: 'shell',
      shell: { command: 'printf hello', status: 'passed', code: 0, output: 'hello' },
    },
  ]);
  assert.deepEqual(result.queue[1].attachments, []);
  assert.deepEqual(result.queue[1].images, []);
  assert.deepEqual(enqueueShellResults('shell-test', result.runs, 'origin', result.queue), result);
  saveQueuedAgentMessages('shell-test', '/repo', 'origin', []);
});

void test('results completed after switching sessions queue only for their origin', () => {
  const result = enqueueShellResults('switch-test', [shellRun()], 'other', []);
  assert.deepEqual(result.queue, []);
  assert.deepEqual(result.runs, []);
  assert.equal(queuedAgentMessages('switch-test', '/repo', 'origin').length, 1);
  assert.deepEqual(queuedAgentMessages('switch-test', '/repo', 'other'), []);
  saveQueuedAgentMessages('switch-test', '/repo', 'origin', []);
});

void test('failed, canceled and timed out commands preserve their outcomes in a paused queue', () => {
  setAgentQueuePaused('paused-test', '/repo', 'origin', true);
  const runs = (['failed', 'canceled', 'timed_out'] as const).map((status) =>
    shellRun({ status, code: null }),
  );
  const result = enqueueShellResults('paused-test', runs, 'origin', []);
  assert.equal(result.queue.length, 3);
  assert.deepEqual(
    result.queue
      .flatMap((message) => splitShellCommands(message.text))
      .map((segment) => segment.type === 'shell' && segment.shell.status),
    ['failed', 'canceled', 'timed_out'],
  );
  assert.equal(agentQueuePaused('paused-test', '/repo', 'origin'), true);
  saveQueuedAgentMessages('paused-test', '/repo', 'origin', []);
  setAgentQueuePaused('paused-test', '/repo', 'origin', false);
});

void test('commands in a new conversation queue without an existing model session', () => {
  const result = enqueueShellResults('new-test', [shellRun({ session: null })], null, []);
  assert.equal(result.queue.length, 1);
  assert.deepEqual(result.runs, []);
});

void test('a completed prompt stays delivered after local bookkeeping fails', () => {
  assert.equal(queuedTurnDisposition('done', null), 'completed');
  assert.equal(queuedTurnDisposition(null, 'done'), 'completed');
});

void test('a dispatched prompt is never placed back in the automatic retry queue', () => {
  assert.equal(queuedTurnDisposition('failed', 'failed'), 'sent');
  assert.equal(queuedTurnDisposition(null, 'dispatched'), 'sent');
  assert.equal(queuedTurnDisposition('interrupted', null), 'sent');
  assert.equal(queuedTurnDisposition(null, 'dispatch_uncertain'), 'uncertain');
});

void test('only a prompt with no dispatch evidence can be retried automatically', () => {
  assert.equal(queuedTurnDisposition(null, 'prepared'), 'unsent');
  assert.equal(queuedTurnDisposition(null, null), 'unsent');
});
