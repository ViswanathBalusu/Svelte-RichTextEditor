/**
 * The browser half of copy, cut and paste on the body web view (U-FE-049-064 lane; FE-050 criteria 4
 * and 5, FE-055 criterion 1 for the copy and cut handlers). The web view hands the browser's copy,
 * cut and paste events to the core, so the clipboard receives the CDM fragment and nothing else.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`. In Node.js
 * there is no DOM, so the suite is skipped there; the core's half is in `test/clipboard.test.ts`.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { FRAGMENT_ATTRIBUTE } from '../clipboard.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

/**
 * Whether a synthetic clipboard event keeps what a listener writes to it. Chromium and WebKit do; Firefox
 * gives a constructed event a protected DataTransfer, so the tests that read the clipboard back are
 * skipped there (the no-copy test still runs, as nothing must be written). Trusted user events are not
 * reachable from this harness.
 */
function syntheticClipboardWrites(): boolean {
  if (!isBrowser) return false;
  const probe = document.createElement('div');
  probe.addEventListener('copy', (e) =>
    (e as ClipboardEvent).clipboardData?.setData('text/plain', 'x'),
  );
  const data = new DataTransfer();
  probe.dispatchEvent(new ClipboardEvent('copy', { clipboardData: data, bubbles: true }));
  return data.getData('text/plain') === 'x';
}

const itWrites = syntheticClipboardWrites() ? it : it.skip;

/** Dispatches a clipboard event of the given type on the surface; returns the event. */
function clipboardEvent(
  surface: HTMLElement,
  type: 'copy' | 'cut' | 'paste',
  data: DataTransfer,
): ClipboardEvent {
  const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
  surface.dispatchEvent(event);
  return event;
}

/** A text range of the first block with enough text, as [from, to) document positions. */
function firstRange(doc: ReturnType<typeof internals>['state']['doc']): {
  from: number;
  to: number;
  text: string;
} {
  let found: { from: number; to: number; text: string } | null = null;
  doc.descendants((node, pos) => {
    if (found) return false;
    if (node.isTextblock && node.textContent.length >= 4) {
      const from = pos + 1;
      const to = from + 4;
      found = { from, to, text: doc.textBetween(from, to) };
    }
    return true;
  });
  if (!found) throw new Error('the fixture has no text block with four characters');
  return found;
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

describe.skipIf(!isBrowser)('copy, cut and paste on the body web view (FE-050, FE-055)', () => {
  itWrites(
    'a copy writes text/html carrying the fragment and text/plain, and no other type (FE-050 criterion 1)',
    () => {
      const { core, surface, cleanup } = mounted();
      try {
        const ic = internals(core);
        const range = firstRange(ic.state.doc);
        ic.dispatch(
          ic.state.tr.setSelection(TextSelection.create(ic.state.doc, range.from, range.to)),
        );
        const data = new DataTransfer();
        clipboardEvent(surface, 'copy', data);
        expect([...data.types].sort()).toEqual(['text/html', 'text/plain']);
        expect(data.getData('text/plain')).toBe(range.text);
        expect(data.getData('text/html')).toContain(FRAGMENT_ATTRIBUTE);
      } finally {
        cleanup();
      }
    },
  );

  itWrites(
    'the clipboard HTML has no script and shows the text in a plain HTML target (FE-050 criterion 5)',
    () => {
      const { core, surface, cleanup } = mounted();
      try {
        const ic = internals(core);
        const range = firstRange(ic.state.doc);
        ic.dispatch(
          ic.state.tr.setSelection(TextSelection.create(ic.state.doc, range.from, range.to)),
        );
        const data = new DataTransfer();
        clipboardEvent(surface, 'copy', data);
        // DOMParser builds an inert document: no script runs and no resource loads.
        const target = new DOMParser().parseFromString(data.getData('text/html'), 'text/html');
        expect(
          target.querySelector('script, iframe, object, embed, [onerror], [onload]'),
        ).toBeNull();
        expect(target.body.textContent).toContain(range.text);
      } finally {
        cleanup();
      }
    },
  );

  itWrites(
    'a copy pasted back into the same editor arrives intact (FE-050 criterion 4, FE-051)',
    async () => {
      const { core, surface, cleanup } = mounted();
      try {
        const ic = internals(core);
        const range = firstRange(ic.state.doc);
        ic.dispatch(
          ic.state.tr.setSelection(TextSelection.create(ic.state.doc, range.from, range.to)),
        );
        const data = new DataTransfer();
        clipboardEvent(surface, 'copy', data);
        const before = ic.state.doc.textContent;
        // Collapse the selection at the end of the document, then paste the copied fragment there.
        const end = ic.state.doc.content.size - 1;
        ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, end)));
        const pasted = clipboardEvent(surface, 'paste', data);
        expect(pasted.defaultPrevented).toBe(true);
        await new Promise((r) => setTimeout(r, 20));
        const after = internals(core).state.doc.textContent;
        expect(after.length).toBeGreaterThan(before.length);
        expect(after.split(range.text).length - 1).toBe(before.split(range.text).length);
      } finally {
        cleanup();
      }
    },
  );

  itWrites(
    'a cut writes the same data as a copy and deletes the selection (FE-050 criterion 2)',
    () => {
      const { core, surface, cleanup } = mounted();
      try {
        const ic = internals(core);
        const range = firstRange(ic.state.doc);
        ic.dispatch(
          ic.state.tr.setSelection(TextSelection.create(ic.state.doc, range.from, range.to)),
        );
        const before = ic.state.doc.textContent;
        const data = new DataTransfer();
        clipboardEvent(surface, 'cut', data);
        expect(data.getData('text/plain')).toBe(range.text);
        expect(data.getData('text/html')).toContain(FRAGMENT_ATTRIBUTE);
        expect(internals(core).state.doc.textContent.length).toBe(
          before.length - range.text.length,
        );
      } finally {
        cleanup();
      }
    },
  );

  it('under no-copy a copy and a cut write nothing and a cut removes nothing (FE-055 criterion 1)', () => {
    const { core, surface, cleanup } = mounted({
      ...styledEditorAccess(),
      restrictions: ['no-copy'],
    });
    try {
      const ic = internals(core);
      const range = firstRange(ic.state.doc);
      ic.dispatch(
        ic.state.tr.setSelection(TextSelection.create(ic.state.doc, range.from, range.to)),
      );
      const before = ic.state.doc.textContent;
      const copied = new DataTransfer();
      const copyEvent = clipboardEvent(surface, 'copy', copied);
      expect(copyEvent.defaultPrevented).toBe(true);
      expect(copied.types.length).toBe(0);
      const cut = new DataTransfer();
      clipboardEvent(surface, 'cut', cut);
      expect(cut.types.length).toBe(0);
      const drag = new DataTransfer();
      const dragEvent = new DragEvent('dragstart', {
        dataTransfer: drag,
        bubbles: true,
        cancelable: true,
      });
      surface.dispatchEvent(dragEvent);
      expect(dragEvent.defaultPrevented).toBe(true);
      expect(drag.types.length).toBe(0);
      expect(internals(core).state.doc.textContent).toBe(before);
    } finally {
      cleanup();
    }
  });
});
