import { browser, expect } from '@wdio/globals';
import { join } from 'node:path';

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (output) await browser.saveScreenshot(join(output, `${name}.png`));
}

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
  it('lists running and finished children apart, opens a child and feeds activity', async () => {
    await browser.execute(() =>
      history.replaceState(null, '', '?opencode-subagents-fixture&mixed'),
    );
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await browser.execute(() => document.querySelectorAll('.subagents .subagent').length)) ===
        3,
      { timeout: 15_000, timeoutMsg: 'the mixed fixture did not render three children' },
    );

    const view = await browser.execute(() => {
      const groups = [...document.querySelectorAll<HTMLElement>('.subagent-group')].map(
        (group) => ({
          label: group.getAttribute('aria-label'),
          heading: group.querySelector('.subagent-group-heading')?.textContent?.trim(),
          children: [...group.querySelectorAll<HTMLElement>('.subagent')].map((child) => ({
            title: child.querySelector('strong')?.textContent?.trim(),
            status: child.querySelector('.activity-status')?.getAttribute('aria-label'),
            activity: child.querySelector('.subagent-activity')?.textContent?.trim(),
          })),
        }),
      );
      return { groups, text: document.querySelector('.subagents')!.textContent };
    });
    expect(view.groups).toEqual([
      {
        label: 'Running subagents',
        heading: 'Running · 1',
        children: [{ title: 'Child child-a', status: 'Working', activity: 'Output of child-a' }],
      },
      {
        label: 'Finished subagents',
        heading: 'Finished · 2',
        children: [
          { title: 'Child child-c', status: 'Finished', activity: 'Output of child-c' },
          { title: 'Child child-d', status: 'Failed', activity: 'Output of child-d' },
        ],
      },
    ]);
    expect(view.text).not.toContain('Queued');
    await capture('desktop-opencode-subagents');

    const feed = await browser.execute(() =>
      [...document.querySelectorAll<HTMLElement>('[data-workspace-activity-id]')].map((item) => ({
        id: item.dataset.workspaceActivityId,
        text: item.innerText.replaceAll('\n', ' '),
      })),
    );
    expect(feed.map((item) => item.id).toSorted()).toEqual([
      'child:opencode-child:child-a',
      'child:opencode-child:child-c',
      'child:opencode-child:child-d',
    ]);

    await browser.execute(() => {
      document
        .querySelector<HTMLButtonElement>(
          'button[aria-label="Open OpenCode subagent thread for Child child-c"]',
        )!
        .click();
    });
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () =>
            document.querySelector<HTMLOutputElement>('output[aria-label="Opened thread"]')!.value,
        )) === '/repo|acp:opencode:child-c',
      { timeout: 5_000, timeoutMsg: 'Open did not open the child session' },
    );
  });
});
