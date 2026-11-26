/**
 * The interactive overlay in real browsers (FE-093): controls sit at the layout tree's positions
 * above the lines, take focus and clicks, are reached in document order by Tab, keep their ARIA
 * references inside the root they were painted into, leave the painted text under them selectable,
 * and show the values the document holds when a page is mounted again. Runs in Chromium, Firefox
 * and WebKit (`pnpm vitest run --project browser packages/painter/src/overlay.universal.test.ts`);
 * skipped in Node.js. The controls here are stand-in inputs: the widgets are FRW's.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { userEvent as BrowserUserEvent } from 'vitest/browser';
import type { BoxFragment, LayoutPage, LayoutTree } from '../../layout/src/tree.ts';
import { paintTree, type PaintSource } from './painter.ts';
import { mountPageWindow, type PageWindow } from './window.ts';

const TEXT = 'The quick brown fox jumps over the lazy dog';
const PX_PER_PT = 96 / 72;
const hasDom = typeof document !== 'undefined';
// `vitest/browser` throws when it is imported outside Browser Mode, so it is loaded only with a DOM;
// in Node.js the suite is skipped and `userEvent` is never used.
const userEvent: typeof BrowserUserEvent = hasDom
  ? (await import('vitest/browser')).userEvent
  : (undefined as never);

const source: PaintSource = {
  lineText: (_block, from, to) => TEXT.slice(from, to),
  fontFamily: 'serif',
  fontSizePt: 12,
};

/**
 * One page: a paragraph with one line at (20, 30), and two boxes in document order. The first box
 * sits low on the page; the second sits over the start of the line, so it must stack above it.
 */
const page = (): LayoutPage => ({
  index: 0,
  section: 0,
  width: 300,
  height: 200,
  fragments: [
    {
      kind: 'paragraph',
      blockId: 'p1',
      from: 0,
      to: TEXT.length,
      x: 20,
      y: 30,
      width: 200,
      height: 14,
      lines: [{ from: 0, to: TEXT.length, x: 0, y: 0, width: 0, height: 14 }],
    },
    { kind: 'box', blockId: 'field-low', x: 20, y: 150, width: 120, height: 16 },
    { kind: 'box', blockId: 'field-over-line', x: 20, y: 28, width: 40, height: 18 },
  ],
  header: [],
  footer: [],
  footnotes: [],
});

const tree: LayoutTree = { engine: 'test', measurer: 'none', pages: [page()] };

