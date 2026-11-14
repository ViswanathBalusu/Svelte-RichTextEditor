/**
 * Opening a sub-editor in a real browser (FE-056 criterion 1, FE-058 criterion 1; 02 §5.2, §8).
 *
 * - FE-056 criterion 1: the sub-editor starts with its own editor state that holds only the story
 *   or footnote node, and the body selection is kept, so it is back when the panel closes.
 * - FE-058 criterion 1: the insert-footnote command, used at the caret of body text, inserts a
 *   footnote with a fresh identifier there, and the sub-editor opens on that footnote's content.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`. In Node.js
 * there is no DOM, so the suite is skipped there.
 */
import type { Access } from '@docedit/protocol';
import { TextSelection } from 'prosemirror-state';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { internals } from '../testing.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

const owner = (): Access => ownerAccess();

/** The position of the node with `id` in `doc`, or -1. */
function posOfId(doc: PMNode, id: string): number {
  let found = -1;
  doc.descendants((node, pos) => {
    if (found < 0 && node.attrs['id'] === id) found = pos;
    return found < 0;
  });
  return found;
}

/** Puts the caret at the end of the node with `id`, as a keystroke at the end would leave it. */
function caretAtEnd(core: EditorCore, id: string): void {
  const i = internals(core);
  const at = posOfId(i.state.doc, id);
  const node = i.state.doc.nodeAt(at);
  if (at < 0 || !node) throw new Error(`no node ${id}`);
  const pos = at + node.nodeSize - 1;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

/** Mounts the body and returns the core with its host elements, for cleanup. */
function mountBody(): {
  core: EditorCore;
  bodyHost: HTMLElement;
  panelHost: HTMLElement;
  unmount: () => void;
} {
  const bodyHost = document.createElement('div');
  const panelHost = document.createElement('div');
  document.body.append(bodyHost, panelHost);
  const core = new EditorCore({
    doc: spikeDocument(),
    access: owner(),
    schedule: (run) => queueMicrotask(run),
  });
  const unmountBody = core.mountBody(bodyHost);
  return {
    core,
    bodyHost,
    panelHost,
    unmount() {
      unmountBody();
      core.destroy();
      bodyHost.remove();
      panelHost.remove();
    },
  };
}

describe.skipIf(!isBrowser)('sub-editors open on their own state (FE-056 criterion 1)', () => {
  it('the header panel holds only the header story and keeps the body selection', () => {
    const { core, panelHost, unmount } = mountBody();
    try {
      const i = internals(core);
      const storyNode = i.state.doc.nodeAt(posOfId(i.state.doc, SPIKE_IDS.header))!;
      expect(storyNode.type.name).toBe('story');
      const bodyBefore = i.state.selection.from;
      expect(core.openStory(SPIKE_IDS.header)).toBe(true);
      const unmountPanel = core.mountPanel(panelHost);
      try {
        const sub = viewsOf(core).subEditor;
        if (!sub) throw new Error('the header sub-editor was not mounted');
        // Its own state, not the body's: the document is the story node alone.
        expect(sub.view.state).not.toBe(internals(core).state);
        expect(sub.view.state.doc.type.name).toBe('story');
        expect(sub.view.state.doc.eq(storyNode)).toBe(true);
        // A header panel is a `story` panel in the view's classes (`de-sub-story`).
        expect(sub.view.dom.classList.contains('de-sub-story')).toBe(true);
        // The body selection is untouched while the panel is open.
        expect(internals(core).state.selection.from).toBe(bodyBefore);
      } finally {
        unmountPanel();
      }
      core.closePanel();
      // It is still there when the panel closes.
      expect(internals(core).state.selection.from).toBe(bodyBefore);
      expect(viewsOf(core).subEditor).toBeNull();
    } finally {
      unmount();
    }
  });

  it('the footnote panel holds only the footnote node and keeps the body selection', () => {
    const { core, panelHost, unmount } = mountBody();
    try {
      core.openFootnote(SPIKE_IDS.footnote);
      const i = internals(core);
      const noteNode = i.state.doc.nodeAt(posOfId(i.state.doc, SPIKE_IDS.footnote))!;
      expect(noteNode.type.name).toBe('footnote');
      caretAtEnd(core, SPIKE_IDS.intro);
      const bodyBefore = internals(core).state.selection.from;
      const unmountPanel = core.mountPanel(panelHost);
      try {
        const sub = viewsOf(core).subEditor;
        if (!sub) throw new Error('the footnote sub-editor was not mounted');
        expect(sub.view.state.doc.type.name).toBe('footnote');
        expect(sub.view.state.doc.eq(noteNode)).toBe(true);
        expect(sub.view.dom.classList.contains('de-sub-footnote')).toBe(true);
        expect(internals(core).state.selection.from).toBe(bodyBefore);
      } finally {
        unmountPanel();
      }
      core.closePanel();
      expect(internals(core).state.selection.from).toBe(bodyBefore);
    } finally {
      unmount();
    }
  });
});

describe.skipIf(!isBrowser)(
  'insert-footnote opens the sub-editor on the new footnote (FE-058 criterion 1)',
  () => {
    it('a footnote at the caret gets a fresh identifier and the sub-editor opens on its content', () => {
      const { core, panelHost, unmount } = mountBody();
      try {
        const idsBefore = new Set<string>();
        internals(core).state.doc.descendants((node) => {
          if (node.type.name === 'footnote') idsBefore.add(String(node.attrs['id']));
          return true;
        });
        caretAtEnd(core, SPIKE_IDS.intro);
        expect(core.run('insertFootnote')).toBe(true);

        // The new footnote sits in the introduction paragraph, with a fresh identifier.
        const doc = internals(core).state.doc;
        const added: PMNode[] = [];
        doc.descendants((node) => {
          if (node.type.name === 'footnote' && !idsBefore.has(String(node.attrs['id'])))
            added.push(node);
          return true;
        });
        expect(added).toHaveLength(1);
        const note = added[0]!;
        const noteId = String(note.attrs['id']);
        expect(noteId).not.toBe('');
        expect(note.childCount).toBe(1);

        const unmountPanel = core.mountPanel(panelHost);
        try {
          const sub = viewsOf(core).subEditor;
          if (!sub) throw new Error('the footnote sub-editor was not mounted');
          expect(sub.target).toEqual({ kind: 'footnote', id: noteId });
          expect(sub.view.state.doc.eq(note)).toBe(true);
          expect(sub.view.state.doc.childCount).toBe(1);
          expect(sub.view.state.doc.firstChild!.type.name).toBe('paragraph');
          // The panel's editing surface is the sub-editor's own, inside the panel host.
          expect(panelHost.contains(sub.view.dom)).toBe(true);
        } finally {
          unmountPanel();
        }
      } finally {
        unmount();
      }
    });
  },
);
