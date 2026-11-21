/**
 * The providers the page view hands the layout engine (02 §9.1; FE-101): who measures text, where a
 * line may break, and how lines are filled. The engine is the project's own (`packages/layout`);
 * only the measurer and the break rule are chosen here.
 *
 * Measurement: until the layout engine runs in the layout worker next to the kernel (02 §15), the
 * page view measures on the page thread with canvas `measureText` (the fallback of spike S5 for
 * Chromium, Edge and WebKit; `kernel-fallback.ts`). The font files in the kernel are not read by the
 * page view yet. Firefox has no acceptable canvas measurement (S5), so the page view is not offered
 * there (`pageViewSupported`).
 *
 * Breaks: FE-080 has not chosen the bundled Unicode line breaking algorithm. Until it does, the page
 * view breaks after blanks, after a hyphen between letters, and between ideographs. This is a
 * placeholder with a narrow rule; it is recorded in docs/adr/0417-w1-page-view-mount.md.
 */
import { cachingMeasurer, type TextMeasurer } from '../../../layout/src/measure.ts';
import { firstFitBreaker, type ItemProviders } from '../../../layout/src/items.ts';
import type { BreakOpportunities } from '../../../layout/src/lines.ts';
import { canvasMeasurerAvailable, canvasTextMeasurer } from '../canvas-measure.ts';
import { fallbackFor } from '../kernel-fallback.ts';

/** Ideographs, kana and hangul syllables: a line may break between two of them. */
const IDEOGRAPH = /[⺀-鿿ꥠ-꥿가-퟿豈-﫿︰-﹏＀-￯]/;

/** Characters a line must not start with (closing punctuation); a break before one is not offered. */
const NO_START = /[、。，．）」』】〕！？,.;:!?)\]}%]/;

/** The break rule of the page view until FE-080 settles the algorithm (see the module comment). */
export const placeholderBreaks: BreakOpportunities = {
  opportunities(text) {
    const out: number[] = [];
    const n = text.length;
    for (let i = 1; i <= n; i++) {
      const prev = text.charAt(i - 1);
      const next = i < n ? text.charAt(i) : '';
      const blank = prev === ' ' || prev === '\t' || prev === '​';
      if (blank && next !== ' ' && next !== '\t') {
        out.push(i);
        continue;
      }
      if (next === '') continue;
      if (
        prev === '-' &&
        i >= 2 &&
        /[\p{L}\p{N}]/u.test(text.charAt(i - 2)) &&
        /[\p{L}\p{N}]/u.test(next)
      ) {
        out.push(i);
        continue;
      }
      if (IDEOGRAPH.test(prev) && IDEOGRAPH.test(next) && !NO_START.test(next)) out.push(i);
    }
    return out;
  },
};

/** Whether the page view can measure text in this browser (S5): canvas is there and Firefox is not the browser. */
export function pageViewSupported(userAgent: string): boolean {
  return fallbackFor(userAgent) === 'canvas-measurement' && canvasMeasurerAvailable();
}

/** The providers of the page view over a measurer, which defaults to canvas measurement. */
export function pageProviders(measurer?: TextMeasurer, epoch = 0): ItemProviders {
  return {
    measurer: cachingMeasurer(measurer ?? canvasTextMeasurer(), epoch),
    breaks: placeholderBreaks,
    lineBreaker: firstFitBreaker,
  };
}
