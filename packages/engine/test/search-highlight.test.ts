/**
 * The find highlights (FE-059 criteria 1 and 4), on the headless core: the decorations that the web
 * view draws for the matches, from the core's own find state. No browser: the test reads the
 * decoration set and its ranges. How the highlight looks is the element's style sheet.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import type { DecorationSet } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { REMOTE } from '../src/meta.ts';
import { FIND_CURRENT_CLASS, FIND_MATCH_CLASS, findDecorations } from '../src/search-highlight.ts';
import { internals } from '../src/testing.ts';
import { STYLE_IDS, styledDocument, styledEditorAccess } from './fixtures.ts';

function core(): DocumentCore {
  return new DocumentCore({ doc: styledDocument(), access: styledEditorAccess() });
}

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

/** The highlights as `[text, class]` pairs in document order. */
function highlights(set: DecorationSet, doc: PMNode): Array<[string, string]> {
  return set.find().map((d) => {
    // `type` holds the inline attributes; the declaration files do not export it.
    const attrs = (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs;
    return [doc.textBetween(d.from, d.to), attrs['class'] ?? ''] as [string, string];
  });
}

/** Non-overlapping occurrences of `query` in the body's paragraphs, counted naively. */
function naiveCount(doc: PMNode, query: string): number {
  const body = doc.lastChild;
  if (!body) return 0;
  let total = 0;
  body.descendants((node) => {
    if (!node.isTextblock) return true;
    const s = node.textContent;
    let i = s.indexOf(query);
    while (i !== -1) {
      total++;
      i = s.indexOf(query, i + query.length);
    }
    return false;
  });
  return total;
}

describe('find highlights (FE-059 criteria 1 and 4)', () => {
  it('draws one highlight per body match and changes no document', () => {
    const c = core();
    const before = c.getContent();
    c.findText('text');
    const ic = internals(c);
    const set = findDecorations(ic.state.doc, c.findState.get());
    expect(set.find()).toHaveLength(c.findState.get().count);
    expect(highlights(set, ic.state.doc)).toEqual([
      ['text', FIND_MATCH_CLASS],
      ['text', FIND_MATCH_CLASS],
    ]);
    expect(c.getContent()).toEqual(before);
    c.destroy();
  });

  it('marks only the current match with the current class, and moves with next', () => {
    const c = core();
    c.findText('text');
    c.findNext();
    const ic = internals(c);
    let set = findDecorations(ic.state.doc, c.findState.get());
    expect(highlights(set, ic.state.doc)).toEqual([
      ['text', FIND_CURRENT_CLASS],
      ['text', FIND_MATCH_CLASS],
    ]);
    c.findNext();
    set = findDecorations(internals(c).state.doc, c.findState.get());
    expect(highlights(set, ic.state.doc).map(([, cls]) => cls)).toEqual([
      FIND_MATCH_CLASS,
      FIND_CURRENT_CLASS,
    ]);
    c.destroy();
  });

  it('a remote commit that adds a match adds its highlight and the count follows (criterion 4)', () => {
    const c = core();
    c.findText('text');
    const ic = internals(c);
    ic.dispatch(
      ic.state.tr.insertText(' text', endOf(ic.state.doc, STYLE_IDS.plain)).setMeta(REMOTE, true),
    );
    const set = findDecorations(internals(c).state.doc, c.findState.get());
    expect(c.findState.get().count).toBe(3);
    expect(set.find()).toHaveLength(3);
    c.destroy();
  });

  it('a remote commit that removes a match removes its highlight', () => {
    const c = core();
    c.findText('text');
    const ic = internals(c);
    const at = endOf(ic.state.doc, STYLE_IDS.inRegion);
    ic.dispatch(
      ic.state.tr.insertText('Protected', at - 'Protected text'.length, at).setMeta(REMOTE, true),
    );
    const set = findDecorations(internals(c).state.doc, c.findState.get());
    expect(set.find()).toHaveLength(1);
    expect(c.findState.get().count).toBe(1);
    c.destroy();
  });

  it('a highlight is drawn for a match in a region the user may not change (finding is never refused)', () => {
    const c = core();
    c.findText('Protected');
    const ic = internals(c);
    const set = findDecorations(ic.state.doc, c.findState.get());
    expect(highlights(set, ic.state.doc)).toEqual([['Protected', FIND_MATCH_CLASS]]);
    c.destroy();
  });

  it('an empty query, and a query with no match, draw nothing', () => {
    const c = core();
    const ic = internals(c);
    expect(findDecorations(ic.state.doc, { query: '', current: null }).find()).toEqual([]);
    c.findText('zzz');
    expect(findDecorations(ic.state.doc, c.findState.get()).find()).toEqual([]);
    c.destroy();
  });

  it('for any text inserted remotely, the highlights are the non-overlapping matches (property)', () => {
    fc.assert(
      fc.property(
        fc.array(fc.constantFrom('a', 'b', ' '), { maxLength: 40 }).map((cs) => cs.join('')),
        fc.constantFrom('a', 'ab', 'aa'),
        (inserted, query) => {
          const c = core();
          c.findText(query);
          const ic = internals(c);
          ic.dispatch(
            ic.state.tr
              .insertText(inserted, endOf(ic.state.doc, STYLE_IDS.plain))
              .setMeta(REMOTE, true),
          );
          const doc = internals(c).state.doc;
          const set = findDecorations(doc, c.findState.get());
          const expected = naiveCount(doc, query);
          expect(c.findState.get().count).toBe(expected);
          expect(set.find()).toHaveLength(expected);
          for (const [text] of highlights(set, doc)) expect(text).toBe(query);
          c.destroy();
        },
      ),
      { numRuns: 60 },
    );
  });
});
