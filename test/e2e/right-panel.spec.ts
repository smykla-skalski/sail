import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('right details panel', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-right-panel-e2e-'));

  before(() => execFileSync('git', ['init', '-q', repository]));

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('spans the shell beside the toolbar and remains usable on mobile', async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute((path) => {
      localStorage.clear();
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await expect($('.agent-launches')).toHaveText(expect.stringContaining('Claude'));
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));

    writeFileSync(join(repository, 'panel-change.txt'), 'Changed for panel test\n');
    await $('.topbar-actions button[title="Toggle Changes (⌘L)"]').click();
    await expect($('#session-details')).toHaveText(expect.stringContaining('panel-change.txt'));

    const desktop = await browser.execute(() => ({
      sidebar: document.querySelector('.sidebar')!.getBoundingClientRect().toJSON(),
      topbar: document.querySelector('.topbar')!.getBoundingClientRect().toJSON(),
      details: document.querySelector('#session-details')!.getBoundingClientRect().toJSON(),
      status: document.querySelector('.agent-status-bar')!.getBoundingClientRect().toJSON(),
      viewportWidth: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(desktop.details.top).toBe(desktop.sidebar.top);
    expect(desktop.details.bottom).toBe(desktop.sidebar.bottom);
    expect(desktop.details.bottom).toBe(desktop.status.top);
    expect(desktop.details.left).toBeGreaterThanOrEqual(desktop.topbar.right);
    expect(desktop.documentWidth).toBeLessThanOrEqual(desktop.viewportWidth);

    const width = desktop.details.width;
    await browser.execute(() => document.querySelector<HTMLElement>('.details-resizer')?.focus());
    await browser.keys('ArrowLeft');
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelector('#session-details')!.getBoundingClientRect().width,
        )) > width,
    );

    await browser.setWindowSize(390, 600);
    await $('.mobile-switcher button:nth-child(3)').click();
    await expect($('#session-details')).toBeDisplayed();
    const mobile = await browser.execute(() => ({
      topbar: document.querySelector('.topbar')!.getBoundingClientRect().toJSON(),
      details: document.querySelector('#session-details')!.getBoundingClientRect().toJSON(),
      status: document.querySelector('.agent-status-bar')!.getBoundingClientRect().toJSON(),
    }));
    expect(mobile.details.top).toBe(mobile.topbar.bottom);
    expect(mobile.details.bottom).toBe(mobile.status.top);
  });
});
