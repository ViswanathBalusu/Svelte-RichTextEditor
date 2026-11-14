// backend-dep against the reference document service (PRO-093, PRO-094; PRO-098 first version; S6
// report §7): the real service started in process on memory storage, its control plane called with
// a service credential as a host would (05 §11 bootstrap contract), and every backend a DepBackend
// over the platform's WebSocket and fetch. The same contract and smoke suites as against
// backend-mock. Cases that need a route the service does not serve yet are listed in PENDING with
// the reason, and reported as skipped.
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  coreSmoke,
  portContract,
  type ContractCase,
  type ContractHarness,
  type ContractUser,
  type HarnessFactory,
} from '@docedit/protocol/contract';
import type { DocRole } from '@docedit/protocol';
import {
  configFromEnv,
  hashSecret,
  newApiKey,
  startService,
  type Service,
} from '@docedit/document-service';
import { createDepBackend, type DepBackend } from '../src/index.ts';
import { IDS, contractDocument, insertText, posIn } from './support/fixtures.ts';
import { sleep } from './support/harness.ts';

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- response bodies of many shapes
type Json = Record<string, any>;

// Why a case cannot pass against the service today. None is a fault of backend-dep: each was
// traced to the service or to a case written before the service's choices (2026-11-06).
const SURROGATE =
  'the service sends the per-tenant surrogate, not the token sub, as the user identifier (G11)';
const LATE_CONTROL =
  'a grants change made before any room is open is recorded as a control commit only after the next room stores its first commit, which shifts the seqs the case counts (room-host initialRevision)';
const VIEW =
  'the case resumes without a view token, which the service answers with a reload even for the full view (G101; ADR 0019)';

/** Cases that need what the service does not offer yet, with the reason (reported as skipped). */
export const PENDING: Readonly<Record<string, string>> = {
  'backend.connect': SURROGATE,
  'channel.onCommits': SURROGATE,
  'presence.peers': SURROGATE,
  'sync.open.reload': LATE_CONTROL,
  'channel.onAccess': LATE_CONTROL,
  'channel.submit.ack': LATE_CONTROL,
  'channel.submit.rebased': LATE_CONTROL,
  'channel.reject.rebase': LATE_CONTROL,
  'core.conversation': LATE_CONTROL,
  'core.convergence': LATE_CONTROL,
  'sync.open.stream': VIEW,
  'sync.open.inflight': VIEW,
  'channel.readOnly': 'a change of document state sends no event document.updated (05 §5.6)',
  'channel.onReset': 'PUT /documents/{id}/content is not served yet',
  'core.reset': 'PUT /documents/{id}/content is not served yet',
};

interface ServiceHarness {
  service: Service;
  harness: ContractHarness;
  /** `POST /tokens` with the service credential: a user token as a host mints it (05 §3.1). */
  token(user: ContractUser, docs: Readonly<Record<string, DocRole>>): Promise<string>;
}

// Ports at or above 1024 that fetch refuses ("bad port", Fetch standard, port blocking). Port 0 lets the
// system choose, and a system whose dynamic range starts at 1024 (the Windows default on some
// machines) can hand out one of them, which makes every fetch to the service fail.
const FETCH_BAD_PORTS: ReadonlySet<number> = new Set([
  1719, 1720, 1723, 2049, 3659, 4045, 4190, 5060, 5061, 6000, 6566, 6665, 6666, 6667, 6668, 6669,
  6679, 6697, 10080,
]);

/** Starts the service on a port the system chooses, again while that port is one fetch refuses. */
async function startOnFetchablePort(): Promise<Service> {
  for (;;) {
    const service = await startService({ config: { ...configFromEnv({}), port: 0, workers: 1 } });
    if (!FETCH_BAD_PORTS.has(Number(new URL(service.url).port))) return service;
    await service.close();
  }
}

