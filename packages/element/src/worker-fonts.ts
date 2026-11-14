// Fonts where text is measured (FE-063; 02 §3, §6, §9.3). A worker that measures text registers the
// manifest's files on its own font set under the same hash aliases as the page (`registerFontFiles`,
// FE-061) before any measurement, and every measurement waits until the faces it names are loaded,
// so no width is taken from a fallback. The page uses the same `ensureFace` before it measures.
//
// `measureHandler` is the whole sequence of the element's measuring worker; `measure-worker.ts` is
// the worker entry that wires it to `onmessage`, and `measure-worker-client.ts` starts it. The font
// set and the FontFace constructor are read from the scope passed in (`self` in a worker, the page's
// `document` otherwise), so the same code runs on both sides.
import {
  canvasTextMeasurer,
  type CanvasFontKey,
  type CanvasTextMeasurer,
} from './canvas-measure.ts';
import { cssUrl } from './font-loader.ts';
import {
  registerFontFiles,
  type FontFaceFactory,
  type FontFaceLike,
  type FontFaceSetLike,
  type FontFileEntry,
} from './font-registration.ts';

/** A font set that loads faces for a CSS font shorthand (`FontFaceSet.load`). */
export interface LoadingFontSet extends FontFaceSetLike {
  /** Resolves with the faces that match and are now loaded; empty when none matches. */
  load(font: string): Promise<readonly unknown[]>;
}

/** The fonts of one scope: its own font set and its FontFace constructor. */
export interface ScopeFonts {
  readonly set: LoadingFontSet;
  readonly make: FontFaceFactory;
}

interface FontScope {
  /** `WorkerGlobalScope.fonts`. */
  readonly fonts?: LoadingFontSet;
  readonly document?: { readonly fonts?: LoadingFontSet };
  readonly FontFace?: new (
    family: string,
    source: string,
    descriptors: { style: string; weight: string },
  ) => FontFaceLike;
}

/**
 * The font set of a scope: `self.fonts` in a worker, `document.fonts` on a page. Null where there is
 * none (Node.js, or a worker without the FontFace API).
 */
export function scopeFonts(scope: unknown = globalThis): ScopeFonts | null {
  const s = scope as FontScope;
  const set = s.fonts ?? s.document?.fonts;
  const Face = s.FontFace;
  if (!set || typeof Face !== 'function') return null;
  return {
    set,
    make: (alias, url, style, weight) => new Face(alias, cssUrl(url), { style, weight }),
  };
}

/**
 * The CSS font shorthand that selects the face of `font`: the same style, weight, size and alias
 * that `canvasTextMeasurer` sets, without its generic fallback, so that a load names only the alias.
 */
export function cssFont(font: CanvasFontKey): string {
  const family = font.family.replace(/["\\]/g, '');
  return `${font.italic ? 'italic ' : ''}${font.bold ? 'bold ' : ''}${font.sizePt * (4 / 3)}px "${family}"`;
}

/** A measurement was asked of an alias that no face of the set holds. */
export class FaceMissingError extends Error {
  override name = 'FaceMissingError';
}

/**
 * Waits until the face of `font` is loaded in `set` (FE-063 criterion 3; 02 §6 "layout waits for the
 * fonts it needs"). Rejects with `FaceMissingError` when no face matches, since a measurement then
 * would take the fallback, and with the font set's error when the file fails to load.
 */
export async function ensureFace(set: LoadingFontSet, font: CanvasFontKey): Promise<void> {
  const faces = await set.load(cssFont(font));
  if (faces.length === 0)
    throw new FaceMissingError(`no face is registered for ${font.family.slice(0, 80)}`);
}

/** The requests of the measuring worker. Each carries an id that its reply repeats. */
export type MeasureRequest =
  | { readonly kind: 'start'; readonly id: number; readonly entries: readonly FontFileEntry[] }
  | {
      readonly kind: 'measure';
      readonly id: number;
      readonly font: CanvasFontKey;
      readonly text: string;
    };

export type MeasureReply =
  | { readonly kind: 'started'; readonly id: number; readonly aliases: readonly string[] }
  | { readonly kind: 'width'; readonly id: number; readonly width: number }
  | {
      readonly kind: 'error';
      readonly id: number;
      readonly code: string;
      readonly message: string;
    };

/**
 * The measuring worker's sequence (FE-063 criteria 1 and 3). `start` registers the manifest's files
 * on the scope's own font set under the page's aliases; a `measure` that comes before any `start`
 * is refused, so nothing is measured before the aliases exist; a `measure` after it waits for its
 * face, and only then measures with the element's canvas measurer.
 */
export function measureHandler(
  scope: unknown = globalThis,
  measurer: () => CanvasTextMeasurer = canvasTextMeasurer,
): (request: MeasureRequest) => Promise<MeasureReply> {
  let registered = false;
  let canvas: CanvasTextMeasurer | null = null;
  const fail = (id: number, code: string, error: unknown): MeasureReply => ({
    kind: 'error',
    id,
    code,
    message: error instanceof Error ? error.message.slice(0, 200) : 'failed',
  });
  return async (request) => {
    const fonts = scopeFonts(scope);
    if (!fonts) return fail(request.id, 'no_fonts', new Error('this scope has no font set'));
    if (request.kind === 'start') {
      // Registration is synchronous, so every later request finds the aliases on the font set.
      const aliases = registerFontFiles(request.entries, fonts.set, fonts.make);
      registered = true;
      return { kind: 'started', id: request.id, aliases };
    }
    if (!registered)
      return fail(
        request.id,
        'not_started',
        new Error('measure before start: no aliases registered'),
      );
    try {
      await ensureFace(fonts.set, request.font);
    } catch (error) {
      return fail(
        request.id,
        error instanceof FaceMissingError ? 'face_missing' : 'load_failed',
        error,
      );
    }
    canvas ??= measurer();
    return { kind: 'width', id: request.id, width: canvas.advance(request.font, request.text) };
  };
}
