import { browser, expect } from '@wdio/globals';

type Calls = {
  list: number;
  listTimes: number[];
  summaries: Record<string, number>;
  histories: Record<string, number>;
};

async function calls(): Promise<Calls> {
  return browser.execute(() =>
    JSON.parse(JSON.stringify(Reflect.get(window, 'openCodeSubagentCalls'))),
  );
}

describe('OpenCode subagents', () => {
  it('polls each child session once per interval with two views open', async () => {
    await browser.execute(() => history.replaceState(null, '', '?opencode-subagents-fixture'));
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.subagents .subagent').length)) ===
        4,
      { timeout: 15_000, timeoutMsg: 'both OpenCode views did not render two children' },
    );

    await browser.execute(() => {
      for (const toggle of document.querySelectorAll<HTMLButtonElement>('.subagent-toggle'))
        if (toggle.textContent?.includes('Child child-a')) toggle.click();
    });
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            [...document.querySelectorAll('.subagent-history')].filter((history) =>
              history.textContent?.includes('Output of child-a'),
            ).length,
        )) === 2,
      { timeout: 10_000, timeoutMsg: 'both views did not show the expanded child history' },
    );

    const before = await calls();
    await browser.waitUntil(async () => (await calls()).list >= before.list + 2, {
      timeout: 20_000,
      interval: 250,
      timeoutMsg: 'the shared poll did not run twice',
    });
    const after = await calls();
    const gaps = after.listTimes.slice(1).map((time, index) => time - after.listTimes[index]);
    console.info('[opencode-subagents] poll gaps', gaps, before, after);

    expect(Math.min(...gaps)).toBeGreaterThanOrEqual(2_500);
    for (const id of ['child-a', 'child-b']) expect(after.summaries[id]).toBe(after.list);
    expect(after.histories['child-a'] - before.histories['child-a']).toBe(after.list - before.list);
  });
});
