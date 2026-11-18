/**
 * Who may read what (ADR 0019, proposed; PRM-066, PRM-067; FRW-088). One pure function gives each
 * connection the regions and field values it may not read; the projection gateway uses it for
 * every outgoing message, and the outcome check uses the same rule for values a user cannot read.
 *
 * - A region is hidden from a connection that has no `view` in it. Only confidential regions can
 *   lack `view` (07 §4 with ADR 0019): their readers are the principals with a grant on the region,
 *   of any role, and users with `manage`.
 * - A field value marked `sensitive` is hidden from a connection that is not one of its readers:
 *   users with `manage`, participants holding the field's assignee role, and principals with a
 *   grant on the region that contains the field (ADR 0019's proposal; ADR 0033 records the reading
 *   of "principals named by a grant", since grants exist only on regions).
 * - Values inside a hidden region are not listed: the placeholder hides them already.
 * - Whether hidden regions show their titles is a document-wide option, hidden by default as in
 *   spike S12, until the owner settles ADR 0019's open question.
 */
import { compileDocument, derivedFromHidden } from '@docedit/rules';
import type { Node } from 'prosemirror-model';
import type { HiddenSet } from '../projection/projection.ts';
import { type Access, type RegionInfo, computeAccess } from './access.ts';
import { type Connection, type PermissionState, regionPolicyOf } from './model.ts';

export interface VisibilityOptions {
  /** Whether placeholders of hidden regions carry the region's title. Default: hidden. */
  titles?: boolean;
}

/** The regions of a document's body, with their policies as the authority reads them. */
export function regionInfos(doc: Node): RegionInfo[] {
  const out: RegionInfo[] = [];
  doc.child(doc.childCount - 1).forEach((c) => {
    if (c.type.name === 'region')
      out.push({ id: String(c.attrs['id']), policy: regionPolicyOf(c.attrs['policy']) });
  });
  return out;
}

/**
 * Whether a connection may read a field's value. `container` is the scope that holds the field
 * (`body`, `region:<id>` or `story:<id>`).
 */
export function canReadValue(access: Access, field: Node, container: string | null): boolean {
  if (field.attrs['sensitive'] !== true) return true;
  if (access.docRole.has('manage')) return true;
  const assignee = field.attrs['assignee'];
  if (typeof assignee === 'string' && access.fill.roles.includes(assignee)) return true;
  return (
    container !== null &&
    container.startsWith('region:') &&
    access.granted.has(container.slice('region:'.length))
  );
}

/** The hidden set of a connection whose access is already computed. */
export function hiddenSetOf(access: Access, doc: Node, options: VisibilityOptions = {}): HiddenSet {
  const regions = new Set<string>();
  const values = new Set<string>();
  // The keys of the values this connection may not read: the input of the rule closure (FRW-089).
  const keys = new Set<string>();
  // What a reference may point at inside a hidden region: the reader cannot resolve it (FRW-089).
  const targets = new Set<string>();
  const hide = (n: Node) => {
    const id = n.attrs['id'];
    if (typeof id === 'string') values.add(id);
    if (typeof n.attrs['key'] === 'string') keys.add(n.attrs['key']);
  };
  const fields = (node: Node, container: string) =>
    node.descendants((n) => {
      if (n.type.name !== 'form_field') return true;
      if (!canReadValue(access, n, container)) hide(n);
      return false;
    });
  doc.forEach((top) => {
    if (top.type.name === 'story') fields(top, `story:${String(top.attrs['id'])}`);
    if (top.type.name !== 'body') return;
    top.forEach((block) => {
      if (block.type.name !== 'region') return fields(block, 'body');
      const id = String(block.attrs['id']);
      if (access.regions.get(id)?.has('view') === true) fields(block, `region:${id}`);
      else {
        regions.add(id);
        targets.add(`node:${id}`);
        // The placeholder hides these values, but a rule may still compute from them.
        block.descendants((n) => {
          if (n.type.name === 'form_field' && typeof n.attrs['key'] === 'string')
            keys.add(n.attrs['key']);
          if (typeof n.attrs['id'] === 'string') targets.add(`node:${n.attrs['id']}`);
          if (n.type.name === 'anchor' && typeof n.attrs['name'] === 'string')
            targets.add(`bookmark:${n.attrs['name']}`);
          if (n.type.name.startsWith('equation') && typeof n.attrs['label'] === 'string')
            targets.add(`eq:${n.attrs['label']}`);
          return true;
        });
      }
    });
  });
  if (keys.size > 0) addDerivedValues(doc, keys, values);
  return { regions, values, keys, targets, titles: options.titles ?? false };
}

/**
 * Adds the id of every field whose value the rules compute from a key in `hiddenKeys` (FRW-089): a
 * `set` effect that reads a hidden value, a rule whose condition reads one. When the rules of the
 * document do not compile, no closure can be read, so every field value is hidden (fails closed).
 * The keys of those fields are added to `hiddenKeys`, so that a mirror of one carries no text.
 */
function addDerivedValues(doc: Node, hiddenKeys: Set<string>, values: Set<string>): void {
  const compiled = compileDocument(doc.toJSON());
  const closure = compiled.ok
    ? new Set(derivedFromHidden(compiled.ruleSet, hiddenKeys).derived)
    : null;
  doc.descendants((n) => {
    if (n.type.name !== 'form_field') return true;
    const id = n.attrs['id'];
    const key = n.attrs['key'];
    if (
      typeof id === 'string' &&
      (closure === null || (typeof key === 'string' && closure.has(key)))
    ) {
      values.add(id);
      if (typeof key === 'string') hiddenKeys.add(key);
    }
    return false;
  });
}

/**
 * What a connection may not read in a document under a permission state, at server time `now`
 * (PRM-067). Pure: equal inputs give equal results, and nothing is mutated. Connections with equal
 * results share one visibility class (`visibilityKey` of the projection).
 */
export function hiddenSet(
  conn: Connection,
  doc: Node,
  perms: PermissionState,
  now: number,
  options: VisibilityOptions = {},
): HiddenSet {
  return hiddenSetOf(computeAccess(conn, regionInfos(doc), perms, now), doc, options);
}

/**
 * The projection gateway's `Visibility` function, `(conn, fullDoc, perms) => HiddenSet`, reading the
 * time from the same clock as the room, so that expired grants stop conveying `view`.
 */
export function visibility(
  now: () => number,
  options: VisibilityOptions = {},
): (conn: Connection, fullDoc: Node, perms: PermissionState) => HiddenSet {
  return (conn, fullDoc, perms) => hiddenSet(conn, fullDoc, perms, now(), options);
}
