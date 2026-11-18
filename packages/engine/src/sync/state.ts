/**
 * The client algorithm of `pm-steps/1` (04 §7 to §9; SYN-017 to SYN-020) as a pure state machine.
 * It is a port of the reference client that passed the S3 and S12 simulations
 * (`packages/authority/test/harness/client.ts`), with the same rules:
 *
 * - the client keeps its confirmed document at its confirmed `seq`, and rebuilds the visible
 *   document from it as the confirmed document plus the unconfirmed steps, never by applying stored
 *   inverses (04 §7; review CONV-1);
 * - at most one commit is in flight; local steps queue behind it (04 §8);
 * - every received commit must be the confirmed `seq` plus one, or it is a gap (04 §2, G5);
 * - a received commit with the in-flight commit's `id` is its acknowledgement;
 * - an acknowledgement whose steps equal the client's own rebased steps (canonical JSON) changes
 *   nothing that is visible;
 * - local steps that no longer apply after a rebase are dropped, as in ProseMirror, and kept as
 *   recovered edits (04 §8; SYN-019).
 *
 * States are immutable: every function returns a new state and the effect on the visible document,
 * so that the editing core can compute a change, look at it (a composition may be open; FE-034) and
 * only then adopt it. Nothing here touches the network, timers or the DOM.
 */
import {
  inverseMapsOf,
  mapsOf,
  rebaseOver,
  stepsEqual,
  stepsToJson,
  type StepJson,
} from '@docedit/authority';
import { utf8 } from '@docedit/model';
import type {
  Ack,
  ChannelOpened,
  Content,
  Origin,
  RemoteCommit,
  SyncReject,
} from '@docedit/protocol';
import type { Node, Schema } from 'prosemirror-model';
import { ReplaceAroundStep, ReplaceStep, Step } from 'prosemirror-transform';

/** The commit in flight (04 §8: at most one). */
export interface Inflight {
  readonly id: string;
  readonly base: number;
  /** The steps as sent; a `retry` resends exactly these with the same `id` (04 §8). */
  readonly sent: readonly Step[];
  readonly json: readonly StepJson[];
  /** The same work rebased locally over the commits received since it was sent. */
  readonly local: readonly Step[];
  readonly origin: Origin | undefined;
  /** Whether it must be sent again (after `retry`, or when a resume reports it `unknown`). */
  readonly resend: boolean;
}

/** Local work that was set aside, for the recovered-edits pane (02 §2.2; UX-016, UX-017). */
export interface Discarded {
  /** The rejection code, or `rebase` (dropped by a rebase), `reload`, `reset` or `stale`. */
  readonly reason: string;
  /** The commit identifier, when the work was in flight. */
  readonly commit: string | null;
  readonly steps: readonly StepJson[];
  /** The text the steps inserted, so that a person can find it again. */
  readonly text: string;
  /** The confirmed `seq` when it was set aside. */
  readonly seq: number;
  /** For a `permission_denied` rejection: the scopes it named (05 §5.3), in its order (PRM-024). */
  readonly scopes?: readonly string[];
  /** For a `permission_denied` rejection: the last permission change the client saw (PRM-024). */
  readonly change?: PermissionChange | null;
}

/**
 * The last control commit that changed what is allowed (04 §3.2; 07 §9): who it is attributed to
 * and when it was stored. `user` is null when the server authored it as `system` (04 §10), so the
 * client does not know who changed the permissions (PRM-024 criterion 2).
 */
export interface PermissionChange {
  readonly user: string | null;
  readonly time: string;
  readonly seq: number;
}

export interface SyncState {
  /** The confirmed document: the document at `seq`, without unconfirmed steps (04 §7). */
  readonly confirmed: Node;
  readonly seq: number;
  /** The log incarnation `seq` belongs to (04 §1); empty until a channel opened. */
  readonly incarnation: string;
  /** The `view` token of the `ch.opened` the confirmed document came from (ADR 0019; D28). */
  readonly view: string | undefined;
  readonly inflight: Inflight | null;
  /** Local steps not yet sent, made on top of the in-flight commit's local steps. */
  readonly queue: readonly Step[];
  /** The confirmed document plus `inflight.local` plus `queue`: what the editor shows. */
  readonly visible: Node;
  /** After a `rebase` rejection: send again only once `seq` reaches this head (04 §8). */
  readonly waitForHead: number | null;
  /** Everything set aside so far, oldest first. */
  readonly discarded: readonly Discarded[];
  /** The last control commit received that changes permissions (PRM-024); absent until one. */
  readonly permissionChange?: PermissionChange;
}

