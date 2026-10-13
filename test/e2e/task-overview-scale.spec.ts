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
      (
        done: (result: {
          duration: number;
          busy: string | null;
          timedOut: boolean;
          count: number;
          ids: (string | undefined)[];
          query: string;
          fixture: string | null;
          url: string;
          visibility: DocumentVisibilityState;
          hasFocus: boolean;
        }) => void,
      ) => {
        const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
        const grid = document.querySelector('.task-card-grid')!;
        const start = performance.now();
        let finished = false;
        const snapshot = (timedOut: boolean) => ({
          duration: performance.now() - start,
          busy: document.querySelector('.task-card-grid')?.getAttribute('aria-busy') ?? null,
          timedOut,
          count: document.querySelectorAll('.task-card').length,
          ids: [...document.querySelectorAll<HTMLElement>('.task-card')].map(
            (card) => card.dataset.taskCardId,
          ),
          query: input.value,
          fixture:
            document.querySelector('[aria-label="Scale fixture state"]')?.textContent ?? null,
          url: location.href,
          visibility: document.visibilityState,
          hasFocus: document.hasFocus(),
        });
        const timer = setTimeout(() => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          done(snapshot(true));
        }, 5000);
        const check = () => {
          if (finished) return;
          if (grid.querySelectorAll('.task-card').length === 1) {
            finished = true;
            clearTimeout(timer);
            observer.disconnect();
            done(snapshot(false));
          }
        };
        const observer = new MutationObserver(check);
        observer.observe(grid, { childList: true, subtree: true });
        input.value = 'Task 99';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        check();
      },
    );
    expect(loadingInteraction).toMatchObject({ timedOut: false, count: 1 });
    expect(loadingInteraction.duration).toBeLessThan(100);
    expect(loadingInteraction.busy).toBe('true');
    await expect($$('.task-card')).toBeElementsArrayOfSize(1);
    await browser.execute(() => (window as ScaleWindow).sailTaskOverviewReleaseRefresh?.());
    await browser.waitUntil(() =>
      browser.execute(
        () => document.querySelector('.task-card-grid')?.getAttribute('aria-busy') === 'false',
      ),
    );

    await browser.execute(() => {
      const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
      input.value = '';
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await expect($$('.task-card')).toBeElementsArrayOfSize(100);
    const search = await browser.executeAsync(
      (done: (result: { duration: number; count: number; timedOut: boolean }) => void) => {
        const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
        const grid = document.querySelector('.task-card-grid')!;
        const start = performance.now();
        let finished = false;
        const finish = (timedOut: boolean) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          done({
            duration: performance.now() - start,
            count: grid.querySelectorAll('.task-card').length,
            timedOut,
          });
        };
        const observer = new MutationObserver(() => {
          if (grid.querySelectorAll('.task-card').length === 1) finish(false);
        });
        observer.observe(grid, { childList: true, subtree: true });
        const timer = setTimeout(() => finish(true), 5000);
        input.value = 'Task 99';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        if (grid.querySelectorAll('.task-card').length === 1) finish(false);
      },
    );
    expect(search).toMatchObject({ count: 1, timedOut: false });
    expect(search.duration).toBeLessThan(100);

    const sorting = await browser.executeAsync(
      (
        done: (result: { duration: number; first: string | undefined; timedOut: boolean }) => void,
      ) => {
        const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
        const grid = document.querySelector('.task-card-grid')!;
        input.value = '';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        const select = document.querySelector<HTMLSelectElement>('.task-overview-sort select')!;
        const start = performance.now();
        let finished = false;
        const first = () => grid.querySelector<HTMLElement>('.task-card')?.dataset.taskCardId;
        const finish = (timedOut: boolean) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          done({ duration: performance.now() - start, first: first(), timedOut });
        };
        const observer = new MutationObserver(() => {
          if (first() === '/fixture/repo-0') finish(false);
        });
        observer.observe(grid, { childList: true, subtree: true });
        const timer = setTimeout(() => finish(true), 5000);
        select.value = 'repository';
        select.dispatchEvent(new Event('change', { bubbles: true }));
        if (first() === '/fixture/repo-0') finish(false);
      },
    );
    expect(sorting).toMatchObject({ first: '/fixture/repo-0', timedOut: false });
    expect(sorting.duration).toBeLessThan(100);

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

    const recentSettled = await browser.executeAsync((done: (settled: boolean) => void) => {
      const grid = document.querySelector('.task-card-grid')!;
      const first = grid.querySelector<HTMLElement>('.task-card')?.dataset.taskCardId;
      const select = document.querySelector<HTMLSelectElement>('.task-overview-sort select')!;
      const observer = new MutationObserver(() => {
        if (grid.querySelector<HTMLElement>('.task-card')?.dataset.taskCardId !== first) {
          clearTimeout(timer);
          observer.disconnect();
          done(true);
        }
      });
      observer.observe(grid, { childList: true, subtree: true });
      const timer = setTimeout(() => {
        observer.disconnect();
        done(false);
      }, 5000);
      select.value = 'recent';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(recentSettled).toBe(true);

    const preserved = await browser.executeAsync(
      (
        done: (result: {
          duration: number;
          expected: string;
          focused: string;
          before: number;
          after: number;
          timedOut: boolean;
        }) => void,
      ) => {
        const root = document.querySelector<HTMLElement>('.task-overview')!;
        root.scrollTop = 1200;
        const bounds = root.getBoundingClientRect();
        const card = [...document.querySelectorAll<HTMLElement>('.task-card')].find((item) => {
          const rect = item.getBoundingClientRect();
          return rect.top >= bounds.top && rect.bottom <= bounds.bottom;
        })!;
        card.querySelector<HTMLButtonElement>('[data-overview-control="main"]')!.focus();
        const expected = card.dataset.taskCardId!;
        const before = root.scrollTop;
        const output = document.querySelector('[aria-label="Scale fixture state"]')!;
        const start = performance.now();
        let finished = false;
        const finish = (timedOut: boolean) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          const active = document.activeElement?.closest<HTMLElement>('[data-task-card-id]');
          done({
            duration: performance.now() - start,
            expected,
            focused: active?.dataset.taskCardId ?? '',
            before,
            after: root.scrollTop,
            timedOut,
          });
        };
        const observer = new MutationObserver(() => {
          if (output.textContent?.includes('50 updates')) queueMicrotask(() => finish(false));
        });
        observer.observe(output, { childList: true, characterData: true, subtree: true });
        const timer = setTimeout(() => finish(true), 5000);
        (window as ScaleWindow).sailTaskOverviewBurst?.();
      },
    );
    expect(preserved.timedOut).toBe(false);
    expect(preserved.duration).toBeLessThan(100);
    expect(preserved.focused).toBe(preserved.expected);
    expect(preserved.after).toBe(preserved.before);
    await expect($('[aria-label="Scale fixture state"]')).toHaveText('500 threads · 50 updates');

    const batch = await browser.executeAsync(
      (
        done: (result: {
          duration: number;
          query: string;
          count: number;
          timedOut: boolean;
        }) => void,
      ) => {
        const input = document.querySelector<HTMLInputElement>('.task-overview-search input')!;
        const grid = document.querySelector('.task-card-grid')!;
        const output = document.querySelector('[aria-label="Scale fixture state"]')!;
        input.focus();
        const start = performance.now();
        let finished = false;
        const finish = (timedOut: boolean) => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(timer);
          done({
            duration: performance.now() - start,
            query: input.value,
            count: grid.querySelectorAll('.task-card').length,
            timedOut,
          });
        };
        const observer = new MutationObserver(() => {
          if (
            output.textContent?.includes('100 updates') &&
            grid.querySelectorAll('.task-card').length === 50
          )
            finish(false);
        });
        observer.observe(output, { childList: true, characterData: true, subtree: true });
        observer.observe(grid, { childList: true, subtree: true });
        const timer = setTimeout(() => finish(true), 5000);
        (window as ScaleWindow).sailTaskOverviewBurst?.();
        input.value = 'Burst';
        input.dispatchEvent(new Event('input', { bubbles: true }));
      },
    );
    expect(batch).toMatchObject({ count: 50, timedOut: false });
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
