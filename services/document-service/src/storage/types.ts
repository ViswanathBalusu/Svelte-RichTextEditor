/**
 * The storage ports of the document service (06 §14; BE-002). Rooms and handlers depend on these
 * interfaces only; PostgreSQL implements them in this folder and memory.ts implements them in
 * process, and both pass the same contract suites (test/contract/).
 *
 * The write contract is the room's own: WriteRequest in, WriteResult out (packages/authority,
 * room/types.ts; 04 §5 step 9). A write is conditional on the ownership epoch, on the head (the
 * primary key (document, seq) is the last line of defence), and on the grants revision it was
 * checked against still being in force.
 */
import type {
  DocumentState,
  Lease,
  LogCommit,
  PermissionState,
  RegionGrant,
  RegionState,
  WriteRequest,
  WriteResult,
} from '@docedit/authority';
import type { LogBundle } from '@docedit/history';
import type { JsonEnvelope } from '@docedit/model';

/** A document as storage addresses it: always together with its tenant (06 §4.1, §12). */
export interface DocRef {
  readonly tenant: string;
  readonly doc: string;
}

/** The head row of a document (06 §2.1, §4.1). */
export interface LogHead {
  seq: number;
  epoch: number;
  owner: string | null;
  incarnation: string;
}

/** The head row with the chain head, for operations and the fault hooks (BE-079 criterion 4). */
export interface HeadState extends LogHead {
  /** The hash of the last commit, lower-case hex, or null before the first. */
  chainHead: string | null;
}

/**
 * Where a test fault abandons a write (BE-079): after the conditions held and before anything is
 * inserted, or after the inserts and before they are made durable. Either way nothing is stored
 * and the outcome is `failed`; a condition that does not hold is still reported as such.
 */
export type WriteFault = 'before-insert' | 'after-insert';

/** The commit log (06 §14 `LogStore`). Any implementation must offer the conditional append. */
export interface LogStore {
  /**
   * Appends a batch in one transaction, or nothing (04 §5 step 9; 06 §2.3). Resolves with the
   * outcome; it rejects only when not even the outcome could be established (OutcomeUnknownError).
   * A request with a snapshot commit needs `options.snapshot`, the content it brings (BE-037).
   */
  append(ref: DocRef, req: WriteRequest, options?: AppendOptions): Promise<WriteResult>;
  /**
   * Stored commits with fromSeq <= seq <= toSeq, in order. A snapshot commit (04 §3.2) comes back
   * with kind `snapshot` and no steps: its content is `snapshotContent` (packet A, phase 1b).
   */
  read(ref: DocRef, fromSeq?: number, toSeq?: number): Promise<LogCommit[]>;
  head(ref: DocRef): Promise<LogHead>;
  /**
   * The metadata of the stored commits with fromSeq <= seq <= toSeq, in order, with no payload: so it
   * also answers for a commit whose payload was removed (a tombstone, thinning; HIS-040, HIS-032).
   * A list of history needs no more. Optional: callers fall back to `read`.
   */
  readMeta?(ref: DocRef, fromSeq: number, toSeq: number): Promise<CommitMetaRow[]>;
  /**
   * The hashed metadata, payload hash and chain hashes of the records `fromSeq` to `toSeq`, with the
   * head, as the log bundle of `@docedit/history` holds them and without any payload (HIS-037). The
   * audit segment is cut from it. Optional: a store without it offers no audit export.
   */
  chainRange?(ref: DocRef, fromSeq: number, toSeq: number): Promise<LogBundle>;
  /**
   * The seq of the commit that introduced the suggestion, by its identifier, from an index that is
   * written as the commit is stored (HIS-042). It does not scan the log. Optional.
   */
  introducedBy?(ref: DocRef, suggestionId: string): Promise<number | undefined>;
  /**
   * The stored commit with this identifier, or null (04 §5 step 2, "then in the log"). A room holds
   * only the commits after its checkpoint; this finds the older ones, so that a redelivered
   * server-authored commit is acknowledged at its seq (BE-039). Optional: test doubles may omit it.
   */
  byId?(ref: DocRef, id: string): Promise<LogCommit | null>;
  /** The content a stored snapshot commit brought, or null when `seq` is not one. Packet A, 1b. */
  snapshotContent?(ref: DocRef, seq: number): Promise<JsonEnvelope | null>;
  /** The head with the chain head (BE-079 criterion 4). Optional: test doubles may omit it. */
  state?(ref: DocRef): Promise<HeadState>;
  /**
   * The assets attached to the document so far, with the seq of the commit that first referenced
   * each (doc_assets, BE-044). Optional: test doubles may omit it.
   */
  attachedAssets?(ref: DocRef): Promise<ReadonlyMap<string, number>>;
  /**
   * Attaches assets to a document outside a commit (`doc_assets` rows, kept if they exist): a fork
   * attaches the assets its content references, with `seq` 0, so that they resolve (HIS-022, I4).
   * Optional: test doubles may omit it.
   */
  attachAssets?(
    ref: DocRef,
    attachments: ReadonlyArray<{ asset: string; seq: number }>,
  ): Promise<void>;
  /**
   * The commits whose scopes include `scope`, newest first, behind the caller's gate (HIS-016;
   * `field:<id>` answers "who filled this field"). Optional: test doubles may omit it.
   */
  scopeHistory?(
    ref: DocRef,
    scope: string,
    gate?: { after?: number; upTo?: number },
  ): Promise<ScopeCommit[]>;
}

