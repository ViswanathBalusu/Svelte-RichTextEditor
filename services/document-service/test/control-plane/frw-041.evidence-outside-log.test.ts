// FRW-041 through the composed service: evidence is kept in the workflow evidence table, scoped by
// tenant, and nowhere else. Evidence with marker values (an address, a user agent, a consent text)
// is recorded through the ledger beside a running workflow with real commits, a version, and events;
// then every place the marker could leak to is read: the commit log, every object of the object
// store (checkpoints and exports are objects), the events that become webhooks, and, on PostgreSQL,
// every other table of the database. The payload a control commit would carry holds the origin and
// a salted hash and nothing else; a verifier recomputes the hash from the stored row; a purge
// removes the rows and leaves the chain as it was. Memory storage and, when the test environment
// is up, PostgreSQL in Podman. docs/adr/0391-w4-FRW-041-evidence-ledger.md (proposed).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { uuid7 } from '@docedit/model';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DepClient } from '../data-plane/client.ts';
import { PgEvidenceRowStore } from '../../src/workflow/evidence-store.ts';
import {
  evidenceCanonical,
  type MemoryEvidenceLedger,
  recomputeCommitment,
  verifyAgainstChain,
} from '../../src/workflow/evidence-ledger.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
  type Storage,
} from './support.ts';

const rand = uuid7().slice(-12);
const IP = '203.0.113.77';
const UA = `MarkerBrowser/9.9-${rand}`;
const CONSENT = `MARKER-CONSENT-TEXT-${rand}`;
const MARKERS = [IP, UA, CONSENT];

const BODY = (doc: string) => ({
  id: '0192f3a1-7c3e-7d2a-9b1c-4e5f6a7b8ca1',
  doc,
  state: 'draft',
  rev: 0,
  timeZone: 'UTC',
  participants: [{ id: 'p1', roles: ['tenant'], kind: 'filler', order: 1, sub: 'sub-p1' }],
});

const facts = (item: string) => ({
  items: {
    session: `session-${item}`,
    consent: { textId: CONSENT, version: 1, hash: 'a'.repeat(64), atMs: 1 },
  },
  ipAddress: IP,
  userAgent: UA,
});
/** Every `.ts` file under the service and packages source folders, as paths and text. */
function sources(root: string): Array<{ path: string; text: string }> {
  const out: Array<{ path: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      if (name === 'node_modules' || name === 'dist') continue;
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full);
      else if (name.endsWith('.ts') && !/\.test\.ts$/.test(name))
        out.push({
          path: relative(root, full).split(sep).join('/'),
          text: readFileSync(full, 'utf8'),
        });
    }
  };
  for (const part of ['packages', 'services']) walk(join(root, part));
  return out;
}

