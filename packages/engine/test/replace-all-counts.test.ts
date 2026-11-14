/**
 * Replace all reports real counts (FE-060 criterion 3), on the headless core. Matches are put into
 * an editable paragraph and into a locked region by remote commits (which the guard does not
 * refuse), then Replace all runs through the core's own guard. The counts it reports must equal
 * the matches that were there, and the locked matches must still be there afterwards.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { REMOTE } from '../src/meta.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';

/** The position just after the content of the paragraph `id`. */
function endOf(doc: PMNode, id: string): number {
  let at = -1;
  doc.descendants((node, pos) => {
    if (at < 0 && node.attrs['id'] === id) at = pos + 1 + node.content.size;
    return at < 0;
  });
  if (at < 0) throw new Error(`no node ${id}`);
  return at;
}

/** The text of the paragraph `id`. */
function textOf(doc: PMNode, id: string): string {
  let text: string | null = null;
  doc.descendants((node) => {
    if (text === null && node.attrs['id'] === id) text = node.textContent;
    return text === null;
  });
  if (text === null) throw new Error(`no node ${id}`);
  return text;
}

/** Non-overlapping occurrences of `query` in `s`. */
function occurrences(s: string, query: string): number {
  let n = 0;
  let i = s.indexOf(query);
  while (i !== -1) {
    n++;
    i = s.indexOf(query, i + query.length);
  }
  return n;
}

describe('replace all counts (FE-060 criterion 3)', () => {
  it('for any number of matches in editable and locked paragraphs, the counts are the real ones (property)', () => {
    fc.assert(
      fc.property(fc.nat({ max: 4 }), fc.nat({ max: 4 }), (extraEditable, extraLocked) => {
        const c = new DocumentCore({
          doc: styledDocument(),
          access: styledEditorAccess(),
        });
        const ic = internals(c);
        // Remote commits add "text" to each paragraph: the editable one and the locked region's.
        ic.dispatch(
          ic.state.tr
            .insertText(' text'.repeat(extraEditable), endOf(ic.state.doc, STYLE_IDS.plain))
            .setMeta(REMOTE, true),
        );
        ic.dispatch(
          ic.state.tr
            .insertText(' text'.repeat(extraLocked), endOf(ic.state.doc, STYLE_IDS.inRegion))
            .setMeta(REMOTE, true),
        );
        const editableBefore = occurrences(textOf(internals(c).state.doc, STYLE_IDS.plain), 'text');
        const lockedBefore = occurrences(
          textOf(internals(c).state.doc, STYLE_IDS.inRegion),
          'text',
        );
        expect(editableBefore).toBe(1 + extraEditable);
        expect(lockedBefore).toBe(1 + extraLocked);

        c.findText('text');
        expect(c.findState.get().count).toBe(editableBefore + lockedBefore);

        const report = c.replaceAll('words');
        expect(report).toEqual({ replaced: editableBefore, skipped: lockedBefore });

        const after = internals(c).state.doc;
        // Every editable match was replaced; every locked match is still there.
        expect(occurrences(textOf(after, STYLE_IDS.plain), 'text')).toBe(0);
        expect(occurrences(textOf(after, STYLE_IDS.inRegion), 'text')).toBe(lockedBefore);
        expect(c.findState.get().count).toBe(lockedBefore);
        // A notice is recorded only because a locked match was skipped (criterion 3, engine part).
        expect(c.refusal.get()?.reason ?? null).toBe('scope');
        c.destroy();
      }),
      { numRuns: 40 },
    );
  });
});
