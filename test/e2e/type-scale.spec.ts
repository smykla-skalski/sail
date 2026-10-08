import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

type AxeResult = { violations: { id: string; nodes: { target: unknown[] }[] }[] };

declare global {
  interface Window {
    axe: {
      run: (
        context: Document,
        options: { runOnly: { type: 'rule'; values: string[] } },
      ) => Promise<AxeResult>;
    };
  }
}

const axeSource = readFileSync(resolve('node_modules/axe-core/axe.min.js'), 'utf8');
const prose =
  'Sail keeps long agent output readable by holding transcript text to a comfortable reading ' +
  'column. Wide windows used to stretch every line across the pane, so eyes had to travel far ' +
  'from the end of one line to the start of the next. This paragraph is long enough to wrap ' +
  'several times and measure how many characters each rendered line holds.';

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

/** Returns the longest rendered line, in characters, of each matching element. */
function longestLines(selector: string) {
  return browser.execute((target) => {
    const range = document.createRange();
    return [...document.querySelectorAll<HTMLElement>(target)].map((element) => {
      const lines = new Map<number, number>();
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      for (let text = walker.nextNode(); text; text = walker.nextNode()) {
        if (!(text instanceof Text)) continue;
        for (let index = 0; index < text.length; index += 1) {
          range.setStart(text, index);
          range.setEnd(text, index + 1);
          const rect = range.getBoundingClientRect();
          if (!rect.width && !rect.height) continue;
          const line = Math.round(rect.top + rect.height / 2);
          lines.set(line, (lines.get(line) ?? 0) + 1);
        }
      }
      return Math.max(0, ...lines.values());
    });
  }, selector);
}

/** Lists visible text rendered below 12 px, plus horizontal document overflow. */
function smallTextAndOverflow() {
  return browser.execute(() => {
    const small = new Set<string>();
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const element = node.parentElement;
      if (!element || !node.textContent?.trim()) continue;
      const style = getComputedStyle(element);
      const size = Number.parseFloat(style.fontSize);
      if (size === 0 || size >= 12 || !element.getClientRects().length) continue;
      if (style.visibility === 'hidden' || element.closest('[hidden], [aria-hidden="true"]'))
        continue;
      small.add(`${element.tagName.toLowerCase()}.${element.className} ${size}px`);
    }
    return {
      small: [...small],
      overflow: document.documentElement.scrollWidth - innerWidth,
    };
  });
}

async function contrastViolations() {
  await browser.execute(axeSource);
  return browser.executeAsync(async (done: (violations: string[]) => void) => {
    const result = await window.axe.run(document, {
      runOnly: { type: 'rule', values: ['color-contrast'] },
    });
    done(
      result.violations.flatMap((violation) =>
        violation.nodes.map((node) => node.target.join(' ')),
      ),
    );
  });
}

describe('type scale and reading column', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-type-scale-'));

  before(async () => {
    execFileSync('git', ['init', '-q', repository]);
    await browser.setWindowSize(1280, 850);
    await browser.execute((path) => {
      localStorage.clear();
      localStorage.setItem('sai-theme', 'light');
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [] }),
      );
    }, realpathSync(repository));
    await browser.refresh();
    await expect($('.chat-area .conversation')).toBeDisplayed();
  });

  after(async () => {
    await browser.setWindowSize(1280, 850);
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('keeps main transcript lines at 80 characters or fewer at 1280 px', async () => {
    await browser.execute((text) => {
      const conversation = document.querySelector('.chat-area .conversation');
      if (!conversation) throw new Error('No main conversation');
      const message = document.createElement('article');
      message.className = 'message measure-probe';
      message.innerHTML = '<div class="avatar"></div><div class="message-body"><p></p></div>';
      message.querySelector('p')!.textContent = text;
      conversation.append(message);
    }, prose);
    const [main] = await longestLines('.measure-probe .message-body p');
    await browser.execute(() => document.querySelector('.measure-probe')?.remove());
    expect(main).toBeGreaterThan(55);
    expect(main).toBeLessThanOrEqual(80);
  });

  it('keeps agent transcript lines at 80 characters or fewer at 1280 px', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').setValue(prose);
    await $('.agent-actions button:last-of-type').click();
    await expect($('.permission-card')).toBeDisplayed();
    await $('.permission-card .permission-link').click();
    await $('.permission-card .permission-actions button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Done: Sail keeps'));
    const lines = await longestLines('.agent-conversation .message-body :is(p, .markdown)');
    expect(lines.length).toBeGreaterThan(1);
    for (const line of lines) expect(line).toBeLessThanOrEqual(80);
    expect(Math.max(...lines)).toBeGreaterThan(55);
    await capture('desktop-type-scale-light');
  });

  for (const theme of ['light', 'dark'] as const)
    for (const [width, height] of [
      [1280, 850],
      [390, 600],
    ] as const)
      it(`has no small text, overflow or contrast failures in ${theme} at ${width} px`, async () => {
        await browser.setWindowSize(width, height);
        await browser.execute((value) => {
          document.documentElement.dataset.suiTheme = value;
        }, theme);
        await browser.pause(300);
        const audit = await smallTextAndOverflow();
        expect(audit.small).toEqual([]);
        expect(audit.overflow).toBeLessThanOrEqual(0);
        expect(await contrastViolations()).toEqual([]);
        await capture(`${width}x${height}-type-scale-${theme}`);
      });
});
