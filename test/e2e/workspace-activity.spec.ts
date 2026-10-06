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
  it('keeps real activity readable and navigable across desktop and compact layouts', async () => {
    await browser.execute(() => {
      localStorage.removeItem('e2e-workspace-activity-active');
      localStorage.removeItem('e2e-workspace-activity-empty');
      history.replaceState(null, '', '?workspace-activity-fixture');
    });
    await browser.setWindowSize(1200, 700);
    await browser.refresh();
    await browser.waitUntil(
      async () =>
        (await browser.execute(
          () => document.querySelectorAll('#active-panel aside li').length,
        )) === 13,
      { timeout: 15_000, timeoutMsg: 'activity panel did not render all real-state items' },
    );

    const desktop = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('#active-panel aside')!;
      const scroll = panel.querySelector<HTMLElement>('.activity-sections')!;
      const sections = [...panel.querySelectorAll('section')].map((section) => ({
        label: section.querySelector('h2')?.textContent?.replace(/\s+/g, ' ').trim(),
        items: section.querySelectorAll('li').length,
      }));
      const composer = document.querySelector<HTMLElement>('[aria-label="Fixture composer"]')!;
      return {
        sections,
        scrollable: scroll.scrollHeight > scroll.clientHeight,
        composerVisible: composer.getBoundingClientRect().bottom <= innerHeight,
        emptyOpen: !!document.querySelector('#empty-panel aside'),
        emptyExpanded: document
          .querySelector('#empty-panel .activity-toggle')
          ?.getAttribute('aria-expanded'),
      };
    });
    expect(desktop.sections).toEqual([
      { label: 'Now10', items: 10 },
      { label: 'Needs input2', items: 2 },
      { label: 'Recent1', items: 1 },
    ]);
    expect(desktop.scrollable).toBe(true);
    expect(desktop.composerVisible).toBe(true);
    expect(desktop.emptyOpen).toBe(false);
    expect(desktop.emptyExpanded).toBe('false');
    await capture('workspace-activity-desktop');

    await selectAndExpect('Open Recent tool 1: Read configuration', 'tool:read');
    await selectAndExpect(
      'Open Needs input decision 1: Allow test command?',
      'decision:permission',
    );
    await selectAndExpect('Open Needs input check 2: npm test', 'check:check');

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
            'Could not open activity: Target unavailable' &&
          !!document.querySelector('#active-panel aside'),
      ),
    );

    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Clear activity"]')!.click(),
    );
    await browser.waitUntil(async () =>
      browser.execute(() => !document.querySelector('#active-panel aside')),
    );
    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('[aria-label="Restore activity"]')!.click(),
    );
    await browser.waitUntil(async () =>
      browser.execute(() => !!document.querySelector('#active-panel aside')),
    );

    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('#active-panel .activity-close')!.click(),
    );
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          !document.querySelector('#active-panel aside') &&
          document.activeElement === document.querySelector('#active-panel .activity-toggle'),
      ),
    );

    await browser.setWindowSize(320, 500);
    await browser.execute(() => localStorage.removeItem('e2e-workspace-activity-active'));
    await browser.refresh();
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          !document.querySelector('#active-panel aside') &&
          document
            .querySelector('#active-panel .activity-toggle')
            ?.getAttribute('aria-expanded') === 'false',
      ),
    );
    await browser.execute(() =>
      document.querySelector<HTMLButtonElement>('#active-panel .activity-toggle')!.click(),
    );
    await browser.waitUntil(async () =>
      browser.execute(() => !!document.querySelector('#active-panel aside')),
    );
    const compact = await browser.execute(() => {
      const sheet = document
        .querySelector<HTMLElement>('#active-panel aside')!
        .getBoundingClientRect();
      const body = document.querySelector<HTMLElement>('.fixture-body')!.getBoundingClientRect();
      const composer = document.querySelector<HTMLElement>('[aria-label="Fixture composer"]')!;
      return {
        left: sheet.left,
        right: sheet.right,
        bottom: sheet.bottom,
        bodyBottom: body.bottom,
        composerVisible: composer.getBoundingClientRect().bottom <= innerHeight,
      };
    });
    expect(compact.left).toBe(0);
    expect(compact.right).toBe(320);
    expect(compact.bottom).toBe(compact.bodyBottom);
    expect(compact.composerVisible).toBe(true);
    await capture('workspace-activity-compact');

    await browser.execute(() =>
      document
        .querySelector<HTMLButtonElement>(
          '#active-panel button[aria-label="Open Now child 1: Child task 9"]',
        )!
        .click(),
    );
    await browser.waitUntil(async () =>
      browser.execute(
        () =>
          document.querySelector<HTMLOutputElement>('[aria-label="Opened activity"]')!.value ===
            'child:child-9' &&
          !document.querySelector('#active-panel aside') &&
          document.activeElement === document.querySelector('#active-panel .activity-toggle'),
      ),
    );
  });
});
