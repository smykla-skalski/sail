import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ShipRun } from '../../src/lib/issue-shipping';

const validationGates = () =>
  $("//h4[normalize-space()='Validation gates']/following-sibling::ol[1]");

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
          validationPolicy: {
            risk: 'high',
            requiredGates: ['code-adversary', 'findings-adversary', 'test-adversary'],
            sources: ['path rule src-tauri/**: high (src-tauri/src/lib.rs)'],
            revision: 'fixture-revision',
            changedPaths: ['src-tauri/src/lib.rs'],
            selectedAt: 1,
            history: [
              {
                requestedRisk: 'medium',
                selectedRisk: 'high',
                sources: ['path rule src-tauri/**: high (src-tauri/src/lib.rs)'],
                at: 1,
              },
            ],
          },
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
          path: join(repository, 'missing-worktree'),
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
    run.issues.push(
      ...Array.from({ length: 7 }, (_, index) => ({
        ...run.issues[2],
        id: `completed-${index}`,
        number: 44 + index,
        url: `https://github.com/fixture/repo/issues/${44 + index}`,
        title: `Completed fixture ${index + 1}`,
        branch: `completed-${index}`,
      })),
    );
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
    await expect($('.app-shell')).toBeDisplayed();
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
    await $('.ship-scope button:nth-child(2)').click();
    await expect($('.ship-summary')).toHaveText(expect.stringContaining('Other project fixture'));
    await $('.ship-scope button:first-child').click();
    await browser.keys('Escape');
    await expect($('.ship-panel')).not.toBeDisplayed();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('.ship-panel')).toBeDisplayed();
    await expect($('.ship-summary')).toHaveText(expect.stringContaining('8 / 10 merged'));
    await expect($('.ship-panel')).toHaveText(expect.stringContaining('Umbrella #40'));
    await expect($('.ship-run-option[aria-pressed="true"]')).toHaveText(
      expect.stringContaining('Ship dashboard fixture'),
    );
    await expect($('.ship-run-option[aria-pressed="true"]')).toHaveText(
      expect.stringContaining('fixture/repo'),
    );
    await expect($('.ship-run-option[aria-pressed="true"]')).toHaveText(
      expect.stringContaining('Launched'),
    );
    await expect($('.ship-now')).toHaveText(expect.stringContaining('Needs attention first'));
    await expect($('.ship-now')).toHaveText(expect.stringContaining('Shipping failed'));
    await expect($('.ship-now')).toHaveText(expect.stringContaining('Blocked by dependency'));
    await expect($$('.ship-now-item')).toBeElementsArrayOfSize(10);
    await expect($('.ship-now-item:first-child')).toHaveAttribute('data-ship-issue-id', 'first');
    await expect($('.ship-now-item:first-child')).toHaveText(
      expect.stringContaining('Recovery needed'),
    );
    await expect($('.ship-now-item:first-child')).toHaveText(expect.stringContaining('Next'));
    await expect($('.ship-now-item:first-child .ship-claims')).toHaveText(
      expect.stringContaining('Worker'),
    );
    const initialWidth = await browser.execute(() => window.innerWidth);
    const zoomTo200 = async (width: number, remaining = 8): Promise<number> => {
      if (width <= initialWidth / 1.9 || remaining === 0) return width;
      await browser.keys(['Meta', '=']);
      await browser.waitUntil(async () => (await browser.execute(() => window.innerWidth)) < width);
      return zoomTo200(await browser.execute(() => window.innerWidth), remaining - 1);
    };
    const zoomedWidth = await zoomTo200(initialWidth);
    expect(zoomedWidth).toBeLessThanOrEqual(initialWidth / 1.9);
    expect(zoomedWidth).toBeGreaterThanOrEqual(initialWidth / 2.1);
    await $('.mobile-switcher button:nth-child(3)').click();
    await expect($('.ship-panel')).toBeDisplayed();
    expect(
      await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>('.ship-panel')!;
        return panel.scrollWidth <= panel.clientWidth;
      }),
    ).toBe(true);
    await browser.keys(['Meta', '0']);
    await browser.waitUntil(
      async () => (await browser.execute(() => window.innerWidth)) === initialWidth,
    );
    await $('[data-ship-issue-id="dependent"]').click();
    await expect(
      $('.ship-issue-detail a[href="https://github.com/owner/repo/issues/123"]'),
    ).toBeDisplayed();
    await $('[data-ship-issue-id="first"]').click();
    await expect($('.ship-issue-detail')).toHaveText(
      expect.stringContaining('model-implementation'),
    );
    await expect(validationGates()).toHaveText(expect.stringContaining('codex / model-test'));
    await expect(validationGates()).toHaveText(expect.stringContaining('FAIL'));
    await expect($('.ship-policy')).toHaveText(expect.stringContaining('Selected risk high'));
    await expect($('.ship-policy')).toHaveText(expect.stringContaining('src-tauri/**: high'));
    await expect($('.ship-checks summary')).toHaveText('CI: Failed');
    const listScroll = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('.ship-panel')!;
      const list = document.querySelector<HTMLElement>('.ship-now')!;
      panel.scrollTop = list.offsetTop;
      document.querySelector<HTMLButtonElement>('[data-ship-issue-id="merged"]')!.click();
      return panel.scrollTop;
    });
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document.querySelector('[data-ship-issue-id="merged"]')?.getAttribute('aria-pressed') ===
          'true',
      ),
    );
    expect(
      await browser.execute(() => document.querySelector<HTMLElement>('.ship-panel')!.scrollTop),
    ).toBe(listScroll);
    await expect($('.ship-issue-detail')).toHaveText(
      expect.stringContaining('Worktree removed after merge'),
    );
    await expect($('.ship-issue-detail button')).toBeDisabled();
    await $('[data-ship-issue-id="first"]').click();
    await $('.ship-issue-detail .ship-actions button').click();
    await expect($('.ship-panel')).not.toBeDisplayed();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await $('.ship-panel header button').click();
    await expect($('.ship-issue-detail')).toHaveText(expect.stringContaining('Refresh failed:'));
    await expect(validationGates()).toHaveText(
      expect.stringContaining('Reproduced fixture failure'),
    );
    await $('[data-ship-issue-id="dependent"]').click();
    await $('.ship-issue-detail .ship-actions button').click();
    await expect($('.ship-panel > .ship-error[role="alert"]')).toExist();
    await $('[aria-label="Close Ship runs"]').click();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('.ship-panel > .ship-error[role="alert"]')).not.toExist();
    await $('[aria-label="Close Ship runs"]').click();
    await browser.execute(() => localStorage.clear());
    await browser.refresh();
    await expect($('.app-shell')).toBeDisplayed();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect(validationGates()).toHaveText(
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

    await browser.tauri.execute(async ({ core }, path) => {
      await core.invoke('save_setting', {
        key: 'sai-pane-layouts',
        value: JSON.stringify({ [path]: { id: 'main', agent: null, thread: null } }),
      });
      await core.invoke('save_setting', { key: `sai-main-pane-empty:${path}`, value: 'true' });
    }, repository);
    await browser.refresh();
    await expect($('.pane-picker')).toBeDisplayed();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('.ship-fallback .ship-panel')).toBeDisplayed();
    await expect($('.ship-summary')).toHaveText(expect.stringContaining('Ship dashboard fixture'));
    await browser.setWindowSize(700, 850);
    await $('.mobile-switcher button:nth-child(2)').click();
    await expect($('.ship-fallback')).not.toExist();
    await $('.mobile-switcher button:nth-child(3)').click();
    await expect($('.ship-fallback .ship-panel')).toBeDisplayed();
    expect(
      await browser.execute(() => {
        const panel = document.querySelector<HTMLElement>('.ship-panel')!;
        return panel.scrollWidth <= panel.clientWidth;
      }),
    ).toBe(true);
    await $('[aria-label="Close Ship runs"]').click();
    await browser.setWindowSize(1280, 850);

    await browser.keys(['Meta', 'd']);
    await expect($('.pane-leaf.focused [data-pane-picker]')).toBeDisplayed();
    await $('.pane-leaf.focused [data-pane-picker]').click();
    try {
      await expect($('.pane-leaf.focused [data-agent-choice]:not(:disabled)')).toBeDisplayed();
    } catch (cause) {
      console.error('Ship split agent picker diagnostic', {
        picker: await $('.pane-leaf.focused .pane-picker').getText(),
        focused: await $('.pane-leaf.focused').getAttribute('data-pane-id'),
        choices: await browser.execute(() =>
          [...document.querySelectorAll('.pane-leaf.focused [data-agent-choice]')].map(
            (element) => ({
              text: element.textContent,
              disabled: element instanceof HTMLButtonElement ? element.disabled : null,
            }),
          ),
        ),
      });
      throw cause;
    }
    await $('.pane-leaf.focused [data-agent-choice]:not(:disabled)').click();
    await expect($('.pane-leaf.focused .agent-workspace')).toBeDisplayed();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await expect($('.pane-leaf.focused .native-details')).toBeDisplayed();
    try {
      await expect(
        $('.pane-leaf.focused .native-details [data-detail-tab="ship"]'),
      ).toBeDisplayed();
    } catch (cause) {
      console.error('Ship split details diagnostic', {
        focusedPane: await $('.pane-leaf.focused').getAttribute('data-pane-id'),
        tabs: await $$('.pane-leaf.focused .native-details .side-tabs button').map((button) =>
          button.getText(),
        ),
        details: await $('.pane-leaf.focused .native-details').getText(),
      });
      throw cause;
    }
    await $('.pane-leaf.focused .native-details [data-detail-tab="ship"]').click();
    await expect($('.pane-leaf.focused .ship-panel')).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.pane-leaf.focused .native-details')).not.toExist();
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'l', metaKey: true, bubbles: true }),
      ),
    );
    await browser.setWindowSize(700, 850);
    await $('.mobile-switcher button:nth-child(3)').click();
    await expect($('.pane-leaf.focused .native-details')).toBeDisplayed();
    await expect($('.pane-leaf.focused .native-details button.active')).toBeFocused();
    await expect($('.ship-fallback')).not.toExist();
    await $('.mobile-switcher button:nth-child(2)').click();
    await expect($('.pane-leaf.focused .native-details')).not.toBeDisplayed();
    try {
      await expect($('.pane-leaf.focused .agent-workspace')).toBeDisplayed();
    } catch (cause) {
      console.error(
        'Ship mobile Chat diagnostic',
        await browser.execute(() => ({
          view: document.querySelector('.app-shell')?.getAttribute('data-mobile-view'),
          panes: [...document.querySelectorAll('.pane-leaf')].map((pane) => ({
            id: pane.getAttribute('data-pane-id'),
            focused: pane.classList.contains('focused'),
            agent: pane.querySelector('.agent-workspace') !== null,
            details: pane.querySelector('.native-details') !== null,
          })),
        })),
      );
      throw cause;
    }
    await $('.mobile-switcher button:nth-child(3)').click();
    await expect($('.pane-leaf.focused .native-details')).toBeDisplayed();
    await $('.mobile-switcher button:nth-child(1)').click();
    await expect($('.pane-leaf.focused .native-details')).not.toBeDisplayed();
    await browser.setWindowSize(1280, 850);
  });
});
