/**
 * The projection gateway (ADR 0019, proposed; spike S12; SYN-050 to SYN-053). It sits between the
 * room and the channels: everything sent to a reader is rewritten for the reader's visibility
 * class, and everything a reader submits is mapped from projected to full positions before the
 * room sees it.
 *
 * It follows the log through an internal observer channel on the room, which receives every stored
 * commit, and keeps per visibility class the projection at each sequence number and the steps each
 * commit sends to the class (`projectCommit`: mapped steps where the commit does not touch hidden
 * content, a local diff step for each step that does).
 */
import { supportedFeatures } from '@docedit/model/definition';
import type { Node, Schema } from 'prosemirror-model';
import { AttrStep, ReplaceAroundStep, ReplaceStep, Step } from 'prosemirror-transform';
import type { ThreadAction } from '../permissions/comments.ts';
import type { Connection, PermissionState } from '../permissions/model.ts';
import { applySteps, mapsOf, rebaseOver } from '../rebase.ts';
import type {
  AuthoredRequest,
  Room,
  SnapshotRequest,
  ThreadOutcome,
  ThreadRequest,
} from '../room/room.ts';
import type { ThreadAnchor } from '../room/threads.ts';
import {
  type CommitInput,
  type Effects,
  type LogCommit,
  type Outbound,
  type Resume,
  type RoomConnection,
  type SnapshotCommit,
  type StoredCommit,
  type ToClient,
  type WriteResult,
  isSnapshot,
} from '../room/types.ts';
import { stepsToJson } from '../steps.ts';
import { visibleScopes as visibleScopesOf } from './page.ts';
import {
  type HiddenSet,
  type Projection,
  type StepRoute,
  fullToProj,
  hidesNothing,
  projToFull,
  project,
  projectCommit,
  projectionSchema,
  toFullSteps,
  visibilityKey,
} from './projection.ts';

const OBSERVER = '\u0000gateway-observer';

/** Attributes whose change can hide or reveal content (ADR 0019; PRM-067). */
const VISIBILITY_ATTRS = new Set(['policy', 'sensitive', 'assignee']);

/** Whether a stored step can change what a reader may see, so that classes are derived again. */
function changesVisibility(step: Step): boolean {
  if (step instanceof AttrStep) return VISIBILITY_ATTRS.has(step.attr);
  if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
    let found = false;
    step.slice.content.descendants((n) => {
      if (n.type.name === 'region' || n.type.name === 'form_field') found = true;
      return !found;
    });
    return found;
  }
  return false;
}

/**
 * An opaque token for a visibility class. A short FNV-1a hash of the class key, so that the token
 * names the view without listing which scopes it hides. (A production token would be keyed.)
 */
export function viewToken(key: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `v${h.toString(16).padStart(8, '0')}`;
}

/**
 * The reason of an `invalid_op` refusal for a read-restricted reader: the failing step's index,
 * when the room named one, and nothing of the document (ADR 0019).
 */
export function withheldReason(reason: string): string {
  const step = /^step (\d+)\b/.exec(reason);
  return step
    ? `step ${step[1]} does not apply to the document`
    : 'the commit does not apply to the document';
}

/**
 * The gateway's own channel on the room. It projects with the full CDM schema, so it announces
 * every CDM feature: it never keeps a document from gaining one (03 §11.1; CDM-047).
 */
const OBSERVER_CONN: Connection & { features: readonly string[] } = {
  sub: 'system:gateway',
  session: 'gateway',
  role: 'viewer',
  groups: [],
  participantRoles: [],
  participantActive: false,
  features: supportedFeatures(),
};

interface ClassState {
  hidden: HiddenSet;
  /** The projection at each sequence number the class has needed. */
  views: Map<number, Projection>;
  /** The steps each commit sends to the class; empty when it changed only hidden content. */
  out: Map<number, Step[]>;
}

interface ChannelState {
  conn: Connection;
  key: string;
}

/** What a connection may not see, given the document and the permissions in force. */
export type Visibility = (conn: Connection, fullDoc: Node, perms: PermissionState) => HiddenSet;

