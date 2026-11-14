/**
 * Checks a value against an attribute grammar (invariant I11). Also used at generation time to
 * check that every default is valid (CDM-006).
 *
 * String lengths count Unicode code points, as JSON Schema's maxLength does, so that validators in
 * other languages agree (CDM-007). Object members are looked up as own properties only, so a key
 * such as `constructor` or `__proto__` is an unknown member, never a match through the prototype
 * chain (CDM-015).
 */
import { UUID7_PATTERN, NODE_ID_PATTERN } from '../conventions/ids.ts';
import { canonicalize } from '../canonical/jcs.ts';
import { utf8 } from '../conventions/platform.ts';
import { MAX_INTEROPERABLE_INTEGER } from '../conventions/validators.ts';
import { PRESERVED_NAME_PATTERN, REGISTERED_NAMESPACES } from '../definition/namespaces.ts';
import { DEFINITION_ID_PATTERN } from '../definition/shared.ts';
import type { Grammar, GrammarProblemKind, RefTarget } from '../definition/grammar.ts';

/**
 * Names in preserved element trees: a registered prefix (`w:val`), Clark notation for other
 * namespaces (`{uri}local`), or a bare local name (spike S11; namespaces.ts).
 */
export const CLARK_NAME_PATTERN = PRESERVED_NAME_PATTERN;

/** Whether a name is spelt the one way the model allows: Clark notation only for unregistered URIs. */
function preservedName(name: string): boolean {
  if (!re(PRESERVED_NAME_PATTERN).test(name)) return false;
  if (!name.startsWith('{')) return true;
  return !REGISTERED_NAMESPACES.has(name.slice(1, name.indexOf('}')));
}

/** C0 controls except tab and line feed, DEL, and C1 controls. */
// eslint-disable-next-line no-control-regex -- matching control characters is the point
export const CONTROL_CHARACTERS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/;

/** One thing wrong with a value. */
export interface GrammarProblem {
  /** JSON Pointer of the offending value. */
  path: string;
  kind: GrammarProblemKind;
  message: string;
}

const regexCache = new Map<string, RegExp>();
function re(pattern: string): RegExp {
  let r = regexCache.get(pattern);
  if (!r) {
    r = new RegExp(pattern);
    regexCache.set(pattern, r);
  }
  return r;
}

export function refPattern(to: RefTarget): string {
  switch (to) {
    case 'asset':
      return UUID7_PATTERN;
    case 'headerStory':
    case 'footerStory':
      return NODE_ID_PATTERN;
    default:
      return DEFINITION_ID_PATTERN;
  }
}

export function codePointLength(s: string): number {
  let n = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    if (c >= 0xd800 && c <= 0xdbff && i + 1 < s.length) {
      const d = s.charCodeAt(i + 1);
      if (d >= 0xdc00 && d <= 0xdfff) i++;
    }
    n++;
  }
  return n;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** A value as text for a message; never throws, whatever a hostile caller passed (CDM-015). */
export function show(value: unknown): string {
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? typeof value;
  } catch {
    return typeof value;
  }
}

const pointer = (path: string, key: string): string =>
  `${path}/${key.replace(/~/g, '~0').replace(/\//g, '~1')}`;

/** Returns a list of problems; empty when the value matches. */
export function checkGrammar(g: Grammar, value: unknown, path: string): string[] {
  return grammarProblems(g, value, path).map((p) => p.message);
}

/** The problems of a value with their kind, so that an attribute can say which invariant each is. */
export function grammarProblems(g: Grammar, value: unknown, path: string): GrammarProblem[] {
  const out: GrammarProblem[] = [];
  check(g, value, path, out);
  return out;
}

