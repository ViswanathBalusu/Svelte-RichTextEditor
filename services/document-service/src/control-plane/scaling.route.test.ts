// The scaling parts as the running service uses them, over its HTTP surface (BE-064, BE-065,
// BE-075): read replicas behind the list and pinned content routes, export workers that the
// service's own scaler sizes from the queue, and the cache of version-pinned content in the
// content route. In-memory storage; the replica is the primary's store seen through a lag the test
// sets, so a read the replica cannot answer correctly is visible. Test values only.
import { randomUUID } from 'node:crypto';
import { NOTHING_HIDDEN } from '@docedit/authority';
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { StubDataPlane, documentWithRegions, hostKey } from '../../test/control-plane/support.ts';
import { checkConfig, configFromEnv, type ServiceConfig } from '../config.ts';
import { memoryParts, startService, type Service, type StartOptions } from '../server.ts';
import type { MemoryStore } from '../storage/memory.ts';
import type { DocRef, DocumentStore, LogStore } from '../storage/types.ts';
import type { JobHandler } from './jobs/runner.ts';
import { signJws } from './jwt.ts';
import { hashSecret } from './tenants.ts';
import { newApiKey, signingKey } from './tokens.ts';
import { FULL_VIEWS } from './visibility.ts';

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

/** Polls `fn` until it is true; about four seconds at most. */
async function until(fn: () => boolean | Promise<boolean>, what: string): Promise<void> {
  for (let i = 0; i < 200; i++) {
    if (await fn()) return;
    await sleep(20);
  }
  throw new Error(`not reached in time: ${what}`);
}

interface Tenant {
  id: string;
  /** Two API keys: two callers, so two read-your-writes sessions. */
  apiKeys: [string, string];
  userToken(docs: Record<string, string>): string;
}

interface Running {
  service: Service;
  tenant: Tenant;
  addTenant(): Promise<Tenant>;
  call(
    method: string,
    path: string,
    o?: { token?: string; body?: unknown; headers?: Record<string, string> },
  ): Promise<{ status: number; headers: Headers; text: string; json: any }>; // eslint-disable-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
  createDocument(tenant?: Tenant): Promise<string>;
}

let running: Running | null = null;
afterEach(async () => {
  await running?.service.close();
  running = null;
});

async function start(
  extra: Partial<StartOptions> = {},
  config: Partial<ServiceConfig> = {},
  parts = memoryParts(),
): Promise<Running> {
  const service = await startService({
    config: { ...configFromEnv({}), port: 0, workers: 1, ...config },
    parts,
    signing: signingKey(undefined, 'scaling-test'),
    createDataPlane: () => new StubDataPlane(),
    // No read restrictions unless a test passes its own views (a restricted document is never cached).
    views: FULL_VIEWS,
    ...extra,
  });
  const addTenant = async (): Promise<Tenant> => {
    const id = randomUUID();
    await parts.registry.putTenant(id, 'Test tenant');
    const host = hostKey('EdDSA');
    await parts.registry.addKey(id, { kid: host.kid, use: 'user', alg: host.alg, jwk: host.jwk });
    const keys = [newApiKey(id), newApiKey(id)];
    for (const k of keys)
      await parts.registry.addApiKey(id, { id: k.id, secretHash: hashSecret(k.secret) });
    return {
      id,
      apiKeys: [keys[0]!.credential, keys[1]!.credential],
      userToken: (docs) => {
        const iat = Math.floor(Date.now() / 1000);
        return signJws(
          { alg: host.alg, typ: 'JWT', kid: host.kid },
          {
            iss: 'https://host.example.test',
            aud: service.url,
            iat,
            exp: iat + 600,
            jti: uuid7(),
            tid: id,
            sub: 'alice',
            docs,
          },
          host.privateKey,
        );
      },
    };
  };
  const tenant = await addTenant();
  const call: Running['call'] = async (method, path, o = {}) => {
    const headers: Record<string, string> = { ...(o.headers ?? {}) };
    if (o.token) headers['Authorization'] = `Bearer ${o.token}`;
    let body: string | undefined;
    if (o.body !== undefined) {
      body = JSON.stringify(o.body);
      headers['Content-Type'] = 'application/json';
    }
    const res = await fetch(`${service.url}${path}`, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
    });
    const text = await res.text();
    let json: unknown;
    try {
      json = text ? JSON.parse(text) : undefined;
    } catch {
      // Not JSON.
    }
    return { status: res.status, headers: res.headers, text, json };
  };
  running = {
    service,
    tenant,
    addTenant,
    call,
    async createDocument(t = tenant) {
      const r = await call('POST', '/v1/documents', {
        token: t.apiKeys[0],
        body: { content: documentWithRegions() },
      });
      if (r.status !== 201) throw new Error(`create failed: ${r.status} ${r.text}`);
      return r.json.id as string;
    },
  };
  return running;
}

