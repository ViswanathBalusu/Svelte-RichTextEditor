/**
 * The string catalogue (UX-064; 13 §8; 02 §11). Plain TypeScript: the shell reads the current
 * translator through `view` (a ReadView, like the core's views), and the element sets the locale
 * from its `locale` attribute.
 *
 * - The core of the source table (British English) is bundled (`source.ts`); the strings that
 *   only code loaded on demand shows load with that code (`late/*.ts`; FND-008). Every other table
 *   loads on demand through a loader, which is a dynamic `import()` and therefore a separate chunk.
 * - A BCP 47 tag is matched exactly, then by its language and script, then by its language, then
 *   the default table is used. Keys a table lacks fall back to the default table and are reported
 *   once per locale through `onMissing` (development).
 * - Host replacements are keyed by string key (13 §8; the mechanism UX-063 builds on); unknown keys
 *   are reported through `onUnknown`. Every result is a plain string, so the shell renders it as
 *   text and never as markup.
 * - Plurals use `Intl.PluralRules` and numbers `Intl.NumberFormat` for the table's locale.
 */
import type { ReadView } from '../core-api.ts';
import type { StringKey } from './en-GB.ts';
import { SOURCE_TABLE, isSourceKey } from './source.ts';
import type {
  LocaleTable,
  Message,
  MessageParams,
  PluralMessage,
  StringTable,
  TableLoader,
} from './types.ts';

export const DEFAULT_LOCALE = 'en-GB';

/** Languages written right to left (for tables that do not say). */
const RTL_LANGUAGES = new Set([
  'ar',
  'ckb',
  'dv',
  'fa',
  'he',
  'ku',
  'ps',
  'sd',
  'syr',
  'ug',
  'ur',
  'yi',
]);

/** Tables the package ships besides the source table. Pseudo-locales only, for now (UX-064). */
export const BUILT_IN_LOADERS: Readonly<Record<string, TableLoader>> = {
  'en-XA': () => import('./pseudo.ts').then((m) => m.accented()),
  'ar-XB': () => import('./pseudo.ts').then((m) => m.bidi()),
};

export interface Translator {
  /** The tag that was asked for. */
  readonly requested: string;
  /** The tag of the table in use. */
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
  /** The message for a key, with parameters and plural forms resolved. */
  t(key: StringKey, params?: MessageParams): string;
  /** Like `t`, for keys that are only known at run time (extension strings, composed keys). */
  text(key: string, params?: MessageParams): string;
  has(key: string): boolean;
  number(value: number): string;
  date(value: Date, options?: Intl.DateTimeFormatOptions): string;
}

export interface StringsOptions {
  locale?: string;
  /** Tables by BCP 47 tag, loaded on first use; merged over `BUILT_IN_LOADERS`. */
  loaders?: Readonly<Record<string, TableLoader>>;
  /** Host replacements by key. */
  overrides?: StringTable;
  /** Keys a locale's table lacks, reported once per locale (development). */
  onMissing?: (locale: string, keys: readonly string[]) => void;
  /** Override keys that no table knows (development). */
  onUnknown?: (keys: readonly string[]) => void;
  /** A loader failed; the default table stays in use. */
  onError?: (locale: string, error: unknown) => void;
}

/** Canonical tag, or null when the tag is not valid BCP 47. */
function canonical(tag: string): string | null {
  try {
    return Intl.getCanonicalLocales(tag)[0] ?? null;
  } catch {
    return null;
  }
}

/** The tags to try for a requested tag, most specific first, ending with the default. */
export function candidates(tag: string): string[] {
  const out: string[] = [];
  const c = canonical(tag);
  if (c) {
    out.push(c);
    const locale = new Intl.Locale(c);
    if (locale.script) out.push(`${locale.language}-${locale.script}`);
    out.push(locale.language);
  }
  out.push(DEFAULT_LOCALE);
  return [...new Set(out)];
}

function directionOf(tag: string, table: LocaleTable | null): 'ltr' | 'rtl' {
  if (table?.dir) return table.dir;
  const c = canonical(tag);
  if (!c) return 'ltr';
  const locale = new Intl.Locale(c);
  if (locale.script === 'Arab' || locale.script === 'Hebr') return 'rtl';
  if (locale.script) return 'ltr';
  return RTL_LANGUAGES.has(locale.language) ? 'rtl' : 'ltr';
}

function isMessage(value: unknown): value is Message {
  if (typeof value === 'string') return true;
  if (!value || typeof value !== 'object') return false;
  const forms = value as Record<string, unknown>;
  return (
    typeof forms['other'] === 'string' && Object.values(forms).every((v) => typeof v === 'string')
  );
}

function pluralCategory(locale: string, count: number): keyof PluralMessage {
  return new Intl.PluralRules(locale).select(count) as keyof PluralMessage;
}

class TranslatorImpl implements Translator {
  readonly requested: string;
  readonly locale: string;
  readonly dir: 'ltr' | 'rtl';
  readonly #table: StringTable;
  readonly #overrides: StringTable;
  readonly #numbers: Intl.NumberFormat;

  constructor(
    requested: string,
    locale: string,
    dir: 'ltr' | 'rtl',
    table: StringTable,
    overrides: StringTable,
  ) {
    this.requested = requested;
    this.locale = locale;
    this.dir = dir;
    this.#table = table;
    this.#overrides = overrides;
    this.#numbers = new Intl.NumberFormat(locale);
  }

