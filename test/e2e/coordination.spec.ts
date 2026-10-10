import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
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
