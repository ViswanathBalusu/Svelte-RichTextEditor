/**
 * The strings of the `reviewPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_REVIEW_PANE = {
  // What the review commands announce (UX-036). Counts are the suggestions handled and left pending.
  'review.gone': 'That suggestion has already been resolved.',

  // The review pane (UX-037).
  'review.pane.kind.insertion': 'Insertion',
  'review.pane.kind.deletion': 'Deletion',
  'review.pane.kind.formatting': 'Formatting change',
  'review.pane.kind.block': 'Block change',
  'review.pane.filter.author': 'Author',
  'review.pane.filter.everyone': 'Everyone',
  'review.pane.list': 'Suggestions',
  'review.pane.empty': 'There are no suggestions to show.',
  'review.pane.noText': 'no text',
  'review.pane.row.name': '{kind} by {author}: {excerpt}',
  'review.pane.row.nameAt': '{kind} by {author}, {time}: {excerpt}',
  'review.pane.show': 'Show',
  'review.pane.show.label': 'Show the suggestion by {author} in the document',
  'review.pane.accept': 'Accept',
  'review.pane.accept.label': 'Accept the suggestion by {author}',
  'review.pane.reject': 'Reject',
  'review.pane.reject.label': 'Reject the suggestion by {author}',
  'review.pane.acceptAll': 'Accept all',
  'review.pane.rejectAll': 'Reject all',
  'review.pane.acceptAllBy': 'Accept all by {author}',
  'review.pane.rejectAllBy': 'Reject all by {author}',
  'review.pane.filter.region': 'Region',
  'review.pane.filter.allRegions': 'The whole document',
  'review.pane.region.untitled': 'Untitled region',
  'review.pane.acceptAllIn': 'Accept all in {region}',
  'review.pane.rejectAllIn': 'Reject all in {region}',
  'review.pane.acceptAllByIn': 'Accept all by {author} in {region}',
  'review.pane.rejectAllByIn': 'Reject all by {author} in {region}',
} as const satisfies StringTable;

registerSource(EN_GB_REVIEW_PANE);
