// Serving previews and requested exports from one queue with priorities and per-tenant limits
// (BE-050; EXP-007; ADR 0054). The in-memory queue is the subject. The PostgreSQL queue runs the
// same claim rules in test/control-plane/queue.test.ts (skipped without a database).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { EXPORT_KIND, EXPORT_PRIORITIES, PREVIEW_KIND } from '../exports.ts';
import { MemoryJobQueue, type JobRecord } from './queue.ts';

const LEASE = 60_000;
const KINDS = [PREVIEW_KIND, EXPORT_KIND];

/** A queue on a clock the test moves. */
function clocked() {
  let t = 1_000_000;
  const q = new MemoryJobQueue(() => t);
  return { q, pass: (ms: number) => void (t += ms) };
}

const priorityOf = (kind: string): number => {
  const p = EXPORT_PRIORITIES[kind];
  if (p === undefined) throw new Error(`no priority for ${kind}`);
  return p;
};

function enqueue(q: MemoryJobQueue, tenant: string, kind: string) {
  return q.enqueue(tenant, {
    kind,
    doc: randomUUID(),
    payload: {},
    createdBy: 'system',
    priority: priorityOf(kind),
  });
}

describe('one queue, two kinds, priorities (BE-050, EXP-007)', () => {
  it('serves previews before requested exports and lets each kind be claimed on its own (BE-050 criterion 1; EXP-007 criterion 1)', async () => {
    const { q } = clocked();
    const tenant = randomUUID();
    const exports = await Promise.all([1, 2, 3].map(() => enqueue(q, tenant, EXPORT_KIND)));
    const preview = await enqueue(q, tenant, PREVIEW_KIND);

    // A worker that serves both kinds takes the preview first, then the exports.
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

    // A worker for exports alone never takes a preview, and a preview worker never takes an export.
    const p2 = await enqueue(q, tenant, PREVIEW_KIND);
    const e2 = await enqueue(q, tenant, EXPORT_KIND);
    expect((await q.claim([EXPORT_KIND], 'exports-only', LEASE))?.id).toBe(e2.id);
    expect(await q.claim([EXPORT_KIND], 'exports-only', LEASE)).toBeNull();
    expect((await q.claim([PREVIEW_KIND], 'previews-only', LEASE))?.id).toBe(p2.id);
  });

  it('starts a preview while a tenant has a backlog of requested exports (BE-050 criterion 2; EXP-007 criterion 2)', async () => {
    const { q } = clocked();
    const bulk = randomUUID();
    const interactive = randomUUID();
    for (let i = 0; i < 20; i++) await enqueue(q, bulk, EXPORT_KIND);
    const preview = await enqueue(q, interactive, PREVIEW_KIND);

    const claimed = await q.claim(KINDS, 'w', LEASE);
    expect(claimed).toMatchObject({ id: preview.id, tenant: interactive, state: 'running' });
    // The export queue is still non-empty after the preview started.
    const depth = await q.depth();
    const queuedExports = depth
      .filter((d) => d.kind === EXPORT_KIND)
      .reduce((n, d) => n + d.queued, 0);
    expect(queuedExports).toBe(20);
  });

  it('keeps a tenant at its limit of running jobs of a kind while other tenants run (BE-050 criterion 3; EXP-007 criterion 3)', async () => {
    const { q } = clocked();
    const a = randomUUID();
    const b = randomUUID();
    await q.setLimit(a, EXPORT_KIND, 1);
    const aJobs = [await enqueue(q, a, EXPORT_KIND), await enqueue(q, a, EXPORT_KIND)];
    const bJob = await enqueue(q, b, EXPORT_KIND);

    const one = await q.claim(KINDS, 'w1', LEASE);
    const two = await q.claim(KINDS, 'w2', LEASE);
    // Both tenants have one job running: A has reached its limit of one, B has none running.
    expect([one?.tenant, two?.tenant].sort()).toEqual([a, b].sort());
    expect(await q.claim(KINDS, 'w3', LEASE)).toBeNull();

    const aRunning = one?.tenant === a ? one : two;
    expect(aRunning).toBeDefined();
    const aWaiting = aJobs.filter((j) => j.id !== aRunning!.id);
    expect(aWaiting).toHaveLength(1);
    expect((await q.get(a, aWaiting[0]!.id))?.state).toBe('queued');
    expect((await q.get(b, bJob.id))?.state).not.toBe('queued');

    // When A's running job ends, A's next job may start.
    expect(await q.complete({ tenant: a, id: aRunning!.id }, aRunning!.lockedBy!, {})).toBe(true);
    const next = await q.claim(KINDS, 'w3', LEASE);
    expect(next).toMatchObject({ id: aWaiting[0]!.id, tenant: a });
  });

  it('applies the default limit to tenants without a limit of their own (EXP-007 criterion 3)', async () => {
    const { q } = clocked();
    const t = randomUUID();
    await enqueue(q, t, EXPORT_KIND);
    await enqueue(q, t, EXPORT_KIND);
    const opts = { defaultLimit: 1 };
    expect(await q.claim([EXPORT_KIND], 'w1', LEASE, opts)).not.toBeNull();
    expect(await q.claim([EXPORT_KIND], 'w2', LEASE, opts)).toBeNull();
    // A limit of the tenant takes precedence over the default.
    await q.setLimit(t, EXPORT_KIND, 2);
    expect(await q.claim([EXPORT_KIND], 'w2', LEASE, opts)).not.toBeNull();
  });

  it('lets any stateless worker claim any ready job, including one whose worker was lost (EXP-007 criterion 4)', async () => {
    const { q, pass } = clocked();
    const a = randomUUID();
    const b = randomUUID();
    const p = await enqueue(q, a, PREVIEW_KIND);
    const e = await enqueue(q, b, EXPORT_KIND);

    // Worker w1 takes the preview; then it is lost (its lease passes without a heartbeat).
    const first = await q.claim(KINDS, 'w1', 50);
    expect(first?.id).toBe(p.id);
    // Worker w2 takes the export; it holds nothing from w1 and runs a different tenant's job.
    const second = await q.claim(KINDS, 'w2', LEASE);
    expect(second).toMatchObject({ id: e.id, tenant: b, lockedBy: 'w2', attempts: 1 });
    // After the lease passes, w3 takes over the lost preview with one more attempt.
    pass(120);
    const third: JobRecord | null = await q.claim(KINDS, 'w3', LEASE);
    expect(third).toMatchObject({ id: p.id, lockedBy: 'w3', attempts: 2 });
  });

  it('reports queued and running jobs per kind and priority for autoscaling (BE-050 criterion 5; the metrics wiring is not built)', async () => {
    const { q } = clocked();
    const t = randomUUID();
    await enqueue(q, t, EXPORT_KIND);
    await enqueue(q, t, EXPORT_KIND);
    await enqueue(q, t, PREVIEW_KIND);
    expect(await q.claim([PREVIEW_KIND], 'w', LEASE)).not.toBeNull();

    expect(await q.depth()).toEqual([
      { kind: EXPORT_KIND, priority: priorityOf(EXPORT_KIND), queued: 2, running: 0 },
      { kind: PREVIEW_KIND, priority: priorityOf(PREVIEW_KIND), queued: 0, running: 1 },
    ]);
  });
});
