export const themeAttributes = ['data-sui-theme', 'data-theme'];

export type ThemeRoot = {
  dataset: DOMStringMap;
  getBoundingClientRect(): unknown;
};

export type ThemeObserver<Root> = {
  observe(target: Root, options?: MutationObserverInit): void;
  disconnect(): void;
};

/**
 * Applies theme changes on `root` without CSS transitions.
 *
 * WebKit pauses transitions in hidden windows, so a color transition started by a theme
 * change can keep the old theme's background until the window is shown again.
 */
export function guardThemeTransitions<Root extends ThemeRoot>(
  root: Root,
  Observer: new (callback: () => void) => ThemeObserver<Root>,
): () => void {
  const observer = new Observer(() => {
    root.dataset.themeSwitching = '';
    root.getBoundingClientRect();
    delete root.dataset.themeSwitching;
  });
  observer.observe(root, { attributes: true, attributeFilter: themeAttributes });
  return () => observer.disconnect();
}

/** Guards the document root against transitions during theme changes. */
export function installThemeTransitionGuard(): () => void {
  return guardThemeTransitions<HTMLElement>(document.documentElement, MutationObserver);
}
