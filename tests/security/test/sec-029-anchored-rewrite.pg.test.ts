/**
 * SEC-029 criterion 5 (lane w8), with the product writer: signed, time-stamped chain heads are
 * written to write-once storage by `HeadAnchoring` (HIS-036), and a later rewrite of history is
 * checked against them with the verification tool of HIS-036 (`verify-anchor.ts`).
 *
 * The service is the real one on PostgreSQL; the signing service is the real one in process with a
 * test PKI and a test time-stamp authority (OpenSSL); the records go to a bucket with Object Lock of
 * the S3-compatible test store, with a retention of 25 seconds.
 *
 * What it shows, for a document of five commits whose head was anchored:
 * - the log as stored verifies against the anchor (exit 0);
 * - the log rewritten from commit 3, with every link and the head recomputed, is a valid chain by
 *   itself and disagrees with the anchored head (exit 1);
 * - after two more commits that no record covers yet, a rewrite of those two alone matches the
 *   anchor of commit 5 and is not detected (exit 0): this is what an anchor cannot show, and 08 §12
 *   says so; the next record covers them, and the same rewrite then disagrees with it (exit 1).
 *
 * Skipped, with the reason, when PostgreSQL, the object store or OpenSSL is missing. Test values only.
 */
import { execFile } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  chainHash,
  payloadDigest,
  verifyBundle,
  type LogBundle,
} from '../../../packages/history/src/index.ts';
import {
  HeadAnchoring,
  ObjectHeadAnchorFiles,
} from '../../../services/document-service/src/control-plane/head-anchoring.ts';
import { PgHeadAnchorStore } from '../../../services/document-service/src/control-plane/head-anchoring-pg.ts';
import { S3ObjectStore } from '../../../services/document-service/src/objects/s3.ts';
import { objectKeys } from '../../../services/document-service/src/objects/store.ts';
import type { PgLogStore } from '../../../services/document-service/src/storage/log-store.ts';
import type { DocRef } from '../../../services/document-service/src/storage/types.ts';
import { HttpSigningClient } from '../../../services/document-service/src/workflow/signing-client.ts';
import {
  documentWithRegions,
  skipReason,
  startHarness,
  type Harness,
} from '../../../services/document-service/test/control-plane/support.ts';
import { insertText } from '../../../services/document-service/test/data-plane/client.ts';
import { settings } from '../../../services/document-service/test/support/env.ts';
import { HttpTimestampAuthority } from '../../../services/signing-service/src/cms.ts';
import { createSigningServer } from '../../../services/signing-service/src/http.ts';
import {
  makePki,
  opensslAvailable,
  type TestPki,
} from '../../../services/signing-service/test/support/pki.ts';
import {
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
} from '../../../services/signing-service/test/support/service-world.ts';
import { startTestTsa, type TestTsa } from '../../../services/signing-service/test/support/tsa.ts';
import { InProcessKeyService } from '../../../services/signing-service/test/support/world.ts';

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
if (skip) console.warn(`sec-029-anchored-rewrite: skipped: ${skip}`);

const TOOL = fileURLToPath(
  new URL('../../../services/signing-service/scripts/verify-anchor.ts', import.meta.url),
);
const SPEC_08 = fileURLToPath(new URL('../../../docs/spec/08-history.md', import.meta.url));
const RETAIN_MS = 25_000;

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

/** Rewrites the commits `from` to `to` (seqs), recomputing every link after them and the head. */
async function rewrite(b: LogBundle, from: number, to: number): Promise<LogBundle> {
  const out = JSON.parse(JSON.stringify(b)) as LogBundle;
  for (let i = from - 1; i < out.commits.length; i++) {
    const prev: string | null = i === 0 ? null : out.commits[i - 1]!.hash;
    const c = out.commits[i]!;
    // Inside the rewritten range the payload is replaced; after it only the links change.
    const payload =
      c.meta.seq <= to ? { steps: [], retired: [], claimed: [], rewritten: c.meta.seq } : c.payload;
    const { hash: payloadHash, size } = await payloadDigest(payload);
    const meta = { ...c.meta, size };
    const hash = await chainHash(prev, meta, payloadHash);
    out.commits[i] = { meta, payloadHash, prevHash: prev, hash, payload };
  }
  const last = out.commits[out.commits.length - 1]!;
  out.head = { seq: out.commits.length, chainHead: last.hash };
  return out;
}

