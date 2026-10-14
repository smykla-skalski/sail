import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTopbarAction } from './topbar';

const providers = [
  ['claude', 'Claude'],
  ['codex', 'Codex'],
  ['opencode', 'OpenCode'],
] as const;

for (const [provider, name] of providers) {
  describe(`missing task reports (${provider})`, () => {
    const repository = mkdtempSync(join(tmpdir(), 'sail-task-reporting-'));
    before(() => execFileSync('git', ['init', '-q', repository]));
    after(() => rmSync(repository, { recursive: true, force: true }));

    beforeEach(async () => {
      await browser.execute((directory) => {
        localStorage.setItem('sai-directory', directory);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
        );
        localStorage.setItem('sai-notifications-enabled', 'false');
      }, realpathSync(repository));
      await browser.refresh();
      await chooseTopbarAction('New agent', name);
      const auth = $('.agent-auth');
      if (await auth.isExisting()) await auth.$('button').click();
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
      if (provider === 'codex')
        await browser.tauri.execute(async ({ core }, directory) => {
          await core.invoke('acp_authenticate', {
            agent: 'codex',
            directory,
            methodId: 'chat-gpt',
          });
        }, realpathSync(repository));
    });

    async function send(mode: string) {
      await $('.agent-composer [data-pane-prompt]').setValue(`Task reporting fixture: ${mode}`);
      await $('.agent-actions button:last-child').click();
      await expect($('.agent-conversation')).toHaveText(
        expect.stringContaining('Task guidance received.'),
      );
      await browser.waitUntil(async () => {
        const reporting = await snapshot();
        return reporting?.turnId === null && !!reporting.reporting;
      });
    }

    async function snapshot() {
      return browser.execute(
        (agent, directory) => {
          const saved = JSON.parse(localStorage.getItem('sai-session-tasks') ?? '[]');
          return saved
            .filter(
              (item: { scope: { agent: string; directory: string }; updated: number }) =>
                item.scope.agent === agent && item.scope.directory === directory,
            )
            .toSorted((a: { updated: number }, b: { updated: number }) => b.updated - a.updated)[0]
            ?.snapshot;
        },
        provider,
        realpathSync(repository),
      );
    }

    it('marks omission after one correction and restores the missing marker', async () => {
      await send('omit');
      const completed = await snapshot();
      expect(completed.reporting.state).toBe('missing');
      expect(completed.reporting.correctionRequested).toBe(true);
      expect(
        (await $('.agent-conversation').getText()).split('One task correction received.'),
      ).toHaveLength(2);
      await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
      await $('button[role="tab"]*=Tasks').click();
      await expect($('#session-details [aria-label="Session tasks"]')).toHaveText(
        expect.stringContaining('Task report missing.'),
      );
      await browser.refresh();
      expect((await snapshot()).reporting).toEqual(completed.reporting);
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
      await $('.agent-composer [data-pane-prompt]').setValue('Task reporting fixture: recover');
      await expect($('.agent-actions button:last-child')).toBeEnabled();
      await $('.agent-actions button:last-child').click();
      await browser.waitUntil(async () => {
        const reporting = (await snapshot())?.reporting;
        return reporting?.turnId !== completed.reporting.turnId && reporting?.state === 'reported';
      });
      expect((await snapshot()).reporting.correctionRequested).toBe(true);
      await expect($('.agent-conversation')).toHaveText(
        expect.stringContaining('Task reporting passed'),
      );
    });

    for (const outcome of ['failed', 'interrupted']) {
      it(`does not correct a ${outcome} turn`, async () => {
        await send(outcome);
        const completed = await snapshot();
        expect(completed.reporting.state).toBe(outcome);
        expect(completed.reporting.correctionRequested).toBe(false);
        expect(await $('.agent-conversation').getText()).not.toContain(
          'One task correction received.',
        );
      });
    }
  });
}
