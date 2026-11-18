/**
 * SEC-044 through the participant endpoints (lane w8, 2026-11-18). The earlier test
 * (sec-044-evidence-scan.pg.test.ts) handed its facts to `recordEvidence`, because no participant
 * endpoint existed. The endpoints exist now (FRW-040, FRW-044 to FRW-047), so this one drives them:
 *
 * - two signers, one after the other. Each opens the document over a WebSocket (the view), accepts
 *   the consent text, signs a signature field with an uploaded image, and completes their part;
 * - the first signer's connection comes from its own loopback address and carries a user agent and
 *   an `amr` that are unique to the run; the consent text is unique too; the signature image is a
 *   real PNG, uploaded through the asset route;
 * - between the two signers the tenant switches IP address and user agent capture off (memory: the
 *   ledger's setting; PostgreSQL: `PgCaptureSettingsStore.change`, which audits the change).
 *
 * Then, criterion 1 (the scan): the commit log, every object, every event, the service log and, on
 * PostgreSQL, every base table as text (and as the hex of its bytes) hold none of the canaries, but
 * `workflow_evidence`. Criterion 3: the second signer's rows, for the view, the consent, the signing
 * and the completion, hold neither an address nor a user agent, and those canaries are in no table at
 * all, while the first signer's rows (made with capture on) do hold them, so the check can fail.
 * Criterion 4: the salts of the stored evidence are in no commit of the log and in no table but the
 * evidence table.
 *
 * Not shown: no control commit carries an evidence hash yet (FRW-041 criterion 2; the signing and the
 * completion write commits without it, ADR 0397), so "only salted hashes of evidence appear in the
 * chain" has nothing to read, and a salt that never reaches the chain is shown against the commits
 * that exist. The search index is fed from checkpoints (BE-054), which are not built, so no search
 * entry holds anything here; PostgreSQL's tables are scanned, and the index table is among them.
 * Runs in memory and on PostgreSQL in the shared container when it answers.
 */
import { createHash } from 'node:crypto';
import type pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DEFAULT_CAPTURE_SETTINGS, type CaptureSettings } from '@docedit/authority';
import { MemoryEventSink } from '../../../services/document-service/src/control-plane/events.ts';
import { createPool } from '../../../services/document-service/src/storage/db.ts';
import { MemoryConsentTextStore } from '../../../services/document-service/src/workflow/consent-service.ts';
import { MemoryEvidenceLedger } from '../../../services/document-service/src/workflow/evidence-ledger.ts';
import { PgCaptureSettingsStore } from '../../../services/document-service/src/workflow/capture-settings-pg.ts';
import { unsandboxed } from '../../../services/asset-worker/src/index.ts';
import {
  documentWithRegions,
  postgresUnavailable,
  startHarness,
  type Harness,
  type Storage,
} from './support/harness.ts';
import { WireClient } from './support/wire.ts';

const RUN = createHash('sha256').update(String(Math.random())).digest('hex').slice(0, 10);
const TEXT_ID = 'sec044-consent';
const VERSION = 1;
const CONSENT_TEXT = `SEC044CONSENT${RUN} I agree to sign this document electronically.`;
/** What the first signer's connection and token carry, and what the second signer's carry. */
const ON = { ip: '127.0.0.77', ua: `Sec044AgentOn/${RUN}`, amr: `sec044-amr-on-${RUN}` };
const OFF = { ip: '127.0.0.78', ua: `Sec044AgentOff/${RUN}`, amr: `sec044-amr-off-${RUN}` };

