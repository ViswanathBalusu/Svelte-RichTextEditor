/**
 * The content checks of the sandbox, run in-process on files built by fixtures.ts (BE-043
 * criteria 2 to 5; SEC-038 criteria 1 to 3 and 5; SEC-040 criteria 2 and 3). The same code runs in
 * the Podman sandbox; sandbox.podman.test.ts runs hostile files through the real container.
 * Every test uses the configured defaults (`contentLimits()`), never smaller ones.
 */
import fc from 'fast-check';
import jpeg from 'jpeg-js';
import { PNG as PngJs } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { contentLimits, DEFAULT_CONTENT_LIMITS } from '../src/sandbox/limits.ts';
import { processAsset, type ProcessResult } from '../src/sandbox/process.ts';
import { DOCX, GIF, JPEG, PDF, PNG, SVG, detectType } from '../src/sandbox/types.ts';
import { isSanitisedSvg } from '../src/verify.ts';
import {
  apng,
  CONTENT_TYPES,
  concat,
  docx,
  docxEntries,
  enc,
  exifApp1,
  gifOf,
  gifScreen,
  jpegOf,
  jpegScanBomb,
  jpegSegment,
  jpegWithSize,
  png,
  pngInflateBomb,
  pngPixelBomb,
  rgba,
  SVG_OK,
  svgDoc,
  svgUseBomb,
  withSegments,
  zip,
} from './fixtures.ts';

const L = contentLimits();

async function ok(bytes: Uint8Array, declared: string) {
  const r = await processAsset(bytes, declared, L);
  if (!r.ok) throw new Error(`expected success, got ${r.reason}: ${r.message}`);
  return r;
}

async function failure(
  bytes: Uint8Array,
  declared: string,
): Promise<Extract<ProcessResult, { ok: false }>> {
  const r = await processAsset(bytes, declared, L);
  if (r.ok) throw new Error('expected a failure');
  return r;
}

const has = (hay: Uint8Array, needle: string): boolean =>
  Buffer.from(hay).includes(Buffer.from(needle, 'latin1'));

describe('the limits are the configured defaults (SEC-038 criterion 5)', () => {
  it('uses the values recorded in the README and ADR 0043', () => {
    expect(L).toEqual(DEFAULT_CONTENT_LIMITS);
    expect(L.maxPixels).toBe(20_000_000);
    expect(L.maxDecodeMiB).toBe(448);
    expect(L.maxFrames).toBe(500);
    expect(L.zipMaxRatio).toBe(100);
  });
});

describe('type detection and the declared type (BE-043 criterion 2; SEC-040 criterion 3)', () => {
  it('detects formats from their bytes, not from what the client says', () => {
    expect(detectType(png())).toBe(PNG);
    expect(detectType(jpegOf())).toBe(JPEG);
    expect(detectType(gifOf())).toBe(GIF);
    expect(detectType(enc(SVG_OK))).toBe(SVG);
    expect(detectType(docx())).toBe('application/zip');
    expect(detectType(enc('<html><script>alert(1)</script></html>'))).toBe(
      'application/octet-stream',
    );
    expect(detectType(enc('%PDF-1.7\n'))).toBe(PDF);
    expect(detectType(enc('RIFF\0\0\0\0WEBPVP8 '))).toBe('image/webp');
  });

  it('fails a declared type that differs from the detected one', async () => {
    for (const [bytes, declared] of [
      [jpegOf(), 'image/png'],
      [png(), 'image/jpeg'],
      [gifOf(), 'image/png'],
      [enc('<html><body><script>alert(document.cookie)</script></body></html>'), 'image/png'],
      [enc(SVG_OK), 'image/png'],
      [png(), 'image/svg+xml'],
      [png(), DOCX],
      [zip([{ name: 'a.txt', data: enc('x') }]), DOCX],
    ] as const) {
      const r = await failure(bytes, declared);
      expect(r.reason, `${declared}`).toBe('type_mismatch');
    }
  });

  it('refuses types it does not accept, whatever the bytes', async () => {
    for (const t of [
      'text/html',
      'application/javascript',
      'image/webp',
      'application/zip',
      'application/pdf',
      'image/bmp',
    ])
      expect((await failure(png(), t)).reason).toBe('unsupported_type');
  });

  it('accepts well-known aliases of the declared type', async () => {
    expect((await ok(jpegOf(), 'image/jpg')).detected).toBe(JPEG);
    expect((await ok(png(), 'IMAGE/PNG; charset=binary')).detected).toBe(PNG);
  });

  it('fails an empty file and a file above the byte limit of its type', async () => {
    expect((await failure(new Uint8Array(), PNG)).reason).toBe('malformed');
    const big = concat(png(), new Uint8Array(L.imageMaxBytes));
    expect((await failure(big, PNG)).reason).toBe('too_large');
    const bigSvg = concat(
      enc('<svg xmlns="http://www.w3.org/2000/svg">'),
      new Uint8Array(L.svgMaxBytes),
    );
    expect((await failure(bigSvg, SVG)).reason).toBe('too_large');
  });
});

