/**
 * FRW-056 at the signing service: a sealed PDF is extended for long-term validation and its
 * time-stamp renewed, as incremental updates only. The original bytes stay the first bytes, the
 * original signature still validates (checked by OpenSSL and by `verifySealedPdf`), a repeat with
 * the same key adds nothing, an authority that is down adds nothing, and the same refusals as the
 * seal hold.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { certificateOf, HttpTimestampAuthority } from '../src/cms.ts';
import { sealPdf } from '../src/pades.ts';
import { verifySealedPdf } from '../src/verify-sealed.ts';
import type { ExtendCommand } from '../src/service.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import {
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  sha256Hex,
  WORKER_SECRET,
  type World,
} from './support/service-world.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { findSignatures, verifyWithOpenssl } from './support/verify.ts';
import { InProcessKeyService, sealOptions, startsWith } from './support/world.ts';

describe.skipIf(!opensslAvailable())('extending a sealed PDF (FRW-056)', () => {
  let pki: TestPki;
  let tsa: TestTsa;
  let ks: InProcessKeyService;
  let world: World;
  let sealed: Uint8Array;
  let down = false;
  let stamps = 0;
  const input = classicPdf();

  const cmd = (pdf: Uint8Array, key: string, over: Partial<ExtendCommand> = {}): ExtendCommand => ({
    tenant: 'tenant-a',
    documentId: 'doc-1',
    seq: 7,
    pdf,
    pdfSha256: sha256Hex(pdf),
    idempotencyKey: key,
    validation: true,
    ...over,
  });
  const count = (pdf: Uint8Array, re: RegExp) =>
    (Buffer.from(pdf).toString('latin1').match(re) ?? []).length;

  beforeAll(async () => {
    ks = new InProcessKeyService();
    pki = makePki(await ks.publicKey());
    tsa = await startTestTsa(pki);
    const inner = new HttpTimestampAuthority(tsa.url);
    world = makeWorld({
      operator: { id: 'operator-key', keyService: ks, pki },
      tsaUrl: tsa.url,
      timestamps: {
        stamp: (d) => {
          stamps += 1;
          return down ? Promise.reject(new Error('authority down')) : inner.stamp(d);
        },
      },
    });
    sealed = (await sealPdf(input, sealOptions(pki, tsa, ks, 'B-LT'))).pdf;
  }, 300_000);
  afterAll(async () => {
    await tsa?.stop();
    pki?.remove();
  });

  it('appends fresh validation data and a further document time-stamp; the seal still validates', async () => {
    down = false;
    const out = await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(sealed, 'k1'));
    if (!out.ok) throw new Error(out.code);
    // Only appended: the sealed bytes are the first bytes, and the original signature is unchanged.
    expect(startsWith(out.pdf, sealed)).toBe(true);
    expect(out.pdf.length).toBeGreaterThan(sealed.length);
    expect(findSignatures(out.pdf)[0]!.contents).toEqual(findSignatures(sealed)[0]!.contents);
    expect(count(out.pdf, /\/Type \/DSS/g)).toBe(count(sealed, /\/Type \/DSS/g) + 1);
    expect(count(out.pdf, /\/Type \/DocTimeStamp/g)).toBe(1);
    expect(out.validationAdded).toBe(true);
    // The original signature validates with OpenSSL, and the whole file with the verifier.
    const reports = verifyWithOpenssl(out.pdf, pki);
    expect(reports.map((r) => r.signature.kind)).toEqual(['signature', 'document-time-stamp']);
    for (const r of reports) expect(r.main.ok, r.main.detail).toBe(true);
    const verdict = await verifySealedPdf(out.pdf, [pki.root]);
    expect(verdict.problems).toEqual([]);
    expect(verdict.ok).toBe(true);
    // The new time-stamp is valid until the authority certificate ends.
    expect(out.expiresAtMs).toBe(certificateOf(pki.tsa).notAfter.value.getTime());
    expect(out.timestampTime.getTime() - Date.now()).toBeLessThan(60_000);
  }, 120_000);

  it('renews again: a second document time-stamp over the first, the earlier bytes first', async () => {
    down = false;
    const first = await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(sealed, 'r1'));
    if (!first.ok) throw new Error(first.code);
    const second = await world.service.extend(
      DOCUMENT_SERVICE_SECRET,
      cmd(first.pdf, 'r2', { validation: false }),
    );
    if (!second.ok) throw new Error(second.code);
    expect(startsWith(second.pdf, first.pdf)).toBe(true);
    expect(second.validationAdded).toBe(false);
    expect(count(second.pdf, /\/Type \/DocTimeStamp/g)).toBe(2);
    expect(count(second.pdf, /\/Type \/DSS/g)).toBe(count(first.pdf, /\/Type \/DSS/g));
    for (const r of verifyWithOpenssl(second.pdf, pki)) expect(r.main.ok, r.main.detail).toBe(true);
    expect((await verifySealedPdf(second.pdf, [pki.root])).ok).toBe(true);
  }, 120_000);

  it('a repeat with the same key returns the first result and adds no second time-stamp', async () => {
    down = false;
    const before = stamps;
    const a = await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(sealed, 'same'));
    const mid = stamps;
    const b = await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(sealed, 'same'));
    if (!a.ok || !b.ok) throw new Error('not ok');
    expect(mid - before).toBe(1);
    expect(stamps).toBe(mid);
    expect(sha256Hex(b.pdf)).toBe(sha256Hex(a.pdf));
    expect(
      world.audit.entries.filter(
        (e) => e.event === 'extend.extended' && e.pdfSha256 === sha256Hex(sealed),
      ).length,
    ).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it('an authority that is down gives no update, is retryable and is audited', async () => {
    down = true;
    const out = await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(sealed, 'down'));
    expect(out).toEqual({ ok: false, code: 'tsa_unreachable', retryable: true });
    expect(
      world.audit.entries.some((e) => e.event === 'extend.failed' && e.code === 'tsa_unreachable'),
    ).toBe(true);
    down = false;
    // The same key later does the work: a failure is not served again.
    const later = await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(sealed, 'down'));
    expect(later.ok).toBe(true);
  }, 120_000);

  it('refuses no credential, the export worker, a wrong hash, a PDF with no signature and a bad request', async () => {
    expect(await world.service.extend(null, cmd(sealed, 'x'))).toMatchObject({
      code: 'unauthenticated',
    });
    expect(await world.service.extend(WORKER_SECRET, cmd(sealed, 'x'))).toMatchObject({
      code: 'wrong_caller',
    });
    expect(
      await world.service.extend(
        DOCUMENT_SERVICE_SECRET,
        cmd(sealed, 'x', { pdfSha256: 'ab'.repeat(32) }),
      ),
    ).toMatchObject({ code: 'hash_mismatch' });
    expect(await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(sealed, ''))).toMatchObject({
      code: 'bad_request',
    });
    expect(await world.service.extend(DOCUMENT_SERVICE_SECRET, cmd(input, 'plain'))).toMatchObject({
      ok: false,
      code: 'seal_failed',
    });
  }, 60_000);
});
