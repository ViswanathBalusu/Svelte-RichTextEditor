/**
 * Themes (UX-061 criteria 1 and 3; UX-062). The resolution of `auto` and the settings are pure
 * functions; the contrast check reads the token defaults of `src/styles/shell.css` for each theme
 * and computes WCAG 2.2 contrast ratios for the text and control pairs. A host's `--de-` override
 * is not checked here: the check covers what the shell ships.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import fc from 'fast-check';
import { describe, expect, it, afterEach } from 'vitest';
import {
  pageThemeMode,
  resolveTheme,
  themeMode,
  watchColourScheme,
  type ThemeSetting,
} from '../src/shell/theme.ts';

describe('the theme setting (UX-061, criterion 1)', () => {
  it('accepts the three values of 05 section 8.1 and the proposed high-contrast value, else light', () => {
    fc.assert(
      fc.property(fc.string(), (value) => {
        const mode = themeMode(value);
        expect(['light', 'dark', 'auto', 'high-contrast']).toContain(mode);
        if (['dark', 'auto', 'high-contrast'].includes(value)) expect(mode).toBe(value);
        else expect(mode).toBe('light');
      }),
    );
    expect(themeMode(null)).toBe('light');
    expect(themeMode(undefined)).toBe('light');
  });

  it('keeps the page light unless the host asks for the canvas to follow the dark theme', () => {
    expect(pageThemeMode('follow')).toBe('follow');
    expect(pageThemeMode('light')).toBe('light');
    expect(pageThemeMode('dark')).toBe('light');
    expect(pageThemeMode(null)).toBe('light');
  });

  it('resolves auto from the browser preference, and leaves the other settings as they are', () => {
    fc.assert(
      fc.property(
        fc.constantFrom<ThemeSetting>('light', 'dark', 'auto', 'high-contrast'),
        fc.boolean(),
        (setting, prefersDark) => {
          const resolved = resolveTheme(setting, prefersDark);
          if (setting === 'auto') expect(resolved).toBe(prefersDark ? 'dark' : 'light');
          else expect(resolved).toBe(setting);
        },
      ),
    );
  });
});

describe('auto follows the browser preference while the editor runs (UX-061, criterion 1)', () => {
  const original = (globalThis as { matchMedia?: unknown }).matchMedia;
  afterEach(() => {
    (globalThis as { matchMedia?: unknown }).matchMedia = original;
  });

  it('reports the current preference and calls back when it changes', () => {
    let listener: ((e: { matches: boolean }) => void) | null = null;
    let current = false;
    (globalThis as { matchMedia?: unknown }).matchMedia = () => ({
      get matches() {
        return current;
      },
      addEventListener: (_: string, l: (e: { matches: boolean }) => void) => {
        listener = l;
      },
      removeEventListener: () => {
        listener = null;
      },
    });
    const seen: boolean[] = [];
    const watch = watchColourScheme((dark) => seen.push(dark));
    expect(watch.dark).toBe(false);
    current = true;
    listener!({ matches: true });
    expect(seen).toEqual([true]);
    watch.stop();
    expect(listener).toBe(null);
  });
});

/* ------------------------------------------------------------------------------------------ */
/* Contrast (criterion 3). WCAG 2.2 relative luminance and contrast ratio.                     */
/* ------------------------------------------------------------------------------------------ */

const CSS = readFileSync(
  fileURLToPath(new URL('../src/styles/shell.css', import.meta.url)),
  'utf8',
);

/** The declarations of the rule whose selector list is exactly `selector`. */
function declarations(selector: string): Record<string, string> {
  const out: Record<string, string> = {};
  const rule = new RegExp(`(?:^|\\}|\\*/)\\s*${escape(selector)}\\s*\\{([^}]*)\\}`, 'gm');
  for (const m of CSS.matchAll(rule)) {
    for (const d of m[1]!.matchAll(/--_de-([a-z0-9-]+):\s*var\(--de-[a-z0-9-]+,\s*([^)]+)\)/g))
      out[d[1]!] = d[2]!.trim();
  }
  return out;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The tokens a theme gives: the base rule, then the theme's own rules over it (cascade order). */
function effective(...selectors: string[]): Record<string, string> {
  return Object.assign({}, ...selectors.map(declarations));
}

