// Property tests of the channel machine against a model server (04 §2 G4, G5; 04 §9; PRO-004):
// whatever the network does to the frames (drops, duplicates), however often the connection is
// lost, a commit goes unanswered or the reader's view changes (ADR 0019), the caller receives a
// gap-free, duplicate-free sequence that matches the server's log, every commit it made is stored
// exactly once, and once the faults stop it catches up with the head.
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type {
  Access,
  ChannelOpened,
  ClientMessage,
  Commit,
  Inflight,
  RemoteCommit,
  ServerMessage,
} from '../generated/types.ts';
import { ClientChannel, type ChannelEffect } from './channel.ts';

const DOC = '0192f0c4-7b1e-7c3a-9a54-3f2f1f6f8a10';
const T = '2026-09-18T10:42:00.000Z';
const TIMEOUT = 1000;
const ACCESS: Access = {
  rev: 1,
  asOfSeq: 0,
  docRole: 'editor',
  caps: ['view', 'edit'],
  scopes: { body: ['view', 'edit'] },
  leases: {},
  fill: null,
  restrictions: [],
};
const uuid = (n: number) => `0192f0c4-0000-7000-8000-${String(n).padStart(12, '0')}`;

/** The authority's side, reduced to what a client can observe: a log, attachment, dedup. */
class ModelServer {
  readonly log: RemoteCommit[] = [];
  incarnation = 'inc-1';
  view = 'view-1';
  attached: number | null = null;
  private ids = 0;

  private stored(id: string): RemoteCommit | undefined {
    return this.log.find((c) => c.id === id);
  }

  private append(id: string): RemoteCommit {
    const c: RemoteCommit = {
      seq: this.log.length + 1,
      kind: 'steps',
      id,
      steps: [{ stepType: 'replace', from: 1, to: 1 }],
      control: null,
      author: { user: 'u', session: null, agent: null },
      serverTime: T,
      origin: 'input',
    };
    this.log.push(c);
    return c;
  }

  answer(m: ClientMessage): ServerMessage[] {
    switch (m.t) {
      case 'ch.open': {
        if (this.attached !== null)
          return [
            { t: 'ch.rejected', re: m.id, ch: m.ch, d: { code: 'already_open', message: 'open' } },
          ];
        this.attached = m.ch;
        const head = this.log.length;
        const r = m.d.resume;
        const stream =
          r !== undefined &&
          r.incarnation === this.incarnation &&
          r.view === this.view &&
          r.seq <= head;
        const d: ChannelOpened = {
          head,
          incarnation: this.incarnation,
          catchUp: stream ? 'stream' : 'reload',
          access: ACCESS,
          view: this.view,
        };
        if (r?.inflight !== undefined) {
          const c = this.stored(r.inflight);
          const inflight: Inflight = c ? { state: 'accepted', seq: c.seq } : { state: 'unknown' };
          d.inflight = inflight;
        }
        const out: ServerMessage[] = [{ t: 'ch.opened', re: m.id, ch: m.ch, d }];
        if (stream) {
          if (head > r.seq)
            out.push({ t: 'sync.commit', ch: m.ch, d: { commits: this.log.slice(r.seq) } });
          out.push({ t: 'sync.caughtUp', ch: m.ch, d: { seq: head } });
        }
        return out;
      }
      case 'ch.close':
        if (this.attached === m.ch) this.attached = null;
        return [];
      case 'sync.submit': {
        if (this.attached !== m.ch) return [];
        const known = this.stored(m.d.id);
        if (known)
          return [
            {
              t: 'sync.ack',
              re: m.id,
              ch: m.ch,
              d: { id: known.id, seq: known.seq, serverTime: T, rebased: true, steps: known.steps },
            },
          ];
        const c = this.append(m.d.id);
        return [
          {
            t: 'sync.ack',
            re: m.id,
            ch: m.ch,
            d: { id: c.id, seq: c.seq, serverTime: T, rebased: false },
          },
        ];
      }
      default:
        return [];
    }
  }

  /** Another user's commit, broadcast to the attached channel. */
  remote(): ServerMessage[] {
    const c = this.append(uuid(900_000 + ++this.ids));
    return this.attached === null
      ? []
      : [{ t: 'sync.commit', ch: this.attached, d: { commits: [c] } }];
  }

