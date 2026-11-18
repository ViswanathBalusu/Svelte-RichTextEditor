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
 * - A document with no rule has no state: every field is visible and enabled, required as authored.
 * - A set of rules that does not compile, or an evaluation over the budget, has no state either: the
 *   editor then shows what the document says and leaves the verdict to the authority.
 * - Reads no clock and no store. Universal: no Node.js or browser API.
 */
import { evaluateDocument, type FieldState } from '@docedit/rules';
import type { Node as PMNode } from 'prosemirror-model';

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

export class FieldRules {
  readonly #host: FieldRulesHost;
  #doc: PMNode | null = null;
  #rolesKey = '';
  #states: ReadonlyMap<string, FieldRuleState> = new Map();

  constructor(host: FieldRulesHost) {
    this.#host = host;
  }

  /** The state of every field by identifier; empty when the document has no usable rules. */
  states(): ReadonlyMap<string, FieldRuleState> {
    const doc = this.#host.state().doc;
    const roles = this.#host.roles();
    const key = roles.join('\u0000');
    if (this.#doc === doc && this.#rolesKey === key) return this.#states;
    this.#doc = doc;
    this.#rolesKey = key;
    this.#states = hasRules(doc) ? this.#evaluate(doc, roles) : new Map();
    return this.#states;
  }

  /** The state of the field `id`, or null when no rule applies to the document. */
  of(id: string): FieldRuleState | null {
    return this.states().get(id) ?? null;
  }

  #evaluate(doc: PMNode, roles: readonly string[]): ReadonlyMap<string, FieldRuleState> {
    const result = evaluateDocument(
      { cdm: 1, requires: [], doc: doc.toJSON() },
      { roles: [...roles] },
    );
    if (!result.ok) return new Map();
    const out = new Map<string, FieldRuleState>();
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
    return out;
  }
}
