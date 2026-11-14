// FE-063 in browsers (lane U-FE-049-064, fixer round 6): the element's own measuring worker
// (`measure-worker.ts`, started by `startMeasureWorker`; the sequence is `measureHandler` in
// worker-fonts.ts) registers the manifest's files on its own font set under the same hash aliases as
// the page before any measurement, waits for the face before it measures, and its width equals the
// main thread's width for the same alias, text and size. The page side waits with the same
// `ensureFace`. Chromium, Firefox and WebKit (`*.universal.test.ts`); skipped where a worker has no
// OffscreenCanvas to measure with.
import notoSerifUrl from '../../perf/fonts/files/NotoSerif-Regular.ttf?url';
import { afterEach, describe, expect, it } from 'vitest';
import { canvasTextMeasurer, type CanvasFontKey } from './canvas-measure.ts';
import { pageFonts } from './font-loader.ts';
import { fontAlias, registerFontFiles, type FontFileEntry } from './font-registration.ts';
import {
  MeasureWorkerError,
  startMeasureWorker,
  type MeasureWorkerClient,
} from './measure-worker-client.ts';
import { ensureFace, measureHandler, scopeFonts, type LoadingFontSet } from './worker-fonts.ts';

const isBrowser =
  typeof document !== 'undefined' && typeof FontFace === 'function' && typeof Worker === 'function';
/**
 * Whether a worker here has a 2D canvas (OffscreenCanvas). The element measures with canvas, so a
 * worker without one cannot measure at all; WebKit's worker has none in the Playwright build used here.
 */
async function workerHasCanvas(): Promise<boolean> {
  if (!isBrowser) return false;
  const source =
    'postMessage(typeof OffscreenCanvas === "function" && !!new OffscreenCanvas(1, 1).getContext("2d"))';
  const worker = new Worker(URL.createObjectURL(new Blob([source], { type: 'text/javascript' })));
  try {
    return await new Promise<boolean>((resolve) => {
      worker.onmessage = (event: MessageEvent<boolean>) => resolve(event.data === true);
      worker.onerror = () => resolve(false);
    });
  } finally {
    worker.terminate();
  }
}

const CAN_MEASURE_IN_WORKER = await workerHasCanvas();
const HASH = 'd'.repeat(64);
const SAMPLE = 'Hamburgefonstiv 0123456789 abc WWW iii';
const SIZE_PT = 11;

const entries: readonly FontFileEntry[] = [
  {
    family: 'Noto Serif',
    style: 'normal',
    weight: '400',
    url: notoSerifUrl,
    hash: HASH,
    licence: 'OFL-1.1',
  },
];
const key = (family: string): CanvasFontKey => ({
  family,
  sizePt: SIZE_PT,
  bold: false,
  italic: false,
});

describe.skipIf(!isBrowser)('the page waits for its face with the shared helper (FE-063)', () => {
  // A hash of its own: Firefox keeps a canvas font cached by family name after the face is deleted,
  // so reusing HASH here would make the later test's "fallback" width the loaded width.
  const PAGE_HASH = 'c'.repeat(64);
  const pageEntries = entries.map((entry) => ({ ...entry, hash: PAGE_HASH }));
  afterEach(() => {
    for (const face of Array.from(document.fonts))
      if (face.family === fontAlias(PAGE_HASH)) document.fonts.delete(face);
  });

  it('refuses to measure an alias with no face, and waits for a registered one', async () => {
    const alias = fontAlias(PAGE_HASH);
    const fonts = scopeFonts();
    expect(fonts).not.toBeNull();
    await expect(ensureFace(fonts!.set, key(fontAlias('e'.repeat(64))))).rejects.toThrow(/no face/);
    // The handler, run on the page, refuses a measurement before `start` registered any alias.
    const handle = measureHandler(globalThis);
    await expect(
      handle({ kind: 'measure', id: 1, font: key(alias), text: SAMPLE }),
    ).resolves.toMatchObject({
      kind: 'error',
      code: 'not_started',
    });
    const started = await handle({ kind: 'start', id: 2, entries: pageEntries });
    expect(started).toEqual({ kind: 'started', id: 2, aliases: [alias] });
    const face = Array.from(document.fonts).find((f) => f.family === alias);
    expect(face?.status).toBe('unloaded');
    await ensureFace(fonts!.set as LoadingFontSet, key(alias));
    expect(face?.status).toBe('loaded');
  });
});

describe.skipIf(!isBrowser || !CAN_MEASURE_IN_WORKER)(
  'the element measuring worker matches the page (FE-063)',
  () => {
    const clients: MeasureWorkerClient[] = [];
    afterEach(() => {
      for (const client of clients.splice(0)) client.terminate();
      for (const face of Array.from(document.fonts))
        if (face.family === fontAlias(HASH)) document.fonts.delete(face);
    });

    it('registers the same alias before measuring, waits for the font, and measures the page width', async () => {
      const alias = fontAlias(HASH);

      // Page: the face is registered but not loaded, so a measurement now takes the fallback.
      const page = pageFonts();
      expect(page).not.toBeNull();
      registerFontFiles(entries, page!.set, page!.make);
      const pageFace = Array.from(document.fonts).find((face) => face.family === alias);
      expect(pageFace?.status).toBe('unloaded');
      const fallbackWidth = canvasTextMeasurer().advance(key(alias), SAMPLE);
      await ensureFace(scopeFonts()!.set, key(alias));
      const pageWidth = canvasTextMeasurer().advance(key(alias), SAMPLE);
      expect(pageWidth).not.toBe(fallbackWidth);

      // Worker: started by the element's client; its first message registers the same alias. The
      // measurement is asked at once, without waiting for `ready` or for any load: the worker's own
      // face is unloaded, and the width it answers is the loaded face's, not the fallback's.
      const client = startMeasureWorker(entries);
      clients.push(client);
      const measured = client.advance(key(alias), SAMPLE);
      await expect(client.ready).resolves.toEqual([alias]);
      const width = await measured;
      expect(width).toBe(pageWidth);
      expect(width).not.toBe(fallbackWidth);
    });

    it('does not measure with a fallback when no face holds the alias', async () => {
      const client = startMeasureWorker(entries);
      clients.push(client);
      await client.ready;
      const missing = client.advance(key(fontAlias('f'.repeat(64))), SAMPLE);
      await expect(missing).rejects.toBeInstanceOf(MeasureWorkerError);
      await expect(missing).rejects.toMatchObject({ code: 'face_missing' });
    });
  },
);
