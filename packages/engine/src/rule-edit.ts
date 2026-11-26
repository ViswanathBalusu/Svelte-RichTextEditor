/**
 * Adding, changing and deleting rule definitions, and listing them (FRW-024; 12 §3.5, §5; 03 §4.1;
 * 07 §4), for the rule builder.
 *
 * - A rule is a `rule_def` node in the document's definitions: `id`, `when`, `then`, `else` and
 *   `ext`. Adding one is an insertion there, changing one is a change of attributes, one step for
 *   each. Each leaves through the commit log like any change.
 * - A set of rules is checked before a step is made, by the same compile as the authority's
 *   (`checkRuleSet` of `@docedit/rules`): a key that does not exist, a cycle among formulas and every
 *   other problem of the language are refused, with the keys concerned (I14). The 500th rule is the
 *   last (I15; `LIMITS.rules`).
 * - The definitions are the scope `defs`, which needs `structure` (07 §4). The caller passes the
 *   region guard's answer as `writable`; where it is false the command returns `read-only`.
 * - The document must require the feature `fields`, which `rule_def` belongs to.
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import type { JsonValue } from '@docedit/model';
import {
  LIMITS,
  checkRuleSet,
  fieldFrom,
  newRuleFromParts,
  openRule,
  ruleParts,
  saveRuleParts,
  type FieldInfo,
  type RuleParts,
  type RuleProblem,
} from '@docedit/rules';
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { rolesOf } from './field-lookup.ts';
import { RULE_ATTRS as ATTRS, listRuleDefs, ruleNodes, ruleOf } from './rule-read.ts';

export { listRuleDefs } from './rule-read.ts';
export type { RuleDefInfo } from './rule-read.ts';

type JsonObject = { [key: string]: JsonValue };

/** One change to the rules, as `DocumentCore.editRule` takes it. */
export type RuleEdit =
  | {
      readonly op: 'save';
      /** The rule's JSON tree; its `id` names it. */
      readonly rule: JsonObject;
      /** The identifier of the rule this one replaces; absent for a new rule. */
      readonly replace?: string;
    }
  | { readonly op: 'delete'; readonly id: string };

export type RuleEditOutcome =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: 'read-only' | 'no-feature' | 'duplicate' | 'not-defined' | 'no-change';
    }
  | {
      readonly ok: false;
      readonly reason: 'rule_limit';
      readonly limit: number;
      readonly message: string;
    }
  | {
      readonly ok: false;
      readonly reason: 'invalid_rules';
      /** Each problem names its code, its message and the field keys concerned. */
      readonly problems: readonly RuleProblem[];
    };

export interface RuleEditOptions {
  /** Whether the region guard lets the user change the definitions at a position (07 §4). */
  readonly writable: (pos: number) => boolean;
  /** Whether the document requires the feature `fields`. */
  readonly formFields: boolean;
}

/** The fields of the document as the rules language reads them, one for each key. */
export function ruleFields(doc: Node): FieldInfo[] {
  const out: FieldInfo[] = [];
  const seen = new Set<string>();
  doc.descendants((node) => {
    if (node.type.name !== 'form_field') return true;
    const info = fieldFrom(node.attrs as Record<string, JsonValue>);
    if (info && !seen.has(info.key)) {
      seen.add(info.key);
      out.push(info);
    }
    return false;
  });
  return out;
}

/** Where a new rule goes: after the last rule, else after the last role, else after the page setups. */
function insertAt(doc: Node): number {
  const defs = doc.firstChild;
  if (!defs) return -1;
  let rule = -1;
  let role = -1;
  let page = -1;
  defs.forEach((child, offset) => {
    const end = 1 + offset + child.nodeSize;
    if (child.type.name === 'rule_def') rule = end;
    else if (child.type.name === 'role_def') role = end;
    else if (child.type.name === 'page_setup') page = end;
  });
  return rule >= 0 ? rule : role >= 0 ? role : page;
}

