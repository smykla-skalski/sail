import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const closeLog = process.env.SAIL_E2E_ACP_CLOSE_LOG ?? '';

function closedSessions(): string[] {
  return existsSync(closeLog) ? readFileSync(closeLog, 'utf8').split('\n').filter(Boolean) : [];
}

describe('idle Codex session close', () => {
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

  it('closes finished unseen threads, spares busy and visible ones, and reattaches on prompt', async () => {
    expect(closeLog).not.toBe('');
    const directory = realpathSync(repository);
    const sessions = await browser.tauri.execute(async ({ core }, path) => {
      await core.invoke('acp_connect', { agent: 'codex', directory: path });
      await core.invoke('acp_authenticate', {
        agent: 'codex',
        directory: path,
        methodId: 'chat-gpt',
      });
      const created = await Promise.all(
        [0, 1, 2, 3].map(() =>
          core.invoke<{ sessionId: string }>('acp_new_session', {
            params: { agent: 'codex', cwd: path },
          }),
        ),
      );
      return created.map((session) => session.sessionId);
    }, directory);
    const [finished, visible, busy, reopened] = sessions;

    await browser.tauri.execute(
      async ({ core }, path, ids) => {
        const prompt = (sessionId: string, text: string, turnId: string) =>
          core.invoke('acp_prompt', {
            params: { agent: 'codex', directory: path, sessionId, text, turnId, imagePaths: [] },
          });
        await Promise.all(
          [ids[0], ids[1], ids[3]].map((sessionId, index) =>
            prompt(sessionId, 'Task reporting fixture: done', `idle-done-${index}`),
          ),
        );
        void prompt(ids[2], 'Long turn', 'idle-long');
        await core.invoke('acp_set_idle_close_timeout', { seconds: 2 });
      },
      directory,
      sessions,
    );

    await browser.waitUntil(
      async () => {
        await browser.tauri.execute(
          async ({ core }, path, id) => {
            await core.invoke('acp_session_visible', {
              agent: 'codex',
              directory: path,
              sessionId: id,
            });
          },
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

    const attached = async () =>
      browser.tauri.execute(async ({ core }, path) => {
        const activity = await core.invoke<Record<string, { sessions: string[] }>>('acp_activity', {
          directory: path,
        });
        return activity.codex?.sessions ?? [];
      }, directory);
    const sessionsAfterClose = await attached();
    expect(sessionsAfterClose).not.toContain(finished);
    expect(sessionsAfterClose).toContain(visible);
    expect(sessionsAfterClose).toContain(busy);

    const outcome = await browser.tauri.execute(
      async ({ core }, path, id) =>
        core.invoke<{ stopReason?: string }>('acp_prompt', {
          params: {
            agent: 'codex',
            directory: path,
            sessionId: id,
            text: 'Task reporting fixture: done',
            turnId: 'idle-reopened',
            imagePaths: [],
          },
        }),
      directory,
      finished,
    );
    expect(outcome.stopReason).toBe('end_turn');
    expect(await attached()).toContain(finished);

    await browser.waitUntil(async () => closedSessions().includes(busy), {
      timeout: 60_000,
      interval: 1000,
      timeoutMsg: 'the long turn thread never closed after it finished',
    });
  });
});
