/**
 * Relay mode (04 §14; 05 §3 and §10; SYN-044). A backend that cannot run the document model may
 * order and store commits and relay them, and nothing more. The relay:
 *
 * - skips steps 4 to 7 of 04 §5 (rebase, apply, invariants, permissions), so it does not read the
 *   steps' meaning at all;
 * - rejects any commit whose `base` is not the head with `stale_base`, and the client rebases
 *   locally, as in stock ProseMirror collaboration;
 * - stores each accepted commit before it acknowledges it, and sends it to the other channels.
 *
 * A relay is for trusted clients only. It cannot enforce region permissions, suggestion-only or
 * fill-only roles, or invariants, and it cannot serve content, catch-up beyond the log window,
 * restore, comparison or export without the authority service. Those limits are the functions
 * `relayCapabilities` and `relayFeatureAvailable` below. Because a relay stores steps it cannot
 * test, every client must treat an unappliable confirmed step as a no-op (04 §14; SYN-045).
 *
 * Attribution of an accepted commit comes from the connection and the server clock (G6), never
 * from the commit. The relay records no scopes, retired regions, claimed suggestions or revision,
 * because it evaluates no permission: those fields are empty or zero, and `cdm` is 0, which means
 * the relay did not check the document. `engine` is `pm-steps/1`, as the clients name it.
 *
 * The module reads no clock and no storage: the host passes `now` and a store. It is universal
 * code (no Node.js or browser APIs; FND-004).
 */
import { isUuid7 } from '@docedit/model';
import { CLIENT_ORIGINS, type RejectAction, type RejectCode, DEFAULT_ACTION } from '../codes.ts';
import type { Connection } from '../permissions/model.ts';
import { ENGINE, type StoredCommit, type ToClient } from './types.ts';
import type { StepJson } from '../steps.ts';

/** The mode a relay announces (05 §3). */
export const RELAY_MODE = 'relay' as const;

/**
 * The features a relay never announces (04 §14; 05 §3). workflow is added for FRW-025 criterion 6:
 * the workflow resource lives with the authority (docs/adr/0371-w4-FRW-025-workflow-put.md, proposed).
 */
export const RELAY_EXCLUDED_FEATURES: readonly string[] = [
  'regions',
  'suggest-enforced',
  'fields',
  'workflow',
];

/** The capability announcement of a relay (05 §3). */
export interface RelayCapabilities {
  mode: typeof RELAY_MODE;
  features: string[];
}

/**
 * The capabilities a relay announces: `mode: "relay"` and the given features without the three a
 * relay cannot enforce.
 */
export function relayCapabilities(features: readonly string[]): RelayCapabilities {
  return {
    mode: RELAY_MODE,
    features: features.filter((f) => !RELAY_EXCLUDED_FEATURES.includes(f)),
  };
}

/** What a relay cannot do without the authority service (04 §14; 05 §10). */
export type RelayFeature = 'content' | 'catchUpBeyondWindow' | 'restore' | 'comparison' | 'export';

/**
 * Whether a feature is available. An authority-mode backend serves all of them. A relay serves
 * them only with an authority service beside it.
 */
export function relayFeatureAvailable(
  mode: 'authority' | typeof RELAY_MODE,
  feature: RelayFeature,
  hasAuthorityService: boolean,
): boolean {
  void feature;
  return mode === 'authority' ? true : hasAuthorityService;
}

/** Stores one accepted commit. Returns false, or throws, when it cannot; then nothing is acknowledged. */
export interface RelayStore {
  append(commit: StoredCommit): boolean;
}

/** A message the host delivers to one channel. */
export interface RelayOut {
  channel: string;
  msg: ToClient;
}

export interface RelayInit {
  now: () => number;
  store: RelayStore;
  /** The commits already stored, in order, when a relay restarts. Each must have the next `seq`. */
  log?: readonly StoredCommit[];
}

/** The steps of a commit, as the relay received them; never read or validated (04 §14). */
function isStepList(v: unknown): v is StepJson[] {
  return Array.isArray(v);
}

