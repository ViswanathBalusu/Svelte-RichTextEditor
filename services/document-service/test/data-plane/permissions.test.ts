// Permission changes through the data plane (07 §4, §9; 05 §5.5; PRM-006, PRM-019, PRM-020;
// PRO-032, PRO-033; SYN-004; BE-026): the control commit and then perm.changed, a lost notification
// caught by the conditional write, each trigger of a new access, and expiry without an event.
import { uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient, type Received } from './client.ts';
import { startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const legal = () => posInside(baseDoc(), 'pLegal000000001B');
const LEGAL = 'region:rLegal000000000B';

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

const commits = (c: DepClient, ch = 1) =>
  c.all('sync.commit', ch).flatMap((m) => m.d!['commits'] as Array<Record<string, any>>); // eslint-disable-line @typescript-eslint/no-explicit-any
const accesses = (c: DepClient, ch = 1): Received[] => c.all('perm.changed', ch);

async function room(p: Plane) {
  const doc = await p.createDocument();
  const alice = await p.client('alice', { [doc]: 'owner' });
  const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
  const frank = await p.client('frank', { [doc]: 'viewer' });
  const opened = new Map<DepClient, Received>();
  for (const c of [alice, bob, frank]) opened.set(c, await c.open(1, doc));
  return { doc, alice, bob, frank, opened };
}

describe('a grant change with its notification (PRM-019, PRO-033, SYN-004)', () => {
  it('records a control commit, then sends perm.changed with a higher rev and asOfSeq at that commit', async () => {
    const p = await plane();
    const { doc, bob, frank, opened } = await room(p);
    expect(opened.get(bob)!.d!['access'].scopes[LEGAL]).toContain('edit');
    await p.changeGrants(doc, {
      removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }],
    });
    for (const c of [bob, frank]) {
      const pc = await c.take((m) => m.t === 'perm.changed');
      const control = commits(c).find((x) => x.kind === 'control');
      expect(control).toMatchObject({
        kind: 'control',
        steps: [],
        control: { type: 'grants', rev: 2 },
        author: { user: 'system', session: null, agent: null },
        origin: 'control',
      });
      // The control commit is in the stream before perm.changed (05 §5.9; D12).
      const iCommit = c.log.findIndex(
        (m) =>
          m.t === 'sync.commit' &&
          m.d!['commits'].some((x: { kind: string }) => x.kind === 'control'),
      );
      expect(iCommit).toBeLessThan(c.log.indexOf(pc));
      expect(pc.d!['asOfSeq']).toBe(control!.seq);
      expect(pc.d!['rev']).toBe(2);
      // A complete access object, not a delta (PRO-033).
      expect(Object.keys(pc.d!).sort()).toEqual(
        ['asOfSeq', 'caps', 'docRole', 'fill', 'leases', 'restrictions', 'rev', 'scopes'].sort(),
      );
    }
    const pc = accesses(bob).at(-1)!;
    expect(pc.d!['scopes'][LEGAL]).not.toContain('edit');
    // The server enforces the new permissions at once; the grant was not in the token.
    const r = await bob.submit(1, { base: 1, steps: [insertText(legal(), 'late ')] });
    expect(r.d).toMatchObject({ code: 'permission_denied', action: 'drop', scopes: [LEGAL] });
    // No collateral effect: Bob may still edit the body (PRM-020).
    expect((await bob.submit(1, { base: 1, steps: [insertText(intro(), 'ok ')] })).t).toBe(
      'sync.ack',
    );
    const stored = await p.stores.logs.read(p.ref(doc));
    expect(stored.map((c) => [c.kind, c.revision])).toEqual([
      ['control', 2],
      ['steps', 2],
    ]);
  });

  it('enforces new permissions for a commit sent before perm.changed reached the client (PRO-033)', async () => {
    const p = await plane();
    const { doc, bob } = await room(p);
    const change = p.changeGrants(doc, {
      removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }],
    });
    await change;
    // Bob has not read perm.changed; his commit is checked against what the server computed.
    const r = await bob.submit(1, { base: 0, steps: [insertText(legal(), 'x')] });
    expect(r.d).toMatchObject({ code: 'permission_denied' });
  });

  it('keeps rev increasing on a channel over several changes (PRO-033)', async () => {
    const p = await plane();
    const { doc, frank } = await room(p);
    for (let i = 0; i < 3; i++)
      await p.changeGrants(doc, {
        putGrants: [
          { region: 'rNotes000000000C', principal: `user:u${i}`, role: 'viewer', expiresAt: null },
        ],
      });
    await until(() => accesses(frank).length === 3);
    expect(accesses(frank).map((m) => m.d!['rev'])).toEqual([2, 3, 4]);
    const controls = commits(frank).filter((x) => x.kind === 'control');
    expect(controls.map((x) => x.control.rev)).toEqual([2, 3, 4]);
    expect(accesses(frank).map((m) => m.d!['asOfSeq'])).toEqual(controls.map((x) => x.seq));
  });

  it('records the control commit even when the change affects nobody connected (PRM-019)', async () => {
    const p = await plane();
    const { doc } = await room(p);
    await p.changeGrants(doc, {
      putGrants: [
        { region: 'rNotes000000000C', principal: 'user:nobody', role: 'viewer', expiresAt: null },
      ],
    });
    await new Promise((r) => setTimeout(r, 50));
    const log = await p.stores.logs.read(p.ref(doc));
    expect(log.map((c) => c.kind)).toEqual(['control']);
  });
});

