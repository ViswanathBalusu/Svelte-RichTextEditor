/**
 * FRW-055 criterion 2, the sealed PDF half: `verifySealedPdf` and `verifyAnchorFile` check a seal
 * and a signed chain head with `pkijs` and the roots the relying party names, and agree with the
 * OpenSSL command line on the same files. Altered bytes, an untrusted root and bytes added after
 * the seal are reported.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sealPdf } from '../src/pades.ts';
import { rootsOf, verifyAnchorFile, verifySealedPdf } from '../src/verify-sealed.ts';
import { anchorRecordText } from '../src/service.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import { DOCUMENT_SERVICE_SECRET, makeWorld, sha256Hex } from './support/service-world.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { cmsParts, findSignatures, verifyWithOpenssl } from './support/verify.ts';
import { flipByte, InProcessKeyService, sealOptions } from './support/world.ts';
import { readFileSync } from 'node:fs';

describe.skipIf(!opensslAvailable())(
  'verifying a sealed PDF and a signed head (FRW-055 criterion 2)',
  () => {
    let pki: TestPki;
    let other: TestPki;
    let tsa: TestTsa;
    let ks: InProcessKeyService;
    let sealed: Uint8Array;
    const input = classicPdf();

    beforeAll(async () => {
      ks = new InProcessKeyService();
      pki = makePki(await ks.publicKey());
      other = makePki(await new InProcessKeyService().publicKey());
      tsa = await startTestTsa(pki);
      sealed = (await sealPdf(input, sealOptions(pki, tsa, ks, 'B-LTA'))).pdf;
    }, 300_000);
    afterAll(async () => {
      await tsa?.stop();
      pki?.remove();
      other?.remove();
    });

    it('accepts a B-LTA seal: the signature, its time-stamp and the document time-stamp, as OpenSSL does', async () => {
      const report = await verifySealedPdf(sealed, [pki.root]);
      expect(report.problems).toEqual([]);
      expect(report.signatures.map((s) => s.kind)).toEqual(['signature', 'document-time-stamp']);
      for (const s of report.signatures)
        expect(s, JSON.stringify(s)).toMatchObject({ ok: true, chain: true });
      expect(report.signatures[0]).toMatchObject({ timestamp: true, coversWholeFile: false });
      expect(report.signatures[1]).toMatchObject({ coversWholeFile: true });
      expect(report.ok).toBe(true);
      for (const r of verifyWithOpenssl(sealed, pki)) expect(r.main.ok, r.main.detail).toBe(true);
    }, 60_000);

    it('reads a root from a PEM file as well as from DER', async () => {
      const pem = new Uint8Array(readFileSync(pki.rootPem));
      expect(rootsOf([pem])).toHaveLength(1);
      expect((await verifySealedPdf(sealed, rootsOf([pem]))).ok).toBe(true);
    });

    it('reports one flipped byte in the first signed range, in the signature, and after the seal', async () => {
      const sigs = findSignatures(sealed);
      const first = sigs[0]!;
      const inRange = flipByte(sealed, 20);
      expect((await verifySealedPdf(inRange, [pki.root])).ok).toBe(false);
      const at = Buffer.from(sealed)
        .toString('latin1')
        .indexOf(Buffer.from(cmsParts(first.contents).signatureValue).toString('hex'));
      expect(at).toBeGreaterThan(0);
      const inSig = await verifySealedPdf(flipByte(sealed, at + 5), [pki.root]);
      expect(inSig.ok).toBe(false);
      expect(inSig.signatures[0]!.signature).toBe(false);
      const appended = new Uint8Array(sealed.length + 4);
      appended.set(sealed);
      appended.set([0x0a, 0x25, 0x25, 0x0a], sealed.length);
      const tail = await verifySealedPdf(appended, [pki.root]);
      expect(tail.ok).toBe(false);
      expect(tail.problems.join()).toContain('bytes follow the last signature');
    }, 60_000);

    it('does not trust a root it was not given', async () => {
      const wrong = await verifySealedPdf(sealed, [other.root]);
      expect(wrong.ok).toBe(false);
      expect(wrong.signatures.every((s) => !s.chain)).toBe(true);
    });

    it('refuses a PDF with no signature', async () => {
      const none = await verifySealedPdf(input, [pki.root]);
      expect(none).toMatchObject({ ok: false, signatures: [] });
    });

    it('checks an anchor file made by the service, and a changed record or head is reported', async () => {
      const world = makeWorld({ operator: { id: 'op', keyService: ks, pki }, tsaUrl: tsa.url });
      const cmd = {
        tenant: 't',
        documentId: 'd',
        workflow: 'w',
        seq: 4,
        chainHead: 'ab'.repeat(32),
      };
      const out = await world.service.anchor(DOCUMENT_SERVICE_SECRET, cmd);
      if (!out.ok) throw new Error(out.code);
      const file = {
        record: out.record,
        recordSha256: out.recordSha256,
        cms: Buffer.from(out.cms).toString('base64'),
      };
      const good = await verifyAnchorFile(file, [pki.root]);
      expect(good.problems).toEqual([]);
      expect(good).toMatchObject({ ok: true, record: { chainHead: cmd.chainHead, seq: 4 } });
      expect(out.record).toBe(anchorRecordText(cmd));
      // A different head: the stated hash no longer matches, and the signature does not cover it.
      const changed = anchorRecordText({ ...cmd, chainHead: 'cd'.repeat(32) });
      const bad = await verifyAnchorFile(
        { ...file, record: changed, recordSha256: sha256Hex(new TextEncoder().encode(changed)) },
        [pki.root],
      );
      expect(bad.ok).toBe(false);
      expect((await verifyAnchorFile(file, [other.root])).ok).toBe(false);
    }, 60_000);
  },
);
