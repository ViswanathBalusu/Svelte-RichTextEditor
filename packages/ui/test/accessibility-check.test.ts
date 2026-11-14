/**
 * The accessibility checker's rules (UX-066, criteria 1, 2, 4 and 6). The checker reads a plain view
 * of the document and never changes it. Property tests fix each rule against an independent oracle.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CHECK_KINDS,
  CONTRAST_MINIMUM,
  checkDocument,
  contrastRatio,
  headingLevelOf,
  parseColour,
  type CheckBlock,
  type CheckIssue,
  type CheckRun,
} from '../src/shell/accessibility-check.ts';

const hex = fc
  .array(fc.constantFrom(...'0123456789abcdef'.split('')), { minLength: 6, maxLength: 6 })
  .map((c) => c.join(''));

const run: fc.Arbitrary<CheckRun> = fc.record(
  {
    text: fc.oneof(fc.constantFrom('', '  ', 'Some words'), fc.string({ maxLength: 12 })),
    color: fc.option(fc.oneof(hex, fc.constant('auto'), fc.constant('red')), { nil: null }),
    highlight: fc.option(fc.oneof(hex, fc.constantFrom('none', 'auto')), { nil: null }),
  },
  { requiredKeys: ['text'] },
);

const block: fc.Arbitrary<CheckBlock> = fc.oneof(
  fc.record({
    kind: fc.constant('paragraph' as const),
    id: fc.uuid(),
    outlineLevel: fc.option(fc.integer({ min: -1, max: 10 }), { nil: null }),
    runs: fc.array(run, { maxLength: 4 }),
  }),
  fc.record({
    kind: fc.constantFrom('image' as const, 'figure' as const),
    id: fc.uuid(),
    altText: fc.option(fc.oneof(fc.constant(''), fc.constant('  '), fc.string({ maxLength: 10 })), {
      nil: null,
    }),
  }),
  fc.record({
    kind: fc.constant('table' as const),
    id: fc.uuid(),
    headerRows: fc.integer({ min: 0, max: 3 }),
  }),
  fc.record({
    kind: fc.constant('link' as const),
    id: fc.uuid(),
    text: fc.oneof(
      fc.constantFrom('', ' ', 'click here', 'Read more.', 'Here', 'Annual report 2026'),
      fc.string({ maxLength: 12 }),
    ),
  }),
);

const blocks = fc.array(block, { maxLength: 25 });

/** Oracle for heading order: each level after the first must not skip more than one. */
function headingSkips(input: readonly CheckBlock[]): string[] {
  const out: string[] = [];
  let prev: number | null = null;
  for (const b of input) {
    if (b.kind !== 'paragraph') continue;
    const level = headingLevelOf(b.outlineLevel);
    if (level === null) continue;
    if (prev !== null && level > prev + 1) out.push(b.id);
    prev = level;
  }
  return out;
}

function issuesOf(kind: string, report: ReturnType<typeof checkDocument>): CheckIssue[] {
  return report.groups.find((g) => g.kind === kind)?.issues.slice() ?? [];
}

