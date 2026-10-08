import { browser, $, $$, expect } from '@wdio/globals';

describe('OpenCode failed tool card', () => {
  it('announces updates and preserves the composer draft', async () => {
    await browser.execute(() => history.replaceState(null, '', '?tool-failure-fixture'));
    await browser.refresh();

    const initialStatus = $('.tool-activity .activity-status');
    await expect(initialStatus).toHaveAttribute('data-state', 'working');
    await expect(initialStatus).toHaveText(expect.stringContaining('Working'));
    const workingColor = await initialStatus.getCSSProperty('color');

    await $('button[aria-label="Fail action"]').click();
    const failedStatus = $('.tool-activity .activity-status');
    await expect(failedStatus).toHaveAttribute('data-state', 'failed');
    await expect(failedStatus).toHaveText(expect.stringContaining('Failed'));
    expect((await failedStatus.getCSSProperty('color')).value).not.toBe(workingColor.value);
    await expect($('.tool-activity')).toHaveAttribute('open');
    await expect($('.tool-activity-error')).toHaveText('Permission denied');
    await expect($('.tool-activity-alert[role="alert"]')).toHaveText('Permission denied');
    await expect($('.tool-activity')).toHaveText(expect.stringContaining('blocked output'));
    await expect($('.tool-activity')).toHaveText(expect.stringContaining('Reported by policy'));
    await $('.tool-activity-fix').click();
    await expect($('textarea')).toHaveValue(expect.stringContaining('Permission denied'));

    await $('button[aria-label="Update failure"]').click();
    await expect($$('.tool-activity')).toBeElementsArrayOfSize(1);
    await expect($('.tool-activity-alert[role="alert"]')).toHaveText('Policy blocked command');
    await expect($('.tool-activity')).toHaveText(expect.stringContaining('updated output'));

    await $('.tool-activity-fix').click();
    await expect($('textarea')).toHaveValue(expect.stringContaining('Existing draft'));
    await expect($('textarea')).toHaveValue(expect.stringContaining('Command:\nnpm test'));
    await expect($('textarea')).toHaveValue(expect.stringContaining('Policy blocked command'));
    await expect($('textarea')).not.toHaveValue(expect.stringContaining('Permission denied'));
    const first = await $('textarea').getValue();
    await $('.tool-activity-fix').click();
    expect(await $('textarea').getValue()).toBe(first);
  });

  it('announces cards that mount failed live once and keeps history silent', async () => {
    await $('button[aria-label="Mount history failure"]').click();
    const history = $('[data-mounted="history"] .tool-activity-alert[role="alert"]');
    await expect(history).toExist();
    await expect(history).toHaveText('');
    await expect($('[data-mounted="history"] .tool-activity-error')).toHaveText('Mounted failure');

    await $('button[aria-label="Mount live failure"]').click();
    await expect($('[data-mounted="live"] .tool-activity-alert[role="alert"]')).toHaveText(
      'Mounted failure',
    );

    await $('button[aria-label="Remount failures"]').click();
    await expect($('[data-mounted="live"] .tool-activity-error')).toHaveText('Mounted failure');
    await expect($('[data-mounted="live"] .tool-activity-alert')).toHaveText('');
    await expect($('[data-mounted="history"] .tool-activity-alert')).toHaveText('');
  });
});
