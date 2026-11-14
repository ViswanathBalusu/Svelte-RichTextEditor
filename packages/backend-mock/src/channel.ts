/**
 * A document channel of the mock backend (05 §5.2 to §5.6; 05 §8.3 `SyncChannel`). Delivery goes
 * through the protocol package's OrderedDelivery, so the mock follows decision D21 exactly as any
 * other backend.
 */
import {
  type Access,
  type Ack,
  type ChannelOpened,
  type ChannelState,
  type Commit,
  type Notification,
  type PresencePeers,
  type RemoteCommit,
  type SyncChannel,
  type SyncCheck,
  type SyncReject,
  type SyncReset,
  type Unsubscribe,
  OrderedDelivery,
  PortError,
  ShapeValidator,
  SyncRejectError,
  DEP1,
} from '@docedit/protocol';

/** What the channel asks of its document. */
export interface ChannelHost {
  submit(channel: MockChannel, commit: Commit): void;
  closeChannel(channel: MockChannel): void;
}

/**
 * Where the backend's own ports listen: PermissionsPort.onAccess and PresencePort.onPeers receive
 * the same messages through the backend, so they never take the channel's kept messages away from
 * the channel's own callbacks.
 */
export interface ChannelForward {
  access(a: Access): void;
  presence(p: PresencePeers): void;
}

interface Waiter {
  resolve: (ack: Ack) => void;
  reject: (e: unknown) => void;
}

const validator = new ShapeValidator(DEP1);

export class MockChannel implements SyncChannel {
  readonly docId: string;
  readonly opened: ChannelOpened;
  /** The room's channel identifier. */
  readonly roomId: string;
  readonly session: string;
  private readonly host: ChannelHost;
  private readonly forward: ChannelForward;
  private readonly delivery = new OrderedDelivery();
  private readonly waiters = new Map<string, Waiter[]>();
  private latestAccess: Access;
  private closedFlag = false;

  constructor(
    host: ChannelHost,
    docId: string,
    roomId: string,
    session: string,
    opened: ChannelOpened,
    forward: ChannelForward,
  ) {
    this.host = host;
    this.forward = forward;
    this.docId = docId;
    this.roomId = roomId;
    this.session = session;
    this.opened = opened;
    this.latestAccess = opened.access;
    this.delivery.push('access', opened.access);
    forward.access(opened.access);
    this.delivery.push(
      'state',
      opened.catchUp === 'stream'
        ? ({ status: 'catching_up', head: opened.head } satisfies ChannelState)
        : ({ status: 'live', seq: opened.head } satisfies ChannelState),
    );
  }

  get isClosed(): boolean {
    return this.closedFlag;
  }

  get access(): Access {
    return this.latestAccess;
  }

  // --- SyncChannel ---------------------------------------------------------------------------

  submit(commit: Commit): Promise<Ack> {
    if (this.closedFlag)
      return Promise.reject(new PortError('unavailable', 'the channel is closed'));
    const violations = validator.checkNamed('Commit', commit);
    if (violations.length)
      return Promise.reject(
        new PortError(
          'bad_message',
          `invalid commit: ${violations.map((v) => `${v.path} ${v.message}`).join('; ')}`,
        ),
      );
    return new Promise<Ack>((resolve, reject) => {
      const list = this.waiters.get(commit.id) ?? [];
      list.push({ resolve, reject });
      this.waiters.set(commit.id, list);
      this.host.submit(this, commit);
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
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.failWaiters('the channel was closed before the commit was answered');
    this.host.closeChannel(this);
    this.delivery.end({
      drop: true,
      last: {
        kind: 'state',
        value: {
          status: 'closed',
          code: null,
          reason: 'closed by the client',
        } satisfies ChannelState,
      },
    });
  }

  // --- From the document ---------------------------------------------------------------------

  /**
   * Settles a waiter for a commit with its acknowledgement. An answer the room gives inside the
   * submit call answers that call (`newest`); a later one answers the commit in flight (`oldest`).
   */
  ack(ack: Ack, which: 'oldest' | 'newest' = 'oldest'): void {
    const w = this.take(ack.id, which);
    if (w) this.delivery.settle(() => w.resolve(ack));
  }

  reject(r: SyncReject, which: 'oldest' | 'newest' = 'oldest'): void {
    const w = this.take(r.id, which);
    if (w) this.delivery.settle(() => w.reject(new SyncRejectError(r)));
  }

  commits(list: RemoteCommit[]): void {
    if (list.length) this.delivery.push('commits', list);
  }

  reset(r: SyncReset): void {
    this.delivery.push('reset', r);
  }

  setAccess(a: Access): void {
    if (this.closedFlag) return;
    this.latestAccess = a;
    this.delivery.push('access', a);
    this.forward.access(a);
  }

  event(n: Notification): void {
    this.delivery.push('event', n);
  }

  state(s: ChannelState): void {
    this.delivery.push('state', s);
  }

  check(c: SyncCheck): void {
    this.delivery.push('check', c);
  }

  presence(p: PresencePeers): void {
    if (!this.closedFlag) this.forward.presence(p);
  }

  /** The server closed the channel (`ch.closed`, revocation). */
  serverClosed(
    code: 'forbidden' | 'unavailable' | 'slow_consumer',
    reason: string,
    retryInMs?: number,
  ): void {
    if (this.closedFlag) return;
    this.closedFlag = true;
    this.failWaiters(reason);
    const state: ChannelState =
      retryInMs === undefined
        ? { status: 'closed', code, reason }
        : { status: 'closed', code, reason, retryInMs };
    this.delivery.end({ last: { kind: 'state', value: state } });
  }

  private take(id: string, which: 'oldest' | 'newest'): Waiter | undefined {
    const list = this.waiters.get(id);
    const w = which === 'oldest' ? list?.shift() : list?.pop();
    if (list && list.length === 0) this.waiters.delete(id);
    return w;
  }

  private failWaiters(reason: string): void {
    for (const list of this.waiters.values())
      for (const w of list)
        this.delivery.settle(() => w.reject(new PortError('unavailable', reason)));
    this.waiters.clear();
  }
}
