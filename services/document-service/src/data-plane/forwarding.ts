/**
 * Forwarding of a channel to the node that owns its document (BE-062; 06 §2.1, §4.3, §6; 04 §12).
 *
 * A channel that lands on a node which is not the owner of its document is opened on the owner over
 * the internal bus (`bus.ts`; Valkey streams, owner decision 136). The node that holds the client's
 * socket is the gateway: it has verified the token, applied the rate limits and the quotas, and it
 * keeps the socket. The owner holds the room. The two ends exchange frames on two ordered streams
 * per channel (`channel-forward.ts`): up (gateway to owner) and down (owner to gateway). Each
 * stream numbers its frames, repairs a gap with a `nack`, and closes the channel with `unavailable`
 * and a `retryInMs` when a gap cannot be repaired. The client then resumes from the log.
 *
 * The rules this module holds:
 *
 * - The owner runs the same room code for a forwarded channel as for a local one: `acquire`, the
 *   feature and CDM checks, `open`, `submit`. The authority checks therefore run in the owning
 *   room; the gateway adds nothing to them and removes nothing (criterion 5).
 * - Routing is a hint. A document with a live owner other than this node is forwarded to that
 *   owner; a document with no live owner is forwarded to the host rendezvous routing names, and
 *   that host claims it through the epoch check of BE-017. Ownership is never granted here.
 * - The bus is not a store. A frame that is lost is repaired from the sender's window or the
 *   channel closes; nothing that the commit log holds depends on the bus (BE-063).
 * - A silent peer ends the channel: each end announces the head of its stream every
 *   `heartbeatMs`, and an end that has heard nothing for `silenceMs` closes.
 * - When the owner of a document changes, or its lease ends, the forwarded channels of that
 *   document are closed with `unavailable`; the client reconnects and is routed again (criterion 4).
 *
 * The figures of `ForwardingSettings` are settings of this story, proposed in
 * docs/adr/0393-w5-BE-062-forwarding-settings.md; the spec names none.
 */
import type { RoomConnection } from '@docedit/authority';
import { mayOpen } from '@docedit/model/definition';
import {
  ForwardReceiver,
  ForwardSender,
  ForwardedChannels,
  type ForwardClose,
  type ForwardWire,
} from '../control-plane/channel-forward.ts';
import { eligibleHosts, routeDocument } from '../control-plane/room-routing.ts';
import type {
  DocRef,
  GrantStore,
  HomeRegionStore,
  LogStore,
  NodeLeaseStore,
} from '../storage/types.ts';
import type { Bus } from './bus.ts';
import type { Metrics } from './metrics.ts';
import type { ChannelPort, HostedRoom, RoomHost } from './room-host.ts';
import { Refusal } from './wire.ts';

export interface ForwardingSettings {
  /** Frames each stream keeps for repair. */
  readonly retain: number;
  /** How long a gap waits before the receiver asks again, ms. */
  readonly repairMs: number;
  /** How many times a missing frame is asked for before the gap is unrepairable. */
  readonly maxNacks: number;
  /** The `retryInMs` a client is given when a forwarded channel closes. */
  readonly retryInMs: number;
  /** How often each end announces the head of its stream, ms. */
  readonly heartbeatMs: number;
  /** How long an end may hear nothing from the other before it closes the channel, ms. */
  readonly silenceMs: number;
  /** How long the gateway waits for the owner to answer a `ch.open`, ms. */
  readonly openTimeoutMs: number;
  /** How often the gateway checks that the owner of a forwarded document is still the owner, ms. */
  readonly ownerWatchMs: number;
}

/** The settings used when a deployment gives none (ADR 0393, proposed). */
export const DEFAULT_FORWARDING: ForwardingSettings = {
  retain: 2000,
  repairMs: 200,
  maxNacks: 10,
  retryInMs: 1000,
  heartbeatMs: 250,
  silenceMs: 3000,
  openTimeoutMs: 5000,
  ownerWatchMs: 500,
};

/** What a session needs of the room at the other end of a channel, local or forwarded. */
export type ChannelRoom = Pick<HostedRoom, 'head' | 'close' | 'submit' | 'presence' | 'refresh'>;

type Resume = Parameters<HostedRoom['open']>[3];
type Commit = Parameters<HostedRoom['submit']>[1];
type PresenceUpdate = Parameters<HostedRoom['presence']>[1];
type Closed = Parameters<ChannelPort['closed']>[0];
type Cause = Parameters<ChannelPort['closed']>[1];

