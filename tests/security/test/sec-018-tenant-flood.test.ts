/**
 * SEC-018 criterion 2 (10 §3.2 "resource exhaustion", §1 availability; 04 §11, §12; BE-030): a
 * tenant that opens connections and documents up to and beyond its limits is answered
 * `rate_limited`, and a second tenant's commits are acknowledged within the targets BE-058 names
 * (a median of 50 ms and a 99th percentile of 300 ms) while the first tenant floods.
 *
 * The flooding tenant (`a`) has CONNECTIONS connections, one user each. Every connection opens
 * documents on every channel it may have and one more (`channel_limit`), and then all of them send
 * commits as fast as the sockets take them, well past the tenant's message bucket, for as long as
 * the second tenant is being measured. The tenant bucket is set small for this file (a capacity of
 * 300 messages and 100 a second) so that the tenant limit, not the user's or the connection's, is
 * the one that refuses; the other buckets keep their defaults apart from the per-connection close
 * after refusals, which is raised so that the flood goes on instead of being disconnected.
 *
 * The second tenant (`b`) has one editor who sends COMMITS commits one after another, each timed
 * from send to `sync.ack`, first alone (the baseline) and then during the flood. The service and
 * the timed client share one process; the flood runs on its own thread (support/flood-worker.ts),
 * so that its client work is not on the service's event loop. Loopback, memory storage; the
 * figures are for that setting and are printed by the test. Phase 2 quotas (`quota_exceeded`) are not part of this file.
 */
import { Worker } from 'node:worker_threads';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { uuid7 } from '@docedit/model';
import { DEFAULT_RATES } from '../../../services/document-service/src/data-plane/settings.ts';
import { RateLimits } from '../../../services/document-service/src/data-plane/limits.ts';
import {
  documentWithRegions,
  insertText,
  startHarness,
  type Harness,
  type TestTenant,
} from './support/harness.ts';
import { inside, loadDoc } from './support/cdm.ts';
import type { FloodReport } from './support/flood-worker.ts';
import { WireClient } from './support/wire.ts';

const CONNECTIONS = 8;
const CHANNELS = 16;
const COMMITS = 200;
const MEDIAN_TARGET_MS = 50;
const P99_TARGET_MS = 300;
const generous = { capacity: 1_000_000, refillPerSecond: 1_000_000 };

const percentile = (sorted: number[], p: number): number =>
  sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? NaN;

describe('SEC-018 criterion 2: a tenant beyond its limits is refused and another tenant is served', () => {
  let h: Harness;
  beforeAll(async () => {
    // Only the tenant bucket is small: the user's and the connection's are wide, so a refusal
    // here is the tenant limit's. A connection is closed after 50 refusals in a row (the default),
    // and the flood's worker opens it again, so the flood lasts as long as the measurement.
    const rates = {
      ...DEFAULT_RATES,
      connection: generous,
      user: generous,
      tenant: { capacity: 300, refillPerSecond: 100 },
    };
    h = await startHarness('memory', { rateLimits: new RateLimits(rates), dataPlane: { rates } });
  });
  afterAll(async () => {
    await h?.close();
  });

  const startOf = async (tenant: TestTenant, doc: string) => {
    const content = (await h.call('GET', `/v1/documents/${doc}/content`, { token: tenant.apiKey }))
      .json;
    return {
      pos: inside(loadDoc(content.doc), 'pIntro0000000001'),
      seq: content.seq as number,
    };
  };

  /** COMMITS commits by one editor of `tenant`, one after another; the latencies in ms, sorted. */
  async function measure(tenant: TestTenant, sub: string): Promise<number[]> {
    const doc = await h.createDocument(tenant, documentWithRegions());
    const c = await WireClient.connect(h.wsUrl, { origin: tenant.origin });
    try {
      await c.hello(await h.mintToken(tenant, sub, { [doc]: 'editor' }));
      await c.open(1, doc);
      const { pos, seq } = await startOf(tenant, doc);
      const out: number[] = [];
      let base = seq;
      for (let i = 0; i < COMMITS; i++) {
        const t0 = performance.now();
        const r = await c.submit(1, { id: uuid7(), base, steps: [insertText(pos, 'b')] });
        out.push(performance.now() - t0);
        expect(r.t, JSON.stringify(r.d)).toBe('sync.ack');
        base = (r.d as { seq: number }).seq;
      }
      return out.sort((x, y) => x - y);
    } finally {
      c.terminate();
    }
  }

  it('answers the flooding tenant rate_limited and keeps the other tenant within the targets', async () => {
    const baseline = await measure(h.b, 'bea');

    // The flooding tenant: connections, and documents on every channel and one more.
    const docs: string[] = [];
    for (let i = 0; i <= CHANNELS; i++)
      docs.push(await h.createDocument(h.a, documentWithRegions()));
    const grants = Object.fromEntries(docs.map((d) => [d, 'editor']));
    const tokens: string[] = [];
    for (let i = 0; i < CONNECTIONS; i++) tokens.push(await h.mintToken(h.a, `flood-${i}`, grants));
    const { pos, seq } = await startOf(h.a, docs[0]!);

    const worker = new Worker(new URL('./support/flood-worker.ts', import.meta.url), {
      workerData: {
        wsUrl: h.wsUrl,
        origin: h.a.origin,
        tokens,
        docs,
        channels: CHANNELS,
        pos,
        seq,
      },
    });
    const next = <T>(what: string): Promise<T> =>
      new Promise<T>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error(`the flood worker did not post ${what}`)),
          30_000,
        );
        worker.once('message', (m) => {
          clearTimeout(timer);
          resolve(m as T);
        });
        worker.once('error', reject);
        worker.once('exit', (code) =>
          reject(new Error(`the flood worker exited with ${code} before ${what}`)),
        );
      });
    let flood: FloodReport;
    let during: number[];
    try {
      expect(await next<string>('ready')).toBe('ready');
      // Let the flood spend the tenant's burst before the measurement starts.
      await new Promise((resolve) => setTimeout(resolve, 500));
      during = await measure(h.b, 'bea');
      const report = next<FloodReport>('its report');
      worker.postMessage('stop');
      flood = await report;
    } finally {
      await worker.terminate();
    }

    // The flooding tenant: the open beyond the channel limit was refused, and its messages beyond
    // the tenant bucket were answered `rate_limited` with a time to try again.
    for (const code of flood.beyondChannelLimit)
      expect(['channel_limit', 'rate_limited']).toContain(code);
    expect(flood.sent, 'the flood went beyond the tenant bucket').toBeGreaterThan(300 * 5);
    expect(flood.rateLimited, 'rate_limited answers to the flooding tenant').toBeGreaterThan(0);
    expect(flood.allSayRetryAfter).toBe(true);

    // The other tenant, measured: every commit was acknowledged, within the targets.
    const report = {
      baseline: { median: percentile(baseline, 50), p99: percentile(baseline, 99) },
      during: { median: percentile(during, 50), p99: percentile(during, 99) },
      floodMessages: flood.sent,
      rateLimited: flood.rateLimited,
      reconnects: flood.reconnects,
    };
    console.info(`SEC-018 tenant flood: ${JSON.stringify(report)}`);
    expect(during.length).toBe(COMMITS);
    expect(report.during.median, 'median acknowledgement, ms').toBeLessThanOrEqual(
      MEDIAN_TARGET_MS,
    );
    expect(report.during.p99, '99th percentile acknowledgement, ms').toBeLessThanOrEqual(
      P99_TARGET_MS,
    );
  }, 120_000);
});