/** The metadata of a stored commit, without its payload (`readMeta`). */
export interface CommitMetaRow {
  seq: number;
  kind: LogCommit['kind'];
  user: string;
  /** The session, or the server's own session for a commit the server wrote. */
  session: string;
  /** Server time, Unix milliseconds. */
  time: number;
  origin: string;
  /** The agent identifier of a commit made on an agent connection (ADR 0234 A1). */
  agent?: string;
  scopes: string[];
  /**
   * The access revision the commit was checked against. A room reads it for the commit at its
   * checkpoint, so that opening needs no payload there (HIS-029: that payload may have moved or been
   * thinned). Optional: a store that does not give it leaves the caller to read the commit.
   */
  revision?: number;
}

/** One commit that changed a scope, as `scopeHistory` returns it (the shape of history's CommitMeta). */
export interface ScopeCommit {
  seq: number;
  kind: LogCommit['kind'];
  user: string;
  session: string;
  agent?: string;
  time: number;
  origin: string;
  scopes: string[];
}

/** What a write carries besides the request (packet A, phase 1b). */
export interface AppendOptions {
  /**
   * The content of the request's snapshot commit: the envelope, its canonical text compressed
   * with Zstandard (as a checkpoint is stored) and the SHA-256 of that text in lower-case hex,
   * which the commit's checkpoint reference names (`sha256:<hash>`).
   */
  snapshot?: {
    envelope: JsonEnvelope;
    encoded: Uint8Array;
    hash: string;
    /**
     * The object key of the checkpoint already written with this content at the snapshot's `seq`
     * (ADR 0034 §3): its index row is written in the same transaction as the commit (BE-020).
     */
    checkpointKey?: string;
  };
  /**
   * Assets the commits of this request attach to the document for the first time (BE-044 criterion
   * 1): one `doc_assets` row each, with `seq` as its `first_seq`, written in the same transaction as
   * the commits. A row that exists is kept.
   */
  attachments?: ReadonlyArray<{ asset: string; seq: number }>;
  /** A test fault for this write only (BE-079); set by the fault hooks, never in production. */
  fault?: WriteFault;
}

/** Room ownership for failover (06 §2.1; BE-017). */
export interface OwnershipStore {
  /** Makes `node` the owner and raises the epoch by one, in one transaction; returns the new epoch. */
  claim(ref: DocRef, node: string): Promise<number>;
  /** Clears the owner if `node` still holds `epoch`; true if it did. */
  release(ref: DocRef, node: string, epoch: number): Promise<boolean>;
  /**
   * Like `claim`, but only when the document has no owner, `node` owns it already, or the owner's
   * node lease has expired by the database clock (06 §2.1; BE-018); null otherwise. Packet A, 1b.
   */
  claimIfFree?(ref: DocRef, node: string): Promise<number | null>;
}

