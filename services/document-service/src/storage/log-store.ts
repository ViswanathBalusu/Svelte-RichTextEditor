/**
 * The commit log in PostgreSQL (06 §2.1, §2.3, §4.1; 04 §5 steps 9 and 10; BE-017, BE-024, BE-025).
 *
 * A write is one transaction that
 *   1. locks the document's head row and checks the ownership epoch and that the head is where the
 *      room believes it is,
 *   2. holds the grants revision row (FOR SHARE) and compares it with the revision the batch was
 *      checked against (04 G7),
 *   3. inserts the commit rows, their payloads and their scopes, and records retired regions,
 *   4. advances the head and the chain head, and retires the removed regions' grants, states and
 *      leases (07 §3),
 * and the primary key (doc_id, seq) refuses a second writer even if the head check were bypassed.
 *
 * Outcomes: an error before COMMIT was sent is a definite failure (the server never commits a
 * transaction without it). An error while COMMIT is outstanding makes the outcome unknown; the
 * store then waits until no transaction holds the head row, which means the write has either
 * committed or rolled back, and reads the log tail back for the room (04 §5, "When a write fails").
 */
import {
  SERVER_SESSION,
  type LogCommit,
  type PermissionState,
  type SnapshotCommit,
  type StoredCommit,
  type WriteRequest,
  type WriteResult,
} from '@docedit/authority';
import { createHash } from 'node:crypto';
import { zstdDecompressSync } from 'node:zlib';
import type { LogBundle } from '@docedit/history';
import type { JsonEnvelope } from '@docedit/model';
import {
  DocumentKeyDestroyedError,
  DocumentKeyUnavailableError,
  isSealed,
  type DocumentKeys,
  type DocumentSealer,
} from './document-keys.ts';
import { PayloadAbsentError } from './payload-absent.ts';
import {
  chainHash,
  decodeContent,
  decodePayload,
  encodeCommit,
  metadataBytes,
  type CommitMetadata,
} from './codec.ts';
import {
  assertUuid,
  beginForTenant,
  constraintOf,
  int,
  iso,
  millis,
  sqlState,
  SQLSTATE,
  type Pool,
  type PoolClient,
  type Queryable,
} from './db.ts';
import {
  DocumentNotFoundError,
  OutcomeUnknownError,
  type AppendOptions,
  type CommitMetaRow,
  type DocRef,
  type HeadState,
  type LogHead,
  type LogStore,
  type OwnershipStore,
  type ScopeCommit,
} from './types.ts';

export type { ScopeCommit } from './types.ts';

/** Points at which a fault injector may abort a write (faults.ts; BE-079). */
export interface AppendHooks {
  /** The conditions held and nothing is inserted yet. */
  beforeInsert?(client: PoolClient): Promise<'continue' | 'rollback'>;
  /** Everything is inserted and the head advanced; COMMIT comes next. */
  beforeCommit?(client: PoolClient): Promise<'commit' | 'rollback'>;
}

/** What tests and the fault hooks read about a document's head row (BE-079 criterion 4). */
export type { HeadState };

/** The hooks that carry out a test fault of AppendOptions (BE-079), added to any already given. */
function withFault(options: AppendOptions & AppendHooks): AppendOptions & AppendHooks {
  const rollback = () => Promise.resolve('rollback' as const);
  if (options.fault === 'before-insert') return { ...options, beforeInsert: rollback };
  if (options.fault === 'after-insert') return { ...options, beforeCommit: rollback };
  return options;
}

export interface PgLogStoreOptions {
  /** The permission state in force, returned with `revision_moved` (06 §2.3 step 2). */
  permissions(ref: DocRef): Promise<PermissionState>;
  /** How long a write waits for the head row or the revision row before it fails (default 5 s). */
  lockTimeoutMs?: number;
  /** Attempts at reading the log back after an unknown outcome (default 5). */
  unknownAttempts?: number;
  /**
   * Per-document keys (HIS-041). With it, the payloads of a document that has a key are sealed in
   * the table and opened on read. Without it the store never looks for a key.
   */
  documentKeys?: DocumentKeys;
}

export type ChainVerdict = { ok: true; head: number } | { ok: false; seq: number; reason: string };

interface CommitRow {
  seq: string;
  kind: LogCommit['kind'];
  commit_id: string;
  user_id: string;
  session_id: string | null;
  agent: string | null;
  server_ts: Date;
  origin: string;
  base: string | null;
  rebased: boolean | null;
  access_rev: string;
  token_jti: string | null;
  cdm_version: number;
  engine: string;
  payload: Buffer | null;
  scopes: string[];
}

const COMMIT_ROWS = `
  SELECT c.seq, c.kind, c.commit_id, c.user_id, c.session_id, c.agent, c.server_ts, c.origin,
         c.base, c.rebased, c.access_rev, c.token_jti, c.cdm_version, c.engine, p.payload,
         coalesce(s.scopes, '{}') AS scopes
    FROM doc_commits c
    LEFT JOIN doc_commit_payloads p ON p.doc_id = c.doc_id AND p.seq = c.seq
    LEFT JOIN LATERAL (
      SELECT array_agg(cs.scope ORDER BY cs.scope COLLATE "C") AS scopes
        FROM commit_scopes cs
       WHERE cs.doc_id = c.doc_id AND cs.seq = c.seq
    ) s ON true`;

const SELECT_COMMITS = `${COMMIT_ROWS}
   WHERE c.doc_id = $1 AND c.seq >= $2 AND ($3::bigint IS NULL OR c.seq <= $3)
   ORDER BY c.seq`;

/** The metadata of a range of commits, with no payload (`readMeta`). */
const SELECT_COMMIT_META = `
  SELECT c.seq, c.kind, c.user_id, c.session_id, c.server_ts, c.origin,
         coalesce(s.scopes, '{}') AS scopes
    FROM doc_commits c
    LEFT JOIN LATERAL (
      SELECT array_agg(cs.scope ORDER BY cs.scope COLLATE "C") AS scopes
        FROM commit_scopes cs
       WHERE cs.doc_id = c.doc_id AND cs.seq = c.seq
    ) s ON true
   WHERE c.doc_id = $1 AND c.seq >= $2 AND c.seq <= $3
   ORDER BY c.seq`;

