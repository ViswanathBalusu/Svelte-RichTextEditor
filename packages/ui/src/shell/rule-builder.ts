/**
 * The rule builder's form state (FRW-024; 12 §5, §11): a rule of the sentence form as the controls
 * show it, the way back to the rule's parts, the checks the form makes before it asks the core, and
 * the sentence, built only from the string catalogue (every fragment of the words is an external
 * string, so a translation can reorder them). Pure: no DOM, no store.
 *
 * - A rule is `If <left> <operator> <right>, <effects>; otherwise <effects>.` One row of the form is
 *   one effect on one field. An effect on several fields opens as several rows and, when the form
 *   was not changed, is not written back at all, so a rule saved without change is identical.
 * - The checks here are the form's: something chosen, a value given, an effect named. Whether the
 *   keys exist and whether the set of rules compiles is the core's answer (the same compile as the
 *   authority's), shown with the keys it names.
 */
import type {
  RuleEffectName,
  RuleEffectView,
  RuleOperandView,
  RuleOperatorName,
  RulePartsView,
} from '../core-api.ts';
import '../i18n/late/rulesPane.ts';

export const RULE_OPERATORS: readonly RuleOperatorName[] = ['==', '!=', '<', '<=', '>', '>='];
export const RULE_EFFECTS: readonly RuleEffectName[] = [
  'show',
  'hide',
  'require',
  'enable',
  'disable',
];

export interface OperandForm {
  kind: 'field' | 'literal';
  /** A field's key, or the literal's text. */
  value: string;
}

export interface EffectRow {
  effect: RuleEffectName;
  /** The field key the effect applies to; empty until one is chosen. */
  key: string;
}

export interface RuleForm {
  id: string;
  left: OperandForm;
  operator: RuleOperatorName;
  right: OperandForm;
  then: EffectRow[];
  /** False for a rule with no `else`. */
  hasOtherwise: boolean;
  otherwise: EffectRow[];
}

const operandForm = (o: RuleOperandView): OperandForm =>
  'field' in o ? { kind: 'field', value: o.field } : { kind: 'literal', value: o.literal };

const rowsOf = (effects: readonly RuleEffectView[]): EffectRow[] =>
  effects.flatMap((e) => e.keys.map((key) => ({ effect: e.effect, key })));

/** The form for a rule opened for change. */
export function formFromParts(id: string, parts: RulePartsView): RuleForm {
  return {
    id,
    left: operandForm(parts.left),
    operator: parts.operator,
    right: operandForm(parts.right),
    then: rowsOf(parts.then),
    hasOtherwise: parts.otherwise !== null,
    otherwise: parts.otherwise === null ? [] : rowsOf(parts.otherwise),
  };
}

/** The form for a new rule: a comparison to fill in and one effect row. */
export function emptyForm(id: string, firstKey = ''): RuleForm {
  return {
    id,
    left: { kind: 'field', value: firstKey },
    operator: '==',
    right: { kind: 'literal', value: '' },
    then: [{ effect: 'show', key: firstKey }],
    hasOtherwise: false,
    otherwise: [],
  };
}

export type FormProblemCode = 'id' | 'left' | 'right' | 'effect' | 'otherwiseEffect';

export interface FormProblem {
  readonly code: FormProblemCode;
}

/** What the form checks itself: an identifier, both sides of the comparison, and an effect each. */
export function formProblems(form: RuleForm): FormProblem[] {
  const out: FormProblem[] = [];
  if (form.id.trim() === '') out.push({ code: 'id' });
  if (form.left.value === '') out.push({ code: 'left' });
  if (form.right.value === '' && form.right.kind === 'field') out.push({ code: 'right' });
  if (form.right.kind === 'literal' && form.right.value === '') out.push({ code: 'right' });
  if (form.then.length === 0 || form.then.some((r) => r.key === '')) out.push({ code: 'effect' });
  if (
    form.hasOtherwise &&
    (form.otherwise.length === 0 || form.otherwise.some((r) => r.key === ''))
  )
    out.push({ code: 'otherwiseEffect' });
  return out;
}

const operandView = (o: OperandForm): RuleOperandView =>
  o.kind === 'field' ? { field: o.value } : { literal: o.value };

const effectsOf = (rows: readonly EffectRow[]): RuleEffectView[] =>
  rows.map((r) => ({ effect: r.effect, keys: [r.key] }));

/** The rule's parts from a form that has no problem. */
export function partsFromForm(form: RuleForm): RulePartsView {
  return {
    left: operandView(form.left),
    operator: form.operator,
    right: operandView(form.right),
    then: effectsOf(form.then),
    otherwise: form.hasOtherwise ? effectsOf(form.otherwise) : null,
  };
}

/** Whether two forms are the same, for "nothing changed". */
export function sameForm(a: RuleForm, b: RuleForm): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Translate = (key: string, params?: Readonly<Record<string, string | number>>) => string;

const OPERATOR_KEYS: Readonly<Record<RuleOperatorName, string>> = {
  '==': 'rule.op.eq',
  '!=': 'rule.op.ne',
  '<': 'rule.op.lt',
  '<=': 'rule.op.le',
  '>': 'rule.op.gt',
  '>=': 'rule.op.ge',
};

const operandWord = (o: RuleOperandView): string => ('field' in o ? o.field : o.literal);

/** The effects as one phrase: "show a and b, and require c". */
function effectsPhrase(effects: readonly RuleEffectView[], t: Translate): string {
  const parts = effects.map((e) =>
    t(`rule.effect.${e.effect}`, { fields: e.keys.join(t('rule.and')) }),
  );
  return parts.join(t('rule.and'));
}

/** The rule as a sentence from the string catalogue: nothing of the words is written here. */
export function sentenceOf(parts: RulePartsView, t: Translate): string {
  const params = {
    left: operandWord(parts.left),
    operator: t(OPERATOR_KEYS[parts.operator]),
    right: operandWord(parts.right),
    then: effectsPhrase(parts.then, t),
  };
  return parts.otherwise === null
    ? t('rule.sentence', params)
    : t('rule.sentence.otherwise', { ...params, otherwise: effectsPhrase(parts.otherwise, t) });
}

export { OPERATOR_KEYS };
