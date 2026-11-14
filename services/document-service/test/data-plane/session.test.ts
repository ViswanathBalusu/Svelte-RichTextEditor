// The session layer of the data plane against real WebSocket clients (05 §4, §5.1, §5.7; BE-029,
// PRO-017, PRO-021, PRO-022, PRO-037): subprotocol and compression, hello and welcome, every limit,
// the origin check, version negotiation, token failures, malformed and oversized frames, chunks,
// heartbeat, token expiry and refresh, and the close codes.
import { isUuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const NINE = [4400, 4401, 4403, 4406, 4408, 4413, 4429, 4500, 4503];
const seenCloseCodes = new Set<number>();
let planes: Plane[] = [];

async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}

async function closedWith(c: DepClient): Promise<number> {
  const { code } = await c.closed;
  seenCloseCodes.add(code);
  return code;
}

afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

describe('the WebSocket handshake (PRO-017)', () => {
  it('selects dep.v1 and leaves permessage-deflate off by default', async () => {
    const p = await plane();
    const c = await DepClient.connect(p.url, { perMessageDeflate: true });
    expect(c.ws.protocol).toBe('dep.v1');
    expect(c.ws.extensions).toBe('');
    c.close();
  });

  it('refuses an upgrade that does not offer dep.v1', async () => {
    const p = await plane();
    await expect(DepClient.connect(p.url, { protocols: ['other'] })).rejects.toMatchObject({
      status: 400,
    });
  });

  it('keeps messages unchanged when both sides enable compression', async () => {
    const p = await plane({ settings: { compression: true } });
    const doc = await p.createDocument();
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    const c = await DepClient.connect(p.url, { perMessageDeflate: true });
    expect(c.ws.extensions).toContain('permessage-deflate');
    const w = await c.hello(token);
    expect(w.t).toBe('welcome');
    const o = await c.open(1, doc);
    expect(o.t).toBe('ch.opened');
    expect(o.d!['head']).toBe(0);
  });
});

