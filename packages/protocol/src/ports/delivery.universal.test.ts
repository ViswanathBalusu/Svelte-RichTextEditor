// Ordered delivery of a channel's callbacks (decision D21), shared by every backend.
import { describe, expect, it } from 'vitest';
import { OrderedDelivery } from './delivery.ts';

const turn = () => new Promise<void>((r) => setTimeout(r, 0));

describe('OrderedDelivery', () => {
  it('never calls a callback synchronously', async () => {
    const d = new OrderedDelivery();
    const seen: unknown[] = [];
    d.push('a', 1);
    d.subscribe('a', (v) => seen.push(v));
    d.push('a', 2);
    expect(seen).toEqual([]);
    await turn();
    expect(seen).toEqual([1, 2]);
  });

  it('delivers in push order across kinds when callbacks are registered together', async () => {
    const d = new OrderedDelivery();
    const seen: string[] = [];
    d.push('commits', 'c1');
    d.push('access', 'a1');
    d.push('commits', 'c2');
    d.subscribe('commits', (v) => seen.push(String(v)));
    d.subscribe('access', (v) => seen.push(String(v)));
    await turn();
    expect(seen).toEqual(['c1', 'a1', 'c2']);
  });

  it('keeps messages of a kind without subscriber for the first one, in order', async () => {
    const d = new OrderedDelivery();
    const first: unknown[] = [];
    const later: unknown[] = [];
    d.subscribe('state', (v) => first.push(v));
    d.push('event', 'e1');
    d.push('state', 's1');
    d.push('event', 'e2');
    await turn();
    expect(first).toEqual(['s1']);
    d.subscribe('event', (v) => later.push(v));
    await turn();
    expect(later).toEqual(['e1', 'e2']);
  });

  it('lets code that awaits a settled promise run before the next message', async () => {
    const d = new OrderedDelivery();
    const log: string[] = [];
    d.subscribe('commits', (v) => log.push(`commit ${String(v)}`));
    let resolve!: (v: string) => void;
    const ack = new Promise<string>((r) => (resolve = r));
    const awaited = (async () => {
      const v = await ack;
      log.push(`after await ${v}`);
    })();
    d.push('commits', 1);
    d.settle(() => resolve('ack 2'));
    d.push('commits', 3);
    await awaited;
    await turn();
    expect(log).toEqual(['commit 1', 'after await ack 2', 'commit 3']);
  });

  it('on end with drop discards queued messages but runs settlements and delivers the last item', async () => {
    const d = new OrderedDelivery();
    const seen: unknown[] = [];
    let settled = false;
    d.subscribe('x', (v) => seen.push(v));
    d.push('x', 'dropped');
    d.settle(() => (settled = true));
    d.end({ drop: true, last: { kind: 'x', value: 'closed' } });
    d.push('x', 'ignored');
    await turn();
    expect(settled).toBe(true);
    expect(seen).toEqual(['closed']);
    expect(d.isEnded).toBe(true);
  });

  it('unsubscribes once, and reports a throwing callback without stopping the others', async () => {
    const errors: unknown[] = [];
    const d = new OrderedDelivery({ onError: (e) => errors.push(e) });
    const seen: unknown[] = [];
    const off = d.subscribe('x', (v) => seen.push(v));
    d.subscribe('y', () => {
      throw new Error('boom');
    });
    d.subscribe('y', (v) => seen.push(v));
    d.push('y', 'y1');
    await turn();
    off();
    off();
    d.push('x', 'after off');
    await turn();
    expect(seen).toEqual(['y1']);
    expect(errors).toHaveLength(1);
  });
});
