/**
 * Lane V-PRO-018-034. A client that attaches with catch-up by stream while two writers commit at
 * the same time (PRO-025 criterion 3; 05 §5.2, §5.3). The criterion asks for writers in the plural
 * and for no commit missed and none sent twice, because attaching and streaming are atomic.
 *
 * The race is made real, then checked to have been real (reviewer, round 1): the attach is held on
 * the server, inside the open, at its read of the stored permission state (session.ts, before
 * `room.open`), while both writers commit. It is released with the writers still committing. The
 * test then asserts that the gap was not empty (`head > resume.seq`), that commits kept arriving as
 * live commits after `sync.caughtUp`, and that bob received every `seq` from `resume.seq + 1` to the
 * last exactly once, the streamed ones before `sync.caughtUp` and the live ones after it.
 *
 * Two writers run on their own connections, each submitting with a base that may be stale, so the
 * room rebases some commits. Runs over the in-memory stores (test/data-plane/support.ts), in
 * Node.js. It measures no rate, so it is a concurrency check, not a load test.
 */
import type { PermissionState } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient } from '../../test/data-plane/client.ts';
import { memoryStores, startPlane, until, type Plane } from '../../test/data-plane/support.ts';
import type { DocRef, GrantStore } from '../storage/types.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

/** A grant store whose next `current` read can be held until the test releases it. */
class HeldGrants implements GrantStore {
  readonly #inner: GrantStore;
  #arm = false;
  #release: (() => void) | null = null;
  /** True once an armed read arrived and is waiting. */
  held = false;

  constructor(inner: GrantStore) {
    this.#inner = inner;
  }

  /** Holds the next `current` read. */
  arm(): void {
    this.#arm = true;
  }

  release(): void {
    const r = this.#release;
    this.#release = null;
    this.held = false;
    r?.();
  }

  async current(ref: DocRef): Promise<PermissionState> {
    if (this.#arm) {
      this.#arm = false;
      this.held = true;
      await new Promise<void>((resolve) => (this.#release = resolve));
    }
    return this.#inner.current(ref);
  }
  at(ref: DocRef, revision: number) {
    return this.#inner.at(ref, revision);
  }
  history(ref: DocRef) {
    return this.#inner.history(ref);
  }
  retired(ref: DocRef) {
    return this.#inner.retired(ref);
  }
  change(...args: Parameters<GrantStore['change']>) {
    return this.#inner.change(...args);
  }
}

let planes: Plane[] = [];
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** The sequence numbers of the commits in `sync.commit` messages, in arrival order. */
function seqsOf(msgs: DepClient['log']): number[] {
  return msgs
    .filter((m) => m.t === 'sync.commit')
    .flatMap((m) => (m.d!['commits'] as Array<{ seq: number }>).map((x) => x.seq));
}

describe('attaching while two writers commit (V-PRO-018-034, PRO-025 criterion 3)', () => {
  it('a client whose attach is in flight while two writers commit receives each commit once, in order, with none missed', async () => {
    const stores = memoryStores();
    const grants = new HeldGrants(stores.grants);
    const p = await startPlane({ stores: { ...stores, grants } });
    planes.push(p);
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const carol = await p.client('carol', { [doc]: 'editor' });
    const first = await alice.open(1, doc);
    const incarnation = first.d!['incarnation'] as string;
    const view = first.d!['view'];
    await carol.open(1, doc);

    let aliceBase = 0;
    for (let i = 0; i < 5; i++) {
      const ack = await alice.submit(1, {
        id: uuid7(),
        base: aliceBase,
        steps: [insertText(intro(), 'a ')],
      });
      expect(ack.t).toBe('sync.ack');
      aliceBase = ack.d!['seq'] as number;
    }
    const resumeSeq = aliceBase;

    // Bob's attach reaches the server and is held inside the open, before the room attaches it.
    const bob = await p.client('bob', { [doc]: 'editor' });
    grants.arm();
    const attach = bob.open(1, doc, { resume: { seq: resumeSeq, incarnation, view } });
    await until(() => grants.held, 3000, "bob's attach to be held");

    const perPerson = 25;
    const acks: number[] = [];
    const writer = async (c: DepClient, text: string, start: number) => {
      let base = start;
      for (let i = 0; i < perPerson; i++) {
        const ack = await c.submit(1, { id: uuid7(), base, steps: [insertText(intro(), text)] });
        expect(ack.t).toBe('sync.ack');
        base = ack.d!['seq'] as number;
        acks.push(base);
      }
    };
    const writers = Promise.all([writer(alice, 'a ', resumeSeq), writer(carol, 'c ', resumeSeq)]);

    // Both writers commit while the attach is in flight; it is released with them still going.
    await until(() => acks.length >= 16, 5000, 'sixteen commits during the attach');
    const committedWhileHeld = acks.length;
    grants.release();
    const opened = await attach;
    expect(opened.t).toBe('ch.opened');
    expect(opened.d).toMatchObject({ catchUp: 'stream' });
    const head = opened.d!['head'] as number;
    // The gap is not empty: the attach streamed the commits made while it was in flight.
    expect(head).toBeGreaterThanOrEqual(resumeSeq + committedWhileHeld);

    await writers;
    const last = Math.max(...acks);
    expect(acks.length).toBe(perPerson * 2);
    await until(() => seqsOf(bob.log).at(-1) === last, 10000, `bob to reach seq ${last}`);

    // The streamed commits come before sync.caughtUp, the live ones after it.
    const caughtAt = bob.log.findIndex((m) => m.t === 'sync.caughtUp');
    expect(caughtAt).toBeGreaterThanOrEqual(0);
    expect(bob.log[caughtAt]!.d!['seq']).toBe(head);
    const streamed = seqsOf(bob.log.slice(0, caughtAt));
    const live = seqsOf(bob.log.slice(caughtAt + 1));
    expect(streamed).toEqual(Array.from({ length: head - resumeSeq }, (_, i) => resumeSeq + 1 + i));
    // Writers kept committing after the attach: live commits arrived after sync.caughtUp.
    expect(last).toBeGreaterThan(head);
    expect(live).toEqual(Array.from({ length: last - head }, (_, i) => head + 1 + i));

    // Every seq from resume.seq + 1 to the last, once each, in order.
    const got = seqsOf(bob.log);
    expect(got).toEqual(Array.from({ length: last - resumeSeq }, (_, i) => resumeSeq + 1 + i));
    expect(new Set(got).size).toBe(got.length);
  });
});