describe('PNG (BE-043 criterion 3; SEC-038 criteria 1 and 2; SEC-040 criterion 2)', () => {
  it('decodes, re-encodes and keeps the pixels', async () => {
    const r = await ok(png(48, 32), PNG);
    expect(r).toMatchObject({ detected: PNG, width: 48, height: 32, keepOriginal: false });
    const out = r.outputs[0]!;
    expect(out).toMatchObject({ role: 'display', mime: PNG });
    const back = PngJs.sync.read(Buffer.from(out.data));
    expect(Buffer.from(back.data).equals(Buffer.from(rgba(48, 32)))).toBe(true);
  });

  it('strips metadata chunks and appended payloads (polyglots)', async () => {
    const hostile = concat(png(), enc('<html><script>alert(1)</script></html>'), docx());
    const r = await ok(hostile, PNG);
    const out = r.outputs[0]!.data;
    for (const s of ['tEXt', 'eXIf', 'tIME', 'secret', '<script', 'PK\x03\x04', 'GPS'])
      expect(has(out, s), s).toBe(false);
    expect(r.notes).toEqual(
      expect.arrayContaining([
        'removed:eXIf',
        'removed:tEXt',
        'removed:tIME',
        'trailing_data_removed',
      ]),
    );
    expect(Buffer.from(out).equals(Buffer.from(hostile))).toBe(false);
  });

  it('decodes interlaced (Adam7) files', async () => {
    const r = await ok(png(23, 17, { interlace: true, extras: false }), PNG);
    const back = PngJs.sync.read(Buffer.from(r.outputs[0]!.data));
    expect(Buffer.from(back.data).equals(Buffer.from(rgba(23, 17)))).toBe(true);
  });

  it('fails a header beyond the pixel limits before any pixel is allocated', async () => {
    const before = process.memoryUsage().arrayBuffers;
    const bomb = pngPixelBomb(50_000, 50_000); // 2.5 gigapixels, 7.5 GB of RGB, a 1 KiB file
    expect(bomb.length).toBeLessThan(2048);
    const r = await failure(bomb, PNG);
    expect(r.reason).toBe('pixel_limit');
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
    expect((await failure(pngPixelBomb(20_000, 10), PNG)).reason).toBe('pixel_limit'); // one side too long
  });

  it('stops inflating image data at the size its header announces (decompression bomb)', async () => {
    for (const interlace of [false, true]) {
      const bomb = pngInflateBomb(256, interlace); // 256 MiB of zeros in about 256 KiB
      expect(bomb.length).toBeLessThan(400 * 1024);
      const before = process.memoryUsage().arrayBuffers;
      const r = await failure(bomb, PNG);
      expect(r.reason).toBe('malformed');
      expect(r.message).toMatch(/inflates to more than/);
      expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
    }
  });

  it('fails animated PNGs with more frames than the limit, and keeps the default image of others', async () => {
    expect((await failure(apng(L.maxFrames + 1), PNG)).reason).toBe('frame_limit');
    expect((await failure(apng(1_000_000), PNG)).reason).toBe('frame_limit');
    const r = await ok(apng(3), PNG);
    expect(r.notes).toContain('animation_dropped');
  });

  it('fails truncated and corrupted files', async () => {
    const good = png();
    expect((await failure(good.subarray(0, good.length - 20), PNG)).reason).toBe('malformed');
    expect((await failure(good.subarray(0, 40), PNG)).reason).toBe('malformed');
    const badCrc = Uint8Array.from(good);
    badCrc[30] = badCrc[30]! ^ 0xff;
    expect((await failure(badCrc, PNG)).reason).toBe('malformed');
  });
});