describe('hello and welcome (PRO-021, PRO-022, BE-029)', () => {
  it('answers hello with welcome: version, a new session, the user, features, every limit, tokenExp', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' }, name: 'Alice' });
    const c = await DepClient.connect(p.url);
    const w = await c.hello(token);
    expect(w.t).toBe('welcome');
    const d = w.d!;
    expect(d['version']).toBe('1.0');
    expect(isUuid7(d['session'])).toBe(true);
    // The wire shows the host's `sub`; the surrogate stays at rest (D42).
    expect(d['user']).toEqual({ id: 'host-alice', name: 'Alice' });
    // D121: the protocol features and the CDM features the model reads, in one list.
    expect(d['features']).toEqual([
      'presence',
      'regions',
      'suggest-enforced',
      'read-restrictions',
      'fields',
      'extensions',
      'preserve',
    ]);
    expect(d['tokenExp']).toBe(new Date(p.tokens.identity(token).expiresAt).toISOString());
    // 04's defaults (targets); maxMessageBytes and maxChannels as the example and the mock (G18).
    expect(d['limits']).toEqual({
      maxMessageBytes: 131072,
      maxCommitBytes: 1048576,
      maxStepsPerCommit: 500,
      maxRebaseSteps: 5000,
      maxChannels: 16,
      heartbeatMs: 25000,
      ackTimeoutMs: 15000,
      presenceHz: 10,
      presenceBytes: 1024,
      catchUpCommits: 5000,
      catchUpBytes: 5242880,
    });
    // A reconnect is a new session; nothing is resumed (05 §5.1).
    const c2 = await DepClient.connect(p.url);
    const w2 = await c2.hello(token);
    expect(w2.d!['session']).not.toBe(d['session']);
  });

  it('advertises the configured limits', async () => {
    const p = await plane({
      settings: { limits: { maxMessageBytes: 65536, heartbeatMs: 20000, presenceHz: 5 } },
    });
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    const w = c.log.find((m) => m.t === 'welcome')!;
    expect(w.d!['limits']).toMatchObject({
      maxMessageBytes: 65536,
      heartbeatMs: 20000,
      presenceHz: 5,
    });
  });

  it('closes with 4408 when no hello arrives in time, and never reads a token from the URL', async () => {
    let verified = 0;
    const p = await plane({ settings: { helloTimeoutMs: 150 } });
    const verify = p.tokens.verify;
    p.tokens.verify = async (t) => {
      verified++;
      return verify(t);
    };
    const doc = await p.createDocument();
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    const c = await DepClient.connect(`${p.url}?token=${token}&access_token=${token}`);
    expect(await closedWith(c)).toBe(4408);
    expect(verified).toBe(0);
    expect(c.log).toEqual([]);
  });

  it('closes with 4400 when the first message is not hello', async () => {
    const p = await plane();
    const c = await DepClient.connect(p.url);
    c.send({ t: 'ping', id: 'x' });
    const e = await c.take((m) => m.t === 'error');
    expect(e.d).toMatchObject({ code: 'bad_message', fatal: true });
    expect(await closedWith(c)).toBe(4400);
  });

  it('lists the server versions in an error and closes with 4406 when no version is common', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await DepClient.connect(p.url);
    const e = await c.hello(p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } }), {
      versions: ['2.0'],
    });
    expect(e.t).toBe('error');
    expect(e.d).toMatchObject({ code: 'unsupported_version', fatal: true, versions: ['1.0'] });
    expect(await closedWith(c)).toBe(4406);
  });

  it.each([
    ['unauthenticated', 4401],
    ['token_expired', 4401],
    ['revoked', 4401],
    ['forbidden', 4403],
  ])(
    'ends a hello whose token is refused with %s in a fatal error and close %i',
    async (code, close) => {
      const p = await plane();
      const doc = await p.createDocument();
      const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
      p.tokens.refusals.set(token, code);
      const c = await DepClient.connect(p.url);
      const e = await c.hello(token);
      expect(e.t).toBe('error');
      expect(e.d).toMatchObject({ code, fatal: true });
      expect(await closedWith(c)).toBe(close);
    },
  );

  it('refuses an unknown token with 4401 and an expired one with token_expired', async () => {
    let now = 1_760_000_000_000;
    const p = await plane({ now: () => now });
    const doc = await p.createDocument();
    const c = await DepClient.connect(p.url);
    expect((await c.hello('tok_unknown')).d).toMatchObject({ code: 'unauthenticated' });
    expect(await closedWith(c)).toBe(4401);
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' }, expiresIn: 1000 });
    now += 5000;
    const c2 = await DepClient.connect(p.url);
    expect((await c2.hello(token)).d).toMatchObject({ code: 'token_expired', fatal: true });
    expect(await closedWith(c2)).toBe(4401);
  });

  it('checks the Origin header against the tenant when hello arrives; a client without one is accepted', async () => {
    const asked: string[] = [];
    const p = await plane({
      deps: {
        allowedOrigins: async (tenant) => {
          asked.push(tenant);
          return ['https://app.example.com'];
        },
      },
    });
    const doc = await p.createDocument();
    const token = () => p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    const bad = await DepClient.connect(p.url, { origin: 'https://evil.example.com' });
    // Nothing is checked before hello: the connection is open until then (05 §4).
    expect(bad.ws.readyState).toBe(bad.ws.OPEN);
    const e = await bad.hello(token());
    expect(e.d).toMatchObject({ code: 'forbidden', fatal: true });
    expect(await closedWith(bad)).toBe(4403);
    expect(asked).toEqual([p.tenant]);
    const good = await DepClient.connect(p.url, { origin: 'https://app.example.com' });
    expect((await good.hello(token())).t).toBe('welcome');
    const none = await DepClient.connect(p.url);
    expect((await none.hello(token())).t).toBe('welcome');
  });
});

