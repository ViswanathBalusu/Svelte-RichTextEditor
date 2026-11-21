// Anchoring chain heads in batches (08 §12; HIS-036; ADR 0409): the leaf of a head, the tree over
// the heads of a tenant, the inclusion path of one head, the text of the signed record, and the
// check a relying party makes. The leaf and node layouts are checked against a second computation
// made here with Node.js's own SHA-256, byte by byte. The signature and the time-stamp are the signing
// service's and are tested there.
import { createHash } from 'node:crypto';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type AnchoredHead,
  HEAD_ANCHOR_FORMAT,
  anchorLeaf,
  anchorPath,
  anchorTree,
  headAnchorRecordText,
  headCovered,
  leafListText,
  parseHeadAnchorRecord,
  parseLeafList,
  rootFromPath,
} from '../src/head-anchor.ts';

const bytesOf = (h: string) => Uint8Array.from(h.match(/../g)!.map((x) => parseInt(x, 16)));
const sha = async (b: Uint8Array) => createHash('sha256').update(b).digest('hex');
const cat = (...parts: Uint8Array[]) => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
const INCARNATION = '11111111-1111-4111-8111-111111111111';
const TENANT = '22222222-2222-4222-8222-222222222222';
const headOf = (n: number, seq = n): AnchoredHead => ({
  doc: uuid(n),
  incarnation: INCARNATION,
  seq,
  chainHead: n.toString(16).padStart(2, '0').repeat(32),
});

/** The leaf as ADR 0409 writes it, computed here without the module. */
async function leafByHand(h: AnchoredHead): Promise<string> {
  const seq = new Uint8Array(8);
  new DataView(seq.buffer).setBigUint64(0, BigInt(h.seq));
  return sha(
    cat(
      Uint8Array.of(0x00),
      bytesOf(h.doc.replaceAll('-', '')),
      bytesOf(h.incarnation.replaceAll('-', '')),
      seq,
      bytesOf(h.chainHead),
    ),
  );
}
const nodeByHand = (l: string, r: string) => sha(cat(Uint8Array.of(0x01), bytesOf(l), bytesOf(r)));

describe('the leaf of a head (ADR 0409 point 3)', () => {
  it('is SHA-256 of 0x00, the document, the incarnation, seq as 8 bytes big endian and the chain head', async () => {
    for (const h of [headOf(1), headOf(2, 300), headOf(3, 2 ** 40 + 7)]) {
      const l = await anchorLeaf(h);
      if (!l.ok) throw new Error(l.reason);
      expect(l.leaf).toBe(await leafByHand(h));
    }
  });

  it('changes with each member of the head', async () => {
    const base = headOf(1);
    const leafOf = async (h: AnchoredHead) => {
      const l = await anchorLeaf(h);
      if (!l.ok) throw new Error(l.reason);
      return l.leaf;
    };
    const leaves = await Promise.all([
      leafOf(base),
      leafOf({ ...base, doc: uuid(2) }),
      leafOf({ ...base, incarnation: '33333333-3333-4333-8333-333333333333' }),
      leafOf({ ...base, seq: 2 }),
      leafOf({ ...base, chainHead: 'ab'.repeat(32) }),
    ]);
    expect(new Set(leaves).size).toBe(5);
  });

  it('refuses a head that is not one', async () => {
    const h = headOf(1);
    for (const bad of [
      { ...h, doc: 'not-a-uuid' },
      { ...h, incarnation: '' },
      { ...h, seq: 0 },
      { ...h, seq: 1.5 },
      { ...h, chainHead: 'AB'.repeat(32) },
      { ...h, chainHead: 'ab'.repeat(31) },
    ])
      expect((await anchorLeaf(bad)).ok).toBe(false);
  });
});

