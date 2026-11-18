// FND-009: the latency, load and fault-injection harness runs against the real service process.
// The workloads here are small: they show that each scenario measures and reports what it says it
// does. The measurements of the story are made with `scripts/load/fnd-009.ts` (see the evidence of
// FND-009), not by this test.
import { connect } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  percentile,
  removeSeed,
  startServiceProcess,
  summarise,
  type ServiceHandle,
} from '../../scripts/load/lib.ts';
import {
  TARGETS,
  ackLatency,
  coldOpen,
  databaseOutage,
  dropConnections,
  killProcess,
  ramp,
} from '../../scripts/load/scenarios.ts';
import { createTestDatabase, postgresUnavailable, settings } from '../support/env.ts';

describe('statistics', () => {
  it('takes nearest-rank percentiles', () => {
    const s = Array.from({ length: 100 }, (_, i) => i + 1);
    expect(percentile(s, 50)).toBe(50);
    expect(percentile(s, 95)).toBe(95);
    expect(percentile(s, 99)).toBe(99);
    expect(percentile([7], 99)).toBe(7);
    expect(percentile([], 50)).toBeNaN();
    expect(summarise([5, 1, 3])).toMatchObject({ n: 3, min: 1, p50: 3, max: 5, mean: 3 });
  });
});

describe('the harness against the service process (memory storage)', () => {
  let svc: ServiceHandle;
  let svcTest: ServiceHandle;
  beforeAll(async () => {
    [svc, svcTest] = await Promise.all([
      startServiceProcess({}),
      startServiceProcess({ testMode: true }),
    ]);
  }, 60_000);
  afterAll(async () => {
    await Promise.all([svc?.stop(), svcTest?.stop()]);
    for (const s of [svc, svcTest]) if (s) await removeSeed(s);
  }, 30_000);

  it('measures commit acknowledgement latency against the targets (criterion 1)', async () => {
    const r = await ackLatency(svc, { writers: 3, commitsPerWriter: 15, warmup: 3 });
    expect(r.failures).toBe(0);
    expect(r.ackMs.n).toBe(45);
    expect(r.ackMs.p50).toBeGreaterThan(0);
    expect(r.target).toEqual({ p50Ms: TARGETS.ackP50Ms, p99Ms: TARGETS.ackP99Ms });
    expect(typeof r.met).toBe('boolean');
  }, 60_000);

  it('measures the cold open of a room for a document under 1 MB (criterion 2)', async () => {
    const r = await coldOpen(svc, { documents: 3, paragraphs: 200 });
    expect(r.failures).toBe(0);
    expect(r.openMs.n).toBe(3);
    expect(r.cdmBytes).toBeGreaterThan(10_000);
    expect(r.cdmBytes).toBeLessThan(TARGETS.coldOpenMaxCdmBytes);
    expect(r.target.p95Ms).toBe(TARGETS.coldOpenP95Ms);
  }, 60_000);

  it('ramps connections and open documents and reports each step (criterion 4)', async () => {
    const r = await ramp(svc, {
      steps: [
        { connections: 20, documents: 5 },
        { connections: 60, documents: 15 },
      ],
      holdMs: 1_000,
      commitIntervalMs: 250,
      connectConcurrency: 20,
    });
    expect(r.steps.map((s) => [s.connections, s.documents])).toEqual([
      [20, 5],
      [60, 15],
    ]);
    for (const s of r.steps) {
      expect(s.connectFailures).toBe(0);
      expect(s.commitsAcked).toBeGreaterThan(0);
      expect(s.openMs.n).toBeGreaterThan(0);
    }
    // The second step has more writers than the first.
    expect(r.steps[1]!.commitsAcked).toBeGreaterThan(r.steps[0]!.commitsAcked);
    expect(r.reachedStage1).toBe(false);
  }, 60_000);

  it('drops connections with commits in flight and loses nothing acknowledged (criterion 5)', async () => {
    const r = await dropConnections(svcTest, { writers: 6, commits: 3 });
    expect(r).toMatchObject({
      socketsDropped: 6,
      resumed: 6,
      inflightResent: 6,
      acknowledgedMissing: 0,
      appliedTwice: 0,
      ok: true,
    });
  }, 60_000);

  it('takes the database away and gets it back without acknowledging a refused commit (criterion 5)', async () => {
    const r = await databaseOutage(svcTest, { outageMs: 300 });
    expect(r).toMatchObject({
      ackedBefore: true,
      ackedDuringOutage: false,
      ackedAfter: true,
      refusedAppliedAnyway: false,
      ok: true,
    });
  }, 60_000);
});

const pgSkip = await postgresUnavailable();
const s3 = settings();
const s3Up = await new Promise<boolean>((resolve) => {
  const sock = connect(
    { host: s3['DOCEDIT_S3_HOST'] ?? '127.0.0.1', port: Number(s3['DOCEDIT_S3_PORT'] ?? 0) },
    () => {
      sock.destroy();
      resolve(true);
    },
  );
  sock.once('error', () => resolve(false));
});
const killSkip =
  pgSkip ?? (s3Up ? null : 'the S3-compatible store of the test environment is down');

describe.skipIf(killSkip !== null)('a killed process (PostgreSQL and the S3 store)', () => {
  it('restarts on the same database with every acknowledged commit and takes writes again (criterion 5)', async () => {
    const db = await createTestDatabase();
    const c = db.serviceConfig;
    await db.service.end();
    const options = {
      databaseUrl: `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`,
      env: Object.fromEntries(Object.entries(s3).filter(([k]) => k.startsWith('DOCEDIT_S3_'))),
    };
    const svc = await startServiceProcess(options);
    let restarted: ServiceHandle | undefined;
    try {
      const r = await killProcess(svc, options, { documents: 3, commits: 5 });
      restarted = r.restarted;
      expect(r.acknowledgedMissing).toBe(0);
      expect(r.writeAgainMs).not.toBeNull();
      expect(r.ok).toBe(true);
    } finally {
      await restarted?.kill().catch(() => {});
      await svc.kill().catch(() => {});
      await removeSeed(svc);
      await db.drop();
    }
  }, 120_000);
});
