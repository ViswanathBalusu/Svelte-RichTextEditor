// Thinning old payloads for a tenant with a period (08 §11; HIS-032): the plan keeps the recent
// payloads, the named, export, sent and completed versions and their rebuild data, the snapshots and
// everything under a legal hold; the chain still verifies after the thinning; a thinned range answers
// with a fixed reason while its metadata stays.
import { cdmSchema } from '@docedit/model/prosemirror';
import fc from 'fast-check';
import type { Node } from 'prosemirror-model';
import { Step } from 'prosemirror-transform';
import { describe, expect, it } from 'vitest';
import { type LogBundle, verifyBundle } from '../src/chain.ts';
import {
  type PayloadRecord,
  type PinnedVersion,
  payloadThinningPlan,
  payloadRecordsOf,
  thinBundle,
} from '../src/payload-thinning.ts';
import { payloadOf } from '../src/tombstone.ts';
import * as history from '../src/index.ts';
import { bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

const schema = cdmSchema();
const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.UTC(2026, 10, 13);
const OLD = NOW - 400 * DAY;
const RECENT = NOW - DAY;
const PERIOD = 30 * DAY;

/** Eight commits: 1 to 6 older than the period, 7 and 8 recent. */
function aged(): LogBuilder {
  const b = new LogBuilder();
  for (let i = 1; i <= 8; i++)
    b.add((d) => typeAt(d, i % 2 ? 'pIntro0000000001' : 'pSecret00000001B', 0, `${CANARY}${i} `), {
      user: i % 2 ? 'bob' : 'carol',
      time: i <= 6 ? OLD + i : RECENT + i,
    });
  return b;
}

async function bundleFor(
  b: LogBuilder,
  extra: Array<{ seq: number; doc: Node; carry?: boolean }> = [],
): Promise<LogBundle> {
  return bundleOf(b.log, [{ seq: 0, doc: b.docs[0]! }, ...extra]);
}

/** Rebuilds the document at `to` from the checkpoint at seq 0, with the payloads the bundle holds. */
function rebuild(bundle: LogBundle, to: number): unknown {
  let doc = schema.nodeFromJSON(bundle.checkpoints![0]!.content!.doc);
  for (let s = 1; s <= to; s++) {
    const c = bundle.commits.find((x) => x.meta.seq === s)!;
    const payload = c.payload as { steps: unknown[] };
    for (const json of payload.steps) {
      const r = Step.fromJSON(schema, json).apply(doc);
      if (!r.doc) throw new Error(`step of ${s} does not apply`);
      doc = r.doc;
    }
  }
  return doc.toJSON();
}

describe('thinning old payloads with a period (HIS-032)', () => {
  it('removes the old payloads that no version needs and keeps the recent ones (criterion 1)', async () => {
    const b = aged();
    const bundle = await bundleFor(b);
    const plan = payloadThinningPlan(payloadRecordsOf(bundle), [0], [], {
      now: NOW,
      periodMs: PERIOD,
    });
    expect(plan).toMatchObject({ ok: true, remove: [1, 2, 3, 4, 5, 6], keep: [7, 8] });
    if (!plan.ok) throw new Error('plan refused');
    const thinned = thinBundle(bundle, plan);
    expect(thinned).toMatchObject({ ok: true, removed: 6 });
    if (!thinned.ok) return;
    // The metadata and the hashes stay on every row; only the payloads of the old range are gone.
    expect(thinned.bundle.commits.map((c) => c.hash)).toEqual(bundle.commits.map((c) => c.hash));
    expect(thinned.bundle.commits.find((c) => c.meta.seq === 3)!.payload).toBeUndefined();
    expect(thinned.bundle.commits.find((c) => c.meta.seq === 7)!.payload).toBeDefined();
  });

  it('keeps a named, sent or other pinned version rebuildable from its checkpoint (criterion 2)', async () => {
    const b = aged();
    const bundle = await bundleFor(b);
    const versions: PinnedVersion[] = [
      { seq: 2, kind: 'named' },
      { seq: 4, kind: 'sent' },
      { seq: 6, kind: 'pre-restore' }, // not pinned: its rebuild data is not kept on its own
    ];
    const plan = payloadThinningPlan(payloadRecordsOf(bundle), [0], versions, {
      now: NOW,
      periodMs: PERIOD,
    });
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    // Commits 1 to 4 are kept for the two pinned versions; 5 and 6 are not needed by any pinned one.
    expect(plan.keep).toEqual([1, 2, 3, 4, 7, 8]);
    expect(plan.keptForVersions).toEqual([1, 2, 3, 4]);
    expect(plan.remove).toEqual([5, 6]);
    const thinned = thinBundle(bundle, plan);
    if (!thinned.ok) throw new Error('thinning refused');
    // The named version at 2 and the sent version at 4 are rebuilt from the checkpoint at seq 0.
    expect(rebuild(thinned.bundle, 2)).toEqual(b.docs[2]!.toJSON());
    expect(rebuild(thinned.bundle, 4)).toEqual(b.docs[4]!.toJSON());
  });

  it('keeps the chain verifiable after the thinning, because the payload hashes stay (criterion 3)', async () => {
    const b = aged();
    const bundle = await bundleFor(b);
    const plan = payloadThinningPlan(payloadRecordsOf(bundle), [0], [], {
      now: NOW,
      periodMs: PERIOD,
    });
    if (!plan.ok) throw new Error('plan refused');
    const thinned = thinBundle(bundle, plan);
    if (!thinned.ok) throw new Error('thinning refused');
    const report = await verifyBundle(thinned.bundle, { schema });
    expect(report.problems).toEqual([]);
    expect(report).toMatchObject({ status: 'intact', payloadsAbsent: 6, payloadsChecked: 2 });
  });

  it('answers a thinned range with a fixed reason, while its metadata stays in the log (criterion 4, read path)', async () => {
    const b = aged();
    const bundle = await bundleFor(b);
    const plan = payloadThinningPlan(payloadRecordsOf(bundle), [0], [], {
      now: NOW,
      periodMs: PERIOD,
    });
    if (!plan.ok) throw new Error('plan refused');
    const thinned = thinBundle(bundle, plan);
    if (!thinned.ok) throw new Error('thinning refused');
    const gone = payloadOf(thinned.bundle, 3);
    expect(gone).toMatchObject({ ok: false, code: 'not_found' });
    expect(gone.ok ? '' : gone.reason).toBe(
      'the detail of that commit was removed and is not in this log',
    );
    expect(thinned.bundle.commits.find((c) => c.meta.seq === 3)!.meta.kind).toBe('steps');
    expect(payloadOf(thinned.bundle, 7).ok).toBe(true);
  });

  it('removes nothing while a legal hold is in force, and resumes after release (criterion 5)', async () => {
    const b = aged();
    const bundle = await bundleFor(b);
    const held = payloadThinningPlan(payloadRecordsOf(bundle), [0], [], {
      now: NOW,
      periodMs: PERIOD,
      hold: true,
    });
    expect(held).toMatchObject({ ok: true, remove: [] });
    const released = payloadThinningPlan(payloadRecordsOf(bundle), [0], [], {
      now: NOW,
      periodMs: PERIOD,
      hold: false,
    });
    expect(released).toMatchObject({ ok: true, remove: [1, 2, 3, 4, 5, 6] });
  });

  it('refuses a period that is not a whole number of milliseconds, or is negative', () => {
    expect(payloadThinningPlan([], [], [], { now: NOW, periodMs: -1 }).ok).toBe(false);
    expect(payloadThinningPlan([], [], [], { now: NOW, periodMs: 1.5 }).ok).toBe(false);
  });

  it('never removes a recent, snapshot or pinned-rebuild payload, and keeps every seq once (property)', () => {
    const commit = fc.record({
      time: fc.integer({ min: 0, max: 1000 }),
      snapshot: fc.boolean(),
    });
    fc.assert(
      fc.property(
        fc.array(commit, { minLength: 0, maxLength: 14 }),
        fc.array(fc.integer({ min: 0, max: 14 }), { maxLength: 4 }),
        fc.array(
          fc.record({
            seq: fc.integer({ min: 1, max: 14 }),
            kind: fc.constantFrom(
              'named',
              'export',
              'sent',
              'completed',
              'pre-restore',
            ) as fc.Arbitrary<PinnedVersion['kind']>,
          }),
          { maxLength: 4 },
        ),
        fc.integer({ min: 0, max: 1000 }),
        fc.integer({ min: 0, max: 1000 }),
        (commits, cps, versions, now, periodMs) => {
          const records: PayloadRecord[] = commits.map((c, i) => ({
            seq: i + 1,
            time: c.time,
            kind: c.snapshot ? 'snapshot' : 'steps',
          }));
          const plan = payloadThinningPlan(records, cps, versions, { now, periodMs });
          expect(plan.ok).toBe(true);
          if (!plan.ok) return;
          const all = records.map((r) => r.seq).sort((a, b) => a - b);
          expect([...plan.keep, ...plan.remove].sort((a, b) => a - b)).toEqual(all);
          const cut = now - periodMs;
          const byseq = new Map(records.map((r) => [r.seq, r]));
          for (const s of plan.remove) {
            const r = byseq.get(s)!;
            expect(r.kind).not.toBe('snapshot');
            expect(r.time).toBeLessThan(cut);
          }
          // Every pinned version's rebuild data stays.
          for (const v of versions) {
            if (v.kind === 'pre-restore') continue;
            const from = Math.max(0, ...cps.filter((s) => s <= v.seq));
            for (const r of records)
              if (r.seq > from && r.seq <= v.seq) expect(plan.remove).not.toContain(r.seq);
          }
        },
      ),
    );
  });
});

describe('the package entry', () => {
  it('exports the payload thinning plan, so the document service can import it', () => {
    expect(history.payloadThinningPlan).toBe(payloadThinningPlan);
    expect(history.payloadRecordsOf).toBe(payloadRecordsOf);
    expect(history.thinBundle).toBe(thinBundle);
    expect([...history.PINNED_VERSION_KINDS].sort()).toEqual([
      'completed',
      'export',
      'named',
      'sent',
    ]);
  });
});
