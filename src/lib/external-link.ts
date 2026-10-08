import { invoke, isTauri } from '@tauri-apps/api/core';

export const OPEN_IN_SPLIT_EVENT = 'sail-open-link-in-split';

export function openExternalLink(
  event: Pick<MouseEvent, 'metaKey' | 'ctrlKey' | 'preventDefault'>,
  url: string,
): void {
  if (!isTauri() || url.startsWith('#')) return;
  event.preventDefault();
  if ((event.metaKey || event.ctrlKey) && /^https?:\/\//i.test(url)) {
    window.dispatchEvent(new CustomEvent(OPEN_IN_SPLIT_EVENT, { detail: { url } }));
    return;
  }
  void invoke('open_external_url', { url }).catch((error: unknown) => {
    console.error('Could not open external link:', error);
  });
}
