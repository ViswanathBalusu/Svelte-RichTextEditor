// The attribution map (08 §7; HIS-014, HIS-017): runs mapped through every step, inserted content
// attributed to its commit, formatting and attribute changes ignored, checkpoint plus replay equal to
// a whole replay, assistants named with the person, and projections that hide who wrote what.
import { ENGINE, type LogCommit, project, projectionSchema } from '@docedit/authority';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { Fragment, Slice } from 'prosemirror-model';
import { ReplaceStep, Step, Transform } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import {
  AttributionMap,
  CHUNK,
  HIDDEN_AUTHOR,
  applyCommit,
  attributionAt,
  authorLabel,
  commitAuthor,
  coversExactly,
  isStructural,
  projectAttribution,
  type RestoreHint,
  type Run,
} from '../src/attribution.ts';
import type { Author } from '../src/types.ts';
import {
  CANARY,
  HIDDEN,
  LogBuilder,
  baseDoc,
  posInside,
  posOf,
  schema,
  stepCommit,
  typeAt,
} from './fixtures.ts';
import { EDIT_KINDS, randomEdit } from './random-edits.ts';

const creator: Author = { user: 'owner', seq: 0 };

/** The specification itself, one entry per position: the oracle for the chunked map. */
class NaiveMap {
  authors: Author[];
  constructor(size: number, a: Author) {
    this.authors = new Array<Author>(size).fill(a);
  }
  apply(step: Step, a: Author, hint?: readonly Run[]) {
    const ranges: Array<[number, number, number, number]> = [];
    step.getMap().forEach((os, oe, ns, ne) => {
      ranges.push([os, oe, ns, ne]);
    });
    const structural = isStructural(step);
    for (let i = ranges.length - 1; i >= 0; i--) {
      const [os, oe, ns, ne] = ranges[i]!;
      if (structural && oe - os === ne - ns) continue;
      const fill: Author[] = [];
      if (hint && ranges.length === 1) {
        for (const r of hint)
          for (let k = 0; k < r.len; k++)
            fill.push({ ...strip(r), restoredBy: a.user, restoredSeq: a.seq });
      } else for (let k = 0; k < ne - ns; k++) fill.push(a);
      this.authors.splice(os, oe - os, ...fill);
    }
  }
}

function strip(r: Author): Author {
  const a: Author = { user: r.user, seq: r.seq };
  if (r.agent !== undefined) a.agent = r.agent;
  if (r.restoredBy !== undefined) a.restoredBy = r.restoredBy;
  if (r.restoredSeq !== undefined) a.restoredSeq = r.restoredSeq;
  return a;
}

function expand(map: AttributionMap): Author[] {
  const out: Author[] = [];
  for (const r of map.runs()) for (let k = 0; k < r.len; k++) out.push(strip(r));
  return out;
}

