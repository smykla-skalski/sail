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
    await browser.execute((selectedPath) => {
      localStorage.setItem('sai-directory', selectedPath);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({
          repositories: [selectedPath],
          groups: [{ id: 'work', name: 'Work', collapsed: false, repositories: [selectedPath] }],
          worktrees: {},
        }),
      );
      localStorage.removeItem('sai-sidebar-width');
      localStorage.setItem('sai-theme', 'dark');
    }, path);
    await browser.refresh();
    await browser.setWindowSize(2560, 1440);
    console.log('inner width', await browser.execute(() => innerWidth));
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
    await browser.keys('ArrowRight');

    await browser.execute(() => localStorage.setItem('sai-theme', 'light'));
    await browser.refresh();
    await browser.setWindowSize(2560, 1440);
    await shot('2560-default-light');
    await $('.sidebar-resizer').click();
    await pressHome();
    await shot('2560-rail-light');
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
