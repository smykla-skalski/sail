import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTopbarAction } from './topbar';

describe('native child Tasks identity', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-native-task-'));
  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  for (const provider of ['opencode', 'claude', 'codex']) {
    it(`keeps ${provider} child task authority separate from its parent`, async () => {
      await browser.execute((directory) => {
        localStorage.clear();
        localStorage.setItem('sai-directory', directory);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
        );
        localStorage.setItem('sai-notifications-enabled', 'false');
      }, realpathSync(repository));
      await browser.refresh();
      await chooseTopbarAction(
        'New agent',
        { opencode: 'OpenCode', claude: 'Claude', codex: 'Codex' }[provider],
      );
      const auth = $('.agent-auth');
      if (await auth.isExisting()) await auth.$('button').click();
      await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
      await $('.agent-composer [data-pane-prompt]').setValue('Native child task reports');
      await $('.agent-actions button:last-child').click();
      await expect($('.project-agent-row[data-depth="1"]')).toBeDisplayed();
      await $('.project-agent-row[data-depth="1"]').click();
      await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
      await $('button[role="tab"]*=Tasks').click();
      const panel = $('#session-details [aria-label="Session tasks"]');
      if (provider === 'opencode') {
        await expect(panel).toHaveText(expect.stringContaining('Test live tasks'));
        await expect($('.agent-conversation')).toHaveText(
          expect.stringContaining('Task reporting passed'),
        );
        await browser.waitUntil(async () => !(await panel.getText()).includes('Current focus'));
      } else {
        await expect(panel).toHaveText(expect.stringContaining('Observed activity:'));
        await expect($('.agent-conversation')).toHaveText(
          expect.stringContaining('Task identity is unavailable'),
        );
      }
      const saved = await browser.execute(() =>
        JSON.parse(localStorage.getItem('sai-session-tasks') ?? '[]'),
      );
      const reported = saved.filter((item: { snapshot: { tasks: { id: string }[] } }) =>
        item.snapshot.tasks.some((task) => task.id === 'smoke'),
      );
      expect(reported).toHaveLength(provider === 'opencode' ? 1 : 0);
      if (provider === 'opencode') expect(reported[0].scope.sessionId).toContain(':task-child');
    });
  }
});
