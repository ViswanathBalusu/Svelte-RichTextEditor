// Channels and sync through the data plane, with real WebSocket clients over MemoryStore (05 §5.2,
// §5.3; PRO-023, PRO-027, PRO-028, PRO-029; SYN-014, SYN-015; BE-024): opening and every refusal,
// the catch-up stream, acknowledgements and their order, rejections and their actions, broadcasts
// with server attribution, duplicates, `inflight` on resume, and group commit.
import { isUuid7, uuid7 } from '@docedit/model';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import { insertText, type DepClient, type Received } from './client.ts';
import { GatedLogStore, memoryStores, startPlane, until, type Plane } from './support.ts';

const intro = () => posInside(baseDoc(), 'pIntro0000000001');
const legal = () => posInside(baseDoc(), 'pLegal000000001B');

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

/** Messages on a channel in arrival order, without the session's own. */
const onChannel = (c: DepClient, ch: number) => c.log.filter((m) => m.ch === ch);

describe('opening a document channel (PRO-023)', () => {
  it('answers ch.open with ch.opened: head, incarnation, reload without resume, access and a view', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    const o = await c.open(1, doc);
    expect(o.t).toBe('ch.opened');
    expect(o.ch).toBe(1);
    const d = o.d!;
    expect(d['head']).toBe(0);
    expect(d['catchUp']).toBe('reload');
    expect(d['incarnation']).toBe((await p.stores.logs.head(p.ref(doc))).incarnation);
    expect(d['inflight']).toBeUndefined();
    expect(typeof d['view']).toBe('string');
    expect(d['view']).toMatch(/^v1\./);
    // PRO-032: rev, asOfSeq, docRole, caps, scopes for every region and body and defs, leases, fill, restrictions.
    expect(d['access']).toMatchObject({
      rev: 1,
      asOfSeq: 0,
      docRole: 'owner',
      caps: ['view', 'comment', 'suggest', 'edit', 'fill', 'structure', 'manage'],
      leases: {},
      fill: null,
      restrictions: [],
    });
    expect(Object.keys(d['access'].scopes).sort()).toEqual(
      [
        'body',
        'defs',
        'doc',
        'region:rLegal000000000B',
        'region:rNotes000000000C',
        'region:rTerms000000000A',
      ].sort(),
    );
  });

  it.each([
    ['not_found', 'an unknown document'],
    ['forbidden', 'a document the token gives no role in'],
    ['unsupported_engine', 'an unknown engine'],
    ['unsupported_cdm', 'a CDM version outside the server range'],
    ['unsupported_feature', 'a document requiring a feature the client did not announce'],
    ['already_open', 'a second channel for the same document'],
    ['channel_limit', 'more channels than maxChannels'],
  ])('refuses with %s: %s', async (code) => {
    const p = await plane({ settings: { limits: { maxChannels: 1 } } });
    const doc = await p.createDocument();
    const other = await p.createDocument();
    // A token may name a document that does not exist; one it does not name is `forbidden`.
    const missing = uuid7();
    const c = await p.client('alice', { [doc]: 'owner', [other]: 'owner', [missing]: 'owner' });
    let r: Received;
    switch (code) {
      case 'not_found':
        r = await c.open(1, missing);
        break;
      case 'forbidden': {
        const c2 = await p.client('bob', { [other]: 'editor' });
        r = await c2.open(1, doc);
        break;
      }
      case 'unsupported_engine':
        r = await c.open(1, doc, { engine: 'yjs/1' });
        break;
      case 'unsupported_cdm':
        r = await c.open(1, doc, { cdm: 2 });
        break;
      case 'unsupported_feature':
        r = await c.open(1, doc, { features: ['presence'] });
        break;
      case 'already_open':
        await c.open(1, doc);
        r = await c.open(2, doc);
        break;
      default:
        await c.open(1, doc);
        r = await c.open(2, other);
    }
    expect(r.t).toBe('ch.rejected');
    expect(r.d!['code']).toBe(code);
    expect(typeof r.d!['message']).toBe('string');
  });

  it('refuses with unavailable when the room cannot be opened', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const lost = await p.createDocument();
    // No content at sequence number 0 for this one: the room has nothing to start from.
    await p.checkpoints.put(p.ref(lost), 0, null as never);
    const c = await p.client('alice', { [doc]: 'owner', [lost]: 'owner' });
    const r = await c.open(1, lost);
    expect(r).toMatchObject({ t: 'ch.rejected', d: { code: 'unavailable' } });
    expect((await c.open(2, doc)).t).toBe('ch.opened');
  });

  it('streams from resume.seq + 1 to head, then sync.caughtUp, then live commits from head + 1', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const first = await a.open(1, doc);
    for (let i = 0; i < 3; i++)
      await a.submit(1, { base: i, steps: [insertText(intro(), 'abc'[i]!)] });
    const b = await p.client('carol', { [doc]: 'editor' });
    const o = await b.open(1, doc, {
      resume: { seq: 1, incarnation: first.d!['incarnation'], view: first.d!['view'] },
    });
    expect(o.d).toMatchObject({ head: 3, catchUp: 'stream' });
    const caught = await b.take((m) => m.t === 'sync.caughtUp');
    expect(caught.d).toEqual({ seq: 3 });
    const before = onChannel(b, 1).filter((m) => m.t === 'sync.commit');
    expect(before.flatMap((m) => m.d!['commits'].map((x: { seq: number }) => x.seq))).toEqual([
      2, 3,
    ]);
    await a.submit(1, { base: 3, steps: [insertText(intro(), 'd')] });
    const live = await b.take((m) => m.t === 'sync.commit' && m.d!['commits'][0].seq === 4);
    expect(live.d!['commits'].map((x: { seq: number }) => x.seq)).toEqual([4]);
  });

  it('reloads a resume whose view token is missing or foreign, and one from another incarnation', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const first = await a.open(1, doc);
    await a.submit(1, { base: 0, steps: [insertText(intro(), 'x')] });
    const inc = first.d!['incarnation'];
    const b = await p.client('carol', { [doc]: 'editor' });
    expect((await b.open(1, doc, { resume: { seq: 0, incarnation: inc } })).d!['catchUp']).toBe(
      'reload',
    );
    const c = await p.client('carol', { [doc]: 'editor' });
    expect(
      (await c.open(1, doc, { resume: { seq: 0, incarnation: inc, view: 'v1.forged' } })).d![
        'catchUp'
      ],
    ).toBe('reload');
    const e = await p.client('carol', { [doc]: 'editor' });
    expect(
      (
        await e.open(1, doc, {
          resume: { seq: 0, incarnation: crypto.randomUUID(), view: first.d!['view'] },
        })
      ).d!['catchUp'],
    ).toBe('reload');
  });

  it('answers inflight on resume: accepted with seq for the caller own stored commit, unknown otherwise (D08)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const first = await a.open(1, doc);
    const id = uuid7();
    await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'x')] });
    const resume = (inflight: string) => ({
      seq: 1,
      incarnation: first.d!['incarnation'],
      view: first.d!['view'],
      inflight,
    });
    const again = await p.client('alice', { [doc]: 'owner' });
    expect((await again.open(1, doc, { resume: resume(id) })).d!['inflight']).toEqual({
      state: 'accepted',
      seq: 1,
    });
    const other = await p.client('carol', { [doc]: 'editor' });
    expect((await other.open(1, doc, { resume: resume(id) })).d!['inflight']).toEqual({
      state: 'unknown',
    });
    const never = await p.client('alice', { [doc]: 'owner' });
    // Present on a reload as well, whatever the catch-up mode (D08).
    expect(
      (await never.open(1, doc, { resume: { seq: 0, incarnation: 'other', inflight: uuid7() } })).d,
    ).toMatchObject({ catchUp: 'reload', inflight: { state: 'unknown' } });
  });
});

