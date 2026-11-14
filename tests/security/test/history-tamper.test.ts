/**
 * SEC-029 — history cannot be forged, as far as the verifier can show (10 §3.3, §2; 08 §2, §12;
 * HIS-033). An attacker who can write the stored log edits it, and the verifier of packages/history
 * is the tool a relying party runs. Each attack below edits an exported log bundle the way a
 * direct edit of the stored rows would change it, then checks what the verifier reports. Property
 * tests (fast-check) pick the log length, the altered `seq` and the field.
 *
 * What is not proved here (see the story Notes): the bundle stands in for the stored rows, so the
 * database-level edit of criterion 1 needs PostgreSQL; signed, time-stamped anchors in write-once
 * storage (criterion 5) are not built, so anchors are supplied as plain heads; control commits for
 * permission and workflow changes (criterion 3) and the manifest and event heads (criterion 4) are
 * not in this test.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  BUNDLE_FORMAT,
  chainHash,
  payloadDigest,
  verifyBundle,
  type Anchor,
  type BundleCommit,
  type ChainMetadata,
  type LogBundle,
} from '../../../packages/history/src/index.ts';

const DOC = 'doc-sec029';

function metaFor(seq: number, size: number): ChainMetadata {
  return {
    doc: DOC,
    seq,
    kind: 'commit',
    id: `c-${seq}`,
    user: 'ann',
    session: null,
    agent: null,
    time: '2026-11-13T09:00:00.000Z',
    origin: 'client',
    scopes: ['edit'],
    base: seq - 1,
    rebased: false,
    revision: 1,
    jti: null,
    cdm: 1,
    engine: 'engine-1',
    size,
  };
}

/** Builds a valid n-commit log the way the document service stores one (ADR 0020). */
async function buildLog(n: number, salt = 'a'): Promise<LogBundle> {
  const commits: BundleCommit[] = [];
  let prev: string | null = null;
  for (let seq = 1; seq <= n; seq++) {
    const payload = {
      steps: [{ stepType: 'insert', text: `${salt}${seq}` }],
      retired: [],
      claimed: [],
    };
    const { hash: payloadHash, size } = await payloadDigest(payload);
    const meta = metaFor(seq, size);
    const hash = await chainHash(prev, meta, payloadHash);
    commits.push({ meta, payloadHash, prevHash: prev, hash, payload });
    prev = hash;
  }
  return { format: BUNDLE_FORMAT, doc: DOC, head: { seq: n, chainHead: prev }, commits };
}

const clone = (b: LogBundle): LogBundle => JSON.parse(JSON.stringify(b)) as LogBundle;

/**
 * Rewrites every commit from `from` (a `seq`) to the end with `payloadFor`, recomputing each link
 * and the head as an attacker with the whole log can. The result is internally consistent.
 */
async function rewriteFrom(
  b: LogBundle,
  from: number,
  payloadFor: (seq: number) => unknown,
): Promise<LogBundle> {
  const out = clone(b);
  for (let i = from - 1; i < out.commits.length; i++) {
    const prev: string | null = i === 0 ? null : out.commits[i - 1]!.hash;
    const c = out.commits[i]!;
    const payload = payloadFor(c.meta.seq);
    const { hash: payloadHash, size } = await payloadDigest(payload);
    const meta = { ...c.meta, size };
    const hash = await chainHash(prev, meta, payloadHash);
    out.commits[i] = { meta, payloadHash, prevHash: prev, hash, payload };
  }
  const last = out.commits[out.commits.length - 1]!;
  out.head = { seq: out.commits.length, chainHead: last.hash };
  return out;
}

const FORGED_EDITS: Array<{ name: string; edit: (m: ChainMetadata) => void }> = [
  { name: 'user', edit: (m) => (m.user = 'mallory') },
  { name: 'scopes', edit: (m) => (m.scopes = ['edit', 'manage']) },
  { name: 'server time', edit: (m) => (m.time = '2030-01-01T00:00:00.000Z') },
  { name: 'origin', edit: (m) => (m.origin = 'restore') },
  { name: 'access revision', edit: (m) => (m.revision = m.revision + 1) },
];

