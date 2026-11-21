/**
 * The strings of the `shortcutsPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_SHORTCUTS_PANE = {
  // Keyboard shortcuts (UX-013): the reference, built from the registry and the shortcut table.
  'shortcuts.label': 'Keyboard shortcuts',
  'shortcuts.command': 'Command',
  'shortcuts.keys': 'Keys',
  'shortcuts.when': 'When',
  'shortcuts.or': 'or',
  'shortcuts.always': 'Anywhere in the editor',
} as const satisfies StringTable;

registerSource(EN_GB_SHORTCUTS_PANE);
