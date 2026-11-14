/**
 * The string catalogue (UX-064; 13 §8): the source table, lazy tables with fallback to the base
 * language and then the default, the missing-key report, host replacements by key, plural rules and
 * number formats through Intl, and the pseudo-locales.
 */
import { describe, expect, it, vi } from 'vitest';
import { coreCommands } from '../src/commands/builtin.ts';
import { EN_GB } from '../src/i18n/en-GB.ts';
import { accentText, accented, bidi } from '../src/i18n/pseudo.ts';
import { DEFAULT_LOCALE, Strings, candidates } from '../src/i18n/strings.ts';
import type { LocaleTable } from '../src/i18n/types.ts';

const welsh: LocaleTable = {
  strings: {
    'toolbar.label': 'Golygu',
    // Welsh has six plural categories; enough of them to see the rules at work.
    'presence.more.label': {
      zero: '{count} person arall',
      one: '{count} person arall',
      two: '{count} berson arall',
      few: '{count} pherson arall',
      many: '{count} pherson arall',
      other: '{count} person arall (other)',
    },
  },
};

describe('the source table', () => {
  it('is British English and the default', () => {
    const strings = new Strings();
    expect(strings.current.locale).toBe(DEFAULT_LOCALE);
    expect(strings.current.dir).toBe('ltr');
    expect(strings.current.t('toolbar.label')).toBe('Editing');
    expect(EN_GB['reason.access.view']).toContain('change');
  });

  it('holds every command label (UX-003, criterion 6)', () => {
    const strings = new Strings();
    for (const entry of coreCommands()) {
      expect(strings.has(entry.label), entry.id).toBe(true);
      expect(strings.current.text(entry.label)).not.toBe(entry.label);
    }
  });
});