/**
 * How the visible document changes. The editing core builds one transaction from it: the old
 * unconfirmed steps undone, `over` applied, the new unconfirmed steps applied, with each rebased step
 * paired with the step it came from so that positions map exactly (the shape prosemirror-collab
 * gives its rebuilds, which prosemirror-history understands). `doc` is the result to reach; the
 * core checks it and corrects any difference, so the document never depends on an inverse being
 * exact (ADR 0038).
 */
export interface Rebuild {
  readonly kind: 'rebuild';
  /** The confirmed document the old unconfirmed steps apply to. */
  readonly base: Node;
  /** The old unconfirmed steps, in order. */
  readonly before: readonly Step[];
  /** The steps from the old to the new confirmed document. */
  readonly over: readonly Step[];
  /** For each step of `over`, the index in `before` of the step it is the authority's version of, or -1. */
  readonly overOrigins: readonly number[];
  /** The new unconfirmed steps, on the new confirmed document. */
  readonly after: readonly Step[];
  /** For each step of `after`, the index in `before` it was rebased from, or -1. */
  readonly afterOrigins: readonly number[];
  readonly doc: Node;
}

/** The visible document is replaced: a reload or a reset. Undo history does not survive it. */
export interface Replace {
  readonly kind: 'replace';
  readonly doc: Node;
  readonly requires: readonly string[] | null;
}

export type Effect = Rebuild | Replace;

/** What the driver must do after a transition. */
export type Action =
  | { readonly t: 'reconnect'; readonly reason: string }
  | { readonly t: 'reload'; readonly reason: string }
  | { readonly t: 'resend'; readonly afterMs: number }
  | { readonly t: 'read-only' }
  | { readonly t: 'refresh-permissions'; readonly scopes: readonly string[] }
  | { readonly t: 'discarded'; readonly items: readonly Discarded[] }
  | { readonly t: 'acknowledged'; readonly id: string; readonly seq: number }
  | { readonly t: 'split'; readonly maxSteps: number }
  | { readonly t: 'report'; readonly code: string; readonly message: string };

/**
 * One step of the confirmed document's history: it went from seq `from` to seq `to` by `steps`
 * (the steps that moved the confirmed document), or was replaced as a whole (`steps` null, after a
 * reset or a reload). Presence uses it to map positions through later changes (SYN-036).
 */
export interface Confirmed {
  readonly from: number;
  readonly to: number;
  readonly steps: readonly Step[] | null;
}

export interface Transition {
  readonly state: SyncState;
  readonly effect: Effect | null;
  readonly actions: readonly Action[];
  /** What the confirmed document gained, oldest first; absent when the confirmed seq did not move. */
  readonly confirmed?: readonly Confirmed[];
}

const none = (state: SyncState, actions: readonly Action[] = []): Transition => ({
  state,
  effect: null,
  actions,
});

/** A state with no unconfirmed work, for a document at `seq`. */
export function initialState(doc: Node, seq = 0, incarnation = '', view?: string): SyncState {
  return {
    confirmed: doc,
    seq,
    incarnation,
    view,
    inflight: null,
    queue: [],
    visible: doc,
    waitForHead: null,
    discarded: [],
  };
}

/** Every unconfirmed step, in order: the in-flight commit's, then the queue. */
export function unconfirmed(s: SyncState): readonly Step[] {
  return s.inflight ? [...s.inflight.local, ...s.queue] : s.queue;
}

/** Whether nothing is in flight or queued (04 §8 `flush`). */
export function settled(s: SyncState): boolean {
  return s.inflight === null && s.queue.length === 0;
}

