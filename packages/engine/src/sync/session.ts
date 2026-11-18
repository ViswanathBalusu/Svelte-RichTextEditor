/**
 * The sync session: runs the client state machine (state.ts) over a document channel of the backend
 * ports (05 §8.3; `SyncChannel` from @docedit/protocol), whatever implements them: backend-mock,
 * backend-dep or a host's own. It owns the input order, the timers and the channel's lifetime:
 *
 * - every message is processed in the order the channel delivered it (D21), one at a time; work that
 *   needs content (a reload, a reset) holds later messages until the content is loaded;
 * - the host may ask a change to wait (a composition is open in the block it changes, FE-034): the
 *   message stays first in line and is computed again, against the state at that moment, when the
 *   host calls `pump()`;
 * - local edits are sent at once when nothing is in flight and nothing was sent in the last
 *   `batchMs`, otherwise when that interval has passed (04 §8: batch for at most 100 ms);
 * - an unanswered commit is given `ackTimeoutMs` (default 15,000, 04 §8), then the channel is closed
 *   and reopened with a resume (04 §9);
 * - a gap closes and reopens the channel with a resume (SYN-019); a reload or a reset loads content
 *   through the sync port.
 */
import { type StepJson, stepsToJson } from '@docedit/authority';
import { documentHash, type JsonEnvelope } from '@docedit/model';
import { CDM1, mayOpen, supportedFeatures } from '@docedit/model/definition';
import type {
  Access,
  Ack,
  ChannelOpened,
  ChannelState,
  Content,
  Limits,
  RemoteCommit,
  Resume,
  SyncChannel,
  SyncCheck,
  SyncPort,
  SyncReject,
  SyncReset,
  Unsubscribe,
} from '@docedit/protocol';
import type { Schema } from 'prosemirror-model';
import {
  type Action,
  type Discarded,
  type OutgoingCommit,
  type SyncState,
  type Transition,
  caughtUp,
  opened as openedTransition,
  receiveAck,
  receiveCommits,
  receiveReject,
  reload,
  resendCommit,
  reset,
  takeCommit,
} from './state.ts';
import { type JournalEntry, type JournalPort, type QueueAt } from './journal.ts';

/** What the session needs from the editing core. */
export interface SyncHost {
  readonly schema: Schema;
  /** The current state; the visible document always equals `state.visible`. */
  readonly sync: SyncState;
  /** Features the document lists in `requires`, for the divergence check's hash (04 §13). */
  readonly requires: readonly string[];
  /**
   * Adopts a transition: its state, and its effect on the visible document. Returns false, adopting
   * nothing, when the change must wait; the session then holds every later message until `pump()`.
   */
  adopt(t: Transition, why: string): boolean;
  setAccess(access: Access): void;
  setReadOnly(on: boolean): void;
  event(e: SyncEvent): void;
}

/** What the session reports (the core turns these into read views and notices). */
export type SyncEvent =
  | { type: 'connection'; status: ConnectionStatus; reason: string }
  | { type: 'discarded'; items: readonly Discarded[] }
  | { type: 'acknowledged'; id: string; seq: number }
  | { type: 'report'; code: string; message: string }
  | { type: 'permissions-stale'; scopes: readonly string[] }
  | { type: 'sent'; id: string; base: number; steps: number }
  /** The journal write failed (`ok` false) or succeeded again (FE-008): nothing is sent meanwhile. */
  | { type: 'journal'; ok: boolean; reason: string }
  /**
   * The service answered our commit with `unavailable` (`ok` false): it cannot store commits now
   * (06 §8, database unavailable). The commit stays in the journal and is sent again; `ok` is true
   * again once a commit of ours is acknowledged, refused for another reason or set aside (FE-008).
   */
  | { type: 'service'; ok: boolean };

export type ConnectionStatus = 'online' | 'reconnecting' | 'offline';

export interface Clock {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
  now(): number;
}

const realClock: Clock = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
  now: () => Date.now(),
};

export interface SessionOptions {
  /**
   * Reopens the channel with a resume and loads content for reloads and resets (05 §8.3). Without
   * it a gap, a timeout or a reload ends the session (`offline`), because nothing can be fetched.
   */
  sync?: Pick<SyncPort, 'open' | 'loadContent'>;
  /** Limits from `welcome` (`backend.auth.session.limits`); the defaults are those of 04. */
  limits?: Partial<Limits>;
  /** The longest a local edit waits before it is sent while others were sent just before (04 §8). */
  batchMs?: number;
  /** Commit identifiers: UUID version 7 by default (04 §3.1). */
  newId?: () => string;
  clock?: Clock;
  /** Delays between attempts to reopen a channel, doubling from `minMs` up to `maxMs`. */
  retry?: { minMs: number; maxMs: number };
  /**
   * The recovery journal (FE-008): each commit is written here before it is sent, and removed when
   * it is acknowledged, refused or set aside. Without it, sending is as before and nothing is kept
   * across a closed tab.
   */
  journal?: JournalPort;
}

/** 04 §3.1 and §8 defaults, used when `welcome` did not announce a value. */
const DEFAULT_LIMITS = {
  maxStepsPerCommit: 500,
  maxCommitBytes: 1024 * 1024,
  ackTimeoutMs: 15_000,
} as const;

