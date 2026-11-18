/**
 * The logic of the rule builder (12 §11; FRW-024; lane V-FRW-019-036). Pure: the sentence view of a
 * rule, the open and save of a rule's JSON tree, the check of a rule set before a save, the limit of
 * 500 rules (12 §3.6, I15) and the access to edit. The interface (keyboard, focus, axe) is not built
 * here; it calls these functions and does not decide any of them itself.
 *
 * Decisions taken where the spec is silent:
 * - a rule is saved as the JSON tree it was opened from, with only the members the builder edits
 *   replaced, so a rule that is opened and saved without change is identical (criterion 2), including
 *   members this module does not read (such as `ext`);
 * - a rule the sentence form cannot express returns `null` from `ruleSentence`; the builder then shows
 *   the JSON tree instead of a guessed sentence.
 */
import type { JsonValue } from '@docedit/model';
import type { FieldInfo } from './fields.ts';
import { compileRules, type RuleProblem, rulesFromList } from './language.ts';
import { LIMITS } from './limits.ts';

type JsonObject = { [key: string]: JsonValue };

const isObject = (v: unknown): v is JsonObject =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const clone = <T extends JsonValue>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** A rule opened in the builder. `raw` is the rule's JSON tree; saving returns a copy of it. */
export interface BuilderRule {
  readonly raw: JsonObject;
}

/**
 * Opens a `rule_def` attributes object. Refuses a value that is not an object with a string `id`:
 * the builder cannot show a rule that has no identifier.
 */
export function openRule(json: unknown): BuilderRule | null {
  if (!isObject(json) || typeof json['id'] !== 'string') return null;
  return { raw: clone(json) };
}

/** The rule as it is saved: a copy of the tree it was opened from, with the edits applied. */
export function saveRule(rule: BuilderRule): JsonObject {
  return clone(rule.raw);
}

/** Replaces the condition (`when`) of an opened rule; the rest of the tree is kept as it was. */
export function setCondition(rule: BuilderRule, when: JsonValue): BuilderRule {
  return { raw: { ...clone(rule.raw), when: clone(when) } };
}

/** Replaces one branch of an opened rule (`then` or `else`) with a list of effects. */
export function setBranch(
  rule: BuilderRule,
  branch: 'then' | 'else',
  effects: readonly JsonValue[],
): BuilderRule {
  return { raw: { ...clone(rule.raw), [branch]: clone(effects as JsonValue[]) } };
}

const COMPARISON_WORDS: Readonly<Record<string, string>> = {
  '==': 'is',
  '!=': 'is not',
  '<': 'is less than',
  '<=': 'is at most',
  '>': 'is more than',
  '>=': 'is at least',
};

const EFFECT_WORDS = ['show', 'hide', 'require', 'enable', 'disable'] as const;

/** A value as it reads in a sentence: a field's key, or a plain literal. Otherwise null. */
function operandWord(v: JsonValue): string | null {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (isObject(v) && typeof v['field'] === 'string' && Object.keys(v).length === 1)
    return v['field'];
  return null;
}

/** One effect as a phrase, such as "show tenant.spouseName", or null if the sentence form has none. */
function effectPhrase(effect: JsonValue): string | null {
  if (!isObject(effect)) return null;
  const names = Object.keys(effect);
  if (names.length !== 1) return null;
  const name = names[0] as string;
  if (!(EFFECT_WORDS as readonly string[]).includes(name)) return null;
  const keys = effect[name];
  if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string'))
    return null;
  return `${name} ${(keys as string[]).join(' and ')}`;
}

/** The effects of a branch as one phrase joined with "and", or null if one effect has no phrase. */
function branchPhrase(effects: JsonValue): string | null {
  if (!Array.isArray(effects) || effects.length === 0) return null;
  const parts = effects.map(effectPhrase);
  if (parts.some((p) => p === null)) return null;
  return (parts as string[]).join(' and ');
}

/**
 * The rule as a sentence, such as "If tenant.maritalStatus is married, show tenant.spouseName and
 * require tenant.spouseName; otherwise hide tenant.spouseName." Only the condition form
 * `{ op: [field-or-literal, field-or-literal] }` with a comparison operator and the field effects
 * have a sentence. Any other rule returns null: the builder shows its JSON tree instead.
 */
