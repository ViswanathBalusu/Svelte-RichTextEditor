/**
 * The strings of the `sourcesPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_SOURCES_PANE = {
  // Sources (UX-103). Titles, names, identifiers and excerpts are content.
  'sources.label': 'Sources of this document',
  'sources.empty': 'This document has no sources.',
  'sources.readOnly':
    'You can cite these sources. Changing them needs permission to change the structure of the document.',
  'sources.notCited': 'Not cited.',
  'sources.citedCount': { one: 'Cited in {count} place.', other: 'Cited in {count} places.' },
  'sources.citedNoText': 'A block without text',
  'sources.cite': 'Cite',
  'sources.cite.name': 'Cite {source}',
  'sources.edit': 'Edit source',
  'sources.edit.name': 'Edit {source}',
  'sources.delete': 'Delete',
  'sources.delete.name': 'Delete {source}',
  'sources.add': 'Add source',
  'sources.import': 'Import sources from a file',
  'sources.save': 'Save',
  'sources.cancel': 'Cancel',
  'sources.field.id': 'Key',
  'sources.field.kind': 'Type',
  'sources.field.title': 'Title',
  'sources.field.authors': 'Authors',
  'sources.field.issued': 'Date',
  'sources.field.container': 'Journal, book or site',
  'sources.field.doi': 'DOI',
  'sources.field.url': 'Web address',
  'sources.hint.id': 'Letters, digits, hyphens and underscores. It cannot be changed later.',
  'sources.hint.authors': 'Family name, given name; separate people with a semicolon.',
  'sources.hint.issued': 'A year, a year and month, or a full date: 2026, 2026-11 or 2026-11-06.',
  'sources.error.readOnly': 'You cannot change the sources of this document.',
  'sources.error.duplicate': 'The document already has a source with this key.',
  'sources.error.gone': 'This source is no longer in the document.',
  'sources.error.noChange': 'Nothing was changed.',
  'sources.error.invalid': 'Some values are not valid. Check the marked fields.',
  'sources.error.cited': 'This source is still cited, so it cannot be deleted. It is cited in:',
  'sources.error.cite': 'A citation cannot be inserted here.',
  'sources.import.result': 'Import result',
  'sources.import.created': { one: '{count} source added.', other: '{count} sources added.' },
  'sources.import.duplicate':
    'the key occurs more than once in the file (entry at {at}); not added.',
  'sources.import.exists': 'the document already has a source with this key; not added.',
  'sources.import.invalid': 'not valid ({fields}); not added.',
  'sources.import.problem': 'At {at}:',
  'announce.sources.added': 'Source added.',
  'announce.sources.changed': 'Source changed.',
  'announce.sources.deleted': 'Source deleted.',
  'announce.sources.cited': 'Citation inserted.',
  'announce.sources.imported': { one: '{count} source added.', other: '{count} sources added.' },
} as const satisfies StringTable;

registerSource(EN_GB_SOURCES_PANE);
