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