describe('framing (PRO-017, PRO-037; decision D03)', () => {
  async function opened(p: Plane): Promise<DepClient> {
    const doc = await p.createDocument();
    return p.client('alice', { [doc]: 'owner' });
  }

  it.each([
    ['not JSON', '{"t":'],
    ['not an object', '[1,2]'],
    ['without t', '{"id":"1"}'],
    ['with a mistyped envelope', '{"t":"ping","ch":"one"}'],
  ])('closes with 4400 after an error for a frame %s', async (_what, frame) => {
    const p = await plane();
    const c = await opened(p);
    c.sendRaw(frame);
    const e = await c.take((m) => m.t === 'error');
    expect(e.d).toMatchObject({ code: 'bad_message', fatal: true });
    expect(await closedWith(c)).toBe(4400);
  });

  it('closes with 4400 for a binary frame and for text that is not UTF-8', async () => {
    const p = await plane();
    const c = await opened(p);
    c.sendRaw(Buffer.from([1, 2, 3]), true);
    expect(await closedWith(c)).toBe(4400);
    const c2 = await opened(p);
    c2.sendRaw(Buffer.from([0x7b, 0xff, 0xfe, 0x7d]));
    expect(await closedWith(c2)).toBe(4400);
  });

  it('answers a frame above maxMessageBytes with too_large and closes with 4413', async () => {
    const p = await plane({ settings: { limits: { maxMessageBytes: 4096 } } });
    const c = await opened(p);
    c.send({ t: 'ping', id: 'x'.repeat(5000) });
    const e = await c.take((m) => m.t === 'error');
    expect(e.d).toMatchObject({ code: 'too_large', fatal: true });
    expect(await closedWith(c)).toBe(4413);
  });

  it('answers a payload that breaks its schema with a non-fatal bad_message carrying re', async () => {
    const p = await plane();
    const c = await opened(p);
    c.send({ t: 'ch.open', id: 'o1', ch: 1, d: { kind: 'doc' } });
    const e = await c.take((m) => m.t === 'error');
    expect(e).toMatchObject({ re: 'o1', d: { code: 'bad_message', fatal: false } });
    c.send({ t: 'ping', id: 'p1' });
    expect(await c.take((m) => m.t === 'pong')).toMatchObject({ re: 'p1' });
  });

  it('ignores an unknown type and answers it with unknown_type when it has an id (05 §1 rule 3)', async () => {
    const p = await plane();
    const c = await opened(p);
    c.send({ t: 'x-future', id: 'f1', d: {} });
    c.send({ t: 'x-future' });
    const e = await c.take((m) => m.t === 'error');
    expect(e).toMatchObject({ re: 'f1', d: { code: 'unknown_type', fatal: false } });
    c.send({ t: 'ping', id: 'p2' });
    await c.take((m) => m.t === 'pong' && m.re === 'p2');
    expect(c.all('error')).toHaveLength(1);
  });

  it('reassembles a chunked message from the client and chunks a large message to it (05 §4)', async () => {
    const { chunkMessage } = await import('@docedit/protocol');
    const p = await plane({ settings: { limits: { maxMessageBytes: 2048 } } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const b = await p.client('carol', { [doc]: 'editor' });
    await a.open(1, doc);
    await b.open(1, doc);
    const { posInside, baseDoc } = await import('../../../../packages/authority/test/fixtures.ts');
    const pos = posInside(baseDoc(), 'pIntro0000000001');
    const long = 'é'.repeat(3000);
    const text = JSON.stringify({
      t: 'sync.submit',
      id: 'big',
      ch: 1,
      d: {
        id: (await import('@docedit/model')).uuid7(),
        base: 0,
        steps: [
          {
            stepType: 'replace',
            from: pos,
            to: pos,
            slice: { content: [{ type: 'text', text: long }] },
          },
        ],
      },
    });
    for (const f of chunkMessage(text, 2048, 'of-1')) a.sendRaw(f);
    const ack = await a.take((m) => m.re === 'big');
    expect(ack.t).toBe('sync.ack');
    const commit = await b.take((m) => m.t === 'sync.commit');
    expect(JSON.stringify(commit.d)).toContain(long);
    // The broadcast was larger than maxMessageBytes, so it travelled as chunks within the limit.
    const chunks = b.frames.filter((f) => f.startsWith('{"t":"chunk"'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const f of b.frames) expect(Buffer.byteLength(f, 'utf8')).toBeLessThanOrEqual(2048);
  });
});

describe('the session over time (05 §4, §5.1)', () => {
  it('answers ping with pong carrying re', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    c.send({ t: 'ping', id: 'hb' });
    expect(await c.take((m) => m.t === 'pong')).toMatchObject({ re: 'hb' });
  });

  it('sends ping after heartbeatMs of silence', async () => {
    const p = await plane({ settings: { limits: { heartbeatMs: 200 } } });
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    await c.take((m) => m.t === 'ping', 2000);
    c.send({ t: 'pong' });
  });

  it('sends auth.expiring about 60 seconds before tokenExp and closes with 4401 at expiry', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const soon = await p.client('alice', { [doc]: 'owner' }, { expiresIn: 60_400 });
    const exp = await soon.take((m) => m.t === 'auth.expiring', 3000);
    expect(exp.d!['inMs']).toBeGreaterThan(55_000);
    expect(exp.d!['inMs']).toBeLessThanOrEqual(60_400);
    const short = await p.client('alice', { [doc]: 'owner' }, { expiresIn: 400 });
    await short.take((m) => m.t === 'auth.expiring');
    const e = await short.take((m) => m.t === 'error', 3000);
    expect(e.d).toMatchObject({ code: 'token_expired', fatal: true });
    expect(await closedWith(short)).toBe(4401);
  });

  it('accepts auth.refresh with the same tid and sub, and refuses another user (BE-029)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    const same = p.tokens.issue({
      user: 'alice',
      docs: { [doc]: 'owner' },
      expiresIn: 20 * 60_000,
    });
    c.send({ t: 'auth.refresh', id: 'r1', d: { token: same } });
    const ok = await c.take((m) => m.re === 'r1');
    expect(ok.t).toBe('auth.ok');
    expect(ok.d!['tokenExp']).toBe(new Date(p.tokens.identity(same).expiresAt).toISOString());
    const other = p.tokens.issue({ user: 'bob', docs: { [doc]: 'editor' } });
    c.send({ t: 'auth.refresh', id: 'r2', d: { token: other } });
    const no = await c.take((m) => m.re === 'r2');
    expect(no).toMatchObject({ t: 'error', d: { code: 'forbidden', fatal: false } });
    const foreign = p.tokens.issue({
      user: 'alice',
      docs: { [doc]: 'owner' },
      tenant: crypto.randomUUID(),
    });
    c.send({ t: 'auth.refresh', id: 'r3', d: { token: foreign } });
    expect(await c.take((m) => m.re === 'r3')).toMatchObject({
      t: 'error',
      d: { code: 'forbidden' },
    });
    expect(c.ws.readyState).toBe(c.ws.OPEN);
  });

  it('revokes a session: auth.revoked, then close 4401 (05 §3.3)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await p.client('bob', { [doc]: 'editor' });
    const other = await p.client('carol', { [doc]: 'editor' });
    p.plane.sessionsRevoked(p.tenant, 'bob', null);
    expect(await c.take((m) => m.t === 'auth.revoked')).toBeTruthy();
    expect(await closedWith(c)).toBe(4401);
    expect(other.ws.readyState).toBe(other.ws.OPEN);
  });

  it('drains on close: goaway with a reconnect hint, then 4503', async () => {
    const p = await startPlane();
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    await c.open(1, doc);
    const done = p.plane.close();
    const g = await c.take((m) => m.t === 'goaway');
    expect(g.d!['reconnectInMs']).toBeGreaterThan(0);
    expect(await closedWith(c)).toBe(4503);
    await done;
    // A new connection is refused while the service stops.
    await expect(DepClient.connect(p.url)).rejects.toMatchObject({ status: 503 });
    await p.close();
  });

  it('closes connections only with the nine codes of 05 §5.7', () => {
    expect(seenCloseCodes.size).toBeGreaterThan(5);
    for (const code of seenCloseCodes) expect(NINE).toContain(code);
  });
});