// ---------------------------------------------------------------------------------------------
// Local edits and sending (04 §8 "Local edit"; SYN-018)

/**
 * The origin a queued step was made with (FE-049: `undo` or `redo`). A step carries it by identity;
 * a rebase makes a new step and `carryOrigins` copies the tag. A step with no tag has no origin
 * hint. The tag is not persisted: steps restored from the journal are sent without a hint.
 */
const stepOrigins = new WeakMap<Step, Origin>();

/** The origin the step was queued with, if any. */
export function stepOrigin(step: Step): Origin | undefined {
  return stepOrigins.get(step);
}

/** Copies the origin tags of `before` onto the steps a rebase made from them (`positions`, as `rebaseOver`). */
function carryOrigins(
  before: readonly Step[],
  positions: readonly number[],
  steps: readonly Step[],
): void {
  positions.forEach((p, i) => {
    const origin = p >= 0 ? stepOrigins.get(before[i]!) : undefined;
    if (origin !== undefined) stepOrigins.set(steps[p]!, origin);
  });
}

/**
 * Appends local steps; `doc` is the visible document after them. `origin` is the commit origin
 * hint of these steps (04 §3.1), kept per step so that a commit never mixes origins (FE-049).
 */
export function local(s: SyncState, steps: readonly Step[], doc: Node, origin?: Origin): SyncState {
  if (steps.length === 0) return s;
  if (origin !== undefined) for (const step of steps) stepOrigins.set(step, origin);
  return { ...s, queue: [...s.queue, ...steps], visible: doc };
}

export interface CommitLimits {
  /** Most steps in one commit (`welcome.limits.maxStepsPerCommit`, default 500; 04 §3.1). */
  maxStepsPerCommit: number;
  /** Largest serialised commit in bytes (`welcome.limits.maxCommitBytes`, default 1 MiB). */
  maxCommitBytes: number;
}

export interface OutgoingCommit {
  id: string;
  base: number;
  steps: StepJson[];
  origin?: Origin;
}

const bytes = (v: unknown): number => utf8(JSON.stringify(v)).length;

/**
 * Takes the next commit from the queue when nothing is in flight (SYN-018): `base` is the confirmed
 * `seq`, the queue is cut so that the commit respects both limits, and the rest stays queued for
 * the next commit. Returns null when there is nothing to send, or the client waits for a head.
 */
export function takeCommit(
  s: SyncState,
  id: string,
  limits: CommitLimits,
  origin?: Origin,
): { state: SyncState; commit: OutgoingCommit } | null {
  if (s.inflight) return null;
  if (s.waitForHead !== null && s.seq < s.waitForHead) return null;
  const state: SyncState = s.waitForHead !== null ? { ...s, waitForHead: null } : s;
  if (state.queue.length === 0) return null;
  const json = stepsToJson(state.queue);
  // Unless the caller names one, the commit takes the origin of its first step and ends where the
  // origin changes, so an undo is its own commit with origin `undo` (FE-049).
  const own = origin === undefined;
  if (own) origin = stepOrigin(state.queue[0]!);
  // The serialised commit is the envelope with an empty step list plus each step and a comma.
  let size = bytes({ id, base: state.seq, steps: [], ...(origin ? { origin } : {}) });
  let n = 0;
  while (n < json.length && n < limits.maxStepsPerCommit) {
    if (own && n > 0 && stepOrigin(state.queue[n]!) !== origin) break;
    const add = bytes(json[n]) + (n > 0 ? 1 : 0);
    if (n > 0 && size + add > limits.maxCommitBytes) break;
    size += add;
    n++;
  }
  const sent = state.queue.slice(0, n);
  const inflight: Inflight = {
    id,
    base: state.seq,
    sent,
    json: json.slice(0, n),
    local: sent,
    origin,
    resend: false,
  };
  const commit: OutgoingCommit = { id, base: state.seq, steps: json.slice(0, n) };
  if (origin) commit.origin = origin;
  return { state: { ...state, inflight, queue: state.queue.slice(n) }, commit };
}

