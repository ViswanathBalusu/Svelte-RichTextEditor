// The page's font arrivals as a `FontArrivals` source (FE-064 criterion 2; 02 §6, §9.3). In the
// browser the faces are the page's `document.fonts`; this module takes them through a callback, so
// it reads no browser global and runs in Node.js and in workers alike.
//
// An arrival is a face that was not loaded when a measurement under its alias was taken and is
// loaded now, whoever loaded it: this source, the browser fetching it for painted text, or another
// `load()` call. So the source remembers each face's status at the first measurement (`note`), and
// `arrived` compares against that record, not against the status at the time it is asked.
import type { FontArrivals } from './font-epoch.ts';

/** The part of a FontFace this source reads and calls. */
export interface LoadableFaceLike {
  readonly family: string;
  /** `unloaded`, `loading`, `loaded` or `error`, as the FontFace API reports them. */
  readonly status?: string;
  /**
   * Resolves when the face has loaded by any route, rejects when it fails (`FontFace.loaded`).
   * Absent: the source calls `load()` to wait.
   */
  readonly loaded?: Promise<unknown>;
  load(): Promise<unknown>;
}

/** A `FontArrivals` that also records what a layout pass measured with. */
export interface FaceArrivals extends FontArrivals {
  /**
   * Records, for each face under `alias` not yet recorded, whether it was loaded at this moment. A
   * pass calls it as it measures (`notingMeasurer`, font-pass.ts). The first record of a face stands.
   */
  note(alias: string): void;
}

export interface FaceArrivalsOptions {
  /**
   * Whether `arrived` starts the load of a face that is not loaded. False (the default): it only
   * waits, and the face arrives when something else loads it.
   */
  readonly load?: boolean;
}

const unquoted = (family: string): string => family.replace(/^["']|["']$/g, '');

/** How a face stood when a pass first measured under its alias. */
type Seen = 'loaded' | 'pending' | 'reported';

/**
 * A `FaceArrivals` over a set of faces. `arrived(alias)` notes the alias first (a pass that did not
 * call `note` is recorded now), then:
 * - resolves `false` when no face holds the alias, or every face under it was loaded when first
 *   noted, or its arrival was already reported;
 * - otherwise waits until those faces are loaded, by any route, and resolves `true` once: a later
 *   or concurrent call for the same faces resolves `false`;
 * - rejects when a face fails to load, which `FontEpoch.track` counts as "not arrived".
 * An alias noted while no face held it counts its faces as not loaded when they appear, since the
 * pass measured it with a fallback.
 */
export function faceArrivals(
  faces: () => Iterable<LoadableFaceLike>,
  options: FaceArrivalsOptions = {},
): FaceArrivals {
  const seen = new WeakMap<LoadableFaceLike, Seen>();
  const absent = new Set<string>();
  const matching = (alias: string): LoadableFaceLike[] =>
    [...faces()].filter((face) => unquoted(face.family) === alias);

  const note = (alias: string): LoadableFaceLike[] => {
    const list = matching(alias);
    if (list.length === 0) absent.add(alias);
    for (const face of list)
      if (!seen.has(face))
        seen.set(face, !absent.has(alias) && face.status === 'loaded' ? 'loaded' : 'pending');
    return list;
  };

  const settled = (face: LoadableFaceLike): Promise<unknown> => {
    if (face.status === 'loaded') return Promise.resolve();
    if (options.load || face.loaded === undefined) return face.load();
    return face.loaded;
  };

  return {
    note(alias) {
      note(alias);
    },
    async arrived(alias) {
      const pending = note(alias).filter((face) => seen.get(face) === 'pending');
      if (pending.length === 0) return false;
      await Promise.all(pending.map(settled));
      // Report each arrival once: a concurrent call that also waited finds them reported.
      const fresh = pending.filter((face) => seen.get(face) === 'pending');
      for (const face of fresh) seen.set(face, 'reported');
      return fresh.length > 0;
    },
  };
}
