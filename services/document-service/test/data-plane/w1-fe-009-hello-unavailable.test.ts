// What the session layer answers when it cannot judge a token or an origin because the service's own
// storage is away (06 §8, "PostgreSQL unavailable"; 05 §5.8). Found by the fault run of FE-009
// criterion 7 (tests/fe-009-fault-run), lane w1: a client that said `hello` during a database outage
// was answered `unauthenticated` or `forbidden`, both of which tell it to give up, so it never came
// back. The answer is now the retryable `unavailable`. A token the service did judge keeps its code.
//
// Real WebSocket clients against the data plane with in-memory stores; the failure of the storage is
// an error without a registry code, as a database driver throws (PostgreSQL's 57P01 here).
import { afterEach, describe, expect, it } from 'vitest';
import { DepClient } from './client.ts';
import { startPlane, type Plane } from './support.ts';

let planes: Plane[] = [];

afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

/** What PostgreSQL's driver throws when the server ends a session: a code that is not a registry code. */
const storageAway = (): Error =>
  Object.assign(new Error('terminating connection due to administrator command'), {
    code: '57P01',
  });

/** A plane whose token check and origin list fail as storage does while `away` is set. */
async function planeWithStorage(): Promise<{
  p: Plane;
  storage: { tokens: boolean; origins: boolean };
}> {
  const storage = { tokens: false, origins: false };
  const holder: { p: Plane | null } = { p: null };
  const p = await startPlane({
    deps: {
      verify: async (token) => {
        if (storage.tokens) throw storageAway();
        return holder.p!.tokens.verify(token);
      },
      allowedOrigins: async () => {
        if (storage.origins) throw storageAway();
        return ['https://app.example.com'];
      },
    },
  });
  holder.p = p;
  planes.push(p);
  return { p, storage };
}

describe('hello while the storage is away (FE-009 criterion 7; 06 §8; 05 §5.8)', () => {
  it('answers a token it could not check with the retryable unavailable and close 4503', async () => {
    const { p, storage } = await planeWithStorage();
    const doc = await p.createDocument();
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    storage.tokens = true;
    const c = await DepClient.connect(p.url);
    const e = await c.hello(token);
    expect(e.t).toBe('error');
    expect(e.d).toMatchObject({ code: 'unavailable', retryable: true, fatal: true });
    expect((await c.closed).code).toBe(4503);
    // No session was opened: the failure is reported, and the same token is welcome afterwards.
    expect(p.errors.length).toBeGreaterThan(0);
    storage.tokens = false;
    const again = await DepClient.connect(p.url);
    expect((await again.hello(token)).t).toBe('welcome');
  });

  it('answers an origin it could not check with unavailable, not with forbidden', async () => {
    const { p, storage } = await planeWithStorage();
    const doc = await p.createDocument();
    const token = () => p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    storage.origins = true;
    const c = await DepClient.connect(p.url, { origin: 'https://app.example.com' });
    const e = await c.hello(token());
    expect(e.d).toMatchObject({ code: 'unavailable', retryable: true, fatal: true });
    expect((await c.closed).code).toBe(4503);
    // The list is read again once it can be: the allowed origin is welcome, another is forbidden.
    storage.origins = false;
    const good = await DepClient.connect(p.url, { origin: 'https://app.example.com' });
    expect((await good.hello(token())).t).toBe('welcome');
    const bad = await DepClient.connect(p.url, { origin: 'https://evil.example.com' });
    expect((await bad.hello(token())).d).toMatchObject({ code: 'forbidden', fatal: true });
    expect((await bad.closed).code).toBe(4403);
  });

  it('keeps the verdict on a token it did judge', async () => {
    const { p } = await planeWithStorage();
    const doc = await p.createDocument();
    for (const [code, close] of [
      ['unauthenticated', 4401],
      ['token_expired', 4401],
      ['revoked', 4401],
      ['forbidden', 4403],
    ] as const) {
      const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
      p.tokens.refusals.set(token, code);
      const c = await DepClient.connect(p.url);
      expect((await c.hello(token)).d).toMatchObject({ code, fatal: true });
      expect((await c.closed).code).toBe(close);
    }
    const c = await DepClient.connect(p.url);
    expect((await c.hello('tok_unknown')).d).toMatchObject({ code: 'unauthenticated' });
    expect((await c.closed).code).toBe(4401);
  });
});

describe('auth.refresh while the storage is away', () => {
  it('answers unavailable and keeps the session; the next refresh succeeds', async () => {
    const { p, storage } = await planeWithStorage();
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    const fresh = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    storage.tokens = true;
    c.send({ t: 'auth.refresh', id: 'r1', d: { token: fresh } });
    const e = await c.take((m) => m.re === 'r1');
    expect(e.t).toBe('error');
    expect(e.d).toMatchObject({ code: 'unavailable', retryable: true, fatal: false });
    // The session is still open: a ping is answered, and a refresh after the outage is accepted.
    c.send({ t: 'ping', id: 'p1' });
    expect((await c.take((m) => m.re === 'p1')).t).toBe('pong');
    storage.tokens = false;
    c.send({ t: 'auth.refresh', id: 'r2', d: { token: fresh } });
    expect((await c.take((m) => m.re === 'r2')).t).toBe('auth.ok');
    // A token that is refused on its merits still says so.
    const refused = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    p.tokens.refusals.set(refused, 'unauthenticated');
    c.send({ t: 'auth.refresh', id: 'r3', d: { token: refused } });
    expect((await c.take((m) => m.re === 'r3')).d).toMatchObject({ code: 'unauthenticated' });
  });
});
