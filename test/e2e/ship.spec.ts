import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShipRun } from '../../src/lib/issue-shipping';

describe('native Ship run history', () => {
  const root = mkdtempSync(join(tmpdir(), 'sail-ship-view-'));
  const repository = realpathSync(root);

  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    await browser.setWindowSize(1280, 850);
  });

  after(async () => {
    await browser.execute(() => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
    });
    rmSync(root, { recursive: true, force: true });
  });

  it('shows persisted Ship runs in the Cmd+L details panel', async () => {
    const run: ShipRun = {
      id: 'ship-fixture',
      source: 'plan',
      repository,
      remote: 'fixture/repo',
      provider: 'claude',
      limit: 2,
      approvedAt: 1,
      externalClosed: {},
      umbrella: {
        number: 40,
        title: 'Ship dashboard fixture',
        url: 'https://github.com/fixture/repo/issues/40',
      },
      issues: [
        {
          id: 'first',
          number: 41,
          url: 'https://github.com/fixture/repo/issues/41',
          title: 'Implementation fixture',
          dependsOn: [],
          state: 'failed',
          branch: 'first',
          path: repository,
          receiptId: null,
          threadId: null,
          pullRequest: 'https://github.com/fixture/repo/pull/5',
          error: 'Manual test found a failure',
          workerModel: 'model-implementation',
          models: ['model-implementation'],
          checks: [
            {
              name: 'Build',
              state: 'FAILURE',
              url: 'https://github.com/fixture/repo/actions/runs/1',
            },
          ],
          gates: [
            {
              id: 'gate',
              gate: 'test-adversary',
              requestedModel: 'model-test',
              model: 'model-test',
              provider: 'codex',
              threadId: null,
              directory: repository,
              state: 'completed',
              created: 1,
              updated: 2,
              error: null,
              verdict: 'FAIL',
              reason: 'Reproduced fixture failure',
            },
          ],
        },
        {
          id: 'dependent',
          number: 42,
          url: 'https://github.com/fixture/repo/issues/42',
          title: 'Dependent fixture',
          dependsOn: ['first', 'owner/repo#123'],
          state: 'pending',
          branch: 'second',
          path: null,
          receiptId: null,
          threadId: null,
          pullRequest: null,
          error: null,
        },
        {
          id: 'merged',
          number: 43,
          url: 'https://github.com/fixture/repo/issues/43',
          title: 'Merged fixture',
          dependsOn: [],
          state: 'merged',
          branch: 'third',
          path: null,
          receiptId: null,
          threadId: null,
          pullRequest: null,
          workerSettled: true,
          error: null,
        },
      ],
    };
    const otherRun: ShipRun = {
      ...run,
      id: 'other-project-run',
      repository: join(repository, 'other-project'),
      remote: 'fixture/other',
      approvedAt: 2,
      umbrella: {
        number: 50,
        title: 'Other project fixture',
        url: 'https://github.com/fixture/other/issues/50',
      },
      issues: [],
    };
    await browser.tauri.execute(
      async ({ core }, input) => {
        await core.invoke('save_setting', {
          key: 'sai-ship-runs',
          value: JSON.stringify([input.run, input.otherRun]),
        });
        await core.invoke('save_setting', {
          key: 'sai-project-catalog',
          value: JSON.stringify({ repositories: [input.repository], groups: [], worktrees: {} }),
        });
        await core.invoke('save_setting', { key: 'sai-directory', value: input.repository });
      },
      { run, otherRun, repository },
    );
    await browser.execute(() => {
      localStorage.clear();
      localStorage.setItem('sail-settings-migrated-v1', '1');
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
    });
    await browser.refresh();
    await expect($('.ship-launch')).not.toExist();
    await expect($('.project-ship')).not.toExist();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('#session-details')).toBeDisplayed();
    await expect($('.side-tabs')).toHaveText(expect.stringContaining('Ship runs (2)'));
    await expect($('.ship-panel')).toBeDisplayed();
    await expect($('.ship-summary')).toHaveText(expect.stringContaining('Ship dashboard fixture'));
    await $('.ship-panel select').selectByAttribute('value', 'all');
    await expect($('.ship-summary')).toHaveText(expect.stringContaining('Other project fixture'));
    await $('.ship-panel select').selectByAttribute('value', 'current');
    await expect($('.ship-summary')).toHaveText(expect.stringContaining('1 / 3 merged'));
    await expect($('.ship-panel')).toHaveText(expect.stringContaining('Umbrella #40'));
    await expect($('.ship-graph')).toHaveText(expect.stringContaining('Blocked'));
    await expect(
      $('.ship-graph a[href="https://github.com/owner/repo/issues/123"]'),
    ).toBeDisplayed();
    await $('.ship-node:nth-child(2) .ship-node-select').click();
    await expect(
      $('.ship-issue-detail a[href="https://github.com/owner/repo/issues/123"]'),
    ).toBeDisplayed();
    await $('.ship-node:first-child .ship-node-select').click();
    await expect($('.ship-issue-detail')).toHaveText(
      expect.stringContaining('model-implementation'),
    );
    await expect($('.ship-gates')).toHaveText(expect.stringContaining('codex / model-test'));
    await expect($('.ship-gates')).toHaveText(expect.stringContaining('FAIL'));
    await expect($('.ship-checks summary')).toHaveText('CI: Failed');
    await $('.ship-node:nth-child(3) .ship-node-select').click();
    await expect($('.ship-issue-detail')).toHaveText(
      expect.stringContaining('Worktree removed after merge'),
    );
    await expect($('.ship-issue-detail button')).toBeDisabled();
    await $('.ship-node:first-child .ship-node-select').click();
    await $('.ship-issue-detail .ship-actions button').click();
    await expect($('.ship-panel')).not.toBeDisplayed();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await $('.ship-panel header button').click();
    await expect($('.ship-issue-detail')).toHaveText(expect.stringContaining('Refresh failed:'));
    await expect($('.ship-gates')).toHaveText(
      expect.stringContaining('Reproduced fixture failure'),
    );
    await $('[aria-label="Close Ship runs"]').click();
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('.ship-gates')).toHaveText(
      expect.stringContaining('Reproduced fixture failure'),
    );
    await $('[aria-label="Close Ship runs"]').click();

    await browser.keys(['Meta', 'd']);
    await expect($('.pane-split.row')).toBeDisplayed();
    await $('[aria-label="Close main pane"]').click();
    await expect($('[data-pane-id="main"]')).not.toExist();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('.ship-panel')).toBeDisplayed();
    await expect($('.ship-summary')).toHaveText(expect.stringContaining('Ship dashboard fixture'));
    await $('[aria-label="Close Ship runs"]').click();
  });
});
