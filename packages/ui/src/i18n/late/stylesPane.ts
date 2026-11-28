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
  // Why a style cannot be changed (UX-022). Style names are content.
  'styles.why.read-only': 'The document is locked, so its styles cannot be changed.',
  'styles.why.suggestion':
    'You are suggesting changes, and a change to a style cannot be a suggestion.',
  'styles.why.no-access':
    'Creating, changing and deleting styles needs permission to change the structure of the document, which you do not have. You can still apply a style.',
  'styles.why.region': {
    one: 'This style is used in the region {regions}, which you cannot edit, so you cannot change it.',
    other:
      'This style is used in the regions {regions}, which you cannot edit, so you cannot change it.',
  },
  'styles.why.approved': {
    one: 'This style is used in the region {regions}, which is approved, so it cannot be changed.',
    other:
      'This style is used in the regions {regions}, which are approved, so it cannot be changed.',
  },
  'styles.why.built-in': 'A built-in style cannot be renamed or deleted.',
  'styles.why.in-use': 'This style is in use, so it cannot be deleted.',
  'styles.why.addOnly':
    'You may add a style. Changing or deleting a style needs the right to change the structure of the document.',
  'styles.why.duplicate-name': 'Another style of this kind has that name.',
  'styles.why.bad-name': 'Give the style a name.',
  'styles.why.bad-based-on':
    'A style can be based only on another style of its kind, and not on itself or on a style based on it.',
  'styles.why.unknown-style': 'That style is no longer in the document.',
} as const satisfies StringTable;

registerSource(EN_GB_STYLES_PANE);
