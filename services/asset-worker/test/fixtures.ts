/**
 * Test files, built in code so that every hostile case says exactly what it contains: valid PNG,
 * JPEG, GIF, SVG and Word files, and their hostile variants (pixel bombs, decompression bombs,
 * frame bombs, archive bombs, truncations, polyglots, wrong types).
 */
import { crc32, deflateRawSync, deflateSync } from 'node:zlib';
import jpeg from 'jpeg-js';
import { GifWriter } from 'omggif';
import { PNG as PngJs } from 'pngjs';

export const enc = (s: string): Uint8Array => new TextEncoder().encode(s);

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.length;
  }
  return out;
}

const u32be = (v: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, v >>> 0, false);
  return b;
};

/** RGBA pixels: a gradient with a translucent corner. */
export function rgba(width: number, height: number, opaque = false): Uint8Array {
  const d = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 4;
      d[i] = (x * 255) / Math.max(1, width - 1);
      d[i + 1] = (y * 255) / Math.max(1, height - 1);
      d[i + 2] = 128;
      d[i + 3] = opaque || x > width / 2 || y > height / 2 ? 255 : 128;
    }
  return d;
}

// --- PNG ----------------------------------------------------------------------------------------

export interface Chunk {
  type: string;
  data: Uint8Array;
}

export function pngChunk(type: string, data: Uint8Array): Uint8Array {
  const t = enc(type);
  return concat(u32be(data.length), t, data, u32be(crc32(concat(t, data))));
}

export const PNG_SIGNATURE = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function buildPng(chunks: readonly Chunk[]): Uint8Array {
  return concat(PNG_SIGNATURE, ...chunks.map((c) => pngChunk(c.type, c.data)));
}

export function readChunks(png: Uint8Array): Chunk[] {
  const out: Chunk[] = [];
  let o = 8;
  const v = new DataView(png.buffer, png.byteOffset, png.byteLength);
  while (o + 12 <= png.length) {
    const len = v.getUint32(o, false);
    const type = String.fromCharCode(...png.subarray(o + 4, o + 8));
    out.push({ type, data: png.slice(o + 8, o + 8 + len) });
    o += 12 + len;
    if (type === 'IEND') break;
  }
  return out;
}

export function ihdr(
  width: number,
  height: number,
  depth = 8,
  colour = 6,
  interlace = 0,
): Uint8Array {
  return concat(u32be(width), u32be(height), new Uint8Array([depth, colour, 0, 0, interlace]));
}

/** A valid RGBA PNG made by pngjs, with text, Exif-like and time chunks added before IDAT. */
export function png(
  width = 48,
  height = 32,
  opts: { interlace?: boolean; extras?: boolean } = {},
): Uint8Array {
  const p = new PngJs({ width, height });
  p.data = Buffer.from(rgba(width, height));
  const plain = new Uint8Array(PngJs.sync.write(p, { colorType: 6 }));
  let chunks = readChunks(plain);
  if (opts.interlace) {
    // Re-encode the same pixels as Adam7 by hand: filter type 0 for every scanline of every pass.
    const px = rgba(width, height);
    const passes = [
      [0, 0, 8, 8],
      [4, 0, 8, 8],
      [0, 4, 4, 8],
      [2, 0, 4, 4],
      [0, 2, 2, 4],
      [1, 0, 2, 2],
      [0, 1, 1, 2],
    ] as const;
    const rows: number[] = [];
    for (const [x0, y0, dx, dy] of passes) {
      if (width <= x0 || height <= y0) continue;
      for (let y = y0; y < height; y += dy) {
        rows.push(0);
        for (let x = x0; x < width; x += dx) {
          const i = (y * width + x) * 4;
          rows.push(px[i]!, px[i + 1]!, px[i + 2]!, px[i + 3]!);
        }
      }
    }
    chunks = [
      { type: 'IHDR', data: ihdr(width, height, 8, 6, 1) },
      { type: 'IDAT', data: new Uint8Array(deflateSync(Uint8Array.from(rows))) },
      { type: 'IEND', data: new Uint8Array() },
    ];
  }
  if (opts.extras !== false) {
    const extras: Chunk[] = [
      { type: 'tEXt', data: enc('Comment\0secret location 51.5N 0.1W <script>alert(1)</script>') },
      { type: 'eXIf', data: enc('MM\0*\0\0\0\x08GPS-secret') },
      { type: 'tIME', data: new Uint8Array([0x07, 0xea, 11, 6, 12, 0, 0]) },
    ];
    chunks.splice(1, 0, ...extras);
  }
  return buildPng(chunks);
}