/**
 * A read replica that has applied, per document, the sequence numbers in `applied` and nothing of a
 * document it is not given: the primary's store seen through that lag.
 */
function laggingReplica(primary: MemoryStore, applied: Map<string, number>) {
  const reached = (ref: DocRef) => applied.get(ref.doc);
  const logs = new Proxy(primary as unknown as LogStore, {
    get(target, p) {
      if (p === 'head')
        return async (ref: DocRef) => {
          const a = reached(ref);
          if (a === undefined) throw new Error('the replica has not applied this document');
          const h = await target.head(ref);
          return { ...h, seq: Math.min(h.seq, a) };
        };
      const v = Reflect.get(target, p) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  const documents = new Proxy(primary as unknown as DocumentStore, {
    get(target, p) {
      if (p === 'get')
        return async (ref: DocRef) => (reached(ref) === undefined ? null : target.get(ref));
      if (p === 'list')
        return async (tenant: string, q: Parameters<DocumentStore['list']>[1]) =>
          (await target.list(tenant, q)).filter((r) => applied.has(r.id));
      const v = Reflect.get(target, p) as unknown;
      return typeof v === 'function' ? v.bind(target) : v;
    },
  });
  return { logs, documents, grants: primary };
}

describe('the read replica is configured from the environment (BE-064)', () => {
  it('reads the replica URL, the sessions kept and the lag sample size, and refuses a replica without sessions', () => {
    const base = { DOCEDIT_DATABASE_URL: 'postgres://primary/db' };
    const c = configFromEnv({
      ...base,
      DOCEDIT_REPLICA_DATABASE_URL: 'postgres://standby/db',
      DOCEDIT_READ_SESSIONS: '50',
      DOCEDIT_READ_LAG_DOCUMENTS: '20',
    });
    expect(c.replicaDatabaseUrl).toBe('postgres://standby/db');
    expect(c.readSessions).toBe(50);
    expect(c.readLagDocuments).toBe(20);
    expect(() => checkConfig(c)).not.toThrow();
    expect(configFromEnv({}).replicaDatabaseUrl).toBeNull();
    expect(() =>
      checkConfig(
        configFromEnv({ ...base, DOCEDIT_REPLICA_DATABASE_URL: 'postgres://standby/db' }),
      ),
    ).toThrow('DOCEDIT_READ_SESSIONS');
    expect(() =>
      checkConfig(configFromEnv({ DOCEDIT_REPLICA_DATABASE_URL: 'x', DOCEDIT_READ_SESSIONS: '5' })),
    ).toThrow('DOCEDIT_DATABASE_URL');
  });
});

describe('read replicas behind the read-only routes (BE-064)', () => {
  async function withReplica() {
    const parts = memoryParts();
    const applied = new Map<string, number>();
    parts.replica = laggingReplica(parts.logs as unknown as MemoryStore, applied);
    const r = await start({ readSessions: 100 }, {}, parts);
    return { ...r, applied, routes: () => r.service.reads!.routes };
  }

  it('answers a pinned read from the primary when the replica lacks the seq, with the right content (criterion 2)', async () => {
    const r = await withReplica();
    const doc = await r.createDocument();
    const reader = r.tenant.userToken({ [doc]: 'editor' });
    const head = await r.call('GET', `/v1/documents/${doc}/content`, { token: reader });
    expect(head.status).toBe(200);

    // The replica has not applied the document: the primary answers.
    const before = r.routes()['behind-pin'] ?? 0;
    const pinned = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: reader });
    expect(pinned.status).toBe(200);
    expect(r.routes()['behind-pin']).toBe(before + 1);
    expect(pinned.json).toEqual(head.json);
    expect(pinned.headers.get('etag')).toBe(head.headers.get('etag'));

    // Once it has, the replica answers the same bytes.
    r.applied.set(doc, 0);
    const replicaBefore = r.routes()['replica'] ?? 0;
    const again = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: reader });
    expect(again.status).toBe(200);
    expect(r.routes()['replica']).toBe(replicaBefore + 1);
    expect(again.text).toBe(pinned.text);

    // A seq above the head is not found, from the primary, never a replica's guess.
    const missing = await r.call('GET', `/v1/documents/${doc}/content?seq=5`, { token: reader });
    expect(missing.status).toBe(404);
  });

  it('answers history reads from the replica when it has the document, and from the primary when it does not (criterion 1)', async () => {
    const r = await withReplica();
    const doc = await r.createDocument();
    const reader = r.tenant.userToken({ [doc]: 'editor' });
    const paths = [
      `/v1/documents/${doc}/history`,
      `/v1/documents/${doc}/diff?fromSeq=0&toSeq=0`,
      `/v1/documents/${doc}/attribution`,
    ];
    // The replica has not applied the document: each read is answered by the primary.
    const first: string[] = [];
    for (const path of paths) {
      const res = await r.call('GET', path, { token: reader });
      expect(res.status, path).toBe(200);
      first.push(res.text);
    }
    expect(r.routes()['replica']).toBeUndefined();
    expect(r.routes()['replica-error'] ?? 0).toBeGreaterThanOrEqual(paths.length);

    // Once the replica has it, the replica answers, with the same bytes.
    r.applied.set(doc, 0);
    for (const [i, path] of paths.entries()) {
      const res = await r.call('GET', path, { token: reader });
      expect(res.status, path).toBe(200);
      expect(res.text, path).toBe(first[i]);
    }
    expect(r.routes()['replica']).toBe(paths.length);

    // A document the caller has no access to is refused the same way, from the primary's answer.
    const other = r.tenant.userToken({ [randomUUID()]: 'editor' });
    const refused = await r.call('GET', paths[0]!, { token: other });
    expect(refused.status).toBe(403);
  });

  it('serves a caller its own writes: from the primary until the replica reaches them (criterion 3)', async () => {
    const r = await withReplica();
    const [writer, other] = r.tenant.apiKeys;
    const doc = await r.createDocument();
    const ids = (res: { json: { items: Array<{ id: string }> } }) =>
      res.json.items.map((i) => i.id);

    // The writer's list waits for its write; another caller's list may lag.
    const mine = await r.call('GET', '/v1/documents', { token: writer });
    expect(mine.status).toBe(200);
    expect(ids(mine)).toContain(doc);
    expect(r.routes()['behind-write']).toBe(1);
    const theirs = await r.call('GET', '/v1/documents', { token: other });
    expect(ids(theirs)).not.toContain(doc);
    expect(r.routes()['replica']).toBe(1);

    // When the replica reaches the write, the writer reads from it as well, and sees the document.
    r.applied.set(doc, 0);
    const later = await r.call('GET', '/v1/documents', { token: writer });
    expect(ids(later)).toContain(doc);
    expect(r.routes()['replica']).toBe(2);

    // A change of metadata has no log position: the writer's pinned reads stay on the primary.
    const meta = await r.call('GET', `/v1/documents/${doc}`, { token: writer });
    const patched = await r.call('PATCH', `/v1/documents/${doc}`, {
      token: writer,
      body: { title: 'Renamed' },
      headers: { 'If-Match': meta.headers.get('etag')! },
    });
    expect(patched.status).toBe(200);
    const behind = r.routes()['behind-write'] ?? 0;
    const own = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: writer });
    expect(own.status).toBe(200);
    expect(r.routes()['behind-write']).toBe(behind + 1);
    const replicaBefore = r.routes()['replica'] ?? 0;
    const others = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: other });
    expect(others.text).toBe(own.text);
    expect(r.routes()['replica']).toBe(replicaBefore + 1);
  });
});

