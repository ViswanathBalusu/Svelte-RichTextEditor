/**
 * The region guard's scope comparison without a walk over the whole document (FE-118; ADR 0055).
 *
 * `diffScopes` of @docedit/authority compares two versions of the document as the room's outcome
 * check does (07 §5.1). On `pages-100` it took 3.6 ms of each keystroke, two thirds of them in the
 * longest common subsequence of the body's children, which finds regions and section breaks that
 * moved. A keystroke cannot move anything: it changes one block in place.
 *
 * `scopeDiff` gives what `diffScopes` gives (every field but `visited`, a counter for its own
 * tests) by looking only at the blocks of the body that are not shared between the two versions,
 * when the change has the shape of an edit in place:
 *
 * - the document's attributes, definitions and stories are unchanged, and so are the body's
 *   attributes and its number of children;
 * - each child that differs keeps its node type and its identifier (so every child keeps the key
 *   `diffScopes` sorts it by), and none is a section break;
 * - every region and section break of the body has an identifier of its own (otherwise the full
 *   comparison's results depend on the whole body, and only it gives them).
 *
 * Any other change goes to `diffScopes`. The property test `test/scope-diff.property.test.ts`
 * checks the two against each other on random edits.
 */
import { type ScopeDiff, deepEqual, diffScopes, eqIgnoringFieldValues } from '@docedit/authority';
import type { Node } from 'prosemirror-model';

/** Whether every region and section break of a body has a distinct string identifier. */
const keyedBodies = new WeakMap<Node, boolean>();

function keyed(body: Node): boolean {
  const known = keyedBodies.get(body);
  if (known !== undefined) return known;
  const regions = new Set<string>();
  const breaks = new Set<string>();
  let ok = true;
  for (let i = 0; ok && i < body.childCount; i++) {
    const c = body.child(i);
    const name = c.type.name;
    if (name !== 'region' && name !== 'section_break') continue;
    const id = c.attrs['id'];
    const seen = name === 'region' ? regions : breaks;
    if (typeof id !== 'string' || seen.has(id)) ok = false;
    else seen.add(id);
  }
  keyedBodies.set(body, ok);
  return ok;
}

/** The form fields of a subtree, by identifier, as `diffScopes` collects them. */
function collectFields(node: Node, out: Map<string, Node>): void {
  if (node.type.name === 'form_field') {
    const id = node.attrs['id'];
    if (typeof id === 'string') out.set(id, node);
    return;
  }
  node.forEach((child) => {
    if (!child.isText) collectFields(child, out);
  });
}

type FieldMap = Map<string, { node: Node; container: string }>;

function collectInto(node: Node, container: string, into: FieldMap): void {
  const found = new Map<string, Node>();
  collectFields(node, found);
  for (const [id, n] of found) into.set(id, { node: n, container });
}

const empty = (): ScopeDiff => ({
  changed: [],
  regionsAdded: [],
  regionsRemoved: [],
  regionsMoved: [],
  regionTitleChanged: [],
  regionPolicyChanged: [],
  sectionBreaksChanged: false,
  definitionsChanged: [],
  fields: [],
  fieldNodes: [],
  visited: 0,
});

/**
 * The scopes a change from `before` to `after` touches, exactly as `diffScopes` reports them; an
 * edit in place is compared in time proportional to the blocks it changed.
 */
export function scopeDiff(before: Node, after: Node): ScopeDiff {
  return inPlace(before, after) ?? diffScopes(before, after);
}

