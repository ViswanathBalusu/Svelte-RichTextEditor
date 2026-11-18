/**
 * The authority service (05 §10): the authority package behind a network interface, for backends
 * that are not written in JavaScript. This module is the service without its transport: `open`,
 * `materialise` and (PRO-107) `migrate` and `evaluateRules`, as plain functions on plain data.
 * `http.ts` is the binding that ADR 0314 recommends.
 *
 * The service holds no state that matters (05 §10). A loaded document is a cache entry named by its
 * `stateId`, the hash-chain head of the log it was built from (08 §2; ADR 0020). An entry is
 * immutable: a log that is rewound and extended gives another head, so another entry, and a call
 * that names the old head never reads the new content. An evicted or restarted service answers
 * `unknown_state`, and the caller calls `open` again with the same inputs and gets the same content.
 *
 * Rules the service follows (ADR 0389, proposed):
 * - `open` verifies the whole chain it is given, from the checkpoint's chain head to the head the
 *   caller names, and refuses a log that does not hash to `stateId` (`state_mismatch`).
 * - Every payload must be present: a thinned payload cannot be replayed (`payload_missing`).
 * - Migrations are run only when the operator enables them, and never by `open` (03 §11.3).
 */
import {
  type Checkpoint,
  type ContentSource,
  type DocumentState,
  type LogCommit,
  type PermissionState,
  type RegionState,
  Room,
  type SnapshotCommit,
  type SnapshotReason,
  type StepJson,
  type StoredCommit,
  contentAt,
  defaultReplayers,
} from '@docedit/authority';
import {
  AttributionMap,
  type AttributionJson,
  type ChainMetadata,
  chainHash,
  coversExactly,
  payloadDigest,
} from '@docedit/history';
import {
  type JsonEnvelope,
  type JsonNode,
  type JsonValue,
  type Migration,
  canonicalEnvelope,
  canonicalText,
  documentHash,
  migrate,
} from '@docedit/model';
import { CDM1, type CdmDefinition } from '@docedit/model/definition';
import { cdmSchema } from '@docedit/model/prosemirror';
import { type Evaluation, type ValueMap, evaluateDocument } from '@docedit/rules';
import type { AuthorityServiceCall } from '@docedit/protocol/client';
import { IMPLEMENTED_CALLS } from './capabilities.ts';
import { attribution, diff, restoreSteps } from './history-calls.ts';
import { type MapRangesAnswer, mapRangesCall } from './range-calls.ts';
import type { AttributionAnswer, DiffAnswer, RestoreStepsAnswer } from './history-calls.ts';
import { readDocument } from '@docedit/model/validate';
import type { Node } from 'prosemirror-model';

const HEX64 = /^[0-9a-f]{64}$/;

export {
  type Answer,
  type HeldState,
  type ServiceError,
  type ServiceErrorCode,
  type WireAuthor,
  type WirePermissions,
  connectionOf,
  fail,
  unpackWirePerms,
} from './common.ts';
import {
  type Answer,
  type HeldState,
  type WireAuthor,
  type WirePermissions,
  connectionOf,
  fail,
  unpackWirePerms,
} from './common.ts';

/**
 * The reference to the checkpoint a log starts from. `seq` is the sequence number it holds (0 for
 * the document as created), `chainHead` the hash of the commit at `seq` (null at 0) and
 * `contentHash` the `documentHash` of its canonical form. `content` carries the document itself;
 * without it the service asks its `CheckpointResolver`.
 */
export interface CheckpointRef {
  seq: number;
  chainHead: string | null;
  contentHash: string;
  content?: JsonEnvelope;
  /**
   * Who wrote what up to `seq`, as `AttributionMap.toJSON()` (08 §7). Without it the content of the
   * checkpoint is attributed to `createdBy` (to nobody when that is absent) at `seq`.
   */
  attribution?: AttributionJson;
  createdBy?: string;
}

/** The payload of one commit as the hash chain holds it (`{ steps, retired, claimed }`, 08 §2). */
export interface WirePayload {
  steps: StepJson[];
  retired?: string[];
  claimed?: string[];
  /** The document's `requires` after this commit, when the commit added a feature (CDM-047). */
  requires?: string[];
  /** Present on a snapshot commit: the checkpoint that holds the new content (08 §3). */
  snapshot?: { checkpoint: string; reason: SnapshotReason };
}

/** One commit of the log, with the hash-chain fields of `@docedit/history`. */
export interface WireCommit {
  meta: ChainMetadata;
  payloadHash: string;
  prevHash: string | null;
  hash: string;
  payload: WirePayload;
}

export interface OpenRequest {
  doc: string;
  checkpointRef: CheckpointRef;
  commits: WireCommit[];
  stateId: string;
}

