import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const shots = process.env.SAIL_E2E_SHOTS;

async function sidebarWidth() {
  return browser.execute(() => document.querySelector('.sidebar')!.getBoundingClientRect().width);
}

// The WebKit driver delivers Home with an empty key, so dispatch the event directly.
async function pressHome() {
  await browser.execute(() =>
    document
      .querySelector('.sidebar-resizer')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', bubbles: true })),
  );
}

async function shot(name: string) {
  if (shots) {
    await browser.execute(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    mkdirSync(shots, { recursive: true });
    await browser.saveScreenshot(join(shots, `${name}.png`));
  }
}

describe('resizable left pane', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-sidebar-resize-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('resizes by keyboard, collapses to an icon rail and persists the width', async () => {
    const path = realpathSync(repository);
    const settings = await browser.execute((selectedPath) => {
      sessionStorage.setItem('sail-e2e-settings', 'enabled');
      const states = ['done', 'interrupted', 'failed'] as const;
      const threads = states.map((state, index) => ({
        agent: 'claude',
        directory: selectedPath,
        sessionId: `rail-${state}`,
        title: `Rail ${state}`,
        updated: Date.now() - index,
      }));
      localStorage.setItem('sai-directory', selectedPath);
      localStorage.setItem('sail-agent-threads', JSON.stringify(threads));
      localStorage.setItem(
        'sai-thread-attention',
        JSON.stringify(
          Object.fromEntries(
            threads.map((thread, index) => [
              JSON.stringify([thread.agent, thread.directory, thread.sessionId]),
              { status: states[index], unread: false },
            ]),
          ),
        ),
      );
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({
          repositories: [selectedPath],
          groups: [{ id: 'work', name: 'Work', collapsed: false, repositories: [selectedPath] }],
          worktrees: {},
        }),
      );
      localStorage.setItem('sai-sidebar-width', '248');
      localStorage.setItem('sai-theme', 'dark');
      return [
        'sai-directory',
        'sail-agent-threads',
        'sai-thread-attention',
        'sai-project-catalog',
        'sai-sidebar-width',
        'sai-theme',
      ].map((key) => [key, localStorage.getItem(key)]);
    }, path);
    await browser.tauri.execute(async ({ core }, entries) => {
      await Promise.all(entries.map(([key, value]) => core.invoke('save_setting', { key, value })));
    }, settings);
    await browser.refresh();
    await browser.setWindowSize(2560, 1440);
    console.log('inner width', await browser.execute(() => innerWidth));
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset.suiTheme)) === 'dark',
    );
    await expect($('.sidebar-resizer')).toBeDisplayed();
    expect(await sidebarWidth()).toBe(248);
    await shot('2560-default');

    const resizer = await $('.sidebar-resizer');
    await resizer.click();
    await browser.keys(['ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight', 'ArrowRight']);
    expect(await sidebarWidth()).toBe(348);
    await shot('2560-wide');

    await pressHome();
    await expect($('.app-shell')).toHaveAttribute('data-sidebar-rail', 'true');
    expect(await sidebarWidth()).toBe(64);
    await expect($('.sidebar-rail .rail-repository')).toBeDisplayed();
    await expect($('.sidebar .projects')).not.toBeDisplayed();
    expect(
      await Promise.all(
        ['completed', 'interrupted', 'failed'].map((state) =>
          $(`.sidebar-rail .rail-thread[data-state="${state}"]`).isDisplayed(),
        ),
      ),
    ).toEqual([true, true, true]);
    expect(
      await browser.execute(() =>
        [...document.querySelectorAll<HTMLButtonElement>('.sidebar-rail .rail-thread')].every(
          (thread) =>
            thread.scrollWidth <= thread.clientWidth &&
            thread.scrollHeight <= thread.clientHeight &&
            !/Working|Interrupted|Failed/.test(thread.textContent ?? ''),
        ),
      ),
    ).toBe(true);
    await shot('2560-rail');

    await browser.refresh();
    await expect($('.app-shell')).toHaveAttribute('data-sidebar-rail', 'true');

    await $('.sidebar-resizer').click();
    await browser.keys('ArrowRight');
    await expect($('.app-shell')).toHaveAttribute('data-sidebar-rail', 'false');
    expect(await sidebarWidth()).toBe(180);
    await browser.keys('ArrowLeft');
    await expect($('.app-shell')).toHaveAttribute('data-sidebar-rail', 'true');

    await browser.execute(() =>
      document
        .querySelector('.sidebar-resizer')!
        .dispatchEvent(new MouseEvent('dblclick', { bubbles: true })),
    );
    expect(await sidebarWidth()).toBe(248);

    await browser.setWindowSize(1920, 1200);
    await shot('1920-default');
    await pressHome();
    await shot('1920-rail');
    await $('.sidebar-resizer').click();
    await browser.keys('ArrowRight');

    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'k', metaKey: true, bubbles: true }),
      ),
    );
    await $('[aria-label="Search command palette"]').setValue('Switch to light theme');
    await $('.palette-entry.active').click();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset.suiTheme)) === 'light',
    );
    await browser.setWindowSize(2560, 1440);
    await shot('2560-default-light');
    await $('.sidebar-resizer').click();
    await pressHome();
    await shot('2560-rail-light');
    await browser.setWindowSize(1920, 1200);
    await shot('1920-rail-light');
    await browser.execute(() => (document.documentElement.style.zoom = '2'));
    expect(
      await browser.execute(() => {
        const sidebar = document.querySelector('.sidebar')!.getBoundingClientRect();
        return [...document.querySelectorAll('.sidebar-rail .rail-thread')].every((thread) => {
          const bounds = thread.getBoundingClientRect();
          return bounds.left >= sidebar.left && bounds.right <= sidebar.right;
        });
      }),
    ).toBe(true);
    await shot('1920-rail-light-200pct');
    await browser.execute(() => (document.documentElement.style.zoom = ''));
    await browser.execute(() => localStorage.setItem('sai-sidebar-width', '248'));
    await browser.refresh();

    await browser.setWindowSize(390, 800);
    await expect($('.sidebar-resizer')).not.toExist();
    await shot('390');
    const overflow = await browser.execute(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
    );
    expect(overflow).toBe(false);
  });
});
