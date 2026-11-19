/**
 * A thread on a block is drawn on the block, and a thread is reached from the keyboard (FE-048
 * criteria 1 and 7; 02 §5.2). Runs in real browser engines through
 * `pnpm vitest run --project browser <this file>`; in Node.js there is no DOM and the suite is
 * skipped (the logic is in test/fe-048-thread-keyboard.test.ts).
 *
 * - The figure of a document carries `de-comment-block` and the thread's identifier, and the shipped
 *   style sheet gives it a dashed outline: a cue that is not colour.
 * - Real key presses: Alt+F8 moves the caret to the next thread (a range, then the block) and
 *   Shift+Alt+F8 moves back; the document does not change.
 */
import { TextSelection } from 'prosemirror-state';
import type { userEvent as BrowserUserEvent } from 'vitest/browser';
import { describe, expect, it, vi } from 'vitest';
import type { CdmEnvelope, CdmJsonNode } from '../api.ts';
import { COMMENT_BLOCK_CLASS, COMMENT_RANGE_CLASS } from '../comment-decorations.ts';
import { internals } from '../testing.ts';
import { LAYOUT_IDS, layoutEnvelope, posOfNode } from '../../test/layout-doc.ts';
import { EditorCore } from './web.ts';
// The shipped style sheet of the element, as text: the cue of the class comes from the real rule.
import elementCss from '../../../element/src/styles/element.css?raw';

const isBrowser = typeof document !== 'undefined';
// `vitest/browser` throws when it is imported outside Browser Mode: `userEvent` is loaded only with a DOM.
const userEvent: typeof BrowserUserEvent | undefined = isBrowser
  ? (await import('vitest/browser')).userEvent
  : undefined;
const EDIT = ['view', 'comment', 'suggest', 'edit'] as const;

describe.skipIf(!isBrowser)(
  'a thread on a block, and the keyboard (FE-048 criteria 1 and 7)',
  () => {
    it('marks the figure with a dashed outline and reaches both threads with Alt+F8', async () => {
      if (!userEvent) throw new Error('userEvent is only available in Browser Mode');
      const style = document.createElement('style');
      style.textContent = elementCss;
      document.head.append(style);
      const host = document.createElement('div');
      document.body.append(host);
      const doc = {
        cdm: 1,
        requires: [],
        doc: layoutEnvelope() as unknown as CdmJsonNode,
      } as CdmEnvelope;
      const core = new EditorCore({
        doc,
        access: {
          rev: 1,
          asOfSeq: 0,
          docRole: 'owner',
          caps: [...EDIT, 'structure', 'manage'],
          scopes: { doc: [...EDIT], body: [...EDIT], defs: [...EDIT] },
          leases: {},
          fill: null,
          restrictions: [],
        },
        schedule: (run) => queueMicrotask(run),
      });
      const unmount = core.mountBody(host);
      try {
        const surface = document.querySelector<HTMLElement>('.de-editing-surface');
        if (!surface) throw new Error('the body surface was not mounted');
        const ic = internals(core);
        const first = posOfNode(ic.state.doc, LAYOUT_IDS.pA) + 1;
        const figure = posOfNode(ic.state.doc, LAYOUT_IDS.figure);
        const docBefore = ic.state.doc;

        core.setThreadRange('on-text', { from: first, to: first + 4 }, 0);
        core.reportThread('on-figure', { seq: 0, block: LAYOUT_IDS.figure });
        await vi.waitFor(() => {
          expect(surface.querySelectorAll(`.${COMMENT_RANGE_CLASS}`)).toHaveLength(1);
          expect(surface.querySelectorAll(`.${COMMENT_BLOCK_CLASS}`)).toHaveLength(1);
        });
        const block = surface.querySelector<HTMLElement>(`.${COMMENT_BLOCK_CLASS}`)!;
        expect(block.dataset['threadId']).toBe('on-figure');
        // The cue that is not colour: a dashed outline from the shipped style sheet.
        expect(getComputedStyle(block).outlineStyle).toBe('dashed');
        expect(parseFloat(getComputedStyle(block).outlineWidth)).toBeGreaterThan(0);

        // Real key presses from the editing surface: next thread, next thread, back.
        surface.focus();
        ic.dispatch(ic.state.tr.setSelection(TextSelection.create(ic.state.doc, first)));
        await userEvent.keyboard('{Alt>}{F8}{/Alt}');
        await vi.waitFor(() => expect(core.selectedThread.get()?.id).toBe('on-figure'));
        expect(ic.state.selection.from).toBe(figure);
        await userEvent.keyboard('{Alt>}{F8}{/Alt}');
        await vi.waitFor(() => expect(core.selectedThread.get()?.id).toBe('on-text'));
        expect(ic.state.selection.from).toBe(first);
        await userEvent.keyboard('{Shift>}{Alt>}{F8}{/Alt}{/Shift}');
        await vi.waitFor(() => expect(core.selectedThread.get()?.id).toBe('on-figure'));
        // The chosen thread is marked more heavily, and the document is as it was.
        expect(surface.querySelector(`.${COMMENT_BLOCK_CLASS}.de-comment-selected`)).not.toBeNull();
        expect(ic.state.doc.eq(docBefore)).toBe(true);
      } finally {
        unmount();
        core.destroy();
        host.remove();
        style.remove();
      }
    });
  },
);
