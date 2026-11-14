/**
 * The page guides of the web view (FE-068 criteria 2 and 3; lane V-FE-065-080, round 3). The element
 * gives the identifiers of the blocks before which a guide is drawn (`setPageGuides`); each guide is
 * a `de-page-guide` element placed directly before that block and never inside a paragraph, hidden
 * from assistive technology. Without identifiers, or after an empty list, no guide is drawn, and the
 * document does not change.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>` (Chromium,
 * Firefox and WebKit); in Node.js there is no DOM, so the suite is skipped there.
 */
import { describe, expect, it, vi } from 'vitest';
import { PAGE_GUIDE_CLASS } from '../page-guide-decorations.ts';
import { internals } from '../testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)('page guides in the body view (FE-068 criteria 2 and 3)', () => {
  it('draws a guide before each named block, outside every paragraph, and none when cleared', async () => {
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
      const before = internals(core).state.doc.toJSON();
      expect(surface.querySelectorAll(`.${PAGE_GUIDE_CLASS}`)).toHaveLength(0);

      // The guide sits between the block before it and the block it names.
      core.setPageGuides([STYLE_IDS.plain, STYLE_IDS.after]);
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${PAGE_GUIDE_CLASS}`)).toHaveLength(2),
      );
      const guides = [...surface.querySelectorAll<HTMLElement>(`.${PAGE_GUIDE_CLASS}`)];
      for (const guide of guides) {
        expect(guide.getAttribute('aria-hidden')).toBe('true');
        expect(guide.textContent).toBe('');
        // A guide sits on the surface and never inside a paragraph.
        expect(surface.contains(guide)).toBe(true);
        expect(guide.closest('p')).toBeNull();
      }
      // Before the plain paragraph, and before the block after the region (FE-068 criterion 2).
      const plainGuide = guides.find((g) => g.dataset['blockId'] === STYLE_IDS.plain);
      expect(plainGuide?.nextElementSibling?.textContent).toBe('Plain text');
      const afterGuide = guides.find((g) => g.dataset['blockId'] === STYLE_IDS.after);
      expect(afterGuide?.nextElementSibling?.textContent).toBe('After the region');

      // The document is not changed by the guides.
      expect(internals(core).state.doc.toJSON()).toEqual(before);

      // An empty list removes every guide (guides are off by default).
      core.setPageGuides([]);
      await vi.waitFor(() =>
        expect(surface.querySelectorAll(`.${PAGE_GUIDE_CLASS}`)).toHaveLength(0),
      );
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