/** How the gateway routed the steps it sent, summed over every class (SYN-051). */
export interface GatewayStats {
  routes: Record<StepRoute, number>;
  /** Commits a class received with no steps because they changed only hidden content. */
  empty: number;
}

export class ProjectionGateway {
  private readonly room: Room;
  private readonly fschema: Schema;
  private readonly pschema: Schema;
  private readonly visibility: Visibility;
  private readonly full = new Map<number, Node>();
  /** The parsed steps of every step commit the gateway has followed. */
  private readonly stepsOf = new Map<number, Step[]>();
  /** Sequence numbers of snapshot commits. */
  private readonly snapshots = new Set<number>();
  private head = 0;
  private readonly classes = new Map<string, ClassState>();
  private readonly channels = new Map<string, ChannelState>();
  /** The steps read-restricted readers sent, by commit identifier, until they are acknowledged. */
  private readonly submitted = new Map<string, unknown>();
  /** The grants revision visibility was last derived from. */
  private revision: number;
  /**
   * Set when visibility must be derived again although the revision did not move: a snapshot
   * replaced the document, or a grant expired.
   */
  private replaced = false;
  readonly stats: GatewayStats = {
    routes: { mapped: 0, noop: 0, inside: 0, value: 0, diff: 0 },
    empty: 0,
  };
  /** Optional diagnostics: called with a short description of every visibility decision. */
  onEvent: ((event: string) => void) | undefined;

  /**
   * @param history the content at sequence number `initialSeq` (0 when omitted) and the stored
   * log after it, so that a gateway started after a failover can project the catch-up stream of
   * clients that resume from an older sequence number; `resolve` gives the content of a snapshot
   * commit's checkpoint. A room opened from a checkpoint at S passes that checkpoint and S, as
   * `RoomInit.initialSeq` does. (A production gateway would load projections from checkpoints.)
   */
  constructor(
    room: Room,
    fschema: Schema,
    visibility: Visibility,
    pschema: Schema = projectionSchema(),
    history?: {
      initial: Node;
      log: readonly LogCommit[];
      resolve?: (c: SnapshotCommit) => Node;
      initialSeq?: number;
    },
  ) {
    this.room = room;
    this.fschema = fschema;
    this.pschema = pschema;
    this.visibility = visibility;
    this.revision = room.permissions.revision;
    if (history) {
      let doc = history.initial;
      const start = history.initialSeq ?? 0;
      this.full.set(start, doc);
      for (const c of history.log) {
        if (c.seq <= start) continue;
        if (isSnapshot(c)) {
          if (!history.resolve)
            throw new Error(`gateway: snapshot commit ${c.seq} needs its checkpoint`);
          doc = history.resolve(c);
          this.snapshots.add(c.seq);
        } else {
          const steps = c.steps.map((s) => Step.fromJSON(fschema, s));
          const r = applySteps(doc, steps);
          if (!r.ok) throw new Error(`gateway: stored commit ${c.seq} does not apply: ${r.reason}`);
          doc = r.value.doc;
          this.stepsOf.set(c.seq, steps);
        }
        this.full.set(c.seq, doc);
      }
    }
    const fx = room.open(OBSERVER, OBSERVER_CONN);
    for (const o of fx.send) {
      if (o.channel === OBSERVER && o.msg.t === 'ch.opened' && o.msg.content) {
        this.head = o.msg.content.seq;
        if (!this.full.has(this.head))
          this.full.set(this.head, fschema.nodeFromJSON(o.msg.content.doc));
      }
    }
  }

  /** The number of visibility classes the gateway projects for (SR-M7: work per commit). */
  get classCount(): number {
    return this.classes.size;
  }

  private cls(hidden: HiddenSet): ClassState {
    const key = visibilityKey(hidden);
    let c = this.classes.get(key);
    if (!c) {
      c = { hidden, views: new Map(), out: new Map() };
      this.classes.set(key, c);
    }
    return c;
  }

  private fullAt(seq: number): Node {
    const f = this.full.get(seq);
    if (!f) throw new Error(`no full document at ${seq}`);
    return f;
  }

