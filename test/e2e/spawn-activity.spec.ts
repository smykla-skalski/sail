import { browser, expect } from '@wdio/globals';

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
      await new Promise((resolve) => setTimeout(resolve, 0));
      const withoutResult = document.querySelectorAll('.spawn-active').length;
      document.querySelector<HTMLButtonElement>('button[aria-label="Preserve result"]')!.click();
      await new Promise((resolve) => setTimeout(resolve, 0));
      return { withoutResult, withResult: document.querySelectorAll('.spawn-active').length };
    });
    expect(handoff).toEqual({ withoutResult: 2, withResult: 1 });
    checkpoint('handoff verified');
  });
});
