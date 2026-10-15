import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTopbarAction } from './topbar';

const provider = process.env.SAIL_REAL_TASK_PROVIDER;
const names: Record<string, string> = { opencode: 'OpenCode', claude: 'Claude', codex: 'Codex' };
const suite = provider ? describe : describe.skip;

suite(`real native child Tasks (${provider ?? 'requires explicit provider environment'})`, () => {
  let repository: string;
  before(() => {
    repository = mkdtempSync(join(tmpdir(), 'sail-native-task-real-'));
    execFileSync('git', ['init', '-q', repository]);
  });
  after(() => {
    if (repository) rmSync(repository, { recursive: true, force: true });
  });

  it('attributes supported child reports and preserves observed provider limitations', async () => {
    if (!provider || !names[provider])
      throw new Error('Set an authorized SAIL_REAL_TASK_PROVIDER.');
    await browser.execute((directory) => {
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
      );
      localStorage.setItem('sai-notifications-enabled', 'false');
    }, realpathSync(repository));
    await browser.refresh();
    await chooseTopbarAction('New agent', names[provider]);
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer [data-pane-prompt]').setValue(
      'Test native child session task identity. Do not edit files, use terminal tools, inspect credentials, or access network services. First call Sail sail_tasks_read and sail_tasks_report for your own parent-only task, title Parent task identity, status done, focus null, with the current turnId and expectedRevision. Then spawn exactly one native child using your provider native subagent tool, not sail agent_spawn. Child prompt: Call Sail sail_tasks_read. If available, report child-only, title Child task identity, status in_progress, focus child-only with the read turnId/revision. Read again, then attempt one report with turnId stale-child-turn, the fresh expectedRevision, and a negative-only task title Rejected stale child report. Require an explicit different-turn error. Read again and verify negative-only is absent, then update child-only to done, focus null. Include the tool error in your final response. If identity or tools are unavailable, report the precise limitation in your final response and do not report through the parent. Wait for the child to finish. Do not make task calls on behalf of the child. Reply Native child identity check complete.',
    );
    await $('.agent-actions button:last-child').click();
    await expect($('.project-agent-row[data-depth="1"]')).toBeDisplayed();
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Native child identity check complete'),
    );
    await $('.project-agent-row[data-depth="1"]').click();
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await $('button[role="tab"]*=Tasks').click();
    const panel = $('#session-details [aria-label="Session tasks"]');
    const saved = await browser.execute(() =>
      JSON.parse(localStorage.getItem('sai-session-tasks') ?? '[]'),
    );
    const parent = saved.find((item: { snapshot: { tasks: { id: string }[] } }) =>
      item.snapshot.tasks.some((task) => task.id === 'parent-only'),
    );
    expect(parent).toBeDefined();
    expect(parent.snapshot.tasks.some((task: { id: string }) => task.id === 'child-only')).toBe(
      false,
    );
    if (provider === 'opencode') {
      await expect(panel).toHaveText(expect.stringContaining('Child task identity'));
      await browser.execute(() => {
        for (const item of document.querySelectorAll<HTMLDetailsElement>(
          '.agent-conversation details.tool-activity',
        ))
          item.open = true;
      });
      await browser.waitUntil(() =>
        browser.execute(() =>
          [...document.querySelectorAll('.agent-conversation [data-tool-id]')].some(
            (item) =>
              item.textContent?.includes('stale-child-turn') &&
              item.textContent.includes('different turn'),
          ),
        ),
      );
      const child = saved.find((item: { snapshot: { tasks: { id: string }[] } }) =>
        item.snapshot.tasks.some((task) => task.id === 'child-only'),
      );
      expect(child).toBeDefined();
      expect(child.scope.sessionId).not.toBe(parent.scope.sessionId);
      expect(child.snapshot.tasks.some((task: { id: string }) => task.id === 'negative-only')).toBe(
        false,
      );
      expect(child.snapshot.focus).toBeNull();
      expect(child.snapshot.turnId).toBeNull();
      expect(
        child.snapshot.tasks.find((task: { id: string }) => task.id === 'child-only').status,
      ).toBe('done');
      await browser.refresh();
      await expect(panel).toHaveText(expect.stringContaining('Child task identity'));
      await browser.waitUntil(async () => !(await panel.getText()).includes('Current focus'));
      const restored = await browser.execute(() =>
        JSON.parse(localStorage.getItem('sai-session-tasks') ?? '[]'),
      );
      const restoredChild = restored.find(
        (item: { scope: { sessionId: string } }) => item.scope.sessionId === child.scope.sessionId,
      );
      expect(restoredChild.snapshot.turnId).toBeNull();
      expect(restoredChild.snapshot.focus).toBeNull();
      expect(
        restoredChild.snapshot.tasks.find((task: { id: string }) => task.id === 'child-only')
          .status,
      ).toBe('done');
    } else {
      await expect(panel).toHaveText(expect.stringContaining('Observed activity:'));
      expect(
        saved.some((item: { snapshot: { tasks: { id: string }[] } }) =>
          item.snapshot.tasks.some((task) => task.id === 'child-only'),
        ),
      ).toBe(false);
    }
  });
});