  /** The class's projection at a sequence number. */
  private view(c: ClassState, seq: number): Projection {
    const known = c.views.get(seq);
    if (known) return known;
    // Roll forward one commit when the projection before it is known; otherwise project afresh.
    if (seq > 0 && c.views.has(seq - 1) && !this.snapshots.has(seq)) {
      this.outgoing(c, seq);
      return c.views.get(seq)!;
    }
    const p = project(this.fullAt(seq), c.hidden, this.pschema);
    c.views.set(seq, p);
    return p;
  }

  /** The steps a commit sends to a class (SYN-051). */
  private outgoing(c: ClassState, seq: number): Step[] {
    const known = c.out.get(seq);
    if (known) return known;
    if (this.snapshots.has(seq)) {
      c.out.set(seq, []);
      if (!c.views.has(seq)) c.views.set(seq, project(this.fullAt(seq), c.hidden, this.pschema));
      return [];
    }
    const before = this.view(c, seq - 1);
    const r = projectCommit(
      before,
      this.fullAt(seq - 1),
      this.stepsOf.get(seq) ?? [],
      c.hidden,
      this.pschema,
    );
    for (const route of r.routes) this.stats.routes[route]++;
    if (r.steps.length === 0 && (this.stepsOf.get(seq)?.length ?? 0) > 0) this.stats.empty++;
    if (!c.views.has(seq)) c.views.set(seq, r.view);
    c.out.set(seq, r.steps);
    return r.steps;
  }

  /** Follows stored commits from the observer channel; returns the effects without them. */
  private follow(fx: Effects): Outbound[] {
    const rest: Outbound[] = [];
    for (const o of fx.send) {
      if (o.channel !== OBSERVER) {
        rest.push(o);
        continue;
      }
      if (o.msg.t === 'sync.commit') {
        const c = o.msg.commit;
        if (c.seq !== this.head + 1) throw new Error(`gateway gap: ${c.seq} after ${this.head}`);
        const steps = c.steps.map((s) => Step.fromJSON(this.fschema, s));
        const r = applySteps(this.fullAt(this.head), steps);
        if (!r.ok) throw new Error(`gateway: stored commit ${c.seq} does not apply: ${r.reason}`);
        this.head = c.seq;
        this.full.set(c.seq, r.value.doc);
        this.stepsOf.set(c.seq, steps);
        // A commit can change what a reader may see: a region's policy or a field's `sensitive`,
        // `assignee` or region, or a new region or field. Visibility is then derived again.
        if (steps.some(changesVisibility)) this.replaced = true;
      } else if (o.msg.t === 'sync.reset') {
        if (o.msg.seq !== this.head + 1)
          throw new Error(`gateway gap: reset ${o.msg.seq} after ${this.head}`);
        this.head = o.msg.seq;
        this.full.set(o.msg.seq, this.fschema.nodeFromJSON(o.msg.content.doc));
        this.snapshots.add(o.msg.seq);
        this.replaced = true;
      }
    }
    return rest;
  }

  private visibleScopes(scopes: readonly string[], hidden: HiddenSet): string[] {
    return visibleScopesOf(scopes, hidden);
  }

