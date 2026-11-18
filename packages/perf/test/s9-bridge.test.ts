/**
 * Spike S9 (SPK-022): the input-bridge prototype's logic in Node.js, where there is no DOM. That is
 * the point of some of these tests: movement by line, page, Home and End needs only the layout
 * tree and the document (02 §9.6), and the bridge's edits map onto the document as text steps.
 * The browser side is in e2e/s9.spec.ts.
 */
import fc from 'fast-check';
import { caretGeometry, hitTest, type DocPosition } from '@docedit/layout';
import { describe, expect, it } from 'vitest';
import { BridgeSession, projectBlock } from '../src/s9/bridge.ts';
import { applyStep, blockText, diffStep, type SpikeDoc } from '../src/s9/doc.ts';
import { breakLines, layoutSpikeDoc, SPIKE_PAGE } from '../src/s9/layout.ts';
import { navigate, navKey } from '../src/s9/navigate.ts';

/** Six points a character: exact, and the same for the layout and the caret. */
const measure = (t: string): number => t.length * 6;
const span = (doc: SpikeDoc) => (blockId: string, from: number, to: number) =>
  measure(blockText(doc, blockId).slice(from, to));

const WORDS = 'alpha beta gamma delta epsilon zeta eta theta iota kappa lambda mu nu xi omicron';
const para = (id: string, n: number): { id: string; text: string } => ({
  id,
  text: Array.from({ length: n }, (_, i) => WORDS.split(' ')[i % 15]).join(' '),
});
const DOC: SpikeDoc = {
  blocks: [para('p1', 30), para('p2', 12), { id: 'p3', text: '' }, para('p4', 40), para('p5', 25)],
};

describe('diffStep', () => {
  it('finds the changed range between the longest prefix and suffix', () => {
    expect(diffStep('b', 10, 'hello world', 'hello brave world')).toEqual({
      blockId: 'b',
      from: 16,
      to: 16,
      insert: 'brave ',
    });
    expect(diffStep('b', 0, 'abcdef', 'abXf')).toEqual({
      blockId: 'b',
      from: 2,
      to: 5,
      insert: 'X',
    });
    expect(diffStep('b', 0, 'same', 'same')).toBeNull();
  });

  it('puts a repeated character at the caret and not before it', () => {
    expect(diffStep('b', 0, 'aa', 'aaa', 3)).toEqual({ blockId: 'b', from: 2, to: 2, insert: 'a' });
  });
});

describe('the projection and the session', () => {
  it('projects a window of the block around the caret', () => {
    const doc: SpikeDoc = { blocks: [{ id: 'b', text: 'x'.repeat(1000) }] };
    const p = projectBlock(doc, { blockId: 'b', offset: 500 }, 50);
    expect(p.start).toBe(450);
    expect(p.text).toHaveLength(100);
    expect(p.caret).toBe(50);
    const edge = projectBlock(doc, { blockId: 'b', offset: 3 }, 50);
    expect([edge.start, edge.caret]).toEqual([0, 3]);
  });

  it('maps a Japanese composition, step by step, onto the document', () => {
    let doc: SpikeDoc = { blocks: [{ id: 'b', text: 'Before after' }] };
    const session = new BridgeSession(projectBlock(doc, { blockId: 'b', offset: 7 }));
    session.compositionStart();
    // The bridge's text and caret after each input event of the composition.
    const events: Array<[string, number]> = [
      ['Before k after', 8],
      ['Before か after', 8],
      ['Before かn after', 9],
      ['Before かな after', 9],
      ['Before 仮名 after', 9],
    ];
    for (const [value, caret] of events) {
      const u = session.update(value, caret);
      if (u.step) doc = applyStep(doc, u.step);
      expect(blockText(doc, 'b')).toBe(value);
    }
    session.compositionEnd();
    expect(session.isComposing).toBe(false);
    expect(blockText(doc, 'b')).toBe('Before 仮名 after');
    expect(session.stepCount).toBe(5);
  });

  it('applies the steps of a window that does not start at the block start', () => {
    let doc: SpikeDoc = { blocks: [{ id: 'b', text: 'abcdefghij' }] };
    const session = new BridgeSession(projectBlock(doc, { blockId: 'b', offset: 6 }, 3));
    expect(session.current.text).toBe('defghi');
    const u = session.update('defXghi', 4);
    expect(u.step).toEqual({ blockId: 'b', from: 6, to: 6, insert: 'X' });
    expect(u.pos).toEqual({ blockId: 'b', offset: 7 });
    doc = applyStep(doc, u.step!);
    expect(blockText(doc, 'b')).toBe('abcdefXghij');
  });

  it('keeps the document equal to the bridge for any series of edits', () => {
    const edit = fc.record({
      at: fc.nat(60),
      remove: fc.nat(5),
      insert: fc.string({ maxLength: 6 }),
    });
    fc.assert(
      fc.property(
        fc.string({ maxLength: 40 }),
        fc.array(edit, { maxLength: 12 }),
        (start, edits) => {
          let doc: SpikeDoc = { blocks: [{ id: 'b', text: start }] };
          const session = new BridgeSession(projectBlock(doc, { blockId: 'b', offset: 0 }, 1000));
          let value = start;
          for (const e of edits) {
            const at = Math.min(e.at, value.length);
            value =
              value.slice(0, at) + e.insert + value.slice(Math.min(value.length, at + e.remove));
            const u = session.update(value, Math.min(at + e.insert.length, value.length));
            if (u.step) doc = applyStep(doc, u.step);
          }
          expect(blockText(doc, 'b')).toBe(value);
        },
      ),
      { numRuns: 200 },
    );
  });
});

