/**
 * Preserved data is created only by import (owner decision 2, default; second review SR-C2):
 * editors may keep, move, copy within the document or delete it, never create or alter it. The
 * importer records the SHA-256 of every preserved payload it created in the source map; the
 * writer writes back only payloads whose digest is there, so a tree, an atom or an `origin` that a
 * client made up never reaches the file. The authority's commit check is the first line; this is
 * the second.
 *
 * A payload is identified without the node's own identifier and `ext`, so that a copy of a
 * paragraph or an atom within the document (a fresh `id`, I2) is still the import's payload.
 */
import { canonicalize, sha256Hex, type JsonEnvelope, type JsonNode } from '@docedit/model';
import type { JsonValue } from '@docedit/model/definition';

export type PayloadKind = 'attribute' | 'mark' | 'atom' | 'origin' | 'definition';

export interface Payload {
  kind: PayloadKind;
  /** The object the writer reads the payload from: a node, a mark or a definition node. */
  owner: object;
  text: string;
}

function atomText(node: JsonNode): string {
  const attrs = { ...(node.attrs ?? {}) };
  delete attrs['id'];
  delete attrs['ext'];
  return canonicalize({ type: node.type, attrs });
}

/** Every preserved payload of a document, with the object it belongs to. */
export function payloads(env: JsonEnvelope): Payload[] {
  const out: Payload[] = [];
  const walk = (n: JsonNode): void => {
    const attrs = n.attrs ?? {};
    if (n.type === 'preserved_block' || n.type === 'preserved_inline')
      out.push({ kind: 'atom', owner: n, text: atomText(n) });
    else if (n.type === 'preserved_def')
      out.push({
        kind: 'definition',
        owner: n,
        text: canonicalize({ id: attrs['id'] ?? null, tree: attrs['tree'] ?? null }),
      });
    else {
      const p = attrs['preserved'];
      if (p !== undefined && p !== null)
        out.push({
          kind: 'attribute',
          owner: n,
          text: canonicalize({ type: n.type, preserved: p as JsonValue }),
        });
      const o = attrs['origin'];
      if (o !== undefined && o !== null)
        out.push({
          kind: 'origin',
          owner: n,
          text: canonicalize({ type: n.type, origin: o as JsonValue }),
        });
    }
    for (const m of n.marks ?? [])
      if (m.type === 'preserved' && m.attrs?.['props'] !== undefined)
        out.push({ kind: 'mark', owner: m, text: canonicalize(m.attrs['props'] as JsonValue) });
    for (const c of n.content ?? []) walk(c);
  };
  walk(env.doc);
  return out;
}

const digestOf = (p: { kind: PayloadKind; text: string }): Promise<string> =>
  sha256Hex(`${p.kind}\u0000${p.text}`);

/** The sorted, distinct digests of a document's preserved payloads, for the source map. */
export async function payloadDigests(env: JsonEnvelope): Promise<string[]> {
  const texts = new Map<string, { kind: PayloadKind; text: string }>();
  for (const p of payloads(env)) texts.set(`${p.kind}\u0000${p.text}`, p);
  const out = await Promise.all([...texts.values()].map(digestOf));
  return [...new Set(out)].sort();
}

export type Untrusted = Record<PayloadKind, Set<object>>;

/**
 * The owners of payloads the import did not create, by kind, so that the writer leaves them out.
 * Without an allow-list (a document not imported from Word), every payload is untrusted.
 */
export async function untrustedPayloads(
  env: JsonEnvelope,
  allowed: ReadonlySet<string> | null,
): Promise<Untrusted> {
  const out: Untrusted = {
    attribute: new Set(),
    mark: new Set(),
    atom: new Set(),
    origin: new Set(),
    definition: new Set(),
  };
  const cache = new Map<string, Promise<string>>();
  for (const p of payloads(env)) {
    let trusted = false;
    if (allowed) {
      const key = `${p.kind}\u0000${p.text}`;
      let d = cache.get(key);
      if (!d) cache.set(key, (d = digestOf(p)));
      trusted = allowed.has(await d);
    }
    if (!trusted) out[p.kind].add(p.owner);
  }
  return out;
}

export const untrustedCount = (u: Untrusted): number =>
  Object.values(u).reduce((n, s) => n + s.size, 0);