describe('JPEG (BE-043 criterion 3; SEC-038 criterion 1; SEC-040 criterion 2)', () => {
  it('re-encodes, strips Exif, comments and appended data, and applies the orientation', async () => {
    // 32 × 16: left half red, right half blue. Orientation 6 means "rotate 90° clockwise".
    const w = 32;
    const h = 16;
    const px = new Uint8Array(w * h * 4);
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        px.set(x < w / 2 ? [255, 0, 0, 255] : [0, 0, 255, 255], i);
      }
    const hostile = concat(
      withSegments(
        jpegOf(w, h, px),
        exifApp1(6),
        jpegSegment(0xfe, enc('<script>alert(1)</script>')),
      ),
      enc('<html><script>alert(2)</script></html>'),
    );
    const r = await ok(hostile, JPEG);
    expect(r).toMatchObject({ width: 16, height: 32 });
    const out = r.outputs[0]!.data;
    for (const s of ['Exif', 'GPS', '<script', 'ACM', '<html']) expect(has(out, s), s).toBe(false);
    expect(r.notes).toEqual(
      expect.arrayContaining([
        'orientation_applied:6',
        'removed:APP1',
        'removed:COM',
        'trailing_data_removed',
      ]),
    );
    const d = jpeg.decode(out, { useTArray: true });
    const at = (x: number, y: number) =>
      Array.from(d.data.subarray((y * d.width + x) * 4, (y * d.width + x) * 4 + 3));
    // After rotating clockwise the red half is on top.
    expect(at(8, 4)[0]).toBeGreaterThan(200);
    expect(at(8, 28)[2]).toBeGreaterThan(200);
  });

  it('fails a frame header beyond the pixel limits before decoding', async () => {
    const r = await failure(jpegWithSize(jpegOf(), 65_000, 65_000), JPEG);
    expect(r.reason).toBe('pixel_limit');
  });

  it('fails progressive files with more scans than the limit (a CPU bomb)', async () => {
    expect((await failure(jpegScanBomb(L.maxJpegScans + 1), JPEG)).reason).toBe('scan_limit');
  });

  it('fails truncated files and unsupported variants', async () => {
    const j = jpegOf();
    expect((await failure(j.subarray(0, Math.floor(j.length / 2)), JPEG)).reason).toBe('malformed');
    const lossless = Uint8Array.from(j);
    for (let i = 2; i + 1 < lossless.length; i++)
      if (lossless[i] === 0xff && lossless[i + 1] === 0xc0) {
        lossless[i + 1] = 0xc3;
        break;
      }
    expect((await failure(lossless, JPEG)).reason).toBe('unsupported_content');
  });
});

