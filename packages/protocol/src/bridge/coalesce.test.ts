// SYN-041: coalescing of sync.commit messages on a time window, the unit alone. What the room
// sends through it is tested in services/document-service/test/data-plane/syn-041-coalescing.test.ts.
import { describe, expect, it } from 'vitest';
import { CommitCoalescer, checkWindow } from './coalesce.ts';
import type { DepOutbound } from './room-bridge.ts';

const commit = (channel: string, ...seqs: number[]): DepOutbound => ({
  channel,
  event: { t: 'sync.commit', d: { commits: seqs.map((seq) => ({ seq }) as never) } },
});
const ack = (channel: string, id: string): DepOutbound => ({
  channel,
  event: { t: 'sync.ack', d: { id, seq: 0 } as never },
});
const seqsOf = (out: DepOutbound[]) =>
  out.map((m) =>
    m.event.t === 'sync.commit'
      ? {
          t: m.event.t,
          ch: m.channel,
          seqs: m.event.d.commits.map((c) => (c as { seq: number }).seq),
        }
      : { t: m.event.t, ch: m.channel },
  );

describe('CommitCoalescer (SYN-041)', () => {
  it('holds commits for one window and sends them as one message in ascending seq', () => {
    const c = new CommitCoalescer(40);
    expect(c.push(commit('a', 1), 0, true)).toEqual([]);
    expect(c.push(commit('a', 2), 10, true)).toEqual([]);
    expect(c.push(commit('a', 3, 4), 25, true)).toEqual([]);
    expect(c.nextDue()).toBe(40);
    expect(c.poll(39)).toEqual([]);
    const out = c.poll(40);
    expect(seqsOf(out)).toEqual([{ t: 'sync.commit', ch: 'a', seqs: [1, 2, 3, 4] }]);
    expect(c.nextDue()).toBeUndefined();
  });

  it('starts a new window after the last one ended', () => {
    const c = new CommitCoalescer(30);
    c.push(commit('a', 1), 0, true);
    expect(seqsOf(c.poll(30))).toEqual([{ t: 'sync.commit', ch: 'a', seqs: [1] }]);
    c.push(commit('a', 2), 100, true);
    expect(c.nextDue()).toBe(130);
  });

  it('ends the held message before an acknowledgement, so the order of SYN-015 holds (criterion 2)', () => {
    const c = new CommitCoalescer(50);
    c.push(commit('a', 1, 2), 0, true);
    const out = c.push(ack('a', 'x'), 5, true);
    expect(seqsOf(out)).toEqual([
      { t: 'sync.commit', ch: 'a', seqs: [1, 2] },
      { t: 'sync.ack', ch: 'a' },
    ]);
    expect(c.nextDue()).toBeUndefined();
  });

  it('keeps channels apart: an acknowledgement on one does not end another', () => {
    const c = new CommitCoalescer(50);
    c.push(commit('a', 1), 0, true);
    c.push(commit('b', 1), 0, true);
    expect(seqsOf(c.push(ack('a', 'x'), 5, true))).toEqual([
      { t: 'sync.commit', ch: 'a', seqs: [1] },
      { t: 'sync.ack', ch: 'a' },
    ]);
    expect(seqsOf(c.flush())).toEqual([{ t: 'sync.commit', ch: 'b', seqs: [1] }]);
  });

  it('ends the held message when a commit would not keep seq ascending', () => {
    const c = new CommitCoalescer(50);
    c.push(commit('a', 5), 0, true);
    const out = c.push(commit('a', 3), 1, true);
    expect(seqsOf(out)).toEqual([{ t: 'sync.commit', ch: 'a', seqs: [5] }]);
    expect(seqsOf(c.flush())).toEqual([{ t: 'sync.commit', ch: 'a', seqs: [3] }]);
  });

  it('sends a commit at once when coalescing is off, and ends a held message first', () => {
    const c = new CommitCoalescer(50);
    expect(seqsOf(c.push(commit('a', 1), 0, false))).toEqual([
      { t: 'sync.commit', ch: 'a', seqs: [1] },
    ]);
    c.push(commit('a', 2), 1, true);
    expect(seqsOf(c.push(commit('a', 3), 2, false))).toEqual([
      { t: 'sync.commit', ch: 'a', seqs: [2] },
      { t: 'sync.commit', ch: 'a', seqs: [3] },
    ]);
  });

  it('passes every other message at once, in order', () => {
    const c = new CommitCoalescer(50);
    const other: DepOutbound = { channel: 'a', event: { t: 'ch.closed', d: {} as never } };
    expect(seqsOf(c.push(other, 0, true))).toEqual([{ t: 'ch.closed', ch: 'a' }]);
  });

  it('sends the held messages of several channels in the order they fall due', () => {
    const c = new CommitCoalescer(40);
    c.push(commit('b', 1), 0, true);
    c.push(commit('a', 1), 10, true);
    expect(seqsOf(c.poll(50))).toEqual([
      { t: 'sync.commit', ch: 'b', seqs: [1] },
      { t: 'sync.commit', ch: 'a', seqs: [1] },
    ]);
  });

  it('never delays a held message past its window, even when polled late', () => {
    const c = new CommitCoalescer(30);
    c.push(commit('a', 1), 0, true);
    c.push(commit('a', 2), 29, true);
    expect(seqsOf(c.poll(500))).toEqual([{ t: 'sync.commit', ch: 'a', seqs: [1, 2] }]);
  });

  it('ignores an empty commit list and rejects an unusable window', () => {
    const c = new CommitCoalescer(40);
    expect(c.push(commit('a'), 0, true)).toEqual([]);
    expect(c.nextDue()).toBeUndefined();
    expect(() => checkWindow(0)).toThrow(RangeError);
    expect(() => new CommitCoalescer(Number.NaN)).toThrow(RangeError);
  });
});