/** Gateway to owner. */
export type UpFrame =
  | {
      readonly t: 'open';
      readonly tenant: string;
      readonly doc: string;
      readonly conn: RoomConnection;
      readonly resume: Resume;
      readonly cdm: number;
      readonly session: string;
      readonly user: ChannelPort['user'];
      readonly wantsPresence: boolean;
      readonly features: readonly string[];
      readonly trace: ChannelPort['trace'];
    }
  | { readonly t: 'submit'; readonly commit: Commit; readonly id: string }
  | { readonly t: 'presence'; readonly u: PresenceUpdate }
  | { readonly t: 'refresh'; readonly conn: RoomConnection }
  | { readonly t: 'close' };

/** Owner to gateway. */
export type DownFrame =
  | { readonly t: 'opened'; readonly d: Parameters<ChannelPort['opened']>[0] }
  | { readonly t: 'send'; readonly e: Parameters<ChannelPort['send']>[0]; readonly re?: string }
  | { readonly t: 'presence'; readonly p: Parameters<ChannelPort['presence']>[0] }
  | { readonly t: 'event'; readonly n: Parameters<ChannelPort['event']>[0] }
  | { readonly t: 'check'; readonly d: Parameters<ChannelPort['check']>[0] }
  | { readonly t: 'closed'; readonly d: Closed; readonly cause: Cause }
  | { readonly t: 'rejected'; readonly code: Refusal['code']; readonly message: string };

type Frame = UpFrame | DownFrame;

/** What goes on the bus: one wire message of one stream of one channel. */
interface Packet {
  /** The channel. */
  readonly c: string;
  /** The stream the wire message belongs to: up or down. */
  readonly s: 'u' | 'd';
  /** The gateway and the owner of the channel. */
  readonly g: string;
  readonly o: string;
  /** The tenant of the document, for the metrics of the node that hears it. */
  readonly t: string;
  readonly w: ForwardWire<Frame>;
}

interface Chan {
  readonly cid: string;
  readonly role: 'gateway' | 'owner';
  readonly tenant: string;
  readonly peer: string;
  readonly g: string;
  readonly o: string;
  readonly out: ForwardSender<Frame>;
  readonly in: ForwardReceiver<Frame>;
  lastHeard: number;
  lastBeat: number;
  closed: boolean;
  /** Frames the owner has taken but not yet handled, in order. */
  chain: Promise<void>;
  // Gateway.
  ref?: DocRef;
  port?: ChannelPort;
  head: number;
  opening?:
    | {
        resolve(room: ChannelRoom): void;
        reject(e: Error): void;
        timer: ReturnType<typeof setTimeout>;
      }
    | undefined;
  // Owner.
  key?: string;
  room?: HostedRoom;
}

export interface ForwardingDeps {
  readonly node: string;
  readonly bus: Bus;
  readonly host: RoomHost;
  readonly logs: Pick<LogStore, 'head'>;
  readonly grants: Pick<GrantStore, 'current'>;
  readonly leases: Pick<NodeLeaseStore, 'live' | 'alive'>;
  /**
   * Home regions (BE-074). With it, a document of a tenant that has a home region is routed to
   * the nodes of that region only, and is refused with `unavailable` when none is live.
   */
  readonly homeRegions?: Pick<HomeRegionStore, 'resolve'> | undefined;
  readonly settings?: Partial<ForwardingSettings>;
  readonly now: () => number;
  readonly metrics: Metrics;
  readonly onError: (e: unknown, where: string) => void;
}

/** What a gateway gives to open a forwarded channel. */
export interface ForwardOpen {
  readonly ref: DocRef;
  /** The channel's key on the gateway: unique on this node. */
  readonly key: string;
  readonly owner: string;
  readonly port: ChannelPort;
  readonly conn: RoomConnection;
  readonly resume: Resume;
  readonly cdm: number;
}

let channelCounter = 0;

export class Forwarder {
  readonly #d: ForwardingDeps;
  readonly settings: ForwardingSettings;
  readonly #chans = new Map<string, Chan>();
  /** Closed channels, so that a late packet does not bring one back, with the time to forget. */
  readonly #gone = new Map<string, number>();
  readonly #watched = new ForwardedChannels(1);
  readonly #docChannels = new Map<string, Set<string>>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #sub: { close(): void } | null = null;
  #watching = false;
  #lastWatch = 0;
  #closed = false;
  /** Counters for tests. */
  readonly stats = {
    opened: 0,
    forwardedFrames: 0,
    repairs: 0,
    gapCloses: 0,
    silenceCloses: 0,
    ownerChangeCloses: 0,
  };

