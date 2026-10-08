import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

describe('agent questions', () => {
  const repository = mkdtempSync(join(tmpdir(), 'sail-questions-e2e-'));

  before(() => {
    execFileSync('git', ['init', '-q', repository]);
  });

  after(async () => {
    await browser.execute(() => localStorage.clear());
    rmSync(repository, { recursive: true, force: true });
  });

  it('renders AskUserQuestion options and returns the adapter answer shape', async () => {
    await browser.execute((path) => {
      localStorage.setItem('sai-directory', path);
      localStorage.setItem(
        'sai-project-catalog',
        JSON.stringify({ repositories: [path], groups: [], worktrees: {} }),
      );
      localStorage.removeItem('sail-agent-threads');
      localStorage.setItem('sai-notifications-enabled', 'false');
    }, realpathSync(repository));
    await browser.refresh();
    await expect($('.agent-launches button')).toBeEnabled();
    await $('.agent-launches button').click();
    await $('.agent-composer textarea').waitForEnabled();
    await $('.agent-composer textarea').setValue('Ask user questions');
    await $('.agent-actions button').click();

    const form = $('[aria-label="Agent question"]');
    await expect(form).toBeDisplayed();
    await expect(form.$('.elicitation-message')).toHaveText(
      'Please answer the following questions.',
    );
    const storage = form.$('[data-question="question_0"]');
    const rollout = form.$('[data-question="question_1"]');
    await expect(storage.$('legend')).toHaveText(
      expect.stringContaining('Which storage engine should the cache use?'),
    );
    await expect(storage.$('.elicitation-header')).toHaveText(/^storage$/i);
    await expect(storage.$$('input[type="radio"]')).toBeElementsArrayOfSize(3);
    await expect(rollout.$$('input[type="checkbox"]')).toBeElementsArrayOfSize(3);
    await expect(storage.$('[data-option="Redis"]')).toHaveText(
      expect.stringContaining('Fastest reads, but adds a service to operate.'),
    );
    await expect(storage.$('[data-option="Postgres (Recommended)"]')).toHaveText(
      expect.stringContaining('Postgres (Recommended)'),
    );
    await expect(storage.$('.elicitation-other input')).toBeDisplayed();
    await expect(rollout.$('.elicitation-other input')).toBeDisplayed();
    await expect(storage.$('.elicitation-preview')).not.toBeExisting();

    await $('[data-topbar-inbox]').click();
    await expect($('.inbox-item')).toHaveText(
      expect.stringContaining(
        '2 questions: Which storage engine should the cache use? · Which rollout steps should run?',
      ),
    );
    await $('.inbox-item .inbox-open').click();
    await expect(form).toBeDisplayed();

    const redis = storage.$('[data-option="Redis"] input');
    await redis.click();
    await browser.execute((input) => input.focus(), redis);
    await browser.keys('ArrowUp');
    await expect(storage.$('[data-option="Postgres (Recommended)"] input')).toBeSelected();
    await expect(storage.$('.elicitation-preview textarea')).toHaveValue(
      expect.stringContaining('CREATE TABLE cache'),
    );
    await rollout.$('[data-option="Metrics"] input').click();
    await rollout.$('[data-option="Docs"] input').click();
    await rollout.$('.elicitation-other input').setValue('Canary');
    await form.$('button=Submit').click();

    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining(
        'Answers: {"question_0":"Postgres (Recommended)","question_1":["Metrics","Docs"],"question_1_custom":"Canary"}',
      ),
    );
    await expect(form).not.toBeExisting();
  });
});
