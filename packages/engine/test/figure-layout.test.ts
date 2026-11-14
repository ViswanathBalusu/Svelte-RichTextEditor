/**
 * Figure size and layout (FE-132 criteria 2 and 3): sizes in twips with the aspect ratio kept unless
 * unlocked, placement and alignment stored, a floating figure refused inside a table cell (I10), and
 * the same rules through the document API. The document is the spike document with figures added to
 * the body or to a table cell, as in table.test.ts.
 */
import fc from 'fast-check';
import type { Node as PMNode } from 'prosemirror-model';
import { describe, expect, it } from 'vitest';
import { bodyRange } from '../src/body.ts';
import {
  figureRefusal,
  MAX_FIGURE_TWIPS,
  resizeFigure,
  setFigureLayout,
  sizeFor,
} from '../src/figure-layout.ts';
import { DocumentCore } from '../src/headless.ts';
import { spikeDocument } from '../src/spike-document.ts';
import { internals } from '../src/testing.ts';

const microtask = (run: () => void) => queueMicrotask(run);
const ASSET = 'a'.repeat(32);

function core(): DocumentCore {
  return new DocumentCore({ doc: spikeDocument(), schedule: microtask });
}

function figureNode(
  c: DocumentCore,
  width: number = 1000,
  height: number = 500,
  placement: string = 'here',
): PMNode {
  const { schema } = internals(c);
  return schema.nodes['figure']!.create({
    id: null,
    asset: ASSET,
    width,
    height,
    alt: null,
    align: null,
    placement,
  });
}

/** Appends a figure to the body. */
function withFigure(c: DocumentCore, width: number = 1000, height: number = 500): void {
  const i = internals(c);
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, figureNode(c, width, height)));
}

/** Appends a table whose one cell holds a figure. */
function withFigureInCell(c: DocumentCore, placement = 'here'): void {
  const i = internals(c);
  const { schema } = i;
  const cell = schema.nodes['table_cell']!.create(null, [figureNode(c, 1000, 500, placement)]);
  const table = schema.nodes['table']!.create({ grid: [1440], headerRows: 0 }, [
    schema.nodes['table_row']!.create(null, [cell]),
  ]);
  i.dispatch(i.state.tr.insert(bodyRange(i.state.doc).end, table));
}

/** The position of the figure that stands at or after `from` in document order. */
function figurePos(doc: PMNode, nth = 0): number {
  const found: number[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name === 'figure') found.push(pos);
    return true;
  });
  return found[nth]!;
}

function figureAttrs(c: DocumentCore, nth = 0): Record<string, unknown> {
  const doc = internals(c).state.doc;
  return doc.nodeAt(figurePos(doc, nth))!.attrs;
}

