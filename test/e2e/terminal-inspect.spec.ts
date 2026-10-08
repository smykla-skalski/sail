import { browser, $, expect } from '@wdio/globals';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

type McpConfig = { command: string; args: string[]; env: Record<string, string> };
const terminal = z.object({
  terminalId: z.string(),
  paneId: z.string().optional(),
  worktree: z.string(),
  state: z.enum(['running', 'exited']),
  exitCode: z.number().nullable(),
  cursor: z.number(),
  baseCursor: z.number(),
});
const page = terminal.extend({
  output: z.string(),
  outputBase64: z.string(),
  truncated: z.boolean(),
  reset: z.boolean(),
  timedOut: z.boolean(),
});
const listed = z.object({ terminals: z.array(terminal) });
const failure = z.object({ error: z.string() });

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
      if (code !== 0) {
        reject(new Error(`MCP process exited ${code}: ${stderr}`));
        return;
      }
      const result = z
        .object({ result: z.object({ content: z.array(z.object({ text: z.string() })) }) })
        .parse(JSON.parse(stdout.trim())).result;
      resolve(JSON.parse(result.content[0].text));
    });
  });
}

async function openShell(command: string, path: string): Promise<string> {
  const previousId = await browser.execute(() =>
    document
      .querySelector('.pane-leaf.focused:has(.terminal-screen)')
      ?.getAttribute('data-pane-id'),
  );
  await browser.keys(['Meta', 't']);
  await browser.waitUntil(async () =>
    browser.execute((previous) => {
      const focused = document.querySelector('.pane-leaf.focused');
      return Boolean(
        focused?.querySelector('.terminal-screen .xterm') &&
        focused.getAttribute('data-pane-id') !== previous,
      );
    }, previousId),
  );
  const id = await browser.execute(() =>
    document
      .querySelector('.pane-leaf.focused .terminal-screen')
      ?.closest('.pane-leaf')
      ?.getAttribute('data-pane-id'),
  );
  if (!id) throw new Error('Terminal pane ID missing');
  const runtimeId = id === 'main' ? `main:${encodeURIComponent(path)}` : id;
  await browser.tauri.execute(
    async ({ core }, input) =>
      core.invoke('terminal_write', {
        id: input.id,
        data: [...new TextEncoder().encode(`${input.command}\n`)],
      }),
    { id: runtimeId, command },
  );
  return runtimeId;
}

