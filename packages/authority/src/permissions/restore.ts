/**
 * Region restores and the definitions they need (07 §13; 08 §8; PRM-049, PRM-050; ADR 0050 item 9).
 * "A region restore that needs a definition that no longer exists recreates it only if the user has
 * `structure`; otherwise the restored paragraphs fall back to the default style, and the user is
 * told." The plan is a pure function of the region's old content, the old and current documents
 * and whether the user holds `structure`, so a dry run and the restore itself get the same answer.
 *
 * Recreating a definition is a change of `defs`, which the outcome check judges as any other: it
 * needs `structure`, and 07 §5.3 for every region that uses the definition. Falling back clears a
 * paragraph's or table's style, removes a character style mark, and clears a paragraph's numbering
 * when its numbering definition is gone.
 */
import type { Node } from 'prosemirror-model';

export interface DefinitionPlan {
  /** Definition nodes of the old version to insert again, in the order of the old `defs`. */
  recreate: Node[];
  /** Definitions the content needs that are gone and are not recreated, as `defs:<type>/<id>`. */
  replaced: string[];
  /** The region to restore, with references to replaced definitions taken out. */
  region: Node;
}

type J = Record<string, unknown>;

function definitions(doc: Node): Map<string, Node> {
  const out = new Map<string, Node>();
  doc.child(0).forEach((d) => {
    const id = d.attrs['id'];
    if (typeof id === 'string') out.set(`${d.type.name}/${id}`, d);
  });
  return out;
}

/** The definitions a region's content refers to directly, as `<type>/<id>`. */
function references(region: Node): Set<string> {
  const out = new Set<string>();
  region.descendants((n) => {
    if (
      (n.type.name === 'paragraph' || n.type.name === 'table') &&
      typeof n.attrs['style'] === 'string'
    )
      out.add(`style_def/${n.attrs['style']}`);
    const num = n.attrs['numbering'] as { numberingId?: string } | null | undefined;
    if (n.type.name === 'paragraph' && num?.numberingId)
      out.add(`numbering_def/${num.numberingId}`);
    for (const m of n.marks)
      if (m.type.name === 'charStyle') out.add(`style_def/${String(m.attrs['style'])}`);
    return true;
  });
  return out;
}

/** What a definition itself refers to: a style's `basedOn`, `next` and numbering. */
function dependencies(d: Node): string[] {
  const out: string[] = [];
  if (d.type.name !== 'style_def') return out;
  for (const a of ['basedOn', 'next', 'link'])
    if (typeof d.attrs[a] === 'string') out.push(`style_def/${String(d.attrs[a])}`);
  const num = d.attrs['numbering'] as { numberingId?: string } | null;
  if (num?.numberingId) out.push(`numbering_def/${num.numberingId}`);
  return out;
}

export function planRestoreDefinitions(
  region: Node,
  oldDoc: Node,
  currentDoc: Node,
  hasStructure: boolean,
): DefinitionPlan {
  const old = definitions(oldDoc);
  const current = definitions(currentDoc);
  const missing = [...references(region)].filter((k) => !current.has(k));
  const recreate = new Set<string>();
  const replaced = new Set<string>();
  if (hasStructure) {
    // Recreate what the old version had, with the definitions those depend on.
    const queue = [...missing];
    while (queue.length) {
      const k = queue.shift()!;
      if (current.has(k) || recreate.has(k)) continue;
      const d = old.get(k);
      if (!d) {
        replaced.add(k);
        continue;
      }
      recreate.add(k);
      queue.push(...dependencies(d));
    }
  } else for (const k of missing) replaced.add(k);
  const gone = (k: string) => replaced.has(k);
  const rewrite = (n: J): J => {
    const out: J = { ...n };
    const attrs = n['attrs'] as J | undefined;
    if (attrs) {
      const a: J = { ...attrs };
      if ((n['type'] === 'paragraph' || n['type'] === 'table') && typeof a['style'] === 'string')
        if (gone(`style_def/${a['style']}`)) a['style'] = null;
      const num = a['numbering'] as { numberingId?: string } | null | undefined;
      if (n['type'] === 'paragraph' && num?.numberingId && gone(`numbering_def/${num.numberingId}`))
        a['numbering'] = null;
      out['attrs'] = a;
    }
    if (Array.isArray(n['marks']))
      out['marks'] = (n['marks'] as J[]).filter(
        (m) =>
          !(m['type'] === 'charStyle' && gone(`style_def/${String((m['attrs'] as J)['style'])}`)),
      );
    if (Array.isArray(n['content'])) out['content'] = (n['content'] as J[]).map(rewrite);
    return out;
  };
  const restored = replaced.size
    ? region.type.schema.nodeFromJSON(rewrite(region.toJSON() as J))
    : region;
  const order: Node[] = [];
  oldDoc.child(0).forEach((d) => {
    const id = d.attrs['id'];
    if (typeof id === 'string' && recreate.has(`${d.type.name}/${id}`)) order.push(d);
  });
  return {
    recreate: order,
    replaced: [...replaced].sort().map((k) => `defs:${k}`),
    region: restored,
  };
}
