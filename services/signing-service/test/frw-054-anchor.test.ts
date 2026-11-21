/**
 * FRW-054 criterion 3 at the signing service: the chain head at completion is signed and
 * time-stamped. The signature and the token are checked by the OpenSSL command line, not by the
 * code that made them (`verifyDetached`). The same rules as the seal hold: the document service
 * only, a credential, the rate limit, the audit entry before any key is used, the tenant's key, no
 * answer without a time-stamp token.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSigningServer } from '../src/http.ts';
import type { AuditEntry, AuditSink } from '../src/audit.ts';
import { HttpTimestampAuthority } from '../src/cms.ts';
import { anchorRecordText, type AnchorCommand } from '../src/service.ts';
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

const HEAD = 'ab'.repeat(32);
const cmd = (over: Partial<AnchorCommand> = {}): AnchorCommand => ({
  tenant: 'tenant-a',
  documentId: 'doc-1',
  workflow: 'wf-1',
  seq: 12,
  chainHead: HEAD,
  ...over,
});

describe.skipIf(!opensslAvailable())(
  'the signed, time-stamped chain head (FRW-054 criterion 3)',
  () => {
    let pki: TestPki;
    let tsa: TestTsa;
    let ks: InProcessKeyService;
    let tenantKs: InProcessKeyService;
    let tenantPki: TestPki;
    let world: World;
    let down = false;
    const credential = DOCUMENT_SERVICE_SECRET;

    beforeAll(async () => {
      ks = new InProcessKeyService();
      pki = makePki(await ks.publicKey());
      tenantKs = new InProcessKeyService();
      tenantPki = makePki(await tenantKs.publicKey());
      tsa = await startTestTsa(pki);
      const inner = new HttpTimestampAuthority(tsa.url);
      world = makeWorld({
        operator: { id: 'operator-key', keyService: ks, pki },
        tenants: { 'tenant-own': { id: 'tenant-key', keyService: tenantKs, pki: tenantPki } },
        tsaUrl: tsa.url,
        timestamps: {
          stamp: (d) => (down ? Promise.reject(new Error('authority down')) : inner.stamp(d)),
        },
      });
    }, 120_000);
    afterAll(async () => {
      await tsa?.stop();
      pki?.remove();
      tenantPki?.remove();
    });

    it('signs a record that names the document, workflow, seq and head, and OpenSSL accepts signature and token', async () => {
      down = false;
      const out = await world.service.anchor(credential, cmd());
      if (!out.ok) throw new Error(out.code);
      expect(JSON.parse(out.record)).toEqual({
        chainHead: HEAD,
        document: 'doc-1',
        format: 'docedit-chain-head-anchor/1',
        seq: 12,
        tenant: 'tenant-a',
        workflow: 'wf-1',
      });
      expect(out.record).toBe(anchorRecordText(cmd()));
      const bytes = new TextEncoder().encode(out.record);
      expect(out.recordSha256).toBe(sha256Hex(bytes));
      const report = verifyDetached(out.cms, bytes, pki);
      expect(report.main.ok, report.main.detail).toBe(true);
      expect(report.timestamp?.ok, report.timestamp?.detail).toBe(true);
      // The time is the token's: the local authority's clock, near this machine's.
      expect(Math.abs(out.timestampTime.getTime() - Date.now())).toBeLessThan(60_000);
      expect(out.keyOwner).toBe('operator');
    }, 60_000);

    it('a changed record or a changed signature byte is reported as broken', async () => {
      down = false;
      const out = await world.service.anchor(credential, cmd({ seq: 13 }));
      if (!out.ok) throw new Error(out.code);
      const other = new TextEncoder().encode(
        anchorRecordText(cmd({ seq: 13, chainHead: 'cd'.repeat(32) })),
      );
      expect(verifyDetached(out.cms, other, pki).main.ok).toBe(false);
      const bytes = new TextEncoder().encode(out.record);
      // One byte of the signature value itself.
      const at = Buffer.from(out.cms).indexOf(Buffer.from(cmsParts(out.cms).signatureValue));
      expect(at).toBeGreaterThan(0);
      expect(verifyDetached(flipByte(out.cms, at + 5), bytes, pki).main.ok).toBe(false);
    }, 60_000);

    it("uses the tenant's own key when the tenant has one", async () => {
      down = false;
      const out = await world.service.anchor(credential, cmd({ tenant: 'tenant-own' }));
      if (!out.ok) throw new Error(out.code);
      expect(out.keyOwner).toBe('tenant');
      expect(out.keyId).toBe('tenant-key');
      const bytes = new TextEncoder().encode(out.record);
      expect(verifyDetached(out.cms, bytes, tenantPki).main.ok).toBe(true);
      expect(verifyDetached(out.cms, bytes, pki).main.ok).toBe(false);
    }, 60_000);

    it('refuses no credential, an unknown one, and the export worker with its own valid one; no key is used', async () => {
      const before = world.audit.entries.filter((e) => e.event === 'anchor.anchored').length;
      expect(await world.service.anchor(null, cmd({ documentId: 'd-x' }))).toMatchObject({
        ok: false,
        code: 'unauthenticated',
      });
      expect(await world.service.anchor('nope', cmd({ documentId: 'd-x' }))).toMatchObject({
        code: 'unauthenticated',
      });
      expect(await world.service.anchor(WORKER_SECRET, cmd({ documentId: 'd-x' }))).toMatchObject({
        code: 'wrong_caller',
      });
      expect(world.audit.entries.filter((e) => e.event === 'anchor.anchored').length).toBe(before);
      expect(
        world.audit.entries.filter((e) => e.event === 'anchor.refused').length,
      ).toBeGreaterThanOrEqual(3);
    });

    it('refuses a request that is not well formed and one head bound to another', async () => {
      down = false;
      expect(await world.service.anchor(credential, cmd({ chainHead: 'xyz' }))).toMatchObject({
        code: 'bad_request',
      });
      expect(await world.service.anchor(credential, cmd({ seq: -1 }))).toMatchObject({
        code: 'bad_request',
      });
      expect((await world.service.anchor(credential, cmd({ documentId: 'doc-bind' }))).ok).toBe(
        true,
      );
      // The same head again anchors again; another head for the same document and seq does not.
      expect((await world.service.anchor(credential, cmd({ documentId: 'doc-bind' }))).ok).toBe(
        true,
      );
      expect(
        await world.service.anchor(
          credential,
          cmd({ documentId: 'doc-bind', chainHead: 'cd'.repeat(32) }),
        ),
      ).toMatchObject({ code: 'binding_conflict' });
    });

    it('gives no anchor without a time-stamp token: the authority down is retryable and audited', async () => {
      down = true;
      const out = await world.service.anchor(credential, cmd({ documentId: 'doc-tsa' }));
      expect(out).toEqual({ ok: false, code: 'tsa_unreachable', retryable: true });
      expect(
        world.audit.entries.some(
          (e) =>
            e.event === 'anchor.failed' &&
            e.documentId === 'doc-tsa' &&
            e.code === 'tsa_unreachable',
        ),
      ).toBe(true);
      expect(
        world.audit.entries.some(
          (e) => e.event === 'anchor.anchored' && e.documentId === 'doc-tsa',
        ),
      ).toBe(false);
      down = false;
    });

    it('writes the request before the key is used and holds only identifiers, hashes and codes', async () => {
      down = false;
      await world.service.anchor(credential, cmd({ documentId: 'doc-audit' }));
      const mine = world.audit.entries.filter((e) => e.documentId === 'doc-audit');
      expect(mine.map((e) => e.event)).toEqual(['anchor.requested', 'anchor.anchored']);
      expect(mine[0]).toMatchObject({
        chainHead: HEAD,
        caller: 'document-service',
        keyId: 'operator-key',
      });
      expect(mine[1]!.sealedSha256).toBe(
        sha256Hex(new TextEncoder().encode(anchorRecordText(cmd({ documentId: 'doc-audit' })))),
      );
      const text = JSON.stringify(mine);
      expect(text).not.toContain(DOCUMENT_SERVICE_SECRET);
      expect(text).not.toContain('PRIVATE');
    });

    it('a failing audit sink gives no anchor and no key call', async () => {
      let signed = 0;
      const counting = new InProcessKeyService();
      const cpki = makePki(await counting.publicKey());
      try {
        const orig = counting.signDigest.bind(counting);
        counting.signDigest = (a, d) => {
          signed += 1;
          return orig(a, d);
        };
        const failing: AuditSink = {
          append: (_e: AuditEntry) => Promise.reject(new Error('disk full')),
        };
        const w = makeWorld({
          operator: { id: 'k', keyService: counting, pki: cpki },
          tsaUrl: tsa.url,
          audit: failing,
        });
        expect(await w.service.anchor(credential, cmd())).toEqual({
          ok: false,
          code: 'audit_unavailable',
          retryable: true,
        });
        expect(signed).toBe(0);
      } finally {
        cpki.remove();
      }
    });

    it('is served by the HTTP transport at POST /v1/anchor with the same refusals', async () => {
      down = false;
      const server = createSigningServer(world.service, { maxBodyBytes: 100_000 });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      const addr = server.address();
      if (!addr || typeof addr === 'string') throw new Error('no address');
      const url = `http://127.0.0.1:${addr.port}/v1/anchor`;
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
        expect((await post(null, cmd())).status).toBe(401);
        expect((await post(WORKER_SECRET, cmd())).status).toBe(403);
        expect((await post(credential, { nonsense: true })).status).toBe(400);
        const ok = await post(credential, cmd({ documentId: 'doc-http' }));
        expect(ok.status).toBe(200);
        const wire = (await ok.json()) as {
          record: string;
          cms: string;
          recordSha256: string;
          ok: boolean;
        };
        expect(wire.ok).toBe(true);
        const report = verifyDetached(
          new Uint8Array(Buffer.from(wire.cms, 'base64')),
          new TextEncoder().encode(wire.record),
          pki,
        );
        expect(report.main.ok, report.main.detail).toBe(true);
      } finally {
        await new Promise<void>((r) => server.close(() => r()));
      }
    });
  },
);
