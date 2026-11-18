/**
 * FE-132 criterion 5, the core's half (Node.js): a picture that is inserted has no alternative
 * text, so the core asks the shell for it (`altRequest`), and the text the shell sends back is
 * stored on that picture through the scope guard (`setImageAlt`). The assets port is a stand-in.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import type { AssetsPort, PastedImage } from '../src/image-paste.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { caret, microtask } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';
const PICTURE: PastedImage = {
  name: 'photo.png',
  mime: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
};

const envelope = (): CdmEnvelope => ({ cdm: 1, requires: [], doc: authoringEnvelope() });

function access(body: readonly (typeof EDIT)[number][] = EDIT): Access {
  return {
    rev: 1,
    asOfSeq: 0,
    docRole: 'editor',
    caps: [...EDIT],
    scopes: { doc: ['view'], body: [...body], defs: ['view'] },
    leases: {},
    fill: null,
    restrictions: [],
  };
}

const port: AssetsPort = {
  upload: () =>
    Promise.resolve({ ok: true, image: { asset: ASSET, widthTwips: 1440, heightTwips: 720 } }),
};

function core(): DocumentCore {
  return new DocumentCore({ doc: envelope(), access: access(), schedule: microtask, assets: port });
}

function alts(c: DocumentCore): unknown[] {
  const out: unknown[] = [];
  internals(c).state.doc.descendants((n) => {
    if (n.type.name === 'image') out.push(n.attrs['alt']);
    return true;
  });
  return out;
}

async function insertPicture(c: DocumentCore): Promise<void> {
  caret(c, AUTH_IDS.p1, 2);
  const result = c.pasteFromClipboard({ files: [PICTURE] });
  if (!result.ok) throw new Error('the picture was refused');
  await result.uploads;
}

describe('a picture without alternative text prompts for it (FE-132 criterion 5)', () => {
  it('asks once per inserted picture, naming its asset, and asks for nothing before one is inserted', async () => {
    const c = core();
    expect(c.altRequest.get()).toBeNull();
    await insertPicture(c);
    expect(c.altRequest.get()).toEqual({ n: 1, asset: ASSET });
    await insertPicture(c);
    expect(c.altRequest.get()).toEqual({ n: 2, asset: ASSET });
  });

  it('asks for nothing when the upload fails and nothing is inserted', async () => {
    const c = new DocumentCore({
      doc: envelope(),
      access: access(),
      schedule: microtask,
      assets: { upload: () => Promise.resolve({ ok: false, message: 'refused' }) },
    });
    caret(c, AUTH_IDS.p1, 2);
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    if (result.ok) await result.uploads;
    expect(c.altRequest.get()).toBeNull();
    expect(alts(c)).toEqual([]);
  });

  it('stores the text on the picture, one change in the history', async () => {
    const c = core();
    await insertPicture(c);
    expect(alts(c)).toEqual([null]);
    expect(c.setImageAlt(ASSET, '  A grey cat on a sofa  ')).toBe(true);
    expect(alts(c)).toEqual(['A grey cat on a sofa']);
    // The picture has its text now: a second answer finds nothing to change.
    expect(c.setImageAlt(ASSET, 'Another')).toBe(false);
    expect(alts(c)).toEqual(['A grey cat on a sofa']);
  });

  it('puts the text on the first picture of that asset that has none', async () => {
    const c = core();
    await insertPicture(c);
    await insertPicture(c);
    expect(c.setImageAlt(ASSET, 'First')).toBe(true);
    expect(c.setImageAlt(ASSET, 'Second')).toBe(true);
    expect(alts(c).sort()).toEqual(['First', 'Second']);
  });

  it('refuses blank text, an unknown asset and a part the user may not change', async () => {
    const c = core();
    await insertPicture(c);
    expect(c.setImageAlt(ASSET, '   ')).toBe(false);
    expect(c.setImageAlt('other-asset', 'Text')).toBe(false);
    expect(alts(c)).toEqual([null]);
    // The same picture, now in a body the user can only view.
    c.setAccess(access(['view']));
    expect(c.setImageAlt(ASSET, 'Text')).toBe(false);
    expect(alts(c)).toEqual([null]);
  });
});
