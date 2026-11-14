/**
 * Pasting pictures through the core's paste path (FE-053 criteria 1, 2 and 4): `pasteFromClipboard`
 * with picture files, with HTML that carries `data:` URIs, and with fragments, under the region
 * guard's real `canWrite` (guard.ts). The assets port is a stand-in for the asset service.
 */
import type { Access } from '@docedit/protocol';
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmFragment, CdmJsonNode } from '../src/api.ts';
import { clipboardPayload, chooseClipboard } from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import type { AssetsPort, PastedImage } from '../src/image-paste.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const REGION = `region:${AUTH_IDS.region}`;
const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';
const DATA_URI =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk';

const PICTURE: PastedImage = {
  name: 'photo.png',
  mime: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
};

function envelope(): CdmEnvelope {
  return { cdm: 1, requires: [], doc: authoringEnvelope() };
}

/** An editor who may change the body but not the restricted region. */
function editorAccess(): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...EDIT], defs: ['view'], [REGION]: ['view', 'comment'] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

/** An assets port that records what it was given and answers with one asset. */
function recordingPort(): AssetsPort & { uploaded: PastedImage[] } {
  const uploaded: PastedImage[] = [];
  return {
    uploaded,
    upload(image) {
      uploaded.push(image);
      return Promise.resolve({
        ok: true,
        image: { asset: ASSET, widthTwips: 1440, heightTwips: 720 },
      });
    },
  };
}

function core(assets?: AssetsPort): DocumentCore {
  return new DocumentCore({
    doc: envelope(),
    access: editorAccess(),
    schedule: microtask,
    ...(assets ? { assets } : {}),
  });
}

function images(c: DocumentCore): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  internals(c).state.doc.descendants((n) => {
    if (n.type.name === 'image') out.push(n.attrs);
    return true;
  });
  return out;
}

const docJson = (c: DocumentCore): string => JSON.stringify(c.getContent());

/** A fragment, as another copy of the editor would put it on the clipboard, with one picture. */
function fragmentWithPicture(asset: string): CdmFragment {
  const content: CdmJsonNode[] = [
    {
      type: 'paragraph',
      attrs: { id: 'pPasted000000001', style: null },
      content: [
        { type: 'text', text: 'Pasted ' },
        { type: 'image', attrs: { asset, width: 1440, height: 720 } },
      ],
    },
  ];
  return { cdm: 1, requires: [], defs: [], content, openStart: 1, openEnd: 1 };
}

describe('a picture file on the clipboard becomes an asset upload (FE-053 criterion 1)', () => {
  it('uploads through the assets port and inserts an image that names the asset', async () => {
    const port = recordingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(await result.uploads).toEqual([{ ok: true, asset: ASSET }]);
    expect(port.uploaded).toEqual([PICTURE]);
    expect(images(c)).toEqual([
      expect.objectContaining({ asset: ASSET, width: 1440, height: 720 }),
    ]);
  });

  it('takes the text, not the picture, when the clipboard holds both (a word processor copies both)', () => {
    const port = recordingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    expect(c.pasteFromClipboard({ text: 'words', files: [PICTURE] })).toEqual({ ok: true });
    expect(port.uploaded).toEqual([]);
    expect(images(c)).toEqual([]);
  });

  it('says why when there is no assets port, and inserts nothing', () => {
    const c = core();
    caret(c, AUTH_IDS.p1, 2);
    expect(c.pasteFromClipboard({ files: [PICTURE] })).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(images(c)).toEqual([]);
  });

  it('ignores files that are not pictures', () => {
    expect(chooseClipboard({ files: [{ ...PICTURE, mime: 'application/pdf' }] })).toEqual({
      kind: 'none',
    });
  });
});

describe('no picture data is embedded, whatever the source (FE-053 criterion 2)', () => {
  it('a picture file: the document holds the asset identifier and the sizes, never the bytes', async () => {
    await fc.assert(
      fc.asyncProperty(fc.uint8Array({ minLength: 8, maxLength: 64 }), async (bytes) => {
        const c = core(recordingPort());
        caret(c, AUTH_IDS.p2, 1);
        const result = c.pasteFromClipboard({ files: [{ ...PICTURE, bytes }] });
        if (!result.ok) throw new Error('refused');
        await result.uploads;
        const json = docJson(c);
        expect(json).not.toContain('data:');
        expect(json).not.toContain(Array.from(bytes).join(','));
        expect(images(c)).toHaveLength(1);
      }),
      { numRuns: 25 },
    );
  });

  it('HTML with `data:` URI pictures: the text is pasted and the pictures are not taken in', () => {
    const c = core(recordingPort());
    caret(c, AUTH_IDS.p1, 2);
    const html = `<p>Hello <img src="${DATA_URI}" alt="x"></p>`;
    expect(c.pasteFromClipboard({ html, text: 'Hello' })).toEqual({ ok: true });
    expect(c.pasteFromClipboard({ html })).toMatchObject({ ok: false, reason: 'invalid' });
    expect(images(c)).toEqual([]);
    expect(docJson(c)).not.toContain('data:');
  });

  it('a fragment whose picture holds a `data:` URI: the picture is dropped, the text kept', () => {
    const c = core(recordingPort());
    caret(c, AUTH_IDS.p1, 2);
    const html = clipboardPayload(fragmentWithPicture(DATA_URI))['text/html'];
    expect(c.pasteFromClipboard({ html })).toEqual({ ok: true });
    expect(images(c)).toEqual([]);
    expect(docJson(c)).not.toContain('data:');
    expect(docJson(c)).toContain('Pasted ');
  });

  it('a fragment whose picture names an asset: the asset identifier is kept, and only it', () => {
    const c = core(recordingPort());
    caret(c, AUTH_IDS.p1, 2);
    const html = clipboardPayload(fragmentWithPicture(ASSET))['text/html'];
    expect(c.pasteFromClipboard({ html })).toEqual({ ok: true });
    expect(images(c)).toEqual([expect.objectContaining({ asset: ASSET })]);
    expect(docJson(c)).not.toContain('data:');
  });
});

describe('a scope the user cannot change uploads nothing (FE-053 criterion 4)', () => {
  it('refuses the paste before any upload, and records the refusal', () => {
    const port = recordingPort();
    const c = core(port);
    caret(c, AUTH_IDS.inRegion, 2);
    expect(c.canEdit(REGION)).toBe(false);
    const doc = internals(c).state.doc;
    expect(c.pasteFromClipboard({ files: [PICTURE] })).toMatchObject({
      ok: false,
      reason: 'refused',
      refusal: 'scope',
    });
    expect(port.uploaded).toEqual([]);
    expect(internals(c).state.doc).toBe(doc);
    expect(c.refusal.get()).toMatchObject({ reason: 'scope', scopes: [REGION] });
  });

  it('inserts nothing when the document became read-only while the upload ran', async () => {
    let release: () => void = () => {};
    const port: AssetsPort = {
      upload: () =>
        new Promise((resolve) => {
          release = () =>
            resolve({ ok: true, image: { asset: ASSET, widthTwips: 10, heightTwips: 10 } });
        }),
    };
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    if (!result.ok) throw new Error('refused');
    c.setMode('view');
    release();
    expect(await result.uploads).toEqual([{ ok: false, reason: 'read-only' }]);
    expect(images(c)).toEqual([]);
  });
});
