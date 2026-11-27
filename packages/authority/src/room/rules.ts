/**
 * The rules language in the authority (12 §3.6, §5; ADR 0030; SYN-012, SYN-037; FRW-019).
 *
 * - The rule half of I14 (every key a rule reads or writes exists; the `set` effects and formulas
 *   form no cycle) runs with the other invariants on every commit, through the model's
 *   registration point (CDM-013): `RULE_INVARIANTS`. I15's count of rules is the model's own check.
 * - A fill goes only into a field that is visible and enabled under the rules (P7, 12 §4.2). The
 *   room evaluates what each filled field depends on, within a step budget (ADR 0034, proposed: the
 *   spec names none); a commit whose evaluation exceeds it is refused with `rate_limited`
 *   (04 §12; ADR 0030 §7).
 */
import type { InvariantCheck } from '@docedit/model/validate';
import { checkDocumentPatterns, compileDocument, evaluateDocument } from '@docedit/rules';
import type { Node } from 'prosemirror-model';

/**
 * Rule evaluation steps one commit may spend (ADR 0034, proposed). About thirteen times the 7,675
 * steps the rules agent measured for evaluating every field of a synthetic document at the targets
 * of 2,000 fields and 500 rules (ADR 0030 §7), and about 0.7 ms at the costliest step rate it
 * measured (4,923,993 steps in 33 ms). Not calibrated: SYN-038 measures it.
 */
export const DEFAULT_RULE_BUDGET = 100_000;

export const RULE_INVARIANTS: InvariantCheck = {
  name: 'rules',
  codes: {
    rule_unknown_key: {
      invariant: 'I14',
      doc: 'A rule reads or writes a field key that does not exist.',
    },
    rule_cycle: {
      invariant: 'I14',
      doc: 'The `set` effects and formulas of the rules form a cycle.',
    },
    rule_invalid: {
      invariant: 'I14',
      doc: 'The rules do not compile for a reason other than an unknown key or a cycle (12 §5.2): a bad shape, a type mismatch, conflicting or duplicate rules, an unknown effect.',
    },
    pattern_unsupported: {
      invariant: 'I11',
      doc: 'A validation.pattern or matches pattern outside the regular-expression subset (FRW-018).',
    },
  },
  // What `check` reads: `readDocument` takes the fields (`form_field`), the roles (`role_def`) and
  // the rules (`rule_def`) of the document, and `checkDocumentPatterns` the same fields and rules.
  // It reads no text and no other node type, so the model's commit validator skips the check for a
  // commit that changes none of the three (ADR 0422; SYN-040).
  reads: { nodes: ['form_field', 'role_def', 'rule_def'] },
  check(view, report) {
    // FRW-018 criterion 1, the commit path: a pattern outside the subset is refused on every commit.
    for (const p of checkDocumentPatterns(view.envelope)) {
      report({
        code: 'pattern_unsupported',
        path: p.path,
        message: p.construct ? `${p.message} (${p.construct})` : p.message,
      });
    }
    if (view.ofType('rule_def').length === 0) return;
    const r = compileDocument(view.envelope);
    if (r.ok) return;
    for (const p of r.problems) {
      if (p.code === 'unknown_field')
        report({ code: 'rule_unknown_key', path: p.path, message: p.message });
      else if (p.code === 'cycle')
        report({
          code: 'rule_cycle',
          path: p.path,
          message: p.keys ? `${p.message} (${p.keys.join(', ')})` : p.message,
        });
      // Every other problem is refused at save as well (owner decision 185, ADR 0340); the count of
      // rules is I15, which the model checks.
      else if (p.code !== 'too_many_rules')
        report({ code: 'rule_invalid', path: p.path, message: `${p.code}: ${p.message}` });
    }
  },
};

/** Whether a document holds any rule (its definitions are the first child of the root). */
function hasRules(doc: Node): boolean {
  let found = false;
  doc.firstChild?.forEach((n) => {
    if (n.type.name === 'rule_def') found = true;
  });
  return found;
}

/** The fields a fill may change, as the outcome check asks for them one by one (P7). */
export interface RuleGate {
  /** Visible and enabled under the rules; false once the budget is spent (it fails closed). */
  enabled: (fieldId: string, after: Node, key?: string) => boolean;
  /**
   * The rule that hid or disabled a field `enabled` refused, by identifier, for the rejection's
   * `rule` (12 §5.3; FRW-022). Undefined when no rule decided it: the field was enabled, unknown,
   * not evaluated, or the evaluation failed or ran out of budget.
   */
  ruleOf: (fieldId: string) => string | undefined;
  /** Whether the budget was spent: the room then refuses with `rate_limited`, not as P7 would. */
  readonly overrun: boolean;
  readonly steps: number;
  /** How often a field had to be found by scanning the document (PRM-016 criterion 6). */
  readonly scans: number;
}

/**
 * The rule gate for one commit, or null when the document has no rules. Each field is evaluated
 * once, with only the rules it depends on, from the participant's roles; every evaluation draws on
 * one budget.
 *
 * @param keyOf the field index's lookup of a field's key (PRM-016): constant time instead of a
 * scan of the document. A field the index does not know is looked for in the document.
 */
export function ruleGate(
  after: Node,
  roles: readonly string[],
  budget: number,
  keyOf?: (fieldId: string) => string | undefined,
): RuleGate | null {
  if (!hasRules(after)) return null;
  let json: unknown;
  const decided = new Map<string, boolean>();
  const decidedBy = new Map<string, string>();
  const state = { overrun: false, steps: 0, scans: 0 };
  const enabled = (fieldId: string, doc: Node, fieldKey?: string): boolean => {
    const known = decided.get(fieldId);
    if (known !== undefined) return known;
    // The key as the commit leaves it (the outcome check passes the field node it found), else
    // the field index; a scan of the document only when neither knows the field.
    let key: string | null = fieldKey ?? keyOf?.(fieldId) ?? null;
    if (key === null) {
      state.scans++;
      doc.descendants((n) => {
        if (key === null && n.type.name === 'form_field' && n.attrs['id'] === fieldId)
          key = String(n.attrs['key']);
        return key === null;
      });
    }
    if (key === null || state.overrun) {
      decided.set(fieldId, key === null);
      return key === null;
    }
    json ??= doc.toJSON();
    const r = evaluateDocument(
      json,
      { roles, now: null, budget: Math.max(0, budget - state.steps) },
      { keys: [key] },
    );
    let yes = false;
    if (r.ok) {
      state.steps += r.steps;
      const f = r.fields.find((x) => x.key === key);
      yes = f !== undefined && f.visible && f.enabled;
      // Hidden first: a hidden field is not filled whatever enables it (12 §5.2).
      const by = f === undefined || yes ? undefined : !f.visible ? f.by.visible : f.by.enabled;
      if (by !== undefined) decidedBy.set(fieldId, by);
    } else if (r.code === 'budget_exceeded') {
      state.steps += r.steps;
      state.overrun = true;
    }
    // A rule set with problems cannot be evaluated: the field counts as disabled (fails closed).
    decided.set(fieldId, yes);
    return yes;
  };
  return {
    enabled,
    ruleOf: (fieldId) => decidedBy.get(fieldId),
    get overrun() {
      return state.overrun;
    },
    get steps() {
      return state.steps;
    },
    get scans() {
      return state.scans;
    },
  };
}
