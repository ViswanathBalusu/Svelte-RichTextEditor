/**
 * FE-079, criterion 1 in a browser: the element's default measurer answers with advances for text in
 * a loaded font alias (FE-061), through canvas `measureText`, in Chromium, Firefox and WebKit
 * (`*.universal.test.ts`). The loaded alias is a real font file, so its widths differ from the
 * browser's fallback for an alias that was never loaded.
 */
import notoSerifUrl from '../../perf/fonts/files/NotoSerif-Regular.ttf?url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canvasMeasurerAvailable,
  canvasTextMeasurer,
  type CanvasFontKey,
} from './canvas-measure.ts';

const isBrowser = typeof document !== 'undefined' && typeof FontFace === 'function';
const LOADED = 'U-FE-065-080 Loaded Serif';
const NEVER_LOADED = 'U-FE-065-080 Never Loaded';
const SAMPLE = 'Hamburgefonstiv 0123456789 abc WWW iii';

const font = (family: string): CanvasFontKey => ({
  family,
  sizePt: 11,
  bold: false,
  italic: false,
});

describe.skipIf(!isBrowser)('canvas text measurer (FE-079, criterion 1)', () => {
  afterEach(() => {
    for (const face of Array.from(document.fonts))
      if (face.family.includes('U-FE-065-080')) document.fonts.delete(face);
  });

  it('returns advances for text in a loaded alias, which differ from the fallback', async () => {
    expect(canvasMeasurerAvailable()).toBe(true);
    const face = new FontFace(LOADED, `url("${notoSerifUrl}")`);
    document.fonts.add(face);
    await face.load();
    await document.fonts.ready;

    const measurer = canvasTextMeasurer();
    const width = measurer.advance(font(LOADED), SAMPLE);
    expect(width).toBeGreaterThan(0);
    expect(measurer.advance(font(LOADED), 'mmmm')).toBeGreaterThan(
      measurer.advance(font(LOADED), 'iiii'),
    );
    expect(measurer.advance(font(LOADED), '')).toBe(0);

    const fallback = measurer.advance(font(NEVER_LOADED), SAMPLE);
    expect(fallback).toBeGreaterThan(0);
    expect(Math.abs(fallback - width)).toBeGreaterThan(0.01);

    const metrics = measurer.lineMetrics(font(LOADED));
    expect(metrics.ascent).toBeGreaterThan(0);
    expect(metrics.descent).toBeGreaterThanOrEqual(0);
  });
});
