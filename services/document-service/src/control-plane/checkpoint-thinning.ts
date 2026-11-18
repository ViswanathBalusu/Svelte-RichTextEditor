/**
 * Thinning old checkpoints with age (HIS-030; 08 section 11; 06 section 2.2; review PD-6).
 *
 * A scheduled run (`checkpoints.thin`, daily, one per tenant) takes each live document and asks
 * `thinningPlan` of `@docedit/history` which checkpoints may go: all are kept for 30 days; older
 * ones are thinned to one per UTC day and, past 90 days (owner decision 55), to one per week. The
 * service adds what the plan cannot know:
 *
 * - which checkpoints a stored version points at (the nearest at or before the version's `seq`,
 *   and the one at sequence number 0), and which border a snapshot commit, are read from the
 *   `versions` and `doc_commits` rows and kept (`checkpointRecords`);
 * - a checkpoint that would replace older ones is first compared with a replay of the log
 *   (`gateThinning`, BE-020 criterion 5). A mismatch raises the alert and the period is held back;
 *   a checkpoint that cannot be verified (a gap in the log) is held back as well;
 * - a document under a legal hold is left alone (the scheduler hands the held set in);
 * - the rows go first, under the purge role (migration 0073), then the objects: a room opens only
 *   from a checkpoint that has a row, so an object left behind by a failure is never used.
 *
 * Commits, payloads and the chain are not touched, so every version can still be rebuilt, with a
 * longer replay, and the chain still verifies. Each document that loses checkpoints gets one audit
 * event, `checkpoints.thinned`, with counts and never content.
 */
import { checkpointRecords, thinningPlan, WEEKLY_AFTER_MS } from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { objectKeys, type ObjectStore } from '../objects/store.ts';
import type { AuditStore, DocRef } from '../storage/types.ts';
import { DAY_MS } from './document-purge.ts';
import type { ScheduledTask, TaskScope } from './scheduler.ts';

/** What the plan reads about one document. */
export interface CheckpointFacts {
  /** The checkpoints that are not set aside, with the time each was written (Unix ms). */
  readonly checkpoints: ReadonlyArray<{ seq: number; time: number }>;
  /** The `seq` of each stored version. */
  readonly versions: readonly number[];
  /** The `seq` of each snapshot commit. */
  readonly snapshots: readonly number[];
}

/** The rows of the thinning. The PostgreSQL implementation runs under the purge role (0073). */
export interface CheckpointThinningStore {
  /** The tenant's documents that are not deleted. */
  documents(tenant: string): Promise<string[]>;
  facts(tenant: string, doc: string): Promise<CheckpointFacts>;
  /** Deletes the index rows of these checkpoints and returns how many were deleted. */
  remove(tenant: string, doc: string, seqs: readonly number[]): Promise<number>;
}

/** The outcome of comparing a checkpoint with a replay of the log (BE-020; `gateThinning`). */
export type CheckpointVerifier = (ref: DocRef, seq: number) => Promise<boolean>;

export interface CheckpointThinningDeps {
  store: CheckpointThinningStore;
  objects: ObjectStore;
  /** True only when the checkpoint's hash matched a replay. A throw counts as not verified. */
  verify: CheckpointVerifier;
  audit: AuditStore;
  now: () => number;
  /** The age after which periods are weeks; default 90 days (owner decision 55). */
  weeklyAfterMs?: number;
  /** Called with the error of a verification that could not be made. */
  onUnverifiable?: (ref: DocRef, seq: number, error: unknown) => void;
}

export interface CheckpointThinningResult {
  /** Documents that lost checkpoints, with how many. */
  thinned: Array<{ doc: string; removed: number }>;
  /** Documents left alone, with the reason. */
  skipped: Array<{ doc: string; reason: 'legal-hold' }>;
  /** Checkpoints held back for want of a verified keeper, over all documents. */
  held: number;
}

export class CheckpointThinning {
  readonly #d: CheckpointThinningDeps;