describe('SEC-029 history cannot be forged', () => {
  it('finds a log built the way the service builds one intact, with no problems', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 8 }), async (n) => {
        const r = await verifyBundle(await buildLog(n));
        expect(r.status).toBe('intact');
        expect(r.firstBadSeq).toBeUndefined();
        expect(r.payloadsChecked).toBe(n);
      }),
      { numRuns: 25 },
    );
  });

  it('reports the altered seq when one metadata field of a stored commit is edited (criterion 1, bundle form)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 1, max: 8 })
          .chain((n) =>
            fc.tuple(
              fc.constant(n),
              fc.integer({ min: 1, max: n }),
              fc.integer({ min: 0, max: FORGED_EDITS.length - 1 }),
            ),
          ),
        async ([n, k, which]) => {
          const b = clone(await buildLog(n));
          FORGED_EDITS[which]!.edit(b.commits[k - 1]!.meta);
          const r = await verifyBundle(b);
          expect(r.status, FORGED_EDITS[which]!.name).toBe('altered');
          expect(r.firstBadSeq, FORGED_EDITS[which]!.name).toBe(k);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('reports the first missing seq when a commit is deleted, and never calls it intact', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 2, max: 8 })
          .chain((n) => fc.tuple(fc.constant(n), fc.integer({ min: 1, max: n - 1 }))),
        async ([n, k]) => {
          const b = clone(await buildLog(n));
          b.commits.splice(k - 1, 1);
          const r = await verifyBundle(b);
          // A missing record is reported as a gap (lost or left out), which is not the same as an
          // altered one: the tool exits 2, not 1 (HIS-033). The first broken seq is the gap.
          expect(r.status).toBe('incomplete');
          expect(r.problems.some((p) => p.altered)).toBe(false);
          expect(r.problems.some((p) => p.check === 'gap' && p.seq === k)).toBe(true);
          expect(r.firstBadSeq).toBe(k);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('reports the seq after a forged record inserted beside a stored one, because the link breaks there', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 2, max: 8 })
          .chain((n) => fc.tuple(fc.constant(n), fc.integer({ min: 1, max: n - 1 }))),
        async ([n, k]) => {
          const b = clone(await buildLog(n));
          const original = b.commits[k - 1]!;
          // The attacker writes a record for seq k after the real one, with its own valid hash.
          const prevHash = k === 1 ? null : b.commits[k - 2]!.hash;
          const payload = {
            steps: [{ stepType: 'insert', text: 'forged' }],
            retired: [],
            claimed: [],
          };
          const { hash: payloadHash, size } = await payloadDigest(payload);
          const meta = { ...original.meta, user: 'mallory', size };
          const hash = await chainHash(prevHash, meta, payloadHash);
          b.commits.splice(k, 0, { meta, payloadHash, prevHash, hash, payload });
          const r = await verifyBundle(b);
          expect(r.status).toBe('altered');
          // The real record k+1 no longer links to the record before it.
          expect(r.firstBadSeq).toBe(k + 1);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('reports the first of two commits whose seq values were swapped (a reorder)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc
          .integer({ min: 2, max: 8 })
          .chain((n) => fc.tuple(fc.constant(n), fc.integer({ min: 1, max: n - 1 }))),
        async ([n, k]) => {
          const b = clone(await buildLog(n));
          const a = b.commits[k - 1]!;
          const c = b.commits[k]!;
          const seqA = a.meta.seq;
          a.meta.seq = c.meta.seq;
          c.meta.seq = seqA;
          const r = await verifyBundle(b);
          expect(r.status).toBe('altered');
          expect(r.firstBadSeq).toBe(k);
        },
      ),
      { numRuns: 60 },
    );
  });

  it('still verifies when payloads are thinned or replaced by tombstones, because the chain holds their hashes (criterion 2)', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 1, max: 8 }).chain((n) =>
          fc.tuple(
            fc.constant(n),
            fc.array(fc.constantFrom('keep', 'thin', 'tombstone'), {
              minLength: n,
              maxLength: n,
            }),
          ),
        ),
        async ([n, modes]) => {
          const b = clone(await buildLog(n));
          let absent = 0;
          b.commits.forEach((c, i) => {
            const mode = modes[i];
            if (mode === 'thin') {
              delete c.payload;
              absent++;
            } else if (mode === 'tombstone') {
              c.payload = null;
              absent++;
            }
          });
          const r = await verifyBundle(b);
          expect(r.status).toBe('intact');
          expect(r.problems).toEqual([]);
          expect(r.payloadsAbsent).toBe(absent);
          expect(r.payloadsChecked).toBe(n - absent);
        },
      ),
      { numRuns: 40 },
    );
  });

  it('shows what is not detectable without an anchor: a rewritten tail with its head updated verifies', async () => {
    const n = 6;
    const original = await buildLog(n);
    // The attacker rewrites commits 3 to 6 and updates the head, so the log is internally consistent.
    const rewritten = await rewriteFrom(original, 3, (seq) => ({
      steps: [{ stepType: 'insert', text: `rewritten${seq}` }],
      retired: [],
      claimed: [],
    }));
    const r = await verifyBundle(rewritten);
    expect(r.status).toBe('intact');
    // Unanchored, the tampering is not detectable by the verifier alone (10 §2: the operator is trusted).
    const headAtN = original.commits[n - 1]!.hash;
    expect(headAtN).not.toBe(rewritten.commits[n - 1]!.hash);
  });

  it('detects a rewrite up to a point whose head was anchored, and accepts an anchor before it (criterion 5, partly)', async () => {
    const n = 6;
    const original = await buildLog(n);
    const rewritten = await rewriteFrom(original, 3, (seq) => ({
      steps: [{ stepType: 'insert', text: `rewritten${seq}` }],
      retired: [],
      claimed: [],
    }));
    const anchoredBeforeRewrite: Anchor = {
      seq: 2,
      hash: original.commits[1]!.hash,
      source: 'anchor',
    };
    const anchoredAtHead: Anchor = {
      seq: n,
      hash: original.commits[n - 1]!.hash,
      source: 'anchor',
    };

    const before = await verifyBundle(rewritten, { anchors: [anchoredBeforeRewrite] });
    expect(before.anchors[0]?.result).toBe('match');
    expect(before.status).toBe('intact');

    const atHead = await verifyBundle(rewritten, { anchors: [anchoredAtHead] });
    expect(atHead.anchors[0]?.result).toBe('mismatch');
    expect(atHead.status).toBe('altered');
    expect(atHead.firstBadSeq).toBe(n);
  });

  it('shows a removed tail with its head updated is not detectable unless an anchor is held', async () => {
    const n = 5;
    const original = await buildLog(n);
    const shorter = clone(original);
    shorter.commits.pop();
    shorter.head = { seq: n - 1, chainHead: shorter.commits[n - 2]!.hash };
    expect((await verifyBundle(shorter)).status).toBe('intact');

    const withAnchor = await verifyBundle(shorter, {
      anchors: [{ seq: n, hash: original.commits[n - 1]!.hash, source: 'anchor' }],
    });
    expect(withAnchor.status).not.toBe('intact');
    expect(withAnchor.anchors[0]?.result).toBe('unknown');
  });
});