describe('GIF (BE-043 criterion 3; SEC-038 criteria 1 and 2; SEC-040 criterion 2)', () => {
  it('re-encodes every frame, keeps the timing, drops comments and appended data, adds a print PNG', async () => {
    const hostile = concat(gifOf(3), enc('PK\x03\x04 appended archive'));
    const r = await ok(hostile, GIF);
    expect(r).toMatchObject({ detected: GIF, width: 20, height: 10, frames: 3 });
    const [display, print] = r.outputs;
    expect(display).toMatchObject({ role: 'display', mime: GIF });
    expect(print).toMatchObject({ role: 'print', mime: PNG });
    expect(has(display!.data, '<script')).toBe(false);
    expect(has(display!.data, 'PK\x03\x04')).toBe(false);
    expect(r.notes).toEqual(expect.arrayContaining(['removed:comment', 'trailing_data_removed']));
    // The re-encoded GIF decodes to the same frames.
    const again = await ok(display!.data, GIF);
    expect(again.frames).toBe(3);
  });

  it('fails a logical screen beyond the pixel limits', async () => {
    expect((await failure(gifScreen(65_535, 65_535), GIF)).reason).toBe('pixel_limit');
  });

  it('fails more frames than the limit before decoding any (frame bomb)', async () => {
    const bomb = gifOf(L.maxFrames + 1, 2, 2, { comment: false });
    expect(bomb.length).toBeLessThan(64 * 1024);
    expect((await failure(bomb, GIF)).reason).toBe('frame_limit');
  });

  it('fails more pixels across frames than the limit', async () => {
    // 400 frames of 1000 × 600: within the frame limit, but 240 megapixels in all.
    const s = gifOf(1, 1000, 600, { comment: false });
    // Repeat the one frame's blocks (from the image descriptor to the trailer) 400 times.
    const start = s.indexOf(0x2c, 13 + 19);
    const frame = s.subarray(start, s.length - 1);
    const many = concat(
      s.subarray(0, start),
      ...Array.from({ length: 400 }, () => frame),
      new Uint8Array([0x3b]),
    );
    expect((await failure(many, GIF)).reason).toBe('frame_limit');
  });

  it('fails truncated files', async () => {
    const g = gifOf(2);
    expect((await failure(g.subarray(0, g.length - 1), GIF)).reason).toBe('malformed');
    expect((await failure(g.subarray(0, 20), GIF)).reason).toBe('malformed');
  });
});

