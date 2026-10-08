import { browser, $, $$, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { shortcuts } from '../../src/lib/shortcuts.ts';
import { chooseTopbarAction } from './topbar';

type AxeViolation = { id: string; impact: string | null; nodes: string[] };
type AxeApi = {
  run: (
    context: Element | Document,
    options: { runOnly: { type: 'tag'; values: string[] } },
  ) => Promise<{
    violations: { id: string; impact: string | null; nodes: { target: unknown[] }[] }[];
  }>;
};

declare global {
  interface Window {
    axe: AxeApi;
  }
}

const axeSource = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');
const input = () => $('[aria-label="Search command palette"]');

async function axeViolations(selector?: string): Promise<AxeViolation[]> {
  await browser.execute(axeSource);
  return browser.executeAsync(
    async (target: string | null, done: (violations: AxeViolation[]) => void) => {
      const context = target ? (document.querySelector(target) ?? document) : document;
      const result = await window.axe.run(context, {
        runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'] },
      });
      done(
        result.violations.map((violation) => ({
          id: violation.id,
          impact: violation.impact,
          nodes: violation.nodes.map((node) => node.target.join(' ')),
        })),
      );
    },
    selector ?? null,
  );
}

async function expectNoViolations(view: string, selector?: string) {
  const violations = await axeViolations(selector);
  expect({ view, violations }).toEqual({ view, violations: [] });
}

async function pressShortcut(key: string, modifiers: { shiftKey?: boolean } = {}) {
  await browser.execute(
    (value, extra) =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: value, metaKey: true, bubbles: true, ...extra }),
      ),
    key,
    modifiers,
  );
}

async function openPalette() {
  await browser.waitUntil(async () => {
    if (!(await browser.execute(() => !!document.querySelector('.command-palette[open]'))))
      await pressShortcut('k');
    return browser.execute(() => !!document.querySelector('.command-palette[open]'));
  });
}

function theme() {
  return browser.execute(() => ({
    stored: localStorage.getItem('sai-theme'),
    applied: document.documentElement.dataset.suiTheme,
    system: matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light',
  }));
}

function selectText(selector = '.agent-header') {
  return browser.execute((target: string) => {
    const header = document.querySelector(target);
    if (!header || !navigator.clipboard) throw new Error('No selectable text or clipboard');
    const writes: string[] = [];
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true,
      value: async (text: string) => {
        writes.push(text);
      },
    });
    const range = document.createRange();
    range.selectNodeContents(header);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    header.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    return new Promise<string[]>((done) =>
      setTimeout(() => {
        selection?.removeAllRanges();
        Object.defineProperty(navigator.clipboard, 'writeText', {
          configurable: true,
          value: original,
        });
        done(writes);
      }, 150),
    );
  }, selector);
}

