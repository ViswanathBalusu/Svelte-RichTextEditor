/**
 * Replacing one commit's payload with a tombstone (HIS-040; 08 §13, second bullet; owner decision 84
 * in docs/owner-decisions-2026-11-15.md). The rules are those of `tombstone` in `@docedit/history`,
 * applied to the stores of the service.
 *
 * The commit's metadata row, its payload hash and the hash chain stay; only the payload row goes,
 * and a row of `commit_tombstones` records who asked, why and when. A read, a comparison or a
 * rebuild that needs the payload then fails with `not_found` and a message that the detail was
 * removed (pipeline.ts, `PayloadAbsentError`), and never returns content built without the commit.
 *
 * The operation is refused when
 *
 * - a legal hold is in force on the document (`conflict`, as `tombstone` of the history package);
 * - the commit does not exist (`not_found`) or its payload is already removed (`conflict`);
 * - no checkpoint covers the commit yet (`conflict`): a room loads from the newest checkpoint and
 *   replays the commits after it, so removing the payload of a commit above it would stop the room
 *   from loading. This rule is the service's, not the package's, and is proposed in the notes of
 *   HIS-040.
 *
 * The answer reports the copies that may still hold the removed text (HIS-040 criterion 4): the
 * checkpoints at or after the commit, the cold segments that cover it, and the attribution map. It
 * does not rewrite them. Owner decision 84 says checkpoints and the attribution map are cleaned of a
 * person's identity on an erasure of that person; the rewrite is not built, and the report says what
 * it involves. A sealed PDF is never touched.
 *
 * Every call is audited (`commit.tombstoned`: the sequence number and the reason, never content).
 */
import { uuid7 } from '@docedit/model';
import type { ObjectStore } from '../objects/store.ts';
import { objectKeys } from '../objects/store.ts';
import type { AuditStore, CheckpointIndex, DocRef, DocumentStore } from '../storage/types.ts';
import { ApiError } from './problems.ts';

export const TOMBSTONE_REASON_MAX = 500;

export const TOMBSTONE_INVOLVES =
  'rebuild or remove each listed checkpoint and cold segment without the commit, and rewrite the attribution runs that name it';

export type PayloadState = 'absent' | 'removed' | 'present';

/** The rows of a tombstone. The PostgreSQL implementation runs under the purge role (migration 0074). */
export interface TombstoneStore {
  /** `absent`: no such commit; `removed`: its payload row is gone; `present` otherwise. */
  state(tenant: string, doc: string, seq: number): Promise<PayloadState>;
  /** Deletes the payload row and records the tombstone, in one transaction. */
  remove(
    tenant: string,
    doc: string,
    seq: number,
    actor: string,
    reason: string,
    at: number,
  ): Promise<void>;
}

export interface TombstoneCopies {
  /** Checkpoints at or after the commit, in order: they were built by replaying it. */
  checkpoints: number[];
  /** Cold segments (`segments/{from}-{to}.payloads.zst`) whose range covers the commit. */
  coldSegments: string[];
  attributionMap: 'may-hold-runs';
  involves: string;
}

export interface TombstoneResult {
  seq: number;
  removedAt: string;
  copies: TombstoneCopies;
}

export interface CommitTombstoneDeps {
  store: TombstoneStore;
  documents: Pick<DocumentStore, 'get'>;
  checkpoints: CheckpointIndex;
  objects: ObjectStore;
  audit: AuditStore;
  /** Whether a legal hold is in force on the document. */
  held: (tenant: string, doc: string) => Promise<boolean>;
  now: () => number;
}

/** Checks the body: an object whose only field is `reason`, trimmed, 1 to 500 characters. */
export function checkTombstoneBody(value: unknown): string {
  const fail = (message: string, path: string): never => {
    throw new ApiError('validation_failed', message, {
      violations: [{ path, rule: 'a non-empty reason of at most 500 characters' }],
    });
  };
  if (typeof value !== 'object' || value === null || Array.isArray(value))
    return fail('the body is an object with a reason', '/');
  const o = value as Record<string, unknown>;
  for (const key of Object.keys(o))
    if (key !== 'reason') return fail(`the body has no field ${key}`, `/${key}`);
  if (typeof o['reason'] !== 'string') return fail('reason is a string', '/reason');
  const reason = o['reason'].trim();
  if (reason.length === 0) return fail('reason is not empty', '/reason');
  if ([...reason].length > TOMBSTONE_REASON_MAX)
    return fail('reason is at most 500 characters', '/reason');
  return reason;
}

const SEGMENT = /\/segments\/(\d+)-(\d+)\.payloads\.zst$/;

export class CommitTombstone {
  readonly #d: CommitTombstoneDeps;

  constructor(deps: CommitTombstoneDeps) {
    this.#d = deps;
  }

  async tombstone(
    tenant: string,
    doc: string,
    seq: number,
    actor: string,
    reason: string,
  ): Promise<TombstoneResult> {
    if (!Number.isSafeInteger(seq) || seq < 1)
      throw new ApiError('validation_failed', 'seq names a commit', {
        violations: [{ path: 'seq', rule: 'a whole number, 1 or more' }],
      });
    const ref: DocRef = { tenant, doc };
    if ((await this.#d.documents.get(ref)) === null)
      throw new ApiError('not_found', 'no such document');
    // A hold is checked first, as `tombstone` of the history package does for a known commit.
    if (await this.#d.held(tenant, doc))
      throw new ApiError('conflict', 'a legal hold is in force on this document');
    const state = await this.#d.store.state(tenant, doc, seq);
    if (state === 'absent') throw new ApiError('not_found', 'no commit has that seq');
    if (state === 'removed')
      throw new ApiError('conflict', 'the payload of that commit is already removed');
    const checkpoints = (await this.#d.checkpoints.list(ref))
      .map((c) => c.seq)
      .sort((a, b) => a - b);
    if (!checkpoints.some((s) => s >= seq))
      throw new ApiError(
        'conflict',
        'no checkpoint covers that commit yet, so a room would need its payload to load',
      );
    const coldSegments = (
      await this.#d.objects.list(`${objectKeys.prefix(tenant)}docs/${doc}/segments/`)
    )
      .filter((key) => {
        const m = SEGMENT.exec(key);
        return m !== null && Number(m[1]) <= seq && seq <= Number(m[2]);
      })
      .sort();
    const at = this.#d.now();
    await this.#d.store.remove(tenant, doc, seq, actor, reason, at);
    await this.#d.audit.record([
      {
        id: uuid7(),
        tenant,
        doc,
        actor,
        kind: 'commit.tombstoned',
        data: { seq, reason },
        at,
      },
    ]);
    return {
      seq,
      removedAt: new Date(at).toISOString(),
      copies: {
        checkpoints: checkpoints.filter((s) => s >= seq),
        coldSegments,
        attributionMap: 'may-hold-runs',
        involves: TOMBSTONE_INVOLVES,
      },
    };
  }
}
