/**
 * FRW-052 and FRW-053 with the key in the development key service (SoftHSM2 in Podman; owner
 * decision 222): the signing service seals the tagged LuaLaTeX sample (the export worker's
 * demonstration document, compiled twice with the local `lualatex`) through its own rules, with
 * a key that it can only ask to sign a 32-byte digest. Checked by OpenSSL.
 *
 * This is a software emulator. It shows the interface and the discipline (the service holds and
 * can request no key, the key is not extractable from the token, no key material reaches the audit
 * log or the sealed file). It does not show a hardware module or a cloud key service, which the
 * owner has not chosen (FRW-052 criterion 2).
 *
 * Needs the same as spk-021-key-service.podman.test.ts: Podman, the emulator image, OpenSSL, a
 * local `lualatex` and the local font directory. It skips without them.
 */
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerCli, podmanInfo } from '../../export-worker/src/container.ts';
import type { DigestAlgorithm, KeyService } from '../src/keyservice.ts';
import { PdfDocument } from '../src/pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import {
  command,
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  sha256Hex,
  type World,
} from './support/service-world.ts';
import { taggedSample, taggedSampleAvailable } from './support/sample.ts';
import { KEY_SERVICE_IMAGE, SoftHsmKeyService } from './support/softhsm.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { findSignatures, verifyWithOpenssl } from './support/verify.ts';
import { flipByte, startsWith } from './support/world.ts';

function imageExists(image: string): boolean {
  const r = spawnSync(containerCli(), ['image', 'exists', image], {
    windowsHide: true,
    timeout: 120_000,
  });
  return !r.error && r.status === 0;
}

const ready =
  podmanInfo() !== null &&
  opensslAvailable() &&
  taggedSampleAvailable() &&
  imageExists(KEY_SERVICE_IMAGE);

class Recording implements KeyService {
  readonly keyLabel: string;
  readonly calls: { algorithm: DigestAlgorithm; length: number }[] = [];
  readonly #inner: KeyService;
  constructor(inner: KeyService) {
    this.#inner = inner;
    this.keyLabel = inner.keyLabel;
  }
  publicKey(): Promise<Uint8Array> {
    return this.#inner.publicKey();
  }
  signDigest(algorithm: DigestAlgorithm, digest: Uint8Array): Promise<Uint8Array> {
    this.calls.push({ algorithm, length: digest.length });
    return this.#inner.signDigest(algorithm, digest);
  }
}

describe.skipIf(!ready)(
  'FRW-052, FRW-053: the signing service with the key in a key service',
  () => {
    let hsm: SoftHsmKeyService;
    let ks: Recording;
    let pki: TestPki;
    let tsa: TestTsa;
    let world: World;
    let pdf1: Uint8Array;
    let pdf2: Uint8Array;

    beforeAll(async () => {
      pdf1 = await taggedSample();
      pdf2 = await taggedSample();
      hsm = await SoftHsmKeyService.start(`docedit-frw052-ks-${process.pid}`);
      ks = new Recording(hsm);
      pki = makePki(await ks.publicKey());
      tsa = await startTestTsa(pki);
      world = makeWorld({
        operator: { id: 'operator-key', keyService: ks, pki },
        tsaUrl: tsa.url,
      });
    }, 900_000);

    afterAll(async () => {
      await tsa?.stop();
      pki?.remove();
      await hsm?.stop();
    }, 300_000);

    it('seals the tagged sample when both compiles agree, and refuses it when they do not', async () => {
      const equal = sha256Hex(pdf1) === sha256Hex(pdf2);
      const out = await world.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(pdf1, {
          documentId: 'doc-tagged',
          compileSha256: [sha256Hex(pdf1), sha256Hex(pdf2)],
        }),
      );
      if (equal) {
        expect(out.ok).toBe(true);
      } else {
        // The two local compiles differ (a timestamp in the file, for instance): the rule holds.
        expect(out).toMatchObject({ ok: false, code: 'pair_differs' });
      }
    }, 300_000);

    describe('the sealed sample', () => {
      let sealed: Uint8Array;
      beforeAll(async () => {
        const h = sha256Hex(pdf1);
        const out = await world.service.seal(
          DOCUMENT_SERVICE_SECRET,
          command(pdf1, { documentId: 'doc-tagged-2', compileSha256: [h, h] }),
        );
        if (!out.ok) throw new Error(out.code);
        sealed = out.pdf;
      }, 300_000);

      it('is the tagged PDF 2.0 with a cross-reference stream, followed by the seal', () => {
        const text = Buffer.from(pdf1).toString('latin1');
        expect(text.startsWith('%PDF-2.0')).toBe(true);
        expect(text).toContain('/StructTreeRoot');
        expect(new PdfDocument(pdf1).kind).toBe('stream');
        expect(startsWith(sealed, pdf1)).toBe(true);
      });

      it('verifies with OpenSSL: the signature, its time-stamp and the chain', () => {
        const reports = verifyWithOpenssl(sealed, pki);
        expect(reports).toHaveLength(1);
        expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
        expect(reports[0]!.timestamp?.ok, reports[0]!.timestamp?.detail).toBe(true);
      }, 180_000);

      it('reports one changed byte', () => {
        const sig = findSignatures(sealed)[0]!;
        const at = Math.floor((sig.byteRange[1] as number) / 2);
        expect(verifyWithOpenssl(flipByte(sealed, at), pki)[0]!.main.ok).toBe(false);
      }, 180_000);

      it('the service asked the key service only for 32-byte digests', () => {
        expect(ks.calls.length).toBeGreaterThanOrEqual(1);
        for (const c of ks.calls) expect(c).toEqual({ algorithm: 'SHA-256', length: 32 });
      });

      it('the token reports the key as sensitive and never extractable, and nothing of it is in the audit log or the file', async () => {
        expect(await hsm.describePrivateKey()).toMatch(
          /Access:\s+sensitive, always sensitive, never extractable/,
        );
        expect(await hsm.tryExtractPrivateKey()).not.toContain('LEAKED');
        expect(JSON.stringify(world.audit.entries)).not.toMatch(/PRIVATE KEY|signatureValue/);
        expect(Buffer.from(sealed).toString('latin1')).not.toMatch(/PRIVATE KEY/);
      }, 180_000);
    });
  },
);
