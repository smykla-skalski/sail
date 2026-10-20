import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdirSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = process.env.SAIL_E2E_CONFIG_DIR;
if (!root) throw new Error('Plan reviews require an isolated SAIL_E2E_CONFIG_DIR.');
const repository = join(root, 'plan-review-repository');

async function restoreReview(inSplit: boolean, withInvalidDiagram = false, appearance = 'light') {
  await browser.execute(
    ({ directory, split, invalidDiagram, theme }) => {
      localStorage.clear();
      localStorage.setItem('sai-theme', theme);
      localStorage.setItem('sai-directory', directory);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [directory], groups: [] }),
      );
      const thread = {
        agent: 'codex',
        directory,
        sessionId: 'plan-review',
        title: 'Pending Codex plan',
        updated: Date.now(),
      };
      localStorage.setItem('sail-agent-threads', JSON.stringify([thread]));
      const agent = { id: split ? 'review-pane' : 'main', agent: 'codex', thread };
      const terminal = {
        id: split ? 'main' : 'terminal-pane',
        kind: 'terminal',
        agent: null,
        thread: null,
      };
      localStorage.setItem(
        'sai-pane-layouts',
        JSON.stringify({
          [directory]: {
            id: 'split',
            direction: 'row',
            ratio: 0.5,
            first: split ? terminal : agent,
            second: split ? agent : terminal,
          },
        }),
      );
      const plan = {
        title: 'Replacement plan v4',
        summary: 'Review the replacement after a blocked checkpoint.\n'.repeat(30),
        sessionID: thread.sessionId,
        version: 4,
        state: 'review',
        reviewReason: 'plan',
        createdAt: Date.now(),
        outside: [],
        ...(invalidDiagram ? { diagram: 'this is not a Mermaid diagram' } : {}),
        steps: ['resume-prior-judgment', 'unapproved-work'].map((id) => ({
          id,
          title: id,
          detail: 'Resume only after explicit review.',
          files: [],
          risk: 'low',
          status: 'proposed',
          origin: 'plan',
          touched: [],
        })),
      };
      localStorage.setItem(
        'sai-acp-plans',
        JSON.stringify([
          {
            scope: { agent: thread.agent, directory, sessionId: thread.sessionId },
            plan,
            questions: null,
            history: [],
            nextHistoryId: 1,
            updated: Date.now(),
          },
        ]),
      );
    },
    {
      directory: realpathSync(repository),
      split: inSplit,
      invalidDiagram: withInvalidDiagram,
      theme: appearance,
    },
  );
  await browser.refresh();
  if ((await browser.execute(() => innerWidth)) <= 850) {
    await $('[aria-label="Workspace panels"]').$('button=Details').click();
  }
  try {
    await expect($('[aria-label="Plan review"]')).toBeDisplayed();
  } catch (cause) {
    console.error(
      'Restored plan diagnostic',
      await browser.execute(() => ({
        body: document.body.innerText.slice(0, 6000),
        directory: localStorage.getItem('sai-directory'),
        threads: localStorage.getItem('sail-agent-threads'),
        panes: localStorage.getItem('sai-pane-layouts'),
        plans: localStorage.getItem('sai-acp-plans'),
      })),
    );
    throw cause;
  }
}

