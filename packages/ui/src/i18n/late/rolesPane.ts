/**
 * The strings of the `rolesPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_ROLES_PANE = {
  // The roles manager and the legend (FRW-074). Role names and field labels are the document's.
  'roles.label': 'Roles of this document',
  'roles.empty': 'This document has no roles.',
  'roles.readOnly': 'Changing the roles needs permission to change the structure of the document.',
  'roles.noFields': 'No field is assigned to this role.',
  'roles.fieldCount': {
    one: '{count} field is assigned to this role.',
    other: '{count} fields are assigned to this role.',
  },
  'roles.icon': 'Shape: {icon}',
  'roles.add': 'Add role',
  'roles.edit': 'Edit role',
  'roles.edit.name': 'Edit role {role}',
  'roles.delete': 'Delete',
  'roles.delete.name': 'Delete {role}',
  'roles.save': 'Save',
  'roles.cancel': 'Cancel',
  'roles.field.name': 'Name',
  'roles.field.color': 'Colour',
  'roles.hint.color': 'The colour is always shown with the shape of the role, never alone.',
  'roles.error.readOnly': 'You cannot change the roles of this document.',
  'roles.error.duplicate': 'The document already has this role.',
  'roles.error.gone': 'This role is no longer in the document.',
  'roles.error.noChange': 'Nothing was changed.',
  'roles.error.noFeature': 'This service does not offer forms, so this document cannot have roles.',
  'roles.error.invalid': 'Some values are not valid. Check the marked fields.',
  'roles.error.inUse': 'Fields are still assigned to this role, so it cannot be deleted. They are:',
  'announce.roles.added': 'Role added.',
  'announce.roles.changed': 'Role changed.',
  'announce.roles.deleted': 'Role deleted.',

  // Preview as a role (FRW-075). Role names are content.
  'announce.rolePreview.failed': 'The preview could not start.',
  'roles.preview': 'Preview',
  'roles.preview.name': 'Preview as {role}',
} as const satisfies StringTable;

registerSource(EN_GB_ROLES_PANE);