describe('the checker lists five kinds of issue (UX-066, criterion 1)', () => {
  it('has exactly the five kinds of the criterion, in the order the report lists them', () => {
    expect([...CHECK_KINDS]).toEqual([
      'alt-text',
      'heading-order',
      'table-header',
      'link-text',
      'contrast',
    ]);
  });

  it('flags an image or figure without alternative text, and no other (property)', () => {
    fc.assert(
      fc.property(blocks, (input) => {
        const expected = input
          .filter(
            (b): b is Extract<CheckBlock, { kind: 'image' | 'figure' }> =>
              b.kind === 'image' || b.kind === 'figure',
          )
          .filter((b) => b.altText === null || b.altText === undefined || b.altText.trim() === '')
          .map((b) => b.id);
        expect(issuesOf('alt-text', checkDocument(input)).map((i) => i.blockId)).toEqual(expected);
      }),
    );
  });

  it('flags a heading level that skips one, comparing each heading with the one before (property)', () => {
    fc.assert(
      fc.property(blocks, (input) => {
        expect(issuesOf('heading-order', checkDocument(input)).map((i) => i.blockId)).toEqual(
          headingSkips(input),
        );
      }),
    );
  });

  it('reports a skipped heading with the levels it goes from and to', () => {
    const report = checkDocument([
      { kind: 'paragraph', id: 'h1', outlineLevel: 1, runs: [] },
      { kind: 'paragraph', id: 'h3', outlineLevel: 3, runs: [] },
      { kind: 'paragraph', id: 'h2', outlineLevel: 2, runs: [] },
    ]);
    expect(issuesOf('heading-order', report)).toEqual([
      { kind: 'heading-order', blockId: 'h3', detail: { from: 1, to: 3 } },
    ]);
  });

  it('takes the outline level as the heading level, 1 to 9 as 03 section 4.1 gives it', () => {
    expect(headingLevelOf(0)).toBeNull();
    expect(headingLevelOf(10)).toBeNull();
    expect(headingLevelOf(-1)).toBeNull();
    expect(headingLevelOf(1.5)).toBeNull();
    expect(headingLevelOf(null)).toBeNull();
    expect(headingLevelOf(1)).toBe(1);
    expect(headingLevelOf(9)).toBe(9);
  });

  it('flags a table with no header row, and no other (property)', () => {
    fc.assert(
      fc.property(blocks, (input) => {
        const expected = input
          .filter((b): b is Extract<CheckBlock, { kind: 'table' }> => b.kind === 'table')
          .filter((b) => !(b.headerRows >= 1))
          .map((b) => b.id);
        expect(issuesOf('table-header', checkDocument(input)).map((i) => i.blockId)).toEqual(
          expected,
        );
      }),
    );
  });

  it('flags an empty or generic link text, and no other (property)', () => {
    const generic = new Set([
      'click',
      'click here',
      'here',
      'link',
      'this',
      'this link',
      'more',
      'read more',
      'learn more',
      'go',
    ]);
    fc.assert(
      fc.property(blocks, (input) => {
        const expected = input
          .filter((b): b is Extract<CheckBlock, { kind: 'link' }> => b.kind === 'link')
          .filter((b) => {
            const n = b.text
              .trim()
              .replace(/\s+/g, ' ')
              .toLowerCase()
              .replace(/[.!:]+$/, '');
            return n === '' || generic.has(n);
          })
          .map((b) => b.id);
        expect(issuesOf('link-text', checkDocument(input)).map((i) => i.blockId)).toEqual(expected);
      }),
    );
  });

  it('says why a link text is flagged: empty, or generic', () => {
    const report = checkDocument([
      { kind: 'link', id: 'a', text: '  ' },
      { kind: 'link', id: 'b', text: 'Read more.' },
      { kind: 'link', id: 'c', text: 'Annual report 2026' },
    ]);
    expect(issuesOf('link-text', report).map((i) => i.detail)).toEqual([
      { reason: 'empty' },
      { reason: 'generic' },
    ]);
  });
});

describe('the issues are located and grouped by kind (UX-066, criterion 2)', () => {
  it('every issue names a block of the input and a kind of the criterion; the count is the total (property)', () => {
    fc.assert(
      fc.property(blocks, (input) => {
        const ids = new Set(input.map((b) => b.id));
        const report = checkDocument(input);
        let total = 0;
        for (const group of report.groups) {
          expect(group.issues.length).toBeGreaterThan(0);
          for (const issue of group.issues) {
            expect(issue.kind).toBe(group.kind);
            expect(ids.has(issue.blockId)).toBe(true);
            total += 1;
          }
        }
        expect(report.count).toBe(total);
      }),
    );
  });

  it('lists the groups in the criterion order and only the kinds that have issues (property)', () => {
    fc.assert(
      fc.property(blocks, (input) => {
        const kinds = checkDocument(input).groups.map((g) => g.kind);
        const order = kinds.map((k) => CHECK_KINDS.indexOf(k));
        expect([...order].sort((a, b) => a - b)).toEqual(order);
        expect(new Set(kinds).size).toBe(kinds.length);
      }),
    );
  });

  it('an empty document has no issues', () => {
    expect(checkDocument([])).toEqual({ groups: [], count: 0 });
  });
});

