/**
 * The `rules` part (`./parts.ts`; FND-008): everything the editor does with the rules language of
 * `@docedit/rules`, which is large and which a document with no rule never needs. It is the
 * evaluation of a document's rules while a person fills (`field-rules.ts`), the rule builder's
 * list and changes (`rule-edit.ts`) and the authority's pre-send checks (`sendChecklist`, which
 * compile the rules). The element loads it before it mounts a document that has rules or a
 * workflow; the rules pane loads it with the pane.
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
export { sendChecklist } from '@docedit/authority';
export { evaluateFields } from './field-rules-eval.ts';
export { editRule, listRuleItems, ruleFromParts } from './rule-edit.ts';
