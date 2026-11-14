// Invariants of paragraph gaps, line heights, tab stops and header growth (CDM-043 to CDM-045;
// 03 §7; ADR 0032), as property tests.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { paragraphGap } from './gaps.ts';
import { lineHeight } from './lines.ts';
import { bodyFrame } from './page.ts';
import { nextTabStop } from './tabs.ts';

const length = fc.integer({ min: 0, max: 31680 });
const side = fc.record({
  styleId: fc.constantFrom('Body', 'ListParagraph'),
  spaceBefore: length,
  spaceAfter: length,
  contextualSpacing: fc.boolean(),
});

describe('paragraph gaps (CDM-043)', () => {
  it('are the larger of the two spaces, less what contextual spacing drops, and never negative', () => {
    fc.assert(
      fc.property(fc.option(side, { nil: null }), fc.option(side, { nil: null }), (a, b) => {
        const gap = paragraphGap(a, b);
        const after = a?.spaceAfter ?? 0;
        const before = b?.spaceBefore ?? 0;
        expect(gap).toBeGreaterThanOrEqual(0);
        expect(gap).toBeLessThanOrEqual(Math.max(after, before));
        const same = a !== null && b !== null && a.styleId === b.styleId;
        if (!same || (!a.contextualSpacing && !b.contextualSpacing))
          expect(gap).toBe(Math.max(after, before));
        if (same && a.contextualSpacing && b.contextualSpacing) expect(gap).toBe(0);
      }),
      { numRuns: 1000 },
    );
  });
});

describe('line heights (CDM-043)', () => {
  const runs = fc.array(fc.integer({ min: 0, max: 20000 }), { minLength: 1, maxLength: 8 });
  it('under multiple depend only on the tallest run, rounded half up', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31680 }), runs, (multiple, heights) => {
        const h = lineHeight({ lineSpacing: multiple, lineRule: 'multiple' }, heights);
        const tallest = Math.max(...heights);
        expect(h).toBe(lineHeight({ lineSpacing: multiple, lineRule: 'multiple' }, [tallest]));
        expect(Math.abs(h - (multiple * tallest) / 1000)).toBeLessThanOrEqual(0.5);
        expect(Number.isSafeInteger(h)).toBe(true);
        expect(
          lineHeight({ lineSpacing: multiple, lineRule: 'multiple' }, [...heights].reverse()),
        ).toBe(h);
      }),
      { numRuns: 1000 },
    );
  });
  it('are the length under exact, and at least the length under atLeast', () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 31680 }), runs, (len, heights) => {
        expect(lineHeight({ lineSpacing: len, lineRule: 'exact' }, heights)).toBe(len);
        expect(lineHeight({ lineSpacing: len, lineRule: 'atLeast' }, heights)).toBe(
          Math.max(len, ...heights),
        );
      }),
      { numRuns: 500 },
    );
  });
});

describe('tab stops (CDM-044)', () => {
  const stops = fc
    .uniqueArray(fc.integer({ min: 0, max: 12000 }), { maxLength: 6 })
    .map((ps) =>
      ps
        .sort((x, y) => x - y)
        .map((position) => ({ position, align: 'left' as const, leader: 'none' as const })),
    );
  it('move strictly right, to the nearest candidate stop', () => {
    fc.assert(
      fc.property(
        stops,
        fc.integer({ min: -720, max: 12000 }),
        fc.integer({ min: 1, max: 2000 }),
        fc.integer({ min: -2000, max: 6000 }),
        fc.integer({ min: -3000, max: 0 }),
        (tabs, x, step, indentLeft, indentFirstLine) => {
          const tab = nextTabStop({ tabs, indentLeft, indentFirstLine, defaultTabStop: step }, x);
          expect(tab.position).toBeGreaterThan(x);
          const explicit = tabs.find((t) => t.position > x)?.position ?? Infinity;
          const hanging = indentFirstLine < 0 && indentLeft > x ? indentLeft : Infinity;
          const last = tabs.length ? tabs[tabs.length - 1]!.position : x;
          const fallback = (Math.floor(Math.max(x, last) / step) + 1) * step;
          expect(tab.position).toBe(Math.min(explicit, hanging, fallback));
          if (tab.source === 'default') {
            expect(Math.abs(tab.position % step)).toBe(0); // -0 for a stop left of the margin
            expect(tab.position).toBeGreaterThan(last);
          }
        },
      ),
      { numRuns: 1000 },
    );
  });
});

describe('header and footer growth (CDM-045)', () => {
  it('starts the body at the top margin or below the header, whichever is lower', () => {
    fc.assert(
      fc.property(
        length,
        length,
        length,
        length,
        (marginTop, headerDistance, headerHeight, footerHeight) => {
          const f = bodyFrame({ marginTop, headerDistance }, { headerHeight, footerHeight });
          expect(f.top).toBe(Math.max(marginTop, headerDistance + headerHeight));
          expect(f.headerPushes).toBe(headerDistance + headerHeight > marginTop);
          const taller = bodyFrame(
            { marginTop, headerDistance },
            { headerHeight: headerHeight + 1, footerHeight },
          );
          expect(taller.top).toBeGreaterThanOrEqual(f.top);
          expect(f.height).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 500 },
    );
  });
});
