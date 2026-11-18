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
  type LogCommit,
  type SnapshotCommit,
  type SnapshotReason,
  type StepJson,
  type StoredCommit,
  contentAt,
  defaultReplayers,
} from '@docedit/authority';
import { type ChainMetadata, chainHash, payloadDigest } from '@docedit/history';
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
import { readDocument } from '@docedit/model/validate';
import type { Node } from 'prosemirror-model';

const HEX64 = /^[0-9a-f]{64}$/;

/** What the service tells a caller when it does not do what was asked. */
export type ServiceErrorCode =
  | 'invalid_request'
  | 'unknown_state'
  | 'not_found'
  | 'state_mismatch'
  | 'chain_broken'
  | 'payload_missing'
  | 'checkpoint_unavailable'
  | 'checkpoint_mismatch'
  | 'replay_failed'
  | 'unsupported_cdm'
  | 'unsupported_feature'
  | 'validation_failed'
  | 'migration_not_enabled'
  | 'migration_failed'
  | 'invalid_rules'
  | 'budget_exceeded'
  | 'storage_unavailable'
  | 'unauthorized';

export interface ServiceError {
  code: ServiceErrorCode;
  message: string;
  /** Further fields of the same kind as the code carries, such as the problem's path. */
  detail?: unknown;
}

export type Answer<T> = ({ ok: true } & T) | { ok: false; error: ServiceError };

export function fail(code: ServiceErrorCode, message: string, detail?: unknown): Answer<never> {
  return { ok: false, error: { code, message, ...(detail === undefined ? {} : { detail }) } };
}

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

/** A loaded document: immutable, named by its `stateId`. */
interface HeldState {
  stateId: string;
  doc: string;
  head: number;
  /** The first sequence number whose content can be read (the checkpoint's). */
  first: number;
  source: ContentSource;
  headDoc: Node;
  /** The `cdm` of the checkpoint the log starts from. */
  cdm: number;
  /** The `requires` of the document at each sequence number from `first` to `head`. */
  requires: Map<number, string[]>;
}

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
    const checkpoints: Checkpoint[] = [{ seq: ref.seq, doc: node }];
    const source: ContentSource = {
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
    };
    this.#hold(state);
    return { ok: true, stateId, seq: head, doc };
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
