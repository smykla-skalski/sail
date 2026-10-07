import { browser, expect } from '@wdio/globals';
import { join } from 'node:path';

async function capture(name: string) {
  const output = process.env.SAIL_VISUAL_AUDIT_DIR;
  if (output) await browser.saveScreenshot(join(output, `${name}.png`));
}

async function selectAndExpect(label: string, expected: string) {
  await browser.execute((accessibleName) => {
    document
      .querySelector<HTMLButtonElement>(`#active-panel button[aria-label="${accessibleName}"]`)!
      .click();
  }, label);
  await browser.waitUntil(async () =>
    browser.execute(
      (value) =>
        document.querySelector<HTMLOutputElement>('[aria-label="Opened activity"]')!.value ===
        value,
      expected,
    ),
  );
}

describe('workspace activity panel', () => {
  it('fills Cmd-L details and combines live and durable activity without duplicates', async () => {
    await browser.execute(() => history.replaceState(null, '', '?workspace-activity-fixture'));
    await browser.setWindowSize(1200, 700);
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll('#active-panel aside li').length,
        )) === 14,
      { timeout: 15_000, timeoutMsg: 'activity panel did not render combined activity' },
    );

    const desktop = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('#active-panel aside')!;
      const bounds = panel.getBoundingClientRect();
      const body = document.querySelector<HTMLElement>('.fixture-body')!.getBoundingClientRect();
      const status = document
        .querySelector<HTMLElement>('[aria-label="Fixture agent status"]')!
        .getBoundingClientRect();
      const sections = [...panel.querySelectorAll('section')].map((section) => ({
        label: section.querySelector('h3')?.textContent?.replace(/\s+/g, ' ').trim(),
        items: section.querySelectorAll('li').length,
      }));
      return {
        sections,
        top: bounds.top,
        bodyTop: body.top,
        bottom: bounds.bottom,
        statusTop: status.top,
        scrollable:
          panel.querySelector<HTMLElement>('.activity-sections')!.scrollHeight >
          panel.querySelector<HTMLElement>('.activity-sections')!.clientHeight,
        duplicateChildren: panel.querySelectorAll(
          '[data-workspace-activity-id="child:child-9"], [data-activity-id="duplicate-child"]',
        ).length,
        detachedToggle: !!document.querySelector('.activity-toggle, .activity-backdrop'),
      };
    });
    expect(desktop.sections).toEqual([
      { label: 'Now10', items: 10 },
      { label: 'Needs input2', items: 2 },
      { label: 'Recent1', items: 1 },
      { label: 'Earlier1', items: 1 },
    ]);
    expect(desktop.top).toBe(desktop.bodyTop);
    expect(desktop.bottom).toBe(desktop.statusTop);
    expect(desktop.scrollable).toBe(true);
    expect(desktop.duplicateChildren).toBe(1);
    expect(desktop.detachedToggle).toBe(false);
    await capture('workspace-activity-details-desktop');

    await selectAndExpect('Open Recent tool 1: Read configuration', 'tool:read');
    await selectAndExpect(
      'Open Needs input decision 1: Allow test command?',
      'decision:permission',
    );
    await selectAndExpect('Open Needs input check 2: npm test', 'check:check');
    await selectAndExpect('Open parent activity: Earlier parent task', 'parent:parent');

    await browser.execute(() => {
      document.querySelector<HTMLButtonElement>('[aria-label="Fail activity selection"]')!.click();
      document
        .querySelector<HTMLButtonElement>(
          '#active-panel button[aria-label="Open Recent tool 1: Read configuration"]',
        )!
        .click();
    });
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document.querySelector('#active-panel [role="alert"]')?.textContent ===
          'Target unavailable',
      ),
    );

    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Clear activity"]')!.click(),
    );
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          !!document.querySelector('#active-panel aside') &&
          document.querySelectorAll('#active-panel [data-workspace-activity-id]').length === 0 &&
          document.querySelectorAll('#active-panel [data-activity-id]').length === 2,
      ),
    );
    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Restore activity"]')!.click(),
    );

    await browser.setWindowSize(320, 500);
    const compact = await browser.execute(() => {
      const panel = document
        .querySelector<HTMLElement>('#active-panel aside')!
        .getBoundingClientRect();
      const body = document.querySelector<HTMLElement>('.fixture-body')!.getBoundingClientRect();
      const status = document
        .querySelector<HTMLElement>('[aria-label="Fixture agent status"]')!
        .getBoundingClientRect();
      return {
        left: panel.left,
        right: panel.right,
        bottom: panel.bottom,
        bodyBottom: body.bottom,
        statusTop: status.top,
      };
    });
    expect(compact.left).toBe(0);
    expect(compact.right).toBe(320);
    expect(compact.bottom).toBe(compact.bodyBottom);
    expect(compact.bottom).toBe(compact.statusTop);
    await capture('workspace-activity-details-compact');

    await selectAndExpect('Open Now child 1: Child task 9', 'child:child-9');
    await expect($('#active-panel aside')).toBeDisplayed();
  });
});