  constructor(deps: CheckpointThinningDeps) {
    this.#d = deps;
  }

  /**
   * Thins the tenant's documents. `held` is the set of documents under a legal hold: they are
   * skipped and nothing of theirs is read or removed. A failure of the store stops the run for the
   * tenant and is thrown, so that the scheduler records it.
   */
  async run(
    tenant: string,
    held: ReadonlySet<string> = new Set(),
    now: number = this.#d.now(),
  ): Promise<CheckpointThinningResult> {
    const out: CheckpointThinningResult = { thinned: [], skipped: [], held: 0 };
    const weeklyAfterMs = this.#d.weeklyAfterMs ?? WEEKLY_AFTER_MS;
    for (const doc of await this.#d.store.documents(tenant)) {
      if (held.has(doc)) {
        out.skipped.push({ doc, reason: 'legal-hold' });
        continue;
      }
      const facts = await this.#d.store.facts(tenant, doc);
      if (facts.checkpoints.length < 2) continue;
      const policy = { now, weeklyAfterMs };
      // A first plan that trusts every checkpoint names those that would replace older ones.
      const all = new Set(facts.checkpoints.map((c) => c.seq));
      const first = thinningPlan(
        checkpointRecords(facts.checkpoints, facts.versions, facts.snapshots, all),
        policy,
      );
      if (!first.ok) throw new Error(`the thinning plan of ${doc} was refused: ${first.reason}`);
      if (first.remove.length === 0) continue;
      const verified = new Set<number>(facts.checkpoints.map((c) => c.seq));
      for (const seq of first.keepers) {
        if (!(await this.#verified({ tenant, doc }, seq))) verified.delete(seq);
      }
      const plan = thinningPlan(
        checkpointRecords(facts.checkpoints, facts.versions, facts.snapshots, verified),
        policy,
      );
      if (!plan.ok) throw new Error(`the thinning plan of ${doc} was refused: ${plan.reason}`);
      out.held += plan.held.length;
      if (plan.remove.length === 0) continue;
      const removed = await this.#d.store.remove(tenant, doc, plan.remove);
      if (removed === 0) continue;
      const failed = await this.#deleteObjects(tenant, doc, plan.remove);
      out.thinned.push({ doc, removed });
      await this.#d.audit.record([
        {
          id: uuid7(),
          tenant,
          doc,
          actor: 'system',
          kind: 'checkpoints.thinned',
          data: {
            removed,
            kept: plan.keep.length,
            held: plan.held.length,
            objectsLeft: failed,
          },
          at: now,
        },
      ]);
    }
    return out;
  }

  async #verified(ref: DocRef, seq: number): Promise<boolean> {
    try {
      return await this.#d.verify(ref, seq);
    } catch (e) {
      this.#d.onUnverifiable?.(ref, seq, e);
      return false;
    }
  }

  /** Deletes the checkpoint and side objects; returns how many deletions failed (left behind). */
  async #deleteObjects(tenant: string, doc: string, seqs: readonly number[]): Promise<number> {
    let failed = 0;
    for (const seq of seqs)
      for (const key of [
        objectKeys.checkpoint(tenant, doc, seq),
        objectKeys.checkpointSide(tenant, doc, seq),
      ]) {
        try {
          await this.#d.objects.delete(key);
        } catch {
          failed += 1;
        }
      }
    return failed;
  }
}

/**
 * The scheduled task (BE-052): once a day, per tenant. It deletes data, so the scheduler gives it
 * the documents under a legal hold, and `run` leaves those alone. Its count is the number of
 * documents that lost checkpoints.
 */
export function checkpointThinningTask(thinning: CheckpointThinning): ScheduledTask {
  return {
    name: 'checkpoints.thin',
    everyMs: DAY_MS,
    deletes: true,
    forTenant: async (tenant: string, at: number, scope: TaskScope) =>
      (await thinning.run(tenant, scope.held, at)).thinned.length,
  };
}
