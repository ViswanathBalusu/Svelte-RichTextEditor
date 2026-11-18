// FE-053 criterion 3 (the core's half): a placeholder shows where a pasted picture will go while its
// upload is under way, changes no document content, and is removed when the upload has finished, whether
// it succeeded or failed. A failed upload returns its message so that the shell can say why. The shell's
// own rendering of the placeholder is not tested here.
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { CdmEnvelope } from '../src/api.ts';
import { DocumentCore } from '../src/headless.ts';
import type { AssetsPort, PastedImage, UploadOutcome } from '../src/image-paste.ts';
import { picturePlaceholderKey } from '../src/picture-placeholder.ts';
import { internals } from '../src/testing.ts';
import { AUTH_IDS, authoringEnvelope } from './authoring-doc.ts';
import { caret, microtask, type } from './support.ts';

const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;
const REGION = `region:${AUTH_IDS.region}`;
const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';

const PICTURE: PastedImage = {
  name: 'photo.png',
  mime: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
};

function envelope(): CdmEnvelope {
  return { cdm: 1, requires: [], doc: authoringEnvelope() };
}

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

/** An assets port whose uploads wait until the test answers them. */
function waitingPort(): AssetsPort & {
  answer(i: number, outcome: UploadOutcome): void;
  count: number;
} {
  const pending: Array<(o: UploadOutcome) => void> = [];
  return {
    get count() {
      return pending.length;
    },
    upload() {
      return new Promise<UploadOutcome>((resolve) => pending.push(resolve));
    },
    answer(i, outcome) {
      pending[i]?.(outcome);
    },
  };
}

function core(assets: AssetsPort): DocumentCore {
  return new DocumentCore({
    doc: envelope(),
    access: editorAccess(),
    schedule: microtask,
    assets,
  });
}

/** The number of placeholders shown now. */
function shown(c: DocumentCore): number {
  return picturePlaceholderKey.getState(internals(c).state)?.pending.size ?? 0;
}

const docJson = (c: DocumentCore): string => JSON.stringify(c.getContent());

/** Lets queued promise callbacks run. */
const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe('the picture placeholder while an upload runs (FE-053 criterion 3)', () => {
  it('shows a placeholder while the upload runs, changes no content, and removes it when the picture is inserted', async () => {
    const port = waitingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    const before = docJson(c);
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(shown(c)).toBe(1);
    expect(docJson(c)).toBe(before);

    port.answer(0, { ok: true, image: { asset: ASSET, widthTwips: 1440, heightTwips: 720 } });
    expect(await result.uploads).toEqual([{ ok: true, asset: ASSET }]);
    expect(shown(c)).toBe(0);
    expect(docJson(c)).not.toBe(before);
  });

  it('removes the placeholder when the asset service rejects the file, and returns the message', async () => {
    const port = waitingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    const before = docJson(c);
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(shown(c)).toBe(1);

    port.answer(0, { ok: false, message: 'the asset service rejected the file' });
    expect(await result.uploads).toEqual([
      { ok: false, reason: 'upload-failed', message: 'the asset service rejected the file' },
    ]);
    await settle();
    expect(shown(c)).toBe(0);
    expect(docJson(c)).toBe(before);
  });

  it('records a refusal the shell turns into a message when the upload fails or is rejected', async () => {
    const port = waitingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    expect(c.refusal.get()).toBeNull();
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Nothing is said while the upload runs.
    expect(c.refusal.get()).toBeNull();
    port.answer(0, { ok: false, message: 'the asset service rejected the file' });
    await result.uploads;
    const notice = c.refusal.get();
    expect(notice).toMatchObject({ n: 1, reason: 'upload-failed', scopes: [] });
    // The service's own message is not carried into the notice.
    expect(JSON.stringify(notice)).not.toContain('rejected the file');
  });

  it('says nothing when the upload succeeds', async () => {
    const port = waitingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    if (!result.ok) throw new Error('refused');
    port.answer(0, { ok: true, image: { asset: ASSET, widthTwips: 1440, heightTwips: 720 } });
    await result.uploads;
    expect(c.refusal.get()).toBeNull();
  });

  it('keeps the placeholder in place of the picture while the user types before it', async () => {
    const port = waitingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    const result = c.pasteFromClipboard({ files: [PICTURE] });
    if (!result.ok) throw new Error('refused');
    const at = (): number | undefined =>
      [...(picturePlaceholderKey.getState(internals(c).state)?.pending.values() ?? [])][0];
    const first = at();
    expect(first).toBeDefined();
    // The user continues: text typed before the placeholder moves it, text after it does not.
    caret(c, AUTH_IDS.p1, 0);
    type(c, 'abc');
    expect(shown(c)).toBe(1);
    expect(at()).toBe((first ?? 0) + 3);
    const moved = at();
    caret(c, AUTH_IDS.p1, 'end');
    type(c, 'xyz');
    expect(at()).toBe(moved);
    port.answer(0, { ok: false, message: 'too large' });
    await result.uploads;
    expect(shown(c)).toBe(0);
  });

  it('shows one placeholder per picture and removes each as its upload finishes', async () => {
    const port = waitingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    const result = c.pasteFromClipboard({ files: [PICTURE, PICTURE] });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(shown(c)).toBe(2);

    port.answer(0, { ok: false, message: 'too large' });
    await settle();
    expect(shown(c)).toBe(1);

    port.answer(1, { ok: true, image: { asset: ASSET, widthTwips: 1440, heightTwips: 720 } });
    await result.uploads;
    expect(shown(c)).toBe(0);
  });

  it('shows no placeholder when the paste is refused before any upload', () => {
    const port = waitingPort();
    const c = core(port);
    caret(c, AUTH_IDS.p1, 2);
    expect(c.pasteFromClipboard({ files: [] })).toMatchObject({ ok: false });
    expect(shown(c)).toBe(0);
    expect(port.count).toBe(0);
  });
});
