// HIS-036: signed, time-stamped chain heads in write-once storage, on PostgreSQL.
//
// The document service anchors through the signing service over HTTP (the real `SigningService` and
// its transport on the loopback interface), which signs with a test chain and gets RFC 3161 tokens
// from a local OpenSSL time-stamp authority (owner decisions 221 to 223: development choices; the
// production key service, certificate and authority are not chosen). The key is in the test process
// here, so this file is not evidence of where a key is kept (criterion 2); the signing service's
// own tests run it with the SoftHSM2 emulator in Podman.
//
// Two parts:
//
// 1. The composed service with its real data plane and its own scheduler. No job is run by hand:
//    the clock is moved an hour and the job runner runs the slot of `heads.anchor`. The write-once
//    store is in memory in this part, because the clock that is moved would set retentions hours
//    ahead in a real bucket. Criteria: 1 (the record and what it names), 3 (the token is the
//    configured authority's), 5 (a run that fails, the alert, editing meanwhile, and the next run
//    covering what was missed) and 6 (the verification tool, as a child process).
// 2. The same job over a real bucket with Object Lock (the S3-compatible store of the test
//    environment), with the machine's clock and a retention of seconds: the record and the leaf
//    list are written there and can be neither deleted nor overwritten before the retention ends.
//
// Skipped, with the reason, when PostgreSQL, the object store or OpenSSL is missing. Test values only.
import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseHeadAnchorRecord, parseLeafList, type AnchoredHead } from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { HttpTimestampAuthority, timestampInfo } from '../../../signing-service/src/cms.ts';
import { createSigningServer } from '../../../signing-service/src/http.ts';
import { verifyBatchAnchorFile } from '../../../signing-service/src/verify-sealed.ts';
import {
  makePki,
  opensslAvailable,
  type TestPki,
} from '../../../signing-service/test/support/pki.ts';
import {
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  type World,
} from '../../../signing-service/test/support/service-world.ts';
import { startTestTsa, type TestTsa } from '../../../signing-service/test/support/tsa.ts';
import { cmsParts, verifyDetached } from '../../../signing-service/test/support/verify.ts';
import { InProcessKeyService } from '../../../signing-service/test/support/world.ts';
import {
  AnchorFileConflictError,
  ANCHOR_PERIOD_MS,
  HeadAnchoring,
  headAnchoringTask,
  MemoryHeadAnchorFiles,
  ObjectHeadAnchorFiles,
  type HeadAnchorFile,
} from '../../src/control-plane/head-anchoring.ts';
import { PgHeadAnchorStore } from '../../src/control-plane/head-anchoring-pg.ts';
import type { JobQueue } from '../../src/control-plane/jobs/queue.ts';
import { Scheduler } from '../../src/control-plane/scheduler.ts';
import type { LogFields } from '../../src/log.ts';
import { S3ObjectStore } from '../../src/objects/s3.ts';
import { objectKeys } from '../../src/objects/store.ts';
import type { PgLogStore } from '../../src/storage/log-store.ts';
import type { DocRef } from '../../src/storage/types.ts';
import { HttpSigningClient } from '../../src/workflow/signing-client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../control-plane/support.ts';
import { DepClient, insertText } from '../data-plane/client.ts';
import { settings } from '../support/env.ts';

const S = settings();
const s3Base = {
  endpoint: `http://${S['DOCEDIT_S3_HOST']}:${S['DOCEDIT_S3_PORT']}`,
  region: S['DOCEDIT_S3_REGION'] ?? 'us-east-1',
  accessKeyId: S['DOCEDIT_S3_ACCESS_KEY'] ?? '',
  secretAccessKey: S['DOCEDIT_S3_SECRET_KEY'] ?? '',
};

async function s3Unavailable(): Promise<string | null> {
  try {
    await new S3ObjectStore({ ...s3Base, bucket: 'docedit-probe' }).exists('probe');
    return null;
  } catch (e) {
    return `the S3-compatible store is not reachable at ${s3Base.endpoint} (${e instanceof Error ? e.message : String(e)}); start it with: pwsh -NoProfile -File infra/test-env.ps1 up`;
  }
}

