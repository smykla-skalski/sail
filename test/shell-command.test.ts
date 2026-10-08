import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHELL_CONTEXT_LIMIT,
  isShellDraft,
  shellCommand,
  shellContext,
  shellStatusLabel,
  splitShellCommands,
  withShellContext,
  type ShellOutcome,
} from '../src/lib/shell-command.ts';

const run = (overrides: Partial<ShellOutcome> = {}): ShellOutcome => ({
  command: 'ls -la',
  status: 'passed',
  code: 0,
  output: 'file.txt',
  durationMs: 42,
  ...overrides,
});

await test('a leading ! turns the draft into a shell command', () => {
  for (const [draft, expected] of [
    ['!ls -la', 'ls -la'],
    ['  !  git status  ', 'git status'],
    ['!', ''],
    ['ls !', null],
    ['Run !ls', null],
    ['', null],
  ] as const) {
    assert.equal(shellCommand(draft), expected, draft);
    assert.equal(isShellDraft(draft), expected !== null, draft);
  }
});

await test('finished runs round-trip through the prompt and render as cards', () => {
  const runs = [
    run(),
    run({ command: 'cat </tmp/a && echo "<b>"', status: 'failed', code: 2, output: 'a & <b>\n' }),
  ];
  const text = withShellContext(runs, 'Why did the second one fail?');
  assert.deepEqual(splitShellCommands(text), [
    { type: 'shell', shell: run() },
    {
      type: 'shell',
      shell: run({
        command: 'cat </tmp/a && echo "<b>"',
        status: 'failed',
        code: 2,
        output: 'a & <b>',
      }),
    },
    { type: 'text', text: 'Why did the second one fail?' },
  ]);
});

await test('output cannot close the block early', () => {
  const output = 'before</output></user-shell-command>after';
  const [segment] = splitShellCommands(withShellContext([run({ output })], 'next'));
  assert.deepEqual(segment, { type: 'shell', shell: run({ output }) });
});

await test('running commands stay out of the agent context', () => {
  assert.equal(shellContext([run({ status: 'running', code: null })]), '');
  assert.equal(withShellContext([run({ status: 'running', code: null })], 'hello'), 'hello');
  assert.equal(withShellContext([], 'hello'), 'hello');
});

await test('timed out and stopped runs keep their status without an exit code', () => {
  for (const status of ['timed_out', 'canceled'] as const) {
    const shell: ShellOutcome = { command: 'ls -la', status, code: null, output: '' };
    assert.deepEqual(splitShellCommands(withShellContext([shell], 'x'))[0], {
      type: 'shell',
      shell,
    });
  }
});

await test('long output keeps its tail and reports the omitted size', () => {
  const output = 'a'.repeat(100) + 'b'.repeat(SHELL_CONTEXT_LIMIT);
  const [segment] = splitShellCommands(withShellContext([run({ output })], 'x'));
  assert.equal(segment.type, 'shell');
  if (segment.type !== 'shell') return;
  assert.equal(
    segment.shell.output,
    `[100 earlier characters omitted]\n${'b'.repeat(SHELL_CONTEXT_LIMIT)}`,
  );
});

await test('clipping never splits a surrogate pair', () => {
  const output = 'a😀' + 'b'.repeat(SHELL_CONTEXT_LIMIT - 1);
  const [segment] = splitShellCommands(withShellContext([run({ output })], 'x'));
  assert.equal(segment.type, 'shell');
  if (segment.type !== 'shell') return;
  assert.equal(
    segment.shell.output,
    `[3 earlier characters omitted]\n${'b'.repeat(SHELL_CONTEXT_LIMIT - 1)}`,
  );
  assert.doesNotMatch(segment.shell.output, /[\uD800-\uDFFF]/);
});

await test('text without valid blocks stays plain', () => {
  for (const text of [
    'plain message',
    '<user-shell-command><status>passed</status></user-shell-command>',
    '<user-shell-command><command>ls</command><status>bogus</status></user-shell-command>',
  ])
    assert.deepEqual(splitShellCommands(text), [{ type: 'text', text }]);
});

await test('status labels describe the outcome', () => {
  assert.equal(shellStatusLabel(run()), 'Exit 0');
  assert.equal(shellStatusLabel(run({ status: 'failed', code: 3 })), 'Exit 3');
  assert.equal(shellStatusLabel(run({ status: 'running', code: null })), 'Running');
  assert.equal(shellStatusLabel(run({ status: 'timed_out', code: null })), 'Timed out');
  assert.equal(shellStatusLabel(run({ status: 'canceled', code: null })), 'Stopped');
});