describe('Word files and archives (BE-043 criterion 4; SEC-038 criterion 3)', () => {
  it('keeps a valid Word file unchanged', async () => {
    const r = await ok(docx(), DOCX);
    expect(r).toMatchObject({ detected: DOCX, keepOriginal: true, outputs: [] });
  });

  it('fails too many entries from the end record alone, before the directory is read', async () => {
    const entries = docxEntries(
      Array.from({ length: L.zipMaxEntries }, (_, i) => ({
        name: `word/media/x${i}.bin`,
        data: new Uint8Array(),
        method: 0 as const,
      })),
    );
    const r = await failure(zip(entries), DOCX);
    expect(r.reason).toBe('archive_limit');
    expect(r.message).toMatch(/entries/);
  });

  it('fails a compression ratio beyond the limit before expanding (a classic zip bomb)', async () => {
    const zeros = new Uint8Array(64 * 1024 * 1024);
    const bomb = docx([{ name: 'word/media/zeros.bin', data: zeros }]);
    expect(bomb.length).toBeLessThan(200 * 1024);
    const before = process.memoryUsage().arrayBuffers;
    const r = await failure(bomb, DOCX);
    expect(r.reason).toBe('archive_limit');
    expect(r.message).toMatch(/compressed more than/);
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(64 * 1024 * 1024);
  });

  it('fails a total size beyond the limit from the declared sizes, before expanding', async () => {
    // Three entries claiming 100 MiB each at a ratio under 50 (allowed); 300 MiB is above the total.
    const lying = (i: number) => ({
      name: `word/media/big${i}.bin`,
      data: enc('x'),
      size: 100 * 1024 * 1024,
      compressedSize: 2_200_000,
    });
    const r = await failure(zip(docxEntries([lying(1), lying(2), lying(3)])), DOCX);
    expect(r.reason).toBe('archive_limit');
  });

  it('stops expanding an entry whose directory lies about its size', async () => {
    const zeros = new Uint8Array(8 * 1024 * 1024);
    // The directory says 32 KiB at a ratio under the floor; the data inflates to 8 MiB.
    const r = await failure(
      docx([{ name: 'word/media/liar.bin', data: zeros, size: 32 * 1024 }]),
      DOCX,
    );
    expect(r.reason).toBe('archive_limit');
    expect(r.message).toMatch(/more than its directory says/);
  });

  it('fails overlapping entries (the overlapping-entry bomb)', async () => {
    const r = await failure(
      zip(docxEntries([{ name: 'word/media/b.bin', data: enc('x') }]), { overlap: true }),
      DOCX,
    );
    expect(['archive_limit', 'unsafe_content']).toContain(r.reason);
  });

  it('fails nested archives outside word/embeddings/, and allows them inside without expanding them', async () => {
    const inner = docx();
    expect(
      (await failure(docx([{ name: 'word/media/inner.zip', data: inner }]), DOCX)).reason,
    ).toBe('nested_archive');
    expect(
      (await failure(docx([{ name: 'word/media/image1.png', data: inner }]), DOCX)).reason,
    ).toBe('nested_archive');
    expect(
      (
        await ok(
          docx([{ name: 'word/embeddings/Microsoft_Excel_Worksheet.xlsx', data: inner }]),
          DOCX,
        )
      ).keepOriginal,
    ).toBe(true);
  });

  it('fails unsafe names, encryption, macros, document type declarations, comments and polyglot layouts', async () => {
    const cases: [Uint8Array, string][] = [
      [docx([{ name: '../../etc/passwd', data: enc('x') }]), 'unsafe_content'],
      [docx([{ name: '/abs/path', data: enc('x') }]), 'unsafe_content'],
      [docx([{ name: 'word\\..\\evil', data: enc('x') }]), 'unsafe_content'],
      [docx([{ name: 'WORD/DOCUMENT.XML', data: enc('x') }]), 'unsafe_content'],
      [docx([{ name: 'word/media/e.bin', data: enc('x'), flags: 0x801 }]), 'unsafe_content'],
      [docx([{ name: 'word/vbaProject.bin', data: enc('macro') }]), 'unsafe_content'],
      [
        zip(
          docxEntries(
            [],
            CONTENT_TYPES.replace(
              '<Types',
              '<!DOCTYPE t [<!ENTITY x SYSTEM "file:///etc/passwd">]><Types',
            ),
          ),
        ),
        'unsafe_content',
      ],
      [
        zip(
          docxEntries(
            [],
            CONTENT_TYPES.replace('document.main+xml', 'document.macroEnabled.main+xml'),
          ),
        ),
        'unsafe_content',
      ],
      [docx([], { comment: '<script>alert(1)</script>' }), 'unsafe_content'],
      [docx([], { gap: enc('<html><script>alert(1)</script></html>') }), 'unsafe_content'],
      [concat(docx(), enc('trailing')), 'unsafe_content'],
      // An HTML page with an archive after it is not detected as an archive at all.
      [docx([], { prefix: enc('<html><script>alert(1)</script></html>') }), 'type_mismatch'],
    ];
    for (const [bytes, reason] of cases) expect((await failure(bytes, DOCX)).reason).toBe(reason);
  });

  it('fails corrupted entries (wrong CRC, truncation)', async () => {
    expect(
      (await failure(docx([{ name: 'word/media/c.bin', data: enc('content'), crc: 1234 }]), DOCX))
        .reason,
    ).toBe('malformed');
    const d = docx();
    expect((await failure(d.subarray(0, d.length - 10), DOCX)).reason).toBe('unsafe_content');
  });
});

