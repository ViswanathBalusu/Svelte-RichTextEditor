// HIS-015 criterion 1 (lane HIS-001-016): the answer to "who wrote this" lists the authors and the
// server times of the runs that cover a passage, taken from the attribution map at the version
// being viewed. The times come from the commit list, not from the spans.
import { NOTHING_HIDDEN } from '@docedit/authority';
import { Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { AttributionMap, type RestoreHint, applyCommit } from '../src/attribution.ts';
import { attributionFor } from '../src/reader.ts';
import { withRunTimes } from '../src/who-wrote-times.ts';
import { LogBuilder, posInside, schema } from './fixtures.ts';

const TERMS = 'rTerms000000000A';
const TERMS_FIRST = 'pTerms000000001A';
const NOTE = 'Bob: ';

// Same scenario as who-wrote.test.ts: seq 1 bob types a note, seq 2 carol deletes it, seq 3 carol
// restores it (the text keeps bob as its author).
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

const commitTimes = (b: LogBuilder) => b.log.map((c) => ({ seq: c.seq, time: c.time }));

describe('who wrote this, with server times (HIS-015 criterion 1)', () => {
  it('gives each run the server time of the commit that wrote it, and lists the authors with their times', () => {
    const { b, maps } = build();
    const seq = 3;
    const answer = attributionFor({
      doc: b.docs[seq]!,
      map: maps[seq]!,
      seq,
      gate: { min: 0, head: b.head },
      hidden: NOTHING_HIDDEN,
      region: TERMS,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const timed = withRunTimes(answer, commitTimes(b), { createdAt: 500 });
    expect(timed.ok).toBe(true);
    if (!timed.ok) return;

    // Every run carries the time of its own seq, from the commit list.
    const timeOf = new Map(commitTimes(b).map((c) => [c.seq, c.time] as const));
    timeOf.set(0, 500);
    for (const r of timed.runs) expect(r.time).toBe(timeOf.get(r.seq));

    // The restored note keeps bob (seq 1) as author, at bob's commit time.
    const bob = timed.runs.find((r) => r.user === 'bob');
    expect(bob).toBeDefined();
    expect(bob!.seq).toBe(1);
    expect(bob!.time).toBe(timeOf.get(1));

    // Authors are listed once each, with the seqs and the first and last times of their runs.
    const users = timed.authors.map((a) => a.user);
    expect(new Set(users).size).toBe(users.length);
    const bobSummary = timed.authors.find((a) => a.user === 'bob')!;
    expect(bobSummary.seqs).toEqual([1]);
    expect(bobSummary.firstTime).toBe(timeOf.get(1));
    expect(bobSummary.lastTime).toBe(timeOf.get(1));
    for (const a of timed.authors) {
      expect(a.firstTime).toBeLessThanOrEqual(a.lastTime);
      const total = timed.runs.filter((r) => r.user === a.user).length;
      expect(total).toBeGreaterThan(0);
    }
  });

  it('refuses rather than guess when a run has neither a commit nor a creation time', () => {
    const { b, maps } = build();
    const answer = attributionFor({
      doc: b.docs[1]!,
      map: maps[1]!,
      seq: 1,
      gate: { min: 0, head: b.head },
      hidden: NOTHING_HIDDEN,
      region: TERMS,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    // The owner's creation text (seq 0) is among the runs; without its time the answer is refused.
    const withoutCreation = withRunTimes(answer, commitTimes(b));
    expect(withoutCreation.ok).toBe(false);
    if (withoutCreation.ok) return;
    expect(withoutCreation.code).toBe('internal');
  });

  it('groups an assistant apart from the person it acted for (HIS-017)', () => {
    const answer = {
      seq: 2,
      spans: [
        { blockId: 'a', from: 0, to: 3, user: 'ann', seq: 1 },
        { blockId: 'a', from: 3, to: 6, user: 'ann', seq: 2, agent: 'writer-bot' },
      ],
    };
    const timed = withRunTimes(answer, [
      { seq: 1, time: 10 },
      { seq: 2, time: 20 },
    ]);
    expect(timed.ok).toBe(true);
    if (!timed.ok) return;
    expect(timed.authors).toHaveLength(2);
    const bot = timed.authors.find((a) => a.agent === 'writer-bot')!;
    expect(bot.user).toBe('ann');
    expect(bot.seqs).toEqual([2]);
    const person = timed.authors.find((a) => a.agent === undefined)!;
    expect(person.seqs).toEqual([1]);
    expect(person.firstTime).toBe(10);
  });

  it('gives the same answer whatever order the commit list is given in', () => {
    const { b, maps } = build();
    const answer = attributionFor({
      doc: b.docs[3]!,
      map: maps[3]!,
      seq: 3,
      gate: { min: 0, head: b.head },
      hidden: NOTHING_HIDDEN,
      region: TERMS,
    });
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    const forward = withRunTimes(answer, commitTimes(b), { createdAt: 500 });
    const backward = withRunTimes(answer, [...commitTimes(b)].reverse(), { createdAt: 500 });
    expect(backward).toEqual(forward);
  });
});
