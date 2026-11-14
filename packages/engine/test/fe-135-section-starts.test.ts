/**
 * FE-135 criterion 2 (lane FE-131-141, round 3): a section break with each start type becomes a
 * direct child of `body`, with its own page setup; a start type outside the four is refused.
 * 03 §4.2 (`section_break`), 07 §5.2 (P2).
 */
import type { EditorState, Transaction } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { SECTION_STARTS, insertSectionBreak, pageSetupNode } from '../src/breaks-sections.ts';
import { LAYOUT_IDS, caretIn, layoutState } from './layout-doc.ts';

const writable = () => true;

/** The body caret, as the existing break tests place it (outside every region). */
function bodyCaret(): EditorState {
  return caretIn(layoutState(), LAYOUT_IDS.pB, 2);
}

/** Runs the command with a dispatch that keeps the new state; returns the result and that state. */
function run(state: EditorState, start: string, index: number) {
  const pad = String(index).padStart(10, '0');
  let next: EditorState = state;
  const result = insertSectionBreak(
    state,
    { start, sectionId: `secStart${pad}`, pageSetupId: `psStart${pad}`, writable },
    (tr: Transaction) => {
      next = state.apply(tr);
    },
  );
  return { result, next };
}

describe('a section break takes each start type (FE-135 criterion 2)', () => {
  it('inserts a section_break with that start type as a direct child of body, with its own page setup', () => {
    SECTION_STARTS.forEach((start, index) => {
      const { result, next } = run(bodyCaret(), start, index);
      expect(result, start).toEqual({ ok: true });

      // The section break is a direct child of body (CDM): look up its parent at its position.
      const sections: { parent: string; start: unknown; pageSetup: unknown }[] = [];
      next.doc.descendants((child, pos) => {
        if (child.type.name === 'section_break') {
          sections.push({
            parent: next.doc.resolve(pos).parent.type.name,
            start: child.attrs['start'],
            pageSetup: child.attrs['pageSetup'],
          });
        }
        return true;
      });
      const added = sections.find((s) => s.start === start);
      expect(added, start).toBeDefined();
      expect(added!.parent, start).toBe('body');
      expect(added!.pageSetup, start).toBe(`psStart${String(index).padStart(10, '0')}`);
      expect(
        pageSetupNode(next.doc, `psStart${String(index).padStart(10, '0')}`),
        start,
      ).not.toBeNull();
    });
  });

  it('refuses a start type outside the four, and dispatches nothing', () => {
    let dispatched = false;
    const result = insertSectionBreak(
      bodyCaret(),
      {
        start: 'sideways',
        sectionId: 'secStartBad0000001',
        pageSetupId: 'psStartBad0000001',
        writable,
      },
      () => {
        dispatched = true;
      },
    );
    expect(result).toEqual({ ok: false, reason: 'bad-start' });
    expect(dispatched).toBe(false);
  });
});