describe.skipIf(!hasDom)('overlay controls (FE-093)', () => {
  let host: HTMLElement | null = null;
  const windows: PageWindow[] = [];

  afterEach(() => {
    for (const w of windows.splice(0)) w.dispose();
    host?.remove();
    host = null;
  });

  const mount = (): HTMLElement => {
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    return el;
  };

  // The control of a box: the element the caller returned, or the input inside it.
  const inputFor = (root: ParentNode, blockId: string): HTMLInputElement => {
    const control = root.querySelector<HTMLElement>(`.de-control[data-block="${blockId}"]`);
    const el = control?.matches('input')
      ? control
      : control?.querySelector<HTMLInputElement>('input');
    if (!el) throw new Error(`no control for ${blockId}`);
    return el as HTMLInputElement;
  };

  it('places each control at its box, and the control over a line is the one under the pointer', () => {
    const root = mount();
    const clicks: string[] = [];
    const result = paintTree(root, tree, source, {
      control: (box: BoxFragment) => {
        const input = document.createElement('input');
        input.type = 'text';
        input.setAttribute('aria-label', box.blockId);
        input.addEventListener('click', () => clicks.push(box.blockId));
        return input;
      },
    });
    expect(result.controlCount).toBe(2);
    const pageBox = result.pages[0]!.getBoundingClientRect();
    const low = inputFor(root, 'field-low');
    const over = inputFor(root, 'field-over-line');

    for (const [input, box] of [
      [low, { x: 20, y: 150, w: 120, h: 16 }],
      [over, { x: 20, y: 28, w: 40, h: 18 }],
    ] as const) {
      const r = input.getBoundingClientRect();
      expect(Math.abs(r.left - pageBox.left - box.x * PX_PER_PT)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(r.top - pageBox.top - box.y * PX_PER_PT)).toBeLessThanOrEqual(0.5);
      expect(Math.abs(r.width - box.w * PX_PER_PT)).toBeLessThanOrEqual(0.5);
    }

    // The control stacks above the line it covers: the pointer at its centre reaches the input.
    const r = over.getBoundingClientRect();
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    expect(hit).toBe(over);
    expect(clicks).toEqual([]);
  });

  it('takes focus and a real click on a control', async () => {
    const root = mount();
    const clicks: string[] = [];
    paintTree(root, tree, source, {
      control: (box) => {
        const input = document.createElement('input');
        input.addEventListener('click', () => clicks.push(box.blockId));
        return input;
      },
    });
    const low = inputFor(root, 'field-low');
    await userEvent.click(low);
    expect(clicks).toEqual(['field-low']);
    low.focus();
    expect(document.activeElement).toBe(low);
  });

  it('reaches the controls with Tab in document order, whatever their position on the page', async () => {
    const root = mount();
    paintTree(root, tree, source, {
      control: () => document.createElement('input'),
    });
    // `field-low` comes first in the document, although it sits below `field-over-line`.
    const low = inputFor(root, 'field-low');
    const over = inputFor(root, 'field-over-line');
    expect(low.compareDocumentPosition(over) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

    await userEvent.tab();
    expect(document.activeElement).toBe(low);
    await userEvent.tab();
    expect(document.activeElement).toBe(over);
  });

  it('makes the label of a control itself, in the same root, so the ARIA reference resolves (criterion 3)', () => {
    const el = document.createElement('div');
    el.style.width = '600px';
    document.body.appendChild(el);
    host = el;
    const shadow = el.attachShadow({ mode: 'open' });
    // The caller gives a bare input and a text; the painter builds the label and the reference.
    paintTree(shadow, tree, source, {
      control: () => document.createElement('input'),
      controlLabel: (box) => `Field ${box.blockId}`,
    });
    const inputs = [...shadow.querySelectorAll<HTMLInputElement>('input')];
    expect(inputs.length).toBe(2);
    const ids = new Set<string>();
    for (const input of inputs) {
      const labelId = input.getAttribute('aria-labelledby')!;
      expect(labelId).toBeTruthy();
      expect(ids.has(labelId)).toBe(false);
      ids.add(labelId);
      const label = shadow.getElementById(labelId);
      expect(label?.textContent).toBe(`Field ${input.dataset['block']}`);
      // Label and control are in the one root, and the page's document does not hold the label.
      expect(label?.getRootNode()).toBe(shadow);
      expect(input.getRootNode()).toBe(shadow);
      expect(document.getElementById(labelId)).toBeNull();
      // The label sits in the overlay of the control and takes no focus and no pointer events.
      expect(label?.parentElement).toBe(input.parentElement);
      expect(label?.style.pointerEvents).toBe('none');
    }
  });

  it('keeps a label the control already has and makes none for it, and none without a text', () => {
    const root = mount();
    paintTree(root, tree, source, {
      control: (box) => {
        const input = document.createElement('input');
        if (box.blockId === 'field-low') input.setAttribute('aria-label', 'Own label');
        return input;
      },
      controlLabel: (box) => (box.blockId === 'field-low' ? 'Ignored' : null),
    });
    expect(root.querySelectorAll('.de-control-label').length).toBe(0);
    expect(root.querySelector('input[aria-label]')?.getAttribute('aria-label')).toBe('Own label');
    expect(root.querySelectorAll('[aria-labelledby]').length).toBe(0);
  });

  it('leaves the painted text under the overlay where the pointer reaches it and it stays selectable', () => {
    const root = mount();
    const { pages } = paintTree(root, tree, source, {
      control: () => document.createElement('input'),
    });
    const span = pages[0]!.querySelector<HTMLElement>('.de-text')!;
    const r = span.getBoundingClientRect();
    // The middle of the line lies right of the control over the line's start (20 to 60 points).
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    expect(hit?.closest('.de-line')).toBe(pages[0]!.querySelector('.de-line[data-from="0"]'));
    expect(hit?.classList.contains('de-control')).toBe(false);
    const range = document.createRange();
    range.selectNodeContents(span);
    expect(range.toString()).toBe(TEXT);
  });

  it('shows the values the document holds when a page is mounted again', () => {
    const scroller = document.createElement('div');
    scroller.style.width = '800px';
    scroller.style.height = '600px';
    scroller.style.overflow = 'auto';
    document.body.appendChild(scroller);
    host = scroller;

    const pageOf = (i: number): LayoutPage => ({
      index: i,
      section: 0,
      width: 300,
      height: 400,
      fragments: [{ kind: 'box', blockId: `b${i}`, x: 20, y: 150, width: 120, height: 16 }],
      header: [],
      footer: [],
      footnotes: [],
    });
    const three: LayoutTree = {
      engine: 'test',
      measurer: 'none',
      pages: [pageOf(0), pageOf(1), pageOf(2)],
    };
    // The document's values, read at each mount; a change is made while page 0 is unmounted.
    const values: Record<string, string> = { b0: 'draft' };
    const w = mountPageWindow(scroller, three, source, {
      overscan: 0,
      control: (box) => {
        const input = document.createElement('input');
        input.value = values[box.blockId] ?? '';
        return input;
      },
    });
    windows.push(w);
    expect(inputFor(scroller, 'b0').value).toBe('draft');

    // Scroll to the bottom: page 0 leaves the window.
    scroller.scrollTop = scroller.scrollHeight;
    w.update();
    expect(w.mountedPages()).not.toContain(0);

    values['b0'] = 'signed';
    scroller.scrollTop = 0;
    w.update();
    expect(w.mountedPages()).toContain(0);
    expect(inputFor(scroller, 'b0').value).toBe('signed');
  });
});