describe('figure size (FE-132 criterion 2)', () => {
  it('keeps the aspect ratio when the width is set, and stores twips', () => {
    expect(sizeFor({ width: 1000, height: 500 }, { width: 2000 })).toEqual({
      width: 2000,
      height: 1000,
    });
  });

  it('keeps the aspect ratio when the height is set', () => {
    expect(sizeFor({ width: 1000, height: 500 }, { height: 250 })).toEqual({
      width: 500,
      height: 250,
    });
  });

  it('stores both values as given when the aspect ratio is unlocked', () => {
    expect(
      sizeFor({ width: 1000, height: 500 }, { width: 2000, height: 100, lockAspect: false }),
    ).toEqual({
      width: 2000,
      height: 100,
    });
  });

  it('refuses a size outside 1 to 31680 twips, or a fraction, and changes nothing', () => {
    const c = core();
    withFigure(c, 1000, 500);
    expect(sizeFor({ width: 1000, height: 500 }, { width: 0 })).toBeNull();
    expect(sizeFor({ width: 1000, height: 500 }, { width: MAX_FIGURE_TWIPS + 1 })).toBeNull();
    expect(sizeFor({ width: 1000, height: 500 }, { height: 1.5 })).toBeNull();
    const pos = figurePos(internals(c).state.doc);
    expect(figureRefusal(internals(c).state, pos, { size: { width: 0 } })).toBe('bad-size');
    expect(resizeFigure(pos, { width: 0 })(internals(c).state)).toBe(false);
    expect(figureAttrs(c)['width']).toBe(1000);
  });

  it('stores the new size on the figure through exec', () => {
    const c = core();
    withFigure(c, 1000, 500);
    const pos = figurePos(internals(c).state.doc);
    expect(c.exec('resizeFigure', { figurePos: pos, figureSize: { width: 2000 } })).toBe(true);
    expect(figureAttrs(c)).toMatchObject({ width: 2000, height: 1000 });
    expect(c.queryCommand('resizeFigure', { figurePos: pos, figureSize: { width: 0 } })).toEqual({
      enabled: false,
      active: false,
      reason: 'bad-size',
    });
    const paragraphPos = bodyRange(internals(c).state.doc).start + 1;
    expect(
      c.queryCommand('resizeFigure', { figurePos: paragraphPos, figureSize: { width: 5 } }).reason,
    ).toBe('not-a-figure');
  });

  it('keeps the aspect ratio within one twip for any locked width (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        fc.integer({ min: 1, max: 5000 }),
        (w0, h0, w1) => {
          const next = sizeFor({ width: w0, height: h0 }, { width: w1 });
          const exact = (w1 * h0) / w0;
          // A derived height outside the CDM's range is refused, not clamped.
          if (exact > MAX_FIGURE_TWIPS || Math.round(exact) < 1) {
            expect(next).toBeNull();
            return;
          }
          expect(next).not.toBeNull();
          expect(next!.width).toBe(w1);
          expect(Math.abs(next!.height - exact)).toBeLessThanOrEqual(0.5);
        },
      ),
    );
  });
});

describe('figure placement and alignment (FE-132 criterion 3)', () => {
  it('stores a floating placement and an alignment in the body', () => {
    const c = core();
    withFigure(c);
    const i = internals(c);
    const pos = figurePos(i.state.doc);
    expect(
      setFigureLayout(pos, { placement: 'float', align: 'center' })(i.state, (tr) =>
        i.dispatch(tr),
      ),
    ).toBe(true);
    expect(figureAttrs(c)).toMatchObject({ placement: 'float', align: 'center' });
  });

  it('refuses a floating figure inside a table cell (I10) and stores nothing', () => {
    const c = core();
    withFigureInCell(c);
    const state = internals(c).state;
    const pos = figurePos(state.doc);
    expect(figureRefusal(state, pos, { layout: { placement: 'float' } })).toBe('float-in-cell');
    expect(setFigureLayout(pos, { placement: 'float' })(state)).toBe(false);
    expect(figureAttrs(c)['placement']).toBe('here');
    expect(figureRefusal(state, pos, { layout: { placement: 'here', align: 'end' } })).toBeNull();
  });

  it('refuses a placement the CDM does not allow', () => {
    const c = core();
    withFigure(c);
    const state = internals(c).state;
    const pos = figurePos(state.doc);
    expect(figureRefusal(state, pos, { layout: { placement: 'wrap' as never } })).toBe(
      'bad-placement',
    );
  });

  it('reports a figure in a table cell as floating-refused through queryCommand', () => {
    const c = core();
    withFigureInCell(c);
    const pos = figurePos(internals(c).state.doc);
    expect(
      c.queryCommand('setFigureLayout', { figurePos: pos, figureLayout: { placement: 'float' } }),
    ).toEqual({
      enabled: false,
      active: false,
      reason: 'float-in-cell',
    });
    expect(
      c.exec('setFigureLayout', {
        figurePos: pos,
        figureLayout: { placement: 'here', align: 'start' },
      }),
    ).toBe(true);
    expect(figureAttrs(c)).toMatchObject({ align: 'start' });
  });
});
