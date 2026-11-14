/**
 * BE-022 criterion 5 (lane U-BE-015-028): a rolling restart with clients typing. Two planes share
 * one PostgreSQL database. Node A drains; its clients get `goaway` and close with 4503, then
 * reconnect to node B with `resume`. Node B takes the room with the next epoch. Each client ends
 * with the same commit sequence as the log, and every acknowledged commit is in the log once.
 * The file skips, with the reason, when PostgreSQL is not up:
 * pwsh -NoProfile -File infra/test-env.ps1 up
 *
 * What is compared: the commit identifiers and sequence numbers the clients saw (acks and
 * `sync.commit`) against the stored log, not the text each client renders; the test client does
 * not replay steps into a document.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { baseDoc, posInside, schema } from '../../../../packages/authority/test/fixtures.ts';
import { DEFAULT_LIMITS } from '../../../../packages/authority/src/codes.ts';
import { applySteps } from '../../../../packages/authority/src/rebase.ts';
import { parseSteps } from '../../../../packages/authority/src/steps.ts';
import { MemoryCheckpoints, startPlane, type Plane } from './support.ts';
import { insertText, type DepClient, type Received } from './client.ts';
import {
  createTestDatabase,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

const unavailable = await postgresUnavailable();
if (unavailable) console.warn(`skipped: ${unavailable}`);

/** The commits a client has been sent, by sequence number (acks and `sync.commit`). */
function seenBy(c: DepClient): Map<number, string | undefined> {
  const out = new Map<number, string | undefined>();
  for (const m of c.all('sync.commit')) {
    for (const x of m.d!['commits'] as Array<{ seq: number; id?: string }>) {
      out.set(x.seq, x.id);
    }
  }
  for (const m of c.all('sync.ack')) {
    if (typeof m.d?.['seq'] === 'number') out.set(m.d['seq'] as number, undefined);
  }
  return out;
}

/** The sequence a client resumed from; its commits from before the resume are not in its log. */
const floors = new Map<DepClient, number>();

function headOf(c: DepClient): number {
  return Math.max(floors.get(c) ?? 0, 0, ...seenBy(c).keys());
}