  /** Rewrites the messages of one channel for its visibility class. */
  private rewrite(out: Outbound[]): Outbound[] {
    const result: Outbound[] = [];
    for (const o of out) {
      const ch = this.channels.get(o.channel);
      if (!ch) {
        result.push(o);
        continue;
      }
      const c = this.classes.get(ch.key)!;
      const m = o.msg;
      const send = (msg: ToClient) => result.push({ channel: o.channel, msg });
      switch (m.t) {
        case 'sync.commit': {
          const commit: StoredCommit = {
            ...m.commit,
            steps: stepsToJson(this.outgoing(c, m.commit.seq)),
            scopes: this.visibleScopes(m.commit.scopes, c.hidden),
            retired: m.commit.retired.filter((r) => !c.hidden.regions.has(r)),
          };
          send({ t: 'sync.commit', commit });
          break;
        }
        case 'sync.ack': {
          // A class that hides nothing receives the room's own acknowledgement. A read-restricted
          // reader gets its class's steps (SYN-051), unless they are exactly the steps it sent and
          // the room did not rebase them: then the acknowledgement says `rebased: false`, as DEP
          // expects for a commit made on the head (conformance kit, `core.sync.ack`).
          if (hidesNothing(c.hidden)) {
            this.submitted.delete(m.id);
            send(m);
            break;
          }
          const steps = stepsToJson(this.outgoing(c, m.seq));
          const sent = this.submitted.get(m.id);
          this.submitted.delete(m.id);
          if (!m.rebased && sent !== undefined && JSON.stringify(sent) === JSON.stringify(steps))
            send({ t: 'sync.ack', id: m.id, seq: m.seq, time: m.time, rebased: false });
          else send({ t: 'sync.ack', id: m.id, seq: m.seq, time: m.time, rebased: true, steps });
          break;
        }
        case 'sync.reject': {
          this.submitted.delete(m.id);
          // An `invalid_op` reason comes from the full document: a ProseMirror error or a
          // validator message can quote its content or a value. A read-restricted reader gets the
          // step index only (ADR 0019).
          const reason =
            m.code === 'invalid_op' && !hidesNothing(c.hidden)
              ? withheldReason(m.reason)
              : m.reason;
          send({
            ...m,
            reason,
            ...(m.scopes ? { scopes: this.visibleScopes(m.scopes, c.hidden) } : {}),
          });
          break;
        }
        case 'sync.reset':
          // A reader receives the projection of the snapshot, never the full content.
          this.outgoing(c, m.seq);
          send({
            ...m,
            view: viewToken(ch.key),
            content: { ...m.content, doc: this.view(c, m.seq).doc.toJSON() },
          });
          break;
        case 'ch.opened': {
          const view = viewToken(ch.key);
          if (m.catchUp === 'page') {
            // The commits resource would have to serve the class's steps; a reader reloads instead.
            send({
              ...m,
              catchUp: 'reload',
              view,
              content: {
                seq: m.head,
                doc: this.view(c, m.head).doc.toJSON(),
                requires: [...this.room.requiresList],
                incarnation: m.incarnation,
              },
            });
          } else if (m.content)
            send({
              ...m,
              view,
              content: { ...m.content, doc: this.view(c, m.content.seq).doc.toJSON() },
            });
          else send({ ...m, view });
          break;
        }
        default:
          send(m);
      }
    }
    return result;
  }

