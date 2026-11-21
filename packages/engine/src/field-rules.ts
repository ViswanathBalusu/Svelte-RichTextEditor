/**
 * The rules as the editor applies them while a person fills (12 §5.3, §11; FRW-023; ADR 0012).
 *
 * The editor evaluates the document's `rule_def` nodes with the same package as the authority
 * (`@docedit/rules`, `evaluateDocument`), for the document as it stands in the editor, so that a
 * field appears, disappears, becomes required, enabled, disabled, shows a message or shows its
 * computed value as the person fills. The result is advice for the screen. The authority decides
 * what stands, on its own evaluation, and its answer wins when the two differ (FRW-022 criterion 6).
 *
 * - One evaluation for each version of the document (and each set of roles), however many fields ask.
 * - After the first, an evaluation covers only the fields whose state a change can change
 *   (`dependentKeys`): a keystroke in one field re-evaluates the rules that read it, and the rules
 *   are compiled again only when the definitions or the fields themselves change (FRW-023
 *   criterion 6). The result is the one a full evaluation of the same document gives.
 * - A document with no rule has no state: every field is visible and enabled, required as authored.
 * - A set of rules that does not compile, or an evaluation over the budget, has no state either: the
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

/** What the rules say about one field, for the control. */
export interface FieldRuleState {
  /** False while a rule hides the field: it is not drawn, not reachable, not counted. */
  readonly visible: boolean;
  /** False while a rule disables the field. */
  readonly enabled: boolean;
  /** Static `required` or a `require` effect; never for a hidden field. */
  readonly required: boolean;
  /** The messages of the `validate` effects whose condition fails, in rule order. */
  readonly messages: readonly string[];
  /** The computed value of a formula field (a decimal string or a string), or null. */
  readonly value: string | null;
  /** Whether the field is a formula, so that its value is shown and cannot be changed. */
  readonly computed: boolean;
}

export interface FieldRulesHost {
  state(): { readonly doc: PMNode };
  /** The `role_def` identifiers the person holds (`access.fill.roles`); none when not filling. */
  roles(): readonly string[];
}

/** Whether `doc` holds a rule (its definitions are the first child of the root). */
function hasRules(doc: PMNode): boolean {
  let found = false;
  doc.firstChild?.forEach((n) => {
    if (n.type.name === 'rule_def') found = true;
  });
  return found;
}

/** A rule of the document named by a refusal, with the words the rule itself carries. */
export interface RuleWords {
  readonly id: string;
  /**
   * The message of the rule's first `validate` effect, which is the only wording a rule has. A rule
   * that hides, shows, requires, enables, disables or sets has none: this is then null and the
   * editor names the rule by its identifier.
   */
  readonly message: string | null;
}

/**
 * The rule `id` of the document `doc`, with its words; null when the document has no such rule (the
 * refusal named an invariant such as `I15`, not a rule of the document). FRW-023 criterion 5.
 */
export function ruleWords(doc: PMNode, id: string): RuleWords | null {
  let found: PMNode | null = null;
  doc.firstChild?.forEach((n) => {
    if (found === null && n.type.name === 'rule_def' && n.attrs['id'] === id) found = n;
  });
  if (found === null) return null;
  const attrs = (found as PMNode).attrs;
  for (const effects of [attrs['then'], attrs['else']]) {
    if (!Array.isArray(effects)) continue;
    for (const e of effects as unknown[]) {
      const v = (e as { validate?: { message?: unknown } } | null)?.validate;
      if (typeof v?.message === 'string' && v.message !== '') return { id, message: v.message };
    }
  }
  return { id, message: null };
}

/** What the last evaluation covered, for the tests and for a measurement. */
export interface RuleEvaluationStats {
  /** Evaluations made since the object was made. */
  readonly evaluations: number;
  /** How many of them compiled the rules again and evaluated every field. */
  readonly full: number;
  /** The number of fields the last evaluation covered; 0 when it was not needed. */
  readonly lastFields: number;
}

/** One `form_field` as the editor last read it: the node, and what the rules see of its attributes. */
interface Seen {
  readonly node: PMNode;
  /** The attributes the rules read, without the value (a change of it is a change of the field). */
  readonly shape: string;
  readonly value: string;
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

/** What the editor keeps of the document between two evaluations. */
interface Compiled {
  /** The definitions node: the rules and the roles are in it. */
  readonly defs: PMNode | null;
  /** The compiled rules; null when they do not compile (then no field has a state). */
  readonly ruleSet: RuleSet | null;
  readonly seen: ReadonlyMap<string, Seen>;
  readonly values: Record<string, JsonValue>;
}

export class FieldRules {
  readonly #host: FieldRulesHost;
  #doc: PMNode | null = null;
  #rolesKey = '';
  #states: ReadonlyMap<string, FieldRuleState> = new Map();
  #compiled: Compiled | null = null;
  #stats = { evaluations: 0, full: 0, lastFields: 0 };