const skip =
  (await skipReason('postgres')) ??
  (opensslAvailable() ? null : 'OpenSSL is not on the path') ??
  (await s3Unavailable());
if (skip) console.warn(`skipped: ${skip}`);

const HOUR = ANCHOR_PERIOD_MS;
const DAY = 24 * HOUR;
const TOOL = fileURLToPath(
  new URL('../../../signing-service/scripts/verify-anchor.ts', import.meta.url),
);
const sha256Hex = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');

function runTool(args: string[]): Promise<{ code: number; report: Record<string, unknown> }> {
  return new Promise((resolve) => {
    execFile(
      process.execPath,
      [TOOL, ...args],
      { timeout: 60_000, maxBuffer: 16 * 1024 * 1024 },
      (error, stdout) => {
        const code = error ? (typeof error.code === 'number' ? error.code : 1) : 0;
        let report: Record<string, unknown>;
        try {
          report = JSON.parse(stdout) as Record<string, unknown>;
        } catch {
          report = { raw: stdout };
        }
        resolve({ code, report });
      },
    );
  });
}

describe.skipIf(skip !== null)('anchoring chain heads (HIS-036, PostgreSQL)', () => {
  let pki: TestPki;
  let tsa: TestTsa;
  let world: World;
  let server: Server;
  let url = '';
  /** The time-stamp authority can be made to stop answering. */
  let authorityDown = false;
  let pos = -1;

  beforeAll(async () => {
    const ks = new InProcessKeyService();
    pki = makePki(await ks.publicKey());
    tsa = await startTestTsa(pki);
    const authority = new HttpTimestampAuthority(tsa.url);
    world = makeWorld({
      operator: { id: 'operator-key', keyService: ks, pki },
      tsaUrl: tsa.url,
      timestamps: {
        stamp: (d) =>
          authorityDown ? Promise.reject(new Error('authority down')) : authority.stamp(d),
      },
    });
    server = createSigningServer(world.service, { maxBodyBytes: 1_000_000 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    url = `http://127.0.0.1:${addr.port}`;
    const root = cdmSchema().nodeFromJSON(documentWithRegions()['doc']);
    root.descendants((node, p) => {
      if (pos < 0 && node.isTextblock) pos = p + 1;
      return pos < 0;
    });
  }, 120_000);

  afterAll(async () => {
    await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
    await tsa?.stop();
    pki?.remove();
  });

  const signingClient = () =>
    new HttpSigningClient({ url, credential: DOCUMENT_SERVICE_SECRET, timeoutMs: 60_000 });

  /** A document with `count` typing commits, appended as a room does. */
  async function documentWith(h: Harness, title: string, count: number): Promise<string> {
    const d = await h.createDocument({ content: documentWithRegions(), title });
    await type(h, d, count);
    return d;
  }

  async function type(h: Harness, d: string, count: number): Promise<void> {
    const r: DocRef = { tenant: h.tenant, doc: d };
    const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
    const epoch = await h.parts.ownership.claim(r, 'test-node');
    for (let i = 0; i < count; i++) {
      const head = await h.parts.logs.head(r);
      const perms = await h.parts.grants.current(r);
      const res = await h.parts.logs.append(r, {
        epoch,
        revision: perms.revision,
        fromSeq: head.seq + 1,
        commits: [
          {
            seq: head.seq + 1,
            id: uuid7(),
            kind: 'steps' as const,
            steps: [insertText(pos, 'x')] as never,
            user: bob,
            session: 's',
            time: h.now(),
            origin: 'input',
            scopes: ['body'],
            revision: perms.revision,
            cdm: 1,
            engine: 'pm-steps/1',
            retired: [],
            claimed: [],
          },
        ],
      });
      if (res.status !== 'ok') throw new Error(`append refused: ${res.status}`);
    }
  }

  /** The head of a document as the database holds it. */
  async function headOf(h: Harness, d: string): Promise<AnchoredHead> {
    const r = await h.db!.admin.query<{ incarnation: string; head_seq: string; chain: string }>(
      `SELECT incarnation, head_seq, encode(chain_head, 'hex') AS chain FROM doc_heads WHERE doc_id = $1`,
      [d],
    );
    const row = r.rows[0]!;
    return {
      doc: d,
      incarnation: row.incarnation,
      seq: Number(row.head_seq),
      chainHead: row.chain,
    };
  }

  describe('through the composed service and its scheduler', () => {
    let h: Harness;
    const files = new MemoryHeadAnchorFiles();
    const logged: LogFields[] = [];
    const clients: DepClient[] = [];
    let work: string;
    let a: string;
    let b: string;
    let empty: string;
    let first: { to: string; file: HeadAnchorFile };

    beforeAll(async () => {
      h = await startHarness('postgres', {
        realDataPlane: true,
        config: { jobIdleMs: 50 },
        parts: { headAnchorFiles: files },
        headAnchoring: { signing: signingClient(), retainMs: 365 * DAY },
        logger: {
          info() {},
          warn() {},
          error: (f) => {
            logged.push(f);
          },
        },
      });
      work = mkdtempSync(join(tmpdir(), 'docedit-his036-pg-'));
    }, 120_000);

    afterAll(async () => {
      for (const c of clients.splice(0)) c.terminate();
      await h?.close();
      if (work) rmSync(work, { recursive: true, force: true });
    }, 60_000);

    const finished = async () =>
      (
        await h.db!.admin.query<{ result: { failures: number; count: number } }>(
          `SELECT result FROM jobs
            WHERE kind = 'schedule' AND payload->>'task' = 'heads.anchor' AND state = 'completed'
            ORDER BY finished_at`,
        )
      ).rows.map((x) => x.result);

    /** Moves the clock an hour and waits until the scheduler has run `heads.anchor` once more. */
    async function nextHour(): Promise<{ failures: number; count: number }> {
      const before = (await finished()).length;
      h.advance(HOUR);
      await h.call('GET', '/healthz');
      const end = Date.now() + 60_000;
      for (;;) {
        const done = await finished();
        if (done.length > before) return done[done.length - 1]!;
        if (Date.now() > end) throw new Error('the scheduler did not run heads.anchor in time');
        await new Promise((r) => setTimeout(r, 100));
      }
    }

    const recordKeys = () => files.keys().filter((k) => !k.endsWith('.leaves.json'));
    const fileAt = async (key: string): Promise<HeadAnchorFile> =>
      JSON.parse(new TextDecoder().decode((await files.get(key))!)) as HeadAnchorFile;

    it('writes one signed, time-stamped record for the tenant, with the heads of its changed documents (criteria 1 and 3)', async () => {
      a = await documentWith(h, 'A', 5);
      b = await documentWith(h, 'B', 3);
      empty = await documentWith(h, 'No commits', 0);
      const stamps = tsa.count();

      const run = await nextHour();
      expect(run).toMatchObject({ failures: 0, count: 1 });

      // One record and its leaf list, under the tenant's prefix.
      const keys = recordKeys();
      expect(keys).toHaveLength(1);
      expect(keys[0]).toMatch(
        new RegExp(`^tenants/${h.tenant}/anchors/heads/\\d{8}T\\d{6}\\.\\d{3}Z\\.json$`),
      );
      const file = await fileAt(keys[0]!);
      const parsed = parseHeadAnchorRecord(file.record);
      if (!parsed.ok) throw new Error(parsed.reason);
      const record = parsed.record;
      first = { to: record.to, file };
      expect(keys[0]).toBe(objectKeys.headAnchor(h.tenant, record.to));
      // The record: the tenant, the batch (its root and count), and the time.
      expect(record).toMatchObject({ tenant: h.tenant, from: null, previous: null, leaves: 2 });
      expect(Math.abs(Date.parse(record.to) - h.now())).toBeLessThan(60_000);
      expect(file.recordSha256).toBe(sha256Hex(file.record));

      // The leaf list: for each document the seq, the incarnation and the head hash, as the
      // database holds them. A document without a commit has no head and no leaf.
      const list = await parseLeafList(
        new TextDecoder().decode(
          (await files.get(objectKeys.headAnchorLeaves(h.tenant, record.to)))!,
        ),
      );
      if (!list.ok) throw new Error(list.reason);
      expect(list.tree.root).toBe(record.root);
      const heads = [await headOf(h, a), await headOf(h, b)].sort((x, y) =>
        x.doc < y.doc ? -1 : 1,
      );
      expect(heads.map((x) => x.seq).sort()).toEqual([3, 5]);
      expect(
        list.tree.leaves.map((l) => ({
          doc: l.doc,
          incarnation: l.incarnation,
          seq: l.seq,
          chainHead: l.chainHead,
        })),
      ).toEqual(heads);
      expect(list.tree.leaves.some((l) => l.doc === empty)).toBe(false);

      // The signature: checked by the relying party's verifier and by OpenSSL, against the root.
      const cms = new Uint8Array(Buffer.from(file.cms, 'base64'));
      const bytes = new TextEncoder().encode(file.record);
      expect(await verifyBatchAnchorFile(file, [pki.root])).toMatchObject({
        ok: true,
        problems: [],
      });
      const openssl = verifyDetached(cms, bytes, pki);
      expect(openssl.main.ok, openssl.main.detail).toBe(true);
      // The time-stamp: one answer of the configured authority, an RFC 3161 token over the
      // signature value, verified by OpenSSL; the file's time is the token's.
      expect(tsa.count()).toBe(stamps + 1);
      expect(openssl.timestamp?.ok, openssl.timestamp?.detail).toBe(true);
      const parts = cmsParts(cms);
      const info = timestampInfo(parts.token!);
      expect(Buffer.from(info.imprint).toString('hex')).toBe(
        createHash('sha256').update(parts.signatureValue).digest('hex'),
      );
      expect(info.genTime.toISOString()).toBe(file.timestampTime);
      expect(Math.abs(info.genTime.getTime() - Date.now())).toBeLessThan(60_000);

      // What the database holds: the record as stored, and the head each document's record covers.
      const rows = await h.db!.admin.query<{ state: string; leaves: number; root: string }>(
        `SELECT state, leaves, encode(root, 'hex') AS root FROM head_anchors WHERE tenant_id = $1`,
        [h.tenant],
      );
      expect(rows.rows).toEqual([{ state: 'stored', leaves: 2, root: record.root }]);
      const covered = await h.db!.admin.query<{ doc_id: string; seq: string }>(
        'SELECT doc_id, seq FROM anchored_heads WHERE tenant_id = $1 ORDER BY doc_id',
        [h.tenant],
      );
      expect(covered.rows).toEqual(heads.map((x) => ({ doc_id: x.doc, seq: String(x.seq) })));
      const events = await h.parts.audit!.query(h.tenant, { kind: 'heads.anchored', limit: 10 });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actor: 'system',
        data: { to: record.to, leaves: 2, root: record.root, keyId: 'operator-key' },
      });

      // The signing service was sent a root, and wrote its request down before it used the key.
      const mine = world.audit.entries.filter((e) => e.batchRoot === record.root);
      expect(mine.map((e) => e.event)).toEqual(['anchor.requested', 'anchor.anchored']);
      expect(mine[0]).toMatchObject({
        tenant: h.tenant,
        documentId: null,
        caller: 'document-service',
      });
      expect(JSON.stringify(mine)).not.toContain(a);
    }, 180_000);

    it('writes no record in an hour without a change, and asks for no signature', async () => {
      const stamps = tsa.count();
      const run = await nextHour();
      expect(run).toMatchObject({ failures: 0, count: 0 });
      expect(recordKeys()).toHaveLength(1);
      expect(tsa.count()).toBe(stamps);
    }, 120_000);

    it('raises an alert when a run fails, does not block editing, and covers the missed heads at the next run that works (criterion 5)', async () => {
      // The authority stops answering. A person goes on editing document A meanwhile.
      authorityDown = true;
      const owner = h.userToken({ [a]: 'owner' }, { sub: 'olga' });
      const client = await DepClient.connect(`${h.base.replace(/^http/, 'ws')}/dep`, {
        origin: 'https://app.example.test',
      });
      clients.push(client);
      expect((await client.hello(owner)).t).toBe('welcome');
      expect((await client.open(1, a)).t).toBe('ch.opened');
      const one = await client.submit(1, { base: 5, steps: [insertText(pos, 'K')] });
      expect(one.t, JSON.stringify(one.d)).toBe('sync.ack');

      const failuresBefore =
        h.service.metrics.value('docedit_head_anchor_failures_total', {
          stage: 'sign',
          code: 'tsa_unreachable',
          retryable: 'true',
        }) ?? 0;
      const failed = await nextHour();
      expect(failed.failures).toBe(1);
      // The alert: an error line, a counter and an audit entry. No record was written.
      expect(
        logged.some(
          (f) =>
            f['event'] === 'heads.anchor.failed' &&
            String(f['message']).includes('tsa_unreachable'),
        ),
      ).toBe(true);
      expect(
        h.service.metrics.value('docedit_head_anchor_failures_total', {
          stage: 'sign',
          code: 'tsa_unreachable',
          retryable: 'true',
        }),
      ).toBe(failuresBefore + 1);
      const alerts = await h.parts.audit!.query(h.tenant, {
        kind: 'heads.anchor_failed',
        limit: 10,
      });
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toMatchObject({
        data: { stage: 'sign', code: 'tsa_unreachable', retryable: true },
      });
      expect(recordKeys()).toHaveLength(1);
      expect((await headOf(h, a)).seq).toBe(6);

      // A second hour without the authority: editing goes on, in both documents.
      const two = await client.submit(1, { base: 6, steps: [insertText(pos, 'L')] });
      expect(two.t, JSON.stringify(two.d)).toBe('sync.ack');
      client.close();
      await type(h, b, 1);
      expect((await nextHour()).failures).toBe(1);
      expect(recordKeys()).toHaveLength(1);
      // Nothing counts as anchored for those hours.
      const covered = await h.db!.admin.query<{ seq: string }>(
        'SELECT seq FROM anchored_heads WHERE doc_id = $1',
        [a],
      );
      expect(covered.rows).toEqual([{ seq: '5' }]);

      // The authority answers again: the next run covers both documents at their heads of now, and
      // its record follows the last one that worked.
      authorityDown = false;
      const ok = await nextHour();
      expect(ok).toMatchObject({ failures: 0, count: 1 });
      const keys = recordKeys();
      expect(keys).toHaveLength(2);
      const file = await fileAt(keys[1]!);
      const parsed = parseHeadAnchorRecord(file.record);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.record).toMatchObject({
        from: first.to,
        previous: sha256Hex(first.file.record),
        leaves: 2,
      });
      const list = await parseLeafList(
        new TextDecoder().decode(
          (await files.get(objectKeys.headAnchorLeaves(h.tenant, parsed.record.to)))!,
        ),
      );
      if (!list.ok) throw new Error(list.reason);
      const heads = [await headOf(h, a), await headOf(h, b)].sort((x, y) =>
        x.doc < y.doc ? -1 : 1,
      );
      expect(heads.map((x) => x.seq).sort()).toEqual([4, 7]);
      expect(
        list.tree.leaves.map((l) => ({
          doc: l.doc,
          incarnation: l.incarnation,
          seq: l.seq,
          chainHead: l.chainHead,
        })),
      ).toEqual(heads);
      expect(await verifyBatchAnchorFile(file, [pki.root])).toMatchObject({ ok: true });
    }, 240_000);

    it('lets the verification tool validate the record and compare a head with the chain of its log (criterion 6)', async () => {
      const keys = recordKeys();
      const file = await fileAt(keys[1]!);
      const parsed = parseHeadAnchorRecord(file.record);
      if (!parsed.ok) throw new Error(parsed.reason);
      const write = (name: string, value: unknown): string => {
        const path = join(work, name);
        writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
        return path;
      };
      const anchorFile = write('anchor.json', file);
      const previousFile = write('previous.json', first.file);
      const rootFile = join(work, 'root.der');
      writeFileSync(rootFile, pki.root);
      const leavesFile = write(
        'leaves.json',
        new TextDecoder().decode(
          (await files.get(objectKeys.headAnchorLeaves(h.tenant, parsed.record.to)))!,
        ),
      );
      // The log of document A as the service exports its chain: the rows with their hashes.
      const logs = h.parts.logs as PgLogStore;
      const bundleA = write('a.json', await logs.chainRange({ tenant: h.tenant, doc: a }, 1, 7));
      const bundleB = write('b.json', await logs.chainRange({ tenant: h.tenant, doc: b }, 1, 4));

      const run = await runTool([
        anchorFile,
        '--root',
        rootFile,
        '--leaves',
        leavesFile,
        '--doc',
        a,
        '--bundle',
        bundleA,
        '--previous',
        previousFile,
      ]);
      expect(run.report['problems'], JSON.stringify(run.report)).toEqual([]);
      expect(run.code).toBe(0);
      expect(run.report).toMatchObject({
        status: 'verified',
        covered: true,
        headMatchesChain: true,
        previousMatches: true,
        signature: { ok: true },
        chain: { status: 'intact', head: 7, commits: 7 },
      });
      expect((run.report['proof'] as { head: AnchoredHead }).head).toEqual(await headOf(h, a));

      // The head of A against the log of B: the tool says that it is another document's log.
      const wrong = await runTool([
        anchorFile,
        '--root',
        rootFile,
        '--leaves',
        leavesFile,
        '--doc',
        a,
        '--bundle',
        bundleB,
      ]);
      expect(wrong.code).toBe(1);
      expect(wrong.report).toMatchObject({ status: 'failed', headMatchesChain: false });

      // The first record covered A at seq 5; the log has moved on, and the record still verifies
      // against it: the head it names is the hash of the log at 5.
      const firstLeaves = write(
        'first-leaves.json',
        new TextDecoder().decode(
          (await files.get(objectKeys.headAnchorLeaves(h.tenant, first.to)))!,
        ),
      );
      const older = await runTool([
        previousFile,
        '--root',
        rootFile,
        '--leaves',
        firstLeaves,
        '--doc',
        a,
        '--bundle',
        bundleA,
      ]);
      expect(older.code, JSON.stringify(older.report)).toBe(0);
      expect((older.report['proof'] as { head: AnchoredHead }).head.seq).toBe(5);
    }, 180_000);

    it('gives the service role no way to change a record or delete one, and the purge removes a document from the covered heads', async () => {
      for (const sql of [
        "UPDATE head_anchors SET record = 'x'",
        "UPDATE head_anchors SET root = '\\x00'",
        'DELETE FROM head_anchors',
        'DELETE FROM anchored_heads',
      ])
        await expect(h.db!.service.query(sql), sql).rejects.toMatchObject({ code: '42501' });
      // The purge role may delete the row that names a document, and no record.
      const c = await h.db!.admin.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE docedit_purge');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [h.tenant]);
        await expect(c.query('DELETE FROM head_anchors')).rejects.toThrow(/permission denied/);
        await c.query('ROLLBACK');
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE docedit_purge');
        await c.query("SELECT set_config('docedit.tenant_id', $1, true)", [h.tenant]);
        const gone = await c.query('DELETE FROM anchored_heads WHERE doc_id = $1', [b]);
        expect(gone.rowCount).toBe(1);
        await c.query('ROLLBACK');
      } finally {
        await c.query('ROLLBACK').catch(() => {});
        c.release();
      }
    });
  });

  describe('in a bucket with Object Lock (criteria 1 and 4)', () => {
    let h: Harness;
    const bucket = `docedit-his036-w7-${randomUUID().slice(0, 8)}`;
    const lock = new S3ObjectStore({ ...s3Base, bucket });
    const RETAIN_MS = 8_000;
    const written: string[] = [];
    let latest = 0;

    beforeAll(async () => {
      h = await startHarness('postgres', {});
      await lock.createBucket({ objectLock: true });
    }, 120_000);

    afterAll(async () => {
      // The objects can be removed only once their retention has ended; wait for that, then remove
      // the bucket.
      const wait = latest + RETAIN_MS - Date.now() + 1_000;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      for (const key of written) await lock.delete(key).catch(() => undefined);
      await lock.deleteBucket().catch(() => undefined);
      await h?.close();
    }, 120_000);

    it('writes the record and its leaf list to write-once storage, where they cannot be deleted or overwritten before the retention ends', async () => {
      const d = await documentWith(h, 'Locked', 2);
      const anchoring = new HeadAnchoring({
        store: new PgHeadAnchorStore(h.db!.service),
        signing: signingClient(),
        files: new ObjectHeadAnchorFiles(lock),
        audit: h.parts.audit!,
        retainMs: RETAIN_MS,
        now: () => Date.now(),
      });
      // The scheduled task runs through the scheduler's own handler, at the machine's time.
      latest = Date.now();
      const task = headAnchoringTask(anchoring);
      const scheduler = new Scheduler({
        queue: { enqueue: async () => undefined } as unknown as JobQueue,
        tasks: [task],
        tenants: async () => [h.tenant],
        now: () => latest,
      });
      const result = (await scheduler.handler(
        {
          payload: { task: task.name, slot: Math.floor(latest / task.everyMs) },
        } as unknown as Parameters<Scheduler['handler']>[0],
        {} as unknown as Parameters<Scheduler['handler']>[1],
      )) as { failures: number; count: number };
      expect(result).toMatchObject({ failures: 0, count: 1 });
      const stored0 = await new PgHeadAnchorStore(h.db!.service).latest(h.tenant);
      if (!stored0) throw new Error('no record');
      const run = { to: stored0.to, root: stored0.root };
      const key = objectKeys.headAnchor(h.tenant, run.to);
      const leavesKey = objectKeys.headAnchorLeaves(h.tenant, run.to);
      written.push(key, leavesKey);

      // Both objects are in the bucket, and the record is the signed one.
      const stored = await lock.get(key);
      expect(stored).not.toBeNull();
      const file = JSON.parse(new TextDecoder().decode(stored!)) as HeadAnchorFile;
      expect(await verifyBatchAnchorFile(file, [pki.root])).toMatchObject({ ok: true });
      const parsed = parseHeadAnchorRecord(file.record);
      if (!parsed.ok) throw new Error(parsed.reason);
      expect(parsed.record).toMatchObject({ tenant: h.tenant, leaves: 1, root: run.root });
      const list = await parseLeafList(new TextDecoder().decode((await lock.get(leavesKey))!));
      if (!list.ok) throw new Error(list.reason);
      expect(list.tree.leaves.map((l) => [l.doc, l.seq])).toEqual([[d, 2]]);
      expect(list.tree.leaves[0]).toMatchObject(await headOf(h, d));

      // Neither can be deleted or overwritten while it is retained, with the store's own (root)
      // credentials.
      for (const k of [key, leavesKey]) {
        const del = await lock.delete(k).catch((e: unknown) => e);
        expect((del as { status?: number }).status, k).toBe(403);
        const put = await lock.put(k, new TextEncoder().encode('{}')).catch((e: unknown) => e);
        expect((put as { status?: number }).status, k).toBe(403);
      }
      expect(await lock.get(key)).toEqual(stored);

      // The job itself never writes over a record: the same bytes are accepted as already there,
      // other bytes are refused before any request to overwrite is sent.
      const files = new ObjectHeadAnchorFiles(lock);
      expect(await files.put(key, stored!, Date.now() + RETAIN_MS)).toBe('existing');
      await expect(
        files.put(key, new TextEncoder().encode('{"other":true}'), Date.now() + RETAIN_MS),
      ).rejects.toBeInstanceOf(AnchorFileConflictError);

      const row = await h.db!.admin.query<{ state: string; object_key: string }>(
        'SELECT state, object_key FROM head_anchors WHERE tenant_id = $1',
        [h.tenant],
      );
      expect(row.rows).toEqual([{ state: 'stored', object_key: key }]);
    }, 120_000);
  });
});
