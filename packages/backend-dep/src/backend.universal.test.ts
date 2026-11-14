// backend-dep beyond the port contract (PRO-093, PRO-094, PRO-005, PRO-006; ADR 0019): what goes on
// the wire, where the token travels, negotiation, the end of a session, reconnection, unknown
// messages and view tokens. Every frame and request is recorded by the in-memory network, so the
// tests assert on the wire itself. Universal: Node.js and browsers.
import { describe, expect, it } from 'vitest';
import {
  isPortError,
  isSyncReject,
  type Access,
  type ChannelState,
  type DocRole,
  type Notification,
  type RemoteCommit,
  type SyncChannel,
  type SyncReset,
} from '@docedit/protocol';
import { featureNamespaceProblems } from '@docedit/protocol/client';
import { DEP1 } from '@docedit/protocol';
import { supportedFeatures } from '@docedit/model/definition';
import { createDepBackend, type DepBackend, type DepBackendOptions } from './index.ts';
import {
  IDS,
  LEGAL_GRANT,
  USERS,
  contractDocument,
  insertText,
  posIn,
} from '../test/support/fixtures.ts';
import { MemoryNetwork, type MemoryServer } from '../test/support/memory-network.ts';
import { MockDepServer, type MockDepServerOptions } from '../test/support/mock-server.ts';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

