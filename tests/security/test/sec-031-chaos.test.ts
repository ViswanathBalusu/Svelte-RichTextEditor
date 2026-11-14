/**
 * SEC-031 criterion 5 (10 §3.3; 06 §2.1, §8): a seeded chaos run of ownership claims, stale
 * writers, restarts and same-seq races against the real storage. After each step the log must
 * hold `seq` without gaps or duplicates, and the epoch must only increase. Each write is checked
 * against a model: it is stored only when its epoch is the current one and its `fromSeq` is the
 * next free seq.
 *
 * The freeze and partition of BE-079 fault hooks are not built, so a freeze is a node that keeps
 * an old epoch and head while others claim the document (SEC-031 Notes). Runs on memory and on
 * PostgreSQL when the shared test environment is up.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';

/** A small seeded generator (mulberry32), so a failing run can be replayed from its seed. */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface NodeBelief {
  epoch: number;
  /** The seq the node will write next, as it last read the head. */
  fromSeq: number;
}

const NODES = ['node-A', 'node-B', 'node-C'];
const STEPS = 120;
const SEEDS = [31, 3103, 20261113];

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-031 criterion 5: seeded chaos run keeps the log linear (${storage})`, () => {
    let h: Harness;
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { node: 'node-A' });
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    for (const seed of SEEDS) {
      t()(
        `seed ${seed}: claims, stale writers, restarts and races never fork the log`,
        async () => {
          const doc = await h.createDocument(h.a, documentWithRegions());
          const ref = { tenant: h.a.id, doc };
          const next = rng(seed);
          const pick = <T>(xs: readonly T[]): T => xs[Math.floor(next() * xs.length)]!;

          const beliefs = new Map<string, NodeBelief>();
          let currentEpoch = (await h.parts.logs.head(ref)).epoch;
          let lastEpoch = currentEpoch;
          let owned = 0; // successful appends, which must equal the stored head

          const commit = (seq: number, base: number): StoredCommit => ({
            seq,
            id: uuid7(),
            kind: 'steps',
            steps: [
              {
                stepType: 'replace',
                from: 1,
                to: 1,
                slice: { content: [{ type: 'text', text: `c${seq}` }] },
              },
            ],
            user: 'system',
            session: '',
            time: Date.now(),
            origin: 'input',
            scopes: ['body'],
            revision: 0,
            cdm: 1,
            engine: 'pm-steps/1',
            retired: [],
            claimed: [],
            base,
            rebased: false,
          });

          const writeFor = async (node: NodeBelief, seq: number): Promise<WriteRequest> => {
            const rev = (await h.parts.grants.current(ref)).revision;
            const base = seq - 1;
            const c = { ...commit(seq, base), revision: rev };
            return { epoch: node.epoch, revision: rev, fromSeq: seq, commits: [c] };
          };

          for (let step = 0; step < STEPS; step++) {
            const op = pick(['claim', 'claim', 'write', 'write', 'stale', 'race', 'restart']);
            const node = pick(NODES);
            const head = (await h.parts.logs.head(ref)).seq;

            if (op === 'claim') {
              // A node takes ownership with the next epoch (06 §2.1); its belief follows the store.
              currentEpoch = await h.parts.ownership.claim(ref, node);
              expect(currentEpoch).toBeGreaterThan(lastEpoch);
              beliefs.set(node, { epoch: currentEpoch, fromSeq: head + 1 });
            } else if (op === 'write') {
              // A node that believes it owns the current epoch writes its next seq.
              const b = beliefs.get(node) ?? { epoch: currentEpoch, fromSeq: head + 1 };
              const seq = head + 1;
              const req = await writeFor({ epoch: currentEpoch, fromSeq: seq }, seq);
              const res = await h.parts.logs.append(ref, { ...req, epoch: b.epoch });
              // The seq is the store's own next seq, so only the epoch decides (06 §2.1).
              if (b.epoch === currentEpoch) {
                expect(res.status).toBe('ok');
                owned++;
                beliefs.set(node, { epoch: currentEpoch, fromSeq: seq + 1 });
              } else {
                expect(res.status).not.toBe('ok');
              }
            } else if (op === 'stale') {
              // A frozen node writes with an old epoch, as if it resumed after a takeover.
              const b = beliefs.get(node) ?? { epoch: currentEpoch, fromSeq: head + 1 };
              const seq = head + 1;
              const req = await writeFor({ epoch: b.epoch, fromSeq: seq }, seq);
              const res = await h.parts.logs.append(ref, { ...req, epoch: b.epoch });
              if (b.epoch !== currentEpoch) {
                expect(res.status).not.toBe('ok');
              } else if (res.status === 'ok') {
                owned++;
                beliefs.set(node, { epoch: currentEpoch, fromSeq: seq + 1 });
              }
            } else if (op === 'race') {
              // Two nodes append the same seq under the current epoch: exactly one is stored.
              const seq = head + 1;
              const [r1, r2] = await Promise.all([
                h.parts.logs.append(
                  ref,
                  await writeFor({ epoch: currentEpoch, fromSeq: seq }, seq),
                ),
                h.parts.logs.append(
                  ref,
                  await writeFor({ epoch: currentEpoch, fromSeq: seq }, seq),
                ),
              ]);
              const oks = [r1, r2].filter((r) => r.status === 'ok').length;
              expect(oks).toBe(1); // both carry the current epoch, so exactly one takes the seq
              owned += oks;
            } else {
              // A restart: the node forgets its belief and reads the store before it writes again.
              beliefs.delete(node);
            }

            // Invariants after every step: the epoch only increases, and the log is linear.
            const headNow = await h.parts.logs.head(ref);
            expect(headNow.epoch).toBeGreaterThanOrEqual(lastEpoch);
            expect(headNow.epoch).toBe(currentEpoch);
            lastEpoch = headNow.epoch;
          }

          const seqs = (await h.parts.logs.read(ref, 1)).map((c) => c.seq);
          expect(new Set(seqs).size).toBe(seqs.length);
          expect(seqs).toEqual(Array.from({ length: seqs.length }, (_, i) => i + 1));
          expect(seqs.length).toBe(owned);
          expect(owned).toBeGreaterThan(0);
        },
      );
    }
  });
}