  /** What the reader may see changed: its channel is closed and its next open reloads (ADR 0019). */
  changeView(): ServerMessage[] {
    this.view = `view-${++this.ids}`;
    const ch = this.attached;
    this.attached = null;
    return ch === null
      ? []
      : [{ t: 'ch.closed', ch, d: { code: 'unavailable', reason: 'access changed' } }];
  }
}

/** The editing core, reduced to its bookkeeping: what a caller of the ports must be able to rely on. */
class ModelClient {
  seq = 0;
  made: string[] = [];
  inflight: { commit: Commit; handle: number | null } | null = null;
  violations: string[] = [];
  needsReopen = false;
  private handles = 0;
  private commits = 0;
  readonly server: ModelServer;

  constructor(server: ModelServer) {
    this.server = server;
  }

  edit(m: ClientChannel, now: number): ChannelEffect[] {
    if (this.inflight || m.phase !== 'live') return [];
    const commit: Commit = {
      id: uuid(++this.commits),
      base: this.seq,
      steps: [{ stepType: 'replace', from: 1, to: 1 }],
    };
    this.made.push(commit.id);
    this.inflight = { commit, handle: ++this.handles };
    return m.submit(this.inflight.handle!, commit, now);
  }

  resubmit(m: ClientChannel, now: number): ChannelEffect[] {
    if (!this.inflight || this.inflight.handle !== null || m.phase !== 'live') return [];
    this.inflight.handle = ++this.handles;
    return m.submit(this.inflight.handle, this.inflight.commit, now);
  }

  check(c: RemoteCommit): void {
    const want = this.server.log[c.seq - 1];
    if (c.seq !== this.seq + 1) this.violations.push(`commit ${c.seq} after ${this.seq}`);
    else if (!want || want.id !== c.id)
      this.violations.push(`commit ${c.seq} differs from the log`);
    this.seq = c.seq;
  }

  /** Acts on the channel's effects like an editing core: in order, never trusting more than the ports promise. */
  take(
    fx: readonly ChannelEffect[],
    m: ClientChannel,
  ): { sends: ClientMessage[]; reopen: boolean } {
    const sends: ClientMessage[] = [];
    let reopen = false;
    for (const e of fx) {
      switch (e.kind) {
        case 'send':
          sends.push(e.message);
          break;
        case 'opened':
          if (e.opened.catchUp === 'reload') this.seq = e.opened.head; // content read at the head
          break;
        case 'commits':
          for (const c of e.commits) {
            this.check(c);
            if (this.inflight && c.id === this.inflight.commit.id) this.inflight = null; // its own commit: the answer
          }
          break;
        case 'ack':
          if (this.inflight?.handle === e.handle) {
            if (e.ack.seq === this.seq + 1) this.seq = e.ack.seq;
            else if (e.ack.seq > this.seq)
              this.violations.push(`ack ${e.ack.seq} after ${this.seq}`);
            this.inflight = null;
          }
          break;
        case 'reject':
          if (this.inflight?.handle === e.handle) this.inflight = null;
          break;
        case 'fail':
          // D23: the fate is learned from the stream, or by resubmitting with the same id.
          if (this.inflight?.handle === e.handle) this.inflight.handle = null;
          break;
        case 'state':
          if (e.state.status === 'closed' && e.state.code !== null) this.needsReopen = true;
          break;
        case 'reopen':
          reopen = true;
          break;
        default:
          break;
      }
    }
    void m;
    return { sends, reopen };
  }
}

type Fate = 'deliver' | 'drop' | 'duplicate';
type Op =
  | { op: 'deliver'; n: number }
  | { op: 'remote' }
  | { op: 'edit' }
  | { op: 'lose' }
  | { op: 'timeout' }
  | { op: 'view' };

const ops: fc.Arbitrary<Op> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.integer({ min: 1, max: 6 }).map((n) => ({ op: 'deliver' as const, n })),
  },
  { weight: 3, arbitrary: fc.constant({ op: 'remote' as const }) },
  { weight: 3, arbitrary: fc.constant({ op: 'edit' as const }) },
  { weight: 1, arbitrary: fc.constant({ op: 'lose' as const }) },
  { weight: 1, arbitrary: fc.constant({ op: 'timeout' as const }) },
  { weight: 1, arbitrary: fc.constant({ op: 'view' as const }) },
);

