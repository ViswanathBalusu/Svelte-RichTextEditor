/**
 * Pictures inside pasted HTML become asset uploads (FE-054 criterion 6), and bookmarks are stripped
 * from the pasted fragment. Node.js: the choice is tested with `chooseClipboard`, the upload through
 * `DocumentCore.pasteFromClipboard` with a stand-in assets port. The HTML parse that reads the
 * `data:` URIs is the view's (browser test in view/fe-054-html-pictures.universal.test.ts).
 */
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope, CdmFragment } from '../src/api.ts';
import { chooseClipboard } from '../src/clipboard.ts';
import { DocumentCore } from '../src/headless.ts';
import type { AssetsPort, PastedImage, UploadOutcome } from '../src/image-paste.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { microtask } from './support.ts';
import type { Access } from '@docedit/protocol';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const REGION = `region:${AUTH_IDS.region}`;
const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';

const PICTURE: PastedImage = {
  name: 'pasted-1.png',
  mime: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
};

const TEXT_FRAGMENT = (text: string, extra: unknown[] = []): CdmFragment => ({
  cdm: 1,
  requires: [],
  defs: [],
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text }, ...(extra as never[])],
    },
  ],
  openStart: 1,
  openEnd: 1,
});

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

function envelope(): CdmEnvelope {
  return { cdm: 1, requires: [], doc: authoringEnvelope() };
}

function recordingPort(): AssetsPort & { uploaded: PastedImage[] } {
  const uploaded: PastedImage[] = [];
  return {
    uploaded,
    upload(image): Promise<UploadOutcome> {
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

function nodesOf(c: DocumentCore, type: string): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  internals(c).state.doc.descendants((n) => {
    if (n.type.name === type) out.push({ ...n.attrs });
    return true;
  });
  return out;
}

describe('pictures in pasted HTML are taken with the fragment (FE-054 criterion 6)', () => {
  it('a fragment read from HTML carries that HTML`s pictures', () => {
    const choice = chooseClipboard({ foreign: TEXT_FRAGMENT('Hi'), htmlPictures: [PICTURE] });
    expect(choice).toEqual({
      kind: 'fragment',
      fragment: TEXT_FRAGMENT('Hi'),
      pictures: [PICTURE],
    });
  });

  it('HTML with pictures and no text is a picture paste', () => {
    expect(chooseClipboard({ htmlPictures: [PICTURE] })).toEqual({
      kind: 'images',
      images: [PICTURE],
    });
  });

  it('HTML pictures are not taken when the view did not read the HTML', () => {
    expect(chooseClipboard({ html: '<img>', text: 'Hi' })).toEqual({ kind: 'text', text: 'Hi' });
    expect(chooseClipboard({ html: '<img>' })).toEqual({ kind: 'none' });
  });

  it('pictures next to plain text that the HTML did not yield are not taken (the text is used)', () => {
    expect(chooseClipboard({ foreign: null, htmlPictures: [PICTURE], text: 'Hi' })).toEqual({
      kind: 'text',
      text: 'Hi',
    });
  });
});

describe('the pasted HTML pictures are uploaded and inserted after the text (FE-054 criterion 6)', () => {
  it('the text is pasted, the picture is uploaded and an image names the asset, never the bytes', async () => {
    const port = recordingPort();
    const c = core(port);
    const result = c.pasteFromClipboard({
      foreign: TEXT_FRAGMENT('Pasted sentence.'),
      htmlPictures: [PICTURE],
    });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.uploads) throw new Error('the picture upload was not started');
    const outcomes = await result.uploads;
    expect(outcomes).toEqual([expect.objectContaining({ ok: true, asset: ASSET })]);
    expect(port.uploaded).toEqual([PICTURE]);
    expect(nodesOf(c, 'image')).toEqual([
      expect.objectContaining({ asset: ASSET, width: 1440, height: 720 }),
    ]);
    const json = JSON.stringify(c.getContent());
    expect(json).toContain('Pasted sentence.');
    expect(json).not.toContain('base64');
    expect(json).not.toContain('data:');
  });

  it('a picture-only HTML paste uploads the picture and inserts no text', async () => {
    const port = recordingPort();
    const c = core(port);
    const result = c.pasteFromClipboard({ htmlPictures: [PICTURE] });
    expect(result.ok).toBe(true);
    if (!result.ok || !result.uploads) throw new Error('the picture upload was not started');
    await result.uploads;
    expect(port.uploaded).toHaveLength(1);
    expect(nodesOf(c, 'image')).toHaveLength(1);
  });

  it('with no assets port the text is still pasted and no picture is inserted', () => {
    const c = core();
    const result = c.pasteFromClipboard({
      foreign: TEXT_FRAGMENT('Only text.'),
      htmlPictures: [PICTURE],
    });
    expect(result).toEqual({ ok: true });
    expect(nodesOf(c, 'image')).toHaveLength(0);
    expect(JSON.stringify(c.getContent())).toContain('Only text.');
  });

  it('bookmarks in the pasted HTML are stripped; the text stays', () => {
    const c = core(recordingPort());
    const result = c.pasteFromClipboard({
      foreign: TEXT_FRAGMENT('Kept.', [{ type: 'anchor', attrs: { name: 'bookmark-1' } }]),
    });
    expect(result).toEqual({ ok: true });
    expect(nodesOf(c, 'anchor')).toHaveLength(0);
    expect(JSON.stringify(c.getContent())).toContain('Kept.');
    expect(JSON.stringify(c.getContent())).not.toContain('bookmark-1');
  });
});
