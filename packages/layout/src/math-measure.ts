/**
 * Equation measurement, injected (02 §6, §9.1, §9.3; FE-064 criterion 4; FE-069). The engine never
 * typesets maths. A page view gives it a `MathMeasurer` that sizes an equation from the same screen
 * fonts the editor draws it with (KaTeX in the browser); the PDF's equation sizes differ a little,
 * and that difference is left to reconciliation with the typeset result (FE-100), not corrected here.
 *
 * Without a math measurer, or where it answers `null`, the engine keeps the stand-in sizes of
 * `flow.ts` (the LaTeX source as text, and two lines for a display equation).
 *
 * Every length is in points. Universal: no DOM and no Node.js API (FND-004).
 */
import type { FontKey } from './measure.ts';

/** The size of one typeset equation, in points. */
export interface MathSize {
  readonly width: number;
  readonly height: number;
}

export interface MathMeasurer {
  /** Identifies the measurer and its fonts, for caches and for test results. */
  readonly id: string;
  /**
   * The aliases of the screen fonts the sizes are taken from, as the font source knows them. A pass
   * notes them when it measures an equation, so that their later arrival advances the font epoch.
   * Empty while no math font is registered.
   */
  readonly fonts: readonly string[];
  /**
   * The size of `latex` set in `font` (the surrounding text's face and size), as a display equation
   * when `display` is true. `null` when it cannot be measured (a source the typesetter rejects, or
   * no screen to measure on): the engine then keeps its stand-in size.
   */
  measure(latex: string, display: boolean, font: FontKey): MathSize | null;
}

/**
 * Memoises a math measurer under a font epoch that a later font load advances (02 §6). The key is
 * the epoch, the display flag, the face and size, and the source; a `null` answer is cached too.
 */
export function cachingMathMeasurer(inner: MathMeasurer, epoch = 0): MathMeasurer {
  const sizes = new Map<string, MathSize | null>();
  return {
    id: `${inner.id}+cache@${epoch}`,
    get fonts() {
      return inner.fonts;
    },
    measure(latex, display, font) {
      const key = `${display ? 'D' : 'I'}\u0000${font.family}\u0000${font.sizePt}\u0000${font.bold ? 'b' : ''}${font.italic ? 'i' : ''}\u0000${latex}`;
      if (sizes.has(key)) return sizes.get(key) ?? null;
      const size = inner.measure(latex, display, font);
      sizes.set(key, size);
      return size;
    },
  };
}

/**
 * `inner` with the math fonts noted with `arrivals` each time an equation is measured, once per
 * alias (`aliases` collects them). The sizes and the id are the inner measurer's.
 */
export function notingMathMeasurer(
  inner: MathMeasurer,
  arrivals: { note(alias: string): void },
  aliases: Set<string>,
): MathMeasurer {
  return {
    id: inner.id,
    get fonts() {
      return inner.fonts;
    },
    measure(latex, display, font) {
      for (const alias of inner.fonts) {
        if (aliases.has(alias)) continue;
        aliases.add(alias);
        arrivals.note(alias);
      }
      return inner.measure(latex, display, font);
    },
  };
}