/** A one-pixel PNG. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

const fid = (n: number) => `fq${String(n).padStart(14, '0')}`;
const F = { sig1: fid(1), date1: fid(2), sig2: fid(3), date2: fid(4) };

function document(): Record<string, unknown> {
  const d = structuredClone(documentWithRegions()) as {
    requires: string[];
    doc: { content: Array<{ type: string; content: unknown[] }> };
  };
  d.requires = ['fields'];
  const defs = d.doc.content[0]!.content;
  defs.push({ type: 'role_def', attrs: { id: 'tenant', name: 'Tenant', color: '#1F77B4' } });
  defs.push({ type: 'role_def', attrs: { id: 'landlord', name: 'Landlord', color: '#FF7F0E' } });
  const ff = (n: number, key: string, kind: string, assignee: string) => ({
    type: 'form_field',
    attrs: { id: fid(n), key, kind, label: key, assignee, required: false, value: null },
  });
  d.doc.content[1]!.content.push({
    type: 'paragraph',
    attrs: { id: 'pSec044000000001' },
    content: [
      ff(1, 'tenant.sig', 'signature', 'tenant'),
      { type: 'text', text: ' ' },
      ff(2, 'tenant.date', 'dateSigned', 'tenant'),
      { type: 'text', text: ' ' },
      ff(3, 'landlord.sig', 'signature', 'landlord'),
      { type: 'text', text: ' ' },
      ff(4, 'landlord.date', 'dateSigned', 'landlord'),
    ],
  });
  return d as unknown as Record<string, unknown>;
}

const body = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8cd4',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  consent: { textId: TEXT_ID, version: VERSION },
  participants: [
    { id: 'p1', roles: ['tenant'], kind: 'signer', order: 1, sub: 'sub-p1' },
    { id: 'p2', roles: ['landlord'], kind: 'signer', order: 2, sub: 'sub-p2' },
  ],
});

const hex = (s: string) => Buffer.from(s, 'utf8').toString('hex');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pgDown = await postgresUnavailable();
if (pgDown) console.warn(`PostgreSQL cases skipped: ${pgDown}`);

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe.skipIf(storage === 'postgres' && pgDown !== null)(
    `SEC-044: evidence of a completed workflow stays outside the log (${storage}, through the endpoints)`,
    () => {
      const texts = new MemoryConsentTextStore();
      const events = new MemoryEventSink();
      let capture: CaptureSettings = DEFAULT_CAPTURE_SETTINGS;
      let h: Harness;
      let pool: pg.Pool | null = null;
      let store: PgCaptureSettingsStore | null = null;
      const clients: WireClient[] = [];

      beforeAll(async () => {
        h = await startHarness(storage, {
          host: '0.0.0.0',
          env: { DOCEDIT_JOB_IDLE_MS: '20' },
          events,
          assetWorker: { sandbox: unsandboxed(), allowUnsandboxed: true },
          parts: {
            consentTexts: texts,
            ...(storage === 'memory'
              ? { evidence: new MemoryEvidenceLedger(Date.now, () => capture) }
              : {}),
          },
        });
        texts.put(h.a.id, TEXT_ID, VERSION, CONSENT_TEXT);
        if (storage === 'postgres') {
          pool = createPool({ connectionString: h.db!.url, max: 3 });
          store = new PgCaptureSettingsStore(pool);
        }
      }, 60_000);
      afterAll(async () => {
        for (const c of clients.splice(0)) c.terminate();
        await h?.close();
        await pool?.end().catch(() => {});
      });

      /** Minted by the service: the audience of a listener on 0.0.0.0 is not the harness's URL. */
      const token = (doc: string, pid: string, amr: string) =>
        h.mintToken(h.a, `sub-${pid}`, { [doc]: 'filler' }, { wfp: pid, amr: [amr] });

      /** The participant opens the document: the view that the evidence records. */
      async function view(doc: string, pid: string, who: typeof ON) {
        const c = await WireClient.connect(h.wsUrl, {
          origin: h.a.origin,
          localAddress: who.ip,
          headers: { 'user-agent': who.ua },
        });
        clients.push(c);
        const w = await c.hello(await token(doc, pid, who.amr), {
          features: ['presence', 'fields', 'regions'],
        });
        expect(w.t, JSON.stringify(w.d)).toBe('welcome');
        const o = await c.open(1, doc, { features: ['fields', 'presence', 'regions'] });
        expect(o.t, JSON.stringify(o.d)).toBe('ch.opened');
        for (let i = 0; i < 100; i++) {
          const rows = await h.parts.evidence!.list(h.a.id, doc);
          if (rows.some((r) => r.participant === pid && r.item === 'viewed')) return;
          await sleep(50);
        }
        throw new Error(`no view evidence for ${pid}`);
      }

      async function readyAsset(doc: string, tok: string): Promise<string> {
        const r = await h.call('POST', `/v1/documents/${doc}/assets`, {
          token: tok,
          body: { filename: 'sig.png', mime: 'image/png', size: PNG.length },
        });
        expect(r.status, r.text).toBe(201);
        const asset = r.json.asset as string;
        await h.service.assets.putQuarantined(h.a.id, asset, PNG);
        expect((await h.call('POST', `/v1/assets/${asset}/complete`, { token: tok })).status).toBe(
          202,
        );
        let row = await h.parts.assetRegistry.get(h.a.id, asset);
        for (let i = 0; i < 300 && row?.state !== 'ready' && row?.state !== 'failed'; i++) {
          await sleep(20);
          row = await h.parts.assetRegistry.get(h.a.id, asset);
        }
        expect(row?.state).toBe('ready');
        return asset;
      }

      /** Consent, adopt and sign, complete: the participant's part, over HTTP with their agent. */
      async function signAndComplete(
        doc: string,
        pid: string,
        who: typeof ON,
        field: string,
      ): Promise<void> {
        const tok = await token(doc, pid, who.amr);
        const headers = { 'user-agent': who.ua };
        const accept = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/${pid}/consent`,
          {
            token: tok,
            body: {},
            headers,
          },
        );
        expect(accept.status, accept.text).toBe(200);
        const asset = await readyAsset(doc, tok);
        const signed = await h.call('POST', `/v1/documents/${doc}/fields/${field}/sign`, {
          token: tok,
          body: { asset, mode: 'uploaded' },
          headers,
        });
        expect(signed.status, signed.text).toBe(200);
        const done = await h.call(
          'POST',
          `/v1/documents/${doc}/workflow/participants/${pid}/complete`,
          { token: tok, body: {}, headers },
        );
        expect(done.status, done.text).toBe(200);
      }

      async function switchCaptureOff(tenant: string): Promise<void> {
        if (store) {
          const changed = await store.change(tenant, 'admin-surrogate-w8-044', {
            captureNetworkIdentity: false,
          });
          expect(changed.audit).not.toBeNull();
        } else capture = { captureNetworkIdentity: false };
      }

      /** The base tables whose rows, read as text or as the hex of their bytes, hold `needle`. */
      async function holders(needle: string): Promise<string[]> {
        const admin = h.db!.admin;
        const tables = await admin.query<{ t: string }>(
          `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
            WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
        );
        expect(tables.rows.length).toBeGreaterThan(5);
        const out: string[] = [];
        for (const { t } of tables.rows) {
          const r = await admin.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM "${t}" x WHERE x::text LIKE $1 OR x::text LIKE $2`,
            [`%${needle}%`, `%${hex(needle)}%`],
          );
          if (Number(r.rows[0]!.n) > 0) out.push(t);
        }
        return out;
      }

      it('keeps every class of evidence out of the log and everything else but the evidence table, and honours the capture switch (criteria 1, 3 and 4, in part)', async () => {
        const doc = await h.createDocument(h.a, document());
        const owner = await h.mintToken(h.a, `owner-044-${RUN}`, { [doc]: 'owner' });
        const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
          token: owner,
          body: body(doc),
          headers: { 'if-match': '"0"' },
        });
        expect(made.status, made.text).toBe(201);
        expect(
          (await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner })).status,
        ).toBe(200);
        const ref = { tenant: h.a.id, doc };

        // The first signer, with capture on.
        await view(doc, 'p1', ON);
        await signAndComplete(doc, 'p1', ON, F.sig1);

        // The tenant switches capture off; the second signer comes after the change.
        await sleep(5);
        await switchCaptureOff(h.a.id);
        await sleep(5);
        await view(doc, 'p2', OFF);
        await signAndComplete(doc, 'p2', OFF, F.sig2);

        const rows = await h.parts.evidence!.list(h.a.id, doc);
        const of = (pid: string) => rows.filter((r) => r.participant === pid);
        const itemsOf = (pid: string) => of(pid).map((r) => r.item);
        // Every event of both signers is on record (the names are the ledger's).
        for (const pid of ['p1', 'p2']) {
          for (const item of ['viewed', 'signed', 'completed'])
            expect(itemsOf(pid), `${pid}: ${itemsOf(pid).join(',')}`).toContain(item);
        }

        // Criterion 3: capture off, so the second signer's rows hold neither value. The first
        // signer's rows do (so the check can fail).
        const network = (r: (typeof rows)[number]) => {
          const e = r.evidence as unknown as { ipAddress?: string; userAgent?: string };
          return { ip: e.ipAddress, ua: e.userAgent };
        };
        for (const r of of('p2')) {
          expect(network(r), `p2 ${r.item}`).toEqual({ ip: undefined, ua: undefined });
          const text = JSON.stringify(r.evidence);
          expect(text).not.toContain(OFF.ip);
          expect(text).not.toContain(OFF.ua);
        }
        const firstView = of('p1').find((r) => r.item === 'viewed')!;
        expect(network(firstView)).toEqual({ ip: ON.ip, ua: ON.ua });
        const firstSigned = of('p1').find((r) => r.item === 'signed')!;
        expect(network(firstSigned).ua).toBe(ON.ua);
        expect(network(firstSigned).ip).toBeTruthy();
        // The other items are kept with capture off.
        expect(JSON.stringify(of('p2').find((r) => r.item === 'viewed')!.evidence)).toContain(
          OFF.amr,
        );

        // Criterion 1: the canaries of both signers are in no commit, object, event or service log.
        // The signature image: its base64 form is in no commit, event or log, and its bytes only in
        // the object store (the asset), whose objects the loop below does not search for the image.
        const imageB64 = PNG.toString('base64');
        const canaries = [ON.ip, ON.ua, ON.amr, OFF.ip, OFF.ua, OFF.amr, CONSENT_TEXT, imageB64];
        const salts = rows.map((r) => Buffer.from(r.salt).toString('hex'));
        expect(salts.length).toBeGreaterThanOrEqual(8);
        const commits = await h.parts.logs.read(ref);
        const origins = commits.map((c) => c.origin);
        // Two signing commits and a control commit; this document has no rule to run, so a
        // completion writes no `rules` commit.
        expect(origins.filter((o) => o === 'sign')).toHaveLength(2);
        const logText = JSON.stringify(commits) + JSON.stringify(await h.parts.logs.head(ref));
        for (const c of canaries) expect(logText, c).not.toContain(c);
        // Criterion 4: no salt, as hex, is in a commit.
        for (const s of salts) expect(logText).not.toContain(s);

        const keys = await h.parts.objects.list('');
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) {
          const bytes = Buffer.from((await h.parts.objects.get(key)) ?? new Uint8Array());
          const text = bytes.toString('utf8');
          for (const c of canaries.slice(0, -1)) expect(text, `${key} ${c}`).not.toContain(c);
          for (const s of salts) expect(text, `${key} salt`).not.toContain(s);
        }
        const eventText = JSON.stringify(events.events);
        expect(eventText.length).toBeGreaterThan(2);
        for (const c of canaries) expect(eventText, c).not.toContain(c);
        for (const s of salts) expect(eventText).not.toContain(s);
        const serviceLog = h.logs.join('\n');
        for (const c of canaries) expect(serviceLog, c).not.toContain(c);
        for (const s of salts) expect(serviceLog).not.toContain(s);

        if (storage === 'postgres') {
          // The audit trail of the switch names the actor and no evidence.
          const audit = await h.db!.admin.query<{ n: string }>(
            `SELECT count(*)::text AS n FROM audit_events x WHERE x::text LIKE '%capture.setting.changed%'`,
          );
          expect(Number(audit.rows[0]!.n)).toBe(1);
          // Every base table, as text and as hex: the first signer's canaries are in the evidence
          // table only (so the scan can fail), the second signer's address and agent are nowhere.
          for (const c of [ON.ip, ON.ua, ON.amr, OFF.amr]) {
            expect(await holders(c), `holders of ${c}`).toEqual(['workflow_evidence']);
          }
          for (const c of [OFF.ip, OFF.ua]) expect(await holders(c), `holders of ${c}`).toEqual([]);
          // The signature image's bytes are in no table (the asset is an object of the store).
          const admin = h.db!.admin;
          const tables = await admin.query<{ t: string }>(
            `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
              WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
          );
          const imageHex = PNG.toString('hex');
          for (const { t } of tables.rows) {
            const r = await admin.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM "${t}" x WHERE x::text LIKE $1 OR x::text LIKE $2`,
              [`%${imageB64}%`, `%${imageHex}%`],
            );
            expect(Number(r.rows[0]!.n), `image in ${t}`).toBe(0);
          }
          // The consent text is held by the text store, not by a table, so it is in none.
          expect(await holders(CONSENT_TEXT)).toEqual([]);
          // The salts are in the evidence table (inside `data`) and in no other table.
          for (const s of salts)
            expect(await holders(s), `holders of salt ${s}`).toEqual(['workflow_evidence']);
        }
      }, 120_000);
    },
  );
}
