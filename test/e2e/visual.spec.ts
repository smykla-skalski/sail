import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { returnToWorkspace, openSettings } from './settings-window';

const output = process.env.SAIL_VISUAL_AUDIT_DIR;

async function capture(name: string) {
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

async function layout() {
  return browser.execute(() => {
    const viewport = { width: innerWidth, height: innerHeight };
    const selectors = [
      '.app-shell',
      '.topbar',
      '.sidebar',
      '.workspace',
      '.chat-area',
      '.side-area',
      '.worktree-dialog',
      '.worktree-dialog-heading',
      '.worktree-form-actions',
    ];
    const boxes = Object.fromEntries(
      selectors.flatMap((selector) => {
        const element = document.querySelector<HTMLElement>(selector);
        if (!element || getComputedStyle(element).display === 'none') return [];
        const rect = element.getBoundingClientRect();
        return [
          [
            selector,
            {
              x: Math.round(rect.x),
              y: Math.round(rect.y),
              right: Math.round(rect.right),
              bottom: Math.round(rect.bottom),
              scrollWidth: element.scrollWidth,
              clientWidth: element.clientWidth,
              scrollHeight: element.scrollHeight,
              clientHeight: element.clientHeight,
            },
          ],
        ];
      }),
    );
    return { viewport, documentWidth: document.documentElement.scrollWidth, boxes };
  });
}

describe('visual layout audit', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-visual-repository-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
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
      '--allow-empty',
      '-q',
      '-m',
      'baseline',
    ]);
  });

  after(() => rmSync(repository, { recursive: true, force: true }));

  it('captures navigation, settings, worktree, and agent states at varied sizes', async function () {
    if (process.env.SAIL_FUZZ_SEED) this.skip();
    this.timeout(180_000);
    const path = realpathSync(repository);
    const longName = `A very long project group ${'navigation'.repeat(12)}`;
    await browser.execute(
      (selected, groupName) => {
        localStorage.setItem('sai-directory', selected);
        localStorage.setItem('sai-theme', 'light');
        localStorage.setItem(
          'sai-project-catalog',
          JSON.stringify({
            repositories: [selected],
            groups: [{ id: 'long', name: groupName, collapsed: false, repositories: [selected] }],
          }),
        );
      },
      path,
      longName,
    );
    await browser.refresh();
    await expect($('.project-group-toggle')).toBeDisplayed();

    await [
      [1280, 850],
      [850, 650],
      [520, 650],
      [390, 600],
      [320, 500],
    ].reduce(async (previous, [width, height]) => {
      await previous;
      await browser.setWindowSize(width, height);
      await browser.pause(100);
      const size = await layout();
      expect(size.boxes['.app-shell'].bottom).toBeLessThanOrEqual(size.viewport.height + 1);
      expect(size.documentWidth).toBeLessThanOrEqual(size.viewport.width + 1);
      if (width <= 850) await $('.mobile-switcher button:nth-child(1)').click();
      await capture(`${width}x${height}-sessions`);
      if (width <= 850) await $('.mobile-switcher button:nth-child(2)').click();
      const sendButtonBottom = await browser.execute(
        () => document.querySelector('.composer-bottom button')?.getBoundingClientRect().bottom,
      );
      if (typeof sendButtonBottom === 'number')
        expect(sendButtonBottom).toBeLessThanOrEqual(size.viewport.height + 1);
      if (width === 320) {
        await expect($('.main-area > .notice.error')).toHaveText(
          expect.stringContaining('settings'),
        );
        await browser.execute(() => {
          document.documentElement.style.fontSize = '200%';
        });
        const launchActions = await $$('.welcome-agents button');
        expect(launchActions.length).toBeGreaterThan(1);
        const actionBounds = await launchActions.reduce<
          Promise<Array<{ top: number; bottom: number }>>
        >(async (accumulated, action) => {
          const bounds = await accumulated;
          await browser.execute((element) => {
            element.scrollIntoView({ block: 'center' });
          }, action);
          await action.waitForDisplayed();
          expect(await action.isEnabled()).toBe(true);
          return [
            ...bounds,
            await browser.execute((element) => {
              const rect = element.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom };
            }, action),
          ];
        }, Promise.resolve([]));
        actionBounds.forEach((bounds) => {
          expect(bounds.top).toBeGreaterThanOrEqual(0);
          expect(bounds.bottom).toBeLessThanOrEqual(size.viewport.height + 1);
        });
        await browser.execute(() => {
          document.documentElement.style.removeProperty('font-size');
        });
      }
      await capture(`${width}x${height}-chat`);
      if (width <= 850) await $('.mobile-switcher button:nth-child(1)').click();
      await $(`[aria-label="Create worktree for ${path.split('/').at(-1)}"]`).click();
      const dialog = await layout();
      expect(dialog.boxes['.worktree-dialog'].scrollWidth).toBeLessThanOrEqual(
        dialog.boxes['.worktree-dialog'].clientWidth + 1,
      );
      await capture(`${width}x${height}-worktree-dialog`);
      await browser.execute(() => {
        const element = document.querySelector('.worktree-dialog');
        if (element) element.scrollTop = element.scrollHeight;
      });
      const actions = await browser.execute(() => {
        const rect = document.querySelector('.worktree-form-actions')!.getBoundingClientRect();
        return { bottom: rect.bottom, right: rect.right };
      });
      expect(actions.bottom).toBeLessThanOrEqual(dialog.viewport.height + 1);
      expect(actions.right).toBeLessThanOrEqual(dialog.viewport.width + 1);
      if (
        dialog.boxes['.worktree-dialog'].scrollHeight >
        dialog.boxes['.worktree-dialog'].clientHeight
      )
        await capture(`${width}x${height}-worktree-dialog-bottom`);
      await $('.worktree-dialog .worktree-cancel').click();
      if (width === 390) {
        await openSettings();
        await browser.setWindowSize(520, 420);
        await capture('compact-general-settings');
        await $('.settings-navigation button:nth-child(2)').click();
        const settingsReachable = await browser.execute(() => {
          const panel = document.querySelector<HTMLElement>('.settings-content');
          return !!panel && document.documentElement.scrollWidth <= innerWidth;
        });
        expect(settingsReachable).toBe(true);
        await capture('mobile-opencode-settings');
        await browser.execute(() =>
          document.querySelector('.repository-diagnostics')?.scrollIntoView({ block: 'start' }),
        );
        await capture('mobile-repository-diagnostics');
        const restartBottom = await browser.execute(() => {
          const button = document.querySelector<HTMLElement>('.repository-diagnostics button')!;
          button.scrollIntoView({ block: 'end' });
          return { bottom: button.getBoundingClientRect().bottom, height: innerHeight };
        });
        expect(restartBottom.bottom).toBeLessThanOrEqual(restartBottom.height + 1);
        await capture('mobile-repository-diagnostics-bottom');
        await returnToWorkspace();
      }
    }, Promise.resolve());

    await browser.setWindowSize(1280, 850);
    await $('[aria-label="Add project group"]').click();
    await capture('desktop-group-form');
    await $('[aria-label="Cancel project group"]').click();
    await $('.project-group-heading button:last-child').click();
    await capture('desktop-group-menu');
    await $('.project-group-heading button:last-child').click();
    await openSettings();
    await capture('desktop-general-settings');
    await $('.settings-navigation button:nth-child(2)').click();
    await capture('desktop-opencode-settings');
    await browser.execute(() =>
      document.querySelector('.repository-diagnostics')?.scrollIntoView({ block: 'start' }),
    );
    await capture('desktop-repository-diagnostics');
    const desktopRestart = await browser.execute(() => {
      const button = document.querySelector<HTMLElement>('.repository-diagnostics button')!;
      button.scrollIntoView({ block: 'end' });
      return { bottom: button.getBoundingClientRect().bottom, viewport: innerHeight };
    });
    expect(desktopRestart.bottom).toBeLessThanOrEqual(desktopRestart.viewport + 1);
    await capture('desktop-repository-diagnostics-bottom');
    await $('.settings-navigation button:nth-child(3)').click();
    await capture('desktop-agent-settings');
    await returnToWorkspace();
    await $(`[aria-label="Create worktree for ${path.split('/').at(-1)}"]`).click();
    await $(`[aria-label="Worktree name for ${path.split('/').at(-1)}"]`).setValue('visual-audit');
    await $('.worktree-agent-option:has(input[value="claude"])').click();
    await $('.worktree-form button[type="submit"]').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const worktree = await browser.execute(() => localStorage.getItem('sai-directory'));
    expect(worktree).toContain('/visual-audit');
    await capture('desktop-worktree-agent-empty');
    await $(`.project-worktree-select[title="${worktree}"]`).click({ button: 'right' });
    await capture('desktop-worktree-menu');
    await $('.brand').click();
    await $('.agent-composer textarea').setValue('unbrokentoken'.repeat(30));
    await $('.agent-actions button').click();
    await expect($('.agent-permission')).toBeDisplayed();
    await capture('desktop-agent-permission');
    await $('.agent-permission button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Done:'));
    const header = await browser.execute(() => {
      const title = document.querySelector('.agent-heading span')!.getBoundingClientRect();
      const badge = document.querySelector('.agent-header > :last-child')!.getBoundingClientRect();
      return { titleRight: title.right, badgeLeft: badge.left };
    });
    expect(header.titleRight).toBeLessThanOrEqual(header.badgeLeft);
    await capture('desktop-agent-conversation');
    writeFileSync(join(worktree, 'visual-change.txt'), 'Changed during audit\n');
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await expect($('.diff-files')).toHaveText(expect.stringContaining('visual-change.txt'));
    await capture('desktop-agent-changes');
    await openSettings();
    await $('[aria-label^="Theme:"]').click();
    await $('.option-menu [role="option"]:nth-child(2)').click();
    await returnToWorkspace();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset.suiTheme)) === 'dark',
    );
    await capture('desktop-dark-changes');
    await browser.setWindowSize(390, 600);
    await $('.mobile-switcher button:nth-child(3)').click();
    await capture('mobile-dark-details');
    await $('.mobile-switcher button:nth-child(2)').click();
    await capture('mobile-dark-agent-chat');
  });

  const labels = [
    'unbrokentoken'.repeat(20),
    '日本語のプロジェクト'.repeat(8),
    '👩‍🚀🚢🌊'.repeat(14),
    'مرحبا بالمشروع '.repeat(12),
    'a name / with spaces & punctuation !?'.repeat(5),
  ];
  for (let seed = 0; seed < 16; seed++) {
    if (process.env.SAIL_VISUAL_ONLY) break;
    if (process.env.SAIL_FUZZ_SEED && seed !== Number(process.env.SAIL_FUZZ_SEED)) continue;
    it(`keeps crowded project and agent controls reachable (seed ${seed})`, async () => {
      const selected = realpathSync(repository);
      const width = seed % 2 ? 320 : 1280;
      await browser.setWindowSize(width, seed % 2 ? 500 : 850);
      const groups = Array.from({ length: 1 + (seed % 8) }, (_, index) => ({
        id: `group-${seed}-${index}`,
        name: labels[(seed + index) % labels.length],
        collapsed: index % 3 === 0,
        repositories: index === 0 ? [selected] : [],
      }));
      const worktrees = Array.from({ length: seed % 7 }, (_, index) => ({
        path: `${selected}/mock-worktree-${seed}-${index}`,
        branch: labels[(seed + index) % labels.length],
      }));
      const threads = Array.from({ length: seed % 12 }, (_, index) => ({
        agent: index % 2 ? 'codex' : 'claude',
        sessionId: `mock-${seed}-${index}`,
        directory: selected,
        title: labels[(seed + index) % labels.length],
        updated: Date.now() - index * 1000,
      }));
      await browser.execute(
        (path, catalog, savedThreads) => {
          localStorage.setItem('sai-directory', path);
          localStorage.setItem('sai-project-catalog', JSON.stringify(catalog));
          localStorage.setItem('sail-agent-threads', JSON.stringify(savedThreads));
        },
        selected,
        { repositories: [selected], groups, worktrees: { [selected]: worktrees } },
        threads,
      );
      const previousPage = await browser.execute(() => performance.timeOrigin);
      await browser.refresh();
      await browser.waitUntil(
        async () => (await browser.execute(() => performance.timeOrigin)) !== previousPage,
      );
      await $('.app-shell').waitForDisplayed();
      if (width === 320) {
        await $('.mobile-switcher button:nth-child(1)').click();
        await expect($('.app-shell')).toHaveAttribute('data-mobile-view', 'sessions');
        await expect($('.sidebar')).toBeDisplayed();
      }
      await browser.execute(() =>
        document.querySelector('.project-group-toggle')?.scrollIntoView(),
      );
      try {
        await expect($('.project-group-toggle')).toBeDisplayed();
      } catch (cause) {
        console.error('Project group visibility diagnostic', {
          seed,
          state: await browser.execute(() => ({
            view: document.querySelector('.app-shell')?.getAttribute('data-mobile-view'),
            sidebar: getComputedStyle(document.querySelector('.sidebar')!).display,
            group: document
              .querySelector('.project-group-toggle')
              ?.getBoundingClientRect()
              .toJSON(),
            contentScroll: document.querySelector('.sidebar-content')?.scrollTop,
          })),
        });
        throw cause;
      }
      await capture(`fuzz-${String(seed).padStart(2, '0')}-${width}`);
      console.log(
        `FUZZ_VISIBILITY_${seed}`,
        JSON.stringify(
          await browser.execute(() =>
            ['.sidebar', '.projects', '.project-list'].map((selector) => {
              const element = document.querySelector(selector)!;
              const rect = element.getBoundingClientRect();
              return { selector, height: rect.height, y: rect.y, bottom: rect.bottom };
            }),
          ),
        ),
      );
      const findings = await browser.execute(() => {
        const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
        const footer = document.querySelector('.sidebar-footer')!.getBoundingClientRect();
        const headings = [...document.querySelectorAll('.project-group-heading')];
        const overlaps = headings.filter((heading) => {
          const controls = [...heading.querySelectorAll('button')].map((button) =>
            button.getBoundingClientRect(),
          );
          return controls.some((rect, index) =>
            controls.slice(index + 1).some((next) => rect.right > next.left + 1),
          );
        });
        return {
          documentWidth: document.documentElement.scrollWidth,
          viewportWidth: innerWidth,
          sidebarRight: sidebar.right,
          footerBottom: footer.bottom,
          viewportHeight: innerHeight,
          overlapCount: overlaps.length,
        };
      });
      console.log(`FUZZ_SEED_${seed}`, JSON.stringify(findings));
      expect(findings.documentWidth).toBeLessThanOrEqual(findings.viewportWidth + 1);
      expect(findings.sidebarRight).toBeLessThanOrEqual(findings.viewportWidth + 1);
      expect(findings.footerBottom).toBeLessThanOrEqual(findings.viewportHeight + 1);
      expect(findings.overlapCount).toBe(0);
      await expect($('.sidebar-sessions')).not.toExist();
    });
  }
});
