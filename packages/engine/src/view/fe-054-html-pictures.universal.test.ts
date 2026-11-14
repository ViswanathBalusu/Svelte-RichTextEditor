/**
 * The browser half of FE-054 criterion 6: a paste event on the body web view whose `text/html` holds a
 * paragraph and an inline `data:` URI picture. The view reads the HTML through the whitelist and the
 * picture through `picturesFromForeignDocument`, the core uploads the picture through the assets port
 * (a stand-in here) and inserts an `image` node after the text. A remote `src` is never uploaded.
 *
 * Runs in real browser engines: `DOCEDIT_BROWSERS=chromium,firefox,webkit pnpm vitest run --project
 * browser <this file>`. Skipped in Node.js, which has no DOM; the core half is in
 * test/fe-054-html-pictures.test.ts.
 */
import type { Access } from '@docedit/protocol';
import { describe, expect, it, vi } from 'vitest';
import { styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import type { AssetsPort, PastedImage, UploadOutcome } from '../image-paste.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const ASSET = '01890a5d-ac96-774b-bcce-b302099a8057';
/** The eight bytes of the PNG signature, and their base64 text. */
const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const PNG_BASE64 = 'iVBORw0KGgo=';

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

/** A clipboard with HTML and plain text, as a browser's DataTransfer. */
function htmlClipboard(html: string, text: string): DataTransfer {
  const dt = new DataTransfer();
  dt.setData('text/html', html);
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

function docText(core: EditorCore): string {
  return internals(core).state.doc.textContent;
}

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
/**
 * Firefox keeps no `DataTransfer` data written onto a constructed paste event (the same probe that
 * skips the FE-054 and FE-053 paste tests), so the HTML never reaches the view there. Not proven in
 * Firefox; the core half is covered in Node.js.
 */
const constructedPasteKeepsData = !(
  typeof navigator !== 'undefined' && /Firefox\//.test(navigator.userAgent)
);

describe.skipIf(!isBrowser)(
  'pictures inside pasted HTML on the body web view (FE-054 criterion 6)',
  () => {
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

    it.skipIf(!constructedPasteKeepsData)(
      'a data: URI picture in pasted HTML is uploaded and inserted; the text is pasted too',
      async () => {
        const port = recordingPort();
        const { core, surface, cleanup } = mounted(port);
        try {
          const html = `<p>Picture follows</p><p><img src="data:image/png;base64,${PNG_BASE64}" alt=""></p>`;
          expect(paste(surface, htmlClipboard(html, 'Picture follows'))).toBe(true);
          await vi.waitFor(() => expect(port.uploaded).toHaveLength(1));
          expect(Array.from(port.uploaded[0]!.bytes)).toEqual(Array.from(PNG_BYTES));
          expect(port.uploaded[0]!.mime).toBe('image/png');
          await vi.waitFor(() => expect(imageCount(core)).toBe(1));
          expect(docText(core)).toContain('Picture follows');
        } finally {
          cleanup();
        }
      },
    );

    it.skipIf(!constructedPasteKeepsData)(
      'a remote image source is never fetched or uploaded; the text is still pasted',
      async () => {
        const port = recordingPort();
        const { core, surface, cleanup } = mounted(port);
        try {
          const html = '<p>Remote only</p><img src="https://example.invalid/photo.png" alt="">';
          paste(surface, htmlClipboard(html, 'Remote only'));
          await new Promise((r) => setTimeout(r, 30));
          expect(port.uploaded).toHaveLength(0);
          expect(imageCount(core)).toBe(0);
          expect(docText(core)).toContain('Remote only');
        } finally {
          cleanup();
        }
      },
    );
  },
);
