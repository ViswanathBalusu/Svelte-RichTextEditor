/**
 * The picture placeholder drawn on the body web view (FE-053 criterion 3, the view's half). While a picture
 * upload is under way the placeholder element is in the editing surface; once the upload has finished it is
 * gone. The core's state is tested in test/fe-053-placeholder.test.ts.
 *
 * Runs through `pnpm vitest run --project browser <this file>`; skipped in Node.js, which has no DOM.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import type { AssetsPort, PastedImage, UploadOutcome } from '../image-paste.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

const PICTURE: PastedImage = {
  name: 'photo.png',
  mime: 'image/png',
  bytes: new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4]),
};

/** An assets port whose upload waits until the test answers it. */
function waitingPort(): AssetsPort & { answer(outcome: UploadOutcome): void } {
  let resolveUpload: ((o: UploadOutcome) => void) | null = null;
  return {
    upload() {
      return new Promise<UploadOutcome>((resolve) => {
        resolveUpload = resolve;
      });
    },
    answer(outcome) {
      resolveUpload?.(outcome);
    },
  };
}

function mounted(access: Access = styledEditorAccess(), assets: AssetsPort) {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: styledDocument(),
    access,
    schedule: (run) => queueMicrotask(run),
    assets,
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

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

describe.skipIf(!isBrowser)(
  'the picture placeholder on the body web view (FE-053 criterion 3)',
  () => {
    it('draws a placeholder while the upload runs and removes it after the picture is inserted', async () => {
      const port = waitingPort();
      const { core, surface, cleanup } = mounted(undefined, port);
      try {
        const ic = internals(core);
        let caret = 0;
        ic.state.doc.descendants((node, pos) => {
          if (caret === 0 && node.isTextblock && node.textContent.length > 0) caret = pos + 1;
          return caret === 0;
        });
        ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, caret)));

        const result = core.pasteFromClipboard({ files: [PICTURE] });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        await settle();
        const shownWhileUploading = surface.querySelectorAll('.de-picture-placeholder');
        expect(shownWhileUploading.length).toBe(1);
        expect(shownWhileUploading[0]?.textContent).toBe('Uploading picture');

        port.answer({
          ok: true,
          image: {
            asset: '01890a5d-ac96-774b-bcce-b302099a8057',
            widthTwips: 1440,
            heightTwips: 720,
          },
        });
        await result.uploads;
        await settle();
        expect(surface.querySelectorAll('.de-picture-placeholder').length).toBe(0);
      } finally {
        cleanup();
      }
    });
  },
);
