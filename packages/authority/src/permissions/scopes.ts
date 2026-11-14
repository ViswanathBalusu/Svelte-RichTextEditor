/**
 * Partition a document into permission scopes and find the scopes a commit changed (07 §5.1;
 * PRM-008). ProseMirror shares unchanged subtrees between versions, so identical objects are
 * skipped without looking inside; only scopes whose subtree identity changed are compared
 * structurally. The values of form fields are their own scopes (`field:<id>`, 12 §4.1), so a fill
 * inside a region does not change the region's scope.
 *
 * Scopes:
 * - `doc`: the top of the tree: the doc node's attributes, which stories exist, the attributes of
 *   `body` and of `defs`, and the order of definitions.
 * - `defs:<type>/<id>` (or `defs:settings`): one per definition node.
 * - `story:<id>`: a header or footer, its attributes included.
 * - `body`: the body without the content of regions (regions appear by identifier).
 * - `region:<id>`: a region's attributes and content.
 * - `field:<id>`: a form field's `value`; the field's other attributes belong to its container.
 */
import type { Mark, Node } from 'prosemirror-model';

export interface FieldChange {
  id: string;
  /** Scope that contains the field (where its other attributes live). */
  container: string;
  before: unknown;
  after: unknown;
  /** The field node after the commit (or before, if it was removed). */
  node: Node;
}

/** A form field found in a subtree that is not shared between the two versions. */
export interface FieldNodes {
  id: string;
  before: Node | null;
  after: Node | null;
  /** The scope that contains it on each side, or null where it is absent. */
  containerBefore: string | null;
  containerAfter: string | null;
}

export interface ScopeDiff {
  /** Every scope that differs, as formatted strings, sorted. */
  changed: string[];
  regionsAdded: Node[];
  regionsRemoved: Node[];
  /** Regions present before and after whose position among the body's blocks changed. */
  regionsMoved: string[];
  regionTitleChanged: string[];
  regionPolicyChanged: string[];
  sectionBreaksChanged: boolean;
  /** Definition scopes that changed, with the node type and identifier. */
  definitionsChanged: Array<{ scope: string; type: string; id: string | null }>;
  /** Fields present on both sides whose value changed. */
  fields: FieldChange[];
  /**
   * Every form field of the subtrees that differ, on either side: the fields a commit may have
   * added, removed, moved or changed. Fields of shared subtrees are unchanged by construction.
   */
  fieldNodes: FieldNodes[];
  /** How many nodes were compared structurally (for the pruning test). */
  visited: number;
}

// ---------------------------------------------------------------------------------------------

export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== typeof b || a === null || b === null || typeof a !== 'object') return false;
  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!deepEqual(a[i], b[i])) return false;
    return true;
  }
  if (Array.isArray(b)) return false;
  const ka = Object.keys(a as object);
  const kb = Object.keys(b as object);
  if (ka.length !== kb.length) return false;
  for (const k of ka) {
    if (!Object.prototype.hasOwnProperty.call(b, k)) return false;
    if (!deepEqual((a as Record<string, unknown>)[k], (b as Record<string, unknown>)[k]))
      return false;
  }
  return true;
}

