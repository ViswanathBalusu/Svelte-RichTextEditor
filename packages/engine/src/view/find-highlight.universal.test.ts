/**
 * The find highlights in a mounted body view (FE-059 criteria 1 and 4): the decorations of
 * `findDecorations` are drawn as elements of the editing surface, the current match gets its own
 * class, and a remote commit that adds a match draws one more highlight.
 *
 * Runs in real browser engines through `pnpm test:browsers`; in Node.js there is no DOM, so the
 * suite is skipped there (the decoration function itself is tested in test/search-highlight.test.ts).
 */
import { describe, expect, it, vi } from 'vitest';
import { REMOTE } from '../meta.ts';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { FIND_CURRENT_CLASS, FIND_MATCH_CLASS } from '../search-highlight.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)('find highlights in the body view (FE-059 criteria 1 and 4)', () => {
  it('draws one highlight per match, marks the current one, and draws a remote match too', async () => {
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
      const highlights = () =>
        surface.querySelectorAll(`.${FIND_MATCH_CLASS}, .${FIND_CURRENT_CLASS}`);

      core.findText('text');
      await vi.waitFor(() => expect(highlights()).toHaveLength(2));
      expect(surface.querySelectorAll(`.${FIND_CURRENT_CLASS}`)).toHaveLength(0);

      core.findNext();
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${FIND_CURRENT_CLASS}`)).toHaveLength(1),
      );
      expect(surface.querySelector(`.${FIND_CURRENT_CLASS}`)!.textContent).toBe('text');

      // A remote commit adds "text" to the plain paragraph: one more highlight, and the count follows.
      const ic = internals(core);
      let at = -1;
      ic.state.doc.descendants((node, pos) => {
        if (at < 0 && node.attrs['id'] === STYLE_IDS.plain) at = pos + 1 + node.content.size;
        return at < 0;
      });
      ic.dispatch(ic.state.tr.insertText(' text', at).setMeta(REMOTE, true));
      await vi.waitFor(() => expect(highlights()).toHaveLength(3));
      expect(core.findState.get().count).toBe(3);
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
