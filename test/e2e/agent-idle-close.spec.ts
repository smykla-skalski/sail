import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const closeLog = process.env.SAIL_E2E_ACP_CLOSE_LOG ?? '';

type Provider = 'codex' | 'claude' | 'opencode';

function closedSessions(): string[] {
  return existsSync(closeLog) ? readFileSync(closeLog, 'utf8').split('\n').filter(Boolean) : [];
}

function closeCount(sessionId: string): number {
  return closedSessions().filter((id) => id === sessionId).length;
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

async function setConfig(
  provider: Provider,
  directory: string,
  sessionId: string,
  configId: string,
  value: string,
) {
  const result = await browser.tauri.execute(
    async ({ core }, agent, path, id, config, next) =>
      core.invoke<{ configOptions: { id: string; currentValue: string }[] }>('acp_set_config', {
        agent,
        directory: path,
        sessionId: id,
        configId: config,
        value: next,
      }),
    provider,
    directory,
    sessionId,
    configId,
    value,
  );
  return result.configOptions;
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

// Closes the threads through the idle sweep, then stops further sweeps from closing them again.
async function closeIdleThreads(...ids: string[]) {
  const closes = ids.map(closeCount);
  await browser.tauri.execute(async ({ core }) => {
    await core.invoke('acp_set_idle_close_timeout', { seconds: 2 });
  });
  await browser.waitUntil(async () => ids.every((id, index) => closeCount(id) > closes[index]), {
    timeout: 90_000,
    interval: 500,
    timeoutMsg: 'the finished thread was never closed',
  });
  await browser.tauri.execute(async ({ core }) => {
    await core.invoke('acp_set_idle_close_timeout', { seconds: 3600 });
  });
}

async function beginHeldResume(provider: Provider, directory: string, sessionId: string) {
  writeFileSync(join(directory, 'idle-resume-hold.txt'), 'hold');
  await browser.tauri.execute(
    async ({ core }, agent, path, id) => {
      const event = window['__TAURI__']?.event;
      if (!event?.listen) throw new Error('Native Tauri event API is unavailable');
      let ready!: () => void;
      const waiting = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const unlisten = await event.listen('acp-event', ({ payload }) => {
        const envelope: unknown = payload;
        if (!envelope || typeof envelope !== 'object' || !('message' in envelope)) return;
        const message = envelope.message;
        if (!message || typeof message !== 'object' || !('params' in message)) return;
        const params = message.params;
        if (
          !params ||
          typeof params !== 'object' ||
          !('sessionId' in params) ||
          params.sessionId !== id ||
          !('update' in params)
        )
          return;
        const update = params.update;
        if (
          update &&
          typeof update === 'object' &&
          'sessionUpdate' in update &&
          update.sessionUpdate === 'idle_resume_waiting'
        )
          ready();
      });
      const reservation = await core.invoke<{ restoreToken: string }>('acp_begin_session_restore', {
        agent,
        cwd: path,
        sessionId: id,
      });
      const state = window as typeof window & {
        idleResume?: Promise<string>;
        idleRestoreToken?: string;
      };
      state.idleRestoreToken = reservation.restoreToken;
      state.idleResume = core
        .invoke('acp_resume_session', {
          params: { agent, cwd: path, sessionId: id, restoreToken: reservation.restoreToken },
        })
        .then(
          () => 'resumed',
          (error) => String(error),
        );
      try {
        await Promise.race([
          waiting,
          state.idleResume.then((result) => {
            throw new Error(`Resume did not wait: ${result}`);
          }),
        ]);
      } finally {
        unlisten();
      }
    },
    provider,
    directory,
    sessionId,
  );
}

async function finishHeldResume(provider: Provider, directory: string, sessionId: string) {
  rmSync(join(directory, 'idle-resume-hold.txt'), { force: true });
  return browser.tauri.execute(
    async ({ core }, agent, path, id) => {
      const state = window as typeof window & {
        idleResume?: Promise<string>;
        idleConfig?: Promise<string>;
        idleRestoreToken?: string;
      };
      const result = await Promise.all([state.idleResume, state.idleConfig]);
      await core.invoke('acp_end_session_restore', {
        agent,
        directory: path,
        sessionId: id,
        restoreToken: state.idleRestoreToken,
      });
      delete state.idleResume;
      delete state.idleConfig;
      delete state.idleRestoreToken;
      return result;
    },
    provider,
    directory,
    sessionId,
  );
}

// Deletes the thread after its restore reservation and before its resume, which may still arrive.
async function deleteDuringReservation(
  provider: Provider,
  directory: string,
  sessionId: string,
  resumes: boolean,
) {
  await browser.tauri.execute(
    async ({ core }, agent, path, id, resume) => {
      const reservation = await core.invoke<{ restoreToken: string }>('acp_begin_session_restore', {
        agent,
        cwd: path,
        sessionId: id,
      });
      await core.invoke('acp_forget_session', { agent, directory: path, sessionId: id });
      if (resume)
        await core
          .invoke('acp_resume_session', {
            params: { agent, cwd: path, sessionId: id, restoreToken: reservation.restoreToken },
          })
          .catch(() => undefined);
      await core.invoke('acp_end_session_restore', {
        agent,
        directory: path,
        sessionId: id,
        restoreToken: reservation.restoreToken,
      });
    },
    provider,
    directory,
    sessionId,
    resumes,
  );
}

// Keep setup independent of whichever test ran before it.
async function pauseIdleClose() {
  await browser.tauri.execute(async ({ core }) => {
    await core.invoke('acp_set_idle_close_timeout', { seconds: 3600 });
  });
}

describe('idle session close', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-idle-close-'));

  beforeEach(async () => {
    await pauseIdleClose();
  });

  afterEach(async () => {
    rmSync(join(repository, 'idle-resume-hold.txt'), { force: true });
    rmSync(join(repository, 'idle-slow-resume.txt'), { force: true });
    await browser.tauri.execute(async ({ core }) => {
      const state = window as typeof window & { idleVisibleTimer?: number };
      clearInterval(state.idleVisibleTimer);
      await core.invoke('acp_set_idle_close_timeout', { seconds: null });
    });
  });

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
    it(`closes an abandoned ${provider} restore after its reservation expires`, async () => {
      expect(closeLog).not.toBe('');
      const directory = realpathSync(repository);
      const [session] = await newSessions(provider, directory, 1);
      await finishTurns(provider, directory, [session]);
      await browser.tauri.execute(
        async ({ core }, agent, path, id) => {
          await core.invoke('acp_begin_session_restore', {
            agent,
            cwd: path,
            sessionId: id,
          });
        },
        provider,
        directory,
        session,
      );
      await closeIdleThreads(session);
      expect(await attached(provider, directory)).not.toContain(session);
    });

    it(`closes finished unseen ${provider} threads, spares busy and visible ones, and reattaches on prompt`, async () => {
      expect(closeLog).not.toBe('');
      const directory = realpathSync(repository);
      const sessions = await newSessions(provider, directory, 5);
      const [finished, visible, busy, reopened, unprompted] = sessions;

      await finishTurns(provider, directory, [finished, visible, reopened]);
      await setConfig(provider, directory, finished, 'effort', 'high');
      await setConfig(provider, directory, finished, 'mode', 'plan');
      await browser.tauri.execute(
        async ({ core }, agent, path, id) => {
          void core.invoke('acp_prompt', {
            params: {
              agent,
              directory: path,
              sessionId: id,
              text: 'Idle held turn',
              turnId: 'idle-long',
              imagePaths: [],
            },
          });
        },
        provider,
        directory,
        busy,
      );

      await browser.waitUntil(
        async () =>
          browser.tauri.execute(
            async ({ core }, agent, path, id) => {
              const activity = await core.invoke<Record<string, { active: string[] }>>(
                'acp_activity',
                {
                  directory: path,
                },
              );
              return activity[agent]?.active.includes(id) ?? false;
            },
            provider,
            directory,
            busy,
          ),
        { timeout: 90_000, timeoutMsg: 'the held turn never became active' },
      );
      await browser.tauri.execute(
        async ({ core }, agent, path, id) => {
          const touch = () =>
            core.invoke('acp_session_visible', {
              agent,
              directory: path,
              sessionId: id,
            });
          await touch();
          const state = window as typeof window & { idleVisibleTimer?: number };
          state.idleVisibleTimer = window.setInterval(() => {
            void touch();
          }, 100);
        },
        provider,
        directory,
        visible,
      );
      await closeIdleThreads(finished, reopened);

      const closedWhileBusy = closedSessions();
      expect(closedWhileBusy).not.toContain(visible);
      expect(closedWhileBusy).not.toContain(busy);
      if (provider === 'claude') expect(closedWhileBusy).not.toContain(unprompted);

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

      const restored = await setConfig(provider, directory, finished, 'model', 'test');
      expect(restored.find((option) => option.id === 'effort')?.currentValue).toBe('high');
      expect(restored.find((option) => option.id === 'mode')?.currentValue).toBe('plan');

      await browser.tauri.execute(
        async ({ core }, agent, path, id) => {
          await core.invoke('acp_cancel', { agent, directory: path, sessionId: id, turnId: null });
        },
        provider,
        directory,
        busy,
      );
      await closeIdleThreads(busy);
    });
  }

  for (const provider of ['codex', 'claude'] as const) {
    it(`reattaches a closed ${provider} thread once for concurrent calls and retries a failed resume`, async () => {
      const directory = realpathSync(repository);
      const [id] = await newSessions(provider, directory, 1);
      await finishTurns(provider, directory, [id]);
      await closeIdleThreads(id);
      expect(await attached(provider, directory)).not.toContain(id);

      const slowResume = join(directory, 'idle-slow-resume.txt');
      writeFileSync(slowResume, 'slow');
      const concurrent = await browser.tauri.execute(
        async ({ core }, agent, path, session) => {
          // A thread allows one turn at a time, so the second concurrent command is a config change.
          const outcomes = await Promise.allSettled([
            core.invoke('acp_set_config', {
              agent,
              directory: path,
              sessionId: session,
              configId: 'effort',
              value: 'high',
            }),
            core.invoke<{ stopReason?: string }>('acp_prompt', {
              params: {
                agent,
                directory: path,
                sessionId: session,
                text: 'Task reporting fixture: done',
                turnId: 'idle-race',
                imagePaths: [],
              },
            }),
            core.invoke('acp_set_config', {
              agent,
              directory: path,
              sessionId: session,
              configId: 'mode',
              value: 'plan',
            }),
          ]);
          const [effort, prompt, mode] = outcomes.map((outcome) =>
            outcome.status === 'fulfilled'
              ? { value: outcome.value }
              : { error: String(outcome.reason) },
          );
          return { effort, prompt, mode };
        },
        provider,
        directory,
        id,
      );
      rmSync(slowResume, { force: true });
      expect(concurrent.effort).not.toHaveProperty('error');
      expect(concurrent.prompt).not.toHaveProperty('error');
      expect(concurrent.mode).not.toHaveProperty('error');
      expect(await attached(provider, directory)).toContain(id);

      await closeIdleThreads(id);
      writeFileSync(join(directory, 'idle-fail-next-resume.txt'), 'fail');
      const failed = await browser.tauri.execute(
        async ({ core }, agent, path, session) =>
          core
            .invoke('acp_set_config', {
              agent,
              directory: path,
              sessionId: session,
              configId: 'effort',
              value: 'low',
            })
            .then(
              () => 'resumed',
              (error) => String(error),
            ),
        provider,
        directory,
        id,
      );
      expect(failed).toContain('Injected resume failure');
      expect(await attached(provider, directory)).not.toContain(id);

      const retried = await browser.tauri.execute(
        async ({ core }, agent, path, session) =>
          core.invoke<{ stopReason?: string }>('acp_prompt', {
            params: {
              agent,
              directory: path,
              sessionId: session,
              text: 'Task reporting fixture: done',
              turnId: 'idle-retry',
              imagePaths: [],
            },
          }),
        provider,
        directory,
        id,
      );
      expect(retried.stopReason).toBe('end_turn');
      expect(await attached(provider, directory)).toContain(id);
    });
  }

  for (const provider of ['codex', 'claude'] as const) {
    it(`restores a closed ${provider} thread from the UI without racing config changes, and keeps it closed when the resume fails`, async () => {
      const directory = realpathSync(repository);
      await pauseIdleClose();
      const [id] = await newSessions(provider, directory, 1);
      await finishTurns(provider, directory, [id]);
      await closeIdleThreads(id);
      expect(await attached(provider, directory)).not.toContain(id);

      await beginHeldResume(provider, directory, id);
      await browser.tauri.execute(
        async ({ core }, agent, path, session) => {
          const state = window as typeof window & { idleConfig?: Promise<string> };
          state.idleConfig = core
            .invoke('acp_set_config', {
              agent,
              directory: path,
              sessionId: session,
              configId: 'effort',
              value: 'high',
            })
            .then(
              () => 'applied',
              (error) => String(error),
            );
        },
        provider,
        directory,
        id,
      );
      const racing = await finishHeldResume(provider, directory, id);
      expect(racing).toEqual(['resumed', 'applied']);
      expect(await attached(provider, directory)).toContain(id);

      await closeIdleThreads(id);
      writeFileSync(join(directory, 'idle-fail-next-resume.txt'), 'fail');
      const failed = await browser.tauri.execute(
        async ({ core }, agent, path, session) => {
          const reservation = await core.invoke<{ restoreToken: string }>(
            'acp_begin_session_restore',
            { agent, cwd: path, sessionId: session },
          );
          const outcome = await core
            .invoke('acp_resume_session', {
              params: {
                agent,
                cwd: path,
                sessionId: session,
                restoreToken: reservation.restoreToken,
              },
            })
            .then(
              () => 'resumed',
              (error) => String(error),
            );
          await core.invoke('acp_end_session_restore', {
            agent,
            directory: path,
            sessionId: session,
            restoreToken: reservation.restoreToken,
          });
          return outcome;
        },
        provider,
        directory,
        id,
      );
      expect(failed).toContain('Injected resume failure');

      const retried = await setConfig(provider, directory, id, 'effort', 'low');
      expect(retried.find((option) => option.id === 'effort')?.currentValue).toBe('low');
      expect(await attached(provider, directory)).toContain(id);
    });
  }

  for (const provider of ['codex', 'claude'] as const) {
    it(`removes a loaded or restored ${provider} thread from activity immediately on delete`, async () => {
      const directory = realpathSync(repository);
      await pauseIdleClose();
      const [restored] = await newSessions(provider, directory, 1);
      await finishTurns(provider, directory, [restored]);
      await closeIdleThreads(restored);
      await browser.tauri.execute(
        async ({ core }, agent, path, session) => {
          const reservation = await core.invoke<{ restoreToken: string }>(
            'acp_begin_session_restore',
            { agent, cwd: path, sessionId: session },
          );
          await core.invoke('acp_resume_session', {
            params: {
              agent,
              cwd: path,
              sessionId: session,
              restoreToken: reservation.restoreToken,
            },
          });
          await core.invoke('acp_end_session_restore', {
            agent,
            directory: path,
            sessionId: session,
            restoreToken: reservation.restoreToken,
          });
        },
        provider,
        directory,
        restored,
      );
      const [loaded] = await newSessions(provider, directory, 1);
      await finishTurns(provider, directory, [loaded]);
      await Promise.all(
        [loaded, restored].map(async (id) => {
          expect(await attached(provider, directory)).toContain(id);
          await browser.tauri.execute(
            async ({ core }, agent, path, sessionId) => {
              await core.invoke('acp_forget_session', { agent, directory: path, sessionId });
            },
            provider,
            directory,
            id,
          );
          expect(await attached(provider, directory)).not.toContain(id);
        }),
      );
    });

    it(`deletes a loaded ${provider} thread even when its agent close fails`, async () => {
      const directory = realpathSync(repository);
      await pauseIdleClose();
      const [id] = await newSessions(provider, directory, 1);
      await finishTurns(provider, directory, [id]);
      const failedClose = join(directory, 'idle-failed-close.log');
      writeFileSync(join(directory, 'idle-fail-next-close.txt'), 'fail');
      await browser.tauri.execute(
        async ({ core }, agent, path, sessionId) => {
          await core.invoke('acp_forget_session', { agent, directory: path, sessionId });
        },
        provider,
        directory,
        id,
      );
      expect(await attached(provider, directory)).not.toContain(id);
      await browser.waitUntil(
        async () => existsSync(failedClose) && readFileSync(failedClose, 'utf8').includes(id),
        { timeout: 10_000, interval: 100, timeoutMsg: 'the close failure was never injected' },
      );
      expect(await attached(provider, directory)).not.toContain(id);
    });

    it(`drops a closed ${provider} thread's idle state when it is deleted, also during a resume`, async () => {
      const directory = realpathSync(repository);
      await pauseIdleClose();
      const [closed, resuming, reserved, reservedResumed] = await newSessions(
        provider,
        directory,
        4,
      );
      await finishTurns(provider, directory, [closed, resuming]);
      await closeIdleThreads(closed, resuming);

      const forget = (id: string) =>
        browser.tauri.execute(
          async ({ core }, agent, path, session) => {
            await core.invoke('acp_forget_session', {
              agent,
              directory: path,
              sessionId: session,
            });
          },
          provider,
          directory,
          id,
        );
      await forget(closed);
      const revived = await browser.tauri.execute(
        async ({ core }, agent, path, session) =>
          core
            .invoke('acp_prompt', {
              params: {
                agent,
                directory: path,
                sessionId: session,
                text: 'Task reporting fixture: done',
                turnId: 'idle-deleted',
                imagePaths: [],
              },
            })
            .then(
              () => 'prompted',
              (error) => String(error),
            ),
        provider,
        directory,
        closed,
      );
      expect(revived).not.toBe('prompted');
      expect(await attached(provider, directory)).not.toContain(closed);

      await beginHeldResume(provider, directory, resuming);
      await forget(resuming);
      const [outcome] = await finishHeldResume(provider, directory, resuming);
      expect(outcome).toContain('deleted while reconnecting');
      expect(await attached(provider, directory)).not.toContain(resuming);

      // A delete between the restore reservation and its resume leaves nothing registered either,
      // whether or not the resume still arrives.
      await finishTurns(provider, directory, [reserved, reservedResumed]);
      await closeIdleThreads(reserved, reservedResumed);
      await deleteDuringReservation(provider, directory, reserved, false);
      expect(await attached(provider, directory)).not.toContain(reserved);
      await deleteDuringReservation(provider, directory, reservedResumed, true);
      expect(await attached(provider, directory)).not.toContain(reservedResumed);
    });
  }

  it('keeps finished OpenCode threads loaded because closing them releases nothing', async () => {
    const directory = realpathSync(repository);
    const sessions = await newSessions('opencode', directory, 2);
    await finishTurns('opencode', directory, sessions);
    const [sentinel] = await newSessions('codex', directory, 1);
    await finishTurns('codex', directory, [sentinel]);
    await closeIdleThreads(sentinel);

    expect(closedSessions().some((id) => sessions.includes(id))).toBe(false);
    expect(await attached('opencode', directory)).toEqual(expect.arrayContaining(sessions));
  });
});
