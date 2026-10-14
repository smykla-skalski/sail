import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { createConnection } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

async function deliverHook(sessionId: string) {
  const file = process.env.SAIL_HOOK_CONNECTION_FILE;
  if (!file) throw new Error('E2E hook connection file is not configured');
  const connection: unknown = JSON.parse(readFileSync(file, 'utf8'));
  if (
    !connection ||
    typeof connection !== 'object' ||
    !('port' in connection) ||
    !('token' in connection) ||
    typeof connection.port !== 'number' ||
    typeof connection.token !== 'string'
  )
    throw new Error('Invalid E2E hook connection file');
  const { port, token } = connection;
  const reply = await new Promise<string>((resolve, reject) => {
    const socket = createConnection({ host: '127.0.0.1', port }, () => {
      socket.end(
        JSON.stringify({
          token,
          event: {
            session_id: sessionId,
            hook_event_name: 'PreToolUse',
            tool_name: 'Read',
          },
        }),
      );
    });
    let response = '';
    socket.setTimeout(5_000, () => socket.destroy(new Error('Hook delivery timed out')));
    socket.on('data', (data) => (response += data.toString()));
    socket.on('end', () => resolve(response));
    socket.on('error', reject);
  });
  expect(reply).toBe('ok\n');
}

function savedSessionId() {
  return browser.execute(() => {
    const threads = JSON.parse(localStorage.getItem('sail-agent-threads') ?? '[]');
    return threads.find((thread: { agent: string }) => thread.agent === 'claude')?.sessionId;
  });
}

describe('transcript activity ordering', () => {
  const repository = realpathSync(mkdtempSync(join(tmpdir(), 'sail-transcript-activity-')));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('shows a native hook and completed post-turn check in event order around a thinking turn', async () => {
    await browser.execute((directory) => {
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.setItem('sai-post-turn-personal', JSON.stringify(['printf transcript-check']));
    }, repository);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));

    await browser.waitUntil(async () => typeof (await savedSessionId()) === 'string', {
      timeoutMsg: 'Claude session was not saved',
    });
    const sessionId = await savedSessionId();
    if (typeof sessionId !== 'string') throw new Error('Claude session was not saved');
    await deliverHook(sessionId);
    await expect($('.hook-activity')).toHaveText(expect.stringContaining('PreToolUse'));

    await $('.agent-composer [data-pane-prompt]').setValue('Thinking demo');
    await $('.agent-actions button:last-child').click();
    await expect($('.assistant-message.thought')).toHaveText(
      expect.stringContaining('I should inspect the result.'),
    );
    await expect($('.assistant-message:not(.thought)')).toHaveText(
      expect.stringContaining('The result is ready.'),
    );
    try {
      await expect($('.post-turn-check')).toHaveText(expect.stringContaining('transcript-check'));
    } catch (cause) {
      console.error('Transcript check diagnostic', {
        setting: await browser.execute(() => localStorage.getItem('sai-post-turn-personal')),
        checks: await browser.execute(async () => {
          const tauri = Reflect.get(window, '__TAURI__');
          return tauri.core.invoke('list_post_turn_checks');
        }),
        transcript: await $('.agent-conversation').getText(),
      });
      throw cause;
    }

    const order = await browser.execute(() =>
      [
        ...document.querySelectorAll(
          '.agent-conversation .hook-activity, .agent-conversation .message, .agent-conversation .post-turn-check',
        ),
      ].map((node) =>
        node.classList.contains('hook-activity')
          ? 'hook'
          : node.classList.contains('post-turn-check')
            ? 'check'
            : node.classList.contains('thought')
              ? 'thought'
              : node.classList.contains('user-message')
                ? 'user'
                : 'answer',
      ),
    );
    expect(order).toEqual(['hook', 'user', 'thought', 'answer', 'check']);

    await browser.refresh();
    await expect($('.hook-activity')).toBeDisplayed();
    await expect($('.post-turn-check')).toHaveText(expect.stringContaining('transcript-check'));
  });
});
