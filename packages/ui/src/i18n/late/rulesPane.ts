/**
 * The strings of the `rulesPane` group of the source table (UX-064; 13 §8) that only code loaded on
 * demand shows. The files that use them import this module, which adds them to the source table
 * (`source.ts`) when it is evaluated; the first load does not carry them (FND-008). The core
 * table is `en-GB-core.ts`; `en-GB.ts` is the whole table.
 */
import { registerSource } from '../source.ts';
import type { StringTable } from '../types.ts';

export const EN_GB_RULES_PANE = {
  // The rule builder (FRW-024; 12 §5, §11). Every fragment of a rule's sentence is a string here.
  'rule.title': 'Rules',
  'rule.none': 'This document has no rules.',
  'rule.readOnly': 'You cannot change the rules of this document.',
  'rule.sentence': 'If {left} {operator} {right}, {then}.',
  'rule.sentence.otherwise': 'If {left} {operator} {right}, {then}; otherwise {otherwise}.',
  'rule.and': ' and ',
  'rule.op.eq': 'is',
  'rule.op.ne': 'is not',
  'rule.op.lt': 'is less than',
  'rule.op.le': 'is at most',
  'rule.op.gt': 'is more than',
  'rule.op.ge': 'is at least',
  'rule.json':
    'This rule is not in sentence form, so it is shown as it is stored and cannot be changed here.',
  'rule.add': 'Add a rule',
  'rule.edit': 'Change rule {id}',
  'rule.delete': 'Delete rule {id}',
  'rule.problems': 'The rule was not saved:',
  'rule.saved': 'The rule was saved.',
  'rule.deleted': 'The rule was deleted.',
  'rule.unchanged': 'Nothing has changed.',
  'rule.goTo': 'Go to field {key}',
} as const satisfies StringTable;

registerSource(EN_GB_RULES_PANE);
