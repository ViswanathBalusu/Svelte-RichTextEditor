/**
 * The page view's math measurer (FE-064 criterion 4; 02 §6, §9.1): it sizes an equation by drawing
 * it with the editor's own KaTeX drawer (`drawEquation`, FE-069) into a hidden box inside the
 * shadow root and reading the box's size. The sizes are therefore the screen fonts' sizes, from the
 * faces registered under hash aliases (FE-061). The PDF's sizes differ a little, and that is left to
 * reconciliation with the typeset result (FE-100).
 *
 * The hidden box holds nothing but the equation being measured, is `visibility: hidden` and out of
 * the flow, and is emptied after each measurement. Before `loadKatexFonts` has resolved there is no
 * sheet in the shadow root, so nothing is measured and the answer is `null`.
 */
import { drawEquation, EQUATION_PLACEHOLDER_CLASS } from './math-display.ts';
import { katexFonts } from './katex-fonts.ts';

/**
 * The shapes of the layout engine's `MathMeasurer` (packages/layout/src/math-measure.ts), declared
 * here so that the element needs no dependency on the universal layout package: the engine accepts
 * any object of this shape.
 */
export interface MathFontKey {
  readonly family: string;
  readonly sizePt: number;
  readonly bold: boolean;
  readonly italic: boolean;
}
export interface MathSizePt {
  readonly width: number;
  readonly height: number;
}
export interface ElementMathMeasurer {
  readonly id: string;
  readonly fonts: readonly string[];
  measure(latex: string, display: boolean, font: MathFontKey): MathSizePt | null;
}

/** CSS pixels in a point (CSS defines 96 px to 72 pt). */
const PX_PER_PT = 96 / 72;

export interface KatexMathMeasurerOptions {
  /** The shadow root (or element) the hidden box is put in; it must hold the aliased KaTeX sheet. */
  readonly root: ShadowRoot | HTMLElement;
}

export function katexMathMeasurer(options: KatexMathMeasurerOptions): ElementMathMeasurer {
  const { root } = options;
  let box: HTMLElement | null = null;
  const hiddenBox = (): HTMLElement => {
    if (box?.isConnected) return box;
    const doc = root.ownerDocument;
    box = doc.createElement('div');
    box.setAttribute('aria-hidden', 'true');
    const style = box.style;
    style.position = 'absolute';
    style.left = '-100000px';
    style.top = '0';
    style.visibility = 'hidden';
    style.display = 'inline-block';
    style.whiteSpace = 'nowrap';
    style.contain = 'layout style';
    root.append(box);
    return box;
  };
  return {
    id: 'katex-dom',
    get fonts(): readonly string[] {
      const prepared = katexFonts();
      return prepared ? [...new Set(prepared.aliases.values())] : [];
    },
    measure(latex: string, display: boolean, font: MathFontKey): MathSizePt | null {
      // No aliased sheet yet: a measurement would be taken in fallback fonts and not be the screen's.
      if (katexFonts() === null) return null;
      const target = hiddenBox();
      target.style.fontSize = `${font.sizePt}pt`;
      try {
        const shown = drawEquation(target, latex, display);
        // A source KaTeX rejects shows a placeholder; its size is not an equation's.
        if (shown.status !== 'drawn' || target.querySelector(`.${EQUATION_PLACEHOLDER_CLASS}`))
          return null;
        const rect = target.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) return null;
        return { width: rect.width / PX_PER_PT, height: rect.height / PX_PER_PT };
      } finally {
        target.textContent = '';
      }
    },
  };
}
