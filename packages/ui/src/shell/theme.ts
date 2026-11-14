/**
 * Themes (UX-061, UX-062; 13 §8; 05 §8.1 `theme`). The shell sets `data-theme` on `.de-shell` to
 * the resolved theme, and the stylesheet gives each theme its token defaults; public `--de-`
 * properties still win over them (FE-018). `auto` is resolved from `prefers-color-scheme` before
 * the first paint and follows it while the editor runs. `high-contrast` is a proposed value of the
 * attribute (05 §8.1 lists `light`, `dark` and `auto`; ADR 0052).
 *
 * The page canvas follows a dark theme only when the host asks (`pageTheme: 'follow'`); otherwise
 * the page stays light. The document's own colours are never changed, in the stored document or
 * in exports: the shell only sets the canvas and the default text colour of the page.
 */
export type ThemeSetting = 'light' | 'dark' | 'auto' | 'high-contrast';
export type ResolvedTheme = 'light' | 'dark' | 'high-contrast';
export type PageTheme = 'light' | 'follow';

export function themeMode(value: string | null | undefined): ThemeSetting {
  return value === 'dark' || value === 'auto' || value === 'high-contrast' ? value : 'light';
}

export function pageThemeMode(value: string | null | undefined): PageTheme {
  return value === 'follow' ? 'follow' : 'light';
}

/** The theme in effect for a setting and the browser's colour-scheme preference. */
export function resolveTheme(setting: ThemeSetting, prefersDark: boolean): ResolvedTheme {
  if (setting === 'auto') return prefersDark ? 'dark' : 'light';
  return setting;
}

/** Watches `prefers-color-scheme: dark`; returns its current value and a way to stop. */
export function watchColourScheme(onChange: (dark: boolean) => void): {
  dark: boolean;
  stop: () => void;
} {
  if (typeof matchMedia !== 'function') return { dark: false, stop: () => {} };
  const query = matchMedia('(prefers-color-scheme: dark)');
  const listener = (e: MediaQueryListEvent) => onChange(e.matches);
  query.addEventListener('change', listener);
  return { dark: query.matches, stop: () => query.removeEventListener('change', listener) };
}