function sameMarks(a: readonly Mark[], b: readonly Mark[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (!a[i]!.eq(b[i]!)) return false;
  return true;
}

function attrsEqualExcept(a: Node, b: Node, except: string | null): boolean {
  const ka = Object.keys(a.attrs);
  for (const k of ka) {
    if (k === except) continue;
    if (!deepEqual(a.attrs[k], b.attrs[k])) return false;
  }
  return true;
}

interface Counter {
  visited: number;
}

/** Structural equality that ignores the `value` of form fields (they are field scopes). */
export function eqIgnoringFieldValues(
  a: Node,
  b: Node,
  counter: Counter = { visited: 0 },
): boolean {
  if (a === b) return true;
  counter.visited++;
  if (a.type !== b.type || !sameMarks(a.marks, b.marks)) return false;
  if (a.isText) return a.text === b.text;
  if (!attrsEqualExcept(a, b, a.type.name === 'form_field' ? 'value' : null)) return false;
  if (a.childCount !== b.childCount) return false;
  for (let i = 0; i < a.childCount; i++)
    if (!eqIgnoringFieldValues(a.child(i), b.child(i), counter)) return false;
  return true;
}

function collectFields(node: Node, out: Map<string, Node>): void {
  if (node.type.name === 'form_field') {
    const id = node.attrs['id'];
    if (typeof id === 'string') out.set(id, node);
    return;
  }
  node.forEach((child) => {
    if (child.isText) return;
    collectFields(child, out);
  });
}

type FieldMap = Map<string, { node: Node; container: string }>;

/** Collects the form fields of a subtree that changed, with the scope that contains them. */
function collectFieldsInto(node: Node | null, container: string, into: FieldMap): void {
  if (!node) return;
  const tmp = new Map<string, Node>();
  collectFields(node, tmp);
  for (const [id, n] of tmp) into.set(id, { node: n, container });
}

function defKey(n: Node): { scope: string; id: string | null } {
  const id = typeof n.attrs['id'] === 'string' ? (n.attrs['id'] as string) : null;
  return { scope: id === null ? `defs:${n.type.name}` : `defs:${n.type.name}/${id}`, id };
}

/** Longest common subsequence membership: which items of `a` (by key) survive in order in `b`. */
function lcsKeep(a: readonly string[], b: readonly string[]): Set<string> {
  const n = a.length;
  const m = b.length;
  // Classic dynamic programming; body children are counted in thousands at most.
  const dp: Uint32Array[] = [];
  for (let i = 0; i <= n; i++) dp.push(new Uint32Array(m + 1));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--)
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
  const keep = new Set<string>();
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      keep.add(a[i]!);
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) i++;
    else j++;
  }
  return keep;
}

function childKey(n: Node, index: number): string {
  const id = n.attrs['id'];
  return typeof id === 'string' ? `${n.type.name}:${id}` : `${n.type.name}@${index}`;
}

function split(doc: Node): { defs: Node; stories: Node[]; body: Node } {
  const stories: Node[] = [];
  let defs: Node | null = null;
  let body: Node | null = null;
  doc.forEach((child) => {
    if (child.type.name === 'defs') defs = child;
    else if (child.type.name === 'story') stories.push(child);
    else if (child.type.name === 'body') body = child;
  });
  if (!defs || !body) throw new Error('document without defs or body');
  return { defs, stories, body };
}