describe('SVG (BE-043 criterion 5; SEC-006 criterion 4)', () => {
  it('writes a sanitised SVG and a PDF rendition from the drawing alone', async () => {
    const r = await ok(enc(SVG_OK), SVG);
    expect(r).toMatchObject({ detected: SVG, width: 120, height: 80 });
    const [display, print] = r.outputs;
    expect(display).toMatchObject({ role: 'display', mime: SVG });
    expect(print).toMatchObject({ role: 'print', mime: PDF });
    const text = new TextDecoder().decode(display!.data);
    expect(isSanitisedSvg(text)).toBe(true);
    for (const s of [
      'secret',
      'inkscape',
      '<title',
      'example.org',
      '<style',
      'class=',
      'href',
      '<symbol',
      '<use',
      '<a ',
      '<!--',
    ])
      expect(text.includes(s), s).toBe(false);
    expect(text).toMatch(/<linearGradient/);
    expect(text).toMatch(/<radialGradient/);
    expect(text).toMatch(/<clipPath/);
    const pdf = Buffer.from(print!.data).toString('latin1');
    expect(pdf.startsWith('%PDF-1.4')).toBe(true);
    expect(pdf.trimEnd().endsWith('%%EOF')).toBe(true);
    expect(pdf).toMatch(/\/ShadingType 2/);
    expect(pdf).toMatch(/\/ShadingType 3/);
    expect(pdf).toMatch(/\/MediaBox \[0 0 90 60\]/);
    expect(r.notes).toEqual(expect.arrayContaining(['link_removed', 'foreign_elements_removed']));
  });

  it('gives the same PDF for the same drawing (deterministic, content-addressed)', async () => {
    const a = await ok(enc(SVG_OK), SVG);
    const b = await ok(enc(SVG_OK), SVG);
    expect(Buffer.from(a.outputs[1]!.data).equals(Buffer.from(b.outputs[1]!.data))).toBe(true);
  });

  it('fails scripts, event handlers, external references and foreign content as unsafe', async () => {
    const cases = [
      '<script>alert(1)</script>',
      '<rect width="5" height="5" onload="alert(1)"/>',
      '<rect width="5" height="5" onclick="x()"/>',
      '<use href="https://evil.example/sprite.svg#a"/>',
      '<use xlink:href="other.svg#a"/>',
      '<rect width="5" height="5" fill="url(https://evil.example/p.svg#g)"/>',
      '<rect width="5" height="5" style="fill: url(http://evil.example/x)"/>',
      '<style>@import url(https://evil.example/x.css);</style>',
      '<foreignObject width="5" height="5"><div xmlns="http://www.w3.org/1999/xhtml">x</div></foreignObject>',
      '<a href="javascript:alert(1)"><rect width="5" height="5"/></a>',
      '<a xlink:href=" JaVaScRiPt:alert(1)"><rect width="5" height="5"/></a>',
      '<iframe src="https://evil.example/"/>',
      '<rect width="5" height="5" fill="&unknown;"/>',
    ];
    for (const body of cases)
      expect((await failure(svgDoc(body), SVG)).reason, body).toBe('unsafe_content');
  });

  it('fails document type declarations, external entities and entity bombs', async () => {
    const xxe =
      '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><svg xmlns="http://www.w3.org/2000/svg">&xxe;</svg>';
    const laughs =
      '<?xml version="1.0"?><!DOCTYPE lolz [<!ENTITY lol "lol"><!ENTITY lol2 "&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;&lol;"><!ENTITY lol3 "&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;&lol2;">]><svg xmlns="http://www.w3.org/2000/svg"><g>&lol3;</g></svg>';
    expect((await failure(enc(xxe), SVG)).reason).toBe('unsafe_content');
    expect((await failure(enc(laughs), SVG)).reason).toBe('unsafe_content');
  });

  it('fails text and embedded images as unsupported, not as unsafe', async () => {
    expect((await failure(svgDoc('<text x="1" y="5">Hi</text>'), SVG)).reason).toBe(
      'unsupported_content',
    );
    expect(
      (
        await failure(
          svgDoc('<image href="data:image/png;base64,iVBORw0KGgo=" width="5" height="5"/>'),
          SVG,
        )
      ).reason,
    ).toBe('unsupported_content');
  });

  it('fails reference bombs at the drawing limit', async () => {
    const r = await failure(svgUseBomb(10, 10), SVG); // 10^10 circles if expanded
    expect(r.reason).toBe('drawing_limit');
    // Groups with nothing to draw, ten references per level: the visits alone hit the limit.
    const levels = Array.from(
      { length: 9 },
      (_, d) => `<g id="e${d + 1}">${`<use href="#e${d}"/>`.repeat(10)}</g>`,
    );
    const empty = await failure(
      svgDoc(`<defs><g id="e0"></g>${levels.join('')}</defs><use href="#e9"/>`),
      SVG,
    );
    expect(empty.reason).toBe('drawing_limit');
  });

  it('ignores reference cycles', async () => {
    const r = await ok(svgDoc('<g id="a"><rect width="4" height="4"/><use href="#a"/></g>'), SVG);
    expect(r.notes).toContain('reference_cycle_ignored');
  });

  it('fails elements nested deeper than the limit and malformed XML', async () => {
    const deep = svgDoc('<g>'.repeat(L.svgMaxDepth + 1) + '</g>'.repeat(L.svgMaxDepth + 1));
    expect((await failure(deep, SVG)).reason).toBe('drawing_limit');
    expect(
      (await failure(enc('<svg xmlns="http://www.w3.org/2000/svg"><rect></svg>'), SVG)).reason,
    ).toBe('malformed');
    expect(
      (await failure(enc('<svg xmlns="http://www.w3.org/2000/svg" a="1" a="2"/>'), SVG)).reason,
    ).toBe('malformed');
    // Not UTF-8: not detected as SVG at all, so the declared type does not match.
    expect(
      (
        await failure(
          concat(
            enc('<svg xmlns="http://www.w3.org/2000/svg">'),
            new Uint8Array([0xff, 0xfe]),
            enc('</svg>'),
          ),
          SVG,
        )
      ).reason,
    ).toBe('type_mismatch');
  });
});

