/**
 * EXP-035 (Node.js only): an extension node is typeset through its fallback. Criterion 2 follows
 * owner decision 210: a block's `fallbackText` goes through `pdfString`, an inline's through `text`.
 * Nothing compiles here.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { blockLines, doc, nid, para, run } from '../test/docs.ts';

const PNG_SHA = 'e'.repeat(64);
const PNG_BYTES = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 0]);
const ASSETS = {
  fb1: { sha256: PNG_SHA, mediaType: 'image/png', status: 'ready' as const, bytes: PNG_BYTES },
};

const SENTINEL = 'PAYLOAD_SENTINEL_7f3a9c';

function extensionBlock(id: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: 'extension_block',
    attrs: {
      id,
      extension: 'example.widget',
      payload: { text: SENTINEL, nested: { value: SENTINEL } },
      fallbackAsset: 'fb1',
      fallbackText: 'A widget',
      width: 1440,
      height: 720,
      ext: {},
      ...extra,
    },
  };
}

describe('EXP-035 criterion 1: a fallback asset is typeset as a block like a figure', () => {
  it('writes the fallback picture with the figure macro and maps its lines to the block', async () => {
    const id = nid('x');
    const bundle = await run(doc([extensionBlock(id)]), { assets: ASSETS });
    const lines = blockLines(bundle, id);
    expect(lines.some((l) => l.includes('\\DEfig{'))).toBe(true);
    expect(lines.some((l) => l.includes(`assets/${PNG_SHA}.png`))).toBe(true);
  });

  it('gives the same picture macro as a figure with the same asset and size', async () => {
    const id = nid('x');
    const figureId = nid('f');
    const ext = await run(doc([extensionBlock(id)]), { assets: ASSETS });
    const fig = await run(
      doc([
        {
          type: 'figure',
          attrs: { id: figureId, asset: 'fb1', width: 1440, height: 720, alt: 'A widget' },
        },
      ]),
      { assets: ASSETS },
    );
    const extFig = blockLines(ext, id).find((l) => l.includes('\\DEfig{'));
    const figFig = blockLines(fig, figureId).find((l) => l.includes('\\DEfig{'));
    expect(extFig).toBeDefined();
    expect(figFig).toBeDefined();
    // The block and the figure differ in their number and in the caption group after the picture;
    // the picture itself (file, size and alternative text) is the same.
    const picture = (l: string): string | undefined =>
      /\\DEimg\{.*?\\DEstr\{[0-9A-F]*\}\}\}\}/.exec(l)?.[0];
    expect(picture(extFig!)).toBe(picture(figFig!));
  });
});

describe('EXP-035 criterion 3: the payload is not read and never reaches TeX', () => {
  it('leaves the payload text out of every bundle file and the map', async () => {
    const id = nid('x');
    const bundle = await run(doc([extensionBlock(id), para('After the widget.')]), {
      assets: ASSETS,
    });
    for (const [name, content] of Object.entries(bundle.files)) {
      expect(content.includes(SENTINEL), `file ${name} carries the payload`).toBe(false);
    }
    expect(JSON.stringify(bundle.map)).not.toContain(SENTINEL);
  });

  it('is written with no payload when the node has no fallback at all', async () => {
    const id = nid('x');
    const bundle = await run(
      doc([extensionBlock(id, { fallbackAsset: null, fallbackText: null })]),
      { assets: ASSETS },
    );
    for (const content of Object.values(bundle.files))
      expect(content.includes(SENTINEL)).toBe(false);
  });

  it('has no reader of the payload in the typesetter sources (a search, not a build check)', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const readers: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.ts') || name.endsWith('.test.ts') || name === 'attributes.ts') continue;
      const src = readFileSync(`${dir}${name}`, 'utf8');
      if (/\bpayload\b/.test(src)) readers.push(name);
    }
    expect(readers).toEqual([]);
  });
});

describe('EXP-035 criterion 4: a missing fallback asset is reported with the block', () => {
  it('reports fallback_asset_missing with the block identifier', async () => {
    const id = nid('x');
    const bundle = await run(doc([extensionBlock(id, { fallbackAsset: 'nowhere' })]), {
      assets: ASSETS,
    });
    const d = bundle.diagnostics.find((x) => x.code === 'fallback_asset_missing');
    expect(d).toBeDefined();
    expect(d!.blockId).toBe(id);
    expect(d!.severity).toBe('warning');
  });

  it('prints the fallback text instead of a picture when the asset is missing', async () => {
    const id = nid('x');
    const bundle = await run(doc([extensionBlock(id, { fallbackAsset: 'nowhere' })]), {
      assets: ASSETS,
    });
    expect(blockLines(bundle, id).some((l) => l.includes('\\DEplaceholder{'))).toBe(true);
  });

  it('does not report a fallback asset that the job lists', async () => {
    const id = nid('x');
    const bundle = await run(doc([extensionBlock(id)]), { assets: ASSETS });
    expect(bundle.diagnostics.some((x) => x.code === 'fallback_asset_missing')).toBe(false);
  });
});