describe('layout and movement from the layout tree alone', () => {
  const tree = layoutSpikeDoc(DOC, measure);
  const sp = span(DOC);

  it('lays the document out on several pages, every line inside its page', () => {
    expect(tree.pages.length).toBeGreaterThan(2);
    for (const page of tree.pages) {
      for (const f of page.fragments) {
        expect(f.y + f.height).toBeLessThanOrEqual(page.height - SPIKE_PAGE.margin + 0.001);
      }
    }
    for (const [from, to] of breakLines(DOC.blocks[0]!.text, 220, measure)) {
      expect(measure(DOC.blocks[0]!.text.slice(from, to).trimEnd())).toBeLessThanOrEqual(220);
    }
  });

  it('moves down and up by line, across paragraphs and pages, with a goal x', () => {
    let pos: DocPosition = { blockId: 'p1', offset: 20 };
    const x0 = caretGeometry(tree, pos, sp)!.x;
    let goal: number | undefined;
    const visited = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const r = navigate('ArrowDown', DOC, tree, pos, goal, sp);
      if (r.pos.blockId === pos.blockId && r.pos.offset === pos.offset) break;
      pos = r.pos;
      goal = r.goalX;
      visited.add(caretGeometry(tree, pos, sp)!.page);
    }
    // Down from page 0 passes through every later page.
    for (let p = 1; p < tree.pages.length; p++) expect(visited.has(p)).toBe(true);
    expect(pos.blockId).toBe('p5');
    // Back up to the first line: the goal x of the first move is kept all the way.
    expect(goal).toBeCloseTo(x0, 6);
    for (let i = 0; i < 60; i++) {
      const r = navigate('ArrowUp', DOC, tree, pos, goal, sp);
      pos = r.pos;
      goal = r.goalX;
    }
    expect(pos.blockId).toBe('p1');
    expect(pos.offset).toBeLessThan(40);
  });

  it('Home and End go to the ends of the painted line, not of the block', () => {
    const mid: DocPosition = { blockId: 'p1', offset: 50 };
    const home = navigate('Home', DOC, tree, mid, undefined, sp).pos;
    const end = navigate('End', DOC, tree, mid, undefined, sp).pos;
    expect(home.offset).toBeLessThanOrEqual(50);
    expect(end.offset).toBeGreaterThanOrEqual(50);
    expect(home.offset).toBeGreaterThan(0);
    expect(end.offset).toBeLessThan(DOC.blocks[0]!.text.length);
    // The end is on the same painted line as the start.
    expect(caretGeometry(tree, end, sp)!.y).toBe(caretGeometry(tree, home, sp)!.y);
  });

  it('PageDown goes to the next page at the same height', () => {
    const pos: DocPosition = { blockId: 'p1', offset: 10 };
    const here = caretGeometry(tree, pos, sp)!;
    const r = navigate('PageDown', DOC, tree, pos, undefined, sp);
    const there = caretGeometry(tree, r.pos, sp)!;
    expect(there.page).toBe(here.page + 1);
    expect(Math.abs(there.y - here.y)).toBeLessThan(SPIKE_PAGE.lineHeight * 2);
  });

  it('left and right cross block boundaries; Ctrl+Home and Ctrl+End go to the ends', () => {
    expect(
      navigate(
        'ArrowRight',
        DOC,
        tree,
        { blockId: 'p2', offset: DOC.blocks[1]!.text.length },
        undefined,
        sp,
      ).pos,
    ).toEqual({
      blockId: 'p3',
      offset: 0,
    });
    expect(
      navigate('ArrowLeft', DOC, tree, { blockId: 'p4', offset: 0 }, undefined, sp).pos,
    ).toEqual({
      blockId: 'p3',
      offset: 0,
    });
    expect(
      navigate('CtrlHome', DOC, tree, { blockId: 'p4', offset: 9 }, undefined, sp).pos,
    ).toEqual({
      blockId: 'p1',
      offset: 0,
    });
    expect(
      navigate('CtrlEnd', DOC, tree, { blockId: 'p1', offset: 9 }, undefined, sp).pos.blockId,
    ).toBe('p5');
  });

  it('a click is a hit test on the tree', () => {
    const page = tree.pages[0]!;
    const f = page.fragments[0]!;
    const pos = hitTest(tree, 0, f.x + 30, f.y + 4, sp);
    expect(pos).toEqual({ blockId: 'p1', offset: 5 });
  });

  it('knows which keys it handles', () => {
    const k = (key: string, o: Partial<{ ctrlKey: boolean; shiftKey: boolean }> = {}) =>
      navKey({ key, ctrlKey: false, altKey: false, metaKey: false, shiftKey: false, ...o });
    expect(k('ArrowDown')).toBe('ArrowDown');
    expect(k('Home', { ctrlKey: true })).toBe('CtrlHome');
    expect(k('a')).toBeNull();
    expect(k('ArrowDown', { shiftKey: true })).toBeNull();
  });
});
