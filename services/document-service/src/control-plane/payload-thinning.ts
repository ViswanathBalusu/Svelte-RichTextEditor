/**
 * Thinning old payloads for a tenant that keeps only the history after a chosen period (HIS-032;
 * 08 section 11; ADR 0010 "Revisit when").
 *
 * The retention policy (retention.ts) is the tenant's choice: `thin_payloads` with `afterDays`, or
 * a document's own policy, which wins. A scheduled run (`payloads.thin`, one per tenant) takes each
 * live document and asks `payloadThinningPlan` of `@docedit/history` which payloads may go:
 *
 * - older than the period, and not the payload of a snapshot commit;
 * - not needed to rebuild a named, export, sent or completed version (the commits after the
 *   version's nearest checkpoint, up to it);
 * - nothing at all for a document under a legal hold (the scheduler hands the held set to a task
 *   that deletes, and the plan is also given the hold).
 *
 * This service adds one rule the plan does not know. A payload above the newest checkpoint is kept,
 * because a room loads from the newest checkpoint and replays what follows it (the same rule as the
 * tombstone of HIS-040). So only the range below the newest checkpoint is thinned, and for that
 * range the checkpoints remain: a rebuild inside it answers `not_found` with the reason
 * (`PayloadAbsentError`), and the history list reads metadata only.
 *
 * The metadata rows, the payload hashes and the chain stay; the chain still verifies. Each document
 * that loses payloads gets one audit event, `history.thinned`, with counts and never content.
 */
import { payloadThinningPlan, type PayloadRecord, type PinnedVersion } from '@docedit/history';
import { DAY_MS } from './document-purge.ts';
import type { AuditStore } from '../storage/types.ts';
import { uuid7 } from '@docedit/model';
import type { RetentionService } from './retention.ts';
import type { ScheduledTask, TaskScope } from './scheduler.ts';

/** What the plan reads about one document. */
export interface ThinningFacts {
  /** Commits with a payload in the log table, older than the cut, in any order. */
  readonly commits: readonly PayloadRecord[];
  /** The checkpoints of the document (set-aside copies left out). */
  readonly checkpoints: readonly number[];
  /** The stored versions of the document. */
  readonly versions: readonly PinnedVersion[];
}

/** The rows of the thinning. The PostgreSQL implementation runs under the purge role (0073). */
export interface ThinningStore {
  /** The tenant's documents that are not deleted. */
  documents(tenant: string): Promise<string[]>;
  /** The facts for one document: commits with a payload and a time before `before` (Unix ms). */
  facts(tenant: string, doc: string, before: number): Promise<ThinningFacts>;
  /** Deletes the payload rows of these commits, and returns how many were deleted. */
  remove(tenant: string, doc: string, seqs: readonly number[]): Promise<number>;
}

export interface PayloadThinningDeps {
  store: ThinningStore;
  retention: RetentionService;
  audit: AuditStore;
  now: () => number;
}

export interface ThinningRunResult {
  /** Documents that lost payloads, with how many. */
  thinned: Array<{ doc: string; removed: number }>;
  /** Documents left alone, with the reason. */
  skipped: Array<{ doc: string; reason: 'legal-hold' }>;
}

export class PayloadThinning {
  readonly #d: PayloadThinningDeps;

  constructor(deps: PayloadThinningDeps) {
    this.#d = deps;
  }

  /**
   * Thins the tenant's documents whose effective policy is `thin_payloads`. `held` is the set of
   * documents under a legal hold: they are skipped and nothing of theirs is read or removed. A
   * failure stops the run for the tenant and is thrown, so that the scheduler records it.
   */
  async run(
    tenant: string,
    held: ReadonlySet<string> = new Set(),
    now: number = this.#d.now(),
  ): Promise<ThinningRunResult> {
    const out: ThinningRunResult = { thinned: [], skipped: [] };
    for (const doc of await this.#d.store.documents(tenant)) {
      const policy = (await this.#d.retention.document(tenant, doc)).effective;
      if (policy.mode !== 'thin_payloads' || policy.afterDays === undefined) continue;
      if (held.has(doc)) {
        out.skipped.push({ doc, reason: 'legal-hold' });
        continue;
      }
      const periodMs = policy.afterDays * DAY_MS;
      const facts = await this.#d.store.facts(tenant, doc, now - periodMs);
      const newest = facts.checkpoints.reduce((m, s) => Math.max(m, s), 0);
      const plan = payloadThinningPlan(facts.commits, facts.checkpoints, facts.versions, {
        now,
        periodMs,
        hold: false,
      });
      if (!plan.ok) throw new Error(`the thinning plan of ${doc} was refused: ${plan.reason}`);
      // The room replays what follows the newest checkpoint, so those payloads stay.
      const remove = plan.remove.filter((seq) => seq <= newest);
      if (remove.length === 0) continue;
      const removed = await this.#d.store.remove(tenant, doc, remove);
      if (removed === 0) continue;
      out.thinned.push({ doc, removed });
      await this.#d.audit.record([
        {
          id: uuid7(),
          tenant,
          doc,
          actor: 'system',
          kind: 'history.thinned',
          data: {
            removed,
            keptForVersions: plan.keptForVersions.length,
            afterDays: policy.afterDays,
          },
          at: now,
        },
      ]);
    }
    return out;
  }
}

/**
 * The scheduled task (BE-052): once a day, per tenant. It deletes data, so the scheduler gives it
 * the documents under a legal hold, and `run` leaves those alone (criterion 5). Its count is the
 * number of documents that lost payloads.
 */
export function payloadThinningTask(thinning: PayloadThinning): ScheduledTask {
  return {
    name: 'payloads.thin',
    everyMs: DAY_MS,
    deletes: true,
    forTenant: async (tenant: string, at: number, scope: TaskScope) =>
      (await thinning.run(tenant, scope.held, at)).thinned.length,
  };
}
