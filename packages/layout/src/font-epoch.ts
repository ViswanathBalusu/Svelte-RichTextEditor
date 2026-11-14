/**
 * The font epoch (02 §6, §9.3; FE-064). A measurement is only as good as the face it was taken
 * from, so every measurement cache is keyed by an epoch, and the epoch advances when a font that a
 * layout pass was waiting for arrives. Caches made under an older epoch then never hit, and the
 * next pass measures again.
 *
 * This module does not load fonts. The caller passes a `FontArrivals` source (in the browser, the
 * page's `document.fonts`; in tests, a fake) that resolves once per alias.
 */
import { cachingMeasurer, type TextMeasurer } from './measure.ts';

/**
 * Reports when a font face arrives. `arrived(alias)` resolves `true` when the face was not loaded
 * when the pass started and is now, and `false` when it was already there. A rejection is treated
 * as "not arrived": the epoch does not move for a font that never loaded.
 */
export interface FontArrivals {
  arrived(alias: string): Promise<boolean>;
}

export class FontEpoch {
  #value: number;
  // The aliases that arrived since the last `takeArrived` (FE-064 criterion 3: which blocks to re-measure).
  #arrived = new Set<string>();

  constructor(initial = 0) {
    this.#value = initial;
  }

  /** The aliases that arrived since the last call, and forgets them. */
  takeArrived(): Set<string> {
    const out = this.#arrived;
    this.#arrived = new Set<string>();
    return out;
  }

  /** The current epoch. */
  get value(): number {
    return this.#value;
  }

  /** A font arrived: the epoch advances by one and returns its new value. */
  advance(): number {
    this.#value += 1;
    return this.#value;
  }

  /** A measurer whose cache is keyed by the current epoch (`cachingMeasurer`, measure.ts). */
  measurer(inner: TextMeasurer): TextMeasurer {
    return cachingMeasurer(inner, this.#value);
  }

  /**
   * Watches the aliases a pass needs. Each alias is looked at once; every alias that arrives
   * advances the epoch once. Resolves when every watched alias has settled.
   */
  async track(arrivals: FontArrivals, aliases: readonly string[]): Promise<void> {
    const unique = [...new Set(aliases)];
    await Promise.all(
      unique.map(async (alias) => {
        // A rejection, or a source that throws, counts as "not arrived" (see `FontArrivals`).
        const arrived = await Promise.resolve()
          .then(() => arrivals.arrived(alias))
          .catch(() => false);
        if (arrived) {
          this.#arrived.add(alias);
          this.advance();
        }
      }),
    );
  }
}