describe('a lost notification (BE-026, PRM-019, PRM-020)', () => {
  it('refuses the write under the old revision, rejects with unavailable, and checks the resubmission against the new grants', async () => {
    const p = await plane();
    const { doc, bob } = await room(p);
    // The control plane writes the change but the announcement to the room is lost.
    await p.changeGrants(
      doc,
      { removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }] },
      false,
    );
    const id = uuid7();
    const first = await bob.submit(1, { id, base: 0, steps: [insertText(legal(), 'x')] });
    expect(first.d).toMatchObject({ id, code: 'unavailable', action: 'retry' });
    // The room took the permissions from storage, recorded them and told the channels.
    await bob.take((m) => m.t === 'perm.changed');
    const again = await bob.submit(1, { id, base: 1, steps: [insertText(legal(), 'x')] });
    expect(again.d).toMatchObject({ code: 'permission_denied' });
    const log = await p.stores.logs.read(p.ref(doc));
    expect(log.every((c) => c.revision === 2)).toBe(true);
    expect(log.some((c) => c.kind === 'steps')).toBe(false);
  });

  it('opens a room with the revision stored while no room was open (PRM-019; D125 at head 0)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    await p.changeGrants(
      doc,
      { removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }] },
      false,
    );
    const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    const o = await bob.open(1, doc);
    // No commit was checked against the older revision, so none records the newer one (D125).
    expect(o.d!['head']).toBe(0);
    expect(o.d!['access'].scopes[LEGAL]).not.toContain('edit');
    expect((await bob.submit(1, { base: 0, steps: [insertText(legal(), 'x')] })).d).toMatchObject({
      code: 'permission_denied',
    });
    expect((await bob.submit(1, { base: 0, steps: [insertText(intro(), 'y')] })).t).toBe(
      'sync.ack',
    );
    const log = await p.stores.logs.read(p.ref(doc));
    expect(log.map((c) => [c.seq, c.kind, c.revision])).toEqual([[1, 'steps', 2]]);
  });

  it('records the control commit first when commits were checked against the older revision (04 G7)', async () => {
    const p = await plane({ settings: { roomIdleMs: 20 } });
    const doc = await p.createDocument();
    const alice = await p.client('alice', { [doc]: 'owner' });
    await alice.open(1, doc);
    expect((await alice.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
    alice.send({ t: 'ch.close', ch: 1 });
    await until(() => p.plane.host.rooms.length === 0, 3000, 'the idle room to close');
    await p.changeGrants(
      doc,
      { removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }] },
      false,
    );
    const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    await bob.open(1, doc);
    // The revision's control commit is recorded first, before any commit checked against it.
    expect((await bob.submit(1, { base: 2, steps: [insertText(intro(), 'y')] })).t).toBe(
      'sync.ack',
    );
    const log = await p.stores.logs.read(p.ref(doc));
    expect(log.map((c) => [c.seq, c.kind, c.revision])).toEqual([
      [1, 'steps', 1],
      [2, 'control', 2],
      [3, 'steps', 2],
    ]);
  });
  it('tells open channels that the document resource changed (05 §5.6)', async () => {
    const p = await plane();
    const { doc, alice } = await room(p);
    await p.changeGrants(doc, { documentState: 'locked' });
    p.plane.documentChanged(p.ref(doc));
    const e = await alice.take((m) => m.t === 'event');
    expect(e.d).toEqual({ type: 'document.updated', resource: `/documents/${doc}` });
  });

  it('brings a room up to the revision in storage when a channel opens (ADR 0019 change 3)', async () => {
    const p = await plane();
    const { doc } = await room(p);
    await p.changeGrants(
      doc,
      { removeGrants: [{ region: 'rLegal000000000B', principal: 'group:legal' }] },
      false,
    );
    const bob2 = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    const o = await bob2.open(2, doc);
    expect(o.d!['access'].scopes[LEGAL]).not.toContain('edit');
  });
});

