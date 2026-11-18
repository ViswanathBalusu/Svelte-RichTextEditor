/**
 * The client side of one document channel (05 §5.2 to §5.6; 04 §8, §9; PRO-004): opening and
 * catching up, the order of commits and acknowledgements, and resuming. Like ClientSession it does
 * no I/O: the caller passes in the messages addressed to the channel and acts on the effects.
 *
 * What the caller observes, whatever the network does (decision D80):
 * - commits and acknowledgements in ascending `seq`, each `seq` once, without gaps; a duplicate is
 *   dropped, and a gap resumes the channel instead of reaching the caller;
 * - after a gap, an answer that did not come within `ackTimeoutMs`, a lost connection or
 *   `ch.closed` with `unavailable`, `internal` or `slow_consumer` (the last two per PRO-039: back off
 *   for the hint, then resume), the channel resumes by itself with
 *   `resume: { seq, incarnation, inflight, view }` (04 §9; D28): unanswered submits fail with
 *   `unavailable` (D23), the state goes `resuming`, then `catching_up` and `live`, and a commit
 *   that was in flight reaches the caller in the catch-up stream if it was stored;
 * - a resume answered with `reload` closes the channel with code `unavailable` and `retryInMs: 0`:
 *   the confirmed document must be replaced (04 §9 step 3; ADR 0019), which only the caller can
 *   do, by reopening it;
 * - submits made while the channel is not live wait until it is (04 §9 step 5: an in-flight commit
 *   is resubmitted only after `sync.caughtUp`).
 */
import { utf8Length } from '../codec/frame.ts';
import { ShapeValidator } from '../codec/validate.ts';
import { DEP1_WIRE } from '../definition/wire.ts';
import type {
  Access,
  Ack,
  ChannelClosed,
  ChannelOpen,
  ChannelOpened,
  ClientMessage,
  Commit,
  ErrorCode,
  ErrorPayload,
  Notification,
  PresencePeers,
  RemoteCommit,
  Resume,
  ServerMessage,
  SyncCheck,
  SyncReject,
  SyncReset,
  WorkflowStatus,
} from '../generated/types.ts';
import type { ChannelState } from '../ports/types.ts';

/** 04 §8: a submitted commit not answered within `ackTimeoutMs` (default 15,000) is resumed. */
export const DEFAULT_ANSWER_TIMEOUT_MS = 15_000;

/** The `reason` of the close that asks the caller to reopen and reload (D80). */
export const RELOAD_REASON =
  'the server answered the resume with a reload: the confirmed document must be replaced, so the channel is closed for the caller to reopen';

/** Names one `submit()` in the effects. */
export type SubmitHandle = number;

type Closed = Extract<ChannelState, { status: 'closed' }>;

/** What the caller does after an input. */
export type ChannelEffect =
  /** Send this message on the connection. */
  | { kind: 'send'; message: ClientMessage }
  /** The first `ch.opened`: the channel exists. */
  | { kind: 'opened'; opened: ChannelOpened }
  /** The first `ch.open` failed (`ch.rejected`, `error`, no answer, lost connection). */
  | { kind: 'openFailed'; code: ErrorCode; message: string }
  | { kind: 'commits'; commits: RemoteCommit[] }
  | { kind: 'ack'; handle: SubmitHandle; ack: Ack }
  | { kind: 'reject'; handle: SubmitHandle; reject: SyncReject }
  /** The submit has no answer and never will on this channel (D23), or the server refused it with `error`. */
  | { kind: 'fail'; handle: SubmitHandle; code: ErrorCode; message: string }
  | { kind: 'access'; access: Access }
  | { kind: 'reset'; reset: SyncReset }
  | { kind: 'event'; event: Notification }
  | { kind: 'check'; check: SyncCheck }
  | { kind: 'presence'; peers: PresencePeers }
  | { kind: 'workflow'; status: WorkflowStatus }
  | { kind: 'state'; state: ChannelState }
  /** `catchUp: "page"`: read the commits after `after` over REST, up to `head`, and pass them to paged(). */
  | { kind: 'page'; after: number; head: number }
  /**
   * Call reopen() once connected, after `delayMs` or, without it, after the reconnection backoff
   * for `attempt` (05 §4).
   */
  | { kind: 'reopen'; attempt: number; delayMs?: number; reason: string };

