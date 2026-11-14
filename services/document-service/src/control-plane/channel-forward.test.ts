/**
 * BE-062 forwarding stream and owner-change bookkeeping (06 §2.1, §6). Runs in Node.js. The lossy
 * link is a seeded simulation: frames are dropped and delayed, so they arrive late and out of order.
 */
import { describe, expect, it } from 'vitest';
import {
  ForwardedChannels,
  ForwardReceiver,
  ForwardSender,
  type ForwardClose,
  type ForwardWire,
} from './channel-forward.ts';

/** A small seeded generator (mulberry32), so every run is the same. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface Flight<T> {
  at: number;
  w: ForwardWire<T>;
}

/** One direction of a lossy link: each frame is dropped with `drop`, else delayed 1..maxDelay+1. */
class LossyLink<T> {
  private inFlight: Flight<T>[] = [];
  now = 0;
  dropped = 0;
  private readonly random: () => number;
  private readonly drop: number;
  private readonly maxDelay: number;
  constructor(random: () => number, drop: number, maxDelay: number) {
    this.random = random;
    this.drop = drop;
    this.maxDelay = maxDelay;
  }

  out = (w: ForwardWire<T>): void => {
    if (this.random() < this.drop) {
      this.dropped += 1;
      return;
    }
    this.inFlight.push({ at: this.now + 1 + Math.floor(this.random() * (this.maxDelay + 1)), w });
  };

  /** Hand over everything due by `now`, in a shuffled order. */
  due(): ForwardWire<T>[] {
    const ready = this.inFlight.filter((f) => f.at <= this.now);
    this.inFlight = this.inFlight.filter((f) => f.at > this.now);
    for (let i = ready.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.random() * (i + 1));
      [ready[i], ready[j]] = [ready[j]!, ready[i]!];
    }
    return ready.map((f) => f.w);
  }
}

interface RunOptions {
  seed: number;
  messages: number;
  drop: number;
  maxDelay: number;
  retain: number;
  repairMs: number;
  maxNacks: number;
  /** Drop every nack on the way back, so the sender never repairs anything. */
  blackholeNacks?: boolean;
  /** Drop the data frame with this sequence number on the forward link, so a gap opens. */
  dropSeq?: number;
}

interface RunResult {
  delivered: Array<{ seq: number; payload: string }>;
  closed: ForwardClose | undefined;
  duplicates: number;
  sent: number;
}

function run(o: RunOptions): RunResult {
  const random = rng(o.seed);
  const forward = new LossyLink<string>(random, o.drop, o.maxDelay);
  const back = new LossyLink<string>(random, o.blackholeNacks ? 1 : o.drop, o.maxDelay);
  const delivered: Array<{ seq: number; payload: string }> = [];
  const sender = new ForwardSender<string>((w) => {
    if (w.k === 'data' && w.seq === o.dropSeq) return;
    forward.out(w);
  }, o.retain);
  let closed: ForwardClose | undefined;
  const recv = new ForwardReceiver<string>(
    back.out,
    (seq, payload) => delivered.push({ seq, payload }),
    (c) => {
      closed = c;
    },
    { repairMs: o.repairMs, maxNacks: o.maxNacks, retryInMs: 500 },
  );

  let sent = 0;
  const limit = 50_000;
  for (let t = 0; t < limit; t += 1) {
    forward.now = t;
    back.now = t;
    if (sent < o.messages) {
      sender.send(`commit-${sent + 1}`);
      sent += 1;
    }
    sender.announce();
    for (const w of forward.due()) recv.receive(w, t);
    recv.tick(t);
    for (const w of back.due()) sender.receive(w);
    if (closed !== undefined) break;
    if (sent === o.messages && delivered.length === o.messages) break;
  }
  return { delivered, closed, duplicates: recv.duplicates, sent };
}

