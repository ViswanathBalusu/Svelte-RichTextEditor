// The element's assets port for pasted pictures (FE-053; 05 §6.2; 10 §3.1): the size read from the
// file header, the display size in twips, the upload through the backend's port, and the paste
// through the editing core with this port, as the session hands it over.
import { DocumentCore } from '@docedit/engine/headless';
import type { AssetsPort as BackendAssetsPort } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { IMAGE_SIDE_MAX_TWIPS, displayTwips, pictureAssets, pixelSize } from '../src/assets.ts';

const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';

/** A PNG header (signature and IHDR) of `w` by `h` pixels. */
function png(w: number, h: number): Uint8Array {
  const b = new Uint8Array(33);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  new DataView(b.buffer).setUint32(16, w);
  new DataView(b.buffer).setUint32(20, h);
  return b;
}

function gif(w: number, h: number): Uint8Array {
  const b = new Uint8Array(13);
  b.set([...'GIF89a'].map((c) => c.charCodeAt(0)));
  new DataView(b.buffer).setUint16(6, w, true);
  new DataView(b.buffer).setUint16(8, h, true);
  return b;
}

/** A JPEG with an APP0 segment before its baseline start-of-frame. */
function jpeg(w: number, h: number): Uint8Array {
  const app0 = [0xff, 0xe0, 0, 16, ...new Array<number>(14).fill(0)];
  const sof = [
    0xff,
    0xc0,
    0,
    17,
    8,
    h >> 8,
    h & 0xff,
    w >> 8,
    w & 0xff,
    3,
    ...new Array<number>(9).fill(0),
  ];
  return new Uint8Array([0xff, 0xd8, ...app0, ...sof]);
}

function webpVp8x(w: number, h: number): Uint8Array {
  const b = new Uint8Array(30);
  const ascii = (at: number, s: string) =>
    b.set(
      [...s].map((c) => c.charCodeAt(0)),
      at,
    );
  ascii(0, 'RIFF');
  ascii(8, 'WEBP');
  ascii(12, 'VP8X');
  const le24 = (at: number, v: number) => b.set([v & 0xff, (v >> 8) & 0xff, (v >> 16) & 0xff], at);
  le24(24, w - 1);
  le24(27, h - 1);
  return b;
}

/** A backend assets port that records the uploads and answers with one asset, or fails. */
function backendPort(
  fail?: string,
): BackendAssetsPort & { files: Array<{ filename: string; size: number; type: string }> } {
  const files: Array<{ filename: string; size: number; type: string }> = [];
  return {
    files,
    create: () => Promise.reject(new Error('not used')),
    complete: () => Promise.reject(new Error('not used')),
    resolve: () => Promise.reject(new Error('not used')),
    async upload(_docId, file) {
      files.push({ filename: file.filename, size: file.source.size, type: file.source.type });
      await file.source.arrayBuffer();
      if (fail) throw new Error(fail);
      return { asset: ASSET };
    },
  };
}

describe('the size of a pasted picture', () => {
  it('is read from PNG, GIF, JPEG and WebP headers', () => {
    expect(pixelSize(png(640, 480))).toEqual({ width: 640, height: 480 });
    expect(pixelSize(gif(32, 16))).toEqual({ width: 32, height: 16 });
    expect(pixelSize(jpeg(1024, 768))).toEqual({ width: 1024, height: 768 });
    expect(pixelSize(webpVp8x(300, 200))).toEqual({ width: 300, height: 200 });
    expect(pixelSize(new Uint8Array([1, 2, 3, 4]))).toBeNull();
    expect(pixelSize(png(0, 10))).toBeNull();
  });

  it('is shown at 15 twips to the pixel, scaled down to the node limit with its aspect kept', () => {
    expect(displayTwips(96, 48)).toEqual({ widthTwips: 1440, heightTwips: 720 });
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 100_000 }),
        fc.integer({ min: 1, max: 100_000 }),
        (w, h) => {
          const { widthTwips, heightTwips } = displayTwips(w, h);
          expect(widthTwips).toBeGreaterThanOrEqual(1);
          expect(heightTwips).toBeGreaterThanOrEqual(1);
          expect(Math.max(widthTwips, heightTwips)).toBeLessThanOrEqual(IMAGE_SIDE_MAX_TWIPS);
          // Rounding to whole twips moves the aspect by at most one twip in the shorter side.
          if (Math.min(widthTwips, heightTwips) > 50) {
            const drift = Math.abs(widthTwips / heightTwips - w / h) / (w / h);
            expect(drift).toBeLessThan(1 / 50);
          }
        },
      ),
    );
  });
});

describe('the picture assets port over the backend port', () => {
  it('uploads the bytes and answers with the asset and the display size', async () => {
    const backend = backendPort();
    const port = pictureAssets(backend, 'doc1');
    const bytes = png(96, 48);
    expect(await port.upload({ name: 'a.png', mime: 'image/png', bytes })).toEqual({
      ok: true,
      image: { asset: ASSET, widthTwips: 1440, heightTwips: 720 },
    });
    expect(backend.files).toEqual([
      { filename: 'a.png', size: bytes.byteLength, type: 'image/png' },
    ]);
  });

  it('returns the service rejection as a message, and uploads nothing it cannot size', async () => {
    const failing = pictureAssets(backendPort('asset.failed: not a picture'), 'doc1');
    expect(await failing.upload({ name: 'a.png', mime: 'image/png', bytes: png(10, 10) })).toEqual({
      ok: false,
      message: 'asset.failed: not a picture',
    });
    const backend = backendPort();
    const unsized = pictureAssets(backend, 'doc1');
    expect(
      await unsized.upload({ name: 'x.bin', mime: 'image/png', bytes: new Uint8Array(8) }),
    ).toMatchObject({
      ok: false,
    });
    expect(backend.files).toEqual([]);
  });

  it('is the port the core pastes through: the image node names the asset, never the bytes', async () => {
    const core = new DocumentCore({
      doc: {
        cdm: 1,
        requires: [],
        doc: {
          type: 'doc',
          content: [
            {
              type: 'defs',
              content: [
                { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
                {
                  type: 'style_def',
                  attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
                },
                { type: 'page_setup', attrs: { id: 'ps1' } },
              ],
            },
            {
              type: 'body',
              attrs: { pageSetup: 'ps1' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'pAssets000000001' },
                  content: [{ type: 'text', text: 'Hi' }],
                },
              ],
            },
          ],
        },
      },
      assets: pictureAssets(backendPort(), 'doc1'),
      schedule: (run) => queueMicrotask(run),
    });
    const result = core.pasteFromClipboard({
      files: [{ name: 'a.png', mime: 'image/png', bytes: png(96, 48) }],
    });
    if (!result.ok) throw new Error(result.message);
    expect(await result.uploads).toEqual([{ ok: true, asset: ASSET }]);
    const json = JSON.stringify(core.getContent());
    expect(json).toContain(`"asset":"${ASSET}"`);
    expect(json).toContain('"width":1440');
    expect(json).not.toContain('data:');
  });
});
