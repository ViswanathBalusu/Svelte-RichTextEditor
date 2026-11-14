// Replacing one commit's payload with a tombstone (08 §13; HIS-040): the chain still verifies,
// the removed text is gone from the commit, the copies that may still hold it are reported, a
// read of the removed payload is refused rather than answered, and the operation is refused under
// a legal hold and audited with the actor and the reason.
import { cdmSchema } from '@docedit/model/prosemirror';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { type LogBundle, verifyBundle } from '../src/chain.ts';
import { NO_HOLD, applyHold } from '../src/hold.ts';
import { payloadOf, tombstone } from '../src/tombstone.ts';
import { DOC, bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

const schema = cdmSchema();
const NOW = 1_800_000_000_000;

async function fixture(): Promise<LogBundle> {
  const b = new LogBuilder();
  for (let i = 0; i < 6; i++)
    b.add((d) => typeAt(d, i % 2 ? 'pSecret00000001B' : 'pIntro0000000001', 0, `${CANARY}${i} `), {
      user: i % 2 ? 'bob' : 'carol',
    });
  return bundleOf(b.log, [
    { seq: 0, doc: b.docs[0]! },
    { seq: 3, doc: b.docs[3]! },
    { seq: 6, doc: b.docs[6]! },
  ]);
}

const clone = (b: LogBundle): LogBundle => JSON.parse(JSON.stringify(b)) as LogBundle;
const req = (seq: number) => ({
  seq,
  actor: 'owner-1',
  reason: 'text that must not be kept',
  now: NOW,
  hold: NO_HOLD,
});

describe('tombstoning a commit (HIS-040)', () => {
  it('keeps the chain verifiable with the payload removed (criterion 1)', async () => {
    const bundle = await fixture();
    const r = tombstone(bundle, req(4));
    if (!r.ok) throw new Error(r.reason);
    const report = await verifyBundle(r.bundle, { schema });
    // The chain itself verifies. The status is `incomplete`, not `intact`, because checkpoint 6
    // cannot be replayed across the tombstoned commit 4, and the verifier says so.
    expect(report).toMatchObject({
      status: 'incomplete',
      head: 6,
      commits: 6,
      payloadsChecked: 5,
      payloadsAbsent: 1,
      problems: [],
    });
    expect(report.checkpoints).toEqual([
      { seq: 0, result: 'match' },
      { seq: 3, result: 'match', from: 0, replayed: 3 },
      { seq: 6, result: 'unchecked', from: 3 },
    ]);
    // The metadata row, the payload hash and the stored links of the removed commit are unchanged.
    const before = bundle.commits[3]!;
    const after = r.bundle.commits[3]!;
    expect(after).toEqual({
      meta: before.meta,
      payloadHash: before.payloadHash,
      prevHash: before.prevHash,
      hash: before.hash,
    });
    expect(JSON.stringify(after)).not.toContain(`${CANARY}3`);
    // The input bundle is not changed.
    expect(bundle.commits[3]!.payload).toBeDefined();
    expect((await verifyBundle(bundle, { schema })).payloadsAbsent).toBe(0);
  });

  it('reports the checkpoints at or after the commit and the attribution runs that may hold its text (criterion 4, report part)', async () => {
    const bundle = await fixture();
    const r = tombstone(bundle, req(4));
    if (!r.ok) throw new Error(r.reason);
    // Checkpoints 0 and 3 are before commit 4; checkpoint 6 was built by replaying it.
    expect(r.copies.checkpoints).toEqual([6]);
    expect(r.copies.attributionMap).toBe('may-hold-runs');
    expect(r.copies.involves).toMatch(/rebuild or remove each listed checkpoint/);
    expect(r.audit).toEqual({
      action: 'tombstone',
      doc: DOC,
      seq: 4,
      actor: 'owner-1',
      reason: 'text that must not be kept',
      at: NOW,
    });
  });

  it('refuses a read of a removed payload with a fixed reason, and answers a present one (criterion 2, read path)', async () => {
    const bundle = await fixture();
    const r = tombstone(bundle, req(4));
    if (!r.ok) throw new Error(r.reason);
    const gone = payloadOf(r.bundle, 4);
    expect(gone).toMatchObject({ ok: false, code: 'not_found' });
    if (gone.ok) throw new Error('unexpected');
    expect(gone.reason).not.toContain(CANARY);
    const kept = payloadOf(r.bundle, 5);
    expect(kept.ok).toBe(true);
    if (kept.ok) expect(JSON.stringify(kept.payload)).toContain(`${CANARY}4`);
    expect(payloadOf(r.bundle, 99)).toMatchObject({ ok: false, code: 'not_found' });
  });

  it('is refused under a legal hold, for an unknown commit, and for one already removed (criterion 3, refusal part)', async () => {
    const bundle = await fixture();
    const held = applyHold(NO_HOLD, { action: 'set', actor: 'admin', reason: 'dispute', now: NOW });
    if (!held.ok) throw new Error(held.reason);
    expect(tombstone(bundle, { ...req(4), hold: held.state })).toMatchObject({
      ok: false,
      code: 'conflict',
    });
    expect(tombstone(bundle, req(99))).toMatchObject({ ok: false, code: 'not_found' });
    expect(tombstone(bundle, { ...req(4), reason: '  ' })).toMatchObject({
      ok: false,
      code: 'validation_failed',
    });
    const once = tombstone(bundle, req(4));
    if (!once.ok) throw new Error(once.reason);
    expect(tombstone(once.bundle, req(4))).toMatchObject({ ok: false, code: 'conflict' });
  });

  it('keeps the log verifiable whichever commit is removed (property)', async () => {
    const bundle = await fixture();
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 6 }), async (seq) => {
        const r = tombstone(clone(bundle), req(seq));
        if (!r.ok) throw new Error(r.reason);
        const report = await verifyBundle(r.bundle, { schema });
        expect(report.status).not.toBe('altered');
        expect(report.payloadsAbsent).toBe(1);
        expect(report.problems).toEqual([]);
      }),
      { numRuns: 12 },
    );
  });
});
