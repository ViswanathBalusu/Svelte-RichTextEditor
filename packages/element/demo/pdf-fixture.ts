/**
 * A one-page PDF that exercises PDF.js's optional WebAssembly decoders (spike S2; ADR 0016):
 *
 * - a rectangle filled in an ICC-based CMYK colour space (PDF.js converts it with qcms_bg.wasm, or
 *   falls back to its DeviceCMYK conversion), using the ICC profile PDF.js itself ships;
 * - a 16 by 16 black image in CCITT Group 4 (decoded by jbig2.wasm, or its JavaScript fallback);
 * - a line of text in Helvetica (PDF.js loads its standard font data).
 *
 * Geometry, in points from the bottom left of a 200 by 200 page: fill at (20, 20, 60, 60), image at
 * (110, 110, 60, 60). features/pdf.ts samples those places.
 */
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';

const require = createRequire(import.meta.url);

function iccProfile(): Buffer {
  const pkg = dirname(require.resolve('pdfjs-dist/package.json'));
  return readFileSync(join(pkg, 'iccs', 'CGATS001Compat-v2-micro.icc'));
}

/** A 16 by 16 all-black image in CCITT T.6 (Group 4), K = -1, BlackIs1 false. */
function blackSquareG4(rows = 16): Buffer {
  // Line 1 against the imaginary white reference line: horizontal mode (001), white run 0
  // (00110101), black run 16 (0000010111). Every later line: two V0 codes (1, 1).
  // End of facsimile block: two EOL codes (000000000001 twice).
  let bits = '001' + '00110101' + '0000010111';
  for (let i = 1; i < rows; i++) bits += '11';
  bits += '000000000001000000000001';
  while (bits.length % 8) bits += '0';
  const out = Buffer.alloc(bits.length / 8);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(bits.slice(i * 8, i * 8 + 8), 2);
  return out;
}

export type FixturePart = 'fill' | 'image' | 'text';

/** The fixture; `parts` limits the page content, for bisecting a behaviour. */
export function pdfFixture(parts: readonly FixturePart[] = ['fill', 'image', 'text']): Buffer {
  const icc = iccProfile();
  const g4 = blackSquareG4();
  const operators: Record<FixturePart, string> = {
    fill: 'q /CS0 cs 0 1 1 0 sc 20 20 60 60 re f Q',
    image: 'q 60 0 0 60 110 110 cm /Im1 Do Q',
    text: 'BT /F1 12 Tf 20 180 Td (Strict policy) Tj ET',
  };
  const content = Buffer.from(parts.map((p) => operators[p]).join('\n'), 'latin1');

  const objects: Buffer[] = [];
  const obj = (body: Buffer | string) =>
    objects.push(typeof body === 'string' ? Buffer.from(body, 'latin1') : body);
  const stream = (dict: string, data: Buffer) =>
    Buffer.concat([
      Buffer.from(`<< ${dict} /Length ${data.length} >>\nstream\n`, 'latin1'),
      data,
      Buffer.from('\nendstream', 'latin1'),
    ]);

  obj('<< /Type /Catalog /Pages 2 0 R >>');
  obj('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  obj(
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Contents 4 0 R ' +
      '/Resources << /ColorSpace << /CS0 [/ICCBased 5 0 R] >> /XObject << /Im1 6 0 R >> /Font << /F1 7 0 R >> >> >>',
  );
  obj(stream('', content));
  obj(stream('/N 4 /Alternate /DeviceCMYK', icc));
  obj(
    stream(
      '/Type /XObject /Subtype /Image /Width 16 /Height 16 /ColorSpace /DeviceGray /BitsPerComponent 1 ' +
        '/Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns 16 /Rows 16 >>',
      g4,
    ),
  );
  obj('<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>');

  const chunks: Buffer[] = [Buffer.from('%PDF-1.7\n%\xE2\xE3\xCF\xD3\n', 'latin1')];
  const offsets: number[] = [];
  let length = chunks[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([
      Buffer.from(`${i + 1} 0 obj\n`, 'latin1'),
      body,
      Buffer.from('\nendobj\n', 'latin1'),
    ]);
    chunks.push(chunk);
    length += chunk.length;
  });
  const xref = [
    'xref',
    `0 ${objects.length + 1}`,
    '0000000000 65535 f ',
    ...offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n `),
    'trailer',
    `<< /Size ${objects.length + 1} /Root 1 0 R >>`,
    'startxref',
    String(length),
    '%%EOF',
    '',
  ].join('\n');
  chunks.push(Buffer.from(xref, 'latin1'));
  return Buffer.concat(chunks);
}
