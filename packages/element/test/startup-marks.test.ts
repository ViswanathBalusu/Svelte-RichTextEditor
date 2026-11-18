import { beforeEach, describe, expect, it } from 'vitest';
import {
  markRegistryEnd,
  markShellMounted,
  markShellStart,
  STARTUP,
  timeBodyAttach,
} from '../src/startup-marks.ts';

function measureNamed(name: string): PerformanceEntry | undefined {
  return performance.getEntriesByName(name, 'measure').at(-1);
}

describe('FE-119 criterion 5: the shell start-up marks', () => {
  beforeEach(() => {
    performance.clearMarks();
    performance.clearMeasures();
  });

  it('records the registry, the chrome, the body view and the whole as separate measures', () => {
    markShellStart();
    markRegistryEnd();
    const result = timeBodyAttach(() => 'attached');
    markShellMounted();

    expect(result).toBe('attached');
    for (const name of [STARTUP.registry, STARTUP.chrome, STARTUP.body, STARTUP.total]) {
      const entry = measureNamed(name);
      expect(entry, name).toBeDefined();
      expect(entry!.duration).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the shell parts inside the whole: registry and chrome end where the body view starts', () => {
    markShellStart();
    markRegistryEnd();
    timeBodyAttach(() => undefined);
    markShellMounted();

    const registry = measureNamed(STARTUP.registry)!;
    const chrome = measureNamed(STARTUP.chrome)!;
    const body = measureNamed(STARTUP.body)!;
    const total = measureNamed(STARTUP.total)!;
    expect(chrome.startTime).toBeCloseTo(registry.startTime + registry.duration, 3);
    expect(body.startTime).toBeCloseTo(chrome.startTime + chrome.duration, 3);
    expect(registry.duration + chrome.duration + body.duration).toBeLessThanOrEqual(
      total.duration + 0.001,
    );
  });

  it('ends the body measure and rethrows when the attachment throws', () => {
    markShellStart();
    markRegistryEnd();
    expect(() =>
      timeBodyAttach(() => {
        throw new Error('no target');
      }),
    ).toThrow('no target');
    expect(measureNamed(STARTUP.body)).toBeDefined();
  });

  it('gives no measure for a part that did not run, and does not throw', () => {
    markShellStart();
    expect(() => markShellMounted()).not.toThrow();
    expect(measureNamed(STARTUP.registry)).toBeUndefined();
    expect(measureNamed(STARTUP.total)).toBeDefined();
  });
});
