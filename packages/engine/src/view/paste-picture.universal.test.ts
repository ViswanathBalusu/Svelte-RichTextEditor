/**
 * The browser half of picture paste (FE-053 criteria 1 and 4): a paste event on the body web view
 * whose clipboard holds a picture file and no text reaches `handlePaste` (view/web.ts), which reads
 * the file and hands it to the core's `pasteFromClipboard`. The assets port is a stand-in.
 *
 * Runs in real browser engines through `pnpm test:browsers` (vitest.config.ts). In Node.js there is
 * no DOM, so the suite is skipped there: the core's half of the same path is tested in
 * `test/image-paste-core.test.ts`. Not run in the round that wrote it: no browser was available.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import type { AssetsPort, PastedImage, UploadOutcome } from '../image-paste.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** An assets port that records every upload and answers with one asset. */
function recordingPort(): AssetsPort & { uploaded: PastedImage[] } {
  const uploaded: PastedImage[] = [];
  return {
    uploaded,
    upload(image: PastedImage): Promise<UploadOutcome> {
      uploaded.push(image);
      return Promise.resolve({
        ok: true,
        image: { asset: ASSET, widthTwips: 1440, heightTwips: 720 },
      });
    },
  };
}

function picture(): File {
  return new File([PNG_BYTES], 'photo.png', { type: 'image/png' });
}

/** A clipboard holding the given files and, optionally, text, as a browser's DataTransfer. */
function clipboard(files: File[], text = ''): DataTransfer {
  const dt = new DataTransfer();
  for (const f of files) dt.items.add(f);
  if (text !== '') dt.setData('text/plain', text);
  return dt;
}

/** Dispatches a paste event on the body surface; true when the browser's default was prevented. */
function paste(surface: HTMLElement, data: DataTransfer): boolean {
  const event = new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });
  // Firefox copies the data of a synthetic event into a new DataTransfer and drops its files (the
  // event then holds none), so the data is put on the event itself.
  Object.defineProperty(event, 'clipboardData', { value: data });
  surface.dispatchEvent(event);
  return event.defaultPrevented;
}

function imageCount(core: EditorCore): number {
  let n = 0;
  internals(core).state.doc.descendants((node) => {
    if (node.type.name === 'image') n++;
    return true;
  });
  return n;
}

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

describe.skipIf(!isBrowser)('picture paste on the body web view (FE-053 criteria 1 and 4)', () => {
  /** A core mounted on a host element of the page, with the given assets port. */
  function mounted(port: AssetsPort, access: Access = styledEditorAccess()) {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({
      doc: styledDocument(),
      access,
      schedule: (run) => queueMicrotask(run),
      assets: port,
    });
    const unmount = core.mountBody(host);
    // The editor may take the mount element's place in the page, so the surface is looked up there.
    const surface = document.querySelector<HTMLElement>('.de-editing-surface');
    if (!surface) throw new Error('the body surface was not mounted');
    return {
      core,
      surface,
      cleanup() {
        unmount();
        core.destroy();
        host.remove();
      },
    };
  }

  it('a picture file on a clipboard with no text is uploaded and inserted as an image node', async () => {
    const port = recordingPort();
    const { core, surface, cleanup } = mounted(port);
    try {
      expect(paste(surface, clipboard([picture()]))).toBe(true);
      await vi.waitFor(() => expect(port.uploaded).toHaveLength(1));
      expect(port.uploaded[0]!.mime).toBe('image/png');
      expect(Array.from(port.uploaded[0]!.bytes)).toEqual(Array.from(PNG_BYTES));
      await vi.waitFor(() => expect(imageCount(core)).toBe(1));
      // The document holds the asset identifier and the sizes, never the bytes (criterion 2).
      let asset: unknown = null;
      internals(core).state.doc.descendants((node) => {
        if (node.type.name === 'image') asset = node.attrs['asset'];
        return asset === null;
      });
      expect(asset).toBe(ASSET);
    } finally {
      cleanup();
    }
  });

  it('a clipboard with a picture and text is left to the text path: nothing is uploaded', async () => {
    const port = recordingPort();
    const { surface, cleanup } = mounted(port);
    try {
      paste(surface, clipboard([picture()], 'some words'));
      await new Promise((r) => setTimeout(r, 20));
      expect(port.uploaded).toHaveLength(0);
    } finally {
      cleanup();
    }
  });

  it('a picture pasted into a region the user may not change is refused before anything is uploaded', async () => {
    const port = recordingPort();
    const { core, surface, cleanup } = mounted(port);
    try {
      // Move the selection into the locked region's paragraph.
      const ic = internals(core);
      const doc = ic.state.doc;
      let at = -1;
      doc.descendants((node, pos) => {
        if (at < 0 && node.attrs['id'] === STYLE_IDS.inRegion) at = pos + 1;
        return at < 0;
      });
      expect(at).toBeGreaterThan(0);
      ic.dispatch(ic.state.tr.setSelection(TextSelection.create(doc, at)));
      paste(surface, clipboard([picture()]));
      await new Promise((r) => setTimeout(r, 20));
      expect(port.uploaded).toHaveLength(0);
      expect(imageCount(core)).toBe(0);
    } finally {
      cleanup();
    }
  });
});
