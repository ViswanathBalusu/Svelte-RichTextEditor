/**
 * FRW-052 and FRW-053: the signing service's rules, over a PDF with a classic cross-reference table
 * and a key held in this process. The key's place is not under test here (that is
 * frw-052-key-service.podman.test.ts, with the key in SoftHSM2); what is: who may ask, what the
 * request is bound to, the audit log, the rate limit, the key of the tenant, the failures, the
 * profile, what the seal says about its party, and the two kinds of time.
 *
 * Needs `openssl` on the path (or DOCEDIT_OPENSSL). The chain and the time-stamp authority are made
 * for the run; nothing leaves this machine.
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuditEntry, AuditSink } from '../src/audit.ts';
import { HttpTimestampAuthority } from '../src/cms.ts';
import type { DigestAlgorithm, KeyService } from '../src/keyservice.ts';
import { profileOf, SigningService } from '../src/service.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import {
  command,
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  sha256Hex,
  WORKER_SECRET,
  type WorldKey,
} from './support/service-world.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { cmsParts, findSignatures, verifyWithOpenssl } from './support/verify.ts';
import { flipByte, InProcessKeyService, startsWith } from './support/world.ts';

/** The time `openssl ts -reply -text` reads out of a token, in ms since the epoch (second precision). */
function tokenTime(token: Uint8Array): number {
  const dir = mkdtempSync(join(tmpdir(), 'docedit-frw053-token-'));
  try {
    writeFileSync(join(dir, 't.der'), token);
    const r = spawnSync(
      process.env['DOCEDIT_OPENSSL'] ?? 'openssl',
      ['ts', '-reply', '-in', 't.der', '-token_in', '-text'],
      { cwd: dir, encoding: 'utf8', windowsHide: true },
    );
    const m = /Time stamp: (.+)/.exec(r.stdout);
    if (!m) throw new Error(`no time in the token: ${r.stdout}${r.stderr}`);
    return Date.parse(`${m[1]!.replace(' GMT', '')} UTC`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

class FailingKeyService implements KeyService {
  readonly keyLabel = 'unavailable';
  publicKey(): Promise<Uint8Array> {
    return Promise.reject(new Error('down'));
  }
  signDigest(_a: DigestAlgorithm, _d: Uint8Array): Promise<Uint8Array> {
    return Promise.reject(new Error('down'));
  }
}

describe.skipIf(!opensslAvailable())('FRW-052, FRW-053: the signing service', () => {
  const input = classicPdf();
  let operatorKs: InProcessKeyService;
  let tenantKs: InProcessKeyService;
  let operatorPki: TestPki;
  let tenantPki: TestPki;
  let tsa: TestTsa;
  let operator: WorldKey;
  let tenant: WorldKey;

  beforeAll(async () => {
    operatorKs = new InProcessKeyService();
    tenantKs = new InProcessKeyService();
    operatorPki = makePki(await operatorKs.publicKey());
    tenantPki = makePki(await tenantKs.publicKey());
    tsa = await startTestTsa(operatorPki);
    operator = { id: 'operator-key', keyService: operatorKs, pki: operatorPki };
    tenant = { id: 'tenant-b-key', keyService: tenantKs, pki: tenantPki };
  }, 300_000);

  afterAll(async () => {
    await tsa?.stop();
    operatorPki?.remove();
    tenantPki?.remove();
  });

  const world = (o: Partial<Parameters<typeof makeWorld>[0]> = {}) =>
    makeWorld({ operator, tsaUrl: tsa.url, ...o });

  describe('FRW-052 criterion 3: who may ask, and what the request is bound to', () => {
    it('refuses a request with no credential or an unknown one, and uses no key', async () => {
      const w = world();
      const before = operatorKs.calls.length;
      for (const secret of [null, '', 'not-a-credential']) {
        const out = await w.service.seal(secret, command(input));
        expect(out).toEqual({ ok: false, code: 'unauthenticated', retryable: false });
      }
      expect(operatorKs.calls.length).toBe(before);
      expect(w.audit.entries.map((e) => [e.event, e.code, e.caller])).toEqual([
        ['seal.refused', 'unauthenticated', null],
        ['seal.refused', 'unauthenticated', null],
        ['seal.refused', 'unauthenticated', null],
      ]);
    });

    it('refuses the export worker even with a valid credential of its own', async () => {
      const w = world();
      const before = operatorKs.calls.length;
      const out = await w.service.seal(WORKER_SECRET, command(input));
      expect(out).toEqual({ ok: false, code: 'wrong_caller', retryable: false });
      expect(operatorKs.calls.length).toBe(before);
      expect(w.audit.entries[0]).toMatchObject({
        event: 'seal.refused',
        caller: 'export-worker',
        code: 'wrong_caller',
      });
    });

    it('refuses bytes that do not hash to the hash the request names', async () => {
      const w = world();
      const other = sha256Hex(new TextEncoder().encode('other bytes'));
      const out = await w.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { pdfSha256: other, compileSha256: [other, other] }),
      );
      expect(out).toMatchObject({ ok: false, code: 'hash_mismatch' });
    });

    it('refuses a PDF that did not come from an equal pair of compiles', async () => {
      const w = world();
      const h = sha256Hex(input);
      const other = sha256Hex(new TextEncoder().encode('a different compile'));
      for (const pair of [
        [h, other],
        [other, h],
        [other, other],
      ] as const) {
        const out = await w.service.seal(
          DOCUMENT_SERVICE_SECRET,
          command(input, { compileSha256: pair }),
        );
        expect(out).toMatchObject({ ok: false, code: 'pair_differs' });
      }
    });

    it('refuses malformed requests', async () => {
      const w = world();
      for (const bad of [
        command(input, { documentId: '' }),
        command(input, { tenant: '' }),
        command(input, { seq: -1 }),
        command(input, { seq: 1.5 }),
        command(input, { pdfSha256: 'ABC' }),
        command(new Uint8Array()),
      ]) {
        const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, bad);
        expect(out).toMatchObject({ ok: false, code: 'bad_request' });
      }
    });

    it('binds one document and seq to one hash: the same bytes again are fine, other bytes are not', async () => {
      const w = world();
      const first = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input));
      expect(first.ok).toBe(true);
      const again = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input));
      expect(again.ok).toBe(true);
      const changed = new Uint8Array(input.length + 1);
      changed.set(input);
      changed[input.length] = 10;
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(changed));
      expect(out).toMatchObject({ ok: false, code: 'binding_conflict', retryable: false });
      // Another seq of the same document is another binding.
      const next = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(changed, { seq: 8 }));
      expect(next.ok).toBe(true);
    }, 180_000);

    it('limits the requests of a caller in a window, and counts again in the next one', async () => {
      const clock = { now: new Date('2026-01-02T03:04:05Z') };
      const w = world({ rateLimit: { limit: 2, windowMs: 1000 }, clock });
      const bad = command(input, { seq: -1 });
      expect((await w.service.seal(DOCUMENT_SERVICE_SECRET, bad)).ok).toBe(false);
      expect((await w.service.seal(DOCUMENT_SERVICE_SECRET, bad)).ok).toBe(false);
      const third = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input));
      expect(third).toEqual({ ok: false, code: 'rate_limited', retryable: true });
      // Another caller has its own count.
      const worker = await w.service.seal(WORKER_SECRET, command(input));
      expect(worker).toMatchObject({ code: 'wrong_caller' });
      clock.now = new Date(clock.now.getTime() + 1000);
      const later = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input));
      expect(later.ok).toBe(true);
    }, 120_000);

    it('writes the request to the audit log before it uses the key, and the outcome after', async () => {
      const seen: { event: string; keyCalls: number }[] = [];
      const sink: AuditSink = {
        append: (e: AuditEntry) => {
          seen.push({ event: e.event, keyCalls: operatorKs.calls.length });
        },
      };
      const w = world({ audit: sink });
      const start = operatorKs.calls.length;
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 21 }));
      expect(out.ok).toBe(true);
      expect(seen.map((s) => s.event)).toEqual(['seal.requested', 'seal.sealed']);
      expect(seen[0]!.keyCalls).toBe(start);
      expect(seen[1]!.keyCalls).toBe(start + 1);
    }, 120_000);

    it('does not seal when the audit log cannot be written', async () => {
      const w = world({
        audit: {
          append: () => {
            throw new Error('disk full');
          },
        },
      });
      const before = operatorKs.calls.length;
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input));
      expect(out).toEqual({ ok: false, code: 'audit_unavailable', retryable: true });
      expect(operatorKs.calls.length).toBe(before);
    });

    it('the audit entries hold identifiers and hashes, and no document byte, key or secret', async () => {
      const w = world();
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 22 }));
      if (!out.ok) throw new Error(out.code);
      const text = JSON.stringify(w.audit.entries);
      expect(w.audit.entries).toHaveLength(2);
      expect(w.audit.entries[1]).toMatchObject({
        event: 'seal.sealed',
        caller: 'document-service',
        tenant: 'tenant-a',
        documentId: 'doc-1',
        seq: 22,
        pdfSha256: sha256Hex(input),
        keyId: 'operator-key',
        sealedSha256: out.sealedSha256,
      });
      expect(text).not.toContain(DOCUMENT_SERVICE_SECRET);
      expect(text).not.toContain('PRIVATE KEY');
      expect(text).not.toContain(Buffer.from(input.subarray(0, 24)).toString('base64'));
      expect(Object.keys(w.audit.entries[0]!).sort()).toEqual(
        [
          'at',
          'caller',
          'code',
          'documentId',
          'event',
          'keyId',
          'pdfSha256',
          'sealedSha256',
          'seq',
          'tenant',
        ].sort(),
      );
    }, 120_000);
  });

  describe('FRW-052 criterion 4: the key of the tenant comes from configuration', () => {
    it('seals with the operator key unless the tenant has its own', async () => {
      const w = world({ tenants: { 'tenant-b': tenant } });
      const o0 = operatorKs.calls.length;
      const t0 = tenantKs.calls.length;
      const a = await w.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { tenant: 'tenant-a', documentId: 'doc-a' }),
      );
      expect(a).toMatchObject({ ok: true, keyId: 'operator-key', keyOwner: 'operator' });
      expect(operatorKs.calls.length - o0).toBe(1);
      expect(tenantKs.calls.length - t0).toBe(0);

      const b = await w.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { tenant: 'tenant-b', documentId: 'doc-b' }),
      );
      expect(b).toMatchObject({ ok: true, keyId: 'tenant-b-key', keyOwner: 'tenant' });
      expect(operatorKs.calls.length - o0).toBe(1);
      expect(tenantKs.calls.length - t0).toBe(1);
      if (!a.ok || !b.ok) throw new Error('not sealed');
      // The seal's certificate is the one issued for that key.
      const certOf = (pdf: Uint8Array): Buffer => Buffer.from(findSignatures(pdf)[0]!.contents);
      expect(certOf(a.pdf).includes(Buffer.from(operatorPki.seal))).toBe(true);
      expect(certOf(b.pdf).includes(Buffer.from(tenantPki.seal))).toBe(true);
      expect(certOf(b.pdf).includes(Buffer.from(operatorPki.seal))).toBe(false);
    }, 180_000);

    it('refuses to seal for a tenant whose key is not in the directory', async () => {
      const w = world({ tenants: { 'tenant-b': tenant } });
      (w.config.keys as { get: (id: string) => KeyService | undefined }).get = () => undefined;
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input));
      expect(out).toMatchObject({ ok: false, code: 'no_key' });
    });
  });

  describe('FRW-053: the seal', () => {
    it('criterion 1: B-LT by default, B-LTA when the workflow says so, each with its time-stamp token', async () => {
      const w = world();
      const lt = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 30 }));
      const lta = await w.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { seq: 31, seal: 'pades-b-lta' }),
      );
      if (!lt.ok || !lta.ok) throw new Error('not sealed');
      expect(lt.profile).toBe('B-LT');
      expect(lta.profile).toBe('B-LTA');
      expect(startsWith(lt.pdf, input)).toBe(true);
      const ltSigs = findSignatures(lt.pdf);
      const ltaSigs = findSignatures(lta.pdf);
      expect(ltSigs.map((s) => s.kind)).toEqual(['signature']);
      expect(ltaSigs.map((s) => s.kind)).toEqual(['signature', 'document-time-stamp']);
      expect(ltSigs[0]!.subFilter).toBe('ETSI.CAdES.detached');
      expect(cmsParts(ltSigs[0]!.contents).token).not.toBeNull();
      expect(Buffer.from(lt.pdf).toString('latin1')).toContain('/Type /DSS');
      for (const out of [lt, lta])
        for (const rep of verifyWithOpenssl(out.pdf, operatorPki)) {
          expect(rep.main.ok, rep.main.detail).toBe(true);
          if (rep.signature.kind === 'signature') expect(rep.timestamp?.ok).toBe(true);
        }
      expect(lt.sealedSha256).toBe(sha256Hex(lt.pdf));
    }, 240_000);

    it('names the profile of finalisation.seal, and refuses a level it does not know', () => {
      expect(profileOf(undefined)).toBe('B-LT');
      expect(profileOf('pades-b-lt')).toBe('B-LT');
      expect(profileOf('pades-b-lta')).toBe('B-LTA');
      expect(profileOf('pades-b-b')).toBeNull();
      expect(profileOf('')).toBeNull();
    });

    it('refuses an unknown seal level before any key is used', async () => {
      const w = world();
      const before = operatorKs.calls.length;
      const out = await w.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { seal: 'pades-b-b' }),
      );
      expect(out).toMatchObject({ ok: false, code: 'unknown_seal_level' });
      expect(operatorKs.calls.length).toBe(before);
    });

    it('criterion 3: one changed byte anywhere the signature covers is reported', async () => {
      const w = world();
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 40 }));
      if (!out.ok) throw new Error(out.code);
      for (const rep of verifyWithOpenssl(out.pdf, operatorPki)) expect(rep.main.ok).toBe(true);
      const sig = findSignatures(out.pdf)[0]!;
      const text = Buffer.from(out.pdf).toString('latin1');
      const spots = [
        0,
        text.indexOf('(Classic table)') + 3,
        Math.floor((sig.byteRange[1] as number) / 2),
        (sig.byteRange[2] as number) + 5,
      ];
      for (const at of spots)
        expect(
          verifyWithOpenssl(flipByte(out.pdf, at), operatorPki)[0]!.main.ok,
          `byte ${at}`,
        ).toBe(false);
    }, 240_000);

    it("criterion 4: the seal names its party, not a signer, and the certificate is the sealing party's", async () => {
      const w = world({ tenants: { 'tenant-b': tenant } });
      const op = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 50 }));
      const te = await w.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { seq: 51, tenant: 'tenant-b' }),
      );
      if (!op.ok || !te.ok) throw new Error('not sealed');
      const added = (pdf: Uint8Array): string =>
        Buffer.from(pdf.subarray(input.length)).toString('latin1');
      expect(added(op.pdf)).toContain(
        '/Reason (Seal applied by the operator of the service. It is not the signature of any signer.)',
      );
      expect(added(te.pdf)).toContain(
        '/Reason (Seal applied by the tenant. It is not the signature of any signer.)',
      );
      for (const pdf of [op.pdf, te.pdf]) {
        const a = added(pdf);
        // No name of a signer, no contact, and no wording that claims a person signed.
        expect(a).not.toMatch(/\/Name\b|\/ContactInfo/);
        expect(a).not.toMatch(/signed by|on behalf of/i);
      }
      // The certificate is the one issued to the seal key: not an end-user certificate.
      expect(op.keyOwner).toBe('operator');
      expect(te.keyOwner).toBe('tenant');
    }, 240_000);

    it('criterion 5: a time-stamp authority that does not answer gives no seal', async () => {
      const w = world({ timestamps: new HttpTimestampAuthority('http://127.0.0.1:9/tsa') });
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 60 }));
      expect(out).toEqual({ ok: false, code: 'tsa_unreachable', retryable: true });
      expect('pdf' in out).toBe(false);
      expect(w.audit.entries.map((e) => [e.event, e.code])).toEqual([
        ['seal.requested', null],
        ['seal.failed', 'tsa_unreachable'],
      ]);
    }, 120_000);

    it('a key service that does not answer gives no seal and a retryable code', async () => {
      const dead: WorldKey = {
        id: 'operator-key',
        keyService: new FailingKeyService(),
        pki: operatorPki,
      };
      const w = makeWorld({ operator: dead, tsaUrl: tsa.url });
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 61 }));
      expect(out).toEqual({ ok: false, code: 'signing_unavailable', retryable: true });
    }, 120_000);

    it('a signature that does not fit its room is a failed seal that leaves nothing half written', async () => {
      const cfg = { ...world().config, contentsBytes: 512 };
      const out = await new SigningService(cfg).seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { seq: 62 }),
      );
      expect(out).toEqual({ ok: false, code: 'seal_failed', retryable: false });
    }, 120_000);

    it("criterion 6: the seal time is the token's, the clock of the service is its own", async () => {
      const clock = { now: new Date('2026-01-02T03:04:05Z') };
      const w = world({ clock });
      const wall = Date.now();
      const out = await w.service.seal(DOCUMENT_SERVICE_SECRET, command(input, { seq: 70 }));
      if (!out.ok) throw new Error(out.code);
      const sig = findSignatures(out.pdf)[0]!;
      const token = cmsParts(sig.contents).token!;
      // The token's time, read by OpenSSL, is what the service reports as the seal's time, and it
      // is the authority's clock (here this machine's), not the service's clock.
      expect(Math.abs(tokenTime(token) - out.timestampTime.getTime())).toBeLessThan(2000);
      expect(Math.abs(out.timestampTime.getTime() - wall)).toBeLessThan(120_000);
      // The service's clock gives `/M` and the audit time, and is a different instant here.
      expect(out.sealedAt.toISOString()).toBe('2026-01-02T03:04:05.000Z');
      expect(Buffer.from(out.pdf).toString('latin1')).toContain('/M (D:20260102030405Z)');
      expect(w.audit.entries.every((e) => e.at === '2026-01-02T03:04:05.000Z')).toBe(true);
      expect(out.timestampTime.getTime()).not.toBe(out.sealedAt.getTime());
    }, 120_000);
  });
});
