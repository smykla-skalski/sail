import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type AxeRun = (
  context: Element | null,
  options: { runOnly: { type: 'rule'; values: string[] } },
) => Promise<{ violations: { id: string }[] }>;

declare global {
  interface Window {
    axe: { run: AxeRun };
  }
}

const axeSource = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');

describe('keyboard scrolling of a long transcript', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-scroll-focus-e2e-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('puts an overflowing conversation in the tab order so keys can scroll it', async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute((path) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    const conversation = $('.agent-conversation');
    await expect(conversation).not.toHaveAttribute('tabindex');

    await $('.agent-composer [data-pane-prompt]').setValue('Long answer');
    await $('.agent-actions button').click();
    await $('.permission-card .permission-actions button').click();
    await expect(conversation).toHaveText(expect.stringContaining('Answer line 99'));
    await expect(conversation).toHaveAttribute('tabindex', '0');

    await browser.execute(axeSource);
    const violations = await browser.execute(async () => {
      const result = await window.axe.run(document.querySelector('.agent-conversation'), {
        runOnly: { type: 'rule', values: ['scrollable-region-focusable'] },
      });
      return result.violations.map((violation) => violation.id);
    });
    expect(violations).toEqual([]);

    await browser.execute(() => {
      const region = document.querySelector<HTMLElement>('.agent-conversation');
      region?.scrollTo({ top: 0 });
      region?.focus();
    });
    expect(
      await browser.execute(
        () => document.activeElement === document.querySelector('.agent-conversation'),
      ),
    ).toBe(true);
    // WebKit's WebDriver keys are untrusted and never scroll; a native
    // PageDown on the focused region does.
  });
});