/** One change of permission data; applied in one transaction under a new grants revision (07 §9). */
export interface PermissionChange {
  /** Inserted, or replacing the grant with the same region and principal. */
  putGrants?: readonly RegionGrant[];
  removeGrants?: ReadonlyArray<{ region: string; principal: string }>;
  /**
   * For `approved`, the binding the room computed (PRM-046): the sequence number and the SHA-256 of
   * the region's canonical content at it. Any other state is stored with no binding.
   */
  setRegionStates?: ReadonlyArray<{
    region: string;
    state: RegionState;
    approval?: { seq: number; hash: string };
  }>;
  clearRegionStates?: readonly string[];
  /** One lease per region; replaces any lease the region has. */
  putLeases?: readonly Lease[];
  /** Region identifiers whose lease ends. */
  removeLeases?: readonly string[];
  documentState?: DocumentState;
  workflowActive?: boolean;
}

export interface ChangeOptions {
  /** Surrogate of the person or service making the change (BE-013). */
  actor: string;
  /** Refuse the change unless this is the current revision (optimistic concurrency for PATCH). */
  ifRevision?: number;
  /**
   * Names the workflow transition that makes this change (FRW-030). A repeat with the same key finds
   * the revision the first attempt raised and returns it with no second revision, so a transition
   * repeated after a stop leaves one control commit. Absent for any other change.
   */
  transition?: string;
}

/** Permission data of 07 §3 (06 §14 `GrantStore`; PRM-002). */
export interface GrantStore {
  /** The permission state in force now. */
  current(ref: DocRef): Promise<PermissionState>;
  /** The permission state that was in force at a revision, or null if the revision never existed. */
  at(ref: DocRef, revision: number): Promise<PermissionState | null>;
  /** Every revision's permission state, oldest first. */
  history(ref: DocRef): Promise<PermissionState[]>;
  /** Region identifiers retired for good (07 §3; I3). */
  retired(ref: DocRef): Promise<string[]>;
  /** Applies a change under the next revision and returns the new state. */
  change(ref: DocRef, change: PermissionChange, opts: ChangeOptions): Promise<PermissionState>;
}

export interface NewDocument {
  /** UUID version 7 (FND-003); generated when absent. */
  id?: string;
  externalId?: string;
  title?: string;
  cdmVersion: number;
  requires?: readonly string[];
  createdBy: string;
  /** The permission state at sequence number 0; its revision is the first one (default 1). */
  permissions?: Omit<PermissionState, 'revision'> & { revision?: number };
  /** Host-defined properties (05 §6.2), a JSON object. Added by packet A2. */
  properties?: Readonly<Record<string, unknown>>;
  /** The classification label (06 §4.1 `label`). Added by packet A2. */
  label?: string;
  /**
   * The provenance of a fork (HIS-022 criterion 2; 08 §8): the source document and the `seq` it was
   * copied at. Absent for a document that was not forked.
   */
  fork?: { from: string; atSeq: number };
}

export interface DocumentRecord {
  id: string;
  tenant: string;
  externalId: string | null;
  title: string | null;
  state: DocumentState;
  cdmVersion: number;
  requires: string[];
  historyVisibility: string;
  createdBy: string;
  createdAt: number;
  incarnation: string;
  head: number;
  // Added by packet A2 (BE-035).
  properties: Record<string, unknown>;
  label: string | null;
  /** Set by a soft delete (05 §6.2 DELETE); a deleted document is gone for every caller. */
  deletedAt: number | null;
  /** Raised by every change of the metadata; the document's ETag (05 §6.1). */
  metaRevision: number;
  /** The document this one was forked from (HIS-022 criterion 2), or null. Absent before 0061. */
  forkedFrom?: string | null;
  /** The `seq` of the source the fork copied (HIS-022 criterion 2), or null. */
  forkedAtSeq?: number | null;
}

/** A change of document metadata (05 §6.2 PATCH /documents/{id}). Added by packet A2. */
export interface DocumentPatch {
  title?: string | null;
  properties?: Readonly<Record<string, unknown>>;
  label?: string | null;
  /** A change of state is a change of permission data: it raises the grants revision (07 §9). */
  state?: DocumentState;
}

/** Options of a metadata change. Added by packet A2. */
export interface DocumentChangeOptions {
  /** Surrogate of the person or service making the change (BE-013). */
  actor: string;
  /** Refuse the change unless this is the current metadata revision (If-Match). */
  ifMetaRevision?: number;
}

/** A page of documents (05 §6.2 GET /documents). Added by packet A2. */
export interface DocumentQuery {
  externalId?: string;
  /** Only documents whose identifier sorts after this one. */
  after?: string;
  limit: number;
}

