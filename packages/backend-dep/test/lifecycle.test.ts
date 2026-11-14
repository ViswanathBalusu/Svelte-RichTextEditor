// The life of a session on a virtual clock (PRO-014, PRO-019; 05 §3.1, §4, §5.1): the token is
// refreshed before it expires, the heartbeat keeps an idle connection alive and ends a silent one,
// reconnection follows the capped full-jitter backoff or the hint of `goaway`. Timers run only when
// the test advances the clock, and the service clock moves with it, so that a 45-minute session
// takes no real time. Node.js only: the schedule is checked exactly.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { isPortError } from '@docedit/protocol';
import {
  createDepBackend,
  type DepBackend,
  type DepBackendOptions,
  type Diagnostic,
} from '../src/index.ts';
import {
  IDS,
  LEGAL_GRANT,
  USERS,
  contractDocument,
  insertText,
  posIn,
} from './support/fixtures.ts';
import { MemoryNetwork, type ServerSocket } from './support/memory-network.ts';
import { MockDepServer, type MockDepServerOptions } from './support/mock-server.ts';
import { VirtualClock, settle, type ClockEvent } from './support/virtual-time.ts';

interface Rig {
  readonly server: MockDepServer;
  readonly net: MemoryNetwork;
  readonly clock: VirtualClock;
  readonly docId: string;
  /** The server's side of every socket the client opened, in order. */
  readonly sockets: ServerSocket[];
  make(extra?: Partial<DepBackendOptions>): DepBackend;
  /** Moves the service clock (token expiry) and the virtual clock (timers) together. */
  advance(ms: number): Promise<void>;
}

function rig(opts: { seed?: number; server?: MockDepServerOptions } = {}): Rig {
  const server = new MockDepServer(opts.server);
  const sockets: ServerSocket[] = [];
  const net = new MemoryNetwork({
    accept: (s) => {
      sockets.push(s);
      return server.accept(s);
    },
    http: (req) => server.http(req),
  });
  const docId = server.service.createDocument(contractDocument(), { grants: [LEGAL_GRANT] });
  const clock = new VirtualClock(opts.seed ?? 1);
  return {
    server,
    net,
    clock,
    docId,
    sockets,
    make(extra = {}) {
      const { platform: extraPlatform, ...rest } = extra;
      return createDepBackend({
        endpoint: server.endpoint,
        getToken: async () => server.mintToken(USERS.editor, { [docId]: 'editor' }),
        ...rest,
        platform: { ...net.platform(), ...clock.platform(), ...extraPlatform },
      });
    },
    async advance(ms) {
      server.service.advanceClock(ms);
      await clock.advance(ms);
    },
  };
}

/** The client frames of one type, decoded. */
const sent = (r: Rig, t: string) => r.net.decoded('c2s').filter((f) => f.t === t);

/** The reconnection delays of a schedule: each jitter draw is followed by the timer it sets. */
function reconnectSchedule(log: readonly ClockEvent[]): Array<{ value: number; ms: number }> {
  const out: Array<{ value: number; ms: number }> = [];
  log.forEach((e, i) => {
    if (e.kind !== 'random') return;
    const next = log[i + 1];
    if (next?.kind !== 'timer') throw new Error('a jitter draw was not followed by a timer');
    out.push({ value: e.value, ms: next.ms });
  });
  return out;
}

describe('reconnection backoff (PRO-019 criterion 3)', () => {
  it('draws each delay uniformly below a ceiling that doubles from 0.5 s to 30 s (full jitter)', async () => {
    await fc.assert(
      fc.asyncProperty(fc.integer({ min: 1, max: 2 ** 31 - 1 }), async (seed) => {
        const r = rig({ seed });
        const b = r.make();
        await b.connect();
        r.net.online = false;
        r.net.cut();
        const start = r.clock.log.length;
        // Nine attempts fail in turn; the tenth delay is drawn at the last failure and not yet run.
        for (let attempt = 0; attempt < 9; attempt++) expect(await r.clock.runNext()).toBe(true);
        const schedule = reconnectSchedule(r.clock.log.slice(start));
        expect(schedule).toHaveLength(10);
        const ceilings = [500, 1000, 2000, 4000, 8000, 16000, 30000, 30000, 30000, 30000];
        schedule.forEach((s, k) => {
          expect(s.value).toBeGreaterThanOrEqual(0);
          expect(s.value).toBeLessThan(1);
          // The delay is exactly the draw applied to that attempt's ceiling (05 §4, full jitter).
          expect(s.ms).toBe(Math.floor(s.value * ceilings[k]!));
          expect(s.ms).toBeLessThan(ceilings[k]!);
        });
        await b.close();
      }),
      { numRuns: 25 },
    );
  });
});

