/**
 * A find navigation scrolls its match into view (FE-059 criterion 2). A long paragraph with many
 * matches sits in a short scroll container; moving to the last match, by wrapping backwards from the
 * first, must bring it inside the container's visible area. Runs in real browser engines through
 * `pnpm test:browsers`; skipped in Node.js, where there is no layout.
 */
import { describe, expect, it, vi } from 'vitest';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { REMOTE } from '../meta.ts';
import { FIND_CURRENT_CLASS } from '../search-highlight.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)(
  'a find navigation scrolls its match into view (FE-059 criterion 2)',
  () => {
    it('the last match, reached by wrapping backwards, is inside the visible scroll area', async () => {
      const scroller = document.createElement('div');
      scroller.style.cssText = 'width:480px;height:160px;overflow:auto;';
      document.body.append(scroller);
      const host = document.createElement('div');
      scroller.append(host);
      const core = new EditorCore({
        doc: styledDocument(),
        access: styledEditorAccess(),
        schedule: (run) => queueMicrotask(run),
      });
      const unmount = core.mountBody(host);
      try {
        const ic = internals(core);
        let end = -1;
        ic.state.doc.descendants((node, pos) => {
          if (end < 0 && node.attrs['id'] === STYLE_IDS.plain) end = pos + 1 + node.content.size;
          return end < 0;
        });
        ic.dispatch(ic.state.tr.insertText(' text'.repeat(300), end).setMeta(REMOTE, true));

        core.findText('text');
        // Wrapping backwards from no current match selects the last match.
        expect(core.findPrevious()).toBe(true);
        expect(core.findState.get().current).toBe(core.findState.get().count);
        await vi.waitFor(() =>
          expect(document.querySelector(`.${FIND_CURRENT_CLASS}`)).not.toBeNull(),
        );
        const match = document.querySelector(`.${FIND_CURRENT_CLASS}`)!.getBoundingClientRect();
        const area = scroller.getBoundingClientRect();
        expect(match.top).toBeGreaterThanOrEqual(area.top - 1);
        expect(match.bottom).toBeLessThanOrEqual(area.bottom + 1);
        expect(scroller.scrollTop).toBeGreaterThan(0);
      } finally {
        unmount();
        core.destroy();
        scroller.remove();
      }
    });
  },
);