describe.skipIf(skip !== null)(
  'SEC-029 criterion 5: a rewrite of history against heads anchored by the product writer',
  () => {
    let pki: TestPki;
    let tsa: TestTsa;
    let server: Server;
    let url = '';
    let h: Harness;
    let work: string;
    let pos = -1;
    const bucket = `docedit-sec029-w8-${randomUUID().slice(0, 8)}`;
    const lock = new S3ObjectStore({ ...s3Base, bucket });
    const written: string[] = [];
    let latest = 0;

    beforeAll(async () => {
      const ks = new InProcessKeyService();
      pki = makePki(await ks.publicKey());
      tsa = await startTestTsa(pki);
      const authority = new HttpTimestampAuthority(tsa.url);
      const world = makeWorld({
        operator: { id: 'operator-key', keyService: ks, pki },
        tsaUrl: tsa.url,
        timestamps: { stamp: (d) => authority.stamp(d) },
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
      h = await startHarness('postgres', {});
      await lock.createBucket({ objectLock: true });
      work = mkdtempSync(join(tmpdir(), 'docedit-sec029-w8-'));
    }, 120_000);

    afterAll(async () => {
      // Objects under retention can be removed only once it has ended.
      const wait = latest + RETAIN_MS - Date.now() + 1_000;
      if (written.length > 0 && wait > 0) await new Promise((r) => setTimeout(r, wait));
      for (const key of written) await lock.delete(key).catch(() => undefined);
      await lock.deleteBucket().catch(() => undefined);
      await h?.close();
      await new Promise<void>((r) => (server ? server.close(() => r()) : r()));
      await tsa?.stop();
      pki?.remove();
      if (work) rmSync(work, { recursive: true, force: true });
    }, 120_000);

    async function type(ref: DocRef, count: number): Promise<void> {
      const bob = (await h.parts.users.resolve(h.tenant, 'bob')).surrogate;
      const epoch = await h.parts.ownership.claim(ref, 'test-node');
      for (let i = 0; i < count; i++) {
        const head = await h.parts.logs.head(ref);
        const perms = await h.parts.grants.current(ref);
        const res = await h.parts.logs.append(ref, {
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

    const file = (name: string, value: unknown): string => {
      const path = join(work, name);
      writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
      return path;
    };

    it('detects a rewrite up to an anchored head, and says what it cannot see after the last anchor', async () => {
      const d = await h.createDocument({ content: documentWithRegions(), title: 'Anchored' });
      const ref: DocRef = { tenant: h.tenant, doc: d };
      await type(ref, 5);

      const anchoring = new HeadAnchoring({
        store: new PgHeadAnchorStore(h.db!.service),
        signing: new HttpSigningClient({
          url,
          credential: DOCUMENT_SERVICE_SECRET,
          timeoutMs: 60_000,
        }),
        files: new ObjectHeadAnchorFiles(lock),
        audit: h.parts.audit!,
        retainMs: RETAIN_MS,
        now: () => Date.now(),
      });
      const rootFile = join(work, 'root.der');
      writeFileSync(rootFile, pki.root);

      /** Runs one anchoring and returns the record file and the leaf list as written to the bucket. */
      async function anchorNow(at: number) {
        latest = at;
        const run = await anchoring.run(h.tenant, at);
        if (!run.anchored) throw new Error('nothing was anchored');
        const key = objectKeys.headAnchor(h.tenant, run.to);
        const leavesKey = objectKeys.headAnchorLeaves(h.tenant, run.to);
        written.push(key, leavesKey);
        return {
          anchor: new TextDecoder().decode((await lock.get(key))!),
          leaves: new TextDecoder().decode((await lock.get(leavesKey))!),
        };
      }

      const verifyWith = (n: string, rec: { anchor: string; leaves: string }, bundle: LogBundle) =>
        runTool([
          file(`anchor-${n}.json`, rec.anchor),
          '--root',
          rootFile,
          '--leaves',
          file(`leaves-${n}.json`, rec.leaves),
          '--doc',
          d,
          '--bundle',
          file(`bundle-${n}.json`, bundle),
        ]);

      // The head at seq 5 is anchored, in a bucket with Object Lock.
      const first = await anchorNow(Date.now());
      const logs = h.parts.logs as PgLogStore;
      const stored5 = await logs.chainRange(ref, 1, 5);
      const ok = await verifyWith('1-stored', first, stored5);
      expect(ok.code, JSON.stringify(ok.report)).toBe(0);
      expect(ok.report).toMatchObject({ status: 'verified', headMatchesChain: true });

      // Rewriting commits 3 to 5 and recomputing every link: a valid chain by itself, and not the
      // chain that was anchored.
      const rewritten5 = await rewrite(stored5, 3, 5);
      expect((await verifyBundle(rewritten5)).status).toBe('intact');
      const caught = await verifyWith('1-rewritten', first, rewritten5);
      expect(caught.code, JSON.stringify(caught.report)).toBe(1);
      expect(caught.report).toMatchObject({ status: 'failed', headMatchesChain: false });

      // Two more commits that no record covers. A rewrite of those two alone leaves the head at
      // seq 5 as anchored, so the anchor of seq 5 cannot see it.
      await type(ref, 2);
      const stored7 = await logs.chainRange(ref, 1, 7);
      const rewritten7 = await rewrite(stored7, 6, 7);
      expect((await verifyBundle(rewritten7)).status).toBe('intact');
      const unseen = await verifyWith('1-tail', first, rewritten7);
      expect(unseen.code, JSON.stringify(unseen.report)).toBe(0);
      expect(unseen.report).toMatchObject({ status: 'verified', headMatchesChain: true });

      // The next record covers seq 7; the same rewrite then disagrees with it.
      const second = await anchorNow(Date.now() + 2_000);
      const stillOk = await verifyWith('2-stored', second, stored7);
      expect(stillOk.code, JSON.stringify(stillOk.report)).toBe(0);
      const seen = await verifyWith('2-tail', second, rewritten7);
      expect(seen.code, JSON.stringify(seen.report)).toBe(1);
      expect(seen.report).toMatchObject({ status: 'failed', headMatchesChain: false });
    }, 180_000);

    it('08 section 12 states what an anchor does not show', () => {
      const text = readFileSync(SPEC_08, 'utf8');
      const section = text.slice(text.indexOf('## 12. Tamper evidence'), text.indexOf('## 13.'));
      expect(section).toContain('not detectable');
      expect(section).toContain('the last anchored head');
    });
  },
);
