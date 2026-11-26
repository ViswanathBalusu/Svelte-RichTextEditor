/**
 * EXP-013 criterion 5, the part the style macro does not carry (Node.js only): spacing and
 * keep-with-next.
 *
 * Owner decision 208 (`docs/owner-decisions-2026-11-15.md`): the converter's `\DEgap` and `\DEkeep`
 * lines stand, and 09 section 3.1 says so. A flattened style therefore equals the cascade of 03
 * section 6 in two places: the setters of its macro (`exp-013-cascade.test.ts`) and these two
 * lines, which the converter writes from the same resolved paragraph. The expected values come
 * from `resolveParagraph` and `paragraphGap` in `@docedit/model`, over a style chain, and the lines
 * are read back from `main.tex`.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  paragraphGap,
  resolveParagraph,
  styleTable,
  type CdmEnvelope,
  type GapSide,
  type TreeNode,
} from '@docedit/model';
import { doc, para, run, type J } from '../test/docs.ts';
import { dimen } from './emit.ts';

const LEN = { min: 0, max: 31680 };
const twips = (min: number, max: number) => fc.integer({ min, max });

const arbCase = fc.record({
  parentBefore: twips(0, 600),
  parentAfter: twips(0, 600),
  parentKeepNext: fc.boolean(),
  /** A leaf value is either set or inherited from the parent. */
  leafBefore: fc.option(twips(0, 600), { nil: undefined }),
  leafAfter: fc.option(twips(0, 600), { nil: undefined }),
  leafKeepNext: fc.option(fc.boolean(), { nil: undefined }),
  contextual: fc.boolean(),
});

function style(id: string, attrs: J): J {
  return {
    type: 'style_def',
    attrs: { id, kind: 'paragraph', name: id, builtIn: false, ...attrs },
  };
}

describe('EXP-013 a flattened style equals the cascade: spacing and keep with next (criterion 5)', () => {
  it('writes the gap and the keep line the cascade resolves for a style chain', async () => {
    await fc.assert(
      fc.asyncProperty(arbCase, async (c) => {
        const leaf: J = { basedOn: 'Parent', contextualSpacing: c.contextual };
        if (c.leafBefore !== undefined) leaf['spaceBefore'] = c.leafBefore;
        if (c.leafAfter !== undefined) leaf['spaceAfter'] = c.leafAfter;
        if (c.leafKeepNext !== undefined) leaf['keepNext'] = c.leafKeepNext;
        const styles = [
          style('Parent', {
            spaceBefore: c.parentBefore,
            spaceAfter: c.parentAfter,
            keepNext: c.parentKeepNext,
          }),
          style('Leaf', leaf),
        ];
        const first = para('Alpha text.', { id: 'pAlpha000000001', style: 'Leaf' });
        const second = para('Beta text.', { id: 'pBeta0000000001', style: 'Leaf' });
        const third = para('Gamma text.', { id: 'pGamma000000001' });
        const env: CdmEnvelope = doc([first, second, third], { styles });
        const b = await run(env);

        const table = styleTable(env.doc as unknown as TreeNode);
        const a = resolveParagraph(table, { style: 'Leaf' });
        expect(a.ok).toBe(true);
        if (!a.ok) return;
        const p = a.value.properties;
        const side: GapSide = {
          styleId: a.value.styleId,
          spaceBefore: p.spaceBefore,
          spaceAfter: p.spaceAfter,
          contextualSpacing: p.contextualSpacing,
        };
        // The cascade really passed the parent's and the leaf's values on.
        expect(p.spaceBefore).toBe(c.leafBefore ?? c.parentBefore);
        expect(p.spaceAfter).toBe(c.leafAfter ?? c.parentAfter);
        expect(p.keepNext).toBe(c.leafKeepNext ?? c.parentKeepNext);

        const main = b.files['main.tex']!;
        const between = main.slice(main.indexOf('Alpha text.'), main.indexOf('Beta text.'));
        const expected = paragraphGap(side, side);
        const gaps = [...between.matchAll(/\\DEgap\{([^}]*)\}/g)].map((m) => m[1]);
        expect(gaps).toEqual(expected > 0 ? [String(dimen(expected, LEN))] : []);
        expect(between.includes('\\DEkeep')).toBe(p.keepNext);
      }),
      { numRuns: 40 },
    );
  });
});
