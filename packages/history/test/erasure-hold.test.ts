// An erasure request against a legal hold (owner decision 38; HIS-031 criterion 5): the hold wins,
// the erasure runs when the hold is released, and the request and the delay are audited.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { decideErasure, releaseDeferred } from '../src/erasure-hold.ts';

const req = { person: 'p-1', requestedBy: 'admin-1', requestedAt: 1_000 };

describe('erasure against a legal hold (HIS-031 criterion 5)', () => {
  it('erases at once when the person is in no document under hold', () => {
    const d = decideErasure(req, ['d1', 'd2'], new Set(['d9']));
    expect(d.action).toBe('erase');
    expect(d.audit).toMatchObject({ kind: 'erasure-run', delayMs: 0, at: 1_000 });
  });

  it('defers the request when the person appears in a document under hold, and audits it', () => {
    const d = decideErasure(req, ['d2', 'd1', 'd2'], new Set(['d2', 'd9']));
    expect(d.action).toBe('defer');
    if (d.action !== 'defer') return;
    expect(d.pending.blockedBy).toEqual(['d2']);
    expect(d.audit).toEqual({
      kind: 'erasure-deferred',
      person: 'p-1',
      requestedBy: 'admin-1',
      requestedAt: 1_000,
      blockedBy: ['d2'],
    });
  });

  it('runs the request when the hold is released, and audits the delay', () => {
    const d = decideErasure(req, ['d1'], new Set(['d1']));
    if (d.action !== 'defer') throw new Error('expected a deferral');
    const still = releaseDeferred([d.pending], new Set(['d1']), 5_000);
    expect(still.run).toEqual([]);
    expect(still.waiting).toHaveLength(1);
    const freed = releaseDeferred([d.pending], new Set(), 61_000);
    expect(freed.waiting).toEqual([]);
    expect(freed.run).toHaveLength(1);
    expect(freed.run[0]!.audit).toEqual({
      kind: 'erasure-run',
      person: 'p-1',
      requestedBy: 'admin-1',
      requestedAt: 1_000,
      at: 61_000,
      delayMs: 60_000,
    });
  });

  it('keeps a request waiting while any one of its documents is still held', () => {
    const d = decideErasure(req, ['d1', 'd2'], new Set(['d1', 'd2']));
    if (d.action !== 'defer') throw new Error('expected a deferral');
    const r = releaseDeferred([d.pending], new Set(['d2']), 9_000);
    expect(r.run).toEqual([]);
    expect(r.waiting[0]!.blockedBy).toEqual(['d2']);
  });

  it('never runs a request that a held document blocks, and runs every other (property)', () => {
    const ids = fc.array(fc.constantFrom('a', 'b', 'c', 'd', 'e'), { maxLength: 5 });
    fc.assert(
      fc.property(ids, ids, ids, (appears, held0, held1) => {
        const d = decideErasure(req, appears, new Set(held0));
        if (d.action === 'erase') {
          expect(appears.some((x) => held0.includes(x))).toBe(false);
          return;
        }
        const r = releaseDeferred([d.pending], new Set(held1), 10_000);
        const blocked = d.pending.blockedBy.some((x) => held1.includes(x));
        expect(r.run.length).toBe(blocked ? 0 : 1);
        expect(r.waiting.length).toBe(blocked ? 1 : 0);
      }),
    );
  });
});
