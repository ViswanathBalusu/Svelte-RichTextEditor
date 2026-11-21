/**
 * HIS-036 at the signing service: the hourly batch of a tenant's chain heads is signed and
 * time-stamped (`anchorBatch`, `POST /v1/anchor-batch`), and a relying party checks it.
 *
 * The signature and the RFC 3161 token are checked twice: by the OpenSSL command line, which is not
 * the code that made them (`verifyDetached`), and by the verifier a relying party runs
 * (`verifyBatchAnchorFile`, and the command line `scripts/verify-anchor.ts` as a child process with
 * a head, its inclusion path and an exported log). The time-stamp authority is the local OpenSSL
 * one of the test support (owner decision 223); the key is in this process, so these tests show the
 * rules and the checks, not where the key is kept (see his-036-key-service.podman.test.ts).
 */
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { LogBundle } from '../../../packages/history/src/chain.ts';
import {
  anchorPath,
  anchorTree,
  headAnchorRecordText,
  leafListText,
  type AnchoredHead,
} from '../../../packages/history/src/head-anchor.ts';
import { bundleOf } from '../../../packages/history/test/bundle.ts';
import { LogBuilder, typeAt } from '../../../packages/history/test/fixtures.ts';
import { createSigningServer } from '../src/http.ts';
import { HttpTimestampAuthority, timestampInfo } from '../src/cms.ts';
import { batchAnchorRecordText, type BatchAnchorCommand } from '../src/service.ts';
import { verifyBatchAnchorFile } from '../src/verify-sealed.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import {
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  sha256Hex,
  WORKER_SECRET,
  type World,
} from './support/service-world.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { cmsParts, verifyDetached } from './support/verify.ts';
import { flipByte, InProcessKeyService } from './support/world.ts';

const TENANT = '22222222-2222-4222-8222-222222222222';
const ROOT = 'ab'.repeat(32);
const cmd = (over: Partial<BatchAnchorCommand> = {}): BatchAnchorCommand => ({
  tenant: TENANT,
  from: null,
  to: '2026-11-21T01:00:00.000Z',
  root: ROOT,
  leaves: 3,
  previous: null,
  ...over,
});

const TOOL = fileURLToPath(new URL('../scripts/verify-anchor.ts', import.meta.url));

interface ToolRun {
  code: number;
  report: Record<string, unknown>;
}

