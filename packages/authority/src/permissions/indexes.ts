/**
 * The room's permission indexes (07 §5.4; PRM-016): the regions with their ranges and policies,
 * the definitions each region uses, and the form fields. They are built once when the room opens
 * a document and then carried through every commit by mapping region positions through the
 * commit's steps and rescanning only what the commit changed: the regions whose scope differs,
 * the fields of the subtrees that are not shared between the versions, and the page setups only
 * when section breaks or the body's own attributes change.
 *
 * - `regionList()` feeds the access map without a scan of the body.
 * - `definitionUse(doc)` gives, for 07 §5.3, the definitions each region uses directly or through
 *   `basedOn`; it reads the region's direct references from the index and expands them against the
 *   definitions of `doc`, which are few.
 * - `field(id)` finds a field in constant time, for the fill rules (P7; 12 §5).
 */
import type { Node } from 'prosemirror-model';
import type { StepMap } from 'prosemirror-transform';
import type { RegionInfo } from './access.ts';
import { type RegionPolicy, regionPolicyOf } from './model.ts';
import type { ScopeDiff } from './scopes.ts';

export interface RegionEntry {
  id: string;
  policy: RegionPolicy;
  /** The region's position in the document, and its size. */
  pos: number;
  size: number;
}

export interface FieldEntry {
  id: string;
  key: string;
  /** The scope that holds the field: `body`, `region:<id>` or `story:<id>`. */
  container: string;
}

/** What a region refers to itself, before `basedOn` chains are followed. */
interface Direct {
  /** Paragraph, table and character styles; `null` for a paragraph with the default style. */
  styles: ReadonlySet<string | null>;
  numbering: ReadonlySet<string>;
}

const bodyOf = (doc: Node): Node => doc.child(doc.childCount - 1);
const bodyStart = (doc: Node): number => doc.content.size - bodyOf(doc).nodeSize + 1;

function directOf(region: Node): Direct {
  const styles = new Set<string | null>();
  const numbering = new Set<string>();
  region.descendants((n) => {
    if (n.type.name === 'paragraph') {
      styles.add((n.attrs['style'] as string | null) ?? null);
      const num = n.attrs['numbering'] as { numberingId?: string } | null;
      if (num?.numberingId) numbering.add(num.numberingId);
    } else if (n.type.name === 'table' && typeof n.attrs['style'] === 'string')
      styles.add(n.attrs['style']);
    for (const m of n.marks) if (m.type.name === 'charStyle') styles.add(String(m.attrs['style']));
    return true;
  });
  return { styles, numbering };
}

function fieldsOf(node: Node, container: string, into: Map<string, FieldEntry>): void {
  node.descendants((n) => {
    if (n.type.name !== 'form_field') return true;
    const id = n.attrs['id'];
    if (typeof id === 'string') into.set(id, { id, key: String(n.attrs['key']), container });
    return false;
  });
}

/** The page setup in force for each region: the body's, or that of the last section break before it. */
function pageSetupsOf(doc: Node): Map<string, string> {
  const out = new Map<string, string>();
  const body = bodyOf(doc);
  let ps = String(body.attrs['pageSetup']);
  body.forEach((block) => {
    if (block.type.name === 'section_break') ps = String(block.attrs['pageSetup']);
    else if (block.type.name === 'region') out.set(String(block.attrs['id']), ps);
  });
  return out;
}

export class PermissionIndex {
  /** How many nodes the last build or update looked at, for the instrumented tests. */
  readonly scanned: number;
  private readonly regions: ReadonlyMap<string, RegionEntry>;
  private readonly order: readonly string[];
  private readonly fields: ReadonlyMap<string, FieldEntry>;
  private readonly direct: ReadonlyMap<string, Direct>;
  private readonly pageSetups: ReadonlyMap<string, string>;

  private constructor(
    regions: ReadonlyMap<string, RegionEntry>,
    order: readonly string[],
    fields: ReadonlyMap<string, FieldEntry>,
    direct: ReadonlyMap<string, Direct>,
    pageSetups: ReadonlyMap<string, string>,
    scanned: number,
  ) {
    this.regions = regions;
    this.order = order;
    this.fields = fields;
    this.direct = direct;
    this.pageSetups = pageSetups;
    this.scanned = scanned;
  }

  /** Builds the indexes from a whole document (when a room opens one; PRM-016 criterion 4). */
  static build(doc: Node): PermissionIndex {
    const regions = new Map<string, RegionEntry>();
    const order: string[] = [];
    const fields = new Map<string, FieldEntry>();
    const direct = new Map<string, Direct>();
    let pos = bodyStart(doc);
    bodyOf(doc).forEach((block) => {
      if (block.type.name === 'region') {
        const id = String(block.attrs['id']);
        regions.set(id, {
          id,
          policy: regionPolicyOf(block.attrs['policy']),
          pos,
          size: block.nodeSize,
        });
        order.push(id);
        direct.set(id, directOf(block));
        fieldsOf(block, `region:${id}`, fields);
      } else fieldsOf(block, 'body', fields);
      pos += block.nodeSize;
    });
    doc.forEach((top) => {
      if (top.type.name === 'story') fieldsOf(top, `story:${String(top.attrs['id'])}`, fields);
    });
    return new PermissionIndex(regions, order, fields, direct, pageSetupsOf(doc), doc.nodeSize);
  }

