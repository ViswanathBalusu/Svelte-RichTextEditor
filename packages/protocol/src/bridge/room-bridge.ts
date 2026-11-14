/**
 * The room's output on DEP's terms, per channel (05 §5.2 to §5.5; S6 report, section 6). The room
 * of `@docedit/authority` speaks DEP's message names in a compact in-process form; this bridge is
 * the one place where its output becomes DEP payloads, for the mock backend and for the document
 * service alike:
 *
 * - consecutive `sync.commit` messages for a channel are coalesced into one `commits` array;
 * - `perm.changed` is held until the control commit that records its grants revision has been
 *   delivered on the channel, and then carries that commit's `seq` as `asOfSeq` (D12; PRO-033);
 * - a commit that adds or removes a region, or changes a region's policy, is followed by
 *   `perm.changed` once it is stored (07 §4; D12; G46);
 * - `rev` counts the access objects sent on one channel (D12);
 * - `sync.caughtUp` carries `seq`, `ch.closed` a reason, `sync.reject` a message;
 * - sequence numbers are the room's plus an offset (the mock's snapshot segments; 0 elsewhere).
 *
 * Who sends what, and on which transport, is the caller's: the bridge only translates.
 */
import {
  computeAccess,
  regionsOf,
  type Access as RoomAccess,
  type CloseReason,
  type Connection,
  type Outbound,
  type PermissionState,
} from '@docedit/authority';
import type {
  Access,
  Ack,
  ChannelClosed,
  ChannelOpened,
  Inflight,
  RemoteCommit,
  SyncCaughtUp,
  SyncCommit,
  SyncReject,
  SyncReset,
} from '../generated/types.ts';
import {
  regionKey,
  storiesOf,
  toAccess,
  toAck,
  toReject,
  toRemoteCommit,
  type RoomDocument,
} from './translate.ts';

/** What the bridge reads from the room it translates for. */
export interface BridgeSource {
  /** The durable document (`Room.document`). */
  readonly document: RoomDocument;
  /** The durable head (`Room.head`), in the room's sequence numbers. */
  readonly head: number;
  readonly permissions: PermissionState;
}

export interface TranslateOptions {
  /**
   * The messages come from `Room.expire()`: access changed under the same grants revision, so no
   * control commit follows and `perm.changed` goes out at once, with `asOfSeq` at the head
   * (07 §4; PRM-007).
   */
  expiry?: boolean;
}

/** One DEP message for one channel, without its envelope. */
export type DepEvent =
  | { t: 'sync.commit'; d: SyncCommit }
  | { t: 'sync.ack'; d: Ack }
  | { t: 'sync.reject'; d: SyncReject }
  | { t: 'sync.caughtUp'; d: SyncCaughtUp }
  | { t: 'sync.reset'; d: SyncReset }
  | { t: 'perm.changed'; d: Access }
  | { t: 'ch.closed'; d: ChannelClosed };

export interface DepOutbound {
  channel: string;
  event: DepEvent;
  /**
   * For `ch.closed`: why the room closed the channel, as the room said (R2's `CloseReason`), so
   * that a caller can tell a change of access from a room that stopped (G103).
   */
  cause?: CloseReason;
}

/** The room's `ch.opened`, as `Room.open` and `ProjectionGateway.open` send it. */
export type RoomOpened = Extract<Outbound['msg'], { t: 'ch.opened' }>;

export interface RoomBridgeOptions {
  /** The room the bridge translates for, read when needed (the mock replaces its room on a snapshot). */
  source: () => BridgeSource;
  /** Server time, Unix milliseconds: access is computed for it. */
  now: () => number;
  /** External `seq` = the room's `seq` + offset (default 0). */
  offset?: () => number;
  /**
   * The user the wire shows for a stored one: the host's `sub` for a per-tenant surrogate in the
   * document service (D42; S6 gap G11), the identity by default.
   */
  user?: (stored: string) => string;
}

interface Attached {
  conn: Connection;
  /** The `rev` of the last access object sent on the channel. */
  rev: number;
  /** `perm.changed` held until the control commit of its revision is delivered (D12). */
  held: Array<{ revision: number; access: RoomAccess }>;
}