const LIGHT = effective('.de-shell');
const DARK = effective('.de-shell', ".de-shell[data-theme='dark']");
const DARK_PAGE = effective(
  '.de-shell',
  ".de-shell[data-theme='dark']",
  ".de-shell[data-theme='dark'][data-page-theme='follow']",
);
const HIGH = effective('.de-shell', ".de-shell[data-theme='high-contrast']");

function channel(c: number): number {
  const v = c / 255;
  return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function luminance(hex: string): number {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = channel((n >> 16) & 255);
  const g = channel((n >> 8) & 255);
  const b = channel(n & 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function contrast(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
}

function colour(theme: Record<string, string>, token: string): string {
  const value = theme[token];
  if (value === undefined) throw new Error(`token ${token} has no default in shell.css`);
  if (!/^#[0-9a-fA-F]{6}$/.test(value))
    throw new Error(`token ${token} is ${value}, not a hex colour`);
  return value;
}

/** Text pairs need 4.5 to 1 (1.4.3); boundaries and focus indicators need 3 to 1 (1.4.11). */
const TEXT = 4.5;
const NON_TEXT = 3;

const PAIRS: Array<[string, string, string, number]> = [
  ['text', 'surface', 'text on the surface', TEXT],
  ['text-muted', 'surface', 'muted text on the surface', TEXT],
  ['text', 'surface-raised', 'text on the raised surface', TEXT],
  ['text', 'control-background', 'text on a control', TEXT],
  ['text', 'control-hover', 'text on a hovered control', TEXT],
  ['text', 'control-active', 'text on an active control', TEXT],
  ['control-disabled-text', 'control-background', 'disabled control text', TEXT],
  ['border-strong', 'surface', 'strong border on the surface', NON_TEXT],
  ['focus', 'surface', 'focus ring on the surface', NON_TEXT],
  ['focus', 'control-background', 'focus ring on a control', NON_TEXT],
  ['control-active-border', 'control-active', 'active control border', NON_TEXT],
];

const THEMES: Array<[string, Record<string, string>]> = [
  ['light', LIGHT],
  ['dark', DARK],
  ['dark with the page canvas following', DARK_PAGE],
  ['high-contrast', HIGH],
];

describe('contrast of the shipped themes (UX-061, criterion 3; UX-062)', () => {
  for (const [name, theme] of THEMES) {
    it(`meets WCAG 2.2 AA on the text and control tokens of the ${name} theme`, () => {
      for (const [fg, bg, what, min] of PAIRS) {
        const ratio = contrast(colour(theme, fg), colour(theme, bg));
        expect(ratio, `${what} in ${name}`).toBeGreaterThanOrEqual(min);
      }
    });
  }

  it('gives every pair a higher ratio in the high-contrast theme than in light and dark (UX-062, criterion 2)', () => {
    for (const [fg, bg, what] of PAIRS) {
      const high = contrast(colour(HIGH, fg), colour(HIGH, bg));
      for (const [name, theme] of [
        ['light', LIGHT],
        ['dark', DARK],
      ] as const) {
        const other = contrast(colour(theme, fg), colour(theme, bg));
        expect(
          high,
          `${what}: high-contrast ${high.toFixed(2)} against ${name} ${other.toFixed(2)}`,
        ).toBeGreaterThan(other);
      }
    }
  });

  it('gives the page text its own pair in the dark theme with the canvas following', () => {
    expect(
      contrast(colour(DARK_PAGE, 'page-text'), colour(DARK_PAGE, 'sheet')),
    ).toBeGreaterThanOrEqual(TEXT);
    expect(contrast(colour(LIGHT, 'page-text'), colour(LIGHT, 'sheet'))).toBeGreaterThanOrEqual(
      TEXT,
    );
  });

  it('keeps white initials on every avatar colour at 4.5 to 1 or more (UX-026)', () => {
    for (let i = 1; i <= 8; i++)
      expect(
        contrast(colour(LIGHT, 'person-text'), colour(LIGHT, `person-${i}`)),
      ).toBeGreaterThanOrEqual(TEXT);
  });

  it('checks the tokens it reads (the parser finds them, so the table is not empty)', () => {
    expect(Object.keys(LIGHT).length).toBeGreaterThan(20);
    expect(Object.keys(DARK).length).toBeGreaterThan(20);
    expect(Object.keys(HIGH).length).toBeGreaterThan(20);
  });
});
