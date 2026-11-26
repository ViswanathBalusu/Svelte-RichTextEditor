// UX-082: the audit feed state machine (owner decision 59: polling `GET /audit` with a stated
// cadence). Pages are made up here; the composed service is in
// services/document-service/test/control-plane/ux-082-audit-feed.test.ts.
import { describe, expect, it } from 'vitest';
import {
  AUDIT_FEED_CADENCE_MS,
  AUDIT_FEED_OVERLAP_MS,
  AuditFeed,
  AuditFeedPoller,
  type AuditFeedEvent,
  type FeedTimers,
} from '../src/client/index.ts';

const T0 = Date.UTC(2026, 10, 26, 10);

const ev = (n: number, at: number, document: string | null = 'd1'): AuditFeedEvent => ({
  id: `01900000-0000-7000-8000-${String(n).padStart(12, '0')}`,
  document,
  actor: 'a1',
  kind: 'grants.changed',
  scopes: ['doc'],
  at: new Date(at).toISOString(),
});

describe('AuditFeed', () => {
  it('asks for the start of the trail first, then for a window that overlaps what it has', () => {
    const feed = new AuditFeed({ filter: { kind: 'grants.changed' } });
    expect(feed.query()).toBe('kind=grants.changed&limit=200');
    feed.receive({ items: [ev(1, T0)], nextCursor: null });
    const q = new URLSearchParams(feed.query());
    expect(q.get('kind')).toBe('grants.changed');
    expect(Date.parse(q.get('from')!)).toBe(T0 - AUDIT_FEED_OVERLAP_MS);
    expect(q.get('cursor')).toBeNull();
  });

  it('follows the cursor of a page that is not the last, with the same start', () => {
    const feed = new AuditFeed({ limit: 2 });
    feed.receive({ items: [ev(1, T0)], nextCursor: 'c1' });
    const first = new URLSearchParams(feed.query());
    expect(first.get('cursor')).toBe('c1');
    expect(first.get('from')).toBeNull();
    const more = feed.receive({ items: [ev(2, T0 + 1_000)], nextCursor: null });
    expect(more.more).toBe(false);
    expect(new URLSearchParams(feed.query()).get('cursor')).toBeNull();
  });

  it('delivers each event once, in the order given, across polls', () => {
    const feed = new AuditFeed();
    const a = feed.receive({ items: [ev(1, T0), ev(2, T0 + 10)], nextCursor: null });
    expect(a.events.map((e) => e.id.slice(-1))).toEqual(['1', '2']);
    const b = feed.receive({ items: [ev(2, T0 + 10), ev(3, T0 + 20)], nextCursor: null });
    expect(b.events.map((e) => e.id.slice(-1))).toEqual(['3']);
  });

  it('delivers an event recorded late within the overlap, and forgets ids older than it', () => {
    const feed = new AuditFeed({ overlapMs: 1_000 });
    feed.receive({ items: [ev(1, T0 + 5_000)], nextCursor: null });
    const late = feed.receive({ items: [ev(2, T0 + 4_500), ev(1, T0 + 5_000)], nextCursor: null });
    expect(late.events.map((e) => e.id.slice(-1))).toEqual(['2']);
    feed.receive({ items: [ev(3, T0 + 9_000)], nextCursor: null });
    expect(feed.position().seen.map((s) => s.id.slice(-1))).toEqual(['3']);
  });

  it('resumes from a saved position without a gap and without a duplicate', () => {
    const feed = new AuditFeed();
    feed.receive({ items: [ev(1, T0), ev(2, T0 + 10)], nextCursor: null });
    const saved = JSON.parse(JSON.stringify(feed.position())) as ReturnType<AuditFeed['position']>;
    const resumed = new AuditFeed({ position: saved });
    expect(Date.parse(new URLSearchParams(resumed.query()).get('from')!)).toBe(
      T0 + 10 - AUDIT_FEED_OVERLAP_MS,
    );
    const got = resumed.receive({
      items: [ev(1, T0), ev(2, T0 + 10), ev(3, T0 + 20)],
      nextCursor: null,
    });
    expect(got.events.map((e) => e.id.slice(-1))).toEqual(['3']);
  });

  it('refuses a page size or an overlap that is not a whole number in range', () => {
    expect(() => new AuditFeed({ limit: 0 })).toThrow(RangeError);
    expect(() => new AuditFeed({ limit: 201 })).toThrow(RangeError);
    expect(() => new AuditFeed({ overlapMs: -1 })).toThrow(RangeError);
  });

  it('states its default cadence', () => {
    expect(AUDIT_FEED_CADENCE_MS).toBeGreaterThan(0);
  });
});

describe('AuditFeedPoller', () => {
  /** Timers that run when the test says so. */
  function fakeTimers() {
    const queue: Array<{ fn: () => void; ms: number }> = [];
    const timers: FeedTimers = {
      setTimeout: (fn, ms) => {
        const t = { fn, ms };
        queue.push(t);
        return t;
      },
      clearTimeout: (h) => {
        const i = queue.indexOf(h as (typeof queue)[number]);
        if (i >= 0) queue.splice(i, 1);
      },
    };
    return { timers, queue };
  }

  it('polls at its cadence, sends the credential, and reports a refusal without stopping', async () => {
    const { timers, queue } = fakeTimers();
    const sent: Array<{ url: string; auth: string | undefined }> = [];
    const failures: string[] = [];
    const delivered: string[] = [];
    let status = 403;
    const poller = new AuditFeedPoller({
      baseUrl: 'https://host.example.test/v1',
      credential: 'svc-key',
      cadenceMs: 2_000,
      timers,
      fetch: async (url, init) => {
        sent.push({ url, auth: init.headers['Authorization'] });
        return { status, json: async () => ({ items: [ev(1, T0)], nextCursor: null }) };
      },
      deliver: (events) => void delivered.push(...events.map((e) => e.id.slice(-1))),
      failed: (e) => void failures.push(e.message),
    });
    poller.start();
    await new Promise((r) => setTimeout(r, 0));
    expect(failures).toEqual(['GET /audit answered 403']);
    expect(sent[0]?.auth).toBe('Bearer svc-key');
    expect(sent[0]?.url.startsWith('https://host.example.test/v1/audit?')).toBe(true);
    expect(queue.map((t) => t.ms)).toEqual([2_000]);
    status = 200;
    queue.shift()!.fn();
    await new Promise((r) => setTimeout(r, 0));
    expect(delivered).toEqual(['1']);
    poller.stop();
    expect(queue).toEqual([]);
  });
});
