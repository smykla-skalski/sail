import assert from 'node:assert/strict';
import test from 'node:test';
import { resetAgentFixture } from './e2e/fixture-lifecycle.ts';

const request = (method: string, sessionId: string, id?: number) => ({
  agent: 'codex',
  directory: '/fixture',
  profile: 'full',
  message: { id, method, params: { sessionId } },
});

await test('fixture cleanup settles requests revealed by an earlier cancellation', async () => {
  const inbox = [
    request('elicitation/create', 'first', 7),
    request('session/request_permission', 'first'),
  ];
  const calls: string[] = [];
  let revealed = false;
  await resetAgentFixture(
    async (command, args) => {
      calls.push(command);
      if (command === 'acp_pending_inbox') return [...inbox];
      if (command === 'acp_reset_test_runtimes') return null;
      if (!args) throw new Error(`Missing arguments for ${command}`);
      if (command === 'acp_elicitation') {
        const params = Reflect.get(args, 'params');
        assert.equal(Reflect.get(params, 'action'), 'cancel');
        const id = Reflect.get(params, 'requestId');
        inbox.splice(
          inbox.findIndex((item) => item.message.id === id),
          1,
        );
        return null;
      }
      if (command === 'acp_cancel') {
        const sessionId = Reflect.get(args, 'sessionId');
        const index = inbox.findIndex((item) => item.message.params.sessionId === sessionId);
        inbox.splice(index, 1);
        if (!revealed) inbox.push(request('elicitation/create', 'follow-up', 9));
        revealed = true;
        return null;
      }
      throw new Error(`Unexpected command: ${command}`);
    },
    async () => {},
  );
  assert.equal(revealed, true);
  assert.equal(calls.filter((call) => call === 'acp_elicitation').length, 2);
  assert.equal(calls.filter((call) => call === 'acp_cancel').length, 1);
  assert.ok(calls.filter((call) => call === 'acp_reset_test_runtimes').length >= 2);
});

await test('fixture cleanup rejects requests it cannot settle', async () => {
  await assert.rejects(
    resetAgentFixture(
      async (command) =>
        command === 'acp_pending_inbox' ? [request('unsupported/request', 'first')] : null,
      async () => {},
    ),
    /Unexpected pending request: unsupported\/request/,
  );
});

await test('fixture cleanup fails when requests keep reappearing', async () => {
  let reads = 0;
  await assert.rejects(
    resetAgentFixture(
      async (command) => {
        if (command === 'acp_pending_inbox') {
          reads += 1;
          return [request('session/request_permission', `session-${reads}`)];
        }
        return null;
      },
      async () => {},
    ),
    /remained after 10 cleanup passes/,
  );
});
