// The document service as one process (BE-001): REST, discovery and the DEP WebSocket of the data
// plane (packet A1) on one server; two channels of a document in one room with no bus; worker
// threads that fail a request alone; readiness that follows the database and its schema.
import { randomUUID } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { afterAll, beforeAll, describe, expect, it, it as itBase } from 'vitest';
import { configFromEnv } from '../../src/config.ts';
import { hashSecret } from '../../src/control-plane/tenants.ts';
import { newApiKey } from '../../src/control-plane/tokens.ts';
import { createPool } from '../../src/storage/db.ts';
import { readiness, startService, type Service } from '../../src/server.ts';
import { startHarness } from '../control-plane/support.ts';
import { documentWithRegions } from '../control-plane/support.ts';
import { DepClient } from '../data-plane/client.ts';
import { createTestDatabase, postgresUnavailable } from '../support/env.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

const pgSkip = await postgresUnavailable();

for (const storage of ['memory', 'postgres'] as const)
  describe(`one process: control plane, discovery and the DEP WebSocket (BE-001 criteria 1, 2; ${storage})`, () => {
    let s: Service;
    let apiKey: string;
    let drop: (() => Promise<void>) | null = null;
    beforeAll(async () => {
      if (storage === 'postgres' && pgSkip) return;
      // The real data plane of packet A1, composed as in production. With PostgreSQL the service
      // connects as the service role to a database migrated by the admin role (BE-011).
      let databaseUrl: string | null = null;
      if (storage === 'postgres') {
        const db = await createTestDatabase();
        const c = db.serviceConfig;
        databaseUrl = `postgres://${c.user}:${c.password}@${c.host}:${c.port}/${c.database}`;
        await db.service.end();
        drop = () => db.drop();
      }
      // Compile workers serve the queue from outside the process: `exports` is announced.
      s = await startService({
        config: { ...configFromEnv({}), port: 0, workers: 1, databaseUrl, externalWorkers: true },
      });
      expect(await s.ready()).toMatchObject({ ready: true });
      const tenant = randomUUID();
      await s.parts.registry.putTenant(tenant, 'one process');
      const key = newApiKey(tenant);
      await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
      apiKey = key.credential;
    });
    afterAll(async () => {
      await s?.close();
      await drop?.();
    });
    const it = storage === 'postgres' && pgSkip ? itBase.skip : itBase;

    const rest = async (method: string, path: string, body?: unknown, token = apiKey) => {
      const res = await fetch(`${s.url}/v1${path}`, {
        method,
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      });
      return { status: res.status, json: (await res.json()) as Json };
    };

    it('serves discovery and REST and hands the ws path to the data plane, minting the tokens it verifies', async () => {
      const discovery = (await (await fetch(`${s.url}/.well-known/dep`)).json()) as {
        ws: string;
        features: string[];
      };
      expect(discovery.features).toEqual(
        expect.arrayContaining(['presence', 'regions', 'exports']),
      );
      const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
        'id'
      ] as string;
      const token = (await rest('POST', '/tokens', { sub: 'ann', docs: { [doc]: 'editor' } })).json[
        'token'
      ] as string;
      const c = await DepClient.connect(discovery.ws);
      try {
        expect((await c.hello(token)).t).toBe('welcome');
        const opened = await c.open(1, doc);
        expect(opened.t).toBe('ch.opened');
        expect(opened.d?.['head']).toBe(0);
      } finally {
        c.close();
      }
    });

    it('puts two channels of one document in one room inside the process (no bus, nothing forwarded)', async () => {
      const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
        'id'
      ] as string;
      const tokenOf = async (sub: string) =>
        (await rest('POST', '/tokens', { sub, docs: { [doc]: 'editor' } })).json['token'] as string;
      const ws = `${s.url.replace('http:', 'ws:')}/dep`;
      const a = await DepClient.connect(ws);
      const b = await DepClient.connect(ws);
      try {
        await a.hello(await tokenOf('ann'));
        await b.hello(await tokenOf('ben'));
        await a.open(1, doc);
        await b.open(1, doc);
        const content = (await rest('GET', `/documents/${doc}/content`)).json;
        let pos = -1;
        cdmSchema()
          .nodeFromJSON(content['doc'])
          .descendants((n, p) => {
            if (n.attrs['id'] === 'pIntro0000000001') pos = p + 1;
            return pos < 0;
          });
        const ack = await a.submit(1, {
          id: uuid7(),
          base: 0,
          steps: [
            {
              stepType: 'replace',
              from: pos,
              to: pos,
              slice: { content: [{ type: 'text', text: 'Z' }] },
            },
          ],
          origin: 'input',
        });
        expect(ack.t).toBe('sync.ack');
        const seen = await b.take(
          (m) => m.t === 'sync.commit',
          5000,
          'the commit of the other channel',
        );
        expect(JSON.stringify(seen.d)).toContain('"Z"');
        // The commit is in the log the control plane reads: content at the head has it.
        const after = await rest('GET', `/documents/${doc}/content`);
        expect(after.json['seq']).toBe(1);
        expect(JSON.stringify(after.json['doc'])).toContain('ZHello');
      } finally {
        a.close();
        b.close();
      }
    });
  });

