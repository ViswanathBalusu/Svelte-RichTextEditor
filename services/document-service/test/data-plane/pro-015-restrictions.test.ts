// PRO-015 criteria 2 and 4 at the data plane, with real WebSocket clients over MemoryStore:
// `access.restrictions` on ch.opened lists exactly the known values of the `restrict` claim, and a
// refreshed token that adds or removes a restriction sends perm.changed carrying the new list.
// Lane U-PRO-001-017.
import { afterEach, describe, expect, it } from 'vitest';
import type { DepClient, Received } from './client.ts';
import { startPlane, type Plane } from './support.ts';

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

async function refresh(c: DepClient, token: string): Promise<Received> {
  const id = c.nextId();
  c.send({ t: 'auth.refresh', id, d: { token } });
  return c.take((m) => m.re === id, 3000, 'answer to auth.refresh');
}

describe('output restrictions on the wire (PRO-015 criteria 2 and 4)', () => {
  it('lists exactly the known restrictions of the token on ch.opened and ignores an unknown value', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await p.client(
      'alice',
      { [doc]: 'owner' },
      {
        restrict: ['no-print', 'no-such-value', 'no-export', 'no-print'],
      },
    );
    const o = await c.open(1, doc);
    expect(o.t).toBe('ch.opened');
    expect(o.d!['access'].restrictions).toEqual(['no-export', 'no-print']);
  });

  it('lists no restriction when the token carries none, or only unknown values', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const none = await p.client('alice', { [doc]: 'owner' });
    expect((await none.open(1, doc)).d!['access'].restrictions).toEqual([]);
    const unknown = await p.client('bob', { [doc]: 'owner' }, { restrict: ['x-other'] });
    expect((await unknown.open(1, doc)).d!['access'].restrictions).toEqual([]);
  });

  it('sends perm.changed with the new restrictions when a refresh adds one, and again when it removes them', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'owner' });
    const first = await bob.open(1, doc);
    expect(first.d!['access'].restrictions).toEqual([]);

    const added = p.tokens.issue({ user: 'bob', docs: { [doc]: 'owner' }, restrict: ['no-copy'] });
    expect((await refresh(bob, added)).t).toBe('auth.ok');
    const up = await bob.take((m) => m.t === 'perm.changed' && m.ch === 1);
    expect(up.d!['restrictions']).toEqual(['no-copy']);
    expect(bob.all('ch.closed', 1)).toHaveLength(0);

    const removed = p.tokens.issue({ user: 'bob', docs: { [doc]: 'owner' } });
    expect((await refresh(bob, removed)).t).toBe('auth.ok');
    const down = await bob.take(
      (m) =>
        m.t === 'perm.changed' &&
        m.ch === 1 &&
        m.d!['restrictions'] !== undefined &&
        m.d!['restrictions'].length === 0,
    );
    expect(down.d!['restrictions']).toEqual([]);
  });

  it('sends nothing for a refresh that keeps the same restrictions and role', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'owner' }, { restrict: ['no-export'] });
    await bob.open(1, doc);
    const again = p.tokens.issue({
      user: 'bob',
      docs: { [doc]: 'owner' },
      restrict: ['no-export'],
    });
    expect((await refresh(bob, again)).t).toBe('auth.ok');
    expect(bob.all('perm.changed', 1)).toHaveLength(0);
  });
});
