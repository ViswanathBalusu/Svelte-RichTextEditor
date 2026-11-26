/**
 * BE-073 criteria 1 and 2, with real processes: a general service process and a process dedicated
 * to one document run over one PostgreSQL database and one Valkey bus; the dedicated process is
 * pinned to one core. A channel opened on the general process for the hot document is served by the
 * dedicated one (the head names it as owner, and it uses a core while the general process does not
 * take the load), and the acknowledgement latency of other documents on the general process stays
 * near its idle figure while writers saturate the hot document.
 *
 * Needs PostgreSQL (infra/test-env.ps1 up) and `DOCEDIT_VALKEY_URL`; skipped, with the reason,
 * otherwise. The bounds are loose on purpose: other jobs share the machine, so a latency figure
 * is a measurement of one run (see the story's Evidence), not a limit.
 */
import os from 'node:os';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { runHotDocument, type HotReport } from '../../scripts/load/be-073.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const valkey = process.env['DOCEDIT_VALKEY_URL'];
const unavailable =
  (await postgresUnavailable()) ?? (valkey ? null : 'DOCEDIT_VALKEY_URL is not set');
if (unavailable) console.warn(`skipped: ${unavailable}`);

describe.skipIf(unavailable !== null)('a hot document in a dedicated process (BE-073)', () => {
  let db: TestDatabase;
  let report: HotReport;
  beforeAll(async () => {
    db = await createTestDatabase();
    const c = db.serviceConfig;
    report = await runHotDocument({
      valkeyUrl: valkey!,
      databaseUrl: `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`,
      seconds: 4,
      others: 6,
      intervalMs: 20,
      hotWriters: 8,
      paragraphs: 300,
    });
    console.info(JSON.stringify(report));
  }, 180_000);
  afterAll(async () => {
    await db?.drop();
  });

  it('serves the hot document in the dedicated process, which takes the epoch like any owner', async () => {
    expect(report.routing.channelOpenedOnGeneral).toBe(true);
    const r = await db.admin.query<{ owner: string; epoch: string }>(
      'select owner, epoch from doc_heads where doc_id = $1',
      [report.ids.hot],
    );
    expect(r.rows[0]).toMatchObject({ owner: 'node-dedicated' });
    expect(Number(r.rows[0]!.epoch)).toBe(1);
  });

  it('runs it on a core of its own when the host allows pinning', () => {
    if (os.availableParallelism() < 3) return;
    expect(report.pinned.dedicated).toHaveLength(1);
    expect(report.pinned.general).not.toContain(report.pinned.dedicated![0]);
    expect(report.pinned.general!.length).toBe(os.availableParallelism() - 1);
  });

  it('uses the dedicated process, not the general one, for the saturating load', () => {
    expect(report.dedicated.hotCommits).toBeGreaterThan(0);
    // A busy room keeps its core most of the time; the general process stays near its idle use.
    expect(report.dedicated.coresUsed.dedicated).toBeGreaterThan(0.5);
    expect(report.dedicated.coresUsed.general!).toBeLessThan(
      1.2 * report.baseline.coresUsed.general! + 0.3,
    );
  });

  it('leaves the acknowledgement latency of other rooms near its idle figure', () => {
    const idle = report.baseline.ackMs;
    const under = report.dedicated.ackMs;
    expect(under.count).toBeGreaterThan(50);
    expect(under.p50).toBeLessThan(Math.max(2 * idle.p50, idle.p50 + 15));
  });
});
