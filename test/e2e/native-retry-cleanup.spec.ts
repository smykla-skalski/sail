import { browser, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('native retry fixture cleanup', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-native-retry-'));
  let attempt = 0;

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('starts a retry after settling requests from the failed attempt', async function () {
    this.retries(1);
    attempt += 1;
    const pending = await browser.tauri.execute(async ({ core }) =>
      core.invoke<unknown[]>('acp_pending_inbox'),
    );
    expect(pending).toHaveLength(0);
    if (attempt === 2) return;

    await browser.tauri.execute(async ({ core }, path) => {
      await core.invoke('acp_connect', { agent: 'codex', directory: path });
      await core.invoke('acp_authenticate', {
        agent: 'codex',
        directory: path,
        methodId: 'chat-gpt',
      });
      const session = await core.invoke<{ sessionId: string }>('acp_new_session', {
        params: { agent: 'codex', cwd: path },
      });
      void core.invoke('acp_prompt', {
        params: {
          agent: 'codex',
          directory: path,
          sessionId: session.sessionId,
          text: 'Delayed approval',
          turnId: 'native-retry-first-attempt',
          imagePaths: [],
        },
      });
    }, realpathSync(repository));
    await browser.waitUntil(
      async () =>
        (
          await browser.tauri.execute(async ({ core }) =>
            core.invoke<unknown[]>('acp_pending_inbox'),
          )
        ).length > 0,
      { timeoutMsg: 'First retry attempt did not leave a pending permission request' },
    );
    throw new Error('Intentional first-attempt product failure');
  });
});
