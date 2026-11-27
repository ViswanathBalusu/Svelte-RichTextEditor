/**
 * The strings of the `checkerPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_CHECKER_PANE = {
  // The accessibility checker pane (UX-066, UX-067): kinds grouped, each issue with its block.
  'checker.unavailable': 'The checker needs the document, which this editor does not give.',
  'checker.none': 'No accessibility issues found.',
  'checker.count': '{count} accessibility issues found.',
  'checker.kind.alt-text': 'Missing alternative text',
  'checker.kind.heading-order': 'Heading level skipped',
  'checker.kind.table-header': 'Table without a header row',
  'checker.kind.link-text': 'Link text does not describe the link',
  'checker.kind.contrast': 'Text contrast too low',
  'checker.explain.alt-text': 'The picture or figure has no alternative text.',
  'checker.explain.heading-order': 'A level {from} heading is followed by a level {to} heading.',
  'checker.explain.table-header': 'The table has no header row.',
  'checker.explain.link-text.empty': 'The link has no text.',
  'checker.explain.link-text.generic': 'The link text is generic, such as "click here".',
  'checker.explain.contrast': 'The contrast is {ratio} to 1; at least 4.5 to 1 is needed.',
  'checker.block': 'Block {id}',
  'checker.go': 'Go to this block',
  'checker.fixable': 'You can fix this here.',
  'checker.locked': 'You cannot fix this. Ask someone who can.',
  'checker.locked.who': 'You cannot fix this. {who}',
  // The fix each kind of issue offers (UX-067 criterion 2).
  'checker.fix.alt-text.label': 'Alternative text',
  'checker.fix.alt-text': 'Set alternative text',
  'checker.fix.link-text.label': 'Link text',
  'checker.fix.link-text': 'Change link text',
  'checker.fix.table-header': 'Make the first row a header row',
  'checker.fix.heading-order': 'Change to heading level {level}',
  'checker.fix.contrast.black': 'Use black text',
  'checker.fix.contrast.white': 'Use white text',
  'checker.fix.done': 'Fixed.',
  'checker.fix.failed': 'This could not be changed.',
} as const satisfies StringTable;

registerSource(EN_GB_CHECKER_PANE);
