/**
 * The preserved payloads of a document (03 §4.6; ADR 0017; CDM-051), each identified by the
 * SHA-256 of its canonical JSON. The second review proposes, as an owner decision not yet made,
 * that only an import may create preserved data (SR-C2). With these digests a commit check can
 * enforce that later without a change to the model: every payload after a commit must already be
 * in the document before it, or come from the import's source map.
 */
import type { JsonNode } from '../canonical/canonical-form.ts';
import { sha256Hex } from '../canonical/hash.ts';
import { canonicalize } from '../canonical/jcs.ts';

export interface PreservedPayload {
  /** `attribute`: a node's `preserved`; `mark`: a `preserved` mark's `props`; `node`: a preserved atom. */
  kind: 'attribute' | 'mark' | 'node';
  /** JSON Pointer of the value. */
  path: string;
  /** The canonical JSON of the value (for an atom: its attributes). */
  canonical: string;
}

/** Every preserved payload of a node and its subtree, in document order. */
export function preservedPayloads(root: JsonNode, base = ''): PreservedPayload[] {
  const out: PreservedPayload[] = [];
  const visit = (node: JsonNode, path: string) => {
    const attrs = node.attrs ?? {};
    if (node.type === 'preserved_block' || node.type === 'preserved_inline')
      out.push({ kind: 'node', path, canonical: canonicalize(attrs) });
    else if (attrs['preserved'] !== undefined && attrs['preserved'] !== null)
      out.push({
        kind: 'attribute',
        path: `${path}/attrs/preserved`,
        canonical: canonicalize(attrs['preserved']),
      });
    (node.marks ?? []).forEach((m, i) => {
      if (m.type === 'preserved' && m.attrs?.['props'] !== undefined)
        out.push({
          kind: 'mark',
          path: `${path}/marks/${i}/attrs/props`,
          canonical: canonicalize(m.attrs['props']),
        });
    });
    (node.content ?? []).forEach((c, i) => visit(c, `${path}/content/${i}`));
  };
  visit(root, base);
  return out;
}

/** The SHA-256 of every distinct preserved payload, sorted. */
export async function preservedDigests(root: JsonNode): Promise<string[]> {
  const texts = [...new Set(preservedPayloads(root).map((p) => `${p.kind}\u0000${p.canonical}`))];
  return (await Promise.all(texts.map((t) => sha256Hex(t)))).sort();
}
