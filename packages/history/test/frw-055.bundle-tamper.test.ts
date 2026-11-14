// Third-party verification of an evidence bundle (FRW-055, lane V-FRW-055-072): the log segment
// half and the evidence half are checked by their own verifiers, and each names what was altered.
// A segment whose payloads were erased by tombstones still verifies (criterion 4).
import {
  buildBundle,
  commitEvidence,
  newEvidenceSalt,
  verifyBundle as verifyEvidenceBundle,
  type BundleItem,
} from '@docedit/authority';
import { cdmSchema } from '@docedit/model/prosemirror';
import { describe, expect, it } from 'vitest';
import { type LogBundle, verifyBundle as verifyLogBundle } from '../src/chain.ts';
import { NO_HOLD } from '../src/hold.ts';
import { tombstone } from '../src/tombstone.ts';
import { bundleOf } from './bundle.ts';
import { CANARY, LogBuilder, typeAt } from './fixtures.ts';

const schema = cdmSchema();
const NOW = 1_800_000_000_000;

async function logFixture(): Promise<LogBundle> {
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

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

async function evidenceItems(): Promise<BundleItem[]> {
  const out: BundleItem[] = [];
  for (const [id, canonical] of [
    ['ev-1', 'Participant one consented to the text.'],
    ['ev-2', 'Participant two signed the field.'],
  ] as const) {
    const salt = newEvidenceSalt();
    out.push({
      id,
      saltHex: Buffer.from(salt).toString('hex'),
      canonical,
      commitment: await commitEvidence(canonical, salt),
    });
  }
  return out;
}

describe('third-party verification of the evidence bundle (FRW-055)', () => {
  it('names an altered commit of the log segment (criterion 3, commit half)', async () => {
    const bundle = await logFixture();
    expect((await verifyLogBundle(bundle, { schema })).status).toBe('intact');

    const tampered = clone(bundle);
    tampered.commits[2]!.payload = { steps: [], retired: [], claimed: [], altered: true };
    const r = await verifyLogBundle(tampered, { schema });
    expect(r.status).toBe('altered');
    expect(r.problems.some((p) => p.check === 'payload' && p.seq === 3 && p.altered)).toBe(true);
    expect(r.firstBadSeq).toBe(3);
  });

  it('names an altered stored hash of a commit (criterion 3, commit half)', async () => {
    const bundle = await logFixture();
    const tampered = clone(bundle);
    tampered.commits[3]!.hash = tampered.commits[3]!.hash.replace(/^./, (c) =>
      c === '0' ? '1' : '0',
    );
    const r = await verifyLogBundle(tampered, { schema });
    expect(r.status).toBe('altered');
    expect(r.firstBadSeq).toBeDefined();
    expect(r.problems.some((p) => p.altered)).toBe(true);
  });

  it('names an altered evidence item (criterion 3, evidence half)', async () => {
    const bundle = buildBundle(await evidenceItems());
    expect((await verifyEvidenceBundle(bundle)).ok).toBe(true);

    // The bundle type is read-only; build the altered copy rather than mutating a clone.
    const tampered: typeof bundle = {
      ...bundle,
      items: bundle.items.map((item, n) =>
        n === 1 ? { ...item, canonical: 'Participant two signed a different field.' } : item,
      ),
    };
    const v = await verifyEvidenceBundle(tampered);
    expect(v.ok).toBe(false);
    expect(v.failed).toEqual(['ev-2']);
    expect(v.items.find((i) => i.id === 'ev-2')).toMatchObject({ ok: false, problem: 'mismatch' });
  });

  it('still verifies a segment whose payloads were erased by tombstones (criterion 4)', async () => {
    const bundle = await logFixture();
    const before = await verifyLogBundle(bundle, { schema });
    let erased = bundle;
    for (const seq of [2, 4]) {
      const r = tombstone(erased, {
        seq,
        actor: 'owner-1',
        reason: 'erasure request',
        now: NOW,
        hold: NO_HOLD,
      });
      if (!r.ok) throw new Error(`tombstone refused: ${r.reason}`);
      erased = r.bundle;
    }
    const after = await verifyLogBundle(erased, { schema });
    // The chain verifies; the replay across the erased commits cannot run, so the run is not intact.
    expect(after.status).not.toBe('altered');
    expect(after.problems).toEqual([]);
    expect(after.payloadsAbsent).toBe(before.payloadsAbsent + 2);
    expect(after.head).toBe(before.head);
    expect(after.checkpoints.every((k) => k.result !== 'mismatch')).toBe(true);
  });
});