describe('heartbeat (PRO-019 criteria 1, 2 and 6)', () => {
  it('sends ping after heartbeatMs (25,000 ms) without sending, and the pong keeps the connection', async () => {
    const r = rig();
    const b = r.make();
    await b.connect();
    await r.advance(24_999);
    expect(sent(r, 'ping')).toHaveLength(0);
    await r.advance(1);
    expect(sent(r, 'ping')).toHaveLength(1);
    await r.advance(30_000);
    expect(sent(r, 'ping').length).toBeGreaterThanOrEqual(2);
    expect(b.connection.status).toBe('online');
    await b.close();
  });

  it('closes a connection that has heard nothing for two heartbeat intervals', async () => {
    const diagnostics: Diagnostic[] = [];
    const r = rig();
    const b = r.make({ onDiagnostic: (d) => diagnostics.push(d) });
    await b.connect();
    // The server goes silent: its pongs never arrive.
    r.net.fate = () => 'drop';
    const silent = () =>
      diagnostics.some((d) => d.message.includes('nothing heard for two heartbeat intervals'));
    await r.advance(49_999);
    expect(silent()).toBe(false);
    await r.advance(1);
    expect(silent()).toBe(true);
    expect(b.connection.status).toBe('reconnecting');
    await b.close();
  });

  it('keeps an open, untouched document alive for ten minutes past a gateway that drops 100 s idle connections', async () => {
    const r = rig();
    const b = r.make();
    await b.connect();
    const content = await b.sync.loadContent(r.docId);
    await b.sync.open(r.docId, { resume: { seq: content.seq, incarnation: content.incarnation } });
    // The gateway: it cuts the socket when no frame, in either direction, has passed for 100 s.
    const GATEWAY_IDLE_MS = 100_000;
    let frames = r.net.frames.length;
    let lastFrameAt = r.clock.elapsed;
    let gatewayCuts = 0;
    for (let t = 0; t < 600_000; t += 1_000) {
      await r.advance(1_000);
      if (r.net.frames.length !== frames) {
        frames = r.net.frames.length;
        lastFrameAt = r.clock.elapsed;
      }
      if (r.net.openSockets > 0 && r.clock.elapsed - lastFrameAt > GATEWAY_IDLE_MS) {
        gatewayCuts++;
        r.net.cut();
      }
    }
    expect(gatewayCuts).toBe(0);
    expect(b.connection.status).toBe('online');
    expect(sent(r, 'ping').length).toBeGreaterThanOrEqual(20);
    await b.close();
  });
});

describe('goaway (PRO-019 criterion 4)', () => {
  it('reconnects after the hint of goaway instead of its own backoff', async () => {
    const r = rig({ seed: 3 });
    const b = r.make();
    await b.connect();
    const start = r.clock.log.length;
    const socket = r.sockets[0]!;
    socket.send(JSON.stringify({ t: 'goaway', d: { reconnectInMs: 4000, reason: 'draining' } }));
    socket.close(1001, 'going away');
    await settle();
    expect(b.connection.status).toBe('reconnecting');
    const after = r.clock.log.slice(start);
    expect(after.some((e) => e.kind === 'random')).toBe(false);
    expect(after).toContainEqual({ kind: 'timer', ms: 4000 });
    await r.advance(3_999);
    expect(b.connection.status).toBe('reconnecting');
    await r.advance(1);
    expect(b.connection.status).toBe('online');
    await b.close();
  });
});