describe('the attribution map (HIS-014)', () => {
  it('maps the runs through a step and gives inserted content a run of its commit', () => {
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    const tr = typeAt(doc, 'pIntro0000000001', 5, 'very ');
    const c = stepCommit(1, tr.steps, { user: 'bob' });
    applyCommit(map, c, schema);
    const at = posInside(doc, 'pIntro0000000001', 5);
    expect(map.slice(at - 1, at + 6).map((r) => [r.user, r.seq, r.len])).toEqual([
      ['owner', 0, 1],
      ['bob', 1, 5],
      ['owner', 0, 1],
    ]);
    expect(coversExactly(map, tr.doc)).toBe(true);
    // Deleting part of bob's text shrinks his run; the rest of the map moves with it.
    const tr2 = new Transform(tr.doc).delete(at + 1, at + 3);
    applyCommit(map, stepCommit(2, tr2.steps, { user: 'carol' }), schema);
    expect(map.slice(at, at + 3).map((r) => [r.user, r.len])).toEqual([['bob', 3]]);
    expect(coversExactly(map, tr2.doc)).toBe(true);
  });

  it('agrees with a per-position model and covers every position exactly once (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...EDIT_KINDS),
            a: fc.double({ min: 0, max: 0.999, noNaN: true }),
            b: fc.double({ min: 0, max: 0.999, noNaN: true }),
            user: fc.constantFrom('alice', 'bob', 'carol'),
            agent: fc.option(fc.constant('assistant-1'), { nil: undefined }),
          }),
          { minLength: 40, maxLength: 220 },
        ),
        (edits) => {
          let doc = baseDoc();
          const map = AttributionMap.create(doc.content.size, creator);
          const naive = new NaiveMap(doc.content.size, creator);
          let seq = 0;
          for (const e of edits) {
            const tr = randomEdit(doc, e.kind, e.a, e.b, 'w');
            if (!tr || !tr.steps.length) continue;
            seq++;
            const author: Author = { user: e.user, seq, ...(e.agent ? { agent: e.agent } : {}) };
            for (const s of tr.steps) {
              map.applyStep(s, author);
              naive.apply(s, author);
            }
            doc = tr.doc;
          }
          expect(coversExactly(map, doc)).toBe(true);
          expect(expand(map)).toEqual(naive.authors);
          expect(map.runs().every((r) => r.len > 0)).toBe(true);
        },
      ),
      { numRuns: 60, seed: 14 },
    );
  });

  it('is tested with every kind of random edit (the generator is not vacuous)', () => {
    let doc = baseDoc();
    const applied = new Map<string, number>();
    let x = 0.137;
    const next = () => (x = (x * 9301 + 0.49297) % 1);
    for (let i = 0; i < 600; i++) {
      const kind = EDIT_KINDS[i % EDIT_KINDS.length]!;
      const tr = randomEdit(doc, kind, next(), next(), 'w');
      if (!tr?.steps.length) continue;
      applied.set(kind, (applied.get(kind) ?? 0) + 1);
      doc = tr.doc;
    }
    for (const kind of new Set(EDIT_KINDS)) expect(applied.get(kind) ?? 0, kind).toBeGreaterThan(0);
  });

  it('keeps more runs than one chunk holds in order', () => {
    let doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    const naive = new NaiveMap(doc.content.size, creator);
    for (let seq = 1; seq <= 3 * CHUNK; seq++) {
      const blocks = ['pIntro0000000001', 'pTerms000000002A', 'pEnd00000000001Z'];
      const tr = typeAt(doc, blocks[seq % 3]!, (seq * 7) % 5, `${seq % 10}`);
      const a = { user: `u${seq % 4}`, seq };
      for (const s of tr.steps) {
        map.applyStep(s, a);
        naive.apply(s, a);
      }
      doc = tr.doc;
    }
    expect(map.runCount).toBeGreaterThan(2 * CHUNK);
    expect(expand(map)).toEqual(naive.authors);
  });

  it('does not change for formatting: marks, attributes and a paragraph re-typed in place', () => {
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    applyCommit(
      map,
      stepCommit(1, typeAt(doc, 'pIntro0000000001', 0, 'Now ').steps, { user: 'bob' }),
      schema,
    );
    const before = map.toJSON();
    const d1 = typeAt(doc, 'pIntro0000000001', 0, 'Now ').doc;
    const at = posOf(d1, 'pIntro0000000001');
    const node = d1.nodeAt(at)!;
    const tr = new Transform(d1)
      .addMark(at + 1, at + 1 + node.content.size, schema.marks['italic']!.create())
      .setNodeAttribute(at, 'align', 'center')
      .setBlockType(at, at + node.nodeSize, schema.nodes['paragraph']!, {
        ...node.attrs,
        style: 'LegalQuote',
      });
    expect(tr.steps.some(isStructural)).toBe(true);
    applyCommit(map, stepCommit(2, tr.steps, { user: 'carol', origin: 'format' }), schema);
    expect(map.toJSON()).toEqual(before);
  });

  it('attributes pasted content to the person who pasted it', () => {
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    // Copy two paragraphs of the terms region and paste them after the introduction.
    const from = posOf(doc, 'pTerms000000001A');
    const to = posOf(doc, 'pTerms000000003A');
    const copy = doc.slice(from, to).content;
    const renamed: Node[] = [];
    copy.forEach((n, _, i) =>
      renamed.push(n.type.create({ ...n.attrs, id: `pPasted00000000${i}` }, n.content)),
    );
    const at =
      posOf(doc, 'pIntro0000000001') + doc.nodeAt(posOf(doc, 'pIntro0000000001'))!.nodeSize;
    const step = new ReplaceStep(at, at, new Slice(Fragment.from(renamed), 0, 0));
    applyCommit(map, stepCommit(1, [step], { user: 'dave', origin: 'paste' }), schema);
    const runs = map.slice(at, at + Fragment.from(renamed).size);
    expect(runs.map((r) => [r.user, r.seq])).toEqual([['dave', 1]]);
  });

  it('creates no run for an attribute change such as a field value (HIS-016 answers who filled it)', () => {
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    let fieldPos = -1;
    doc.descendants((n, pos) => {
      if (n.attrs['id'] === 'fTenantName00001') fieldPos = pos;
      return fieldPos < 0;
    });
    const tr = new Transform(doc).setNodeAttribute(fieldPos, 'value', 'Erin');
    applyCommit(
      map,
      stepCommit(1, tr.steps, { user: 'erin', origin: 'fill', scopes: ['field:fTenantName00001'] }),
      schema,
    );
    expect(map.runCount).toBe(1);
    expect(map.at(fieldPos)).toEqual(creator);
  });

  it('serialises for a checkpoint and reads back the same map', () => {
    let doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    for (let seq = 1; seq <= 40; seq++) {
      const tr = typeAt(doc, seq % 2 ? 'pIntro0000000001' : 'pEnd00000000001Z', seq % 5, 'ab');
      map.applyStep(tr.steps[0]!, {
        user: seq % 3 ? 'bob' : 'carol',
        seq,
        ...(seq % 7 ? {} : { agent: 'helper' }),
      });
      doc = tr.doc;
    }
    const json = JSON.parse(JSON.stringify(map.toJSON()));
    const back = AttributionMap.fromJSON(json);
    expect(back.equals(map)).toBe(true);
    expect(back.toJSON()).toEqual(map.toJSON());
    expect(() => AttributionMap.fromJSON({ v: 2 } as never)).toThrow();
  });

  it('gives the same map from a checkpoint plus a replay as from the whole log (property)', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom(...EDIT_KINDS),
            a: fc.double({ min: 0, max: 0.999, noNaN: true }),
            b: fc.double({ min: 0, max: 0.999, noNaN: true }),
            user: fc.constantFrom('alice', 'bob'),
          }),
          { minLength: 10, maxLength: 80 },
        ),
        fc.uniqueArray(fc.integer({ min: 1, max: 80 }), { maxLength: 5 }),
        fc.integer({ min: 0, max: 80 }),
        (edits, checkpointSeqs, at) => {
          const b = new LogBuilder();
          const hints = new Map<number, RestoreHint>();
          const maps: AttributionMap[] = [AttributionMap.create(b.doc.content.size, creator)];
          for (const e of edits) {
            const tr = randomEdit(b.doc, e.kind, e.a, e.b, 'x');
            if (!tr || !tr.steps.length) continue;
            const c = b.add(() => tr, { user: e.user });
            // Every eleventh commit is a restore whose inserted content keeps an older author.
            let hint: RestoreHint | undefined;
            if (c.seq % 11 === 0 && tr.steps.length === 1) {
              const len = (tr.steps[0] as ReplaceStep).slice?.size ?? 0;
              if (tr.steps[0] instanceof ReplaceStep && len > 0) {
                hint = [[{ user: 'original', seq: 0, len }]];
                hints.set(c.seq, hint);
              }
            }
            const m = maps[maps.length - 1]!.clone();
            applyCommit(m, c, schema, hint);
            maps.push(m);
          }
          const head = b.head;
          const seq = Math.min(at, head);
          const checkpoints = [0, ...checkpointSeqs.filter((s) => s <= head)].map((s) => ({
            seq: s,
            map: AttributionMap.fromJSON(JSON.parse(JSON.stringify(maps[s]!.toJSON()))),
          }));
          const source = {
            schema,
            commits: (after: number, to: number) => b.commits(after, to),
            restoreHint: (s: number) => hints.get(s),
          };
          const whole = attributionAt(seq, { ...source, checkpoints: [{ seq: 0, map: maps[0]! }] });
          const near = attributionAt(seq, { ...source, checkpoints });
          expect(whole.ok && near.ok).toBe(true);
          if (whole.ok && near.ok) {
            expect(near.map.toJSON()).toEqual(whole.map.toJSON());
            expect(near.map.equals(maps[seq]!)).toBe(true);
            expect(coversExactly(near.map, b.docs[seq]!)).toBe(true);
          }
        },
      ),
      { numRuns: 60, seed: 4 },
    );
  });

  it('starts again from the map saved with a snapshot commit', () => {
    const b = new LogBuilder();
    b.add((d) => typeAt(d, 'pIntro0000000001', 0, 'A '), { user: 'bob' });
    const restored = AttributionMap.create(b.doc.content.size, {
      user: 'zoe',
      seq: 0,
      restoredBy: 'alice',
      restoredSeq: 2,
    });
    const log: LogCommit[] = [
      ...b.log,
      {
        ...b.log[0]!,
        seq: 2,
        kind: 'snapshot',
        steps: [],
        snapshot: { checkpoint: 'k2', reason: 'restore' },
        engine: ENGINE,
      },
    ];
    const r = attributionAt(2, {
      schema,
      checkpoints: [{ seq: 0, map: AttributionMap.create(b.docs[0]!.content.size, creator) }],
      commits: (after, to) => log.filter((c) => c.seq > after && c.seq <= to),
      snapshot: () => restored,
    });
    expect(r.ok && r.map.equals(restored)).toBe(true);
    const missing = attributionAt(2, {
      schema,
      checkpoints: [{ seq: 0, map: AttributionMap.create(b.docs[0]!.content.size, creator) }],
      commits: (after, to) => log.filter((c) => c.seq > after && c.seq <= to),
    });
    expect(missing).toMatchObject({ ok: false, code: 'internal' });
  });
});

