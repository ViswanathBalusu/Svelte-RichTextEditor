/**
 * FE-064, criterion 2 (Node.js): when a font arrives after layout, the font epoch advances, the
 * measurement caches keyed by the old epoch no longer hit, and a font that was already loaded does
 * not advance it. Criteria 1 (a pass waits for an unloaded font) and 3 (only the blocks that use
 * the font are re-measured) are not run here: no layout pass calls `track` yet (see the story Notes).
 */
import { describe, expect, it } from 'vitest';
import { FontEpoch, type FontArrivals } from './font-epoch.ts';
import { type FontKey, type TextMeasurer, fixedWidthMeasurer } from './measure.ts';

const font: FontKey = { family: 'de-serif-test', sizePt: 10, bold: false, italic: false };

function countingMeasurer(): { measurer: TextMeasurer; calls: () => number } {
  const inner = fixedWidthMeasurer({ emWidth: 0.5 });
  let n = 0;
  return {
    measurer: {
      id: inner.id,
      advance: (f, t) => {
        n += 1;
        return inner.advance(f, t);
      },
      lineMetrics: (f) => inner.lineMetrics(f),
    },
    calls: () => n,
  };
}

/** Arrivals that resolve when the test says so; `arrived` is true for an alias not loaded before. */
function fakeArrivals(loaded: readonly string[], pending: Record<string, Promise<boolean>>) {
  const before = new Set(loaded);
  const source: FontArrivals = {
    arrived: (alias) => {
      if (before.has(alias)) return Promise.resolve(false);
      return pending[alias] ?? Promise.resolve(true);
    },
  };
  return source;
}

describe('FE-064 criterion 2: a font arrival advances the epoch and misses old caches', () => {
  it('a cache under the old epoch does not answer after the epoch advances', () => {
    const epoch = new FontEpoch(0);
    const { measurer, calls } = countingMeasurer();

    const before = epoch.measurer(measurer);
    before.advance(font, 'abc');
    before.advance(font, 'abc');
    expect(calls()).toBe(1);

    epoch.advance();
    const after = epoch.measurer(measurer);
    after.advance(font, 'abc');
    expect(calls()).toBe(2);
    expect(after.id).not.toBe(before.id);
  });

  it('a font that arrives after layout advances the epoch once', async () => {
    const epoch = new FontEpoch(0);
    await epoch.track(fakeArrivals([], {}), ['alias-a', 'alias-a', 'alias-b']);
    // Two distinct aliases arrived; the duplicate is looked at once.
    expect(epoch.value).toBe(2);
  });

  it('a font that was already loaded does not advance the epoch', async () => {
    const epoch = new FontEpoch(5);
    await epoch.track(fakeArrivals(['alias-a'], {}), ['alias-a']);
    expect(epoch.value).toBe(5);
  });

  it('the epoch moves only when the font has arrived, not while it is pending', async () => {
    const epoch = new FontEpoch(0);
    let resolve!: (v: boolean) => void;
    const pending = new Promise<boolean>((r) => {
      resolve = r;
    });
    const done = epoch.track(fakeArrivals([], { 'alias-late': pending }), ['alias-late']);
    expect(epoch.value).toBe(0);
    resolve(true);
    await done;
    expect(epoch.value).toBe(1);
  });

  it('a font whose load fails does not advance the epoch', async () => {
    const epoch = new FontEpoch(0);
    const failing: FontArrivals = { arrived: () => Promise.reject(new Error('404')) };
    await epoch.track(failing, ['alias-bad']);
    expect(epoch.value).toBe(0);
  });
});
