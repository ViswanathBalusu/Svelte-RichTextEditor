// FE-107 criterion 7: typing makes the save state flip at every commit; a state is announced only
// when it has held for the settle period and differs from the one last announced (ADR 0376).
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { Announcer, type AnnounceTimers } from '../src/announcer.ts';
import type { SyncState } from '../src/events.ts';
import { manualFrames } from './support.ts';

/** A clock the test moves by hand. */
function clock() {
  let now = 0;
  let next = 1;
  const due = new Map<number, { at: number; run: () => void }>();
  const timers: AnnounceTimers = {
    set(run, ms) {
      const id = next++;
      due.set(id, { at: now + ms, run });
      return id;
    },
    clear(handle) {
      due.delete(handle as number);
    },
  };
  return {
    timers,
    /** Moves time on; timers that fall due run in order. */
    advance(ms: number) {
      const end = now + ms;
      for (;;) {
        const soonest = [...due.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (!soonest || soonest[1].at > end) break;
        due.delete(soonest[0]);
        now = soonest[1].at;
        soonest[1].run();
      }
      now = end;
    },
    pending: () => due.size,
  };
}

const SETTLE = 1000;

function harness(initialSync: SyncState = 'saved') {
  const time = clock();
  const frames = manualFrames();
  const sent: string[] = [];
  const announcer = new Announcer({
    sink: (text) => sent.push(text),
    schedule: frames.schedule,
    resolveUsers: null,
    initialSync,
    settleMs: SETTLE,
    timers: time.timers,
  });
  const run = (ms: number): void => {
    time.advance(ms);
    for (let i = 0; i < 10 && frames.pending() > 0; i++) frames.flush();
  };
  return { announcer, sent, run, time };
}

describe('save state while typing (criterion 7)', () => {
  it('says nothing for commits that start and end in the state the document was in', () => {
    const { announcer, sent, run } = harness();
    for (let i = 0; i < 20; i++) {
      announcer.notify({ kind: 'sync', sync: 'saving' });
      run(120);
      announcer.notify({ kind: 'sync', sync: 'saved' });
      run(120);
    }
    run(5 * SETTLE);
    expect(sent).toEqual([]);
  });

  it('says a save that holds, once, and then the state it ends in, once', () => {
    const { announcer, sent, run } = harness();
    announcer.notify({ kind: 'sync', sync: 'saving' });
    run(SETTLE - 1);
    expect(sent).toEqual([]);
    run(1);
    expect(sent).toEqual(['Saving changes.']);
    announcer.notify({ kind: 'sync', sync: 'saved' });
    run(SETTLE);
    expect(sent).toEqual(['Saving changes.', 'All changes saved.']);
  });

  it('starts the wait again at every change of state', () => {
    const { announcer, sent, run } = harness();
    announcer.notify({ kind: 'sync', sync: 'saving' });
    run(SETTLE - 1);
    announcer.notify({ kind: 'sync', sync: 'unsaved' });
    run(SETTLE - 1);
    expect(sent).toEqual([]);
    run(1);
    expect(sent).toEqual(['Changes are not saved yet.']);
  });

  it('does not repeat the state it last announced', () => {
    const { announcer, sent, run } = harness();
    announcer.notify({ kind: 'sync', sync: 'unsaved' });
    run(SETTLE);
    expect(announcer.notify({ kind: 'sync', sync: 'unsaved' })).toBe(false);
    run(SETTLE);
    expect(sent).toEqual(['Changes are not saved yet.']);
  });

  it('says nothing after it is closed, and leaves no timer behind', () => {
    const { announcer, sent, run, time } = harness();
    announcer.notify({ kind: 'sync', sync: 'saving' });
    announcer.close();
    run(5 * SETTLE);
    expect(sent).toEqual([]);
    expect(time.pending()).toBe(0);
  });

  it('keeps the other notices immediate while a save state waits', () => {
    const { announcer, sent, run } = harness();
    announcer.notify({ kind: 'sync', sync: 'saving' });
    announcer.notify({ kind: 'recovered', count: 2 });
    run(0);
    expect(sent).toEqual(['Edits set aside for recovery: 2.']);
    run(SETTLE);
    expect(sent).toEqual(['Edits set aside for recovery: 2.', 'Saving changes.']);
  });

  it('property: no sentence is said for a run of states that is cut short, and each said state is the last of its run', () => {
    const states = fc.constantFrom<SyncState>('saving', 'saved', 'unsaved', 'readonly');
    fc.assert(
      fc.property(
        fc.array(fc.tuple(states, fc.integer({ min: 0, max: 2 * SETTLE })), { maxLength: 30 }),
        (steps) => {
          const { announcer, sent, run } = harness();
          let last: SyncState = 'saved';
          const expected: SyncState[] = [];
          for (const [state, wait] of steps) {
            announcer.notify({ kind: 'sync', sync: state });
            run(wait);
            // A state is said once it has held for the settle period and is not the last said.
            if (wait >= SETTLE && state !== last) {
              expected.push(state);
              last = state;
            }
          }
          run(SETTLE);
          // The final state also settles if it is not yet said.
          const finalState = steps.length > 0 ? steps[steps.length - 1]![0] : last;
          if (finalState !== last) expected.push(finalState);
          const words: Record<SyncState, string> = {
            saving: 'Saving changes.',
            saved: 'All changes saved.',
            unsaved: 'Changes are not saved yet.',
            readonly: 'This document is read-only.',
          };
          expect(sent).toEqual(expected.map((s) => words[s]));
        },
      ),
      { numRuns: 200 },
    );
  });
});
