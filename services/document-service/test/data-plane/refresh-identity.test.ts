// PRO-014 criterion 3 (05 §3.1, §5.1, §5.2; BE-029): a token that comes in with `ch.open`, or with
// `auth.refresh` and `ch`, or a refreshed session token, whose `tid` or `sub` differs from the
// session's is refused, and the token already in force stays in force.
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient, type Received } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');

let planes: Plane[] = [];
async function plane(...args: Parameters<typeof startPlane>): Promise<Plane> {
  const p = await startPlane(...args);
  planes.push(p);
  return p;
}
afterEach(async () => {
  for (const p of planes) await p.close();
  planes = [];
});

async function refresh(c: DepClient, token: string, ch?: number): Promise<Received> {
  const id = c.nextId();
  c.send({ t: 'auth.refresh', id, ...(ch !== undefined ? { ch } : {}), d: { token } });
  return c.take((m) => m.re === id, 3000, 'answer to auth.refresh');
}

describe('a token of another user or tenant never replaces the token in force (PRO-014 criterion 3)', () => {
  it('refuses a ch.open token of another user, and the session token still opens the channel', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = p.tokens.issue({ user: 'bob', docs: { [doc]: 'editor' } });
    const r = await alice.open(1, doc, { token: bob });
    expect(r).toMatchObject({ t: 'ch.rejected', d: { code: 'forbidden' } });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
  });

  it('refuses a ch.open token of another tenant', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const foreign = p.tokens.issue({
      user: 'alice',
      docs: { [doc]: 'owner' },
      tenant: crypto.randomUUID(),
    });
    expect(await alice.open(1, doc, { token: foreign })).toMatchObject({
      t: 'ch.rejected',
      d: { code: 'forbidden' },
    });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
  });

  it('refuses an auth.refresh with ch whose user differs, and the channel keeps its token', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const bob = p.tokens.issue({ user: 'bob', docs: { [doc]: 'editor' } });
    expect(await refresh(alice, bob, 1)).toMatchObject({
      t: 'error',
      d: { code: 'forbidden', fatal: false },
    });
    expect(alice.all('ch.closed', 1)).toHaveLength(0);
    // The token in force is still alice's: her commit is acknowledged.
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
  });

  it('refuses an auth.refresh with ch whose tenant differs', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const foreign = p.tokens.issue({
      user: 'alice',
      docs: { [doc]: 'owner' },
      tenant: crypto.randomUUID(),
    });
    expect(await refresh(alice, foreign, 1)).toMatchObject({
      t: 'error',
      d: { code: 'forbidden', fatal: false },
    });
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
    expect(alice.all('ch.closed', 1)).toHaveLength(0);
  });

  it('refuses a session auth.refresh of another user, keeps the session, and accepts the next valid token', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    expect((await alice.open(1, doc)).t).toBe('ch.opened');
    const bob = p.tokens.issue({ user: 'bob', docs: { [doc]: 'editor' } });
    expect(await refresh(alice, bob)).toMatchObject({
      t: 'error',
      d: { code: 'forbidden', fatal: false },
    });
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
    const own = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    expect((await refresh(alice, own)).t).toBe('auth.ok');
    expect(alice.ws.readyState).toBe(alice.ws.OPEN);
  });
});