/** The in-flight commit as it must be resent: same `id`, `base` and steps (04 §8, G4). */
export function resendCommit(s: SyncState): { state: SyncState; commit: OutgoingCommit } | null {
  const inf = s.inflight;
  if (!inf || !inf.resend) return null;
  const commit: OutgoingCommit = { id: inf.id, base: inf.base, steps: [...inf.json] };
  if (inf.origin) commit.origin = inf.origin;
  return { state: { ...s, inflight: { ...inf, resend: false } }, commit };
}

// ---------------------------------------------------------------------------------------------
// Receiving (04 §8, §9)

/** What the steps inserted, as text (for recovered edits). */
export function insertedText(steps: readonly Step[]): string {
  let out = '';
  // Where the previous insertion ended, in the document the next step is made on: a step that
  // inserts right there continues the same typing (one step per keystroke), so no line break.
  let continuesAt = -1;
  for (const step of steps) {
    if (step instanceof ReplaceStep || step instanceof ReplaceAroundStep) {
      const content = step.slice.content;
      const text = content.textBetween(0, content.size, '\n', '');
      if (text) {
        out += out === '' ? text : step.from === continuesAt ? text : `\n${text}`;
        continuesAt = step.from + step.slice.size;
      }
    }
  }
  return out;
}

function discard(
  s: SyncState,
  steps: readonly Step[],
  reason: string,
  commit: string | null,
  why?: Pick<Discarded, 'scopes' | 'change'>,
): Discarded[] {
  if (steps.length === 0) return [];
  return [
    { reason, commit, steps: stepsToJson(steps), text: insertedText(steps), seq: s.seq, ...why },
  ];
}

/**
 * The permission change a control commit records, or null when it records none (04 §3.2): a
 * participant's completion changes no one else's permissions. `system` is no person (04 §10).
 */
function permissionChangeOf(c: RemoteCommit): PermissionChange | null {
  if (c.kind !== 'control' || c.control?.type === 'participant') return null;
  const user = c.author.user === 'system' ? null : c.author.user;
  return { user, time: c.serverTime, seq: c.seq };
}

/**
 * Applies confirmed steps. A confirmed step that fails to apply is a no-op (04 §14: every client
 * MUST treat it so, which keeps clients of a relay converging); behind an authority it means the
 * client and the server disagree, which the divergence check catches (04 §13), so it is reported.
 */
function applyConfirmed(
  doc: Node,
  steps: readonly Step[],
): { doc: Node; applied: Step[]; failed: number } {
  let current = doc;
  const applied: Step[] = [];
  let failed = 0;
  for (const step of steps) {
    let result: ReturnType<Step['apply']> | null;
    try {
      result = step.apply(current);
    } catch {
      result = null;
    }
    if (result?.doc) {
      current = result.doc;
      applied.push(step);
    } else failed++;
  }
  return { doc: current, applied, failed };
}

const failedReport = (what: string, failed: number): Action => ({
  t: 'report',
  code: 'step_failed',
  message: `${failed} confirmed step${failed === 1 ? '' : 's'} of ${what} did not apply and were treated as no-ops (04 §14)`,
});

/**
 * How one transition moved the confirmed document and the unconfirmed steps. Transitions in a row
 * (several commits in one message) are folded into one rebuild from the first state to the last
 * (`effectOf`), so that the steps that moved the confirmed document are never left out, even where
 * one of them changed nothing visible (an acknowledgement equal to the local steps).
 */
interface Move {
  /** The steps that moved the confirmed document, in order. */
  readonly moved: readonly Step[];
  /** For each moved step, the index (in the unconfirmed steps before) of the step it is the authority's version of, or -1. */
  readonly movedOrigins: readonly number[];
  /** For each unconfirmed step after, the index in the unconfirmed steps before it came from. */
  readonly origins: readonly number[];
}

interface Moved {
  readonly state: SyncState;
  readonly actions: readonly Action[];
  readonly move: Move;
}

const identity = (n: number): number[] => Array.from({ length: n }, (_, i) => i);

