// A follower node that never submits (04 §12 stage 3; SYN-042). It holds one upstream channel on a
// room, which it opens like any reader, and fans the room's ordered stream out to its viewers. A
// viewer's submission is refused here and never reaches the room. The follower keeps no document:
// it serves a viewer by streaming the commits it holds, and a viewer it cannot serve from them is
// closed, so that the host can send it to the room (`reload`). Pure data in and out, no I/O.
//
// Ordering: a viewer's cursor only moves to the next seq, so a viewer sees each commit once and in
// ascending `seq`. A commit that does not follow the held head means the upstream stream lost a
// commit; the follower stops fanning out until the upstream channel is reopened with `resume()`
// and the commits from the head come again (SYN-042 criterion 4).
//
// Access (ADR 0019; ADR 0147 section 7): every viewer is served under its own access, which the
// host computes and passes to `open` and `permissions`; the upstream channel's access is never
// sent to a viewer. The follower applies no per-user projection (HIS-023), so it serves only
// readers of the whole document: a viewer with `manage`, or, while the document holds nothing
// that some reader cannot read (no confidential region, no sensitive field value), a viewer with
// `view` in every scope. The upstream channel must read the whole document too, or its stream is
// a projection and nobody is served. Until the follower has seen the document's content it
// assumes the content may hide something. A viewer it stops serving is closed with
// `access_changed` and reopens at the room.
import { DEFAULT_LIMITS } from '../codes.ts';
import type { Access } from '../permissions/access.ts';
import { regionPolicyOf } from '../permissions/model.ts';
import type {
  CommitInput,
  InlineContent,
  Outbound,
  Resume,
  StoredCommit,
  ToClient,
} from './types.ts';

export interface FollowerInit {
  /** Commits streamed to a resuming viewer at most, before it must be served elsewhere. */
  catchUpCommits?: number;
}

/** A viewer as the host knows it: its own access and its history gate. */
export interface FollowerViewer {
  /** The viewer's own effective access (07 §4), computed by the host for this viewer's connection. */
  access: Access;
  /**
   * The viewer's `minVisibleSeq` (07 §8; `room/gate.ts`). A resume from below it is not served
   * here. When absent the gate fails closed at the head: only a viewer at the head resumes here.
   */
  minVisibleSeq?: number;
}

/** Why a viewer's submission is refused: a follower takes no commits (SYN-042 criterion 2). */
export const FOLLOWER_REFUSAL = 'a follower takes no commits; the viewer must submit to the room';

interface Viewer {
  cursor: number;
  access: Access;
}

/** Whether an access holds `view` in every scope it knows of, and in a region yet to be made. */
function viewsEverywhere(a: Access): boolean {
  if (!a.docRole.has('view') || !a.body.has('view') || !a.newRegion.has('view')) return false;
  for (const caps of a.regions.values()) if (!caps.has('view')) return false;
  return true;
}

/**
 * Whether JSON (a document, a commit) may carry content that some reader cannot read (ADR 0019):
 * a region policy that reads as `confidential` (an unknown value does), or a field marked
 * `sensitive`, as a node attribute or as an attribute step. Conservative: a match anywhere counts.
 */
function mayHideContent(json: unknown): boolean {
  if (Array.isArray(json)) return json.some(mayHideContent);
  if (json === null || typeof json !== 'object') return false;
  const o = json as Record<string, unknown>;
  if (o['sensitive'] === true) return true;
  if ('policy' in o && regionPolicyOf(o['policy']) === 'confidential') return true;
  if (o['attr'] === 'sensitive' && o['value'] === true) return true;
  if (o['attr'] === 'policy' && regionPolicyOf(o['value']) === 'confidential') return true;
  return Object.values(o).some(mayHideContent);
}

export class Follower {
  private incarnation: string | null = null;
  /** The upstream channel's own access: checked, never sent to a viewer. */
  private upstreamAccess: Access | null = null;
  /** The newest permission revision seen upstream; a viewer's access from before it is stale. */
  private revision = 0;
  /** Whether the document may hold content some reader cannot read; true until content is seen. */
  private mayHide = true;
  private head = 0;
  /** Commits held, by `seq`, for resuming viewers; the oldest are dropped past the window. */
  private readonly held = new Map<number, StoredCommit>();
  private floor = 0;
  private lost = false;
  private readonly window: number;
  private readonly viewers = new Map<string, Viewer>();

