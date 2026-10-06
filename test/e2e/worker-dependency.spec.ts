import { browser, expect } from '@wdio/globals';

describe('worker dependency map', () => {
  it('shows authoritative blockers and equivalent keyboard navigation', async () => {
    await browser.execute(() => {
      document.body.dataset.fixtureReload = 'pending';
      history.replaceState(null, '', '?worker-dependency-fixture');
    });
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            location.search === '?worker-dependency-fixture' &&
            document.body.dataset.fixtureReload !== 'pending' &&
            document.querySelectorAll('.map-node').length === 5 &&
            document.querySelectorAll('.map-column').length === 2,
        )) === true,
    );

    const state = await browser.execute(() => ({
      levels: document.querySelectorAll('.map-column').length,
      errors: document.querySelector('[role="alert"]')?.textContent,
      dependent: document.querySelector('[data-node-id="owner/repo#2"]')?.textContent,
      independentMap: !!document.querySelector('#independent .dependency-map'),
    }));
    expect(state.levels).toBe(2);
    expect(state.errors).toContain('Missing dependency target: missing-target');
    expect(state.errors).toContain('Repository unavailable');
    expect(state.dependent).toContain('Failed');
    expect(state.dependent).toContain('#1 Issue 1');
    expect(state.independentMap).toBe(false);

    await browser.execute(() =>
      document
        .querySelector<HTMLButtonElement>('[data-node-id="owner/repo#2"] .node-select')!
        .click(),
    );
    expect(await $('[aria-label="Selected dependency"]')).toHaveText('owner/repo#2');
    await browser.execute(() =>
      document
        .querySelector<HTMLButtonElement>('[data-node-id="owner/repo#2"] .node-actions button')!
        .click(),
    );
    expect(await $('[aria-label="Opened worker"]')).toHaveText(
      '/workspace/issue-2:opencode:session-2',
    );

    const keyboardState = await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '.view-switch button[aria-pressed="false"]',
      )!;
      button.focus();
      return {
        focused: document.activeElement === button,
        tag: button.tagName,
        label: button.textContent,
      };
    });
    expect(keyboardState).toEqual({ focused: true, tag: 'BUTTON', label: 'Table' });
    await $('.view-switch button[aria-pressed="false"]').click();
    await expect($('table')).toBeDisplayed();
    expect(await $('table').getText()).toContain('Worker dependencies');
  });
});
