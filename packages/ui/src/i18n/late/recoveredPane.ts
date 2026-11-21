/**
 * The strings of the `recoveredPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_RECOVERED_PANE = {
  // Recovered edits (UX-017). The text is the author's own.
  'recovered.label': 'Recovered edits',
  'recovered.empty': 'Nothing has been set aside.',
  'recovered.why.permission': 'Not saved: your permissions changed',
  'recovered.why.readOnly': 'Not saved: the document became read-only',
  'recovered.why.invalid': 'Not saved: the service did not accept it',
  'recovered.why.conflict': 'Not saved: it conflicted with another change',
  'recovered.why.field': 'Not saved: the value is not valid',
  'recovered.why.tooLarge': 'Not saved: it is too large',
  'recovered.why.rebase': 'Not saved: it could not be combined with other changes',
  'recovered.why.reload': 'Not saved: the document was reloaded',
  'recovered.why.other': 'Not saved',
  'recovered.region': 'Region: {title}',
  'recovered.part.body': 'Part: the body',
  'recovered.part.definitions': 'Part: the definitions',
  'recovered.part.headerFooter': 'Part: the header or footer',
  'recovered.part.document': 'Part: the whole document',
  'recovered.changedBy': 'Permission changed by {name}',
  'recovered.changedByAt': 'Permission changed by {name} on {when}',
  'recovered.copy': 'Copy',
  'recovered.insert': 'Insert at the cursor',
  'recovered.discard': 'Discard',
  'recovered.discard.question': 'Discard this text for good? This cannot be undone.',
  'recovered.discard.confirm': 'Discard for good',
  'recovered.discard.keep': 'Keep it',
  'announce.recovered.copied': 'Copied.',
  'announce.recovered.copyFailed': 'The text could not be copied.',
  'announce.recovered.inserted': 'Inserted at the cursor.',
  'announce.recovered.notInserted': 'The text could not be inserted here.',
  'announce.recovered.discarded': 'Discarded.',
} as const satisfies StringTable;

registerSource(EN_GB_RECOVERED_PANE);
