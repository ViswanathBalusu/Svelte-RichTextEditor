// Table borders and cell margins in the cascade (CDM-028 criterion 5): a direct value on the table
// overrides the table style, as a whole value; a table without a style takes only its own values.
import { describe, expect, it } from 'vitest';
import example from '../../fixtures/example-03-12.json' with { type: 'json' };
// Imported through the package entry point, so the test also proves other packages can reach it.
import { resolveParagraph, resolveTableFormat } from '../index.ts';
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

const GRID = { style: 'single', width: 4, color: '000000', space: 0 };
const STYLE_BORDERS = {
  top: GRID,
  bottom: GRID,
  left: GRID,
  right: GRID,
  insideH: GRID,
  insideV: GRID,
};
const DIRECT_BORDERS = { top: null, bottom: GRID, left: null, right: null };
const STYLE_MARGINS = { top: 0, bottom: 0, left: 108, right: 108 };
const DIRECT_MARGINS = { top: 40, bottom: 40, left: 80, right: 80 };

function table(styles: J[]) {
  return styleTable(docWith(styles));
}

describe('table borders and cell margins in the cascade (CDM-028)', () => {
  it('gives a table without a style only its direct values', () => {
    const t = table([]);
    const plain = resolveTableFormat(t, {
      style: null,
      borders: DIRECT_BORDERS,
      cellMargins: null,
    });
    expect(plain.ok).toBe(true);
    if (!plain.ok) return;
    expect(plain.value.borders).toEqual(DIRECT_BORDERS);
    expect(plain.value.cellMargins).toBeNull();
    expect(plain.value.trace).toEqual({ borders: 'direct', cellMargins: 'none' });

    const none = resolveTableFormat(t, {});
    expect(none.ok && none.value.borders).toBeNull();
    expect(none.ok && none.value.trace).toEqual({ borders: 'none', cellMargins: 'none' });
  });

  it('takes the borders and margins of the table style when the table sets none', () => {
    const t = table([
      {
        id: 'Grid',
        name: 'Grid',
        kind: 'table',
        borders: STYLE_BORDERS,
        cellMargins: STYLE_MARGINS,
      },
    ]);
    const r = resolveTableFormat(t, { style: 'Grid', borders: null, cellMargins: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.borders).toEqual(STYLE_BORDERS);
    expect(r.value.cellMargins).toEqual(STYLE_MARGINS);
    expect(r.value.trace).toEqual({ borders: 'table style', cellMargins: 'table style' });
  });

  it('lets a direct borders value replace the style borders as a whole', () => {
    const t = table([{ id: 'Grid', name: 'Grid', kind: 'table', borders: STYLE_BORDERS }]);
    const r = resolveTableFormat(t, { style: 'Grid', borders: DIRECT_BORDERS, cellMargins: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // Whole value: none of the style's sides survive the direct value.
    expect(r.value.borders).toEqual(DIRECT_BORDERS);
    expect(r.value.borders).not.toHaveProperty('insideH');
    expect(r.value.trace.borders).toBe('direct');
  });

  it('lets direct cellMargins override the style margins independently of borders', () => {
    const t = table([
      {
        id: 'Grid',
        name: 'Grid',
        kind: 'table',
        borders: STYLE_BORDERS,
        cellMargins: STYLE_MARGINS,
      },
    ]);
    const r = resolveTableFormat(t, { style: 'Grid', borders: null, cellMargins: DIRECT_MARGINS });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.cellMargins).toEqual(DIRECT_MARGINS);
    expect(r.value.borders).toEqual(STYLE_BORDERS);
    expect(r.value.trace).toEqual({ borders: 'table style', cellMargins: 'direct' });
  });

  it('lets a derived table style replace cell margins and inherit borders from basedOn', () => {
    const t = table([
      {
        id: 'Base',
        name: 'Base',
        kind: 'table',
        borders: STYLE_BORDERS,
        cellMargins: STYLE_MARGINS,
      },
      {
        id: 'Derived',
        name: 'Derived',
        kind: 'table',
        basedOn: 'Base',
        cellMargins: DIRECT_MARGINS,
      },
    ]);
    const r = resolveTableFormat(t, { style: 'Derived', borders: null, cellMargins: null });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.borders).toEqual(STYLE_BORDERS);
    expect(r.value.cellMargins).toEqual(DIRECT_MARGINS);
  });

  it('returns the cascade error for a table style that does not exist', () => {
    const t = table([]);
    const r = resolveTableFormat(t, { style: 'Missing', borders: null, cellMargins: null });
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.code).toBe('style_missing');
    expect(r.error.styleId).toBe('Missing');
  });
});

describe('the borders of a table style are not paragraph borders', () => {
  it('leaves the borders of a paragraph in a cell unset (found by EXP-078, with EXP-020)', () => {
    const t = table([
      { id: 'Grid', name: 'Grid', kind: 'table', borders: STYLE_BORDERS },
      { id: 'Boxed', name: 'Boxed', kind: 'paragraph', borders: { top: GRID } },
    ]);
    const plain = resolveParagraph(t, undefined, { tableStyle: 'Grid' });
    expect(plain.ok && plain.value.properties.borders).toBeNull();
    // A paragraph style still gives its paragraphs borders inside a table.
    const boxed = resolveParagraph(t, { style: 'Boxed' }, { tableStyle: 'Grid' });
    expect(boxed.ok && boxed.value.properties.borders).toEqual({ top: GRID });
  });
});
