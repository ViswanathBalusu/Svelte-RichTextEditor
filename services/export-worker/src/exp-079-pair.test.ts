/**
 * EXP-079 (lane V-EXP-065-080), Node only: the pair rule on fake compile results. Criteria 3 to 5:
 * equal pairs are sealable, unequal or failed pairs are not, and `acceptForSealing` refuses anything
 * that did not come from an equal pair. The real two-sandbox run is in exp-079-pair.podman.test.ts.
 */
import { describe, expect, it } from 'vitest';
import type { CompileResult } from './sandbox.ts';
import { acceptForSealing, comparePair, sha256Hex } from './exp-079-pair.ts';

function run(name: string, over: Partial<CompileResult>): CompileResult {
  return {
    ok: true,
    exitCode: 0,
    timedOut: false,
    outputOverflow: false,
    cancelled: false,
    passes: [],
    converged: true,
    pdf: new TextEncoder().encode('%PDF-1.7 probe'),
    log: '',
    layoutRaw: null,
    stderr: '',
    wallMs: 10,
    stdout: new Uint8Array(),
    name,
    limits: {} as CompileResult['limits'],
    passTimeoutSeconds: 1,
    ...over,
  };
}

describe('EXP-079 pair rule', () => {
  it('makes an equal pair sealable and records both hashes', () => {
    const a = run('c-a', {});
    const b = run('c-b', {});
    const out = comparePair(a, b);
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    const want = sha256Hex(a.pdf!);
    expect(out.hashes).toEqual({ a: want, b: want });
    expect(acceptForSealing(out.sealable)).toEqual(a.pdf);
  });

  it('refuses to seal when the PDFs differ, with a diagnostic and no sealable PDF', () => {
    const out = comparePair(
      run('c-a', {}),
      run('c-b', { pdf: new TextEncoder().encode('%PDF-1.7 other') }),
    );
    expect(out.ok).toBe(false);
    expect(out.sealable).toBeNull();
    expect(out.ok ? '' : out.diagnostic).toMatch(/differ/);
    expect(out.hashes).not.toBeNull();
  });

  it('refuses when either compile failed or produced no PDF', () => {
    const failed = comparePair(run('c-a', {}), run('c-b', { ok: false, exitCode: 1 }));
    expect(failed.ok).toBe(false);
    expect(failed.ok ? '' : failed.diagnostic).toMatch(/second compile failed/);
    const none = comparePair(run('c-a', { pdf: null }), run('c-b', {}));
    expect(none.ok).toBe(false);
    expect(none.ok ? '' : none.diagnostic).toMatch(/no PDF/);
  });

  it('refuses when both compiles ran in the same container (not independent)', () => {
    const out = comparePair(run('same', {}), run('same', {}));
    expect(out.ok).toBe(false);
  });

  it('reports the wall time of both compiles for the compile-minute count', () => {
    const out = comparePair(run('c-a', { wallMs: 120 }), run('c-b', { wallMs: 340 }));
    expect(out.compileMs).toEqual([120, 340]);
  });

  it('acceptForSealing refuses a PDF that was not marked by an equal pair', () => {
    expect(() => acceptForSealing(new Uint8Array([1, 2, 3]))).toThrow(/equal pair/);
    expect(() => acceptForSealing({ pdf: new Uint8Array([1]) })).toThrow(/equal pair/);
    expect(() => acceptForSealing(null)).toThrow(/equal pair/);
    const unequal = comparePair(run('c-a', {}), run('c-b', { pdf: new TextEncoder().encode('x') }));
    expect(() => acceptForSealing(unequal.sealable ?? { pdf: new Uint8Array() })).toThrow(
      /equal pair/,
    );
  });
});
