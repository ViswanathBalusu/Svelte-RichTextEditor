// Values derived from hidden content (ADR 0019; FRW-089). A formula, a `set` effect or a rule
// whose condition reads a hidden value computes a value that may reveal it, so that value is hidden
// too. This module finds the closure. It decides nothing about what a reader sees: the redaction
// marker, the server evaluation and the numbering and PDF choices belong to the authority, the
// editor and the owner (FRW-089 criteria 1 to 3).
//
// Taint rules, the conservative default taken where ADR 0030 and ADR 0119 are silent:
// - a `set` effect whose value reads a hidden field makes its target hidden;
// - a `set` effect in a rule whose condition reads a hidden field makes its target hidden too
//   (an implicit flow: the value is chosen by the hidden value, even if the expression is constant);
// - a visibility, enablement, requirement or message effect in a rule whose condition reads a hidden
//   field is reported as `conditioned`: it reveals one bit, and the owner decides whether to hide it.
import type { CompiledRule, Effect, Expr, RuleSet } from './language.ts';

export interface HiddenDerivation {
  /** The input keys and every key computed from them, sorted. */
  readonly hidden: readonly string[];
  /** The keys in `hidden` that were not given: values computed from hidden content, sorted. */
  readonly derived: readonly string[];
  /** Fields whose visibility, enablement, requirement or message a hidden condition decides, sorted. */
  readonly conditioned: readonly string[];
}

/** The field keys an expression reads, added to `into`. */
export function fieldsRead(expr: Expr, into: Set<string> = new Set()): Set<string> {
  if (expr.k === 'field') into.add(expr.key);
  else if (expr.k === 'op') for (const arg of expr.args) fieldsRead(arg, into);
  return into;
}

function readsAny(keys: ReadonlySet<string>, fields: ReadonlySet<string>): boolean {
  for (const key of fields) if (keys.has(key)) return true;
  return false;
}

/** The effects of a rule, both branches. */
function effectsOf(rule: CompiledRule): Effect[] {
  return [...rule.then, ...rule.else];
}

/** The keys a visibility, enablement, requirement or message effect names. */
function conditionedKeys(effect: Effect): readonly string[] {
  return effect.k === 'set' ? [] : effect.keys;
}

/**
 * The closure of `hiddenKeys` under the rule set: every field whose value a hidden value can reach.
 * Runs to a fixed point, so it does not depend on the order in which rules are stored (the rule set
 * is already sorted by identifier, and each step only adds keys).
 */
export function derivedFromHidden(
  ruleSet: RuleSet,
  hiddenKeys: Iterable<string>,
): HiddenDerivation {
  const input = new Set(hiddenKeys);
  const hidden = new Set(input);

  let changed = true;
  while (changed) {
    changed = false;
    for (const rule of ruleSet.rules) {
      const conditionHidden = readsAny(hidden, fieldsRead(rule.when));
      for (const effect of effectsOf(rule)) {
        if (effect.k !== 'set' || hidden.has(effect.key)) continue;
        if (conditionHidden || readsAny(hidden, fieldsRead(effect.value))) {
          hidden.add(effect.key);
          changed = true;
        }
      }
    }
  }

  const conditioned = new Set<string>();
  for (const rule of ruleSet.rules) {
    if (!readsAny(hidden, fieldsRead(rule.when))) continue;
    for (const effect of effectsOf(rule))
      for (const key of conditionedKeys(effect)) conditioned.add(key);
  }

  const sorted = (keys: Iterable<string>) => [...keys].sort();
  return {
    hidden: sorted(hidden),
    derived: sorted([...hidden].filter((key) => !input.has(key))),
    conditioned: sorted(conditioned),
  };
}