/** Where checkpoints that are named but not carried come from: the caller's storage. */
export interface CheckpointResolver {
  /** The content of the checkpoint a snapshot commit names, or undefined when there is none. */
  snapshot(doc: string, checkpoint: string): Promise<JsonEnvelope | undefined>;
  /** The content of the checkpoint a `CheckpointRef` names without carrying it. */
  ref(doc: string, ref: CheckpointRef): Promise<JsonEnvelope | undefined>;
}

/**
 * The caller's storage, seen from the service: the inputs of `open` for a state it names, or
 * undefined when the caller has no such state (any more). It throws when storage cannot be reached.
 */
export interface StateLoader {
  load(stateId: string): Promise<OpenRequest | undefined>;
}

export interface ServiceOptions {
  /** How many loaded documents the service keeps; the least recently used one goes first. */
  capacity?: number;
  resolver?: CheckpointResolver;
  /**
   * Where a state the service does not hold is rebuilt from (05 §10: the service "can rebuild any
   * of them from storage"). Without it a call for such a state answers `unknown_state`.
   */
  loader?: StateLoader;
  /**
   * Whether `migrate` runs. The operator turns it on (03 §11.3: a migration is gated by an operator
   * and never triggered by opening a document). Off by default.
   */
  allowMigrations?: boolean;
  /** The migrations, one from each version to the next (CDM-049). None exist for CDM 1 yet. */
  migrations?: readonly Migration[];
  /** The definitions of the versions this service can read and write; CDM 1 by default. */
  definitions?: readonly CdmDefinition[];
}

/** The request of `migrate`: the document to migrate and the version to migrate it to. */
export interface MigrateRequest {
  content: JsonEnvelope;
  target: number;
}

export interface MigrateAnswer {
  /** The canonical content under the target version's definition. */
  content: JsonEnvelope;
  text: string;
  contentHash: string;
  cdm: number;
  /** The names of the migrations that ran, in order. */
  steps: string[];
}

/** The request of `evaluateRules` (05 §10; 12 §5): who is filling, and optionally what they enter. */
export interface EvaluateRulesRequest {
  roles?: string[];
  /** Values that replace the stored ones, by field key. */
  values?: Record<string, JsonValue>;
  /** Only these fields are returned. */
  keys?: string[];
  now?: { instant: string; timeZone: string } | null;
  budget?: number;
}

export type EvaluateRulesAnswer = Extract<Evaluation, { ok: true }>;

/** What the caller relied on when it decided to apply the commit (04 §5, closing paragraph). */
export interface WirePreconditions {
  revision?: number;
  head?: number;
  documentState?: DocumentState;
  workflowActive?: boolean;
  regionStates?: Record<string, RegionState>;
}

export interface ApplyCommitRequest {
  commit: {
    id: string;
    base: number;
    steps: unknown;
    origin?: string;
    author: WireAuthor;
    /** The server time of the commit, Unix milliseconds; the service's clock when absent. */
    time?: number;
  };
  permissions: WirePermissions;
  preconditions?: WirePreconditions;
}

/** A rejection, in the shape of `sync.reject` (05 §5.3); the answer, not an error. */
export interface WireRejection {
  id: string;
  code: string;
  action: string;
  head: number;
  reason?: string;
  scopes?: string[];
  rule?: string;
}

export type ApplyCommitAnswer =
  | {
      accepted: true;
      /** The state after the commit (and the control commit that came with it, if any). */
      stateId: string;
      seq: number;
      /** The steps as applied, after rebasing (08 §2). */
      steps: StepJson[];
      /** The scopes the commit changed (07 §5.1). */
      scopes: string[];
      rebased: boolean;
      /** Every commit to store, in order, as `open` takes them: a control commit may come first. */
      commits: WireCommit[];
    }
  | { accepted: false; rejected: WireRejection };

export interface OpenAnswer {
  stateId: string;
  /** The sequence number the state reached. */
  seq: number;
  doc: string;
}

export interface MaterialiseAnswer {
  stateId: string;
  seq: number;
  /** The canonical CDM content (03 §2). */
  content: JsonEnvelope;
  /** The RFC 8785 text of `content`: the bytes a caller compares and hashes. */
  text: string;
  contentHash: string;
}

const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

const sortedUnion = (...lists: ReadonlyArray<readonly string[]>): string[] =>
  [...new Set(lists.flat())].sort();

export const DEFAULT_CAPACITY = 64;

export class AuthorityService {
  readonly #held = new Map<string, HeldState>();
  readonly #capacity: number;
  readonly #resolver: CheckpointResolver | undefined;
  readonly #loader: StateLoader | undefined;
  readonly #schema = cdmSchema();
  readonly #allowMigrations: boolean;
  readonly #migrations: readonly Migration[];
  readonly #definitions: ReadonlyMap<number, CdmDefinition>;

