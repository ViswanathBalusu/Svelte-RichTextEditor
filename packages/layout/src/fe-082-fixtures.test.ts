/**
 * FE-082 criterion 1: pagination against stored fixtures. `fixtures/pagination-priority.json` lists
 * documents of paragraphs and page breaks in which two rules of 02 section 9.4 conflict, with the
 * pages that the priority order gives. The expectations were worked out by hand. The roster at the
 * end fails when a pair of neighbouring rules has no fixture.
 */
import { describe, expect, it } from 'vitest';
import fixtures from '../fixtures/pagination-priority.json' with { type: 'json' };
import { paginate, type PageItem } from './paginate.ts';
import type { ParagraphFragment } from './tree.ts';

interface FixtureItem {
  block?: string;
  lines?: number;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  pageBreak?: boolean;
}
interface Fixture {
  id: string;
  rules: string[];
  why: string;
  items: FixtureItem[];
  pages: string[][];
}

const LINE = fixtures.lineHeight;

/** A paragraph of `n` lines of one height; line i covers offsets 10 i to 10 i + 10. */
function toItem(it: FixtureItem): PageItem {
  if (it.pageBreak) return { kind: 'pageBreak' };
  const n = it.lines ?? 1;
  const lines = Array.from({ length: n }, (_, i) => ({
    from: i * 10,
    to: i * 10 + 10,
    x: 0,
    y: i * LINE,
    width: 50,
    height: LINE,
  }));
  const fragment: ParagraphFragment = {
    kind: 'paragraph',
    blockId: it.block ?? 'p',
    from: 0,
    to: n * 10,
    x: 0,
    y: 0,
    width: 100,
    height: n * LINE,
    lines,
  };
  return {
    kind: 'paragraph',
    fragment,
    spaceBefore: 0,
    spaceAfter: 0,
    keepNext: it.keepNext ?? false,
    keepLines: it.keepLines ?? false,
    pageBreakBefore: it.pageBreakBefore ?? false,
    widowControl: it.widowControl ?? false,
  };
}

function run(c: Fixture): string[][] {
  const { pages } = paginate(c.items.map(toItem), {
    width: fixtures.page.width,
    height: fixtures.page.height,
    margins: { top: 0, right: 0, bottom: 0, left: 0 },
  });
  return pages.map((p) =>
    p.fragments.map((f) =>
      f.kind === 'paragraph' ? `${f.blockId}:${f.from / 10}-${f.to / 10}` : f.blockId,
    ),
  );
}

describe('pagination fixtures: the order of the rules (FE-082 criterion 1)', () => {
  for (const c of fixtures.cases as Fixture[]) {
    it(`${c.id}: ${c.why}`, () => {
      expect(run(c)).toEqual(c.pages);
    });
  }

  it('has a fixture for each pair of rules that the priority order ranks', () => {
    const pairs = new Set(
      (fixtures.cases as Fixture[])
        .filter((c) => c.rules.length === 2)
        .map((c) => c.rules.join('>')),
    );
    for (const pair of [
      'break>keepNext',
      'break>pageBreakBefore',
      'pageBreakBefore>keepNext',
      'keepNext>keepLines',
      'keepLines>widow',
      'keepNext>widow',
    ])
      expect(pairs, pair).toContain(pair);
  });
});