export function diffScopes(before: Node, after: Node): ScopeDiff {
  const counter: Counter = { visited: 0 };
  const changed = new Set<string>();
  const diff: ScopeDiff = {
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
  };
  if (before === after) return diff;
  // Form fields of every subtree that is not shared between the versions, document-wide, so that a
  // field moved between scopes compares with itself.
  const fb: FieldMap = new Map();
  const fa: FieldMap = new Map();
  const b = split(before);
  const a = split(after);

  // doc: top-level attributes, the set of stories (their identifiers: a story's own attributes are
  // its scope), the attributes of body and of defs, the order of definitions.
  const storyIds = (s: Node[]) => s.map((x) => String(x.attrs['id']));
  const defOrder = (d: Node) => {
    const out: string[] = [];
    d.forEach((c) => out.push(defKey(c).scope));
    return out;
  };
  if (
    !deepEqual(before.attrs, after.attrs) ||
    !deepEqual(storyIds(b.stories), storyIds(a.stories)) ||
    !deepEqual(b.body.attrs, a.body.attrs) ||
    (b.defs !== a.defs &&
      (!deepEqual(b.defs.attrs, a.defs.attrs) ||
        !sameMarks(b.defs.marks, a.defs.marks) ||
        !deepEqual(defOrder(b.defs), defOrder(a.defs))))
  ) {
    changed.add('doc');
  }

  // Definitions, one scope each.
  if (b.defs !== a.defs) {
    const bd = new Map<string, Node>();
    const ad = new Map<string, Node>();
    b.defs.forEach((c) => bd.set(defKey(c).scope, c));
    a.defs.forEach((c) => ad.set(defKey(c).scope, c));
    for (const key of new Set([...bd.keys(), ...ad.keys()])) {
      const x = bd.get(key);
      const y = ad.get(key);
      if (x && y && (x === y || eqIgnoringFieldValues(x, y, counter))) continue;
      changed.add(key);
      const n = (y ?? x)!;
      diff.definitionsChanged.push({ scope: key, type: n.type.name, id: defKey(n).id });
    }
  }

  // Stories.
  const bs = new Map(b.stories.map((s) => [String(s.attrs['id']), s] as const));
  const as = new Map(a.stories.map((s) => [String(s.attrs['id']), s] as const));
  for (const id of new Set([...bs.keys(), ...as.keys()])) {
    const x = bs.get(id) ?? null;
    const y = as.get(id) ?? null;
    if (x === y) continue;
    if (!x || !y || !eqIgnoringFieldValues(x, y, counter)) changed.add(`story:${id}`);
    collectFieldsInto(x, `story:${id}`, fb);
    collectFieldsInto(y, `story:${id}`, fa);
  }

  // Body and regions.
  if (b.body !== a.body) {
    const bRegions = new Map<string, Node>();
    const aRegions = new Map<string, Node>();
    const bKeys: string[] = [];
    const aKeys: string[] = [];
    const bOthers: Node[] = [];
    const aOthers: Node[] = [];
    b.body.forEach((c, _o, i) => {
      bKeys.push(childKey(c, i));
      if (c.type.name === 'region') bRegions.set(String(c.attrs['id']), c);
      else bOthers.push(c);
    });
    a.body.forEach((c, _o, i) => {
      aKeys.push(childKey(c, i));
      if (c.type.name === 'region') aRegions.set(String(c.attrs['id']), c);
      else aOthers.push(c);
    });

    // body: the sequence of children with regions as identifiers, other blocks in full.
    let bodyChanged = bKeys.length !== aKeys.length;
    if (!bodyChanged) {
      for (let i = 0, oi = 0; i < bKeys.length; i++) {
        if (bKeys[i] !== aKeys[i]) {
          bodyChanged = true;
          break;
        }
        if (!bKeys[i]!.startsWith('region:')) {
          const x = bOthers[oi]!;
          const y = aOthers[oi]!;
          oi++;
          if (x !== y && !eqIgnoringFieldValues(x, y, counter)) {
            bodyChanged = true;
            break;
          }
        }
      }
    }
    if (bodyChanged) changed.add('body');
    // Blocks of the body that are not shared between the versions hold every changed field.
    const aSet = new Set(aOthers);
    const bSet = new Set(bOthers);
    for (const x of bOthers) if (!aSet.has(x)) collectFieldsInto(x, 'body', fb);
    for (const y of aOthers) if (!bSet.has(y)) collectFieldsInto(y, 'body', fa);

    const bSections = bKeys.filter((k) => k.startsWith('section_break:'));
    const aSections = aKeys.filter((k) => k.startsWith('section_break:'));
    if (!deepEqual(bSections, aSections)) diff.sectionBreaksChanged = true;
    else {
      // A section break whose attributes changed.
      const bsb = new Map<string, Node>();
      b.body.forEach((c) => c.type.name === 'section_break' && bsb.set(String(c.attrs['id']), c));
      a.body.forEach((c) => {
        if (c.type.name !== 'section_break') return;
        const x = bsb.get(String(c.attrs['id']));
        if (x && x !== c && !deepEqual(x.attrs, c.attrs)) diff.sectionBreaksChanged = true;
      });
    }

    // Moves: regions and section breaks present on both sides that are not on the longest common
    // subsequence of the body's children.
    if (bodyChanged) {
      const keep = lcsKeep(bKeys, aKeys);
      for (const id of bRegions.keys())
        if (aRegions.has(id) && !keep.has(`region:${id}`)) diff.regionsMoved.push(id);
      for (const k of bSections)
        if (aSections.includes(k) && !keep.has(k)) diff.sectionBreaksChanged = true;
    }

    for (const id of new Set([...bRegions.keys(), ...aRegions.keys()])) {
      const x = bRegions.get(id) ?? null;
      const y = aRegions.get(id) ?? null;
      if (x && !y) diff.regionsRemoved.push(x);
      if (y && !x) diff.regionsAdded.push(y);
      if (x === y) continue;
      if (!x || !y || !eqIgnoringFieldValues(x, y, counter)) changed.add(`region:${id}`);
      if (x && y) {
        if (!deepEqual(x.attrs['title'], y.attrs['title'])) diff.regionTitleChanged.push(id);
        if (!deepEqual(x.attrs['policy'], y.attrs['policy'])) diff.regionPolicyChanged.push(id);
      }
      collectFieldsInto(x, `region:${id}`, fb);
      collectFieldsInto(y, `region:${id}`, fa);
    }
    for (const id of diff.regionsMoved) changed.add(`region:${id}`);
  }

  // Field scopes: a value that changed, or a field that exists on one side only (07 §5.1: a scope
  // present in one version differs). Adding and removing fields needs edit in their container,
  // which the container's own scope already requires; only value changes go through P7 to P9.
  for (const [id, an] of fa) {
    const bn = fb.get(id);
    if (!bn) {
      changed.add(`field:${id}`);
      continue;
    }
    if (!deepEqual(bn.node.attrs['value'], an.node.attrs['value'])) {
      diff.fields.push({
        id,
        container: bn.container,
        before: bn.node.attrs['value'],
        after: an.node.attrs['value'],
        node: an.node,
      });
    }
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

// ---------------------------------------------------------------------------------------------
// The partition (PRM-008).

/**
 * Every node of a document assigned to exactly one scope, and every form field's value to its
 * own scope (07 §5.1; PRM-008). Nodes are keyed by position: the root is -1, every other node the
 * position before it. The `doc` scope holds the root, `defs` and `body` nodes themselves (their
 * attributes and the order of their children); a definition node is its own scope; a story, a
 * region and everything inside them belong to that story or region; every other block of the body
 * and its content belong to `body`. A form field node belongs to its container; its `value` to
 * `field:<id>`.
 */
export interface ScopePartition {
  nodes: Map<number, string>;
  values: Map<string, string>;
}

export function partitionScopes(doc: Node): ScopePartition {
  const nodes = new Map<number, string>([[-1, 'doc']]);
  const values = new Map<string, string>();
  const subtree = (node: Node, pos: number, scope: string) => {
    nodes.set(pos, scope);
    if (node.type.name === 'form_field' && typeof node.attrs['id'] === 'string')
      values.set(node.attrs['id'], `field:${node.attrs['id']}`);
    node.forEach((child, offset) => subtree(child, pos + 1 + offset, scope));
  };
  doc.forEach((top, offset) => {
    if (top.type.name === 'defs') {
      nodes.set(offset, 'doc');
      top.forEach((d, o) => subtree(d, offset + 1 + o, defKey(d).scope));
    } else if (top.type.name === 'body') {
      nodes.set(offset, 'doc');
      top.forEach((block, o) =>
        subtree(
          block,
          offset + 1 + o,
          block.type.name === 'region' ? `region:${String(block.attrs['id'])}` : 'body',
        ),
      );
    } else subtree(top, offset, `story:${String(top.attrs['id'])}`);
  });
  return { nodes, values };
}
