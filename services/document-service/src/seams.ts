/**
 * The seams between the parts of the document service that are built in parallel (PLAN-1a:
 * packet A1, the data plane in `src/data-plane/`; packet A2, the control plane in
 * `src/control-plane/` and the composition in `src/server.ts`).
 *
 * This file belongs to the main session. Change it only additively, and say so in your report:
 * both packets build against it at the same time.
 */
import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import type { Connection, DocRole, PermissionState, Visibility } from '@docedit/authority';
import type { EventSink } from './control-plane/events.ts';
import type { JsonEnvelope } from '@docedit/model';
import type { RateLimits } from './data-plane/limits.ts';
import type { LiveQuotaGate } from './data-plane/quota-gate.ts';
import type { Content, Limits, Notification, RemoteCommit } from '@docedit/protocol';
import type {
  AuditEvent,
  AuditStore,
  CheckpointIndex,
  CheckpointStore,
  DocRef,
  DocumentStore,
  GrantStore,
  LogStore,
  NodeLeaseStore,
  OutboxStore,
  OwnershipStore,
} from './storage/types.ts';

/** Who a verified DEP token says the caller is (05 §3; PRO-008 to PRO-012). */
export interface VerifiedIdentity {
  readonly tenant: string;
  /** The document the token is for. */
  readonly doc: string;
  /** The identity the authority checks commits against (07 §2; 04 G6). */
  readonly connection: Connection;
  /** The token's identifier, recorded with each commit (HIS-001). */
  readonly jti: string;
  /** When the token expires, Unix milliseconds. */
  readonly expiresAt: number;
  // --- Added by packet A2 (additive). ---------------------------------------------------------
  /**
   * Every document of the `docs` claim with the role in it (05 §3.1: at most 20). `doc` and
   * `connection` describe the first entry; build the connection for another document with
   * `connectionFor()` (control-plane/tokens.ts). A document revoked for this user since the token
   * was issued (05 §3.3) is left out.
   */
  readonly docs: Readonly<Record<string, DocRole>>;
  /**
   * The host's `sub` claim. `connection.sub` is the per-tenant surrogate (BE-013; 08 §13), which
   * is what grants, leases and commits store; whether clients see one or the other is G11.
   */
  readonly sub: string;
  /** The `name` claim, when the token has one. */
  readonly name?: string;
  /** When the token was issued (`iat`), Unix milliseconds. */
  readonly issuedAt: number;
  /** Output restrictions of the `restrict` claim (`no-export`, `no-copy`, `no-print`). */
  readonly restrict: readonly string[];
  // --- Added by packet A, phase 1b (additive). ------------------------------------------------
  /** The `access_since` claim, Unix milliseconds, for the `since_access` setting (08 §9). */
  readonly accessSince?: number;
  // --- Added by PRO-015 (lane U-PRO-001-017, additive). ----------------------------------------
  /**
   * The `wfp`, `amr` and `auth_time` claims, recorded as the host gave them (12 §7; FRW-038,
   * FRW-040). The service does not vouch for them: they are not identity proof and feed no
   * permission check. Each is present only when the token carries it in the expected type.
   */
  readonly asserted?: {
    readonly wfp?: string;
    readonly amr?: readonly string[];
    readonly auth_time?: number;
  };
}

/**
 * Verifies a token. Rejects with an error whose `code` is a DEP error code from the registry
 * (`spec/dep/dep-1.registry.json`), for example `token_expired`, so that the data plane can answer
 * with the right `error` message or close code.
 */
export type VerifyToken = (token: string) => Promise<VerifiedIdentity>;

/**
 * The control plane tells the room that owns a document about changes made outside the room
 * (BE-026; 07 §9). In stage 1 the call is in process; later stages put a bus behind it.
 */
export interface RoomNotifier {
  /** The permission data changed; `perms` is the new state read back from storage. */
  permissionsChanged(ref: DocRef, perms: PermissionState): void;
  /** The document was locked, archived, unlocked or deleted: the room re-reads it or closes. */
  documentChanged(ref: DocRef): void;
}

