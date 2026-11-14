/**
 * The data plane's settings and their defaults (05 §4, §5.1; 04 §3.1, §8, §9, §11; 06 §2.2). Every
 * figure is a target of the spec. Where the spec names none (`maxMessageBytes` and `maxChannels`,
 * gap G18; the send-queue bound, the rate limits and the node lease of phase 1b, ADR 0053), the
 * default is the value of an example in the spec, of the mock backend, or the one ADR 0053 gives
 * its reasons for, and the operator sets the real one (PRO-022 notes).
 */
import { randomBytes } from 'node:crypto';
import { DEFAULT_LIMITS } from '@docedit/authority';
import { supportedFeatures } from '@docedit/model/definition';
import type { Limits } from '@docedit/protocol';
import type { DataPlaneSettings, RateSettings, Span } from '../seams.ts';
import type { CoalescingSettings } from './syn-041-coalescing.ts';

export interface CheckpointSettings {
  /** A checkpoint after this many stored commits since the last one (06 §2.2 step 3: 2,000). */
  readonly everyCommits: number;
  /** Or after this long since the first commit after the last one (ten minutes). */
  readonly everyMs: number;
  /** But never more often than this (two minutes). */
  readonly minIntervalMs: number;
}

export interface LeaseSettings {
  /** How long a renewal keeps the node lease valid, by the database clock (BE-018). */
  readonly durationMs: number;
  /** How often the node renews its lease ("every few seconds", 06 §2.1). */
  readonly renewMs: number;
  /** Subtracted from the validity the node proves with its own monotonic clock (clock drift). */
  readonly marginMs: number;
}

export interface Settings {
  readonly limits: Limits;
  /** Announced in `welcome` and discovery (05 §1 rule 4): protocol and CDM features (D121). */
  readonly features: readonly string[];
  /** Protocol versions the server speaks (05 §1). */
  readonly versions: readonly string[];
  /** Sync engines (05 §5.2). */
  readonly engines: readonly string[];
  /** CDM major versions (05 §2). */
  readonly cdm: { readonly min: number; readonly max: number };
  readonly helloTimeoutMs: number;
  readonly roomIdleMs: number;
  /** `auth.expiring` is sent this long before `tokenExp` (05 §5.1: about 60 seconds). */
  readonly authExpiringMs: number;
  /** Chunks of one message must arrive within this time (05 §4: 10 seconds). */
  readonly chunkTimeoutMs: number;
  /** The largest message accepted after reassembly: the largest commit and its envelope. */
  readonly maxReassembledBytes: number;
  /**
   * The largest frame the WebSocket layer reads at all. A frame above `maxMessageBytes` and below
   * this is answered with `too_large` and close 4413; a larger one is cut by the WebSocket layer
   * before it is buffered (ADR 0035).
   */
  readonly maxFrameBytes: number;
  /** The key of the view tokens (ADR 0019 change 1; PRO-130). */
  readonly viewKey: Uint8Array;
  readonly onError: (error: unknown, where: string) => void;
  /** Whether `permessage-deflate` may be negotiated (05 §4: off by default). */
  readonly compression: boolean;
  /** Whether rooms announce expiries of grants and leases by a timer (PRO-033). */
  readonly expiryTimers: boolean;
  // --- Phase 1b (packet A; ADR 0053) -----------------------------------------------------------
  readonly checkpoint: CheckpointSettings;
  /** Whether a room sends `sync.check` after each checkpoint (04 §13; SYN-043). */
  readonly syncCheck: boolean;
  /** Bytes one channel's send queue may hold before the channel is closed (06 §2.4; BE-027). */
  readonly sendQueueBytes: number;
  /** Bytes handed to the socket and not yet flushed, per connection, before frames queue. */
  readonly socketHighWater: number;
  /** Estimated bytes of all rooms of the node; idle rooms close first above it (BE-021). 0: none. */
  readonly roomMemoryBudget: number;
  readonly rates: RateSettings;
  /** Whether the host serves `GET /documents/{id}/commits`, so rooms may answer `page` (04 §9). */
  readonly commitsResource: boolean;
  readonly lease: LeaseSettings;
  /** Worker threads for checkpoints, replays and encoding (06 §1; SYN-039); 0 runs them inline. */
  readonly workers: number;
  /** Longest a worker task may run; the worker is then replaced and the task fails. */
  readonly workerTimeoutMs: number;
  /** Outbox delivery (BE-039): poll interval, lock, batch size. */
  readonly outbox: { readonly pollMs: number; readonly leaseMs: number; readonly batch: number };
  /** How long a drain waits for writes in flight before it stops the rooms anyway (BE-022). */
  readonly drainTimeoutMs: number;
  /** Whether the fault-injection hooks exist (BE-079). Off unless a test turns it on. */
  readonly testMode: boolean;
  /** Called with every finished span (BE-087; PRO-044). */
  readonly onSpan: ((span: Span) => void) | undefined;
  /** Broadcast coalescing (SYN-041): off when absent; no default threshold or window is set. */
  readonly coalescing?: CoalescingSettings | undefined;
}