describe('the tree over the heads of a tenant (ADR 0409 points 2 and 3)', () => {
  it('sorts the leaves by document, hashes pairs with 0x01 and carries an odd node up unchanged', async () => {
    const heads = [headOf(3), headOf(1), headOf(2)];
    const t = await anchorTree(heads);
    if (!t.ok) throw new Error(t.reason);
    expect(t.leaves.map((l) => l.doc)).toEqual([uuid(1), uuid(2), uuid(3)]);
    const [a, b, c] = await Promise.all([1, 2, 3].map((n) => leafByHand(headOf(n))));
    expect(t.leaves.map((l) => l.leaf)).toEqual([a, b, c]);
    // Level 1: node(a, b) and c carried up; the root is node(node(a, b), c).
    expect(t.root).toBe(await nodeByHand(await nodeByHand(a!, b!), c!));
  });

  it('is the leaf itself for one head, and the same whatever the order of the heads', async () => {
    const one = await anchorTree([headOf(7)]);
    if (!one.ok) throw new Error(one.reason);
    expect(one.root).toBe(await leafByHand(headOf(7)));
    const forward = await anchorTree([1, 2, 3, 4, 5].map((n) => headOf(n)));
    const backward = await anchorTree([5, 4, 3, 2, 1].map((n) => headOf(n)));
    if (!forward.ok || !backward.ok) throw new Error('tree refused');
    expect(backward.root).toBe(forward.root);
  });

  it('refuses an empty set, a document that appears twice and a malformed head', async () => {
    expect((await anchorTree([])).ok).toBe(false);
    expect((await anchorTree([headOf(1), headOf(1, 2)])).ok).toBe(false);
    expect((await anchorTree([headOf(1), { ...headOf(2), chainHead: 'x' }])).ok).toBe(false);
  });

  it('keeps a leaf from being read as an inner node', async () => {
    // Two leaves as one tree, and a single "leaf" made of their node's bytes, have other roots.
    const two = await anchorTree([headOf(1), headOf(2)]);
    if (!two.ok) throw new Error(two.reason);
    const [a, b] = two.leaves.map((l) => l.leaf);
    expect(two.root).toBe(await nodeByHand(a!, b!));
    expect(two.root).not.toBe(await sha(cat(Uint8Array.of(0x00), bytesOf(a!), bytesOf(b!))));
  });
});

describe('the inclusion path of a head', () => {
  it('leads from every leaf to the root, for every size of tree (property)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 33 }), async (count) => {
        const heads = Array.from({ length: count }, (_, i) => headOf(i + 1, i + 5));
        const t = await anchorTree(heads);
        if (!t.ok) throw new Error(t.reason);
        // A path has at most one hash per level.
        const depth = Math.ceil(Math.log2(count));
        for (const h of heads) {
          const p = await anchorPath(t, h.doc);
          if (!p.ok) throw new Error(p.reason);
          expect(p.head).toEqual(h);
          expect(p.path.length).toBeLessThanOrEqual(depth);
          const r = await rootFromPath(p.leaf, p.path);
          expect(r).toEqual({ ok: true, root: t.root });
          expect(await headCovered(t, { head: p.head, path: p.path })).toMatchObject({
            ok: true,
            covered: true,
          });
        }
      }),
      { numRuns: 40 },
    );
  });

  it('does not lead to the root for another head, another seq or a changed step', async () => {
    const heads = [1, 2, 3, 4, 5].map((n) => headOf(n));
    const t = await anchorTree(heads);
    if (!t.ok) throw new Error(t.reason);
    const p = await anchorPath(t, uuid(3));
    if (!p.ok) throw new Error(p.reason);
    const covered = async (head: AnchoredHead, path = p.path) => {
      const r = await headCovered(t, { head, path });
      if (!r.ok) throw new Error(r.reason);
      return r.covered;
    };
    expect(await covered(p.head)).toBe(true);
    expect(await covered({ ...p.head, seq: p.head.seq + 1 })).toBe(false);
    expect(await covered({ ...p.head, chainHead: 'cd'.repeat(32) })).toBe(false);
    expect(await covered({ ...p.head, incarnation: uuid(99) })).toBe(false);
    expect(await covered(headOf(4), p.path)).toBe(false);
    const flipped = p.path.map((s, i) =>
      i === 0 ? { ...s, side: s.side === 'left' ? ('right' as const) : ('left' as const) } : s,
    );
    expect(await covered(p.head, flipped)).toBe(false);
    expect(await covered(p.head, p.path.slice(1))).toBe(false);
  });

  it('refuses a document that is not in the tree, and a malformed path', async () => {
    const t = await anchorTree([headOf(1), headOf(2)]);
    if (!t.ok) throw new Error(t.reason);
    expect(await anchorPath(t, uuid(9))).toMatchObject({ ok: false, code: 'not_found' });
    expect((await rootFromPath('zz', [])).ok).toBe(false);
    expect(
      (await rootFromPath(t.leaves[0]!.leaf, [{ side: 'up' as never, hash: t.leaves[1]!.leaf }]))
        .ok,
    ).toBe(false);
    expect((await headCovered(t, { head: headOf(1), path: 'none' as never })).ok).toBe(false);
  });
});