/** What the data plane needs from the composition. */
export interface DataPlaneDeps {
  readonly logs: LogStore;
  readonly ownership: OwnershipStore;
  readonly grants: GrantStore;
  readonly documents: DocumentStore;
  readonly verify: VerifyToken;
  /** This node's identifier for ownership claims (06 §2.1). */
  readonly node: string;
  /** Server time, Unix milliseconds. */
  readonly now: () => number;
  /** The node's shared rate limits (BE-030); the data plane makes its own when absent. */
  readonly limits?: RateLimits;
  /** The live-use quota gate of the node (BE-091); absent when the node composes no quotas. */
  readonly quotas?: LiveQuotaGate | undefined;
  // --- Added by packet A2 (additive). ---------------------------------------------------------
  /**
   * Checkpoints in object storage (06 §4.2; BE-003). The content a document was created with is
   * the checkpoint at sequence number 0 (decision D67), so a room opens from `get(ref, 0)` plus
   * the log. The composition always passes it; without it a room has no content to start from.
   */
  readonly checkpoints?: CheckpointStore;
  // --- Added by packet A1 (additive). ---------------------------------------------------------
  /** Settings of the data plane; every member has a default (data-plane/settings.ts). */
  readonly settings?: DataPlaneSettings;
  /**
   * The tenant's allowed origins (05 §4; 10 §3.2), read when `hello` arrives, which is when the
   * tenant is known. A connection whose `Origin` header is not among them is closed with 4403; one
   * without the header (not a browser) is accepted (ADR 0035). Without this function no origin is
   * checked, which only a development setup may do.
   */
  readonly allowedOrigins?: (tenant: string) => Promise<readonly string[]>;
  /**
   * What a reader may not see (ADR 0019, proposed). Content reads, the outgoing stream and
   * presence all go through it, one visibility class at a time. Without it nothing is hidden.
   */
  readonly visibility?: Visibility;
  // --- Added by packet A2 (additive). ---------------------------------------------------------
  /**
   * The per-tenant user mapping (BE-013; S6 gap G11): storage and rooms hold surrogates, the wire
   * shows the host's `sub`. The composition always passes it.
   */
  readonly users?: UserLookup;
  // --- Added by packet A, phase 1b (additive; each one is off without it). --------------------
  /** The index of checkpoints (`doc_checkpoints`; BE-020): rooms open only from indexed ones. */
  readonly checkpointIndex?: CheckpointIndex;
  /** The audit trail (BE-014): rejected commits are recorded (PRM-051). */
  readonly audit?: AuditStore;
  /**
   * The event sink of the webhooks (05 §7; PRM-053 criterion 3): a refused commit raises
   * `dep.commit.rejected`. Absent: no event is raised from the data plane.
   */
  readonly events?: EventSink;
  /** The outbox (BE-039): server-authored operations are delivered from it. */
  readonly outbox?: OutboxStore;
  /** Node leases (BE-018): with them a node owns rooms only while it can prove its lease. */
  readonly leases?: NodeLeaseStore;
}

/** A token bucket's size and refill (BE-030). Added by packet A. */
export interface BucketSettings {
  readonly capacity: number;
  readonly refillPerSecond: number;
}

/** Rate limits by address, connection, user and tenant (06 §1, §8; BE-030). Added by packet A. */
export interface RateSettings {
  /** WebSocket upgrades per remote address, before any token is verified. */
  readonly addressConnections: BucketSettings;
  /** Frames per remote address before `hello` is accepted. */
  readonly addressFrames: BucketSettings;
  /** Messages per connection after `hello`. */
  readonly connection: BucketSettings;
  /** Messages per user (tenant and surrogate), over all of their connections. */
  readonly user: BucketSettings;
  /** Messages per tenant, over all of its connections. */
  readonly tenant: BucketSettings;
  /** Refusals in a row after which the connection is closed with 4429. */
  readonly closeAfterRefusals: number;
}

/** One unit of traced work (W3C trace context; 06 §11; BE-087, PRO-044). Added by packet A. */
export interface Span {
  /** For example `dep.session`, `dep.channel.open`, `dep.commit`, `dep.checkpoint`. */
  readonly name: string;
  /** 32 lower-case hex digits: the trace of the `traceparent` that started the work. */
  readonly traceId: string;
  /** 16 lower-case hex digits. */
  readonly spanId: string;
  readonly parentSpanId: string | null;
  /** Unix milliseconds. */
  readonly start: number;
  readonly end: number;
  /** Identifiers and codes only: never document content or tokens (06 §11). */
  readonly attributes: Readonly<Record<string, string | number | boolean>>;
}

/** Fault-injection hooks for the conformance kit (05 §11; BE-079). Added by packet A. */
export interface DataPlaneTestHooks {
  /** Every write of the node fails as if the database were unreachable, until `false`. */
  dropDatabase(down: boolean): void;
  /** The next write of the document fails before its insert, or after it and before COMMIT. */
  failNextWrite(ref: DocRef, at: 'before-insert' | 'after-insert'): void;
  /** Stops the document's room as a crash would: no release, no checkpoint. */
  killRoom(ref: DocRef): Promise<boolean>;
  /** The next grant announcement for the document is dropped. */
  dropNextAnnouncement(ref: DocRef): void;
  /** The chain head, the head and the ownership epoch of a document. */
  state(ref: DocRef): Promise<{
    seq: number;
    epoch: number;
    owner: string | null;
    incarnation: string;
    chainHead: string | null;
  }>;
  /** The audit events of a document. */
  auditEvents(ref: DocRef): Promise<AuditEvent[]>;
}