describe('each trigger of a new access (PRM-006, PRO-032)', () => {
  it('a region state: approving a region limits it to view and comment', async () => {
    const p = await plane();
    const { doc, alice } = await room(p);
    await p.changeGrants(doc, {
      setRegionStates: [{ region: 'rTerms000000000A', state: 'approved' }],
    });
    const pc = await alice.take((m) => m.t === 'perm.changed');
    expect(pc.d!['scopes']['region:rTerms000000000A']).toEqual(['view', 'comment']);
  });

  it('a lease: the holder appears in access.leases and others lose edit', async () => {
    const p = await plane();
    const { doc, bob } = await room(p);
    const expiresAt = Date.now() + 600_000;
    await p.changeGrants(doc, {
      putLeases: [{ region: 'rNotes000000000C', holder: 'alice', expiresAt }],
    });
    const pc = await bob.take((m) => m.t === 'perm.changed');
    expect(pc.d!['leases']).toEqual({
      // The holder is stored as the surrogate and shown as the host's `sub` (D42).
      'region:rNotes000000000C': {
        holder: 'host-alice',
        expiresAt: new Date(expiresAt).toISOString(),
      },
    });
    expect(pc.d!['scopes']['region:rNotes000000000C']).not.toContain('edit');
  });

  it('the document state: a locked document answers commits with read_only', async () => {
    const p = await plane();
    const { doc, alice } = await room(p);
    await p.changeGrants(doc, { documentState: 'locked' });
    const pc = await alice.take((m) => m.t === 'perm.changed');
    expect(pc.d!['scopes']['body']).not.toContain('edit');
    expect((await alice.submit(1, { base: 1, steps: [insertText(intro(), 'x')] })).d).toMatchObject(
      {
        code: 'read_only',
        action: 'drop',
      },
    );
  });

  it('the region list: a stored commit that adds a region is followed by perm.changed listing it', async () => {
    const p = await plane();
    const { alice, frank } = await room(p);
    const d = baseDoc();
    const end = d.content.size - 1;
    const region = {
      type: 'region',
      attrs: { id: 'rNew000000000001' },
      content: [
        {
          type: 'paragraph',
          attrs: { id: 'pNew000000000001' },
          content: [{ type: 'text', text: 'new' }],
        },
      ],
    };
    const ack = await alice.submit(1, {
      base: 0,
      steps: [{ stepType: 'replace', from: end, to: end, slice: { content: [region] } }],
    });
    expect(ack.t).toBe('sync.ack');
    const pc = await frank.take((m) => m.t === 'perm.changed');
    expect(pc.d!['asOfSeq']).toBeGreaterThanOrEqual(ack.d!['seq']);
    expect(Object.keys(pc.d!['scopes'])).toContain('region:rNew000000000001');
  });

  it('an expiry: perm.changed arrives when a grant expires, with no other event (PRO-033)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    await p.changeGrants(doc, {
      putGrants: [
        {
          region: 'rLegal000000000B',
          principal: 'user:carol',
          role: 'editor',
          expiresAt: Date.now() + 2000,
        },
      ],
    });
    const carol = await p.client('carol', { [doc]: 'editor' });
    const o = await carol.open(1, doc);
    expect(o.d!['access'].scopes[LEGAL]).toContain('edit');
    const pc = await carol.take((m) => m.t === 'perm.changed', 5000);
    expect(pc.d!['scopes'][LEGAL]).not.toContain('edit');
    expect(pc.d!['rev']).toBe(2);
    expect((await carol.submit(1, { base: 0, steps: [insertText(legal(), 'x')] })).d).toMatchObject(
      {
        code: 'permission_denied',
      },
    );
  });

  /** A complete access object (05 §5.5) with a `rev` above the one the channel opened with. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const complete = (d: Record<string, any>, opened: Received) => {
    expect(d['rev']).toBeGreaterThan(opened.d!['access'].rev as number);
    expect(typeof d['asOfSeq']).toBe('number');
    expect(typeof d['docRole']).toBe('string');
    expect(Array.isArray(d['caps'])).toBe(true);
    // Every region of the document, and the two scopes outside regions.
    expect(Object.keys(d['scopes']).sort()).toEqual(Object.keys(opened.d!['access'].scopes).sort());
    expect(Object.keys(d['scopes'])).toEqual(
      expect.arrayContaining(['body', 'defs', 'region:rTerms000000000A', LEGAL]),
    );
    expect(d['leases']).toEqual({});
    expect(d['restrictions']).toEqual([]);
    expect(d).toHaveProperty('fill');
  };

  it('the workflow: starting it sends a complete access with a higher rev', async () => {
    const p = await plane();
    const { doc, alice, bob, opened } = await room(p);
    // Bob edits the legal region through his group while no workflow runs.
    expect(opened.get(bob)!.d!['access'].scopes[LEGAL]).toContain('edit');
    await p.changeGrants(doc, { workflowActive: true, documentState: 'locked' });
    for (const c of [alice, bob]) {
      const pc = await c.take((m) => m.t === 'perm.changed');
      complete(pc.d!, opened.get(c)!);
      // 07 §4, limit 1: a running workflow leaves view and comment on the content.
      expect(pc.d!['scopes']['body']).toEqual(['view', 'comment']);
      expect(pc.d!['scopes'][LEGAL]).toEqual(['view', 'comment']);
      expect(accesses(c)).toHaveLength(1);
    }
  });

  it('a refreshed token: a lower role in the next token sends a complete access with a higher rev', async () => {
    const p = await plane();
    const { doc, bob, opened } = await room(p);
    const id = bob.nextId();
    bob.send({
      t: 'auth.refresh',
      id,
      d: { token: p.tokens.issue({ user: 'bob', docs: { [doc]: 'viewer' }, groups: [] }) },
    });
    await bob.take((m) => m.re === id, 3000, 'answer to auth.refresh');
    const pc = await bob.take((m) => m.t === 'perm.changed' && m.ch === 1);
    complete(pc.d!, opened.get(bob)!);
    expect(pc.d).toMatchObject({ docRole: 'viewer', caps: ['view'] });
    expect(pc.d!['scopes']['body']).toEqual(['view']);
    expect(pc.d!['scopes'][LEGAL]).not.toContain('edit');
    expect(accesses(bob)).toHaveLength(1);
  });
});

describe('revocation of one document (05 §3.3)', () => {
  it('closes that user channels on the document with forbidden', async () => {
    const p = await plane();
    const { doc, bob, frank } = await room(p);
    p.plane.sessionsRevoked(p.tenant, 'bob', doc);
    const closed = await bob.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'forbidden' });
    expect(frank.all('ch.closed')).toHaveLength(0);
    expect(bob.ws.readyState).toBe(bob.ws.OPEN);
  });
});
