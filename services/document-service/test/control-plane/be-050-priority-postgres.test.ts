// Previews and requested exports on one queue (BE-050; EXP-007), on PostgreSQL, lane U-BE-043-056.
// The in-memory version is src/control-plane/jobs/priority.test.ts, which says the PostgreSQL claim
// rules are run elsewhere; this file runs the same criteria against the real database
// (docedit_claim_job_v2 and docedit_job_depth). Each test gets a database of its own, so the claims
// of one test never see another test's jobs. It skips when PostgreSQL is not up.
import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { EXPORT_KIND, EXPORT_PRIORITIES, PREVIEW_KIND } from '../../src/control-plane/exports.ts';
import { PgJobQueue } from '../../src/control-plane/jobs/pg.ts';
import type { JobRecord } from '../../src/control-plane/jobs/queue.ts';
import { createTestDatabase, postgresUnavailable, type TestDatabase } from '../support/env.ts';

const LEASE = 60_000;
const KINDS = [PREVIEW_KIND, EXPORT_KIND];
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const priorityOf = (kind: string): number => {
  const p = EXPORT_PRIORITIES[kind];
  if (p === undefined) throw new Error(`no priority for ${kind}`);
  return p;
};

const databases: TestDatabase[] = [];

/** A PostgreSQL queue in a database of its own. */
async function fresh() {
  const db = await createTestDatabase();
  databases.push(db);
  const q = new PgJobQueue(db.service);
  return { q, pass: (ms: number) => sleep(ms) };
}

function enqueue(q: PgJobQueue, tenant: string, kind: string) {
  return q.enqueue(tenant, {
    kind,
    doc: randomUUID(),
    payload: {},
    createdBy: 'system',
    priority: priorityOf(kind),
  });
}

const why = await postgresUnavailable();

