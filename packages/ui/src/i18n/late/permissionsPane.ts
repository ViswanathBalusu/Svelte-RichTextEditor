/**
 * The strings of the `permissionsPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_PERMISSIONS_PANE = {
  // Regions and permissions (PRM-026, PRM-033, PRM-035, PRM-036). Titles and names are content.
  'permissions.label': 'Permissions',
  'permissions.regions': 'Regions',
  'permissions.empty': 'This document has no regions.',
  'permissions.rename.label': 'Name of the region',
  'permissions.rename.save': 'Rename',
  'permissions.rename.done': 'Region renamed.',
  'permissions.rename.failed': 'The region could not be renamed.',
  'permissions.rename.noStructure':
    'Only people who can change the structure of the document can rename a region.',
  'permissions.rename.noEdit': 'You cannot edit this region, so you cannot rename it.',
  'permissions.grants': 'People and groups with a role',
  'permissions.grants.none': 'Nobody has a role on this region.',
  'permissions.add': 'Give a role',
  'permissions.search': 'Find a person or group',
  'permissions.search.none': 'Nobody found.',
  'permissions.search.unavailable':
    'The application around the editor offers no directory, so nobody can be found.',
  'permissions.candidates': 'People and groups found',
  'permissions.role': 'Role',
  'permissions.expiry': 'Until (optional)',
  'permissions.save': 'Save',
  'permissions.remove': 'Remove the role of {name}',
  'permissions.saved': 'Permissions saved.',
  'permissions.conflict':
    'Someone else changed the permissions first. The current ones are shown; nothing of yours was saved.',
  'permissions.failed': 'The permissions could not be saved.',
  'permissions.loadFailed': 'The permissions could not be loaded.',
  'permissions.readOnly': 'Only people who manage the document can change who may edit.',
  'permissions.stateChange.label': 'State of the region',
  'permissions.stateChange.save': 'Change state',
  'permissions.stateChange.changed': 'The state of the region was changed.',
  'permissions.stateChange.failed': 'The state of the region could not be changed.',
  'lease.heading': 'Check-out',
  'lease.help': 'Checking a region out lets you edit it alone for a short time.',
  'lease.checkOut': 'Check out',
  'lease.release': 'Release',
  'lease.mine': 'You have this region checked out. Nobody else can edit it until you release it.',
  'lease.other': '{name} has this region checked out.',
  'lease.approved': 'An approved region cannot be checked out.',
  'lease.noEdit': 'You need to be able to edit this region to check it out.',
  'lease.taken': 'Checked out.',
  'lease.released': 'Released.',
  'lease.conflict': 'Someone else has this region checked out.',
  'lease.forbidden': 'You cannot check this region out.',
  'lease.failed': 'The check-out could not be changed. Try again.',
} as const satisfies StringTable;

registerSource(EN_GB_PERMISSIONS_PANE);
