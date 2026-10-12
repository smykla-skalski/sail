import { browser, expect } from '@wdio/globals';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join } from 'node:path';

describe('post-turn check recovery', () => {
  const scratch = process.env.SAIL_E2E_CONFIG_DIR;
  if (!scratch) throw new Error('This spec requires private SAIL_E2E_CONFIG_DIR');
  const repository = realpathSync(mkdtempSync(join(scratch, 'post-turn-recovery-')));
  const command = "printf 'run\\n' >> recovered-runs.txt";

  after(async () => {
    await browser.execute(async () => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.core.invoke('save_setting', { key: 'sai-acp-turn-evidence', value: null });
      await tauri.core.invoke('save_setting', { key: 'sai-post-turn-personal', value: null });
      localStorage.clear();
      sessionStorage.removeItem('sail-e2e-settings');
    });
    rmSync(repository, { recursive: true, force: true });
  });

  it('runs a persisted completion once and leaves legacy history silent', async () => {
    await browser.execute(
      async (path, check) => {
        const tauri = Reflect.get(window, '__TAURI__');
        const saved = async (key: string, value: string) =>
          tauri.core.invoke('save_setting', { key, value });
        const evidence = [
          {
            agent: 'claude',
            directory: path,
            sessionId: 'historical-session',
            turnId: 'historical-turn',
            status: 'done',
            error: null,
            updatedAt: 1,
          },
          {
            agent: 'claude',
            directory: path,
            sessionId: 'completed-during-reload',
            turnId: 'completed-turn',
            status: 'done',
            error: null,
            updatedAt: Date.now(),
            postTurnPending: true,
          },
        ];
        await saved('sai-acp-turn-evidence', JSON.stringify(evidence));
        await saved('sai-post-turn-personal', JSON.stringify([check]));
        sessionStorage.setItem('sail-e2e-settings', 'enabled');
        localStorage.setItem('sai-post-turn-personal', JSON.stringify([check]));
        localStorage.setItem('sai-directory', path);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [path], groups: [] }),
        );
      },
      repository,
      command,
    );
    expect(existsSync(join(repository, 'recovered-runs.txt'))).toBe(false);

    await browser.refresh();
    await browser.waitUntil(() => existsSync(join(repository, 'recovered-runs.txt')), {
      timeoutMsg: 'Persisted completed turn was not reconciled after reload',
    });
    expect(readFileSync(join(repository, 'recovered-runs.txt'), 'utf8')).toBe('run\n');
    await browser.waitUntil(
      async () => {
        const evidence = await browser.execute(async (path) => {
          const tauri = Reflect.get(window, '__TAURI__');
          return tauri.core.invoke('get_acp_turn_evidence', {
            agent: 'claude',
            directory: path,
            sessionId: 'completed-during-reload',
            turnId: 'completed-turn',
          });
        }, repository);
        return evidence?.postTurnPending === false;
      },
      { timeoutMsg: 'The completed turn was not acknowledged after its check' },
    );
    await browser.refresh();
    expect(readFileSync(join(repository, 'recovered-runs.txt'), 'utf8')).toBe('run\n');
  });
});