describe('submitting and acknowledging (PRO-027, SYN-015)', () => {
  it('acknowledges with id, seq, serverTime and rebased, re the submit, after storage', async () => {
    const mem = memoryStores().memory;
    const gated = new GatedLogStore(mem);
    const p = await plane({ stores: { logs: gated, ownership: mem, grants: mem, documents: mem } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const b = await p.client('carol', { [doc]: 'editor' });
    await a.open(1, doc);
    await b.open(1, doc);
    gated.hold = true;
    const commit = uuid7();
    const env = a.submitNoWait(1, {
      id: commit,
      base: 0,
      steps: [insertText(intro(), 'x')],
      origin: 'paste',
    });
    await until(() => gated.pending === 1, 2000, 'the write');
    // Nothing is acknowledged or broadcast before the write succeeded (G2).
    await new Promise((r) => setTimeout(r, 50));
    expect(a.log.some((m) => m.re === env)).toBe(false);
    expect(b.all('sync.commit')).toHaveLength(0);
    await gated.release();
    const ack = await a.take((m) => m.re === env);
    expect(ack.t).toBe('sync.ack');
    // The full view gets the room's own acknowledgement: a commit made on the head is not rebased
    // and carries no steps (the gateway since 2026-11-06; conformance kit `core.sync.ack`).
    expect(ack.d).toMatchObject({ id: commit, seq: 1, rebased: false });
    expect(ack.d!['serverTime']).toMatch(/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/);
    expect(ack.d!['steps']).toBeUndefined();
    const sc = await b.take((m) => m.t === 'sync.commit');
    const rc = sc.d!['commits'][0];
    const session = a.log.find((m) => m.t === 'welcome')!.d!['session'];
    expect(rc).toEqual({
      seq: 1,
      kind: 'steps',
      id: commit,
      steps: [insertText(intro(), 'x')],
      control: null,
      // The host's `sub` on the wire, the surrogate in the log (D42).
      author: { user: 'host-alice', session, agent: null },
      serverTime: ack.d!['serverTime'],
      origin: 'paste',
    });
  });

  it('rejects a second submit while one is in flight with busy and action retry', async () => {
    const mem = memoryStores().memory;
    const gated = new GatedLogStore(mem);
    const p = await plane({ stores: { logs: gated, ownership: mem, grants: mem, documents: mem } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    gated.hold = true;
    const first = a.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'x')] });
    const second = await a.submit(1, { base: 0, steps: [insertText(intro(), 'y')] });
    expect(second).toMatchObject({
      t: 'sync.reject',
      d: { code: 'busy', action: 'retry', head: 0 },
    });
    await gated.release();
    expect((await a.take((m) => m.re === first)).t).toBe('sync.ack');
  });

  it('rebuilds the acknowledgement of a stored commit resubmitted by its author, with steps', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    const id = uuid7();
    const ack = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'x')] });
    const dup = await a.submit(1, { id, base: 0, steps: [insertText(intro(), 'x')] });
    expect(dup.t).toBe('sync.ack');
    expect(dup.d).toMatchObject({ id, seq: ack.d!['seq'], rebased: true });
    expect(dup.d!['steps']).toEqual([insertText(intro(), 'x')]);
    expect((await p.stores.logs.read(p.ref(doc))).length).toBe(1);
    // Another user replaying the identifier is refused (07 §16).
    const m = await p.client('mallory', { [doc]: 'editor' });
    await m.open(1, doc);
    expect((await m.submit(1, { id, base: 1, steps: [insertText(intro(), 'y')] })).d).toMatchObject(
      {
        code: 'invalid_op',
      },
    );
  });

  it('rejects commits above maxStepsPerCommit or maxCommitBytes with too_large and drop (PRO-022)', async () => {
    const p = await plane({ settings: { limits: { maxStepsPerCommit: 3, maxCommitBytes: 2000 } } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    const many = await a.submit(1, {
      base: 0,
      steps: [1, 2, 3, 4].map(() => insertText(intro(), 'x')),
    });
    expect(many.d).toMatchObject({ code: 'too_large', action: 'drop' });
    const big = await a.submit(1, { base: 0, steps: [insertText(intro(), 'x'.repeat(3000))] });
    expect(big.d).toMatchObject({ code: 'too_large', action: 'drop' });
  });

  it('sends every message of a channel in seq order: an ack never before a lower commit (SYN-015)', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const users = ['alice', 'carol', 'bob'] as const;
    const clients: DepClient[] = [];
    for (const u of users) {
      const c = await p.client(u, { [doc]: u === 'alice' ? 'owner' : 'editor' });
      await c.open(1, doc);
      clients.push(c);
    }
    // Concurrent typing at stale bases: the room rebases and orders.
    await Promise.all(
      clients.flatMap((c, i) =>
        [0, 1, 2].map((k) =>
          c.submit(1, { base: 0, steps: [insertText(intro(), `${i}${k}`)] }).catch(() => null),
        ),
      ),
    );
    await until(() =>
      clients.every((c) => c.all('sync.ack').length + c.all('sync.reject').length >= 1),
    );
    for (const c of clients) {
      let last = 0;
      for (const m of onChannel(c, 1)) {
        if (m.t === 'sync.commit')
          for (const x of m.d!['commits']) {
            expect(x.seq).toBe(last + 1);
            last = x.seq;
          }
        if (m.t === 'sync.ack') {
          expect(m.d!['seq']).toBeLessThanOrEqual(last + 1);
          if (m.d!['seq'] === last + 1) last = m.d!['seq'];
        }
        if (m.t === 'sync.reject') expect(m.d!['head']).toBeLessThanOrEqual(last);
      }
    }
  });
});