async function waitFor(check: () => boolean, what: string, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Ack {
  id: string;
  seq: number;
  text: string;
}

/**
 * How a resumed channel caught up: `stream` (the missing commits follow, then `sync.caughtUp`), or
 * `reload` (the content at head, which the client takes in place of the commits). Returns the
 * reload's sequence and text, or null when the commits are streamed.
 */
async function caughtUp(
  c: DepClient,
  opened: Received,
  plane: Plane,
  doc: string,
): Promise<{ reloadedAt: number; doc: unknown } | null> {
  const how = opened.d!['catchUp'];
  if (how === 'stream') {
    await c.take((m) => m.t === 'sync.caughtUp');
    return null;
  }
  if (how !== 'reload') throw new Error(`unexpected catchUp ${String(how)}`);
  // The data plane sends no inline content on reload. The client reads the content at head over
  // REST; the REST route calls the same data-plane method (control-plane/kit.ts), which the test
  // calls in process with the client's own identity (BE-022 criterion 5).
  const reloadedAt = opened.d!['head'] as number;
  const content = await plane.plane.readContent(plane.tokens.identity(c.token!), doc);
  if (content.seq !== reloadedAt)
    throw new Error(`the reload read seq ${content.seq}, the answer named ${reloadedAt}`);
  return { reloadedAt, doc: content.doc };
}

/**
 * One commit by `who`, then wait until `other` has been sent it, so both clients stay at head.
 * When `other` is `who` itself, the ack alone is the proof.
 */
async function type(who: DepClient, other: DepClient, ch: number, text: string, acks: Ack[]) {
  const id = uuid7();
  const r = await who.submit(ch, { id, base: headOf(who), steps: [insertText(intro(), text)] });
  if (r.t !== 'sync.ack') throw new Error(`submit ${text}: ${JSON.stringify(r)}`);
  const seq = r.d!['seq'] as number;
  acks.push({ id, seq, text });
  await waitFor(() => headOf(other) >= seq, `the other client to see ${seq}`);
}

describe.skipIf(unavailable !== null)(
  'rolling restart with clients typing over PostgreSQL (BE-022 criterion 5)',
  () => {
    let db: TestDatabase;
    const planes: Plane[] = [];

    beforeAll(async () => {
      db = await createTestDatabase();
    });

    afterAll(async () => {
      for (const p of planes) await p.close().catch(() => {});
      await db?.drop();
    });

    it('ends every client with the stored commit sequence after a restart, losing no acknowledged commit', async () => {
      const stores = pgStores(db.service);
      const checkpoints = new MemoryCheckpoints();
      const a = await startPlane({
        stores: {
          logs: stores.logs,
          ownership: stores.logs,
          grants: stores.grants,
          documents: stores.docs,
        },
        checkpoints,
        node: 'node-a',
      });
      planes.push(a);
      const doc = await a.createDocument();
      const ref = a.ref(doc);

      // Both clients type on node A.
      const alice = await a.client('alice', { [doc]: 'owner' });
      const bob = await a.client('bob', { [doc]: 'editor' });
      const aliceOpen = await alice.open(1, doc);
      expect(aliceOpen.t).toBe('ch.opened');
      const incarnation = aliceOpen.d!['incarnation'] as string;
      const view = aliceOpen.d!['view'];
      const bobOpen = await bob.open(1, doc);
      expect(bobOpen.t).toBe('ch.opened');
      const bobView = bobOpen.d!['view'];

      const acks: Ack[] = [];
      const reloads: Array<{ who: string; reloadedAt: number; doc: unknown }> = [];
      for (let i = 0; i < 3; i++) {
        await type(alice, bob, 1, `a${i} `, acks);
        await type(bob, alice, 1, `b${i} `, acks);
      }
      const atDrain = { alice: headOf(alice), bob: headOf(bob) };
      expect(atDrain.alice).toBe(atDrain.bob);

      // Node A drains (a deploy): both clients are told to reconnect and are closed.
      await a.plane.drain();
      for (const c of [alice, bob]) {
        const g = (await c.take((m: Received) => m.t === 'goaway')) as Received;
        expect(typeof g.d!['reconnectInMs']).toBe('number');
        expect((await c.closed).code).toBe(4503);
      }

      // Node B starts on the same stores and takes the room with the next epoch.
      const b = await startPlane({
        stores: {
          logs: stores.logs,
          ownership: stores.logs,
          grants: stores.grants,
          documents: stores.docs,
        },
        checkpoints,
        tenant: a.tenant,
        node: 'node-b',
      });
      planes.push(b);

      // Alice reconnects first, with resume at her head, and types while bob is away.
      const alice2 = await b.client('alice', { [doc]: 'owner' });
      const aliceResume = await alice2.open(1, doc, {
        resume: { seq: atDrain.alice, incarnation, view },
      });
      expect(aliceResume.d!['incarnation']).toBe(incarnation);
      const aliceCaught = await caughtUp(alice2, aliceResume, b, doc);
      floors.set(alice2, aliceCaught?.reloadedAt ?? atDrain.alice);
      if (aliceCaught) reloads.push({ who: 'alice', ...aliceCaught });
      await type(alice2, alice2, 1, 'a-after ', acks);
      // Bob reconnects after those commits: he is streamed what he missed, or reloaded to the content.
      const bob2 = await b.client('bob', { [doc]: 'editor' });
      const bobResume = await bob2.open(1, doc, {
        resume: { seq: atDrain.bob, incarnation, view: bobView },
      });
      expect(bobResume.t).toBe('ch.opened');
      expect(bobResume.d!['incarnation']).toBe(incarnation);
      const bobCaught = await caughtUp(bob2, bobResume, b, doc);
      floors.set(bob2, bobCaught?.reloadedAt ?? atDrain.bob);
      if (bobCaught) reloads.push({ who: 'bob', ...bobCaught });

      // Both keep typing on node B.
      await type(bob2, alice2, 1, 'b-after ', acks);
      await type(alice2, bob2, 1, 'a-last ', acks);

      // Every acknowledged commit is in the log once, at the sequence the client was told, and the
      // log has no gaps.
      const stored = await stores.logs.read(ref);
      const bySeq = new Map(stored.map((c) => [c.seq, c]));
      const head = stored.length ? Math.max(...stored.map((c) => c.seq)) : 0;
      expect(stored.length).toBe(head);
      for (let s = 1; s <= head; s++) expect(bySeq.has(s), `seq ${s} stored`).toBe(true);
      for (const ack of acks) {
        const row = stored.find((c) => c.id === ack.id);
        expect(row, `acknowledged ${ack.id}`).toBeDefined();
        expect(row!.seq).toBe(ack.seq);
        // The text the client typed is in the stored commit.
        expect(JSON.stringify(row), `text of ${ack.id}`).toContain(ack.text.trim());
      }

      // Each client, over both of its connections, holds the same sequence as the log. A reload
      // covers the sequences up to the head it was given, and its content is checked below.
      const logical: Record<string, DepClient[]> = { alice: [alice, alice2], bob: [bob, bob2] };
      for (const [label, conns] of Object.entries(logical)) {
        const known = new Map<number, string | undefined>();
        for (const c of conns) for (const [s, id] of seenBy(c)) known.set(s, id ?? known.get(s));
        for (const r of reloads.filter((x) => x.who === label)) {
          for (let s = 1; s <= r.reloadedAt; s++) if (!known.has(s)) known.set(s, undefined);
        }
        for (let s = 1; s <= head; s++) {
          expect(known.has(s), `${label} holds seq ${s}`).toBe(true);
          const id = known.get(s);
          if (id !== undefined) expect(id, `${label} seq ${s} id`).toBe(bySeq.get(s)!.id);
        }
      }
      // The same document (criterion 5): the content the plane serves at head is the content at 0
      // with every stored commit applied in order, and each reload took that content at the head
      // it was given. A client that was streamed the commits holds the same sequence and identifiers
      // (checked above), so it holds the same document.
      const reader = b.tokens.identity(alice2.token!);
      const initial = (await b.plane.readContent(reader, doc, 0)).doc;
      const replayed = (upTo: number) => {
        let d = schema.nodeFromJSON(initial);
        for (const c of [...stored].filter((x) => x.seq <= upTo).sort((x, y) => x.seq - y.seq)) {
          const parsed = parseSteps(schema, c.steps, DEFAULT_LIMITS);
          if (!parsed.ok)
            throw new Error(`stored commit ${c.seq} does not parse: ${parsed.reason}`);
          const r = applySteps(d, parsed.value);
          if (!r.ok) throw new Error(`stored commit ${c.seq} does not apply: ${r.reason}`);
          d = r.value.doc;
        }
        return d;
      };
      const atHead = await b.plane.readContent(reader, doc);
      expect(atHead.seq).toBe(head);
      expect(schema.nodeFromJSON(atHead.doc).eq(replayed(head))).toBe(true);
      expect(reloads.length).toBeGreaterThan(0);
      for (const r of reloads) {
        const content = schema.nodeFromJSON(r.doc as Parameters<typeof schema.nodeFromJSON>[0]);
        expect(
          content.eq(replayed(r.reloadedAt)),
          `${r.who} holds the document at ${r.reloadedAt}`,
        ).toBe(true);
      }
      expect(a.errors).toEqual([]);
      expect(b.errors).toEqual([]);
    });
  },
);
