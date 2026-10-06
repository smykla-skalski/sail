import { browser, expect } from '@wdio/globals';

type ScaleWindow = Window & {
  sailTaskOverviewBurst?: () => void;
  sailTaskOverviewReleaseRefresh?: () => void;
};

describe('task overview at scale', () => {
  it('keeps search, sorting, navigation, and activity batches responsive', async () => {
    await browser.execute(() => {
      document.body.dataset.fixtureReload = 'pending';
      history.replaceState(null, '', '?task-overview-scale-fixture');
    });
    await browser.refresh();
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document.body.dataset.fixtureReload !== 'pending' &&
          document.querySelectorAll('.task-card').length === 100 &&
          document.querySelector('.task-card-grid')?.getAttribute('aria-busy') === 'true',
      ),
    );
    await expect($('[aria-label="Scale fixture state"]')).toHaveText('500 threads · 0 updates');

    const loadingInteraction = await browser.executeAsync(
      (done: (result: { duration: number; busy: string | null }) => void) => {
        const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
        const start = performance.now();
        input.value = 'Task 99';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const check = () => {
          if (document.querySelectorAll('.task-card').length === 1)
            done({
              duration: performance.now() - start,
              busy: document.querySelector('.task-card-grid')?.getAttribute('aria-busy') ?? null,
            });
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      },
    );
    expect(loadingInteraction.duration).toBeLessThan(100);
    expect(loadingInteraction.busy).toBe('true');
    await expect($$('.task-card')).toBeElementsArrayOfSize(1);
    await browser.execute(() => (window as ScaleWindow).sailTaskOverviewReleaseRefresh?.());
    await browser.waitUntil(() =>
      browser.execute(
        () => document.querySelector('.task-card-grid')?.getAttribute('aria-busy') === 'false',
      ),
    );

    const searchMs = await browser.executeAsync((done: (duration: number) => void) => {
      const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
      const start = performance.now();
      input.value = 'Task 99';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const check = () => {
        if (document.querySelectorAll('.task-card').length === 1) done(performance.now() - start);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    expect(searchMs).toBeLessThan(100);

    const sortMs = await browser.executeAsync((done: (duration: number) => void) => {
      const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
      const select = document.querySelector<HTMLSelectElement>('.task-overview-sort select')!;
      const start = performance.now();
      select.value = 'repository';
      select.dispatchEvent(new Event('change', { bubbles: true }));
      const check = () => {
        const first = document.querySelector<HTMLElement>('.task-card')?.dataset.taskCardId;
        if (first === '/fixture/repo-0') done(performance.now() - start);
        else requestAnimationFrame(check);
      };
      requestAnimationFrame(check);
    });
    expect(sortMs).toBeLessThan(100);

    const keyboard = await browser.execute(() => {
      const buttons = [
        ...document.querySelectorAll<HTMLButtonElement>('[data-overview-control="main"]'),
      ];
      buttons[0].focus();
      const start = performance.now();
      buttons[0].dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
      return {
        duration: performance.now() - start,
        focused: document.activeElement === buttons[1],
      };
    });
    expect(keyboard.focused).toBe(true);
    expect(keyboard.duration).toBeLessThan(100);

    const preserved = await browser.executeAsync(
      (
        done: (result: {
          duration: number;
          expected: string;
          focused: string;
          before: number;
          after: number;
        }) => void,
      ) => {
        const root = document.querySelector<HTMLElement>('.task-overview')!;
        const select = document.querySelector<HTMLSelectElement>('.task-overview-sort select')!;
        select.value = 'recent';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        requestAnimationFrame(() => {
          root.scrollTop = 1200;
          requestAnimationFrame(() => {
            const bounds = root.getBoundingClientRect();
            const card = [...document.querySelectorAll<HTMLElement>('.task-card')].find((item) => {
              const rect = item.getBoundingClientRect();
              return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
            })!;
            card.querySelector<HTMLButtonElement>('[data-overview-control="main"]')!.focus();
            const expected = card.dataset.taskCardId!;
            const before = root.scrollTop;
            const start = performance.now();
            (window as ScaleWindow).sailTaskOverviewBurst?.();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                const active = document.activeElement?.closest<HTMLElement>('[data-task-card-id]');
                done({
                  duration: performance.now() - start,
                  expected,
                  focused: active?.dataset.taskCardId ?? '',
                  before,
                  after: root.scrollTop,
                });
              }),
            );
          });
        });
      },
    );
    expect(preserved.duration).toBeLessThan(100);
    expect(preserved.focused).toBe(preserved.expected);
    expect(preserved.after).toBe(preserved.before);
    await expect($('[aria-label="Scale fixture state"]')).toHaveText('500 threads · 50 updates');

    const batch = await browser.executeAsync(
      (done: (result: { duration: number; query: string }) => void) => {
        const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
        input.focus();
        const start = performance.now();
        (window as ScaleWindow).sailTaskOverviewBurst?.();
        input.value = 'Burst';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        requestAnimationFrame(() =>
          done({
            duration: performance.now() - start,
            query: input.value,
          }),
        );
      },
    );
    expect(batch.duration).toBeLessThan(100);
    expect(batch.query).toBe('Burst');
    await expect($$('.task-card')).toBeElementsArrayOfSize(50);
    await expect($('[aria-label="Scale fixture state"]')).toHaveText('500 threads · 100 updates');
    expect(await $$('.task-card-unavailable').length).toBeGreaterThan(0);

    await browser.execute(() => history.replaceState(null, '', location.pathname));
    await browser.refresh();
    await $('.app-shell').waitForDisplayed();
  });
});
