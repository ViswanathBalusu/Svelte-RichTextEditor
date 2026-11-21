/**
 * SPK-021 (spike S8): the sealing code on a PDF with a classic cross-reference table, with the key
 * held in this process. These tests are about the file handling: the incremental updates, the
 * byte ranges, the time-stamps and the profiles, each checked by OpenSSL. They say nothing about
 * where the key is; that is spk-021-key-service.podman.test.ts, with the key in SoftHSM2.
 *
 * Needs `openssl` on the path (or DOCEDIT_OPENSSL). The certificate chain and the time-stamp
 * authority are made for the run (test/support/pki.ts, tsa.ts); nothing goes outside this machine.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { addDocumentTimestamp, sealPdf } from '../src/pades.ts';
import { PdfDocument, PdfError } from '../src/pdf.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { cmsParts, findSignatures, verifyWithOpenssl } from './support/verify.ts';
import {
  flipByte,
  flipHexDigit,
  InProcessKeyService,
  sealOptions,
  startsWith,
} from './support/world.ts';

describe.skipIf(!opensslAvailable())(
  'SPK-021: sealing a PDF with a classic cross-reference table',
  () => {
    let pki: TestPki;
    let tsa: TestTsa;
    let ks: InProcessKeyService;
    const input = classicPdf();

    beforeAll(async () => {
      ks = new InProcessKeyService();
      pki = makePki(await ks.publicKey());
      tsa = await startTestTsa(pki);
    }, 300_000);

    afterAll(async () => {
      await tsa?.stop();
      pki?.remove();
    });

    it('reads the table and finds the catalog and the first page', () => {
      const doc = new PdfDocument(input);
      expect(doc.kind).toBe('table');
      expect(doc.version).toBe('1.7');
      expect(doc.firstPage().ref.num).toBe(3);
    });

    it('seals at B-T: one signature, a signature time-stamp, the original bytes first', async () => {
      const r = await sealPdf(input, sealOptions(pki, tsa, ks, 'B-T'));
      expect(startsWith(r.pdf, input)).toBe(true);
      const reports = verifyWithOpenssl(r.pdf, pki);
      expect(reports).toHaveLength(1);
      const rep = reports[0]!;
      expect(rep.signature.subFilter).toBe('ETSI.CAdES.detached');
      expect(rep.signature.coversWholeFile).toBe(true);
      expect(rep.main.ok, rep.main.detail).toBe(true);
      expect(rep.timestamp?.ok, rep.timestamp?.detail).toBe(true);
    }, 120_000);

    it('only the 32-byte digest goes to the key service, never a document byte', async () => {
      const before = ks.calls.length;
      await sealPdf(input, sealOptions(pki, tsa, ks, 'B-T'));
      const calls = ks.calls.slice(before);
      expect(calls).toHaveLength(1);
      expect(calls[0]).toEqual({ algorithm: 'SHA-256', length: 32 });
    }, 120_000);

    it('seals at B-LT: validation data in a later update, the signature still valid', async () => {
      const r = await sealPdf(input, sealOptions(pki, tsa, ks, 'B-LT'));
      const text = Buffer.from(r.pdf).toString('latin1');
      expect(text).toContain('/Type /DSS');
      expect(text).toContain('/VRI');
      expect(text).toMatch(/\/Extensions <<\/ESIC/);
      const reports = verifyWithOpenssl(r.pdf, pki);
      expect(reports).toHaveLength(1);
      // The signature covers the file up to its own update; the DSS comes after it.
      expect(reports[0]!.signature.coversWholeFile).toBe(false);
      expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
      expect(reports[0]!.timestamp?.ok).toBe(true);
      expect(r.steps.map((s) => s.name)).toEqual([
        'input',
        'signature and signature time-stamp (B-T)',
        'validation data (DSS, B-LT)',
      ]);
    }, 120_000);

    it('seals at B-LTA: a document time-stamp over the whole file', async () => {
      const r = await sealPdf(input, sealOptions(pki, tsa, ks, 'B-LTA'));
      const reports = verifyWithOpenssl(r.pdf, pki);
      expect(reports.map((x) => x.signature.kind)).toEqual(['signature', 'document-time-stamp']);
      for (const rep of reports) expect(rep.main.ok, rep.main.detail).toBe(true);
      expect(reports[1]!.signature.coversWholeFile).toBe(true);
    }, 120_000);

    it('upgrades a B-LT file to B-LTA and renews the time-stamp by appending only', async () => {
      const lt = await sealPdf(input, sealOptions(pki, tsa, ks, 'B-LT'));
      const lta = await addDocumentTimestamp(lt.pdf, {
        timestamps: sealOptions(pki, tsa, ks, 'B-LT').timestamps,
      });
      expect(startsWith(lta, lt.pdf)).toBe(true);
      const renewed = await addDocumentTimestamp(lta, {
        timestamps: sealOptions(pki, tsa, ks, 'B-LT').timestamps,
      });
      expect(startsWith(renewed, lta)).toBe(true);
      const reports = verifyWithOpenssl(renewed, pki);
      expect(reports.map((x) => x.signature.kind)).toEqual([
        'signature',
        'document-time-stamp',
        'document-time-stamp',
      ]);
      for (const rep of reports) expect(rep.main.ok, rep.main.detail).toBe(true);
    }, 180_000);

    describe('one changed byte is reported', () => {
      let sealed: Uint8Array;
      beforeAll(async () => {
        sealed = (await sealPdf(input, sealOptions(pki, tsa, ks, 'B-LTA'))).pdf;
        // The untouched file is valid; each case below changes one byte of it.
        for (const rep of verifyWithOpenssl(sealed, pki)) expect(rep.main.ok).toBe(true);
      }, 120_000);

      it('in the page content: the signature and the document time-stamp both fail', () => {
        const text = Buffer.from(sealed).toString('latin1');
        const at = text.indexOf('(Classic table)') + 3;
        const bad = verifyWithOpenssl(flipByte(sealed, at), pki);
        expect(bad[0]!.main.ok).toBe(false);
        expect(bad[1]!.main.ok).toBe(false);
      }, 120_000);

      it('in the validation data: the signature holds, the document time-stamp fails', () => {
        const sigs = findSignatures(sealed);
        // Just past the end of the first signature's last signed byte: the DSS update.
        const at = (sigs[0]!.byteRange[2] as number) + (sigs[0]!.byteRange[3] as number) + 100;
        const bad = verifyWithOpenssl(flipByte(sealed, at), pki);
        expect(bad[0]!.main.ok).toBe(true);
        expect(bad[1]!.main.ok).toBe(false);
      }, 120_000);

      it('in the signature value: the signature fails', () => {
        const s = findSignatures(sealed)[0]!;
        const inside = Buffer.from(s.contents).indexOf(
          Buffer.from(cmsParts(s.contents).signatureValue),
        );
        expect(inside).toBeGreaterThan(0);
        const at = (s.byteRange[1] as number) + 1 + 2 * (inside + 20);
        const bad = verifyWithOpenssl(flipHexDigit(sealed, at), pki);
        expect(bad[0]!.main.ok).toBe(false);
      }, 120_000);

      it('in the document time-stamp token: the time-stamp fails', () => {
        const s = findSignatures(sealed)[1]!;
        const inside = Buffer.from(s.contents).indexOf(
          Buffer.from(cmsParts(s.contents).signatureValue),
        );
        expect(inside).toBeGreaterThan(0);
        const at = (s.byteRange[1] as number) + 1 + 2 * (inside + 20);
        const bad = verifyWithOpenssl(flipHexDigit(sealed, at), pki);
        expect(bad[0]!.main.ok).toBe(true);
        expect(bad[1]!.main.ok).toBe(false);
      }, 120_000);
    });
    it('refuses a signature that does not fit its room', async () => {
      await expect(
        sealPdf(input, { ...sealOptions(pki, tsa, ks, 'B-T'), contentsBytes: 512 }),
      ).rejects.toBeInstanceOf(PdfError);
    }, 60_000);

    it('refuses B-LT without validation data', async () => {
      const o = sealOptions(pki, tsa, ks, 'B-LT');
      delete (o as { validationData?: unknown }).validationData;
      await expect(sealPdf(input, o)).rejects.toBeInstanceOf(PdfError);
    }, 60_000);
  },
);
