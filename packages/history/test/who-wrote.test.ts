// "Who wrote this" (05 §6.2 `/attribution`; HIS-015): the runs that cover a passage come from the
// attribution map at the version being viewed, behind the caller's gate, and text a restore brings
// back keeps its original author and names the restoring user.
import { NOTHING_HIDDEN } from '@docedit/authority';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, type RestoreHint, applyCommit } from '../src/attribution.ts';
import { attributionFor } from '../src/reader.ts';
import { LogBuilder, posInside, schema } from './fixtures.ts';

const TERMS = 'rTerms000000000A';
const TERMS_FIRST = 'pTerms000000001A';
const NOTE = 'Bob: ';

/**
 * The attribution map after each seq. Seq 1: bob types a note at the start of the first term.
 * Seq 2: carol deletes it. Seq 3: carol restores it, so the text keeps bob as its author.
 */
function build(): { b: LogBuilder; maps: AttributionMap[] } {
  const b = new LogBuilder();
  b.add((d) => new Transform(d).insert(posInside(d, TERMS_FIRST, 0), schema.text(NOTE)), {
    user: 'bob',
    scopes: ['body'],
  });
  b.add(
    (d) => {
      const at = posInside(d, TERMS_FIRST, 0);
      return new Transform(d).delete(at, at + NOTE.length);
    },
    { user: 'carol', scopes: ['body'] },
  );
  b.add((d) => new Transform(d).insert(posInside(d, TERMS_FIRST, 0), schema.text(NOTE)), {
    user: 'carol',
    origin: 'restore',
    scopes: ['body'],
  });
  const hints = new Map<number, RestoreHint>([[3, [[{ user: 'bob', seq: 1, len: NOTE.length }]]]]);
  const maps = [AttributionMap.create(b.docs[0]!.content.size, { user: 'owner', seq: 0 })];
  for (const c of b.log) {
    const m = maps[maps.length - 1]!.clone();
    applyCommit(m, c, schema, hints.get(c.seq));
    maps.push(m);
  }
  return { b, maps };
}

const at = (b: LogBuilder, maps: AttributionMap[], seq: number, region?: string) =>
  attributionFor({
    doc: b.docs[seq]!,
    map: maps[seq]!,
    seq,
    gate: { min: 0, head: b.head },
    hidden: NOTHING_HIDDEN,
    ...(region === undefined ? {} : { region }),
  });

describe('who wrote this (HIS-015)', () => {
  it('answers from the map at the version being viewed, not the head', () => {
    const { b, maps } = build();
    const before = at(b, maps, 1, TERMS);
    const after = at(b, maps, 2, TERMS);
    if (!before.ok || !after.ok) throw new Error('attribution refused');
    expect(before.spans).toContainEqual({
      blockId: TERMS_FIRST,
      from: 0,
      to: NOTE.length,
      user: 'bob',
      seq: 1,
    });
    // After the deletion nobody is named for the passage bob wrote: the map is the old version's.
    expect(after.spans.some((s) => s.user === 'bob')).toBe(false);
    expect(after.seq).toBe(2);
  });

  it('names the original author of restored text and the user who restored it', () => {
    const { b, maps } = build();
    const head = at(b, maps, b.head, TERMS);
    if (!head.ok) throw new Error('attribution refused');
    expect(head.spans).toContainEqual({
      blockId: TERMS_FIRST,
      from: 0,
      to: NOTE.length,
      user: 'bob',
      seq: 1,
      restoredBy: 'carol',
      restoredSeq: 3,
    });
  });

  it('is refused below the visibility gate, as if the version did not exist', () => {
    const { b, maps } = build();
    const r = attributionFor({
      doc: b.docs[1]!,
      map: maps[1]!,
      seq: 1,
      gate: { min: 2, head: b.head },
      hidden: NOTHING_HIDDEN,
    });
    expect(r).toMatchObject({ ok: false, code: 'forbidden' });
  });
});