export interface ChannelOptions {
  doc: string;
  /** Envelope identifiers for `ch.open` and `sync.submit`, unique on the connection. */
  ids: () => string;
  engine?: string;
  /** The CDM version the client will use (05 §5.2). */
  cdm?: number;
  /** How long a request waits for its answer: `limits.ackTimeoutMs` (04 §8). */
  answerTimeoutMs?: number;
  /** The commit limits the server advertised in `welcome` (PRO-022); the 04 §3.1 defaults when omitted. */
  limits?: CommitLimits;
}

/** The two limits that bound one commit (PRO-022; 04 §3.1). */
export interface CommitLimits {
  /** Largest serialised commit in UTF-8 bytes (default 1 MiB). */
  maxCommitBytes: number;
  /** Most steps in one commit (default 500). */
  maxStepsPerCommit: number;
}

/** 04 §3.1 defaults, used until a welcome says otherwise. */
export const DEFAULT_COMMIT_LIMITS: CommitLimits = {
  maxCommitBytes: 1_048_576,
  maxStepsPerCommit: 500,
};

export type ChannelPhase = 'opening' | 'catching_up' | 'paging' | 'live' | 'resuming' | 'closed';

interface Sent {
  handle: SubmitHandle;
  commit: Commit;
  at: number;
}

const validator = new ShapeValidator(DEP1_WIRE);