/** Document metadata (06 §4.1 `documents`, `doc_heads`). */
export interface DocumentStore {
  /** Creates the document, its head row and its first grants revision in one transaction. */
  create(tenant: string, input: NewDocument): Promise<DocumentRecord>;
  get(ref: DocRef): Promise<DocumentRecord | null>;
  // Added by packet A2 (BE-035).
  /** The tenant's documents that are not deleted, in identifier order (UUID version 7: creation order). */
  list(tenant: string, query: DocumentQuery): Promise<DocumentRecord[]>;
  /**
   * Changes metadata in one transaction. A change of `state` also raises the grants revision and
   * records the permission state in force at it, so `perms` is the new state (null otherwise).
   * Throws RevisionConflictError (with the current metadata revision) when `ifMetaRevision` is
   * stale, and DocumentNotFoundError for a missing or deleted document.
   */
  update(
    ref: DocRef,
    patch: DocumentPatch,
    opts: DocumentChangeOptions,
  ): Promise<{ record: DocumentRecord; perms: PermissionState | null }>;
  /** Soft delete: sets `deletedAt` and raises the metadata revision; the data stays (HIS-029). */
  remove(ref: DocRef, opts: DocumentChangeOptions): Promise<DocumentRecord>;
}

/**
 * Checkpoints: canonical CDM content at a sequence number, in object storage (06 §4.2; BE-003,
 * BE-020). The content a document is created with is the checkpoint at sequence number 0.
 * Added by packet A2.
 */
export interface CheckpointStore {
  /** Stores the content at `seq`. Writing the same `seq` again replaces it with equal content. */
  put(ref: DocRef, seq: number, content: JsonEnvelope): Promise<void>;
  /** The content at exactly `seq`, or null. */
  get(ref: DocRef, seq: number): Promise<JsonEnvelope | null>;
  /** The newest checkpoint at or before `seq`, or null. */
  latest(ref: DocRef, atOrBefore: number): Promise<{ seq: number; content: JsonEnvelope } | null>;
  // Added by packet A, phase 1b (optional; the data plane falls back to the members above).
  /**
   * Stores a checkpoint already encoded as `put` would store it: the canonical JSON text,
   * compressed with Zstandard. The data plane encodes in a worker thread (SYN-039).
   */
  putEncoded?(ref: DocRef, seq: number, bytes: Uint8Array): Promise<void>;
  /** The stored bytes of the checkpoint at exactly `seq`, or null. */
  getEncoded?(ref: DocRef, seq: number): Promise<Uint8Array | null>;
  /**
   * Stores the side object of the checkpoint at `seq`: the comment ranges at that `seq` and the
   * attribution map, as `encodeSide` writes them (06 §2.2 step 3, §4.2, §8 `{seq}.side.json.zst`;
   * SYN-032 criterion 6, owner decision 81; HIS-014, ADR 0377). It is written before the
   * checkpoint, and set aside with it.
   */
  putSide?(ref: DocRef, seq: number, bytes: Uint8Array): Promise<void>;
  /** The stored bytes of the side object of the checkpoint at exactly `seq`, or null. */
  getSide?(ref: DocRef, seq: number): Promise<Uint8Array | null>;
  /**
   * Sets aside every checkpoint above `aboveSeq`, so that `get` and `latest` no longer return it
   * (a log rewound by a database recovery; BE-078). Returns the sequence numbers set aside.
   */
  setAside?(ref: DocRef, aboveSeq: number): Promise<number[]>;
}

/**
 * Assets, export outputs and sealed PDFs of a tenant, in object storage (`AssetStore`, 06 §4.2,
 * §4.4, §14; BE-002, BE-003). The implementation over an `ObjectStore` is `ObjectAssetStore`
 * (src/objects/checkpoints.ts).
 */