export function ruleSentence(rule: BuilderRule): string | null {
  const when = rule.raw['when'];
  if (!isObject(when)) return null;
  const ops = Object.keys(when);
  if (ops.length !== 1) return null;
  const op = ops[0] as string;
  const word = COMPARISON_WORDS[op];
  const operands = when[op];
  if (word === undefined || !Array.isArray(operands) || operands.length !== 2) return null;
  const left = operandWord(operands[0] as JsonValue);
  const right = operandWord(operands[1] as JsonValue);
  if (left === null || right === null) return null;
  const then = branchPhrase(rule.raw['then'] ?? []);
  if (then === null) return null;
  const otherwise = rule.raw['else'] === undefined ? null : branchPhrase(rule.raw['else']);
  if (rule.raw['else'] !== undefined && otherwise === null) return null;
  const head = `If ${left} ${word} ${right}, ${then}`;
  return otherwise === null ? `${head}.` : `${head}; otherwise ${otherwise}.`;
}

/** Why a rule set cannot be saved: each problem names its code, its path and the keys concerned. */
export type RuleSetCheck =
  { readonly ok: true } | { readonly ok: false; readonly problems: readonly RuleProblem[] };

/**
 * Checks a whole rule set (the rules of a document, as JSON) against the document's fields and roles,
 * the same check the authority runs on save. An unknown key, a cycle among formulas or a conflict is
 * refused here with the keys concerned (criterion 3, I14).
 */
export function checkRuleSet(
  rules: readonly JsonValue[],
  fields: readonly FieldInfo[],
  roles?: readonly string[],
): RuleSetCheck {
  const env = roles === undefined ? { fields } : { fields, roles };
  const result = compileRules(rulesFromList(rules), env);
  return result.ok ? { ok: true } : { ok: false, problems: result.problems };
}

/** The reason a rule cannot be added: the limit of rules, or the problems of the set with it. */
export type AddRuleRefusal =
  | { readonly code: 'rule_limit'; readonly limit: number; readonly message: string }
  | { readonly code: 'invalid_rules'; readonly problems: readonly RuleProblem[] };

/**
 * Adds a rule to a rule set, or refuses it. The limit of 500 rules (I15) is checked first, so a
 * document at the limit is refused without compiling the set. Otherwise the whole set with the new
 * rule is checked as one (criterion 3 and 4).
 */
export function addRule(
  rules: readonly JsonValue[],
  rule: BuilderRule,
  fields: readonly FieldInfo[],
  roles?: readonly string[],
): { ok: true; rules: JsonValue[] } | { ok: false; refusal: AddRuleRefusal } {
  if (rules.length >= LIMITS.rules)
    return {
      ok: false,
      refusal: {
        code: 'rule_limit',
        limit: LIMITS.rules,
        message: `A document has at most ${LIMITS.rules} rules.`,
      },
    };
  const next = [...rules, saveRule(rule)];
  const check = checkRuleSet(next, fields, roles);
  if (!check.ok) return { ok: false, refusal: { code: 'invalid_rules', problems: check.problems } };
  return { ok: true, rules: next };
}

/**
 * The access to the builder (criterion 5): a caller with `structure` edits rules; any other caller
 * sees the builder read-only (07 §2, FRW-021).
 */
export function builderAccess(caller: { readonly structure: boolean }): 'edit' | 'read_only' {
  return caller.structure ? 'edit' : 'read_only';
}

/** The comparison operators of the sentence form, in the order the interface offers them. */
export const BUILDER_OPERATORS = ['==', '!=', '<', '<=', '>', '>='] as const;
export type ComparisonOperator = (typeof BUILDER_OPERATORS)[number];

/** The field effects of the sentence form, in the order the interface offers them. */
export const BUILDER_EFFECTS = EFFECT_WORDS;
export type BuilderEffect = (typeof BUILDER_EFFECTS)[number];

/** One side of a comparison: a field's key, or a literal as the person typed it. */
export type RuleOperand = { readonly field: string } | { readonly literal: string };

