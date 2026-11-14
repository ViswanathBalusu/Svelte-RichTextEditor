/**
 * FE-048 criterion 8 (lane U-FE-033-048, round 7): a comment range adds no invisible cursor stop.
 * The range is an inline decoration over existing text, not a zero-width anchor, so moving the caret
 * with the arrow keys through the commented text visits each text position once and in order.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>` (Chromium,
 * Firefox and WebKit). In Node.js there is no DOM, so the suite is skipped there; `vitest/browser`
 * throws when it is imported outside Browser Mode, so `userEvent` is loaded only when a DOM exists.
 */
import type { userEvent as BrowserUserEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import { COMMENT_RANGE_CLASS } from '../comment-decorations.ts';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';
import elementCss from '../../../element/src/styles/element.css?raw';
import { TextSelection } from 'prosemirror-state';

const isBrowser = typeof document !== 'undefined';
const userEvent: typeof BrowserUserEvent | undefined = isBrowser
  ? (await import('vitest/browser')).userEvent
  : undefined;
const THREAD = 'thread-fe-048-caret';

describe.skipIf(!isBrowser)('comment ranges add no caret stop (FE-048 criterion 8)', () => {
  it('moves the caret one text position per arrow key through the commented text', async () => {
    if (!userEvent) throw new Error('userEvent is only available in Browser Mode');
    const style = document.createElement('style');
    style.textContent = elementCss;
    document.head.append(style);
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
      const ic = internals(core);

      let start = -1;
      ic.state.doc.descendants((node, pos) => {
        if (start < 0 && node.attrs['id'] === STYLE_IDS.plain) start = pos + 1;
        return start < 0;
      });
      const end = start + 4;
      const docBefore = ic.state.doc;

      core.setThreadRange(THREAD, { from: start, to: end }, 1);
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`)).toHaveLength(1),
      );

      // The caret starts at the first commented character; the arrow keys move it through the range.
      surface.focus();
      ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, start)));
      await vi.waitFor(() => expect(ic.state.selection.from).toBe(start));

      const visited: number[] = [ic.state.selection.from];
      for (let step = 0; step < 4; step++) {
        const before = ic.state.selection.from;
        await userEvent.keyboard('{ArrowRight}');
        await vi.waitFor(() => expect(ic.state.selection.from).not.toBe(before));
        visited.push(ic.state.selection.from);
      }

      // Each arrow key moved the caret exactly one position: no stop was skipped and none was added.
      expect(visited).toEqual([start, start + 1, start + 2, start + 3, start + 4]);
      // The decoration is still one inline element, and the document itself did not change.
      expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`)).toHaveLength(1);
      expect(ic.state.doc.eq(docBefore)).toBe(true);
    } finally {
      unmount();
      core.destroy();
      host.remove();
      style.remove();
    }
  });
});
