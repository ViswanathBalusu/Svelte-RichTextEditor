/**
 * The places inside a structured attribute value (SEC-005 criteria 1 and 4).
 *
 * 121 of the 337 attributes of the CDM hold more than one value: an object with declared members
 * (`borders`, `numbering`, `format`), an array (`tabs`, `levels`, `items`, `options`), free JSON
 * (`ext`, `payload`, `value`, a rule) or a preserved element tree (ADR 0017). A hostile string put
 * in place of the whole attribute is refused for its type, which says nothing about a string put
 * where the grammar expects one: the label of a choice, the family name of an author, the prefix
 * of a citation, a member of `ext`, the text of a preserved element. Those places are derived
 * here from the grammars of the definition (`CDM1`), not listed by hand:
 *
 * - every declared member of an object, to any depth, and a member the grammar does not declare
 *   whose name is the payload;
 * - the members of the first two items of an array, and one more item that is the payload;
 * - in free JSON: the payload as the value of a new member, as the name of a member, as a further
 *   item of an array, and in place of the strings the value already holds;
 * - in an element tree: the payload as an attribute's value, as an attribute's name, as a child
 *   element's name, as a text child, and as the identifier of a shared tree.
 *
 * A wire suite sends each as one commit and a REST suite as one replacement; both read back what
 * was stored through `stored`.
 */
import type { Grammar, RefTarget } from '@docedit/model/definition';
import type { Json } from './sec-005-fixture.ts';

export type Key = string | number;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** Sets an own member whatever its name: an assignment to `__proto__` would set the prototype. */
export function setOwn(target: Record<string, unknown>, name: string, value: unknown): void {
  Object.defineProperty(target, name, {
    value,
    enumerable: true,
    configurable: true,
    writable: true,
  });
}

/** The value at a path of own members and indexes; undefined when the path leads nowhere. */
export function getAt(value: unknown, path: readonly Key[]): unknown {
  let v = value;
  for (const k of path) {
    if (Array.isArray(v)) v = typeof k === 'number' ? v[k] : undefined;
    else if (isRecord(v)) v = Object.hasOwn(v, String(k)) ? v[String(k)] : undefined;
    else return undefined;
  }
  return v;
}

/** A copy of `value` with `leaf` at `path`; the containers on the way are made when absent. */
export function setAt(value: unknown, path: readonly Key[], leaf: unknown): unknown {
  if (path.length === 0) return leaf;
  const [head, ...rest] = path as [Key, ...Key[]];
  if (typeof head === 'number') {
    const copy: unknown[] = Array.isArray(value) ? [...value] : [];
    copy[head] = setAt(copy[head], rest, leaf);
    return copy;
  }
  const copy: Record<string, unknown> = {};
  if (isRecord(value)) for (const k of Object.keys(value)) setOwn(copy, k, value[k]);
  setOwn(copy, head, setAt(Object.hasOwn(copy, head) ? copy[head] : undefined, rest, leaf));
  return copy;
}

/** Whether an attribute of this grammar holds more than one value. */
export const isStructured = (g: Grammar): boolean =>
  g.kind === 'object' || g.kind === 'array' || g.kind === 'json' || g.kind === 'elementTree';

/** Whether an object somewhere in the grammar declares a member of one of these names. */
export function declaresMember(g: Grammar, names: readonly string[]): boolean {
  if (g.kind === 'array') return declaresMember(g.items, names);
  if (g.kind !== 'object') return false;
  return Object.entries(g.properties).some(
    ([name, child]) => names.includes(name) || declaresMember(child, names),
  );
}

// ---------------------------------------------------------------------------------------------
// A valid value of a grammar, to put the payload in where the document holds none.

/** An identifier of each kind a reference may name, taken from the document itself. */
export type Refs = Partial<Record<RefTarget, string>>;

export function refsOf(doc: Json): Refs {
  const refs: Refs = {};
  const first = (kind: RefTarget, id: unknown): void => {
    if (typeof id === 'string' && refs[kind] === undefined) refs[kind] = id;
  };
  const visit = (node: Json): void => {
    const attrs = node.attrs ?? {};
    switch (node.type) {
      case 'style_def': {
        const kind = (attrs['kind'] as string | undefined) ?? 'paragraph';
        first(`${kind}Style` as RefTarget, attrs['id']);
        first('anyStyle', attrs['id']);
        break;
      }
      case 'numbering_def':
        first('numbering', attrs['id']);
        break;
      case 'page_setup':
        first('pageSetup', attrs['id']);
        break;
      case 'story':
        first(attrs['kind'] === 'footer' ? 'footerStory' : 'headerStory', attrs['id']);
        break;
      case 'role_def':
        first('role', attrs['id']);
        break;
      case 'source_def':
        first('source', attrs['id']);
        break;
      case 'preserved_def':
        first('preservedDef', attrs['id']);
        break;
      default:
        for (const name of ['asset', 'fallbackAsset', 'fragment']) first('asset', attrs[name]);
    }
    for (const child of node.content ?? []) visit(child);
  };
  visit(doc);
  return refs;
}