/** The stored commit with one of the identifiers, the earliest first. */
const SELECT_BY_ID = `${COMMIT_ROWS}
   WHERE c.doc_id = $1 AND c.commit_id = ANY ($2::uuid[])
   ORDER BY c.seq
   LIMIT 1`;

/**
 * The commits that changed one scope, newest first, with their metadata and no payload (HIS-016;
 * 06 §4.1 notes). The scope is found through the primary key of `commit_scopes`, (doc_id, scope,
 * seq), and each commit row by its own key (doc_id, seq); the log is not read in order and no
 * payload is read. The commit row is a LATERAL lookup with LIMIT 1 (the key gives at most one row
 * anyway) so that the planner keeps it a keyed lookup per scope row: as a plain join it may scan
 * the document's whole commit partition when the partition is small. `$3` is the gate's
 * `minVisibleSeq` (commits at or below it are withheld) and `$4` the head. Exported so that a test
 * can read the plan of this exact statement.
 */
export const SELECT_SCOPE_HISTORY = `
  SELECT c.seq, c.kind, c.user_id, c.session_id, c.agent, c.server_ts, c.origin,
         coalesce(s.scopes, '{}') AS scopes
    FROM commit_scopes f
    JOIN LATERAL (
      SELECT k.seq, k.kind, k.user_id, k.session_id, k.agent, k.server_ts, k.origin
        FROM doc_commits k
       WHERE k.doc_id = $1 AND k.seq = f.seq
       LIMIT 1
    ) c ON true
    LEFT JOIN LATERAL (
      SELECT array_agg(cs.scope ORDER BY cs.scope COLLATE "C") AS scopes
        FROM commit_scopes cs
       WHERE cs.doc_id = f.doc_id AND cs.seq = f.seq
    ) s ON true
   WHERE f.doc_id = $1 AND f.scope = $2 AND f.seq > $3 AND ($4::bigint IS NULL OR f.seq <= $4)
   ORDER BY f.seq DESC`;

/** What `#append` reports for a conflict on the commit identifier alone. */
const DUPLICATE = Symbol('duplicate');

const INSERT_BATCH = `
  WITH c AS (
    INSERT INTO doc_commits (doc_id, seq, tenant_id, kind, commit_id, user_id, session_id, agent,
                             server_ts, origin, base, rebased, access_rev, token_jti, cdm_version,
                             engine, size, payload_hash, prev_hash, hash)
    SELECT $1, x.seq, $2, x.kind, x.commit_id, x.user_id, x.session_id, x.agent, x.server_ts,
           x.origin, x.base, x.rebased, x.access_rev, x.token_jti, x.cdm_version, x.engine, x.size,
           x.payload_hash, x.prev_hash, x.hash
      FROM unnest($3::bigint[], $4::text[], $5::uuid[], $6::text[], $7::text[], $8::text[],
                  $9::timestamptz[], $10::text[], $11::bigint[], $12::boolean[], $13::bigint[],
                  $14::text[], $15::int[], $16::text[], $17::int[], $18::bytea[], $19::bytea[],
                  $20::bytea[])
        AS x(seq, kind, commit_id, user_id, session_id, agent, server_ts, origin, base, rebased,
             access_rev, token_jti, cdm_version, engine, size, payload_hash, prev_hash, hash)
  ), p AS (
    INSERT INTO doc_commit_payloads (doc_id, seq, tenant_id, payload)
    SELECT $1, x.seq, $2, x.payload FROM unnest($3::bigint[], $21::bytea[]) AS x(seq, payload)
  ), s AS (
    INSERT INTO commit_scopes (doc_id, scope, seq, tenant_id)
    SELECT $1, x.scope, x.seq, $2 FROM unnest($22::text[], $23::bigint[]) AS x(scope, seq)
  ), rr AS (
    INSERT INTO retired_regions (doc_id, region_id, tenant_id, retired_seq)
    SELECT $1, x.region_id, $2, x.seq FROM unnest($24::text[], $25::bigint[]) AS x(region_id, seq)
    ON CONFLICT (doc_id, region_id) DO NOTHING
  ), rg AS (
    DELETE FROM region_grants WHERE doc_id = $1 AND region_id = ANY ($24::text[])
  ), rs AS (
    DELETE FROM region_states WHERE doc_id = $1 AND region_id = ANY ($24::text[])
  ), rl AS (
    DELETE FROM region_leases WHERE doc_id = $1 AND region_id = ANY ($24::text[])
  )
  UPDATE doc_heads SET head_seq = $26, chain_head = $27 WHERE doc_id = $1`;

/** A snapshot commit's content, next to the commit, in the same transaction (migration 0030). */
const INSERT_SNAPSHOT = `
  INSERT INTO doc_snapshots (doc_id, seq, tenant_id, content, content_hash)
  VALUES ($1, $2, $3, $4, $5)`;

/**
 * The attachments of a request (BE-044 criterion 1): an asset is attached to the document from the
 * first commit that references it, and a row that exists is kept (criterion 5).
 */
const INSERT_DOC_ASSETS = `
  INSERT INTO doc_assets (tenant_id, doc_id, asset_id, first_seq)
  SELECT $1, $2, x.asset, x.seq FROM unnest($3::uuid[], $4::bigint[]) AS x(asset, seq)
  ON CONFLICT (tenant_id, doc_id, asset_id) DO NOTHING`;

/** The commit that introduced each suggestion, kept as the commit is stored (HIS-042; migration 0062). The lowest seq wins. */
const INSERT_SUGGESTION_INTRODUCTIONS = `
  INSERT INTO suggestion_introductions (tenant_id, doc_id, suggestion_id, seq)
  SELECT $1, $2, x.id, x.seq FROM unnest($3::text[], $4::bigint[]) AS x(id, seq)
  ON CONFLICT (tenant_id, doc_id, suggestion_id) DO UPDATE
    SET seq = least(suggestion_introductions.seq, excluded.seq)`;

