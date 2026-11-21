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
 * - The evaluation itself (`field-rules-eval.ts`, with `@docedit/rules`) is the `rules` part
 *   (`./parts.ts`; FND-008). The element loads it before it mounts a document that has rules. A
 *   document whose first rule arrives later (another person adds one) has no state until the part
 *   has loaded, which asks the views to read the states again (`FieldRulesHost.loaded`).
 * - Reads no clock and no store. Universal: no Node.js or browser API.
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { Compiled } from './field-rules-eval.ts';
import type { FieldRuleState, RuleEvaluationStats } from './field-rules-types.ts';
import { rulesPart } from './parts.ts';

export type { FieldRuleState, RuleEvaluationStats } from './field-rules-types.ts';

export interface FieldRulesHost {
  state(): { readonly doc: PMNode };
  /** The `role_def` identifiers the person holds (`access.fill.roles`); none when not filling. */
  roles(): readonly string[];
  /** The rules part has loaded after the states were asked for: read them again. */
  loaded?(): void;
  /** The rules part could not be loaded: the states stay empty and the core says so. */
  loadFailed?(error: unknown): void;
}

/** Whether `doc` holds a rule (its definitions are the first child of the root). */
export function hasRules(doc: PMNode): boolean {
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

const NONE: ReadonlyMap<string, FieldRuleState> = new Map();

export class FieldRules {
  readonly #host: FieldRulesHost;
  #doc: PMNode | null = null;
  #rolesKey = '';
  #states: ReadonlyMap<string, FieldRuleState> = new Map();
  #compiled: Compiled | null = null;
  #stats: RuleEvaluationStats = { evaluations: 0, full: 0, lastFields: 0 };
  /** The part's load was asked for, and has not failed. */
  #asked = false;

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
    if (!hasRules(doc)) {
      this.#doc = doc;
      this.#rolesKey = key;
      this.#compiled = null;
      this.#states = new Map();
      return this.#states;
    }
    const part = rulesPart.peek();
    if (part === null) {
      // The rules arrived after the editor opened (or the element did not load the part). The
      // fields show what the document says until the part is there; `#doc` is left as it was, so
      // that the next read tries again.
      this.#load();
      return NONE;
    }
    const rolesChanged = this.#rolesKey !== key;
    this.#doc = doc;
    this.#rolesKey = key;
    const run = part.evaluateFields(
      { compiled: this.#compiled, states: this.#states, stats: this.#stats },
      doc,
      roles,
      rolesChanged,
    );
    this.#compiled = run.compiled;
    this.#states = run.states;
    this.#stats = run.stats;
    return this.#states;
  }

  /** The state of the field `id`, or null when no rule applies to the document. */
  of(id: string): FieldRuleState | null {
    return this.states().get(id) ?? null;
  }

  #load(): void {
    if (this.#asked) return;
    this.#asked = true;
    rulesPart.load().then(
      () => this.#host.loaded?.(),
      (error: unknown) => this.#host.loadFailed?.(error),
    );
  }
}