async function startServiceHarness(): Promise<ServiceHarness> {
  const service = await startOnFetchablePort();
  const tenant = randomUUID();
  await service.parts.registry.putTenant(tenant, 'backend-dep contract');
  const key = newApiKey(tenant);
  await service.parts.registry.addApiKey(tenant, {
    id: key.id,
    secretHash: hashSecret(key.secret),
  });
  const credential = key.credential;
  const rest = async (
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ) => {
    const res = await fetch(`${service.url}/v1${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${credential}`,
        'Content-Type': 'application/json',
        ...headers,
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    const json = (text ? JSON.parse(text) : null) as Json;
    if (res.status >= 300) throw new Error(`${method} ${path}: ${res.status} ${text}`);
    return { status: res.status, etag: res.headers.get('etag'), json };
  };
  const backends: DepBackend[] = [];
  const setGrants = async (docId: string, grants: readonly unknown[]) => {
    const g = await rest('GET', `/documents/${docId}/grants`);
    await rest('PATCH', `/documents/${docId}/grants`, { grants }, { 'If-Match': g.etag! });
  };
  const token = async (user: ContractUser, docs: Readonly<Record<string, DocRole>>) =>
    (
      await rest('POST', '/tokens', {
        sub: user.sub,
        docs,
        ...(user.name !== undefined ? { name: user.name } : {}),
        ...(user.groups !== undefined ? { grp: [...user.groups] } : {}),
      })
    ).json['token'] as string;
  const harness: ContractHarness = {
    createDocument: async (content, o) => {
      const id = (await rest('POST', '/documents', { content })).json['id'] as string;
      if (o?.grants?.length) await setGrants(id, o.grants);
      return id;
    },
    backend: async (user, docs) => {
      const b = createDepBackend({
        endpoint: service.url,
        getToken: () => token(user, docs),
        platform: { random: () => 0 },
      });
      backends.push(b);
      return b;
    },
    setGrants,
    replaceContent: async (docId, content) => {
      const c = await rest('GET', `/documents/${docId}/content`);
      await rest('PUT', `/documents/${docId}/content`, content, { 'If-Match': c.etag! });
    },
    setDocumentState: async (docId, state) => {
      const d = await rest('GET', `/documents/${docId}`);
      await rest('PATCH', `/documents/${docId}`, { state }, { 'If-Match': d.etag! });
    },
    revokeSessions: async (sub) => {
      await rest('POST', '/sessions/revoke', { sub });
    },
    dispose: async () => {
      for (const b of backends) await b.close();
      await service.close();
    },
  };
  return { service, harness, token };
}

const factory: HarnessFactory = async () => (await startServiceHarness()).harness;

const register = (cases: readonly ContractCase[]) => {
  for (const k of cases) {
    const pending = PENDING[k.id];
    if (pending) it.skip(`${k.id}: ${k.title} (pending: ${pending})`, () => {});
    else it(`${k.id}: ${k.title}`, (ctx) => k.run({ skip: (reason) => ctx.skip(reason) }));
  }
};

describe('backend-dep against the document service: port contract', () => {
  register(portContract(factory, { sleep, timeoutMs: 8000 }));
});

describe('backend-dep against the document service: smoke suite for the core profile', () => {
  register(coreSmoke(factory, { sleep, timeoutMs: 8000 }));
});

/** A raw DEP socket to the service, after `hello` and `welcome`. */
async function wire(
  run: (w: {
    docId: string;
    discovery: { ws: string; rest: string; features: string[] };
    ws: WebSocket;
    inbox: Array<Record<string, unknown>>;
    send(m: unknown): void;
    reply(re: string): Promise<Record<string, unknown>>;
  }) => Promise<void>,
): Promise<void> {
  const { service, harness, token } = await startServiceHarness();
  let ws: WebSocket | null = null;
  try {
    const docId = await harness.createDocument(contractDocument());
    const discovery = (await (await fetch(`${service.url}/.well-known/dep`)).json()) as {
      ws: string;
      rest: string;
      features: string[];
    };
    const inbox: Array<Record<string, unknown>> = [];
    const socket = new WebSocket(discovery.ws, ['dep.v1']);
    ws = socket;
    socket.addEventListener('message', (e) =>
      inbox.push(JSON.parse(String(e.data)) as Record<string, unknown>),
    );
    await new Promise<void>((resolve, reject) => {
      socket.addEventListener('open', () => resolve());
      socket.addEventListener('error', () => reject(new Error('no socket')));
    });
    const reply = async (re: string) => {
      for (let i = 0; i < 400; i++) {
        const m = inbox.find((x) => x['re'] === re);
        if (m) return m;
        await sleep(5);
      }
      throw new Error(`no reply to ${re}: ${JSON.stringify(inbox)}`);
    };
    const send = (m: unknown) => socket.send(JSON.stringify(m));
    send({
      t: 'hello',
      id: 'h1',
      d: {
        versions: ['1.0'],
        token: await token({ sub: 'wire' }, { [docId]: 'editor' }),
        client: { name: 'wire-test', version: '1' },
        engines: ['pm-steps/1'],
        cdm: { min: 1, max: 1 },
        features: [],
      },
    });
    expect(await reply('h1')).toMatchObject({ t: 'welcome', d: { version: '1.0' } });
    await run({ docId, discovery, ws: socket, inbox, send, reply });
  } finally {
    ws?.close(1000);
    await harness.dispose();
  }
}

const open = (id: string, ch: number, doc: string, features: string[]) => ({
  t: 'ch.open',
  id,
  ch,
  d: { kind: 'doc', doc, engine: 'pm-steps/1', cdm: 1, features },
});

describe('the service on the wire, as a receiver (PRO-005, PRO-006)', () => {
  it('speaks 1.0 on dep.v1 under /v1, ignores an unknown type, answers one with an id, and stays open', async () => {
    await wire(async ({ docId, discovery, ws, inbox, send, reply }) => {
      expect(ws.protocol).toBe('dep.v1');
      expect(discovery.rest.endsWith('/v1')).toBe(true);
      // 05 §1 rule 3: an unknown type is ignored; with an id it is answered with unknown_type.
      send({ t: 'future.thing', d: { a: 1 } });
      send({ t: 'x-trial.thing', id: 'u1' });
      expect(await reply('u1')).toMatchObject({
        t: 'error',
        d: { code: 'unknown_type', fatal: false },
      });
      send(open('o1', 1, docId, []));
      expect(await reply('o1')).toMatchObject({ t: 'ch.opened' });
      expect(inbox.filter((m) => m['t'] === 'error')).toHaveLength(1);
      expect(ws.readyState).toBe(1);
    });
  });

  // 05 §1 rule 4; PRO-006 criterion 5. The data plane refuses an unannounced feature
  // (services/document-service/src/data-plane/session.ts, `unsupported_feature`).
  it('refuses a ch.open that asks for a feature the server did not announce', async () => {
    await wire(async ({ docId, discovery, send, reply }) => {
      expect(discovery.features).not.toContain('x-not-announced');
      send(open('o1', 1, docId, ['x-not-announced']));
      expect(await reply('o1')).toMatchObject({
        t: 'ch.rejected',
        d: { code: 'unsupported_feature' },
      });
    });
  });
});

// PRO-018 criterion 5: a commit near `maxCommitBytes` (1 MiB target) with the 131,072-byte message
// limit of the example of 05 §5.9 is sent as chunks, reassembled by the service and acknowledged.
describe('a large commit over the service is chunked and acknowledged (PRO-018)', () => {
  it('sends a 1,000,000-character insertion as chunks, the service reassembles it and acknowledges it', async () => {
    const { service, harness, token } = await startServiceHarness();
    const sent: string[] = [];
    class Recording extends WebSocket {
      override send(data: string): void {
        sent.push(data);
        super.send(data);
      }
    }
    const docId = await harness.createDocument(contractDocument());
    const b = createDepBackend({
      endpoint: service.url,
      getToken: () => token({ sub: 'large-commit' }, { [docId]: 'editor' }),
      platform: { WebSocket: Recording, random: () => 0 },
    });
    try {
      await b.connect();
      const content = await b.sync.loadContent(docId);
      const ch = await b.sync.open(docId, {
        resume: { seq: content.seq, incarnation: content.incarnation },
      });
      const states: string[] = [];
      ch.onState((s) => states.push(s.status));
      for (let i = 0; i < 400 && !states.includes('live'); i++) await sleep(5);
      expect(states).toContain('live');

      const body = 'x'.repeat(1_000_000);
      const from = sent.length;
      const ack = await ch.submit({
        id: '0192f0c4-0000-7000-8000-000000000402',
        base: content.seq,
        steps: [insertText(posIn(content.doc, IDS.intro), body)],
      });
      const frames = sent.slice(from).map((t) => JSON.parse(t) as { t: string; d: Json });
      const chunks = frames.filter((f) => f.t === 'chunk');
      expect(chunks.length).toBeGreaterThan(1);
      expect(frames.map((f) => f.t)).not.toContain('sync.submit');
      expect(sent.slice(from).every((t) => new TextEncoder().encode(t).length <= 131_072)).toBe(
        true,
      );
      expect(ack.seq).toBe(content.seq + 1);

      const after = await b.sync.loadContent(docId);
      expect(JSON.stringify(after.doc)).toContain(body);
    } finally {
      await b.close();
      await harness.dispose();
    }
  }, 60_000);
});
