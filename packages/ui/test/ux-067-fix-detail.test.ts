/**
 * UX-067 criterion 2, the checker's half: a contrast issue names the colour its fix offers, and
 * the colour always reaches the minimum; a link issue names which link of the block it is, as the
 * core counts them.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CONTRAST_MINIMUM,
  checkDocument,
  contrastRatio,
  parseColour,
} from '../src/shell/accessibility-check.ts';

describe('the colour a contrast fix offers (UX-067 criterion 2)', () => {
  it('reaches the minimum on any background, whichever of black and white it names', () => {
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), (n) => {
        const background = `#${n.toString(16).padStart(6, '0')}`;
        // Text the same colour as its background is the worst case: it always fails.
        const report = checkDocument([
          {
            kind: 'paragraph',
            id: 'p1',
            shading: background,
            runs: [{ text: 'Text', color: background }],
          },
        ]);
        const issue = report.groups.find((g) => g.kind === 'contrast')!.issues[0]!;
        const suggest = String(issue.detail['suggest']);
        expect(['#000000', '#FFFFFF']).toContain(suggest);
        expect(
          contrastRatio(parseColour(suggest)!, parseColour(background)!),
        ).toBeGreaterThanOrEqual(CONTRAST_MINIMUM);
      }),
    );
  });

  it('is chosen for the background of the worst run', () => {
    const report = checkDocument([
      {
        kind: 'paragraph',
        id: 'p1',
        runs: [
          { text: 'On navy', color: '#000080', highlight: '#000080' },
          { text: 'Faint', color: '#EEEEEE' },
        ],
      },
    ]);
    // The same colour on navy is the worst pair (1 to 1); navy wants white.
    expect(report.groups[0]!.issues[0]!.detail['suggest']).toBe('#FFFFFF');
  });
});

describe('the link a link-text fix means (UX-067 criterion 2)', () => {
  it('carries the index of the link the view gave, and none when it gave none', () => {
    const report = checkDocument([
      { kind: 'link', id: 'p1', text: 'Annual report', index: 0 },
      { kind: 'link', id: 'p1', text: 'click here', index: 1 },
      { kind: 'link', id: 'p2', text: '' },
    ]);
    const issues = report.groups.find((g) => g.kind === 'link-text')!.issues;
    expect(issues.map((i) => i.detail)).toEqual([
      { reason: 'generic', index: 1 },
      { reason: 'empty' },
    ]);
  });
});
