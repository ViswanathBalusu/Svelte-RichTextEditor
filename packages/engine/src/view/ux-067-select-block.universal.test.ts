/**
 * UX-067 criterion 1 in a browser: choosing a block far below the visible area of a short scroll
 * container (what the accessibility checker, the outline and the export diagnostics do through
 * `selectBlock`) brings its caret inside the visible area. Runs in real browser engines through
 * `pnpm test:browsers`; skipped in Node.js, where there is no layout.
 */
import { describe, expect, it, vi } from 'vitest';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { REMOTE } from '../meta.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)('selectBlock scrolls the block into view (UX-067 criterion 1)', () => {
  it('a block pushed far below the visible area ends up inside it, with the caret in it', async () => {
    const scroller = document.createElement('div');
    scroller.style.cssText = 'width:480px;height:160px;overflow:auto;';
    document.body.append(scroller);
    const host = document.createElement('div');
    scroller.append(host);
    const core = new EditorCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
    const unmount = core.mountBody(host);
    try {
      const ic = internals(core);
      let end = -1;
      ic.state.doc.descendants((node, pos) => {
        if (end < 0 && node.attrs['id'] === SPIKE_IDS.title) end = pos + 1 + node.content.size;
        return end < 0;
      });
      ic.dispatch(ic.state.tr.insertText(' filler'.repeat(600), end).setMeta(REMOTE, true));
      expect(scroller.scrollHeight).toBeGreaterThan(scroller.clientHeight * 2);
      expect(scroller.scrollTop).toBe(0);

      expect(core.selectBlock(SPIKE_IDS.last)).toBe(true);
      await vi.waitFor(() => expect(scroller.scrollTop).toBeGreaterThan(0));
      const caret = core.caretRect();
      expect(caret).not.toBeNull();
      const area = scroller.getBoundingClientRect();
      expect(caret!.y).toBeGreaterThanOrEqual(area.top - 1);
      expect(caret!.y + caret!.height).toBeLessThanOrEqual(area.bottom + 1);
    } finally {
      unmount();
      core.destroy();
      scroller.remove();
    }
  });
});