export interface AssetStore {
  /** An upload before validation (06 §4.4). */
  putQuarantined(tenant: string, asset: string, bytes: Uint8Array): Promise<void>;
  getQuarantined(tenant: string, asset: string): Promise<Uint8Array | null>;
  /** A final asset: the store computes the SHA-256 and writes the content-addressed object. */
  putFinal(tenant: string, bytes: Uint8Array, contentType: string): Promise<string>;
  getFinal(tenant: string, sha256: string): Promise<Uint8Array | null>;
  /** An output of an export job, under the job's prefix. */
  putExport(
    tenant: string,
    job: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
  /** A sealed PDF: written once; a second write is refused with `ObjectExistsError`. */
  putSealed(tenant: string, doc: string, workflow: string, bytes: Uint8Array): Promise<void>;
  getSealed(tenant: string, doc: string, workflow: string): Promise<Uint8Array | null>;
  /** A short-lived URL of an object of `tenant`, after the caller's permission check (10 §3.7). */
  signedUrl(tenant: string, key: string, expiresAt: number): string;
}

// --- Ports added by packet A, phase 1b (06 §4.1, §14). Implementations: src/data-plane/pg/ and
// src/data-plane/memory-ports.ts. ---------------------------------------------------------------

/** One row of `doc_checkpoints` (06 §4.1; BE-020): a checkpoint written and verified. */
export interface CheckpointRow {
  seq: number;
  /** The object key (06 §4.2). */
  key: string;
  /** Bytes of the stored object (compressed). */
  bytes: number;
  /** SHA-256 of the canonical JSON text, lower-case hex: the hash `sync.check` carries. */
  hash: string;
  createdAt: number;
}

/** The index of checkpoints (06 §4.1 `doc_checkpoints`; BE-020, BE-078, BE-081). */
export interface CheckpointIndex {
  record(ref: DocRef, row: Omit<CheckpointRow, 'createdAt'>): Promise<void>;
  /** The checkpoints of a document that are not set aside, oldest first. */
  list(ref: DocRef): Promise<CheckpointRow[]>;
  /** Marks every checkpoint above `aboveSeq` as set aside; returns their sequence numbers. */
  setAside(ref: DocRef, aboveSeq: number): Promise<number[]>;
}

/** An entry of the audit trail (06 §4.1 `audit_events`; 07 §14; BE-014, PRM-051). */
export interface AuditEvent {
  /** UUID version 7. */
  id: string;
  tenant: string;
  doc: string | null;
  /** The per-tenant surrogate of the actor, or `system` (08 §13). */
  actor: string;
  /** For example `commit.rejected`, `grants.changed`, `incarnation.changed`. */
  kind: string;
  /** Small data: identifiers, codes and scopes, never document text. */
  data: Record<string, unknown>;
  /** Server time, Unix milliseconds. */
  at: number;
}

export interface AuditQuery {
  doc?: string;
  actor?: string;
  kind?: string;
  /** Inclusive, Unix milliseconds. */
  from?: number;
  /** Exclusive, Unix milliseconds. */
  to?: number;
  limit: number;
}

/** The append-only audit trail (BE-014): events are inserted, never changed. */
export interface AuditStore {
  record(events: readonly AuditEvent[]): Promise<void>;
  /** The tenant's events, oldest first. */
  query(tenant: string, q: AuditQuery): Promise<AuditEvent[]>;
}

/** What the control plane asks the room to do through the outbox (06 §3; 04 §10; BE-039). */
export interface NewOutboxItem {
  tenant: string;
  doc: string;
  /** The deterministic commit identifier (UUID version 7; 08 §2): a retry cannot apply it twice. */
  commitId: string;
  kind: 'snapshot' | 'author';
  /**
   * JSON: for `snapshot`, `{ reason, actor, preconditions? }`; for `author`, `{ origin, actor,
   * base, steps, preconditions? }`. `actor` is a surrogate or `system`.
   */
  request: Record<string, unknown>;
  /** The content of a snapshot: canonical JSON compressed with Zstandard. */
  payload?: Uint8Array | null;
}

export interface OutboxItem extends Required<NewOutboxItem> {
  id: string;
  state: 'pending' | 'done' | 'failed';
  /** `{ seq }` when done; `{ code, action, message }` when refused. */
  result: Record<string, unknown> | null;
  attempts: number;
  createdAt: number;
}

/** The outbox (06 §4.1 `outbox`; BE-039). */
export interface OutboxStore {
  /** Writes an item; an item with the same document and commit identifier is returned instead. */
  enqueue(item: NewOutboxItem): Promise<OutboxItem>;
  get(tenant: string, id: string): Promise<OutboxItem | null>;
  /** Pending items of any tenant whose lock is free, locked for `node` for `leaseMs`. */
  claim(node: string, leaseMs: number, limit: number): Promise<OutboxItem[]>;
  /** Settles an item `node` holds: done with `{ seq }`, or failed with the rejection. */
  settle(
    item: Pick<OutboxItem, 'tenant' | 'id'>,
    node: string,
    state: 'done' | 'failed',
    result: Record<string, unknown>,
  ): Promise<boolean>;
  /** Gives an item back without settling it, for a later attempt. */
  unlock(item: Pick<OutboxItem, 'tenant' | 'id'>, node: string): Promise<void>;
}

/**
 * Writes outbox items together with the control-plane state they rely on, as one unit (BE-039
 * criterion 1; 06 §3): the items and the audit events are all stored or none is, so an operator's
 * request is on the audit trail exactly when its item is in the outbox. In PostgreSQL this is one
 * transaction under the tenant (`insertOutboxItem` and `insertAuditEvent`).
 */
export interface OutboxWriter {
  write(
    tenant: string,
    unit: { items: readonly NewOutboxItem[]; events: readonly AuditEvent[] },
  ): Promise<OutboxItem[]>;
}

/** A node that holds a live lease, with the WebSocket address it announced (null when none). */
export interface NodeInfo {
  readonly node: string;
  readonly address: string | null;
  /** The region the node runs in (BE-074), or null/absent when it announced none. */
  readonly region?: string | null;
  /** The one document this node is dedicated to (BE-073), or null/absent for a general node. */
  readonly dedicated?: string | null;
}

/** What a node announces about itself on its lease row besides its address. */
export interface NodeTraits {
  /** The region the node runs in; routing for a tenant with a home region considers its nodes only. */
  readonly region?: string;
  /** A node that runs the rooms of this one document and no other (a hot document; BE-073). */
  readonly dedicated?: string;
}

/** Node-level liveness leases (06 §2.1; BE-018). Expiry is judged by the database clock only. */
export interface NodeLeaseStore {
  /**
   * Takes or renews the lease of `node` until `leaseMs` from now by the database clock. `address`
   * is the WebSocket URL the node announces for its own channels (BE-061; owner decision 200); a
   * renewal without one leaves no address on the row.
   */
  renew(node: string, leaseMs: number, address?: string, traits?: NodeTraits): Promise<void>;
  /** Whether `node` holds a lease that has not expired by the database clock. */
  alive(node: string): Promise<boolean>;
  /** The nodes that hold a lease that has not expired by the database clock (BE-060), by name. */
  live(): Promise<NodeInfo[]>;
  /** Ends the lease of `node`. */
  release(node: string): Promise<void>;
}

/** One assignment of a home region: the tenant's (no document) or one document's. */
export interface HomeRegionRow {
  readonly doc: string | null;
  readonly region: string;
}

/**
 * Home regions (06 §7; BE-074 criterion 1). A tenant has at most one, and a document of it may have
 * its own, which wins for that document. A tenant with none has no home region: routing is then as
 * on one region.
 */
export interface HomeRegionStore {
  /** The region of the document: its own assignment, else its tenant's, else null. */
  resolve(ref: DocRef): Promise<string | null>;
  /** Assigns the region of the tenant, or of one of its documents; replaces an earlier one. */
  assign(tenant: string, region: string, by: string, doc?: string): Promise<void>;
  /** Removes an assignment; true when there was one. */
  clear(tenant: string, doc?: string): Promise<boolean>;
  /** The tenant's assignments: its own first, then its documents' in identifier order. */
  list(tenant: string): Promise<HomeRegionRow[]>;
}

/** The outcome of a write could not be established, not even by reading the log back. */
export class OutcomeUnknownError extends Error {
  override name = 'OutcomeUnknownError';
}

/** A change named a region whose identifier is retired (07 §3; BE-010). */
export class RetiredRegionError extends Error {
  override name = 'RetiredRegionError';
}

/** A change was made against a revision that is no longer current. */
export class RevisionConflictError extends Error {
  override name = 'RevisionConflictError';
  readonly current: number;
  constructor(message: string, current: number) {
    super(message);
    this.current = current;
  }
}

export class DocumentNotFoundError extends Error {
  override name = 'DocumentNotFoundError';
}

/** Another document of the tenant has the same `externalId` (06 §4.1 unique key). Packet A2. */
export class DuplicateExternalIdError extends Error {
  override name = 'DuplicateExternalIdError';
}
