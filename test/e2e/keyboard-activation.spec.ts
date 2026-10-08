import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

type Readiness = {
  button: boolean;
  enabled: boolean;
  inTabOrder: boolean;
  focused: boolean;
  enterBlocked: boolean;
  spaceBlocked: boolean;
  focusKept: boolean;
};

/**
 * WebKit's WebDriver sends untrusted keys: Enter and Space never activate a
 * button and Tab never moves focus, so native Enter and Space activation is
 * not exercised here. This checks what it relies on instead: an enabled,
 * visible, focusable button, and no app key handler cancelling synthetic
 * Enter or Space on it.
 */
function keyboardReadiness(selector: string): Promise<Readiness> {
  return browser.execute((target: string) => {
    const control = document.querySelector<HTMLElement>(target);
    if (!control) throw new Error(`Missing ${target}`);
    const scope = control.closest('dialog[open]') ?? document;
    const order = [
      ...scope.querySelectorAll<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]',
      ),
    ].filter(
      (element) =>
        element.tabIndex >= 0 &&
        !(element instanceof HTMLButtonElement && element.disabled) &&
        !element.closest('[inert], [aria-hidden="true"], [hidden]') &&
        element.checkVisibility({ visibilityProperty: true }),
    );
    control.focus();
    const focused = document.activeElement === control;
    const press = (type: 'keydown' | 'keyup', key: string, code: string) =>
      !control.dispatchEvent(
        new KeyboardEvent(type, { key, code, bubbles: true, cancelable: true }),
      );
    const enterBlocked = press('keydown', 'Enter', 'Enter') || press('keyup', 'Enter', 'Enter');
    const spaceBlocked = press('keydown', ' ', 'Space') || press('keyup', ' ', 'Space');
    return {
      button: control instanceof HTMLButtonElement && (control.type === 'button' || !control.form),
      enabled:
        control instanceof HTMLButtonElement &&
        !control.disabled &&
        control.ariaDisabled !== 'true',
      inTabOrder: order.includes(control),
      focused,
      enterBlocked,
      spaceBlocked,
      focusKept: document.activeElement === control,
    };
  }, selector);
}

const ready: Readiness = {
  button: true,
  enabled: true,
  inTabOrder: true,
  focused: true,
  enterBlocked: false,
  spaceBlocked: false,
  focusKept: true,
};

function activateFocused() {
  return browser.execute(() => {
    const active = document.activeElement;
    if (active instanceof HTMLElement) active.click();
  });
}

describe('keyboard activation of the palette, thread menu and shortcut sheet', () => {
  let repository = '';

  before(async () => {
    repository = mkdtempSync(join(tmpdir(), 'sail-keyboard-e2e-'));
    execFileSync('git', ['init', '-q', repository]);
    await browser.setWindowSize(1280, 850);
    await browser.execute((path: string) => {
      sessionStorage.removeItem('sail-e2e-settings');
      localStorage.clear();
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
      const thread = {
        agent: 'claude',
        directory: path,
        sessionId: 'keys',
        title: 'Keyboard thread',
        updated: Date.now(),
      };
      localStorage.setItem('sail-agent-threads', JSON.stringify([thread]));
      localStorage.setItem(
        'sai-pane-layouts',
        JSON.stringify({ [path]: { id: 'main', agent: 'claude', thread } }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Keyboard thread'));
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    if (repository) rmSync(repository, { recursive: true, force: true });
  });

  it('keeps the top bar palette button keyboard-ready and opens the palette', async () => {
    expect(await keyboardReadiness('.topbar-palette')).toEqual(ready);
    await activateFocused();
    await expect($('.command-palette[open]')).toBeDisplayed();
    await expect($('[aria-label="Search command palette"]')).toBeFocused();
    await browser.keys('Escape');
    await expect($('.command-palette[open]')).not.toExist();
  });

  it('keeps the sidebar thread menu button keyboard-ready and opens the menu', async () => {
    expect(
      await keyboardReadiness('.project-agent-menu[aria-label="Manage thread Keyboard thread"]'),
    ).toEqual(ready);
    await activateFocused();
    await expect($('.project-menu[role="menu"]')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => !!document.activeElement?.closest('.project-menu')),
    );
    await browser.keys('Escape');
    await expect($('.project-menu')).not.toExist();
  });

  it('opens the shortcut sheet with Cmd+/ and keeps its close button keyboard-ready', async () => {
    await browser.execute(() =>
      window.dispatchEvent(
        new KeyboardEvent('keydown', { key: '/', metaKey: true, bubbles: true, cancelable: true }),
      ),
    );
    await expect($('.shortcuts-dialog[open]')).toBeDisplayed();
    await browser.waitUntil(() =>
      browser.execute(() => !!document.activeElement?.closest('.shortcuts-dialog')),
    );
    const close = '.shortcuts-dialog [aria-label="Close keyboard shortcuts"]';
    expect(await keyboardReadiness(close)).toEqual(ready);
    await activateFocused();
    await expect($('.shortcuts-dialog[open]')).not.toExist();
  });
});