  #message(key: string): Message | undefined {
    return this.#overrides[key] ?? this.#table[key] ?? SOURCE_TABLE[key];
  }

  has(key: string): boolean {
    return this.#message(key) !== undefined;
  }

  t(key: StringKey, params?: MessageParams): string {
    return this.text(key, params);
  }

  text(key: string, params?: MessageParams): string {
    const message = this.#message(key);
    // An unknown key shows itself: visible in development, never an empty control.
    if (message === undefined) return key;
    let text: string;
    if (typeof message === 'string') text = message;
    else {
      const count = params?.['count'];
      const category = typeof count === 'number' ? pluralCategory(this.locale, count) : 'other';
      text = message[category] ?? message.other;
    }
    if (!params) return text;
    return text.replace(/\{([A-Za-z]+)\}/g, (whole, name: string) => {
      const value = params[name];
      if (value === undefined) return whole;
      return typeof value === 'number' ? this.#numbers.format(value) : value;
    });
  }

  number(value: number): string {
    return this.#numbers.format(value);
  }

  date(value: Date, options?: Intl.DateTimeFormatOptions): string {
    return new Intl.DateTimeFormat(this.locale, options).format(value);
  }
}

export class Strings {
  readonly #loaders: Readonly<Record<string, TableLoader>>;
  readonly #loaded = new Map<string, LocaleTable>();
  readonly #loading = new Map<string, Promise<LocaleTable | null>>();
  readonly #reported = new Set<string>();
  readonly #listeners = new Set<() => void>();
  readonly #options: StringsOptions;
  #overrides: StringTable = {};
  #current: Translator;
  #request = 0;

  readonly view: ReadView<Translator>;

  constructor(options: StringsOptions = {}) {
    this.#options = options;
    this.#loaders = { ...BUILT_IN_LOADERS, ...options.loaders };
    this.#loaded.set(DEFAULT_LOCALE, { strings: SOURCE_TABLE, dir: 'ltr' });
    this.#loaded.set('en', { strings: SOURCE_TABLE, dir: 'ltr' });
    this.#setOverrides(options.overrides ?? {});
    this.#current = this.#translator(DEFAULT_LOCALE, DEFAULT_LOCALE);
    this.view = {
      get: () => this.#current,
      subscribe: (listener) => {
        this.#listeners.add(listener);
        return () => this.#listeners.delete(listener);
      },
    };
    if (options.locale) void this.setLocale(options.locale);
  }

  /** The translator in use (the same object `view.get()` returns). */
  get current(): Translator {
    return this.#current;
  }

  /** Whether the source table knows a key (the registry checks command labels with it). */
  has(key: string): boolean {
    return Object.hasOwn(SOURCE_TABLE, key) || Object.hasOwn(this.#overrides, key);
  }

  /**
   * Switches to the best table for a BCP 47 tag, loading it on demand. Resolves once the new
   * translator is in use. A later call wins over an earlier one that is still loading.
   */
  async setLocale(tag: string): Promise<void> {
    const request = ++this.#request;
    for (const candidate of candidates(tag)) {
      const table = this.#loaded.get(candidate) ?? (await this.#load(candidate));
      if (request !== this.#request) return;
      if (!table) continue;
      this.#report(candidate, table);
      this.#publish(this.#translator(tag, candidate));
      return;
    }
  }

  /** Replaces the host's string replacements (by key). */
  setOverrides(overrides: StringTable): void {
    this.#setOverrides(overrides);
    this.#publish(this.#translator(this.#current.requested, this.#current.locale));
  }

  #setOverrides(overrides: StringTable): void {
    const accepted: Record<string, Message> = {};
    const unknown: string[] = [];
    for (const [key, message] of Object.entries(overrides)) {
      if (!isSourceKey(key)) unknown.push(key);
      // A value that is not a message is ignored: a host string is only ever text.
      if (isMessage(message)) accepted[key] = message;
    }
    if (unknown.length) this.#options.onUnknown?.(unknown);
    this.#overrides = accepted;
  }

  async #load(tag: string): Promise<LocaleTable | null> {
    const loader = this.#loaders[tag];
    if (!loader) return null;
    let pending = this.#loading.get(tag);
    if (!pending) {
      pending = loader().then(
        (table) => {
          this.#loaded.set(tag, table);
          return table;
        },
        (error: unknown) => {
          this.#options.onError?.(tag, error);
          return null;
        },
      );
      this.#loading.set(tag, pending);
    }
    return pending;
  }

  #report(tag: string, table: LocaleTable): void {
    if (this.#reported.has(tag) || tag === DEFAULT_LOCALE || tag === 'en') return;
    this.#reported.add(tag);
    const missing = Object.keys(SOURCE_TABLE).filter((key) => !Object.hasOwn(table.strings, key));
    if (missing.length) this.#options.onMissing?.(tag, missing);
  }

  /** Keys of the source table that a loaded locale lacks. */
  missing(tag: string): string[] {
    const table = this.#loaded.get(tag);
    if (!table) return [];
    return Object.keys(SOURCE_TABLE).filter((key) => !Object.hasOwn(table.strings, key));
  }

  #translator(requested: string, locale: string): Translator {
    const table = this.#loaded.get(locale) ?? null;
    return new TranslatorImpl(
      requested,
      locale,
      directionOf(locale, table),
      table?.strings ?? SOURCE_TABLE,
      this.#overrides,
    );
  }

  #publish(next: Translator): void {
    this.#current = next;
    for (const listener of [...this.#listeners]) listener();
  }
}

/** A translator for the source table, for code that runs before a catalogue exists. */
export function sourceTranslator(): Translator {
  return new TranslatorImpl(DEFAULT_LOCALE, DEFAULT_LOCALE, 'ltr', SOURCE_TABLE, {});
}
