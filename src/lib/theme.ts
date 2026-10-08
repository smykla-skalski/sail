export type ThemePreference = 'system' | 'light' | 'dark';
export type ResolvedTheme = 'light' | 'dark';

export const themeSettingKey = 'sai-theme';
export const systemDarkQuery = '(prefers-color-scheme: dark)';

/** Reads a stored theme. Explicit Light and Dark choices survive; anything else follows the OS. */
export function parseThemePreference(stored: string | null): ThemePreference {
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

export function resolveTheme(preference: ThemePreference, systemDark: boolean): ResolvedTheme {
  if (preference === 'system') return systemDark ? 'dark' : 'light';
  return preference;
}

type ColorSchemeQuery = {
  matches: boolean;
  addEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
  removeEventListener(type: 'change', listener: (event: { matches: boolean }) => void): void;
};

/** Calls `onchange` with the OS dark-mode state now and whenever it changes. */
export function watchSystemDark(
  onchange: (dark: boolean) => void,
  query: ColorSchemeQuery | undefined = globalThis.matchMedia?.(systemDarkQuery),
): () => void {
  if (!query) {
    onchange(false);
    return () => {};
  }
  const listener = (event: { matches: boolean }) => onchange(event.matches);
  onchange(query.matches);
  query.addEventListener('change', listener);
  return () => query.removeEventListener('change', listener);
}
