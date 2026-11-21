/**
 * The strings of the `outlinePane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_OUTLINE_PANE = {
  // Navigation pane (UX-020). Headings and matches are content.
  'outline.label': 'Headings',
  'outline.empty': 'No headings',
  'search.label': 'Search the document',
  'search.field': 'Search for',
  'search.matchCase': 'Match case',
  'search.run': 'Search',

  // Page thumbnails of the navigation pane (UX-021), offered while the view on screen has pages.
  'outline.tabs': 'Navigate by',
  'pages.label': 'Pages',
  'pages.thumbnail': 'Page {page} of {pages}',

  // Other words for a command, for the command search (UX-011 criterion 2; proposed in
  // docs/adr/0383-w3-UX-011-command-synonyms.md). One key per command, `synonyms.<command id>`,
  // and the words are separated by semicolons. A locale lists the words people use in that locale.
  'search.gone': 'That place is no longer in the document.',
} as const satisfies StringTable;

registerSource(EN_GB_OUTLINE_PANE);