for (const storage of ['memory', 'postgres'] as Storage[]) {
  describe(`evidence outside the commit log (${storage}; FRW-041)`, async () => {
    const skip = await skipReason(storage);
    let h: Harness;
    const clients: DepClient[] = [];
    beforeAll(async () => {
      if (!skip) h = await startHarness(storage, { realDataPlane: true });
    });
    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
    });

    /** A document with a workflow that was sent, so the log, versions and events exist. */
    async function sentWorkflow(connected = false) {
      const doc = await h.createDocument({ content: documentWithRegions() });
      const owner = h.userToken({ [doc]: 'owner' }, { sub: `owner-041-${uuid7()}` });
      const made = await h.call('PUT', `/v1/documents/${doc}/workflow`, {
        token: owner,
        body: BODY(doc),
        headers: { 'if-match': '"0"' },
      });
      expect(made.status, made.text).toBe(201);
      if (connected) await ownerChannel(doc, owner);
      const sent = await h.call('POST', `/v1/documents/${doc}/workflow/send`, { token: owner });
      expect(sent.status, sent.text).toBe(200);
      return { doc, owner, ref: { tenant: h.tenant, doc } };
    }

    const ledger = () => h.parts.evidence!;

    /** An owner's channel, opened before the send, makes the room write the control commit of it. */
    async function ownerChannel(doc: string, owner: string): Promise<void> {
      const c = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`);
      clients.push(c);
      expect((await c.hello(owner)).t).toBe('welcome');
      expect((await c.open(1, doc)).t).toBe('ch.opened');
    }
    it.skipIf(skip)(
      'stores the evidence in the ledger, and finds it in no commit, object, event or other table (criterion 1)',
      async () => {
        const { doc, ref } = await sentWorkflow(true);
        for (let i = 0; i < 100 && (await h.parts.logs.read(ref)).length === 0; i++)
          await new Promise((r) => setTimeout(r, 50));
        await ledger().record(h.tenant, {
          doc,
          participant: 'p1',
          kind: 'signer' as const,
          item: 'consented',
          origin: 'sign',
          facts: facts('consented'),
        });
        await ledger().record(h.tenant, {
          doc,
          participant: 'p1',
          kind: 'signer' as const,
          item: 'completed',
          origin: 'rules',
          facts: facts('completed'),
        });
        // The ledger has it, with the network identity the setting allows (on by default).
        const rows = await ledger().list(h.tenant, doc);
        expect(rows.map((r) => r.item)).toEqual(['consented', 'completed']);
        expect(rows[0]!.evidence).toMatchObject({ ipAddress: IP, userAgent: UA });
        expect(JSON.stringify(rows[0]!.evidence)).toContain(CONSENT);

        // The commit log holds none of it: the commits, their payloads and the chain.
        const commits = await h.parts.logs.read(ref);
        expect(commits.length).toBeGreaterThan(0);
        const logText = JSON.stringify(commits);
        for (const m of MARKERS) expect(logText).not.toContain(m);
        expect(JSON.stringify(await h.parts.logs.head(ref))).not.toContain(IP);

        // No object of the store (checkpoints, exports, versions, assets) holds it.
        const keys = await h.parts.objects.list('');
        expect(keys.length).toBeGreaterThan(0);
        for (const key of keys) {
          const body = await h.parts.objects.get(key);
          const text = Buffer.from(body ?? new Uint8Array()).toString('utf8');
          for (const m of MARKERS) expect(text, key).not.toContain(m);
        }

        // No event, which the dispatcher turns into a webhook, holds it.
        const events = JSON.stringify(h.events.events);
        expect(events.length).toBeGreaterThan(2);
        for (const m of MARKERS) expect(events).not.toContain(m);

        // On PostgreSQL: the marker is in table workflow_evidence, scoped by the tenant, and in no
        // other table of the database (the admin role sees every row).
        if (h.db !== null) {
          const tables = (
            await h.db.admin.query<{ t: string }>(
              `SELECT c.relname AS t FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
                WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT c.relispartition`,
            )
          ).rows.map((r) => r.t);
          const holders: string[] = [];
          for (const t of tables) {
            const r = await h.db.admin.query<{ n: string }>(
              `SELECT count(*)::text AS n FROM "${t}" x WHERE x::text LIKE $1`,
              [`%${UA}%`],
            );
            if (Number(r.rows[0]!.n) > 0) holders.push(t);
          }
          expect(holders).toEqual(['workflow_evidence']);
          const mine = await h.db.admin.query<{ tenant_id: string; n: string }>(
            `SELECT tenant_id::text, count(*)::text AS n FROM workflow_evidence
              WHERE doc_id = $1 GROUP BY tenant_id`,
            [doc],
          );
          expect(mine.rows).toEqual([{ tenant_id: h.tenant, n: '2' }]);
        }
      },
      60_000,
    );

    it.skipIf(skip)(
      'is read by no module that makes an export, a checkpoint, a webhook or a search entry (criterion 1, structure)',
      () => {
        // The root of the repository: this file is services/document-service/test/control-plane/.
        const root = join(import.meta.dirname, '..', '..', '..', '..');
        const holders = sources(root)
          .filter((f) => f.text.includes('workflow_evidence'))
          .map((f) => f.path)
          .sort();
        // Only the evidence modules and the purge name the table.
        expect(holders).toEqual([
          'services/document-service/src/control-plane/document-purge-pg.ts',
          'services/document-service/src/workflow/capture-settings-pg.ts',
          'services/document-service/src/workflow/evidence-ledger-pg.ts',
          'services/document-service/src/workflow/evidence-ledger.ts',
          'services/document-service/src/workflow/evidence-store.ts',
        ]);
        // And the ledger's own port is used by nothing that builds those outputs.
        const users = sources(root)
          .filter((f) => /evidence-ledger|parts\.evidence|\.evidence\./.test(f.text))
          .map((f) => f.path)
          .filter((p) => /export|checkpoint|webhook|search/.test(p));
        expect(users).toEqual([]);
      },
    );

    it.skipIf(skip)(
      'gives the control commit the origin and a salted hash and nothing else (criterion 2, the payload)',
      async () => {
        const { doc } = await sentWorkflow();
        const a = await ledger().record(h.tenant, {
          doc,
          participant: 'p1',
          kind: 'signer' as const,
          item: 'consented',
          origin: 'sign',
          facts: facts('same'),
        });
        const b = await ledger().record(h.tenant, {
          doc,
          participant: 'p1',
          kind: 'signer' as const,
          item: 'consented',
          origin: 'sign',
          facts: facts('same'),
        });
        expect(Object.keys(a.commit!).sort()).toEqual(['evidenceHash', 'origin']);
        expect(a.commit!.origin).toBe('sign');
        expect(a.commit!.evidenceHash).toMatch(/^[0-9a-f]{64}$/);
        // The same evidence under a fresh salt gives another hash: the hash reveals nothing of it.
        expect(a.commit!.evidenceHash).not.toBe(b.commit!.evidenceHash);
        const text = JSON.stringify(a.commit);
        for (const m of MARKERS) expect(text).not.toContain(m);
        const stored = (await ledger().list(h.tenant, doc)).find((r) => r.id === a.id)!;
        expect(text).not.toContain(Buffer.from(stored.salt).toString('hex'));
      },
    );

    it.skipIf(skip)(
      'lets a verifier recompute each hash from the stored row, and keeps the chain whole after a purge (criterion 3, in part)',
      async () => {
        const { doc, ref } = await sentWorkflow();
        const made = [
          await ledger().record(h.tenant, {
            doc,
            participant: 'p1',
            kind: 'signer' as const,
            item: 'consented',
            origin: 'sign',
            facts: facts('one'),
          }),
          await ledger().record(h.tenant, {
            doc,
            participant: 'p1',
            kind: 'signer' as const,
            item: 'completed',
            origin: 'rules',
            facts: facts('two'),
          }),
        ];
        // What a control commit would hold for these two events.
        const chain = new Set(made.map((m) => m.commit!.evidenceHash));
        const rows = await ledger().list(h.tenant, doc);
        expect(rows).toHaveLength(2);
        for (const row of rows) {
          expect(await recomputeCommitment(row)).toBe(row.hash);
          expect(chain.has(row.hash)).toBe(true);
        }
        expect(await verifyAgainstChain(rows, chain)).toEqual({
          matched: rows.map((r) => r.id),
          unmatched: [],
        });
        // Changed evidence, another salt, or another participant no longer match the chain.
        const first = rows[0]!;
        const altered = {
          ...first,
          evidence: { ...first.evidence, ipAddress: '198.51.100.1' },
        };
        const resalted = { ...first, salt: new Uint8Array(16) };
        const other = { ...first, participant: 'p2' };
        const verdict = await verifyAgainstChain([altered, resalted, other], chain);
        expect(verdict.matched).toEqual([]);
        expect(verdict.unmatched).toHaveLength(3);
        expect(evidenceCanonical('p1', 'consented', first.evidence)).not.toContain('p2');

        // A purge removes the rows. The commit log and its head are as they were; the hashes the
        // chain holds need none of the evidence to stand.
        const headBefore = await h.parts.logs.state?.(ref);
        const logBefore = JSON.stringify(await h.parts.logs.read(ref));
        if (h.db !== null) {
          const store = new PgEvidenceRowStore(h.parts.pool!, h.tenant);
          await store.deleteRows(
            doc,
            rows.map((r) => r.id),
          );
        } else (ledger() as MemoryEvidenceLedger).purge(h.tenant, doc);
        expect(await ledger().list(h.tenant, doc)).toEqual([]);
        expect(await h.parts.logs.state?.(ref)).toEqual(headBefore);
        expect(JSON.stringify(await h.parts.logs.read(ref))).toBe(logBefore);
        const verify = (h.parts.logs as unknown as { verify?: (r: typeof ref) => Promise<unknown> })
          .verify;
        if (verify) expect(await verify.call(h.parts.logs, ref)).toMatchObject({ ok: true });
      },
    );
  });
}
