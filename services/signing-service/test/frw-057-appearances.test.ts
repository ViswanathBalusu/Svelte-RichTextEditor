/**
 * FRW-057 at the signing service: visible appearances are drawn at the field positions of the
 * layout, after the compile and before the signature, so that the signature covers them and the
 * compile pair is untouched. A field with no rectangle, an entry that is not valid and a rectangle
 * outside its page are reported and the seal still goes on.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createSigningServer } from '../src/http.ts';
import { HttpTimestampAuthority } from '../src/cms.ts';
import { PdfDocument } from '../src/pdf.ts';
import { verifySealedPdf } from '../src/verify-sealed.ts';
import type { AppearanceRequest } from '../src/service.ts';
import { classicPdf } from './support/classic-pdf.ts';
import { makePki, opensslAvailable, type TestPki } from './support/pki.ts';
import {
  command,
  DOCUMENT_SERVICE_SECRET,
  makeWorld,
  type World,
} from './support/service-world.ts';
import { startTestTsa, type TestTsa } from './support/tsa.ts';
import { findSignatures, verifyWithOpenssl } from './support/verify.ts';
import { flipByte, InProcessKeyService, startsWith } from './support/world.ts';

const text = (b: Uint8Array) => Buffer.from(b).toString('latin1');

describe.skipIf(!opensslAvailable())('visible appearances at the field positions (FRW-057)', () => {
  let pki: TestPki;
  let tsa: TestTsa;
  let ks: InProcessKeyService;
  let world: World;
  const input = classicPdf();

  const request = (layout: Record<string, unknown>): AppearanceRequest => ({
    layout,
    targets: [
      {
        id: 'fieldA',
        key: 'tenant.sign',
        kind: 'signature',
        lines: ['Electronically signed', 'Ada', '2026-11-18'],
      },
      { id: 'fieldB', key: 'tenant.initials', kind: 'initials', lines: ['Initialled'] },
      { id: 'fieldC', key: 'tenant.name', kind: 'text', lines: ['never drawn'] },
    ],
  });
  // The page is 200 by 200 points: 4000 twips. A rectangle from 20 to 120 points across and 150 to 180
  // down is, in PDF points from the lower left, [20 20 120 50].
  const GOOD = {
    fieldA: { page: 1, rect: [400, 3000, 2400, 3600] },
    fieldB: { page: 1, rect: [2600, 3000, 3200, 3400] },
  };

  beforeAll(async () => {
    ks = new InProcessKeyService();
    pki = makePki(await ks.publicKey());
    tsa = await startTestTsa(pki);
    world = makeWorld({
      operator: { id: 'operator-key', keyService: ks, pki },
      tsaUrl: tsa.url,
      timestamps: new HttpTimestampAuthority(tsa.url),
    });
  }, 300_000);
  afterAll(async () => {
    await tsa?.stop();
    pki?.remove();
  });

  it('draws an appearance inside the rectangle of each signature and initials field, and the seal covers them', async () => {
    const out = await world.service.seal(DOCUMENT_SERVICE_SECRET, {
      ...command(input),
      appearances: request(GOOD),
    });
    if (!out.ok) throw new Error(out.code);
    expect(out.appearances).toEqual({ drawn: ['fieldA', 'fieldB'], diagnostics: [] });
    // The input is still the first bytes; the appearances come after it and before the signature.
    expect(startsWith(out.pdf, input)).toBe(true);
    const pdf = text(out.pdf);
    expect(pdf).toContain('/Rect [20 20 120 50]');
    expect(pdf).toContain('/Rect [130 30 160 50]');
    expect(pdf).toContain('(Electronically signed) Tj');
    expect(pdf.match(/\/Subtype \/Stamp/g)).toHaveLength(2);
    expect(pdf).not.toContain('never drawn');
    // The page lists the two annotations and the seal's own field.
    const page = new PdfDocument(out.pdf).pageList()[0]!;
    expect((page.dict.get('Annots') as unknown[]).length).toBe(3);
    // The signature validates, and it covers the appearances: a changed byte in one is detected.
    const reports = verifyWithOpenssl(out.pdf, pki);
    expect(reports).toHaveLength(1);
    expect(reports[0]!.main.ok, reports[0]!.main.detail).toBe(true);
    expect((await verifySealedPdf(out.pdf, [pki.root])).ok).toBe(true);
    const at = pdf.indexOf('(Electronically signed)');
    expect(verifyWithOpenssl(flipByte(out.pdf, at + 3), pki)[0]!.main.ok).toBe(false);
    expect(findSignatures(out.pdf)[0]!.byteRange[1]).toBeGreaterThan(at);
  }, 120_000);

  it('does not change what the compile pair is checked against: the pair is of the input', async () => {
    const cmd = command(input);
    const out = await world.service.seal(DOCUMENT_SERVICE_SECRET, {
      ...cmd,
      appearances: request(GOOD),
    });
    expect(out.ok).toBe(true);
    // A pair of the bytes with appearances is not the compile: it is refused as before.
    const drawn = (out as { pdf: Uint8Array }).pdf;
    const again = await world.service.seal(DOCUMENT_SERVICE_SECRET, {
      ...command(drawn, { seq: 99 }),
      compileSha256: cmd.compileSha256,
    });
    expect(again).toMatchObject({ ok: false, code: 'pair_differs' });
  }, 120_000);

  it('seals without an appearance for a field with no rectangle, and says so', async () => {
    const out = await world.service.seal(DOCUMENT_SERVICE_SECRET, {
      ...command(input, { seq: 11 }),
      appearances: request({ fieldA: GOOD.fieldA }),
    });
    if (!out.ok) throw new Error(out.code);
    expect(out.appearances!.drawn).toEqual(['fieldA']);
    expect(out.appearances!.diagnostics).toEqual([
      expect.objectContaining({ id: 'fieldB', key: 'tenant.initials', code: 'no_rectangle' }),
    ]);
    for (const r of verifyWithOpenssl(out.pdf, pki)) expect(r.main.ok, r.main.detail).toBe(true);
  }, 120_000);

  it('does not use a rectangle outside its page, a page that does not exist, or an entry that is not valid', async () => {
    const out = await world.service.seal(DOCUMENT_SERVICE_SECRET, {
      ...command(input, { seq: 12 }),
      appearances: request({
        fieldA: { page: 1, rect: [400, 3000, 5000, 3600] },
        fieldB: { page: 2, rect: [400, 3000, 800, 3600] },
        fieldX: { page: 1, rect: [900, 100, 100, 200] },
      }),
    });
    if (!out.ok) throw new Error(out.code);
    expect(out.appearances!.drawn).toEqual([]);
    expect(out.appearances!.diagnostics.map((d) => [d.id, d.code]).sort()).toEqual([
      ['fieldA', 'rect_outside_page'],
      ['fieldB', 'unknown_page'],
      ['fieldX', 'entry_invalid'],
    ]);
    expect(text(out.pdf)).not.toContain('/Subtype /Stamp');
    expect(verifyWithOpenssl(out.pdf, pki)[0]!.main.ok).toBe(true);
  }, 120_000);

  it('is requested and answered over HTTP', async () => {
    const server = createSigningServer(world.service, { maxBodyBytes: 5_000_000 });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const addr = server.address();
    if (!addr || typeof addr === 'string') throw new Error('no address');
    try {
      const cmd = command(input, { seq: 13 });
      const res = await fetch(`http://127.0.0.1:${addr.port}/v1/seal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${DOCUMENT_SERVICE_SECRET}`,
        },
        body: JSON.stringify({
          tenant: cmd.tenant,
          documentId: cmd.documentId,
          seq: cmd.seq,
          pdfSha256: cmd.pdfSha256,
          compileSha256: cmd.compileSha256,
          pdf: Buffer.from(input).toString('base64'),
          appearances: request(GOOD),
        }),
      });
      const wire = (await res.json()) as {
        ok: boolean;
        appearances: { drawn: string[] };
        pdf: string;
      };
      expect(res.status).toBe(200);
      expect(wire.appearances.drawn).toEqual(['fieldA', 'fieldB']);
      expect(text(new Uint8Array(Buffer.from(wire.pdf, 'base64')))).toContain('/Subtype /Stamp');
      // A request whose appearances are not of the shape is a bad request.
      const bad = await fetch(`http://127.0.0.1:${addr.port}/v1/seal`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${DOCUMENT_SERVICE_SECRET}`,
        },
        body: JSON.stringify({
          tenant: 't',
          documentId: 'd',
          seq: 1,
          pdfSha256: cmd.pdfSha256,
          compileSha256: cmd.compileSha256,
          pdf: Buffer.from(input).toString('base64'),
          appearances: { layout: 1, targets: 'x' },
        }),
      });
      expect(bad.status).toBe(400);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  }, 120_000);
});
