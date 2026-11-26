// UX-082: a security tool reads the audit trail by polling `GET /audit` (owner decision 59), with
// the feed of `@docedit/protocol/client`. The composed service runs in memory; the feed's `fetch`
// is the real one, over HTTP, with the service key. Events are recorded straight on the trail so
// that their times are known. Test values only.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import {
  AuditFeedPoller,
  type AuditFeedEvent,
  type AuditFeedPosition,
  type FeedTimers,
} from '@docedit/protocol/client';
import { startHarness, type Harness } from './support.ts';

const NOW = Date.now();
const DOC_A = uuid7();
const DOC_B = uuid7();

describe('the audit feed over GET /audit (UX-082)', () => {
  let h: Harness;
  const recorded: string[] = [];

  beforeAll(async () => {
    h = await startHarness('memory');
  });
  afterAll(async () => {
    await h?.close();
  });

  const record = async (doc: string | null, at: number, kind = 'ux082.test'): Promise<string> => {
    const id = uuid7();
    await h.parts.audit!.record([
      { id, tenant: h.tenant, doc, actor: 'actor-1', kind, data: {}, at },
    ]);
    recorded.push(id);
    return id;
  };

  const timers: FeedTimers = { setTimeout: () => null, clearTimeout: () => undefined };
  const poller = (
    credential: string,
    sink: AuditFeedEvent[],
    position: AuditFeedPosition | null = null,
    failures: string[] = [],
  ) =>
    new AuditFeedPoller({
      baseUrl: `${h.base}/v1`,
      credential,
      filter: { kind: 'ux082.test' },
      limit: 3,
      overlapMs: 10_000,
      position,
      timers,
      fetch: (url, init) => fetch(url, init),
      deliver: (events) => void sink.push(...events),
      failed: (e) => void failures.push(e.message),
    });

  it('delivers new events on the next poll, in order for each document, over several pages', async () => {
    const got: AuditFeedEvent[] = [];
    const feed = poller(h.apiKey, got);
    for (let i = 0; i < 4; i++) {
      await record(DOC_A, NOW + i * 10);
      await record(DOC_B, NOW + i * 10 + 5);
    }
    expect(await feed.pollOnce()).toBe(8);
    expect(got).toHaveLength(8);
    for (const doc of [DOC_A, DOC_B]) {
      const times = got.filter((e) => e.document === doc).map((e) => Date.parse(e.at));
      expect(times).toEqual([...times].sort((a, b) => a - b));
    }
    // Nothing new: nothing delivered. Then one new event arrives on the next poll.
    expect(await feed.pollOnce()).toBe(0);
    const fresh = await record(DOC_A, NOW + 1_000);
    expect(await feed.pollOnce()).toBe(1);
    expect(got.at(-1)?.id).toBe(fresh);
  });

  it('resumes from a saved position after a disconnect with no gap and no duplicate, late events included', async () => {
    const before: AuditFeedEvent[] = [];
    const first = poller(h.apiKey, before);
    const base = NOW + 100_000;
    await record(DOC_A, base);
    await record(DOC_B, base + 10);
    await first.pollOnce();
    const saved = JSON.parse(JSON.stringify(first.feed.position())) as AuditFeedPosition;

    // While the consumer is away: events after its newest, and one recorded late with an earlier
    // time (within the overlap).
    const missed = [
      await record(DOC_A, base + 20),
      await record(DOC_B, base + 5),
      await record(DOC_A, base + 30),
      await record(null, base + 40),
    ];
    const after: AuditFeedEvent[] = [];
    const resumed = poller(h.apiKey, after, saved);
    await resumed.pollOnce();
    expect(after.map((e) => e.id).sort()).toEqual([...missed].sort());
    // Each event the first and the second reader saw is identified by the same id.
    const seen = new Set(before.map((e) => e.id));
    expect(after.some((e) => seen.has(e.id))).toBe(false);

    // Between the first reader and the resumed one, every event of this test was delivered once.
    const delivered = [...before, ...after].map((e) => e.id);
    expect(new Set(delivered).size).toBe(delivered.length);
    for (const id of recorded.slice(8)) expect(delivered).toContain(id);
  });

  it('is refused for a user token, and keeps the failure for the host', async () => {
    const got: AuditFeedEvent[] = [];
    const failures: string[] = [];
    const feed = poller(h.userToken({}), got, null, failures);
    expect(await feed.pollOnce()).toBe(0);
    expect(failures).toEqual(['GET /audit answered 403']);
    expect(got).toEqual([]);
  });
});
