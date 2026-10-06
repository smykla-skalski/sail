import { browser, expect } from '@wdio/globals';

describe('activity history', () => {
  it('groups durable events, deduplicates updates, and opens the exact source', async () => {
    await browser.execute(() => history.replaceState(null, '', '?activity-history-fixture'));
    await browser.refresh();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelectorAll('aside li').length)) === 2,
    );

    const state = await browser.execute(() => ({
      groups: [...document.querySelectorAll('aside section h3 span')].map(
        (element) => element.textContent,
      ),
      titles: [...document.querySelectorAll<HTMLElement>('.event-copy strong')].map(
        (element) => element.textContent ?? '',
      ),
      outcomes: [...document.querySelectorAll<HTMLElement>('.event-copy small')].map(
        (element) => element.textContent,
      ),
      timestamps: [...document.querySelectorAll('aside time')].map((element) =>
        Number(new Date(element.dateTime)),
      ),
    }));

    expect(state.groups).toEqual(['alpha', 'beta']);
    expect(state.titles[0]).toBe('Run tests');
    expect(state.titles[1].length).toBe(240);
    expect(state.outcomes[0]).toContain('completed');
    expect(state.timestamps).toEqual([30, 20]);

    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('[aria-label^="Open tool activity"]')!.click(),
    );
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document.querySelector<HTMLOutputElement>('[aria-label="Opened activity"]')!.value ===
          '/workspace/alpha:tool-1',
      ),
    );

    await browser.refresh();
    await browser.waitUntil(
      async () => (await browser.execute(() => document.querySelectorAll('aside li').length)) === 2,
    );
  });
});