describe('token refresh (PRO-014 criteria 2 and 6)', () => {
  it('asks getToken for a new token when auth.expiring arrives, and the server acknowledges it', async () => {
    const r = rig();
    const b = r.make();
    await b.connect();
    const before = b.auth.session!.tokenExp;
    const inMs: number[] = [];
    b.auth.onExpiring((e) => inMs.push(e.inMs));
    // The token lasts 15 minutes; the server warns 60 seconds before it ends.
    await r.advance(14 * 60_000);
    // The service clock runs in real time between the test's steps, so the warning is at most 60 s.
    expect(inMs).toHaveLength(1);
    expect(inMs[0]).toBeLessThanOrEqual(60_000);
    expect(inMs[0]).toBeGreaterThan(59_000);
    const refreshes = sent(r, 'auth.refresh');
    expect(refreshes).toHaveLength(1);
    const oks = r.net.decoded('s2c').filter((f) => f.t === 'auth.ok');
    expect(oks).toHaveLength(1);
    expect(oks[0]).toMatchObject({ re: refreshes[0]!['id'] });
    expect(b.auth.session!.tokenExp).not.toBe(before);
    await b.close();
  });

  it('keeps a 45-minute session on 15-minute tokens with no reconnect and no lost message', async () => {
    const diagnostics: Diagnostic[] = [];
    const r = rig();
    const b = r.make({ onDiagnostic: (d) => diagnostics.push(d) });
    await b.connect();
    const content = await b.sync.loadContent(r.docId);
    const ch = await b.sync.open(r.docId, {
      resume: { seq: content.seq, incarnation: content.incarnation },
    });
    for (let minute = 0; minute < 45; minute++) await r.advance(60_000);
    expect(sent(r, 'auth.refresh')).toHaveLength(3);
    expect(sent(r, 'hello')).toHaveLength(1);
    expect(diagnostics.filter((d) => d.kind === 'reconnect')).toEqual([]);
    expect(b.connection.status).toBe('online');
    const pending = ch.submit({
      id: '0192f0c4-0000-7000-8000-000000000045',
      base: content.seq,
      steps: [insertText(posIn(content.doc, IDS.intro), 'after 45 minutes')],
    });
    await r.advance(1_000);
    const ack = await pending;
    expect(ack.seq).toBe(1);
    await b.close();
  });
});

/** Replaces some of the limits that `welcome` advertises (05 §5.1). */
function advertising(limits: Record<string, number>): MockDepServerOptions {
  return {
    welcome: (d) => ({ ...d, limits: { ...(d['limits'] as Record<string, unknown>), ...limits } }),
  };
}

/** Opens a channel on the document and runs the clock until it is live. */
async function liveChannel(r: Rig, b: DepBackend) {
  await b.connect();
  const content = await b.sync.loadContent(r.docId);
  const ch = await b.sync.open(r.docId, {
    resume: { seq: content.seq, incarnation: content.incarnation },
  });
  const states: string[] = [];
  ch.onState((s) => states.push(s.status));
  for (let i = 0; i < 50 && !states.includes('live'); i++) await r.advance(0);
  expect(states).toContain('live');
  return { ch, content };
}

/** The client frames sent since `from`, as text. */
const framesSince = (r: Rig, from: number): string[] =>
  r.net.frames
    .filter((f) => f.dir === 'c2s')
    .slice(from)
    .map((f) => f.text);