/** The rebuild from `s0` to `s1` through `moves`, or null when nothing visible changed. */
function effectOf(s0: SyncState, s1: SyncState, moves: readonly Move[]): Rebuild | null {
  if (s1.visible === s0.visible) return null;
  const before = unconfirmed(s0);
  let map: number[] = identity(before.length);
  const over: Step[] = [];
  const overOrigins: number[] = [];
  for (const m of moves) {
    over.push(...m.moved);
    for (const j of m.movedOrigins) overOrigins.push(j >= 0 ? (map[j] ?? -1) : -1);
    map = m.origins.map((j) => (j >= 0 ? (map[j] ?? -1) : -1));
  }
  return {
    kind: 'rebuild',
    base: s0.confirmed,
    before,
    over,
    overOrigins,
    after: unconfirmed(s1),
    afterOrigins: map,
    doc: s1.visible,
  };
}

const transition = (s0: SyncState, m: Moved): Transition => ({
  state: m.state,
  effect: effectOf(s0, m.state, [m.move]),
  actions: m.actions,
  ...(m.state.seq !== s0.seq
    ? { confirmed: [{ from: s0.seq, to: m.state.seq, steps: m.move.moved }] }
    : {}),
});

/** For each output step of a rebase, the index of the input step it came from. */
function originsOf(positions: readonly number[], offset = 0): number[] {
  const out: number[] = [];
  positions.forEach((p, i) => {
    if (p >= 0) out[p] = offset + i;
  });
  return out;
}

/**
 * Rebases the unconfirmed steps over `over` (applied to the confirmed document to give `next`);
 * steps that no longer apply are dropped and set aside.
 */
function rebaseLocal(
  s: SyncState,
  over: readonly Step[],
  next: Node,
  seq: number,
  extra: readonly Action[],
): Moved {
  const inf = s.inflight;
  const nInf = inf?.local.length ?? 0;
  const before = unconfirmed(s);
  if (over.length === 0)
    return {
      state: { ...s, confirmed: next, seq },
      actions: extra,
      move: { moved: [], movedOrigins: [], origins: identity(before.length) },
    };
  if (before.length === 0)
    return {
      state: { ...s, confirmed: next, seq, visible: next },
      actions: extra,
      move: { moved: over, movedOrigins: over.map(() => -1), origins: [] },
    };
  const rr = rebaseOver(before, mapsOf(over), next, 'drop');
  if (!rr.ok) throw new Error('a rebase in drop mode cannot fail');
  const { steps, positions, dropped, doc } = rr.value;
  carryOrigins(before, positions, steps);
  const pick = (from: number, to: number) =>
    positions
      .slice(from, to)
      .filter((i) => i >= 0)
      .map((i) => steps[i]!);
  const items = discard(
    s,
    dropped.map((i) => before[i]!),
    'rebase',
    null,
  );
  const state: SyncState = {
    ...s,
    confirmed: next,
    seq,
    inflight: inf ? { ...inf, local: pick(0, nInf) } : null,
    queue: pick(nInf, before.length),
    visible: doc,
    discarded: [...s.discarded, ...items],
  };
  return {
    state,
    actions: items.length ? [...extra, { t: 'discarded', items }] : extra,
    move: { moved: over, movedOrigins: over.map(() => -1), origins: originsOf(positions) },
  };
}

