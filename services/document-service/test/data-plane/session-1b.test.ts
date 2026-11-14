// The session's phase 1b behaviour with real WebSocket clients over MemoryStore (packet A):
// features (PRO-006; D120, D121), roles through token refresh (PRM-021), bounded send queues
// (BE-027), rate limits (BE-030), chunking (PRO-018), keep-alive (PRO-019), closing channels and
// draining (PRO-024) and traces (PRO-044, BE-087).
import { uuid7 } from '@docedit/model';
import { chunkMessage } from '@docedit/protocol';
import { afterEach, describe, expect, it } from 'vitest';
import { baseDoc, posInside } from '../../../../packages/authority/test/fixtures.ts';
import type { Span } from '../../src/seams.ts';
import { DepClient, insertText, type Received } from './client.ts';
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

async function refresh(c: DepClient, token: string, ch?: number): Promise<Received> {
  const id = c.nextId();
  c.send({ t: 'auth.refresh', id, ...(ch !== undefined ? { ch } : {}), d: { token } });
  return c.take((m) => m.re === id, 3000, 'answer to auth.refresh');
}

describe('features (PRO-006 criterion 5; 03 §11.1; D120, D121)', () => {
  it('rejects a ch.open that names a feature the server did not announce', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    const r = await c.open(1, doc, { features: ['fields', 'x-unannounced'] });
    expect(r).toMatchObject({ t: 'ch.rejected', d: { code: 'unsupported_feature' } });
    expect(r.d!['message']).toContain('x-unannounced');
  });

  it('rejects a client that lacks a feature the document requires, and keeps what each channel announced', async () => {
    const p = await plane();
    const doc = await p.createDocument({ requires: ['fields', 'extensions'] });
    const c = await p.client('alice', { [doc]: 'owner' });
    const r = await c.open(1, doc, { features: ['fields'] });
    expect(r).toMatchObject({ t: 'ch.rejected', d: { code: 'unsupported_feature' } });
    expect(r.d!['message']).toContain('extensions');
    expect((await c.open(2, doc, { features: ['fields', 'extensions', 'presence'] })).t).toBe(
      'ch.opened',
    );
    expect(p.plane.host.get(p.ref(doc))!.clientFeatures).toEqual([
      ['fields', 'extensions', 'presence'],
    ]);
  });
});

describe('roles and groups through token refresh (PRM-021)', () => {
  it('sends perm.changed for a lower role, keeps the channel open, and applies the new role', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'editor' }, { groups: ['legal'] });
    const o = await bob.open(1, doc);
    expect(o.d!['access'].docRole).toBe('editor');
    // Until the next refresh the old role stays in force (07 §9).
    expect((await bob.submit(1, { base: 0, steps: [insertText(intro(), 'a')] })).t).toBe(
      'sync.ack',
    );
    const lower = p.tokens.issue({ user: 'bob', docs: { [doc]: 'viewer' }, groups: ['legal'] });
    expect((await refresh(bob, lower)).t).toBe('auth.ok');
    const changed = await bob.take((m) => m.t === 'perm.changed' && m.ch === 1);
    expect(changed.d).toMatchObject({ docRole: 'viewer' });
    expect(changed.d!['caps']).not.toContain('edit');
    expect(changed.d!['rev']).toBeGreaterThan(o.d!['access'].rev);
    expect(bob.all('ch.closed', 1)).toHaveLength(0);
    // The room now checks commits against the viewer role.
    expect((await bob.submit(1, { base: 1, steps: [insertText(intro(), 'b')] })).d).toMatchObject({
      code: 'permission_denied',
    });
  });

  it('stops matching grants that name a group the refreshed token no longer has', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const bob = await p.client('bob', { [doc]: 'commenter' }, { groups: ['legal'] });
    const o = await bob.open(1, doc);
    expect(o.d!['access'].scopes[LEGAL]).toContain('edit');
    const fewer = p.tokens.issue({ user: 'bob', docs: { [doc]: 'commenter' }, groups: [] });
    await refresh(bob, fewer);
    const changed = await bob.take((m) => m.t === 'perm.changed' && m.ch === 1);
    expect(changed.d!['scopes'][LEGAL]).not.toContain('edit');
    expect((await bob.submit(1, { base: 0, steps: [insertText(legal(), 'x')] })).d).toMatchObject({
      code: 'permission_denied',
    });
  });

  it('closes the channel with forbidden when the refreshed token no longer names the document', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const other = await p.createDocument();
    const carol = await p.client('carol', { [doc]: 'editor', [other]: 'editor' });
    await carol.open(1, doc);
    await refresh(carol, p.tokens.issue({ user: 'carol', docs: { [other]: 'editor' } }));
    const closed = await carol.take((m) => m.t === 'ch.closed' && m.ch === 1);
    expect(closed.d).toMatchObject({ code: 'forbidden' });
  });
});

