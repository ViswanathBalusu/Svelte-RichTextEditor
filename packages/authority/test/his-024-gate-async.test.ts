// HIS-024 criterion 1: the gate is one rule. A caller that reads commit times from storage
// (`minVisibleSeqAsync`) and a caller that holds them (`minVisibleSeq`) get the same answer for
// every setting, so no endpoint needs a copy of the `since_access` search.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { HISTORY_VISIBILITIES, minVisibleSeq, minVisibleSeqAsync } from '../src/room/gate.ts';

describe('minVisibleSeqAsync is minVisibleSeq with awaited commit times', () => {
  it('gives the same gate for every setting, head, floor and access time', async () => {
    await fc.assert(
      fc.asyncProperty(
        fc.constantFrom(...HISTORY_VISIBILITIES),
        fc.boolean(),
        fc.array(fc.integer({ min: 0, max: 50 }), { maxLength: 40 }),
        fc.option(fc.integer({ min: -5, max: 2000 }), { nil: undefined }),
        fc.integer({ min: 0, max: 5 }),
        async (setting, edits, steps, accessSince, floor) => {
          // Non-decreasing commit times, one per seq from 1.
          const times: number[] = [];
          let t = 0;
          for (const s of steps) times.push((t += s));
          const head = times.length;
          const timeOf = (seq: number) => times[seq - 1];
          const input = { setting, editsSomewhere: edits, accessSince, head, floor };
          const sync = minVisibleSeq({ ...input, timeOf });
          const asked: number[] = [];
          const awaited = await minVisibleSeqAsync({
            ...input,
            timeOf: async (seq) => {
              asked.push(seq);
              return timeOf(seq);
            },
          });
          expect(awaited).toBe(sync);
          // Storage is asked only for a handful of commits (a binary search), none above the head.
          expect(asked.length).toBeLessThanOrEqual(Math.ceil(Math.log2(head + 2)) + 1);
          for (const seq of asked) expect(seq).toBeLessThanOrEqual(head);
        },
      ),
    );
  });

  it('fails closed at the head without an access time, and asks storage nothing', async () => {
    let asked = 0;
    const gate = await minVisibleSeqAsync({
      setting: 'since_access',
      editsSomewhere: true,
      head: 9,
      timeOf: async () => {
        asked++;
        return 0;
      },
    });
    expect(gate).toBe(9);
    expect(asked).toBe(0);
  });
});