/** A PNG whose header declares `width` × `height` with almost no image data (a pixel bomb). */
export function pngPixelBomb(width: number, height: number): Uint8Array {
  return buildPng([
    { type: 'IHDR', data: ihdr(width, height, 8, 2) },
    { type: 'IDAT', data: new Uint8Array(deflateSync(new Uint8Array(1024))) },
    { type: 'IEND', data: new Uint8Array() },
  ]);
}

/** A small PNG whose image data inflates to `inflatedMiB` MiB of zeros (a decompression bomb). */
export function pngInflateBomb(inflatedMiB: number, interlace = false): Uint8Array {
  const zeros = new Uint8Array(inflatedMiB * 1024 * 1024);
  return buildPng([
    { type: 'IHDR', data: ihdr(64, 64, 8, 6, interlace ? 1 : 0) },
    { type: 'IDAT', data: new Uint8Array(deflateSync(zeros, { level: 9 })) },
    { type: 'IEND', data: new Uint8Array() },
  ]);
}

/** An APNG that announces `frames` frames (its extra frames need not exist for the check). */
export function apng(frames: number): Uint8Array {
  const chunks = readChunks(png(16, 16, { extras: false }));
  const actl = concat(u32be(frames), u32be(0));
  chunks.splice(1, 0, { type: 'acTL', data: actl });
  return buildPng(chunks);
}

// --- JPEG ---------------------------------------------------------------------------------------

export function jpegOf(width = 48, height = 32, pixels?: Uint8Array): Uint8Array {
  const e = jpeg.encode({ data: pixels ?? rgba(width, height, true), width, height }, 90);
  return new Uint8Array(e.data.buffer, e.data.byteOffset, e.data.byteLength);
}

/** An Exif APP1 payload (big-endian TIFF) with an orientation and a GPS-like ASCII tag. */
export function exifApp1(orientation: number): Uint8Array {
  const tiff = [
    0x4d,
    0x4d,
    0x00,
    0x2a,
    0x00,
    0x00,
    0x00,
    0x08, // header, IFD0 at 8
    0x00,
    0x02, // two entries
    0x01,
    0x12,
    0x00,
    0x03,
    0x00,
    0x00,
    0x00,
    0x01,
    0x00,
    orientation,
    0x00,
    0x00, // orientation
    0x01,
    0x0f,
    0x00,
    0x02,
    0x00,
    0x00,
    0x00,
    0x04,
    0x41,
    0x43,
    0x4d,
    0x00, // Make = "ACM"
    0x00,
    0x00,
    0x00,
    0x00, // no next IFD
  ];
  const payload = concat(enc('Exif\0\0'), Uint8Array.from(tiff), enc('GPS 51.5074N 0.1278W'));
  const len = payload.length + 2;
  return concat(new Uint8Array([0xff, 0xe1, len >> 8, len & 255]), payload);
}

export function jpegSegment(marker: number, payload: Uint8Array): Uint8Array {
  const len = payload.length + 2;
  return concat(new Uint8Array([0xff, marker, len >> 8, len & 255]), payload);
}

/** Inserts segments right after SOI. */
export function withSegments(j: Uint8Array, ...segments: Uint8Array[]): Uint8Array {
  return concat(j.subarray(0, 2), ...segments, j.subarray(2));
}

/** Sets the frame header's dimensions of a baseline JPEG. */
export function jpegWithSize(j: Uint8Array, width: number, height: number): Uint8Array {
  const out = Uint8Array.from(j);
  for (let i = 2; i + 9 < out.length; i++)
    if (out[i] === 0xff && out[i + 1] === 0xc0) {
      out[i + 5] = height >> 8;
      out[i + 6] = height & 255;
      out[i + 7] = width >> 8;
      out[i + 8] = width & 255;
      return out;
    }
  throw new Error('no SOF0');
}

/** A progressive frame header followed by `scans` start-of-scan segments (a scan bomb). */
export function jpegScanBomb(scans: number): Uint8Array {
  const sof2 = jpegSegment(0xc2, Uint8Array.from([8, 0, 16, 0, 16, 1, 1, 0x11, 0]));
  const sos = concat(
    jpegSegment(0xda, Uint8Array.from([1, 1, 0, 0, 63, 0])),
    new Uint8Array([0x12, 0x34]),
  );
  const parts: Uint8Array[] = [new Uint8Array([0xff, 0xd8]), sof2];
  for (let i = 0; i < scans; i++) parts.push(sos);
  parts.push(new Uint8Array([0xff, 0xd9]));
  return concat(...parts);
}