  constructor(init: FollowerInit = {}) {
    this.window = init.catchUpCommits ?? DEFAULT_LIMITS.catchUpCommits!;
  }

  /** The upstream head the follower holds contiguously. */
  get seq(): number {
    return this.head;
  }

  /** True after the upstream stream lost a commit or closed, until it is reopened (criterion 4). */
  get stalled(): boolean {
    return this.lost;
  }

  get viewerCount(): number {
    return this.viewers.size;
  }

  /**
   * The resume position for reopening the upstream channel: the held head and incarnation. The
   * room answers with the commits after it (SYN-026), which `upstream` then receives.
   */
  resume(): Resume {
    return { seq: this.head, incarnation: this.incarnation ?? '', inflight: null };
  }

  /** One message of the upstream channel. Returns what the viewers receive as a result. */
  upstream(msg: ToClient): Outbound[] {
    switch (msg.t) {
      case 'ch.opened': {
        this.incarnation = msg.incarnation;
        this.upstreamAccess = msg.access;
        this.revision = Math.max(this.revision, msg.access.revision);
        if (msg.catchUp === 'reload') {
          // The follower's own commits no longer continue from the room: every viewer is closed
          // and the follower starts again from the content the room sent.
          return this.restart(msg.content ?? null, msg.head);
        }
        this.lost = false;
        return this.enforce();
      }
      case 'sync.commit':
        return this.receive(msg.commit);
      case 'sync.reset':
        return this.reset(msg);
      case 'perm.changed':
        // The upstream user's access is its own and is not forwarded. A newer revision makes every
        // viewer's access from an older one stale: such a viewer gets nothing more until the host
        // passes its own recomputed access to `permissions`.
        this.upstreamAccess = msg.access;
        this.revision = Math.max(this.revision, msg.revision);
        return this.enforce();
      case 'ch.closed':
        // The upstream subscription is gone: nothing more is fanned out until it is reopened.
        this.lost = true;
        return [];
      default:
        return [];
    }
  }