describe('the control plane tells the rooms (BE-035 criteria 4 to 6; PRO-052 criterion 4; PRO-049 criterion 6)', () => {
  let s: Service;
  let apiKey: string;
  let tenant: string;
  beforeAll(async () => {
    s = await startService({ config: { ...configFromEnv({}), port: 0, workers: 1 } });
    tenant = randomUUID();
    await s.parts.registry.putTenant(tenant, 'rooms');
    const key = newApiKey(tenant);
    await s.parts.registry.addApiKey(tenant, { id: key.id, secretHash: hashSecret(key.secret) });
    apiKey = key.credential;
  });
  afterAll(async () => {
    await s?.close();
  });
  const rest = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
    token = apiKey,
  ) => {
    const res = await fetch(`${s.url}/v1${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...headers },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return {
      status: res.status,
      headers: res.headers,
      json: (text ? JSON.parse(text) : null) as Json,
    };
  };
  const intro = (doc: unknown) => {
    let pos = -1;
    cdmSchema()
      .nodeFromJSON(doc)
      .descendants((n, p) => {
        if (n.attrs['id'] === 'pIntro0000000001') pos = p + 1;
        return pos < 0;
      });
    return pos;
  };
  const typing = (pos: number, text: string) => [
    { stepType: 'replace', from: pos, to: pos, slice: { content: [{ type: 'text', text }] } },
  ];

  it('a grants change reaches connected users as a control commit and perm.changed', async () => {
    const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
      'id'
    ] as string;
    const token = (await rest('POST', '/tokens', { sub: 'cara', docs: { [doc]: 'editor' } })).json[
      'token'
    ] as string;
    const c = await DepClient.connect(`${s.url.replace('http:', 'ws:')}/dep`);
    try {
      await c.hello(token);
      await c.open(1, doc);
      const r = await rest(
        'PATCH',
        `/documents/${doc}/grants`,
        { grants: [{ region: 'rLegal0000000001', principal: 'user:cara', role: 'editor' }] },
        { 'If-Match': '"g1"' },
      );
      expect(r.status).toBe(200);
      const control = await c.take(
        (m) => m.t === 'sync.commit' && JSON.stringify(m.d).includes('"control"'),
        5000,
        'the control commit',
      );
      expect(JSON.stringify(control.d)).toContain('"grants"');
      const changed = await c.take((m) => m.t === 'perm.changed', 5000, 'perm.changed');
      expect(JSON.stringify(changed.d)).toContain('region:rLegal0000000001');
    } finally {
      c.close();
    }
  });

  it('a lock makes commits read_only; a delete closes the channels; the log stores surrogates', async () => {
    const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
      'id'
    ] as string;
    const token = (await rest('POST', '/tokens', { sub: 'dan', docs: { [doc]: 'editor' } })).json[
      'token'
    ] as string;
    const c = await DepClient.connect(`${s.url.replace('http:', 'ws:')}/dep`);
    try {
      await c.hello(token);
      await c.open(1, doc);
      const content = (await rest('GET', `/documents/${doc}/content`)).json;
      expect(
        (await c.submit(1, { base: 0, steps: typing(intro(content['doc']), 'a'), origin: 'input' }))
          .t,
      ).toBe('sync.ack');
      const [stored] = await s.parts.logs.read({ tenant, doc }, 1, 1);
      const dan = (await s.parts.users.resolve(tenant, 'dan')).surrogate;
      expect(stored!.user).toBe(dan);
      const meta = await rest('GET', `/documents/${doc}`);
      expect(
        (
          await rest(
            'PATCH',
            `/documents/${doc}`,
            { state: 'locked' },
            { 'If-Match': meta.headers.get('etag')! },
          )
        ).status,
      ).toBe(200);
      // The state is permission data: the room records it as a control commit, then sends access.
      const control = await c.take(
        (m) => m.t === 'sync.commit' && JSON.stringify(m.d).includes('"control"'),
        5000,
        'the control commit of the lock',
      );
      expect(JSON.stringify(control.d)).toContain('"kind":"control"');
      await c.take((m) => m.t === 'perm.changed', 5000, 'perm.changed after the lock');
      const head = (await rest('GET', `/documents/${doc}/content`)).json['seq'] as number;
      const reject = await c.submit(1, {
        base: head,
        steps: typing(intro(content['doc']), 'b'),
        origin: 'input',
      });
      expect(reject.t).toBe('sync.reject');
      expect(reject.d?.['code']).toBe('read_only');
      expect((await rest('DELETE', `/documents/${doc}`)).status).toBe(204);
      const closed = await c.take((m) => m.t === 'ch.closed', 5000, 'ch.closed after the delete');
      expect(closed.ch).toBe(1);
      // PRO-047 criterion 4 (the open half): a deleted document can no longer be opened.
      const again = await c.open(2, doc);
      expect(again.t).toBe('ch.rejected');
      expect(again.d?.['code']).toBe('not_found');
    } finally {
      c.close();
    }
  });

  it('a client that read content over REST resumes at its seq and receives seq + 1 next; another document is refused', async () => {
    const doc = (await rest('POST', '/documents', { content: documentWithRegions() })).json[
      'id'
    ] as string;
    const other = (await rest('POST', '/documents', {})).json['id'] as string;
    const tokenOf = async (sub: string) =>
      (await rest('POST', '/tokens', { sub, docs: { [doc]: 'editor' } })).json['token'] as string;
    const ws = `${s.url.replace('http:', 'ws:')}/dep`;
    const a = await DepClient.connect(ws);
    const b = await DepClient.connect(ws);
    try {
      const ta = await tokenOf('eve');
      await a.hello(ta);
      await a.open(1, doc);
      const c0 = (await rest('GET', `/documents/${doc}/content`)).json;
      await a.submit(1, { base: 0, steps: typing(intro(c0['doc']), 'q'), origin: 'input' });
      const tb = await tokenOf('fay');
      const read = (await rest('GET', `/documents/${doc}/content`, undefined, {}, tb)).json;
      expect(read['seq']).toBe(1);
      await b.hello(tb);
      const opened = await b.open(1, doc, {
        resume: { seq: read['seq'], incarnation: read['incarnation'], view: read['view'] },
      });
      expect(opened.d?.['catchUp']).toBe('stream');
      await a.submit(1, { base: 1, steps: typing(intro(c0['doc']), 'r'), origin: 'input' });
      const next = await b.take((m) => m.t === 'sync.commit', 5000, 'the next commit');
      expect((next.d?.['commits'] as Array<{ seq: number }>)[0]!.seq).toBe(2);
      // The token covers one document: another is refused on the channel (PRO-011 criterion 4).
      const refused = await b.open(2, other);
      expect(refused.t).toBe('ch.rejected');
      expect(refused.d?.['code']).toBe('forbidden');
    } finally {
      a.close();
      b.close();
    }
  });
});

describe('worker threads (BE-001 criteria 3, 4)', () => {
  it('fails only the request whose worker crashed, with the retryable code internal, and goes on', async () => {
    const h = await startHarness('memory', { allowWorkerCrash: true });
    try {
      const doc = await h.createDocument({ content: documentWithRegions() });
      await expect(h.service.pool.run('crash', null)).rejects.toMatchObject({
        code: 'internal',
        status: 500,
      });
      expect(h.service.pool.replaced).toBe(1);
      // The pool replaced the worker; reads that replay keep working, in a thread of their own.
      const r = await h.call('GET', `/v1/documents/${doc}/content`, { token: h.apiKey });
      expect(r.status).toBe(200);
      // A registry code with retryable "yes" (05 §5.8).
      const { DEP1 } = await import('@docedit/protocol');
      expect(DEP1.errors.find((e) => e.code === 'internal')?.retryable).toBe('yes');
    } finally {
      await h.close();
    }
  });
});

describe('readiness (BE-001 criterion 5)', async () => {
  const skip = await postgresUnavailable();
  it.skipIf(skip)(
    'is ready when the database answers with the schema of the code, and not otherwise',
    async () => {
      const db = await createTestDatabase();
      try {
        expect(await readiness(db.service)).toMatchObject({ ready: true });
        // A schema the code does not know: a newer migration was applied by another version.
        await db.admin.query(
          "INSERT INTO docedit_schema_migrations (version, checksum) VALUES ('9999_future', 'x')",
        );
        const r = await readiness(db.service);
        expect(r).toMatchObject({ ready: false, schema: '9999_future' });
        expect(r.reason).toMatch(/expects/);
        // An unreachable database.
        const dead = createPool({
          host: '127.0.0.1',
          port: 1,
          user: 'x',
          password: 'x',
          database: 'x',
          connectionTimeoutMillis: 500,
        });
        const down = await readiness(dead);
        expect(down.ready).toBe(false);
        expect(down.reason).toMatch(/unreachable/);
        await dead.end();
      } finally {
        await db.drop();
      }
    },
  );

  it('answers /readyz with 200 or 503', async () => {
    const h = await startHarness('memory');
    try {
      const r = await h.call('GET', '/readyz');
      expect(r.status).toBe(200);
      expect(r.json).toEqual({ ready: true });
      expect((await h.call('GET', '/healthz')).json).toEqual({ live: true });
    } finally {
      await h.close();
    }
  });
});
