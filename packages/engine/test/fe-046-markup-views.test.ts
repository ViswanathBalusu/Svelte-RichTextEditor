/**
 * The markup views of the review tools (FE-046 criterion 4; 02 §5.2; 13 §3): the core builds the
 * decoration set of the view it is asked for, from the suggestion marks of the document. The spike
 * document's intro paragraph carries an `ins` run, a `del` run next to it, and a block `fmt` mark.
 * The views' rules are the default taken in `src/suggestion-markup.ts`; the spec does not define
 * them (see docs/adr/0132-engine-3-backlog-batch.md). The control and its labels are UX's and are
 * not run here, and the drawing of the classes is not run in a browser.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { DocumentCore } from '../src/headless.ts';
import { SPIKE_IDS, spikeDocument } from '../src/spike-document.ts';
import type { SuggestionSpec } from '../src/suggestion-markup.ts';
import { internals } from '../src/testing.ts';
import { microtask, posOf } from './support.ts';

/** The attributes a decoration was made with. */
function attrsOf(d: SuggestionSpec): Readonly<Record<string, string>> {
  return d.attrs;
}

/** The classes of every decoration in the list, one entry per decoration. */
function classesOf(specs: readonly SuggestionSpec[]): string[] {
  return specs.map((d) => String(attrsOf(d)['class'] ?? ''));
}

/** A core whose intro paragraph carries an `ins` run, a `del` run and a block `fmt` mark. */
function markedCore(): { c: DocumentCore; introStart: number } {
  const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
  const i = internals(c);
  const { schema } = i;
  const intro = posOf(i.state.doc, SPIKE_IDS.intro);
  const introNode = i.state.doc.nodeAt(intro) as PMNode;
  if (introNode.textContent.length < 2) throw new Error('intro paragraph too short');
  const start = intro + 1;
  let tr = i.state.tr.addMark(
    start,
    start + 1,
    schema.marks['ins']!.create({ id: 'ins-1', user: 'alice' }),
  );
  tr = tr.addMark(start + 1, start + 2, schema.marks['del']!.create({ id: 'del-1', user: 'bob' }));
  tr = tr.addNodeMark(
    intro,
    schema.marks['fmt']!.create({
      id: 'fmt-1',
      user: 'carol',
      before: { attrs: { style: 'Normal' } },
    }),
  );
  i.dispatch(tr);
  return { c, introStart: start };
}

describe('markup views (FE-046 criterion 4)', () => {
  it('none gives no decoration', () => {
    const { c } = markedCore();
    expect(c.markupDecorations('none')).toEqual([]);
  });

  it('all gives a class for each kind: inline for runs, node for the block mark', () => {
    const { c } = markedCore();
    const classes = classesOf(c.markupDecorations('all'));
    expect(classes).toHaveLength(3);
    expect(classes).toContain('de-suggest-ins');
    expect(classes).toContain('de-suggest-del');
    expect(classes).toContain('de-suggest-fmt');
  });

  it('simple hides the deletion and cues the insertion and the formatting change', () => {
    const { c } = markedCore();
    const classes = classesOf(c.markupDecorations('simple'));
    expect(classes.filter((k) => k.includes('de-suggest-hidden'))).toHaveLength(1);
    expect(classes.filter((k) => k.includes('de-suggest-changed'))).toHaveLength(2);
    expect(classes.join(' ')).not.toContain('de-suggest-del');
  });

  it('original hides the insertion, restores the deletion and shows the formatting before', () => {
    const { c } = markedCore();
    const classes = classesOf(c.markupDecorations('original'));
    expect(classes.filter((k) => k.includes('de-suggest-hidden'))).toHaveLength(1);
    expect(classes.join(' ')).toContain('de-suggest-restored');
    expect(classes.join(' ')).toContain('de-suggest-before');
    expect(classes.join(' ')).not.toContain('de-suggest-ins');
  });

  it('each decoration names the author and the identifier of its mark', () => {
    const { c } = markedCore();
    const pairs = c.markupDecorations('all').map((d) => {
      const a = attrsOf(d);
      return [a['data-suggestion-user'], a['data-suggestion-id']];
    });
    expect(pairs).toEqual(
      expect.arrayContaining([
        ['alice', 'ins-1'],
        ['bob', 'del-1'],
        ['carol', 'fmt-1'],
      ]),
    );
  });

  it('a document without suggestion marks has no decoration in any view', () => {
    const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
    for (const view of ['all', 'simple', 'none', 'original'] as const) {
      expect(c.markupDecorations(view)).toEqual([]);
    }
  });

  it('property: simple never shows a deletion and original never shows an insertion', () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            kind: fc.constantFrom('ins', 'del'),
            user: fc.constantFrom('alice', 'bob', 'carol'),
            from: fc.nat({ max: 3 }),
            length: fc.integer({ min: 1, max: 3 }),
          }),
          { minLength: 1, maxLength: 4 },
        ),
        (marks) => {
          const c = new DocumentCore({ doc: spikeDocument(), schedule: microtask });
          const i = internals(c);
          const intro = posOf(i.state.doc, SPIKE_IDS.intro);
          const text = i.state.doc.nodeAt(intro)!.textContent.length;
          let tr = i.state.tr;
          marks.forEach((m, n) => {
            const from = intro + 1 + Math.min(m.from, Math.max(0, text - 1));
            const to = Math.min(from + m.length, intro + 1 + text);
            if (to > from) {
              tr = tr.addMark(
                from,
                to,
                i.schema.marks[m.kind]!.create({ id: `p${n}`, user: m.user }),
              );
            }
          });
          i.dispatch(tr);
          expect(classesOf(c.markupDecorations('simple')).join(' ')).not.toContain(
            'de-suggest-del',
          );
          expect(classesOf(c.markupDecorations('original')).join(' ')).not.toContain(
            'de-suggest-ins',
          );
        },
      ),
      { numRuns: 80 },
    );
  });
});
