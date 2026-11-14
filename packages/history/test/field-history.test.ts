// Who filled a field (08 §7; HIS-016): the answer comes from the commits whose scopes include
// `field:<id>`, newest first, behind the caller's gate, with the user, session, time and origin of
// each. Server-authored commits show their origin with the user or `system`.
import { NOTHING_HIDDEN } from '@docedit/authority';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { fieldHistory } from '../src/reader.ts';
import { HIDDEN, LogBuilder, meta, posInside, posOf, schema } from './fixtures.ts';

const FIELD = 'fTenantName00001';
const UNUSED_FIELD = 'fSecretName00001';

/**
 * Seq 1: alice types in the introduction. Seq 2: erin fills the field. Seq 3: bob types. Seq 4:
 * erin changes the value again. Seq 5: the server prefills the field (origin `prefill`).
 */
function build(): LogBuilder {
  const b = new LogBuilder();
  b.add((d) => new Transform(d).insert(posInside(d, 'pIntro0000000001', 0), schema.text('A ')), {
    user: 'alice',
    scopes: ['body'],
  });
  b.add((d) => new Transform(d).setNodeAttribute(posOf(d, FIELD), 'value', 'Erin Ltd'), {
    user: 'erin',
    origin: 'fill',
    scopes: [`field:${FIELD}`],
  });
  b.add((d) => new Transform(d).insert(posInside(d, 'pEnd00000000001Z', 0), schema.text('B ')), {
    user: 'bob',
    scopes: ['body'],
  });
  b.add((d) => new Transform(d).setNodeAttribute(posOf(d, FIELD), 'value', 'Erin Ltd 2'), {
    user: 'erin',
    origin: 'fill',
    scopes: [`field:${FIELD}`],
  });
  b.add((d) => new Transform(d).setNodeAttribute(posOf(d, FIELD), 'value', 'Prefilled'), {
    user: 'system',
    session: 'system',
    origin: 'prefill',
    scopes: [`field:${FIELD}`],
  });
  return b;
}

const metas = (b: LogBuilder) => b.log.map(meta);
const seqsOf = (r: ReturnType<typeof fieldHistory>) => (r.ok ? r.entries.map((e) => e.seq) : null);

describe('who filled a field (HIS-016)', () => {
  it('names the user, time and seq of the latest commit that touched the field', () => {
    const b = build();
    const r = fieldHistory(FIELD, metas(b), { min: 0, head: b.head }, NOTHING_HIDDEN);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.entries[0]).toEqual({
      seq: 5,
      user: 'system',
      session: 'system',
      time: 1_005_000,
      origin: 'prefill',
    });
  });

  it('lists every commit that touched the field, newest first, with user, session, time and origin', () => {
    const b = build();
    const r = fieldHistory(FIELD, metas(b), { min: 0, head: b.head }, NOTHING_HIDDEN);
    // The body edits by alice (1) and bob (3) are not in the field's history.
    expect(seqsOf(r)).toEqual([5, 4, 2]);
    if (!r.ok) return;
    expect(r.entries[2]).toEqual({
      seq: 2,
      user: 'erin',
      session: 's-erin',
      time: 1_002_000,
      origin: 'fill',
    });
    for (const e of r.entries) expect(e).not.toHaveProperty('agent');
  });

  it('shows the origin of a server-authored value with the system as its user', () => {
    const b = build();
    const r = fieldHistory(FIELD, metas(b), { min: 0, head: b.head }, NOTHING_HIDDEN);
    if (!r.ok) throw new Error(r.reason);
    expect(r.entries[0]).toMatchObject({ user: 'system', origin: 'prefill' });
  });

  it('withholds commits at or below the minimum visible seq and above the head', () => {
    const b = build();
    expect(seqsOf(fieldHistory(FIELD, metas(b), { min: 2, head: b.head }, NOTHING_HIDDEN))).toEqual(
      [5, 4],
    );
    expect(seqsOf(fieldHistory(FIELD, metas(b), { min: 0, head: 3 }, NOTHING_HIDDEN))).toEqual([2]);
  });

  it('says so, with an empty list, for a field that never changed', () => {
    const b = build();
    const r = fieldHistory(UNUSED_FIELD, metas(b), { min: 0, head: b.head }, NOTHING_HIDDEN);
    expect(r).toEqual({ ok: true, fieldId: UNUSED_FIELD, entries: [] });
  });

  it('refuses the history of a field whose value the caller may not see, as if it did not exist', () => {
    const b = build();
    expect(fieldHistory(FIELD, metas(b), { min: 0, head: b.head }, HIDDEN)).toMatchObject({
      ok: false,
      code: 'not_found',
    });
    expect(
      fieldHistory(UNUSED_FIELD, metas(b), { min: 0, head: b.head }, NOTHING_HIDDEN, () => false),
    ).toMatchObject({ ok: false, code: 'not_found' });
  });
});