/** Confirms the in-flight commit with the authority's steps (04 §7). */
function confirm(s: SyncState, seq: number, given: readonly Step[]): Moved {
  const inf = s.inflight!;
  const { doc: next, applied: ackSteps, failed } = applyConfirmed(s.confirmed, given);
  const acked: Action = { t: 'acknowledged', id: inf.id, seq };
  const actions: Action[] = failed ? [acked, failedReport(`commit ${seq}`, failed)] : [acked];
  const nInf = inf.local.length;
  if (stepsEqual(ackSteps, inf.local)) {
    // The visible state already is the confirmed document plus the queue (04 §7: a no-op).
    return {
      state: { ...s, confirmed: next, seq, inflight: null },
      actions,
      move: {
        moved: ackSteps,
        movedOrigins: identity(nInf),
        origins: s.queue.map((_, k) => nInf + k),
      },
    };
  }
  const over = [...inverseMapsOf(inf.local), ...mapsOf(ackSteps)];
  const rr = rebaseOver(s.queue, over, next, 'drop');
  if (!rr.ok) throw new Error('a rebase in drop mode cannot fail');
  const { steps, positions, dropped, doc } = rr.value;
  carryOrigins(s.queue, positions, steps);
  const items = discard(
    s,
    dropped.map((i) => s.queue[i]!),
    'rebase',
    null,
  );
  if (items.length) actions.push({ t: 'discarded', items });
  // When the authority's steps correspond one to one to ours, each is the authority's version of
  // the local step at the same index, so undo history keeps the work (prosemirror-history follows
  // the pairing); otherwise they are new steps and the history entries of the commit are dropped.
  const paired = ackSteps.length === nInf;
  return {
    state: {
      ...s,
      confirmed: next,
      seq,
      inflight: null,
      queue: steps,
      visible: doc,
      discarded: [...s.discarded, ...items],
    },
    actions,
    move: {
      moved: ackSteps,
      movedOrigins: ackSteps.map((_, i) => (paired ? i : -1)),
      origins: originsOf(positions, nInf),
    },
  };
}

/** `sync.commit` (04 §8): commits in ascending `seq`, each checked for a gap (SYN-019). */
export function receiveCommits(
  s: SyncState,
  commits: readonly RemoteCommit[],
  schema: Schema,
): Transition {
  let state = s;
  const moves: Move[] = [];
  const actions: Action[] = [];
  const confirmed: Confirmed[] = [];
  for (const c of commits) {
    // Already applied: after a reload over REST the channel may still deliver commits at or below
    // the content's seq (05 §5.2). Skipping them is safe; anything beyond the next seq is a gap.
    if (c.seq <= state.seq) continue;
    if (c.seq !== state.seq + 1) {
      actions.push({ t: 'reconnect', reason: `gap: commit ${c.seq} after ${state.seq}` });
      break;
    }
    let m: Moved;
    if (state.inflight && c.id === state.inflight.id) {
      // Our own commit in the stream is the acknowledgement (04 §8).
      m = confirm(state, c.seq, parse(c.steps, schema));
    } else {
      const { doc, applied, failed } = applyConfirmed(state.confirmed, parse(c.steps, schema));
      const extra = failed ? [failedReport(`commit ${c.seq}`, failed)] : [];
      m = rebaseLocal(state, applied, doc, c.seq, extra);
    }
    confirmed.push({ from: state.seq, to: c.seq, steps: m.move.moved });
    state = m.state;
    const change = permissionChangeOf(c);
    if (change) state = { ...state, permissionChange: change };
    moves.push(m.move);
    actions.push(...m.actions);
  }
  return {
    state,
    effect: effectOf(s, state, moves),
    actions,
    ...(confirmed.length ? { confirmed } : {}),
  };
}

/** Steps from JSON; a step that does not parse is a no-op like one that does not apply. */
function parse(json: readonly unknown[], schema: Schema): Step[] {
  const out: Step[] = [];
  for (const j of json) {
    try {
      out.push(Step.fromJSON(schema, j));
    } catch {
      // Skipped; applyConfirmed reports failures of the steps that parse.
    }
  }
  return out;
}

/** `sync.ack` (04 §7). An acknowledgement of anything but the in-flight commit is ignored. */
export function receiveAck(s: SyncState, ack: Ack, schema: Schema): Transition {
  const inf = s.inflight;
  if (!inf || ack.id !== inf.id) return none(s);
  // Anything but the next seq is a gap; a resume then settles the commit's fate (04 §9).
  if (ack.seq !== s.seq + 1)
    return none(s, [{ t: 'reconnect', reason: `gap: acknowledgement ${ack.seq} after ${s.seq}` }]);
  const steps = ack.rebased ? parse(ack.steps ?? [], schema) : inf.sent;
  return transition(s, confirm(s, ack.seq, steps));
}