describe.skipIf(why)('one queue, two kinds, priorities on PostgreSQL (BE-050, EXP-007)', () => {
  afterAll(async () => {
    for (const db of databases) await db.drop();
  });

  it('serves previews before requested exports and lets each kind be claimed on its own (BE-050 criterion 1)', async () => {
    const { q } = await fresh();
    const tenant = randomUUID();
    const exports = [
      await enqueue(q, tenant, EXPORT_KIND),
      await enqueue(q, tenant, EXPORT_KIND),
      await enqueue(q, tenant, EXPORT_KIND),
    ];
    const preview = await enqueue(q, tenant, PREVIEW_KIND);

    const first = await q.claim(KINDS, 'both', LEASE);
    expect(first?.id).toBe(preview.id);
    expect(first?.kind).toBe(PREVIEW_KIND);
    const rest = [
      await q.claim(KINDS, 'both', LEASE),
      await q.claim(KINDS, 'both', LEASE),
      await q.claim(KINDS, 'both', LEASE),
    ];
    expect(rest.map((j) => j?.kind)).toEqual([EXPORT_KIND, EXPORT_KIND, EXPORT_KIND]);
    expect(rest.map((j) => j?.id).sort()).toEqual(exports.map((j) => j.id).sort());
    expect(await q.claim(KINDS, 'both', LEASE)).toBeNull();

    const p2 = await enqueue(q, tenant, PREVIEW_KIND);
    const e2 = await enqueue(q, tenant, EXPORT_KIND);
    expect((await q.claim([EXPORT_KIND], 'exports-only', LEASE))?.id).toBe(e2.id);
    expect(await q.claim([EXPORT_KIND], 'exports-only', LEASE)).toBeNull();
    expect((await q.claim([PREVIEW_KIND], 'previews-only', LEASE))?.id).toBe(p2.id);
  });

  it('starts a preview while a tenant has a backlog of requested exports (BE-050 criterion 2)', async () => {
    const { q } = await fresh();
    const bulk = randomUUID();
    const interactive = randomUUID();
    for (let i = 0; i < 20; i++) await enqueue(q, bulk, EXPORT_KIND);
    const preview = await enqueue(q, interactive, PREVIEW_KIND);

    const claimed = await q.claim(KINDS, 'w', LEASE);
    expect(claimed).toMatchObject({ id: preview.id, tenant: interactive, state: 'running' });
    const depth = await q.depth();
    const queuedExports = depth
      .filter((d) => d.kind === EXPORT_KIND)
      .reduce((n, d) => n + d.queued, 0);
    expect(queuedExports).toBe(20);
  });

  it('keeps a tenant at its limit of running jobs of a kind while other tenants run (BE-050 criterion 3)', async () => {
    const { q } = await fresh();
    const a = randomUUID();
    const b = randomUUID();
    await q.setLimit(a, EXPORT_KIND, 1);
    const aJobs = [await enqueue(q, a, EXPORT_KIND), await enqueue(q, a, EXPORT_KIND)];
    const bJob = await enqueue(q, b, EXPORT_KIND);

    const one = await q.claim(KINDS, 'w1', LEASE);
    const two = await q.claim(KINDS, 'w2', LEASE);
    expect([one?.tenant, two?.tenant].sort()).toEqual([a, b].sort());
    expect(await q.claim(KINDS, 'w3', LEASE)).toBeNull();

    const aRunning = one?.tenant === a ? one : two;
    expect(aRunning).toBeDefined();
    const aWaiting = aJobs.filter((j) => j.id !== aRunning!.id);
    expect(aWaiting).toHaveLength(1);
    expect((await q.get(a, aWaiting[0]!.id))?.state).toBe('queued');
    expect((await q.get(b, bJob.id))?.state).not.toBe('queued');

    expect(await q.complete({ tenant: a, id: aRunning!.id }, aRunning!.lockedBy!, {})).toBe(true);
    const next = await q.claim(KINDS, 'w3', LEASE);
    expect(next).toMatchObject({ id: aWaiting[0]!.id, tenant: a });
  });

  it('applies the default limit to tenants without a limit of their own (EXP-007 criterion 3)', async () => {
    const { q } = await fresh();
    const t = randomUUID();
    await enqueue(q, t, EXPORT_KIND);
    await enqueue(q, t, EXPORT_KIND);
    const opts = { defaultLimit: 1 };
    expect(await q.claim([EXPORT_KIND], 'w1', LEASE, opts)).not.toBeNull();
    expect(await q.claim([EXPORT_KIND], 'w2', LEASE, opts)).toBeNull();
    await q.setLimit(t, EXPORT_KIND, 2);
    expect(await q.claim([EXPORT_KIND], 'w2', LEASE, opts)).not.toBeNull();
  });

  it('lets any stateless worker claim a job whose worker was lost (EXP-007 criterion 4)', async () => {
    const { q, pass } = await fresh();
    const a = randomUUID();
    const b = randomUUID();
    const p = await enqueue(q, a, PREVIEW_KIND);
    const e = await enqueue(q, b, EXPORT_KIND);

    const first = await q.claim(KINDS, 'w1', 50);
    expect(first?.id).toBe(p.id);
    const second = await q.claim(KINDS, 'w2', LEASE);
    expect(second).toMatchObject({ id: e.id, tenant: b, lockedBy: 'w2', attempts: 1 });
    await pass(120);
    const third: JobRecord | null = await q.claim(KINDS, 'w3', LEASE);
    expect(third).toMatchObject({ id: p.id, lockedBy: 'w3', attempts: 2 });
  });

  it('reports queued and running jobs per kind and priority for autoscaling (BE-050 criterion 5)', async () => {
    const { q } = await fresh();
    const t = randomUUID();
    await enqueue(q, t, EXPORT_KIND);
    await enqueue(q, t, EXPORT_KIND);
    await enqueue(q, t, PREVIEW_KIND);
    expect(await q.claim([PREVIEW_KIND], 'w', LEASE)).not.toBeNull();

    const depth = await q.depth();
    expect(depth).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: EXPORT_KIND, queued: 2, running: 0 }),
        expect.objectContaining({ kind: PREVIEW_KIND, queued: 0, running: 1 }),
      ]),
    );
  });
});