function runTool(args: string[]): Promise<ToolRun> {
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

describe.skipIf(!opensslAvailable())(
  'the signed, time-stamped batch of chain heads (HIS-036)',
  () => {
    let pki: TestPki;
    let otherPki: TestPki;
    let tsa: TestTsa;
    let ks: InProcessKeyService;
    let world: World;
    let down = false;
    let work: string;
    const credential = DOCUMENT_SERVICE_SECRET;

    beforeAll(async () => {
      ks = new InProcessKeyService();
      pki = makePki(await ks.publicKey());
      otherPki = makePki(await new InProcessKeyService().publicKey());
      tsa = await startTestTsa(pki);
      const inner = new HttpTimestampAuthority(tsa.url);
      world = makeWorld({
        operator: { id: 'operator-key', keyService: ks, pki },
        tsaUrl: tsa.url,
        timestamps: {
          stamp: (d) => (down ? Promise.reject(new Error('authority down')) : inner.stamp(d)),
        },
      });
      work = mkdtempSync(join(tmpdir(), 'docedit-his036-'));
    }, 120_000);
    afterAll(async () => {
      await tsa?.stop();
      pki?.remove();
      otherPki?.remove();
      if (work) rmSync(work, { recursive: true, force: true });
    });

    it('signs a record that names the tenant, the period, the root and the count, and OpenSSL accepts signature and token', async () => {
      down = false;
      const before = tsa.count();
      const out = await world.service.anchorBatch(credential, cmd());
      if (!out.ok) throw new Error(out.code);
      expect(JSON.parse(out.record)).toEqual({
        format: 'docedit-anchor/1',
        from: null,
        leaves: 3,
        previous: null,
        root: ROOT,
        tenant: TENANT,
        to: '2026-11-21T01:00:00.000Z',
      });
      // The same text the document service and a verifier build from the members.
      expect(out.record).toBe(batchAnchorRecordText(cmd()));
      const fromHistory = headAnchorRecordText(cmd());
      expect(fromHistory).toEqual({ ok: true, text: out.record });
      const bytes = new TextEncoder().encode(out.record);
      expect(out.recordSha256).toBe(sha256Hex(bytes));

      // An independent check: the OpenSSL command line verifies the signature and the token.
      const report = verifyDetached(out.cms, bytes, pki);
      expect(report.main.ok, report.main.detail).toBe(true);
      expect(report.timestamp?.ok, report.timestamp?.detail).toBe(true);
      // The token is an RFC 3161 token from the configured authority: one more answer of the
      // authority, its imprint is the SHA-256 of the signature value, and its time is the authority's.
      expect(tsa.count()).toBe(before + 1);
      const parts = cmsParts(out.cms);
      expect(parts.token).not.toBeNull();
      const info = timestampInfo(parts.token!);
      expect(Buffer.from(info.imprint).toString('hex')).toBe(
        createHash('sha256').update(parts.signatureValue).digest('hex'),
      );
      expect(info.policy).toBe('2.999.1');
      expect(info.genTime.getTime()).toBe(out.timestampTime.getTime());
      expect(Math.abs(out.timestampTime.getTime() - Date.now())).toBeLessThan(60_000);
    }, 60_000);

    it('is checked by the relying party verifier, which trusts only the roots it is given', async () => {
      down = false;
      const out = await world.service.anchorBatch(
        credential,
        cmd({ to: '2026-11-21T02:00:00.000Z' }),
      );
      if (!out.ok) throw new Error(out.code);
      const file = {
        record: out.record,
        recordSha256: out.recordSha256,
        cms: Buffer.from(out.cms).toString('base64'),
      };
      const good = await verifyBatchAnchorFile(file, [pki.root]);
      expect(good.problems).toEqual([]);
      expect(good.ok).toBe(true);
      expect(good.record).toEqual({
        tenant: TENANT,
        from: null,
        to: '2026-11-21T02:00:00.000Z',
        root: ROOT,
        leaves: 3,
        previous: null,
      });
      expect(good.timestampTime).toBe(out.timestampTime.toISOString());

      // Another root: neither the signer nor the authority chains to it.
      expect((await verifyBatchAnchorFile(file, [otherPki.root])).ok).toBe(false);
      // A changed record (another root), with its stated hash changed to fit.
      const other = batchAnchorRecordText(
        cmd({ to: '2026-11-21T02:00:00.000Z', root: 'cd'.repeat(32) }),
      )!;
      const forged = await verifyBatchAnchorFile(
        { ...file, record: other, recordSha256: sha256Hex(new TextEncoder().encode(other)) },
        [pki.root],
      );
      expect(forged.ok).toBe(false);
      expect(forged.problems.join(' ')).toMatch(/signature/);
      // A changed record whose stated hash was left.
      expect((await verifyBatchAnchorFile({ ...file, record: other }, [pki.root])).ok).toBe(false);
      // One byte of the signature value, and one byte of the time-stamp token.
      const at = Buffer.from(out.cms).indexOf(Buffer.from(cmsParts(out.cms).signatureValue));
      const brokenSignature = Buffer.from(flipByte(out.cms, at + 5)).toString('base64');
      expect((await verifyBatchAnchorFile({ ...file, cms: brokenSignature }, [pki.root])).ok).toBe(
        false,
      );
      const token = cmsParts(out.cms).token!;
      const tokenAt = Buffer.from(out.cms).indexOf(Buffer.from(token.subarray(token.length - 40)));
      expect(tokenAt).toBeGreaterThan(0);
      const brokenToken = Buffer.from(flipByte(out.cms, tokenAt + 20)).toString('base64');
      const tokenReport = await verifyBatchAnchorFile({ ...file, cms: brokenToken }, [pki.root]);
      expect(tokenReport.ok).toBe(false);
      // A file that is not an anchor file, and a record of another format.
      expect((await verifyBatchAnchorFile({} as never, [pki.root])).ok).toBe(false);
      expect(
        (await verifyBatchAnchorFile({ ...file, record: '{"format":"other"}' }, [pki.root])).ok,
      ).toBe(false);
    }, 60_000);

    it('refuses no credential, an unknown one and the export worker; a request that is not well formed; and another root for the same tenant and time', async () => {
      down = false;
      const anchored = () =>
        world.audit.entries.filter((e) => e.event === 'anchor.anchored').length;
      const before = anchored();
      const c = cmd({ to: '2026-11-21T03:00:00.000Z' });
      expect(await world.service.anchorBatch(null, c)).toMatchObject({ code: 'unauthenticated' });
      expect(await world.service.anchorBatch('nope', c)).toMatchObject({ code: 'unauthenticated' });
      expect(await world.service.anchorBatch(WORKER_SECRET, c)).toMatchObject({
        code: 'wrong_caller',
      });
      for (const bad of [
        { ...c, root: 'xyz' },
        { ...c, leaves: 0 },
        { ...c, to: 'yesterday' },
        { ...c, from: c.to, previous: 'cd'.repeat(32) },
        { ...c, previous: 'cd'.repeat(32) },
        { ...c, from: '2026-11-21T02:00:00.000Z' },
        { ...c, tenant: '' },
      ])
        expect(await world.service.anchorBatch(credential, bad), JSON.stringify(bad)).toMatchObject(
          {
            code: 'bad_request',
          },
        );
      expect(anchored()).toBe(before);
      // The same record again is signed again; another record for the same tenant and time is not.
      expect((await world.service.anchorBatch(credential, c)).ok).toBe(true);
      expect((await world.service.anchorBatch(credential, c)).ok).toBe(true);
      expect(
        await world.service.anchorBatch(credential, { ...c, root: 'cd'.repeat(32) }),
      ).toMatchObject({ code: 'binding_conflict' });
    }, 60_000);

    it('gives no record without a time-stamp token, and writes the request before the key is used', async () => {
      down = true;
      const c = cmd({ to: '2026-11-21T04:00:00.000Z', root: 'ef'.repeat(32) });
      expect(await world.service.anchorBatch(credential, c)).toEqual({
        ok: false,
        code: 'tsa_unreachable',
        retryable: true,
      });
      down = false;
      expect((await world.service.anchorBatch(credential, c)).ok).toBe(true);
      const mine = world.audit.entries.filter((e) => e.batchRoot === 'ef'.repeat(32));
      expect(mine.map((e) => e.event)).toEqual([
        'anchor.requested',
        'anchor.failed',
        'anchor.requested',
        'anchor.anchored',
      ]);
      expect(mine[0]).toMatchObject({
        caller: 'document-service',
        tenant: TENANT,
        keyId: 'operator-key',
        documentId: null,
        seq: null,
      });
      // The entries hold a tenant, a root, a key name and codes: no head, no secret, no key.
      const text = JSON.stringify(mine);
      expect(text).not.toContain(DOCUMENT_SERVICE_SECRET);
      expect(text).not.toContain('PRIVATE');
    }, 60_000);

    it('is served at POST /v1/anchor-batch with the same refusals', async () => {
      down = false;
      const server = createSigningServer(world.service, { maxBodyBytes: 100_000 });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      const url = `http://127.0.0.1:${addr.port}/v1/anchor-batch`;
      const post = (secret: string | null, body: unknown) =>
        fetch(url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...(secret ? { authorization: `Bearer ${secret}` } : {}),
          },
          body: JSON.stringify(body),
        });
      try {
        const c = cmd({ to: '2026-11-21T05:00:00.000Z' });
        expect((await post(null, c)).status).toBe(401);
        expect((await post(WORKER_SECRET, c)).status).toBe(403);
        expect((await post(credential, { nonsense: true })).status).toBe(400);
        expect((await post(credential, { ...c, leaves: '3' })).status).toBe(400);
        const ok = await post(credential, c);
        expect(ok.status).toBe(200);
        const wire = (await ok.json()) as {
          ok: boolean;
          record: string;
          recordSha256: string;
          cms: string;
          timestampTime: string;
          keyId: string;
        };
        expect(wire.ok).toBe(true);
        expect(wire.record).toBe(batchAnchorRecordText(c));
        expect(wire.keyId).toBe('operator-key');
        expect((await verifyBatchAnchorFile(wire, [pki.root])).ok).toBe(true);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    }, 60_000);

    describe('the verification tool (criterion 6)', () => {
      const INCARNATION = '11111111-1111-4111-8111-111111111111';
      let bundle: LogBundle;
      let heads: AnchoredHead[];
      let anchorFile: string;
      let rootFile: string;
      let leavesFile: string;
      let proofFile: string;
      let bundleFile: string;
      let firstRecord: string;

      const write = (name: string, value: unknown): string => {
        const path = join(work, name);
        writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
        return path;
      };

      beforeAll(async () => {
        down = false;
        // A real log of six commits with its hash chain, and two other documents' heads beside it.
        const b = new LogBuilder();
        for (let i = 1; i <= 6; i++)
          b.add((d) => typeAt(d, 'pIntro0000000001', 0, `word ${i} `), {
            user: 'bob',
            time: Date.UTC(2026, 10, 20, 10, i),
          });
        bundle = await bundleOf(b.log, [{ seq: 0, doc: b.docs[0]! }]);
        const head = bundle.commits[bundle.commits.length - 1]!;
        heads = [
          { doc: bundle.doc, incarnation: INCARNATION, seq: head.meta.seq, chainHead: head.hash },
          {
            doc: '00000000-0000-4000-8000-000000000001',
            incarnation: INCARNATION,
            seq: 4,
            chainHead: '11'.repeat(32),
          },
          {
            doc: 'ffffffff-ffff-4fff-8fff-ffffffffffff',
            incarnation: INCARNATION,
            seq: 9,
            chainHead: '22'.repeat(32),
          },
        ];
        const tree = await anchorTree(heads);
        if (!tree.ok) throw new Error(tree.reason);
        // A first record of the tenant, and the one that follows it and covers the heads.
        const first = await world.service.anchorBatch(
          credential,
          cmd({ to: '2026-11-21T06:00:00.000Z', root: '33'.repeat(32), leaves: 1 }),
        );
        if (!first.ok) throw new Error(first.code);
        firstRecord = first.record;
        const out = await world.service.anchorBatch(credential, {
          tenant: TENANT,
          from: '2026-11-21T06:00:00.000Z',
          to: '2026-11-21T07:00:00.000Z',
          root: tree.root,
          leaves: tree.leaves.length,
          previous: first.recordSha256,
        });
        if (!out.ok) throw new Error(out.code);
        const fileOf = (o: typeof out) => ({
          format: 'docedit-anchor-file/1',
          record: o.record,
          recordSha256: o.recordSha256,
          cms: Buffer.from(o.cms).toString('base64'),
          timestampTime: o.timestampTime.toISOString(),
          keyId: o.keyId,
        });
        anchorFile = write('anchor.json', fileOf(out));
        write('previous.json', fileOf(first));
        rootFile = join(work, 'root.der');
        writeFileSync(rootFile, pki.root);
        leavesFile = write('leaves.json', leafListText(tree));
        const path = await anchorPath(tree, bundle.doc);
        if (!path.ok) throw new Error(path.reason);
        proofFile = write('proof.json', { head: path.head, path: path.path });
        bundleFile = write('bundle.json', bundle);
      }, 120_000);

      it('validates the signature and the time-stamp, follows the path to the root and compares the head with the chain', async () => {
        const run = await runTool([
          anchorFile,
          '--root',
          rootFile,
          '--proof',
          proofFile,
          '--bundle',
          bundleFile,
          '--previous',
          join(work, 'previous.json'),
        ]);
        expect(run.report['problems']).toEqual([]);
        expect(run.code).toBe(0);
        expect(run.report).toMatchObject({
          status: 'verified',
          covered: true,
          headMatchesChain: true,
          previousMatches: true,
          signature: { ok: true, problems: [] },
          chain: { status: 'intact', head: 6, commits: 6 },
          record: { tenant: TENANT, leaves: 3, from: '2026-11-21T06:00:00.000Z' },
        });
        expect(typeof (run.report['signature'] as { timestampTime: unknown }).timestampTime).toBe(
          'string',
        );
        // No text of the document is in the report.
        expect(JSON.stringify(run.report)).not.toContain('word ');
      }, 120_000);

      it('computes the path from the leaf list for an operator, with the same verdict', async () => {
        const run = await runTool([
          anchorFile,
          '--root',
          rootFile,
          '--leaves',
          leavesFile,
          '--doc',
          bundle.doc,
          '--bundle',
          bundleFile,
        ]);
        expect(run.code, JSON.stringify(run.report)).toBe(0);
        expect(run.report).toMatchObject({
          status: 'verified',
          covered: true,
          headMatchesChain: true,
        });
        expect((run.report['proof'] as { head: AnchoredHead }).head).toEqual(heads[0]);
      }, 120_000);

      it('fails when the head is not the hash of the log, when the log was altered, and when the path is of another head', async () => {
        // The head the record covers, against a log whose record 6 was altered.
        const altered: LogBundle = structuredClone(bundle);
        altered.commits[5]!.meta.user = 'mallory';
        const alteredFile = write('altered.json', altered);
        const a = await runTool([
          anchorFile,
          '--root',
          rootFile,
          '--proof',
          proofFile,
          '--bundle',
          alteredFile,
        ]);
        expect(a.code).toBe(1);
        expect(a.report).toMatchObject({ status: 'failed', covered: true });
        expect((a.report['problems'] as string[]).join(' ')).toMatch(/log does not verify/);

        // A proof that claims another seq for the document: it does not lead to the root.
        const proof = { head: { ...heads[0]!, seq: 5 }, path: [] as unknown[] };
        const real = JSON.parse(readFileSync(proofFile, 'utf8')) as { path: unknown[] };
        proof.path = real.path;
        const wrongFile = write('wrong-proof.json', proof);
        const w = await runTool([
          anchorFile,
          '--root',
          rootFile,
          '--proof',
          wrongFile,
          '--bundle',
          bundleFile,
        ]);
        expect(w.code).toBe(1);
        expect(w.report).toMatchObject({ status: 'failed', covered: false });

        // A log that stops before the anchored seq.
        const short: LogBundle = {
          ...bundle,
          commits: bundle.commits.slice(0, 4),
          head: { seq: 4, chainHead: bundle.commits[3]!.hash },
        };
        const shortFile = write('short.json', short);
        const s = await runTool([
          anchorFile,
          '--root',
          rootFile,
          '--proof',
          proofFile,
          '--bundle',
          shortFile,
        ]);
        expect(s.code).toBe(1);
        expect((s.report['problems'] as string[]).join(' ')).toMatch(/does not reach the seq/);
      }, 180_000);

      it('fails for a root that is not trusted, a changed record and a record that does not follow the one given', async () => {
        const otherRoot = join(work, 'other-root.der');
        writeFileSync(otherRoot, otherPki.root);
        const untrusted = await runTool([
          anchorFile,
          '--root',
          otherRoot,
          '--proof',
          proofFile,
          '--bundle',
          bundleFile,
        ]);
        expect(untrusted.code).toBe(1);
        expect(untrusted.report).toMatchObject({ status: 'failed', signature: { ok: false } });

        const file = JSON.parse(readFileSync(anchorFile, 'utf8')) as {
          record: string;
          recordSha256: string;
        };
        const changedRecord = file.record.replace('"leaves":3', '"leaves":4');
        const changed = write('changed.json', {
          ...file,
          record: changedRecord,
          recordSha256: sha256Hex(new TextEncoder().encode(changedRecord)),
        });
        const c = await runTool([
          changed,
          '--root',
          rootFile,
          '--proof',
          proofFile,
          '--bundle',
          bundleFile,
        ]);
        expect(c.code).toBe(1);
        expect(c.report).toMatchObject({ signature: { ok: false } });

        // The record is given as its own predecessor: it does not name that hash.
        const p = await runTool([
          anchorFile,
          '--root',
          rootFile,
          '--proof',
          proofFile,
          '--bundle',
          bundleFile,
          '--previous',
          anchorFile,
        ]);
        expect(p.code).toBe(1);
        expect(p.report).toMatchObject({ previousMatches: false });
        expect(firstRecord).toContain('"previous":null');
      }, 180_000);

      it('says what it could not compare, and refuses arguments it cannot read', async () => {
        // The signature alone: it holds, and the head was compared with nothing.
        const alone = await runTool([anchorFile, '--root', rootFile]);
        expect(alone.code).toBe(2);
        expect(alone.report).toMatchObject({
          status: 'incomplete',
          signature: { ok: true },
          covered: null,
          headMatchesChain: null,
        });
        // A proof without a log.
        const noLog = await runTool([anchorFile, '--root', rootFile, '--proof', proofFile]);
        expect(noLog.code).toBe(2);
        expect(noLog.report).toMatchObject({ status: 'incomplete', covered: true });

        expect((await runTool([anchorFile])).code).toBe(3);
        expect((await runTool([join(work, 'none.json'), '--root', rootFile])).code).toBe(3);
        expect((await runTool([bundleFile, '--root', rootFile])).code).toBe(3);
        expect((await runTool([anchorFile, '--root', rootFile, '--leaves', leavesFile])).code).toBe(
          3,
        );
        const doc = '99999999-9999-4999-8999-999999999999';
        const absent = await runTool([
          anchorFile,
          '--root',
          rootFile,
          '--leaves',
          leavesFile,
          '--doc',
          doc,
        ]);
        expect(absent.code).toBe(1);
        expect((absent.report['problems'] as string[]).join(' ')).toMatch(/no leaf/);
      }, 180_000);
    });
  },
);