  constructor(deps: ForwardingDeps) {
    this.#d = deps;
    this.settings = { ...DEFAULT_FORWARDING, ...deps.settings };
  }

  /** Listens on this node's inbox; resolves once packets sent from now on are heard. */
  async start(): Promise<void> {
    this.#sub = await this.#d.bus.subscribe(`node:${this.#d.node}`, (m) => this.#onPacket(m.body));
    this.#timer = setInterval(() => this.#tick(), 50);
    this.#timer.unref?.();
  }

  /**
   * Where a channel for `ref` should be opened: another node, or null for this one. Throws a
   * `Refusal` (`unavailable`) when no node may serve the document, for example when it has a home
   * region and no live node is in it (BE-074 criterion 4): the channel is not served anywhere
   * else, so nothing is written elsewhere.
   */
  async route(ref: DocRef): Promise<{ node: string } | null> {
    if (this.#closed) return null;
    const me = this.#d.node;
    let head;
    let live;
    let region: string | null = null;
    try {
      [head, live] = await Promise.all([this.#d.logs.head(ref), this.#d.leases.live()]);
      if (this.#d.homeRegions) region = await this.#d.homeRegions.resolve(ref);
    } catch {
      return null;
    }
    const names = live.map((n) => n.node);
    if (head.owner !== null && head.owner !== me && names.includes(head.owner))
      return { node: head.owner };
    if (head.owner === me) return null;
    // No live owner: the host that rendezvous routing names tries to own it. A dedicated host
    // takes its document, a general one never gets a hot document, and a home region limits the
    // candidates to its own nodes (BE-073, BE-074).
    if (!names.includes(me) || names.length === 0) return null;
    const eligible = eligibleHosts(ref.doc, live, region).map((n) => n.node);
    if (eligible.length === 0)
      throw new Refusal(
        'unavailable',
        region === null
          ? 'no node may serve this document'
          : `no live node in the home region ${region}`,
      );
    const named = routeDocument(ref.doc, eligible);
    return named === me ? null : { node: named };
  }

  // --- Gateway ---------------------------------------------------------------------------------

  /**
   * Opens `o.port`'s channel on the owner. Resolves with the room handle once the owner answered
   * `ch.opened` (the port has had `opened` called); rejects with a `Refusal` when the owner refused
   * the channel or could not be reached.
   */
  open(o: ForwardOpen): Promise<ChannelRoom> {
    if (this.#closed) return Promise.reject(new Refusal('unavailable', 'the service is stopping'));
    const cid = `${this.#d.node}/${++channelCounter}/${o.key}`;
    const chan = this.#newChan(cid, 'gateway', this.#d.node, o.owner, o.ref.tenant);
    chan.ref = o.ref;
    chan.port = o.port;
    chan.key = o.key;
    const room: ChannelRoom = {
      get head() {
        return chan.head;
      },
      close: () => this.#gatewayClose(chan, true),
      submit: (_key, commit, id) => this.#up(chan, { t: 'submit', commit, id }),
      presence: (_key, u) => this.#up(chan, { t: 'presence', u }),
      refresh: (_key, conn) => this.#up(chan, { t: 'refresh', conn }),
    };
    const answered = new Promise<ChannelRoom>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#teardown(chan, true);
        reject(new Refusal('unavailable', 'the owning node did not answer'));
      }, this.settings.openTimeoutMs);
      timer.unref?.();
      chan.opening = { resolve: () => resolve(room), reject, timer };
    });
    const docKey = `${o.ref.tenant}/${o.ref.doc}`;
    this.#watched.open(cid, docKey, o.owner);
    let set = this.#docChannels.get(docKey);
    if (!set) this.#docChannels.set(docKey, (set = new Set()));
    set.add(cid);
    const frame: UpFrame = {
      t: 'open',
      tenant: o.ref.tenant,
      doc: o.ref.doc,
      conn: o.conn,
      resume: o.resume,
      cdm: o.cdm,
      session: o.port.session,
      user: o.port.user,
      wantsPresence: o.port.wantsPresence,
      features: o.port.features,
      trace: o.port.trace,
    };
    this.stats.opened++;
    this.#up(chan, frame);
    return answered;
  }

  #up(chan: Chan, f: UpFrame): void {
    if (chan.closed) return;
    chan.out.send(f);
  }

