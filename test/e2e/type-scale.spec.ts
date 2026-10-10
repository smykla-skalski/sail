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
  'Sail keeps long agent output across the whole chat pane, so wide windows show more of each ' +
  'answer instead of a narrow column surrounded by empty space. Only a small fixed gutter ' +
  'separates the text from the pane edges. This paragraph is long enough to wrap several ' +
  'times even on a 2560 px window, so each rendered line shows how much of the width it uses. ' +
  'The same rule applies to the main conversation, the agent workspace transcript and the ' +
  'OpenCode pane transcript, which all share one gutter token.';

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (!output) return;
  mkdirSync(output, { recursive: true });
  await browser.saveScreenshot(join(output, `${name}.png`));
}

type Span = { chars: number; gutters: number[]; rightGap: number; contentWidth: number };

/**
 * Returns, for each matching element, its longest rendered line in characters,
 * its transcript container's horizontal padding, and the gap between the
 * element's right edge and the container's content box.
 */
function textSpans(selector: string) {
  return browser.execute((target) => {
    const range = document.createRange();
    return [...document.querySelectorAll<HTMLElement>(target)].map((element): Span => {
      const container = element.closest<HTMLElement>('.conversation, .agent-conversation');
      if (!container) throw new Error(`No transcript container for ${target}`);
      const style = getComputedStyle(container);
      const left = container.getBoundingClientRect().left + container.clientLeft;
      const contentRight = left + container.clientWidth - Number.parseFloat(style.paddingRight);
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
      return {
        chars: Math.max(0, ...lines.values()),
        gutters: [style.paddingLeft, style.paddingRight].map(Number.parseFloat),
        rightGap: contentRight - element.getBoundingClientRect().right,
        contentWidth: contentRight - left - Number.parseFloat(style.paddingLeft),
      };
    });
  }, selector);
}

/** Asserts that transcript text fills its pane up to the shared 20 px gutter. */
function expectFullWidth(spans: Span[]) {
  expect(spans.length).toBeGreaterThan(0);
  for (const span of spans) {
    expect(span.gutters).toEqual([20, 20]);
    expect(Math.abs(span.rightGap)).toBeLessThanOrEqual(1);
  }
  const widest = spans.reduce((best, span) => (span.chars > best.chars ? span : best));
  // 14 px body text averages about 7 px per character; 10 px leaves room for wrapping.
  expect(widest.chars).toBeGreaterThan(widest.contentWidth / 10);
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

describe('type scale and full-width transcript', () => {
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

  it('fills the main transcript width at 1280 px', async () => {
    await browser.execute((text) => {
      const conversation = document.querySelector('.chat-area .conversation');
      if (!conversation) throw new Error('No main conversation');
      const message = document.createElement('article');
      message.className = 'message measure-probe';
      message.innerHTML = '<div class="avatar"></div><div class="message-body"><p></p></div>';
      message.querySelector('p')!.textContent = text;
      conversation.append(message);
    }, prose);
    const main = await textSpans('.measure-probe .message-body p');
    await browser.execute(() => document.querySelector('.measure-probe')?.remove());
    expectFullWidth(main);
    expect(main[0].chars).toBeGreaterThan(80);
  });

  it('fills the agent transcript width at 1280 px', async () => {
    await $('.agent-launches button').click();
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer [data-pane-prompt]').setValue(prose);
    await $('.agent-actions button:last-of-type').click();
    await expect($('.permission-card')).toBeDisplayed();
    await $('.permission-card .permission-link').click();
    await $('.permission-card .permission-actions button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Done: Sail keeps'));
    const spans = await textSpans('.agent-conversation .message-body :is(p, .markdown)');
    expect(spans.length).toBeGreaterThan(1);
    expectFullWidth(spans);
    expect(Math.max(...spans.map((span) => span.chars))).toBeGreaterThan(80);
    await capture('desktop-type-scale-light');
  });

  it('gives Markdown headings in the transcript a size scale', async () => {
    await browser.execute(() => {
      const composer = document.querySelector<HTMLElement>('.agent-composer [data-pane-prompt]');
      if (!composer) throw new Error('No composer');
      composer.textContent = '# Heading one\n## Heading two\n### Heading three\n\nBody text';
      composer.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await $('.agent-actions button:last-of-type').click();
    await $('.permission-card .permission-link').click();
    await $('.permission-card .permission-actions button').click();
    await expect($('.agent-conversation .markdown h1')).toBeDisplayed();
    const sizes = await browser.execute(() =>
      ['h1', 'h2', 'h3', 'p'].map(
        (tag) =>
          getComputedStyle(
            [...document.querySelectorAll(`.agent-conversation .markdown ${tag}`)].at(-1)!,
          ).fontSize,
      ),
    );
    expect(sizes).toEqual(['20px', '16px', '14px', '14px']);
  });

  for (const theme of ['light', 'dark'] as const)
    for (const [width, height] of [
      [1920, 1200],
      [2560, 1440],
    ] as const)
      it(`fills the agent transcript width in ${theme} at ${width} px`, async () => {
        await browser.setWindowSize(width, height);
        await browser.execute((value) => {
          document.documentElement.dataset.suiTheme = value;
        }, theme);
        await browser.pause(300);
        expect(await browser.execute(() => innerWidth)).toBe(width);
        expectFullWidth(await textSpans('.agent-conversation .message-body :is(p, .markdown)'));
        await capture(`${width}x${height}-chat-width-${theme}`);
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
