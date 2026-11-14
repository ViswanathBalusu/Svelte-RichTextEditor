// The purge plan of a deleted document (08 §13; HIS-039): what the job removes, what it keeps, and
// when it does not run (retention still running, not deleted, or under a legal hold).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { NO_HOLD } from '../src/hold.ts';
import { type PurgeAsset, type PurgeRequest, purgePlan } from '../src/purge.ts';

const DAY = 24 * 60 * 60 * 1000;
const DELETED_AT = 1_000_000_000_000;

const base = (over: Partial<PurgeRequest> = {}): PurgeRequest => ({
  doc: 'doc-1',
  deletedAt: DELETED_AT,
  retentionMs: 30 * DAY,
  now: DELETED_AT + 31 * DAY,
  hold: NO_HOLD,
  assets: [],
  ...over,
});

function outcomeOf(req: PurgeRequest) {
  const r = purgePlan(req);
  if (!r.ok) throw new Error(`refused: ${r.reason}`);
  return r.outcome;
}

describe('purging a deleted document (HIS-039)', () => {
  it('removes commits, cold segments, checkpoints, exports and search entries once retention has passed', () => {
    const o = outcomeOf(base());
    expect(o.run).toBe(true);
    if (!o.run) return;
    expect(o.remove).toEqual({
      commits: true,
      coldSegments: true,
      checkpoints: true,
      exports: true,
      searchEntries: true,
      assets: [],
    });
    expect(o.audit).toEqual({ action: 'purge', doc: 'doc-1', at: DELETED_AT + 31 * DAY });
  });

  it('keeps an asset that another document references and removes the rest (criterion 2, property)', () => {
    fc.assert(
      fc.property(
        fc.uniqueArray(
          // Identifiers that purgePlan accepts: a blank one is refused (see 'refusals' below).
          fc.record({ id: fc.stringMatching(/^[a-z0-9-]{1,6}$/), shared: fc.boolean() }),
          { maxLength: 12, selector: (a) => a.id },
        ),
        (items) => {
          const assets: PurgeAsset[] = items.map((i) => ({
            id: i.id,
            sharedWithOtherDocument: i.shared,
          }));
          const o = outcomeOf(base({ assets }));
          if (!o.run) throw new Error('expected a run');
          const shared = assets.filter((a) => a.sharedWithOtherDocument).map((a) => a.id);
          const unshared = assets.filter((a) => !a.sharedWithOtherDocument).map((a) => a.id);
          expect(o.keptAssets).toEqual(shared);
          expect(o.remove.assets).toEqual(unshared);
          for (const id of shared) expect(o.remove.assets).not.toContain(id);
        },
      ),
    );
  });

  it('keeps a shared asset while removing an unshared one of the same document', () => {
    const o = outcomeOf(
      base({
        assets: [
          { id: 'img-shared', sharedWithOtherDocument: true },
          { id: 'img-own', sharedWithOtherDocument: false },
        ],
      }),
    );
    expect(o).toMatchObject({
      run: true,
      keptAssets: ['img-shared'],
      remove: { assets: ['img-own'] },
    });
  });
});

describe('when the purge does not run (HIS-039, HIS-031)', () => {
  it('does not run under a legal hold, even when the retention has passed (criterion 5)', () => {
    expect(outcomeOf(base({ hold: { inForce: true } }))).toEqual({
      run: false,
      reason: 'legal-hold',
    });
  });

  it('runs once the hold is released, with the retention still passed', () => {
    expect(outcomeOf(base({ hold: { inForce: false } })).run).toBe(true);
  });

  it('does not run while the retention period is still running', () => {
    expect(outcomeOf(base({ now: DELETED_AT + 29 * DAY }))).toEqual({
      run: false,
      reason: 'retention-running',
    });
  });

  it('runs exactly when the retention period has passed', () => {
    expect(outcomeOf(base({ now: DELETED_AT + 30 * DAY })).run).toBe(true);
  });

  it('does not run for a document that is not deleted', () => {
    expect(outcomeOf(base({ deletedAt: null }))).toEqual({ run: false, reason: 'not-deleted' });
  });

  it('never runs under a hold, for any retention and time (property)', () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 400 * DAY }),
        fc.integer({ min: 0, max: 400 * DAY }),
        (retentionMs, elapsed) => {
          const o = outcomeOf(
            base({ retentionMs, now: DELETED_AT + elapsed, hold: { inForce: true } }),
          );
          expect(o.run).toBe(false);
        },
      ),
    );
  });
});

describe('refusals', () => {
  it('refuses a negative or fractional retention', () => {
    expect(purgePlan(base({ retentionMs: -1 })).ok).toBe(false);
    expect(purgePlan(base({ retentionMs: 1.5 })).ok).toBe(false);
  });

  it('refuses an asset listed twice', () => {
    const r = purgePlan(
      base({
        assets: [
          { id: 'a', sharedWithOtherDocument: false },
          { id: 'a', sharedWithOtherDocument: true },
        ],
      }),
    );
    expect(r.ok).toBe(false);
  });

  it('refuses an asset with a blank identifier', () => {
    expect(purgePlan(base({ assets: [{ id: ' ', sharedWithOtherDocument: false }] })).ok).toBe(
      false,
    );
  });

  it('refuses a document with no identifier', () => {
    expect(purgePlan(base({ doc: ' ' })).ok).toBe(false);
  });
});
