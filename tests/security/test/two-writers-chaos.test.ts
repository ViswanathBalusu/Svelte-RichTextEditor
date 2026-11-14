/**
 * SEC-031 criterion 5 (lane SEC-027-039): a seeded chaos run over the real service's log and
 * ownership ports (10 §3.3; 06 §2.1, §8). Nodes claim the document, fall behind (freezes), lose
 * their views (restarts), race for the same `seq`, and write under injected faults. After every
 * step the log is checked; at the end `seq` has no gap or duplicate and the epoch only increased.
 *
 * The run drives the storage ports of the harness directly, not the room. The freeze is a node
 * that keeps an old epoch and an old `seq`; a partition is the same, with the other node's claims
 * raising the epoch meanwhile. The fault hook (BE-079, `after-insert`) is the memory store's own.
 * The PostgreSQL form is skipped here (no database in this run); the random seed is fixed so a
 * failure can be replayed.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StoredCommit, WriteRequest } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { documentWithRegions, startHarness, type Harness } from './support/harness.ts';

const NODES = ['node-A', 'node-B', 'node-C'] as const;
const STEPS = 400;
const SEED = 0x5ec031;

/** A small seeded generator (mulberry32), so every run takes the same path. */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function commitAt(seq: number, base: number, revision: number): StoredCommit {
  return {
    seq,
    id: uuid7(),
    kind: 'steps',
    steps: [
      {
        stepType: 'replace',
        from: 1,
        to: 1,
        slice: { content: [{ type: 'text', text: 'x' }] },
      },
    ],
    user: 'system',
    session: '',
    time: Date.now(),
    origin: 'input',
    scopes: ['body'],
    revision,
    cdm: 1,
    engine: 'pm-steps/1',
    retired: [],
    claimed: [],
    base,
    rebased: false,
  };
}

describe('SEC-031 criterion 5: a seeded chaos run keeps seq gap-free and the epoch monotone', () => {
  let h: Harness;
  beforeAll(async () => {
    h = await startHarness('memory', { node: 'node-A' });
  });
  afterAll(async () => {
    await h?.close();
  });

  it('after claims, freezes, restarts, races and faults, the log has no gap or duplicate', async () => {
    const doc = await h.createDocument(h.a, documentWithRegions());
    const ref = { tenant: h.a.id, doc };
    const random = seeded(SEED);
    const pick = <T>(xs: readonly T[]): T => xs[Math.floor(random() * xs.length)]!;
    const rev = (await h.parts.grants.current(ref)).revision;

    // What each node believes: the epoch it claimed under and the seq it last read.
    const view = new Map<string, { epoch: number; seq: number }>();
    let lastEpoch = (await h.parts.logs.head(ref)).epoch;
    const claimed: number[] = [];
    const outcome: Record<string, number> = {};

    /** One append from `epoch` at `base`, with the head read before and after it. */
    const send = async (epoch: number, base: number, fault?: 'after-insert') => {
      const before = await h.parts.logs.head(ref);
      const req: WriteRequest = {
        epoch,
        revision: rev,
        fromSeq: base + 1,
        commits: [commitAt(base + 1, base, rev)],
      };
      const r = await h.parts.logs.append(ref, req, fault ? { fault } : {});
      const after = await h.parts.logs.head(ref);
      outcome[r.status] = (outcome[r.status] ?? 0) + 1;
      // Only the write that holds the current epoch and the next seq can land, and a faulted or
      // refused write leaves the log as it was.
      if (r.status === 'ok') {
        expect(fault).toBeUndefined();
        expect(epoch).toBe(before.epoch);
        expect(base).toBe(before.seq);
        expect(after.seq).toBe(before.seq + 1);
      } else {
        expect(after.seq).toBe(before.seq);
      }
      expect(after.epoch).toBe(before.epoch);
      return r;
    };

    for (let i = 0; i < STEPS; i++) {
      const node = pick(NODES);
      const op = random();

      if (op < 0.15) {
        // Takeover or lease recovery: the node claims, so the epoch rises and the node reads the head.
        const epoch = await h.parts.ownership.claim(ref, node);
        expect(epoch).toBeGreaterThan(lastEpoch);
        lastEpoch = epoch;
        claimed.push(epoch);
        view.set(node, { epoch, seq: (await h.parts.logs.head(ref)).seq });
      } else if (op < 0.3) {
        // A freeze or a partition: the node keeps its old view while the others move on (no-op here).
        continue;
      } else if (op < 0.4) {
        // A restart: the node forgets its view and must claim again before it writes.
        view.delete(node);
      } else if (op < 0.5) {
        // A race: two nodes with the same current view append the same seq at once.
        const head = await h.parts.logs.head(ref);
        const raw = (base: number) =>
          h.parts.logs.append(ref, {
            epoch: head.epoch,
            revision: rev,
            fromSeq: base + 1,
            commits: [commitAt(base + 1, base, rev)],
          });
        const [r1, r2] = await Promise.all([raw(head.seq), raw(head.seq)]);
        outcome[r1.status] = (outcome[r1.status] ?? 0) + 1;
        outcome[r2.status] = (outcome[r2.status] ?? 0) + 1;
        expect([r1.status, r2.status].filter((s) => s === 'ok')).toHaveLength(1);
        view.delete(node);
      } else if (op < 0.6) {
        // A write that fails after its inserts: the undo leaves the log as it was.
        const v = view.get(node);
        if (v) await send(v.epoch, v.seq, 'after-insert');
      } else {
        // An ordinary write from the node's view. A node that is fenced stops serving the document.
        const v = view.get(node);
        if (!v) continue;
        const r = await send(v.epoch, v.seq);
        if (r.status === 'ok') view.set(node, { epoch: v.epoch, seq: v.seq + 1 });
        else view.delete(node);
      }

      // After every step: the log is contiguous from 1 and the head agrees with it.
      const head = await h.parts.logs.head(ref);
      const log = await h.parts.logs.read(ref, 1);
      expect(log.map((c) => c.seq)).toEqual(Array.from({ length: head.seq }, (_, k) => k + 1));
      expect(head.epoch).toBe(lastEpoch);
    }

    // The whole run: the epoch only increased, every commit id is unique, and both kinds of
    // outcome occurred (so the run exercised the fence as well as the accept path).
    for (let k = 1; k < claimed.length; k++) expect(claimed[k]!).toBeGreaterThan(claimed[k - 1]!);
    const log = await h.parts.logs.read(ref, 1);
    expect(new Set(log.map((c) => c.id)).size).toBe(log.length);
    expect(log.map((c) => c.seq)).toEqual(Array.from({ length: log.length }, (_, k) => k + 1));
    expect(outcome['ok'] ?? 0).toBeGreaterThan(0);
    expect(outcome['fenced'] ?? 0).toBeGreaterThan(0);
    expect(outcome['failed'] ?? 0).toBeGreaterThan(0);
  });
});
