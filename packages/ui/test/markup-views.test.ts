/**
 * The four markup views (UX-035 criterion 1; the definitions are inferred, ADR 0233).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import {
  MARKUP_VIEWS,
  viewSegments,
  viewText,
  type Change,
  type ChangeKind,
  type MarkupView,
  type Run,
} from '../src/shell/markup-views.ts';

const KINDS: readonly ChangeKind[] = ['insertion', 'deletion', 'formatting'];
const AUTHORS = ['ann', 'ben', 'assistant:drafter'] as const;

const changeArb: fc.Arbitrary<Change> = fc.record({
  id: fc.stringMatching(/^c[0-9]{1,3}$/),
  kind: fc.constantFrom(...KINDS),
  author: fc.constantFrom(...AUTHORS),
});

const runArb: fc.Arbitrary<Run> = fc.record({
  text: fc.string({ maxLength: 8 }),
  change: fc.option(changeArb, { nil: null }),
});

const runsArb = fc.array(runArb, { maxLength: 15 });

function joined(runs: readonly Run[], keep: (r: Run) => boolean): string {
  return runs
    .filter(keep)
    .map((r) => r.text)
    .join('');
}

describe('the four views (UX-035 criterion 1)', () => {
  it('names the four views the spec gives', () => {
    expect([...MARKUP_VIEWS]).toEqual(['all', 'simple', 'none', 'original']);
  });

  it('none shows the text as if every suggestion were accepted (property)', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const expected = joined(runs, (r) => r.change?.kind !== 'deletion');
        expect(viewText(runs, 'none')).toBe(expected);
        for (const s of viewSegments(runs, 'none'))
          expect(s.kind === 'text' && s.change === null).toBe(true);
      }),
    );
  });

  it('original shows the text as if every suggestion were rejected (property)', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const expected = joined(runs, (r) => r.change?.kind !== 'insertion');
        expect(viewText(runs, 'original')).toBe(expected);
        for (const s of viewSegments(runs, 'original'))
          expect(s.kind === 'text' && s.change === null).toBe(true);
      }),
    );
  });

  it('all keeps every run with its change and author, in order (property)', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        const segments = viewSegments(runs, 'all');
        const nonEmpty = runs.filter((r) => r.text.length > 0);
        expect(segments.length).toBe(nonEmpty.length);
        segments.forEach((s, i) => {
          const run = nonEmpty[i];
          expect(run).toBeDefined();
          if (s.kind !== 'text' || run === undefined) throw new Error('all shows only text');
          expect(s.text).toBe(run.text);
          expect(s.change).toEqual(run.change);
        });
        expect(viewText(runs, 'all')).toBe(joined(runs, () => true));
      }),
    );
  });

  it('simple shows the accepted text with a marker before each changed run (property)', () => {
    fc.assert(
      fc.property(runsArb, (runs) => {
        expect(viewText(runs, 'simple')).toBe(viewText(runs, 'none'));
        const markers = viewSegments(runs, 'simple').flatMap((s) =>
          s.kind === 'marker' ? [s.changeId] : [],
        );
        const changed = runs.flatMap((r) => (r.change === null ? [] : [r.change.id]));
        expect(markers).toEqual(changed);
      }),
    );
  });

  it('gives the four views the same input and leaves it unchanged (property)', () => {
    fc.assert(
      fc.property(runsArb, fc.constantFrom(...MARKUP_VIEWS), (runs, view: MarkupView) => {
        const before = JSON.stringify(runs);
        viewSegments(runs, view);
        expect(JSON.stringify(runs)).toBe(before);
      }),
    );
  });
});

describe('a concrete example', () => {
  const runs: Run[] = [
    { text: 'The ', change: null },
    { text: 'quick ', change: { id: 'c1', kind: 'deletion', author: 'ann' } },
    { text: 'brisk ', change: { id: 'c2', kind: 'insertion', author: 'ben' } },
    { text: 'fox.', change: null },
  ];

  it('reads as each view names it', () => {
    expect(viewText(runs, 'all')).toBe('The quick brisk fox.');
    expect(viewText(runs, 'none')).toBe('The brisk fox.');
    expect(viewText(runs, 'original')).toBe('The quick fox.');
    expect(viewSegments(runs, 'simple')).toEqual([
      { kind: 'text', text: 'The ', change: null },
      { kind: 'marker', changeId: 'c1' },
      { kind: 'marker', changeId: 'c2' },
      { kind: 'text', text: 'brisk ', change: null },
      { kind: 'text', text: 'fox.', change: null },
    ]);
  });
});