describe('export workers that follow the queue (BE-065)', () => {
  /** Export jobs wait on a gate of their own until the test opens it. */
  function gatedExports() {
    const gates = new Map<string, () => void>();
    const ran: string[] = [];
    let running = 0;
    let most = 0;
    const handler: JobHandler = async (job) => {
      ran.push(job.id);
      running++;
      most = Math.max(most, running);
      try {
        await new Promise<void>((resolve) => gates.set(job.id, resolve));
      } finally {
        running--;
      }
      return { output: null, pages: 0, layout: null, converged: true, log: null, diagnostics: [] };
    };
    return {
      handler,
      ran,
      most: () => most,
      started: (id: string) => gates.has(id),
      open: (id: string) => gates.get(id)?.(),
      openAll: () => {
        for (const g of gates.values()) g();
      },
    };
  }

  const policy = { minWorkers: 1, maxWorkers: 3, jobsPerWorker: 1 };

  async function exportOf(r: Running, doc: string): Promise<string> {
    const token = r.tenant.userToken({ [doc]: 'editor' });
    const res = await r.call('POST', `/v1/documents/${doc}/exports`, {
      token,
      body: { target: 'pdf', options: { profile: 'final' } },
    });
    expect(res.status).toBe(202);
    return res.json.id as string;
  }

  it('adds workers as exports queue up, until the backlog drains, and keeps the warm floor (criteria 1 and 2)', async () => {
    const g = gatedExports();
    const r = await start(
      { jobHandlers: { export: g.handler }, exportScaling: { policy, tickMs: 20 } },
      { jobIdleMs: 20 },
    );
    const pool = r.service.exportWorkers!;
    expect(r.service.runner).toBeNull();
    // An empty queue: the floor is up.
    await until(() => pool.size === 1, 'the warm floor');

    const docs = [await r.createDocument(), await r.createDocument(), await r.createDocument()];
    const jobs: string[] = [];
    for (const d of docs) jobs.push(await exportOf(r, d));
    await until(() => pool.size === 3, 'three workers for three exports');
    await until(() => jobs.every(g.started), 'every export running at once');

    g.openAll();
    for (const id of jobs)
      await until(
        async () => (await r.service.parts.queue.get(r.tenant.id, id))?.state === 'completed',
        `export ${id} completed`,
      );
    await until(() => pool.size === 1, 'back to the floor once drained');
    // The floor holds over further readings of an empty queue.
    await sleep(100);
    expect(pool.size).toBe(1);
  });

  it('lets a removed worker finish the job it runs (criterion 3)', async () => {
    const g = gatedExports();
    const r = await start(
      { jobHandlers: { export: g.handler }, exportScaling: { policy, tickMs: 20 } },
      { jobIdleMs: 20 },
    );
    const doc = await r.createDocument();
    const id = await exportOf(r, doc);
    await until(() => g.started(id), 'the export running');

    // Closing the service removes every worker; it waits for the running export.
    let closed = false;
    const closing = r.service.close().then(() => (closed = true));
    await sleep(100);
    expect(closed).toBe(false);
    g.open(id);
    await closing;
    expect((await r.service.parts.queue.get(r.tenant.id, id))?.state).toBe('completed');
    expect(g.ran.filter((j) => j === id)).toHaveLength(1);
    running = null;
  });

  it('keeps tenant limits and priorities while the pool scales (criterion 4)', async () => {
    const g = gatedExports();
    const r = await start(
      { jobHandlers: { export: g.handler }, exportScaling: { policy, tickMs: 20 } },
      { jobIdleMs: 20, exportTenantConcurrency: 1 },
    );
    const pool = r.service.exportWorkers!;
    // Three exports of one tenant with a limit of one: three workers, one running at a time.
    const docs = [await r.createDocument(), await r.createDocument(), await r.createDocument()];
    const jobs: string[] = [];
    for (const d of docs) jobs.push(await exportOf(r, d));
    await until(() => pool.size === 3, 'three workers');
    await sleep(100);
    expect(jobs.filter(g.started)).toHaveLength(1);
    // Another tenant's export runs beside it.
    const other = await r.addTenant();
    const otherDoc = await r.createDocument(other);
    const otherJob = (
      await r.call('POST', `/v1/documents/${otherDoc}/exports`, {
        token: other.userToken({ [otherDoc]: 'editor' }),
        body: { target: 'pdf', options: { profile: 'final' } },
      })
    ).json.id as string;
    await until(() => g.started(otherJob), "the other tenant's export running");
    for (let i = 0; i < 3; i++) {
      g.openAll();
      await sleep(60);
    }
    for (const id of jobs)
      await until(
        async () => (await r.service.parts.queue.get(r.tenant.id, id))?.state === 'completed',
        `export ${id} completed`,
      );
    expect(g.most()).toBe(2);

    // Priorities: with every worker busy, the higher priority job is claimed first.
    const q = r.service.parts.queue;
    const hold = await q.enqueue(r.tenant.id, { kind: 'export', payload: {}, createdBy: 'system' });
    const holdB = await q.enqueue(other.id, { kind: 'export', payload: {}, createdBy: 'system' });
    await until(() => g.started(hold.id) && g.started(holdB.id), 'the holding jobs running');
    const low = await q.enqueue(other.id, {
      kind: 'export',
      payload: {},
      createdBy: 'system',
      priority: 0,
    });
    const high = await q.enqueue(other.id, {
      kind: 'export',
      payload: {},
      createdBy: 'system',
      priority: 5,
    });
    await until(() => g.started(holdB.id), 'held');
    g.open(holdB.id);
    await until(() => g.started(high.id) || g.started(low.id), 'the next job claimed');
    expect(g.started(high.id)).toBe(true);
    g.openAll();
    await until(() => g.started(low.id), 'the low priority job claimed');
    g.openAll();
  });
});

