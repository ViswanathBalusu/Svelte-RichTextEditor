/**
 * Rules over a CDM document (12 §3.5, §3.6, §5.4): reads the fields, values, roles and rules of a
 * document in its JSON form (an envelope or the `doc` node), without ProseMirror, and offers the
 * calls the authority and the authority service need: the rule invariants I14 and I15, and
 * `evaluateRules` on a document (05 §10).
 */
import type { JsonEnvelope, JsonNode, JsonValue } from '@docedit/model';
import {
  type EvaluationContext,
  type Evaluation,
  type ValueMap,
  evaluateRules,
} from './evaluate.ts';
import { type FieldInfo, type FieldKind, type FieldValidation, FIELD_KINDS } from './fields.ts';
import { isObject, pointer } from './json.ts';
import { type RuleInput, type RuleProblem, type RuleSet, compileRules } from './language.ts';
import { LIMITS } from './limits.ts';

export interface DocumentRules {
  /** Every `form_field`, in document order. */
  fields: FieldInfo[];
  /** The stored `value` of each field, by key. */
  values: Record<string, JsonValue>;
  /** The identifiers of the `role_def` nodes. */
  roles: string[];
  /** The attributes of the `rule_def` nodes, with their JSON Pointers. */
  rules: RuleInput[];
}

const KINDS = new Set<string>(FIELD_KINDS);

/** The rules' view of one `form_field` node's attributes; null when it has no `key`. */
export function fieldFrom(attrs: Record<string, JsonValue>): FieldInfo | null {
  const key = attrs['key'];
  if (typeof key !== 'string') return null;
  const kind = (
    typeof attrs['kind'] === 'string' && KINDS.has(attrs['kind']) ? attrs['kind'] : 'text'
  ) as FieldKind;
  const f: FieldInfo = { key, kind };
  if (typeof attrs['id'] === 'string' || attrs['id'] === null) f.id = attrs['id'];
  if (attrs['required'] === true) f.required = true;
  if (attrs['readOnly'] === true) f.readOnly = true;
  if (Array.isArray(attrs['options']))
    f.options = attrs['options'].flatMap((o) =>
      isObject(o) && typeof o['id'] === 'string' ? [o['id']] : [],
    );
  if (isObject(attrs['validation'])) {
    const v = attrs['validation'];
    const out: FieldValidation = {};
    if (typeof v['min'] === 'string') out.min = v['min'];
    if (typeof v['max'] === 'string') out.max = v['max'];
    if (typeof v['minLength'] === 'number') out.minLength = v['minLength'];
    if (typeof v['maxLength'] === 'number') out.maxLength = v['maxLength'];
    if (typeof v['pattern'] === 'string') out.pattern = v['pattern'];
    if (typeof v['message'] === 'string') out.message = v['message'];
    if (v['preset'] === 'email' || v['preset'] === 'phone' || v['preset'] === 'postcode')
      out.preset = v['preset'];
    f.validation = out;
  }
  return f;
}

/** Reads the rules' view of a document: an envelope `{ cdm, requires, doc }` or a `doc` node. */
export function readDocument(input: JsonEnvelope | JsonNode | unknown): DocumentRules {
  const out: DocumentRules = { fields: [], values: {}, roles: [], rules: [] };
  let root: unknown = input;
  let base = '';
  if (isObject(input) && 'doc' in input) {
    root = input['doc'];
    base = '/doc';
  }
  const seen = new Set<string>();
  const stack: Array<[unknown, string]> = [[root, base]];
  while (stack.length) {
    const [node, path] = stack.pop()!;
    if (!isObject(node)) continue;
    const attrs = isObject(node['attrs']) ? node['attrs'] : {};
    switch (node['type']) {
      case 'role_def':
        if (typeof attrs['id'] === 'string') out.roles.push(attrs['id']);
        break;
      case 'rule_def':
        out.rules.push({ attrs, path: pointer(path, 'attrs') });
        break;
      case 'form_field': {
        const f = fieldFrom(attrs);
        if (f && !seen.has(f.key)) {
          seen.add(f.key);
          out.fields.push(f);
          out.values[f.key] = attrs['value'] ?? null;
        }
        break;
      }
    }
    const content = node['content'];
    if (Array.isArray(content))
      for (let i = content.length - 1; i >= 0; i--)
        stack.push([content[i], pointer(pointer(path, 'content'), i)]);
  }
  return out;
}

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
