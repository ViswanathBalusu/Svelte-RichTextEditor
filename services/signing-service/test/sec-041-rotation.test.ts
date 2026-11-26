/**
 * SEC-041 criteria 4 and 5 (lane w8): the signing service's audit trail across a key rotation, and
 * the seals made before it.
 *
 * A rotation here is what an operator does with the product's configuration: a new key in the key
 * service with its own certificate chain, the operator key identifier of the service changed to it,
 * and the old key retired (the old key service is no longer in the service's key directory, so
 * nothing can sign with it any more). The seal verifier of FRW-055 (`verifySealedPdf`) is the
 * relying party's: it needs only the roots it trusts.
 *
 * - Criterion 5: a seal made under the first key still validates after the rotation, under the
 *   first key's root, as the verifier and as OpenSSL read it; a seal made after it is under the new
 *   key and root, and does not validate under the old root alone.
 * - Criterion 4: each sealing is in the audit trail with the hash of the document and the requester
 *   (the caller the credential names), in order and with the key that was used; the entries before
 *   and after the rotation are in one trail.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { verifySealedPdf } from '../src/verify-sealed.ts';
import { MemoryAudit } from '../src/audit.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import { command, DOCUMENT_SERVICE_SECRET, makeWorld, sha256Hex } from './support/service-world.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { verifyWithOpenssl } from './support/verify.ts';
import { InProcessKeyService } from './support/world.ts';

describe.skipIf(!opensslAvailable())(
  'SEC-041: seals and the audit trail across a key rotation',
  () => {
    const input = classicPdf();
    let oldKs: InProcessKeyService;
    let newKs: InProcessKeyService;
    let oldPki: TestPki;
    let newPki: TestPki;
    let oldTsa: TestTsa;
    let newTsa: TestTsa;

    beforeAll(async () => {
      oldKs = new InProcessKeyService();
      newKs = new InProcessKeyService();
      oldPki = makePki(await oldKs.publicKey());
      newPki = makePki(await newKs.publicKey());
      oldTsa = await startTestTsa(oldPki);
      newTsa = await startTestTsa(newPki);
    }, 300_000);

    afterAll(async () => {
      await oldTsa?.stop();
      await newTsa?.stop();
      oldPki?.remove();
      newPki?.remove();
    });

    it('validates a seal made before the rotation, and records both sealings with their document hash and requester', async () => {
      const trail = new MemoryAudit();
      const before = makeWorld({
        operator: { id: 'operator-2026', keyService: oldKs, pki: oldPki },
        tsaUrl: oldTsa.url,
        audit: trail,
      });
      const first = await before.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { documentId: 'doc-before', seq: 3 }),
      );
      if (!first.ok) throw new Error(first.code);
      const oldCalls = oldKs.calls.length;

      // The rotation: the service is configured with the new key; the old key service is gone.
      const after = makeWorld({
        operator: { id: 'operator-2027', keyService: newKs, pki: newPki },
        tsaUrl: newTsa.url,
        audit: trail,
      });
      const second = await after.service.seal(
        DOCUMENT_SERVICE_SECRET,
        command(input, { documentId: 'doc-after', seq: 4 }),
      );
      if (!second.ok) throw new Error(second.code);
      // Nothing asked the old key to sign again.
      expect(oldKs.calls.length).toBe(oldCalls);
      expect(newKs.calls.length).toBeGreaterThan(0);

      // Criterion 5: the earlier seal validates after the rotation, under its own root.
      const earlier = await verifySealedPdf(first.pdf, [oldPki.root]);
      expect(earlier.problems).toEqual([]);
      expect(earlier.ok).toBe(true);
      for (const r of verifyWithOpenssl(first.pdf, oldPki))
        expect(r.main.ok, r.main.detail).toBe(true);
      // A relying party that trusts both roots validates both seals.
      for (const pdf of [first.pdf, second.pdf])
        expect((await verifySealedPdf(pdf, [oldPki.root, newPki.root])).ok).toBe(true);
      // The new seal is under the new key: its root validates it, the old root alone does not.
      expect((await verifySealedPdf(second.pdf, [newPki.root])).ok).toBe(true);
      expect((await verifySealedPdf(second.pdf, [oldPki.root])).ok).toBe(false);
      // And the old seal does not validate under the new root alone: the rotation did not re-sign it.
      expect((await verifySealedPdf(first.pdf, [newPki.root])).ok).toBe(false);

      // Criterion 4: each sealing is in the one trail, with the document hash and the requester.
      const sealed = trail.entries.filter((e) => e.event === 'seal.sealed');
      expect(sealed).toHaveLength(2);
      expect(sealed[0]).toMatchObject({
        caller: 'document-service',
        documentId: 'doc-before',
        seq: 3,
        pdfSha256: sha256Hex(input),
        keyId: 'operator-2026',
        sealedSha256: first.sealedSha256,
      });
      expect(sealed[1]).toMatchObject({
        caller: 'document-service',
        documentId: 'doc-after',
        seq: 4,
        pdfSha256: sha256Hex(input),
        keyId: 'operator-2027',
        sealedSha256: second.sealedSha256,
      });
      // Each request was written before its seal.
      expect(trail.entries.map((e) => `${e.event}:${e.documentId}`)).toEqual([
        'seal.requested:doc-before',
        'seal.sealed:doc-before',
        'seal.requested:doc-after',
        'seal.sealed:doc-after',
      ]);
    }, 300_000);
  },
);
