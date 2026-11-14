/**
 * Settings the element reflects from its attributes into the shell (05 §8.1): `toolbar`, `locale`,
 * `theme`, the proposed `header` (ADR 0041; 05 §8.1 has no attribute for the header yet, UX-014)
 * and the proposed `pageTheme` (ADR 0052: whether a dark theme darkens the page canvas too).
 * A ReadView like the core's, so the shell reads it without copying it into reactive state.
 */
import type { ReadView } from '../core-api.ts';
import type { PageTheme, ThemeSetting } from './theme.ts';

export type ToolbarMode = 'compact' | 'full' | 'none';
export type HeaderMode = 'default' | 'none';

export interface ShellSettings {
  readonly toolbar: ToolbarMode;
  readonly header: HeaderMode;
  /** BCP 47 tag of the interface language. */
  readonly locale: string;
  readonly theme: ThemeSetting;
  readonly pageTheme: PageTheme;
}

export const DEFAULT_SETTINGS: ShellSettings = {
  toolbar: 'compact',
  header: 'default',
  locale: 'en-GB',
  theme: 'light',
  pageTheme: 'light',
};

/** Reads an attribute value; anything unknown keeps the default (05 §1 rule 3, by analogy). */
export function toolbarMode(value: string | null | undefined): ToolbarMode {
  return value === 'full' || value === 'none' || value === 'compact' ? value : 'compact';
}

export function headerMode(value: string | null | undefined): HeaderMode {
  return value === 'none' ? 'none' : 'default';
}

export { pageThemeMode, themeMode } from './theme.ts';

export class SettingsStore implements ReadView<ShellSettings> {
  #value: ShellSettings;
  readonly #listeners = new Set<() => void>();

  constructor(initial: Partial<ShellSettings> = {}) {
    this.#value = { ...DEFAULT_SETTINGS, ...initial };
  }

  get(): ShellSettings {
    return this.#value;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  set(patch: Partial<ShellSettings>): void {
    const next = { ...this.#value, ...patch };
    const keys = Object.keys(next) as Array<keyof ShellSettings>;
    if (keys.every((k) => next[k] === this.#value[k])) return;
    this.#value = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
