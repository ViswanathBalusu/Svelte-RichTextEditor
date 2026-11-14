// Read restrictions at the data plane (ADR 0019, proposed; PRO-130; S6 gaps G101 to G103). By
// default nothing is hidden, and still every reader goes through the projection gateway and gets a
// keyed view token. With a visibility function that hides a region from one user, that user gets
// content and commits of their class, a token of their own, presence only within the class, and a
// close that says the access changed.
import {
  NOTHING_HIDDEN,
  type HiddenSet,
  type PermissionState,
  type Visibility,
} from '@docedit/authority';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { keyedViewToken } from '../../src/data-plane/index.ts';
import { insertText } from './client.ts';
import { startPlane, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const legal = () => posInside(baseDoc(), 'pLegal000000001B');
const LEGAL = 'rLegal000000000B';

/** Frank may not see the legal region unless a grant names him. */
const hideLegalFromFrank: Visibility = (conn, _doc, perms: PermissionState): HiddenSet =>
  conn.sub === 'frank' && !perms.grants.some((g) => g.principal === 'user:frank')
    ? { regions: new Set([LEGAL]), values: new Set(), titles: false }
    : NOTHING_HIDDEN;

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

describe('content reads carry the view token (G101; D70)', () => {
  it('returns content at the head or a pinned seq with the token of the reader class', async () => {
    const key = new Uint8Array(32).fill(7);
    const p = await plane({ settings: { viewKey: key } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const o = await a.open(1, doc);
    await a.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    const id = p.tokens.identity(p.tokens.issue({ user: 'carol', docs: { [doc]: 'editor' } }));
    const head = await p.plane.readContent(id, doc);
    expect(head).toMatchObject({
      seq: 1,
      incarnation: o.d!['incarnation'],
      cdm: 1,
      requires: ['fields'],
    });
    expect(head.view).toBe(o.d!['view']);
    // One definition of the token, which the REST content route uses with the same key.
    expect(head.view).toBe(keyedViewToken(key, NOTHING_HIDDEN));
    const pinned = await p.plane.readContent(id, doc, 0);
    expect(pinned.seq).toBe(0);
    expect(JSON.stringify(pinned.doc)).not.toContain('xThis');
    expect(JSON.stringify(head.doc)).toContain('xThis');
    await expect(p.plane.readContent(id, doc, 9)).rejects.toMatchObject({ code: 'not_found' });
    const stranger = p.tokens.identity(p.tokens.issue({ user: 'carol', docs: {} }));
    await expect(p.plane.readContent(stranger, doc)).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('lets a client that joined over REST resume a stream with the token of that content', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    await a.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    const tok = p.tokens.issue({ user: 'carol', docs: { [doc]: 'editor' } });
    const content = await p.plane.readContent(p.tokens.identity(tok), doc);
    await a.submit(1, { base: 1, steps: [insertText(intro(), 'y')] });
    const c = await p.client('carol', { [doc]: 'editor' });
    const o = await c.open(1, doc, {
      resume: { seq: content.seq, incarnation: content.incarnation, view: content.view },
    });
    expect(o.d).toMatchObject({ catchUp: 'stream', head: 2 });
    const caught = await c.take((m) => m.t === 'sync.caughtUp');
    expect(caught.d).toEqual({ seq: 2 });
  });
});

describe('a reader who may not see a region (PRO-130)', () => {
  it('gets the projection, a token of its own, and commits of its class with empty steps (G102)', async () => {
    const p = await plane({ deps: { visibility: hideLegalFromFrank } });
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    const frank = await p.client('frank', { [doc]: 'viewer' });
    const oa = await alice.open(1, doc);
    await bob.open(1, doc);
    const of = await frank.open(1, doc);
    expect(of.d!['view']).not.toBe(oa.d!['view']);
    const fc = await p.plane.readContent(
      p.tokens.identity(p.tokens.issue({ user: 'frank', docs: { [doc]: 'viewer' } })),
      doc,
    );
    expect(fc.view).toBe(of.d!['view']);
    expect(JSON.stringify(fc.doc)).toContain('hidden_region');
    expect(JSON.stringify(fc.doc)).not.toContain('Liability');
    // Bob writes inside the hidden region: Frank receives the commit, with no steps.
    await bob.submit(1, { base: 0, steps: [insertText(legal(), 'secret ')] });
    const fcommit = (await frank.take((m) => m.t === 'sync.commit')).d!['commits'][0];
    expect(fcommit).toMatchObject({ seq: 1, kind: 'steps', steps: [] });
    const acommit = (await alice.take((m) => m.t === 'sync.commit')).d!['commits'][0];
    expect(JSON.stringify(acommit.steps)).toContain('secret');
    expect(JSON.stringify(frank.log)).not.toContain('secret');
  });

  it('relays presence only within a visibility class', async () => {
    const p = await plane({ deps: { visibility: hideLegalFromFrank } });
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    const carol = await p.client('carol', { [doc]: 'editor' });
    const frank = await p.client('frank', { [doc]: 'viewer' });
    for (const c of [alice, carol, frank]) await c.open(1, doc);
    alice.send({
      t: 'presence.update',
      ch: 1,
      d: {
        seq: 0,
        state: {
          selection: { anchor: legal(), head: legal() },
          scope: `region:${LEGAL}`,
          status: 'active',
        },
      },
    });
    await carol.take((m) => m.t === 'presence.state');
    await new Promise((r) => setTimeout(r, 100));
    expect(frank.all('presence.state')).toHaveLength(0);
  });

  it('closes the channel with cause access_changed when the class changes, and reloads it (G103; D42)', async () => {
    const p = await plane({ deps: { visibility: hideLegalFromFrank } });
    const doc = await p.createDocument();
    const frank = await p.client('frank', { [doc]: 'viewer' });
    const of = await frank.open(1, doc);
    await p.changeGrants(doc, {
      putGrants: [{ region: LEGAL, principal: 'user:frank', role: 'viewer', expiresAt: null }],
    });
    const closed = await frank.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'unavailable', cause: 'access_changed' });
    const again = await frank.open(2, doc, {
      resume: { seq: of.d!['head'], incarnation: of.d!['incarnation'], view: of.d!['view'] },
    });
    // The old token names the old class: the reader reloads (ADR 0019 change 2).
    expect(again.d).toMatchObject({ catchUp: 'reload' });
    expect(again.d!['view']).not.toBe(of.d!['view']);
  });

  it('refuses a step on the placeholder and names no hidden scope in the rejection (SR-M4)', async () => {
    const { posOf } = await import('../../../../packages/authority/test/fixtures.ts');
    const p = await plane({ deps: { visibility: hideLegalFromFrank } });
    const doc = await p.createDocument();
    // Frank is an editor here, but still may not see the legal region.
    const frank = await p.client('frank', { [doc]: 'editor' });
    await frank.open(1, doc);
    expect((await frank.submit(1, { base: 0, steps: [insertText(intro(), 'x')] })).t).toBe(
      'sync.ack',
    );
    // In Frank's projection the region is one placeholder atom where the region starts.
    const at = posOf(baseDoc(), LEGAL);
    const r = await frank.submit(1, {
      base: 1,
      steps: [{ stepType: 'replace', from: at + 1, to: at + 2 }],
    });
    expect(r.t).toBe('sync.reject');
    expect(r.d!['code']).toBe('permission_denied');
    expect(r.d!['scopes'] ?? []).not.toContain(`region:${LEGAL}`);
  });
});
