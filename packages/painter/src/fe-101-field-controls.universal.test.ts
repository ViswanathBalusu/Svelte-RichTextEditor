/**
 * FE-101 criterion 5 (the painter's half): a run that is a box leaves its room in the line, and the
 * control that `PaintOptions.inlineControl` returns is placed in the page's overlay at the box
 * (FE-093), also on a justified line. Runs in Chromium, Firefox and WebKit; skipped in Node.js.
 */
import { describe, expect, it } from 'vitest';
import type { LayoutTree } from '../../layout/src/tree.ts';
import { paintTree, type InlineBoxPlace, type PaintRun, type PaintSource } from './painter.ts';

const hasDom = typeof document !== 'undefined';

const run = (text: string, extra: Partial<PaintRun> = {}): PaintRun => ({
  text,
  fontFamily: 'serif',
  fontSizePt: 11,
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  color: null,
  vertAlign: null,
  ...extra,
});

const tree: LayoutTree = {
  engine: 'test',
  measurer: 'test',
  pages: [
    {
      index: 0,
      section: 0,
      width: 300,
      height: 200,
      fragments: [
        {
          kind: 'paragraph',
          blockId: 'p1',
          from: 0,
          to: 12,
          x: 20,
          y: 30,
          width: 200,
          height: 28,
          lines: [{ from: 0, to: 12, x: 0, y: 0, width: 0, height: 14 }],
        },
      ],
      header: [],
      footer: [],
      footnotes: [],
    },
  ],
};

const box = { id: 'f1', kind: 'text', offset: 6, widthPt: 60, heightPt: 11 };

/** A source whose widths are 5 pt a character and 60 pt for the box. */
const source: PaintSource = {
  lineText: () => '',
  fontFamily: 'serif',
  fontSizePt: 11,
  runs: () => [run('Name: '), run('', { box }), run(' end')],
  measureRange: (_block, from, to) => (to > 6 && from <= 6 ? 60 : 0) + Math.min(to, 6) * 5,
};

describe.skipIf(!hasDom)('the control of an inline box (FE-101 criterion 5)', () => {
  it('leaves the room in the line and puts the control in the overlay on it', () => {
    const root = document.createElement('div');
    document.body.append(root);
    try {
      const places: InlineBoxPlace[] = [];
      const result = paintTree(root, tree, source, {
        inlineControl: (place) => {
          places.push(place);
          const el = document.createElement('input');
          el.dataset['field'] = place.id;
          return el;
        },
      });
      expect(result.controlCount).toBe(1);
      const room = root.querySelector<HTMLElement>('.de-line .de-inline-box')!;
      expect(room.style.width).toBe('60pt');
      expect(room.dataset['field']).toBe('f1');
      // The line holds the text either side of the room, and no text in it.
      expect(root.querySelector('.de-line')!.textContent).toBe('Name:  end');
      const control = root.querySelector<HTMLElement>('.de-overlay .de-control')!;
      expect(control.dataset['field']).toBe('f1');
      expect(control.dataset['block']).toBe('p1');
      // Box left is the line's left (20) and the 6 characters before it (30 pt); the line's top is 30.
      expect(control.style.left).toBe('50pt');
      expect(control.style.top).toBe('30pt');
      expect(control.style.width).toBe('60pt');
      expect(control.style.height).toBe('14pt');
      expect(control.style.pointerEvents).toBe('auto');
      expect(places[0]).toMatchObject({ blockId: 'p1', id: 'f1', x: 50, y: 30, lineHeightPt: 14 });
    } finally {
      root.remove();
    }
  });

  it('puts no control where the option is absent or returns null', () => {
    const root = document.createElement('div');
    document.body.append(root);
    try {
      expect(paintTree(root, tree, source).controlCount).toBe(0);
      expect(paintTree(root, tree, source, { inlineControl: () => null }).controlCount).toBe(0);
    } finally {
      root.remove();
    }
  });
});