function run(
  script: readonly Op[],
  fates: readonly Fate[],
): { server: ModelServer; client: ModelClient } {
  const server = new ModelServer();
  const client = new ModelClient(server);
  let now = 0;
  let envelope = 0;
  let nextCh = 1;
  let connected = true;
  let wantReopen = false;
  let fateAt = 0;
  let faulty = true;
  const inbound: ServerMessage[] = [];
  const make = () =>
    new ClientChannel({ doc: DOC, ids: () => `e${++envelope}`, answerTimeoutMs: TIMEOUT });
  let m = make();

  const toClient = (msgs: readonly ServerMessage[]) => {
    for (const msg of msgs) {
      const fate: Fate = faulty
        ? (fates[fateAt++ % Math.max(1, fates.length)] ?? 'deliver')
        : 'deliver';
      if (fate === 'drop') continue;
      inbound.push(msg);
      if (fate === 'duplicate') inbound.push(msg);
    }
  };
  const apply = (fx: readonly ChannelEffect[]) => {
    const r = client.take(fx, m);
    if (r.reopen) wantReopen = true;
    if (connected) for (const s of r.sends) toClient(server.answer(s));
    if (m.phase === 'live') {
      const again = client.resubmit(m, now);
      if (again.length) apply(again);
    }
  };
  const reopenIfNeeded = () => {
    if (!connected) return;
    if (client.needsReopen || m.phase === 'closed') {
      client.needsReopen = false;
      wantReopen = false;
      m = make();
      // The 1a fallback of the editing core: reopen without resume, which reloads (05 §5.2).
      apply(m.open(nextCh++, [], undefined, now));
    } else if (m.phase === 'resuming' && wantReopen) {
      wantReopen = false;
      apply(m.reopen(nextCh++, [], now));
    }
  };
  const deliver = (n: number) => {
    for (let i = 0; i < n && inbound.length; i++) {
      const msg = inbound.shift()!;
      if ('ch' in msg && msg.ch !== m.ch) continue; // a frame for an old channel number
      apply(m.receive(msg, now));
    }
  };

  apply(m.open(nextCh++, [], undefined, now));
  for (const s of script) {
    switch (s.op) {
      case 'deliver':
        deliver(s.n);
        break;
      case 'remote':
        toClient(server.remote());
        break;
      case 'edit':
        apply(client.edit(m, now));
        break;
      case 'lose':
        // The connection breaks: frames in flight are lost, the server detaches the channel.
        connected = false;
        inbound.length = 0;
        server.attached = null;
        apply(m.connectionLost('connection lost'));
        connected = true;
        wantReopen = true;
        break;
      case 'timeout':
        now += TIMEOUT;
        apply(m.tick(now));
        break;
      case 'view':
        toClient(server.changeView());
        break;
    }
    reopenIfNeeded();
  }

  // The faults stop. One more commit by someone else reveals a lost last frame, and one edit of the
  // user's reveals a channel the server detached without the client hearing of it (a lost
  // ch.closed): only activity can show that. Then everything settles: deliveries, answer
  // timeouts and reopens, until nothing changes.
  faulty = false;
  toClient(server.remote());
  let edited = false;
  for (let round = 0; round < 60; round++) {
    reopenIfNeeded();
    deliver(Number.MAX_SAFE_INTEGER);
    if (!edited && m.phase === 'live' && !client.inflight) {
      edited = true;
      apply(client.edit(m, now));
      continue;
    }
    if (
      edited &&
      m.phase === 'live' &&
      client.seq === server.log.length &&
      !client.inflight &&
      inbound.length === 0
    )
      break;
    now += TIMEOUT;
    apply(m.tick(now));
  }
  return { server, client };
}

describe('the channel machine under faults (property)', () => {
  it('delivers the log gap-free and once, stores each commit once, and catches up', () => {
    fc.assert(
      fc.property(
        fc.array(ops, { minLength: 1, maxLength: 60 }),
        fc.array(
          fc.constantFrom<Fate>('deliver', 'deliver', 'deliver', 'deliver', 'drop', 'duplicate'),
          {
            minLength: 1,
            maxLength: 40,
          },
        ),
        (script, fates) => {
          const { server, client } = run(script, fates);
          expect(client.violations).toEqual([]);
          expect(client.seq).toBe(server.log.length);
          expect(client.inflight).toBeNull();
          const ids = server.log.map((c) => c.id);
          expect(new Set(ids).size).toBe(ids.length);
          for (const id of client.made) expect(ids.filter((x) => x === id)).toHaveLength(1);
        },
      ),
      { numRuns: 300 },
    );
  });
});
