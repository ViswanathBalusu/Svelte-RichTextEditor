/**
 * The header panel's name and focus in a real browser (U-FE-049-064 lane; FE-057 criterion 4, the
 * accessible name and the return of focus to the body on close; 02 §8).
 *
 * - The panel's editable surface carries an accessible name (`aria-label`, the story label of the web
 *   view: "Header" by default).
 * - Focus goes into the panel when it is open, and `closePanel()` returns it to the body surface.
 *
 * Not covered here: the visible focus style (the element's stylesheet, not built in the engine) and
 * opening the panel from the keyboard (the shell's shortcut). FE-057 criterion 4 therefore stays
 * unticked in the story; this file is evidence for its two named parts only.
 *
 * Runs in real browser engines through `pnpm vitest run --project browser <this file>`. In Node.js
 * there is no DOM, so the suite is skipped there.
 */
import { describe, expect, it } from 'vitest';
import { ownerAccess } from '../../test/fixtures.ts';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';

describe.skipIf(!isBrowser)('header panel name and focus (FE-057 criterion 4, two parts)', () => {
  it('the panel surface has an accessible name, focus goes in on open and back to the body on close', async () => {
    const bodyHost = document.createElement('div');
    const panelHost = document.createElement('div');
    document.body.append(bodyHost, panelHost);
    const core = new EditorCore({
      doc: spikeDocument(),
      access: ownerAccess(),
      schedule: (run) => queueMicrotask(run),
    });
    const unmountBody = core.mountBody(bodyHost);
    try {
      expect(core.openStory(SPIKE_IDS.header)).toBe(true);
      const unmountPanel = core.mountPanel(panelHost);
      const sub = viewsOf(core).subEditor;
      if (!sub) throw new Error('the header sub-editor was not mounted');
      // Accessible name of the editing surface of the panel.
      expect(sub.view.dom.getAttribute('aria-label')).toBeTruthy();
      expect(sub.view.dom.getAttribute('aria-label')).toBe('Header');
      // Focus moves into the panel while it is open.
      sub.view.focus();
      await new Promise((r) => setTimeout(r, 20));
      expect(panelHost.contains(document.activeElement)).toBe(true);
      unmountPanel();
      core.closePanel();
      // Focus is back on the body editing surface.
      await new Promise((r) => setTimeout(r, 20));
      // The editor may take the mount element's place in the page, so the surface is looked up there.
      const surface = document.querySelector<HTMLElement>('.de-editing-surface');
      expect(surface).not.toBeNull();
      expect(surface!.contains(document.activeElement)).toBe(true);
    } finally {
      unmountBody();
      core.destroy();
      bodyHost.remove();
      panelHost.remove();
    }
  });
});
