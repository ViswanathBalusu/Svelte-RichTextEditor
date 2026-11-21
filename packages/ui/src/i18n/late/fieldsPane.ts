/**
 * The strings of the `fieldsPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_FIELDS_PANE = {
  // The field properties panel (FRW-073). Property names, reasons and the panel's own messages.
  'field.panel.title': 'Field properties',
  'field.panel.readOnly': 'These properties cannot be changed now.',
  'field.panel.apply': 'Apply',
  'field.panel.problems': 'Fix these before applying:',
  'field.panel.noRole': 'No role',
  'field.panel.optionsHint': 'One option per line, as identifier | label.',
  'field.panel.notApplied': 'Not applied. Fix the entries shown.',
  'field.panel.unchanged': 'Nothing has changed.',
  'field.panel.applied': 'Applied.',
  'field.panel.none': 'This document has no fields.',
  'field.panel.choose': 'Field',
  'field.panel.gone': 'This field is no longer in the document.',
  'field.panel.refused': 'Not applied. The document would not be valid with these properties.',
} as const satisfies StringTable;

registerSource(EN_GB_FIELDS_PANE);
