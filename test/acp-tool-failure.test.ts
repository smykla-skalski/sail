import assert from 'node:assert/strict';
import test from 'node:test';
import { updateEntries, type AgentTool } from '../src/lib/acp.ts';
import {
  acpToolFailure,
  fixAcpToolFailurePrompt,
  prepareAcpFailureDraft,
} from '../src/lib/acp-tool-failure.ts';

const tool = (changes: Partial<AgentTool>): AgentTool => ({
  id: 'call-1',
  type: 'tool',
  title: 'Run command',
  status: 'failed',
  content: '',
  terminalIds: [],
  ...changes,
});

void test('hook failure exposes action, rule, reason, output, and follow-up prompt', () => {
  const failure = acpToolFailure(
    tool({
      input: { command: 'git commit -m test' },
      content: 'PreToolUse:Bash says: ❌ GIT010: Add -s -S flags',
    }),
  );
  assert.deepEqual(failure, {
    kind: 'hook',
    action: 'git commit -m test',
    rule: 'GIT010',
    reason: 'Add -s -S flags',
    output: 'PreToolUse:Bash says: ❌ GIT010: Add -s -S flags',
  });
  assert.match(fixAcpToolFailurePrompt(failure), /Rule or hook: GIT010/);
  assert.match(fixAcpToolFailurePrompt(failure), /Add -s -S flags/);
});

void test('structured hook metadata works without Klaudiush formatting', () => {
  const failure = acpToolFailure(
    tool({ output: { hookName: 'secret-scan', reason: 'Secret found', stderr: 'Blocked' } }),
  );
  assert.equal(failure?.kind, 'hook');
  assert.equal(failure?.rule, 'secret-scan');
  assert.equal(failure?.reason, 'Secret found');
  assert.match(failure?.output ?? '', /Blocked/);
  const namedRule = acpToolFailure(
    tool({ output: { ruleName: 'GIT020', stderr: 'Branch name rejected' } }),
  );
  assert.equal(namedRule?.kind, 'hook');
  assert.equal(namedRule?.rule, 'GIT020');
  assert.equal(namedRule?.reason, 'Branch name rejected');
  assert.equal(
    acpToolFailure(tool({ output: { error: { message: 'Permission denied' } } }))?.reason,
    'Permission denied',
  );
  assert.equal(
    acpToolFailure(tool({ output: { output: 'Permission denied' } }))?.reason,
    'Permission denied',
  );
});

void test('ordinary tool errors stay labeled as tool failures', () => {
  const failure = acpToolFailure(tool({ content: 'File not found' }));
  assert.equal(failure?.kind, 'tool');
  assert.equal(failure?.rule, null);
  assert.equal(failure?.reason, 'File not found');
  assert.doesNotMatch(fixAcpToolFailurePrompt(failure), /reported rule/);
  assert.match(fixAcpToolFailurePrompt(failure), /failure details/);
  assert.equal(
    acpToolFailure(tool({ content: 'Error: expected PreToolUse response from parser' }))?.kind,
    'tool',
  );
  assert.equal(
    acpToolFailure(tool({ output: { stderr: 'Command exited 7' } }))?.reason,
    'Command exited 7',
  );
  assert.equal(
    acpToolFailure(tool({ status: 'completed', content: 'hook blocked example' })),
    null,
  );
});

void test('post-action hook failures avoid implying the action was blocked', () => {
  const failure = acpToolFailure(
    tool({
      content: 'PostToolUse:Bash says: Audit check failed',
      output: { hookName: 'audit', hookEvent: 'PostToolUse' },
    }),
  );
  assert.equal(failure?.kind, 'post-hook');
  assert.equal(failure?.rule, 'audit');
  assert.match(fixAcpToolFailurePrompt(failure), /Check the action result before retrying/);
  assert.doesNotMatch(fixAcpToolFailurePrompt(failure), /hook-blocked action/);
});

void test('repeated ACP updates keep one card with the latest result', () => {
  const started = updateEntries([], {
    sessionUpdate: 'tool_call',
    toolCallId: 'call-1',
    title: 'Run command',
    status: 'pending',
  });
  const failed = updateEntries(started, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'First error' } }],
  });
  const revised = updateEntries(failed, {
    sessionUpdate: 'tool_call_update',
    toolCallId: 'call-1',
    status: 'failed',
    content: [{ type: 'content', content: { type: 'text', text: 'Latest error' } }],
  });
  assert.equal(revised.length, 1);
  assert.equal(revised[0]?.type === 'tool' && acpToolFailure(revised[0])?.reason, 'Latest error');
});

void test('revised failures replace stale draft details without duplicating them', () => {
  const first = acpToolFailure(tool({ content: 'First error' }))!;
  const latest = acpToolFailure(tool({ content: 'Latest error' }))!;
  const prepared = new Map<string, string>();
  const draft = prepareAcpFailureDraft('  Keep this context.\n', prepared, 'session:call-1', first);
  const revised = prepareAcpFailureDraft(draft, prepared, 'session:call-1', latest);
  assert.ok(revised.startsWith('  Keep this context.\n'));
  assert.match(revised, /Latest error/);
  assert.doesNotMatch(revised, /First error/);
  assert.equal(prepareAcpFailureDraft(revised, prepared, 'session:call-1', latest), revised);
  assert.match(
    prepareAcpFailureDraft('My replacement', prepared, 'session:call-1', latest),
    /Latest error/,
  );
});

void test('revised failure replaces its own draft after another failure was prepared', () => {
  const prepared = new Map<string, string>();
  const oldA = acpToolFailure(tool({ content: 'Old A' }))!;
  const newA = acpToolFailure(tool({ content: 'New A' }))!;
  const failureB = acpToolFailure(tool({ content: 'Failure B' }))!;
  const first = prepareAcpFailureDraft('', prepared, 'session:A', oldA);
  const second = prepareAcpFailureDraft(first, prepared, 'session:B', failureB);
  const revised = prepareAcpFailureDraft(second, prepared, 'session:A', newA);
  assert.match(revised, /New A/);
  assert.match(revised, /Failure B/);
  assert.doesNotMatch(revised, /Old A/);
});
