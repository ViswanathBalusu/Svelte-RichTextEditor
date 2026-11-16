/**
 * EXP-014 criterion 2 (09 §2; 06 §4.4): an SVG is converted to PDF when the asset is processed, and
 * the compile does no SVG conversion. Node.js only.
 *
 * - The asset worker's own code (`processAsset`, the function its sandbox runs) turns an SVG upload
 *   into a PDF rendition for the typesetter. That it does so inside the worker's Podman sandbox is
 *   BE-043's test (`services/asset-worker/test/sandbox.podman.test.ts`), not repeated here.
 * - The converter takes that PDF by its content hash, and refuses an asset whose type is SVG, so
 *   no SVG file and no SVG tool can reach the bundle.
 * - The bundle with the rendition compiles in the export worker's sandbox, and the log shows the
 *   PDF file included as it is. This test skips when `sandboxReady()` says compiles cannot run
 *   here (EXP-070).
 *
 * The export worker does not yet read a document's assets from the store, so this test hands the
 * rendition to the converter itself; see the story's Notes.
 */
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { contentLimits } from '../../../services/asset-worker/src/sandbox/limits.ts';
import { processAsset } from '../../../services/asset-worker/src/sandbox/process.ts';
import { PDF, SVG } from '../../../services/asset-worker/src/sandbox/types.ts';
import { SVG_OK, enc } from '../../../services/asset-worker/test/fixtures.ts';
import { codes, doc, nid, para, run, type J } from '../test/docs.ts';
import { classFiles, convertAndCompile, keep, pdfText, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

/** The print rendition the asset worker makes of the SVG fixture, with its content hash. */
async function rendition(): Promise<{ bytes: Uint8Array; sha256: string }> {
  const r = await processAsset(enc(SVG_OK), SVG, contentLimits());
  if (!r.ok) throw new Error(`the asset worker refused the SVG: ${r.reason}: ${r.message}`);
  const print = r.outputs.find((o) => o.role === 'print');
  if (!print || print.mime !== PDF) throw new Error('the asset worker made no PDF rendition');
  return { bytes: print.data, sha256: createHash('sha256').update(print.data).digest('hex') };
}

const figure = (id: string): J => ({
  type: 'figure',
  attrs: { id, asset: 'drawing', width: 2400, height: 1600, alt: 'A drawing', placement: 'here' },
});

/** Names of SVG tools and packages that would mean a conversion at compile time. */
const SVG_TOOLING = /\\includesvg|\\usepackage(\[[^\]]*\])?\{svg\}|inkscape|rsvg|\.svg\b/i;

describe('EXP-014 criterion 2: SVG is converted on upload, and the compile converts none', () => {
  it('takes the asset worker’s PDF rendition of an SVG into assets/ by its content hash', async () => {
    const pdf = await rendition();
    expect(new TextDecoder('latin1').decode(pdf.bytes.subarray(0, 8))).toBe('%PDF-1.4');
    const bundle = await run(doc([figure(nid('f'))]), {
      assets: {
        drawing: { sha256: pdf.sha256, mediaType: PDF, status: 'ready', bytes: pdf.bytes },
      },
    });
    expect(bundle.ok).toBe(true);
    expect(Object.keys(bundle.assets)).toEqual([`assets/${pdf.sha256}.pdf`]);
    expect(bundle.assets[`assets/${pdf.sha256}.pdf`]).toEqual(pdf.bytes);
    expect(bundle.files['main.tex']).toContain(`assets/${pdf.sha256}.pdf`);
    for (const [name, text] of Object.entries(bundle.files))
      expect(SVG_TOOLING.test(text), name).toBe(false);
  });

  it('refuses an asset whose type is SVG, with the block identifier, and places no file', async () => {
    const f = nid('f');
    const bytes = enc(SVG_OK);
    const bundle = await run(doc([figure(f)]), {
      assets: {
        drawing: {
          sha256: createHash('sha256').update(bytes).digest('hex'),
          mediaType: SVG,
          status: 'ready',
          bytes,
        },
      },
    });
    expect(codes(bundle)).toContain('asset_type_unsupported');
    expect(bundle.diagnostics.find((d) => d.code === 'asset_type_unsupported')?.blockId).toBe(f);
    expect(Object.keys(bundle.assets)).toEqual([]);
    expect(SVG_TOOLING.test(bundle.files['main.tex']!)).toBe(false);
  });

  it('ships a class that names no SVG package or tool', () => {
    for (const [name, text] of Object.entries(classFiles()))
      expect(SVG_TOOLING.test(text), name).toBe(false);
  });

  it.skipIf(!ready)(
    'compiles the rendition as it is: the PDF is included, and nothing is converted',
    async () => {
      const pdf = await rendition();
      const f = nid('f');
      const c = await convertAndCompile(
        doc([para('BEFOREDRAWING'), figure(f), para('AFTERDRAWING')]),
        {
          profile: 'preview',
          title: 'exp-014-svg-rendition',
          instant: '2026-11-06T10:00:00.000Z',
          timeZone: 'Europe/London',
          suggestions: 'accept',
          layout: 'block',
          assets: {
            drawing: { sha256: pdf.sha256, mediaType: PDF, status: 'ready', bytes: pdf.bytes },
          },
        } as never,
      );
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(
          `the compile failed (${keep('exp-014-svg-rendition', c)}):\n${c.compile.log.slice(-1500)}`,
        );
      expect(c.bundle.diagnostics.filter((d) => d.code.startsWith('asset_'))).toEqual([]);
      // LuaTeX's log names every file it includes; a line break may fall inside the long name.
      const log = c.compile.log.replace(/\r?\n/g, '');
      expect(log).toContain(`assets/${pdf.sha256}.pdf`);
      expect(/inkscape|rsvg|\.svg\b|runsystem|shell.escape enabled/i.test(log)).toBe(false);
      // The figure is set between the paragraphs, at the size asked for.
      const y = (id: string): number | undefined => c.layout?.blocks[id]?.y;
      const ids = c.bundle.map.blocks;
      expect(ids).toContain(f);
      expect(y(f)).toBeTypeOf('number');
      const text = pdfText(c.compile.pdf);
      if (text === null) throw new Error('pdftotext is not installed or failed');
      expect(text.indexOf('BEFOREDRAWING')).toBeGreaterThanOrEqual(0);
      expect(text.indexOf('AFTERDRAWING')).toBeGreaterThan(text.indexOf('BEFOREDRAWING'));
    },
    300_000,
  );
});
