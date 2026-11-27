/**
 * SEC-015 criterion 2 (10 §3.2 "replay and resubmission"; 04 §5 steps 1, 2; review SYNC-1), with
 * the rate limits out of the way: a commit is still being stored when the same user sends its
 * identifier again 999 times on the same channel. Exactly one commit is stored, every one of the
 * thousand copies gets the same acknowledgement, and the room goes on serving.
 *
 * "Still being stored" is made true by a gate around the log's append (test code only): the first
 * copy reaches the store and waits there while the other copies arrive, and the gate is opened
 * once all of them are on the wire.
 *
 * The rate limits are raised for this file (the node's `rateLimits`, which an operator sets): at
 * the default limits a burst of a thousand frames from one connection is answered `rate_limited`
 * and the socket is closed with 4429, which is SEC-018's subject and is covered by
 * replay-and-key-reuse.test.ts. Whether the criterion is to hold at the default limits too is the
 * owner's question (docs/adr/0344-lane-V-SEC-001-016.md, question 1).
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { DEFAULT_RATES } from '../../../services/document-service/src/data-plane/settings.ts';
import { RateLimits } from '../../../services/document-service/src/data-plane/limits.ts';
import {
  documentWithRegions,
  insertText,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { inside, loadDoc } from './support/cdm.ts';
import { WireClient } from './support/wire.ts';

const COPIES = 1000;
const generous = { capacity: 1_000_000, refillPerSecond: 1_000_000 };

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-015 criterion 2: copies of a commit that is still being stored (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let hold: Promise<void> | null = null;
    let open: () => void = () => {};
    let appends = 0;
    /** How the thousand copies were answered, by kind; filled by the first test. */
    let tally: Record<string, number> = {};

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, {
        rateLimits: new RateLimits({
          ...DEFAULT_RATES,
          addressConnections: generous,
          addressFrames: generous,
          connection: generous,
          user: generous,
          tenant: generous,
          closeAfterRefusals: 1_000_000,
        }),
        // The connection's own bucket is a data-plane setting; raise it with the node's limits.
        dataPlane: {
          rates: {
            ...DEFAULT_RATES,
            addressConnections: generous,
            addressFrames: generous,
            connection: generous,
            user: generous,
            tenant: generous,
            closeAfterRefusals: 1_000_000,
          },
        },
      });
      doc = await h.createDocument(h.a, documentWithRegions());
      const logs = h.parts.logs as unknown as { append: (...args: unknown[]) => Promise<unknown> };
      const append = logs.append.bind(logs);
      logs.append = async (...args: unknown[]) => {
        appends++;
        if (hold) await hold;
        return append(...args);
      };
    });
    afterAll(async () => {
      open();
      await h?.close();
    });

    (skip ? it.skip : it)(
      'stores one commit, answers every copy with the same acknowledgement, and the room goes on',
      async () => {
        const token = await h.mintToken(h.a, 'cai', { [doc]: 'editor' });
        const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        await c.hello(token);
        await c.open(1, doc);
        const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
          .json;
        const start = inside(loadDoc(content.doc), 'pIntro0000000001');
        const commit = {
          id: uuid7(),
          base: content.seq as number,
          steps: [insertText(start, 'R')],
        };
        try {
          hold = new Promise<void>((resolve) => (open = resolve));
          const before = appends;
          const ids: string[] = [];
          const send = () => {
            const mid = c.nextId();
            ids.push(mid);
            c.send({ t: 'sync.submit', id: mid, ch: 1, d: commit });
          };
          send();
          // The first copy is at the store, and waits there.
          for (let i = 0; i < 500 && appends === before; i++)
            await new Promise((resolve) => setTimeout(resolve, 10));
          expect(appends, 'the first copy reached the store').toBe(before + 1);
          for (let i = 1; i < COPIES; i++) send();
          // Every copy must be handled while the commit is still being stored. The session handles
          // the frames of a connection in order, so the answer to a ping sent after the last copy
          // comes after the room has seen all of them. (A fixed wait is not enough on a loaded
          // host: a copy handled after the store is answered from the log, with the stored steps,
          // which is another acknowledgement by design, 04 §5 step 2.)
          const ping = c.nextId();
          c.send({ t: 'ping', id: ping });
          await c.take((m) => m.t === 'pong' && m.re === ping, 60_000, 'the pong after the copies');
          open();
          hold = null;

          const settled = await Promise.allSettled(
            ids.map((mid) => c.take((m) => m.re === mid, 10_000, 'an answer')),
          );
          const answers = settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : []));
          const kinds = new Map<string, number>();
          const silent = settled.flatMap((s, i) => (s.status === 'rejected' ? [i + 1] : []));
          if (silent.length > 0) kinds.set(`no answer (copy ${silent.join(', ')})`, silent.length);
          for (const m of answers) {
            const kind = m.t === 'sync.ack' ? 'sync.ack' : `${m.t}:${String(m.d?.['code'])}`;
            kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
          }
          tally = Object.fromEntries(kinds);
          // Every one of the thousand submits is answered, with the stored commit's acknowledgement.
          expect(tally).toEqual({ 'sync.ack': COPIES });
          const acks = new Set(answers.map((m) => JSON.stringify(m.d)));
          expect(acks.size, 'the acknowledgements are the same').toBe(1);
          console.info(`SEC-015 in-flight copies (${storage}): ${JSON.stringify(tally)}`);
        } finally {
          open();
          hold = null;
          c.terminate();
        }

        // Exactly one commit is stored under the identifier.
        const log = await h.parts.logs.read({ tenant: h.a.id, doc }, 1);
        expect(log.filter((stored) => stored.id === commit.id).length).toBe(1);

        // The room did not crash: a new connection gets another commit acknowledged.
        const fresh = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        try {
          await fresh.hello(await h.mintToken(h.a, 'cai', { [doc]: 'editor' }));
          await fresh.open(1, doc);
          const later = (await h.call('GET', `/v1/documents/${doc}/content`, { token: h.a.apiKey }))
            .json;
          const at = inside(loadDoc(later.doc), 'pIntro0000000001');
          const after = await fresh.submit(1, {
            id: uuid7(),
            base: later.seq as number,
            steps: [insertText(at, 'L')],
          });
          expect(after.t, JSON.stringify(after.d)).toBe('sync.ack');
        } finally {
          fresh.terminate();
        }
      },
      120_000,
    );
  });
}