/** Strings to choose from: the first that fits a grammar's length and pattern is its example. */
const STRINGS: readonly string[] = [
  'a',
  'en',
  '#000000',
  '%1.',
  'sec005nested0001',
  'a'.repeat(64),
  'https://example.test/',
  '2026',
  '1',
  'x.y',
];

/**
 * A value the grammar accepts. `full`: an object with every declared member; otherwise only the
 * required ones. A member named in `hints` takes that value (the suggesting `user`, which rule P4
 * compares with the submitting user). An array has one item, so that its members can be reached.
 */
export function exampleOf(
  g: Grammar,
  refs: Refs,
  hints: Readonly<Record<string, unknown>>,
  full: boolean,
): unknown {
  switch (g.kind) {
    case 'string': {
      const re = g.pattern === undefined ? null : new RegExp(g.pattern);
      const found = STRINGS.find(
        (s) => s.length <= g.maxLength && s.length >= (g.minLength ?? 0) && (!re || re.test(s)),
      );
      if (found === undefined) throw new Error(`no example string matches ${g.pattern}`);
      return found;
    }
    case 'integer':
      return Math.min(Math.max(0, g.min), g.max);
    case 'boolean':
      return false;
    case 'enum':
      return g.values[0];
    case 'ref': {
      const id = refs[g.to];
      if (id === undefined)
        throw new Error(`the document has nothing a ${g.to} reference can name`);
      return id;
    }
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [name, child] of Object.entries(g.properties))
        if (full || (g.required ?? []).includes(name))
          setOwn(
            out,
            name,
            Object.hasOwn(hints, name) ? hints[name] : exampleOf(child, refs, hints, full),
          );
      return out;
    }
    case 'array':
      return [exampleOf(g.items, refs, hints, full)];
    case 'json':
      return {};
    case 'elementTree':
      return { children: [{ name: 'w:keepLines' }] };
  }
}

/** `value` with every declared member of every object in it present, to any depth. */
export function filledOut(
  g: Grammar,
  value: unknown,
  refs: Refs,
  hints: Readonly<Record<string, unknown>>,
): unknown {
  if (value === null || value === undefined) return exampleOf(g, refs, hints, true);
  if (g.kind === 'object' && isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const [name, child] of Object.entries(g.properties))
      setOwn(
        out,
        name,
        Object.hasOwn(value, name) && value[name] !== null
          ? filledOut(child, value[name], refs, hints)
          : Object.hasOwn(hints, name)
            ? hints[name]
            : exampleOf(child, refs, hints, true),
      );
    return out;
  }
  if (g.kind === 'array' && Array.isArray(value)) {
    const items = value.length > 0 ? value : [null];
    return items.map((item) => filledOut(g.items, item, refs, hints));
  }
  return value;
}

export const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

export interface Base {
  /** The value the payloads are put into. */
  base: unknown;
  /** Whether it had to be sent; false when it is what the document held. */
  sent: boolean;
  /**
   * `full`: a value with every declared member, so every member is reached. `held`: the service
   * did not take that (a member that is only allowed beside another one), and this is the value
   * the document held or the smallest valid one. `single`: one string or number, which has
   * nothing inside.
   */
  how: 'full' | 'held' | 'single';
}

/**
 * The value an attribute is given before the payloads go in, so that a refusal is about the
 * payload and not about the value around it. `send` puts a value in the attribute and says
 * whether the service took it. Free JSON is typed by what it belongs to (a field's value by the
 * field's kind), so it is tried as an object, as a list and then as single values. Undefined: the
 * service takes no value at all.
 */
