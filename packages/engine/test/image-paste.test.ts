/**
 * Pasting a picture as an asset upload (FE-053 criteria 1, 2 and 4). Criterion 3 (the placeholder
 * while the upload runs) is the shell's and is not tested here; criterion 5 (SVG is never drawn
 * live) is the view's (FE-067).
 */
import fc from 'fast-check';
import type { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import {
  pasteImage,
  type AssetsPort,
  type PastedImage,
  type PasteHost,
  type UploadOutcome,
} from '../src/image-paste.ts';
import { AUTH_IDS, authoringState, caretIn } from './authoring-doc.ts';

const PICTURE: PastedImage = {
  name: 'chart.png',
  mime: 'image/png',
  bytes: new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
};

/** A port that records the uploads and answers with `outcome`. */
function portOf(
  outcome: UploadOutcome | (() => UploadOutcome) = {
    ok: true,
    image: { asset: 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0', widthTwips: 2880, heightTwips: 1440 },
  },
) {
  const uploads: PastedImage[] = [];
  const port: AssetsPort = {
    upload: async (image) => {
      uploads.push(image);
      return typeof outcome === 'function' ? outcome() : outcome;
    },
  };
  return { port, uploads };
}

/** A host whose state changes with each dispatch, as the editing core's does. */
function hostOf(start: EditorState): PasteHost & { current: () => EditorState } {
  let state = start;
  return {
    state: () => state,
    dispatch: (tr) => {
      state = state.apply(tr);
    },
    current: () => state,
  };
}

/** The `image` nodes of a document, as JSON attributes. */
function images(state: EditorState): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  state.doc.descendants((node) => {
    if (node.type.name === 'image') out.push({ ...node.attrs });
    return true;
  });
  return out;
}

const always = () => true;

describe('the picture becomes an asset reference (FE-053 criterion 1)', () => {
  it('uploads the picture through the port and inserts an image that names the asset', async () => {
    const start = caretIn(authoringState(), AUTH_IDS.p1, 0);
    const host = hostOf(start);
    const { port, uploads } = portOf();
    const result = await pasteImage(host, PICTURE, port, { writable: always });
    expect(result).toEqual({ ok: true, asset: 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0' });
    expect(uploads).toEqual([PICTURE]);
    expect(images(host.current())).toEqual([
      expect.objectContaining({
        asset: 'a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0a0',
        width: 2880,
        height: 1440,
      }),
    ]);
  });
});

describe('no picture data is stored in the document (FE-053 criterion 2)', () => {
  it('the document holds the asset identifier and the sizes, never the bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 1, maxLength: 64 }), async (bytes) => {
        const host = hostOf(caretIn(authoringState(), AUTH_IDS.p2, 0));
        const { port } = portOf();
        const result = await pasteImage(host, { ...PICTURE, bytes }, port, { writable: always });
        expect(result.ok).toBe(true);
        const json = JSON.stringify(host.current().doc.toJSON());
        expect(json).not.toContain('data:');
        expect(json).not.toContain(Buffer.from(bytes).toString('base64'));
        // Only the asset, the sizes and the node's own defaults (alt, ext, origin, preserved).
        const [image] = images(host.current());
        expect(image).toMatchObject({ asset: expect.any(String) });
        expect(Object.values(image!).some((v) => v instanceof Uint8Array)).toBe(false);
      }),
      { numRuns: 25 },
    );
  });
});

describe('a picture is not uploaded where the user cannot change (FE-053 criterion 4)', () => {
  it('uploads nothing and inserts nothing in a locked region', async () => {
    const start = caretIn(authoringState(), AUTH_IDS.inRegion, 0);
    const host = hostOf(start);
    const { port, uploads } = portOf();
    const result = await pasteImage(host, PICTURE, port, { writable: () => false });
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    expect(uploads).toHaveLength(0);
    expect(host.current()).toBe(start);
  });

  it('inserts nothing when the position became locked while the upload ran', async () => {
    const host = hostOf(caretIn(authoringState(), AUTH_IDS.p1, 0));
    const { port, uploads } = portOf();
    let calls = 0;
    // Writable when the paste starts, locked when the upload has finished.
    const writable = () => ++calls === 1;
    const result = await pasteImage(host, PICTURE, port, { writable });
    expect(result).toEqual({ ok: false, reason: 'read-only' });
    expect(uploads).toHaveLength(1);
    expect(images(host.current())).toHaveLength(0);
  });
});

describe('a failed upload inserts nothing and gives its reason', () => {
  it('returns the message of a rejected picture and leaves the document as it was', async () => {
    const start = caretIn(authoringState(), AUTH_IDS.p1, 0);
    const host = hostOf(start);
    const { port } = portOf({ ok: false, message: 'the file is not a picture' });
    const result = await pasteImage(host, PICTURE, port, { writable: always });
    expect(result).toEqual({
      ok: false,
      reason: 'upload-failed',
      message: 'the file is not a picture',
    });
    expect(host.current()).toBe(start);
  });

  it('refuses a size outside the image node range without inserting', async () => {
    const start = caretIn(authoringState(), AUTH_IDS.p1, 0);
    const host = hostOf(start);
    const { port } = portOf({
      ok: true,
      image: { asset: 'b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0b0', widthTwips: 0, heightTwips: 100 },
    });
    const result = await pasteImage(host, PICTURE, port, { writable: always });
    expect(result).toEqual({ ok: false, reason: 'invalid-size' });
    expect(host.current()).toBe(start);
  });
});