describe('advertised limits (PRO-022 criterion 3)', () => {
  it('uses the advertised heartbeat interval', async () => {
    const r = rig({ server: advertising({ heartbeatMs: 5_000 }) });
    const b = r.make();
    await b.connect();
    await r.advance(4_999);
    expect(sent(r, 'ping')).toHaveLength(0);
    await r.advance(1);
    expect(sent(r, 'ping')).toHaveLength(1);
    await b.close();
  });

  it('uses the advertised acknowledgement timeout before it resumes the channel', async () => {
    const r = rig({ server: advertising({ ackTimeoutMs: 3_000 }) });
    const b = r.make();
    const { ch, content } = await liveChannel(r, b);
    // The server never answers the commit.
    r.net.fate = () => 'drop';
    const opens = () => sent(r, 'ch.open').length;
    const before = opens();
    const pending = ch
      .submit({
        id: '0192f0c4-0000-7000-8000-000000000301',
        base: content.seq,
        steps: [insertText(posIn(content.doc, IDS.intro), 'x')],
      })
      .catch((e: unknown) => e);
    await r.advance(2_999);
    expect(opens()).toBe(before);
    await r.advance(1);
    expect(opens()).toBe(before + 1);
    await b.close();
    await pending;
  });

  it('chunks a message above the advertised maxMessageBytes and only that', async () => {
    const commit = (r: Rig, b: DepBackend) =>
      liveChannel(r, b).then(async ({ ch, content }) => {
        const from = r.net.frames.filter((f) => f.dir === 'c2s').length;
        const pending = ch
          .submit({
            id: '0192f0c4-0000-7000-8000-000000000302',
            base: content.seq,
            steps: [insertText(posIn(content.doc, IDS.intro), 'x'.repeat(10_000))],
          })
          .catch((e: unknown) => e);
        await r.advance(0);
        const texts = framesSince(r, from);
        await b.close();
        await pending;
        return texts;
      });

    const small = rig({ server: advertising({ maxMessageBytes: 4_096 }) });
    const chunked = await commit(small, small.make());
    const kinds = chunked.map((t) => (JSON.parse(t) as { t: string }).t);
    expect(kinds).toContain('chunk');
    expect(kinds).not.toContain('sync.submit');
    expect(chunked.every((t) => t.length <= 4_096)).toBe(true);

    const large = rig();
    const whole = await commit(large, large.make());
    const plain = whole.map((t) => (JSON.parse(t) as { t: string }).t);
    expect(plain).toContain('sync.submit');
    expect(plain).not.toContain('chunk');
  });

  it('refuses locally a commit above the advertised maxStepsPerCommit, and sends nothing for it (criterion 4, client half)', async () => {
    const r = rig({ server: advertising({ maxStepsPerCommit: 2 }) });
    const b = r.make();
    const { ch, content } = await liveChannel(r, b);
    const pos = posIn(content.doc, IDS.intro);
    const from = r.net.frames.filter((f) => f.dir === 'c2s').length;
    const err: unknown = await ch
      .submit({
        id: '0192f0c4-0000-7000-8000-000000000303',
        base: content.seq,
        steps: [insertText(pos, 'a'), insertText(pos, 'b'), insertText(pos, 'c')],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await r.advance(0);
    expect(isPortError(err) && err.code).toBe('too_large');
    expect(sent(r, 'sync.submit')).toHaveLength(0);
    expect(framesSince(r, from)).toEqual([]);
    await b.close();
  });

  it('refuses locally a commit above the advertised maxCommitBytes, and sends nothing for it', async () => {
    const r = rig({ server: advertising({ maxCommitBytes: 2_000 }) });
    const b = r.make();
    const { ch, content } = await liveChannel(r, b);
    const from = r.net.frames.filter((f) => f.dir === 'c2s').length;
    const err: unknown = await ch
      .submit({
        id: '0192f0c4-0000-7000-8000-000000000304',
        base: content.seq,
        steps: [insertText(posIn(content.doc, IDS.intro), 'y'.repeat(3_000))],
      })
      .then(
        () => null,
        (e: unknown) => e,
      );
    await r.advance(0);
    expect(isPortError(err) && err.code).toBe('too_large');
    expect(framesSince(r, from)).toEqual([]);
    await b.close();
  });

  it('sends presence at the advertised rate, and never a state above presenceBytes', async () => {
    const r = rig({ server: advertising({ presenceHz: 2, presenceBytes: 1_024 }) });
    const b = r.make();
    const { content } = await liveChannel(r, b);
    const update = (seq: number, scope: string) => ({
      seq,
      state: { selection: { anchor: 1, head: 1 }, scope, status: 'active' as const },
    });
    const port = b.presence!;
    // 2 Hz: the first update goes at once, the two that follow become one 500 ms later.
    port.update(r.docId, update(content.seq, 'a'));
    port.update(r.docId, update(content.seq, 'b'));
    port.update(r.docId, update(content.seq, 'c'));
    await r.advance(0);
    expect(sent(r, 'presence.update')).toHaveLength(1);
    await r.advance(499);
    expect(sent(r, 'presence.update')).toHaveLength(1);
    await r.advance(1);
    expect(sent(r, 'presence.update')).toHaveLength(2);
    // A state above presenceBytes is never sent (05 §5.4).
    await r.advance(500);
    port.update(r.docId, update(content.seq, 'x'.repeat(2_000)));
    await r.advance(1_000);
    expect(sent(r, 'presence.update')).toHaveLength(2);
    await b.close();
  });
});
