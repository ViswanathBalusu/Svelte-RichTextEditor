/**
 * BE-058: the stage 1 load test, at a small size against the real service process (memory
 * storage), and the gate. The full-size run is the command `scripts/load/be-058.ts`; its
 * measurements are in `docs/research/2026-11-17-be-058-stage1-load.md`.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Metrics } from '../../src/control-plane/metrics.ts';
import { registerProcessMetrics } from '../../src/control-plane/process-metrics.ts';
import { removeSeed, startServiceProcess, type ServiceHandle } from '../../scripts/load/lib.ts';
import {
  GATE_DEFAULTS,
  STAGE1_DEFAULTS,
  gate,
  metricSamples,
  scrape,
  stage1,
  sumOf,
  type Stage1Result,
} from '../../scripts/load/stage1.ts';

describe('the metrics text', () => {
  it('reads the samples of one family and not those of a longer name', () => {
    const text = [
      '# HELP dep_open_rooms Rooms open on the node',
      '# TYPE dep_open_rooms gauge',
      'dep_open_rooms{node="n1",tenant="a"} 3',
      'dep_open_rooms{node="n1",tenant="b"} 4',
      'dep_open_rooms_total{node="n1"} 99',
      'other 1',
    ].join('\n');
    const s = metricSamples(text, 'dep_open_rooms');
    expect(s).toHaveLength(2);
    expect(s[0]?.labels).toEqual({ node: 'n1', tenant: 'a' });
    expect(sumOf(s)).toBe(7);
    expect(metricSamples(text, 'other')).toEqual([{ labels: {}, value: 1 }]);
  });
});

describe('the process metrics of the service', () => {
  it('reports the event-loop delay quantiles and the memory of the process', async () => {
    const m = new Metrics({ node: 'n1' });
    const p = registerProcessMetrics(m);
    await new Promise((r) => setTimeout(r, 60));
    const text = await m.render();
    p.stop();
    const loop = metricSamples(text, 'docedit_event_loop_delay_seconds');
    expect(loop.map((x) => x.labels['quantile']).sort()).toEqual(['0.5', '0.99', '1']);
    for (const x of loop) expect(x.value).toBeGreaterThanOrEqual(0);
    const rss = metricSamples(text, 'docedit_process_memory_bytes').find(
      (x) => x.labels['kind'] === 'rss',
    );
    expect(rss?.value).toBeGreaterThan(1_000_000);
  });
});

const good: Pick<Stage1Result, 'checks' | 'ackMs' | 'cold' | 'eventLoop'> = {
  checks: {
    gatePhaseReached: true,
    ackMedian: true,
    ackP99: true,
    coldOpenP95: true,
    coldOpenDocumentUnder1MB: true,
    noSlowConsumer: true,
    noEarlyClose: true,
    allCommitsAcknowledged: true,
    allConnected: true,
    roomsReturnToZero: true,
    eventLoopWithinBudget: true,
  },
  ackMs: { n: 100, p50: 10, p95: 30, p99: 80, max: 90, mean: 15 },
  cold: {
    cdmBytes: 680_000,
    openMs: { n: 20, p50: 190, p95: 250, p99: 260, max: 270, mean: 200 },
    failures: 0,
  },
  eventLoop: { budgetP99Ms: 100, p99Ms: 12, maxMs: 40 },
};

describe('the gate', () => {
  it('passes a run equal to its baseline and one inside the tolerance', () => {
    expect(gate(good, good)).toEqual({ ok: true, failures: [] });
    const worse = { ...good, ackMs: { ...good.ackMs, p50: 14, p99: 110 } };
    expect(gate(worse, good, GATE_DEFAULTS).ok).toBe(true);
  });

  it('fails a latency beyond the tolerance and the floor, and names it', () => {
    const worse = { ...good, ackMs: { ...good.ackMs, p99: 200 } };
    const r = gate(worse, good, GATE_DEFAULTS);
    expect(r.ok).toBe(false);
    expect(r.failures).toEqual([expect.stringContaining('ack 99th percentile 200 ms')]);
    const slowOpen = {
      ...good,
      cold: { ...good.cold, openMs: { ...good.cold.openMs, p95: 600 } },
    };
    expect(gate(slowOpen, good).failures).toEqual([expect.stringContaining('cold open')]);
    const loop = { ...good, eventLoop: { ...good.eventLoop, p99Ms: 80 } };
    expect(gate(loop, good).failures).toEqual([expect.stringContaining('event loop')]);
  });

  it('allows a small absolute rise on a tiny baseline (the floor)', () => {
    const tiny = { ...good, ackMs: { ...good.ackMs, p50: 2 } };
    const noisy = { ...good, ackMs: { ...good.ackMs, p50: 9 } };
    expect(gate(noisy, tiny).ok).toBe(true);
    expect(gate(noisy, tiny, { tolerancePct: 50, floorMs: 2 }).ok).toBe(false);
  });

  it('fails on every hard check whatever the baseline says', () => {
    for (const k of [
      'gatePhaseReached',
      'noSlowConsumer',
      'noEarlyClose',
      'allCommitsAcknowledged',
      'allConnected',
      'roomsReturnToZero',
      'eventLoopWithinBudget',
    ] as const) {
      const r = gate({ ...good, checks: { ...good.checks, [k]: false } }, good);
      expect(r.ok, k).toBe(false);
      expect(r.failures).toEqual([`${k} failed`]);
    }
  });

  it('fails a latency that was not measured', () => {
    const none = { ...good, ackMs: { ...good.ackMs, p50: Number.NaN } };
    expect(gate(none, good).failures).toEqual(['ack median was not measured']);
  });
});

describe('the stage 1 scenario (small, memory storage, test mode)', () => {
  let svc: ServiceHandle;
  const token = 'be-058-test-token';
  beforeAll(async () => {
    // Test mode shortens the idle timer of a room to 1 s, so that "the open rooms return to zero"
    // can be seen inside a test. The full-size run does not use test mode.
    svc = await startServiceProcess({ testMode: true, env: { DOCEDIT_METRICS_TOKEN: token } });
  }, 60_000);
  afterAll(async () => {
    await svc?.stop();
    if (svc) await removeSeed(svc);
  }, 30_000);

  it('holds connections, types, opens cold rooms, and sees the rooms go after the clients leave', async () => {
    const r = await stage1(svc, {
      ...STAGE1_DEFAULTS,
      connections: 40,
      documents: 10,
      typistSteps: [4, 8],
      gateTypists: 8,
      commitsPerSecond: 4,
      holdMs: 3000,
      coldDocuments: 2,
      coldParagraphs: 500,
      eventLoopBudgetMs: 500,
      drainWaitMs: 30_000,
      metricsToken: token,
    });
    expect(r.connected).toBe(40);
    expect(r.connectFailures).toBe(0);
    expect(r.atPeak.openRooms).toBeGreaterThanOrEqual(10);
    expect(r.phases.map((p) => p.typists)).toEqual([4, 8]);
    for (const p of r.phases) {
      expect(p.commitsAcked).toBeGreaterThan(20);
      expect(p.unacked).toBe(0);
      expect(p.ackMs.n).toBe(p.commitsAcked);
      expect(p.cold.openMs.n).toBe(2);
      expect(p.cold.failures).toBe(0);
      expect(p.slowConsumerCloses).toBe(0);
      expect(p.closeCodes).toEqual({});
      expect(p.closedEarly).toBe(0);
    }
    expect(r.ackMs).toEqual(r.phases[1]?.ackMs);
    expect(r.saturation).toBeNull();
    expect(r.openRoomsAfterLeave).toBe(0);
    expect(r.roomsGoneMs).not.toBeNull();
    expect(r.eventLoop.p99Ms).toBeGreaterThanOrEqual(0);
    expect(r.serviceRssMiB.atPeak).toBeGreaterThan(10);
    expect(r.checks.noSlowConsumer && r.checks.roomsReturnToZero && r.checks.allConnected).toBe(
      true,
    );
    // The same run is its own baseline.
    expect(gate(r, r).ok).toBe(true);
    // The metrics endpoint answers only with the token.
    expect((await fetch(`${svc.url}/metrics`)).status).toBe(401);
    expect(await scrape(svc, token)).toContain('docedit_event_loop_delay_seconds');
  }, 90_000);

  it('refuses a gate phase that is not a step, and more typists than documents', async () => {
    await expect(
      stage1(svc, { ...STAGE1_DEFAULTS, typistSteps: [10], gateTypists: 20, metricsToken: token }),
    ).rejects.toThrow(/gate phase must be one of/);
    await expect(
      stage1(svc, {
        ...STAGE1_DEFAULTS,
        documents: 5,
        connections: 5,
        typistSteps: [10],
        gateTypists: 10,
        metricsToken: token,
      }),
    ).rejects.toThrow(/typist needs a document/);
  });

  it('refuses fewer connections than documents', async () => {
    await expect(
      stage1(svc, { ...STAGE1_DEFAULTS, connections: 1, documents: 2, metricsToken: token }),
    ).rejects.toThrow(/a connection is needed for each document/);
  });
});