describe('version-pinned content cached in the content route (BE-075)', () => {
  it('stores pinned reads only, under the tenant, and serves the same bytes (criterion 2)', async () => {
    const r = await start({ pinnedCache: { enabled: () => true, maxEntries: 10 } });
    const cache = r.service.pinnedCache!;
    const doc = await r.createDocument();
    const reader = r.tenant.userToken({ [doc]: 'editor' });

    const head = await r.call('GET', `/v1/documents/${doc}/content`, { token: reader });
    expect(head.status).toBe(200);
    expect(cache.entries(r.tenant.id)).toBe(0);

    const first = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: reader });
    expect(first.status).toBe(200);
    expect(cache.entries(r.tenant.id)).toBe(1);
    const second = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: reader });
    expect(cache.stats.hits).toBe(1);
    expect(second.text).toBe(first.text);
    expect(second.headers.get('etag')).toBe(first.headers.get('etag'));
    expect(second.headers.get('etag')).toBe(head.headers.get('etag'));
    const unchanged = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, {
      token: reader,
      headers: { 'If-None-Match': first.headers.get('etag')! },
    });
    expect(unchanged.status).toBe(304);

    // Another tenant's copies are its own.
    const other = await r.addTenant();
    const theirs = await r.createDocument(other);
    const read = await r.call('GET', `/v1/documents/${theirs}/content?seq=0`, {
      token: other.userToken({ [theirs]: 'editor' }),
    });
    expect(read.status).toBe(200);
    expect(cache.entries(other.id)).toBe(1);
    expect(cache.entries(r.tenant.id)).toBe(1);
  });

  it('runs the permission check before a copy is served (criterion 3)', async () => {
    const r = await start({ pinnedCache: { enabled: () => true, maxEntries: 10 } });
    const cache = r.service.pinnedCache!;
    const doc = await r.createDocument();
    const ok = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, {
      token: r.tenant.userToken({ [doc]: 'editor' }),
    });
    expect(ok.status).toBe(200);
    expect(cache.entries(r.tenant.id)).toBe(1);

    // A user without a role on the document is refused although a copy is held.
    const stranger = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, {
      token: r.tenant.userToken({ [uuid7()]: 'editor' }),
    });
    expect(stranger.status).toBe(403);
    // Another tenant does not see the document at all.
    const other = await r.addTenant();
    const foreign = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, {
      token: other.apiKeys[0],
    });
    expect(foreign.status).toBe(404);
    // A deleted document is not served from its copy.
    const deleted = await r.call('DELETE', `/v1/documents/${doc}`, { token: r.tenant.apiKeys[0] });
    expect(deleted.status).toBe(204);
    const gone = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, {
      token: r.tenant.userToken({ [doc]: 'editor' }),
    });
    expect(gone.status).toBe(404);
    expect(cache.stats.hits).toBe(0);
    expect(cache.stats.refused).toBe(3);

    // Under read restrictions nothing is cached (SR-C4).
    await r.service.close();
    const restricted = await start({
      pinnedCache: { enabled: () => true, maxEntries: 10 },
      views: { ...FULL_VIEWS, visibility: () => NOTHING_HIDDEN },
    });
    const rdoc = await restricted.createDocument();
    const rread = await restricted.call('GET', `/v1/documents/${rdoc}/content?seq=0`, {
      token: restricted.tenant.userToken({ [rdoc]: 'editor' }),
    });
    expect(rread.status).toBe(200);
    expect(restricted.service.pinnedCache!.entries(restricted.tenant.id)).toBe(0);
  });

  it('reads from home and stores nothing for a tenant that switched caching off (criterion 4)', async () => {
    const off = new Set<string>();
    const r = await start({
      pinnedCache: { enabled: (t) => !off.has(t), maxEntries: 10 },
    });
    const cache = r.service.pinnedCache!;
    const doc = await r.createDocument();
    const reader = r.tenant.userToken({ [doc]: 'editor' });
    const cached = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: reader });
    expect(cache.entries(r.tenant.id)).toBe(1);

    off.add(r.tenant.id);
    const homeReads = cache.stats.homeReads;
    const stored = cache.stats.stored;
    const home = await r.call('GET', `/v1/documents/${doc}/content?seq=0`, { token: reader });
    expect(home.status).toBe(200);
    expect(home.text).toBe(cached.text);
    expect(cache.stats.homeReads).toBe(homeReads + 1);
    expect(cache.stats.stored).toBe(stored);
    expect(cache.stats.hits).toBe(0);
    expect(cache.entries(r.tenant.id)).toBe(0);
  });
});
