/**
 * FE-114 criterion 1: the rules that keep the caret above the on-screen keyboard
 * (src/keyboard-inset.ts), with a fake visual viewport. The browser run is
 * e2e/fe-114-keyboard-inset.spec.ts.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  CARET_MARGIN,
  type CaretBox,
  type VisualViewportLike,
  coveredHeight,
  scrollToCaret,
  watchKeyboardInset,
} from '../src/keyboard-inset.ts';

class FakeVisual implements VisualViewportLike {
  offsetTop = 0;
  height: number;
  readonly #listeners = new Set<() => void>();
  constructor(height: number) {
    this.height = height;
  }
  addEventListener(_type: 'resize', listener: () => void): void {
    this.#listeners.add(listener);
  }
  removeEventListener(_type: 'resize', listener: () => void): void {
    this.#listeners.delete(listener);
  }
  get listeners(): number {
    return this.#listeners.size;
  }
  resize(height: number, offsetTop = 0): void {
    this.height = height;
    this.offsetTop = offsetTop;
    for (const l of [...this.#listeners]) l();
  }
}

const caretAt = (y: number, height = 20): CaretBox => ({ x: 10, y, width: 1, height });

describe('coveredHeight', () => {
  it('is the part of the layout viewport the visual viewport leaves out at the bottom', () => {
    expect(coveredHeight(800, { offsetTop: 0, height: 500 })).toBe(300);
    expect(coveredHeight(800, { offsetTop: 100, height: 500 })).toBe(200);
  });
  it('is zero when the visual viewport fills the layout viewport, or is larger', () => {
    expect(coveredHeight(800, { offsetTop: 0, height: 800 })).toBe(0);
    expect(coveredHeight(800, { offsetTop: 0, height: 800.3 })).toBe(0);
    expect(coveredHeight(800, { offsetTop: 0, height: 799.7 })).toBe(0);
    expect(coveredHeight(800, { offsetTop: 5, height: 810 })).toBe(0);
  });
});

describe('scrollToCaret', () => {
  const visual = { offsetTop: 0, height: 500 };
  it('is zero when the caret is inside the visible part', () => {
    expect(scrollToCaret(caretAt(100), visual)).toBe(0);
    expect(scrollToCaret(caretAt(500 - 20 - CARET_MARGIN), visual)).toBe(0);
  });
  it('scrolls down by the distance that puts the caret above the keyboard, with the margin', () => {
    // The caret's bottom is at 620; the visible part ends at 500; with the margin 128 more.
    expect(scrollToCaret(caretAt(600), visual)).toBe(620 + CARET_MARGIN - 500);
  });
  it('scrolls up when the caret is above the visible part', () => {
    expect(scrollToCaret(caretAt(-50), { offsetTop: 0, height: 500 })).toBe(-50 - CARET_MARGIN);
    expect(scrollToCaret(caretAt(40), { offsetTop: 100, height: 400 })).toBe(
      40 - CARET_MARGIN - 100,
    );
  });
  it('keeps the bottom of a caret that is taller than the visible part', () => {
    expect(scrollToCaret(caretAt(0, 900), { offsetTop: 0, height: 300 })).toBeGreaterThan(0);
  });
  it('after the scroll the caret is inside the visible part, for any caret and viewport', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: -2000, max: 4000 }),
        fc.integer({ min: 10, max: 40 }),
        fc.integer({ min: 100, max: 1000 }),
        fc.integer({ min: 0, max: 300 }),
        (y, h, height, offsetTop) => {
          const dy = scrollToCaret(caretAt(y, h), { offsetTop, height });
          const top = y - dy;
          const bottom = top + h;
          // Within a pixel of rounding of the margins, in the visible part.
          expect(bottom).toBeLessThanOrEqual(offsetTop + height - CARET_MARGIN + 1);
          expect(top).toBeGreaterThanOrEqual(offsetTop + CARET_MARGIN - 1);
        },
      ),
    );
  });
});

describe('watchKeyboardInset', () => {
  function setup(opts: { enabled?: boolean; caret?: CaretBox | null } = {}) {
    const visual = new FakeVisual(800);
    const state = {
      caret: opts.caret === undefined ? caretAt(700) : opts.caret,
      enabled: opts.enabled ?? true,
      inset: 0,
      scrolls: [] as number[],
      insets: [] as number[],
    };
    const watch = watchKeyboardInset({
      visual,
      layoutHeight: () => 800,
      caretRect: () => state.caret,
      scrollBy: (dy) => {
        state.scrolls.push(dy);
        // A scroll moves the caret up the screen by the same distance.
        if (state.caret) state.caret = { ...state.caret, y: state.caret.y - dy };
      },
      setInset: (px) => {
        state.inset = px;
        state.insets.push(px);
      },
      enabled: () => state.enabled,
    });
    return { visual, state, watch };
  }

  it('does nothing while no keyboard covers the page', () => {
    const { state } = setup();
    expect(state.inset).toBe(0);
    expect(state.scrolls).toEqual([]);
  });

  it('raises the inset and scrolls the caret above the keyboard when the visual viewport shrinks', () => {
    const { visual, state } = setup({ caret: caretAt(700) });
    visual.resize(450);
    expect(state.inset).toBe(350);
    expect(state.scrolls).toEqual([700 + 20 + CARET_MARGIN - 450]);
    expect(state.caret!.y + state.caret!.height + CARET_MARGIN).toBeLessThanOrEqual(450);
  });

  it('does not scroll when the caret is already above the keyboard', () => {
    const { visual, state } = setup({ caret: caretAt(100) });
    visual.resize(450);
    expect(state.inset).toBe(350);
    expect(state.scrolls).toEqual([]);
  });

  it('follows the caret as it moves down while the keyboard is up', () => {
    const { visual, state, watch } = setup({ caret: caretAt(100) });
    visual.resize(450);
    state.caret = caretAt(480);
    watch.check();
    expect(state.scrolls).toHaveLength(1);
    expect(state.caret.y + state.caret.height + CARET_MARGIN).toBeLessThanOrEqual(450);
  });

  it('does not scroll for a caret that is not there (no focus in the document)', () => {
    const { visual, state } = setup({ caret: null });
    visual.resize(450);
    expect(state.inset).toBe(350);
    expect(state.scrolls).toEqual([]);
  });

  it('removes the inset when the keyboard goes away', () => {
    const { visual, state } = setup();
    visual.resize(450);
    visual.resize(800);
    expect(state.inset).toBe(0);
    expect(state.insets).toEqual([350, 0]);
  });

  it('does nothing on a device that is not a touch device', () => {
    const { visual, state } = setup({ enabled: false });
    visual.resize(450);
    expect(state.inset).toBe(0);
    expect(state.scrolls).toEqual([]);
  });

  it('counts a keyboard that is already up when the watch starts', () => {
    const visual = new FakeVisual(450);
    const insets: number[] = [];
    watchKeyboardInset({
      visual,
      layoutHeight: () => 800,
      caretRect: () => null,
      scrollBy: () => {},
      setInset: (px) => insets.push(px),
      enabled: () => true,
    });
    expect(insets).toEqual([350]);
  });

  it('stops listening and clears the inset', () => {
    const { visual, state, watch } = setup();
    visual.resize(450);
    expect(visual.listeners).toBe(1);
    watch.stop();
    expect(visual.listeners).toBe(0);
    expect(state.inset).toBe(0);
    visual.resize(300);
    expect(state.inset).toBe(0);
  });
});
