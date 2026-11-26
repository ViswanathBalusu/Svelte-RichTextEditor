/**
 * The strings of the `participantsPane` group of the source table (UX-064; 13 §8) that only code
 * loaded on demand shows: the participants of the workflow, in the roles pane (FRW-026). The files
 * that use them import this module, which adds them to the source table (`source.ts`) when it is
 * evaluated. Names and `sub` values are the owner's or the host's text, not strings of the editor.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_PARTICIPANTS_PANE = {
  'participants.label': 'Participants of the workflow',
  'participants.heading': 'Participants',
  'participants.intro':
    'People with the same order act together. A person with a higher order acts after everyone with a lower order has finished.',
  'participants.empty': 'Nobody is bound to the roles of this document yet.',
  'participants.readOnly': 'Changing the participants needs permission to manage the document.',
  'participants.notDraft':
    'The document has been sent, so its participants can no longer be changed.',
  'participants.unnamed': 'Unnamed participant',
  'participants.sub': 'Identifier: {sub}',
  'participants.kind': 'Role in the workflow: {kind}',
  'participants.order': 'Order {order}',
  'participants.roles': 'Roles: {roles}',
  'participants.state': 'State: {state}',
  'participants.kind.filler': 'fills fields',
  'participants.kind.signer': 'signs',
  'participants.kind.approver': 'approves',
  'participants.kind.cc': 'receives a copy',
  'participants.state.pending': 'waiting',
  'participants.state.active': 'active',
  'participants.state.completed': 'finished',
  'participants.state.declined': 'declined',
  'participants.add': 'Add participant',
  'participants.edit': 'Edit participant',
  'participants.edit.name': 'Edit participant {name}',
  'participants.remove': 'Remove',
  'participants.remove.name': 'Remove {name}',
  'participants.save': 'Save',
  'participants.cancel': 'Cancel',
  'participants.field.name': 'Name',
  'participants.field.sub': 'Identifier at the host',
  'participants.hint.sub':
    'The host knows the person by this identifier. No e-mail address or telephone number is kept here.',
  'participants.field.roles': 'Roles this person acts for',
  'participants.field.kind': 'Role in the workflow',
  'participants.field.order': 'Order',
  'participants.hint.order':
    'A whole number from 1. The same number means together, a higher number means later.',
  'participants.error.roles': 'Choose at least one role.',
  'participants.error.name': 'Give a name or an identifier.',
  'participants.error.order': 'The order must be a whole number from 1.',
  'participants.error.kind': 'Choose what the person does.',
  'participants.error.invalid': 'Some values are not valid. Check the marked fields.',
  'participants.error.forbidden': 'You cannot change the participants of this document.',
  'participants.error.notDraft':
    'The document has been sent, so its participants can no longer be changed.',
  'participants.error.stale':
    'Someone else changed the participants first. The list shows their version. Try again.',
  'participants.error.failed': 'The participants could not be saved. Try again.',
  'announce.participants.saved': 'Participant saved.',
  'announce.participants.removed': 'Participant removed.',
} as const satisfies StringTable;

registerSource(EN_GB_PARTICIPANTS_PANE);