describe('rejections (PRO-028)', () => {
  it('carries id, code, message, action, head and re; permission_denied names the scopes', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const carol = await p.client('carol', { [doc]: 'editor' });
    await carol.open(1, doc);
    const id = uuid7();
    const r = await carol.submit(1, { id, base: 0, steps: [insertText(legal(), 'pwned ')] });
    expect(r.t).toBe('sync.reject');
    expect(r.d).toMatchObject({
      id,
      code: 'permission_denied',
      action: 'drop',
      head: 0,
      scopes: ['region:rLegal000000000B'],
    });
    expect(typeof r.d!['message']).toBe('string');
    expect(r.d!['rule']).toBeUndefined();
    expect(r.d!['retryAfterMs']).toBeUndefined();
    // Nothing was stored, and the same commit sent again is checked again (PRM-020).
    expect(
      (await carol.submit(1, { id, base: 0, steps: [insertText(legal(), 'pwned ')] })).d,
    ).toMatchObject({
      code: 'permission_denied',
    });
    expect(await p.stores.logs.read(p.ref(doc))).toEqual([]);
  });

  it('gives invalid_op with drop for a disallowed step, and reload for a base ahead of the head', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    expect(
      (await a.submit(1, { base: 0, steps: [{ stepType: 'docAttr', attr: 'x', value: 1 }] })).d,
    ).toMatchObject({
      code: 'invalid_op',
      action: 'drop',
    });
    expect((await a.submit(1, { base: 7, steps: [insertText(intro(), 'x')] })).d).toMatchObject({
      code: 'invalid_op',
      action: 'reload',
    });
  });

  it('answers a submit on a channel that is not open with a non-fatal error', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const r = await a.submit(9, { base: 0, steps: [insertText(intro(), 'x')] });
    expect(r).toMatchObject({ t: 'error', ch: 9, d: { code: 'bad_message', fatal: false } });
  });
});

