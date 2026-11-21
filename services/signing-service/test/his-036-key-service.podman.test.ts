/**
 * HIS-036 with the key in the development key service (SoftHSM2 in Podman; owner decision 222): the
 * signing service signs the hourly batch of chain heads with a key it can only ask to sign a
 * 32-byte digest. The signature and the RFC 3161 token are checked by OpenSSL and by the relying
 * party's verifier.
 *
 * This is a software emulator. It shows the interface and the discipline: the service holds and can
 * request no key, the token reports the key as never extractable, and no key material reaches the
 * audit log or the signed file. It does not show a hardware module or a cloud key service, which the
 * owner has not chosen, so it is not evidence for HIS-036 criterion 2.
 *
 * Needs Podman, the emulator image (`pnpm --filter @docedit/signing-service keyservice:image`) and
 * OpenSSL. It skips without them.
 */
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { containerCli, podmanInfo } from '../../export-worker/src/container.ts';
import type { DigestAlgorithm, KeyService } from '../src/keyservice.ts';
import { verifyBatchAnchorFile } from '../src/verify-sealed.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import { DOCUMENT_SERVICE_SECRET, makeWorld, type World } from './support/service-world.ts';
import { KEY_SERVICE_IMAGE, SoftHsmKeyService } from './support/softhsm.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { verifyDetached } from './support/verify.ts';

function imageExists(image: string): boolean {
  const r = spawnSync(containerCli(), ['image', 'exists', image], {
    windowsHide: true,
    timeout: 120_000,
  });
  return !r.error && r.status === 0;
}

const ready = podmanInfo() !== null && opensslAvailable() && imageExists(KEY_SERVICE_IMAGE);

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
  'HIS-036: a batch of chain heads signed with the key in a key service',
  () => {
    let hsm: SoftHsmKeyService;
    let ks: Recording;
    let pki: TestPki;
    let tsa: TestTsa;
    let world: World;

    beforeAll(async () => {
      hsm = await SoftHsmKeyService.start(`docedit-his036-ks-${process.pid}-w7`);
      ks = new Recording(hsm);
      pki = makePki(await ks.publicKey());
      tsa = await startTestTsa(pki);
      world = makeWorld({ operator: { id: 'operator-key', keyService: ks, pki }, tsaUrl: tsa.url });
    }, 900_000);

    afterAll(async () => {
      await tsa?.stop();
      pki?.remove();
      await hsm?.stop();
    }, 300_000);

    it('signs and time-stamps the record through the key service, and OpenSSL and the verifier accept it', async () => {
      const out = await world.service.anchorBatch(DOCUMENT_SERVICE_SECRET, {
        tenant: '22222222-2222-4222-8222-222222222222',
        from: null,
        to: '2026-11-21T01:00:00.000Z',
        root: 'ab'.repeat(32),
        leaves: 2,
        previous: null,
      });
      if (!out.ok) throw new Error(out.code);
      const bytes = new TextEncoder().encode(out.record);
      const report = verifyDetached(out.cms, bytes, pki);
      expect(report.main.ok, report.main.detail).toBe(true);
      expect(report.timestamp?.ok, report.timestamp?.detail).toBe(true);
      const file = {
        record: out.record,
        recordSha256: out.recordSha256,
        cms: Buffer.from(out.cms).toString('base64'),
      };
      expect(await verifyBatchAnchorFile(file, [pki.root])).toMatchObject({
        ok: true,
        problems: [],
      });

      // The service asked the key service for a signature over a 32-byte digest, and nothing else.
      expect(ks.calls).toEqual([{ algorithm: 'SHA-256', length: 32 }]);
      // The token reports the key as never extractable, and nothing of it is in the audit log or
      // the signed file.
      expect(await hsm.describePrivateKey()).toMatch(
        /Access:\s+sensitive, always sensitive, never extractable/,
      );
      expect(await hsm.tryExtractPrivateKey()).not.toContain('LEAKED');
      expect(JSON.stringify(world.audit.entries)).not.toMatch(/PRIVATE KEY|signatureValue/);
      expect(JSON.stringify(file)).not.toMatch(/PRIVATE KEY/);
    }, 600_000);
  },
);
