import { browser, $, $$, expect } from '@wdio/globals';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

async function captureTheme(theme: 'light' | 'dark', audit?: string) {
  await browser.execute((value) => (document.documentElement.dataset.suiTheme = value), theme);
  const viewport = await browser.execute(() => ({
    width: innerWidth,
    height: innerHeight,
    scrollWidth: document.documentElement.scrollWidth,
  }));
  expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
  await expect($('.patch-scroll')).toBeDisplayed();
  console.log(`Diff viewport ${theme}: ${viewport.width}×${viewport.height}`);
  if (audit)
    await browser.saveScreenshot(
      join(audit, `${viewport.width}x${viewport.height}-diff-${theme}.png`),
    );
}

async function auditSize(width: number, height: number, audit?: string) {
  await browser.setWindowSize(width, height);
  await captureTheme('light', audit);
  await captureTheme('dark', audit);
}

describe('large diff interaction', () => {
  it('keeps a large patch scrollable and commentable without mounting every line', async () => {
    await browser.execute(() => history.replaceState(null, '', '?diff-scale-fixture'));
    await browser.refresh();

    const patch = $('.patch-scroll');
    await expect(patch).toBeDisplayed();
    expect((await $$('.patch-scroll .diff-line')).length).toBeLessThanOrEqual(160);

    await patch.$('button[aria-label="Comment on new line 1"]').click();
    await browser.execute(() => {
      const scroll = document.querySelector<HTMLElement>('.patch-scroll')!;
      scroll.scrollTop = scroll.scrollHeight;
    });
    const last = patch.$('button[aria-label="Comment on new line 2000"]');
    await expect(last).toBeDisplayed();
    expect((await $$('.patch-scroll .diff-line')).length).toBeLessThanOrEqual(160);

    await browser.execute(() => {
      document
        .querySelector('button[aria-label="Comment on new line 2000"]')!
        .dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true }));
    });
    await expect($('.diff-comment-entry label')).toHaveText('Comment on large.txt:1-2000');
  });

  it('keeps the diff usable at large and narrow sizes', async () => {
    await browser.execute(() => history.replaceState(null, '', '?diff-scale-fixture'));
    await browser.refresh();
    const audit = process.env.SAIL_VISUAL_AUDIT_DIR;
    if (audit) mkdirSync(audit, { recursive: true });
    await auditSize(2560, 1440, audit);
    await auditSize(1920, 1200, audit);
    await auditSize(390, 844, audit);
  });

  it('keeps the last line and comment action reachable at 200% zoom', async () => {
    await browser.execute(() => history.replaceState(null, '', '?diff-scale-fixture'));
    await browser.refresh();
    await browser.setWindowSize(1920, 1200);
    await browser.execute(() => (document.documentElement.style.zoom = '200%'));
    try {
      await browser.execute(() => {
        const first = document.querySelector<HTMLButtonElement>(
          'button[aria-label="Comment on new line 1"]',
        )!;
        first.focus();
        first.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', bubbles: true }));
      });
      const last = $('button[aria-label="Comment on new line 2000"]');
      await expect(last).toBeDisplayed();
      await last.click();
      await expect($('.diff-comment-entry label')).toHaveText('Comment on large.txt:2000');
    } finally {
      await browser.execute(() => (document.documentElement.style.zoom = ''));
    }
  });
});