  constructor(host: FieldRulesHost) {
    this.#host = host;
  }

  get stats(): RuleEvaluationStats {
    return this.#stats;
  }

  /** The state of every field by identifier; empty when the document has no usable rules. */
  states(): ReadonlyMap<string, FieldRuleState> {
    const doc = this.#host.state().doc;
    const roles = this.#host.roles();
    const key = roles.join('\u0000');
    if (this.#doc === doc && this.#rolesKey === key) return this.#states;
    const rolesChanged = this.#rolesKey !== key;
    this.#doc = doc;
    this.#rolesKey = key;
    if (!hasRules(doc)) {
      this.#compiled = null;
      this.#states = new Map();
      return this.#states;
    }
    this.#states = this.#update(doc, roles, rolesChanged);
    return this.#states;
  }

  /** The state of the field `id`, or null when no rule applies to the document. */
  of(id: string): FieldRuleState | null {
    return this.states().get(id) ?? null;
  }

  #update(
    doc: PMNode,
    roles: readonly string[],
    rolesChanged: boolean,
  ): ReadonlyMap<string, FieldRuleState> {
    const before = this.#compiled;
    const found = scanFields(doc);
    // The fields and the definitions as before, with the value of some fields changed: only the
    // rules that read those values are evaluated again. Anything else starts again.
    let changed: string[] | null = null;
    if (before !== null && before.ruleSet !== null && before.defs === doc.firstChild) {
      changed = [];
      if (found.size !== before.seen.size) changed = null;
      else
        for (const [key, node] of found) {
          const prev = before.seen.get(key);
          if (prev === undefined) {
            changed = null;
            break;
          }
          if (prev.node === node) continue;
          if (prev.shape !== shapeOf(node)) {
            changed = null;
            break;
          }
          if (prev.value !== JSON.stringify(valueOf(node))) changed.push(key);
        }
    }
    if (changed === null || before === null || before.ruleSet === null)
      return this.#full(doc, roles, found);

    // Remember the nodes and the changed values, then evaluate what depends on them.
    const seen = new Map<string, Seen>();
    const values = { ...before.values };
    for (const [key, node] of found) {
      const prev = before.seen.get(key)!;
      if (prev.node === node) seen.set(key, prev);
      else {
        seen.set(key, { node, shape: prev.shape, value: JSON.stringify(valueOf(node)) });
        values[key] = valueOf(node);
      }
    }
    this.#compiled = { defs: before.defs, ruleSet: before.ruleSet, seen, values };
    if (changed.length === 0 && !rolesChanged) {
      this.#stats = { ...this.#stats, lastFields: 0 };
      return this.#states;
    }
    const keys = rolesChanged ? undefined : dependentKeys(before.ruleSet, changed);
    const result = evaluateRules(
      before.ruleSet,
      values,
      { roles: [...roles] },
      keys === undefined ? {} : { keys },
    );
    this.#stats = {
      evaluations: this.#stats.evaluations + 1,
      full: this.#stats.full,
      lastFields: result.ok ? result.fields.length : 0,
    };
    if (!result.ok) {
      this.#compiled = null;
      return new Map();
    }
    const out = keys === undefined ? new Map<string, FieldRuleState>() : new Map(this.#states);
    this.#put(out, result);
    return out;
  }

  /** Compiles the rules and evaluates every field. */
  #full(
    doc: PMNode,
    roles: readonly string[],
    found: ReadonlyMap<string, PMNode>,
  ): ReadonlyMap<string, FieldRuleState> {
    const compiled = compileDocument({ cdm: 1, requires: [], doc: doc.toJSON() });
    const seen = new Map<string, Seen>();
    for (const [key, node] of found)
      seen.set(key, { node, shape: shapeOf(node), value: JSON.stringify(valueOf(node)) });
    this.#stats = {
      evaluations: this.#stats.evaluations + 1,
      full: this.#stats.full + 1,
      lastFields: found.size,
    };
    if (!compiled.ok) {
      this.#compiled = { defs: doc.firstChild, ruleSet: null, seen, values: {} };
      return new Map();
    }
    const values = compiled.document.values;
    this.#compiled = { defs: doc.firstChild, ruleSet: compiled.ruleSet, seen, values };
    const result = evaluateRules(compiled.ruleSet, values, { roles: [...roles] });
    if (!result.ok) {
      this.#compiled = null;
      return new Map();
    }
    const out = new Map<string, FieldRuleState>();
    this.#put(out, result);
    return out;
  }

  #put(out: Map<string, FieldRuleState>, result: Extract<Evaluation, { ok: true }>): void {
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
}
