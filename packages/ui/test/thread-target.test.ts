/**
 * The target of a new comment thread (UX-028 criterion 2; criterion 5 gate only; 05 §6.2).
 */
import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { THREAD_LIMIT, threadLimitGate, threadTarget } from '../src/shell/thread-target.ts';

describe('a range selection targets { range: { from, to, baseSeq } } (UX-028 criterion 1 shape)', () => {
  it('builds the range target with the sequence it was read at', () => {
    expect(threadTarget({ kind: 'range', from: 3, to: 9, baseSeq: 41 })).toEqual({
      ok: true,
      target: { range: { from: 3, to: 9, baseSeq: 41 } },
    });
  });

  it('refuses a range that is reversed, fractional or negative, and a bad baseSeq', () => {
    expect(threadTarget({ kind: 'range', from: 9, to: 3, baseSeq: 1 })).toEqual({
      ok: false,
      reason: 'badRange',
    });
    expect(threadTarget({ kind: 'range', from: 1.5, to: 3, baseSeq: 1 })).toEqual({
      ok: false,
      reason: 'badRange',
    });
    expect(threadTarget({ kind: 'range', from: -1, to: 3, baseSeq: 1 })).toEqual({
      ok: false,
      reason: 'badRange',
    });
    expect(threadTarget({ kind: 'range', from: 1, to: 3, baseSeq: -2 })).toEqual({
      ok: false,
      reason: 'badRange',
    });
  });

  it('keeps any valid range as a range target, with the same positions (property)', () => {
    fc.assert(
      fc.property(fc.nat(1000), fc.nat(1000), fc.nat(100000), (a, b, baseSeq) => {
        const from = Math.min(a, b);
        const to = Math.max(a, b);
        const result = threadTarget({ kind: 'range', from, to, baseSeq });
        expect(result).toEqual({ ok: true, target: { range: { from, to, baseSeq } } });
      }),
    );
  });
});

describe('a block selection targets { block: id } (UX-028 criterion 2)', () => {
  it('targets a figure, table or equation by its identifier', () => {
    for (const id of ['figure-3', 'table-1', 'equation-7']) {
      expect(threadTarget({ kind: 'block', id })).toEqual({ ok: true, target: { block: id } });
    }
  });

  it('refuses an empty identifier', () => {
    expect(threadTarget({ kind: 'block', id: '' })).toEqual({ ok: false, reason: 'emptyBlock' });
  });

  it('gives exactly one key, block, and never a range (property)', () => {
    fc.assert(
      fc.property(fc.string({ minLength: 1, maxLength: 40 }), (id) => {
        const result = threadTarget({ kind: 'block', id });
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(Object.keys(result.target)).toEqual(['block']);
        expect('range' in result.target).toBe(false);
      }),
    );
  });
});

describe('the thread limit gate (UX-028 criterion 5, gate only)', () => {
  it('uses the 5,000 threads the story gives', () => {
    expect(THREAD_LIMIT).toBe(5000);
  });

  it('refuses a creation at and above the limit, and allows one below it (property)', () => {
    fc.assert(
      fc.property(fc.nat(10000), (count) => {
        const gate = threadLimitGate(count);
        expect(gate.allowed).toBe(count < THREAD_LIMIT);
        if (!gate.allowed) expect(gate.reason).toBe('threadLimit');
      }),
    );
  });

  it('refuses a count that is not a whole non-negative number', () => {
    expect(threadLimitGate(-1).allowed).toBe(false);
    expect(threadLimitGate(Number.NaN).allowed).toBe(false);
  });
});