  private finish(fx: Effects): Effects {
    const rest = this.follow(fx);
    const send = this.rewrite(rest);
    // Whenever the room's permissions moved (a notification, or a write refused because the
    // grants revision moved) or a snapshot replaced the document, visibility is derived again; a
    // reader whose view changed is closed and reloads, so that no projection of the old view
    // reaches them again (SYN-053).
    if (this.room.permissions.revision !== this.revision || this.replaced) {
      this.onEvent?.(
        `revision ${this.revision} -> ${this.room.permissions.revision}${this.replaced ? ', snapshot' : ''}; channels ${[...this.channels.keys()].join(',')}`,
      );
      this.revision = this.room.permissions.revision;
      this.replaced = false;
      for (const [id, ch] of this.channels) {
        const key = visibilityKey(this.hiddenFor(ch.conn));
        this.onEvent?.(`  ${id}: ${ch.key} -> ${key}`);
        if (key === ch.key) continue;
        this.channels.delete(id);
        this.room.close(id);
        for (let i = send.length - 1; i >= 0; i--) if (send[i]!.channel === id) send.splice(i, 1);
        send.push({
          channel: id,
          msg: { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
        });
      }
    }
    if (fx.refused) this.channels.delete(fx.refused.channel);
    return {
      send,
      write: fx.write,
      ...(fx.checkpoints ? { checkpoints: fx.checkpoints } : {}),
      ...(fx.refused ? { refused: fx.refused } : {}),
    };
  }

  private hiddenFor(conn: Connection): HiddenSet {
    const hidden = this.visibility(conn, this.fullAt(this.head), this.room.permissions);
    this.cls(hidden);
    return hidden;
  }

  /**
   * Opens a channel for a reader.
   *
   * @param stored the permission state read from storage for this open (ADR 0019 change 3;
   * SYN-053). When its revision is newer than the room's, the room is brought up to it first, so
   * that a lost notification cannot make the content a projection of revoked access.
   */
  open(channel: string, conn: RoomConnection, resume?: Resume, stored?: PermissionState): Effects {
    const pre =
      stored && stored.revision > this.room.permissions.revision
        ? this.finish(this.room.permissionsChanged(stored))
        : null;
    const hidden = this.hiddenFor(conn);
    const key = visibilityKey(hidden);
    this.channels.set(channel, { conn, key });
    // The client says which view its confirmed document is a projection for. Anything but the
    // current view (or no token at all) must reload; the gateway cannot know what was delivered.
    const forced = !resume || resume.view !== viewToken(key);
    this.onEvent?.(
      `open ${channel} (${conn.sub}) key ${key} resume ${resume ? `${resume.seq} view ${resume.view ?? 'none'}` : 'none'} forced ${forced}`,
    );
    const fx = this.finish(this.room.open(channel, conn, forced ? undefined : resume));
    if (!pre) return fx;
    return {
      send: [...pre.send, ...fx.send],
      write: pre.write ?? fx.write,
      ...(pre.checkpoints ? { checkpoints: pre.checkpoints } : {}),
    };
  }

  close(channel: string): void {
    this.channels.delete(channel);
    this.room.close(channel);
  }

  submit(channel: string, input: CommitInput): Effects {
    const ch = this.channels.get(channel);
    if (!ch) return { send: [], write: null };
    const c = this.classes.get(ch.key)!;
    if (hidesNothing(c.hidden)) return this.finish(this.room.submit(channel, input));
    const reject = (
      code: 'invalid_op' | 'rebase_failed' | 'permission_denied' | 'stale_base',
      reason: string,
      action: 'drop' | 'rebase' | 'reload' = 'drop',
    ): Effects => ({
      send: [
        {
          channel,
          msg: {
            t: 'sync.reject',
            id: typeof input?.id === 'string' ? input.id : '',
            code,
            action,
            head: this.head,
            reason,
          },
        },
      ],
      write: null,
    });
    if (
      !input ||
      typeof input !== 'object' ||
      !Array.isArray(input.steps) ||
      !Number.isSafeInteger(input.base)
    )
      return this.finish(this.room.submit(channel, input));
    if (input.base > this.head) return reject('invalid_op', 'base is ahead of the head', 'reload');
    if (!this.full.has(input.base) || input.base < 0)
      return reject('stale_base', 'base is older than the projections kept', 'rebase');
    for (let s = input.base + 1; s <= this.head; s++)
      if (this.snapshots.has(s))
        return reject('stale_base', `a snapshot commit (${s}) lies after the base`, 'rebase');
    let steps: Step[];
    try {
      steps = (input.steps as unknown[]).map((s) => Step.fromJSON(this.pschema, s));
    } catch (e) {
      return reject('invalid_op', `malformed step: ${(e as Error).message}`);
    }
    // Rebase in projected space over the class's steps since the base, then map to full positions.
    const over: Step[] = [];
    for (let s = input.base + 1; s <= this.head; s++) over.push(...this.outgoing(c, s));
    const head = this.view(c, this.head);
    let atHead = steps;
    if (over.length) {
      const r = rebaseOver(steps, mapsOf(over), head.doc, 'reject');
      if (!r.ok) return reject('rebase_failed', r.reason, 'rebase');
      atHead = r.value.steps;
    }
    const mapped = toFullSteps(
      atHead,
      this.fullAt(this.head),
      c.hidden,
      this.pschema,
      this.fschema,
      head,
    );
    if (!mapped.ok)
      return reject(
        mapped.code === 'permission_denied' ? 'permission_denied' : 'invalid_op',
        mapped.reason,
      );
    // Unrebased steps stay as sent; the acknowledgement compares the class's steps with them.
    if (typeof input.id === 'string')
      this.submitted.set(input.id, over.length ? null : stepsToJson(steps));
    return this.finish(
      this.room.submit(channel, {
        ...input,
        base: this.head,
        steps: stepsToJson(mapped.value.steps),
      }),
    );
  }

  writeCompleted(result: WriteResult): Effects {
    return this.finish(this.room.writeCompleted(result));
  }

  /** The control plane changed permissions and notified the room. */
  permissionsChanged(perms: PermissionState): Effects {
    return this.finish(this.room.permissionsChanged(perms));
  }

  /**
   * A grant or a lease expired (07 §4; PRM-007): access changed without a new revision, so the
   * visibility of every channel is derived again and readers whose class changed reload (SYN-053).
   */
  expire(): Effects {
    this.replaced = true;
    return this.finish(this.room.expire());
  }

  /**
   * A channel's token was refreshed (05 §5.1; PRM-067 criterion 3): its claims can change what
   * the reader may see, so its class is derived again, and a reader whose class changed reloads.
   */
  refresh(channel: string, conn: RoomConnection): Effects {
    const ch = this.channels.get(channel);
    if (!ch) return { send: [], write: null };
    // A token for another user: the room closes the channel.
    if (conn.sub !== ch.conn.sub) this.channels.delete(channel);
    else {
      ch.conn = conn;
      this.replaced = true;
    }
    return this.finish(this.room.refresh(channel, conn));
  }

  /** A snapshot commit through the room (SYN-005); readers receive the projection of its content. */
  snapshot(requester: string, request: SnapshotRequest): Effects {
    return this.finish(this.room.snapshot(requester, request));
  }

  /** A server-authored step commit through the room (SYN-030). */
  author(requester: string, request: AuthoredRequest): Effects {
    return this.finish(this.room.author(requester, request));
  }

  /** Stops the room and closes every channel (see `Room.stop`). */
  stop(): Effects {
    return this.finish(this.room.stop());
  }

  get fullHead(): Node {
    return this.fullAt(this.head);
  }

  /**
   * Checks every projection the gateway holds, and the steps each class received, against
   * projections built from scratch (SYN-051): a class's steps for a commit turn its projection
   * before the commit into exactly the projection after it. For tests and diagnostics; it costs a
   * projection per class and sequence number. Returns the mismatches.
   */
  audit(): string[] {
    const out: string[] = [];
    const fresh = new Map<string, Projection>();
    const truth = (c: ClassState, key: string, seq: number): Projection => {
      const k = `${key}\u0000${seq}`;
      let p = fresh.get(k);
      if (!p) {
        p = project(this.fschema.nodeFromJSON(this.fullAt(seq).toJSON()), c.hidden, this.pschema);
        fresh.set(k, p);
      }
      return p;
    };
    for (const [key, c] of this.classes) {
      for (const [seq, view] of c.views) {
        const t = truth(c, key, seq);
        if (!view.doc.eq(t.doc))
          out.push(`class ${viewToken(key)}: the projection at ${seq} differs from the document's`);
        if (JSON.stringify(view.spans) !== JSON.stringify(t.spans))
          out.push(`class ${viewToken(key)}: the hidden spans at ${seq} are wrong`);
      }
      for (const [seq, steps] of c.out) {
        if (this.snapshots.has(seq)) continue;
        let doc = truth(c, key, seq - 1).doc;
        for (const s of steps) {
          const r = s.apply(doc);
          if (!r.doc) {
            out.push(
              `class ${viewToken(key)}: a step of commit ${seq} does not apply: ${r.failed}`,
            );
            break;
          }
          doc = r.doc;
        }
        if (!doc.eq(truth(c, key, seq).doc))
          out.push(
            `class ${viewToken(key)}: the steps of commit ${seq} do not give its projection`,
          );
      }
    }
    return out;
  }

  /** The projection a class holds at the head, for tests and diagnostics. */
  projectionAtHead(hidden: HiddenSet): Projection {
    return this.view(this.cls(hidden), this.head);
  }

  // -------------------------------------------------------------------------------------------
  // Comment threads for read-restricted readers (ADR 0019 decision item 5; PRM-037, PRM-039 as the
  // S12 report changes them): a reader's ranges are in projected positions and are mapped to full
  // ones; a thread whose target lies in hidden content is `not_found`; ranges the reader receives
  // are projected positions at the head.

  /** An anchor as a reader of this class sees it, or null when its target is hidden from them. */
  private projectAnchor(a: ThreadAnchor, view: Projection): ThreadAnchor | null {
    if (!('range' in a.target)) return { ...a, ...(a.scopes ? { scopes: [...a.scopes] } : {}) };
    const from = fullToProj(view, a.target.range.from);
    const to = fullToProj(view, a.target.range.to);
    if (from === null || to === null) return null;
    return {
      ...a,
      target: { range: { from, to } },
      ...(a.scopes ? { scopes: [...a.scopes] } : {}),
    };
  }

  private hideScopes(o: ThreadOutcome, hidden: HiddenSet): ThreadOutcome {
    if (o.ok || !o.scopes) return o;
    return { ...o, scopes: this.visibleScopes(o.scopes, hidden) };
  }

  /**
   * Starts a thread for a reader whose range is in projected positions at `baseSeq`. A range that
   * covers a placeholder is refused: a reader cannot comment on what they cannot see.
   */
  createThread(req: ThreadRequest): ThreadOutcome {
    const hidden = this.hiddenFor(req.as);
    const c = this.cls(hidden);
    if (hidesNothing(hidden) || !('range' in req.target)) {
      const o = this.room.createThread(req);
      if (!o.ok) return this.hideScopes(o, hidden);
      const p = this.projectAnchor(o.thread, this.view(c, this.head));
      return p
        ? { ok: true, thread: p }
        : { ok: false, code: 'not_found', reason: 'no such block' };
    }
    const { from, to, baseSeq } = req.target.range;
    if (!Number.isSafeInteger(baseSeq) || !this.full.has(baseSeq))
      return {
        ok: false,
        code: 'stale_base',
        reason: 'the range cannot be mapped from its baseSeq',
      };
    const at = this.view(c, baseSeq);
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || to <= from)
      return { ok: false, code: 'invalid_op', reason: 'a range needs from < to' };
    if (at.spans.some((s) => from < s.projStart + 1 && to > s.projStart))
      return {
        ok: false,
        code: 'permission_denied',
        reason: 'the range covers content you cannot see',
      };
    const full = {
      ...req,
      target: { range: { from: projToFull(at, from), to: projToFull(at, to), baseSeq } },
    };
    const o = this.room.createThread(full);
    if (!o.ok) return this.hideScopes(o, hidden);
    const p = this.projectAnchor(o.thread, this.view(c, this.head));
    return p ? { ok: true, thread: p } : { ok: false, code: 'not_found', reason: 'no such thread' };
  }

  /** The threads a reader may see, with ranges in their projected positions at the head. */
  threadsFor(conn: Connection): ThreadAnchor[] {
    const view = this.view(this.cls(this.hiddenFor(conn)), this.head);
    const out: ThreadAnchor[] = [];
    for (const a of this.room.threadAnchors()) {
      if (!this.room.threadAccess(a.id, conn, 'read').ok) continue;
      const p = this.projectAnchor(a, view);
      if (p) out.push(p);
    }
    return out;
  }

  /** Whether a reader may act on a thread; a thread in hidden content is `not_found`. */
  threadAccess(threadId: string, conn: Connection, action: ThreadAction): ThreadOutcome {
    const hidden = this.hiddenFor(conn);
    const o = this.room.threadAccess(threadId, conn, action);
    if (!o.ok) return this.hideScopes(o, hidden);
    const p = this.projectAnchor(o.thread, this.view(this.cls(hidden), this.head));
    return p ? { ok: true, thread: p } : { ok: false, code: 'not_found', reason: 'no such thread' };
  }
}
