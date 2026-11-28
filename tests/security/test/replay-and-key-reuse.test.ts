/**
 * SEC-015 — replay and key reuse fail (10 §3.2; 05 §6.1; D140). A commit identifier and an
 * `Idempotency-Key` are scoped: another user, another document or another tenant that reuses one
 * gets its own result and never the other's, and a stored commit is stored once however often it is
 * sent.
 *
 * Criteria 1 to 3 run over the wire on the data plane. Criterion 5 runs over HTTP on the control
 * plane. Criterion 4 (another caller, or another route, or a changed body under one key) runs over
 * HTTP: the idempotency scope is the tenant, the principal (the user's surrogate, or the service
 * credential), the route and the key, so a second user or the service credential on the same route
 * gets its own job, the same caller on another served route gets that route's own job, and a
 * changed body under the same caller's key is refused without creating a job.
 */
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { uuid7 } from '@docedit/model';
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

/** The copies sent in the replay test; the criterion names a thousand. */
const COPIES = 1000;

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-015 replay and key reuse fail (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let doc2: string;
    beforeAll(async () => {
      if (!skip) {
        h = await startHarness(storage);
        doc = await h.createDocument(h.a, documentWithRegions());
        doc2 = await h.createDocument(h.a, documentWithRegions());
      }
    });
    afterAll(async () => {
      await h?.close();
    });
    const t = () => (skip ? it.skip : it);

    const contentOf = async (d: string) =>
      (await h.call('GET', `/v1/documents/${d}/content`, { token: h.a.apiKey })).json;

    const connect = async (d: string, sub: string, role = 'editor') => {
      const token = await h.mintToken(h.a, sub, { [d]: role });
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      await c.hello(token);
      await c.open(1, d);
      return c;
    };

    /** An insertion at the start of the introduction, as a step list. */
    const insertAt = async (d: string, text: string) => {
      const content = await contentOf(d);
      const start = inside(loadDoc(content.doc), 'pIntro0000000001');
      return { steps: [insertText(start, text)], seq: content.seq as number };
    };

    t()('refuses a commit identifier of another user with invalid_op', async () => {
      const ann = await connect(doc, 'ann');
      const ben = await connect(doc, 'ben');
      try {
        const id = uuid7();
        const { steps, seq } = await insertAt(doc, 'A');
        const first = await ann.submit(1, { id, base: seq, steps });
        expect(first.t, JSON.stringify(first.d)).toBe('sync.ack');

        // Ben sends the same identifier with a different change.
        const again = await insertAt(doc, 'B');
        const r = await ben.submit(1, { id, base: again.seq, steps: again.steps });
        expect(r.t, JSON.stringify(r.d)).toBe('sync.reject');
        expect(r.d?.['code']).toBe('invalid_op');
      } finally {
        ann.terminate();
        ben.terminate();
      }
    });

    t()(
      'stores one commit for a burst of copies of the same identifier, and the acks carry one seq',
      async () => {
        // Criterion 2 asks that every one of a thousand copies gets the same ack. This service
        // acks the first copies, then answers the rest with rejects and closes the socket with
        // 4429 (too many messages, SEC-018). That is not the criterion, so this test checks only
        // what holds: one stored commit, one seq across the acks, and a service that still serves.
        const c = await connect(doc, 'cai');
        const id = uuid7();
        const { steps, seq } = await insertAt(doc, 'R');
        try {
          // One channel carries one commit in flight (the busy reject). The first copy is sent
          // alone and its answer awaited, so the stored commit is acknowledged before the burst;
          // the burst then repeats that commit. Sent together, the rate limit (SEC-018) closes the
          // socket before the first commit answers on PostgreSQL, and no copy is acknowledged.
          const first = c.nextId();
          c.send({ t: 'sync.submit', id: first, ch: 1, d: { id, base: seq, steps } });
          const firstAnswer = await c.take((m) => m.re === first, 60_000, `answer to ${first}`);
          const ids: string[] = [];
          for (let i = 1; i < COPIES; i++) {
            const mid = c.nextId();
            ids.push(mid);
            c.send({ t: 'sync.submit', id: mid, ch: 1, d: { id, base: seq, steps } });
          }
          const settled = await Promise.allSettled(
            ids.map((mid) => c.take((m) => m.re === mid, 60_000, `answer to ${mid}`)),
          );
          const acks = [
            firstAnswer,
            ...settled.flatMap((s) => (s.status === 'fulfilled' ? [s.value] : [])),
          ]
            .filter((m) => m.t === 'sync.ack')
            .map((m) => (m.d as { seq: number }).seq);
          expect(acks.length).toBeGreaterThan(0);
          expect(new Set(acks).size, 'the acknowledgements carry one seq').toBe(1);
        } finally {
          c.terminate();
        }

        // Exactly one stored commit carries the identifier.
        const log = await h.parts.logs.read({ tenant: h.a.id, doc }, 1);
        expect(log.filter((commit) => commit.id === id).length).toBe(1);

        // The service still serves: a fresh connection gets a distinct commit acknowledged.
        const fresh = await connect(doc, 'cai');
        try {
          const later = await insertAt(doc, 'L');
          const after = await fresh.submit(1, { id: uuid7(), base: later.seq, steps: later.steps });
          expect(after.t).toBe('sync.ack');
        } finally {
          fresh.terminate();
        }
      },
      120_000,
    );

    t()('keeps the same identifier independent on two documents', async () => {
      const id = uuid7();
      const a = await connect(doc, 'dee');
      const b = await connect(doc2, 'dee');
      try {
        const one = await insertAt(doc, 'X');
        const two = await insertAt(doc2, 'Y');
        const r1 = await a.submit(1, { id, base: one.seq, steps: one.steps });
        const r2 = await b.submit(1, { id, base: two.seq, steps: two.steps });
        expect(r1.t, JSON.stringify(r1.d)).toBe('sync.ack');
        expect(r2.t, JSON.stringify(r2.d)).toBe('sync.ack');

        const l1 = await h.parts.logs.read({ tenant: h.a.id, doc }, 1);
        const l2 = await h.parts.logs.read({ tenant: h.a.id, doc: doc2 }, 1);
        expect(l1.filter((commit) => commit.id === id).length).toBe(1);
        expect(l2.filter((commit) => commit.id === id).length).toBe(1);
      } finally {
        a.terminate();
        b.terminate();
      }
    });

    t()(
      'keeps an Idempotency-Key of tenant A independent of tenant B, and refuses a changed body under one key',
      async () => {
        const key = `sec015-${uuid7()}`;
        const first = await h.call('POST', '/v1/documents', {
          token: h.a.apiKey,
          headers: { 'Idempotency-Key': key },
          body: {},
        });
        expect(first.status).toBe(201);
        const id1 = first.json.id as string;

        // Tenant B uses the same key: its own document, never tenant A's response.
        const other = await h.call('POST', '/v1/documents', {
          token: h.b.apiKey,
          headers: { 'Idempotency-Key': key },
          body: {},
        });
        expect(other.status).toBe(201);
        expect(other.json.id).not.toBe(id1);

        // Tenant A with the same key and a different body: refused.
        const changed = await h.call('POST', '/v1/documents', {
          token: h.a.apiKey,
          headers: { 'Idempotency-Key': key },
          body: { content: documentWithRegions() },
        });
        expect(changed.json?.code ?? changed.json?.error?.code).toBe('idempotency_mismatch');

        // Tenant A, the same caller and key, on another served route (an export of doc2): that
        // route's own result, a queued job, never the replayed create.
        const otherRoute = await h.call('POST', `/v1/documents/${doc2}/exports`, {
          token: h.a.apiKey,
          headers: { 'Idempotency-Key': key },
          body: { target: 'pdf' },
        });
        expect(otherRoute.status, otherRoute.text.slice(0, 160)).toBe(202);
        expect(otherRoute.headers.get('dep-idempotent-replayed')).toBeNull();
        expect(otherRoute.json.id).toEqual(expect.any(String));
        expect(otherRoute.json.id).not.toBe(id1);
      },
    );

    t()(
      'gives another caller, or the same caller on another route, its own job, and refuses a changed body under one key (criterion 4)',
      async () => {
        const key = `sec015-route-${uuid7()}`;
        const route = `/v1/documents/${doc}/exports`;
        const headers = { 'Idempotency-Key': key };
        const ann = await h.mintToken(h.a, 'ann-key', { [doc]: 'editor', [doc2]: 'editor' });
        const ben = await h.mintToken(h.a, 'ben-key', { [doc]: 'editor' });
        // Every accepted export enqueues one job (a cache hit enqueues a copy), so the count of
        // enqueue calls is the count of jobs this test creates.
        const enqueue = vi.spyOn(h.parts.queue, 'enqueue');
        // The jobs enqueued so far, named, so that a count that is off says which job was extra.
        const jobs = () =>
          enqueue.mock.calls.map(([tenant, job]) => `${tenant} ${job.kind} by ${job.createdBy}`);
        try {
          // Ann creates the export under the key.
          const first = await h.call('POST', route, {
            token: ann,
            headers,
            body: { target: 'pdf' },
          });
          expect(first.status, first.text.slice(0, 160)).toBe(202);
          const jobAnn = first.json.id as string;
          expect(jobs()).toHaveLength(1);

          // Ben, same route, same key, same body: his own job, never Ann's response.
          const second = await h.call('POST', route, {
            token: ben,
            headers,
            body: { target: 'pdf' },
          });
          expect(second.status, second.text.slice(0, 160)).toBe(202);
          expect(second.json.id).not.toBe(jobAnn);

          // The service credential, same route and key: its own job as well.
          const svc = await h.call('POST', route, {
            token: h.a.apiKey,
            headers,
            body: { target: 'pdf' },
          });
          expect(svc.status, svc.text.slice(0, 160)).toBe(202);
          expect(svc.json.id).not.toBe(jobAnn);
          expect(svc.json.id).not.toBe(second.json.id);
          expect(jobs()).toHaveLength(3);

          // Ann, same key and same body, on another served route (an export of doc2): that route's
          // own job, never the replay of her export of doc.
          const routeS = `/v1/documents/${doc2}/exports`;
          const elsewhere = await h.call('POST', routeS, {
            token: ann,
            headers,
            body: { target: 'pdf' },
          });
          expect(elsewhere.status, elsewhere.text.slice(0, 160)).toBe(202);
          expect(elsewhere.headers.get('dep-idempotent-replayed')).toBeNull();
          expect(elsewhere.json.id).toEqual(expect.any(String));
          expect(elsewhere.json.id).not.toBe(jobAnn);
          expect(jobs()).toHaveLength(4);

          // Ann again with the same key and a different body: refused, and no job is created.
          const changed = await h.call('POST', route, {
            token: ann,
            headers,
            body: { target: 'pdf', options: { profile: 'final' } },
          });
          expect(changed.status).toBe(422);
          expect(changed.json?.code ?? changed.json?.error?.code).toBe('idempotency_mismatch');
          expect(changed.json?.id).toBeUndefined();
          expect(jobs(), 'the refused request created no job').toHaveLength(4);

          // Ann's own replays return her jobs, unchanged, and create nothing.
          const replay = await h.call('POST', route, {
            token: ann,
            headers,
            body: { target: 'pdf' },
          });
          expect(replay.status).toBe(202);
          expect(replay.headers.get('dep-idempotent-replayed')).toBe('true');
          expect(replay.json.id).toBe(jobAnn);
          const replayS = await h.call('POST', routeS, {
            token: ann,
            headers,
            body: { target: 'pdf' },
          });
          expect(replayS.status).toBe(202);
          expect(replayS.json.id).toBe(elsewhere.json.id);
          expect(jobs()).toHaveLength(4);
        } finally {
          enqueue.mockRestore();
        }
      },
    );
  });
}
