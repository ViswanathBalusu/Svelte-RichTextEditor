/**
 * The drawer the web view draws equations with (FE-069; 02 §2, §6).
 *
 * KaTeX is large, so it is not part of the editor chunk's first load: the first equation asks for
 * `math-display.ts` (KaTeX and the sheet adoption) and `katex-fonts.ts`, and shows the LaTeX source
 * as text until they arrive. When the host gave a font directory (`config.katexFontsUrl`), the KaTeX
 * files are registered under hash aliases before the first equation is drawn, so no equation is
 * drawn without its sheet. A failed load leaves the source as text and nothing throws.
 *
 * The drawer keeps the latest source it was asked to draw into each container; a late load never
 * draws an older source over a newer one.
 */
import type { EquationDrawer } from '@docedit/engine';
import type * as MathDisplayModule from './math-display.ts';

type MathDisplay = typeof MathDisplayModule;

export interface EquationDrawerOptions {
  /** The directory (ending in `/`) the host serves KaTeX's `.woff2` files from; absent, none is registered. */
  fontsUrl?: string | null;
  /** The module loader; a test gives its own. */
  load?: () => Promise<MathDisplay>;
  /** The font loader; a test gives its own. */
  loadFonts?: (baseUrl: string) => Promise<unknown>;
}

export function equationDrawer(options: EquationDrawerOptions = {}): EquationDrawer {
  const load = options.load ?? (() => import('./math-display.ts'));
  const loadFonts =
    options.loadFonts ??
    ((url: string) => import('./katex-fonts.ts').then((m) => m.loadKatexFonts(url)));
  let display: MathDisplay | null = null;
  let ready: Promise<MathDisplay | null> | null = null;
  const latest = new WeakMap<HTMLElement, string>();

  const start = (): Promise<MathDisplay | null> => {
    ready ??= (async () => {
      try {
        const [m] = await Promise.all([
          load(),
          options.fontsUrl ? loadFonts(options.fontsUrl).catch(() => null) : null,
        ]);
        display = m;
        return m;
      } catch {
        return null;
      }
    })();
    return ready;
  };

  return (container, latex, displayMode) => {
    const key = `${displayMode ? 'D' : 'I'}${latex}`;
    latest.set(container, key);
    if (display) {
      display.drawEquation(container, latex, displayMode);
      return;
    }
    // Until KaTeX has arrived the container shows the source (the node view put it there).
    void start().then((m) => {
      if (m && latest.get(container) === key) m.drawEquation(container, latex, displayMode);
    });
  };
}
