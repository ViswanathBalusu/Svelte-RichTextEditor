// Header row shading of a table style in the cascade (FE-131 criterion 1, lane V-FE-129-141). A table
// has no shading of its own in the CDM, so the style's `headerRowShading` is the shading that follows
// the style; a table without a style takes none.
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
import { resolveTableFormat } from '../index.ts';
import { type TreeNode, styleTable } from './styles.ts';

type J = Record<string, unknown>;

function docWith(styles: J[]): TreeNode {
  const env = structuredClone(example) as unknown as { doc: { content: { content: J[] }[] } };
  env.doc.content[0]!.content.splice(
    3,
    0,
    ...styles.map((attrs) => ({ type: 'style_def', attrs })),
  );
  return env.doc as unknown as TreeNode;
}

const HEADER = { fill: '#D9E2F3' };

describe('table style header row shading in the cascade (FE-131 criterion 1)', () => {
  it('gives a table the header row shading of its table style', () => {
    const t = styleTable(
      docWith([{ id: 'Report', name: 'Report', kind: 'table', headerRowShading: HEADER }]),
    );
    const r = resolveTableFormat(t, { style: 'Report', borders: null, cellMargins: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.headerRowShading).toEqual(HEADER);
  });

  it('gives no shading to a table without a style, or whose style sets none', () => {
    const t = styleTable(docWith([{ id: 'Plain', name: 'Plain', kind: 'table' }]));
    const none = resolveTableFormat(t, {});
    expect(none.ok && none.value.headerRowShading).toBeNull();
    const plain = resolveTableFormat(t, { style: 'Plain' });
    expect(plain.ok && plain.value.headerRowShading).toBeNull();
  });

  it('lets a more specific table style win over the style it is based on', () => {
    const t = styleTable(
      docWith([
        { id: 'Base', name: 'Base', kind: 'table', headerRowShading: HEADER },
        {
          id: 'Child',
          name: 'Child',
          kind: 'table',
          basedOn: 'Base',
          headerRowShading: { fill: '#FFFFFF' },
        },
      ]),
    );
    const r = resolveTableFormat(t, { style: 'Child' });
    expect(r.ok && r.value.headerRowShading).toEqual({ fill: '#FFFFFF' });
  });
});
