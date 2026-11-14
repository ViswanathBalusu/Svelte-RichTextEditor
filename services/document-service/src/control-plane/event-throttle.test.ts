// Debounce of dep.document.changed (05 §7; PRO-072 criterion 2). This tests the debounce module
// on its own. Criterion 2 is not met in the running service: the handlers do not yet route
// events through it, and they emit `{ seq }` without the hash-chain head (PRO-072 Notes).
import { describe, expect, it } from 'vitest';
import type { DepEvent, EventSink } from './events.ts';
import { CHANGE_WINDOW_MS, DocumentChangeDebounce } from './event-throttle.ts';

const DOC = '0190d2a4-7c3e-7b1a-9f00-1234567890ab';
const OTHER_DOC = '0190d2a4-7c3e-7b1a-9f00-ffffffffffff';
const HEAD = 'b'.repeat(64);

class Recorder implements EventSink {
  readonly events: DepEvent[] = [];
  emit(event: DepEvent): void {
    this.events.push(event);
  }
}

function change(seq: number, subject = DOC, tenant = 'acme'): DepEvent {
  return {
    type: 'dep.document.changed.v1',
    tenant,
    subject,
    data: { seq, chainHead: HEAD },
    time: 1_000_000 + seq,
  };
}

describe('PRO-072 criterion 2: at most one dep.document.changed per document per 10 seconds', () => {
  it('raises 100 commits in 10 seconds as one event at once and one at the end of the window', () => {
    const sink = new Recorder();
    const debounce = new DocumentChangeDebounce(sink);
    const start = 1_000_000;
    // One commit every 100 ms: 100 commits between t=0 and t=9.9 s.
    for (let i = 0; i < 100; i++) debounce.offer(change(i), start + i * 100);
    expect(sink.events.map((e) => e.data['seq'])).toEqual([0]);

    debounce.flush(start + CHANGE_WINDOW_MS - 1);
    expect(sink.events).toHaveLength(1);

    debounce.flush(start + CHANGE_WINDOW_MS);
    expect(sink.events.map((e) => e.data['seq'])).toEqual([0, 99]);
    expect(debounce.waiting).toBe(0);
  });

  it('never raises two events of one document less than the window apart', () => {
    let clock = 0;
    const raisedAt: { at: number; seq: number }[] = [];
    const sink: EventSink = {
      emit(e) {
        raisedAt.push({ at: clock, seq: e.data['seq'] as number });
      },
    };
    const debounce = new DocumentChangeDebounce(sink);
    // A long burst: 2000 commits, one every 50 ms, with a flush after each, as a timer would do.
    for (let i = 0; i < 2000; i++) {
      clock = i * 50;
      debounce.offer(change(i), clock);
      debounce.flush(clock);
    }
    clock += CHANGE_WINDOW_MS;
    debounce.flush(clock);
    for (let i = 1; i < raisedAt.length; i++) {
      expect(raisedAt[i]!.at - raisedAt[i - 1]!.at).toBeGreaterThanOrEqual(CHANGE_WINDOW_MS);
    }
    expect(raisedAt.map((r) => r.seq)).toEqual([
      0, 200, 400, 600, 800, 1000, 1200, 1400, 1600, 1800, 1999,
    ]);
  });

  it('carries the seq and the hash-chain head of the latest commit in the window', () => {
    const sink = new Recorder();
    const debounce = new DocumentChangeDebounce(sink);
    debounce.offer(change(1), 0);
    debounce.offer(change(2), 1_000);
    debounce.offer(change(3), 2_000);
    debounce.flush(CHANGE_WINDOW_MS);
    expect(sink.events.at(-1)?.data).toEqual({ seq: 3, chainHead: HEAD });
  });

  it('keeps documents apart, and tenants apart', () => {
    const sink = new Recorder();
    const debounce = new DocumentChangeDebounce(sink);
    debounce.offer(change(1, DOC), 0);
    debounce.offer(change(1, OTHER_DOC), 0);
    debounce.offer(change(1, DOC, 'globex'), 0);
    expect(sink.events).toHaveLength(3);
  });

  it('raises another event type at once, without a window', () => {
    const sink = new Recorder();
    const debounce = new DocumentChangeDebounce(sink);
    const grants: DepEvent = {
      type: 'dep.grants.changed.v1',
      tenant: 'acme',
      subject: DOC,
      data: { rev: 2 },
      time: 0,
    };
    debounce.offer(grants, 0);
    debounce.offer(grants, 1);
    expect(sink.events).toHaveLength(2);
  });

  it('raises a change again at once once its window has passed with nothing pending', () => {
    const sink = new Recorder();
    const debounce = new DocumentChangeDebounce(sink);
    debounce.offer(change(1), 0);
    debounce.offer(change(2), CHANGE_WINDOW_MS);
    expect(sink.events.map((e) => e.data['seq'])).toEqual([1, 2]);
  });

  it('refuses a window that is not positive', () => {
    expect(() => new DocumentChangeDebounce(new Recorder(), 0)).toThrow(RangeError);
  });
});
