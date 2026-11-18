/**
 * UX-058 criterion 4 (the checker's half): a custom block's fallback picture is a picture, with the
 * fallback text as its alternative text. A block with a picture and no text is flagged as missing
 * alternative text (UX-066); a block with text, or with text only, is not.
 */
import { describe, expect, it } from 'vitest';
import { checkDocument } from '../src/shell/accessibility-check.ts';
import { checkViewOfContent } from '../src/shell/accessibility-content.ts';

const block = (id: string, attrs: Record<string, unknown>) => ({
  type: 'extension_block',
  attrs: {
    id,
    extension: 'com.example.chart',
    payload: {},
    fallbackAsset: null,
    fallbackText: null,
    ...attrs,
  },
});

function issuesFor(blocks: unknown[]) {
  const doc = {
    type: 'doc',
    content: [
      { type: 'defs', content: [] },
      { type: 'body', content: blocks },
    ],
  };
  const view = checkViewOfContent({ doc });
  return checkDocument(view.blocks, view.options);
}

describe('UX-058 criterion 4: the checker flags a fallback picture without alternative text', () => {
  it('flags a picture with no fallback text, and names the block', () => {
    const report = issuesFor([block('xNoText0000000001', { fallbackAsset: 'aFallback0000001' })]);
    const alt = report.groups.find((g) => g.kind === 'alt-text')!;
    expect(alt.issues.map((i) => i.blockId)).toEqual(['xNoText0000000001']);
  });

  it('flags a blank fallback text the same way', () => {
    const report = issuesFor([
      block('xBlank0000000001', { fallbackAsset: 'aFallback0000001', fallbackText: '   ' }),
    ]);
    expect(report.groups.find((g) => g.kind === 'alt-text')!.issues).toHaveLength(1);
  });

  it('accepts a picture with fallback text, and flags nothing for a block with text only', () => {
    const report = issuesFor([
      block('xBoth00000000001', {
        fallbackAsset: 'aFallback0000001',
        fallbackText: 'Sales by month',
      }),
      block('xText00000000001', { fallbackText: 'A chart of three values' }),
    ]);
    expect(report.groups.find((g) => g.kind === 'alt-text')).toBeUndefined();
  });
});