  #gatewayClose(chan: Chan, tellOwner: boolean): void {
    if (chan.closed) return;
    this.#teardown(chan, tellOwner);
  }

  /** A frame from the owner, in order, once. */
  #onDown(chan: Chan, f: DownFrame): void {
    const port = chan.port;
    if (!port || chan.closed) return;
    switch (f.t) {
      case 'opened': {
        noteHead(chan, f.d);
        port.opened(f.d);
        const o = chan.opening;
        if (o) {
          clearTimeout(o.timer);
          chan.opening = undefined;
          o.resolve(undefined as never);
        }
        return;
      }
      case 'rejected': {
        const o = chan.opening;
        this.#teardown(chan, false);
        if (o) {
          clearTimeout(o.timer);
          o.reject(new Refusal(f.code, f.message));
        }
        return;
      }
      case 'send':
        noteHead(chan, f.e.d);
        port.send(f.e, f.re);
        return;
      case 'presence':
        port.presence(f.p);
        return;
      case 'event':
        port.event(f.n);
        return;
      case 'check':
        port.check(f.d);
        return;
      case 'closed':
        this.#teardown(chan, false);
        port.closed(f.d, f.cause);
        return;
    }
  }

  /** The channel ends on the gateway side with a close the client sees. */
  #closeToClient(chan: Chan, c: ForwardClose, tellOwner: boolean): void {
    if (chan.closed) return;
    const port = chan.port;
    const opening = chan.opening;
    if (tellOwner) this.#rawUp(chan, { t: 'close' });
    this.#teardown(chan, false);
    if (opening) {
      clearTimeout(opening.timer);
      opening.reject(new Refusal('unavailable', c.reason));
      return;
    }
    port?.closed({ code: c.code, reason: c.reason, retryInMs: c.retryInMs }, undefined);
  }

  /** A close sent outside the stream, for an end that is going away: best effort. */
  #rawUp(chan: Chan, f: UpFrame): void {
    void this.#publish(chan, 'u', { k: 'data', seq: Number.MAX_SAFE_INTEGER, payload: f });
  }

  // --- Owner -----------------------------------------------------------------------------------

  #ownerFrame(chan: Chan, f: UpFrame): Promise<void> {
    chan.chain = chan.chain
      .then(() => this.#handleUp(chan, f))
      .catch((e: unknown) => this.#d.onError(e, 'forwarded channel'));
    return chan.chain;
  }

  async #handleUp(chan: Chan, f: UpFrame): Promise<void> {
    if (chan.closed) return;
    switch (f.t) {
      case 'open':
        return this.#ownerOpen(chan, f);
      case 'submit':
        chan.room?.submit(chan.key!, f.commit, f.id);
        return;
      case 'presence':
        chan.room?.presence(chan.key!, f.u);
        return;
      case 'refresh':
        chan.room?.refresh(chan.key!, f.conn);
        return;
      case 'close':
        if (chan.room) chan.room.close(chan.key!);
        this.#teardown(chan, false);
        return;
    }
  }

  async #ownerOpen(chan: Chan, f: Extract<UpFrame, { t: 'open' }>): Promise<void> {
    const ref: DocRef = { tenant: f.tenant, doc: f.doc };
    const down = (d: DownFrame) => {
      if (!chan.closed) chan.out.send(d);
    };
    const port: ChannelPort = {
      session: f.session,
      user: f.user,
      wantsPresence: f.wantsPresence,
      features: f.features,
      trace: f.trace,
      opened: (d) => down({ t: 'opened', d }),
      send: (e, re) => down({ t: 'send', e, ...(re !== undefined ? { re } : {}) }),
      presence: (p) => down({ t: 'presence', p }),
      event: (n) => down({ t: 'event', n }),
      check: (d) => down({ t: 'check', d }),
      closed: (d, cause) => {
        down({ t: 'closed', d, cause });
        this.#teardown(chan, false);
      },
    };
    try {
      const room = await this.#d.host.acquire(ref);
      const decision = mayOpen(room.requires, [...f.features]);
      if (!decision.ok)
        throw new Refusal(
          'unsupported_feature',
          `the document requires ${decision.missing.join(', ')}`,
        );
      if (room.record.cdmVersion !== f.cdm)
        throw new Refusal('unsupported_cdm', `the document is CDM ${room.record.cdmVersion}`);
      const stored = await this.#d.grants.current(ref);
      if (chan.closed) return;
      chan.room = room;
      room.open(chan.key!, port, f.conn, f.resume, stored);
    } catch (e) {
      if (!(e instanceof Refusal)) this.#d.onError(e, 'forwarded ch.open');
      const r =
        e instanceof Refusal ? e : new Refusal('unavailable', 'the document could not be opened');
      down({ t: 'rejected', code: r.code, message: r.message });
      this.#teardown(chan, false);
    }
  }

  // --- Shared ----------------------------------------------------------------------------------

  #newChan(cid: string, role: 'gateway' | 'owner', g: string, o: string, tenant: string): Chan {
    const s = this.settings;
    const peer = role === 'gateway' ? o : g;
    const outStream = role === 'gateway' ? 'u' : 'd';
    const inStream = role === 'gateway' ? 'd' : 'u';
    // `chan` is read by the callbacks below only after it is assigned.
    const chan: Chan = {
      cid,
      role,
      tenant,
      peer,
      g,
      o,
      out: new ForwardSender<Frame>((w) => void this.#publish(chan, outStream, w), s.retain),
      in: new ForwardReceiver<Frame>(
        (w) => void this.#publish(chan, inStream, w),
        (_seq, f) => this.#deliver(chan, f),
        (c) => this.#onGap(chan, c),
        { repairMs: s.repairMs, maxNacks: s.maxNacks, retryInMs: s.retryInMs },
      ),
      lastHeard: this.#d.now(),
      lastBeat: this.#d.now(),
      closed: false,
      chain: Promise.resolve(),
      head: 0,
    };
    this.#chans.set(cid, chan);
    return chan;
  }

  #deliver(chan: Chan, f: Frame): void {
    if (chan.role === 'gateway') this.#onDown(chan, f as DownFrame);
    else void this.#ownerFrame(chan, f as UpFrame);
  }

  #onGap(chan: Chan, c: ForwardClose): void {
    this.stats.gapCloses++;
    this.#d.metrics.forwardClosed.inc({ tenant: chan.tenant, reason: 'gap' });
    if (chan.role === 'gateway') this.#closeToClient(chan, c, true);
    else {
      chan.room?.close(chan.key!);
      this.#teardown(chan, false);
    }
  }

  async #publish(chan: Chan, stream: 'u' | 'd', w: ForwardWire<Frame>): Promise<boolean> {
    const p: Packet = { c: chan.cid, s: stream, g: chan.g, o: chan.o, t: chan.tenant, w };
    this.stats.forwardedFrames++;
    this.#d.metrics.forwardFrames.inc({
      tenant: chan.tenant,
      dir: stream === 'u' ? 'up' : 'down',
    });
    return this.#d.bus.publish(`node:${chan.peer}`, JSON.stringify(p));
  }

  #onPacket(body: string): void {
    let p: Packet;
    try {
      p = JSON.parse(body) as Packet;
    } catch {
      return;
    }
    const now = this.#d.now();
    let chan = this.#chans.get(p.c);
    if (!chan) {
      // Only an owner starts a channel from a packet, and only from the gateway's stream.
      if (p.o !== this.#d.node || p.s !== 'u' || p.w.k === 'nack' || this.#gone.has(p.c)) return;
      chan = this.#newChan(p.c, 'owner', p.g, p.o, p.t);
      chan.key = `fwd:${p.g}:${p.c}`;
    }
    chan.lastHeard = now;
    const mine = chan.role === 'gateway' ? 'u' : 'd';
    if (p.w.k === 'nack') {
      if (p.s === mine) {
        this.stats.repairs++;
        chan.out.receive(p.w);
      }
    } else if (p.s !== mine) {
      // A close sent outside the stream (see `#rawUp`): act on it at once.
      if (p.w.k === 'data' && p.w.seq === Number.MAX_SAFE_INTEGER) {
        const f = p.w.payload as UpFrame;
        if (f.t === 'close' && chan.role === 'owner') {
          chan.room?.close(chan.key!);
          this.#teardown(chan, false);
        }
        return;
      }
      chan.in.receive(p.w, now);
    }
  }

  #tick(): void {
    const now = this.#d.now();
    const s = this.settings;
    for (const chan of [...this.#chans.values()]) {
      if (chan.closed) continue;
      chan.in.tick(now);
      if (chan.closed) continue;
      if (now - chan.lastBeat >= s.heartbeatMs) {
        chan.lastBeat = now;
        chan.out.announce();
      }
      if (now - chan.lastHeard > s.silenceMs) {
        this.stats.silenceCloses++;
        this.#d.metrics.forwardClosed.inc({ tenant: chan.tenant, reason: 'silence' });
        const c: ForwardClose = {
          code: 'unavailable',
          reason: 'the other node stopped answering',
          retryInMs: s.retryInMs,
        };
        if (chan.role === 'gateway') this.#closeToClient(chan, c, false);
        else {
          chan.room?.close(chan.key!);
          this.#teardown(chan, false);
        }
      }
    }
    for (const [cid, until] of this.#gone) if (until < now) this.#gone.delete(cid);
    if (!this.#watching && now - this.#lastWatch >= s.ownerWatchMs && this.#docChannels.size > 0) {
      this.#lastWatch = now;
      this.#watching = true;
      void this.#watchOwners().finally(() => (this.#watching = false));
    }
  }

  /** Closes the forwarded channels of a document whose owner changed or whose lease ended. */
  async #watchOwners(): Promise<void> {
    for (const docKey of [...this.#docChannels.keys()]) {
      const first = [...(this.#docChannels.get(docKey) ?? [])]
        .map((cid) => this.#chans.get(cid))
        .find((c) => c && !c.closed);
      if (!first?.ref) {
        this.#docChannels.delete(docKey);
        continue;
      }
      try {
        const head = await this.#d.logs.head(first.ref);
        // The owner the channels were forwarded to, unless the row names another node or the
        // owner's lease has ended; then the "owner" is a name no channel was forwarded to.
        let owner = first.o;
        if (head.owner !== null && head.owner !== first.o) owner = head.owner;
        else if (!(await this.#d.leases.alive(first.o))) owner = `${first.o}#gone`;
        for (const { channel, close } of this.#watched.setOwner(docKey, owner)) {
          const chan = this.#chans.get(channel);
          if (!chan) continue;
          this.stats.ownerChangeCloses++;
          this.#d.metrics.forwardClosed.inc({ tenant: chan.tenant, reason: 'owner_changed' });
          this.#closeToClient(chan, close, true);
        }
      } catch {
        // The database could not be read; the next round tries again.
      }
    }
  }

  #teardown(chan: Chan, tellOwner: boolean): void {
    if (chan.closed) return;
    chan.closed = true;
    if (tellOwner) this.#rawUp(chan, { t: 'close' });
    this.#chans.delete(chan.cid);
    this.#gone.set(chan.cid, this.#d.now() + this.settings.silenceMs * 2);
    if (chan.role === 'gateway' && chan.ref) {
      const docKey = `${chan.ref.tenant}/${chan.ref.doc}`;
      this.#watched.forget(chan.cid, docKey);
      const set = this.#docChannels.get(docKey);
      set?.delete(chan.cid);
      if (set && set.size === 0) {
        this.#docChannels.delete(docKey);
      }
    }
  }

  /** The number of channels this node holds as gateway or as owner, for tests. */
  get channels(): { gateway: number; owner: number } {
    let gateway = 0;
    let owner = 0;
    for (const c of this.#chans.values())
      if (c.role === 'gateway') gateway++;
      else owner++;
    return { gateway, owner };
  }

  async close(): Promise<void> {
    this.#closed = true;
    if (this.#timer) clearInterval(this.#timer);
    this.#timer = null;
    this.#sub?.close();
    for (const chan of [...this.#chans.values()]) {
      if (chan.role === 'owner') chan.room?.close(chan.key!);
      if (chan.opening) {
        clearTimeout(chan.opening.timer);
        chan.opening.reject(new Refusal('unavailable', 'the service is stopping'));
      }
      this.#teardown(chan, chan.role === 'gateway');
    }
  }
}

/** The head a frame tells the gateway of, so that `head` of the room handle is near the owner's. */
function noteHead(chan: Chan, d: unknown): void {
  if (typeof d !== 'object' || d === null) return;
  const r = d as Record<string, unknown>;
  for (const k of ['head', 'seq']) {
    const v = r[k];
    if (typeof v === 'number' && v > chan.head) chan.head = v;
  }
}