describe('pending structured plan review', () => {
  before(() => {
    mkdirSync(repository, { recursive: true });
    execFileSync('git', ['init', '-q', repository]);
    writeFileSync(
      join(repository, '.acp-external-sessions.json'),
      JSON.stringify([
        {
          sessionId: 'plan-review',
          title: 'Pending Codex plan',
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
  });

  for (const split of [false, true]) {
    it(`restores and submits pending review in the ${split ? 'split' : 'main'} agent pane`, async () => {
      await browser.setWindowSize(1920, 1200);
      await restoreReview(split);
      const panel = $('[aria-label="Plan review"]');
      await expect(panel).toHaveText(expect.stringContaining('Replacement plan v4'));
      await expect(panel.$('.approval-blocker')).toHaveText(
        expect.stringContaining('Approve at least one step'),
      );
      await expect(panel.$('button=Execute approved steps')).toBeDisabled();
      const firstApprove = panel.$('[aria-label="Approve resume-prior-judgment"]');
      await firstApprove.scrollIntoView();
      await firstApprove.click();
      const execute = panel.$('button=Execute approved steps');
      await expect(execute).toBeEnabled();
      await execute.click();
      await panel.$('button=Confirm execution').click();
      const auth = $('.agent-auth button');
      if (await auth.isExisting()) await auth.click();
      await expect($('.agent-permission')).toHaveText(expect.stringContaining('Run test action'));
      await $('.agent-permission button').click();
      await expect(panel).toHaveText(expect.stringContaining('Execution approved.'));
      await browser.waitUntil(async () =>
        browser.execute(() => {
          const saved = JSON.parse(localStorage.getItem('sai-acp-plans') ?? '[]');
          return saved[0]?.plan?.state === 'executing';
        }),
      );
      const statuses = await browser.execute(() =>
        JSON.parse(localStorage.getItem('sai-acp-plans') ?? '[]')[0].plan.steps.map(
          (step: { status: string }) => step.status,
        ),
      );
      expect(statuses).toEqual(['approved', 'proposed']);
    });
  }

  it('explains why invalid diagrams block approval', async () => {
    await restoreReview(true, true);
    const panel = $('[aria-label="Plan review"]');
    await expect(panel.$('.approval-blocker')).toHaveText(
      expect.stringContaining('Correct the invalid diagrams'),
    );
    await expect(panel.$('button=Accept all and start')).toBeDisabled();
    await expect(panel.$('button=Execute approved steps')).toBeDisabled();
  });

  it('allows scrolling to review actions in a short split pane', async () => {
    await browser.setWindowSize(960, 550);
    await restoreReview(true);
    const bounds = await browser.execute(() => {
      const panel = document.querySelector<HTMLElement>('.plan-panel')!;
      panel.scrollTo(0, panel.scrollHeight);
      const rect = panel.getBoundingClientRect();
      const button = [...panel.querySelectorAll<HTMLButtonElement>('button')]
        .find((element) => element.textContent?.includes('Execute approved steps'))!
        .getBoundingClientRect();
      return {
        top: button.top,
        bottom: button.bottom,
        panelTop: rect.top,
        panelBottom: rect.bottom,
        height: innerHeight,
      };
    });
    expect(bounds.top).toBeGreaterThanOrEqual(bounds.panelTop);
    expect(bounds.bottom).toBeLessThanOrEqual(Math.min(bounds.panelBottom, bounds.height));
  });

  for (const theme of ['light', 'dark']) {
    for (const [width, height] of [
      [2560, 1440],
      [1920, 1200],
      [390, 850],
    ]) {
      it(`keeps review actions reachable at ${width}px in ${theme}`, async () => {
        await browser.setWindowSize(width, height);
        await restoreReview(width > 850, false, theme);
        const panel = $('[aria-label="Plan review"]');
        await expect(panel).toBeDisplayed();
        const bounds = await browser.execute(() => {
          const button = [
            ...document.querySelectorAll<HTMLButtonElement>('.plan-panel button'),
          ].find((element) => element.textContent?.includes('Accept all and start'))!;
          const rect = button.getBoundingClientRect();
          return {
            width: innerWidth,
            top: rect.top,
            bottom: rect.bottom,
            left: rect.left,
            right: rect.right,
            height: innerHeight,
            overflow: document.documentElement.scrollWidth > innerWidth,
          };
        });
        expect(bounds.top).toBeGreaterThanOrEqual(0);
        expect(bounds.bottom).toBeLessThanOrEqual(bounds.height);
        expect(bounds.left).toBeGreaterThanOrEqual(0);
        expect(bounds.right).toBeLessThanOrEqual(bounds.width);
        expect(bounds.overflow).toBe(false);
        if (width === 2560 && process.env.SAIL_REVIEW_SCREENSHOTS) {
          console.log('Review capture viewport', bounds.width);
          await browser.saveScreenshot(
            join(process.env.SAIL_REVIEW_SCREENSHOTS, `plan-review-${theme}-${bounds.width}.png`),
          );
        }
      });
    }
  }
});
