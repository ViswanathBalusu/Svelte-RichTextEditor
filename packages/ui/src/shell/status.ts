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