  constructor(options: ServiceOptions = {}) {
    this.#capacity = options.capacity ?? DEFAULT_CAPACITY;
    if (!(this.#capacity >= 1)) throw new RangeError('the service must hold at least one state');
    this.#resolver = options.resolver;
    this.#loader = options.loader;
    this.#allowMigrations = options.allowMigrations ?? false;
    this.#migrations = options.migrations ?? [];
    this.#definitions = new Map((options.definitions ?? [CDM1]).map((d) => [d.cdm, d]));
  }

  /** The calls this service answers now: `migrate` only when the operator enabled it. */
  get calls(): readonly AuthorityServiceCall[] {
    return IMPLEMENTED_CALLS.filter((c) => c !== 'migrate' || this.#allowMigrations);
  }

  /** The number of documents in memory now. */
  get size(): number {
    return this.#held.size;
  }

  /** Whether a state is in memory now (it may be evicted at any time). */
  holds(stateId: string): boolean {
    return this.#held.has(stateId);
  }

  /** Drops everything, as a restart does. */
  clear(): void {
    this.#held.clear();
  }

  /**
   * `open(doc, checkpointRef, commits, stateId)` (05 §10): loads a document from a checkpoint and
   * the commits after it, and names the state by the chain head.
   */
  async open(request: unknown): Promise<Answer<OpenAnswer>> {
    const req = parseOpen(request);
    if (!req.ok) return req;
    const { doc, checkpointRef: ref, commits, stateId } = req.value;

    const loaded = await this.#checkpoint(doc, ref);
    if (!loaded.ok) return loaded;
    const { envelope, node } = loaded;
    let baseAttribution: AttributionMap;
    try {
      baseAttribution = ref.attribution
        ? AttributionMap.fromJSON(ref.attribution)
        : AttributionMap.create(node.content.size, { user: ref.createdBy ?? '', seq: ref.seq });
    } catch (e) {
      return fail('invalid_request', `checkpointRef.attribution is not valid: ${String(e)}`);
    }
    if (!coversExactly(baseAttribution, node))
      return fail('invalid_request', 'checkpointRef.attribution does not cover the checkpoint');

    // The chain: every record links to the one before and hashes to its own `hash`.
    let prev = ref.chainHead;
    let expected = ref.seq + 1;
    for (const c of commits) {
      const seq = c.meta.seq;
      if (seq !== expected)
        return fail('chain_broken', `expected commit ${expected}, found ${seq}`, { seq: expected });
      if (c.meta.doc !== doc)
        return fail('chain_broken', `commit ${seq} belongs to another document`, { seq });
      if (c.prevHash !== prev)
        return fail('chain_broken', `commit ${seq} does not follow the commit before it`, { seq });
      const digest = await payloadDigest(c.payload);
      if (digest.hash !== c.payloadHash || digest.size !== c.meta.size)
        return fail('chain_broken', `the payload of commit ${seq} does not match its hash`, {
          seq,
        });
      if ((await chainHash(prev, c.meta, c.payloadHash)) !== c.hash)
        return fail('chain_broken', `commit ${seq} does not hash to its own hash`, { seq });
      prev = c.hash;
      expected++;
    }
    const head = expected - 1;
    // A document with no commit after its checkpoint is named by the checkpoint's own identity.
    const computed = prev ?? ref.contentHash;
    if (computed !== stateId)
      return fail('state_mismatch', 'the log given does not end at the state named', {
        expected: stateId,
        computed,
      });

    const held = this.#held.get(stateId);
    if (held) {
      this.#touch(held);
      return { ok: true, stateId, seq: held.head, doc: held.doc };
    }

    // Build the log the authority package replays.
    const log: LogCommit[] = [];
    const snapshots = new Map<string, Node>();
    const requires = new Map<number, string[]>([[ref.seq, sortedUnion(envelope.requires)]]);
    let currentRequires = sortedUnion(envelope.requires);
    for (const c of commits) {
      const made = await this.#logCommit(doc, c, snapshots);
      if (!made.ok) return made;
      log.push(made.value.commit);
      currentRequires = made.value.requires
        ? sortedUnion(made.value.requires)
        : sortedUnion(currentRequires, c.payload.requires ?? []);
      requires.set(c.meta.seq, currentRequires);
    }
    const source = this.#source(stateId, head, ref.seq, node, log, snapshots);
    const built = contentAt(head, source);
    if (!built.ok) return fail('replay_failed', built.reason, { code: built.code });
    const state: HeldState = {
      stateId,
      doc,
      head,
      first: ref.seq,
      source,
      headDoc: built.doc,
      cdm: envelope.cdm,
      requires,
      log,
      snapshots,
      checkpointDoc: node,
      chainHead: prev,
      baseAttribution,
    };
    this.#hold(state);
    return { ok: true, stateId, seq: head, doc };
  }

  /** What `contentAt` replays: the checkpoint, the log after it and the snapshots the log names. */
  #source(
    stateId: string,
    head: number,
    first: number,
    checkpointDoc: Node,
    log: readonly LogCommit[],
    snapshots: ReadonlyMap<string, Node>,
  ): ContentSource {
    const checkpoints: Checkpoint[] = [{ seq: first, doc: checkpointDoc }];
    return {
      incarnation: stateId,
      head,
      checkpoints,
      commits: (afterSeq, toSeq) => log.filter((c) => c.seq > afterSeq && c.seq <= toSeq),
      resolve: (c: SnapshotCommit) => {
        const found = snapshots.get(c.snapshot.checkpoint);
        if (!found) throw new Error(`checkpoint ${c.snapshot.checkpoint} was not resolved`);
        return found;
      },
      replayers: defaultReplayers(this.#schema),
    };
  }

  /**
   * `materialise(stateId or seq)` (05 §10): the canonical content of a state, at its head or at a
   * sequence number inside it.
   */
  async materialise(stateId: unknown, seq?: unknown): Promise<Answer<MaterialiseAnswer>> {
    if (typeof stateId !== 'string' || !HEX64.test(stateId))
      return fail('invalid_request', 'stateId must be 64 lower-case hexadecimal digits');
    if (seq !== undefined && (typeof seq !== 'number' || !Number.isSafeInteger(seq)))
      return fail('invalid_request', 'seq must be an integer');
    const found = await this.#state(stateId);
    if (!found.ok) return found;
    const state = found.state;
    const at = seq ?? state.head;
    if (at > state.head)
      return fail('not_found', `the state ends at ${state.head}, not ${at}`, { seq: at });
    if (at < state.first)
      return fail(
        'not_found',
        `the state was opened from a checkpoint at ${state.first}; ${at} is before it`,
        { seq: at },
      );
    let node: Node;
    if (at === state.head) node = state.headDoc;
    else {
      const built = contentAt(at, state.source);
      if (!built.ok) return fail('replay_failed', built.reason, { code: built.code });
      node = built.doc;
    }
    const envelope = canonicalEnvelope({
      cdm: state.cdm,
      requires: state.requires.get(at) ?? [],
      doc: node.toJSON() as JsonNode,
    });
    return {
      ok: true,
      stateId,
      seq: at,
      content: envelope,
      text: canonicalText(envelope),
      contentHash: await documentHash(envelope),
    };
  }

  /**
   * `applyCommit(stateId, commit, permissions, preconditions)` (05 §10; 04 §5, §6; 07 §5): the
   * room's own checks on a commit, run on a state this service holds. The authority package decides,
   * as in a room: the base and the rebase, the allow-list, the invariants, the permission outcome,
   * the suggestion and field rules. The service stores nothing: the answer holds the commits to
   * store and the new `stateId`, and the new state is held so that the next call can name it. A
   * commit that is not acceptable is a rejection in the answer, never an error (ADR 0314).
   */
  async applyCommit(stateId: unknown, request: unknown): Promise<Answer<ApplyCommitAnswer>> {
    if (typeof stateId !== 'string' || !HEX64.test(stateId))
      return fail('invalid_request', 'stateId must be 64 lower-case hexadecimal digits');
    const parsed = parseApply(request);
    if (!parsed.ok) return parsed;
    const { commit, permissions, preconditions } = parsed.value;
    const found = await this.#state(stateId);
    if (!found.ok) return found;
    const state = found.state;

    const perms = unpackWirePerms(permissions);
    // The state the caller decided under must still be the state now (04 §5, closing paragraph).
    const failed = preconditionFailure(preconditions, perms, state.head);
    if (failed !== null)
      return {
        ok: true,
        accepted: false,
        rejected: {
          id: commit.id,
          code: 'conflict',
          action: 'drop',
          head: state.head,
          reason: failed,
        },
      };

    const lastRevision = state.log.length ? state.log[state.log.length - 1]!.revision : undefined;
    const at = Number.isSafeInteger(commit.time) ? (commit.time as number) : Date.now();
    const a = commit.author;
    const conn = connectionOf(a);
    const room = new Room({
      schema: this.#schema,
      initial: state.checkpointDoc,
      requires: state.requires.get(state.first) ?? [],
      log: [...state.log],
      perms,
      initialRevision: lastRevision ?? (state.first === 0 ? 0 : perms.revision),
      initialSeq: state.first,
      epoch: 1,
      incarnation: stateId,
      now: () => at,
      snapshotContent: (c) => {
        const node = state.snapshots.get(c.snapshot.checkpoint);
        if (!node) throw new Error(`checkpoint ${c.snapshot.checkpoint} was not resolved`);
        return node;
      },
    });
    const channel = 'apply';
    const opened = room.open(channel, conn, {
      seq: state.head,
      incarnation: stateId,
      inflight: null,
    });
    if (opened.refused)
      return fail('unsupported_feature', 'the document needs features this service lacks', {
        missing: opened.refused.missing,
      });
    const fx = room.submit(channel, {
      id: commit.id,
      base: commit.base,
      steps: commit.steps,
      ...(commit.origin !== undefined ? { origin: commit.origin } : {}),
    });
    for (const o of fx.send) {
      if (o.msg.t !== 'sync.reject') continue;
      const m = o.msg;
      return {
        ok: true,
        accepted: false,
        rejected: {
          id: m.id,
          code: m.code,
          action: m.action,
          head: m.head,
          ...(m.reason !== undefined ? { reason: m.reason } : {}),
          ...(m.scopes ? { scopes: m.scopes } : {}),
          ...(m.rule !== undefined ? { rule: m.rule } : {}),
        },
      };
    }
    // The room asks storage to write; the service answers yes, and the caller stores the same
    // commits for real before it relies on the new state.
    const stored: StoredCommit[] = [];
    let write = fx.write;
    for (let guard = 0; write && guard < 8; guard++) {
      stored.push(...write.commits);
      write = room.writeCompleted({ status: 'ok' }).write;
    }
    const mine = stored.find((c) => c.id === commit.id);
    if (!mine) return fail('replay_failed', 'the room accepted the commit but stored nothing');

    // The commits as the hash chain holds them, linked to the head of this state.
    const wire: WireCommit[] = [];
    const requires = new Map(state.requires);
    let prev = state.chainHead;
    let current = state.requires.get(state.head) ?? [];
    for (const c of stored) {
      const w = await this.#wireCommit(state.doc, c, prev, state.cdm);
      wire.push(w);
      prev = w.hash;
      current = c.requires ? sortedUnion(c.requires) : current;
      requires.set(c.seq, current);
    }
    const head = stored[stored.length - 1]!.seq;
    const newId = prev ?? stateId;
    const log = [...state.log, ...stored];
    this.#hold({
      ...state,
      stateId: newId,
      head,
      headDoc: room.document,
      source: this.#source(newId, head, state.first, state.checkpointDoc, log, state.snapshots),
      requires,
      log,
      chainHead: prev,
    });
    return {
      ok: true,
      accepted: true,
      stateId: newId,
      seq: mine.seq,
      steps: mine.steps,
      scopes: mine.scopes,
      rebased: mine.rebased ?? false,
      commits: wire,
    };
  }

  /** A stored commit as the hash chain holds it: the inverse of `#logCommit`. */
  async #wireCommit(
    doc: string,
    c: StoredCommit,
    prev: string | null,
    cdm: number,
  ): Promise<WireCommit> {
    const payload: WirePayload = {
      steps: c.steps,
      retired: c.retired,
      claimed: c.claimed,
      ...(c.requires ? { requires: c.requires } : {}),
    };
    const digest = await payloadDigest(payload);
    const meta: ChainMetadata = {
      doc,
      seq: c.seq,
      kind: c.kind,
      id: c.id,
      user: c.user,
      session: c.session === '' ? null : c.session,
      agent: c.agent ?? null,
      time: new Date(c.time).toISOString(),
      origin: c.origin,
      scopes: c.scopes,
      base: c.base ?? null,
      rebased: c.rebased ?? null,
      revision: c.revision,
      jti: c.jti ?? null,
      cdm: c.cdm ?? cdm,
      engine: c.engine,
      size: digest.size,
    };
    return {
      meta,
      payloadHash: digest.hash,
      prevHash: prev,
      hash: await chainHash(prev, meta, digest.hash),
      payload,
    };
  }

