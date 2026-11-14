/**
 * `SyncChannel` over DEP (05 §5.2 to §5.6; PRO-094): the ClientChannel state machine of
 * `@docedit/protocol/client`, its effects delivered through OrderedDelivery so that every backend
 * keeps the same rules (D21): nothing is called back synchronously, messages arrive in order, a
 * message waits for its first subscriber, and code awaiting `submit()` runs before later messages.
 */
import {
  OrderedDelivery,
  PortError,
  SyncRejectError,
  type Access,
  type Ack,
  type ChannelOpened,
  type ChannelState,
  type Commit,
  type Notification,
  type RemoteCommit,
  type SyncChannel,
  type SyncCheck,
  type SyncReset,
  type Unsubscribe,
} from '@docedit/protocol';
import type { ChannelEffect, ClientChannel } from '@docedit/protocol/client';

/** What a channel needs from its backend. */
export interface ChannelHost {
  now(): number;
  /** Sends a message of this channel on the current connection. */
  send(channel: DepChannel, message: Extract<ChannelEffect, { kind: 'send' }>['message']): void;
  /** Re-arms the channel's answer timer. */
  armTimer(channel: DepChannel): void;
  /** `catchUp: "page"`: read commits over REST. */
  page(channel: DepChannel, after: number, head: number): void;
  /** Reopen once connected, after a delay. */
  scheduleReopen(channel: DepChannel, effect: Extract<ChannelEffect, { kind: 'reopen' }>): void;
  /** The latest access, for PermissionsPort. */
  accessChanged(channel: DepChannel, access: Access): void;
  /** `presence.state`, for PresencePort. */
  peers(channel: DepChannel, peers: Extract<ChannelEffect, { kind: 'presence' }>['peers']): void;
  /** The channel ended. */
  ended(channel: DepChannel): void;
}

interface Waiter {
  resolve(ack: Ack): void;
  reject(e: unknown): void;
}

export class DepChannel implements SyncChannel {
  readonly docId: string;
  readonly machine: ClientChannel;
  private readonly host: ChannelHost;
  private readonly delivery = new OrderedDelivery();
  private readonly waiters = new Map<number, Waiter>();
  private nextHandle = 1;
  private opening: { resolve(c: DepChannel): void; reject(e: unknown): void } | null = null;
  /** The answer timer and the reopen timer of the channel. */
  timer: number | null = null;
  reopenTimer: number | null = null;

  constructor(host: ChannelHost, machine: ClientChannel) {
    this.host = host;
    this.machine = machine;
    this.docId = machine.doc;
  }

  /** What the first `ch.opened` said (D20). */
  get opened(): ChannelOpened {
    const o = this.machine.opened;
    if (!o) throw new PortError('unavailable', 'the channel is not open yet');
    return o;
  }

  get isClosed(): boolean {
    return this.machine.phase === 'closed';
  }

  /** Waits for the first `ch.opened`. */
  whenOpen(): Promise<DepChannel> {
    return new Promise((resolve, reject) => {
      this.opening = { resolve, reject };
    });
  }

  // --- SyncChannel -----------------------------------------------------------------------------

  submit(commit: Commit): Promise<Ack> {
    const handle = this.nextHandle++;
    return new Promise<Ack>((resolve, reject) => {
      this.waiters.set(handle, { resolve, reject });
      this.apply(this.machine.submit(handle, commit, this.host.now()));
    });
  }

  onCommits(cb: (commits: RemoteCommit[]) => void): Unsubscribe {
    return this.delivery.subscribe('commits', cb);
  }
  onReset(cb: (reset: SyncReset) => void): Unsubscribe {
    return this.delivery.subscribe('reset', cb);
  }
  onAccess(cb: (access: Access) => void): Unsubscribe {
    return this.delivery.subscribe('access', cb);
  }
  onEvent(cb: (event: Notification) => void): Unsubscribe {
    return this.delivery.subscribe('event', cb);
  }
  onState(cb: (state: ChannelState) => void): Unsubscribe {
    return this.delivery.subscribe('state', cb);
  }
  onCheck(cb: (check: SyncCheck) => void): Unsubscribe {
    return this.delivery.subscribe('check', cb);
  }

  close(): void {
    this.apply(this.machine.close());
  }

  // --- From the backend ------------------------------------------------------------------------

  /** Acts on the effects of the state machine, in order. */
  apply(effects: readonly ChannelEffect[]): void {
    for (const e of effects) {
      switch (e.kind) {
        case 'send':
          this.host.send(this, e.message);
          break;
        case 'opened': {
          const o = this.opening;
          this.opening = null;
          o?.resolve(this);
          break;
        }
        case 'openFailed': {
          const o = this.opening;
          this.opening = null;
          o?.reject(new PortError(e.code, e.message));
          this.host.ended(this);
          break;
        }
        case 'commits':
          this.delivery.push('commits', e.commits);
          break;
        case 'ack':
          this.settle(e.handle, (w) => w.resolve(e.ack));
          break;
        case 'reject':
          this.settle(e.handle, (w) => w.reject(new SyncRejectError(e.reject)));
          break;
        case 'fail':
          this.settle(e.handle, (w) => w.reject(new PortError(e.code, e.message)));
          break;
        case 'access':
          this.host.accessChanged(this, e.access);
          this.delivery.push('access', e.access);
          break;
        case 'reset':
          this.delivery.push('reset', e.reset);
          break;
        case 'event':
          this.delivery.push('event', e.event);
          break;
        case 'check':
          this.delivery.push('check', e.check);
          break;
        case 'presence':
          this.host.peers(this, e.peers);
          break;
        case 'workflow':
          // The workflow port reports `wf.changed` (D20); `backend-dep` offers no workflow port yet.
          break;
        case 'state':
          if (e.state.status === 'closed') {
            // Closed by the caller: nothing after it (D27). Closed by the server: what was
            // received before the close is still delivered.
            this.delivery.end({
              drop: e.state.code === null,
              last: { kind: 'state', value: e.state },
            });
            this.host.ended(this);
          } else this.delivery.push('state', e.state);
          break;
        case 'page':
          this.host.page(this, e.after, e.head);
          break;
        case 'reopen':
          this.host.scheduleReopen(this, e);
          break;
      }
    }
    this.host.armTimer(this);
  }

  private settle(handle: number, fn: (w: Waiter) => void): void {
    const w = this.waiters.get(handle);
    if (!w) return;
    this.waiters.delete(handle);
    this.delivery.settle(() => fn(w));
  }
}