  /**
   * The host recomputed a viewer's own access (a permission change, an expiry, a token refresh:
   * the moments the room sends `perm.changed`). The viewer gets `perm.changed` with it and any
   * commits it was held back from, or is closed when the follower can no longer serve it.
   */
  permissions(channel: string, access: Access): Outbound[] {
    const viewer = this.viewers.get(channel);
    if (!viewer) return [];
    if (!this.serves(access) || access.revision < this.revision || viewer.cursor < this.floor) {
      this.viewers.delete(channel);
      return [{ channel, msg: { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' } }];
    }
    viewer.access = access;
    const out: Outbound[] = [
      { channel, msg: { t: 'perm.changed', revision: access.revision, access } },
    ];
    for (let s = viewer.cursor + 1; s <= this.head; s++) {
      out.push({ channel, msg: { t: 'sync.commit', commit: this.held.get(s)! } });
    }
    viewer.cursor = this.head;
    return out;
  }

  /**
   * A viewer opens on the follower with its own access. Without a resume, with one the follower
   * cannot serve from its held commits or that starts below the viewer's history gate, with
   * access from an older permission revision, or when the viewer may not read the whole document,
   * the viewer is closed with `unavailable` and must reopen at the room.
   */
  open(channel: string, viewer: FollowerViewer, resume?: Resume): Outbound[] {
    const closed: Outbound[] = [{ channel, msg: { t: 'ch.closed', code: 'unavailable' } }];
    if (this.incarnation === null) return closed;
    const { access } = viewer;
    if (!this.serves(access) || access.revision < this.revision) return closed;
    const servable =
      resume !== undefined &&
      resume.incarnation === this.incarnation &&
      Number.isSafeInteger(resume.seq) &&
      resume.seq >= this.floor &&
      resume.seq <= this.head &&
      resume.seq >= (viewer.minVisibleSeq ?? this.head) &&
      this.head - resume.seq <= this.window;
    if (!servable) return closed;
    const out: Outbound[] = [
      {
        channel,
        msg: {
          t: 'ch.opened',
          head: this.head,
          incarnation: this.incarnation,
          inflight: null,
          // The viewer's own access, never the upstream channel's (ADR 0019).
          access,
          catchUp: 'stream',
        },
      },
    ];
    for (let s = resume.seq + 1; s <= this.head; s++) {
      out.push({ channel, msg: { t: 'sync.commit', commit: this.held.get(s)! } });
    }
    out.push({ channel, msg: { t: 'sync.caughtUp', head: this.head } });
    this.viewers.set(channel, { cursor: this.head, access });
    return out;
  }

  /** A viewer's submission: refused with `read_only`, and never handed to the room (SYN-042). */
  submit(channel: string, input: CommitInput): Outbound[] {
    return [
      {
        channel,
        msg: {
          t: 'sync.reject',
          id: input.id,
          code: 'read_only',
          action: 'drop',
          head: this.head,
          reason: FOLLOWER_REFUSAL,
        },
      },
    ];
  }

  close(channel: string): void {
    this.viewers.delete(channel);
  }

  private receive(commit: StoredCommit): Outbound[] {
    if (commit.seq <= this.head) return []; // a repeat of a commit already fanned out
    if (commit.seq !== this.head + 1 || this.lost) {
      // A gap: the commit cannot be placed, so nothing past it is fanned out.
      this.lost = true;
      return [];
    }
    this.store(commit);
    const out: Outbound[] = [];
    // A commit that may bring in content some reader cannot read: viewers who may not read it are
    // closed before it is fanned out, so it never reaches them.
    if (!this.mayHide && mayHideContent(commit)) {
      this.mayHide = true;
      out.push(...this.enforce());
    }
    for (const [channel, viewer] of this.viewers) {
      if (viewer.cursor !== commit.seq - 1) continue;
      // Access from an older permission revision: held back until `permissions` refreshes it.
      if (viewer.access.revision < this.revision) continue;
      viewer.cursor = commit.seq;
      out.push({ channel, msg: { t: 'sync.commit', commit } });
    }
    return out;
  }

  /**
   * A snapshot commit upstream (04 §3.2): every viewer still served gets the same `sync.reset` and
   * its cursor moves. A viewer whose access is stale, or who may not read the new content, is closed.
   */
  private reset(msg: Extract<ToClient, { t: 'sync.reset' }>): Outbound[] {
    this.held.clear();
    this.head = msg.seq;
    this.floor = msg.seq;
    this.lost = false;
    this.mayHide = mayHideContent(msg.content);
    const out = this.enforce();
    for (const [channel, viewer] of this.viewers) {
      if (viewer.access.revision < this.revision) {
        this.viewers.delete(channel);
        out.push({
          channel,
          msg: { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' },
        });
        continue;
      }
      viewer.cursor = msg.seq;
      out.push({ channel, msg });
    }
    return out;
  }

  private restart(content: InlineContent | null, head: number): Outbound[] {
    const out: Outbound[] = [];
    for (const channel of this.viewers.keys())
      out.push({ channel, msg: { t: 'ch.closed', code: 'unavailable' } });
    this.viewers.clear();
    this.held.clear();
    this.head = content?.seq ?? head;
    this.floor = this.head;
    this.lost = false;
    // Without content the follower cannot tell what the document holds, so it assumes the worst.
    this.mayHide = content === null || mayHideContent(content.doc);
    return out;
  }

  /**
   * Whether a viewer with this access may be served: both it and the upstream channel read the
   * whole document (see the header).
   */
  private serves(access: Access): boolean {
    const reads = (a: Access) => a.docRole.has('manage') || (!this.mayHide && viewsEverywhere(a));
    return this.upstreamAccess !== null && reads(this.upstreamAccess) && reads(access);
  }

  /** Closes every viewer the follower may no longer serve, with `access_changed`. */
  private enforce(): Outbound[] {
    const out: Outbound[] = [];
    for (const [channel, viewer] of this.viewers) {
      if (this.serves(viewer.access)) continue;
      this.viewers.delete(channel);
      out.push({ channel, msg: { t: 'ch.closed', code: 'unavailable', reason: 'access_changed' } });
    }
    return out;
  }

  private store(commit: StoredCommit): void {
    this.held.set(commit.seq, commit);
    this.head = commit.seq;
    while (this.head - this.floor > this.window) {
      this.held.delete(this.floor + 1);
      this.floor += 1;
    }
  }
}
