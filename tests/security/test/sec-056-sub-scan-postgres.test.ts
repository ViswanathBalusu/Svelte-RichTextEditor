/**
 * SEC-056 criterion 1 against PostgreSQL (10 §4; 08 §13). Lane U-SEC-049-064.
 *
 * A host `sub` that looks like an e-mail address goes through a scenario on the real document
 * service, with PostgreSQL storage: the user mints a token, commits over the WebSocket, reads
 * every content surface as the user, exports, searches, changes a grant (an audit row and a
 * webhook delivery), and the service log is kept. Afterwards the `sub` must appear in no table of
 * the database except the user mapping row (tenant_users), and in no log line, webhook body,
 * export answer, search answer or audit answer that the scenario received.
 *
 * The database sweep reads every column of every table of the scenario's own database as a
 * text value (bytea as bytes). The mapping row is the positive control: the sweep must find the
 * `sub` there, so an empty sweep cannot pass by accident.
 *
 * Run: pnpm vitest run tests/security/test/sec-056-sub-scan-postgres.test.ts
 * (with infra/test-env.ps1 up -NoExport). Skips with the reason when PostgreSQL is not reachable.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  MemoryDeliveryStore,
  WebhookDispatcher,
} from '../../../services/document-service/src/control-plane/webhook-dispatcher.ts';
import {
  MemorySubscriptionStore,
  WebhookSubscriptions,
} from '../../../services/document-service/src/control-plane/webhook-subscriptions.ts';
import type {
  Transport,
  TransportResult,
} from '../../../services/document-service/src/control-plane/webhook-egress.ts';
import {
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const SUB = `sec056.scan+${uuid7()}@example.test`;
const NAME = 'Scan Person SEC-056';
const PARA = 'pIntro0000000001';
const OPEN = 'rOpen00000000001';
const TARGET = 'https://hooks.example.test/sec-056-scan';
const SOURCE = 'urn:docedit:sec-056-scan';
const GRANTS = 'dep.grants.changed.v1';

const skip = await postgresUnavailable();

/** Records every webhook send; answers 204 so each delivery is a success. */
class Recorder implements Transport {
  readonly sent: Array<{ url: string; body: string }> = [];

  async deliver(req: {
    url: string;
    headers: Readonly<Record<string, string>>;
    body: string;
  }): Promise<TransportResult> {
    this.sent.push({ url: req.url, body: req.body });
    return { ok: true, status: 204, hops: 0 };
  }
}

