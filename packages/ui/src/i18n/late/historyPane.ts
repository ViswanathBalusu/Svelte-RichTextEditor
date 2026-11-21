/**
 * The strings of the `historyPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_HISTORY_PANE = {
  // The history pane (HIS-009; 08 §4).
  'history.label': 'History',
  'history.unavailable': 'History is not available for this document.',
  'history.loading': 'Loading history.',
  'history.empty': 'No history matches these filters.',
  'history.error': 'The history could not be loaded.',
  'history.retry': 'Try again',
  'history.more': 'Load more history',
  'history.filters': 'Filters',
  'history.filter.named': 'Named versions only',
  'history.filter.region': 'Region',
  'history.filter.field': 'Field',
  'history.filter.user': 'Person',
  'history.filter.any': 'Any',
  'history.filter.clear': 'Clear filters',
  'history.active': 'Active filters',
  'history.chip.named': 'Named versions',
  'history.chip.region': 'Region: {name}',
  'history.chip.field': 'Field: {name}',
  'history.chip.user': 'Person: {name}',
  'history.named-only': 'You can see named versions only, so the rest of the history is not shown.',
  'history.group.range': '{from} to {to}',
  'history.group.changes': {
    one: '{count} change',
    other: '{count} changes',
  },
  'history.group.authors': 'Authors: {authors}',
  'history.group.assisted': 'Written by an assistant for {name}: {agent}',
  'history.group.origins': 'Origins: {origins}',
  'history.group.named': 'Named version',
  'history.version.by': 'Named by {name} at {time}',
  'history.version.open': 'Open this version',
  'history.version.open-at': 'Open this version, {when}',
  'history.view.label': 'Read-only version, {when}',
  'history.view.label.named': 'Read-only version {name}, {when}',
  'history.view.note': 'This is a read-only copy. Changes to the live document do not appear here.',
  'history.view.leave': 'Back to the live document',

  // Copy a version into a new document (HIS-022): the editor asks, the host makes the copy.
  'history.fork.request': 'Copy this version to a new document',
  'history.fork.requested': 'Asked to copy this version into a new document.',
  'history.view.opening': 'Opening this version.',
  'history.view.forbidden': 'You cannot open this version.',
  'history.view.not-found': 'This version no longer exists.',
  'history.view.failed': 'This version could not be opened.',

  // Who wrote this (HIS-015; 08 §7): authors are named in words, never by colour alone.
  'history.who.title': 'Who wrote this',
  'history.who.scope': 'Passage',
  'history.who.scope.document': 'The whole document',
  'history.who.scope.selection': 'The selected passage',
  'history.who.scope.region': 'Region: {name}',
  'history.who.ask': 'Show who wrote this',
  'history.who.loading': 'Looking up who wrote this.',
  'history.who.nothing-selected': 'Select a passage in the version first.',
  'history.who.empty': 'No text is recorded for this passage.',
  'history.who.failed': 'Who wrote this could not be found.',
  'history.who.forbidden': 'You cannot see who wrote this version.',
  'history.who.line': {
    one: '{name}: {count} passage, from {first} to {last}.',
    other: '{name}: {count} passages, from {first} to {last}.',
  },
  'history.who.assistant': 'Written by an assistant ({agent}) for this person.',
  'history.who.restored': 'Brought back by {by}.',

  // Comparing two versions (HIS-013; 08 §6).
  'history.compare.title': 'Compare versions',
  'history.compare.from': 'Older version',
  'history.compare.to': 'Newer version',
  'history.compare.current': 'Current document',
  'history.compare.run': 'Compare',
  'history.compare.option.group': 'Changes up to {when}',
  'history.compare.option.version': '{name}, {when}',
  'history.compare.loading': 'Comparing the versions.',
  'history.compare.none': 'These versions have no differences.',
  'history.compare.failed': 'The versions could not be compared.',
  'history.compare.forbidden': 'You cannot compare these versions.',
  'history.compare.navigate': 'Move between changes',
  'history.compare.previous': 'Previous change',
  'history.compare.next': 'Next change',
  'history.compare.deletions': 'Show deleted text',
  'history.compare.announce': 'Change {n} of {m}: {kind}, by {name}',
  'history.compare.announce.assistant':
    'Change {n} of {m}: {kind}, written by an assistant ({agent}) for {name}',
  'history.compare.assistant.title': 'Written by assistants',
  'history.compare.assistant.row':
    'Change {n}: {kind}, written by an assistant ({agent}) for {name}',
  'history.compare.announce.nobody': 'Change {n} of {m}: {kind}',
  'history.compare.summary': 'Summary by region',
  'history.compare.fields': 'Field changes',
  'history.compare.field.row': '{field} was changed by {name}',

  // Restoring a version (HIS-021; 08 §8): a preview first, then a confirmation.
  'history.restore.title': 'Restore this version',
  'history.restore.scope': 'What to restore',
  'history.restore.scope.document': 'The whole document',
  'history.restore.scope.region': 'Region: {name}',
  'history.restore.preview.run': 'Preview the restore',
  'history.restore.previewing': 'Working out what the restore would change.',
  'history.restore.preview': {
    one: 'Restoring would make {count} change. Nothing has been changed yet.',
    other: 'Restoring would make {count} changes. Nothing has been changed yet.',
  },
  'history.restore.unchanged':
    'Restoring would change nothing: the document already matches this version.',
  'history.restore.target': 'To be restored: {what}',
  'history.restore.recreated': 'These definitions would be brought back: {names}.',
  'history.restore.replaced':
    'These definitions no longer exist and you cannot bring them back, so the default is used instead: {names}.',
  'history.restore.confirm': 'Restore now',
  'history.restore.cancel': 'Cancel the restore',
  'history.restore.restoring': 'Restoring.',
  'history.restore.done':
    'The document was restored. The state before the restore is kept in the history.',
  'history.restore.refused.forbidden': 'You cannot restore this.',
  'history.restore.refused.not-found': 'This version, or this region in it, no longer exists.',
  'history.restore.refused.conflict':
    'The restore does not fit the document as it is now: it has changed, or a region is approved or in use. Preview the restore again.',
  'history.restore.refused.workflow': 'A workflow is active, so the document cannot be restored.',
  'history.restore.refused.too-large': 'This restore is too large to apply.',
  'history.restore.refused.preview-failed': 'The restore could not be previewed.',
  'history.restore.refused.failed': 'The restore could not be applied.',
} as const satisfies StringTable;

registerSource(EN_GB_HISTORY_PANE);