describe('what a person wrote and what an assistant wrote for them (HIS-017)', () => {
  it('names the person and the agent on the runs of an assistant commit', () => {
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    const tr = typeAt(doc, 'pIntro0000000001', 0, 'Drafted. ');
    applyCommit(
      map,
      stepCommit(1, tr.steps, { user: 'bob', agent: 'agent-7', origin: 'assistant' }),
      schema,
    );
    const at = posInside(doc, 'pIntro0000000001');
    expect(map.at(at)).toEqual({ user: 'bob', seq: 1, agent: 'agent-7' });
    expect(authorLabel(map.at(at)!)).toEqual({ kind: 'assistant', user: 'bob', agent: 'agent-7' });
  });

  it('never names an agent the connection did not carry, whatever origin the commit claimed', () => {
    fc.assert(
      fc.property(
        fc.constantFrom('input', 'paste', 'assistant', 'format', 'fill'),
        fc.string({ maxLength: 8 }),
        (origin, text) => {
          const doc = baseDoc();
          const map = AttributionMap.create(doc.content.size, creator);
          const tr = typeAt(doc, 'pEnd00000000001Z', 0, text || 'x');
          applyCommit(map, stepCommit(1, tr.steps, { user: 'bob', origin }), schema);
          for (const r of map.runs()) {
            expect(r.agent).toBeUndefined();
            expect(authorLabel(r).kind).toBe('person');
          }
          expect(commitAuthor(stepCommit(1, [], { user: 'bob', origin })).agent).toBeUndefined();
        },
      ),
      { numRuns: 40, seed: 17 },
    );
  });
});

describe('attribution as a projection (HIS-046)', () => {
  it('gives a hidden region one position of nobody, so neither authors nor lengths show', () => {
    const doc = baseDoc();
    const map = AttributionMap.create(doc.content.size, creator);
    const at = posInside(doc, 'pSecret00000001B', 3);
    const tr = new Transform(doc).insert(at, schema.text(`more ${CANARY}`));
    applyCommit(map, stepCommit(1, tr.steps, { user: 'mallory' }), schema);
    const p = project(tr.doc, HIDDEN, projectionSchema());
    const pm = projectAttribution(map, p.spans);
    expect(pm.size).toBe(p.doc.content.size);
    expect(coversExactly(pm, p.doc)).toBe(true);
    const placeholder = p.spans[0]!.projStart;
    expect(pm.at(placeholder)).toBeUndefined();
    expect(pm.runs().some((r) => r.user === 'mallory')).toBe(false);
    expect(pm.runs().some((r) => r.user === HIDDEN_AUTHOR.user && r.len === 1)).toBe(true);
    // A step with a structural flag of its own type still parses back.
    expect(Step.fromJSON(schema, tr.steps[0]!.toJSON())).toBeInstanceOf(ReplaceStep);
  });
});
