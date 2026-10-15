import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const closeLog = process.env.SAIL_E2E_ACP_CLOSE_LOG ?? '';

type Provider = 'codex' | 'claude' | 'opencode';

function closedSessions(): string[] {
  return existsSync(closeLog) ? readFileSync(closeLog, 'utf8').split('\n').filter(Boolean) : [];
}

async function newSessions(provider: Provider, directory: string, count: number) {
  return browser.tauri.execute(
    async ({ core }, agent, path, total) => {
      await core.invoke('acp_connect', { agent, directory: path });
      if (agent === 'codex')
        await core.invoke('acp_authenticate', { agent, directory: path, methodId: 'chat-gpt' });
      const created = await Promise.all(
        Array.from({ length: total }, () =>
          core.invoke<{ sessionId: string }>('acp_new_session', {
            params: { agent, cwd: path },
          }),
        ),
      );
      return created.map((session) => session.sessionId);
    },
    provider,
    directory,
    count,
  );
}

async function finishTurns(provider: Provider, directory: string, ids: string[]) {
  await browser.tauri.execute(
    async ({ core }, agent, path, sessions) => {
      await Promise.all(
        sessions.map((sessionId, index) =>
          core.invoke('acp_prompt', {
            params: {
              agent,
              directory: path,
              sessionId,
              text: 'Task reporting fixture: done',
              turnId: `idle-done-${index}`,
              imagePaths: [],
            },
          }),
        ),
      );
    },
    provider,
    directory,
    ids,
  );
}

async function attached(provider: Provider, directory: string) {
  return browser.tauri.execute(
    async ({ core }, agent, path) => {
      const activity = await core.invoke<Record<string, { sessions: string[] }>>('acp_activity', {
        directory: path,
      });
      return activity[agent]?.sessions ?? [];
    },
    provider,
    directory,
  );
}

describe('idle session close', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-idle-close-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.tauri.execute(async ({ core }) => {
      await core.invoke('acp_set_idle_close_timeout', { seconds: null });
    });
    rmSync(repository, { recursive: true, force: true });
  });

  for (const provider of ['codex', 'claude'] as const) {
    it(`closes finished unseen ${provider} threads, spares busy and visible ones, and reattaches on prompt`, async () => {
      expect(closeLog).not.toBe('');
      const directory = realpathSync(repository);
      const sessions = await newSessions(provider, directory, 4);
      const [finished, visible, busy, reopened] = sessions;

      await finishTurns(provider, directory, [finished, visible, reopened]);
      await browser.tauri.execute(
        async ({ core }, agent, path, id) => {
          void core.invoke('acp_prompt', {
            params: {
              agent,
              directory: path,
              sessionId: id,
              text: 'Long turn',
              turnId: 'idle-long',
              imagePaths: [],
            },
          });
          await core.invoke('acp_set_idle_close_timeout', { seconds: 2 });
        },
        provider,
        directory,
        busy,
      );

      await browser.waitUntil(
        async () => {
          await browser.tauri.execute(
            async ({ core }, agent, path, id) => {
              await core.invoke('acp_session_visible', {
                agent,
                directory: path,
                sessionId: id,
              });
            },
            provider,
            directory,
            visible,
          );
          const closed = closedSessions();
          return closed.includes(finished) && closed.includes(reopened);
        },
        { timeout: 20_000, interval: 500, timeoutMsg: 'finished threads were never closed' },
      );

      const closedWhileBusy = closedSessions();
      expect(closedWhileBusy).not.toContain(visible);
      expect(closedWhileBusy).not.toContain(busy);

      const sessionsAfterClose = await attached(provider, directory);
      expect(sessionsAfterClose).not.toContain(finished);
      expect(sessionsAfterClose).toContain(visible);
      expect(sessionsAfterClose).toContain(busy);

      const outcome = await browser.tauri.execute(
        async ({ core }, agent, path, id) =>
          core.invoke<{ stopReason?: string }>('acp_prompt', {
            params: {
              agent,
              directory: path,
              sessionId: id,
              text: 'Task reporting fixture: done',
              turnId: 'idle-reopened',
              imagePaths: [],
            },
          }),
        provider,
        directory,
        finished,
      );
      expect(outcome.stopReason).toBe('end_turn');
      expect(await attached(provider, directory)).toContain(finished);

      await browser.waitUntil(async () => closedSessions().includes(busy), {
        timeout: 60_000,
        interval: 1000,
        timeoutMsg: 'the long turn thread never closed after it finished',
      });
    });
  }

  it('keeps finished OpenCode threads loaded because closing them releases nothing', async () => {
    const directory = realpathSync(repository);
    const sessions = await newSessions('opencode', directory, 2);
    await finishTurns('opencode', directory, sessions);
    await browser.tauri.execute(async ({ core }) => {
      await core.invoke('acp_set_idle_close_timeout', { seconds: 2 });
    });

    await browser.pause(6000);

    expect(closedSessions().some((id) => sessions.includes(id))).toBe(false);
    expect(await attached('opencode', directory)).toEqual(expect.arrayContaining(sessions));
  });
});