describe('broadcasts and attribution (PRO-029, SYN-014)', () => {
  it('stamps the author from the connection and records the client origin only as a claim', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const b = await p.client('carol', { [doc]: 'editor' });
    await a.open(1, doc);
    await b.open(1, doc);
    a.send({
      t: 'sync.submit',
      id: 'forge',
      ch: 1,
      d: {
        id: uuid7(),
        base: 0,
        steps: [insertText(intro(), 'x')],
        origin: 'assistant',
        user: 'carol',
        session: 'forged',
        agent: 'robot',
        time: 0,
        author: { user: 'carol' },
      },
    });
    await a.take((m) => m.re === 'forge');
    const c = (await b.take((m) => m.t === 'sync.commit')).d!['commits'][0];
    expect(c.author.user).toBe('host-alice');
    expect(c.author.session).toBe(a.log.find((m) => m.t === 'welcome')!.d!['session']);
    expect(c.author.agent).toBeNull();
    expect(c.origin).toBe('assistant');
    const stored = (await p.stores.logs.read(p.ref(doc)))[0]!;
    expect(stored.user).toBe('alice');
    expect(isUuid7(stored.session)).toBe(true);
    expect(Math.abs(stored.time - Date.now())).toBeLessThan(10_000);
  });

  it('coalesces consecutive commits for a channel into one ascending array', async () => {
    const mem = memoryStores().memory;
    const gated = new GatedLogStore(mem);
    const p = await plane({ stores: { logs: gated, ownership: mem, grants: mem, documents: mem } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const c2 = await p.client('carol', { [doc]: 'editor' });
    const d = await p.client('bob', { [doc]: 'editor' });
    const watcher = await p.client('frank', { [doc]: 'viewer' });
    for (const c of [a, c2, d, watcher]) await c.open(1, doc);
    gated.hold = true;
    a.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'a')] });
    await until(() => gated.pending === 1);
    // These arrive while the first write is in flight: they join the next write (BE-024).
    c2.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'c')] });
    d.submitNoWait(1, { base: 0, steps: [insertText(intro(), 'd')] });
    await new Promise((r) => setTimeout(r, 50));
    await gated.release();
    await until(() => gated.pending === 1);
    expect(gated.requests[1]!.commits).toHaveLength(2);
    await gated.release();
    await until(() => watcher.all('sync.commit').flatMap((m) => m.d!['commits']).length === 3);
    const batches = watcher
      .all('sync.commit')
      .map((m) => m.d!['commits'].map((x: { seq: number }) => x.seq));
    expect(batches).toEqual([[1], [2, 3]]);
    expect(gated.maxInFlight).toBe(1);
  });
});