  /** `restoreSteps` (05 §10; 08 §8): the steps or snapshot that restore a document or a region. */
  async restoreSteps(stateId: unknown, request: unknown): Promise<Answer<RestoreStepsAnswer>> {
    const found = await this.#stateOf(stateId);
    return found.ok ? restoreSteps(this.#schema, found.state, request) : found;
  }

  /** `diff` (05 §10; 08 §6): the comparison of two states of one document. */
  async diff(stateId: unknown, request: unknown): Promise<Answer<DiffAnswer>> {
    const found = await this.#stateOf(stateId);
    return found.ok ? diff(this.#schema, found.state, request) : found;
  }

  /** `attribution` (05 §10; 08 §7): who wrote which spans of a region or of some blocks. */
  async attribution(stateId: unknown, request: unknown): Promise<Answer<AttributionAnswer>> {
    const found = await this.#stateOf(stateId);
    return found.ok ? attribution(this.#schema, found.state, request) : found;
  }

  /** `mapRanges` (05 §10; ADR 0015): the ranges given at a seq, mapped to the head of the state. */
  async mapRanges(stateId: unknown, request: unknown): Promise<Answer<MapRangesAnswer>> {
    const found = await this.#stateOf(stateId);
    return found.ok ? mapRangesCall(this.#schema, found.state, request) : found;
  }

  async #stateOf(stateId: unknown): Promise<Answer<{ state: HeldState }>> {
    if (typeof stateId !== 'string' || !HEX64.test(stateId))
      return fail('invalid_request', 'stateId must be 64 lower-case hexadecimal digits');
    return this.#state(stateId);
  }

  /**
   * `migrate` (05 §10; 03 §11.3): the content of a document of an older `cdm`, moved to `target`
   * by the registered migrations and checked against the target's definition. The service keeps
   * nothing: the result is not a state, and a failure leaves everything as it was. The caller
   * stores the content as a snapshot commit with origin `migration` and opens it.
   */
  async migrate(request: unknown): Promise<Answer<MigrateAnswer>> {
    if (!this.#allowMigrations)
      return fail(
        'migration_not_enabled',
        'migrations are run only when the operator enables them (03 §11.3)',
      );
    if (!isObject(request) || !isObject(request['content']))
      return fail('invalid_request', 'content must be a CDM envelope');
    const target = request['target'];
    if (typeof target !== 'number' || !Number.isSafeInteger(target))
      return fail('invalid_request', 'target must be an integer CDM version');
    const def = this.#definitions.get(target);
    if (!def)
      return fail('unsupported_cdm', `this service has no definition of CDM version ${target}`, {
        supported: [...this.#definitions.keys()].sort((a, b) => a - b),
      });
    const migrated = migrate(request['content'], this.#migrations, target);
    if (!migrated.ok) return fail('migration_failed', migrated.message, { code: migrated.code });
    const read = readDocument(migrated.envelope, { def });
    if (!read.ok)
      return fail('migration_failed', `the migrated document is not valid: ${read.message}`, {
        code: 'result_invalid',
        reason: read.code,
      });
    const content = canonicalEnvelope(migrated.envelope as unknown as JsonEnvelope, def);
    return {
      ok: true,
      content,
      text: canonicalText(content, def),
      contentHash: await documentHash(content, def),
      cdm: migrated.cdm,
      steps: migrated.steps,
    };
  }

  /**
   * `evaluateRules` (05 §10; 12 §5): the visibility, requirement, enablement and computed values of
   * the fields of a state's head, for the roles given and, optionally, values that replace the
   * stored ones. It is the shared rules package on the head's content, nothing more.
   */
  async evaluateRules(
    stateId: unknown,
    request: unknown = {},
  ): Promise<Answer<{ evaluation: EvaluateRulesAnswer }>> {
    if (typeof stateId !== 'string' || !HEX64.test(stateId))
      return fail('invalid_request', 'stateId must be 64 lower-case hexadecimal digits');
    if (!isObject(request)) return fail('invalid_request', 'the request must be a JSON object');
    const roles = request['roles'] ?? [];
    if (!Array.isArray(roles) || roles.some((r) => typeof r !== 'string'))
      return fail('invalid_request', 'roles must be an array of strings');
    const values = request['values'];
    if (values !== undefined && !isObject(values))
      return fail('invalid_request', 'values must be an object keyed by field key');
    const keys = request['keys'];
    if (keys !== undefined && (!Array.isArray(keys) || keys.some((k) => typeof k !== 'string')))
      return fail('invalid_request', 'keys must be an array of strings');
    const now = request['now'];
    if (
      now !== undefined &&
      now !== null &&
      !(isObject(now) && typeof now['instant'] === 'string' && typeof now['timeZone'] === 'string')
    )
      return fail('invalid_request', 'now must be null or { instant, timeZone }');
    const budget = request['budget'];
    if (budget !== undefined && !(typeof budget === 'number' && Number.isSafeInteger(budget)))
      return fail('invalid_request', 'budget must be an integer');
    const found = await this.#state(stateId);
    if (!found.ok) return found;
    const state = found.state;
    const envelope: JsonEnvelope = {
      cdm: state.cdm,
      requires: state.requires.get(state.head) ?? [],
      doc: state.headDoc.toJSON() as JsonNode,
    };
    const result = evaluateDocument(
      envelope,
      {
        roles: roles as string[],
        ...(now !== undefined ? { now: now as { instant: string; timeZone: string } | null } : {}),
        ...(budget !== undefined ? { budget: budget as number } : {}),
      },
      {
        ...(values ? { values: values as ValueMap } : {}),
        ...(keys ? { keys: keys as string[] } : {}),
      },
    );
    if (!result.ok) {
      if (result.code === 'budget_exceeded')
        return fail('budget_exceeded', 'the rules did not finish within the budget', {
          steps: result.steps,
        });
      return fail('invalid_rules', 'the document holds rules that do not compile', {
        problems: result.problems,
      });
    }
    return { ok: true, evaluation: result };
  }

  /** The checkpoint's content, checked against its reference, and its parsed document. */
  async #checkpoint(
    doc: string,
    ref: CheckpointRef,
  ): Promise<Answer<{ envelope: JsonEnvelope; node: Node }>> {
    let content = ref.content;
    if (content === undefined) {
      content = await this.#resolver?.ref(doc, ref);
      if (content === undefined)
        return fail('checkpoint_unavailable', `the checkpoint at ${ref.seq} is not available`, {
          seq: ref.seq,
        });
    }
    return this.#read(content, ref.contentHash);
  }

  async #read(
    content: JsonEnvelope,
    contentHash?: string,
  ): Promise<Answer<{ envelope: JsonEnvelope; node: Node }>> {
    const read = readDocument(content, { schema: this.#schema });
    if (!read.ok) {
      if (read.code === 'unsupported_cdm')
        return fail('unsupported_cdm', read.message, { supported: read.supported });
      if (read.code === 'unsupported_feature')
        return fail('unsupported_feature', read.message, { missing: read.missing });
      return fail('validation_failed', read.message);
    }
    if (contentHash !== undefined) {
      let actual: string;
      try {
        actual = await documentHash(content);
      } catch (e) {
        return fail('validation_failed', `the checkpoint has no canonical form: ${String(e)}`);
      }
      if (actual !== contentHash)
        return fail('checkpoint_mismatch', 'the checkpoint does not hash to its contentHash');
    }
    return { ok: true, envelope: content, node: read.doc };
  }

  async #logCommit(
    doc: string,
    c: WireCommit,
    snapshots: Map<string, Node>,
  ): Promise<Answer<{ value: { commit: LogCommit; requires?: string[] } }>> {
    const { meta, payload } = c;
    const time = Date.parse(meta.time);
    const common = {
      seq: meta.seq,
      id: meta.id,
      user: meta.user,
      session: meta.session ?? '',
      ...(meta.agent === null ? {} : { agent: meta.agent }),
      time: Number.isNaN(time) ? 0 : time,
      origin: meta.origin,
      scopes: meta.scopes,
      revision: meta.revision,
      cdm: meta.cdm,
      engine: meta.engine,
      retired: payload.retired ?? [],
      claimed: payload.claimed ?? [],
    };
    if (meta.kind === 'snapshot') {
      const snap = payload.snapshot;
      if (!snap)
        return fail('invalid_request', `snapshot commit ${meta.seq} names no checkpoint`, {
          seq: meta.seq,
        });
      const env = await this.#resolver?.snapshot(doc, snap.checkpoint);
      if (env === undefined)
        return fail('checkpoint_unavailable', `checkpoint ${snap.checkpoint} is not available`, {
          seq: meta.seq,
        });
      const read = await this.#read(env);
      if (!read.ok) return read;
      snapshots.set(snap.checkpoint, read.node);
      const commit: SnapshotCommit = {
        ...common,
        kind: 'snapshot',
        steps: [],
        snapshot: snap,
      };
      return { ok: true, value: { commit, requires: read.envelope.requires } };
    }
    if (meta.kind !== 'steps' && meta.kind !== 'control')
      return fail('invalid_request', `commit ${meta.seq} has an unknown kind`, { seq: meta.seq });
    const commit: StoredCommit = { ...common, kind: meta.kind, steps: payload.steps };
    return { ok: true, value: { commit } };
  }

  /**
   * A state by its identifier: from memory, or rebuilt from the caller's storage when the service
   * does not hold it (an evicted state, a restart, another replica). Without a loader the answer
   * is `unknown_state` and the caller calls `open`.
   */
  async #state(stateId: string): Promise<Answer<{ state: HeldState }>> {
    const held = this.#held.get(stateId);
    if (held) {
      this.#touch(held);
      return { ok: true, state: held };
    }
    const miss = () =>
      fail('unknown_state', 'the service does not hold this state; call open again', { stateId });
    if (!this.#loader) return miss();
    let request: OpenRequest | undefined;
    try {
      request = await this.#loader.load(stateId);
    } catch (e) {
      return fail('storage_unavailable', `the state could not be read from storage: ${String(e)}`, {
        stateId,
      });
    }
    if (!request) return miss();
    if (request.stateId !== stateId)
      return fail('state_mismatch', 'storage returned another state than the one asked for', {
        asked: stateId,
        got: request.stateId,
      });
    const opened = await this.open(request);
    if (!opened.ok) return opened;
    const state = this.#held.get(stateId);
    return state ? { ok: true, state } : miss();
  }

  #hold(state: HeldState): void {
    this.#held.set(state.stateId, state);
    while (this.#held.size > this.#capacity) {
      const oldest = this.#held.keys().next().value;
      if (oldest === undefined) break;
      this.#held.delete(oldest);
    }
  }

  #touch(state: HeldState): void {
    this.#held.delete(state.stateId);
    this.#held.set(state.stateId, state);
  }
}

const DOCUMENT_STATES: readonly string[] = ['active', 'locked', 'archived'];

/** Checks the shape of an `applyCommit` request; the room checks what the commit means. */
function parseApply(input: unknown): Answer<{ value: ApplyCommitRequest }> {
  const bad = (m: string) => fail('invalid_request', m);
  if (!isObject(input)) return bad('the request must be a JSON object');
  const { commit, permissions, preconditions } = input;
  if (!isObject(commit)) return bad('commit must be an object');
  if (typeof commit['id'] !== 'string') return bad('commit.id must be a string');
  if (typeof commit['base'] !== 'number' || !Number.isSafeInteger(commit['base']))
    return bad('commit.base must be an integer');
  const author = commit['author'];
  if (
    !isObject(author) ||
    typeof author['sub'] !== 'string' ||
    typeof author['session'] !== 'string'
  )
    return bad('commit.author needs a sub and a session');
  if (typeof author['role'] !== 'string') return bad('commit.author.role must be a string');
  if (
    commit['time'] !== undefined &&
    !(typeof commit['time'] === 'number' && Number.isSafeInteger(commit['time']))
  )
    return bad('commit.time must be an integer');
  if (!isObject(permissions)) return bad('permissions must be an object');
  if (typeof permissions['revision'] !== 'number' || !Number.isSafeInteger(permissions['revision']))
    return bad('permissions.revision must be an integer');
  if (!Array.isArray(permissions['grants'])) return bad('permissions.grants must be an array');
  const ds = permissions['documentState'];
  if (ds !== undefined && !(typeof ds === 'string' && DOCUMENT_STATES.includes(ds)))
    return bad('permissions.documentState must be active, locked or archived');
  if (preconditions !== undefined && !isObject(preconditions))
    return bad('preconditions must be an object');
  return { ok: true, value: input as unknown as ApplyCommitRequest };
}

/** What the room checks for a server-authored commit (04 §5), here for a commit the caller decided on. */
function preconditionFailure(
  p: WirePreconditions | undefined,
  now: PermissionState,
  head: number,
): string | null {
  if (!p) return null;
  if (p.revision !== undefined && p.revision !== now.revision)
    return `the grants revision is ${now.revision}, not ${p.revision}`;
  if (p.head !== undefined && p.head !== head) return `commits were accepted after ${p.head}`;
  if (p.documentState !== undefined && p.documentState !== now.documentState)
    return `the document is ${now.documentState}, not ${p.documentState}`;
  if (p.workflowActive !== undefined && p.workflowActive !== now.workflowActive)
    return p.workflowActive ? 'no workflow is active' : 'a workflow is active';
  for (const [region, state] of Object.entries(p.regionStates ?? {})) {
    const cur = now.regionStates.get(region) ?? 'draft';
    if (cur !== state) return `region ${region} is ${cur}, not ${state}`;
  }
  return null;
}

/** Checks the shape of an `open` request; the contents are checked by the service itself. */
function parseOpen(input: unknown): Answer<{ value: OpenRequest }> {
  const bad = (m: string) => fail('invalid_request', m);
  if (!isObject(input)) return bad('the request must be a JSON object');
  const { doc, checkpointRef: ref, commits, stateId } = input;
  if (typeof doc !== 'string' || doc === '') return bad('doc must be a non-empty string');
  if (typeof stateId !== 'string' || !HEX64.test(stateId))
    return bad('stateId must be 64 lower-case hexadecimal digits');
  if (!isObject(ref)) return bad('checkpointRef must be an object');
  if (typeof ref['seq'] !== 'number' || !Number.isSafeInteger(ref['seq']) || ref['seq'] < 0)
    return bad('checkpointRef.seq must be a non-negative integer');
  const chainHead = ref['chainHead'];
  if (chainHead !== null && !(typeof chainHead === 'string' && HEX64.test(chainHead)))
    return bad('checkpointRef.chainHead must be null or 64 hexadecimal digits');
  if ((ref['seq'] === 0) !== (chainHead === null))
    return bad('checkpointRef.chainHead is null exactly when seq is 0');
  if (typeof ref['contentHash'] !== 'string' || !HEX64.test(ref['contentHash']))
    return bad('checkpointRef.contentHash must be 64 lower-case hexadecimal digits');
  if (ref['content'] !== undefined && !isObject(ref['content']))
    return bad('checkpointRef.content must be a CDM envelope');
  if (!Array.isArray(commits)) return bad('commits must be an array');
  for (const [i, c] of commits.entries()) {
    if (isObject(c) && (c['payload'] === undefined || c['payload'] === null))
      return fail('payload_missing', `commit ${i} has no payload; the service cannot replay it`, {
        index: i,
      });
    if (
      !isObject(c) ||
      !isObject(c['meta']) ||
      !isObject(c['payload']) ||
      typeof c['payloadHash'] !== 'string' ||
      typeof c['hash'] !== 'string' ||
      !(c['prevHash'] === null || typeof c['prevHash'] === 'string')
    )
      return bad(`commit ${i} is malformed`);
    const meta = c['meta'];
    if (typeof meta['seq'] !== 'number' || !Number.isSafeInteger(meta['seq']))
      return bad(`commit ${i} has no integer seq`);
    if (!Array.isArray((c['payload'] as Record<string, unknown>)['steps']))
      return bad(`commit ${i} has no steps array`);
  }
  return { ok: true, value: input as unknown as OpenRequest };
}