/** Makes one change to the rules. With `dispatch` absent, only checks. */
export function editRule(
  state: EditorState,
  edit: RuleEdit,
  options: RuleEditOptions,
  dispatch?: (tr: Transaction) => void,
): RuleEditOutcome {
  const type = state.schema.nodes['rule_def'];
  if (!type || !options.formFields) return { ok: false, reason: 'no-feature' };
  const existing = ruleNodes(state.doc);

  if (edit.op === 'delete') {
    const found = existing.find((r) => r.node.attrs['id'] === edit.id);
    if (!found) return { ok: false, reason: 'not-defined' };
    if (!options.writable(found.pos)) return { ok: false, reason: 'read-only' };
    // A document without this rule must still compile (a rule that sets a formula that another reads).
    const rest = existing.filter((r) => r !== found).map((r) => ruleOf(r.node));
    const check = checkRuleSet(rest, ruleFields(state.doc), [...rolesOf(state.doc).keys()]);
    if (!check.ok) return { ok: false, reason: 'invalid_rules', problems: check.problems };
    if (dispatch) dispatch(state.tr.delete(found.pos, found.pos + found.node.nodeSize));
    return { ok: true };
  }

  const id = edit.rule['id'];
  if (typeof id !== 'string' || id === '') return { ok: false, reason: 'not-defined' };
  const target =
    edit.replace === undefined
      ? null
      : (existing.find((r) => r.node.attrs['id'] === edit.replace) ?? null);
  if (edit.replace !== undefined && target === null) return { ok: false, reason: 'not-defined' };
  if (existing.some((r) => r !== target && r.node.attrs['id'] === id))
    return { ok: false, reason: 'duplicate' };
  if (target === null && existing.length >= LIMITS.rules)
    return {
      ok: false,
      reason: 'rule_limit',
      limit: LIMITS.rules,
      message: `A document has at most ${LIMITS.rules} rules.`,
    };
  const at = target === null ? insertAt(state.doc) : target.pos;
  if (at < 0) return { ok: false, reason: 'not-defined' };
  if (!options.writable(at)) return { ok: false, reason: 'read-only' };

  const rules = existing.map((r) => (r === target ? edit.rule : ruleOf(r.node)));
  if (target === null) rules.push(edit.rule);
  const check = checkRuleSet(rules, ruleFields(state.doc), [...rolesOf(state.doc).keys()]);
  if (!check.ok) return { ok: false, reason: 'invalid_rules', problems: check.problems };

  const attrs: Record<string, JsonValue> = {};
  // Only what the rule says is set: `ext` has a default of its own, and `else` is null without one.
  for (const name of ATTRS) {
    const value = edit.rule[name];
    if (value !== undefined) attrs[name] = value;
    else if (name === 'else') attrs[name] = null;
  }
  if (target === null) {
    if (dispatch) dispatch(state.tr.insert(at, type.create(attrs)));
    return { ok: true };
  }
  const changed = ATTRS.filter(
    (name) =>
      name in attrs &&
      JSON.stringify(attrs[name]) !== JSON.stringify(target.node.attrs[name] ?? null),
  );
  if (changed.length === 0) return { ok: false, reason: 'no-change' };
  if (dispatch) {
    const tr = state.tr;
    for (const name of changed) tr.setNodeAttribute(at, name, attrs[name]!);
    dispatch(tr);
  }
  return { ok: true };
}

/** A rule as the builder lists it: its sentence parts, or its JSON text when it has no sentence form. */
export interface RuleItemInfo {
  readonly id: string;
  readonly parts: RuleParts | null;
  readonly json: string;
}

export function listRuleItems(doc: Node): RuleItemInfo[] {
  return listRuleDefs(doc).map(({ id, rule }) => {
    const opened = openRule(rule);
    return {
      id,
      parts: opened === null ? null : ruleParts(opened),
      json: JSON.stringify(rule, null, 2),
    };
  });
}

/**
 * The rule's JSON tree for a save from the builder: a rule that replaces another keeps every member
 * the builder does not edit (`saveRuleParts`); a new one is made from the parts (`newRuleFromParts`).
 */
export function ruleFromParts(
  doc: Node,
  input: { readonly id: string; readonly parts: RuleParts; readonly replace?: string },
): JsonObject {
  const before =
    input.replace === undefined
      ? undefined
      : listRuleDefs(doc).find((r) => r.id === input.replace)?.rule;
  const opened = before === undefined ? null : openRule(before);
  if (opened === null) return newRuleFromParts(input.id, input.parts);
  return { ...saveRuleParts(opened, input.parts), id: input.id };
}
