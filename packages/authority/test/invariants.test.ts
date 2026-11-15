// Invariants on the result of a commit (04 §5 step 6; 03 §8 I2, I3; SYN-011).
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { checkInvariants } from '../src/invariants.ts';
import { applySteps } from '../src/rebase.ts';
import { REQUIRES, baseDoc, posInside, posOf } from './fixtures.ts';

function run(make: (tr: Transform) => void, retired = new Set<string>()) {
  const before = baseDoc();
  const tr = new Transform(before);
  make(tr);
  const r = applySteps(before, tr.steps);
  if (!r.ok) throw new Error(r.reason);
  return checkInvariants(before, r.value.doc, tr.steps, r.value.docs, {
    requires: REQUIRES,
    retiredRegionIds: retired,
  });
}

describe('invariants', () => {
  it('accepts a split whose copy gets a fresh identifier (03 §9)', () => {
    const r = run((tr) => {
      const pos = posInside(tr.doc, 'pIntro0000000001', 4);
      tr.split(pos);
      const $at = tr.doc.resolve(tr.mapping.map(pos));
      tr.setNodeAttribute($at.before($at.depth), 'id', 'pSplitCopy000001');
    });
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);
  });

  it('refuses a split that leaves two nodes with one identifier (I2)', () => {
    const r = run((tr) => tr.split(posInside(tr.doc, 'pIntro0000000001', 4)));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/I2/);
  });

  it('refuses changing the identifier of its only holder (I2, P5)', () => {
    const r = run((tr) =>
      tr.setNodeAttribute(posOf(tr.doc, 'pIntro0000000001'), 'id', 'pRenamed00000001'),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/changes the identifier/);
    const region = run((tr) =>
      tr.setNodeAttribute(posOf(tr.doc, 'rLegal000000000B'), 'id', 'rStolen00000000X'),
    );
    expect(region.ok).toBe(false);
  });

  it('refuses changing the identifier by replacing the node around its content (I2; ADR 0362)', () => {
    // `setNodeMarkup` makes one `replaceAround` step: the content stays, the markup is replaced.
    const r = run((tr) => {
      const pos = posOf(tr.doc, 'pIntro0000000001');
      const node = tr.doc.nodeAt(pos)!;
      tr.setNodeMarkup(pos, null, { ...node.attrs, id: 'pRenamed00000001' });
      expect(tr.steps[0]!.toJSON().stepType).toBe('replaceAround');
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/changes the identifier of a paragraph \(I2\)/);
    const region = run((tr) => {
      const pos = posOf(tr.doc, 'rLegal000000000B');
      tr.setNodeMarkup(pos, null, { ...tr.doc.nodeAt(pos)!.attrs, id: 'rStolen00000000X' });
    });
    expect(region.ok).toBe(false);
    if (!region.ok) expect(region.reason).toMatch(/I2/);
  });

  it('accepts a replacement around the content that keeps the identifier, or that a later step removes', () => {
    const same = run((tr) => {
      const pos = posOf(tr.doc, 'pIntro0000000001');
      const node = tr.doc.nodeAt(pos)!;
      tr.setNodeMarkup(pos, null, { ...node.attrs, align: 'center' });
    });
    expect(same.ok, same.ok ? '' : same.reason).toBe(true);
    // Renamed and then deleted in the same commit: no node is left to have changed identity.
    const gone = run((tr) => {
      const pos = posOf(tr.doc, 'pIntro0000000001');
      const node = tr.doc.nodeAt(pos)!;
      tr.setNodeMarkup(pos, null, { ...node.attrs, id: 'pRenamed00000001' });
      tr.delete(pos, pos + tr.doc.nodeAt(pos)!.nodeSize);
    });
    if (!gone.ok) expect(gone.reason).not.toMatch(/changes the identifier/);
  });

  it('judges I2 by the outcome: the undo of a split and of a join is accepted (ADR 0050 item 1)', () => {
    // A split with the identifier fill, as the client sends it...
    const before = baseDoc();
    const split = new Transform(before);
    const at = posInside(split.doc, 'pIntro0000000001', 4);
    split.split(at);
    const $at = split.doc.resolve(split.mapping.map(at));
    split.setNodeAttribute($at.before($at.depth), 'id', 'pSplitCopy000001');
    const ctx = { requires: REQUIRES, retiredRegionIds: new Set<string>() };
    const done = applySteps(before, split.steps);
    if (!done.ok) throw new Error(done.reason);
    expect(checkInvariants(before, done.value.doc, split.steps, done.value.docs, ctx).ok).toBe(
      true,
    );
    // ...and its undo: the inverse steps in reverse order. The first gives the copy its old
    // identifier back (two nodes share it for a moment), the second joins the copy away.
    const undo = split.steps.map((s, i) => s.invert(split.docs[i]!)).reverse();
    const undone = applySteps(done.value.doc, undo);
    if (!undone.ok) throw new Error(undone.reason);
    expect(undone.value.doc.eq(before)).toBe(true);
    const r = checkInvariants(done.value.doc, undone.value.doc, undo, undone.value.docs, ctx);
    expect(r.ok, r.ok ? '' : r.reason).toBe(true);

    // A join of the title and the introduction, and its undo, which splits them again with the
    // introduction's old identifier.
    const join = new Transform(before);
    join.join(posOf(join.doc, 'pIntro0000000001'));
    const joined = applySteps(before, join.steps);
    if (!joined.ok) throw new Error(joined.reason);
    expect(checkInvariants(before, joined.value.doc, join.steps, joined.value.docs, ctx).ok).toBe(
      true,
    );
    const unjoin = join.steps.map((s, i) => s.invert(join.docs[i]!)).reverse();
    const unjoined = applySteps(joined.value.doc, unjoin);
    if (!unjoined.ok) throw new Error(unjoined.reason);
    expect(unjoined.value.doc.eq(before)).toBe(true);
    const u = checkInvariants(
      joined.value.doc,
      unjoined.value.doc,
      unjoin,
      unjoined.value.docs,
      ctx,
    );
    expect(u.ok, u.ok ? '' : u.reason).toBe(true);
  });

  it('still refuses re-identifying a node through a temporary copy (I2 by outcome)', () => {
    // Insert a copy of the paragraph (two holders of its identifier), rename the original, then
    // delete the copy again: the original survives under a new identifier and the old one is gone.
    const r = run((tr) => {
      const p = tr.doc.nodeAt(posOf(tr.doc, 'pIntro0000000001'))!;
      const end = posOf(tr.doc, 'pEnd00000000001Z');
      tr.insert(end, p.copy(p.content));
      tr.setNodeAttribute(posOf(tr.doc, 'pIntro0000000001'), 'id', 'pRenamed00000001');
      const copyAt = posOf(tr.doc, 'pIntro0000000001');
      tr.delete(copyAt, copyAt + tr.doc.nodeAt(copyAt)!.nodeSize);
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/changes the identifier/);
  });

  it('refuses reusing a retired region identifier (I3)', () => {
    const r = run(
      (tr) => tr.setNodeAttribute(posOf(tr.doc, 'rNotes000000000C'), 'title', 'x'),
      new Set(['rNotes000000000C']),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/I3/);
  });

  it('reports removed regions so that their identifiers are retired', () => {
    const r = run((tr) => {
      const at = posOf(tr.doc, 'rNotes000000000C');
      tr.delete(at, at + tr.doc.nodeAt(at)!.nodeSize);
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.value.removedRegions).toEqual(['rNotes000000000C']);
  });

  it('maps a wrongly typed fill to field_invalid', () => {
    const r = run((tr) => tr.setNodeAttribute(posOf(tr.doc, 'fTenantName00001'), 'value', 42));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('field_invalid');
  });
});