// --- GIF ----------------------------------------------------------------------------------------

/** A GIF of `frames` frames of `w` × `h` with a four-colour palette, a loop count and a comment. */
export function gifOf(
  frames = 2,
  w = 20,
  h = 10,
  opts: { comment?: boolean; frameW?: number; frameH?: number } = {},
): Uint8Array {
  const fw = opts.frameW ?? w;
  const fh = opts.frameH ?? h;
  const buf = new Uint8Array(1024 + frames * (fw * fh * 2 + 64));
  const writer = new GifWriter(buf, w, h, { loop: 0 });
  for (let f = 0; f < frames; f++) {
    const px: number[] = [];
    for (let i = 0; i < fw * fh; i++) px.push((i + f) % 4);
    writer.addFrame(0, 0, fw, fh, px, {
      palette: [0xff0000, 0x00ff00, 0x0000ff, 0xffffff],
      delay: 10,
      disposal: 1,
      transparent: 3,
    });
  }
  let out: Uint8Array = buf.slice(0, writer.end());
  if (opts.comment !== false) {
    // A comment extension with a payload, after the header and logical screen.
    const comment = concat(
      new Uint8Array([0x21, 0xfe, 24]),
      enc('<script>alert(1)</script'.slice(0, 24)),
      new Uint8Array([0]),
    );
    out = concat(out.subarray(0, 13), comment, out.subarray(13));
  }
  return out;
}

/** A GIF whose logical screen is `w` × `h` (a pixel bomb). */
export function gifScreen(w: number, h: number): Uint8Array {
  const g = gifOf(1, 4, 4, { comment: false });
  const out = Uint8Array.from(g);
  out[6] = w & 255;
  out[7] = w >> 8;
  out[8] = h & 255;
  out[9] = h >> 8;
  return out;
}

// --- ZIP and Word files ---------------------------------------------------------------------------

export interface ZipSpec {
  name: string;
  data: Uint8Array;
  method?: 0 | 8;
  /** Overrides of what the directory claims. */
  size?: number;
  compressedSize?: number;
  crc?: number;
  flags?: number;
}

export interface ZipOptions {
  prefix?: Uint8Array;
  /** Bytes between the first entry and the second. */
  gap?: Uint8Array;
  comment?: string;
  /** Point the second directory entry at the first entry's data (overlapping entries). */
  overlap?: boolean;
}

export function zip(entries: readonly ZipSpec[], opts: ZipOptions = {}): Uint8Array {
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = opts.prefix?.length ?? 0;
  const offsets: number[] = [];
  for (const e of entries) {
    const method = e.method ?? 8;
    const comp = method === 8 ? new Uint8Array(deflateRawSync(e.data)) : e.data;
    const name = enc(e.name);
    const crc = e.crc ?? crc32(e.data);
    const size = e.size ?? e.data.length;
    const csize = e.compressedSize ?? comp.length;
    const flags = e.flags ?? 0x800;
    const lh = new DataView(new ArrayBuffer(30));
    lh.setUint32(0, 0x04034b50, true);
    lh.setUint16(4, 20, true);
    lh.setUint16(6, flags, true);
    lh.setUint16(8, method, true);
    lh.setUint16(12, 0x21, true);
    lh.setUint32(14, crc, true);
    lh.setUint32(18, csize, true);
    lh.setUint32(22, size, true);
    lh.setUint16(26, name.length, true);
    const local = concat(new Uint8Array(lh.buffer), name, comp);
    offsets.push(offset);
    const at = opts.overlap && offsets.length === 2 ? offsets[0]! : offset;
    const ch = new DataView(new ArrayBuffer(46));
    ch.setUint32(0, 0x02014b50, true);
    ch.setUint16(4, 20, true);
    ch.setUint16(6, 20, true);
    ch.setUint16(8, flags, true);
    ch.setUint16(10, method, true);
    ch.setUint16(14, 0x21, true);
    ch.setUint32(16, crc, true);
    ch.setUint32(20, csize, true);
    ch.setUint32(24, size, true);
    ch.setUint16(28, name.length, true);
    ch.setUint32(42, at, true);
    centrals.push(concat(new Uint8Array(ch.buffer), name));
    if (!(opts.overlap && offsets.length === 2)) {
      locals.push(local);
      offset += local.length;
    }
    if (opts.gap && offsets.length === 1) {
      locals.push(opts.gap);
      offset += opts.gap.length;
    }
  }
  const cd = concat(...centrals);
  const comment = enc(opts.comment ?? '');
  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, entries.length, true);
  eocd.setUint16(10, entries.length, true);
  eocd.setUint32(12, cd.length, true);
  eocd.setUint32(16, offset, true);
  eocd.setUint16(20, comment.length, true);
  return concat(
    opts.prefix ?? new Uint8Array(),
    ...locals,
    cd,
    new Uint8Array(eocd.buffer),
    comment,
  );
}

