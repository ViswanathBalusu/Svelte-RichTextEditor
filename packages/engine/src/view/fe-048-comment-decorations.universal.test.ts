/**
 * The comment ranges in a mounted body view (FE-048 criteria 1 and 5; lane V-FE-033-048). A thread's
 * range is drawn as an element over its text with the class `de-comment-range` and the thread's
 * identifier; the element carries a dotted underline (a cue that is not colour). When the commented
 * text is deleted the range collapses, the element is removed, and the thread is reported detached.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>` (Chromium,
 * Firefox and WebKit); in Node.js there is no DOM, so the suite is skipped there. The mapping and the
 * decoration function are tested in test/fe-048-core-threads.test.ts.
 */
import { describe, expect, it, vi } from 'vitest';
import { COMMENT_RANGE_CLASS } from '../comment-decorations.ts';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';
// The shipped style sheet of the element, as text: the cue of the class comes from the real rule.
import elementCss from '../../../element/src/styles/element.css?raw';

const isBrowser = typeof document !== 'undefined';
const THREAD = 'thread-fe-048-view';

describe.skipIf(!isBrowser)('comment ranges in the body view (FE-048 criteria 1 and 5)', () => {
  it('draws a range over its text and removes the decoration when the text is deleted', async () => {
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

      // The first four characters of the plain paragraph are the commented text.
      let from = -1;
      ic.state.doc.descendants((node, pos) => {
        if (from < 0 && node.attrs['id'] === STYLE_IDS.plain) from = pos + 1;
        return from < 0;
      });
      const to = from + 4;
      const covered = ic.state.doc.textBetween(from, to);
      expect(covered).toHaveLength(4);

      core.setThreadRange(THREAD, { from, to }, 1);
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`)).toHaveLength(1),
      );
      const span = surface.querySelector<HTMLElement>(`.${COMMENT_RANGE_CLASS}`)!;
      expect(span.textContent).toBe(covered);
      expect(span.dataset['threadId']).toBe(THREAD);
      // The cue that is not colour: a dotted underline on the element.
      expect(getComputedStyle(span).textDecorationLine).toContain('underline');
      expect(getComputedStyle(span).textDecorationStyle).toBe('dotted');

      // The commented text is deleted: the range collapses, its decoration goes, and it is detached.
      ic.dispatch(ic.state.tr.delete(from, to));
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`)).toHaveLength(0),
      );
      const [range] = core.threadRanges.get();
      expect(range).toMatchObject({ id: THREAD, detached: true });
    } finally {
      unmount();
      core.destroy();
      host.remove();
      style.remove();
    }
  });
});
