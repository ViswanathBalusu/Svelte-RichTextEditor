/**
 * FE-139 criterion 2, the move: in a real browser a person drags a preserved atom to another place,
 * and it goes whole. The atom is selected by a click (a node selection), then the pointer drags it
 * onto the second paragraph; the atom is then in the new place, once, with its label and its
 * fallback text, and the text around it is as it was. The drag is sent as drag events with a data
 * transfer, not as a native mouse drag (the `dragAndDrop` of the browser-mode `userEvent` fails
 * in this setup).
 *
 * Runs through `pnpm vitest run --project browser <this file>`. Skipped in Node.js (no DOM).
 */
import { NodeSelection } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import type { userEvent as BrowserUserEvent } from 'vitest/browser';
import { ownerAccess } from '../../test/fixtures.ts';
import { spikeDocument } from '../spike-document.ts';
import { EditorCore, viewsOf } from './web.ts';

const isBrowser = typeof document !== 'undefined' && typeof DataTransfer !== 'undefined';
// `vitest/browser` throws when it is imported outside Browser Mode.
const userEvent: typeof BrowserUserEvent | undefined = isBrowser
  ? (await import('vitest/browser')).userEvent
  : undefined;

/** The block ids of the body's children in order, with `#atom` for a preserved block. */
function bodyOrder(core: EditorCore): string[] {
  const view = viewsOf(core).view;
  if (!view) throw new Error('the body view is not mounted');
  const out: string[] = [];
  view.state.doc.descendants((node, pos) => {
    if (view.state.doc.resolve(pos).parent.type.name !== 'body') return true;
    out.push(
      node.type.name === 'preserved_block' ? '#atom' : String(node.attrs['id'] ?? node.type.name),
    );
    return false;
  });
  return out;
}

describe.skipIf(!isBrowser)(
  'a preserved atom is moved whole by a drag (FE-139 criterion 2)',
  () => {
    it('moves to the paragraph it is dropped on, once, with its label and fallback text', async () => {
      if (!userEvent) throw new Error('userEvent is only available in Browser Mode');
      const host = document.createElement('div');
      host.style.inlineSize = '600px';
      document.body.append(host);
      const core = new EditorCore({
        doc: spikeDocument(),
        access: ownerAccess(),
        schedule: (run) => queueMicrotask(run),
      });
      const unmount = core.mountBody(host);
      try {
        const view = viewsOf(core).view;
        if (!view) throw new Error('the body view is not mounted');
        const type = view.state.schema.nodes['preserved_block'];
        if (!type) throw new Error('the schema has no preserved_block node');
        // The atom goes in as the first child of the body.
        let bodyStart = -1;
        view.state.doc.descendants((n, pos) => {
          if (bodyStart < 0 && n.type.name === 'body') bodyStart = pos + 1;
          return bodyStart < 0;
        });
        const atom = type.create({
          label: 'chart',
          fragment: 'aFragment0000001',
          fallbackText: 'Sales by quarter',
        });
        view.dispatch(view.state.tr.insert(bodyStart, atom));
        await new Promise((r) => setTimeout(r, 50));
        const before = bodyOrder(core);
        expect(before[0]).toBe('#atom');
        expect(before.filter((id) => id === '#atom')).toHaveLength(1);

        const el = view.dom.querySelector<HTMLElement>('.de-preserved');
        expect(el).not.toBeNull();
        // A click selects the atom as a node.
        await userEvent.click(el!);
        // The browser reports the new DOM selection after the click; the view must have settled.
        await new Promise((r) => setTimeout(r, 200));
        expect(view.state.selection).toBeInstanceOf(NodeSelection);
        expect(view.state.selection.from).toBe(bodyStart);

        // The second paragraph of the body is the target: both it and the atom are in the viewport,
        // where the view can map a pointer position to a document position.
        const paragraphs = Array.from(view.dom.querySelectorAll<HTMLElement>('.de-body > p'));
        const target = paragraphs[1];
        expect(target).toBeDefined();
        const textBefore = view.state.doc.textContent;
        // Drag events with a data transfer, at the centre of the atom and then of the target, as the
        // pointer sends them: the view's own drag and drop handlers do the move.
        const centre = (e: HTMLElement): { clientX: number; clientY: number } => {
          const r = e.getBoundingClientRect();
          return { clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 };
        };
        const transfer = new DataTransfer();
        const send = (on: HTMLElement, type: string): void => {
          on.dispatchEvent(
            new DragEvent(type, {
              bubbles: true,
              cancelable: true,
              dataTransfer: transfer,
              ...centre(on),
            }),
          );
        };
        // The view may draw the selected atom again; the drag starts on the element that is in the page.
        const live = view.dom.querySelector<HTMLElement>('.de-preserved');
        expect(live).not.toBeNull();
        send(live!, 'dragstart');
        send(target!, 'dragenter');
        send(target!, 'dragover');
        send(target!, 'drop');
        send(live!, 'dragend');
        await new Promise((r) => setTimeout(r, 100));

        const after = bodyOrder(core);
        expect(after.filter((id) => id === '#atom')).toHaveLength(1);
        expect(after.length).toBe(before.length);
        expect(after[0]).not.toBe('#atom');
        expect(after.indexOf('#atom')).toBeGreaterThan(0);
        // Nothing of the atom's text leaked into a paragraph, and no paragraph text was lost.
        expect(view.state.doc.textContent).toBe(textBefore);
        const moved = view.dom.querySelector('.de-preserved');
        expect(moved?.textContent).toContain('Chart, from Word');
        expect(moved?.textContent).toContain('Sales by quarter');
      } finally {
        unmount();
        core.destroy();
        host.remove();
      }
    });
  },
);