describe('choosing a table for a BCP 47 tag (UX-064, criterion 2)', () => {
  it('tries the exact tag, then language and script, then the language, then the default', () => {
    expect(candidates('de-CH')).toEqual(['de-CH', 'de', 'en-GB']);
    expect(candidates('sr-Latn-RS')).toEqual(['sr-Latn-RS', 'sr-Latn', 'sr', 'en-GB']);
    expect(candidates('EN-gb')).toEqual(['en-GB', 'en']);
    expect(candidates('not a tag!')).toEqual(['en-GB']);
  });

  it('loads a table only when it is needed, once', async () => {
    const loader = vi.fn(async () => welsh);
    const strings = new Strings({ loaders: { cy: loader } });
    expect(loader).not.toHaveBeenCalled();
    await strings.setLocale('cy-GB');
    expect(loader).toHaveBeenCalledTimes(1);
    expect(strings.current.locale).toBe('cy');
    expect(strings.current.requested).toBe('cy-GB');
    expect(strings.current.t('toolbar.label')).toBe('Golygu');
    await strings.setLocale('en-GB');
    await strings.setLocale('cy');
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it('falls back to the default table for a language it has no table for', async () => {
    const strings = new Strings();
    await strings.setLocale('fr-CA');
    expect(strings.current.locale).toBe('en-GB');
    expect(strings.current.requested).toBe('fr-CA');
    await strings.setLocale('en-US');
    expect(strings.current.locale).toBe('en');
    expect(strings.current.t('save.saved')).toBe('Saved');
  });

  it('falls back key by key and reports the missing keys once per locale', async () => {
    const onMissing = vi.fn();
    const strings = new Strings({ loaders: { cy: async () => welsh }, onMissing });
    await strings.setLocale('cy');
    await strings.setLocale('en-GB');
    await strings.setLocale('cy');
    expect(onMissing).toHaveBeenCalledTimes(1);
    const [tag, keys] = onMissing.mock.calls[0]! as [string, string[]];
    expect(tag).toBe('cy');
    expect(keys).toContain('save.saved');
    expect(keys).not.toContain('toolbar.label');
    expect(strings.current.t('save.saved')).toBe('Saved');
    expect(strings.missing('cy')).toEqual(keys);
  });

  it('keeps the default table when a loader fails, and reports it', async () => {
    const onError = vi.fn();
    const strings = new Strings({
      loaders: { cy: () => Promise.reject(new Error('offline')) },
      onError,
    });
    await strings.setLocale('cy');
    expect(onError).toHaveBeenCalledWith('cy', expect.any(Error));
    expect(strings.current.locale).toBe('en-GB');
  });

  it('lets the latest request win', async () => {
    let release!: () => void;
    const slow = new Promise<LocaleTable>((resolve) => (release = () => resolve(welsh)));
    const strings = new Strings({ loaders: { cy: () => slow } });
    const first = strings.setLocale('cy');
    await strings.setLocale('en-GB');
    release();
    await first;
    expect(strings.current.locale).toBe('en-GB');
  });

  it('notifies the shell when the translator changes', async () => {
    const strings = new Strings();
    const listener = vi.fn();
    strings.view.subscribe(listener);
    await strings.setLocale('en-XA');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(strings.view.get()).toBe(strings.current);
  });
});

describe('host replacements (UX-064, criterion 3; the mechanism for UX-063)', () => {
  it('replace strings by key, fall back for the rest and report unknown keys', () => {
    const onUnknown = vi.fn();
    const strings = new Strings({
      overrides: { 'save.saved': 'All changes stored', 'no.such.key': 'x' },
      onUnknown,
    });
    expect(strings.current.t('save.saved')).toBe('All changes stored');
    expect(strings.current.t('save.saving')).toBe('Saving');
    expect(onUnknown).toHaveBeenCalledWith(['no.such.key']);
  });

  it('ignore values that are not messages, and keep markup as plain text', () => {
    const strings = new Strings({
      overrides: {
        'save.saved': { other: '<b>Saved</b>' },
        'save.saving': 42 as unknown as string,
      },
    });
    expect(strings.current.t('save.saved')).toBe('<b>Saved</b>');
    expect(strings.current.t('save.saving')).toBe('Saving');
  });
});

describe('numbers, dates and plurals through Intl (UX-064, criterion 5)', () => {
  it('picks the plural form with the locale rules', async () => {
    const en = new Strings();
    expect(en.current.t('presence.more.label', { count: 1 })).toBe(
      '1 more person in this document',
    );
    expect(en.current.t('presence.more.label', { count: 3 })).toBe(
      '3 more people in this document',
    );
    const cy = new Strings({ loaders: { cy: async () => welsh } });
    await cy.setLocale('cy');
    expect(cy.current.t('presence.more.label', { count: 2 })).toBe('2 berson arall');
    expect(cy.current.t('presence.more.label', { count: 3 })).toBe('3 pherson arall');
    expect(cy.current.t('presence.more.label', { count: 6 })).toBe('6 pherson arall');
  });

  it('formats numbers and dates for the locale', async () => {
    const strings = new Strings({ loaders: { de: async () => ({ strings: {} }) } });
    expect(strings.current.number(12345.5)).toBe('12,345.5');
    await strings.setLocale('de-DE');
    expect(strings.current.locale).toBe('de');
    expect(strings.current.number(12345.5)).toBe('12.345,5');
    expect(strings.current.t('count.comments', { count: 1234 })).toBe(
      'Comments, 1.234 open threads',
    );
    const date = new Date(Date.UTC(2026, 10, 6, 12));
    expect(strings.current.date(date, { dateStyle: 'long', timeZone: 'UTC' })).toBe(
      '6. November 2026',
    );
  });
});

describe('pseudo-locales (UX-064, criteria 4 and 7)', () => {
  it('transform every message and keep placeholders', () => {
    const table = accented().strings;
    expect(Object.keys(table)).toEqual(Object.keys(EN_GB));
    expect(accentText('Region: {title}')).toMatch(/^\[Ŕéĝíóñ: \{title\}·+\]$/);
    for (const [key, message] of Object.entries(table)) {
      const texts = typeof message === 'string' ? [message] : Object.values(message);
      for (const text of texts) expect(text, key).toMatch(/^\[.*\]$/s);
    }
  });

  it('make strings longer, to show clipping', () => {
    const source = EN_GB['reason.access.view'];
    const pseudo = accented().strings['reason.access.view'] as string;
    expect(pseudo.length).toBeGreaterThan(source.length * 1.3);
  });

  it('mark the right-to-left pseudo-locale and load both on demand', async () => {
    expect(bidi().dir).toBe('rtl');
    const strings = new Strings();
    await strings.setLocale('ar-XB');
    expect(strings.current.dir).toBe('rtl');
    expect(strings.current.t('toolbar.label')).toBe('‮Editing‬');
    await strings.setLocale('ar');
    // Without an Arabic table the interface stays in English, left to right.
    expect(strings.current.locale).toBe('en-GB');
    expect(strings.current.dir).toBe('ltr');
  });
});