function check(g: Grammar, value: unknown, path: string, out: GrammarProblem[]): void {
  const add = (kind: GrammarProblemKind, message: string, at = path) =>
    void out.push({ path: at, kind, message: `${at}: ${message}` });
  if (value === null) {
    if (!g.nullable) add('null', 'null is not allowed');
    return;
  }
  switch (g.kind) {
    case 'string': {
      if (typeof value !== 'string')
        return add('type', `expected a string, got ${describe(value)}`);
      const len = codePointLength(value);
      if (len > g.maxLength) add('length', `longer than ${g.maxLength} characters`);
      if (g.minLength !== undefined && len < g.minLength)
        add('length', `shorter than ${g.minLength} characters`);
      if (g.pattern && !re(g.pattern).test(value)) add('pattern', `does not match ${g.pattern}`);
      if (g.noControl !== false && CONTROL_CHARACTERS.test(value))
        add('control', 'contains a control character');
      return;
    }
    case 'integer':
      if (typeof value !== 'number')
        return add('type', `expected an integer, got ${describe(value)} ${show(value)}`);
      if (!Number.isInteger(value))
        return add('range', `expected an integer, got ${String(value)}`);
      if (value < g.min || value > g.max) add('range', `${value} is outside ${g.min} to ${g.max}`);
      return;
    case 'boolean':
      if (typeof value !== 'boolean') add('type', `expected a boolean, got ${describe(value)}`);
      return;
    case 'enum':
      if (typeof value !== 'string' || !g.values.includes(value))
        add('enum', `${JSON.stringify(value)} is not one of ${g.values.join(', ')}`);
      return;
    case 'ref':
      if (typeof value !== 'string' || !re(refPattern(g.to)).test(value))
        add('reference', `${JSON.stringify(value)} is not a ${g.to} identifier`);
      return;
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value))
        return add('type', `expected an object, got ${describe(value)}`);
      const rec = value as Record<string, unknown>;
      for (const key of Object.keys(rec)) {
        const at = pointer(path, key);
        if (!Object.hasOwn(g.properties, key)) add('member', 'unknown property', at);
        else check(g.properties[key]!, rec[key], at, out);
      }
      for (const key of g.required ?? [])
        if (!Object.hasOwn(rec, key)) add('member', 'required', pointer(path, key));
      return;
    }
    case 'array':
      if (!Array.isArray(value)) return add('type', `expected an array, got ${describe(value)}`);
      if (value.length > g.maxItems) add('count', `more than ${g.maxItems} items`);
      if (g.minItems !== undefined && value.length < g.minItems)
        add('count', `fewer than ${g.minItems} items`);
      // A hostile array is not walked item by item past its bound (I7: no unbounded work).
      for (let i = 0; i < Math.min(value.length, g.maxItems + 1); i++)
        check(g.items, value[i], `${path}/${i}`, out);
      return;
    case 'json': {
      if (g.objectOnly && (typeof value !== 'object' || Array.isArray(value)))
        return add('type', 'expected an object');
      const before = out.length;
      checkJson(value, path, 1, g.maxDepth, out);
      if (g.keyPattern && typeof value === 'object' && !Array.isArray(value)) {
        for (const key of Object.keys(value as object)) {
          if (!re(g.keyPattern).test(key))
            add('key', `key does not match ${g.keyPattern}`, pointer(path, key));
        }
      }
      if (out.length === before) checkSize(value, g.maxBytes, path, out);
      return;
    }
    case 'elementTree': {
      const before = out.length;
      // { "ref": id }: the tree is shared, in a preserved_def (spike S11).
      if (
        typeof value === 'object' &&
        value !== null &&
        !Array.isArray(value) &&
        Object.hasOwn(value, 'ref')
      ) {
        const rec = value as Record<string, unknown>;
        if (g.noRef) return add('element', 'a shared tree cannot refer to another', `${path}/ref`);
        if (Object.keys(rec).length !== 1) add('element', 'a reference holds only `ref`', path);
        if (typeof rec['ref'] !== 'string' || !re(DEFINITION_ID_PATTERN).test(rec['ref']))
          add('reference', 'ref is not a preserved_def identifier', `${path}/ref`);
        return;
      }
      if (typeof value === 'object' && value !== null && Object.hasOwn(value, 'name'))
        add('element', 'the top level names no element; the node implies it', `${path}/name`);
      checkElementBody(value, path, 1, g.maxDepth, out);
      if (out.length === before) checkSize(value, g.maxBytes, path, out);
      return;
    }
  }
}