export const CONTENT_TYPES =
  '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>';

export function docxEntries(
  extra: readonly ZipSpec[] = [],
  contentTypes = CONTENT_TYPES,
): ZipSpec[] {
  return [
    { name: '[Content_Types].xml', data: enc(contentTypes) },
    {
      name: '_rels/.rels',
      data: enc(
        '<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>',
      ),
    },
    {
      name: 'word/document.xml',
      data: enc(
        '<?xml version="1.0" encoding="UTF-8"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Hello</w:t></w:r></w:p></w:body></w:document>',
      ),
    },
    ...extra,
  ];
}

export function docx(extra: readonly ZipSpec[] = [], opts: ZipOptions = {}): Uint8Array {
  return zip(docxEntries(extra), opts);
}

// --- SVG ----------------------------------------------------------------------------------------

export const SVG_OK = `<?xml version="1.0" encoding="UTF-8"?>
<!-- a comment -->
<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape" width="120" height="80" viewBox="0 0 120 80" inkscape:version="1.3">
  <title>A test drawing</title>
  <metadata><inkscape:secret>author's home address</inkscape:secret></metadata>
  <style>.blue { fill: #0057b8; } #star { stroke: rgb(255, 215, 0); stroke-width: 2 }</style>
  <defs>
    <linearGradient id="g1" x1="0" y1="0" x2="1" y2="0"><stop offset="0" stop-color="red"/><stop offset="1" stop-color="blue"/></linearGradient>
    <radialGradient id="g2" xlink:href="#g1" cx="0.5" cy="0.5" r="0.5"/>
    <clipPath id="clip"><circle cx="60" cy="40" r="30"/></clipPath>
    <symbol id="dot" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="green"/></symbol>
  </defs>
  <rect x="5" y="5" width="50" height="30" rx="4" fill="url(#g1)"/>
  <rect class="blue" x="65" y="5" width="50" height="30"/>
  <g transform="translate(10 40) rotate(10)" opacity="0.8">
    <path id="star" d="M10 0 L13 7 L20 7 L14 11 L16 18 L10 14 L4 18 L6 11 L0 7 L7 7 Z" fill="none"/>
    <ellipse cx="40" cy="10" rx="12" ry="6" fill="url(#g2)"/>
    <polyline points="60,0 70,10 80,0" fill="none" stroke="black" stroke-dasharray="2 1"/>
    <path d="M90 10 a 8 8 0 1 0 16 0 q 4 -8 8 0 t 8 0 c 2 2 4 2 6 0 s 4 -2 6 0 h 2 v 2 z" fill="purple" fill-rule="evenodd"/>
  </g>
  <use xlink:href="#dot" x="100" y="60" width="12" height="12"/>
  <circle cx="60" cy="40" r="35" fill="orange" fill-opacity="0.5" clip-path="url(#clip)"/>
  <a href="https://example.org/"><line x1="0" y1="79" x2="120" y2="79" stroke="#333"/></a>
</svg>
`;

export function svgDoc(body: string, attrs = 'width="10" height="10"'): Uint8Array {
  return enc(
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" ${attrs}>${body}</svg>`,
  );
}

/** Nested `use` references that multiply: `depth` levels of `fan` copies each. */
export function svgUseBomb(depth: number, fan: number): Uint8Array {
  let defs = '<circle id="l0" cx="1" cy="1" r="1"/>';
  for (let d = 1; d <= depth; d++) {
    const uses = Array.from({ length: fan }, () => `<use href="#l${d - 1}"/>`).join('');
    defs += `<g id="l${d}">${uses}</g>`;
  }
  return svgDoc(`<defs>${defs}</defs><use href="#l${depth}"/>`);
}
