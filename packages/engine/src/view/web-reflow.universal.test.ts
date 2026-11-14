/**
 * The web view reflows when its container changes width and draws no page boundaries (FE-066
 * criterion 3). Runs in real browser engines through `pnpm test:browsers`; skipped in Node.js,
 * where there is no layout.
 */
import { describe, expect, it, vi } from 'vitest';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { REMOTE } from '../meta.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)('the web view reflows with its container (FE-066 criterion 3)', () => {
  it('a narrower container makes the same text taller, and no page boundary is drawn', async () => {
    const outer = document.createElement('div');
    outer.style.width = '800px';
    document.body.append(outer);
    const host = document.createElement('div');
    outer.append(host);
    const core = new EditorCore({
      doc: styledDocument(),
      access: styledEditorAccess(),
      schedule: (run) => queueMicrotask(run),
    });
    const unmount = core.mountBody(host);
    try {
      const surface = document.querySelector<HTMLElement>('.de-editing-surface');
      if (!surface) throw new Error('the body surface was not mounted');
      // A long paragraph, so that the number of lines changes with the width. A remote commit adds
      // the words, as a collaborator's would.
      const ic = internals(core);
      let end = -1;
      ic.state.doc.descendants((node, pos) => {
        if (end < 0 && node.attrs['id'] === STYLE_IDS.plain) end = pos + 1 + node.content.size;
        return end < 0;
      });
      ic.dispatch(ic.state.tr.insertText(' word'.repeat(60), end).setMeta(REMOTE, true));
      const wide = surface.getBoundingClientRect().height;
      outer.style.width = '240px';
      await vi.waitFor(() => {
        expect(surface.getBoundingClientRect().width).toBeLessThan(300);
      });
      const narrow = surface.getBoundingClientRect().height;
      expect(narrow).toBeGreaterThan(wide);
      // The continuous sheet shows no page edges: no element of the view carries a page class.
      expect(document.querySelectorAll('[class*="de-page"], [class*="page-break"]')).toHaveLength(
        0,
      );
    } finally {
      unmount();
      core.destroy();
      outer.remove();
    }
  });
});
