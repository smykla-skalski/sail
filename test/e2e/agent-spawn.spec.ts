import { browser, $, expect } from '@wdio/globals';
import { execFileSync, spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { z } from 'zod';

type McpConfig = { command: string; args: string[]; env: Record<string, string> };
const mcpResult = z.object({
  isError: z.boolean().optional(),
  content: z.array(z.object({ text: z.string() })),
});
const agentThread = z.object({
  agent: z.string(),
  sessionId: z.string(),
  directory: z.string(),
  title: z.string(),
});

function callMcp(
  config: McpConfig,
  sessionId: string,
  arguments_: Record<string, unknown>,
  name = 'agent_spawn',
) {
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
      params: {
        name,
        arguments: arguments_,
        _meta: { sessionID: sessionId },
      },
    })}\n`,
  );
  return new Promise<z.infer<typeof mcpResult>>((resolve, reject) => {
    const timer = setTimeout(() => child.kill(), 60_000);
    child.once('error', reject);
    child.once('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`MCP process exited ${code}: ${stderr}; stdout=${stdout}`));
        return;
      }
      try {
        const response: unknown = JSON.parse(stdout.trim());
        resolve(z.object({ result: mcpResult }).parse(response).result);
      } catch (error) {
        reject(new Error(`Invalid MCP response: ${stdout}; stderr=${stderr}`, { cause: error }));
      }
    });
  });
}

describe('provider selected agent spawn', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-spawn-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '--allow-empty',
      '-qm',
      'seed',
    ]);
  });
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('selects Codex in a new worktree and asks before sharing an existing one', async () => {
    const path = realpathSync(repository);
    await browser.execute((directory) => {
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.setItem('sai-notifications-enabled', 'false');
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    }, path);
    await browser.tauri.execute(async ({ core }, directory) => {
      await core.invoke('save_setting', { key: 'sai-directory', value: directory });
      await core.invoke('save_setting', {
        key: 'sai-project-catalog',
        value: JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      });
      await core.invoke('save_setting', { key: 'sail-agent-threads', value: null });
      await core.invoke('save_setting', { key: 'sai-notifications-enabled', value: 'false' });
    }, path);
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await $('.agent-launches button').click();
    await browser.waitUntil(
      () =>
        browser.execute(() =>
          Boolean(document.querySelector('.agent-composer textarea:not([disabled])')),
        ),
      { timeout: 15_000 },
    );
    await $('.agent-composer textarea').setValue('Clipboard fixture source');
    await $('.agent-actions button').click();
    await browser.waitUntil(
      () =>
        browser.execute(() => {
          const saved: unknown = JSON.parse(localStorage.getItem('sail-agent-threads') ?? '[]');
          return Array.isArray(saved) && saved.length > 0;
        }),
      { timeout: 15_000 },
    );
    const saved = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const sourceThread = z
      .array(agentThread)
      .parse(JSON.parse(saved ?? '[]'))
      .find((thread) => thread.directory === path && thread.title === 'Clipboard fixture source');
    if (!sourceThread) throw new Error(`Source thread was not saved: ${saved}`);
    const sessionId = sourceThread.sessionId;

    await $('.agent-launches button:nth-child(2)').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue('Clipboard fixture authenticate Codex');
    await $('.agent-actions button').click();
    await browser.waitUntil(
      async () =>
        (await $('.agent-auth button').isDisplayed()) ||
        (await $('.agent-conversation').getText()).includes('Clipboard received:'),
      { timeout: 15_000 },
    );
    if (await $('.agent-auth button').isDisplayed()) {
      await $('.agent-auth button').click();
      await $('.agent-actions button').click();
    }
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Clipboard received:'),
    );

    const config = await browser.tauri.execute(
      async ({ core }, input) => core.invoke<McpConfig>('browser_mcp_config', input),
      { directory: path, agent: sourceThread.agent },
    );
    const invalid = await callMcp(config, sessionId, {
      provider: 'other',
      prompt: 'Clipboard fixture invalid',
    });
    expect(invalid.isError).toBe(true);
    expect(invalid.content[0].text).toContain('Choose Claude, Codex, or OpenCode');
    const pendingReceiptId = randomUUID();
    const pendingAccessKey = randomUUID();
    const spawnNew = callMcp(config, sessionId, {
      provider: 'codex',
      prompt: 'Clipboard fixture delegate',
      receiptId: pendingReceiptId,
      accessKey: pendingAccessKey,
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await expect($('.worktree-approval-dialog')).toHaveText(expect.stringContaining('codex'));
    const queued = await callMcp(
      config,
      sessionId,
      { receiptId: pendingReceiptId, accessKey: pendingAccessKey },
      'agent_status',
    );
    expect(JSON.parse(queued.content[0].text)).toMatchObject({ state: 'queued' });
    await $('.worktree-approval-actions button:last-child').click();
    const newResult = await spawnNew;
    expect(newResult.isError).not.toBe(true);
    const started = z
      .object({
        status: z.string(),
        threadId: z.string(),
        worktreeId: z.string(),
        path: z.string(),
        receiptId: z.string(),
        accessKey: z.string(),
        sourceId: z.string(),
        targetId: z.string(),
      })
      .parse(JSON.parse(newResult.content[0].text));
    expect(started.status).toBe('started');
    expect(started.receiptId).toBe(pendingReceiptId);
    expect(started.accessKey).toBe(pendingAccessKey);
    expect(started.threadId).toMatch(/^acp:codex:/);
    expect(started.worktreeId).toBe(started.path);
    expect(started.targetId).toBe(started.threadId);
    expect(started.sourceId).toBe(`acp:${sourceThread.agent}:${sessionId}`);
    expect(existsSync(started.path)).toBe(true);

    const completed = await callMcp(
      config,
      sessionId,
      { receiptId: started.receiptId, accessKey: started.accessKey, timeoutMs: 10_000 },
      'agent_wait',
    );
    expect(completed.isError).not.toBe(true);
    expect(JSON.parse(completed.content[0].text)).toMatchObject({
      receiptId: started.receiptId,
      sourceId: started.sourceId,
      targetId: started.targetId,
      worktreeId: started.worktreeId,
      state: 'completed',
      timedOut: false,
    });
    const result = await callMcp(
      config,
      sessionId,
      { receiptId: started.receiptId, accessKey: started.accessKey },
      'agent_result',
    );
    expect(JSON.parse(result.content[0].text)).toMatchObject({
      state: 'completed',
      result: expect.stringContaining('Clipboard received: Clipboard fixture delegate'),
    });
    const wrongKey = await callMcp(
      config,
      sessionId,
      { receiptId: started.receiptId, accessKey: 'wrong-key' },
      'agent_result',
    );
    expect(wrongKey.isError).toBe(true);

    const spawnShared = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture shared',
      target: { kind: 'existing', path },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await expect($('.worktree-approval-dialog')).toHaveText(
      expect.stringContaining('share this worktree’s files'),
    );
    await $('.worktree-approval-actions button:first-child').click();
    const denied = await spawnShared;
    expect(denied.isError).toBe(true);
    expect(denied.content[0].text).toContain('User declined');

    const approvedShared = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture approved shared',
      target: { kind: 'existing', path },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await $('.worktree-approval-actions button:last-child').click();
    const sharedResult = await approvedShared;
    expect(sharedResult.isError).not.toBe(true);
    const shared = z
      .object({
        status: z.string(),
        threadId: z.string(),
        worktreeId: z.string(),
        path: z.string(),
      })
      .parse(JSON.parse(sharedResult.content[0].text));
    expect(shared.status).toBe('started');
    expect(shared.threadId).toMatch(/^acp:claude:/);
    expect(shared.worktreeId).toBe(path);
    expect(shared.path).toBe(path);

    let openCodeFinished = false;
    const spawnOpenCode = callMcp(config, sessionId, {
      provider: 'opencode',
      prompt: 'Clipboard fixture OpenCode',
      target: { kind: 'existing', path },
    }).then((spawnResponse) => {
      openCodeFinished = true;
      return spawnResponse;
    });
    await browser.waitUntil(
      async () => openCodeFinished || (await $('.worktree-approval-dialog').isDisplayed()),
      { timeout: 15_000 },
    );
    if (await $('.worktree-approval-dialog').isDisplayed()) {
      await $('.worktree-approval-actions button:last-child').click();
    }
    const openCodeResult = await spawnOpenCode;
    if (openCodeResult.isError) {
      expect(openCodeResult.content[0].text).toContain(
        'Complete OpenCode setup in the target worktree before spawning',
      );
      console.log(
        `OpenCode spawn unavailable in isolated fixture: ${openCodeResult.content[0].text}`,
      );
    } else {
      const openCode = z
        .object({ status: z.string(), threadId: z.string(), worktreeId: z.string() })
        .parse(JSON.parse(openCodeResult.content[0].text));
      expect(openCode.status).toBe('started');
      expect(openCode.threadId).toMatch(/^opencode:/);
      expect(openCode.worktreeId).toBe(path);
    }

    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const restoredResult = await callMcp(
      config,
      sessionId,
      { receiptId: started.receiptId, accessKey: started.accessKey },
      'agent_result',
    );
    expect(JSON.parse(restoredResult.content[0].text)).toMatchObject({
      state: 'completed',
      result: expect.stringContaining('Clipboard received: Clipboard fixture delegate'),
    });
    const rawRestored = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const restored = z.array(agentThread).parse(JSON.parse(rawRestored ?? '[]'));
    expect(
      restored.some(
        (thread) =>
          `acp:codex:${thread.sessionId}` === started.threadId && thread.directory === started.path,
      ),
    ).toBe(true);
  });

  it('reports waiting, failure, timeout, and lost in-flight history', async () => {
    const path = realpathSync(repository);
    const saved = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const sourceThread = z
      .array(agentThread)
      .parse(JSON.parse(saved ?? '[]'))
      .find((thread) => thread.directory === path);
    if (!sourceThread) throw new Error('Source thread was not restored');
    const sessionId = sourceThread.sessionId;
    const config = await browser.tauri.execute(
      async ({ core }, input) => core.invoke<McpConfig>('browser_mcp_config', input),
      { directory: path, agent: sourceThread.agent },
    );
    const spawnWaiting = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Delayed approval',
      target: { kind: 'existing', path },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await $('.worktree-approval-actions button:last-child').click();
    const waitingLaunch = z
      .object({ receiptId: z.string(), accessKey: z.string() })
      .parse(JSON.parse((await spawnWaiting).content[0].text));
    const timeout = await callMcp(
      config,
      sessionId,
      { receiptId: waitingLaunch.receiptId, accessKey: waitingLaunch.accessKey, timeoutMs: 0 },
      'agent_wait',
    );
    expect(JSON.parse(timeout.content[0].text)).toMatchObject({
      state: 'working',
      timedOut: true,
    });
    const waiting = await callMcp(
      config,
      sessionId,
      { receiptId: waitingLaunch.receiptId, accessKey: waitingLaunch.accessKey, timeoutMs: 5_000 },
      'agent_wait',
    );
    expect(JSON.parse(waiting.content[0].text)).toMatchObject({
      state: 'waiting',
      timedOut: false,
    });
    const hidden = await callMcp(
      config,
      'different-source',
      { receiptId: waitingLaunch.receiptId, accessKey: waitingLaunch.accessKey },
      'agent_result',
    );
    expect(hidden.isError).toBe(true);

    const spawnFailure = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Prompt failure',
      target: { kind: 'existing', path },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await $('.worktree-approval-actions button:last-child').click();
    const failedLaunch = z
      .object({ receiptId: z.string(), accessKey: z.string() })
      .parse(JSON.parse((await spawnFailure).content[0].text));
    const failed = await callMcp(
      config,
      sessionId,
      { receiptId: failedLaunch.receiptId, accessKey: failedLaunch.accessKey, timeoutMs: 5_000 },
      'agent_wait',
    );
    expect(JSON.parse(failed.content[0].text)).toMatchObject({
      state: 'failed',
      error: expect.stringContaining('Fixture prompt failed'),
    });

    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const reconciled = await callMcp(
      config,
      sessionId,
      { receiptId: waitingLaunch.receiptId, accessKey: waitingLaunch.accessKey },
      'agent_status',
    );
    expect(['waiting', 'failed']).toContain(JSON.parse(reconciled.content[0].text).state);

    const staleId = randomUUID();
    const staleKey = randomUUID();
    const setting = await browser.execute(
      (sourceId, receiptId, accessKey) => {
        const key = 'sai-agent-spawn-receipts';
        const receipts: Array<Record<string, unknown>> = JSON.parse(
          localStorage.getItem(key) ?? '[]',
        );
        const source = receipts.find((item) => item.receiptId === sourceId);
        if (!source) throw new Error('Waiting receipt was not persisted');
        receipts.unshift({
          ...source,
          receiptId,
          accessKey,
          requestId: receiptId,
          turnId: crypto.randomUUID(),
          state: 'working',
        });
        const value = JSON.stringify(receipts);
        localStorage.setItem(key, value);
        return value;
      },
      waitingLaunch.receiptId,
      staleId,
      staleKey,
    );
    await browser.tauri.execute(
      async ({ core }, value) =>
        core.invoke('save_setting', { key: 'sai-agent-spawn-receipts', value }),
      setting,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const unavailable = await callMcp(
      config,
      sessionId,
      { receiptId: staleId, accessKey: staleKey },
      'agent_status',
    );
    expect(JSON.parse(unavailable.content[0].text)).toMatchObject({ state: 'unavailable' });
  });

  it('routes MCP validation gates and enforces strict model selection', async () => {
    const path = realpathSync(repository);
    const settings = JSON.stringify({
      choices: [
        { agent: 'claude', model: 'broken' },
        { agent: 'claude', model: 'test' },
        { agent: 'claude', model: 'fast' },
      ],
      strictDifferentModel: true,
    });
    await browser.execute((value) => localStorage.setItem('sai-cross-validation', value), settings);
    await browser.tauri.execute(
      async ({ core }, value) =>
        core.invoke('save_setting', { key: 'sai-cross-validation', value }),
      settings,
    );
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const saved = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const sourceThread = z
      .array(agentThread)
      .parse(JSON.parse(saved ?? '[]'))
      .find((thread) => thread.directory === path && thread.title === 'Clipboard fixture source');
    if (!sourceThread) throw new Error('Source thread was not restored');
    const config = await browser.tauri.execute(
      async ({ core }, input) => core.invoke<McpConfig>('browser_mcp_config', input),
      { directory: path, agent: sourceThread.agent },
    );
    const result = await callMcp(
      config,
      sourceThread.sessionId,
      {
        gate: 'code-adversary',
        prompt: 'Ship gate fixture validation gate',
        implementingModels: ['test'],
      },
      'validation_gate',
    );
    expect(result.isError).not.toBe(true);
    const started = z
      .object({ receiptId: z.string(), accessKey: z.string(), threadId: z.string() })
      .passthrough()
      .parse(JSON.parse(result.content[0].text));
    expect(started).toMatchObject({
      status: 'started',
      provider: 'claude',
      model: 'fast',
      gate: 'code-adversary',
      path,
    });
    expect(started.threadId).not.toBe(`acp:${sourceThread.agent}:${sourceThread.sessionId}`);
    const forged = await callMcp(
      config,
      sourceThread.sessionId,
      { verdict: 'CLEAN' },
      'ship_progress',
    );
    expect(forged.isError).toBe(true);
    const gateConfig = await browser.tauri.execute(
      async ({ core }, input) => core.invoke<McpConfig>('browser_mcp_config', input),
      { directory: path, agent: 'claude' },
    );
    const report = await callMcp(
      gateConfig,
      started.threadId.slice('acp:claude:'.length),
      { verdict: 'CLEAN' },
      'ship_progress',
    );
    expect(report.isError).not.toBe(true);

    const completed = await callMcp(
      config,
      sourceThread.sessionId,
      { receiptId: started.receiptId, accessKey: started.accessKey, timeoutMs: 10_000 },
      'agent_wait',
    );
    expect(completed.isError).not.toBe(true);
    expect(JSON.parse(completed.content[0].text)).toMatchObject({
      state: 'completed',
      model: 'fast',
      validation: { verdict: 'CLEAN', gate: 'code-adversary' },
    });
    const rejected = await callMcp(
      config,
      sourceThread.sessionId,
      {
        gate: 'findings-adversary',
        prompt: 'Clipboard fixture strict gate',
        implementingModels: ['test', 'fast'],
      },
      'validation_gate',
    );
    expect(rejected.isError).toBe(true);
    expect(rejected.content[0].text).toContain('Strict different-model routing is enabled');
    await browser.tauri.execute(async ({ core }) => {
      await core.invoke('save_setting', {
        key: 'sai-cross-validation',
        value: JSON.stringify({
          choices: [
            { agent: 'claude', model: 'test' },
            { agent: 'claude', model: 'fast' },
          ],
          strictDifferentModel: false,
        }),
      });
    });
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    const dispatchFailure = await callMcp(
      config,
      sourceThread.sessionId,
      {
        gate: 'test-adversary',
        prompt: 'Gate prompt model unavailable',
        implementingModels: [],
      },
      'validation_gate',
    );
    if (dispatchFailure.isError) {
      expect(dispatchFailure.content[0].text).toContain('Model x is unavailable');
    } else {
      const receipt = z
        .object({ receiptId: z.string(), accessKey: z.string() })
        .parse(JSON.parse(dispatchFailure.content[0].text));
      const outcome = await callMcp(
        config,
        sourceThread.sessionId,
        {
          ...receipt,
          timeoutMs: 10_000,
        },
        'agent_wait',
      );
      expect(JSON.parse(outcome.content[0].text)).toMatchObject({
        state: 'failed',
        error: expect.stringContaining('Model x is unavailable'),
      });
    }
    const savedReceipts = await browser.execute(() =>
      localStorage.getItem('sai-agent-spawn-receipts'),
    );
    const attempts = z
      .array(z.object({ prompt: z.string().nullable().optional() }))
      .parse(JSON.parse(savedReceipts ?? '[]'))
      .filter((receipt) => receipt.prompt?.startsWith('Gate prompt model unavailable'));
    expect(attempts).toHaveLength(1);
  });

  it('reports setup failure without creating an agent thread', async () => {
    const path = realpathSync(repository);
    mkdirSync(join(repository, '.sail'), { recursive: true });
    writeFileSync(join(repository, '.sail', 'worktree.json'), JSON.stringify({ setup: 'exit 7' }));
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'add',
      '.sail/worktree.json',
    ]);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.test',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'failing setup',
    ]);
    const saved = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const sourceThread = z
      .array(agentThread)
      .parse(JSON.parse(saved ?? '[]'))
      .find((thread) => thread.directory === path);
    if (!sourceThread) throw new Error('Source thread was not restored');
    const sessionId = sourceThread.sessionId;
    const config = await browser.tauri.execute(
      async ({ core }, input) => core.invoke<McpConfig>('browser_mcp_config', input),
      { directory: path, agent: sourceThread.agent },
    );
    const spawnNew = callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture no launch',
      target: { kind: 'new', name: 'failing-setup' },
    });
    await expect($('.worktree-approval-dialog')).toBeDisplayed();
    await $('.worktree-approval-actions button:last-child').click();
    const result = await spawnNew;
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain('Worktree setup exited with code 7');
    const threadsRaw = await browser.execute(() => localStorage.getItem('sail-agent-threads'));
    const threads = z.array(agentThread).parse(JSON.parse(threadsRaw ?? '[]'));
    expect(threads.some((thread) => basename(thread.directory) === 'failing-setup')).toBe(false);
    const catalogRaw = await browser.execute(() => localStorage.getItem('sai-project-catalog'));
    const catalog = z
      .object({ worktrees: z.record(z.string(), z.array(z.object({ path: z.string() }))) })
      .parse(JSON.parse(catalogRaw ?? '{}'));
    const failedPath = catalog.worktrees[path].find(
      (item) => basename(item.path) === 'failing-setup',
    )?.path;
    if (!failedPath) throw new Error('Failed setup worktree was not saved');
    const retry = await callMcp(config, sessionId, {
      provider: 'claude',
      prompt: 'Clipboard fixture should not start',
      target: { kind: 'existing', path: failedPath },
    });
    expect(retry.isError).toBe(true);
    expect(retry.content[0].text).toContain('Complete worktree setup');
  });
});