  /**
   * The indexes after a commit: region positions mapped through the commit's steps, and only the
   * regions, fields and page setups the commit changed looked at again.
   */
  next(
    before: Node,
    after: Node,
    maps: readonly StepMap[] | null,
    diff: ScopeDiff,
  ): PermissionIndex {
    if (before === after) return this;
    if (maps === null) return PermissionIndex.build(after); // a snapshot replaced the content
    let scanned = 0;
    const regions = new Map<string, RegionEntry>();
    const direct = new Map(this.direct);
    const removed = new Set(diff.regionsRemoved.map((r) => String(r.attrs['id'])));
    const rescan = new Set<string>([
      ...diff.regionsAdded.map((r) => String(r.attrs['id'])),
      ...diff.regionsMoved,
    ]);
    for (const [id, e] of this.regions) {
      if (removed.has(id)) {
        direct.delete(id);
        continue;
      }
      if (rescan.has(id)) continue;
      let p = e.pos;
      let gone = false;
      for (const m of maps) {
        const r = m.mapResult(p, 1);
        if (r.deletedAfter) gone = true;
        p = r.pos;
      }
      const node = gone ? null : after.nodeAt(p);
      if (!node || node.type.name !== 'region' || String(node.attrs['id']) !== id) {
        rescan.add(id);
        continue;
      }
      regions.set(id, {
        id,
        policy: regionPolicyOf(node.attrs['policy']),
        pos: p,
        size: node.nodeSize,
      });
      scanned++;
      if (diff.changed.includes(`region:${id}`)) {
        direct.set(id, directOf(node));
        scanned += node.nodeSize;
      }
    }
    // Regions that are new, moved or could not be followed: found among the body's children.
    const order: string[] = [];
    let pos = bodyStart(after);
    bodyOf(after).forEach((block) => {
      if (block.type.name === 'region') {
        const id = String(block.attrs['id']);
        order.push(id);
        if (rescan.has(id) || !regions.has(id)) {
          regions.set(id, {
            id,
            policy: regionPolicyOf(block.attrs['policy']),
            pos,
            size: block.nodeSize,
          });
          direct.set(id, directOf(block));
          scanned += block.nodeSize;
        }
      }
      pos += block.nodeSize;
    });
    for (const id of [...regions.keys()]) if (!order.includes(id)) regions.delete(id);
    for (const id of [...direct.keys()]) if (!regions.has(id)) direct.delete(id);
    // Fields: those of the subtrees the commit did not share with the document before it.
    const fields = new Map(this.fields);
    for (const f of diff.fieldNodes) {
      if (f.after) {
        fields.set(f.id, {
          id: f.id,
          key: String(f.after.attrs['key']),
          container: f.containerAfter ?? 'body',
        });
      } else if (fields.get(f.id)?.container === f.containerBefore) fields.delete(f.id);
      scanned++;
    }
    // Page setups move only with section breaks, the body's attributes or the region list.
    const pageSetups =
      diff.sectionBreaksChanged ||
      diff.changed.includes('doc') ||
      diff.regionsAdded.length ||
      diff.regionsMoved.length ||
      diff.regionsRemoved.length
        ? pageSetupsOf(after)
        : this.pageSetups;
    return new PermissionIndex(regions, order, fields, direct, pageSetups, scanned);
  }

  /** The regions in body order with their policies, as the access map wants them (07 §4). */
  regionList(): RegionInfo[] {
    return this.order.map((id) => ({ id, policy: this.regions.get(id)!.policy }));
  }

  region(id: string): RegionEntry | undefined {
    return this.regions.get(id);
  }

  /** A field by identifier, in constant time (PRM-016 criterion 6). */
  field(id: string): FieldEntry | undefined {
    return this.fields.get(id);
  }

  get fieldCount(): number {
    return this.fields.size;
  }

  /**
   * The definitions each region uses, directly or through `basedOn` (07 §5.3), expanded against
   * the definitions of `doc`; equal to `definitionUse(doc)` of the outcome check.
   */
  definitionUse(doc: Node): Map<string, Set<string>> {
    const styles = new Map<string, { basedOn: string | null; numbering: string | null }>();
    let defaultStyle = 'Normal';
    doc.child(0).forEach((d) => {
      if (d.type.name === 'style_def') {
        const num = d.attrs['numbering'] as { numberingId?: string } | null;
        styles.set(String(d.attrs['id']), {
          basedOn: (d.attrs['basedOn'] as string | null) ?? null,
          numbering: num?.numberingId ?? null,
        });
      } else if (d.type.name === 'settings')
        defaultStyle = String(d.attrs['defaultParagraphStyle']);
    });
    const expand = (id: string, out: Set<string>) => {
      for (let cur: string | null = id, guard = 0; cur && guard < 20; guard++) {
        out.add(`defs:style_def/${cur}`);
        const s = styles.get(cur);
        if (s?.numbering) out.add(`defs:numbering_def/${s.numbering}`);
        cur = s?.basedOn ?? null;
      }
    };
    const use = new Map<string, Set<string>>();
    for (const id of this.order) {
      const d = this.direct.get(id)!;
      const out = new Set<string>([`defs:page_setup/${this.pageSetups.get(id) ?? ''}`]);
      for (const s of d.styles) expand(s ?? defaultStyle, out);
      for (const n of d.numbering) out.add(`defs:numbering_def/${n}`);
      use.set(id, out);
    }
    return use;
  }

  /** A comparable form of the indexes, for the property test against a full rebuild. */
  snapshot(): unknown {
    return {
      regions: this.order.map((id) => this.regions.get(id)),
      fields: [...this.fields.values()].sort((a, b) => (a.id < b.id ? -1 : 1)),
      direct: this.order.map((id) => {
        const d = this.direct.get(id)!;
        return [id, [...d.styles].map(String).sort(), [...d.numbering].sort()];
      }),
      pageSetups: this.order.map((id) => [id, this.pageSetups.get(id)]),
    };
  }
}