/** The index row of the checkpoint written for a snapshot (BE-020; ADR 0034 §3). */
const INSERT_CHECKPOINT_ROW = `
  INSERT INTO doc_checkpoints (doc_id, seq, tenant_id, object_key, bytes, content_hash, created_at)
  VALUES ($1, $2, $3, $4, $5, $6, now())
  ON CONFLICT (doc_id, seq) DO UPDATE
    SET object_key = excluded.object_key, bytes = excluded.bytes,
        content_hash = excluded.content_hash, created_at = excluded.created_at, set_aside_at = NULL`;

/**
 * Claims a document for `$2` only when it has no owner, `$2` owns it already, or the owner holds
 * no lease that is still valid by the database clock (06 §2.1; BE-018). A row with an owner that
 * never took a lease (a node of phase 1a) is claimable.
 */
const CLAIM_IF_FREE = `
  UPDATE doc_heads h SET owner = $2, epoch = h.epoch + 1
   WHERE h.doc_id = $1
     AND (h.owner IS NULL OR h.owner = $2
          OR NOT EXISTS (SELECT 1 FROM node_leases l WHERE l.node = h.owner AND l.expires_at > now()))
  RETURNING h.epoch`;

const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function asError(e: unknown): Error {
  return e instanceof Error ? e : new Error(String(e));
}

/**
 * Refuses requests the room never makes; they are programming errors, not storage outcomes. A
 * snapshot commit (04 §3.2) is written alone, with its content (BE-037).
 */
function checkRequest(ref: DocRef, req: WriteRequest, options: AppendOptions): LogCommit[] {
  assertUuid(ref.tenant, 'tenant');
  assertUuid(ref.doc, 'document');
  if (!Number.isSafeInteger(req.epoch) || !Number.isSafeInteger(req.revision))
    throw new TypeError('epoch and revision must be integers');
  if (!Number.isSafeInteger(req.fromSeq) || req.fromSeq < 1)
    throw new TypeError('fromSeq must be a sequence number');
  if (req.snapshot) {
    const s = req.snapshot;
    if (req.commits.length > 0) throw new TypeError('a snapshot commit is written alone');
    if (s.seq !== req.fromSeq) throw new TypeError(`the snapshot commit has seq ${s.seq}`);
    if (s.revision !== req.revision)
      throw new TypeError('the snapshot commit was checked against another revision');
    const content = options.snapshot;
    if (!content) throw new TypeError('a snapshot commit needs its content');
    if (s.snapshot.checkpoint !== `sha256:${content.hash}`)
      throw new TypeError('the snapshot commit references other content');
    return [s];
  }
  if (req.commits.length === 0) throw new TypeError('a write needs at least one commit');
  req.commits.forEach((c, i) => {
    if (c.seq !== req.fromSeq + i)
      throw new TypeError(`commit ${i} has seq ${c.seq}, expected ${req.fromSeq + i}`);
    if (c.revision !== req.revision)
      throw new TypeError(`commit ${c.seq} was checked against another revision than the batch`);
  });
  return req.commits;
}

/**
 * A stored row as the room's commit. `base`, `rebased`, `jti` and the agent come back when they
 * were recorded, so that a restarted room can rebuild an acknowledgement from the log (HIS-001;
 * SYN-008). A snapshot commit comes back with its checkpoint reference; its content is read with
 * `snapshotContent`.
 */
function toStoredCommit(row: CommitRow): LogCommit {
  if (!row.payload) throw new PayloadAbsentError(int(row.seq));
  const payload = decodePayload(row.payload);
  if (row.kind === 'snapshot') {
    if (!payload.snapshot) throw new Error(`snapshot commit ${row.seq} has no reference`);
    const s: SnapshotCommit = {
      seq: int(row.seq),
      id: row.commit_id,
      kind: 'snapshot',
      steps: [],
      snapshot: payload.snapshot,
      user: row.user_id,
      session: row.session_id ?? SERVER_SESSION,
      time: millis(row.server_ts)!,
      origin: row.origin,
      scopes: row.scopes,
      revision: int(row.access_rev),
      cdm: row.cdm_version,
      engine: row.engine,
      retired: payload.retired,
      claimed: payload.claimed,
    };
    if (row.agent !== null) s.agent = row.agent;
    if (row.base !== null) s.base = int(row.base);
    if (row.rebased !== null) s.rebased = row.rebased;
    if (row.token_jti !== null) s.jti = row.token_jti;
    return s;
  }
  const c: StoredCommit = {
    seq: int(row.seq),
    id: row.commit_id,
    kind: row.kind,
    steps: payload.steps,
    user: row.user_id,
    // A stored NULL session is a server-authored commit's (codec.ts).
    session: row.session_id ?? SERVER_SESSION,
    time: millis(row.server_ts)!,
    origin: row.origin,
    scopes: row.scopes,
    revision: int(row.access_rev),
    cdm: row.cdm_version,
    engine: row.engine,
    retired: payload.retired,
    claimed: payload.claimed,
  };
  if (row.agent !== null) c.agent = row.agent;
  if (row.base !== null) c.base = int(row.base);
  if (row.rebased !== null) c.rebased = row.rebased;
  if (row.token_jti !== null) c.jti = row.token_jti;
  return c;
}

export class PgLogStore implements LogStore, OwnershipStore {
  readonly #pool: Pool;
  readonly #permissions: (ref: DocRef) => Promise<PermissionState>;
  readonly #lockTimeoutMs: number;
  readonly #unknownAttempts: number;
  #keys: DocumentKeys | undefined;

  constructor(pool: Pool, options: PgLogStoreOptions) {
    this.#pool = pool;
    this.#permissions = options.permissions;
    this.#lockTimeoutMs = options.lockTimeoutMs ?? 5000;
    this.#unknownAttempts = options.unknownAttempts ?? 5;
    this.#keys = options.documentKeys;
  }

