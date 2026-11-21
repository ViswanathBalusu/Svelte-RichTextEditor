/**
 * Rules over a CDM document (12 §3.5, §3.6, §5.4): reads the fields, values, roles and rules of a
 * document in its JSON form (an envelope or the `doc` node), without ProseMirror, and offers the
 * calls the authority and the authority service need: the rule invariants I14 and I15, and
 * `evaluateRules` on a document (05 §10).
 */
import {
  type EvaluationContext,
  type Evaluation,
  type ValueMap,
  evaluateRules,
} from './evaluate.ts';
import { type DocumentRules, readDocument } from './document-read.ts';
import { type RuleProblem, type RuleSet, compileRules } from './language.ts';
import { LIMITS } from './limits.ts';

export { type DocumentRules, fieldFrom, readDocument } from './document-read.ts';

export interface RuleViolation {
  invariant: 'I14' | 'I15';
  /** JSON Pointer into the document. */
  path: string;
  message: string;
  /** The keys on a cycle, or the key that does not exist. */
  keys?: string[];
}

/**
 * The rule halves of invariants I14 and I15 (12 §3.6), in the shape of the model's violations so
 * that `model.validate()` can run them through its registration point (CDM-013): every key a rule
 * reads or writes exists, the graph of `set` effects and formulas has no cycle, and a document has
 * at most 500 rules. Other rule problems (shapes, types, conflicts) are not invariants; the send
 * checklist and the rule builder refuse them (12 §6.2; FRW-024, FRW-027).
 */
export function checkRuleInvariants(input: unknown): RuleViolation[] {
  const d = readDocument(input);
  const r = compileRules(d.rules, { fields: d.fields, roles: d.roles });
  if (r.ok) return [];
  const out: RuleViolation[] = [];
  for (const p of r.problems) {
    if (p.code === 'unknown_field' || p.code === 'cycle')
      out.push({
        invariant: 'I14',
        path: p.path,
        message: p.message,
        ...(p.keys ? { keys: p.keys } : {}),
      });
    else if (p.code === 'too_many_rules')
      out.push({ invariant: 'I15', path: p.path || '/doc', message: p.message });
  }
  return out;
}

export function compileDocument(
  input: unknown,
):
  | { ok: true; ruleSet: RuleSet; document: DocumentRules }
  | { ok: false; problems: RuleProblem[]; document: DocumentRules } {
  const read = readDocument(input);
  const r = compileRules(read.rules, { fields: read.fields, roles: read.roles });
  return r.ok
    ? { ok: true, ruleSet: r.ruleSet, document: read }
    : { ok: false, problems: r.problems, document: read };
}

/**
 * `evaluateRules` of the authority service interface (05 §10), on a document: the visibility,
 * requirement, enablement and computed values of its fields, for the stored values or for the
 * values given in `values` (which replace stored ones by key).
 */
export function evaluateDocument(
  input: unknown,
  context: EvaluationContext,
  options: { values?: ValueMap; keys?: readonly string[] } = {},
): Evaluation | { ok: false; code: 'invalid_rules'; problems: RuleProblem[] } {
  const c = compileDocument(input);
  if (!c.ok) return { ok: false, code: 'invalid_rules', problems: c.problems };
  const values = { ...c.document.values, ...options.values };
  return evaluateRules(c.ruleSet, values, context, options.keys ? { keys: options.keys } : {});
}

/** The number of `rule_def` nodes a document may hold (I15). */
export const MAX_RULES = LIMITS.rules;