/** Polls `read` until it gives a value; fails after five seconds. */
async function until<T>(read: () => T | undefined, what: string): Promise<T> {
  const deadline = Date.now() + 5000;
  for (;;) {
    const v = read();
    if (v !== undefined) return v;
    if (Date.now() > deadline) throw new Error(`${what} was not delivered in time`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

describe.skipIf(skip !== null)(
  'SEC-056 criterion 1: the sub is in the mapping row and nowhere else (PostgreSQL)',
  () => {
    let h: Harness;
    let transport: Recorder;

    beforeAll(async () => {
      if (skip) return;
      const subs = new MemorySubscriptionStore();
      transport = new Recorder();
      const dispatcher = new WebhookDispatcher({
        subscriptions: subs,
        deliveries: new MemoryDeliveryStore(),
        transport,
        source: SOURCE,
        now: () => Date.now(),
        rejectedThrottle: { windowMs: 60_000, max: 5 },
      });
      h = await startHarness('postgres', {
        events: dispatcher,
        parts: { webhooks: new WebhookSubscriptions({ store: subs, now: () => Date.now() }) },
      });
    }, 60_000);

    afterAll(async () => {
      if (skip) return;
      await h?.close();
    });

    it('a scenario with an e-mail sub leaves the sub only in the user mapping row', async () => {
      const sub = await h.call('POST', '/v1/webhooks', {
        token: h.a.apiKey,
        body: { url: TARGET, events: [GRANTS] },
      });
      expect(sub.status, sub.text).toBe(201);

      const doc = await h.createDocument(h.a, documentWithRegions());
      const token = await h.mintToken(h.a, SUB, { [doc]: 'owner' }, { name: NAME });
      const corpus: Array<{ what: string; text: string }> = [];

      // 1. A commit over the wire, submitted as the user.
      const c = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
      try {
        expect((await c.hello(token)).t).toBe('welcome');
        expect((await c.open(1, doc)).t).toBe('ch.opened');
        const cur = await h.call('GET', `/v1/documents/${doc}/content`, { token });
        expect(cur.status).toBe(200);
        const ack = await c.submit(1, {
          id: uuid7(),
          base: Number(cur.json.seq ?? 0),
          steps: [insertText(posInside(cur.json.doc, PARA), ' SEC-056 scan text.')],
        });
        expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');
      } finally {
        c.terminate();
      }

      // 2. Every content surface, read as the user or as the host for the audit answer.
      const reads = [
        `/v1/documents/${doc}/content`,
        `/v1/documents/${doc}/history`,
        `/v1/documents/${doc}/commits`,
        `/v1/documents/${doc}/attribution`,
        `/v1/documents/${doc}/activity`,
        `/v1/documents/${doc}/versions`,
        `/v1/documents/${doc}/grants`,
        `/v1/documents/${doc}/threads`,
        '/v1/search?q=scan',
        '/v1/audit',
      ];
      for (const path of reads) {
        const r = await h.call('GET', path, { token: path === '/v1/audit' ? h.a.apiKey : token });
        expect(r.status, `${path} must not fail inside the service`).toBeLessThan(500);
        corpus.push({ what: `GET ${path} (${r.status})`, text: r.text });
      }

      // 3. An export, requested as the user.
      const exp = await h.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        headers: { 'Idempotency-Key': uuid7() },
        body: {},
      });
      expect(exp.status, exp.text).toBeLessThan(500);
      corpus.push({ what: `POST exports (${exp.status})`, text: exp.text });

      // 4. A grant change by the owner: one audit row and one webhook delivery.
      const etag = (await h.call('GET', `/v1/documents/${doc}/grants`, { token })).headers.get(
        'etag',
      );
      const grant = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
        token,
        headers: { 'If-Match': etag ?? '' },
        body: { grants: [{ region: OPEN, principal: 'user:gina', role: 'viewer' }] },
      });
      expect(grant.status, grant.text).toBe(200);
      corpus.push({ what: `PATCH grants (${grant.status})`, text: grant.text });
      const delivered = await until(
        () =>
          transport.sent.find(
            (s) => s.url === TARGET && s.body.includes(GRANTS) && s.body.includes(doc),
          ),
        'the grant webhook',
      );
      corpus.push({ what: 'webhook body dep.grants.changed.v1', text: delivered.body });

      // 5. The service log and every webhook body the scenario produced.
      corpus.push({ what: 'service log', text: h.logs.join('\n') });
      corpus.push({ what: 'webhook bodies', text: transport.sent.map((s) => s.body).join('\n') });

      // Positive control: the mapping row holds the sub, so the sweep below can see one.
      const mapping = await h.db!.admin.query<{ sub: string }>(
        'SELECT sub FROM tenant_users WHERE tenant_id = $1 AND sub = $2',
        [h.a.id, SUB],
      );
      expect(mapping.rows.length).toBe(1);

      // The surfaces the scenario received hold no sub.
      for (const entry of corpus) {
        expect(entry.text.includes(SUB), `${entry.what} must not carry the sub`).toBe(false);
      }

      // 6. A sweep of every column of every table in the scenario's database.
      const db = h.db!.admin;
      const cols = await db.query<{ table_name: string; column_name: string; data_type: string }>(
        `SELECT table_name, column_name, data_type FROM information_schema.columns
        WHERE table_schema = 'public' ORDER BY table_name, ordinal_position`,
      );
      const hits: Array<{ table: string; column: string; rows: number }> = [];
      const unscanned: string[] = [];
      for (const col of cols.rows) {
        const t = `"${col.table_name}"`;
        const cname = `"${col.column_name}"`;
        try {
          const bytes = col.data_type === 'bytea';
          const r = await db.query<{ n: number }>(
            bytes
              ? `SELECT count(*)::int AS n FROM ${t} WHERE position($1::bytea in ${cname}) > 0`
              : `SELECT count(*)::int AS n FROM ${t} WHERE position($1 in ${cname}::text) > 0`,
            [bytes ? Buffer.from(SUB, 'utf8') : SUB],
          );
          const n = r.rows[0]?.n ?? 0;
          if (n > 0) hits.push({ table: col.table_name, column: col.column_name, rows: n });
        } catch (e) {
          unscanned.push(
            `${col.table_name}.${col.column_name} (${col.data_type}): ${(e as Error).message}`,
          );
        }
      }
      expect(unscanned, 'every column must be scanned').toEqual([]);
      expect(hits).toEqual([{ table: 'tenant_users', column: 'sub', rows: 1 }]);
    }, 120_000);
  },
);
