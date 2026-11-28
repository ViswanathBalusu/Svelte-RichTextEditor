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
  // The rule builder (FRW-024; 12 §5, §11). Every fragment of a rule's sentence is a string here.
  'rule.effect.show': 'show {fields}',
  'rule.effect.hide': 'hide {fields}',
  'rule.effect.require': 'require {fields}',
  'rule.effect.enable': 'enable {fields}',
  'rule.effect.disable': 'disable {fields}',
  'rule.form.new': 'New rule',
  'rule.form.change': 'Change rule',
  'rule.form.id': 'Rule name',
  'rule.form.condition': 'Condition',
  'rule.form.left': 'Left side',
  'rule.form.right': 'Right side',
  'rule.form.operator': 'Comparison',
  'rule.form.kind': 'Kind of value',
  'rule.form.kind.field': 'A field',
  'rule.form.kind.literal': 'A value',
  'rule.form.field': 'Field',
  'rule.form.value': 'Value',
  'rule.form.then': 'Then',
  'rule.form.otherwise': 'Otherwise',
  'rule.form.hasOtherwise': 'Add an otherwise',
  'rule.form.effect': 'Effect',
  'rule.form.effectField': 'Field of the effect',
  'rule.form.addEffect': 'Add an effect',
  'rule.form.removeEffect': 'Remove this effect',
  'rule.form.choose': 'Choose a field',
  'rule.form.save': 'Save the rule',
  'rule.form.cancel': 'Cancel',
  'rule.form.preview': 'Sentence',
  'rule.problem.id': 'Give the rule a name.',
  'rule.problem.left': 'Choose the left side of the comparison.',
  'rule.problem.right': 'Give the right side of the comparison.',
  'rule.problem.effect': 'Give each effect a field.',
  'rule.problem.otherwiseEffect': 'Give each otherwise effect a field.',
  'rule.refused.read-only': 'You cannot change the rules of this document.',
  'rule.refused.no-feature':
    'This service does not offer forms, so this document cannot have rules.',
  'rule.refused.duplicate': 'Another rule already has this name.',
  'rule.refused.not-defined': 'This rule is no longer in the document.',
  'rule.refused.no-change': 'Nothing has changed.',
  'rule.refused.rule_limit': 'A document has at most {limit} rules.',
  'rule.refused.invalid_rules': 'The document would not be valid with this rule:',
} as const satisfies StringTable;

registerSource(EN_GB_RULES_PANE);
