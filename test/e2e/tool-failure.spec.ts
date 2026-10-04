import { browser, $, $$, expect } from '@wdio/globals';

describe('OpenCode failed tool card', () => {
  it('announces updates and preserves the composer draft', async () => {
    await browser.execute(() => history.replaceState(null, '', '?tool-failure-fixture'));
    await browser.refresh();

    await $('button[aria-label="Fail action"]').click();
    await expect($('.tool-activity')).toHaveAttribute('open');
    await expect($('.tool-activity-error[role="alert"]')).toHaveText('Permission denied');
    await expect($('.tool-activity')).toHaveText(expect.stringContaining('blocked output'));
    await expect($('.tool-activity')).toHaveText(expect.stringContaining('Reported by policy'));

    await $('button[aria-label="Update failure"]').click();
    await expect($$('.tool-activity')).toBeElementsArrayOfSize(1);
    await expect($('.tool-activity-error[role="alert"]')).toHaveText('Policy blocked command');
    await expect($('.tool-activity')).toHaveText(expect.stringContaining('updated output'));

    await $('.tool-activity-fix').click();
    await expect($('textarea')).toHaveValue(expect.stringContaining('Existing draft'));
    await expect($('textarea')).toHaveValue(expect.stringContaining('Command:\nnpm test'));
    await expect($('textarea')).toHaveValue(expect.stringContaining('Policy blocked command'));
    const first = await $('textarea').getValue();
    await $('.tool-activity-fix').click();
    expect(await $('textarea').getValue()).toBe(first);
  });
});