export class Relay {
  private readonly now: () => number;
  private readonly store: RelayStore;
  private head: number;
  private readonly byId = new Map<string, StoredCommit>();
  private readonly channels = new Map<string, Connection>();

  constructor(init: RelayInit) {
    this.now = init.now;
    this.store = init.store;
    this.head = 0;
    for (const c of init.log ?? []) {
      if (c.seq !== this.head + 1) throw new RangeError(`the log has a gap at seq ${c.seq}`);
      this.head = c.seq;
      this.byId.set(c.id, c);
    }
  }

  /** The sequence number of the last stored commit. */
  get headSeq(): number {
    return this.head;
  }

  /** Opens a channel for a connection. Its commits are relayed to it from now on. */
  open(channel: string, conn: Connection): void {
    this.channels.set(channel, conn);
  }

  /** Closes a channel. */
  close(channel: string): void {
    this.channels.delete(channel);
  }

  /**
   * Handles one submitted commit from a channel. Input is untrusted: this never throws. The
   * returned messages are for the host to deliver, in order.
   */
  submit(channel: string, input: unknown): RelayOut[] {
    const conn = this.channels.get(channel);
    if (!conn) return [];
    const out: RelayOut[] = [];
    const rawId =
      typeof input === 'object' && input !== null ? (input as { id?: unknown }).id : undefined;
    const reject = (code: RejectCode, reason: string, action?: RejectAction): RelayOut[] => {
      out.push({
        channel,
        msg: {
          t: 'sync.reject',
          id: typeof rawId === 'string' ? rawId : '',
          code,
          action: action ?? DEFAULT_ACTION[code],
          head: this.head,
          reason,
        },
      });
      return out;
    };

    const obj =
      typeof input === 'object' && input !== null ? (input as Record<string, unknown>) : {};
    const id = obj['id'];
    const base = obj['base'];
    const steps = obj['steps'];
    const origin = obj['origin'] ?? 'input';

    if (typeof id !== 'string' || !isUuid7(id))
      return reject('invalid_op', 'a commit needs a UUID version 7 id');
    if (typeof base !== 'number' || !Number.isSafeInteger(base) || base < 0)
      return reject('invalid_op', 'base must be a sequence number');
    if (!isStepList(steps)) return reject('invalid_op', 'steps must be a list');
    if (typeof origin !== 'string' || !(CLIENT_ORIGINS as readonly string[]).includes(origin))
      return reject('invalid_op', 'origin is not a client origin');

    // Deduplicate: the same commit id from the same user is acknowledged again, never stored twice.
    const known = this.byId.get(id);
    if (known) {
      if (known.user !== conn.sub)
        return reject('invalid_op', 'the commit id belongs to another user');
      out.push({
        channel,
        msg: { t: 'sync.ack', id, seq: known.seq, time: known.time, rebased: false },
      });
      return out;
    }

    // Steps 4 to 7 are skipped. The base check is the only ordering rule: the base must be the head.
    if (base !== this.head)
      return reject('stale_base', `base ${base} is not the head ${this.head}`, 'rebase');

    const seq = this.head + 1;
    const commit: StoredCommit = {
      seq,
      id,
      kind: 'steps',
      steps,
      user: conn.sub,
      session: conn.session,
      ...(conn.agent !== undefined ? { agent: conn.agent } : {}),
      time: this.now(),
      origin,
      scopes: [],
      revision: 0,
      cdm: 0,
      engine: ENGINE,
      retired: [],
      claimed: [],
      base,
      rebased: false,
    };

    // Store before acknowledgement (04 §5 step 9; 05 §5). A failed store leaves the head unchanged.
    let stored: boolean;
    try {
      stored = this.store.append(commit);
    } catch {
      stored = false;
    }
    if (!stored) return reject('unavailable', 'the commit could not be stored; retry');

    this.head = seq;
    this.byId.set(id, commit);
    out.push({
      channel,
      msg: { t: 'sync.ack', id, seq, time: commit.time, rebased: false },
    });
    for (const other of this.channels.keys()) {
      if (other !== channel) out.push({ channel: other, msg: { t: 'sync.commit', commit } });
    }
    return out;
  }
}
