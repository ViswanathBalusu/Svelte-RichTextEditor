// The finalisation gate (12 §6.2, §8.2; FRW-049 criterion 4, FRW-053 criterion 5, FRW-054 criterion 2).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  type CompileResult,
  type SealResult,
  type StoreResult,
  finaliseWorkflow,
} from '../src/index.ts';

const hash = 'a'.repeat(64);
const other = 'b'.repeat(64);
const okCompile: CompileResult = { ok: true };
const badCompile: CompileResult = { ok: false, diagnostics: ['undefined reference'] };
const okSeal: SealResult = { ok: true, timestamped: true, sealedHash: hash };
const okStore: StoreResult = { ok: true, storedHash: hash };

describe('completed is raised first and finalised only after the sealed bytes are stored', () => {
  it('raises completed and then finalised when every step succeeds (FRW-049 criterion 4)', () => {
    const out = finaliseWorkflow({ compile: okCompile, seal: okSeal, store: okStore });
    expect(out).toEqual({
      status: 'finalised',
      raised: ['completed', 'finalised'],
      stoppedAt: null,
      failure: null,
      alert: false,
      sealedHash: hash,
    });
  });

  it('a store that fails leaves the workflow completed and finalised is not raised (FRW-054 criterion 2)', () => {
    const out = finaliseWorkflow({
      compile: okCompile,
      seal: okSeal,
      store: { ok: false, reason: 'store_failed' },
    });
    expect(out.status).toBe('completed');
    expect(out.raised).toEqual(['completed']);
    expect(out.stoppedAt).toBe('store');
    expect(out.failure?.code).toBe('store_failed');
    expect(out.alert).toBe(true);
  });

  it('stores other bytes than the sealed ones: not finalised', () => {
    const out = finaliseWorkflow({
      compile: okCompile,
      seal: okSeal,
      store: { ok: true, storedHash: other },
    });
    expect(out.status).toBe('completed');
    expect(out.failure?.code).toBe('stored_hash_differs');
  });
});

describe('a failed compile stops the run and names its diagnostics (FRW-049 criterion 3)', () => {
  it('stays completed, does not finalise, and returns the diagnostics', () => {
    const out = finaliseWorkflow({ compile: badCompile, seal: okSeal, store: okStore });
    expect(out.status).toBe('completed');
    expect(out.raised).toEqual(['completed']);
    expect(out.stoppedAt).toBe('compile');
    expect(out.failure).toEqual({
      stage: 'compile',
      code: 'compile_failed',
      diagnostics: ['undefined reference'],
    });
    expect(out.alert).toBe(true);
    expect(out.sealedHash).toBeNull();
  });
});

describe('no seal without a time-stamp (FRW-053 criterion 5)', () => {
  it('an unreachable time-stamping authority stops the run at the seal', () => {
    const out = finaliseWorkflow({
      compile: okCompile,
      seal: { ok: false, reason: 'tsa_unreachable' },
      store: okStore,
    });
    expect(out.status).toBe('completed');
    expect(out.stoppedAt).toBe('seal');
    expect(out.failure?.code).toBe('tsa_unreachable');
    expect(out.sealedHash).toBeNull();
  });

  it('a seal that carries no time-stamp token is refused', () => {
    const out = finaliseWorkflow({
      compile: okCompile,
      seal: { ok: true, timestamped: false, sealedHash: hash },
      store: okStore,
    });
    expect(out.status).toBe('completed');
    expect(out.failure?.code).toBe('no_timestamp');
    expect(out.sealedHash).toBeNull();
  });

  it('a missing seal or store result is never treated as success', () => {
    expect(finaliseWorkflow({ compile: okCompile }).failure?.code).toBe('seal_missing');
    expect(finaliseWorkflow({ compile: okCompile, seal: okSeal }).failure?.code).toBe(
      'store_missing',
    );
  });
});

describe('finalised is raised exactly when every step succeeded (property)', () => {
  const compile: fc.Arbitrary<CompileResult> = fc.constantFrom<CompileResult>(
    okCompile,
    badCompile,
  );
  const seal: fc.Arbitrary<SealResult> = fc.constantFrom<SealResult>(
    okSeal,
    { ok: true, timestamped: false, sealedHash: hash },
    { ok: false, reason: 'tsa_unreachable' },
    { ok: false, reason: 'signing_unavailable' },
    { ok: false, reason: 'seal_failed' },
  );
  const store: fc.Arbitrary<StoreResult> = fc.constantFrom<StoreResult>(
    okStore,
    { ok: true, storedHash: other },
    { ok: false, reason: 'store_failed' },
  );

  it('finalised iff compile, seal (timestamped) and store all succeed; completed is always raised first', () => {
    fc.assert(
      fc.property(compile, seal, store, (c, s, st) => {
        const out = finaliseWorkflow({ compile: c, seal: s, store: st });
        const allOk = c.ok && s.ok && s.timestamped && st.ok && st.storedHash === s.sealedHash;
        expect(out.status === 'finalised').toBe(allOk);
        expect(out.raised[0]).toBe('completed');
        expect(out.raised.includes('finalised')).toBe(allOk);
        expect(out.alert).toBe(!allOk);
        expect(out.failure === null).toBe(allOk);
        if (out.failure !== null) expect(out.stoppedAt).toBe(out.failure.stage);
      }),
      { numRuns: 300 },
    );
  });
});
