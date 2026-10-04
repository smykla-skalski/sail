import assert from 'node:assert/strict';
import test from 'node:test';
import {
  openCodeErrorDetails,
  reportedHookIdentity,
  toolFailurePrompt,
} from '../src/lib/tool-failure.ts';

void test('failure follow-up includes the action, reason, and output', () => {
  assert.equal(
    toolFailurePrompt(
      'bash',
      { command: 'npm test', workdir: '/repo/pkg' },
      'Process exited 1',
      'Assertion failed',
    ),
    'Fix the failed bash action. Inspect the cause, make the needed change, and verify it.\n\nCommand:\nnpm test\n\nInput:\n{\n  "command": "npm test",\n  "workdir": "/repo/pkg"\n}\n\nError:\nProcess exited 1\n\nOutput:\nAssertion failed',
  );
});

void test('structured OpenCode error details include response body and a fallback reason', () => {
  assert.equal(
    openCodeErrorDetails({
      type: 'HttpError',
      message: 'Request failed',
      response: { body: 'Denied' },
    }),
    'Request failed\n\nDenied',
  );
  assert.equal(openCodeErrorDetails({ type: 'PluginError', message: '' }), 'PluginError');
});

void test('hook identity comes only from reported metadata', () => {
  assert.equal(reportedHookIdentity(undefined), null);
  assert.equal(reportedHookIdentity({ source: 'plugin', name: 'guessed-name' }), null);
  assert.equal(reportedHookIdentity({ hook: 'pre-tool-check' }), 'pre-tool-check');
  assert.equal(reportedHookIdentity({ plugin: 'policy', hook: 'pre-tool-check' }), 'policy');
});