export async function chooseBase(
  g: Grammar,
  original: unknown,
  refs: Refs,
  hints: Readonly<Record<string, unknown>>,
  send: (value: unknown) => Promise<boolean>,
): Promise<Base | undefined> {
  const smallest = original ?? exampleOf(g, refs, hints, false);
  const inside = (v: unknown): boolean => typeof v === 'object' && v !== null;
  const candidates =
    g.kind !== 'json'
      ? [filledOut(g, smallest, refs, hints), smallest]
      : inside(original)
        ? [original]
        : [{}, [], ...(original === null || original === undefined ? [] : [original]), 'a', '1', 1];
  for (const [i, candidate] of candidates.entries()) {
    if (i > 0 && same(candidate, candidates[i - 1])) continue;
    const stored = same(candidate, original);
    if (!stored && !(await send(candidate))) continue;
    const how = !inside(candidate) ? 'single' : i === 0 || g.kind === 'json' ? 'full' : 'held';
    return { base: candidate, sent: !stored, how };
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// The places.

export interface NestedEdit {
  /** JSON Pointer of the place inside the attribute value; `{payload}` where the payload is a name. */
  where: string;
  /** The member the payload becomes the value of; null when the payload is a name. */
  member: string | null;
  /** The whole attribute value with the payload in that place. */
  value(payload: string): unknown;
  /** What a stored attribute value holds in that place, and what it holds when the payload was stored. */
  stored(attrValue: unknown, payload: string): { got: unknown; want: unknown };
}

const pointer = (path: readonly Key[]): string => path.map((k) => `/${String(k)}`).join('');

/** The first key that free JSON with this key pattern accepts as a member name. */
function validKey(pattern: string | undefined): string {
  const re = pattern === undefined ? null : new RegExp(pattern);
  const found = ['sec005', 'test.example:sec005'].find((k) => !re || re.test(k));
  if (found === undefined) throw new Error(`no example key matches ${pattern}`);
  return found;
}

/** The places inside `base`, a valid value of the structured grammar `g`. */
export function nestedEdits(g: Grammar, base: unknown): NestedEdit[] {
  const edits: NestedEdit[] = [];

  /** The payload as the value at `path`. */
  const asValue = (path: readonly Key[]): void => {
    const last = [...path].reverse().find((k): k is string => typeof k === 'string');
    edits.push({
      where: pointer(path),
      member: last ?? null,
      value: (payload) => setAt(base, path, payload),
      stored: (attrValue, payload) => ({ got: getAt(attrValue, path), want: payload }),
    });
  };
  /** The payload as the name of a member of the object at `path`. */
  const asName = (path: readonly Key[]): void => {
    edits.push({
      where: `${pointer(path)}/{payload}`,
      member: null,
      value: (payload) => setAt(base, [...path, payload], 'x'),
      stored: (attrValue, payload) => ({ got: getAt(attrValue, [...path, payload]), want: 'x' }),
    });
  };
  /** A further child of the element at `path`: an element named by the payload, or a text. */
  const asChild = (path: readonly Key[], at: number, key: 'name' | 'text'): void => {
    edits.push({
      where: pointer([...path, 'children', at, key]),
      member: key === 'text' ? 'text' : null,
      value: (payload) => setAt(base, [...path, 'children', at], { [key]: payload }),
      stored: (attrValue, payload) => ({
        got: getAt(attrValue, [...path, 'children', at, key]),
        want: payload,
      }),
    });
  };

  /** The strings free JSON already holds, at most three of them. */
  const strings = (value: unknown, path: readonly Key[], found: Key[][]): void => {
    if (found.length >= 3) return;
    if (typeof value === 'string') found.push([...path]);
    else if (Array.isArray(value)) value.forEach((v, i) => strings(v, [...path, i], found));
    else if (isRecord(value))
      for (const k of Object.keys(value)) strings(value[k], [...path, k], found);
  };

  const walk = (grammar: Grammar, value: unknown, path: readonly Key[]): void => {
    // A member the value does not hold: the payload in its place.
    if (value === null || value === undefined) return asValue(path);
    switch (grammar.kind) {
      case 'object':
        if (!isRecord(value)) return asValue(path);
        for (const [name, child] of Object.entries(grammar.properties))
          walk(child, Object.hasOwn(value, name) ? value[name] : undefined, [...path, name]);
        return asName(path);
      case 'array':
        if (!Array.isArray(value)) return asValue(path);
        value.slice(0, 2).forEach((item, i) => walk(grammar.items, item, [...path, i]));
        return asValue([...path, value.length]);
      case 'json': {
        if (isRecord(value)) {
          asValue([...path, validKey(grammar.keyPattern)]);
          asName(path);
        } else if (Array.isArray(value)) asValue([...path, value.length]);
        // A scalar in place of the whole attribute is the attribute itself, which the caller
        // already covers; inside another value it is a place of its own.
        else if (path.length > 0) asValue(path);
        const found: Key[][] = [];
        if (typeof value !== 'string') strings(value, path, found);
        for (const at of found) asValue(at);
        return;
      }
      case 'elementTree': {
        // The identifier of a shared tree in place of the tree.
        edits.push({
          where: `${pointer(path)}/ref`,
          member: 'ref',
          value: (payload) => setAt(base, path, { ref: payload }),
          stored: (attrValue, payload) => ({
            got: getAt(attrValue, [...path, 'ref']),
            want: payload,
          }),
        });
        if (isRecord(value) && Object.hasOwn(value, 'ref')) return;
        asValue([...path, 'attrs', 'w:val']);
        asName([...path, 'attrs']);
        const children =
          isRecord(value) && Array.isArray(value['children']) ? value['children'] : [];
        asChild(path, children.length, 'name');
        asChild(path, children.length, 'text');
        return;
      }
      default:
        return asValue(path);
    }
  };

  if (isStructured(g)) walk(g, base, []);
  return edits;
}
