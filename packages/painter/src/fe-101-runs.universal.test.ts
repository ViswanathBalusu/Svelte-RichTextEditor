/**
 * FE-101 (the page view shows real pages): a line is painted in the faces the layout measured, run by
 * run, and the text of the runs is the text of the line. Runs in Chromium, Firefox and WebKit; the
 * suite is skipped in Node.js, which has no DOM.
 */
import { describe, expect, it } from 'vitest';
import type { LayoutTree } from '../../layout/src/tree.ts';
import { paintTree, type PaintRun, type PaintSource } from './painter.ts';

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

describe.skipIf(!hasDom)('painting a line from runs (FE-101)', () => {
  it('paints one span for each run, with its own face, and the line text is the runs joined', () => {
    const source: PaintSource = {
      lineText: () => 'wrong',
      fontFamily: 'serif',
      fontSizePt: 11,
      runs: () => [
        run('Hello '),
        run('bold', { bold: true, fontSizePt: 18 }),
        run(' end', { italic: true }),
      ],
    };
    const root = document.createElement('div');
    document.body.append(root);
    try {
      paintTree(root, tree, source);
      const line = root.querySelector('.de-line') as HTMLElement;
      expect(line.textContent).toBe('Hello bold end');
      const runs = [...line.querySelectorAll<HTMLElement>('.de-run')];
      expect(runs.map((r) => r.textContent)).toEqual(['Hello ', 'bold', ' end']);
      expect(runs[1]!.style.fontWeight).toBe('bold');
      expect(runs[1]!.style.fontSize).toBe('18pt');
      expect(runs[2]!.style.fontStyle).toBe('italic');
    } finally {
      root.remove();
    }
  });

  it('ends the shaping run between two runs of one face, so a pair is not kerned across them (FE-094)', () => {
    const source: PaintSource = {
      lineText: () => '',
      fontFamily: 'serif',
      fontSizePt: 11,
      runs: () => [run('colour'), run(', '), run('bold', { bold: true })],
    };
    const root = document.createElement('div');
    document.body.append(root);
    try {
      paintTree(root, tree, source);
      const runs = [...root.querySelectorAll<HTMLElement>('.de-run')];
      expect(runs[0]!.style.unicodeBidi).toBe('');
      expect(runs[1]!.style.unicodeBidi).toBe('isolate');
      expect(runs[2]!.style.unicodeBidi).toBe('');
      expect(runs.map((r) => r.textContent).join('')).toBe('colour, bold');
    } finally {
      root.remove();
    }
  });

  it('keeps the old single-face painting when the source gives no runs', () => {
    const source: PaintSource = { lineText: () => 'plain', fontFamily: 'serif', fontSizePt: 11 };
    const root = document.createElement('div');
    document.body.append(root);
    try {
      paintTree(root, tree, source);
      expect(root.querySelector('.de-line')!.textContent).toBe('plain');
      expect(root.querySelectorAll('.de-run').length).toBe(0);
    } finally {
      root.remove();
    }
  });
});