/** Lookups between host `sub` values and per-tenant surrogates (BE-013). Added by packet A2. */
export interface UserLookup {
  /** The `sub` of each surrogate that is still mapped; an erased user is missing from the map. */
  subsOf(tenant: string, surrogates: readonly string[]): Promise<ReadonlyMap<string, string>>;
  /** The surrogate of `sub`, created the first time the tenant sees it. */
  surrogateOf(tenant: string, sub: string): Promise<string>;
}

/** Settings of the data plane (05 §5.1; 06 §2.2). Every member is optional. Added by packet A1. */
export interface DataPlaneSettings {
  /** Limits announced in `welcome` and enforced (05 §5.1). */
  readonly limits?: Partial<Limits>;
  /** Features announced in `welcome` and discovery (05 §1 rule 4). */
  readonly features?: readonly string[];
  /** How long a connection may stay without `hello` (05 §5.1: 10 seconds). */
  readonly helloTimeoutMs?: number;
  /** How long a room stays open after its last channel closed (06 §2.2: 60 seconds). */
  readonly roomIdleMs?: number;
  /**
   * The key of the view tokens (ADR 0019 change 1; PRO-130). Nodes that serve the same documents
   * must share it; without it each process draws its own, so a failover forces readers to reload.
   */
  readonly viewKey?: Uint8Array;
  /** Called with errors the data plane could not answer on the wire (default: console.error). */
  readonly onError?: (error: unknown, where: string) => void;
  /** Whether `permessage-deflate` may be negotiated (05 §4: optional, off by default). */
  readonly compression?: boolean;
  /**
   * Whether a room tells its channels when a grant or lease expires (PRO-033), by a timer. On by
   * default; a test that drives the clock itself turns it off.
   */
  readonly expiryTimers?: boolean;
  // --- Added by packet A, phase 1b (additive; every member has a default, ADR 0053). ----------
  /** Chunks of one message must arrive within this time (05 §4: 10 seconds). */
  readonly chunkTimeoutMs?: number;
  /** Checkpoint policy (06 §2.2 step 3: 2,000 commits or ten minutes, at most every two). */
  readonly checkpoint?: {
    readonly everyCommits?: number;
    readonly everyMs?: number;
    readonly minIntervalMs?: number;
  };
  /** Whether rooms send `sync.check` after each checkpoint (04 §13; default on). */
  readonly syncCheck?: boolean;
  /** Bytes one channel's send queue may hold before `slow_consumer` (06 §2.4; BE-027). */
  readonly sendQueueBytes?: number;
  /** Bytes in flight to the socket per connection before frames wait in the queues. */
  readonly socketHighWater?: number;
  /** Estimated bytes of all rooms of the node; idle rooms close first above it (BE-021). */
  readonly roomMemoryBudget?: number;
  /** Rate limits (BE-030); each member replaces its default. */
  readonly rates?: Partial<RateSettings>;
  /** Whether the host serves `GET /documents/{id}/commits` (05 §6.2): rooms may then answer `page`. */
  readonly commitsResource?: boolean;
  /** The node lease (BE-018): duration, renewal interval and the drift margin. */
  readonly lease?: {
    readonly durationMs?: number;
    readonly renewMs?: number;
    readonly marginMs?: number;
  };
  /** Worker threads for checkpoints, replays and encoding (SYN-039); 0 runs them inline. */
  readonly workers?: number;
  /** Longest a worker task may run. */
  readonly workerTimeoutMs?: number;
  /** Outbox delivery (BE-039). */
  readonly outbox?: {
    readonly pollMs?: number;
    readonly leaseMs?: number;
    readonly batch?: number;
  };
  /** How long a drain waits for writes in flight (BE-022). */
  readonly drainTimeoutMs?: number;
  /** Turns the fault-injection hooks on (BE-079); a production composition never sets it. */
  readonly testMode?: boolean;
  /** Called with every finished span (BE-087; PRO-044). */
  readonly onSpan?: (span: Span) => void;
  /**
   * Broadcast coalescing for rooms with many subscribers (SYN-041; 04 §12): the window in
   * milliseconds and the channel count from which a room holds its commits. Off when absent.
   */
  readonly coalescing?: { readonly windowMs: number; readonly minSubscribers: number };
  /**
   * The CPU budgets of admission control (04 §12; SYN-037; SEC-028): each connection's budget in
   * a room and, when given, one budget per tenant shared by the tenant's rooms on the node. In the
   * cost units of `defaultCost` of `@docedit/authority`. Off when absent: the spec gives no
   * figure, and SYN-038 calibrates them.
   */
  readonly admission?: {
    readonly connection: { readonly capacity: number; readonly refillPerSecond: number };
    readonly tenant?: { readonly capacity: number; readonly refillPerSecond: number };
  };
}

