// The save state and connection reporting (FE-007; PRO-087): at most one de-status per frame,
// de-change at most once per interval, and the read-only rule.
import type { Access } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import type { StatusDetail } from '../src/events.ts';
import { ChangeReporter, StatusReporter, connectionOf, mayChange } from '../src/status.ts';
import { manualFrames, settle } from './support.ts';

const access = (caps: string[], scopes: Record<string, string[]>): Access =>
  ({
    rev: 1,
    asOfSeq: 0,
    docRole: 'viewer',
    caps,
    scopes,
    leases: {},
    fill: null,
    restrictions: [],
  }) as Access;

describe('StatusReporter', () => {
  it('raises at most once per frame, only when the value differs from the last one raised', () => {
    const frames = manualFrames();
    const raised: StatusDetail[] = [];
    const r = new StatusReporter(
      (s) => raised.push(s),
      { connection: 'offline', sync: 'saved' },
      frames.schedule,
    );
    r.update({ connection: 'online' });
    r.update({ sync: 'saving' });
    r.update({ sync: 'saved' });
    expect(frames.pending()).toBe(1);
    frames.flush();
    expect(raised).toEqual([{ connection: 'online', sync: 'saved' }]);
    // Back and forth within one frame: nothing to raise.
    r.update({ sync: 'saving' });
    r.update({ sync: 'saved' });
    frames.flush();
    expect(raised).toHaveLength(1);
    // Connection and save state move independently.
    r.update({ connection: 'reconnecting' });
    frames.flush();
    r.update({ sync: 'readonly' });
    frames.flush();
    expect(raised.slice(1)).toEqual([
      { connection: 'reconnecting', sync: 'saved' },
      { connection: 'reconnecting', sync: 'readonly' },
    ]);
    r.close();
    r.update({ connection: 'online' });
    frames.flush();
    expect(raised).toHaveLength(3);
  });
});

describe('ChangeReporter', () => {
  it('raises the latest confirmed seq at most once per interval and never the loaded one', async () => {
    const raised: number[] = [];
    const c = new ChangeReporter((seq) => raised.push(seq), 10, 20);
    c.confirmed(10);
    c.confirmed(9);
    await settle(40);
    expect(raised).toEqual([]);
    for (let s = 11; s <= 30; s++) c.confirmed(s);
    await settle(40);
    c.confirmed(31);
    await settle(40);
    expect(raised).toEqual([30, 31]);
    c.confirmed(32);
    c.close();
    await settle(40);
    expect(raised).toEqual([30, 31]);
  });
});

describe('the read-only rule and the connection', () => {
  it('is read-only only when no scope and no document capability allows a change', () => {
    expect(mayChange(access(['view'], { body: ['view'], defs: ['view'] }))).toBe(false);
    expect(mayChange(access(['view', 'comment'], { body: ['view', 'comment'] }))).toBe(false);
    expect(mayChange(access(['view'], { body: ['view'], 'region:r1': ['view', 'edit'] }))).toBe(
      true,
    );
    expect(mayChange(access(['view'], { body: ['view', 'suggest'] }))).toBe(true);
    expect(mayChange(access(['view', 'fill'], { body: ['view'] }))).toBe(true);
  });

  it('maps channel states to the three connection values of de-status', () => {
    expect(
      ['catching_up', 'live', 'resuming', 'closed'].map((s) => connectionOf(s as never)),
    ).toEqual(['online', 'online', 'reconnecting', 'offline']);
  });
});
