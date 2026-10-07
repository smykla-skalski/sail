import { $, expect } from '@wdio/globals';

export type TopbarMenu = 'New agent' | 'More actions';

export function topbarMenuTrigger(menu: TopbarMenu) {
  return $(`.topbar button[aria-label="${menu}"]`);
}

export async function openTopbarMenu(menu: TopbarMenu) {
  const trigger = topbarMenuTrigger(menu);
  if ((await trigger.getAttribute('aria-expanded')) !== 'true') await trigger.click();
  const popup = $(`[role="menu"][aria-label="${menu}"]`);
  await expect(popup).toBeDisplayed();
  return popup;
}

export async function chooseTopbarAction(menu: TopbarMenu, label: string) {
  const popup = await openTopbarMenu(menu);
  const item = popup.$(
    `.//*[starts-with(@role, "menuitem")][contains(normalize-space(.), "${label}")]`,
  );
  await expect(item).toBeEnabled();
  await item.click();
}