const CLOSE_REASONS: Readonly<Record<CloseReason, string>> = {
  fenced: 'another writer holds the document',
  lost: 'the outcome of a write could not be established',
  stopped: 'the room stopped serving the document',
  access_changed: 'what you may see in the document changed; reopen it',
};

/** The `reason` text of a `ch.closed` sent for a room's close reason. */
export function closeReasonText(reason: CloseReason | undefined): string {
  return reason ? CLOSE_REASONS[reason] : CLOSE_REASONS.stopped;
}

export class RoomBridge {
  readonly #source: () => BridgeSource;
  readonly #now: () => number;
  readonly #offset: () => number;
  readonly #user: (stored: string) => string;
  readonly #attached = new Map<string, Attached>();
  #regionKey: string;

  constructor(opts: RoomBridgeOptions) {
    this.#source = opts.source;
    this.#now = opts.now;
    this.#offset = opts.offset ?? (() => 0);
    this.#user = opts.user ?? ((u) => u);
    this.#regionKey = regionKey(this.#source().document);
  }

  has(channel: string): boolean {
    return this.#attached.has(channel);
  }

  get channels(): string[] {
    return [...this.#attached.keys()];
  }

  connection(channel: string): Connection | undefined {
    return this.#attached.get(channel)?.conn;
  }

  /**
   * The DEP `ch.opened` for the room's `ch.opened`, and the channel attached to the bridge. `head`
   * is the external head; `inflight` is present exactly when the client's resume named a commit
   * (D08), which only the caller can answer across segments, so it is passed in.
   */
  opened(
    channel: string,
    conn: Connection,
    msg: RoomOpened,
    extra: { inflight?: Inflight; catchUp?: ChannelOpened['catchUp'] } = {},
  ): ChannelOpened {
    const src = this.#source();
    const head = msg.head + this.#offset();
    this.#attached.set(channel, { conn, rev: 1, held: [] });
    const opened: ChannelOpened = {
      head,
      incarnation: msg.incarnation,
      catchUp: extra.catchUp ?? msg.catchUp,
      access: toAccess(
        msg.access,
        conn,
        src.permissions,
        storiesOf(src.document),
        1,
        head,
        this.#user,
      ),
    };
    if (extra.inflight !== undefined) opened.inflight = extra.inflight;
    // A projecting gateway names the reader's view (ADR 0019); the plain room serves the full view.
    if (msg.view !== undefined) opened.view = msg.view;
    return opened;
  }

  detach(channel: string): void {
    this.#attached.delete(channel);
  }

  /**
   * The channel's token was refreshed (05 §5.1 `auth.refresh`; PRM-021): the access objects sent
   * on it from now on describe the new connection (its role and groups), and `rev` keeps counting.
   */
  rebind(channel: string, conn: Connection): void {
    const a = this.#attached.get(channel);
    if (a) a.conn = conn;
  }

  /**
   * The room's messages as DEP messages, in order per channel. Consecutive commits for a channel
   * are coalesced; a control commit ends a batch, so that the `perm.changed` it releases follows it.
   * Messages for channels the bridge does not know are dropped.
   */
  translate(send: readonly Outbound[], opts: TranslateOptions = {}): DepOutbound[] {
    const offset = this.#offset();
    const out: DepOutbound[] = [];
    const batches = new Map<string, RemoteCommit[]>();
    const flush = (channel: string) => {
      const list = batches.get(channel);
      if (list?.length) {
        out.push({ channel, event: { t: 'sync.commit', d: { commits: list } } });
        batches.set(channel, []);
      }
    };
    for (const { channel, msg } of send) {
      const a = this.#attached.get(channel);
      if (!a) continue;
      switch (msg.t) {
        case 'sync.commit': {
          const rc = toRemoteCommit(msg.commit, offset, this.#user);
          const list = batches.get(channel) ?? [];
          list.push(rc);
          batches.set(channel, list);
          if (msg.commit.kind === 'control') {
            flush(channel);
            this.#releaseHeld(channel, a, msg.commit.revision, rc.seq, out);
          }
          break;
        }
        case 'sync.ack':
          flush(channel);
          out.push({ channel, event: { t: 'sync.ack', d: toAck(msg, offset) } });
          break;
        case 'sync.reject':
          flush(channel);
          out.push({ channel, event: { t: 'sync.reject', d: toReject(msg, offset) } });
          break;
        case 'sync.caughtUp':
          flush(channel);
          out.push({ channel, event: { t: 'sync.caughtUp', d: { seq: msg.head + offset } } });
          break;
        case 'sync.reset':
          flush(channel);
          out.push({
            channel,
            event: { t: 'sync.reset', d: { seq: msg.seq + offset, reason: msg.reason } },
          });
          break;
        case 'perm.changed':
          flush(channel);
          if (opts.expiry) {
            // An expiry changes access without a new revision: nothing to wait for.
            const src = this.#source();
            a.rev += 1;
            out.push({
              channel,
              event: {
                t: 'perm.changed',
                d: toAccess(
                  msg.access,
                  a.conn,
                  src.permissions,
                  storiesOf(src.document),
                  a.rev,
                  src.head + offset,
                  this.#user,
                ),
              },
            });
            break;
          }
          // The room sends perm.changed before it stores the control commit; DEP sends it after,
          // with asOfSeq set to that commit (05 §5.9, PRO-033; D12).
          a.held.push({ revision: msg.revision, access: msg.access });
          break;
        case 'ch.closed': {
          flush(channel);
          this.#attached.delete(channel);
          const o: DepOutbound = {
            channel,
            event: {
              t: 'ch.closed',
              d: { code: 'unavailable', reason: closeReasonText(msg.reason) },
            },
          };
          if (msg.reason !== undefined) o.cause = msg.reason;
          out.push(o);
          break;
        }
        case 'ch.opened':
          break;
      }
    }
    for (const channel of batches.keys()) flush(channel);
    return out;
  }

  #releaseHeld(
    channel: string,
    a: Attached,
    revision: number,
    seq: number,
    out: DepOutbound[],
  ): void {
    const ready = a.held.filter((h) => h.revision <= revision);
    if (!ready.length) return;
    a.held = a.held.filter((h) => h.revision > revision);
    const last = ready[ready.length - 1]!;
    const src = this.#source();
    a.rev += 1;
    out.push({
      channel,
      event: {
        t: 'perm.changed',
        d: toAccess(
          last.access,
          a.conn,
          src.permissions,
          storiesOf(src.document),
          a.rev,
          seq,
          this.#user,
        ),
      },
    });
  }

  /**
   * After stored commits: when the region list changed, every channel's access is computed again
   * and sent with `asOfSeq` at the durable head (07 §4; D12; G46). Call it after the messages of a
   * completed write were translated.
   */
  regionsChanged(head: number): DepOutbound[] {
    const key = regionKey(this.#source().document);
    if (key === this.#regionKey) return [];
    this.#regionKey = key;
    return this.recomputeAccess(head);
  }

  /** Forgets the region list, after the room was replaced (a snapshot in the mock). */
  resetRegions(): void {
    this.#regionKey = regionKey(this.#source().document);
  }

  /**
   * Every channel's access computed again from the durable document, the room's permissions and
   * the clock (07 §4), with `asOfSeq` set to `asOfSeq` (an external `seq`).
   */
  recomputeAccess(asOfSeq: number): DepOutbound[] {
    const src = this.#source();
    const regions = regionsOf(src.document);
    const stories = storiesOf(src.document);
    const out: DepOutbound[] = [];
    for (const [channel, a] of this.#attached) {
      const access = computeAccess(a.conn, regions, src.permissions, this.#now());
      a.rev += 1;
      out.push({
        channel,
        event: {
          t: 'perm.changed',
          d: toAccess(access, a.conn, src.permissions, stories, a.rev, asOfSeq, this.#user),
        },
      });
    }
    return out;
  }
}
