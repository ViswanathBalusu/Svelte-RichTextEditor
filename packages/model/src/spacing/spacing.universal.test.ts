// Paragraph gaps, line heights, tabs, header growth and kept spaces (CDM-043 to CDM-045; ADR 0032):
// error paths and defaults that the shared fixtures do not cover.
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import { styleTable, type TreeNode } from '../cascade/styles.ts';
import { flowGaps } from './gaps.ts';
import { lineHeight } from './lines.ts';
import { bodyFrame, pageGeometry } from './page.ts';
import { nextTabStop, placeTab } from './tabs.ts';
import { spaceRuns } from './whitespace.ts';

describe('layout semantics: edges', () => {
  it('computes the gaps of the 03 §12 example through its region', () => {
    const doc = (example as unknown as { doc: TreeNode }).doc;
    const body = (doc.content as TreeNode[])[1]!;
    const { gaps, problems } = flowGaps(styleTable(doc), body);
    expect(problems).toEqual([]);
    // Heading1 and Normal have spaceBefore 0 and spaceAfter 160 (Heading1 inherits it).
    expect(gaps.map((g) => g.gap)).toEqual([0, 160, 160, 160]);
    expect(gaps.map((g) => g.below)).toEqual([
      'p3Jq8sLw0aZx1VbN',
      'pA1b2C3d4E5f6G7h',
      'pZ9y8X7w6V5u4T3s',
      null,
    ]);
  });

  it('reports a paragraph whose style cannot be resolved, and treats it as a block without spacing', () => {
    const doc = structuredClone(example) as unknown as {
      doc: { content: { content: unknown[] }[] };
    };
    const body = doc.doc.content[1]!;
    body.content.push({ type: 'paragraph', attrs: { id: 'pNoStylexxxxxxxx', style: 'Missing' } });
    const { gaps, problems } = flowGaps(
      styleTable(doc.doc as unknown as TreeNode),
      body as unknown as TreeNode,
    );
    expect(problems.map((p) => p.code)).toEqual(['style_missing']);
    expect(gaps.at(-1)).toEqual({ above: 'pNoStylexxxxxxxx', below: null, gap: 0 });
  });

  it('refuses a line without runs and run heights that are not whole twips', () => {
    expect(() => lineHeight({ lineSpacing: 1000, lineRule: 'multiple' }, [])).toThrow(RangeError);
    expect(() => lineHeight({ lineSpacing: 1000, lineRule: 'multiple' }, [12.5])).toThrow(
      RangeError,
    );
    expect(() => lineHeight({ lineSpacing: 1000, lineRule: 'multiple' }, [-1])).toThrow(RangeError);
  });

  it('refuses a default tab stop that is not a positive number of twips', () => {
    for (const defaultTabStop of [0, -720, 1.5])
      expect(() =>
        nextTabStop({ tabs: [], indentLeft: 0, indentFirstLine: 0, defaultTabStop }, 0),
      ).toThrow(RangeError);
  });

  it('places a segment after a default stop like a left stop', () => {
    const placed = placeTab(
      { tabs: [], indentLeft: 0, indentFirstLine: 0, defaultTabStop: 720 },
      100,
      { width: 300 },
    );
    expect(placed).toEqual({
      position: 720,
      align: 'left',
      leader: 'none',
      source: 'default',
      start: 720,
      leaderFrom: 100,
    });
  });

  it('fills page geometry from the definition defaults (A4, 1440 margins, 708 header distance)', () => {
    expect(pageGeometry(undefined)).toEqual({
      width: 11906,
      height: 16838,
      marginTop: 1440,
      marginBottom: 1440,
      headerDistance: 708,
      footerDistance: 708,
    });
    expect(bodyFrame(undefined, { headerHeight: 0, footerHeight: 0 }).top).toBe(1440);
  });

  it('keeps spaces in other scripts and around tabs as ordinary text', () => {
    expect(spaceRuns('日本　語')).toEqual([]); // U+3000 ideographic space is an ordinary character
    expect(spaceRuns('a\tb  c').map((r) => r.explicit)).toEqual([1]);
  });
});