describe('BE-062 forwarding stream', () => {
  it('delivers in order, once each, on a clean link', () => {
    const r = run({
      seed: 1,
      messages: 200,
      drop: 0,
      maxDelay: 0,
      retain: 1000,
      repairMs: 5,
      maxNacks: 5,
    });
    expect(r.closed).toBeUndefined();
    expect(r.duplicates).toBe(0);
    expect(r.delivered.map((d) => d.seq)).toEqual(Array.from({ length: 200 }, (_, i) => i + 1));
    expect(r.delivered.map((d) => d.payload)).toEqual(
      Array.from({ length: 200 }, (_, i) => `commit-${i + 1}`),
    );
  });

  it('misses, duplicates and reorders nothing across 200 seeded lossy and delayed runs', () => {
    for (let seed = 1; seed <= 200; seed += 1) {
      const r = run({
        seed,
        messages: 300,
        drop: 0.3,
        maxDelay: 6,
        retain: 10_000,
        repairMs: 4,
        maxNacks: 60,
      });
      expect(r.closed, `seed ${seed} closed`).toBeUndefined();
      expect(r.sent, `seed ${seed} sent`).toBe(300);
      expect(
        r.delivered.map((d) => d.payload),
        `seed ${seed} order`,
      ).toEqual(Array.from({ length: 300 }, (_, i) => `commit-${i + 1}`));
      expect(
        r.delivered.map((d) => d.seq),
        `seed ${seed} seq`,
      ).toEqual(Array.from({ length: 300 }, (_, i) => i + 1));
    }
  });

  it('closes unavailable with retryInMs when the sender no longer keeps a missing frame', () => {
    // The sender keeps two frames. Frame 1 is lost on the way out and evicted by the time the nack
    // arrives, so the sender answers `gone`.
    const delivered: number[] = [];
    let closed: ForwardClose | undefined;
    const back: ForwardWire<string>[] = [];
    const inbound: ForwardWire<string>[] = [];
    const sender = new ForwardSender<string>((w) => {
      if (w.k === 'data' && w.seq === 1) return;
      inbound.push(w);
    }, 2);
    const receiver = new ForwardReceiver<string>(
      (w) => back.push(w),
      (seq) => delivered.push(seq),
      (c) => {
        closed = c;
      },
      { repairMs: 3, maxNacks: 5, retryInMs: 250 },
    );
    for (let i = 1; i <= 5; i += 1) sender.send(`c${i}`);
    for (const w of inbound.splice(0)) receiver.receive(w, 0);
    expect(delivered).toEqual([]);
    expect(back.map((w) => w.k)).toEqual(['nack']);
    for (const w of back.splice(0)) sender.receive(w);
    for (const w of inbound.splice(0)) receiver.receive(w, 1);
    expect(closed).toEqual({
      code: 'unavailable',
      reason: expect.any(String),
      retryInMs: 250,
    });
    expect(receiver.closed).toEqual(closed);
    // Once closed, nothing more is delivered.
    receiver.receive({ k: 'data', seq: 1, payload: 'late' }, 2);
    expect(delivered).toEqual([]);
  });

  it('closes unavailable when a gap is not repaired within maxNacks requests', () => {
    const r = run({
      seed: 3,
      messages: 20,
      drop: 0,
      maxDelay: 0,
      retain: 10_000,
      repairMs: 2,
      maxNacks: 4,
      blackholeNacks: true,
      dropSeq: 1,
    });
    // Frame 1 is lost on the forward link, so frame 2 opens a gap. Every nack is lost on the way
    // back, so the gap at frame 1 is never repaired and the channel closes. No frame after the gap
    // is delivered.
    expect(r.closed?.code).toBe('unavailable');
    expect(r.closed?.retryInMs).toBe(500);
    expect(r.delivered).toEqual([]);
  });

  it('ignores duplicates of delivered and held frames', () => {
    const seen: string[] = [];
    const out: ForwardWire<string>[] = [];
    const receiver = new ForwardReceiver<string>(
      (w) => out.push(w),
      (_seq, payload) => seen.push(payload),
      () => undefined,
      { repairMs: 5, maxNacks: 3, retryInMs: 100 },
    );
    receiver.receive({ k: 'data', seq: 2, payload: 'b' }, 0);
    receiver.receive({ k: 'data', seq: 2, payload: 'b' }, 0);
    receiver.receive({ k: 'data', seq: 1, payload: 'a' }, 0);
    receiver.receive({ k: 'data', seq: 1, payload: 'a' }, 0);
    expect(seen).toEqual(['a', 'b']);
    expect(receiver.duplicates).toBe(2);
    expect(receiver.closed).toBeUndefined();
  });

  it('repairs a lost last frame, which opens no gap until the sender announces its head', () => {
    const delivered: string[] = [];
    const back: ForwardWire<string>[] = [];
    const inbound: ForwardWire<string>[] = [];
    let lost = false;
    const sender = new ForwardSender<string>((w) => {
      if (w.k === 'data' && w.seq === 2 && !lost) {
        lost = true;
        return;
      }
      inbound.push(w);
    }, 10);
    const receiver = new ForwardReceiver<string>(
      (w) => back.push(w),
      (_seq, payload) => delivered.push(payload),
      () => undefined,
      { repairMs: 3, maxNacks: 5, retryInMs: 100 },
    );
    sender.send('a');
    sender.send('b');
    for (const w of inbound.splice(0)) receiver.receive(w, 0);
    expect(delivered).toEqual(['a']);
    expect(back).toEqual([]);
    sender.announce();
    for (const w of inbound.splice(0)) receiver.receive(w, 1);
    // A head only names the frame; it may still be in flight, so the nack waits for repairMs.
    expect(back).toEqual([]);
    receiver.tick(3);
    expect(back).toEqual([]);
    receiver.tick(4);
    expect(back).toEqual([{ k: 'nack', seq: 2 }]);
    for (const w of back.splice(0)) sender.receive(w);
    for (const w of inbound.splice(0)) receiver.receive(w, 5);
    expect(delivered).toEqual(['a', 'b']);
    expect(receiver.closed).toBeUndefined();
  });

  it('rejects a non-positive retain or retryInMs', () => {
    expect(() => new ForwardSender<string>(() => undefined, 0)).toThrow(RangeError);
    expect(() => new ForwardedChannels(0)).toThrow(RangeError);
  });
});

