/**
 * EXP-116, criteria 1 and 2 over the whole corpus. The source map is an immutable, content-addressed
 * asset next to the original package, and it records, for every identified node the import created,
 * the location of its original element and its hash as imported. Nodes without a single original
 * element (synthetic nodes, shared trees) carry a hash, and a shared tree names the located nodes
 * that hold it. A modelled node's `preserved` attribute is an element tree that passes the
 * grammar of ADR 0017 part 2 (I11).
 */
import { describe, expect, it } from 'vitest';
import { sha256HexBytes, type JsonNode } from '@docedit/model';
import { checkPreserved, importDocx } from '../src/index.ts';
import { NodeHasher } from '../src/hash.ts';
import type { NodeSource, SourceMap } from '../src/source-map.ts';
import type { TreeBody } from '../src/tree.ts';
import { entryData, readZip } from '../src/zip.ts';
import { corpusFiles, readFile } from './corpus.ts';

const HEX64 = /^[0-9a-f]{64}$/;

function walk(n: JsonNode, visit: (node: JsonNode) => void): void {
  visit(n);
  for (const c of n.content ?? []) walk(c, visit);
}

const located = (s: Pick<NodeSource, 'part' | 'start' | 'end' | 'hash'> | undefined): boolean =>
  !!s && typeof s.part === 'string' && s.start >= 0 && s.start < s.end && HEX64.test(s.hash);

/** The entry for an identified node, or a reason it is missing or incomplete. */
function check(
  sm: SourceMap,
  n: JsonNode,
  id: string,
  part: (start: number, end: number, p: string) => boolean,
): string | null {
  const where = sm.nodes[id] ?? sm.defs[id] ?? sm.breaks[id];
  if (where) {
    if (!located(where)) return 'incomplete location or hash';
    return part(where.start, where.end, where.part) ? null : 'range outside its part';
  }
  const derived = sm.derived[id];
  if (!derived) return 'no entry';
  if (!HEX64.test(derived.hash)) return 'no hash';
  if (n.type === 'preserved_def') {
    if (!derived.holders?.length) return 'shared tree without holders';
    const lost = derived.holders.filter((h) => !located(sm.nodes[h] ?? sm.defs[h]));
    return lost.length ? `holders without a location: ${lost.join(', ')}` : null;
  }
  return sm.synthetic.includes(id) ? null : 'derived but neither synthetic nor shared';
}

describe.each(corpusFiles())('$name', (file) => {
  it('records a location and a hash for every identified node the import created', async () => {
    const bytes = readFile(file);
    const imported = await importDocx(bytes);
    const sm = imported.sourceMap;
    const sizes = new Map<string, number>();
    const zip = readZip(bytes);
    for (const e of zip.entries) sizes.set(e.name, entryData(zip, e).length);
    const inPart = (start: number, end: number, p: string): boolean =>
      sizes.has(p) && end <= sizes.get(p)!;

    const hasher = new NodeHasher();
    const problems: string[] = [];
    const types = new Set<string>();
    const nodes: Array<{ n: JsonNode; id: string }> = [];
    walk(imported.envelope.doc as JsonNode, (n) => {
      const id = n.attrs?.['id'];
      if (typeof id === 'string') nodes.push({ n, id });
    });
    for (const { n, id } of nodes) {
      types.add(n.type);
      const why = check(sm, n, id, inPart);
      if (why) {
        problems.push(`${n.type} ${id}: ${why}`);
        continue;
      }
      // The recorded hash is the node's hash as imported (the document is unchanged here).
      const recorded = (sm.nodes[id] ?? sm.defs[id] ?? sm.breaks[id] ?? sm.derived[id])!.hash;
      if (recorded !== (await hasher.hash(n))) problems.push(`${n.type} ${id}: hash differs`);
    }
    expect(problems.slice(0, 5)).toEqual([]);
    expect(nodes.length).toBeGreaterThan(0);
    expect(types.has('style_def') || types.has('paragraph')).toBe(true);
  });

  it('stores the source map as an immutable asset next to the original', async () => {
    const bytes = readFile(file);
    const imported = await importDocx(bytes);
    const original = imported.assets.get(imported.originalAsset);
    const map = imported.assets.get(imported.sourceMapAsset);
    expect(original?.role).toBe('original');
    expect(map?.role).toBe('source-map');
    expect(map?.serverOnly).toBe(true);
    expect(original?.serverOnly).toBe(true);
    // Content-addressed: the recorded digest is the digest of the stored bytes.
    expect(map?.sha256).toBe(await sha256HexBytes(map!.bytes));
    expect(original?.sha256).toBe(await sha256HexBytes(bytes));
    // The stored asset is the source map the import returned, entries included.
    expect(JSON.parse(new TextDecoder().decode(map!.bytes))).toEqual(imported.sourceMap);
  });

  it('keeps preserved attributes as element trees that pass the grammar (I11)', async () => {
    const imported = await importDocx(readFile(file));
    const problems: string[] = [];
    walk(imported.envelope.doc as JsonNode, (n) => {
      const preserved = n.attrs?.['preserved'] as TreeBody | { ref: string } | undefined;
      if (!preserved || typeof preserved !== 'object' || 'ref' in preserved) return;
      for (const p of checkPreserved(preserved)) problems.push(`${n.type}: ${p}`);
    });
    expect(problems.slice(0, 5)).toEqual([]);
  });
});