describe('bounded send queues (BE-027)', () => {
  it('closes a channel that falls behind with slow_consumer; a resume gets every commit once; others keep up', async () => {
    const p = await plane({
      settings: { sendQueueBytes: 256 * 1024, socketHighWater: 32 * 1024 },
    });
    const doc = await p.createDocument();
    const writer = await p.client('alice', { [doc]: 'owner' });
    const slow = await p.client('carol', { [doc]: 'editor' });
    const fast = await p.client('dave', { [doc]: 'viewer' });
    const opened = await writer.open(1, doc);
    await slow.open(1, doc);
    await fast.open(1, doc);
    slow.ws.pause();
    const text = 'x'.repeat(60_000);
    let head = 0;
    for (let i = 0; i < 160 && !slow.closeInfo; i++) {
      const r = await writer.submit(1, { base: head, steps: [insertText(intro(), text)] });
      expect(r.t).toBe('sync.ack');
      head = r.d!['seq'];
      if (p.plane.metricsRegistry.slowConsumers.get({ tenant: p.tenant }) > 0) break;
    }
    expect(p.plane.metricsRegistry.slowConsumers.get({ tenant: p.tenant })).toBe(1);
    slow.ws.resume();
    const closed = await slow.take((m) => m.t === 'ch.closed' && m.ch === 1, 15_000);
    expect(closed.d).toMatchObject({ code: 'slow_consumer' });
    // What it received before the close, in order, without a gap.
    const got = slow
      .all('sync.commit', 1)
      .flatMap((m) => m.d!['commits'].map((c: { seq: number }) => c.seq));
    got.forEach((s, i) => expect(s).toBe(i + 1));
    const last = got.length ? got[got.length - 1]! : 0;
    const re = await slow.open(2, doc, {
      resume: { seq: last, incarnation: opened.d!['incarnation'], view: opened.d!['view'] },
    });
    expect(re.d).toMatchObject({ catchUp: 'stream', head });
    await slow.take((m) => m.t === 'sync.caughtUp' && m.ch === 2, 15_000);
    const streamed = slow
      .all('sync.commit', 2)
      .flatMap((m) => m.d!['commits'].map((c: { seq: number }) => c.seq));
    expect(streamed).toEqual(Array.from({ length: head - last }, (_, i) => last + 1 + i));
    // The channel that kept up received every commit, and was never closed.
    await until(
      () => fast.all('sync.commit', 1).flatMap((m) => m.d!['commits']).length === head,
      10_000,
      'the fast reader',
    );
    expect(fast.all('ch.closed')).toHaveLength(0);
    // Its queue went with the channel: nothing waits for it any more.
    expect(p.plane.sessions.reduce((a, s) => a + s.queuedBytes, 0)).toBe(0);
  }, 60_000);
});

