import { browser, $, expect } from '@wdio/globals';

describe('settings-disabled E2E fixture', () => {
  it('keeps durable writes in local storage without showing an error', async () => {
    await browser.execute(() => {
      sessionStorage.removeItem('sail-e2e-settings');
      history.replaceState(null, '', '?settings-durable-fixture');
      localStorage.removeItem('sai-e2e-durable-probe');
    });
    await browser.refresh();
    await expect($('#settings-durable-result')).toHaveText('saved');
    expect(await browser.execute(() => localStorage.getItem('sai-e2e-durable-probe'))).toBe(
      'saved',
    );
    await browser.execute(() => {
      localStorage.removeItem('sai-e2e-durable-probe');
      history.replaceState(null, '', location.pathname);
    });
    await browser.refresh();
    await expect($('.app-shell')).toBeDisplayed();
    const alerts = await browser.execute(() =>
      [...document.querySelectorAll('.notice.error')].map((alert) => alert.textContent?.trim()),
    );
    expect(alerts.filter((alert) => alert?.includes('Sail settings are unavailable.'))).toEqual([]);
  });
});
