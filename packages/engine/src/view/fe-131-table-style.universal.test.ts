/**
 * FE-131 criterion 1: a table references the table style applied to it, and its borders and shading
 * follow the style unless overridden (03 §4.1, §4.3, §4.5).
 *
 * The first suite reads the computed values (`tableCellStyles`) and runs everywhere. The second
 * mounts the body view and reads what the page draws; it runs in real browser engines through
 * `pnpm vitest run --project browser <this file>` (Chromium, Firefox and WebKit) and is skipped in
 * Node.js, where there is no DOM.
 */
import type { Node as PMNode } from 'prosemirror-model';
import { TextSelection } from 'prosemirror-state';
import { describe, expect, it, vi } from 'vitest';
import type { CdmEnvelope } from '@docedit/model';
import { internals } from '../testing.ts';
import { styledDocument, styledEditorAccess } from '../../test/fixtures.ts';
import { borderCss, tableCellStyles } from './table-style-view.ts';
import { EditorCore } from './web.ts';

const isBrowser = typeof document !== 'undefined';

type Json = { type: string; attrs?: Record<string, unknown>; content?: Json[]; text?: string };

const cell = (text: string, attrs: Record<string, unknown> = {}): Json => ({
  type: 'table_cell',
  attrs,
  content: [{ type: 'paragraph', content: [{ type: 'text', text }] }],
});

const line = (style: string, width: number, color: string | null) => ({ style, width, color });

/**
 * The styled document with two table styles and a 3 by 2 table with one header row and no style.
 * `GridTable` is based on `TableBase`: it takes the header shading from it and sets its own borders.
 */
function tableDocument(tableAttrs: Record<string, unknown> = {}): CdmEnvelope {
  const env = structuredClone(styledDocument()) as unknown as { doc: Json };
  const [defs, body] = [env.doc.content![0]!, env.doc.content![env.doc.content!.length - 1]!];
  const at = defs.content!.findIndex((n) => n.type === 'page_setup');
  defs.content!.splice(
    at,
    0,
    {
      type: 'style_def',
      attrs: {
        id: 'TableBase',
        kind: 'table',
        name: 'Table Base',
        headerRowShading: { fill: '#D9E2F3' },
        borders: { top: line('dotted', 8, '#FF0000') },
      },
    },
    {
      type: 'style_def',
      attrs: {
        id: 'GridTable',
        kind: 'table',
        name: 'Grid Table',
        basedOn: 'TableBase',
        borders: {
          top: line('double', 12, '#0000FF'),
          bottom: line('thick', 24, '#0000FF'),
          left: line('single', 8, '#0000FF'),
          right: line('single', 8, '#0000FF'),
          insideH: line('dashed', 4, '#7F7F7F'),
          insideV: line('dotted', 4, null),
        },
      },
    },
  );
  body.content!.push({
    type: 'table',
    attrs: { grid: [1440, 1440], headerRows: 1, ...tableAttrs },
    content: [
      { type: 'table_row', content: [cell('Name'), cell('Sum', { shading: { fill: '#FFF2CC' } })] },
      { type: 'table_row', content: [cell('b'), cell('2')] },
      {
        type: 'table_row',
        content: [cell('a'), cell('1', { borders: { bottom: { style: 'none' } } })],
      },
    ],
  });
  return env as unknown as CdmEnvelope;
}

function newCore(tableAttrs: Record<string, unknown> = {}): EditorCore {
  return new EditorCore({
    doc: tableDocument(tableAttrs),
    access: styledEditorAccess(),
    schedule: (run) => queueMicrotask(run),
  });
}

function tableOf(doc: PMNode): { node: PMNode; pos: number } {
  let found: { node: PMNode; pos: number } | null = null;
  doc.descendants((node, pos) => {
    if (node.type.name === 'table') found = { node, pos };
    return found === null;
  });
  if (!found) throw new Error('no table');
  return found;
}

/** Puts the caret in the first cell of the table. */
function caretInTable(core: EditorCore): void {
  const i = internals(core);
  // Table, row, cell, paragraph: the text starts four positions after the table.
  const pos = tableOf(i.state.doc).pos + 4;
  i.dispatch(i.state.tr.setSelection(TextSelection.create(i.state.doc, pos)));
}

/** The computed values of the cells in row order, by the cell's text. */
function cssByText(core: EditorCore): Record<string, unknown> {
  const doc = internals(core).state.doc;
  return Object.fromEntries(
    tableCellStyles(doc).map((c) => [doc.nodeAt(c.pos)!.textContent, c.css]),
  );
}

