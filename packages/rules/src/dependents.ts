/**
 * Which fields a change of values can change the state of (12 §5.3; FRW-023 criterion 6): the editor
 * re-evaluates these and no others while a person types, so the cost of a keystroke follows the
 * rules that read the field, not the size of the document.
 *
 * The answer is an upper bound, never a lower one. A rule is read as depending on every field its
 * condition or its `set` values read, and as changing the state of every field its effects name. A
 * formula that a rule sets is a field in its own right: when it may change, the rules that read it
 * are followed in turn. Pure: no clock, no store.
 */
import type { CompiledRule, Expr, RuleSet } from './language.ts';

interface Index {
  /** For each field key, the rules that read it. */
  readonly readers: ReadonlyMap<string, readonly CompiledRule[]>;
}

const indexes = new WeakMap<RuleSet, Index>();

/** The field keys an expression reads. */
function reads(e: Expr, into: Set<string>): void {
  if (e.k === 'field') into.add(e.key);
  else if (e.k === 'op') for (const a of e.args) reads(a, into);
}

function indexOf(rs: RuleSet): Index {
  let index = indexes.get(rs);
  if (index !== undefined) return index;
  const readers = new Map<string, CompiledRule[]>();
  for (const r of rs.rules) {
    const keys = new Set<string>();
    reads(r.when, keys);
    for (const effect of [...r.then, ...r.else]) if (effect.k === 'set') reads(effect.value, keys);
    for (const key of keys) {
      const list = readers.get(key);
      if (list === undefined) readers.set(key, [r]);
      else list.push(r);
    }
  }
  index = { readers };
  indexes.set(rs, index);
  return index;
}

/** The field keys the rules of an effect list name. */
function named(r: CompiledRule, into: Set<string>): void {
  for (const effect of [...r.then, ...r.else]) {
    if (effect.k === 'set') into.add(effect.key);
    else for (const key of effect.keys) into.add(key);
  }
}

/**
 * The keys whose state may change when the values of `changed` change: `changed` themselves, every
 * field a rule that reads a changed key names in its effects, and, for a formula among them, the
 * fields named by the rules that read the formula, and so on. Keys that are not fields of the rule
 * set are left out, and the order is the document's.
 */
export function dependentKeys(rs: RuleSet, changed: readonly string[]): string[] {
  const { readers } = indexOf(rs);
  const found = new Set<string>();
  const queue: string[] = [];
  const add = (key: string): void => {
    if (found.has(key)) return;
    found.add(key);
    queue.push(key);
  };
  for (const key of changed) if (rs.fields.has(key)) add(key);
  const seenRules = new Set<string>();
  for (let i = 0; i < queue.length; i++) {
    for (const r of readers.get(queue[i]!) ?? []) {
      if (seenRules.has(r.id)) continue;
      seenRules.add(r.id);
      const out = new Set<string>();
      named(r, out);
      for (const key of out) if (rs.fields.has(key)) add(key);
    }
  }
  return rs.fieldOrder.filter((key) => found.has(key));
}