/** Drops the in-flight commit and rebuilds from the confirmed document plus the queue (04 §7). */
function dropInflight(
  s: SyncState,
  reason: string,
  why?: Pick<Discarded, 'scopes' | 'change'>,
): Moved {
  const inf = s.inflight!;
  const nInf = inf.local.length;
  const lost = discard(s, nInf ? inf.local : inf.sent, reason, inf.id, why);
  if (nInf === 0) {
    // Nothing of it is visible (a crafted or fully rebased-away commit): the queue stays as it is.
    return {
      state: { ...s, inflight: null, discarded: [...s.discarded, ...lost] },
      actions: lost.length ? [{ t: 'discarded', items: lost }] : [],
      move: { moved: [], movedOrigins: [], origins: s.queue.map((_, k) => k) },
    };
  }
  const rr = rebaseOver(s.queue, inverseMapsOf(inf.local), s.confirmed, 'drop');
  if (!rr.ok) throw new Error('a rebase in drop mode cannot fail');
  const { steps, positions, dropped, doc } = rr.value;
  carryOrigins(s.queue, positions, steps);
  const items = [
    ...lost,
    ...discard(
      s,
      dropped.map((i) => s.queue[i]!),
      'rebase',
      null,
    ),
  ];
  return {
    state: {
      ...s,
      inflight: null,
      queue: steps,
      visible: doc,
      discarded: [...s.discarded, ...items],
    },
    actions: items.length ? [{ t: 'discarded', items }] : [],
    move: { moved: [], movedOrigins: [], origins: originsOf(positions, nInf) },
  };
}

/** `sync.reject` (04 §8 table; SYN-020). */
export function receiveReject(s: SyncState, reject: SyncReject): Transition {
  const inf = s.inflight;
  if (!inf || reject.id !== inf.id) return none(s);
  switch (reject.action) {
    case 'retry':
      // The same commit with the same id, after the indicated delay.
      return none({ ...s, inflight: { ...inf, resend: true } }, [
        { t: 'resend', afterMs: reject.retryAfterMs ?? 0 },
      ]);
    case 'rebase':
      // Wait until the confirmed seq reaches the head the rejection names, then send the rebased
      // steps as a new commit with a new id.
      return none({
        ...s,
        inflight: null,
        queue: [...inf.local, ...s.queue],
        waitForHead: Math.max(reject.head, s.waitForHead ?? 0),
      });
    case 'drop': {
      if (reject.code === 'too_large' && inf.local.length > 1) {
        // Split the change and resubmit it in smaller commits (04 §8).
        return none({ ...s, inflight: null, queue: [...inf.local, ...s.queue] }, [
          { t: 'split', maxSteps: Math.max(1, Math.floor(inf.local.length / 2)) },
        ]);
      }
      // A permission rejection keeps what it names and the last permission change the client
      // saw, so that the editor can say which part was refused and who changed it (07 §9; PRM-024).
      const why =
        reject.code === 'permission_denied'
          ? { scopes: [...(reject.scopes ?? [])], change: s.permissionChange ?? null }
          : undefined;
      const t = transition(s, dropInflight(s, reject.code, why));
      const actions: Action[] = [...t.actions];
      if (reject.code === 'permission_denied')
        actions.push({ t: 'refresh-permissions', scopes: reject.scopes ?? [] });
      if (reject.code === 'read_only') actions.push({ t: 'read-only' });
      if (reject.code !== 'permission_denied' && reject.code !== 'read_only')
        actions.push({ t: 'report', code: reject.code, message: reject.message });
      return { ...t, actions };
    }
    case 'reload': {
      // Discard local state and reload the document (04 §8, `invalid_op`).
      const items = discard(s, unconfirmed(s), reject.code, inf.id);
      const state: SyncState = {
        ...s,
        inflight: null,
        queue: [],
        visible: s.confirmed,
        waitForHead: null,
        discarded: [...s.discarded, ...items],
      };
      const actions: Action[] = items.length ? [{ t: 'discarded', items }] : [];
      actions.push({ t: 'reload', reason: `${reject.code}: ${reject.message}` });
      // The visible document becomes the confirmed one at once; the reload then replaces both.
      return { state, effect: { kind: 'replace', doc: s.confirmed, requires: null }, actions };
    }
  }
}

