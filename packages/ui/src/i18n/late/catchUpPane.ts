/**
 * The strings of the `catchUpPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_CATCH_UP_PANE = {
  // The catch-up pane (HIS-028; 08 §10).
  'catchUp.label': 'Catch up',
  'catchUp.unavailable': 'Catch up is not available for this document.',
  'catchUp.loading': 'Looking for changes since your last visit.',
  'catchUp.empty': 'Nothing has changed since your last visit.',
  'catchUp.error': 'The changes since your last visit could not be loaded.',
  'catchUp.forbidden': 'You cannot see the changes since your last visit.',
  'catchUp.retry': 'Try again',
  'catchUp.announce': {
    one: '{count} change since your last visit.',
    other: '{count} changes since your last visit.',
  },
  'catchUp.foryou': 'For you',
  'catchUp.foryou.mention': '{name} mentioned you: {text}',
  'catchUp.foryou.mention.nobody': 'Someone mentioned you: {text}',
  'catchUp.foryou.task': 'A thread is assigned to you.',
  'catchUp.summary': 'Changes by region',
  'catchUp.changes': 'Changes',
  'catchUp.change.row': '{kind}, by {name}',
  'catchUp.change.row.nobody': '{kind}',
  'catchUp.comments': {
    one: '{count} comment by other people',
    other: '{count} comments by other people',
  },
  'catchUp.dismiss': 'Mark as seen',
  'catchUp.mark-failed': 'Your place could not be saved. Try again.',
} as const satisfies StringTable;

registerSource(EN_GB_CATCH_UP_PANE);
