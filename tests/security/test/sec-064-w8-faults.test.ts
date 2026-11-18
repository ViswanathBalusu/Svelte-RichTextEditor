/**
 * SEC-064 criterion 2 (lane w8): hidden content stays hidden while grants change, while a second
 * service node never hears of a change, and across a restart of the service.
 *
 * - Grant churn: a reader is granted the confidential region and revoked again several times. After
 *   each revocation the reader reads until the first projection without the canary; the number of
 *   reads that still carried it (stale reads) and the time to the first clean read are recorded. A
 *   writer commits a canary into the region after each revocation, and the revoked reader's open
 *   channel must not carry it. A reader who never had a grant reads continuously and never sees a
 *   canary.
 * - Lost notification (PostgreSQL): two service nodes share one database. The grants change through
 *   node B and node A is never told; a read through node A after the change must not carry the
 *   canary. The window is the time from the change to the first clean read through node A.
 * - Failover (PostgreSQL): the service stops and a new process takes over the same database and
 *   port. Revoked and never-granted readers get no canary from it.
 *
 * The windows are wall-clock times in one process on one machine; when DOCEDIT_W8_REPORT names a
 * file the run appends them there. They are measurements of this run, not limits.
 */
import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { visibility } from '@docedit/authority';
import { S3ObjectStore } from '../../../services/document-service/src/objects/s3.ts';
import { settings } from '../../../services/document-service/test/support/env.ts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FULL_VIEWS } from '../../../services/document-service/src/control-plane/visibility.ts';
import {
  createTestDatabase,
  documentWithRegions,
  insertText,
  posInside,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
  type TestDatabase,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const CANARY = {
  title: 'CANARY_CONF_TITLE_4e1d',
  text: 'CANARY_CONF_TEXT_8a2c',
  value: 'CANARY_SENSITIVE_6f0b',
};
const CANARIES = Object.values(CANARY);
const CONF = 'rConf00000000001';
const CONF_PARA = 'pConf00000000001';
const SENS = 'fSens00000000001';
const SENS_PARA = 'pSens00000000001';
const OPEN = { features: ['regions', 'presence', 'fields'] };
const VIEWS = () => ({ ...FULL_VIEWS, visibility: visibility(() => Date.now()) });

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const report = (line: string) => {
  const file = process.env['DOCEDIT_W8_REPORT'];
  if (file) appendFileSync(file, `${line}\n`);
};

function confidentialDocument(): Record<string, unknown> {
  const content = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  content.requires = ['fields'];
  const body = content.doc.content[1]!;
  const end = body.content.pop()!;
  body.content.push(
    {
      type: 'region',
      attrs: { id: CONF, title: CANARY.title, policy: 'confidential' },
      content: [
        {
          type: 'paragraph',
          attrs: { id: CONF_PARA, style: 'Normal' },
          content: [{ type: 'text', text: CANARY.text }],
        },
      ],
    },
    {
      type: 'paragraph',
      attrs: { id: SENS_PARA, style: 'Normal' },
      content: [
        { type: 'text', text: 'Deposit: ' },
        {
          type: 'form_field',
          attrs: {
            id: SENS,
            key: 'deposit',
            kind: 'text',
            label: 'deposit',
            assignee: null,
            sensitive: true,
            value: CANARY.value,
          },
        },
      ],
    },
    end,
  );
  return content;
}

const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

/** Grants through `h` (the service credential), with the current entity tag. */
async function setGrants(h: Harness, doc: string, grants: unknown[], apiKey = h.a.apiKey) {
  const etag = (await h.call('GET', `/v1/documents/${doc}/grants`, { token: apiKey })).headers.get(
    'etag',
  )!;
  const r = await h.call('PATCH', `/v1/documents/${doc}/grants`, {
    token: apiKey,
    headers: { 'If-Match': etag },
    body: { grants },
  });
  expect(r.status, r.text).toBe(200);
}

const GRANT_GINA = [{ region: CONF, principal: 'user:gina', role: 'viewer' }];

/**
 * Reads as `token` through `h` until the first answer without the hidden text (a projection, or a
 * refusal: neither leaks). Returns the number of reads that still carried the text, the time from
 * `since` to that answer, and the answer's status.
 */
async function windowAfterRevoke(
  h: Harness,
  doc: string,
  token: string,
  since: number,
): Promise<{ stale: number; ms: number; status: number; text: string }> {
  let stale = 0;
  for (let i = 0; i < 400; i++) {
    const r = await h.call('GET', `/v1/documents/${doc}/content`, { token });
    if (!r.text.includes(CANARY.text))
      return { stale, ms: Date.now() - since, status: r.status, text: r.text.slice(0, 200) };
    stale++;
    await sleep(5);
  }
  throw new Error('the revoked reader still gets the hidden text after 400 reads');
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const skip = storage === 'postgres' ? await postgresUnavailable() : null;
  describe(`SEC-064 grants change during a run (${storage})`, () => {
    let h: Harness;
    let doc: string;
    let ann: string;
    let frank: string;
    let gina: string;
    const t = () => (skip ? it.skip : it);

    beforeAll(async () => {
      if (skip) return;
      h = await startHarness(storage, { views: VIEWS() });
      doc = await h.createDocument(h.a, confidentialDocument());
      ann = h.userToken(h.a, 'ann', { [doc]: 'owner' });
      frank = h.userToken(h.a, 'frank', { [doc]: 'viewer' });
      gina = h.userToken(h.a, 'gina', { [doc]: 'viewer' });
    });
    afterAll(async () => {
      await h?.close();
    });

    t()(
      'repeated grants and revocations leave no stale read, no canary on the revoked channel and none for a reader who never had access',
      async () => {
        const cycles = 6;
        const windows: number[] = [];
        let stale = 0;
        let told = 0;
        let closedMsgs = 0;
        let permMsgs = 0;
        const toldMs: number[] = [];

        // The reader who never had access reads all the while.
        let reading = true;
        let franksReads = 0;
        const leaks: string[] = [];
        const franksLoop = (async () => {
          while (reading) {
            for (const u of [
              `/documents/${doc}/content`,
              `/documents/${doc}/commits?after=0`,
              `/documents/${doc}/history`,
              `/documents/${doc}/field-values`,
            ]) {
              const r = await h.call('GET', `/v1${u}`, { token: frank });
              franksReads++;
              for (const c of CANARIES) if (r.text.includes(c)) leaks.push(`${u} carried ${c}`);
            }
            await sleep(2);
          }
        })();

        const writer = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
        let base = 0;
        try {
          expect((await writer.hello(ann)).t).toBe('welcome');
          expect((await writer.open(1, doc, OPEN)).t).toBe('ch.opened');

          for (let i = 0; i < cycles; i++) {
            await setGrants(h, doc, GRANT_GINA);
            const granted = await h.call('GET', `/v1/documents/${doc}/content`, { token: gina });
            expect(granted.text, `cycle ${i}: the granted reader sees the text`).toContain(
              CANARY.text,
            );

            const channel = await WireClient.connect(h.wsUrl, { origin: h.a.origin });
            try {
              expect((await channel.hello(gina)).t).toBe('welcome');
              expect((await channel.open(1, doc, OPEN)).t).toBe('ch.opened');

              const started = Date.now();
              await setGrants(h, doc, []);
              const w = await windowAfterRevoke(h, doc, gina, started);
              windows.push(w.ms);
              stale += w.stale;

              // A commit into the region after the revocation must not reach the revoked channel.
              const canary = `CANARY_W8_CYCLE_${i}_${randomUUID().slice(0, 6)}`;
              const pos = posInside(
                (await h.call('GET', `/v1/documents/${doc}/content`, { token: ann })).json.doc,
                CONF_PARA,
              );
              const ack = await writer.submit(1, {
                id: uuid7(),
                base,
                steps: [insertText(pos, ` ${canary}`)],
              });
              expect(ack.t, JSON.stringify(ack.d)).toBe('sync.ack');
              base = (ack.d?.['seq'] as number | undefined) ?? base + 1;

              // Whether the channel is told (a close or a notice) is measured.
              const until = Date.now() + 3000;
              while (
                Date.now() < until &&
                channel.closeInfo === null &&
                channel.all('perm.changed').length === 0 &&
                channel.all('ch.closed').length === 0
              )
                await sleep(10);
              if (
                channel.closeInfo !== null ||
                channel.all('perm.changed').length > 0 ||
                channel.all('ch.closed').length > 0
              ) {
                told++;
                if (channel.all('ch.closed').length > 0) closedMsgs++;
                if (channel.all('perm.changed').length > 0) permMsgs++;
                toldMs.push(Date.now() - started);
              }
              const frames = channel.frames.join('\n');
              expect(
                frames,
                `cycle ${i}: the revoked channel must not carry ${canary}`,
              ).not.toContain(canary);
            } finally {
              channel.terminate();
            }
          }
        } finally {
          writer.terminate();
          reading = false;
          await franksLoop;
        }

        expect(leaks, 'the reader who never had access').toEqual([]);
        // Four routes a round: at least one whole round ran while the grants changed.
        expect(franksReads, 'that reader read while the grants changed').toBeGreaterThanOrEqual(4);
        expect(stale, 'reads after a revocation that still carried the hidden text').toBe(0);
        expect(told, 'the revoked channel is told of the change, by a close (ch.closed)').toBe(
          cycles,
        );
        expect(closedMsgs, 'by a ch.closed message').toBe(cycles);
        report(
          `${storage} grant churn: ${cycles} cycles; time from the revocation to the first clean read: median ${median(windows)} ms, max ${Math.max(...windows)} ms; stale reads ${stale}; revoked channel told within 3000 ms in ${told} of ${cycles} (ch.closed messages ${closedMsgs}, perm.changed messages ${permMsgs})${toldMs.length ? ` (median ${median(toldMs)} ms)` : ''}; reads by the never-granted reader ${franksReads}`,
        );
      },
      120_000,
    );
  });
}

const s3 = (() => {
  try {
    const S = settings();
    return {
      endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
      region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
      bucket: S['DOCEDIT_S3_BUCKET'] ?? 'docedit-test',
      accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
      secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
    };
  } catch {
    return null;
  }
})();
const s3Env: Record<string, string> = s3
  ? {
      DOCEDIT_S3_ENDPOINT: s3.endpoint,
      DOCEDIT_S3_REGION: s3.region,
      DOCEDIT_S3_BUCKET: s3.bucket,
      DOCEDIT_S3_ACCESS_KEY: s3.accessKeyId,
      DOCEDIT_S3_SECRET_KEY: s3.secretAccessKey,
    }
  : {};
async function s3Unavailable(): Promise<string | null> {
  if (!s3) return 'the S3-compatible store is not configured';
  try {
    await new S3ObjectStore(s3).exists(`probe/${randomUUID()}`);
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable (${e instanceof Error ? e.message : String(e)})`;
  }
}
const pgSkip = (await postgresUnavailable()) ?? (await s3Unavailable());

describe.skipIf(pgSkip !== null)(
  'SEC-064 a node that is not told of a change, and a restart (PostgreSQL)',
  () => {
    let db: TestDatabase;
    beforeAll(async () => {
      db = await createTestDatabase();
    });
    const tenants: string[] = [];
    afterAll(async () => {
      await db?.drop();
      if (s3) {
        const store = new S3ObjectStore(s3);
        for (const t of tenants)
          for (const key of await store.list(`tenants/${t}/`)) await store.delete(key);
      }
    });

    it('a read through a node that never heard of the revocation carries no canary', async () => {
      const a = await startHarness('postgres', {
        databaseUrl: db.url,
        env: s3Env,
        views: VIEWS(),
        node: 'w8-node-a',
      });
      const b = await startHarness('postgres', {
        databaseUrl: db.url,
        env: s3Env,
        views: VIEWS(),
        node: 'w8-node-b',
      });
      try {
        tenants.push(a.a.id);
        const doc = await a.createDocument(a.a, confidentialDocument());
        // Tokens signed by tenant A's host key, with the audience of the node that is called.
        const tokenFor = (node: Harness, sub: string, role: string) =>
          a.userToken(a.a, sub, { [doc]: role }, { claims: { aud: node.base } });
        const ginaA = tokenFor(a, 'gina', 'viewer');
        const frankA = tokenFor(a, 'frank', 'viewer');

        await setGrants(a, doc, GRANT_GINA);
        // Node A reads (and so holds whatever it caches) with the grant in place.
        const granted = await a.call('GET', `/v1/documents/${doc}/content`, { token: ginaA });
        expect(granted.text, 'through node A the granted reader sees the text').toContain(
          CANARY.text,
        );

        // The change goes through node B only; node A is told nothing.
        const started = Date.now();
        await setGrants(b, doc, [], a.a.apiKey);
        const w = await windowAfterRevoke(a, doc, ginaA, started);
        expect(w.stale, 'reads through node A after the change that carried the text').toBe(0);
        const franks = await a.call('GET', `/v1/documents/${doc}/content`, { token: frankA });
        for (const c of CANARIES) expect(franks.text).not.toContain(c);
        report(
          `postgres two nodes: grants revoked through node B, node A not told; first answer without the text through node A after ${w.ms} ms (status ${w.status}), stale reads ${w.stale}`,
        );
      } finally {
        await b.close();
        await a.close();
      }
    }, 120_000);

    it('after the service restarts on the same database and port, revoked and never-granted readers get no canary', async () => {
      const first = await startHarness('postgres', {
        databaseUrl: db.url,
        views: VIEWS(),
        env: s3Env,
      });
      const port = Number(new URL(first.base).port);
      let doc: string;
      let ginaOld: string;
      try {
        tenants.push(first.a.id);
        doc = await first.createDocument(first.a, confidentialDocument());
        ginaOld = first.userToken(first.a, 'gina', { [doc]: 'viewer' });
        await setGrants(first, doc, GRANT_GINA);
        const seen = await first.call('GET', `/v1/documents/${doc}/content`, { token: ginaOld });
        expect(seen.text).toContain(CANARY.text);
        await setGrants(first, doc, []);
      } finally {
        await first.close();
      }

      const second = await startHarness('postgres', {
        databaseUrl: db.url,
        env: s3Env,
        views: VIEWS(),
        port,
      });
      try {
        expect(Number(new URL(second.base).port)).toBe(port);
        // The service credential and the host-signed tokens come from the database, so they work.
        const started = Date.now();
        const w = await windowAfterRevoke(second, doc, ginaOld, started);
        expect(w.status, w.text).toBe(200);
        expect(w.stale).toBe(0);
        const frank = second.userToken(first.a, 'frank', { [doc]: 'viewer' });
        for (const u of [
          `/documents/${doc}/content`,
          `/documents/${doc}/content?seq=0`,
          `/documents/${doc}/field-values`,
          `/documents/${doc}/history`,
        ]) {
          const r = await second.call('GET', `/v1${u}`, { token: frank });
          for (const c of CANARIES) expect(r.text, `${u} must not carry ${c}`).not.toContain(c);
        }
        // A reader granted again after the restart sees the text, so the check can fail.
        await setGrants(second, doc, GRANT_GINA, first.a.apiKey);
        const again = await second.call('GET', `/v1/documents/${doc}/content`, { token: ginaOld });
        expect(again.text).toContain(CANARY.text);
        report(
          `postgres restart: first answer without the text for the revoked reader after the restart ${w.ms} ms (status ${w.status}), stale reads ${w.stale}`,
        );
      } finally {
        await second.close();
      }
    }, 120_000);
  },
);
