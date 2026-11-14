/**
 * Decorations are mapped through a rebuild, and a recomputation from scratch finds no difference
 * (FE-035 criterion 3; lane V-FE-033-048). Node.js, headless core in review mode for `alice`.
 *
 * A remote commit is modelled as a transaction marked `REMOTE` that inserts text before the other
 * decorated text. This exercises the core's mapping of find matches, comment ranges and suggestion
 * decorations; it does not run the sync client's rebuild, which the selection-mapping tests cover
 * with backend-mock. Remote carets are SYN-036's (test/presence-mapping.test.ts) and are not here.
 */
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { findMatches } from '../src/search.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import { REMOTE } from '../src/meta.ts';
import { internals } from '../src/testing.ts';
import { editorAccess } from './fixtures.ts';
import { microtask, posOf } from './support.ts';

const QUERY = 'e';

function reviewer(): DocumentCore {
  let n = 0;
  return new DocumentCore({
    doc: spikeDocument(),
    schedule: microtask,
    mode: 'review',
    user: 'alice',
    access: editorAccess(),
    generateId: () => `r${String(++n).padStart(15, '0')}`,
  });
}

describe('FE-035 criterion 3: decorations after a rebuild equal a recomputation', () => {
  it('find matches, comment ranges and suggestion decorations are mapped through a remote commit', () => {
    const c = reviewer();
    const i = internals(c);
    const from = posOf(i.state.doc, SPIKE_IDS.intro) + 1;

    // A suggestion by alice: typed text carries an ins mark, so the suggestion decorations exist.
    i.dispatch(i.state.tr.insertText('big ', from));
    const threadFrom = from + 4 + 1;
    const threadTo = threadFrom + 4;
    const threadText = i.state.doc.textBetween(threadFrom, threadTo);
    c.setThreadRange('thread-a', { from: threadFrom, to: threadTo }, 1);

    c.findText(QUERY);
    expect(c.findResults().length).toBeGreaterThan(0);
    const beforeMarkup = c.markupDecorations('all');
    expect(beforeMarkup.length).toBeGreaterThan(0);

    // A remote commit inserts text before every decorated range.
    i.dispatch(i.state.tr.insertText('Remote ', from).setMeta(REMOTE, true));

    // Find matches: the kept matches equal a search of the rebuilt document from scratch.
    const fresh = findMatches(i.state.doc, QUERY);
    expect(c.findResults().map((r) => r.after)).toEqual(fresh.map((m) => m.after));
    expect(c.findResults().map((r) => r.text)).toEqual(fresh.map((m) => m.text));

    // Comment range: still covers the same text, moved by the remote insertion.
    const [range] = c.threadRanges.get();
    expect(range).toMatchObject({ id: 'thread-a', detached: false, from: threadFrom + 7 });
    expect(i.state.doc.textBetween(range!.from, range!.to)).toBe(threadText);

    // Suggestion decorations: a core opened on the same document computes the same set.
    const recomputed = new DocumentCore({ doc: c.getContent(), schedule: microtask });
    expect(c.markupDecorations('all')).toEqual(recomputed.markupDecorations('all'));
    expect(c.markupDecorations('all')).toEqual(
      beforeMarkup.map((d) => ({ ...d, from: d.from + 7, to: d.to + 7 })),
    );
  });
});