describe('the record that is signed', () => {
  const fields = {
    tenant: TENANT,
    from: '2026-11-21T00:00:00.000Z',
    to: '2026-11-21T01:00:00.000Z',
    root: 'ab'.repeat(32),
    leaves: 3,
    previous: 'cd'.repeat(32),
  };

  it('is JSON with its members in alphabetical order and no white space', () => {
    const r = headAnchorRecordText(fields);
    if (!r.ok) throw new Error(r.reason);
    expect(r.text).toBe(
      `{"format":"${HEAD_ANCHOR_FORMAT}","from":"2026-11-21T00:00:00.000Z","leaves":3,"previous":"${'cd'.repeat(32)}","root":"${'ab'.repeat(32)}","tenant":"${TENANT}","to":"2026-11-21T01:00:00.000Z"}`,
    );
    expect(parseHeadAnchorRecord(r.text)).toEqual({
      ok: true,
      record: { format: HEAD_ANCHOR_FORMAT, ...fields },
    });
  });

  it('has neither from nor previous for the first record of a tenant, and both afterwards', () => {
    expect(headAnchorRecordText({ ...fields, from: null, previous: null }).ok).toBe(true);
    expect(headAnchorRecordText({ ...fields, from: null }).ok).toBe(false);
    expect(headAnchorRecordText({ ...fields, previous: null }).ok).toBe(false);
  });

  it('refuses a member that is not of its shape', () => {
    for (const bad of [
      { ...fields, tenant: 'acme' },
      { ...fields, to: '2026-11-21 01:00' },
      { ...fields, from: fields.to },
      { ...fields, root: 'AB'.repeat(32) },
      { ...fields, leaves: 0 },
      { ...fields, previous: 'cd' },
    ])
      expect(headAnchorRecordText(bad).ok).toBe(false);
  });

  it('reads only the text it writes: no other member, order, spacing or format', () => {
    const r = headAnchorRecordText(fields);
    if (!r.ok) throw new Error(r.reason);
    const o = JSON.parse(r.text) as Record<string, unknown>;
    for (const text of [
      'not json',
      '[]',
      JSON.stringify({ ...o, extra: 1 }),
      JSON.stringify({ ...o, format: 'docedit-anchor/2' }),
      JSON.stringify(o, null, 1),
      JSON.stringify({ to: o['to'], ...o }),
      JSON.stringify({ ...o, leaves: '3' }),
    ])
      expect(parseHeadAnchorRecord(text).ok, text).toBe(false);
  });
});

describe('the stored leaf list', () => {
  it('gives the tree back, and a path from it', async () => {
    const t = await anchorTree([1, 2, 3, 4].map((n) => headOf(n)));
    if (!t.ok) throw new Error(t.reason);
    const back = await parseLeafList(leafListText(t));
    if (!back.ok) throw new Error(back.reason);
    expect(back.tree).toEqual({ root: t.root, leaves: t.leaves });
    const p = await anchorPath(back.tree, uuid(2));
    if (!p.ok) throw new Error(p.reason);
    expect(await rootFromPath(p.leaf, p.path)).toEqual({ ok: true, root: t.root });
  });

  it('is refused when a leaf was changed, added or removed, or the text is not a leaf list', async () => {
    const t = await anchorTree([1, 2, 3].map((n) => headOf(n)));
    if (!t.ok) throw new Error(t.reason);
    const o = JSON.parse(leafListText(t)) as { root: string; leaves: Array<{ seq: number }> };
    const changed = structuredClone(o);
    changed.leaves[1]!.seq += 1;
    const fewer = { ...o, leaves: o.leaves.slice(1) };
    for (const text of [
      JSON.stringify(changed),
      JSON.stringify(fewer),
      JSON.stringify({ ...o, format: 'other' }),
      JSON.stringify({ ...o, leaves: [null] }),
      'not json',
    ])
      expect((await parseLeafList(text)).ok, text.slice(0, 40)).toBe(false);
  });
});