/**
 * `ch.opened` (04 §9) when it streams. An in-flight commit reported `accepted` at or below the
 * confirmed `seq` cannot be in the stream, so it is set aside; one reported `unknown` (or not
 * answered) is resent after `sync.caughtUp`. Returns whether that resend is due.
 */
export function opened(
  s: SyncState,
  o: ChannelOpened,
): { transition: Transition; resendAfterCaughtUp: boolean } {
  const state: SyncState = { ...s, incarnation: o.incarnation, view: o.view ?? s.view };
  const inf = state.inflight;
  if (!inf) return { transition: none(state), resendAfterCaughtUp: false };
  const answer = o.inflight;
  if (answer?.state === 'accepted') {
    if ((answer.seq ?? 0) <= state.seq)
      return {
        transition: transition(state, dropInflight(state, 'stale')),
        resendAfterCaughtUp: false,
      };
    // The stream carries it: its own id in the stream is the acknowledgement.
    return { transition: none(state), resendAfterCaughtUp: false };
  }
  return { transition: none(state), resendAfterCaughtUp: true };
}

/** `sync.caughtUp`: resend the in-flight commit if the resume reported it unknown (04 §9 step 5). */
export function caughtUp(s: SyncState, resendDue: boolean): Transition {
  const inf = s.inflight;
  if (!inf || !resendDue) return none(s);
  return none({ ...s, inflight: { ...inf, resend: true } }, [{ t: 'resend', afterMs: 0 }]);
}

/**
 * A reload (04 §9 step 3; ADR 0019 item 6): the content at the head replaces the confirmed document,
 * and unconfirmed work goes to recovered edits. An in-flight commit the server reports `accepted` is
 * part of that content and is not set aside.
 */
export function reload(
  s: SyncState,
  content: Content,
  schema: Schema,
  view: string | undefined,
  inflightAccepted: boolean,
): Transition {
  const doc = schema.nodeFromJSON(content.doc);
  doc.check();
  const inf = s.inflight;
  const accepted = inf !== null && inflightAccepted;
  const items = discard(
    s,
    accepted ? s.queue : unconfirmed(s),
    'reload',
    accepted ? null : (inf?.id ?? null),
  );
  const state: SyncState = {
    ...initialState(doc, content.seq, content.incarnation, view),
    discarded: [...s.discarded, ...items],
  };
  return {
    state,
    effect: { kind: 'replace', doc, requires: content.requires },
    actions: items.length ? [{ t: 'discarded', items }] : [],
    confirmed: [{ from: s.seq, to: content.seq, steps: null }],
  };
}

/**
 * `sync.reset` (04 §3.2, §8): a snapshot commit replaced the document. The local steps are
 * re-applied to the new content; those that fail go to recovered edits. The in-flight commit stays
 * in flight with its re-applied steps: its base is now older than the snapshot, so it is rejected
 * with `stale_base` and action `rebase`, and its work is then resubmitted as a new commit.
 */
export function reset(s: SyncState, content: Content, schema: Schema): Transition {
  const doc = schema.nodeFromJSON(content.doc);
  doc.check();
  const inf = s.inflight;
  const kept: Step[] = [];
  const failed: Step[] = [];
  let visible = doc;
  let nInfKept = 0;
  unconfirmed(s).forEach((step, i) => {
    let result: ReturnType<Step['apply']> | null;
    try {
      result = step.apply(visible);
    } catch {
      result = null;
    }
    if (result?.doc) {
      visible = result.doc;
      kept.push(step);
      if (inf && i < inf.local.length) nInfKept++;
    } else failed.push(step);
  });
  const items = discard(s, failed, 'reset', null);
  const state: SyncState = {
    ...s,
    confirmed: doc,
    seq: content.seq,
    incarnation: content.incarnation,
    inflight: inf ? { ...inf, local: kept.slice(0, nInfKept) } : null,
    queue: kept.slice(nInfKept),
    visible,
    waitForHead: null,
    discarded: [...s.discarded, ...items],
  };
  return {
    state,
    effect: { kind: 'replace', doc: visible, requires: content.requires },
    actions: items.length ? [{ t: 'discarded', items }] : [],
    confirmed: [{ from: s.seq, to: content.seq, steps: null }],
  };
}