function checkSize(value: unknown, maxBytes: number, path: string, out: GrammarProblem[]): void {
  try {
    const bytes = utf8(canonicalize(value)).length;
    if (bytes > maxBytes)
      out.push({
        path,
        kind: 'size',
        message: `${path}: ${bytes} bytes of canonical JSON, more than ${maxBytes}`,
      });
  } catch (e) {
    out.push({
      path,
      kind: 'type',
      message: `${path}: not canonicalisable JSON (${(e as Error).message})`,
    });
  }
}

/** Free JSON: no floating-point numbers, bounded depth (03 §1 principle 7). */
function checkJson(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  out: GrammarProblem[],
): void {
  if (depth > maxDepth)
    return void out.push({
      path,
      kind: 'depth',
      message: `${path}: nested deeper than ${maxDepth}`,
    });
  if (value === null || typeof value === 'boolean' || typeof value === 'string') return;
  if (typeof value === 'number') {
    if (!Number.isInteger(value) || Math.abs(value) > MAX_INTEROPERABLE_INTEGER)
      out.push({
        path,
        kind: 'range',
        message: `${path}: ${value} is not an integer in the interoperable range; decimals are strings`,
      });
    return;
  }
  if (Array.isArray(value))
    return void value.forEach((v, i) => checkJson(v, `${path}/${i}`, depth + 1, maxDepth, out));
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>))
      checkJson(v, pointer(path, k), depth + 1, maxDepth, out);
    return;
  }
  out.push({ path, kind: 'type', message: `${path}: ${typeof value} is not JSON` });
}

/** `{ attrs?, children? }`: the attributes and children of an element whose name the node implies. */
function checkElementBody(
  value: unknown,
  path: string,
  depth: number,
  maxDepth: number,
  out: GrammarProblem[],
): void {
  const add = (kind: GrammarProblemKind, at: string, message: string) =>
    void out.push({ path: at, kind, message: `${at}: ${message}` });
  if (depth > maxDepth) return add('depth', path, `nested deeper than ${maxDepth}`);
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return add('element', path, 'expected an element body object');
  const rec = value as Record<string, unknown>;
  for (const key of Object.keys(rec)) {
    if (key !== 'attrs' && key !== 'children' && key !== 'name')
      add('element', pointer(path, key), 'unknown member of an element');
  }
  if (Object.hasOwn(rec, 'attrs')) {
    const attrs = rec['attrs'];
    if (typeof attrs !== 'object' || attrs === null || Array.isArray(attrs))
      add('element', `${path}/attrs`, 'expected an object');
    else {
      for (const [k, v] of Object.entries(attrs as Record<string, unknown>)) {
        const at = pointer(`${path}/attrs`, k);
        if (!preservedName(k)) add('element', at, 'not a registered-prefix or Clark-notation name');
        if (typeof v !== 'string') add('element', at, 'attribute values are strings');
        else if (CONTROL_CHARACTERS.test(v)) add('control', at, 'contains a control character');
      }
    }
  }
  if (Object.hasOwn(rec, 'children')) {
    const children = rec['children'];
    if (!Array.isArray(children)) return add('element', `${path}/children`, 'expected an array');
    children.forEach((child, i) => {
      const p = `${path}/children/${i}`;
      if (typeof child !== 'object' || child === null || Array.isArray(child))
        return add('element', p, 'expected an element or a text object');
      const c = child as Record<string, unknown>;
      if (Object.hasOwn(c, 'text')) {
        if (Object.keys(c).length !== 1 || typeof c['text'] !== 'string')
          add('element', p, 'a text child is exactly { "text": string }');
        return;
      }
      if (typeof c['name'] !== 'string' || !preservedName(c['name']))
        add('element', `${p}/name`, 'not a registered-prefix or Clark-notation name');
      checkElementBody(c, p, depth + 1, maxDepth, out);
    });
  }
}
