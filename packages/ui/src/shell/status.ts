/**
 * What the status bar shows about the language (UX-018 criterion 3; 02 §7). The language at the
 * caret is the `lang` mark there when it has one, else the document's default language, else none.
 * The mark is the document's (a span of text), so the bar describes it and does not invent one.
 *
 * The words are the component's: this module decides which source applies, which keeps the rule
 * testable without a DOM or a translator.
 */

export type LanguageAt =
  | { readonly source: 'mark'; readonly tag: string }
  | { readonly source: 'document'; readonly tag: string }
  | { readonly source: 'none' };

/** Blank or missing tags count as none, so an empty mark never hides the document's language. */
function tagOf(value: string | null | undefined): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : null;
}

/**
 * The names English gives to the regional forms of a language (CLDR, `languageDisplay: 'dialect'`).
 * `Intl.DisplayNames` gives them in Chrome, Firefox and WebKit; Microsoft Edge on Linux answers
 * "English (United Kingdom)" for the same call (seen on the hosted runner). The status bar and the
 * language dialog must say the same words in every browser, so the English names are fixed here.
 */
const ENGLISH_DIALECTS: Readonly<Record<string, string>> = {
  'en-au': 'Australian English',
  'en-ca': 'Canadian English',
  'en-gb': 'British English',
  'en-us': 'American English',
  'es-419': 'Latin American Spanish',
  'es-es': 'European Spanish',
  'es-mx': 'Mexican Spanish',
  'fr-ca': 'Canadian French',
  'fr-ch': 'Swiss French',
  'pt-br': 'Brazilian Portuguese',
  'pt-pt': 'European Portuguese',
};

/** The name of a language tag in the language of the interface; the tag itself when it has none. */
export function languageName(tag: string, locale: string): string {
  if (/^en(-|$)/i.test(locale)) {
    const fixed = ENGLISH_DIALECTS[tag.toLowerCase()];
    if (fixed) return fixed;
  }
  try {
    return (
      new Intl.DisplayNames([locale], { type: 'language', languageDisplay: 'dialect' }).of(tag) ??
      tag
    );
  } catch {
    return tag;
  }
}

export function languageAt(
  markAtCaret: string | null | undefined,
  documentDefault: string | null | undefined,
): LanguageAt {
  const mark = tagOf(markAtCaret);
  if (mark) return { source: 'mark', tag: mark };
  const fallback = tagOf(documentDefault);
  if (fallback) return { source: 'document', tag: fallback };
  return { source: 'none' };
}
