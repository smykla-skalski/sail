import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chooseTopbarAction } from './topbar';

const provider = process.env.SAIL_REAL_TASK_PROVIDER ?? 'claude';
const names: Record<string, string> = { claude: 'Claude', codex: 'Codex', opencode: 'OpenCode' };
const real = !!process.env.SAIL_REAL_TASK_PROVIDER;

describe(`session Tasks (${provider}${real ? ', real provider' : ', fixture'})`, () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-session-tasks-'));
  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('creates a starting task, receives native reports, and restores task history', async () => {
    await browser.execute(
      (directory, durable) => {
        if (durable) sessionStorage.setItem('sail-e2e-settings', 'enabled');
        localStorage.setItem('sai-directory', directory);
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({ repositories: [directory], groups: [], worktrees: {} }),
        );
        localStorage.setItem('sai-notifications-enabled', 'false');
      },
      realpathSync(repository),
      real,
    );
    await browser.refresh();
    await chooseTopbarAction('New agent', names[provider]);
    const auth = $('.agent-auth');
    if (await auth.isExisting()) await auth.$('button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer [data-pane-prompt]').setValue(
      real
        ? 'Use the Sail session task MCP tools for this smoke test. Call sail_tasks_read, then sail_tasks_report with its turnId and revision, a task id smoke, title Test live tasks, status in_progress and focus smoke. Read again, update that same task to done and focus null. Do not edit files or call other tools. Reply Task reporting passed.'
        : 'Report session tasks',
    );
    await $('.agent-actions button:last-child').click();
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    const tab = $('button[role="tab"]*=Tasks');
    await tab.click();
    const panel = $('#session-details [aria-label="Session tasks"]');
    await expect(panel).toHaveText(expect.stringContaining('Sail starting task'));
    await expect(panel).toHaveText(expect.stringContaining('Test live tasks'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('Task reporting passed'),
    );
    await browser.waitUntil(async () => !(await panel.getText()).includes('Current focus'));
    const before = await browser.execute(() =>
      JSON.parse(localStorage.getItem('sai-session-tasks') ?? '[]'),
    );
    expect(
      before[0].snapshot.tasks.filter((task: { id: string }) => task.id === 'smoke'),
    ).toHaveLength(1);
    expect(
      before[0].snapshot.tasks.find((task: { id: string }) => task.id === 'smoke').status,
    ).toBe('done');
    await browser.refresh();
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await $('button[role="tab"]*=Tasks').click();
    await expect($('#session-details [aria-label="Session tasks"]')).toHaveText(
      expect.stringContaining('Test live tasks'),
    );
  });
});
