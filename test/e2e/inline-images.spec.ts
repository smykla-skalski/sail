import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('inline image attachments', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-inline-images-e2e-'));

  before(() => execFileSync('git', ['init', '-q', repository]));
  after(() => rmSync(repository, { recursive: true, force: true }));

  it('places a pasted image between words and sends it', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await browser.keys(['Meta', '0']);

    const composer = $('[data-pane-prompt]');
    await composer.setValue('Clipboard fixture: i dont like how this  looks like fix it');
    await browser.execute(() => {
      const input = document.querySelector<HTMLElement>('[data-pane-prompt]');
      if (!input?.firstChild) throw new Error('No composer text');
      const text = input.firstChild.textContent ?? '';
      const offset = text.indexOf('  looks') + 1;
      const range = document.createRange();
      range.setStart(input.firstChild, offset);
      range.collapse(true);
      const selection = window.getSelection();
      selection?.removeAllRanges();
      selection?.addRange(range);
      const canvas = document.createElement('canvas');
      canvas.width = canvas.height = 2;
      canvas.getContext('2d')?.fillRect(0, 0, 2, 2);
      return new Promise<void>((resolve, reject) =>
        canvas.toBlob((blob) => {
          if (!blob) return reject(new Error('No PNG'));
          const data = new DataTransfer();
          data.items.add(new File([blob], 'example.png', { type: 'image/png' }));
          input.dispatchEvent(
            new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: data }),
          );
          resolve();
        }, 'image/png'),
      );
    });
    await expect($('.composer-image')).toHaveText(expect.stringContaining('example.png'));
    const parts = await browser.execute(() => {
      const input = document.querySelector<HTMLElement>('[data-pane-prompt]')!;
      return Array.from(input.childNodes).map((node) => node.textContent);
    });
    expect(parts[0]).toBe('Clipboard fixture: i dont like how this ');
    expect(parts[1]).toContain('example.png');
    expect(parts[2]).toContain('looks like fix it');

    const output = process.env.SAIL_VISUAL_AUDIT_DIR;
    if (output) {
      mkdirSync(output, { recursive: true });
      await [
        [2560, 1440],
        [1920, 1200],
        [390, 800],
      ].reduce(async (previous, [width, height]) => {
        await previous;
        await browser.setWindowSize(width, height);
        const actualWidth = await browser.execute(() => innerWidth);
        if (width === 390)
          expect(
            await browser.execute(() => document.documentElement.scrollWidth),
          ).toBeLessThanOrEqual(actualWidth);
        await ['light', 'dark'].reduce(async (previousTheme, theme) => {
          await previousTheme;
          await browser.execute((value) => {
            document.documentElement.dataset.suiTheme = value;
          }, theme);
          await browser.saveScreenshot(join(output, `composer-${actualWidth}-${theme}.png`));
        }, Promise.resolve());
      }, Promise.resolve());
    }

    await browser.setWindowSize(1920, 1200);
    const regularWidth = await browser.execute(() => innerWidth);
    await [1, 2, 3, 4, 5].reduce(async (previous) => {
      await previous;
      await browser.keys(['Meta', '=']);
    }, Promise.resolve());
    const zoomed = await browser.execute(() => ({
      width: innerWidth,
      documentWidth: document.documentElement.scrollWidth,
    }));
    expect(zoomed.width).toBeLessThanOrEqual(regularWidth / 2);
    expect(zoomed.documentWidth).toBeLessThanOrEqual(zoomed.width);
    await composer.click();
    await expect(composer).toBeFocused();
    await browser.keys('Tab');
    expect(await browser.execute(() => document.activeElement?.getAttribute('aria-label'))).toBe(
      'Remove example.png',
    );
    await browser.keys(['Meta', '0']);

    await $('button=Send ↗').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('image: image/png'));
    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining('i dont like how this [image] looks like fix it'),
    );
  });
});