/** The comparison of an edit in place, or null when the change has another shape. */
function inPlace(before: Node, after: Node): ScopeDiff | null {
  const top = before.childCount;
  if (before === after || top === 0 || top !== after.childCount) return null;
  // `diffScopes` refuses a document without definitions; it is left to say so.
  if (before.child(0).type.name !== 'defs') return null;
  if (before.type !== after.type || !deepEqual(before.attrs, after.attrs)) return null;
  // Definitions and stories are shared; the body is the last child (03 §3).
  for (let i = 0; i < top - 1; i++) if (before.child(i) !== after.child(i)) return null;
  const b = before.lastChild!;
  const a = after.lastChild!;
  if (b === a || b.type.name !== 'body' || a.type !== b.type) return null;
  if (!deepEqual(b.attrs, a.attrs)) return null;
  const n = b.childCount;
  if (n !== a.childCount) return null;
  let lo = 0;
  while (lo < n && b.child(lo) === a.child(lo)) lo++;
  if (lo === n) return null;
  let hi = n - 1;
  while (hi > lo && b.child(hi) === a.child(hi)) hi--;
  if (!keyed(b)) return null;

  // The children that differ, in body order: blocks and regions, as `diffScopes` splits them.
  const others: Array<[Node, Node]> = [];
  const regions: Array<[Node, Node, string]> = [];
  for (let i = lo; i <= hi; i++) {
    const x = b.child(i);
    const y = a.child(i);
    if (x === y) continue;
    if (x.type !== y.type) return null;
    const name = x.type.name;
    if (name === 'section_break') return null;
    const xid = x.attrs['id'];
    const yid = y.attrs['id'];
    if (typeof xid === 'string' ? xid !== yid : typeof yid === 'string') return null;
    if (name === 'region') regions.push([x, y, xid as string]);
    else others.push([x, y]);
  }
  // Every region keeps its identifier and every block its key, so the body's region and section
  // break identifiers are what they were.
  keyedBodies.set(a, true);

  const counter = { visited: 0 };
  const changed = new Set<string>();
  const diff = empty();
  if (others.some(([x, y]) => !eqIgnoringFieldValues(x, y, counter))) changed.add('body');

  // Form fields of the blocks not shared between the versions (`diffScopes` takes a block as
  // shared when the other version holds the same node anywhere among the body's blocks).
  const fb: FieldMap = new Map();
  const fa: FieldMap = new Map();
  const probe = new Map<string, Node>();
  for (const [x, y] of others) {
    collectFields(x, probe);
    collectFields(y, probe);
  }
  if (probe.size > 0) {
    const bSide = new Set<Node>();
    const aSide = new Set<Node>();
    for (let i = lo; i <= hi; i++) {
      bSide.add(b.child(i));
      aSide.add(a.child(i));
    }
    // A node of the window that also stands outside it: only the full comparison decides then.
    for (let i = 0; i < n; i++) {
      if (i >= lo && i <= hi) continue;
      const c = b.child(i);
      if (bSide.has(c) || aSide.has(c)) return null;
    }
    for (const [x] of others) if (!aSide.has(x)) collectInto(x, 'body', fb);
    for (const [, y] of others) if (!bSide.has(y)) collectInto(y, 'body', fa);
  }

  for (const [x, y, id] of regions) {
    if (!eqIgnoringFieldValues(x, y, counter)) changed.add(`region:${id}`);
    if (!deepEqual(x.attrs['title'], y.attrs['title'])) diff.regionTitleChanged.push(id);
    if (!deepEqual(x.attrs['policy'], y.attrs['policy'])) diff.regionPolicyChanged.push(id);
    collectInto(x, `region:${id}`, fb);
    collectInto(y, `region:${id}`, fa);
  }

  // Field scopes, as in `diffScopes`.
  for (const [id, an] of fa) {
    const bn = fb.get(id);
    if (!bn) {
      changed.add(`field:${id}`);
      continue;
    }
    if (!deepEqual(bn.node.attrs['value'], an.node.attrs['value']))
      diff.fields.push({
        id,
        container: bn.container,
        before: bn.node.attrs['value'],
        after: an.node.attrs['value'],
        node: an.node,
      });
  }
  for (const id of fb.keys()) if (!fa.has(id)) changed.add(`field:${id}`);
  for (const f of diff.fields) changed.add(`field:${f.id}`);
  for (const id of new Set([...fb.keys(), ...fa.keys()])) {
    const x = fb.get(id);
    const y = fa.get(id);
    diff.fieldNodes.push({
      id,
      before: x?.node ?? null,
      after: y?.node ?? null,
      containerBefore: x?.container ?? null,
      containerAfter: y?.container ?? null,
    });
  }
  diff.changed = [...changed].sort();
  diff.visited = counter.visited;
  return diff;
}
