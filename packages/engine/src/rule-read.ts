/**
 * Listing the document's rule definitions as JSON trees (FRW-024). The reading half of
 * `rule-edit.ts` that does not need the rules language: the shell asks for the rules' list and for
 * the next identifier as soon as it has the rules service, so this stays in the first load, while
 * the language (`@docedit/rules`: the compiler, the evaluator and the builder) loads as the `rules`
 * part (`./parts.ts`; FND-008).
 *
 * The module reads no clock and no store. It is universal: no Node.js or browser API.
 */
import type { JsonValue } from '@docedit/model';
import type { Node } from 'prosemirror-model';

type JsonObject = { [key: string]: JsonValue };

/** A rule of the document as the builder reads it: its attributes as a JSON tree, without nulls. */
export interface RuleDefInfo {
  readonly id: string;
  readonly rule: JsonObject;
}

/** The attributes of a `rule_def` that the builder writes. */
export const RULE_ATTRS = ['id', 'when', 'then', 'else', 'ext'] as const;

const isEmpty = (v: JsonValue): boolean =>
  typeof v === 'object' && v !== null && !Array.isArray(v) && Object.keys(v).length === 0;

/** A rule of the document as the builder reads it: its attributes as a JSON tree, without nulls. */
export function ruleOf(node: Node): JsonObject {
  const rule: JsonObject = {};
  for (const name of RULE_ATTRS) {
    const value = node.attrs[name] as JsonValue | undefined;
    if (value === null || value === undefined) continue;
    // `ext` is `{}` unless an extension wrote something: an empty one is no member of the rule.
    if (name === 'ext' && isEmpty(value)) continue;
    rule[name] = value;
  }
  return rule;
}

export function ruleNodes(doc: Node): Array<{ node: Node; pos: number }> {
  const out: Array<{ node: Node; pos: number }> = [];
  doc.firstChild?.forEach((child, offset) => {
    if (child.type.name === 'rule_def' && typeof child.attrs['id'] === 'string')
      out.push({ node: child, pos: 1 + offset });
  });
  return out;
}

/** The rules of the document in the order of its definitions. */
export function listRuleDefs(doc: Node): RuleDefInfo[] {
  return ruleNodes(doc).map(({ node }) => ({ id: String(node.attrs['id']), rule: ruleOf(node) }));
}
