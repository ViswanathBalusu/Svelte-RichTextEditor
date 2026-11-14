// FE-053 criterion 5: an SVG file on the clipboard is never taken into the document as a picture, so
// the editor never draws it as live SVG. The picture's size is read from its header (PNG, GIF, JPEG,
// WebP only); an SVG has none of those headers, so it is refused before any upload, and the core
// inserts no `image` node. The view's rule that SVG is never drawn live is FE-067 and is not tested here.
import { DocumentCore } from '@docedit/engine/headless';
import type { AssetsPort as BackendAssetsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { pictureAssets, pixelSize } from '../src/assets.ts';

const SVG_TEXT =
  '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" onload="alert(1)"><script>alert(2)</script></svg>';
const SVG_BYTES = new TextEncoder().encode(SVG_TEXT);

function backendPort(): BackendAssetsPort & { files: string[] } {
  const files: string[] = [];
  return {
    files,
    create: () => Promise.reject(new Error('not used')),
    complete: () => Promise.reject(new Error('not used')),
    resolve: () => Promise.reject(new Error('not used')),
    async upload(_docId, file) {
      files.push(file.filename);
      return { asset: '01890a5d-ac96-774b-bcce-b302099a8057' };
    },
  };
}

function coreWith(port: BackendAssetsPort): DocumentCore {
  return new DocumentCore({
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
                attrs: { id: 'pSvgPaste000001' },
                content: [{ type: 'text', text: 'Hi' }],
              },
            ],
          },
        ],
      },
    },
    assets: pictureAssets(port, 'doc1'),
    schedule: (run) => queueMicrotask(run),
  });
}

describe('an SVG file on the clipboard is never drawn (FE-053 criterion 5)', () => {
  it('has no size in its header, so the picture is refused as it is', () => {
    expect(pixelSize(SVG_BYTES)).toBeNull();
  });

  it('is refused by the assets port before any upload, with a message', async () => {
    const backend = backendPort();
    const port = pictureAssets(backend, 'doc1');
    const outcome = await port.upload({
      name: 'drawing.svg',
      mime: 'image/svg+xml',
      bytes: SVG_BYTES,
    });
    expect(outcome).toMatchObject({ ok: false });
    expect(backend.files).toEqual([]);
  });

  it('inserts no image node and keeps the document free of its markup when pasted', async () => {
    const backend = backendPort();
    const core = coreWith(backend);
    const result = core.pasteFromClipboard({
      files: [{ name: 'drawing.svg', mime: 'image/svg+xml', bytes: SVG_BYTES }],
    });
    if (!result.ok) throw new Error(result.message);
    expect(await result.uploads).toEqual([expect.objectContaining({ ok: false })]);
    expect(backend.files).toEqual([]);
    const json = JSON.stringify(core.getContent());
    expect(json).not.toContain('"image"');
    expect(json).not.toContain('onload');
    expect(json).not.toContain('<svg');
  });
});
