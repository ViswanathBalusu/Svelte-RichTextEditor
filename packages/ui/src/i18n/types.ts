/**
 * Shapes of the string tables (UX-064). Kept apart from the catalogue so that the source table and
 * the lazily loaded ones import nothing but types.
 */

/** Plural forms of one message, by `Intl.PluralRules` category; `other` is required. */
export interface PluralMessage {
  readonly zero?: string;
  readonly one?: string;
  readonly two?: string;
  readonly few?: string;
  readonly many?: string;
  readonly other: string;
}

export type Message = string | PluralMessage;

export type StringTable = Readonly<Record<string, Message>>;

/** A table for one locale, optionally with its writing direction (pseudo-locales set it). */
export interface LocaleTable {
  readonly strings: StringTable;
  readonly dir?: 'ltr' | 'rtl';
}

/** Loads a table on demand (a dynamic `import()`, so it is a separate chunk). */
export type TableLoader = () => Promise<LocaleTable>;

export type MessageParams = Readonly<Record<string, string | number>>;
