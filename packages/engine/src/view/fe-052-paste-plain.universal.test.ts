/**
 * The browser half of plain-text paste (U-FE-049-064 lane; FE-052 criteria 1 to 3). A paste event on
 * the body web view whose clipboard holds `text/plain` (with or without `text/html` that carries no
 * embedded fragment) reaches `handlePaste` (view/web.ts), which passes the data to the core's
 * `pasteFromClipboard`. The text is inserted at the caret; a line break starts a new paragraph; HTML
 * without a fragment is not used when plain text is there.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`. In Node.js
 * there is no DOM, so the suite is skipped there; the core's half is in `test/paste.test.ts` and
 * `test/clipboard.test.ts`.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

/**
 * Whether a synthetic paste event keeps the data it was built with. Chromium and WebKit do; Firefox
 * ignores the clipboard data of a constructed event, so the paste tests are skipped there (the same
 * limit as clipboard-fragment.universal.test.ts; Firefox is not evidence for FE-052 until it passes).
 */
function syntheticPasteReads(): boolean {
  if (!isBrowser) return false;
  let seen = '';
  const probe = document.createElement('div');
  probe.addEventListener('paste', (e) => {
    seen = (e as ClipboardEvent).clipboardData?.getData('text/plain') ?? '';
  });
  const data = new DataTransfer();
  data.setData('text/plain', 'x');
  probe.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
  return seen === 'x';
}

const itReads = syntheticPasteReads() ? it : it.skip;

/** A clipboard holding the given plain text and, optionally, HTML, as a browser's DataTransfer. */
function clipboard(text: string, html = ''): DataTransfer {
  const dt = new DataTransfer();
  if (text !== '') dt.setData('text/plain', text);
  if (html !== '') dt.setData('text/html', html);
  return dt;
}

/** Dispatches a paste event on the surface; returns the event (its defaultPrevented says it was taken). */
function paste(surface: HTMLElement, data: DataTransfer): ClipboardEvent {
  const event = new ClipboardEvent('paste', {
    clipboardData: data,
    bubbles: true,
    cancelable: true,
  });
  surface.dispatchEvent(event);
  return event;
}

/** The number of textblocks in the document. */
function blockCount(doc: ReturnType<typeof internals>['state']['doc']): number {
  let n = 0;
  doc.descendants((node) => {
    if (node.isTextblock) n++;
    return true;
  });
  return n;
}

/** A collapsed caret at the start of the first textblock with text, as a document position. */
function caretInFirstBlock(doc: ReturnType<typeof internals>['state']['doc']): number {
  let caret: number | null = null;
  doc.descendants((node, pos) => {
    if (caret !== null) return false;
    if (node.isTextblock && node.textContent.length > 0) caret = pos + 1;
    return true;
  });
  if (caret === null) throw new Error('the fixture has no text block with text');
  return caret;
}

function mounted(access: Access = styledEditorAccess()) {
  const host = document.createElement('div');
  document.body.append(host);
  const core = new EditorCore({
    doc: styledDocument(),
    access,
    schedule: (run) => queueMicrotask(run),
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

describe.skipIf(!isBrowser)(
  'plain-text paste on the body web view (FE-052 criteria 1 to 3)',
  () => {
    itReads('plain text with no HTML is inserted at the caret (FE-052 criterion 1)', async () => {
      const { core, surface, cleanup } = mounted();
      try {
        const ic = internals(core);
        const caret = caretInFirstBlock(ic.state.doc);
        ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, caret)));
        const before = ic.state.doc.textContent;
        expect(paste(surface, clipboard('PLAIN-INSERT')).defaultPrevented).toBe(true);
        await new Promise((r) => setTimeout(r, 20));
        const after = internals(core).state.doc.textContent;
        expect(after.length).toBe(before.length + 'PLAIN-INSERT'.length);
        expect(internals(core).state.doc.textBetween(caret, caret + 12)).toBe('PLAIN-INSERT');
      } finally {
        cleanup();
      }
    });

    itReads(
      'a line break in the pasted text starts a new paragraph (FE-052 criterion 2)',
      async () => {
        const { core, surface, cleanup } = mounted();
        try {
          const ic = internals(core);
          const caret = caretInFirstBlock(ic.state.doc);
          ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, caret)));
          const blocksBefore = blockCount(ic.state.doc);
          paste(surface, clipboard('first\nsecond'));
          await new Promise((r) => setTimeout(r, 20));
          const doc = internals(core).state.doc;
          expect(blockCount(doc)).toBe(blocksBefore + 1);
          expect(doc.textContent).toContain('first');
          expect(doc.textContent).toContain('second');
        } finally {
          cleanup();
        }
      },
    );

    // FE-054 now reads HTML without a fragment through the whitelist, so HTML that holds text is pasted in
    // preference to plain text (FE-054 criterion 1). This criterion holds for HTML that yields nothing to
    // paste: a script is dropped, so the plain text is used.
    itReads(
      'when HTML without a fragment yields nothing, the plain text is used (FE-052 criterion 3)',
      async () => {
        const { core, surface, cleanup } = mounted();
        try {
          const ic = internals(core);
          const caret = caretInFirstBlock(ic.state.doc);
          ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, caret)));
          paste(surface, clipboard('PLAIN-WINS', '<script>HTML-LOSES</script>'));
          await new Promise((r) => setTimeout(r, 20));
          const text = internals(core).state.doc.textContent;
          expect(text).toContain('PLAIN-WINS');
          expect(text).not.toContain('HTML-LOSES');
        } finally {
          cleanup();
        }
      },
    );
  },
);