describe('rate limits (BE-030)', () => {
  it('refuses upgrades over the address limit with HTTP 429, before any token is verified', async () => {
    let verified = 0;
    const p = await plane({
      settings: { rates: { addressConnections: { capacity: 2, refillPerSecond: 0.001 } } },
    });
    const verify = p.tokens.verify;
    p.tokens.verify = async (t) => {
      verified++;
      return verify(t);
    };
    const doc = await p.createDocument();
    await p.client('alice', { [doc]: 'owner' });
    await p.client('carol', { [doc]: 'editor' });
    const before = verified;
    await expect(DepClient.connect(p.url)).rejects.toMatchObject({ status: 429 });
    expect(verified).toBe(before);
    expect(p.plane.metrics()).toMatch(/dep_rate_limited_total\{node="[^"]+",scope="address"\} 1/);
  });

  it('closes with 4429 an address that sends more frames than allowed before hello', async () => {
    const p = await plane({
      settings: { rates: { addressFrames: { capacity: 2, refillPerSecond: 0.001 } } },
    });
    const doc = await p.createDocument();
    await p.client('alice', { [doc]: 'owner' });
    await p.client('carol', { [doc]: 'editor' });
    const c = await DepClient.connect(p.url);
    c.send({ t: 'hello', id: 'h', d: {} });
    expect((await c.closed).code).toBe(4429);
  });

  it('answers messages over the connection limit with rate_limited and retryAfterMs, and closes after repeated refusals', async () => {
    const p = await plane({
      settings: {
        // hello is not counted against the connection bucket (ADR 0103): ch.open and the first
        // submit take the two tokens, so the next submit is refused.
        rates: { connection: { capacity: 2, refillPerSecond: 0.5 }, closeAfterRefusals: 3 },
      },
    });
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    await c.open(1, doc);
    await c.submit(1, { base: 0, steps: [insertText(intro(), 'a')] });
    const id = c.submitNoWait(1, { base: 1, steps: [insertText(intro(), 'b')] });
    const r = await c.take((m) => m.re === id);
    // A submit over the limit is a typed rejection the channel's state machine retries (05 §5.3).
    expect(r).toMatchObject({ t: 'sync.reject', d: { code: 'rate_limited', action: 'retry' } });
    expect(r.d!['retryAfterMs']).toBeGreaterThan(0);
    c.send({
      t: 'presence.update',
      id: 'p1',
      ch: 1,
      d: { seq: 1, state: { selection: { anchor: 1, head: 1 }, scope: 'body', status: 'active' } },
    });
    const e = await c.take((m) => m.re === 'p1');
    expect(e).toMatchObject({ t: 'error', d: { code: 'rate_limited', fatal: false } });
    expect(e.d!['retryAfterMs']).toBeGreaterThan(0);
    c.send({
      t: 'presence.update',
      id: 'p2',
      ch: 1,
      d: { seq: 1, state: { selection: { anchor: 1, head: 1 }, scope: 'body', status: 'active' } },
    });
    expect((await c.closed).code).toBe(4429);
  });

  it('holds one tenant at its limit without slowing another', async () => {
    const tight = { capacity: 4, refillPerSecond: 0.001 };
    const p = await plane({ settings: { rates: { tenant: tight } } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const b = await p.client('carol', { [uuid7()]: 'editor' }, { tenant: crypto.randomUUID() });
    for (let i = 0; i < 6; i++) a.send({ t: 'ch.close', ch: 99 }); // never limited
    for (let i = 0; i < 6; i++)
      a.send({
        t: 'ch.open',
        id: `a${i}`,
        ch: 50 + i,
        d: { kind: 'doc', doc: uuid7(), engine: 'pm-steps/1', cdm: 1, features: [] },
      });
    await a.take((m) => m.re === 'a5');
    expect(a.all('error').some((m) => m.d!['code'] === 'rate_limited')).toBe(true);
    for (let i = 0; i < 4; i++)
      b.send({
        t: 'ch.open',
        id: `b${i}`,
        ch: 50 + i,
        d: { kind: 'doc', doc: uuid7(), engine: 'pm-steps/1', cdm: 1, features: [] },
      });
    await b.take((m) => m.re === 'b3');
    expect(b.all('error').some((m) => m.d!['code'] === 'rate_limited')).toBe(false);
  });
});

describe('chunked messages (PRO-018)', () => {
  it('reassembles a commit of about 1 MiB sent in chunks, acknowledges it, and chunks the broadcast', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const b = await p.client('carol', { [doc]: 'editor' });
    await a.open(1, doc);
    await b.open(1, doc);
    // Characters outside the Basic Multilingual Plane, so that a split could divide a pair.
    const text = '\u{1F600}a'.repeat(160_000);
    const msg = JSON.stringify({
      t: 'sync.submit',
      id: 'big',
      ch: 1,
      d: { id: uuid7(), base: 0, steps: [insertText(intro(), text)] },
    });
    expect(Buffer.byteLength(msg)).toBeGreaterThan(131_072 * 5);
    for (const f of chunkMessage(msg, 131_072, uuid7())) a.sendRaw(f);
    const ack = await a.take((m) => m.re === 'big', 15_000);
    expect(ack).toMatchObject({ t: 'sync.ack', d: { seq: 1 } });
    const commit = await b.take((m) => m.t === 'sync.commit', 15_000);
    expect(commit.d!['commits'][0].steps[0].slice.content[0].text).toBe(text);
    // Every frame of the broadcast is within maxMessageBytes; the chunks of it came one after another.
    const chunks = b.frames.filter((f) => f.startsWith('{"t":"chunk"'));
    expect(chunks.length).toBeGreaterThan(1);
    for (const f of b.frames) expect(Buffer.byteLength(f)).toBeLessThanOrEqual(131_072);
    const first = b.frames.findIndex((f) => f.startsWith('{"t":"chunk"'));
    expect(
      b.frames.slice(first, first + chunks.length).every((f) => f.startsWith('{"t":"chunk"')),
    ).toBe(true);
  }, 30_000);

  it('abandons an incomplete message after chunkTimeoutMs', async () => {
    const p = await plane({ settings: { chunkTimeoutMs: 200 } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    const msg = (id: string) =>
      JSON.stringify({
        t: 'sync.submit',
        id,
        ch: 1,
        d: { id: uuid7(), base: 0, steps: [insertText(intro(), 'y'.repeat(200_000))] },
      });
    const lost = chunkMessage(msg('lost'), 131_072, uuid7());
    a.sendRaw(lost[0]!);
    await new Promise((r) => setTimeout(r, 300));
    for (const f of chunkMessage(msg('kept'), 131_072, uuid7())) a.sendRaw(f);
    expect(await a.take((m) => m.re === 'kept', 10_000)).toMatchObject({ t: 'sync.ack' });
    expect(a.log.some((m) => m.re === 'lost')).toBe(false);
    expect(a.closeInfo).toBeNull();
  });
});

describe('keep-alive (PRO-019)', () => {
  it('pings an idle connection after heartbeatMs, keeps it while the client answers, and ends it after two silent intervals', async () => {
    const p = await plane({ settings: { limits: { heartbeatMs: 150 } } });
    const doc = await p.createDocument();
    const alive = await p.client('alice', { [doc]: 'owner' });
    alive.onMessage = (m) => {
      if (m.t === 'ping') alive.send({ t: 'pong' });
    };
    const silent = await p.client('carol', { [doc]: 'editor' });
    await silent.take((m) => m.t === 'ping', 2000, 'a ping');
    const closed = await silent.closed;
    expect(closed.code).toBe(1006);
    await new Promise((r) => setTimeout(r, 800));
    expect(alive.closeInfo).toBeNull();
    expect(alive.all('ping').length).toBeGreaterThanOrEqual(3);
  }, 20_000);
});

describe('closing channels and draining (PRO-024; BE-022)', () => {
  it('stops sending for a channel the client closed, and accepts a later ch.open for the document', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    const b = await p.client('carol', { [doc]: 'editor' });
    await a.open(1, doc);
    await b.open(1, doc);
    b.send({ t: 'ch.close', ch: 1 });
    await until(() => p.plane.host.get(p.ref(doc))!.channelCount === 1);
    await a.submit(1, { base: 0, steps: [insertText(intro(), 'q')] });
    await new Promise((r) => setTimeout(r, 50));
    expect(b.all('sync.commit', 1)).toHaveLength(0);
    expect((await b.open(1, doc)).t).toBe('ch.opened');
  });

  it('sends goaway with a jittered reconnectInMs and a reason, then closes with 4503, when the node drains', async () => {
    const p = await plane();
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    await p.plane.drain();
    const g = await a.take((m) => m.t === 'goaway');
    expect(g.d!['reconnectInMs']).toBeGreaterThanOrEqual(1000);
    expect(g.d!['reconnectInMs']).toBeLessThanOrEqual(5000);
    expect(typeof g.d!['reason']).toBe('string');
    expect((await a.closed).code).toBe(4503);
    await expect(DepClient.connect(p.url)).rejects.toMatchObject({ status: 503 });
  });

  it('closes each channel with ch.closed unavailable and no goaway when a room stops', async () => {
    const p = await plane({ settings: { testMode: true } });
    const doc = await p.createDocument();
    const a = await p.client('alice', { [doc]: 'owner' });
    await a.open(1, doc);
    expect(await p.plane.hooks!.killRoom(p.ref(doc))).toBe(true);
    const closed = await a.take((m) => m.t === 'ch.closed');
    expect(closed.d).toMatchObject({ code: 'unavailable' });
    expect(a.all('goaway')).toHaveLength(0);
    expect(a.closeInfo).toBeNull();
  });
});

describe('traces (PRO-044; BE-087)', () => {
  it('records the session, its channels and its commits under the trace of hello.traceparent, without content or tokens', async () => {
    const spans: Span[] = [];
    const p = await plane({ settings: { onSpan: (s) => spans.push(s) } });
    const doc = await p.createDocument();
    const token = p.tokens.issue({ user: 'alice', docs: { [doc]: 'owner' } });
    const c = await DepClient.connect(p.url);
    const trace = '4bf92f3577b34da6a3ce929d0e0e4736';
    await c.hello(token, { traceparent: `00-${trace}-00f067aa0ba902b7-01` });
    await c.open(1, doc);
    await c.submit(1, { base: 0, steps: [insertText(intro(), 'secret words')] });
    c.close();
    await until(() => spans.some((s) => s.name === 'dep.session'), 3000, 'the session span');
    const names = new Set(spans.map((s) => s.name));
    expect(names).toEqual(new Set(['dep.session', 'dep.channel', 'dep.commit']));
    for (const s of spans) expect(s.traceId).toBe(trace);
    const session = spans.find((s) => s.name === 'dep.session')!;
    expect(session.parentSpanId).toBe('00f067aa0ba902b7');
    const text = JSON.stringify(spans);
    expect(text).not.toContain('secret words');
    expect(text).not.toContain(token);
  });

  it('starts a trace of its own without traceparent', async () => {
    const spans: Span[] = [];
    const p = await plane({ settings: { onSpan: (s) => spans.push(s) } });
    const doc = await p.createDocument();
    const c = await p.client('alice', { [doc]: 'owner' });
    c.close();
    await until(() => spans.length > 0);
    expect(spans[0]!.traceId).toMatch(/^[0-9a-f]{32}$/);
    expect(spans[0]!.parentSpanId).toBeNull();
  });
});