/** 05 §5.9's example for `maxMessageBytes`; 16 channels as in the mock backend (G18). */
export const DEFAULT_LIMIT_VALUES: Limits = {
  maxMessageBytes: 131_072,
  maxCommitBytes: DEFAULT_LIMITS.maxCommitBytes,
  maxStepsPerCommit: DEFAULT_LIMITS.maxStepsPerCommit,
  maxRebaseSteps: DEFAULT_LIMITS.maxRebaseSteps,
  maxChannels: 16,
  heartbeatMs: 25_000,
  ackTimeoutMs: 15_000,
  presenceHz: 10,
  presenceBytes: 1024,
  catchUpCommits: 5000,
  catchUpBytes: 5 * 1024 * 1024,
};

/** The protocol features the data plane implements (05 §2; 07 §5): the authority enforces P4. */
// `read-restrictions`: the name is the kit's proposal (ADR 0042 item 4; PRO-130), not yet a DEP decision.
export const PROTOCOL_FEATURES: readonly string[] = [
  'presence',
  'regions',
  'suggest-enforced',
  'read-restrictions',
];

/**
 * What the data plane announces (D121): its protocol features and the CDM features its document
 * model reads (03 §11.1), which share one namespace (05 §1 rule 4).
 */
export const DEFAULT_FEATURES: readonly string[] = [
  ...new Set([...PROTOCOL_FEATURES, ...supportedFeatures()]),
];

/**
 * Rate limits of ADR 0053 (BE-030): the spec names no figure, so the defaults only stop a flood.
 * Many users can share one address (an office behind NAT, a test harness), so the address limits
 * are wide; the operator sets the real ones.
 */
export const DEFAULT_RATES: RateSettings = {
  addressConnections: { capacity: 2000, refillPerSecond: 200 },
  addressFrames: { capacity: 4000, refillPerSecond: 400 },
  connection: { capacity: 400, refillPerSecond: 200 },
  user: { capacity: 1000, refillPerSecond: 400 },
  tenant: { capacity: 20_000, refillPerSecond: 5000 },
  closeAfterRefusals: 50,
};

export function settingsFrom(s: DataPlaneSettings = {}): Settings {
  const limits: Limits = { ...DEFAULT_LIMIT_VALUES, ...s.limits };
  return {
    limits,
    features: s.features ?? DEFAULT_FEATURES,
    versions: ['1.0'],
    engines: ['pm-steps/1'],
    cdm: { min: 1, max: 1 },
    helloTimeoutMs: s.helloTimeoutMs ?? 10_000,
    roomIdleMs: s.roomIdleMs ?? 60_000,
    authExpiringMs: 60_000,
    chunkTimeoutMs: s.chunkTimeoutMs ?? 10_000,
    maxReassembledBytes: limits.maxCommitBytes + 64 * 1024,
    maxFrameBytes: Math.max(8 * limits.maxMessageBytes, 1024 * 1024),
    viewKey: s.viewKey ?? randomBytes(32),
    compression: s.compression ?? false,
    expiryTimers: s.expiryTimers ?? true,
    onError:
      s.onError ??
      ((error, where) => {
        console.error(`data plane: ${where}:`, error);
      }),
    checkpoint: {
      everyCommits: s.checkpoint?.everyCommits ?? 2000,
      everyMs: s.checkpoint?.everyMs ?? 10 * 60_000,
      minIntervalMs: s.checkpoint?.minIntervalMs ?? 2 * 60_000,
    },
    syncCheck: s.syncCheck ?? true,
    // A whole catch-up stream (at most catchUpBytes of commits, more as DEP JSON) must fit, with
    // room for live commits behind it (ADR 0053).
    sendQueueBytes: s.sendQueueBytes ?? 2 * limits.catchUpBytes + 2 * limits.maxCommitBytes,
    socketHighWater: s.socketHighWater ?? 1024 * 1024,
    roomMemoryBudget: s.roomMemoryBudget ?? 0,
    rates: {
      ...DEFAULT_RATES,
      ...s.rates,
    },
    commitsResource: s.commitsResource ?? false,
    lease: {
      durationMs: s.lease?.durationMs ?? 15_000,
      renewMs: s.lease?.renewMs ?? 3000,
      marginMs: s.lease?.marginMs ?? 1000,
    },
    workers: s.workers ?? 1,
    workerTimeoutMs: s.workerTimeoutMs ?? 60_000,
    outbox: {
      pollMs: s.outbox?.pollMs ?? 1000,
      leaseMs: s.outbox?.leaseMs ?? 30_000,
      batch: s.outbox?.batch ?? 20,
    },
    drainTimeoutMs: s.drainTimeoutMs ?? 10_000,
    testMode: s.testMode ?? false,
    onSpan: s.onSpan,
    ...(s.coalescing ? { coalescing: s.coalescing } : {}),
  };
}
