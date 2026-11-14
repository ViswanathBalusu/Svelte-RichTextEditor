/**
 * Drawing an equation on screen with KaTeX (FE-069; 02 §6; 09 §6.1).
 *
 * - KaTeX runs with `trust: false` (no `\href`, `\url` or `\htmlId`) and `strict: 'error'`, so a
 *   source that LaTeX itself would reject is refused rather than drawn in a loose way.
 * - `katex.render` builds its tree with DOM calls (`toNode()`), so no HTML string is parsed into the
 *   page here. The container is cleared with `textContent`, never `innerHTML` (FE-016, FE-067).
 * - A source KaTeX rejects becomes a visible placeholder that shows the source. Nothing throws and
 *   the document is not changed: this module only touches the container it was given.
 * - The MathML that KaTeX emits carries the source as `annotation encoding="application/x-tex"`,
 *   which is the text alternative for assistive technology (criterion 6).
 *
 * The KaTeX fonts are registered by `loadKatexFonts` (`katex-fonts.ts`) under hash aliases (FE-061,
 * FE-069 criterion 3). Once that has resolved, each draw adopts the aliased KaTeX sheet into the
 * shadow root that holds the container, so the glyphs use the alias faces. A container that is not
 * yet in a shadow root, or a draw before the fonts are loaded, gets no sheet.
 */
import katex from 'katex';
import { adoptKatexSheet } from './katex-fonts.ts';

/** The options every on-screen equation is drawn with. Fixed, so that no caller can loosen them. */
export const EQUATION_OPTIONS = {
  throwOnError: true,
  strict: 'error',
  trust: false,
} as const;

/** Class of the placeholder shown for a source that KaTeX rejects. */
export const EQUATION_PLACEHOLDER_CLASS = 'de-math-placeholder';

export type EquationDisplay =
  { readonly status: 'drawn' } | { readonly status: 'placeholder'; readonly reason: string };

/**
 * Draws `latex` into `container`, replacing what the container held. Returns `drawn`, or
 * `placeholder` with KaTeX's reason when the source is refused.
 */
export function drawEquation(
  container: HTMLElement,
  latex: string,
  displayMode: boolean,
): EquationDisplay {
  adoptKatexSheet(container);
  try {
    // Replace the container's content first, so that a second draw does not stack equations.
    container.textContent = '';
    katex.render(latex, container, { ...EQUATION_OPTIONS, displayMode });
    return { status: 'drawn' };
  } catch (e) {
    container.textContent = '';
    const placeholder = container.ownerDocument.createElement('span');
    placeholder.className = EQUATION_PLACEHOLDER_CLASS;
    placeholder.setAttribute('role', 'img');
    placeholder.setAttribute('aria-label', latex);
    placeholder.textContent = latex;
    container.append(placeholder);
    return { status: 'placeholder', reason: e instanceof Error ? e.message : String(e) };
  }
}
