/**
 * FE-133 criterion 3 in a browser: an in-document link in the rendered text is followed with a
 * Ctrl-click (a plain click places the caret, as in any editable text), and the caret moves to the
 * start of the heading it names. Runs in real browser engines through `pnpm test:browsers`; skipped
 * in Node.js, where there is no DOM.
 */
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { SPIKE_IDS, spikeDocument } from '../spike-document.ts';
import { REMOTE } from '../meta.ts';
import { internals } from '../testing.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

describe.skipIf(!isBrowser)('following a link to a heading (FE-133 criterion 3)', () => {
  it('a Ctrl-click on #<heading id> puts the caret at the start of the heading; a plain click does not', () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = new EditorCore({ doc: spikeDocument(), schedule: (run) => queueMicrotask(run) });
    const unmount = core.mountBody(host);
    try {
      const ic = internals(core);
      let heading = -1;
      let last = -1;
      let lastSize = 0;
      ic.state.doc.descendants((node, pos) => {
        if (node.attrs['id'] === SPIKE_IDS.title) heading = pos;
        if (node.attrs['id'] === SPIKE_IDS.last) {
          last = pos;
          lastSize = node.content.size;
        }
        return true;
      });
      expect(heading).toBeGreaterThanOrEqual(0);
      expect(lastSize).toBeGreaterThan(0);
      const mark = ic.state.schema.marks['link']!.create({
        href: `#${SPIKE_IDS.title}`,
        title: null,
      });
      ic.dispatch(ic.state.tr.addMark(last + 1, last + 1 + lastSize, mark).setMeta(REMOTE, true));
      const anchor = host.querySelector<HTMLAnchorElement>('a[href^="#"]');
      expect(anchor).not.toBeNull();

      const click = (init: MouseEventInit): boolean =>
        anchor!.dispatchEvent(
          new MouseEvent('click', { bubbles: true, cancelable: true, composed: true, ...init }),
        );

      // The caret is in the paragraph with the link, away from the heading. A plain click in
      // editable text is left to the editor: the caret is not sent to the heading.
      ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, last + 1)));
      expect(internals(core).state.selection.head).not.toBe(heading + 1);
      click({});
      expect(internals(core).state.selection.head).not.toBe(heading + 1);

      // Ctrl-click follows the link, and the browser's own jump to a fragment is stopped.
      const notPrevented = click({ ctrlKey: true });
      expect(internals(core).state.selection.head).toBe(heading + 1);
      expect(notPrevented).toBe(false);
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
