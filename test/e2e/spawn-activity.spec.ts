import { browser, expect } from '@wdio/globals';
import { join } from 'node:path';

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (output) await browser.saveScreenshot(join(output, `${name}.png`));
}

describe('live subagent activity', () => {
  it('inspects bounded output without disturbing the parent composer', async () => {
    const started = Date.now();
    const checkpoint = (step: string) =>
      console.info(`[spawn-activity] ${step} ${Date.now() - started}ms`);

    await browser.execute(() => history.replaceState(null, '', '?spawn-activity-fixture'));
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.spawn-active').length)) === 2,
      { timeout: 15_000, timeoutMsg: 'spawn activity fixture did not render two cards' },
    );
    checkpoint('fixture loaded');

    const initial = await browser.execute(() => {
      const cards = [...document.querySelectorAll<HTMLElement>('.spawn-active')];
      return {
        count: cards.length,
        first: cards[0]?.innerText,
        second: cards[1]?.innerText,
        datetime: cards[1]?.querySelector('time')?.getAttribute('datetime'),
        toggleLabel: document.querySelector('.spawn-toggle')?.getAttribute('aria-label'),
        openLabel: document.querySelector('.spawn-open')?.getAttribute('aria-label'),
      };
    });
    expect(initial.count).toBe(2);
    expect(initial.first).toContain('Codex subagent');
    expect(initial.first).toContain('Inspect the exact child task');
    expect(initial.first).toContain('Running browser checks');
    expect(initial.first).toContain('Last signal');
    expect(initial.first).toContain('3 tool uses');
    expect(initial.second).toContain('child has not confirmed a target');
    expect(initial.datetime).toBe('1970-01-01T00:00:00.000Z');
    expect(initial.toggleLabel).toBe('Expand Codex subagent task: Inspect the exact child task');
    expect(initial.openLabel).toBe('Open Codex subagent thread for Inspect the exact child task');
    checkpoint('initial state verified');

    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Parent message"]',
      )!;
      input.focus();
      input.setSelectionRange(7, 12);
      document.querySelector<HTMLButtonElement>('.spawn-toggle')!.click();
    });
    const pointerState = await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Parent message"]',
      )!;
      return {
        expanded: document.querySelector('.spawn-toggle')?.getAttribute('aria-expanded'),
        draft: input.value,
        selection: [input.selectionStart, input.selectionEnd],
      };
    });
    expect(pointerState).toEqual({
      expanded: 'true',
      draft: 'Parent draft stays here',
      selection: [7, 12],
    });
    checkpoint('pointer expansion verified');

    const keyboardState = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('.spawn-toggle')!;
      button.focus();
      const focused = document.activeElement === button;
      button.click();
      button.click();
      const input = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Parent message"]',
      )!;
      return {
        focused,
        expanded: button.getAttribute('aria-expanded'),
        draft: input.value,
        selection: [input.selectionStart, input.selectionEnd],
      };
    });
    expect(keyboardState).toEqual({
      focused: true,
      expanded: 'true',
      draft: 'Parent draft stays here',
      selection: [7, 12],
    });
    checkpoint('keyboard expansion verified');

    const text = await browser.execute(() =>
      document.querySelector<HTMLElement>('.spawn-output')!.innerText.trim(),
    );
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('TAIL')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4_001);
    const liveState = await browser.execute(() => {
      const output = document.querySelector<HTMLElement>('.spawn-output')!;
      output.scrollTop = 80;
      document.querySelector<HTMLButtonElement>('button[aria-label="Update child"]')!.click();
      return {
        expanded: document.querySelector('.spawn-toggle')?.getAttribute('aria-expanded'),
        scrollTop: output.scrollTop,
      };
    });
    expect(liveState).toEqual({ expanded: 'true', scrollTop: 80 });
    checkpoint('bounded live output verified');

    await browser.execute(async () => {
      const button = document.querySelector<HTMLButtonElement>('.spawn-open')!;
      button.click();
      button.click();
      await new Promise((resolve) => setTimeout(resolve, 100));
    });
    const openState = await browser.execute(() => ({
      opened: document.querySelector<HTMLOutputElement>('output[aria-label="Opened thread"]')!
        .value,
      count: document.querySelector<HTMLOutputElement>('output[aria-label="Open count"]')!.value,
      draft: document.querySelector<HTMLTextAreaElement>('textarea[aria-label="Parent message"]')!
        .value,
    }));
    expect(openState).toEqual({
      opened: '/repo/child|acp:codex:exact-child',
      count: '1',
      draft: 'Parent draft stays here',
    });
    checkpoint('exact open verified');

    const response = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>(
        '.spawn-response[data-spawn-id="finished"]',
      )!;
      const result = card.querySelector<HTMLElement>('.spawn-result')!;
      const line = parseFloat(getComputedStyle(result).lineHeight);
      return {
        text: card.innerText,
        label: card.getAttribute('aria-label'),
        lines: Math.round(result.clientHeight / line),
        fullLines: Math.round(result.scrollHeight / line),
        expand: card.querySelector('.spawn-expand')?.textContent?.trim(),
        stats: getComputedStyle(card.querySelector('.spawn-stats')!).fontVariantNumeric,
      };
    });
    expect(response.label).toBe('Explore subagent response');
    expect(response.text).toContain('Explore');
    expect(response.text).toContain('Map the sidebar code');
    expect(response.text).toContain('1m 5s');
    expect(response.text).toContain('7 tool uses');
    expect(response.lines).toBeLessThanOrEqual(3);
    expect(response.fullLines).toBeGreaterThan(3);
    expect(response.expand).toBe('Expand');
    expect(response.stats).toContain('tabular-nums');
    const toggled = await browser.execute(async () => {
      const card = document.querySelector<HTMLElement>(
        '.spawn-response[data-spawn-id="finished"]',
      )!;
      const result = card.querySelector<HTMLElement>('.spawn-result')!;
      const button = card.querySelector<HTMLButtonElement>('.spawn-expand')!;
      const settle = () => new Promise((resolve) => setTimeout(resolve, 50));
      const clamped = result.clientHeight;
      button.click();
      await settle();
      const expanded = { height: result.clientHeight, aria: button.getAttribute('aria-expanded') };
      button.click();
      await settle();
      return {
        clamped,
        expanded,
        label: button.textContent.trim(),
        collapsedHeight: result.clientHeight,
      };
    });
    expect(toggled.expanded.aria).toBe('true');
    expect(toggled.expanded.height).toBeGreaterThan(toggled.clamped);
    expect(toggled.label).toBe('Expand');
    expect(toggled.collapsedHeight).toBe(toggled.clamped);
    await browser.execute(() =>
      document
        .querySelector<HTMLButtonElement>(
          '.spawn-response[data-spawn-id="finished"] .spawn-response-open',
        )!
        .click(),
    );
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector<HTMLOutputElement>('output[aria-label="Response opened"]')!
              .value,
        )) === '/repo/finished|acp:claude:finished-child',
      { timeout: 5_000, timeoutMsg: 'the response Open button did not open the child thread' },
    );
    checkpoint('response card verified');

    const live = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.spawn-active')!;
      return {
        regions: document.querySelectorAll('[aria-live]').length,
        announcer: document.querySelector('.spawn-announcer')!.textContent.trim(),
        statusInCards: document.querySelectorAll(
          '.spawn-active [role="status"], .spawn-active [aria-live]',
        ).length,
        clock: getComputedStyle(card.querySelector('.spawn-clock')!).fontVariantNumeric,
        text: card.querySelector<HTMLElement>('.spawn-signal')!.innerText,
      };
    });
    expect(live.regions).toBe(1);
    expect(live.announcer).toBe('');
    expect(live.statusInCards).toBe(0);
    expect(live.clock).toContain('tabular-nums');
    expect(live.text).toMatch(/\d+s/);
    expect(live.text).toContain('3 tool uses');
    checkpoint('live card timing verified');
    await capture('desktop-subagent-results');

    await browser.setWindowSize(320, 500);
    const bounds = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.spawn-active')!.getBoundingClientRect();
      const open = document.querySelector<HTMLElement>('.spawn-open')!.getBoundingClientRect();
      return { cardRight: card.right, openRight: open.right, viewport: innerWidth };
    });
    expect(bounds.cardRight).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.openRight).toBeLessThanOrEqual(bounds.viewport);
    checkpoint('narrow viewport verified');

    const handoff = await browser.execute(async () => {
      document
        .querySelector<HTMLButtonElement>('button[aria-label="Settle without result"]')!
        .click();
      await new Promise((resolve) => setTimeout(resolve, 50));
      const settled = {
        announcement: document.querySelector('.spawn-announcer')!.textContent.trim(),
        active: document.querySelectorAll('.spawn-active').length,
        responses: document.querySelectorAll('.spawn-response').length,
        missing: document.querySelectorAll('.spawn-response[data-spawn-id="missing"]').length,
        body: document.querySelector('.spawn-response[data-spawn-id="missing"] .spawn-result'),
      };
      document.querySelector<HTMLButtonElement>('button[aria-label="Preserve result"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return {
        withoutResult: {
          announcement: settled.announcement,
          active: settled.active,
          responses: settled.responses,
          missing: settled.missing,
          hasBody: settled.body !== null,
        },
        withResult: {
          active: document.querySelectorAll('.spawn-active').length,
          responses: document.querySelectorAll('.spawn-response').length,
          result: document
            .querySelector<HTMLElement>('.spawn-response[data-spawn-id="missing"] .spawn-result')
            ?.innerText.trim(),
        },
      };
    });
    expect(handoff).toEqual({
      withoutResult: {
        announcement: 'Claude subagent Waiting for a thread: Completed',
        active: 1,
        responses: 2,
        missing: 1,
        hasBody: false,
      },
      withResult: { active: 1, responses: 2, result: 'Preserved result' },
    });
    checkpoint('handoff verified');
  });
});
