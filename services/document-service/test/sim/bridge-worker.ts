/**
 * The PostgreSQL side of the simulation bridge (SYN-047). It runs in a worker thread with the real
 * stores of src/, so the simulation's synchronous storage calls reach a real database: the test
 * thread posts a request and blocks on a shared flag; this thread performs it, posts the reply on
 * the reply port and raises the flag.
 */
import type { PermissionState, WriteRequest } from '@docedit/authority';
import type pg from 'pg';
import { parentPort, workerData, type MessagePort } from 'node:worker_threads';

interface Init {
  pool: pg.PoolConfig;
  tenant: string;
  signal: SharedArrayBuffer;
  reply: MessagePort;
}

const { pool: config, tenant, signal, reply } = workerData as Init;
const flag = new Int32Array(signal);

function answer(message: unknown): void {
  reply.postMessage(message);
  Atomics.store(flag, 0, 1);
  Atomics.notify(flag, 0);
}

// Loaded dynamically so that a failure to load is reported to the waiting thread, not lost.
const ready = (async () => {
  const s = await import('../../src/index.ts');
  const pool = s.createPool({ ...config, max: 6 });
  const grants = new s.PgGrantStore(pool);
  const logs = new s.PgLogStore(pool, { permissions: (ref) => grants.current(ref) });
  const docs = new s.PgDocumentStore(pool);
  const stats = {
    documents: 0,
    writes: 0,
    byFault: {} as Record<string, number>,
    byOutcome: {} as Record<string, number>,
    claims: 0,
    changes: 0,
    retiredOpsDropped: 0,
    /** Step types of the commits the room asked to store, by stepType. */
    stepTypes: {} as Record<string, number>,
    /** Kinds of the commits stored, by kind. */
    kinds: {} as Record<string, number>,
    writeMs: 0,
  };
  let nodes = 0;
  const ref = (doc: string) => ({ tenant, doc });

  const handlers: Record<string, (args: never) => Promise<unknown>> = {
    async create(args: { perms: PermissionState; requires: string[] }) {
      const rec = await docs.create(tenant, {
        cdmVersion: 1,
        requires: args.requires,
        createdBy: 'sim',
        permissions: args.perms,
      });
      stats.documents++;
      const epoch = await logs.claim(ref(rec.id), `sim-node-${++nodes}`);
      return { doc: rec.id, incarnation: rec.incarnation, epoch };
    },
    async write(args: {
      doc: string;
      req: WriteRequest;
      fault: 'none' | 'fail' | 'unknown-applied' | 'unknown-lost';
      failAt: 'before-insert' | 'before-commit';
    }) {
      const t0 = performance.now();
      const r = await s.appendWithFault(logs, ref(args.doc), args.req, args.fault, args.failAt);
      stats.writeMs += performance.now() - t0;
      stats.writes++;
      const fault = args.fault === 'fail' ? `fail ${args.failAt}` : args.fault;
      stats.byFault[fault] = (stats.byFault[fault] ?? 0) + 1;
      stats.byOutcome[r.status] = (stats.byOutcome[r.status] ?? 0) + 1;
      if (r.status === 'ok')
        for (const c of args.req.commits) {
          stats.kinds[c.kind] = (stats.kinds[c.kind] ?? 0) + 1;
          for (const step of c.steps) {
            const type = String((step as { stepType?: unknown }).stepType);
            stats.stepTypes[type] = (stats.stepTypes[type] ?? 0) + 1;
          }
        }
      return r;
    },
    log: (args: { doc: string }) => logs.read(ref(args.doc)),
    perms: (args: { doc: string }) => grants.current(ref(args.doc)),
    async history(args: { doc: string }) {
      return (await grants.history(ref(args.doc))).map((p) => [p.revision, p] as const);
    },
    async epoch(args: { doc: string }) {
      return (await logs.head(ref(args.doc))).epoch;
    },
    async change(args: { doc: string; desired: Omit<PermissionState, 'revision'> }) {
      const r = ref(args.doc);
      const current = await grants.current(r);
      const retired = new Set(await grants.retired(r));
      const c = s.diffPermissions(current, args.desired);
      // The control plane refuses grants, states and leases on retired regions (BE-010); the
      // simulation's changes are applied without them.
      const before =
        (c.putGrants?.length ?? 0) + (c.setRegionStates?.length ?? 0) + (c.putLeases?.length ?? 0);
      if (c.putGrants) c.putGrants = c.putGrants.filter((g) => !retired.has(g.region));
      if (c.setRegionStates)
        c.setRegionStates = c.setRegionStates.filter((x) => !retired.has(x.region));
      if (c.putLeases) c.putLeases = c.putLeases.filter((l) => !retired.has(l.region));
      stats.retiredOpsDropped +=
        before -
        ((c.putGrants?.length ?? 0) +
          (c.setRegionStates?.length ?? 0) +
          (c.putLeases?.length ?? 0));
      stats.changes++;
      return grants.change(r, c, { actor: 'sim' });
    },
    async claim(args: { doc: string }) {
      stats.claims++;
      return logs.claim(ref(args.doc), `sim-node-${++nodes}`);
    },
    stats: () => Promise.resolve(stats),
    async close() {
      await pool.end();
      return null;
    },
  };
  return handlers;
})();

parentPort!.on('message', (msg: { method: string; args: unknown }) => {
  void (async () => {
    try {
      const handlers = await ready;
      const h = handlers[msg.method];
      if (!h) throw new Error(`bridge: no method ${msg.method}`);
      answer({ ok: true, value: await h(msg.args as never) });
    } catch (e) {
      answer({ ok: false, error: e instanceof Error ? (e.stack ?? e.message) : String(e) });
    }
  })();
});