async function until(pred: () => boolean, what: string, ms = 3000): Promise<void> {
  for (let waited = 0; !pred(); waited += 5) {
    if (waited > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(5);
  }
}

interface Setup {
  server: MockDepServer;
  net: MemoryNetwork;
  docId: string;
  tokens: string[];
  make(
    user?: { sub: string; name?: string; groups?: readonly string[] },
    role?: DocRole,
    extra?: Partial<DepBackendOptions>,
  ): DepBackend;
}

function setup(
  opts: { server?: MockDepServerOptions; wrap?: (s: MockDepServer) => MemoryServer } = {},
): Setup {
  const server = new MockDepServer(opts.server);
  const net = new MemoryNetwork(opts.wrap ? opts.wrap(server) : server);
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const tokens: string[] = [];
  return {
    server,
    net,
    docId,
    tokens,
    make: (user = USERS.editor, role = 'editor', extra = {}) =>
      createDepBackend({
        endpoint: server.endpoint,
        getToken: async () => {
          const t = server.mintToken(user, { [docId]: role });
          tokens.push(t);
          return t;
        },
        ...extra,
        // Reconnect at once in tests: no jitter (05 §4 allows any delay below the cap).
        platform: { random: () => 0, ...net.platform(), ...extra.platform },
      }),
  };
}

/** Records what a channel delivers, in one log across kinds. */
function record(ch: SyncChannel) {
  const log: Array<{ kind: string; value: unknown }> = [];
  ch.onCommits((v) => log.push({ kind: 'commits', value: v }));
  ch.onAccess((v) => log.push({ kind: 'access', value: v }));
  ch.onReset((v) => log.push({ kind: 'reset', value: v }));
  ch.onEvent((v) => log.push({ kind: 'event', value: v }));
  ch.onState((v) => log.push({ kind: 'state', value: v }));
  return {
    log,
    states: () => log.flatMap((d) => (d.kind === 'state' ? [d.value as ChannelState] : [])),
    commits: () => log.flatMap((d) => (d.kind === 'commits' ? (d.value as RemoteCommit[]) : [])),
  };
}

async function joined(s: Setup, b: DepBackend) {
  await b.connect();
  const content = await b.sync.loadContent(s.docId);
  const ch = await b.sync.open(s.docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const rec = record(ch);
  await until(() => rec.states().some((x) => x.status === 'live'), 'live');
  return { content, ch, rec };
}

const frames = (net: MemoryNetwork, dir: 'c2s' | 's2c') => net.decoded(dir);

describe('connect() (PRO-093)', () => {
  it('fetches discovery, opens ws with dep.v1, sends hello with the token and resolves on welcome', async () => {
    const s = setup();
    const b = s.make();
    expect(b.auth.session).toBeNull();
    expect(b.connection.status).toBe('offline');
    await b.connect();
    expect(s.net.requests[0]).toMatchObject({
      method: 'GET',
      url: 'https://dep.test/.well-known/dep',
    });
    expect(s.net.requests[0]!.headers['authorization']).toBeUndefined();
    expect(s.net.sockets).toEqual([{ id: 1, url: 'wss://dep.test/dep', protocols: ['dep.v1'] }]);
    const hello = frames(s.net, 'c2s')[0]!;
    expect(hello).toMatchObject({ t: 'hello', d: { token: s.tokens[0], versions: ['1.0'] } });
    expect(b.auth.session?.user.id).toBe(USERS.editor.sub);
    expect(b.connection.status).toBe('online');
    await b.close();
  });

  it('negotiates the features: what the client asked for that the server announced (05 §1 rule 4)', async () => {
    const s = setup({
      server: {
        welcome: (d) => ({ ...d, features: ['regions', 'x-other', 'history', 'suggest-enforced'] }),
      },
    });
    const b = s.make(USERS.editor, 'editor', {
      features: ['presence', 'regions', 'x-trial', 'suggest-enforced'],
    });
    expect(b.features.size).toBe(0);
    await b.connect();
    expect([...b.features]).toEqual(['regions', 'suggest-enforced']);
    expect(b.presence).toBeUndefined();
    expect(typeof b.permissions.regions).toBe('function');
    await b.close();
    expect(b.features.size).toBe(0);
  });

  it('rejects with unavailable when discovery cannot be read, and names a version mismatch', async () => {
    const cases: Array<[Partial<MockDepServerOptions> | 'down', string]> = [
      ['down', 'unavailable'],
      [{ discovery: (d) => ({ ...d, ws: undefined }) }, 'unavailable'],
      [{ discovery: (d) => ({ ...d, versions: ['2.0'] }) }, 'unsupported_version'],
      [{ discovery: (d) => ({ ...d, engines: ['crdt/9'] }) }, 'unsupported_engine'],
    ];
    for (const [opt, code] of cases) {
      const s = setup(opt === 'down' ? {} : { server: opt });
      if (opt === 'down') s.net.online = false;
      const b = s.make();
      const e = await b.connect().then(
        () => null,
        (x: unknown) => x,
      );
      expect(isPortError(e) && e.code, JSON.stringify(opt)).toBe(code);
      expect(b.connection.status).toBe('offline');
      expect(b.timers.size).toBe(0);
    }
  });

  it('rejects with unauthenticated and raises onAuthRequired when the token source fails', async () => {
    const s = setup();
    const b = createDepBackend({
      endpoint: s.server.endpoint,
      getToken: async () => {
        throw new Error('signed out');
      },
      platform: s.net.platform(),
    });
    const seen: string[] = [];
    b.auth.onAuthRequired((e) => seen.push(e.code));
    const e = await b.connect().then(
      () => null,
      (x: unknown) => x,
    );
    expect(isPortError(e) && e.code).toBe('unauthenticated');
    await until(() => seen.length > 0, 'onAuthRequired');
    expect(seen).toEqual(['unauthenticated']);
    expect(s.net.sockets).toEqual([]);
  });

  it('refuses a server that does not select the subprotocol dep.v1 (05 §4)', async () => {
    const s = setup({
      wrap: (server) => ({
        accept: (sock) => (server.accept(sock), 'chat'),
        http: (r) => server.http(r),
      }),
    });
    const e = await s
      .make()
      .connect()
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(isPortError(e) && e.code).toBe('unsupported_version');
  });
});

describe('the token (PRO-093; 05 §3.1)', () => {
  it('appears only in hello, auth.refresh and Authorization headers, never in a URL', async () => {
    const s = setup();
    const owner = s.make(USERS.owner, 'owner');
    const { content, ch } = await joined(s, owner);
    await owner.sync.loadContent(s.docId, content.seq);
    await ch.submit({
      id: '0192f0c4-0000-7000-8000-000000000001',
      base: content.seq,
      steps: [insertText(posIn(content.doc, IDS.intro), 'x')],
    });
    await owner.auth.refresh();
    await owner.permissions.regions!(s.docId);
    const g = await owner.permissions.grants!(s.docId);
    await owner.permissions.updateGrants!(s.docId, { grants: g.value.grants }, { ifMatch: g.etag });
    await owner.close();
    expect(s.tokens.length).toBeGreaterThanOrEqual(2);
    for (const f of s.net.frames)
      for (const t of s.tokens)
        if (f.text.includes(t)) {
          expect(f.dir).toBe('c2s');
          expect(['hello', 'auth.refresh']).toContain((JSON.parse(f.text) as { t: string }).t);
        }
    for (const r of s.net.requests) {
      for (const t of s.tokens) expect(r.url.includes(t), r.url).toBe(false);
      for (const [k, v] of Object.entries(r.headers))
        if (s.tokens.some((t) => v.includes(t))) {
          expect(k).toBe('authorization');
          expect(v.startsWith('Bearer ')).toBe(true);
        }
    }
    for (const sock of s.net.sockets)
      for (const t of s.tokens) expect(sock.url.includes(t)).toBe(false);
  });
});

describe('close() (PRO-093)', () => {
  it('closes the channels and the socket with a normal closure, and no timer remains', async () => {
    const s = setup();
    const b = s.make();
    const { rec } = await joined(s, b);
    await b.close();
    await until(() => s.server.sessions[0]!.ended, 'the server sees the close');
    const closes = frames(s.net, 'c2s').filter((f) => f['t'] === 'ch.close');
    expect(closes).toHaveLength(1);
    expect(b.timers.size).toBe(0);
    expect(b.connection.status).toBe('offline');
    await until(() => rec.states().at(-1)?.status === 'closed', 'closed');
    expect(rec.states().at(-1)).toEqual({
      status: 'closed',
      code: null,
      reason: 'closed by the client',
    });
    expect(s.net.openSockets).toBe(0);
  });

  it('rejects a connect() in progress', async () => {
    const s = setup();
    const b = s.make();
    const p = b.connect();
    await b.close();
    const e = await p.then(
      () => null,
      (x: unknown) => x,
    );
    expect(isPortError(e) && e.code).toBe('unavailable');
    expect(b.timers.size).toBe(0);
  });
});

describe('a lost connection (PRO-093; 05 §4; 04 §9)', () => {
  it('reports reconnecting, then online, and the channel resumes with what it missed', async () => {
    const s = setup();
    const statuses: string[] = [];
    const a = s.make(USERS.editor, 'editor');
    a.connection.onStatus((x) => statuses.push(x));
    const other = s.make(USERS.grantee, 'editor');
    const ja = await joined(s, a);
    const jo = await joined(s, other);
    s.net.cut();
    await until(() => ja.rec.states().some((x) => x.status === 'resuming'), 'resuming', 5000);
    // While a is away, the other user commits; a receives it in its catch-up stream.
    await until(() => other.connection.status === 'online', 'other back', 5000);
    await until(
      () => jo.rec.states().filter((x) => x.status === 'live').length >= 2,
      'other live again',
      5000,
    );
    const ack = await jo.ch.submit({
      id: '0192f0c4-0000-7000-8000-000000000002',
      base: jo.content.seq,
      steps: [insertText(posIn(jo.content.doc, IDS.end), 'y')],
    });
    await until(() => ja.rec.commits().some((c) => c.seq === ack.seq), 'the missed commit', 5000);
    expect(statuses).toEqual(expect.arrayContaining(['online', 'reconnecting']));
    expect(statuses.at(-1)).toBe('online');
    const st = ja.rec.states().map((x) => x.status);
    expect(st.slice(0, 2)).toEqual(['catching_up', 'live']);
    expect(st).toContain('resuming');
    expect(st.at(-1)).toBe('live');
    const resumes = frames(s.net, 'c2s').filter(
      (f) => f['t'] === 'ch.open' && (f['d'] as { resume?: unknown }).resume,
    );
    expect(resumes.length).toBeGreaterThanOrEqual(4);
    await Promise.all([a.close(), other.close()]);
  });
});

describe('channels (PRO-094)', () => {
  it('reads content over REST, pinned with ?seq=N', async () => {
    const s = setup();
    const b = s.make();
    await b.connect();
    const head = await b.sync.loadContent(s.docId);
    const pinned = await b.sync.loadContent(s.docId, head.seq);
    expect(pinned.seq).toBe(head.seq);
    const urls = s.net.requests.map((r) => r.url);
    expect(urls).toContain(`https://dep.test/v1/documents/${s.docId}/content`);
    expect(urls).toContain(`https://dep.test/v1/documents/${s.docId}/content?seq=${head.seq}`);
    await b.close();
  });

  it('opens each channel on a fresh channel number', async () => {
    const s = setup();
    const b = s.make();
    await b.connect();
    const c1 = await b.sync.open(s.docId, {});
    c1.close();
    await b.sync.open(s.docId, {});
    const opens = frames(s.net, 'c2s').filter((f) => f['t'] === 'ch.open');
    expect(opens.map((f) => f['ch'])).toEqual([1, 2]);
    await b.close();
  });

  it('delivers sync.commit, perm.changed, sync.reset and event in the order received', async () => {
    const s = setup();
    const b = s.make();
    const { ch, rec, content } = await joined(s, b);
    const session = s.server.sessions[0]!;
    const n = frames(s.net, 'c2s').filter((f) => f['t'] === 'ch.open')[0]!['ch'] as number;
    const access = ch.opened.access;
    const seq = content.seq;
    const commit: RemoteCommit = {
      seq: seq + 1,
      kind: 'control',
      id: '0192f0c4-0000-7000-8000-0000000000c1',
      steps: [],
      control: { type: 'grants', rev: 9 },
      author: { user: 'system', session: null, agent: null },
      serverTime: '2026-11-06T10:00:00.000Z',
      origin: 'control',
    };
    const event: Notification = { type: 'document.updated', resource: `/documents/${s.docId}` };
    const reset: SyncReset = { seq: seq + 2, reason: 'import' };
    const before = rec.log.length;
    session.push({ t: 'event', ch: n, d: event });
    session.push({ t: 'perm.changed', ch: n, d: { ...access, rev: 2 } });
    session.push({ t: 'sync.commit', ch: n, d: { commits: [commit] } });
    session.push({ t: 'sync.reset', ch: n, d: reset });
    session.push({ t: 'event', ch: n, d: event });
    await until(() => rec.log.length >= before + 5, 'five deliveries');
    expect(rec.log.slice(before).map((d) => d.kind)).toEqual([
      'event',
      'access',
      'commits',
      'reset',
      'event',
    ]);
    expect((rec.log[before + 1]!.value as Access).rev).toBe(2);
    await b.close();
  });

  it('sends ch.close on close() and ignores later messages for the channel', async () => {
    const s = setup();
    const b = s.make();
    const { ch, rec, content } = await joined(s, b);
    const n = frames(s.net, 'c2s').filter((f) => f['t'] === 'ch.open')[0]!['ch'] as number;
    ch.close();
    expect(frames(s.net, 'c2s').at(-1)).toEqual({ t: 'ch.close', ch: n });
    await until(() => rec.states().at(-1)?.status === 'closed', 'closed');
    const before = rec.log.length;
    s.server.sessions[0]!.push({
      t: 'event',
      ch: n,
      d: { type: 'document.updated', resource: '/x' },
    });
    s.server.sessions[0]!.push({
      t: 'sync.reset',
      ch: n,
      d: { seq: content.seq + 1, reason: 'import' },
    });
    await sleep(20);
    expect(rec.log.slice(before).map((d) => d.kind)).toEqual([]);
    expect(rec.states().filter((x) => x.status === 'closed')).toHaveLength(1);
    await b.close();
  });

  it('rejects a submit with a SyncRejectError carrying code, action and head', async () => {
    const s = setup();
    const b = s.make();
    const { ch, content } = await joined(s, b);
    const e = await ch
      .submit({
        id: '0192f0c4-0000-7000-8000-000000000003',
        base: content.seq,
        steps: [insertText(posIn(content.doc, IDS.lockedPara), 'x')],
      })
      .then(
        () => null,
        (x: unknown) => x,
      );
    expect(isSyncReject(e) && [e.code, e.action, e.head]).toEqual([
      'permission_denied',
      'drop',
      content.seq,
    ]);
    await b.close();
  });
});

describe('what the client does not know (PRO-005)', () => {
  it('uses the known members of a message and ignores the unknown ones', async () => {
    const s = setup();
    const b = s.make();
    const { rec } = await joined(s, b);
    const n = frames(s.net, 'c2s').filter((f) => f['t'] === 'ch.open')[0]!['ch'] as number;
    s.server.sessions[0]!.push({
      t: 'event',
      ch: n,
      future: { a: 1 },
      d: { type: 'document.updated', resource: '/documents/x', later: [1, 2] },
    });
    await until(() => rec.log.some((d) => d.kind === 'event'), 'the event');
    expect(rec.log.find((d) => d.kind === 'event')!.value).toMatchObject({
      type: 'document.updated',
      resource: '/documents/x',
    });
    await b.close();
  });

  it('ignores an unknown type without an id, answers one with an id, and the connection stays open', async () => {
    const s = setup();
    const b = s.make();
    const { ch, content } = await joined(s, b);
    const session = s.server.sessions[0]!;
    const sent = () => frames(s.net, 'c2s').length;
    const before = sent();
    session.push({ t: 'future.thing', d: { a: 1 } });
    session.push({ t: 'x-trial.thing', id: 'srv-7' });
    session.push({ t: 'future.thing', id: 'srv-8', d: {} });
    await until(() => sent() >= before + 2, 'the replies');
    expect(frames(s.net, 'c2s').slice(before)).toEqual([
      {
        t: 'error',
        re: 'srv-7',
        d: {
          code: 'unknown_type',
          message: 'unknown message type x-trial.thing',
          retryable: false,
          fatal: false,
        },
      },
      {
        t: 'error',
        re: 'srv-8',
        d: {
          code: 'unknown_type',
          message: 'unknown message type future.thing',
          retryable: false,
          fatal: false,
        },
      },
    ]);
    const ack = await ch.submit({
      id: '0192f0c4-0000-7000-8000-000000000004',
      base: content.seq,
      steps: [insertText(posIn(content.doc, IDS.intro), 'z')],
    });
    expect(ack.seq).toBe(content.seq + 1);
    expect(b.connection.status).toBe('online');
    await b.close();
  });

  it('ignores unknown members of REST bodies', async () => {
    const s = setup({
      wrap: (server) => ({
        accept: (sock) => server.accept(sock),
        http: async (r) => {
          const res = await server.http(r);
          if (!r.url.includes('/content') || !res.body) return res;
          return {
            ...res,
            body: JSON.stringify({ ...JSON.parse(res.body), futureMember: { deep: [1] } }),
          };
        },
      }),
    });
    const b = s.make();
    const c = await b.sync.loadContent(s.docId);
    expect(c.seq).toBe(0);
    expect(c.cdm).toBe(1);
  });

  it('names no stable message type, field or feature with the x- prefix, and registers each feature once', () => {
    expect(featureNamespaceProblems(DEP1, supportedFeatures())).toEqual([]);
    const fields: string[] = [];
    const walk = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      for (const [k, x] of Object.entries(v)) {
        fields.push(k);
        walk(x);
      }
    };
    walk(DEP1.shapes);
    expect(fields.filter((f) => f.startsWith('x-'))).toEqual([]);
  });
});

describe('versions and features (PRO-006)', () => {
  it('puts the major version in the subprotocol and the REST path, the minor only in hello and welcome', async () => {
    const s = setup();
    const b = s.make();
    await joined(s, b);
    expect(s.net.sockets[0]!.protocols).toEqual(['dep.v1']);
    expect(frames(s.net, 'c2s')[0]).toMatchObject({ t: 'hello', d: { versions: ['1.0'] } });
    expect(frames(s.net, 's2c')[0]).toMatchObject({ t: 'welcome', d: { version: '1.0' } });
    for (const f of [...frames(s.net, 'c2s').slice(1), ...frames(s.net, 's2c').slice(1)]) {
      const d = (f['d'] ?? {}) as Record<string, unknown>;
      expect('version' in d || 'versions' in d, JSON.stringify(f)).toBe(false);
    }
    for (const r of s.net.requests.slice(1))
      expect(r.url.startsWith('https://dep.test/v1/')).toBe(true);
    await b.close();
  });

  it('uses no feature the server did not announce: no presence port, no presence.update, ch.open within welcome.features', async () => {
    const s = setup({ server: { presence: false } });
    const b = s.make();
    await joined(s, b);
    const welcome = frames(s.net, 's2c')[0]!['d'] as { features: string[] };
    expect(welcome.features).not.toContain('presence');
    expect(b.presence).toBeUndefined();
    for (const f of frames(s.net, 'c2s')) {
      expect(f['t']).not.toBe('presence.update');
      if (f['t'] === 'ch.open')
        for (const x of (f['d'] as { features: string[] }).features)
          expect(welcome.features).toContain(x);
    }
    await b.close();
  });
});

describe('view tokens (ADR 0019; D28, D81)', () => {
  it('echoes the view of ch.opened in the resume after a lost connection', async () => {
    const s = setup({ server: { view: () => 'class-a' } });
    const b = s.make();
    const { rec } = await joined(s, b);
    s.net.cut();
    await until(
      () => rec.states().filter((x) => x.status === 'live').length >= 2,
      'live again',
      5000,
    );
    const resumes = frames(s.net, 'c2s')
      .filter((f) => f['t'] === 'ch.open')
      .map((f) => (f['d'] as { resume?: { view?: string } }).resume);
    expect(resumes.at(-1)?.view).toBe('class-a');
    await b.close();
  });

  it('fills the view of a content read into a resume from that content', async () => {
    const s = setup({ server: { view: () => 'class-b' } });
    const b = s.make();
    await b.connect();
    const c = await b.sync.loadContent(s.docId);
    expect(c.view).toBe('class-b');
    await b.sync.open(s.docId, { resume: { seq: c.seq, incarnation: c.incarnation } });
    const open = frames(s.net, 'c2s').find((f) => f['t'] === 'ch.open')!;
    expect((open['d'] as { resume: unknown }).resume).toEqual({
      seq: c.seq,
      incarnation: c.incarnation,
      view: 'class-b',
    });
    await b.close();
  });

  it('closes a channel whose resume is answered with a reload, so the caller replaces its document', async () => {
    let view = 'class-a';
    const s = setup({ server: { view: () => view } });
    const b = s.make();
    const { rec } = await joined(s, b);
    view = 'class-b';
    s.net.cut();
    await until(() => rec.states().at(-1)?.status === 'closed', 'closed', 5000);
    expect(rec.states().at(-1)).toMatchObject({
      status: 'closed',
      code: 'unavailable',
      retryInMs: 0,
    });
    await b.close();
  });
});

describe('REST failures (05 §6.1; 05 §5.8)', () => {
  it('surfaces the problem code', async () => {
    const s = setup();
    const owner = s.make(USERS.owner, 'owner');
    await owner.connect();
    const g = await owner.permissions.grants!(s.docId);
    await owner.permissions.updateGrants!(s.docId, { grants: g.value.grants }, { ifMatch: g.etag });
    const stale = await owner.permissions.updateGrants!(
      s.docId,
      { grants: [] },
      { ifMatch: g.etag },
    ).then(
      () => null,
      (x: unknown) => x,
    );
    expect(isPortError(stale) && stale.code).toBe('precondition_failed');
    const missing = await owner.sync.loadContent('0192f0c4-0000-7000-8000-00000000dead').then(
      () => null,
      (x: unknown) => x,
    );
    expect(isPortError(missing) && missing.code).toBe('forbidden');
    await owner.close();
  });

  it('renews a refused token once with getToken', async () => {
    const s = setup();
    const b = s.make();
    await b.sync.loadContent(s.docId);
    expect(s.tokens).toHaveLength(1);
    await s.server.service.revokeSessions(USERS.editor.sub);
    await b.sync.loadContent(s.docId);
    expect(s.tokens).toHaveLength(2);
    await b.sync.loadContent(s.docId);
    expect(s.tokens).toHaveLength(2);
  });
});
