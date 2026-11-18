/**
 * The comments pane's choice reaches the page, and the page's choice reaches the pane (UX-030
 * criterion 2; lane w3). A thread chosen through `selectThread` is marked in the body and brought
 * into view; a click on a thread's highlight is recorded in `pickedThread`. Neither touches the
 * document: no step, no commit.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>` (Chromium,
 * Firefox and WebKit); in Node.js there is no DOM, so the suite is skipped there.
 */
import { describe, expect, it, vi } from 'vitest';
import { COMMENT_RANGE_CLASS, COMMENT_SELECTED_CLASS } from '../comment-decorations.ts';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)(
  'a thread chosen in the pane and in the page (UX-030 criterion 2)',
  () => {
    it('marks the chosen range, brings it into view, and records a click on a highlight', async () => {
      const scroller = document.createElement('div');
      scroller.style.cssText = 'height:60px;overflow:auto;';
      const host = document.createElement('div');
      scroller.append(host);
      document.body.append(scroller);
      const core = new EditorCore({
        doc: styledDocument(),
        access: styledEditorAccess(),
        schedule: (run) => queueMicrotask(run),
      });
      const unmount = core.mountBody(host);
      try {
        const surface = document.querySelector<HTMLElement>('.de-editing-surface');
        if (!surface) throw new Error('the body surface was not mounted');
        const ic = internals(core);

        // Two threads: one on the first paragraph, one far down on the last.
        const startOf = (id: string): number => {
          let start = -1;
          ic.state.doc.descendants((node, pos) => {
            if (start < 0 && node.attrs['id'] === id) start = pos + 1;
            return start < 0;
          });
          return start;
        };
        const first = startOf(STYLE_IDS.plain);
        const last = startOf(STYLE_IDS.after);
        core.setThreadRange('top', { from: first, to: first + 4 }, 1);
        core.setThreadRange('bottom', { from: last, to: last + 4 }, 1);
        await vi.waitFor(() =>
          expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`).length).toBe(2),
        );
        expect(surface.querySelectorAll(`.${COMMENT_SELECTED_CLASS}`).length).toBe(0);

        const revision = ic.state.doc;
        scroller.scrollTop = 0;
        core.selectThread({ id: 'bottom', block: null });
        await vi.waitFor(() =>
          expect(surface.querySelectorAll(`.${COMMENT_SELECTED_CLASS}`).length).toBe(1),
        );
        const chosen = surface.querySelector<HTMLElement>(`.${COMMENT_SELECTED_CLASS}`)!;
        expect(chosen.getAttribute('data-thread-id')).toBe('bottom');
        // The chosen text is inside the scrolling box, which had to move to show it.
        await vi.waitFor(() => {
          const box = scroller.getBoundingClientRect();
          const at = chosen.getBoundingClientRect();
          expect(at.top).toBeGreaterThanOrEqual(box.top - 1);
          expect(at.bottom).toBeLessThanOrEqual(box.bottom + 1);
        });
        expect(scroller.scrollTop).toBeGreaterThan(0);

        // Another choice moves the mark; clearing it removes the mark.
        core.selectThread({ id: 'top', block: null });
        await vi.waitFor(() =>
          expect(
            surface.querySelector(`.${COMMENT_SELECTED_CLASS}`)?.getAttribute('data-thread-id'),
          ).toBe('top'),
        );
        core.selectThread(null);
        await vi.waitFor(() =>
          expect(surface.querySelectorAll(`.${COMMENT_SELECTED_CLASS}`).length).toBe(0),
        );

        // A click on a highlight in the page is recorded for the pane.
        expect(core.pickedThread.get()).toBeNull();
        surface
          .querySelector<HTMLElement>(`.${COMMENT_RANGE_CLASS}[data-thread-id="bottom"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(core.pickedThread.get()).toEqual({ id: 'bottom', n: 1 });
        surface
          .querySelector<HTMLElement>(`.${COMMENT_RANGE_CLASS}[data-thread-id="bottom"]`)!
          .dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        expect(core.pickedThread.get()).toEqual({ id: 'bottom', n: 2 });

        // None of this changed the document.
        expect(ic.state.doc.eq(revision)).toBe(true);
      } finally {
        unmount();
        core.destroy();
        scroller.remove();
      }
    });

    it('marks a block that a thread targets', async () => {
      const host = document.createElement('div');
      document.body.append(host);
      const core = new EditorCore({
        doc: styledDocument(),
        access: styledEditorAccess(),
        schedule: (run) => queueMicrotask(run),
      });
      const unmount = core.mountBody(host);
      try {
        const surface = document.querySelector<HTMLElement>('.de-editing-surface');
        if (!surface) throw new Error('the body surface was not mounted');
        core.selectThread({ id: 'on-block', block: STYLE_IDS.quote });
        await vi.waitFor(() =>
          expect(surface.querySelectorAll(`.${COMMENT_SELECTED_CLASS}`).length).toBe(1),
        );
        const marked = surface.querySelector<HTMLElement>(`.${COMMENT_SELECTED_CLASS}`)!;
        expect(marked.getAttribute('data-thread-id')).toBe('on-block');
        expect(marked.tagName).toBe('P');
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    });
  },
);