/** The keys one effect applies to. */
export interface RuleEffectPart {
  readonly effect: BuilderEffect;
  readonly keys: readonly string[];
}

/**
 * A rule of the sentence form as parts, so that the interface builds the words from its own
 * strings (FRW-024 criterion 6: every fragment of the sentence is an external string). `otherwise`
 * is null when the rule has no `else`.
 */
export interface RuleParts {
  readonly left: RuleOperand;
  readonly operator: ComparisonOperator;
  readonly right: RuleOperand;
  readonly then: readonly RuleEffectPart[];
  readonly otherwise: readonly RuleEffectPart[] | null;
}

function operandPart(v: JsonValue): RuleOperand | null {
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean')
    return { literal: String(v) };
  if (isObject(v) && typeof v['field'] === 'string' && Object.keys(v).length === 1)
    return { field: v['field'] };
  return null;
}

function effectParts(effects: JsonValue | undefined): RuleEffectPart[] | null {
  if (!Array.isArray(effects) || effects.length === 0) return null;
  const out: RuleEffectPart[] = [];
  for (const effect of effects) {
    if (!isObject(effect)) return null;
    const names = Object.keys(effect);
    if (names.length !== 1) return null;
    const name = names[0] as string;
    const keys = effect[name];
    if (!(EFFECT_WORDS as readonly string[]).includes(name)) return null;
    if (!Array.isArray(keys) || keys.length === 0 || !keys.every((k) => typeof k === 'string'))
      return null;
    out.push({ effect: name as BuilderEffect, keys: keys as string[] });
  }
  return out;
}

/**
 * The parts of a rule of the sentence form, or null when the rule has another shape (the builder
 * then shows its JSON tree and does not edit it). The same shapes have a sentence in `ruleSentence`.
 */
export function ruleParts(rule: BuilderRule): RuleParts | null {
  const when = rule.raw['when'];
  if (!isObject(when)) return null;
  const ops = Object.keys(when);
  if (ops.length !== 1) return null;
  const operator = ops[0] as string;
  const operands = when[operator];
  if (
    !(BUILDER_OPERATORS as readonly string[]).includes(operator) ||
    !Array.isArray(operands) ||
    operands.length !== 2
  )
    return null;
  const left = operandPart(operands[0] as JsonValue);
  const right = operandPart(operands[1] as JsonValue);
  const then = effectParts(rule.raw['then']);
  if (left === null || right === null || then === null) return null;
  const rawElse = rule.raw['else'];
  const otherwise = rawElse === undefined || rawElse === null ? null : effectParts(rawElse);
  if (rawElse !== undefined && rawElse !== null && otherwise === null) return null;
  return { left, operator: operator as ComparisonOperator, right, then, otherwise };
}

const operandJson = (o: RuleOperand): JsonValue => {
  if ('field' in o) return { field: o.field };
  if (o.literal === 'true') return true;
  if (o.literal === 'false') return false;
  return o.literal;
};

const effectsJson = (parts: readonly RuleEffectPart[]): JsonValue[] =>
  parts.map((p) => ({ [p.effect]: [...p.keys] }));

/**
 * The rule with its sentence parts replaced: `when`, `then` and `else` are written from `parts`, and
 * the identifier and every other member of the opened rule are kept. A rule whose parts are those it
 * was opened with is returned as it was, so a save without change is identical (criterion 2) even
 * where the parts read a literal back as text (a number written as a number).
 */
export function saveRuleParts(rule: BuilderRule, parts: RuleParts): JsonObject {
  const before = ruleParts(rule);
  if (before !== null && JSON.stringify(before) === JSON.stringify(parts)) return saveRule(rule);
  const next: JsonObject = {
    ...clone(rule.raw),
    when: { [parts.operator]: [operandJson(parts.left), operandJson(parts.right)] },
    then: effectsJson(parts.then),
  };
  if (parts.otherwise === null) delete next['else'];
  else next['else'] = effectsJson(parts.otherwise);
  return next;
}

/** A rule of the sentence form for a new identifier, from its parts. */
export function newRuleFromParts(id: string, parts: RuleParts): JsonObject {
  return saveRuleParts({ raw: { id } }, parts);
}