describe('BE-062 owner change closes forwarded channels', () => {
  it('closes every forwarded channel of a document when its owner changes, and no other', () => {
    const fc = new ForwardedChannels(300);
    fc.open('c1', 'doc-a', 'node-1');
    fc.open('c2', 'doc-a', 'node-1');
    fc.open('c3', 'doc-a', 'node-1');
    fc.open('c4', 'doc-b', 'node-2');
    expect(fc.setOwner('doc-a', 'node-1')).toEqual([]);
    const closed = fc.setOwner('doc-a', 'node-3');
    expect(closed.map((c) => c.channel).sort()).toEqual(['c1', 'c2', 'c3']);
    for (const c of closed) {
      expect(c.close.code).toBe('unavailable');
      expect(c.close.retryInMs).toBe(300);
    }
    expect(fc.count('doc-a')).toBe(0);
    expect(fc.count('doc-b')).toBe(1);
    expect(fc.setOwner('doc-a', 'node-3')).toEqual([]);
  });

  it('forgets a channel that closed on its own', () => {
    const fc = new ForwardedChannels(300);
    fc.open('c1', 'doc-a', 'node-1');
    fc.open('c2', 'doc-a', 'node-1');
    fc.forget('c1', 'doc-a');
    expect(fc.count('doc-a')).toBe(1);
    expect(fc.setOwner('doc-a', 'node-1')).toEqual([]);
    expect(fc.setOwner('doc-a', 'node-2').map((c) => c.channel)).toEqual(['c2']);
  });
});