describe('project terminal MCP inspection', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-terminal-mcp-'));
  const foreign = mkdtempSync(join(tmpdir(), 'sail-terminal-foreign-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', ['init', '-q', foreign]);
  });
  after(() => {
    rmSync(repository, { recursive: true, force: true });
    rmSync(foreign, { recursive: true, force: true });
  });

  it('pages, waits, scopes, and retains Sail terminal output', async () => {
    const path = realpathSync(repository);
    const other = realpathSync(foreign);
    await browser.execute(
      ([project, unrelated]) => {
        localStorage.removeItem('sai-pane-layouts');
        localStorage.removeItem('sail-agent-threads');
        localStorage.setItem('sai-directory', project);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [project, unrelated], groups: [], worktrees: {} }),
        );
      },
      [path, other],
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const source = await browser.tauri.execute(async ({ core }, directory) => {
      await core.invoke('acp_connect', { agent: 'claude' });
      return core.invoke<{ sessionId: string }>('acp_new_session', {
        params: { agent: 'claude', cwd: directory },
      });
    }, path);
    await browser.execute(
      (directory, sessionId) =>
        localStorage.setItem(
          'sail-agent-threads',
          JSON.stringify([
            {
              agent: 'claude',
              sessionId,
              directory,
              title: 'Terminal inspector',
              updated: Date.now(),
            },
          ]),
        ),
      path,
      source.sessionId,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const config = await browser.tauri.execute(
      async ({ core }, directory) =>
        core.invoke<McpConfig>('browser_mcp_config', { directory, agent: 'claude' }),
      path,
    );

    const firstPane = await openShell(
      'printf SAIL143_START; sleep 5; printf SAIL143_END; exit 7',
      path,
    );
    const secondPane = await openShell('printf SAIL143_SECOND; sleep 12', path);
    expect(secondPane).not.toBe(firstPane);
    await $(`.project-default-worktree-select[title="${other}"]`).click();
    const foreignPane = await openShell('printf SAIL143_FOREIGN; sleep 12', other);
    const foreignId = await browser.tauri.execute(
      async ({ core }, input) => {
        const terminals = await core.invoke<Array<{ terminalId: string; paneId: string }>>(
          'terminal_inspect_list',
          { allowed: [input.path] },
        );
        return terminals.find((item) => item.paneId === input.pane)?.terminalId;
      },
      { path: other, pane: foreignPane },
    );
    if (!foreignId) throw new Error('Foreign terminal missing');
    await $(`.project-default-worktree-select[title="${path}"]`).click();
    const list = listed.parse(callMcp(config, source.sessionId, 'terminal_list', {}));
    const firstId = list.terminals.find((item) => item.paneId === firstPane)?.terminalId;
    const secondId = list.terminals.find((item) => item.paneId === secondPane)?.terminalId;
    if (!firstId || !secondId) throw new Error('Project terminals missing');
    expect(secondId).not.toBe(firstId);
    expect(list.terminals.map((item) => item.terminalId)).toContain(firstId);
    expect(list.terminals.map((item) => item.terminalId)).toContain(secondId);
    expect(list.terminals.map((item) => item.terminalId)).not.toContain(foreignId);
    expect(list.terminals.find((item) => item.terminalId === firstId)?.worktree).toBe(path);

    const secondNow = page.parse(
      callMcp(config, source.sessionId, 'terminal_read', { terminalId: secondId }),
    );
    const waiting = callMcpAsync(config, source.sessionId, 'terminal_wait', {
      terminalId: secondId,
      cursor: secondNow.cursor,
      timeoutMs: 5_000,
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    await browser.tauri.execute(
      async ({ core }, id) =>
        core.invoke('terminal_write', {
          id,
          data: [...new TextEncoder().encode('printf SAIL143_WAKE\n')],
        }),
      secondPane,
    );
    const woke = page.parse(await waiting);
    expect(woke.timedOut).toBe(false);
    expect(woke.output).toContain('SAIL143_WAKE');

    const first = page.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: firstId,
        cursor: 0,
        maxBytes: 4,
      }),
    );
    expect(first.outputBase64).toBe(Buffer.from(first.output).toString('base64'));
    expect(first.cursor).toBe(4);
    expect(first.output.length).toBeLessThanOrEqual(4);
    const next = page.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: firstId,
        cursor: first.cursor,
        maxBytes: 4,
      }),
    );
    expect(next.cursor).toBeGreaterThan(first.cursor);

    const foreignRead = failure.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: foreignId,
      }),
    );
    expect(foreignRead.error).toContain('Unknown terminal ID');
    const stale = failure.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: 'shell:missing-terminal',
      }),
    );
    expect(stale.error).toContain('Unknown terminal ID');

    const drained = page.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: firstId,
        cursor: next.cursor,
        maxBytes: 65_536,
      }),
    );
    let finished = drained;
    for (let attempt = 0; attempt < 4 && finished.state === 'running'; attempt++) {
      finished = page.parse(
        callMcp(config, source.sessionId, 'terminal_wait', {
          terminalId: firstId,
          cursor: finished.cursor,
          timeoutMs: 5_000,
        }),
      );
    }
    expect(finished.state).toBe('exited');
    expect(finished.exitCode).toBe(7);
    expect(finished.timedOut).toBe(false);
    const complete = page.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: firstId,
        cursor: 0,
      }),
    );
    expect(complete.output).toContain('SAIL143_END');

    await $('.terminal-exit button').click();
    const reopened = listed.parse(callMcp(config, source.sessionId, 'terminal_list', {}));
    const replacement = reopened.terminals.find((item) => item.paneId === firstPane)?.terminalId;
    expect(replacement).toBeDefined();
    expect(replacement).not.toBe(firstId);
    const oldRead = failure.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: firstId,
      }),
    );
    expect(oldRead.error).toContain('Unknown terminal ID');

    await browser.tauri.execute(
      async ({ core }, sessionId) =>
        core.invoke('acp_prompt', {
          params: {
            agent: 'claude',
            sessionId,
            text: 'Terminal: run',
            turnId: `terminal-inspect-${Date.now()}`,
            imagePaths: [],
          },
        }),
      source.sessionId,
    );
    const withAgent = listed.parse(callMcp(config, source.sessionId, 'terminal_list', {}));
    const agent = withAgent.terminals.find((item) => item.terminalId.startsWith('agent:'));
    expect(agent).toBeDefined();
    expect(agent?.worktree).toBe(path);
    const agentPage = page.parse(
      callMcp(config, source.sessionId, 'terminal_read', {
        terminalId: agent!.terminalId,
      }),
    );
    expect(agentPage.output).toContain('started');
    expect(agentPage.output).toContain('finished');
    expect(agentPage.state).toBe('exited');
    expect(agentPage.exitCode).toBe(7);

    await Promise.all(
      [firstPane, secondPane, foreignPane].map((id) =>
        browser.tauri.execute(
          async ({ core }, terminalId) => core.invoke('terminal_close', { id: terminalId }),
          id,
        ),
      ),
    );
  });
});
