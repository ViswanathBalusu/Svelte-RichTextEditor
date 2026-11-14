/**
 * EXP-034 criterion 1 (Node.js only): a signature or initials value `{ asset, mode }` is drawn as the
 * asset's picture at the field's width, with its height from the PNG's proportions and the field's
 * label as alternative text. The asset bytes travel in the bundle. Without bytes (or for a value that
 * names no usable PNG) the field stays blank and the converter keeps `form_value_not_printed`.
 *
 * Nothing compiles here; the compile test is `exp-034-signature.compile.test.ts`.
 */
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run, type J } from '../test/docs.ts';
import { makePng, sha256Hex } from '../test/exp-034-png.ts';
import { dimen, kvValue, text } from './emit.ts';
import {
  heightForWidth,
  imagePixelSize,
  jpegPixelSize,
  pngPixelSize,
} from './signature-picture.ts';

const idOfPara = (p: J): string => (p['attrs'] as J)['id'] as string;

function field(key: string, kind: string, attrs: J = {}): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind, label: `Label ${key}`, width: 2880, value: null, ...attrs },
  };
}

function fieldLine(lines: string[]): string {
  const line = lines.find((l) => l.includes('\\DEff{'));
  if (line === undefined) throw new Error('no flattened field in the block');
  return line;
}

/** A PNG asset of the job: its bytes, its hash and its media type, as the job gives them (EXP-014). */
function pngAsset(width: number, height: number, withBytes = true) {
  const bytes = makePng(width, height);
  return {
    sha256: sha256Hex(bytes),
    mediaType: 'image/png',
    status: 'ready' as const,
    ...(withBytes ? { bytes } : {}),
  };
}

describe('EXP-034 criterion 1: the PNG size comes from the IHDR chunk', () => {
  it('reads width and height of a PNG', () => {
    expect(pngPixelSize(makePng(200, 100))).toEqual({ w: 200, h: 100 });
  });

  it('gives null for bytes that are not a PNG, and for a truncated one', () => {
    expect(pngPixelSize(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(pngPixelSize(new TextEncoder().encode('GIF89a' + 'x'.repeat(30)))).toBeNull();
    expect(pngPixelSize(makePng(4, 4).subarray(0, 20))).toBeNull();
  });

  it('reads width and height of a JPEG from its start-of-frame segment', () => {
    // SOI, an APP0 segment (skipped), then SOF0 with 8-bit precision, height 50 and width 120.
    const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
    const sof0 = [0xff, 0xc0, 0x00, 0x0b, 0x08, 0x00, 0x32, 0x00, 0x78, 0x01, 0x01];
    expect(jpegPixelSize(new Uint8Array([0xff, 0xd8, ...app0, ...sof0]))).toEqual({
      w: 120,
      h: 50,
    });
    expect(imagePixelSize(new Uint8Array([0xff, 0xd8, ...app0, ...sof0]), 'image/jpeg')).toEqual({
      w: 120,
      h: 50,
    });
    expect(imagePixelSize(makePng(7, 5), 'image/png')).toEqual({ w: 7, h: 5 });
    expect(imagePixelSize(makePng(7, 5), 'image/gif')).toBeNull();
    expect(jpegPixelSize(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBeNull();
  });

  it('keeps the height in proportion, at least one twip, rounded', () => {
    expect(heightForWidth(2880, { w: 200, h: 100 })).toBe(1440);
    expect(heightForWidth(2880, { w: 3, h: 1 })).toBe(960);
    expect(heightForWidth(1, { w: 1000, h: 1 })).toBe(1);
  });
});

describe('EXP-034 criterion 1: a signature value is drawn as its picture', () => {
  it('draws the asset at the field width and the proportional height, with the label as alternative text', async () => {
    const asset = pngAsset(200, 100);
    const p = para('Signed: ', {}, [
      field('sig', 'signature', {
        label: 'Signature of the applicant',
        value: { asset: 'sig1', mode: 'drawn' },
      }),
    ]);
    const b = await run(doc([p]), { assets: { sig1: asset } });
    const f = fieldLine(blockLines(b, idOfPara(p)));
    const file = `assets/${asset.sha256}.png`;
    expect(f).toContain(`\\DEff{1}{${dimen(2880)}}{${kvValue('Signature of the applicant')}}{`);
    expect(f).toContain(
      `\\DEimg{${file}}{${dimen(2880)}}{${dimen(1440)}}{1440}{${kvValue('Signature of the applicant')}}`,
    );
    expect(b.diagnostics.some((d) => d.code === 'form_value_not_printed')).toBe(false);
    expect(Object.keys(b.assets)).toContain(file);
  });

  it('draws initials the same way', async () => {
    const asset = pngAsset(60, 30);
    const p = para('Initials: ', {}, [
      field('ini', 'initials', { label: 'Initials', value: { asset: 'ini1', mode: 'typed' } }),
    ]);
    const b = await run(doc([p]), { assets: { ini1: asset } });
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toMatch(/\\DEimg\{assets\/[0-9a-f]{64}\.png\}\{[0-9.]+bp\}\{[0-9.]+bp\}\{1440\}/);
  });

  it('prints the blank field and keeps the warning when the job gives no bytes', async () => {
    const p = para('Signed: ', {}, [
      field('sig', 'signature', { label: 'Signature', value: { asset: 'sig1', mode: 'drawn' } }),
    ]);
    const b = await run(doc([p]), { assets: { sig1: pngAsset(200, 100, false) } });
    const f = fieldLine(blockLines(b, idOfPara(p)));
    expect(f).toContain(`{${kvValue('Signature')}}{${text('')}}`);
    expect(f).not.toContain('\\DEimg');
    expect(b.diagnostics.some((d) => d.code === 'form_value_not_printed')).toBe(true);
  });

  it('prints the blank field when the asset is not an image the converter reads (no size in its bytes)', async () => {
    const jpeg = {
      sha256: 'a'.repeat(64),
      mediaType: 'image/jpeg',
      status: 'ready' as const,
      bytes: new Uint8Array([255, 216, 255]),
    };
    const p = para('Signed: ', {}, [
      field('sig', 'signature', { label: 'Signature', value: { asset: 'sig1', mode: 'drawn' } }),
    ]);
    const b = await run(doc([p]), { assets: { sig1: jpeg } });
    expect(fieldLine(blockLines(b, idOfPara(p)))).not.toContain('\\DEimg');
    expect(b.diagnostics.some((d) => d.code === 'form_value_not_printed')).toBe(true);
  });

  it('prints the blank field when the value names an asset the job does not list', async () => {
    const p = para('Signed: ', {}, [
      field('sig', 'signature', { label: 'Signature', value: { asset: 'nope', mode: 'drawn' } }),
    ]);
    const b = await run(doc([p]), { assets: {} });
    expect(fieldLine(blockLines(b, idOfPara(p)))).not.toContain('\\DEimg');
    expect(b.diagnostics.some((d) => d.code === 'form_value_not_printed')).toBe(true);
  });

  it('leaves an empty signature field as the labelled empty box (criterion 4)', async () => {
    const p = para('Signed: ', {}, [
      field('sig', 'signature', { label: 'Signature', value: null }),
    ]);
    const b = await run(doc([p]));
    expect(fieldLine(blockLines(b, idOfPara(p)))).toContain(
      `{${kvValue('Signature')}}{${text('')}}`,
    );
  });
});
