/**
 * EXP-034 criterion 1 in the Podman sandbox (Node.js only; lane V-EXP-033-048, round 12): a signature
 * field whose value names a PNG asset is compiled, and the compiled PDF holds that image at its own
 * pixel size, with the field's label as the alternative text of the tagged span. The display width
 * is the field's width; the picture's height follows the PNG's proportions.
 *
 * The test reads the PDF's objects (raw and inflated Flate streams) for the image dictionary. It skips
 * when `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { makePng, sha256Hex } from '../test/exp-034-png.ts';
import { convertAndCompile, firstError, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const OPTIONS = {
  profile: 'preview',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
} as const;
const FIELD_WIDTH_TWIPS = 2880; // 144 pt
const LABEL = 'Signature of the applicant';

/** The PDF as text: the raw file and the inflated contents of every Flate stream. */
function pdfObjectText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      parts.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a Flate stream; its dictionary is still in the raw text.
    }
  }
  return parts.join('\n');
}

describe.skipIf(!ready)('EXP-034 criterion 1: a signature picture is compiled into the PDF', () => {
  it('embeds the PNG at its pixel size and the field keeps its label as alternative text', async () => {
    const bytes = makePng(200, 100, [20, 20, 160]);
    const asset = {
      sha256: sha256Hex(bytes),
      mediaType: 'image/png',
      status: 'ready' as const,
      bytes,
    };
    const field: J = {
      type: 'form_field',
      attrs: {
        id: nid('ff'),
        key: 'sig',
        kind: 'signature',
        label: LABEL,
        width: FIELD_WIDTH_TWIPS,
        value: { asset: 'sig1', mode: 'drawn' },
      },
    };
    const p = para('Signed: ', { id: nid('p') }, [field]);
    const c = await convertAndCompile(doc([p]), { ...OPTIONS, assets: { sig1: asset } } as never);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(
        `the compile failed (${keep('exp-034-signature', c)}):\n${firstError(c.compile.log)}`,
      );

    const objects = pdfObjectText(c.compile.pdf);
    // The image dictionary of the 200 by 100 pixel PNG.
    expect(objects).toMatch(
      /\/Subtype\s*\/Image[\s\S]{0,200}?\/Width\s+200[\s\S]{0,40}?\/Height\s+100/,
    );
    // The field's label is the alternative text of the tagged span and of the picture (EXP-033 criterion 1):
    // PDF text strings are UTF-16BE with a byte order mark, in hexadecimal.
    let hex = 'FEFF';
    for (const ch of LABEL) hex += ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();
    expect(objects).toContain(`/Alt <${hex}>`);
  }, 900_000);
});