describe('hostile bytes never escape the checks (property test)', () => {
  const seeds: [Uint8Array, string][] = [
    [png(16, 12), PNG],
    [jpegOf(16, 12), JPEG],
    [gifOf(2, 8, 6), GIF],
    [docx(), DOCX],
    [
      svgDoc('<rect width="5" height="5" fill="red"/><circle cx="5" cy="5" r="3" stroke="blue"/>'),
      SVG,
    ],
  ];

  it('returns a failure or fresh outputs within the limits for random mutations of valid files', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.integer({ min: 0, max: seeds.length - 1 }),
        fc.array(fc.tuple(fc.nat(), fc.integer({ min: 0, max: 255 })), {
          minLength: 1,
          maxLength: 12,
        }),
        fc.option(fc.nat(), { nil: undefined }),
        async (which, flips, cut) => {
          const [seed, declared] = seeds[which]!;
          const b = Uint8Array.from(seed);
          for (const [pos, val] of flips) b[pos % b.length] = val;
          const input = cut === undefined ? b : b.subarray(0, cut % (b.length + 1));
          const r = await processAsset(input, declared, L);
          if (!r.ok) {
            expect(typeof r.reason).toBe('string');
            return;
          }
          for (const o of r.outputs) expect(o.data.length).toBeLessThanOrEqual(L.outputMaxBytes);
          if (r.width !== undefined)
            expect(r.width * (r.height ?? 1)).toBeLessThanOrEqual(L.maxPixels);
          if (declared === SVG)
            expect(isSanitisedSvg(new TextDecoder().decode(r.outputs[0]!.data))).toBe(true);
        },
      ),
      { numRuns: 300, seed: 43 },
    );
  });
});
