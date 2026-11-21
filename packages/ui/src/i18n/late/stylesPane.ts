/**
 * The strings of the `stylesPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_STYLES_PANE = {
  // Styles (UX-022). Style names are content.
  'styles.label': 'Styles of this document',
  'styles.kind.paragraph': 'Paragraph style',
  'styles.kind.character': 'Character style',
  'styles.kind.table': 'Table style',
  'styles.current': 'In use at the cursor',
  'styles.empty': 'This document defines no styles.',
  'styles.manage': 'Manage styles',
  'styles.new': 'New style',
  'styles.new.name': 'Name of the style',
  'styles.new.kind': 'Kind of style',
  'styles.new.basedOn': 'Based on',
  'styles.new.noParent': 'No parent style',
  'styles.new.save': 'Create',
  'styles.new.cancel': 'Cancel',
  'styles.new.done': 'Style created.',
  'styles.change': 'Change style {name}',
  'styles.change.action': 'Change',
  'styles.delete.action': 'Delete',
  'styles.change.label': 'Change the style {name}',
  'styles.change.save': 'Save',
  'styles.change.done': 'Style changed.',
  'styles.delete': 'Delete style {name}',
  'styles.delete.done': 'Style deleted.',
  'styles.edit.failed': 'The style could not be saved.',
} as const satisfies StringTable;

registerSource(EN_GB_STYLES_PANE);
