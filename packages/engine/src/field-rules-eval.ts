/**
 * The evaluation behind `FieldRules` (field-rules.ts; FRW-023): compiling the document's rules and
 * evaluating them with `@docedit/rules`. It loads as part of the `rules` part (`./parts.ts`;
 * FND-008), so that a document with no rule never loads the rules language.
 *
 * - One evaluation for each version of the document (and each set of roles), however many fields
 *   ask: the caller keeps the answer.
 * - After the first, an evaluation covers only the fields whose state a change can change
 *   (`dependentKeys`): a keystroke in one field re-evaluates the rules that read it, and the rules
 *   are compiled again only when the definitions or the fields themselves change (FRW-023
 *   criterion 6). The result is the one a full evaluation of the same document gives.
 * - A set of rules that does not compile, or an evaluation over the budget, has no state: the
 *   editor then shows what the document says and leaves the verdict to the authority.
 * - Reads no clock and no store. Universal: no Node.js or browser API.
 */
import type { JsonValue } from '@docedit/model';
import {
  compileDocument,
  dependentKeys,
  evaluateRules,
  fieldFrom,
  type Evaluation,
  type FieldState,
  type RuleSet,
} from '@docedit/rules';
import type { Node as PMNode } from 'prosemirror-model';
import { formFieldsOf } from './field-entries.ts';
import type { FieldRuleState, RuleEvaluationStats } from './field-rules-types.ts';

/** One `form_field` as the editor last read it: the node, and what the rules see of its attributes. */
interface Seen {
  readonly node: PMNode;
  /** The attributes the rules read, without the value (a change of it is a change of the field). */
  readonly shape: string;
  readonly value: string;
}

/** What the editor keeps of the document between two evaluations. */
export interface Compiled {
  /** The definitions node: the rules and the roles are in it. */
  readonly defs: PMNode | null;
  /** The compiled rules; null when they do not compile (then no field has a state). */
  readonly ruleSet: RuleSet | null;
  readonly seen: ReadonlyMap<string, Seen>;
  readonly values: Record<string, JsonValue>;
}

/** What one evaluation starts from and leaves. */
export interface RuleRun {
  readonly compiled: Compiled | null;
  readonly states: ReadonlyMap<string, FieldRuleState>;
  readonly stats: RuleEvaluationStats;
}

/**
 * The first `form_field` of each key, in document order (as the rules read a document). Read from
 * the list of the document's fields, which is walked once for every reader (field-entries.ts).
 */
function scanFields(doc: PMNode): Map<string, PMNode> {
  const out = new Map<string, PMNode>();
  for (const { node } of formFieldsOf(doc).list) {
    const key = node.attrs['key'];
    if (typeof key === 'string' && !out.has(key)) out.set(key, node);
  }
  return out;
}

const shapeOf = (node: PMNode): string =>
  JSON.stringify(fieldFrom(node.attrs as Record<string, JsonValue>) ?? null);

const valueOf = (node: PMNode): JsonValue => (node.attrs['value'] ?? null) as JsonValue;

function put(out: Map<string, FieldRuleState>, result: Extract<Evaluation, { ok: true }>): void {
  for (const f of result.fields as FieldState[]) {
    if (typeof f.id !== 'string') continue;
    out.set(f.id, {
      visible: f.visible,
      enabled: f.enabled,
      required: f.required,
      messages: f.messages.map((m) => m.message),
      value: f.value === undefined ? null : f.value,
      computed: f.value !== undefined || f.error !== undefined,
    });
  }
}

/** Compiles the rules and evaluates every field. */
function full(
  prev: RuleRun,
  doc: PMNode,
  roles: readonly string[],
  found: ReadonlyMap<string, PMNode>,
): RuleRun {
  const compiled = compileDocument({ cdm: 1, requires: [], doc: doc.toJSON() });
  const seen = new Map<string, Seen>();
  for (const [key, node] of found)
    seen.set(key, { node, shape: shapeOf(node), value: JSON.stringify(valueOf(node)) });
  const stats = {
    evaluations: prev.stats.evaluations + 1,
    full: prev.stats.full + 1,
    lastFields: found.size,
  };
  if (!compiled.ok)
    return {
      compiled: { defs: doc.firstChild, ruleSet: null, seen, values: {} },
      states: new Map(),
      stats,
    };
  const values = compiled.document.values;
  const result = evaluateRules(compiled.ruleSet, values, { roles: [...roles] });
  if (!result.ok) return { compiled: null, states: new Map(), stats };
  const out = new Map<string, FieldRuleState>();
  put(out, result);
  return {
    compiled: { defs: doc.firstChild, ruleSet: compiled.ruleSet, seen, values },
    states: out,
    stats,
  };
}

/**
 * The state of every field for `doc`, from the run before it. The document holds rules (the caller
 * checked).
 */
export function evaluateFields(
  prev: RuleRun,
  doc: PMNode,
  roles: readonly string[],
  rolesChanged: boolean,
): RuleRun {
  const before = prev.compiled;
  const found = scanFields(doc);
  // The fields and the definitions as before, with the value of some fields changed: only the
  // rules that read those values are evaluated again. Anything else starts again.
  let changed: string[] | null = null;
  if (before !== null && before.ruleSet !== null && before.defs === doc.firstChild) {
    changed = [];
    if (found.size !== before.seen.size) changed = null;
    else
      for (const [key, node] of found) {
        const was = before.seen.get(key);
        if (was === undefined) {
          changed = null;
          break;
        }
        if (was.node === node) continue;
        if (was.shape !== shapeOf(node)) {
          changed = null;
          break;
        }
        if (was.value !== JSON.stringify(valueOf(node))) changed.push(key);
      }
  }
  if (changed === null || before === null || before.ruleSet === null)
    return full(prev, doc, roles, found);

  // Remember the nodes and the changed values, then evaluate what depends on them.
  const seen = new Map<string, Seen>();
  const values = { ...before.values };
  for (const [key, node] of found) {
    const was = before.seen.get(key)!;
    if (was.node === node) seen.set(key, was);
    else {
      seen.set(key, { node, shape: was.shape, value: JSON.stringify(valueOf(node)) });
      values[key] = valueOf(node);
    }
  }
  const compiled: Compiled = { defs: before.defs, ruleSet: before.ruleSet, seen, values };
  if (changed.length === 0 && !rolesChanged)
    return { compiled, states: prev.states, stats: { ...prev.stats, lastFields: 0 } };
  const keys = rolesChanged ? undefined : dependentKeys(before.ruleSet, changed);
  const result = evaluateRules(
    before.ruleSet,
    values,
    { roles: [...roles] },
    keys === undefined ? {} : { keys },
  );
  const stats = {
    evaluations: prev.stats.evaluations + 1,
    full: prev.stats.full,
    lastFields: result.ok ? result.fields.length : 0,
  };
  if (!result.ok) return { compiled: null, states: new Map(), stats };
  const out = keys === undefined ? new Map<string, FieldRuleState>() : new Map(prev.states);
  put(out, result);
  return { compiled, states: out, stats };
}
