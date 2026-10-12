import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

describe('post-turn check recovery', () => {
  const scratch = process.env.SAIL_E2E_CONFIG_DIR;
  if (!scratch) throw new Error('This spec requires private SAIL_E2E_CONFIG_DIR');
  const repository = realpathSync(mkdtempSync(join(scratch, 'post-turn-recovery-')));
  const command = "printf 'run\\n' >> recovered-runs.txt";

  before(() => execFileSync('git', ['init', '-q', repository]));

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

  it('keeps completion pending after a pre-save rejection, then retries once', async () => {
    const check = "printf 'retry\\n' >> retry-runs.txt";
    await browser.execute(async (value) => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.core.invoke('save_setting', {
        key: 'sai-acp-turn-evidence',
        value: null,
      });
      await tauri.core.invoke('save_setting', {
        key: 'sai-post-turn-personal',
        value: JSON.stringify([value]),
      });
      localStorage.setItem('sai-post-turn-personal', JSON.stringify([value]));
    }, check);
    const previousDocument = await browser.execute(() => performance.timeOrigin);
    await browser.refresh();
    await browser.waitUntil(
      () =>
        browser.execute(
          (previous) =>
            performance.timeOrigin > previous &&
            typeof Reflect.get(window, 'sailE2eStopAgentEvents') === 'function',
          previousDocument,
        ),
      { timeoutMsg: 'Agent listener did not finish mounting before the setting changed' },
    );

    await browser.execute(async (path) => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.core.invoke('save_setting', {
        key: 'sai-post-turn-personal',
        value: JSON.stringify(['different command']),
      });
      await tauri.core.invoke('save_setting', {
        key: 'sai-acp-turn-evidence',
        value: JSON.stringify([
          {
            agent: 'claude',
            directory: path,
            sessionId: 'pre-save-session',
            turnId: 'pre-save-turn',
            status: 'done',
            error: null,
            updatedAt: Date.now(),
            postTurnPending: true,
          },
        ]),
      });
      await tauri.event.emitTo('main', 'acp-event', {
        agent: 'claude',
        directory: path,
        worktree: path,
        message: {
          method: 'sail/prompt_finished',
          params: {
            sessionId: 'pre-save-session',
            turnId: 'pre-save-turn',
            status: 'done',
            notify: true,
          },
        },
      });
    }, repository);
    await browser.pause(1_000);
    const failed = await browser.execute(async (path) => {
      const tauri = Reflect.get(window, '__TAURI__');
      const [evidence, history] = await Promise.all([
        tauri.core.invoke('get_acp_turn_evidence', {
          agent: 'claude',
          directory: path,
          sessionId: 'pre-save-session',
          turnId: 'pre-save-turn',
        }),
        tauri.core.invoke('list_post_turn_checks'),
      ]);
      return { pending: evidence?.postTurnPending, history };
    }, repository);
    expect(failed.pending).toBe(true);
    expect(
      failed.history.some(
        (item: { directory: string; turn: string }) =>
          item.directory === repository && item.turn === 'pre-save-turn',
      ),
    ).toBe(false);
    expect(existsSync(join(repository, 'retry-runs.txt'))).toBe(false);

    await browser.execute(async (value) => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.core.invoke('save_setting', {
        key: 'sai-post-turn-personal',
        value: JSON.stringify([value]),
      });
    }, check);
    await browser.refresh();
    await browser.waitUntil(() => existsSync(join(repository, 'retry-runs.txt')), {
      timeoutMsg: 'The rejected check was not retried after reload',
    });
    await browser.waitUntil(
      () =>
        browser.execute(async (path) => {
          const tauri = Reflect.get(window, '__TAURI__');
          const evidence = await tauri.core.invoke('get_acp_turn_evidence', {
            agent: 'claude',
            directory: path,
            sessionId: 'pre-save-session',
            turnId: 'pre-save-turn',
          });
          return evidence?.postTurnPending === false;
        }, repository),
      { timeoutMsg: 'The retried check was not acknowledged' },
    );
    expect(readFileSync(join(repository, 'retry-runs.txt'), 'utf8')).toBe('retry\n');
    await browser.refresh();
    expect(readFileSync(join(repository, 'retry-runs.txt'), 'utf8')).toBe('retry\n');
  });

  it('keeps completion pending until repository configuration can load', async () => {
    const personal = "printf 'personal\\n' >> config-personal-runs.txt";
    const repositoryCheck = "printf 'repository\\n' >> config-repository-runs.txt";
    const configPath = join(repository, '.sail', 'worktree.json');
    execFileSync('git', ['init', '-q', repository]);
    mkdirSync(join(repository, '.sail'));
    writeFileSync(configPath, JSON.stringify({ postTurnChecks: [repositoryCheck] }));
    execFileSync('git', ['-C', repository, 'add', '.sail/worktree.json']);
    execFileSync('git', [
      '-C',
      repository,
      '-c',
      'user.name=Sail Test',
      '-c',
      'user.email=sail@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-qm',
      'baseline',
    ]);
    writeFileSync(configPath, '{');
    await browser.execute(
      async (path, personalCommand) => {
        const tauri = Reflect.get(window, '__TAURI__');
        await tauri.core.invoke('save_setting', {
          key: 'sai-post-turn-personal',
          value: JSON.stringify([personalCommand]),
        });
        await tauri.core.invoke('save_setting', {
          key: 'sai-acp-turn-evidence',
          value: JSON.stringify([
            {
              agent: 'claude',
              directory: path,
              sessionId: 'config-session',
              turnId: 'config-turn',
              status: 'done',
              error: null,
              updatedAt: Date.now(),
              postTurnPending: true,
            },
          ]),
        });
        localStorage.setItem('sai-post-turn-personal', JSON.stringify([personalCommand]));
      },
      repository,
      personal,
    );
    await browser.refresh();
    await browser.waitUntil(() => existsSync(join(repository, 'config-personal-runs.txt')), {
      timeoutMsg: 'Personal check did not run while repository config was invalid',
    });
    const pending = await browser.execute(async (path) => {
      const tauri = Reflect.get(window, '__TAURI__');
      const evidence = await tauri.core.invoke('get_acp_turn_evidence', {
        agent: 'claude',
        directory: path,
        sessionId: 'config-session',
        turnId: 'config-turn',
      });
      return evidence?.postTurnPending;
    }, repository);
    expect(pending).toBe(true);
    expect(existsSync(join(repository, 'config-repository-runs.txt'))).toBe(false);

    writeFileSync(configPath, JSON.stringify({ postTurnChecks: [repositoryCheck] }));
    await browser.execute(
      async (path, approvedCommand) => {
        const tauri = Reflect.get(window, '__TAURI__');
        await tauri.core.invoke('approve_post_turn_check', {
          directory: path,
          command: approvedCommand,
        });
      },
      repository,
      repositoryCheck,
    );
    await browser.refresh();
    await browser.waitUntil(() => existsSync(join(repository, 'config-repository-runs.txt')), {
      timeoutMsg: 'Repository check did not run after configuration recovered',
    });
    await browser.waitUntil(
      () =>
        browser.execute(async (path) => {
          const tauri = Reflect.get(window, '__TAURI__');
          const evidence = await tauri.core.invoke('get_acp_turn_evidence', {
            agent: 'claude',
            directory: path,
            sessionId: 'config-session',
            turnId: 'config-turn',
          });
          return evidence?.postTurnPending === false;
        }, repository),
      { timeoutMsg: 'The turn was not acknowledged after config recovered' },
    );
    expect(readFileSync(join(repository, 'config-personal-runs.txt'), 'utf8')).toBe('personal\n');
    expect(readFileSync(join(repository, 'config-repository-runs.txt'), 'utf8')).toBe(
      'repository\n',
    );
    await browser.refresh();
    expect(readFileSync(join(repository, 'config-personal-runs.txt'), 'utf8')).toBe('personal\n');
    expect(readFileSync(join(repository, 'config-repository-runs.txt'), 'utf8')).toBe(
      'repository\n',
    );
  });

  it('retries a check interrupted by restart once and leaves a declined check settled', async () => {
    const check = "printf 'recovered\\n' >> restart-runs.txt";
    writeFileSync(
      join(repository, '.sail', 'worktree.json'),
      JSON.stringify({ postTurnChecks: [] }),
    );
    const recovered = await browser.execute(
      async (path, checkCommand) => {
        const tauri = Reflect.get(window, '__TAURI__');
        const turn = (sessionId: string, turnId: string) => ({
          agent: 'claude',
          directory: path,
          sessionId,
          turnId,
          status: 'done',
          error: null,
          updatedAt: Date.now(),
          postTurnPending: true,
        });
        const result = (sessionId: string, turnId: string, status: string) => ({
          id: JSON.stringify([path, `acp:claude:${sessionId}`, turnId, 'personal', checkCommand]),
          updated: Date.now(),
          directory: path,
          thread: `acp:claude:${sessionId}`,
          turn: turnId,
          source: 'personal',
          command: checkCommand,
          status,
          output: '',
          code: null,
        });
        await tauri.core.invoke('save_setting', {
          key: 'sai-acp-turn-evidence',
          value: JSON.stringify([
            turn('restart-session', 'restart-turn'),
            turn('declined-session', 'declined-turn'),
          ]),
        });
        await tauri.core.invoke('save_setting', {
          key: 'sai-post-turn-history',
          value: JSON.stringify([
            result('restart-session', 'restart-turn', 'running'),
            result('declined-session', 'declined-turn', 'canceled'),
          ]),
        });
        await tauri.core.invoke('save_setting', {
          key: 'sai-post-turn-personal',
          value: JSON.stringify([checkCommand]),
        });
        localStorage.setItem('sai-post-turn-personal', JSON.stringify([checkCommand]));
        return tauri.core.invoke('list_post_turn_checks');
      },
      repository,
      check,
    );
    expect(recovered.find((item: { turn: string }) => item.turn === 'restart-turn')).toMatchObject({
      status: 'canceled',
      restartInterrupted: true,
    });
    expect(recovered.find((item: { turn: string }) => item.turn === 'declined-turn')).toMatchObject(
      { status: 'canceled', restartInterrupted: false },
    );

    await browser.refresh();
    await browser.waitUntil(() => existsSync(join(repository, 'restart-runs.txt')), {
      timeoutMsg: 'Restart-interrupted check did not run automatically',
    });
    await browser.waitUntil(() =>
      browser.execute(async (path) => {
        const tauri = Reflect.get(window, '__TAURI__');
        const turns = await Promise.all(
          [
            ['restart-session', 'restart-turn'],
            ['declined-session', 'declined-turn'],
          ].map(([sessionId, turnId]) =>
            tauri.core.invoke('get_acp_turn_evidence', {
              agent: 'claude',
              directory: path,
              sessionId,
              turnId,
            }),
          ),
        );
        return turns.every((turn) => turn?.postTurnPending === false);
      }, repository),
    );
    expect(readFileSync(join(repository, 'restart-runs.txt'), 'utf8')).toBe('recovered\n');
    await browser.refresh();
    expect(readFileSync(join(repository, 'restart-runs.txt'), 'utf8')).toBe('recovered\n');
  });

  it('shows a persistent write failure and waits for verified recovery before running', async () => {
    const check = "printf 'saved\\n' >> evidence-retry-runs.txt";
    writeFileSync(
      join(repository, '.sail', 'worktree.json'),
      JSON.stringify({ postTurnChecks: [] }),
    );
    await browser.execute(async (value) => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.core.invoke('save_setting', { key: 'sai-acp-turn-evidence', value: null });
      await tauri.core.invoke('save_setting', {
        key: 'sai-post-turn-personal',
        value: JSON.stringify([value]),
      });
      localStorage.setItem('sai-post-turn-personal', JSON.stringify([value]));
    }, check);
    const previousDocument = await browser.execute(() => performance.timeOrigin);
    await browser.refresh();
    await browser.waitUntil(() =>
      browser.execute(
        (previous) =>
          performance.timeOrigin > previous &&
          typeof Reflect.get(window, 'sailE2eStopAgentEvents') === 'function',
        previousDocument,
      ),
    );

    const emitReady = async () =>
      browser.execute(async (path) => {
        const tauri = Reflect.get(window, '__TAURI__');
        await tauri.event.emitTo('main', 'acp-event', {
          agent: 'claude',
          directory: path,
          worktree: path,
          message: {
            method: 'sail/post_turn_evidence_ready',
            params: { sessionId: 'retry-session', turnId: 'retry-turn' },
          },
        });
      }, repository);
    await browser.execute(async (path) => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.event.emitTo('main', 'acp-event', {
        agent: 'claude',
        directory: path,
        worktree: path,
        message: {
          method: 'sail/prompt_finished',
          params: {
            sessionId: 'retry-session',
            turnId: 'retry-turn',
            status: 'done',
            notify: false,
            evidenceError: 'injected settings write failure',
          },
        },
      });
    }, repository);
    await browser.waitUntil(() =>
      browser.execute(() =>
        [...document.querySelectorAll('[role="alert"]')].some((item) =>
          item.textContent?.includes('Completed turn is waiting for its post-turn check record'),
        ),
      ),
    );
    await emitReady();
    expect(existsSync(join(repository, 'evidence-retry-runs.txt'))).toBe(false);
    expect(
      await browser.execute(() =>
        [...document.querySelectorAll('[role="alert"]')].some((item) =>
          item.textContent?.includes('Completed turn is waiting for its post-turn check record'),
        ),
      ),
    ).toBe(true);
    const auditDir = process.env.SAIL_VISUAL_AUDIT_DIR;
    if (auditDir) {
      mkdirSync(auditDir, { recursive: true });
      const captureSize = async (theme: 'light' | 'dark', width: number, height: number) => {
        await browser.setWindowSize(width, height);
        const viewport = await browser.execute(() => ({
          width: innerWidth,
          height: innerHeight,
        }));
        console.log(
          `Evidence warning ${theme}: requested ${width}x${height}, viewport ${viewport.width}x${viewport.height}`,
        );
        await browser.saveScreenshot(
          join(auditDir, `evidence-warning-${theme}-${viewport.width}x${viewport.height}.png`),
        );
      };
      const captureTheme = async (theme: 'light' | 'dark') => {
        await browser.tauri.execute(
          async ({ core }, value) =>
            core.invoke('plugin:window|set_theme', { label: 'main', value }),
          theme,
        );
        await browser.waitUntil(
          async () =>
            (await browser.execute(() => document.documentElement.dataset.suiTheme)) === theme,
        );
        await captureSize(theme, 2560, 1440);
        await captureSize(theme, 1920, 1200);
      };
      await captureTheme('light');
      await captureTheme('dark');
      await browser.setWindowSize(390, 800);
      expect(await browser.execute(() => document.documentElement.scrollWidth > innerWidth)).toBe(
        false,
      );
      await browser.execute(() => {
        document.documentElement.style.zoom = '2';
      });
      expect(await browser.execute(() => document.querySelector('[role="alert"]') !== null)).toBe(
        true,
      );
      await browser.execute(() => {
        document.documentElement.style.zoom = '';
      });
    }
    await browser.execute(async (path) => {
      const tauri = Reflect.get(window, '__TAURI__');
      await tauri.core.invoke('save_setting', {
        key: 'sai-acp-turn-evidence',
        value: JSON.stringify([
          {
            agent: 'claude',
            directory: path,
            sessionId: 'retry-session',
            turnId: 'retry-turn',
            status: 'done',
            error: null,
            updatedAt: Date.now(),
            postTurnPending: true,
          },
        ]),
      });
    }, repository);
    await emitReady();
    await browser.waitUntil(() => existsSync(join(repository, 'evidence-retry-runs.txt')), {
      timeoutMsg: 'The recovered completion did not run its check',
    });
    await browser.waitUntil(() =>
      browser.execute(() =>
        [...document.querySelectorAll('[role="alert"]')].every(
          (item) =>
            !item.textContent?.includes('Completed turn is waiting for its post-turn check record'),
        ),
      ),
    );
    await emitReady();
    expect(readFileSync(join(repository, 'evidence-retry-runs.txt'), 'utf8')).toBe('saved\n');
  });
});
