/**
 * Copy, cut and drag in the sub-editors (FE-055 criterion 1, FE-050; 02 §5.2, §8). The footnote and
 * header panels are their own `EditorView`s. Their copy, cut and dragstart go through the core as the
 * body's do: under `no-copy` nothing is written and a cut removes nothing; otherwise the clipboard
 * gets the core's CDM fragment of the sub-editor's selection, not ProseMirror's own format.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`. In Node.js
 * there is no DOM, so the suite is skipped there.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { FRAGMENT_ATTRIBUTE } from '../clipboard.ts';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { internals } from '../testing.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

/** Whether a synthetic clipboard event keeps what a listener writes (not in Firefox). */
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

type Kind = 'footnote' | 'header';

/** Mounts the body and opens the footnote or header panel; the sub-editor's view is returned. */
function mountedPanel(kind: Kind, access: Access) {
  const bodyHost = document.createElement('div');
  const panelHost = document.createElement('div');
  document.body.append(bodyHost, panelHost);
  const core = new EditorCore({
    doc: spikeDocument(),
    access,
    schedule: (run) => queueMicrotask(run),
  });
  const unmountBody = core.mountBody(bodyHost);
  if (kind === 'footnote') core.openFootnote(SPIKE_IDS.footnote);
  else if (!core.openStory(SPIKE_IDS.header)) throw new Error('the header panel did not open');
  const unmountPanel = core.mountPanel(panelHost);
  const sub = viewsOf(core).subEditor;
  if (!sub) throw new Error(`the ${kind} sub-editor was not mounted`);
  return {
    core,
    sub,
    cleanup() {
      unmountPanel();
      unmountBody();
      core.destroy();
      bodyHost.remove();
      panelHost.remove();
    },
  };
}

/** Selects the first four characters of the sub-editor's first text block; returns the text. */
function selectFour(view: EditorView): string {
  let range: { from: number; to: number } | null = null;
  view.state.doc.descendants((node, pos) => {
    if (range) return false;
    if (node.isTextblock && node.textContent.length >= 4) range = { from: pos + 1, to: pos + 5 };
    return true;
  });
  if (!range) throw new Error('the sub-editor has no text block with four characters');
  const { from, to } = range;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, from, to)));
  return view.state.doc.textBetween(from, to);
}

function clipboardEvent(el: HTMLElement, type: 'copy' | 'cut', data: DataTransfer): ClipboardEvent {
  const event = new ClipboardEvent(type, { clipboardData: data, bubbles: true, cancelable: true });
  el.dispatchEvent(event);
  return event;
}

const noCopy = (): Access => ({ ...ownerAccess(), restrictions: ['no-copy'] });

describe.skipIf(!isBrowser)('copy, cut and drag in the sub-editors (FE-055 criterion 1)', () => {
  for (const kind of ['footnote', 'header'] as const) {
    it(`under no-copy a copy, a cut and a drag in the ${kind} write nothing and remove nothing`, () => {
      const { core, sub, cleanup } = mountedPanel(kind, noCopy());
      try {
        selectFour(sub.view);
        const mainBefore = internals(core).state.doc;
        const subBefore = sub.view.state.doc;
        const copied = new DataTransfer();
        const copyEvent = clipboardEvent(sub.view.dom, 'copy', copied);
        expect(copyEvent.defaultPrevented).toBe(true);
        expect(copied.types.length).toBe(0);
        expect(core.refusal.get()?.reason).toBe('no-copy');
        const cut = new DataTransfer();
        const cutEvent = clipboardEvent(sub.view.dom, 'cut', cut);
        expect(cutEvent.defaultPrevented).toBe(true);
        expect(cut.types.length).toBe(0);
        const drag = new DataTransfer();
        const dragEvent = new DragEvent('dragstart', {
          dataTransfer: drag,
          bubbles: true,
          cancelable: true,
        });
        sub.view.dom.dispatchEvent(dragEvent);
        expect(dragEvent.defaultPrevented).toBe(true);
        expect(drag.types.length).toBe(0);
        expect(sub.view.state.doc.eq(subBefore)).toBe(true);
        expect(internals(core).state.doc.eq(mainBefore)).toBe(true);
      } finally {
        cleanup();
      }
    });

    itWrites(
      `without no-copy a copy in the ${kind} writes the core's fragment of its selection (FE-050)`,
      () => {
        const { sub, cleanup } = mountedPanel(kind, ownerAccess());
        try {
          const text = selectFour(sub.view);
          const data = new DataTransfer();
          const event = clipboardEvent(sub.view.dom, 'copy', data);
          expect(event.defaultPrevented).toBe(true);
          expect([...data.types].sort()).toEqual(['text/html', 'text/plain']);
          expect(data.getData('text/plain')).toBe(text);
          expect(data.getData('text/html')).toContain(FRAGMENT_ATTRIBUTE);
        } finally {
          cleanup();
        }
      },
    );

    itWrites(
      `without no-copy a cut in the ${kind} writes the fragment and removes the text`,
      () => {
        const { core, sub, cleanup } = mountedPanel(kind, ownerAccess());
        try {
          const text = selectFour(sub.view);
          const before = internals(core).state.doc.textContent;
          const data = new DataTransfer();
          clipboardEvent(sub.view.dom, 'cut', data);
          expect(data.getData('text/plain')).toBe(text);
          expect(internals(core).state.doc.textContent.length).toBe(before.length - text.length);
        } finally {
          cleanup();
        }
      },
    );
  }
});
