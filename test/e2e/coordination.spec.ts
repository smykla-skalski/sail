import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent coordination bridge', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-coordination-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('automatically exposes the Sail skill to connected agents', async () => {
    const config = await browser.tauri.execute(
      async ({ core }, directory) =>
        core.invoke<{ command: string; args: string[]; env: Record<string, string> }>(
          'browser_mcp_config',
          { directory, agent: 'claude' },
        ),
      realpathSync(repository),
    );
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize' },
      { jsonrpc: '2.0', id: 2, method: 'tools/list' },
      {
        jsonrpc: '2.0',
        id: 3,
        method: 'tools/call',
        params: { name: 'sail_skill', arguments: {} },
      },
    ];
    const output = execFileSync(config.command, config.args, {
      env: { ...process.env, ...config.env },
      input: `${requests.map((request) => JSON.stringify(request)).join('\n')}\n`,
      timeout: 30_000,
      encoding: 'utf8',
    });
    const [initialization, tools, skill] = output
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    expect(initialization.result.instructions).toContain('# Sail');
    expect(initialization.result.instructions).toContain('agent_spawn');
    expect(initialization.result.instructions).toContain('## Shared memory');
    expect(initialization.result.instructions).toContain('use the `sail-browser` memory tools');
    expect(tools.result.tools.map((tool: { name: string }) => tool.name)).toContain('sail_skill');
    expect(tools.result.tools).toContainEqual(
      expect.objectContaining({
        name: 'validation_gate',
        inputSchema: expect.objectContaining({
          required: ['gate', 'prompt'],
          properties: expect.objectContaining({
            gate: expect.objectContaining({
              enum: ['inline-review', 'code-adversary', 'findings-adversary', 'test-adversary'],
            }),
          }),
        }),
      }),
    );
    expect(tools.result.tools).toContainEqual(
      expect.objectContaining({
        name: 'ship_progress',
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            gate: expect.objectContaining({
              enum: ['inline-review', 'code-adversary', 'findings-adversary', 'test-adversary'],
            }),
          }),
        }),
      }),
    );
    expect(tools.result.tools).toContainEqual(
      expect.objectContaining({
        name: 'agent_spawn',
        inputSchema: expect.objectContaining({
          properties: expect.objectContaining({
            role: expect.objectContaining({
              enum: ['exploration', 'implementation', 'debugging', 'review', 'ci-triage'],
            }),
            risk: expect.objectContaining({ enum: ['low', 'medium', 'high'] }),
          }),
          required: ['prompt'],
        }),
      }),
    );
    expect(skill.result.content[0].text).toBe(initialization.result.instructions);
  });

  it('delivers a queued message to a session absent from the saved threads', async () => {
    const path = realpathSync(repository);
    const sessionId = 'claude-external-coordination';
    const messageId = 'external-coordination-message';
    writeFileSync(
      join(path, '.acp-external-sessions.json'),
      JSON.stringify([
        { sessionId, title: 'External recipient', updatedAt: new Date().toISOString() },
      ]),
    );
    await browser.execute(
      ({ directory, session, message }) => {
        localStorage.setItem('sai-directory', directory);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
        );
        localStorage.setItem('sail-agent-threads', '[]');
        localStorage.setItem(
          'sai-coordination-messages',
          JSON.stringify([
            {
              id: message,
              target: `${directory}\0acp:claude:${session}`,
              sender: 'Another agent',
              text: 'Read the recovered message',
              created: Date.now(),
            },
          ]),
        );
      },
      { directory: path, session: sessionId, message: messageId },
    );
    await browser.refresh();
    try {
      await browser.waitUntil(
        () =>
          browser.execute(
            (message) =>
              JSON.parse(localStorage.getItem('sai-coordination-messages') ?? '[]').find(
                (item: { id: string }) => item.id === message,
              )?.delivered === true,
            messageId,
          ),
        { timeout: 30_000, timeoutMsg: 'Message was not delivered to the recovered session' },
      );
    } catch (cause) {
      console.error('Coordination recovery diagnostic', {
        state: await browser.execute(() => ({
          messages: localStorage.getItem('sai-coordination-messages'),
          catalog: localStorage.getItem('sai-project-catalog'),
          threads: localStorage.getItem('sail-agent-threads'),
          visibleText: document.body.innerText.slice(0, 2000),
        })),
        activity: await browser.tauri.execute(async ({ core }) => core.invoke('acp_activity')),
      });
      throw cause;
    }
  });

  it('recovers an OpenCode session and accepts its reply when listing fails', async () => {
    const path = realpathSync(repository);
    const sessionId = 'opencode-external-coordination';
    const targetSessionId = 'claude-external-reply-target';
    const messageId = 'opencode-external-message';
    writeFileSync(join(path, '.acp-session-list-error'), '');
    writeFileSync(
      join(path, '.acp-external-sessions.json'),
      JSON.stringify([
        { sessionId, title: 'External OpenCode recipient', updatedAt: new Date().toISOString() },
        {
          sessionId: targetSessionId,
          title: 'Claude reply target',
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
    await browser.execute(
      ({ directory, session, targetSession, message }) => {
        localStorage.setItem('sai-directory', directory);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
        );
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            {
              agent: 'claude',
              directory,
              sessionId: targetSession,
              title: 'Claude reply target',
              updated: Date.now(),
            },
          ]),
        );
        localStorage.setItem(
          'sai-coordination-messages',
          JSON.stringify([
            {
              id: message,
              target: `${directory}\0acp:opencode:${session}`,
              sender: 'Another agent',
              text: 'Read the recovered message',
              created: Date.now(),
            },
          ]),
        );
      },
      {
        directory: path,
        session: sessionId,
        targetSession: targetSessionId,
        message: messageId,
      },
    );
    await browser.refresh();
    await browser.waitUntil(
      () =>
        browser.execute(
          ({ message, session }) => {
            const messages = JSON.parse(localStorage.getItem('sai-coordination-messages') ?? '[]');
            const threads = JSON.parse(localStorage.getItem('sail-agent-threads') ?? '[]');
            return (
              messages.find((item: { id: string }) => item.id === message)?.delivered === true &&
              threads.some(
                (thread: { agent: string; sessionId: string }) =>
                  thread.agent === 'opencode' && thread.sessionId === session,
              )
            );
          },
          { message: messageId, session: sessionId },
        ),
      {
        timeout: 30_000,
        timeoutMsg: 'OpenCode message was not delivered with the source session registered',
      },
    );
    const config = await browser.tauri.execute(
      async ({ core }, directory) =>
        core.invoke<{ command: string; args: string[]; env: Record<string, string> }>(
          'browser_mcp_config',
          { directory, agent: 'opencode' },
        ),
      path,
    );
    const response = execFileSync(config.command, config.args, {
      env: { ...process.env, ...config.env },
      input: `${JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/call',
        params: {
          name: 'thread_message',
          arguments: {
            threadId: `acp:claude:${targetSessionId}`,
            text: 'Reply from recovered OpenCode session',
          },
          _meta: { sessionID: sessionId },
        },
      })}\n`,
      timeout: 30_000,
      encoding: 'utf8',
    });
    const result = JSON.parse(response.trim());
    expect(result.result.isError).not.toBe(true);
    await browser.waitUntil(
      () =>
        browser.execute(
          (targetSession) =>
            JSON.parse(localStorage.getItem('sai-coordination-messages') ?? '[]').some(
              (item: { target: string; text: string; delivered?: boolean }) =>
                item.target.endsWith(`acp:claude:${targetSession}`) &&
                item.text === 'Reply from recovered OpenCode session' &&
                item.delivered === true,
            ),
          targetSessionId,
        ),
      { timeout: 30_000, timeoutMsg: 'OpenCode reply was not delivered to the Claude target' },
    );
  });

  it('rejects a saved ACP source session that is no longer running', async () => {
    const path = realpathSync(repository);
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.setItem(
        'sail-agent-threads',
        JSON.stringify([
          {
            agent: 'claude',
            directory,
            sessionId: 'test-stale-session',
            title: 'Stale ACP source',
            updated: Date.now(),
          },
        ]),
      );
    }, path);
    await browser.refresh();
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          document
            .querySelector('.breadcrumb-project')
            ?.textContent?.includes('sail-coordination-'),
        ),
      { timeout: 15_000, timeoutMsg: 'Test repository did not load' },
    );
    const config = await browser.tauri.execute(
      async ({ core }, directory) =>
        core.invoke<{ command: string; args: string[]; env: Record<string, string> }>(
          'browser_mcp_config',
          { directory, agent: 'claude' },
        ),
      path,
    );
    let response: string;
    try {
      response = execFileSync(config.command, config.args, {
        env: { ...process.env, ...config.env },
        input: `${JSON.stringify({
          jsonrpc: '2.0',
          id: 1,
          method: 'tools/call',
          params: {
            name: 'worktree_list',
            arguments: {},
            _meta: { sessionID: 'test-stale-session' },
          },
        })}\n`,
        timeout: 30_000,
        encoding: 'utf8',
      });
    } catch (error) {
      console.error('MCP process failed', { error, command: config.command, args: config.args });
      throw error;
    }
    const result = JSON.parse(response.trim());
    expect(result.result.isError).toBe(true);
    expect(result.result.content[0].text).toContain('The source agent session is unavailable.');
  });
});
