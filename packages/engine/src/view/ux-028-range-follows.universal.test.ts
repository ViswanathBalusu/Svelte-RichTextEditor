/**
 * The highlight of a comment stays on the same text when the text around it changes (UX-028
 * criterion 6; lane w3). A thread's range is drawn as an element over its text; edits before it,
 * inside it and a second thread's edits are applied to the mounted body view, and after each one
 * the element still covers the same words. The mapping function is the authority's (FE-048
 * criterion 2, test/fe-048-range-agreement.test.ts); this test checks what is drawn.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>` (Chromium,
 * Firefox and WebKit); in Node.js there is no DOM, so the suite is skipped there.
 */
import { describe, expect, it, vi } from 'vitest';
import { COMMENT_RANGE_CLASS } from '../comment-decorations.ts';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';
const THREAD = 'thread-ux-028-follows';

describe.skipIf(!isBrowser)('the highlight follows its text (UX-028 criterion 6)', () => {
  it('keeps covering the same words after insertions before, inside and after, and after a deletion before', async () => {
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
      // Four characters from the third character of the paragraph.
      const from = start + 2;
      const to = from + 4;
      const covered = ic.state.doc.textBetween(from, to);
      expect(covered).toHaveLength(4);
      core.setThreadRange(THREAD, { from, to }, 1);

      const drawn = async (): Promise<string> => {
        await vi.waitFor(() =>
          expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`).length).toBeGreaterThan(0),
        );
        return [...surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`)]
          .map((el) => el.textContent)
          .join('');
      };
      expect(await drawn()).toBe(covered);

      // Insertion before the range: the range moves right, the words under it are the same.
      ic.dispatch(ic.state.tr.insertText('>>> ', start));
      expect(await drawn()).toBe(covered);
      const moved = core.threadRanges.get()[0]!;
      expect(moved.from).toBe(from + 4);
      expect(ic.state.doc.textBetween(moved.from, moved.to)).toBe(covered);

      // Insertion inside the range: it grows, and the highlight shows the old words with the new.
      const inside = moved.from + 2;
      ic.dispatch(ic.state.tr.insertText('XY', inside));
      const grown = core.threadRanges.get()[0]!;
      const text = ic.state.doc.textBetween(grown.from, grown.to);
      expect(text).toBe(covered.slice(0, 2) + 'XY' + covered.slice(2));
      await vi.waitFor(async () => expect(await drawn()).toBe(text));

      // Insertion after the range: nothing moves.
      ic.dispatch(ic.state.tr.insertText('!!', grown.to + 1));
      expect(await drawn()).toBe(text);

      // Deletion before the range: it moves left and still covers the same words.
      ic.dispatch(ic.state.tr.delete(start, start + 4));
      const left = core.threadRanges.get()[0]!;
      expect(left.from).toBe(grown.from - 4);
      expect(ic.state.doc.textBetween(left.from, left.to)).toBe(text);
      expect(await drawn()).toBe(text);
      expect(core.threadRanges.get()[0]).toMatchObject({ id: THREAD, detached: false });
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