describe('the values a table takes from its table style (FE-131 criterion 1)', () => {
  it('gives a table without a style only what its cells set themselves', () => {
    const core = newCore();
    expect(cssByText(core)).toEqual({
      Sum: { backgroundColor: '#FFF2CC' },
      '1': { borderBottom: 'none' },
    });
    core.destroy();
  });

  it('references the style when it is applied, and the borders and shading follow it', () => {
    const core = newCore();
    caretInTable(core);
    expect(core.exec('setTableStyle', { tableStyle: 'GridTable' })).toBe(true);
    expect(tableOf(internals(core).state.doc).node.attrs['style']).toBe('GridTable');

    const blue = (w: string, l: string) => `${w} ${l} #0000FF`;
    const insideH = '0.5pt dashed #7F7F7F';
    const insideV = '0.5pt dotted currentcolor';
    expect(cssByText(core)).toEqual({
      // The header row takes the shading of the base style; the outer edges take the outer borders
      // of the style itself, which replace the base style's borders as a whole.
      Name: {
        backgroundColor: '#D9E2F3',
        borderTop: blue('1.5pt', 'double'),
        borderBottom: insideH,
        borderLeft: blue('1pt', 'solid'),
        borderRight: insideV,
      },
      // A cell's own shading wins over the header row shading.
      Sum: {
        backgroundColor: '#FFF2CC',
        borderTop: blue('1.5pt', 'double'),
        borderBottom: insideH,
        borderLeft: insideV,
        borderRight: blue('1pt', 'solid'),
      },
      b: {
        borderTop: insideH,
        borderBottom: insideH,
        borderLeft: blue('1pt', 'solid'),
        borderRight: insideV,
      },
      '2': {
        borderTop: insideH,
        borderBottom: insideH,
        borderLeft: insideV,
        borderRight: blue('1pt', 'solid'),
      },
      a: {
        borderTop: insideH,
        borderBottom: blue('3pt', 'solid'),
        borderLeft: blue('1pt', 'solid'),
        borderRight: insideV,
      },
      // A cell's own border wins over the style's on that side only.
      '1': {
        borderTop: insideH,
        borderBottom: 'none',
        borderLeft: insideV,
        borderRight: blue('1pt', 'solid'),
      },
    });

    // Clearing the style returns the table to its cells' own values.
    expect(core.exec('setTableStyle', { tableStyle: null })).toBe(true);
    expect(Object.keys(cssByText(core)).sort()).toEqual(['1', 'Sum']);
    core.destroy();
  });

  it('lets the borders set on the table itself replace the borders of the style', () => {
    const core = newCore({
      style: 'GridTable',
      borders: { top: line('single', 16, '#00FF00') },
    });
    const css = cssByText(core) as Record<string, Record<string, string>>;
    expect(css['Name']).toEqual({ backgroundColor: '#D9E2F3', borderTop: '2pt solid #00FF00' });
    // The direct value is whole: the sides it does not name are not taken from the style.
    expect(css['b']).toBeUndefined();
    core.destroy();
  });

  it('draws nothing from a value that does not match its grammar', () => {
    expect(borderCss({ style: 'single', width: 8, color: 'red; position: fixed' })).toBeUndefined();
    expect(borderCss({ style: 'wavy', width: 8 })).toBeUndefined();
    expect(borderCss({ style: 'single', width: 2400 })).toBeUndefined();
    expect(borderCss({ style: 'single', width: 1.5 })).toBeUndefined();
    expect(borderCss(null)).toBeUndefined();
    expect(borderCss({ style: 'single' })).toBe('0.5pt solid currentcolor');
    expect(borderCss({ style: 'none', width: 8 })).toBe('none');
  });
});

describe.skipIf(!isBrowser)('a table style in the body view (FE-131 criterion 1)', () => {
  it('draws the borders and shading of the applied style, and what a cell overrides', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const core = newCore();
    const unmount = core.mountBody(host);
    try {
      const cellOf = (text: string): HTMLElement => {
        const td = [...host.querySelectorAll<HTMLElement>('td')].find(
          (el) => el.textContent === text,
        );
        if (!td) throw new Error(`no cell ${text}`);
        return td;
      };
      const drawn = (text: string) => getComputedStyle(cellOf(text));

      // Before the style: only the cell's own shading is drawn.
      expect(cellOf('Name').style.backgroundColor).toBe('');
      expect(cellOf('Name').style.borderTopStyle).toBe('');
      expect(drawn('Sum').backgroundColor).toBe('rgb(255, 242, 204)');

      caretInTable(core);
      expect(core.exec('setTableStyle', { tableStyle: 'GridTable' })).toBe(true);
      await vi.waitFor(() => expect(drawn('Name').backgroundColor).toBe('rgb(217, 226, 243)'));

      // Header row shading from the style; the cell's own shading wins in the second header cell.
      expect(drawn('Sum').backgroundColor).toBe('rgb(255, 242, 204)');
      expect(cellOf('b').style.backgroundColor).toBe('');

      // Outer and inside borders of the style.
      expect(drawn('Name').borderTopStyle).toBe('double');
      expect(drawn('Name').borderTopColor).toBe('rgb(0, 0, 255)');
      expect(cellOf('Name').style.borderTopWidth).toBe('1.5pt');
      expect(drawn('Name').borderLeftStyle).toBe('solid');
      expect(drawn('Name').borderBottomStyle).toBe('dashed');
      expect(drawn('Name').borderBottomColor).toBe('rgb(127, 127, 127)');
      expect(drawn('Name').borderRightStyle).toBe('dotted');
      expect(drawn('a').borderBottomStyle).toBe('solid');
      expect(cellOf('a').style.borderBottomWidth).toBe('3pt');

      // The cell's own border wins on its side; its other sides follow the style.
      expect(drawn('1').borderBottomStyle).toBe('none');
      expect(drawn('1').borderRightStyle).toBe('solid');
      expect(drawn('1').borderRightColor).toBe('rgb(0, 0, 255)');

      // The cells keep their spans and stay editable content.
      expect(cellOf('Name').getAttribute('colspan')).toBe('1');
      expect(cellOf('Name').querySelector('p')?.textContent).toBe('Name');

      // Clearing the style removes what it drew and keeps the cells' own values.
      expect(core.exec('setTableStyle', { tableStyle: null })).toBe(true);
      await vi.waitFor(() => expect(cellOf('Name').style.backgroundColor).toBe(''));
      expect(cellOf('Name').style.borderTopStyle).toBe('');
      expect(drawn('Sum').backgroundColor).toBe('rgb(255, 242, 204)');
      expect(drawn('1').borderBottomStyle).toBe('none');
    } finally {
      unmount();
      core.destroy();
      host.remove();
    }
  });
});