describe('palette actions and accessibility', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-a11y-repo-'));
  let repoPath = '';

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
    repoPath = realpathSync(repository);
  });

  after(async () => {
    await browser.execute(() => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
    });
    rmSync(repository, { recursive: true, force: true });
  });

  it('has no axe violations in the workspace, palette, shortcut sheet and Inbox', async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute((repo) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
      localStorage.setItem('sai-directory', repo);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [repo], groups: [] }),
      );
      const thread = {
        agent: 'claude',
        directory: repo,
        sessionId: 'a11y',
        title: 'Accessibility thread',
        updated: Date.now(),
      };
      localStorage.setItem('sail-agent-threads', JSON.stringify([thread]));
      localStorage.setItem(
        'sai-pane-layouts',
        JSON.stringify({ [repo]: { id: 'main', agent: 'claude', thread } }),
      );
    }, repoPath);
    await browser.refresh();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Accessibility thread'));

    await expectNoViolations('workspace');

    await $('.topbar button[title^="Toggle Changes"]').click();
    await expect($('.side-tabs [role="tab"][aria-selected="true"]')).toBeDisplayed();
    await expectNoViolations('details tabs');
    await $('.topbar button[title^="Toggle Changes"]').click();

    await openPalette();
    await input().setValue('split');
    await expect($('.palette-entry[data-kind="action"]')).toBeDisplayed();
    await expectNoViolations('command palette', '.command-palette');
    await browser.keys('Escape');

    await pressShortcut('/');
    await expect($('.shortcuts-dialog[open]')).toBeDisplayed();
    await expectNoViolations('shortcut sheet', '.shortcuts-dialog');
    await browser.keys('Escape');

    await $('[data-topbar-inbox]').click();
    await expect($('.inbox-dialog[open]')).toBeDisplayed();
    await expectNoViolations('inbox', '.inbox-dialog');
    await browser.keys('Escape');

    await chooseTopbarAction('More actions', 'Task overview');
    await expect($('.task-overview')).toBeDisplayed();
    await expectNoViolations('task overview');
    await chooseTopbarAction('More actions', 'Back to workspace');
  });

  it('runs palette actions and shows their shortcut hints', async () => {
    await openPalette();
    await input().setValue('task overview');
    const entry = $('.palette-entry[data-kind="action"]');
    await expect(entry).toBeDisplayed();
    await expect(entry).toHaveText(expect.stringContaining('Action'));
    await expect(input()).toHaveAttribute('role', 'combobox');
    await expect(input()).toHaveAttribute('aria-activedescendant', await entry.getAttribute('id'));
    await expect(entry).toHaveAttribute('aria-selected', 'true');
    await browser.keys('Enter');
    await expect($('.command-palette[open]')).not.toExist();
    await expect($('.task-overview')).toBeDisplayed();

    await openPalette();
    await input().setValue('side chat');
    await expect($('.palette-entry[data-kind="action"]')).toHaveText(
      expect.stringContaining('⌘⇧J'),
    );
    await browser.keys('Escape');

    await openPalette();
    await input().setValue('back to workspace');
    await browser.keys('Enter');
    await expect($('.task-overview')).not.toExist();

    await openPalette();
    await input().setValue('dark theme');
    await browser.keys('Enter');
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset.suiTheme)) === 'dark',
    );
    await openPalette();
    await input().setValue('light theme');
    await browser.keys('Enter');
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.documentElement.dataset.suiTheme)) === 'light',
    );
  });

  it('switches the theme away from System and back from the palette', async () => {
    const choose = async (query: string) => {
      await openPalette();
      await input().setValue(query);
      await expect($('.palette-entry[data-kind="action"]')).toHaveText(
        expect.stringContaining(query),
      );
      await browser.keys('Enter');
      await expect($('.command-palette[open]')).not.toExist();
    };

    await choose('system theme');
    await browser.waitUntil(async () => (await theme()).stored === 'system');
    await openPalette();
    await input().setValue('system theme');
    await expect($('.palette-entry[data-kind="action"]')).not.toExist();
    await browser.keys('Escape');

    const fromSystem = (await theme()).system === 'dark' ? 'light' : 'dark';
    await choose(`${fromSystem} theme`);
    await browser.waitUntil(async () => {
      const current = await theme();
      return current.stored === fromSystem && current.applied === fromSystem;
    });

    await choose('system theme');
    await browser.waitUntil(async () => {
      const current = await theme();
      return current.stored === 'system' && current.applied === current.system;
    });
  });

  it('opens the command palette from its top bar button', async () => {
    await $('.topbar-palette').click();
    await expect($('.command-palette[open]')).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.command-palette[open]')).not.toExist();
  });

  it('lists every registry shortcut in the sheet opened with Cmd+/', async () => {
    await pressShortcut('/');
    await expect($('.shortcuts-dialog[open]')).toBeDisplayed();
    const ids = await $$('.shortcuts-row').map((row) => row.getAttribute('data-shortcut-id'));
    expect(ids).toEqual(shortcuts.map((shortcut) => shortcut.id));
    await browser.keys('Escape');
    await expect($('.shortcuts-dialog[open]')).not.toExist();
  });

  it('puts every sidebar thread menu in the tab order and opens it with focus inside', async () => {
    const reachable = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('.project-agent-menu');
      if (!button) return null;
      button.focus();
      return {
        focused: document.activeElement === button,
        disabled: button.disabled,
        tabIndex: button.tabIndex,
        name: button.getAttribute('aria-label'),
        popup: button.getAttribute('aria-haspopup'),
      };
    });
    expect(reachable).toEqual({
      focused: true,
      disabled: false,
      tabIndex: 0,
      name: 'Manage thread Accessibility thread',
      popup: 'menu',
    });
    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('.project-agent-menu')?.click(),
    );
    await expect($('.project-menu[role="menu"]')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => !!document.activeElement?.closest('.project-menu')),
    );
    await browser.keys('Escape');
    await expect($('.project-menu')).not.toExist();
  });

  it('shows and announces "Copied" for a copy inside a modal dialog', async () => {
    await pressShortcut('/');
    await expect($('.shortcuts-dialog[open]')).toBeDisplayed();
    expect((await selectText('.shortcuts-list')).join(' ')).toContain('Toggle sidebar');
    const status = $('.shortcuts-dialog .copy-status[role="status"]');
    await expect(status).toHaveText('Copied');
    await expect(status).toBeDisplayed();
    await browser.keys('Escape');
    await expect($('.shortcuts-dialog[open]')).not.toExist();

    expect((await selectText()).join(' ')).toContain('Accessibility thread');
    await browser.waitUntil(() =>
      browser.execute(() => {
        const region = document.querySelector('.copy-status');
        return !region?.closest('dialog') && region?.textContent?.trim() === 'Copied';
      }),
    );
    await browser.waitUntil(async () => (await $('.copy-status').getText()) === '', {
      timeout: 5000,
    });
  });

  it('copies selections only when select-to-copy is on and announces "Copied"', async () => {
    expect((await selectText()).join(' ')).toContain('Accessibility thread');
    await expect($('.copy-status[role="status"]')).toHaveText('Copied');
    await browser.waitUntil(async () => (await $('.copy-status').getText()) === '', {
      timeout: 5000,
    });

    await browser.execute(() => localStorage.setItem('sai-auto-copy-enabled', 'false'));
    await browser.refresh();
    await expect($('.agent-header')).toBeDisplayed();
    expect(await selectText()).toEqual([]);
    await expect($('.copy-status')).toHaveText('');
  });
});