/**
 * Content as the reader may see it, with the view token that a later `resume` carries (05 §6.2;
 * S6 gap G101; decision D70 of packet A2). Added by packet A1.
 */
export type ContentRead = Content & { readonly view: string };

/** The data plane: DEP over WebSocket, rooms and their storage (05 §5; 06 §2). */
export interface DataPlane extends RoomNotifier {
  /** Handles an HTTP upgrade to the DEP WebSocket (subprotocol `dep.v1`). */
  handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void;
  /** Stops accepting connections, closes the rooms, and resolves when they have stopped. */
  close(): Promise<void>;
  // --- Added by packet A2 (additive). ---------------------------------------------------------
  /** Features the data plane implements, for discovery (05 §2), for example `presence`. */
  readonly features?: readonly string[];
  /**
   * The host revoked a user's sessions (05 §3.3): close that user's channels, on `doc` only when
   * one is named. `user` is the per-tenant surrogate, as in `connection.sub`.
   */
  sessionsRevoked?(tenant: string, user: string, doc: string | null): void;
  /**
   * `PUT /documents/{id}/content` (05 §6.2; BE-037, PRO-050): stores `content` as a snapshot commit
   * with origin `import`, so that open channels get `sync.reset`, and resolves with its `seq`. The
   * control plane has checked the credential, If-Match and the content (`model.validate`); `actor`
   * is the surrogate the commit is attributed to, or `system`. Rejects with an error whose `code`
   * is a registry code. Without it the route answers `not_found`.
   */
  replaceContent?(
    ref: DocRef,
    content: JsonEnvelope,
    actor: string,
    // Added by packet A, phase 1b: the request's `traceparent` (BE-087).
    // HIS-019: `restore` for a whole-document restore (default `import`).
    opts?: { traceparent?: string; reason?: 'import' | 'restore' },
  ): Promise<{ seq: number }>;
  // --- Added by packet A1 (additive). ---------------------------------------------------------
  /**
   * The content of a document at `seq` (default: the durable head) as `identity` may see it, for
   * `GET /documents/{id}/content` (05 §6.2): projected for the reader's visibility class, checked
   * against the grants revision in storage (ADR 0019 change 3), with the view token (G101).
   * Rejects with an error whose `code` is `forbidden`, `not_found` or `unavailable`.
   */
  readContent?(identity: VerifiedIdentity, doc: string, seq?: number): Promise<ContentRead>;
  // --- Added by packet A, phase 1b (additive). ------------------------------------------------
  /**
   * `GET /documents/{id}/commits?after=&limit=` (05 §6.2; BE-038): stored commits after `after`
   * in ascending `seq`, at most `limit` (1 to 200), as `sync.commit` elements. Refused with
   * `forbidden` when `after` is below the caller's visibility gate (HIS-024) or the reader's class
   * hides content (the gateway reloads such readers), `conflict` when the next commit is a
   * snapshot commit (the client reloads; D122), `not_found` when `after` is above the head.
   */
  readCommits?(
    identity: VerifiedIdentity,
    doc: string,
    after: number,
    limit: number,
  ): Promise<CommitPage>;
  /**
   * Tells the open channels of a document that a resource changed (05 §5.6; PRO-035): every
   * channel, or only those of `user` (a surrogate), for example the requester of an export job.
   */
  notify?(ref: DocRef, n: Notification, opts?: { user?: string }): void;
  /**
   * Drains the node (06 §2.2 step 5; BE-022): no new connections or channels, writes in flight
   * finish and are answered, rooms are checkpointed and released, then `goaway` and 4503.
   */
  drain?(reason?: string): Promise<void>;
  /** The metrics of 06 §11 in the Prometheus text format (BE-086). */
  metrics?(): string;
  /** Present only in test mode (BE-079). */
  readonly hooks?: DataPlaneTestHooks | undefined;
}

/** A page of the commit log (BE-038). Added by packet A. */
export interface CommitPage {
  items: RemoteCommit[];
  /** The `after` of the next page, or null at the head. */
  next: number | null;
  head: number;
  incarnation: string;
}

export type CreateDataPlane = (deps: DataPlaneDeps) => DataPlane;
