import { browser, $, $$, expect } from '@wdio/globals';

describe('live subagent activity', () => {
  it('inspects bounded output without disturbing the parent composer', async () => {
    await browser.execute(() => history.replaceState(null, '', '?spawn-activity-fixture'));
    await browser.refresh();

    await expect($$('.spawn-active')).toBeElementsArrayOfSize(2);
    await expect($('.spawn-active')).toHaveText(expect.stringContaining('Codex subagent'));
    await expect($('.spawn-active')).toHaveText(
      expect.stringContaining('Inspect the exact child task'),
    );
    await expect($('.spawn-active')).toHaveText(expect.stringContaining('Running browser checks'));
    await expect($('.spawn-active')).toHaveText(expect.stringContaining('Last signal'));
    await expect($('.spawn-active:nth-of-type(2)')).toHaveText(
      expect.stringContaining('child has not confirmed a target'),
    );

    const composer = $('textarea[aria-label="Parent message"]');
    await composer.click();
    await browser.execute(() => {
      const input = document.querySelector<HTMLTextAreaElement>(
        'textarea[aria-label="Parent message"]',
      )!;
      input.setSelectionRange(7, 12);
    });
    await $('.spawn-toggle').click();
    await expect($('.spawn-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(await composer.getValue()).toBe('Parent draft stays here');
    expect(
      await browser.execute(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Parent message"]',
        )!;
        return [input.selectionStart, input.selectionEnd];
      }),
    ).toEqual([7, 12]);

    expect(
      await browser.execute(() => {
        const button = document.querySelector<HTMLButtonElement>('.spawn-toggle')!;
        button.focus();
        return document.activeElement === button;
      }),
    ).toBe(true);
    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('.spawn-toggle')!.click(),
    );
    await expect($('.spawn-toggle')).toHaveAttribute('aria-expanded', 'false');
    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('.spawn-toggle')!.click(),
    );
    await expect($('.spawn-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(await composer.getValue()).toBe('Parent draft stays here');
    expect(
      await browser.execute(() => {
        const input = document.querySelector<HTMLTextAreaElement>(
          'textarea[aria-label="Parent message"]',
        )!;
        return [input.selectionStart, input.selectionEnd];
      }),
    ).toEqual([7, 12]);

    const output = $('.spawn-output');
    const text = await output.getText();
    expect(text.startsWith('…')).toBe(true);
    expect(text.endsWith('TAIL')).toBe(true);
    expect(text.length).toBeLessThanOrEqual(4_001);
    await browser.execute(() => {
      document.querySelector<HTMLElement>('.spawn-output')!.scrollTop = 80;
    });
    await $('button[aria-label="Update child"]').click();
    await expect($('.spawn-toggle')).toHaveAttribute('aria-expanded', 'true');
    expect(
      await browser.execute(() => document.querySelector<HTMLElement>('.spawn-output')!.scrollTop),
    ).toBe(80);

    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>('.spawn-open')!;
      button.click();
      button.click();
    });
    await expect($('output[aria-label="Opened thread"]')).toHaveText(
      '/repo/child|acp:codex:exact-child',
    );
    await expect($('output[aria-label="Open count"]')).toHaveText('1');
    expect(await composer.getValue()).toBe('Parent draft stays here');

    await browser.setWindowSize(320, 500);
    const bounds = await browser.execute(() => {
      const card = document.querySelector<HTMLElement>('.spawn-active')!.getBoundingClientRect();
      const open = document.querySelector<HTMLElement>('.spawn-open')!.getBoundingClientRect();
      return { cardRight: card.right, openRight: open.right, viewport: innerWidth };
    });
    expect(bounds.cardRight).toBeLessThanOrEqual(bounds.viewport);
    expect(bounds.openRight).toBeLessThanOrEqual(bounds.viewport);

    await $('button[aria-label="Settle without result"]').click();
    await expect($$('.spawn-active')).toBeElementsArrayOfSize(2);
    await $('button[aria-label="Preserve result"]').click();
    await expect($$('.spawn-active')).toBeElementsArrayOfSize(1);
  });
});