/** JSON with sorted keys, for comparing access objects. */
function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(',')}]`;
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>;
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v) ?? 'null';
}

/** Two access objects grant the same, whatever their `rev` and `asOfSeq`. */
function sameAccess(a: Access, b: Access): boolean {
  const strip = (x: Access) => canonical({ ...x, rev: 0, asOfSeq: 0 });
  return strip(a) === strip(b);
}

/**
 * The members of an `access` object this client knows (PRO-032 criterion 5; PRO-005: ignore what is
 * not known). A member added by a later protocol version is dropped here, so the host never sees it.
 */
const ACCESS_MEMBERS = [
  'rev',
  'asOfSeq',
  'docRole',
  'caps',
  'scopes',
  'leases',
  'fill',
  'restrictions',
] as const;

export function knownAccess(a: Access): Access {
  const raw = a as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of ACCESS_MEMBERS) if (key in raw) out[key] = raw[key];
  return out as unknown as Access;
}

const state = (s: ChannelState): ChannelEffect => ({ kind: 'state', state: s });

export class ClientChannel {
  readonly doc: string;
  phase: ChannelPhase = 'opening';
  /** The channel number on the current connection; null while detached. */
  ch: number | null = null;
  /** The last `seq` delivered in order: by a commit, an acknowledgement, a reset or a reload. */
  seq = 0;
  incarnation: string | null = null;
  /** The view token of the latest `ch.opened` (ADR 0019; D28). */
  view: string | undefined = undefined;
  /** The first `ch.opened`: what `open()` resolved with. */
  opened: ChannelOpened | null = null;
  /** The head of the latest `ch.opened`. */
  head = 0;
  answerTimeoutMs: number;
  /** What the machine repaired, for diagnostics and tests. */
  readonly faults = { duplicates: 0, gaps: 0, timeouts: 0, resumes: 0 };

  private readonly engine: string;
  private readonly cdm: number;
  private readonly ids: () => string;
  private commitLimits: CommitLimits;
  private openId: string | null = null;
  private openAt = 0;
  /** When the channel last heard from the server while catching up. */
  private heardAt = 0;
  private readonly sent = new Map<string, Sent>();
  private queued: Array<{ handle: SubmitHandle; commit: Commit }> = [];
  private latest: Access | null = null;
  /** Messages held while commits are paged in over REST. */
  private held: ServerMessage[] = [];
  private attempts = 0;
  /** The commit to name in the next resume (04 §9 step 1). */
  private inflight: string | undefined = undefined;

  constructor(opts: ChannelOptions) {
    this.doc = opts.doc;
    this.ids = opts.ids;
    this.engine = opts.engine ?? DEP1_WIRE.engines[0]!;
    this.cdm = opts.cdm ?? DEP1_WIRE.cdm.max;
    this.answerTimeoutMs = opts.answerTimeoutMs ?? DEFAULT_ANSWER_TIMEOUT_MS;
    this.commitLimits = { ...(opts.limits ?? DEFAULT_COMMIT_LIMITS) };
  }

  /** Replaces the commit limits with the ones a `welcome` advertised (PRO-022). */
  setLimits(limits: CommitLimits): void {
    this.commitLimits = { ...limits };
  }

  /** The latest access the channel delivered, or null. */
  get access(): Access | null {
    return this.latest;
  }

  /** Whether an `error` with this `re` answers one of the channel's requests. */
  owns(id: string): boolean {
    return id === this.openId || this.sent.has(id);
  }

  /** The `ch.open` of the caller (05 §5.2). Without `resume` the server answers `catchUp: "reload"`. */
  open(
    ch: number,
    features: readonly string[],
    resume: Resume | undefined,
    now: number,
  ): ChannelEffect[] {
    if (this.opened !== null || this.openId !== null)
      throw new Error(`the channel for ${this.doc} is already open`);
    if (resume) {
      this.seq = resume.seq;
      this.incarnation = resume.incarnation;
      this.view = resume.view;
    }
    return [this.sendOpen(ch, features, resume, now)];
  }

  /** Where the channel resumes (04 §9 step 1): its confirmed seq, incarnation, in-flight commit and view. */
  resumePoint(): Resume {
    const r: Resume = { seq: this.seq, incarnation: this.incarnation ?? '' };
    if (this.inflight !== undefined) r.inflight = this.inflight;
    if (this.view !== undefined) r.view = this.view;
    return r;
  }

  /** Reopens a resuming channel on the current connection, with resumePoint(). */
  reopen(ch: number, features: readonly string[], now: number): ChannelEffect[] {
    if (this.phase !== 'resuming') return [];
    this.faults.resumes++;
    return [this.sendOpen(ch, features, this.resumePoint(), now)];
  }

  /** A message whose `ch` is the channel's, or an `error` whose `re` it owns. */
  receive(m: ServerMessage, now: number): ChannelEffect[] {
    switch (m.t) {
      case 'ch.opened':
        return this.onOpened(m.d, m.re, now);
      case 'ch.rejected':
        return this.onRefused(m.re, m.d.code, m.d.message);
      case 'error':
        return this.onError(m.re, m.d);
      default:
        break;
    }
    if (this.phase === 'opening' || this.phase === 'resuming' || this.phase === 'closed') return [];
    this.heardAt = now;
    if (m.t === 'ch.closed') return this.onClosed(m.d);
    if (this.phase === 'paging') {
      // Live messages wait until the paged commits before them are delivered.
      this.held.push(m);
      return [];
    }
    switch (m.t) {
      case 'sync.commit':
        return this.deliver(m.d.commits);
      case 'sync.ack':
        return this.onAck(m.re, m.d);
      case 'sync.reject':
        return this.onReject(m.re, m.d);
      case 'sync.caughtUp':
        return this.onCaughtUp(m.d.seq, now);
      case 'sync.reset':
        return this.onReset(m.d);
      case 'sync.check':
        return [{ kind: 'check', check: m.d }];
      case 'perm.changed':
        return this.onAccess(m.d, true);
      case 'event':
        return [{ kind: 'event', event: m.d }];
      case 'presence.state':
        return [{ kind: 'presence', peers: m.d }];
      case 'wf.changed':
        return [{ kind: 'workflow', status: m.d }];
      default:
        return [];
    }
  }

  /** Submits a commit (`sync.submit`); it waits while the channel is not live. */
  submit(handle: SubmitHandle, commit: Commit, now: number): ChannelEffect[] {
    if (this.phase === 'closed')
      return [{ kind: 'fail', handle, code: 'unavailable', message: 'the channel is closed' }];
    const violations = validator.checkNamed('Commit', commit);
    if (violations.length)
      return [
        {
          kind: 'fail',
          handle,
          code: 'bad_message',
          message: `invalid commit: ${violations.map((v) => `${v.path} ${v.message}`).join('; ')}`,
        },
      ];
    // PRO-022: a client never builds a commit the server would answer with too_large.
    const tooLarge = this.oversize(commit);
    if (tooLarge !== null) return [{ kind: 'fail', handle, code: 'too_large', message: tooLarge }];
    if (this.phase !== 'live') {
      this.queued.push({ handle, commit });
      return [];
    }
    return [this.sendSubmit(handle, commit, now)];
  }

  /** Commits read over REST for `catchUp: "page"` (05 §5.2), in ascending `seq`. */
  paged(commits: readonly RemoteCommit[], now: number): ChannelEffect[] {
    if (this.phase !== 'paging') return [];
    const out: ChannelEffect[] = [];
    const fresh: RemoteCommit[] = [];
    for (const c of commits) {
      if (c.seq <= this.seq) continue;
      if (c.seq !== this.seq + 1) {
        if (fresh.length) out.push({ kind: 'commits', commits: fresh });
        this.faults.gaps++;
        return [...out, ...this.suspend(`gap in the paged commits at ${c.seq}`, { close: true })];
      }
      fresh.push(c);
      this.seq = c.seq;
    }
    if (fresh.length) out.push({ kind: 'commits', commits: fresh });
    if (this.seq < this.head) {
      if (fresh.length) return [...out, { kind: 'page', after: this.seq, head: this.head }];
      this.faults.gaps++;
      return [
        ...out,
        ...this.suspend(`paging stopped at ${this.seq} before ${this.head}`, { close: true }),
      ];
    }
    this.phase = 'live';
    out.push(state({ status: 'live', seq: this.seq }));
    const held = this.held;
    this.held = [];
    for (const m of held) out.push(...this.receive(m, now));
    if (this.phase === 'live') out.push(...this.flush(now));
    return out;
  }

  /** Reading the pages failed: the channel resumes. */
  pageFailed(reason: string): ChannelEffect[] {
    if (this.phase !== 'paging') return [];
    return this.suspend(reason, { close: true });
  }

  /** The connection was lost; reopen() follows once a new session is open. */
  connectionLost(reason: string): ChannelEffect[] {
    switch (this.phase) {
      case 'closed':
      case 'resuming':
        return [];
      case 'opening':
        if (this.opened === null) {
          this.phase = 'closed';
          this.ch = null;
          this.openId = null;
          return [{ kind: 'openFailed', code: 'unavailable', message: reason }];
        }
        // A reopen was in flight: the state already says resuming.
        this.ch = null;
        this.openId = null;
        this.phase = 'resuming';
        return [];
      default:
        return [...this.detach(reason), state({ status: 'resuming', reason })];
    }
  }

  /** Closes the channel (`ch.close`); unanswered submits fail with `unavailable`. */
  close(): ChannelEffect[] {
    if (this.phase === 'closed') return [];
    const unanswered = this.opened === null;
    const out = this.end({ status: 'closed', code: null, reason: 'closed by the client' }, true);
    if (unanswered)
      out.unshift({ kind: 'openFailed', code: 'unavailable', message: 'closed before the answer' });
    return out;
  }

  /**
   * The session ended for good (a revocation, a refused token, an unsupported version): the channel
   * closes with `code`, nothing is sent, and unanswered submits fail with `unavailable`.
   */
  terminate(code: ErrorCode, reason: string): ChannelEffect[] {
    if (this.phase === 'closed') return [];
    const unanswered = this.opened === null;
    this.ch = null;
    const out = this.end({ status: 'closed', code, reason }, false);
    if (unanswered) out.unshift({ kind: 'openFailed', code, message: reason });
    return out;
  }

  /** Answer timeouts (04 §8): a request not answered within answerTimeoutMs resumes the channel. */
  tick(now: number): ChannelEffect[] {
    if (
      this.phase === 'opening' &&
      this.openId !== null &&
      now - this.openAt >= this.answerTimeoutMs
    ) {
      this.faults.timeouts++;
      if (this.opened === null) {
        const out: ChannelEffect[] =
          this.ch !== null ? [{ kind: 'send', message: { t: 'ch.close', ch: this.ch } }] : [];
        this.phase = 'closed';
        this.ch = null;
        this.openId = null;
        return [
          ...out,
          { kind: 'openFailed', code: 'unavailable', message: 'no answer to ch.open' },
        ];
      }
      return this.suspend('no answer to ch.open within ackTimeoutMs', { close: true });
    }
    for (const s of this.sent.values())
      if (now - s.at >= this.answerTimeoutMs) {
        this.faults.timeouts++;
        return this.suspend('no answer to a commit within ackTimeoutMs (04 §8)', {
          close: true,
          delayMs: 0,
        });
      }
    // The open is answered only once the stream ends: silence while catching up resumes (D80).
    if (this.phase === 'catching_up' && now - this.heardAt >= this.answerTimeoutMs) {
      this.faults.timeouts++;
      return this.suspend('the catch-up stream stopped before sync.caughtUp', {
        close: true,
        delayMs: 0,
      });
    }
    return [];
  }

  /** When tick() next has something to do, or null. */
  deadline(): number | null {
    let d: number | null = null;
    const at = (t: number) => {
      d = d === null ? t : Math.min(d, t);
    };
    if (this.phase === 'opening' && this.openId !== null) at(this.openAt + this.answerTimeoutMs);
    if (this.phase === 'catching_up') at(this.heardAt + this.answerTimeoutMs);
    for (const s of this.sent.values()) at(s.at + this.answerTimeoutMs);
    return d;
  }

  // --- Inputs ----------------------------------------------------------------------------------

  private sendOpen(
    ch: number,
    features: readonly string[],
    resume: Resume | undefined,
    now: number,
  ): ChannelEffect {
    this.ch = ch;
    this.openId = this.ids();
    this.openAt = now;
    this.phase = 'opening';
    const d: ChannelOpen = {
      kind: 'doc',
      doc: this.doc,
      engine: this.engine,
      cdm: this.cdm,
      features: [...features],
    };
    if (resume) d.resume = { ...resume };
    return { kind: 'send', message: { t: 'ch.open', id: this.openId, ch, d } };
  }

  private onOpened(d: ChannelOpened, re: string, now: number): ChannelEffect[] {
    if (this.phase !== 'opening' || re !== this.openId) return [];
    this.openId = null;
    const first = this.opened === null;
    if (!first && (d.catchUp === 'reload' || d.incarnation !== this.incarnation))
      return this.end(
        { status: 'closed', code: 'unavailable', reason: RELOAD_REASON, retryInMs: 0 },
        true,
      );
    this.attempts = 0;
    this.inflight = undefined;
    this.incarnation = d.incarnation;
    this.view = d.view;
    this.head = d.head;
    const out: ChannelEffect[] = [];
    if (first) {
      this.opened = d;
      // Reload: the caller reads the content at head (05 §5.2), and the channel continues from it.
      if (d.catchUp === 'reload') this.seq = d.head;
      out.push({ kind: 'opened', opened: d });
    }
    out.push(...this.onAccess(d.access, first));
    // The workflow object follows the access it implies (FRW-035); a reopened channel brings the
    // current one, so a client that was disconnected during a transition is told.
    if (d.workflow !== undefined) out.push({ kind: 'workflow', status: d.workflow });
    if (d.catchUp === 'stream') {
      this.phase = 'catching_up';
      this.heardAt = now;
      out.push(state({ status: 'catching_up', head: d.head }));
    } else if (d.catchUp === 'page' && this.seq < d.head) {
      this.phase = 'paging';
      this.held = [];
      out.push(state({ status: 'catching_up', head: d.head }), {
        kind: 'page',
        after: this.seq,
        head: d.head,
      });
    } else {
      this.phase = 'live';
      out.push(state({ status: 'live', seq: this.seq }), ...this.flush(now));
    }
    return out;
  }

  private onRefused(re: string | undefined, code: ErrorCode, message: string): ChannelEffect[] {
    if (this.phase !== 'opening' || re === undefined || re !== this.openId) return [];
    this.openId = null;
    if (this.opened === null) {
      this.phase = 'closed';
      this.ch = null;
      return [{ kind: 'openFailed', code, message }];
    }
    // A resume refused for a passing reason is tried again: the server may still be processing
    // the `ch.close` of the channel being resumed (05 §4: one channel per document).
    if (code === 'already_open' || code === 'unavailable' || code === 'channel_limit') {
      this.ch = null;
      this.phase = 'resuming';
      this.attempts++;
      return [{ kind: 'reopen', attempt: this.attempts, reason: `ch.rejected: ${code}` }];
    }
    return this.end({ status: 'closed', code, reason: message }, false);
  }

  private onError(re: string | undefined, e: ErrorPayload): ChannelEffect[] {
    if (re === undefined) return [];
    if (re === this.openId) return this.onRefused(re, e.code, e.message);
    const s = this.sent.get(re);
    if (!s) return [];
    this.sent.delete(re);
    return [{ kind: 'fail', handle: s.handle, code: e.code, message: e.message }];
  }

  private onClosed(d: ChannelClosed): ChannelEffect[] {
    // `internal` is retryable and its client action is "back off" (the registry, PRO-038; PRO-039).
    if (d.code === 'unavailable' || d.code === 'internal' || d.code === 'slow_consumer')
      return this.suspend(
        `ch.closed: ${d.code}: ${d.reason}`,
        d.retryInMs === undefined ? { close: false } : { close: false, delayMs: d.retryInMs },
      );
    const s: Closed =
      d.retryInMs === undefined
        ? { status: 'closed', code: d.code, reason: d.reason }
        : { status: 'closed', code: d.code, reason: d.reason, retryInMs: d.retryInMs };
    return this.end(s, false);
  }

  /** Delivers commits in order: a duplicate is dropped, a gap resumes the channel (G5). */
  private deliver(list: readonly RemoteCommit[]): ChannelEffect[] {
    const out: ChannelEffect[] = [];
    let fresh: RemoteCommit[] = [];
    for (const c of list) {
      if (c.seq <= this.seq) {
        this.faults.duplicates++;
        continue;
      }
      if (c.seq !== this.seq + 1) {
        if (fresh.length) out.push({ kind: 'commits', commits: fresh });
        this.faults.gaps++;
        return [
          ...out,
          ...this.suspend(`gap: expected seq ${this.seq + 1}, received ${c.seq}`, {
            close: true,
            delayMs: 0,
          }),
        ];
      }
      this.seq = c.seq;
      const own = this.sentFor(c.id);
      if (own) {
        // The server sent the client's own commit as a commit: it answers the submit (04 §8).
        if (fresh.length) out.push({ kind: 'commits', commits: fresh });
        fresh = [];
        this.sent.delete(own[0]);
        out.push({
          kind: 'ack',
          handle: own[1].handle,
          ack: { id: c.id, seq: c.seq, serverTime: c.serverTime, rebased: true, steps: c.steps },
        });
        continue;
      }
      fresh.push(c);
    }
    if (fresh.length) out.push({ kind: 'commits', commits: fresh });
    return out;
  }

  /** Why a commit is above the advertised limits, or null when it is within them (04 §3.1). */
  private oversize(commit: Commit): string | null {
    const { maxStepsPerCommit, maxCommitBytes } = this.commitLimits;
    if (commit.steps.length > maxStepsPerCommit)
      return `the commit has ${commit.steps.length} steps; the server allows ${maxStepsPerCommit} (maxStepsPerCommit)`;
    const bytes = utf8Length(JSON.stringify(commit));
    if (bytes > maxCommitBytes)
      return `the commit is ${bytes} bytes; the server allows ${maxCommitBytes} (maxCommitBytes)`;
    return null;
  }

  private sentFor(commitId: string): [string, Sent] | undefined {
    for (const e of this.sent) if (e[1].commit.id === commitId) return e;
    return undefined;
  }

  private onAck(re: string, ack: Ack): ChannelEffect[] {
    const s = this.sent.get(re);
    if (!s) return [];
    if (ack.seq > this.seq + 1) {
      // Commits before this one are missing: they come with the resume, the commit with them.
      this.faults.gaps++;
      return this.suspend(`gap: expected seq ${this.seq + 1}, acknowledged ${ack.seq}`, {
        close: true,
        delayMs: 0,
      });
    }
    this.sent.delete(re);
    // An acknowledgement rebuilt for a duplicate can carry an earlier seq (04 §5 step 2).
    if (ack.seq === this.seq + 1) this.seq = ack.seq;
    return [{ kind: 'ack', handle: s.handle, ack }];
  }

  private onReject(re: string, r: SyncReject): ChannelEffect[] {
    const s = this.sent.get(re);
    if (!s) return [];
    this.sent.delete(re);
    return [{ kind: 'reject', handle: s.handle, reject: r }];
  }

  private onCaughtUp(seq: number, now: number): ChannelEffect[] {
    if (this.phase !== 'catching_up') return [];
    if (seq > this.seq) {
      this.faults.gaps++;
      return this.suspend(`gap: caught up at ${seq}, received up to ${this.seq}`, {
        close: true,
        delayMs: 0,
      });
    }
    this.phase = 'live';
    return [state({ status: 'live', seq: this.seq }), ...this.flush(now)];
  }

  private onReset(r: SyncReset): ChannelEffect[] {
    if (r.seq <= this.seq) {
      this.faults.duplicates++;
      return [];
    }
    this.seq = r.seq;
    return [{ kind: 'reset', reset: r }];
  }

  private onAccess(received: Access, always: boolean): ChannelEffect[] {
    const a = knownAccess(received);
    const same = this.latest !== null && sameAccess(this.latest, a);
    this.latest = a;
    return always || !same ? [{ kind: 'access', access: a }] : [];
  }

  // --- Transitions -----------------------------------------------------------------------------

  private sendSubmit(handle: SubmitHandle, commit: Commit, now: number): ChannelEffect {
    const id = this.ids();
    this.sent.set(id, { handle, commit, at: now });
    return { kind: 'send', message: { t: 'sync.submit', id, ch: this.ch!, d: commit } };
  }

  private flush(now: number): ChannelEffect[] {
    const q = this.queued;
    this.queued = [];
    return q.map((x) => this.sendSubmit(x.handle, x.commit, now));
  }

  /** Detaches from the connection: unanswered submits fail (D23); the newest is named in the resume. */
  private detach(reason: string): ChannelEffect[] {
    const out: ChannelEffect[] = [];
    let newest: Sent | undefined;
    for (const s of this.sent.values()) {
      if (!newest || s.at >= newest.at) newest = s;
      out.push({ kind: 'fail', handle: s.handle, code: 'unavailable', message: reason });
    }
    this.sent.clear();
    if (newest) this.inflight = newest.commit.id;
    this.ch = null;
    this.openId = null;
    this.held = [];
    this.phase = 'resuming';
    return out;
  }

  /** Starts a resume on the same connection: `ch.close` when the server still has the channel. */
  private suspend(reason: string, opts: { close: boolean; delayMs?: number }): ChannelEffect[] {
    const out: ChannelEffect[] = [];
    if (opts.close && this.ch !== null)
      out.push({ kind: 'send', message: { t: 'ch.close', ch: this.ch } });
    out.push(...this.detach(reason));
    this.attempts++;
    if (opts.delayMs === undefined) {
      out.push(state({ status: 'resuming', reason }), {
        kind: 'reopen',
        attempt: this.attempts,
        reason,
      });
    } else {
      out.push(state({ status: 'resuming', reason, retryInMs: opts.delayMs }), {
        kind: 'reopen',
        attempt: this.attempts,
        delayMs: opts.delayMs,
        reason,
      });
    }
    return out;
  }

  private end(s: Closed, sendClose: boolean): ChannelEffect[] {
    const out: ChannelEffect[] = [];
    if (sendClose && this.ch !== null)
      out.push({ kind: 'send', message: { t: 'ch.close', ch: this.ch } });
    this.phase = 'closed';
    this.ch = null;
    this.openId = null;
    this.held = [];
    for (const x of this.sent.values())
      out.push({ kind: 'fail', handle: x.handle, code: 'unavailable', message: s.reason });
    this.sent.clear();
    for (const q of this.queued)
      out.push({ kind: 'fail', handle: q.handle, code: 'unavailable', message: s.reason });
    this.queued = [];
    out.push(state(s));
    return out;
  }
}