describe('contrast is judged from the document colours only (UX-066, criterion 4)', () => {
  it('uses the WCAG ratio and the 4.5 to 1 minimum, with two known pairs', () => {
    expect(CONTRAST_MINIMUM).toBe(4.5);
    expect(contrastRatio(parseColour('000000')!, parseColour('ffffff')!)).toBeCloseTo(21, 5);
    // #767676 on white is the commonly cited pair just above 4.5 to 1; #777777 just below.
    expect(contrastRatio(parseColour('767676')!, parseColour('ffffff')!)).toBeGreaterThanOrEqual(
      4.5,
    );
    expect(contrastRatio(parseColour('777777')!, parseColour('ffffff')!)).toBeLessThan(4.5);
  });

  it('flags grey text on white below the minimum, and not the same text on black (examples)', () => {
    const grey = checkDocument([
      { kind: 'paragraph', id: 'p1', runs: [{ text: 'Faint', color: '777777' }] },
    ]);
    expect(issuesOf('contrast', grey)).toHaveLength(1);
    const ok = checkDocument([
      { kind: 'paragraph', id: 'p2', runs: [{ text: 'Clear', color: '767676' }] },
    ]);
    expect(issuesOf('contrast', ok)).toHaveLength(0);
  });

  it('a document highlight replaces the page background in the test, and the page colour is an input', () => {
    const doc: CheckBlock[] = [
      {
        kind: 'paragraph',
        id: 'p',
        runs: [{ text: 'Marked', color: '000000', highlight: '202020' }],
      },
    ];
    // Black on near-black fails; the same text on the white page passes.
    expect(issuesOf('contrast', checkDocument(doc))).toHaveLength(1);
    expect(issuesOf('contrast', checkDocument(doc, { pageBackground: '#ffffff' }))).toHaveLength(1);
    const noHighlight: CheckBlock[] = [
      { kind: 'paragraph', id: 'q', runs: [{ text: 'Plain', color: '000000' }] },
    ];
    expect(
      issuesOf('contrast', checkDocument(noHighlight, { pageBackground: '#202020' })),
    ).toHaveLength(1);
    expect(issuesOf('contrast', checkDocument(noHighlight))).toHaveLength(0);
  });

  it('paragraph shading stands behind runs without a highlight, and a highlight covers it', () => {
    const shaded = (runs: CheckRun[]): CheckBlock[] => [
      { kind: 'paragraph', id: 's', shading: '#1f1f1f', runs },
    ];
    // White text passes on dark shading although it would fail on the white page.
    expect(
      issuesOf('contrast', checkDocument(shaded([{ text: 'Light', color: 'ffffff' }]))),
    ).toHaveLength(0);
    // Default black text fails on the same shading.
    expect(issuesOf('contrast', checkDocument(shaded([{ text: 'Dark' }])))).toHaveLength(1);
    // A yellow highlight covers the shading: black on yellow passes.
    expect(
      issuesOf('contrast', checkDocument(shaded([{ text: 'Marked', highlight: '#ffff00' }]))),
    ).toHaveLength(0);
  });

  it('reports the lowest failing ratio of a paragraph once (property)', () => {
    fc.assert(
      fc.property(hex, hex, (text, bg) => {
        const ratio = contrastRatio(parseColour(text)!, parseColour(bg)!);
        const report = checkDocument([
          {
            kind: 'paragraph',
            id: 'p',
            runs: [
              { text: 'a', color: text, highlight: bg },
              { text: 'b', color: text, highlight: bg },
            ],
          },
        ]);
        const issues = issuesOf('contrast', report);
        if (ratio < CONTRAST_MINIMUM) {
          expect(issues).toHaveLength(1);
          expect(issues[0]!.detail.ratio).toBe(Math.round(ratio * 100) / 100);
        } else {
          expect(issues).toHaveLength(0);
        }
      }),
    );
  });

  it('leaves a colour it cannot read (a name, not hex) unevaluated rather than flagged', () => {
    const report = checkDocument([
      { kind: 'paragraph', id: 'p', runs: [{ text: 'Named', color: 'red', highlight: 'yellow' }] },
    ]);
    expect(issuesOf('contrast', report)).toHaveLength(0);
  });

  it('rejects a page background that is not hex', () => {
    expect(() => checkDocument([], { pageBackground: 'paper' })).toThrow(RangeError);
  });
});

describe('the checker leaves the document as it was (UX-066, criterion 6)', () => {
  it('reads a frozen document without error and returns the same report twice (property)', () => {
    fc.assert(
      fc.property(blocks, (input) => {
        const frozen = deepFreeze(structuredClone(input));
        const before = JSON.stringify(frozen);
        const first = checkDocument(frozen);
        const second = checkDocument(frozen);
        expect(JSON.stringify(frozen)).toBe(before);
        expect(second).toEqual(first);
      }),
    );
  });
});

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object') {
    for (const v of Object.values(value)) deepFreeze(v);
    Object.freeze(value);
  }
  return value;
}