/**
 * The first and longest wait between attempts to reopen a channel. 05 §5.8 asks clients to back off
 * on `unavailable` without naming a value; these are proposed defaults (ADR 0038), not measurements.
 */
const DEFAULT_RETRY = { minMs: 250, maxMs: 10_000 } as const;

type Input =
  | { t: 'opened'; opened: ChannelOpened }
  | { t: 'commits'; commits: RemoteCommit[] }
  | { t: 'ack'; ack: Ack }
  | { t: 'reject'; reject: SyncReject }
  | { t: 'state'; state: ChannelState }
  | { t: 'reset'; reset: SyncReset; content?: Content }
  | {
      t: 'reload';
      reason: string;
      head: number | null;
      view: string | undefined;
      inflightAccepted: boolean;
      content?: Content;
    }
  | { t: 'access'; access: Access }
  | { t: 'check'; check: SyncCheck };

/** A journal failure as text, for the `journal` event. */
function journalReason(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** A `sync.reject` as `submit()` rejects with it (D22): an error whose own members are the payload. */
function asReject(e: unknown): SyncReject | null {
  if (typeof e !== 'object' || e === null) return null;
  const r = e as Partial<SyncReject>;
  return typeof r.id === 'string' &&
    typeof r.code === 'string' &&
    typeof r.action === 'string' &&
    typeof r.head === 'number'
    ? (r as SyncReject)
    : null;
}

/** A UUID version 7 (01 §8; 04 §3.1) from the clock and WebCrypto. */
export function commitId(now: number = Date.now()): string {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  let ms = now;
  for (let i = 5; i >= 0; i--) {
    bytes[i] = ms % 256;
    ms = Math.floor(ms / 256);
  }
  bytes[6] = (bytes[6]! & 0x0f) | 0x70;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export class SyncSession {
  readonly docId: string;
  readonly #host: SyncHost;
  readonly #opts: SessionOptions;
  readonly #clock: Clock;
  readonly #newId: () => string;
  readonly #batchMs: number;
  readonly #ackTimeoutMs: number;
  readonly #maxCommitBytes: number;
  #maxSteps: number;
  /** The channel the caller handed over; the caller closes it. */
  readonly #given: SyncChannel;
  #channel: SyncChannel | null = null;
  #unsubscribe: Unsubscribe[] = [];
  /** Increases with every channel, so that late callbacks of an old one are ignored. */
  #generation = 0;
  #inputs: Input[] = [];
  #held = false;
  #loading = false;
  #pumping = false;
  #catchingUp = false;
  #resendAfterCaughtUp = false;
  #streamHead = 0;
  #live = false;
  #lastSent = Number.NEGATIVE_INFINITY;
  /** A `retry` rejection asks for a delay before the same commit is sent again. */
  #resendAt = Number.NEGATIVE_INFINITY;
  /** Rejections of our commits since the last acknowledgement; they space out resubmissions. */
  #failures = 0;
  /** After a futile `rebase`: no new commit before this time, unless the seq passes `#futileAt`. */
  #notBefore = Number.NEGATIVE_INFINITY;
  #futileAt = -1;
  #sendTimer: unknown = null;
  #ackTimer: unknown = null;
  #retryTimer: unknown = null;
  #retryMs: number;
  #status: ConnectionStatus = 'online';
  #ended = false;
  #suspended = false;
  #serviceOk = true;
  /** The journal (FE-008); writes run one after another, in the order they were requested. */
  readonly #journal: JournalPort | null;
  #journalChain: Promise<void> = Promise.resolve();
  #journalTimer: unknown = null;
  #journalMs: number;
  #journalOk = true;
  /** The queue as last written to the journal, so that an unchanged queue is not written again. */
  #queueKey = '[]';
  /** Recovered edits kept for this document (FE-010): restored from the journal, then written back. */
  #recoveredKept: Discarded[] = [];
  /** The access in force on this channel: the one of `ch.opened`, then every `perm.changed`. */
  #access: Access | null = null;
  /** Scopes a `permission_denied` named while the access still allowed writing there (PRM-020). */
  #staleScopes: readonly string[] | null = null;
  #accessTimer: unknown = null;

  constructor(host: SyncHost, channel: SyncChannel, opts: SessionOptions = {}) {
    this.#host = host;
    this.#opts = opts;
    this.#journal = opts.journal ?? null;
    this.#journalMs = (opts.retry ?? DEFAULT_RETRY).minMs;
    this.#given = channel;
    this.docId = channel.docId;
    this.#clock = opts.clock ?? realClock;
    this.#newId = opts.newId ?? (() => commitId(this.#clock.now()));
    this.#batchMs = opts.batchMs ?? 100;
    this.#ackTimeoutMs = opts.limits?.ackTimeoutMs ?? DEFAULT_LIMITS.ackTimeoutMs;
    this.#maxSteps = opts.limits?.maxStepsPerCommit ?? DEFAULT_LIMITS.maxStepsPerCommit;
    this.#maxCommitBytes = opts.limits?.maxCommitBytes ?? DEFAULT_LIMITS.maxCommitBytes;
    this.#retryMs = (opts.retry ?? DEFAULT_RETRY).minMs;
    // Work put back from the journal (FE-009) is already in the queue: it is not written again.
    this.#queueKey = JSON.stringify(stepsToJson(host.sync.queue));
    this.#restoreRecovered();
    this.#bind(channel);
  }

  /**
   * Keeps work from the journal that could not be put back as recovered edits (FE-009; FE-010): it is
   * reported as set aside, written to the journal's recovered store, and its commits and the queue
   * leave the journal, so that it is not tried again on the next visit.
   */
  setAside(items: readonly Discarded[]): void {
    if (items.length === 0 || this.#ended) return;
    this.#host.event({ type: 'discarded', items });
    this.#recordRecovered(items);
    for (const id of new Set(items.map((i) => i.commit))) if (id !== null) this.#journalDrop(id);
    // The queue in the journal may be the work just set aside: write what the client now holds.
    this.#queueKey = '\u0000';
    this.#writeQueue();
  }

  /** The channel in use, or null while reconnecting. */
  get channel(): SyncChannel | null {
    return this.#channel;
  }

  get connection(): ConnectionStatus {
    return this.#status;
  }

  /** Whether a message waits for the host (a composition, FE-034). */
  get held(): boolean {
    return this.#held;
  }

  /** Messages received and not yet processed. */
  get pending(): number {
    return this.#inputs.length;
  }

  /** Whether the channel is live: caught up, and commits may be sent. */
  get live(): boolean {
    return this.#live && !this.#catchingUp && this.#channel !== null;
  }

  // --- Channel ---------------------------------------------------------------------------------

  #bind(channel: SyncChannel): void {
    const gen = ++this.#generation;
    this.#channel = channel;
    this.#live = false;
    this.#catchingUp = false;
    const push = (input: Input) => {
      if (gen !== this.#generation || this.#ended) return;
      this.#inputs.push(input);
      this.#pump();
    };
    // `opened` and the access it carries come from `channel.opened`, never from the callbacks:
    // another subscriber (the element) may have taken the kept messages (D21).
    this.#inputs.push({ t: 'opened', opened: channel.opened });
    this.#unsubscribe = [
      channel.onCommits((commits) => {
        // Our own commit in the stream answers the submit (04 §8): the timeout no longer applies.
        const id = this.#host.sync.inflight?.id;
        if (id !== undefined && commits.some((c) => c.id === id)) this.#clearAckTimer();
        push({ t: 'commits', commits });
      }),
      channel.onReset((r) => push({ t: 'reset', reset: r })),
      channel.onAccess((access) => push({ t: 'access', access })),
      channel.onState((state) => push({ t: 'state', state })),
      channel.onCheck((check) => push({ t: 'check', check })),
    ];
    this.#pump();
  }

  /**
   * Stops listening to the current channel. `close` closes it: always before a reconnect, because a
   * backend allows one channel per document on a connection (05 §4, `already_open`); at the end of
   * the session only when the session opened it itself.
   */
  #unbind(close: 'always' | 'own' | 'never'): void {
    this.#generation++;
    for (const u of this.#unsubscribe.splice(0)) u();
    const ch = this.#channel;
    this.#channel = null;
    this.#live = false;
    this.#catchingUp = false;
    this.#inputs = [];
    this.#held = false;
    this.#loading = false;
    this.#clearAckTimer();
    this.#clearAccessTimer();
    if (ch && (close === 'always' || (close === 'own' && ch !== this.#given))) ch.close();
  }

  /** Whether the service can store commits, as its last answer to a commit of ours said (FE-008). */
  #setServiceOk(ok: boolean): void {
    if (this.#serviceOk === ok) return;
    this.#serviceOk = ok;
    this.#host.event({ type: 'service', ok });
  }

  #setStatus(status: ConnectionStatus, reason: string): void {
    if (this.#status === status) return;
    this.#status = status;
    this.#host.event({ type: 'connection', status, reason });
  }

  /** Closes the channel and opens a new one with a resume (04 §9), after `delayMs`. */
  #reconnect(reason: string, delayMs = 0): void {
    if (this.#ended || this.#suspended) return;
    this.#unbind('always');
    if (!this.#opts.sync) {
      this.#setStatus('offline', `${reason}; there is no sync port to reopen the channel`);
      return;
    }
    this.#setStatus('reconnecting', reason);
    if (this.#retryTimer !== null) return;
    this.#retryTimer = this.#clock.setTimeout(() => {
      this.#retryTimer = null;
      void this.#open();
    }, delayMs);
  }

  async #open(): Promise<void> {
    const port = this.#opts.sync;
    if (!port || this.#ended || this.#suspended) return;
    const s = this.#host.sync;
    const resume: Resume = { seq: s.seq, incarnation: s.incarnation };
    if (s.inflight) resume.inflight = s.inflight.id;
    // The view of the `ch.opened` the confirmed document came from (ADR 0019; D28).
    if (s.view !== undefined) resume.view = s.view;
    const gen = this.#generation;
    try {
      const channel = await port.open(this.docId, { resume });
      if (this.#ended || gen !== this.#generation) {
        channel.close();
        return;
      }
      this.#retryMs = (this.#opts.retry ?? DEFAULT_RETRY).minMs;
      this.#bind(channel);
    } catch (e) {
      if (this.#ended || gen !== this.#generation) return;
      const code = (e as { code?: unknown }).code;
      if (code === 'forbidden' || code === 'not_found' || code === 'revoked') {
        this.#setStatus('offline', `the channel cannot be reopened: ${String(code)}`);
        return;
      }
      const after = (e as { retryAfterMs?: unknown }).retryAfterMs;
      const delay = typeof after === 'number' ? after : this.#retryMs;
      this.#retryMs = Math.min(this.#retryMs * 2, (this.#opts.retry ?? DEFAULT_RETRY).maxMs);
      this.#reconnect(`reopening failed: ${(e as Error).message}`, delay);
    }
  }

  // --- Processing ------------------------------------------------------------------------------

  /** Processes held and queued messages; the host calls it when a held change may proceed. */
  pump(): void {
    this.#held = false;
    this.#pump();
  }

  #pump(): void {
    if (this.#pumping || this.#held || this.#loading || this.#ended) return;
    this.#pumping = true;
    try {
      while (this.#inputs.length && !this.#held && !this.#loading && !this.#ended) {
        const input = this.#inputs[0]!;
        const gen = this.#generation;
        let outcome: 'done' | 'wait' | 'load';
        try {
          outcome = this.#process(input);
        } catch (e) {
          // Nothing a message does may stop the session: report it and resume from the confirmed
          // seq, which replays the stream (spaced out if it keeps failing).
          this.#failures++;
          this.#host.event({
            type: 'report',
            code: 'internal',
            message: `processing ${input.t} failed: ${(e as Error).message}`,
          });
          this.#reconnect(`processing ${input.t} failed`, this.#backoff());
          break;
        }
        if (gen !== this.#generation) break; // the channel changed while processing
        if (outcome === 'wait') {
          this.#held = true;
          break;
        }
        if (outcome === 'load') break; // the load continues the pump
        this.#inputs.shift();
      }
    } finally {
      this.#pumping = false;
    }
    this.#trySend();
  }

  /** `done`: processed; `wait`: the host held it; `load`: content is being fetched for it. */
  #process(input: Input): 'done' | 'wait' | 'load' {
    const host = this.#host;
    switch (input.t) {
      case 'opened': {
        const o = input.opened;
        this.#setAccess(o.access);
        if (o.catchUp === 'reload') {
          // `page` is not here: the channel reads the missing commits over REST itself and delivers
          // them in order like a stream, with the state `live` after the last (SYN-028 criterion 4;
          // `SyncChannel`, `backend-dep` PRO-026), so the session treats it as `stream`.
          this.#inputs.splice(1, 0, {
            t: 'reload',
            reason: `catch-up ${o.catchUp}`,
            head: o.head,
            view: o.view,
            inflightAccepted: o.inflight?.state === 'accepted',
          });
          return 'done';
        }
        const { transition, resendAfterCaughtUp } = openedTransition(host.sync, o);
        if (!this.#adopt(transition, 'opened')) return 'wait';
        this.#catchingUp = true;
        this.#live = true;
        this.#resendAfterCaughtUp = resendAfterCaughtUp;
        this.#streamHead = o.head;
        this.#setStatus('online', 'channel opened');
        this.#maybeCaughtUp();
        return 'done';
      }
      case 'state':
        this.#onState(input.state);
        return 'done';
      case 'commits': {
        const t = receiveCommits(host.sync, input.commits, host.schema);
        if (!this.#adopt(t, 'commits')) return 'wait';
        this.#maybeCaughtUp();
        if (this.#futileAt >= 0 && host.sync.seq > this.#futileAt) {
          // The commit a futile `rebase` waited for: send now rather than after the backoff.
          this.#futileAt = -1;
          this.#clearSendTimer();
        }
        return 'done';
      }
      case 'ack':
        return this.#adopt(receiveAck(host.sync, input.ack, host.schema), 'ack') ? 'done' : 'wait';
      case 'reject': {
        const r = input.reject;
        const seq = host.sync.seq;
        const ours = host.sync.inflight?.id === r.id;
        if (!this.#adopt(receiveReject(host.sync, r), `reject ${r.code}`)) return 'wait';
        if (!ours) return 'done';
        this.#failures++;
        this.#setServiceOk(r.code !== 'unavailable');
        // A `rebase` whose head the client has already reached failed on commits the room holds
        // but has not stored yet (its tentative state, 04 §5): resubmitting at once fails again.
        // Wait for the next commit, or a growing delay, whichever comes first (ADR 0038).
        if (r.action === 'rebase' && r.head <= seq) {
          this.#futileAt = seq;
          this.#notBefore = this.#clock.now() + this.#backoff();
        }
        return 'done';
      }
      case 'access':
        this.#setAccess(input.access);
        return 'done';
      case 'check':
        this.#check(input.check);
        return 'done';
      case 'reset': {
        if (!input.content) return this.#load(input, input.reset.seq);
        if (!this.#readable(input.content)) return 'done';
        return this.#adopt(reset(host.sync, input.content, host.schema), 'reset') ? 'done' : 'wait';
      }
      case 'reload': {
        if (!input.content) return this.#load(input, input.head);
        if (!this.#readable(input.content)) return 'done';
        const t = reload(host.sync, input.content, host.schema, input.view, input.inflightAccepted);
        if (!this.#adopt(t, `reload (${input.reason})`)) return 'wait';
        this.#catchingUp = false;
        this.#live = true;
        this.#setStatus('online', 'reloaded');
        return 'done';
      }
    }
  }

  #onState(state: ChannelState): void {
    switch (state.status) {
      case 'catching_up':
        this.#catchingUp = true;
        return;
      case 'live':
        this.#live = true;
        if (this.#catchingUp) this.#finishCatchUp();
        this.#setStatus('online', 'live');
        return;
      case 'resuming':
        // The backend reopens the channel itself; nothing is sent until it is live again.
        this.#live = false;
        this.#setStatus('reconnecting', state.reason);
        return;
      case 'closed':
        if (state.code === null) {
          // Closed by its owner: nothing more can be sent on it.
          this.#unbind('never');
          this.#setStatus('offline', state.reason);
        } else if (state.code === 'forbidden') {
          // A revocation (05 §3.3): the old token is refused; the host reconnects with a new one.
          this.#unbind('never');
          this.#setStatus('offline', state.reason);
        } else if (state.code === 'bad_message' || state.code === 'unknown_type') {
          // 05 §5.8: not retryable; the client reports a bug (PRO-039 criterion 6). The element
          // raises `de-error` from the report, and nothing is reopened.
          this.#host.event({
            type: 'report',
            code: state.code,
            message: `the channel closed: ${state.code} (${state.reason})`,
          });
          this.#unbind('never');
          this.#setStatus('offline', state.reason);
        } else
          this.#reconnect(
            `the channel closed: ${state.code} (${state.reason})`,
            state.retryInMs ?? 0,
          );
        return;
    }
  }

  /** The stream has caught up when `sync.caughtUp` arrives or the confirmed seq reaches its head. */
  #maybeCaughtUp(): void {
    if (this.#catchingUp && this.#host.sync.seq >= this.#streamHead) this.#finishCatchUp();
  }

  #finishCatchUp(): void {
    this.#catchingUp = false;
    this.#live = true;
    const t = caughtUp(this.#host.sync, this.#resendAfterCaughtUp);
    this.#resendAfterCaughtUp = false;
    this.#adopt(t, 'caught up');
  }

  /**
   * Whether new content can be opened (03 §2, §11.1): another CDM version, or a `requires` entry
   * this build does not support, is refused and never opened with content dropped. The session
   * then stops; the host reports it as fatal (`de-error`).
   */
  #readable(content: Content): boolean {
    const decision = mayOpen(content.requires, supportedFeatures(CDM1));
    const code = content.cdm !== 1 ? 'unsupported_cdm' : decision.ok ? null : 'unsupported_feature';
    if (code === null) return true;
    const message =
      code === 'unsupported_cdm'
        ? `the document now uses CDM version ${content.cdm}; this editor reads version 1`
        : `the document now needs features this editor does not support: ${decision.ok ? '' : decision.missing.join(', ')}`;
    this.#host.event({ type: 'report', code, message });
    this.#unbind('own');
    this.#setStatus('offline', message);
    return false;
  }

  #load(input: Extract<Input, { t: 'reset' | 'reload' }>, seq: number | null): 'load' | 'done' {
    const port = this.#opts.sync;
    if (!port) {
      this.#unbind('own');
      this.#setStatus('offline', 'content must be reloaded, and there is no sync port');
      return 'done';
    }
    this.#loading = true;
    const gen = this.#generation;
    const request = seq === null ? port.loadContent(this.docId) : port.loadContent(this.docId, seq);
    request.then(
      (content) => {
        if (gen !== this.#generation || this.#ended) return;
        this.#loading = false;
        input.content = content;
        this.#pump();
      },
      (e: unknown) => {
        if (gen !== this.#generation || this.#ended) return;
        this.#loading = false;
        this.#reconnect(`loading content failed: ${(e as Error).message}`, this.#retryMs);
      },
    );
    return 'load';
  }

  /** Adopts a transition and carries out its actions. */
  #adopt(t: Transition, why: string): boolean {
    const was = this.#host.sync.inflight?.id;
    if (!this.#host.adopt(t, why)) return false;
    for (const a of t.actions) this.#act(a);
    this.#journalSettle(was, t);
    return true;
  }

  /**
   * Keeps the journal in step with a transition (FE-008). A commit that left flight without an
   * acknowledgement leaves the journal too: refused for good (`permission_denied`, `invalid_op`,
   * `rebase_failed` and the other `drop` and `reload` answers), set aside by a reload or a stale
   * resume, or put back in the queue to be sent again under a new identifier (`rebase`, a split).
   * The queue is written first when it changed, so work that goes back to the queue is never in
   * neither place, and work that was set aside leaves the queue's entry as well. Refused content is
   * then held in memory only, as recovered edits; keeping it in the journal is FE-010's, under the
   * purge rules of ADR 0019.
   */
  #journalSettle(was: string | undefined, t: Transition): void {
    if (!this.#journal) return;
    const left =
      was !== undefined &&
      this.#host.sync.inflight?.id !== was &&
      !t.actions.some((a) => a.t === 'acknowledged' && a.id === was);
    if (left || t.actions.some((a) => a.t === 'discarded')) this.#writeQueue();
    if (left) this.#journalDrop(was);
  }

  #act(a: Action): void {
    const host = this.#host;
    switch (a.t) {
      case 'reconnect':
        this.#reconnect(a.reason);
        return;
      case 'reload':
        // Content over REST at the head; commits the channel still delivers at or below it are
        // skipped, so the channel stays open (05 §5.2).
        this.#inputs.splice(1, 0, {
          t: 'reload',
          reason: a.reason,
          head: null,
          view: host.sync.view,
          inflightAccepted: false,
        });
        return;
      case 'resend':
        // The server's delay, and never sooner than the backoff of repeated failures.
        this.#resendAt = this.#clock.now() + Math.max(a.afterMs, this.#backoff());
        return;
      case 'read-only':
        host.setReadOnly(true);
        return;
      case 'refresh-permissions':
        host.event({ type: 'permissions-stale', scopes: a.scopes });
        this.#refreshAccess(a.scopes);
        return;
      case 'discarded':
        this.#setServiceOk(true);
        host.event({ type: 'discarded', items: a.items });
        this.#recordRecovered(a.items);
        return;
      case 'acknowledged':
        this.#failures = 0;
        this.#setServiceOk(true);
        this.#journalDrop(a.id);
        host.event({ type: 'acknowledged', id: a.id, seq: a.seq });
        return;
      case 'split':
        this.#maxSteps = Math.max(1, Math.min(this.#maxSteps, a.maxSteps));
        return;
      case 'report':
        host.event({ type: 'report', code: a.code, message: a.message });
        return;
    }
  }

  // --- Refreshing permissions (04 §6, `permission_denied`; PRM-020) ------------------------------

  #setAccess(access: Access): void {
    this.#access = access;
    this.#host.setAccess(access);
    if (this.#staleScopes && !this.#accessAllows(this.#staleScopes)) this.#clearAccessTimer();
  }

  /** Whether the access in force still says the client may write in one of the refused scopes. */
  #accessAllows(scopes: readonly string[]): boolean {
    const a = this.#access;
    if (!a) return false;
    const writes = (caps: readonly string[] | undefined) =>
      caps?.some((c) => c !== 'view' && c !== 'comment') ?? false;
    // A refusal without scopes is the capability check of 07 §5 (P6): the document-level set.
    if (scopes.length === 0) return writes(a.caps);
    return scopes.some((s) => writes(a.scopes[s.startsWith('defs:') ? 'defs' : s]));
  }

  /**
   * The server refused a commit with `permission_denied`. When the access in force already denies
   * the refused scopes, the `perm.changed` came first and the client's access is the server's. When
   * it still allows them, the access is stale: the `perm.changed` is still on its way (it follows
   * the control commit of its revision, D12) or was lost. DEP has no request that reads the access
   * again, so the session waits for it for the time it waits for any answer (`ackTimeoutMs`) and
   * then reopens the channel, whose `ch.opened` carries the server's access (05 §5.2).
   */
  #refreshAccess(scopes: readonly string[]): void {
    if (!this.#accessAllows(scopes)) return;
    this.#clearAccessTimer();
    this.#staleScopes = scopes;
    this.#accessTimer = this.#clock.setTimeout(() => {
      this.#accessTimer = null;
      this.#staleScopes = null;
      this.#reconnect('permissions refreshed after permission_denied');
    }, this.#ackTimeoutMs);
  }

  #clearAccessTimer(): void {
    if (this.#accessTimer !== null) this.#clock.clearTimeout(this.#accessTimer);
    this.#accessTimer = null;
    this.#staleScopes = null;
  }

  // --- Sending ---------------------------------------------------------------------------------

  /**
   * The delay before work that was just refused is sent again: none for the first refusal, then
   * doubling from `retry.minMs` up to `retry.maxMs`. It is always taken on a timer, so that a chain
   * of refusals can never keep the event loop busy.
   */
  #backoff(): number {
    if (this.#failures <= 1) return 0;
    const r = this.#opts.retry ?? DEFAULT_RETRY;
    return Math.min(r.minMs * 2 ** (this.#failures - 2), r.maxMs);
  }

  /** The host calls this after every local edit. */
  localEdit(): void {
    this.#writeQueue();
    this.#trySend(false);
  }

  // --- Journal (FE-008) ------------------------------------------------------------------------

  /** Queues a write of the queue of unsent steps, when it has changed since the last write. */
  #writeQueue(): void {
    const journal = this.#journal;
    if (!journal || this.#ended) return;
    const steps = stepsToJson(this.#host.sync.queue) as StepJson[];
    const key = JSON.stringify(steps);
    if (key === this.#queueKey) return;
    this.#queueKey = key;
    const at = this.#queueAt();
    this.#journalChain = this.#journalChain
      .then(() => journal.setQueue(this.docId, steps, at))
      .then(
        () => this.#setJournalOk(true, ''),
        (e: unknown) => this.#setJournalOk(false, journalReason(e)),
      );
  }

  /** The confirmed document the queue is made on, written with it (FE-009). */
  #queueAt(): QueueAt {
    const s = this.#host.sync;
    return { seq: s.seq, incarnation: s.incarnation };
  }

  /**
   * Restores the recovered edits the journal kept for this document (FE-010), once, ahead of any
   * write queued later. The core receives them as an ordinary `discarded` event.
   */
  #restoreRecovered(): void {
    const journal = this.#journal;
    if (!journal?.readRecovered) return;
    this.#journalChain = this.#journalChain
      .then(() => journal.readRecovered!(this.docId))
      .then(
        (items) => {
          if (this.#ended || items.length === 0) return;
          this.#recoveredKept = [...items, ...this.#recoveredKept];
          this.#host.event({ type: 'discarded', items });
        },
        (e: unknown) => this.#setJournalOk(false, journalReason(e)),
      );
  }

  /**
   * Takes one set-aside item out of the journal's recovered edits (UX-017): the person discarded it,
   * so it is not listed again when the document is opened later. The item is the one with this
   * commit, `seq` and text.
   */
  forgetRecovered(item: { commit: string | null; seq: number; text: string }): void {
    const journal = this.#journal;
    const kept = this.#recoveredKept.filter(
      (d) => !(d.commit === item.commit && d.seq === item.seq && d.text === item.text),
    );
    if (kept.length === this.#recoveredKept.length) return;
    this.#recoveredKept = kept;
    if (!journal?.setRecovered || this.#ended) return;
    this.#journalChain = this.#journalChain
      .then(() => journal.setRecovered!(this.docId, this.#recoveredKept.slice()))
      .then(
        () => this.#setJournalOk(true, ''),
        (e: unknown) => this.#setJournalOk(false, journalReason(e)),
      );
  }

  /** Keeps set-aside work in the journal, as recovered edits, until it is written (FE-010). */
  #recordRecovered(items: readonly Discarded[]): void {
    const journal = this.#journal;
    if (!journal?.setRecovered || this.#ended || items.length === 0) return;
    this.#recoveredKept = [...this.#recoveredKept, ...items];
    this.#journalChain = this.#journalChain
      .then(() => journal.setRecovered!(this.docId, this.#recoveredKept.slice()))
      .then(
        () => this.#setJournalOk(true, ''),
        (e: unknown) => this.#setJournalOk(false, journalReason(e)),
      );
  }

  #setJournalOk(ok: boolean, reason: string): void {
    if (ok) this.#journalMs = (this.#opts.retry ?? DEFAULT_RETRY).minMs;
    if (this.#journalOk === ok) return;
    this.#journalOk = ok;
    this.#host.event({ type: 'journal', ok, reason });
  }

  /**
   * Writes a commit to the journal and sends it only once the write has resolved (FE-008; 04 §8).
   * A failed write sends nothing; the write is tried again after a delay that doubles, and the
   * state reads as unsaved meanwhile.
   */
  #journalThen(channel: SyncChannel, commit: OutgoingCommit): void {
    const journal = this.#journal;
    if (!journal) return this.#transmit(channel, commit);
    const gen = this.#generation;
    const entry: JournalEntry = {
      docId: this.docId,
      id: commit.id,
      base: commit.base,
      steps: commit.steps,
      ...(commit.origin ? { origin: commit.origin } : {}),
      // The incarnation `base` belongs to, so that the next visit resumes in the same log (FE-009).
      ...(this.#host.sync.incarnation === '' ? {} : { incarnation: this.#host.sync.incarnation }),
    };
    const queue = stepsToJson(this.#host.sync.queue) as StepJson[];
    this.#queueKey = JSON.stringify(queue);
    const at = this.#queueAt();
    this.#journalChain = this.#journalChain
      .then(() => journal.put(entry))
      .then(() => journal.setQueue(this.docId, queue, at))
      .then(
        () => {
          this.#setJournalOk(true, '');
          if (gen === this.#generation && !this.#ended) this.#transmit(channel, commit);
        },
        (e: unknown) => {
          this.#setJournalOk(false, journalReason(e));
          if (gen !== this.#generation || this.#ended) return;
          const delay = this.#journalMs;
          this.#journalMs = Math.min(delay * 2, (this.#opts.retry ?? DEFAULT_RETRY).maxMs);
          this.#journalTimer = this.#clock.setTimeout(() => {
            this.#journalTimer = null;
            if (
              gen === this.#generation &&
              !this.#ended &&
              this.#host.sync.inflight?.id === commit.id
            )
              this.#journalThen(channel, commit);
          }, delay);
        },
      );
  }

  /**
   * Resolves once every journal write requested so far is durable (FE-011): the page is hidden, and
   * whatever was typed before it is in the journal when this resolves.
   */
  journalIdle(): Promise<void> {
    return this.#journalChain;
  }

  /** Removes a commit from the journal: acknowledged, refused or set aside. */
  #journalDrop(id: string): void {
    const journal = this.#journal;
    if (!journal) return;
    this.#journalChain = this.#journalChain
      .then(() => journal.remove(this.docId, id))
      .then(
        () => undefined,
        (e: unknown) => this.#setJournalOk(false, journalReason(e)),
      );
  }

  #clearSendTimer(): void {
    if (this.#sendTimer !== null) this.#clock.clearTimeout(this.#sendTimer);
    this.#sendTimer = null;
  }

  #schedule(atMs: number): void {
    if (this.#sendTimer !== null) return;
    this.#sendTimer = this.#clock.setTimeout(
      () => {
        this.#sendTimer = null;
        this.#trySend(true);
      },
      Math.max(0, atMs - this.#clock.now()),
    );
  }

  /**
   * Sends what is due. `fromTimer` is true when a timer called it: after a refusal the next
   * submission is always made from a timer, never in the task that processed the refusal.
   */
  #trySend(fromTimer = false): void {
    const channel = this.#channel;
    if (!channel || !this.live || this.#ended || this.#held || this.#sendTimer !== null) return;
    const host = this.#host;
    const s = host.sync;
    const now = this.#clock.now();
    const afterRefusal = this.#failures > 0 && !fromTimer;
    if (s.inflight) {
      if (!s.inflight.resend) return;
      if (now < this.#resendAt || afterRefusal)
        return this.#schedule(Math.max(this.#resendAt, now));
      const again = resendCommit(s);
      if (!again || !host.adopt({ state: again.state, effect: null, actions: [] }, 'resend'))
        return;
      this.#submit(channel, again.commit);
      return;
    }
    if (s.queue.length === 0) return;
    if (s.waitForHead !== null && s.seq < s.waitForHead) return;
    let at = this.#lastSent + this.#batchMs;
    // A futile `rebase`: wait for the next commit or the backoff, whichever comes first.
    if (this.#futileAt >= 0) {
      if (s.seq > this.#futileAt) this.#futileAt = -1;
      else at = Math.max(at, this.#notBefore);
    }
    if (now < at || afterRefusal) return this.#schedule(Math.max(at, now));
    const next = takeCommit(s, this.#newId(), {
      maxStepsPerCommit: this.#maxSteps,
      maxCommitBytes: this.#maxCommitBytes,
    });
    if (!next || !host.adopt({ state: next.state, effect: null, actions: [] }, 'send')) return;
    this.#submit(channel, next.commit);
  }

  #submit(channel: SyncChannel, commit: OutgoingCommit): void {
    this.#journalThen(channel, commit);
  }

  #transmit(channel: SyncChannel, commit: OutgoingCommit): void {
    const gen = this.#generation;
    this.#lastSent = this.#clock.now();
    this.#host.event({
      type: 'sent',
      id: commit.id,
      base: commit.base,
      steps: commit.steps.length,
    });
    this.#armAckTimer(commit.id);
    const answered = (input: Input) => {
      if (gen !== this.#generation || this.#ended) return;
      if (this.#host.sync.inflight?.id === commit.id) this.#clearAckTimer();
      this.#inputs.push(input);
      this.#pump();
    };
    channel.submit(commit).then(
      (ack) => answered({ t: 'ack', ack }),
      (e: unknown) => {
        const reject = asReject(e);
        if (reject) answered({ t: 'reject', reject });
        // Otherwise the channel closed first (D23); the resume learns the commit's fate (04 §9).
      },
    );
  }

  #armAckTimer(id: string): void {
    this.#clearAckTimer();
    this.#ackTimer = this.#clock.setTimeout(() => {
      this.#ackTimer = null;
      if (this.#host.sync.inflight?.id === id)
        this.#reconnect(`commit ${id} was not answered within ${this.#ackTimeoutMs} ms`);
    }, this.#ackTimeoutMs);
  }

  #clearAckTimer(): void {
    if (this.#ackTimer !== null) this.#clock.clearTimeout(this.#ackTimer);
    this.#ackTimer = null;
  }

  // --- Divergence check (04 §13) ----------------------------------------------------------------

  #check(check: SyncCheck): void {
    const s = this.#host.sync;
    if (check.seq !== s.seq) return;
    const env = {
      cdm: 1,
      requires: [...this.#host.requires],
      doc: s.confirmed.toJSON(),
    } as unknown as JsonEnvelope;
    const gen = this.#generation;
    void documentHash(env).then((hash) => {
      if (gen !== this.#generation || this.#ended) return;
      if (hash === check.hash || `sha256:${hash}` === check.hash) return;
      this.#host.event({
        type: 'report',
        code: 'divergence',
        message: `the confirmed document at seq ${check.seq} differs from the server's; reloading`,
      });
      this.#inputs.push({
        t: 'reload',
        reason: 'divergence',
        head: null,
        view: this.#host.sync.view,
        inflightAccepted: false,
      });
      this.#pump();
    });
  }

  // --- Lifetime --------------------------------------------------------------------------------

  /** Opens a new channel at once: for a host that has a new token after a revocation. */
  reconnect(): void {
    this.#retryMs = (this.#opts.retry ?? DEFAULT_RETRY).minMs;
    this.#reconnect('reconnect requested', 0);
  }

  /** Whether the session is suspended: no channel, and none is opened until `resume` (FE-005). */
  get suspended(): boolean {
    return this.#suspended;
  }

  /**
   * Closes the channel and opens none until `resume` (FE-005; 02 §2.1). The sync state, the queue of
   * unsent steps and the journal stay; local edits made meanwhile wait in the queue.
   */
  suspend(): void {
    if (this.#ended || this.#suspended) return;
    this.#suspended = true;
    if (this.#retryTimer !== null) this.#clock.clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
    this.#clearSendTimer();
    this.#unbind('always');
    this.#setStatus('offline', 'suspended');
  }

  /** Opens a new channel with a resume (04 §9) after `suspend`; unsent steps are then sent. */
  resume(): void {
    if (this.#ended || !this.#suspended) return;
    this.#suspended = false;
    this.reconnect();
  }

  /** Stops the session. A channel the session opened itself is closed; the given one is not. */
  end(): void {
    if (this.#ended) return;
    this.#unbind('own');
    this.#ended = true;
    if (this.#sendTimer !== null) this.#clock.clearTimeout(this.#sendTimer);
    if (this.#retryTimer !== null) this.#clock.clearTimeout(this.#retryTimer);
    if (this.#journalTimer !== null) this.#clock.clearTimeout(this.#journalTimer);
    this.#journalTimer = null;
    this.#sendTimer = null;
    this.#retryTimer = null;
  }
}