  /** Turns on per-document keys after construction (HIS-041), for a store made before the keys were. */
  useDocumentKeys(keys: DocumentKeys): void {
    this.#keys = keys;
  }

  /** The sealer of the document, or null when it has no key (or the store has no key support). */
  async #sealerOf(ref: DocRef): Promise<DocumentSealer | null> {
    return this.#keys ? this.#keys.sealerFor(ref) : null;
  }

  /**
   * The rows with their payloads opened (HIS-041). A sealed payload with no key to open it is
   * never returned as it is: it is an error, so no one reads sealed bytes as content.
   */
  async #opened(ref: DocRef, rows: readonly CommitRow[], sealer: DocumentSealer | null) {
    const out: CommitRow[] = [];
    for (const row of rows) {
      if (!row.payload || !isSealed(row.payload)) {
        out.push(row);
        continue;
      }
      if (!sealer) throw new DocumentKeyDestroyedError(ref.doc);
      out.push({
        ...row,
        payload: Buffer.from(await sealer.open(`${ref.doc}/${int(row.seq)}`, row.payload)),
      });
    }
    return out;
  }

  async append(
    ref: DocRef,
    req: WriteRequest,
    options: AppendOptions & AppendHooks = {},
  ): Promise<WriteResult> {
    const r = await this.#append(ref, req, withFault(options));
    if (r !== DUPLICATE) return r;
    // A conflict on the commit identifier alone is a duplicate submission, never another writer
    // (06 §2.3; 04 §5): the room answers it from the stored commit (BE-025). The lookup runs after
    // the write's connection went back to the pool.
    const ids = req.snapshot ? [req.snapshot.id] : req.commits.map((c) => c.id);
    const stored = await this.#storedOf(ref, ids).catch(() => null);
    return stored ? { status: 'duplicate', stored } : { status: 'failed' };
  }

  async #storedOf(ref: DocRef, ids: readonly string[]): Promise<LogCommit | null> {
    const sealer = await this.#sealerOf(ref);
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<CommitRow>(SELECT_BY_ID, [ref.doc, ids]);
        const [row] = await this.#opened(ref, r.rows.slice(0, 1), sealer);
        return row ? toStoredCommit(row) : null;
      },
      true,
    );
  }

  async #append(
    ref: DocRef,
    req: WriteRequest,
    hooks: AppendOptions & AppendHooks,
  ): Promise<WriteResult | typeof DUPLICATE> {
    const commits = checkRequest(ref, req, hooks);
    const encoded = commits.map((c) => encodeCommit(ref.doc, c));
    // A document with its own key has its payloads sealed before they reach the table (HIS-041). A
    // key that cannot be had stops the write, with nothing sent, rather than writing in the clear.
    let sealer: DocumentSealer | null;
    try {
      sealer = await this.#sealerOf(ref);
    } catch (e) {
      if (e instanceof DocumentKeyDestroyedError || e instanceof DocumentKeyUnavailableError)
        return { status: 'failed' };
      throw e;
    }
    const payloads: Buffer[] = [];
    for (const e of encoded)
      payloads.push(
        sealer
          ? Buffer.from(await sealer.seal(`${ref.doc}/${e.meta.seq}`, e.payload))
          : Buffer.from(e.payload),
      );
    let client: PoolClient;
    try {
      client = await this.#pool.connect();
    } catch {
      // No connection, so nothing was sent: the room rejects with `unavailable` (06 §8).
      return { status: 'failed' };
    }
    let broken: Error | undefined;
    let committing = false;
    let released = false;
    const release = (err: Error | undefined) => {
      if (released) return;
      released = true;
      client.release(err);
    };
    const rollback = async () => {
      try {
        await client.query('ROLLBACK');
      } catch (e) {
        broken = asError(e);
      }
    };
    try {
      await beginForTenant(client, ref.tenant, { lockTimeoutMs: this.#lockTimeoutMs });
      // Steps 1 and 2: the head row for update, the revision row for share.
      const locked = await client.query<{
        head_seq: string;
        epoch: string;
        chain_head: Buffer | null;
        rev: string;
      }>(
        `SELECT h.head_seq, h.epoch, h.chain_head, g.rev
           FROM doc_heads h JOIN grant_revisions g ON g.doc_id = h.doc_id
          WHERE h.doc_id = $1
            FOR UPDATE OF h FOR SHARE OF g`,
        [ref.doc],
      );
      const head = locked.rows[0];
      if (!head || int(head.epoch) !== req.epoch || int(head.head_seq) !== req.fromSeq - 1) {
        await rollback();
        return { status: 'fenced' };
      }
      if (int(head.rev) !== req.revision) {
        await rollback();
        return { status: 'revision_moved', perms: await this.#permissions(ref) };
      }
      if ((await hooks.beforeInsert?.(client)) === 'rollback') {
        await rollback();
        return { status: 'failed' };
      }

      // Steps 3 and 4: the rows, the chain and the head, in one statement.
      let prev: Buffer | null = head.chain_head;
      const prevHashes: Array<Buffer | null> = [];
      const hashes: Buffer[] = [];
      for (const e of encoded) {
        const h = chainHash(prev, e.metaBytes, e.payloadHash);
        prevHashes.push(prev);
        hashes.push(h);
        prev = h;
      }
      const m = encoded.map((e) => e.meta);
      const scopes = commits.flatMap((c) => c.scopes.map((s) => [s, c.seq] as const));
      const retired = commits.flatMap((c) => c.retired.map((r) => [r, c.seq] as const));
      await client.query(INSERT_BATCH, [
        ref.doc,
        ref.tenant,
        m.map((x) => x.seq),
        m.map((x) => x.kind),
        m.map((x) => x.id),
        m.map((x) => x.user),
        m.map((x) => x.session),
        m.map((x) => x.agent),
        m.map((x) => x.time),
        m.map((x) => x.origin),
        m.map((x) => x.base),
        m.map((x) => x.rebased),
        m.map((x) => x.revision),
        m.map((x) => x.jti),
        m.map((x) => x.cdm),
        m.map((x) => x.engine),
        m.map((x) => x.size),
        encoded.map((e) => e.payloadHash),
        prevHashes,
        hashes,
        payloads,
        scopes.map(([s]) => s),
        scopes.map(([, seq]) => seq),
        retired.map(([r]) => r),
        retired.map(([, seq]) => seq),
        req.fromSeq + commits.length - 1,
        hashes[hashes.length - 1],
      ]);
      if (hooks.attachments?.length)
        await client.query(INSERT_DOC_ASSETS, [
          ref.tenant,
          ref.doc,
          hooks.attachments.map((a) => a.asset),
          hooks.attachments.map((a) => a.seq),
        ]);
      // The suggestions this batch claims first are indexed in the same transaction (HIS-042).
      const claims = commits.flatMap((c) => c.claimed.map((id) => [id, c.seq] as const));
      if (claims.length)
        await client.query(INSERT_SUGGESTION_INTRODUCTIONS, [
          ref.tenant,
          ref.doc,
          claims.map(([id]) => id),
          claims.map(([, seq]) => seq),
        ]);
      const snap = req.snapshot ? hooks.snapshot : undefined;
      if (req.snapshot && snap) {
        const hash = Buffer.from(snap.hash, 'hex');
        await client.query(INSERT_SNAPSHOT, [
          ref.doc,
          req.snapshot.seq,
          ref.tenant,
          sealer
            ? Buffer.from(
                await sealer.seal(`snapshot/${ref.doc}/${req.snapshot.seq}`, snap.encoded),
              )
            : Buffer.from(snap.encoded),
          hash,
        ]);
        if (snap.checkpointKey !== undefined)
          await client.query(INSERT_CHECKPOINT_ROW, [
            ref.doc,
            req.snapshot.seq,
            ref.tenant,
            snap.checkpointKey,
            snap.encoded.byteLength,
            hash,
          ]);
      }

      if ((await hooks.beforeCommit?.(client)) === 'rollback') {
        await rollback();
        return { status: 'failed' };
      }
      committing = true;
      await client.query('COMMIT');
      return { status: 'ok' };
    } catch (e) {
      if (committing) {
        // COMMIT was outstanding: it may have been applied. Never guess; read the log back.
        release(asError(e));
        return await this.resolveUnknown(ref, req.fromSeq);
      }
      await rollback();
      // Another writer stored this sequence number: a primary key keyed by (document, seq)
      // refused it (06 §2.1). The statement's parts run in no fixed order, so the commit, payload
      // or scope table may be the one that reports it.
      const constraint = constraintOf(e) ?? '';
      if (
        sqlState(e) === SQLSTATE.uniqueViolation &&
        /^(doc_commits|doc_commit_payloads)(_p\d+)?_pkey$|^commit_scopes_pkey$/.test(constraint)
      )
        return { status: 'fenced' };
      // The unique key (doc_id, commit_id) alone: the commit is stored already.
      if (
        sqlState(e) === SQLSTATE.uniqueViolation &&
        /^doc_commits(_p\d+)?_doc_id_commit_id_key$/.test(constraint)
      )
        return DUPLICATE;
      // Anything else stored nothing.
      return { status: 'failed' };
    } finally {
      release(broken);
    }
  }

  /**
   * The outcome of a write that began at `fromSeq` is unknown: wait until no transaction holds the
   * head row, then return the log from `fromSeq` (04 §5). Rejects with OutcomeUnknownError when
   * the log cannot be read after the configured attempts; the room host must then stop the room.
   */
  async resolveUnknown(ref: DocRef, fromSeq: number): Promise<WriteResult> {
    let last: unknown;
    const sealer = await this.#sealerOf(ref);
    for (let attempt = 0; attempt < this.#unknownAttempts; attempt++) {
      if (attempt > 0) await delay(Math.min(2000, 50 * 2 ** attempt));
      const client = await this.#pool.connect().catch((e: unknown) => {
        last = e;
        return null;
      });
      if (!client) continue;
      let broken: Error | undefined;
      try {
        await beginForTenant(client, ref.tenant, { lockTimeoutMs: this.#lockTimeoutMs });
        // FOR SHARE waits for a FOR UPDATE holder: once granted, the uncertain write has ended.
        const r = await client.query('SELECT 1 FROM doc_heads WHERE doc_id = $1 FOR SHARE', [
          ref.doc,
        ]);
        if (r.rowCount !== 1) throw new DocumentNotFoundError(`no document ${ref.doc}`);
        const tail = await this.#select(client, ref, fromSeq, null, sealer);
        await client.query('COMMIT');
        return { status: 'unknown', tail };
      } catch (e) {
        last = e;
        broken = asError(e);
        await client.query('ROLLBACK').catch(() => {});
      } finally {
        client.release(broken);
      }
    }
    throw new OutcomeUnknownError(
      `the outcome of the write from seq ${fromSeq} of ${ref.doc} is unknown and the log could not be read: ${String(last)}`,
    );
  }

  async read(ref: DocRef, fromSeq = 1, toSeq?: number): Promise<LogCommit[]> {
    const sealer = await this.#sealerOf(ref);
    return this.#inTenant(ref, (c) => this.#select(c, ref, fromSeq, toSeq ?? null, sealer), true);
  }

  /** The metadata of the commits in a range, with no payload read (HIS-040: a removed payload does not stop a list). */
  async readMeta(ref: DocRef, fromSeq: number, toSeq: number): Promise<CommitMetaRow[]> {
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<Omit<CommitRow, 'payload' | 'commit_id' | 'agent'>>(
          SELECT_COMMIT_META,
          [ref.doc, fromSeq, toSeq],
        );
        return r.rows.map((row) => ({
          seq: int(row.seq),
          kind: row.kind,
          user: row.user_id,
          session: row.session_id ?? SERVER_SESSION,
          time: millis(row.server_ts)!,
          origin: row.origin,
          scopes: row.scopes,
        }));
      },
      true,
    );
  }

  /**
   * The records `fromSeq` to `toSeq` as the log bundle holds them, read from the stored rows (the
   * same columns `verify` reads), with the head and no payloads (HIS-037).
   */
  async chainRange(ref: DocRef, fromSeq: number, toSeq: number): Promise<LogBundle> {
    return this.#inTenant(
      ref,
      async (c) => {
        const rows = await c.query<{
          seq: string;
          kind: string;
          commit_id: string;
          user_id: string;
          session_id: string | null;
          agent: string | null;
          server_ts: Date;
          origin: string;
          base: string | null;
          rebased: boolean | null;
          access_rev: string;
          token_jti: string | null;
          cdm_version: number;
          engine: string;
          size: number;
          payload_hash: Buffer;
          prev_hash: Buffer | null;
          hash: Buffer;
          scopes: string[];
        }>(
          `SELECT c.*, coalesce(s.scopes, '{}') AS scopes
             FROM doc_commits c
             LEFT JOIN LATERAL (
               SELECT array_agg(cs.scope ORDER BY cs.scope COLLATE "C") AS scopes
                 FROM commit_scopes cs WHERE cs.doc_id = c.doc_id AND cs.seq = c.seq
             ) s ON true
            WHERE c.doc_id = $1 AND c.seq BETWEEN $2 AND $3 ORDER BY c.seq`,
          [ref.doc, fromSeq, toSeq],
        );
        const head = await c.query<{ head_seq: string; chain_head: Buffer | null }>(
          'SELECT head_seq, chain_head FROM doc_heads WHERE doc_id = $1',
          [ref.doc],
        );
        const hr = head.rows[0];
        if (!hr) throw new DocumentNotFoundError(`no document ${ref.doc}`);
        return {
          format: 'docedit-log-bundle/1',
          doc: ref.doc,
          head: {
            seq: int(hr.head_seq),
            chainHead: hr.chain_head ? hr.chain_head.toString('hex') : null,
          },
          commits: rows.rows.map((r) => ({
            meta: {
              doc: ref.doc,
              seq: int(r.seq),
              kind: r.kind,
              id: r.commit_id,
              user: r.user_id,
              session: r.session_id,
              agent: r.agent,
              time: r.server_ts.toISOString(),
              origin: r.origin,
              scopes: r.scopes,
              base: r.base === null ? null : int(r.base),
              rebased: r.rebased,
              revision: int(r.access_rev),
              jti: r.token_jti,
              cdm: r.cdm_version,
              engine: r.engine,
              size: r.size,
            },
            payloadHash: r.payload_hash.toString('hex'),
            prevHash: r.prev_hash ? r.prev_hash.toString('hex') : null,
            hash: r.hash.toString('hex'),
          })),
        };
      },
      true,
    );
  }
  /** The `seq` of the commit that introduced a suggestion, from the index; not a scan of the log (HIS-042). */
  async introducedBy(ref: DocRef, suggestionId: string): Promise<number | undefined> {
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<{ seq: string }>(
          `SELECT seq FROM suggestion_introductions
            WHERE tenant_id = $1 AND doc_id = $2 AND suggestion_id = $3`,
          [ref.tenant, ref.doc, suggestionId],
        );
        return r.rows[0] === undefined ? undefined : int(r.rows[0].seq);
      },
      true,
    );
  }

  /** Attaches assets outside a commit; a row that exists is kept (HIS-022). */
  async attachAssets(
    ref: DocRef,
    attachments: ReadonlyArray<{ asset: string; seq: number }>,
  ): Promise<void> {
    if (attachments.length === 0) return;
    await this.#inTenant(ref, async (c) => {
      await c.query(INSERT_DOC_ASSETS, [
        ref.tenant,
        ref.doc,
        attachments.map((a) => a.asset),
        attachments.map((a) => a.seq),
      ]);
    });
  }

  /** The assets attached to the document and the seq that first referenced each (BE-044). */
  async attachedAssets(ref: DocRef): Promise<ReadonlyMap<string, number>> {
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<{ asset_id: string; first_seq: string }>(
          'SELECT asset_id, first_seq FROM doc_assets WHERE tenant_id = $1 AND doc_id = $2',
          [ref.tenant, ref.doc],
        );
        return new Map(r.rows.map((x) => [x.asset_id, int(x.first_seq)] as const));
      },
      true,
    );
  }

  /** The stored commit with this identifier (04 §5 step 2; BE-039), by the (doc_id, commit_id) key. */
  async byId(ref: DocRef, id: string): Promise<LogCommit | null> {
    return this.#storedOf(ref, [id]);
  }

  /**
   * The commits whose scopes include `scope`, newest first (HIS-016: `field:<id>` answers "who
   * filled this field"; 06 §4.1). An index lookup on `commit_scopes`, not a replay of the log: no
   * payload is read. `after` is the caller's `minVisibleSeq` (default 0) and `upTo` the head.
   */
  async scopeHistory(
    ref: DocRef,
    scope: string,
    gate: { after?: number; upTo?: number } = {},
  ): Promise<ScopeCommit[]> {
    const after = gate.after ?? 0;
    const upTo = gate.upTo ?? null;
    if (!Number.isSafeInteger(after) || (upTo !== null && !Number.isSafeInteger(upTo)))
      throw new TypeError('the gate must be sequence numbers');
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<{
          seq: string;
          kind: LogCommit['kind'];
          user_id: string;
          session_id: string | null;
          agent: string | null;
          server_ts: Date;
          origin: string;
          scopes: string[];
        }>(SELECT_SCOPE_HISTORY, [ref.doc, scope, after, upTo]);
        return r.rows.map((row) => {
          const e: ScopeCommit = {
            seq: int(row.seq),
            kind: row.kind,
            user: row.user_id,
            session: row.session_id ?? SERVER_SESSION,
            time: millis(row.server_ts)!,
            origin: row.origin,
            scopes: row.scopes,
          };
          if (row.agent !== null) e.agent = row.agent;
          return e;
        });
      },
      true,
    );
  }

  async head(ref: DocRef): Promise<LogHead> {
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<{
          head_seq: string;
          epoch: string;
          owner: string | null;
          incarnation: string;
        }>('SELECT head_seq, epoch, owner, incarnation FROM doc_heads WHERE doc_id = $1', [
          ref.doc,
        ]);
        const row = r.rows[0];
        if (!row) throw new DocumentNotFoundError(`no document ${ref.doc}`);
        return {
          seq: int(row.head_seq),
          epoch: int(row.epoch),
          owner: row.owner,
          incarnation: row.incarnation,
        };
      },
      true,
    );
  }

  async claim(ref: DocRef, node: string): Promise<number> {
    return this.#inTenant(ref, async (c) => {
      const r = await c.query<{ epoch: string }>(
        'UPDATE doc_heads SET owner = $2, epoch = epoch + 1 WHERE doc_id = $1 RETURNING epoch',
        [ref.doc, node],
      );
      const row = r.rows[0];
      if (!row) throw new DocumentNotFoundError(`no document ${ref.doc}`);
      return int(row.epoch);
    });
  }

  async release(ref: DocRef, node: string, epoch: number): Promise<boolean> {
    return this.#inTenant(ref, async (c) => {
      const r = await c.query(
        'UPDATE doc_heads SET owner = NULL WHERE doc_id = $1 AND owner = $2 AND epoch = $3',
        [ref.doc, node, epoch],
      );
      return r.rowCount === 1;
    });
  }

  // --- Added by packet A, phase 1b ----------------------------------------------------------------

  /** `claim`, unless another node owns the document and its lease is still valid (BE-018). */
  async claimIfFree(ref: DocRef, node: string): Promise<number | null> {
    return this.#inTenant(ref, async (c) => {
      const r = await c.query<{ epoch: string }>(CLAIM_IF_FREE, [ref.doc, node]);
      const row = r.rows[0];
      if (row) return int(row.epoch);
      const exists = await c.query('SELECT 1 FROM doc_heads WHERE doc_id = $1', [ref.doc]);
      if (exists.rowCount !== 1) throw new DocumentNotFoundError(`no document ${ref.doc}`);
      return null;
    });
  }

  /** The content a stored snapshot commit brought (BE-037), or null when `seq` is not one. */
  async snapshotContent(ref: DocRef, seq: number): Promise<JsonEnvelope | null> {
    const sealer = await this.#sealerOf(ref);
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<{ content: Buffer }>(
          'SELECT content FROM doc_snapshots WHERE doc_id = $1 AND seq = $2',
          [ref.doc, seq],
        );
        const row = r.rows[0];
        if (!row) return null;
        const stored = new Uint8Array(row.content);
        if (!isSealed(stored)) return decodeContent<JsonEnvelope>(row.content);
        if (!sealer) throw new DocumentKeyDestroyedError(ref.doc);
        return decodeContent<JsonEnvelope>(
          Buffer.from(await sealer.open(`snapshot/${ref.doc}/${seq}`, stored)),
        );
      },
      true,
    );
  }

  /** The head row with the chain head, for operations and the fault hooks (BE-079). */
  async state(ref: DocRef): Promise<HeadState> {
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<{
          head_seq: string;
          epoch: string;
          owner: string | null;
          incarnation: string;
          chain_head: Buffer | null;
        }>(
          'SELECT head_seq, epoch, owner, incarnation, chain_head FROM doc_heads WHERE doc_id = $1',
          [ref.doc],
        );
        const row = r.rows[0];
        if (!row) throw new DocumentNotFoundError(`no document ${ref.doc}`);
        return {
          seq: int(row.head_seq),
          epoch: int(row.epoch),
          owner: row.owner,
          incarnation: row.incarnation,
          chainHead: row.chain_head ? row.chain_head.toString('hex') : null,
        };
      },
      true,
    );
  }

  /**
   * The hash of the stored commit at `seq`, lower-case hex, or null when there is none. It is the
   * chain head of the state at that `seq` (HIS-034 criterion 3): an export at an older `seq` names
   * its chain head with it, and at the head it is the head's chain head.
   */
  async chainHeadAt(ref: DocRef, seq: number): Promise<string | null> {
    return this.#inTenant(
      ref,
      async (c) => {
        const r = await c.query<{ hash: Buffer }>(
          'SELECT hash FROM doc_commits WHERE doc_id = $1 AND seq = $2',
          [ref.doc, seq],
        );
        const row = r.rows[0];
        return row ? row.hash.toString('hex') : null;
      },
      true,
    );
  }

  /**
   * Gives the document's log a new incarnation (04 §1; 06 §8; BE-078): every `seq` a client holds
   * from the old one is then reloaded. Run by the operator procedure after a database recovery.
   */
  async newIncarnation(ref: DocRef, incarnation: string): Promise<{ before: string }> {
    assertUuid(incarnation, 'incarnation');
    return this.#inTenant(ref, async (c) => {
      const r = await c.query<{ before: string }>(
        `UPDATE doc_heads h SET incarnation = $2
           FROM (SELECT incarnation AS before FROM doc_heads WHERE doc_id = $1 FOR UPDATE) b
          WHERE h.doc_id = $1
          RETURNING b.before`,
        [ref.doc, incarnation],
      );
      const row = r.rows[0];
      if (!row) throw new DocumentNotFoundError(`no document ${ref.doc}`);
      return { before: row.before };
    });
  }

  /**
   * Recomputes the hash chain from the stored metadata and payload hashes and compares it with
   * the stored hashes and the chain head (HIS-002; the tool of BE-081 and HIS-033 does the same).
   */
  async verify(ref: DocRef, opts: { payloads?: boolean } = {}): Promise<ChainVerdict> {
    // Checking the payloads needs the document's key if it has one (HIS-041). The chain itself does
    // not: it covers the stored hashes, so it verifies after the key is destroyed.
    let sealer: DocumentSealer | null = null;
    if (opts.payloads) {
      try {
        sealer = await this.#sealerOf(ref);
      } catch (e) {
        if (e instanceof DocumentKeyDestroyedError)
          return {
            ok: false,
            seq: 0,
            reason: 'the key of the document was destroyed, so its payloads cannot be checked',
          };
        throw e;
      }
    }
    const open = async (stored: Buffer, aad: string): Promise<Buffer> => {
      const bytes = new Uint8Array(stored);
      if (!isSealed(bytes)) return stored;
      if (!sealer) throw new DocumentKeyDestroyedError(ref.doc);
      return Buffer.from(await sealer.open(aad, bytes));
    };
    return this.#inTenant(
      ref,
      async (c) => {
        // With `payloads`, every stored payload is also hashed again and compared with the hash
        // the chain covers (BE-081 criterion 2); a thinned payload is skipped.
        if (opts.payloads) {
          const p = await c.query<{ seq: string; payload: Buffer; payload_hash: Buffer }>(
            `SELECT c.seq, p.payload, c.payload_hash
               FROM doc_commits c JOIN doc_commit_payloads p ON p.doc_id = c.doc_id AND p.seq = c.seq
              WHERE c.doc_id = $1 ORDER BY c.seq`,
            [ref.doc],
          );
          for (const r of p.rows) {
            const text = zstdDecompressSync(await open(r.payload, `${ref.doc}/${int(r.seq)}`));
            if (!createHash('sha256').update(text).digest().equals(r.payload_hash))
              return { ok: false, seq: int(r.seq), reason: 'the payload does not match its hash' };
          }
          const s = await c.query<{ seq: string; content: Buffer; content_hash: Buffer }>(
            'SELECT seq, content, content_hash FROM doc_snapshots WHERE doc_id = $1 ORDER BY seq',
            [ref.doc],
          );
          for (const r of s.rows) {
            const text = zstdDecompressSync(
              await open(r.content, `snapshot/${ref.doc}/${int(r.seq)}`),
            );
            if (!createHash('sha256').update(text).digest().equals(r.content_hash))
              return {
                ok: false,
                seq: int(r.seq),
                reason: 'the snapshot content does not match its hash',
              };
          }
        }
        const rows = await c.query<{
          seq: string;
          kind: LogCommit['kind'];
          commit_id: string;
          user_id: string;
          session_id: string | null;
          agent: string | null;
          server_ts: Date;
          origin: string;
          base: string | null;
          rebased: boolean | null;
          access_rev: string;
          token_jti: string | null;
          cdm_version: number;
          engine: string;
          size: number;
          payload_hash: Buffer;
          prev_hash: Buffer | null;
          hash: Buffer;
          scopes: string[];
        }>(
          `SELECT c.*, coalesce(s.scopes, '{}') AS scopes
             FROM doc_commits c
             LEFT JOIN LATERAL (
               SELECT array_agg(cs.scope ORDER BY cs.scope COLLATE "C") AS scopes
                 FROM commit_scopes cs WHERE cs.doc_id = c.doc_id AND cs.seq = c.seq
             ) s ON true
            WHERE c.doc_id = $1 ORDER BY c.seq`,
          [ref.doc],
        );
        const head = await c.query<{ head_seq: string; chain_head: Buffer | null }>(
          'SELECT head_seq, chain_head FROM doc_heads WHERE doc_id = $1',
          [ref.doc],
        );
        let prev: Buffer | null = null;
        let expectedSeq = 1;
        for (const r of rows.rows) {
          const seq = int(r.seq);
          if (seq !== expectedSeq) return { ok: false, seq, reason: `gap before seq ${seq}` };
          const meta: CommitMetadata = {
            doc: ref.doc,
            seq,
            kind: r.kind,
            id: r.commit_id,
            user: r.user_id,
            session: r.session_id,
            agent: r.agent,
            time: iso(millis(r.server_ts)!),
            origin: r.origin,
            scopes: r.scopes,
            base: r.base === null ? null : int(r.base),
            rebased: r.rebased,
            revision: int(r.access_rev),
            jti: r.token_jti,
            cdm: r.cdm_version,
            engine: r.engine,
            size: r.size,
          };
          const storedPrev = r.prev_hash;
          if ((prev === null) !== (storedPrev === null) || (prev && !prev.equals(storedPrev!)))
            return { ok: false, seq, reason: 'prev_hash does not match the preceding hash' };
          const h = chainHash(prev, metadataBytes(meta), r.payload_hash);
          if (!h.equals(r.hash))
            return { ok: false, seq, reason: 'hash does not match the record' };
          prev = h;
          expectedSeq++;
        }
        const hr = head.rows[0];
        if (!hr) throw new DocumentNotFoundError(`no document ${ref.doc}`);
        if (int(hr.head_seq) !== expectedSeq - 1)
          return { ok: false, seq: expectedSeq, reason: 'the head does not match the log' };
        if ((prev === null) !== (hr.chain_head === null) || (prev && !prev.equals(hr.chain_head!)))
          return {
            ok: false,
            seq: expectedSeq - 1,
            reason: 'the chain head does not match the log',
          };
        return { ok: true, head: expectedSeq - 1 };
      },
      true,
    );
  }

  async #select(
    client: Queryable,
    ref: DocRef,
    fromSeq: number,
    toSeq: number | null,
    sealer: DocumentSealer | null,
  ): Promise<LogCommit[]> {
    const r = await client.query<CommitRow>(SELECT_COMMITS, [ref.doc, fromSeq, toSeq]);
    return (await this.#opened(ref, r.rows, sealer)).map(toStoredCommit);
  }

  async #inTenant<T>(ref: DocRef, fn: (c: PoolClient) => Promise<T>, readOnly = false): Promise<T> {
    assertUuid(ref.doc, 'document');
    const client = await this.#pool.connect();
    let broken: Error | undefined;
    try {
      await beginForTenant(client, ref.tenant, { readOnly });
      const result = await fn(client);
      await client.query('COMMIT');
      return result;
    } catch (e) {
      await client.query('ROLLBACK').catch((re: unknown) => {
        broken = asError(re);
      });
      throw e;
    } finally {
      client.release(broken);
    }
  }
}
