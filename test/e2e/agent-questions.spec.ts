import { browser, $, expect } from '@wdio/globals';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const sendButton = "//*[contains(@class,'agent-actions')]//button[contains(.,'Send')]";

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
    await expect($('.agent-header')).toHaveText(expect.stringContaining('Ready'));
    await $('.agent-composer textarea').waitForEnabled();
    await $('.agent-composer textarea').setValue('Ask user questions');
    await expect($(sendButton)).toBeEnabled();
    await $(sendButton).click();

    const form = $('[aria-label="Agent question"]');
    try {
      await expect(form).toBeDisplayed();
    } catch (cause) {
      console.error('Agent question diagnostic', {
        header: await $('.agent-header').getText(),
        composer: await $('.agent-composer').getText(),
        draft: await $('.agent-composer textarea').getValue(),
        conversation: await $('.agent-conversation').getText(),
      });
      throw cause;
    }
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
    await browser.execute(() =>
      document
        .querySelector<HTMLInputElement>('[data-question="question_0"] [data-option="Redis"] input')
        ?.focus(),
    );
    await browser.keys('ArrowUp');
    await expect(storage.$('[data-option="Postgres (Recommended)"] input')).toBeSelected();
    await expect(storage.$('.elicitation-preview textarea')).toHaveValue(
      expect.stringContaining('CREATE TABLE cache'),
    );
    const clear = () => storage.$('button=Clear choice');
    await browser.execute(() => {
      const button = document.querySelector<HTMLButtonElement>(
        '[data-question="question_0"] .elicitation-clear button',
      );
      button?.focus();
      button?.click();
    });
    await expect(storage.$$('input[type="radio"]:checked')).toBeElementsArrayOfSize(0);
    await expect(clear()).not.toBeExisting();
    await expect(storage.$('.elicitation-preview')).not.toBeExisting();
    expect(
      await browser.execute(
        () => document.activeElement?.matches('[data-question="question_0"] input') ?? false,
      ),
    ).toBe(true);
    await storage.$('[data-option="Redis"] input').click();
    await clear().click();
    await expect(storage.$$('input[type="radio"]:checked')).toBeElementsArrayOfSize(0);
    await storage.$('.elicitation-other input').setValue('Valkey');
    await rollout.$('[data-option="Metrics"] input').click();
    await rollout.$('[data-option="Docs"] input').click();
    await rollout.$('.elicitation-other input').setValue('Canary');
    await form.$('button=Submit').click();

    await expect($('.agent-conversation')).toHaveText(
      expect.stringContaining(
        'Answers: {"question_0_custom":"Valkey","question_1":["Metrics","Docs"],"question_1_custom":"Canary"}',
      ),
    );
    await expect(form).not.toBeExisting();

    await $('.agent-composer textarea').setValue('Ask structured question');
    await expect($(sendButton)).toBeEnabled();
    await $(sendButton).click();
    try {
      await $('[aria-label="Agent question"]').waitForDisplayed();
    } catch (cause) {
      console.error('Enum question diagnostic', {
        header: await $('.agent-header').getText(),
        actions: await $('.agent-actions').getText(),
        draft: await $('.agent-composer textarea').getValue(),
        conversation: await $('.agent-conversation').getText(),
      });
      throw cause;
    }
    await expect($('[aria-label="Agent question"] .elicitation-message')).toHaveText(
      'Choose the delivery approach',
    );
    await browser.execute(() => {
      const select = document.querySelector<HTMLSelectElement>(
        '[aria-label="Agent question"] select',
      );
      if (!select) throw new Error('Missing enum select');
      select.value = 'fast';
      select.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await $('[aria-label="Agent question"] .elicitation-actions button').click();
    await expect($('.agent-conversation')).toHaveText(expect.stringContaining('Selected: fast'));
  });
});
