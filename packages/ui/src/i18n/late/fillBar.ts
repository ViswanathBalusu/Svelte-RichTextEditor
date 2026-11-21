/**
 * The strings of the `fillBar` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_FILL_BAR = {
  // Fill mode (FRW-076, FRW-078). Field labels are content.
  'fill.label': 'Filling in',
  'fill.next': 'Next field to fill',
  'fill.finish': 'Finish',
  'fill.summary': 'What is left',
  'fill.waiting': 'It is not your turn yet. Your fields open when it is.',
  'fill.paused': 'Filling in is paused.',

  // The access code of a participant (FRW-039). The code is never shown back or kept.
  'accessCode.label': 'Access code',
  'accessCode.hint': 'Enter the code you were given to start filling in.',
  'accessCode.submit': 'Submit code',
  'accessCode.wrong': 'That code is not right. Check it and try again.',
  'accessCode.rateLimited': {
    one: 'Too many attempts. Try again in {count} second.',
    other: 'Too many attempts. Try again in {count} seconds.',
  },
  'accessCode.failed': 'The code could not be checked. Try again.',
  'accessCode.accepted': 'Code accepted. You can fill in the document.',
  'fill.done': 'All required fields are filled.',
} as const satisfies StringTable;

registerSource(EN_GB_FILL_BAR);
