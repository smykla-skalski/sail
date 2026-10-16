import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync } from 'node:fs';
import { join } from 'node:path';
import { chooseTopbarAction } from './topbar';

const root = process.env.SAIL_E2E_CONFIG_DIR;
if (!root) throw new Error('Split header tests require isolated SAIL_E2E_CONFIG_DIR.');
const repository = join(root, 'split-header-repository');

async function expectReadableHeaders() {
  const headers = await browser.execute(() =>
    [...document.querySelectorAll<HTMLElement>('.agent-header')].map((header) => {
      const provider = header.querySelector<HTMLElement>('.agent-heading strong')!;
      const bounds = provider.getBoundingClientRect();
      const pane = header.closest('.pane-leaf')!.getBoundingClientRect();
      const controls = [
        ...header.querySelectorAll<HTMLElement>('.option-trigger, .activity-status'),
      ];
      return {
        providerWidth: bounds.width,
        providerFits: provider.scrollWidth <= provider.clientWidth + 1,
        withinPane: [provider, ...controls].every((element) => {
          const rect = element.getBoundingClientRect();
          return rect.left >= pane.left - 1 && rect.right <= pane.right + 1;
        }),
        overlaps: controls.some((control) => {
          const rect = control.getBoundingClientRect();
          return (
            rect.left < bounds.right &&
            rect.right > bounds.left &&
            rect.top < bounds.bottom &&
            rect.bottom > bounds.top
          );
        }),
      };
    }),
  );
  expect(headers).toHaveLength(2);
  for (const header of headers) {
    expect(header.providerWidth).toBeGreaterThan(0);
    expect(header.providerFits).toBe(true);
    expect(header.withinPane).toBe(true);
    expect(header.overlaps).toBe(false);
  }
  expect(await browser.execute(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
    true,
  );
}

describe('split agent header', () => {
  before(async () => {
    mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-q', repository]);
    await browser.setWindowSize(1920, 1200);
    await browser.execute((directory) => {
      localStorage.clear();
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await chooseTopbarAction('New agent', 'Claude');
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await browser.keys(['Meta', 'd']);
    await $('.pane-leaf.focused [data-pane-picker]').click();
    await $('.pane-leaf.focused [data-agent-choice]:not(:disabled)').click();
    await expect($$('.agent-header')).toBeElementsArrayOfSize(2);
    await expect($('.pane-leaf.focused .agent-header')).toHaveText(
      expect.stringContaining('Ready'),
    );
  });

  after(async () => {
    await browser.keys(['Meta', '0']);
    await browser.setWindowSize(1280, 850);
  });

  it('keeps provider, mode and status separate at 200% with Tasks details open', async () => {
    await browser.keys(['Meta', 'l']);
    await $('.pane-leaf.focused button[role="tab"]*=Tasks').click();
    const width = await browser.execute(() => innerWidth);
    const zoomTo200 = async (previous: number, remaining = 8): Promise<void> => {
      if (previous <= width / 1.9 || remaining === 0) return;
      await browser.keys(['Meta', '=']);
      await browser.waitUntil(async () => (await browser.execute(() => innerWidth)) < previous);
      await zoomTo200(await browser.execute(() => innerWidth), remaining - 1);
    };
    await zoomTo200(width);
    expect(await browser.execute(() => innerWidth)).toBeLessThanOrEqual(width / 1.9);
    await expectReadableHeaders();
    const mode = $('.pane-leaf.focused .agent-config .option-trigger');
    await mode.click();
    await browser.keys('Escape');
    await expect(mode).toBeFocused();
    await browser.keys('Enter');
    await expect($('.pane-leaf.focused .agent-config [role="listbox"]')).toBeDisplayed();
    await browser.keys('Escape');
    await browser.keys(['Meta', '0']);
    await browser.keys(['Meta', 'l']);
  });

  for (const theme of ['light', 'dark']) {
    for (const width of [2560, 1920, 390, 320]) {
      it(`keeps split headers readable at ${width}px in ${theme}`, async () => {
        await browser.setWindowSize(width, width > 1920 ? 1440 : 1200);
        await browser.execute((value) => {
          document.documentElement.dataset.suiTheme = value;
        }, theme);
        expect(await browser.execute(() => innerWidth)).toBe(width);
        await expectReadableHeaders();
      });
    }
  }
});
