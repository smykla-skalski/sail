import { browser, $, expect } from '@wdio/globals';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

type McpConfig = { command: string; args: string[]; env: Record<string, string> };
const failure = z.object({ error: z.string() });
const created = z.object({ terminalId: z.string(), paneId: z.string(), worktree: z.string() });
const output = z.object({
  state: z.string(),
  exitCode: z.number().nullable(),
  output: z.string(),
  cursor: z.number(),
});

function callMcp(config: McpConfig, sessionId: string, name: string, args: object) {
  const raw = execFileSync(config.command, config.args, {
    env: { ...process.env, ...config.env },
    input: `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, _meta: { sessionID: sessionId } },
    })}\n`,
    encoding: 'utf8',
    timeout: 40_000,
  });
  const result = z
    .object({
      result: z.object({
        isError: z.boolean().optional(),
        content: z.array(z.object({ text: z.string() })),
      }),
    })
    .parse(JSON.parse(raw.trim())).result;
  return result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text);
}

function callMcpAsync(config: McpConfig, sessionId: string, name: string, args: object) {
  const child = spawn(config.command, config.args, {
    env: { ...process.env, ...config.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
  child.stdin.end(
    `${JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name, arguments: args, _meta: { sessionID: sessionId } },
    })}\n`,
  );
  return new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 40_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) return reject(new Error(`MCP process exited ${code}: ${stderr}`));
      const result = z
        .object({
          result: z.object({
            isError: z.boolean().optional(),
            content: z.array(z.object({ text: z.string() })),
          }),
        })
        .parse(JSON.parse(stdout.trim())).result;
      resolve(
        result.isError ? { error: result.content[0].text } : JSON.parse(result.content[0].text),
      );
    });
  });
}

describe('owned MCP terminals', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-owned-terminal-'));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('gates execution, isolates owners, reports exit, and invalidates closed IDs', async () => {
    execFileSync('git', ['init', '-q', repository]);
    const path = realpathSync(repository);
    await browser.execute((directory) => {
      localStorage.removeItem('sai-pane-layouts');
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem('sai-agent-terminals-enabled', 'false');
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
    }, path);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const sessions = await browser.tauri.execute(async ({ core }, directory) => {
      await core.invoke('acp_connect', { agent: 'claude' });
      return Promise.all([
        core.invoke<{ sessionId: string }>('acp_new_session', {
          params: { agent: 'claude', cwd: directory },
        }),
        core.invoke<{ sessionId: string }>('acp_new_session', {
          params: { agent: 'claude', cwd: directory },
        }),
      ]);
    }, path);
    await browser.execute(
      (directory, ids) => {
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify(
            ids.map((session, index) => ({
              agent: 'claude',
              sessionId: session.sessionId,
              directory,
              title: `Owner ${index + 1}`,
              updated: Date.now(),
            })),
          ),
        );
      },
      path,
      sessions,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const firstOwner = sessions[0].sessionId;
    const secondOwner = sessions[1].sessionId;
    const [config, secondConfig] = await browser.tauri.execute(
      async ({ core }, input) =>
        Promise.all(
          input.sessions.map((session) =>
            core.invoke<McpConfig>('browser_mcp_config', {
              directory: input.directory,
              session: session.sessionId,
              agent: 'claude',
            }),
          ),
        ),
      { directory: path, sessions },
    );
    expect(
      failure.parse(callMcp(config, firstOwner, 'terminal_create', { command: 'printf denied' }))
        .error,
    ).toContain('disabled');
    await browser.tauri.execute(async ({ core }) =>
      core.invoke('save_setting', { key: 'sai-agent-terminals-enabled', value: 'true' }),
    );
    await browser.execute(() => localStorage.setItem('sai-agent-terminals-enabled', 'true'));
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const [firstResponse, secondResponse] = await Promise.all([
      callMcpAsync(config, firstOwner, 'terminal_create', {
        command: 'printf SAIL144_START; read value; printf "%s" "$value"; exit 7',
      }),
      callMcpAsync(secondConfig, secondOwner, 'terminal_create', { command: 'sleep 30' }),
    ]);
    const first = created.parse(firstResponse);
    const second = created.parse(secondResponse);
    const sharedConfig = await browser.tauri.execute(
      async ({ core }, directory) => core.invoke<McpConfig>('browser_mcp_config', { directory }),
      path,
    );
    expect(
      failure.parse(
        callMcp(sharedConfig, firstOwner, 'terminal_stop', { terminalId: first.terminalId }),
      ).error,
    ).toContain('session-bound');
    expect(second.terminalId).not.toBe(first.terminalId);
    expect(first.worktree).toBe(path);
    await expect($(`[data-pane-id="${first.paneId}"]`)).toBeDisplayed();
    await expect($(`[data-pane-id="${second.paneId}"]`)).toBeDisplayed();
    await expect($(`[data-pane-id="${first.paneId}"] .pane-heading`)).toHaveText(
      expect.stringContaining('Owner 1'),
    );
    for (const name of ['terminal_write', 'terminal_stop']) {
      const args =
        name === 'terminal_write'
          ? { terminalId: first.terminalId, data: 'intrude\n' }
          : { terminalId: first.terminalId };
      expect(failure.parse(callMcp(secondConfig, secondOwner, name, args)).error).toContain(
        'another source session',
      );
    }
    expect(
      failure.parse(
        callMcp(config, firstOwner, 'terminal_write', {
          terminalId: second.terminalId,
          data: 'intrude\n',
        }),
      ).error,
    ).toContain('another source session');
    expect(
      failure.parse(
        callMcp(config, firstOwner, 'terminal_write', {
          terminalId: first.terminalId,
          data: 'x'.repeat(16_385),
        }),
      ).error,
    ).toContain('16384');
    callMcp(config, firstOwner, 'terminal_write', {
      terminalId: first.terminalId,
      data: 'SUCCESS\n',
    });
    let page = output.parse(
      callMcp(config, firstOwner, 'terminal_read', { terminalId: first.terminalId }),
    );
    for (let attempt = 0; attempt < 4 && page.state === 'running'; attempt++)
      page = output.parse(
        callMcp(config, firstOwner, 'terminal_wait', {
          terminalId: first.terminalId,
          cursor: page.cursor,
          timeoutMs: 5_000,
        }),
      );
    expect(page.state).toBe('exited');
    expect(page.exitCode).toBe(7);
    expect(page.output).toContain('SUCCESS');
    callMcp(secondConfig, secondOwner, 'terminal_stop', { terminalId: second.terminalId });
    let stopped = output.parse(
      callMcp(secondConfig, secondOwner, 'terminal_read', { terminalId: second.terminalId }),
    );
    for (let attempt = 0; attempt < 4 && stopped.state === 'running'; attempt++)
      stopped = output.parse(
        callMcp(secondConfig, secondOwner, 'terminal_wait', {
          terminalId: second.terminalId,
          cursor: stopped.cursor,
          timeoutMs: 5_000,
        }),
      );
    expect(stopped.state).toBe('exited');
    await $(
      `[data-pane-id="${second.paneId}"] .pane-heading button[aria-label="Close pane"]`,
    ).click();
    expect(
      failure.parse(
        callMcp(secondConfig, secondOwner, 'terminal_stop', {
          terminalId: second.terminalId,
        }),
      ).error,
    ).toContain('Unknown terminal ID');
  });
});
