/**
 * The purge of a deleted document (HIS-039; 08 §13; 05 §6.2 `DELETE /documents/{id}`; owner
 * decisions 30, 31 and 84 in docs/owner-decisions-2026-11-15.md).
 *
 * `DELETE /documents/{id}` is a soft delete: the data stays and `dep.document.deleted` is raised at
 * that time. This job removes the data once the retention period has passed, which is 30 days by
 * default (decision 30; `purgeAfterDays` in the configuration). The decision of whether a document
 * is purged and what is removed is `purgePlan` of `@docedit/history`: not before the retention has
 * passed, never under a legal hold, and an asset that another document references is kept.
 *
 * For a document the plan lets through, the job:
 *
 * 1. deletes the objects: everything under the document's prefix (checkpoints, cold segments and
 *    set-aside checkpoints), the files of its export jobs, and the objects of its assets that no
 *    other document references and whose content no other asset shares (assets are stored by hash);
 * 2. deletes the rows keyed by the document, in one transaction (`PurgeStore.remove`): commits and
 *    their metadata, checkpoints, grants, versions, threads and comments, read markers, workflow
 *    state and evidence, jobs, and the document itself;
 * 3. removes the document from the search index; and
 * 4. writes the audit event `document.purged` (the document and counts, never content).
 *
 * The objects go first. If the row deletion then fails, the document is still soft-deleted and the
 * next run does it again; nothing is left that no row points to.
 *
 * A sealed final PDF is stored write-once (12 §8.2; decision 84: it stays intact). A document that
 * has one whose retention (`retain_until`) has not ended is not purged yet, and the run reports it
 * as `sealed-retained`. Once the retention has ended the sealed PDF goes with the document, because
 * signing evidence is kept as long as the signed document exists and deleted with it (decision 31).
 * This reading is proposed in the notes of HIS-039; the owner has not decided it.
 *
 * What is not here: a tenant's own retention period (the default is the same for every tenant), the
 * backups (they age out on the operator's schedule: docs/operations/backups.md), and the audit rows
 * of the document, which stay: the trail is append-only and holds identifiers, never content.
 */
import { NO_HOLD, purgePlan, type PurgeAsset } from '@docedit/history';
import { uuid7 } from '@docedit/model';
import { objectKeys, type ObjectStore } from '../objects/store.ts';
import type { AuditStore } from '../storage/types.ts';

export const DAY_MS = 24 * 60 * 60 * 1000;
/** The retention between soft delete and purge when nothing else is set (decision 30). */
export const DEFAULT_PURGE_AFTER_DAYS = 30;

/** A document as the purge sees it: soft-deleted at `deletedAt` (Unix ms). */
export interface DeletedDocument {
  doc: string;
  deletedAt: number;
}

/** An asset the document references, with what other documents and assets share. */
export interface PurgeAssetRow {
  id: string;
  /** Another document, not being purged, references the asset. */
  shared: boolean;
  /** The asset was uploaded for this document (it is deleted with it unless shared). */
  own: boolean;
  /** Lower-case hex SHA-256 of the content, when the asset is ready. */
  sha256: string | null;
  /** Another asset row (one this purge does not delete) has the same content. */
  contentShared: boolean;
}

export interface SealedRow {
  objectKey: string;
  /** Unix ms; the sealed PDF is retained until then. */
  retainUntil: number;
}

/** The rows of the purge. The PostgreSQL implementation runs under the purge role (migration 0073). */
export interface PurgeStore {
  /** The tenant's soft-deleted documents, oldest first, at most `limit`. */
  deleted(tenant: string, limit: number): Promise<DeletedDocument[]>;
  assets(tenant: string, doc: string): Promise<PurgeAssetRow[]>;
  /** The jobs that belong to the document (exports among them). */
  jobs(tenant: string, doc: string): Promise<string[]>;
  sealed(tenant: string, doc: string): Promise<SealedRow[]>;
  /**
   * Deletes every row keyed by the document, and the rows of `assets` (the ones the document owns
   * and nobody else references), in one transaction. The document's own row goes last.
   */
  remove(tenant: string, doc: string, assets: readonly string[]): Promise<void>;
}

export interface SearchPurge {
  purgeDocument(tenant: string, doc: string): unknown | Promise<unknown>;
}

export interface DocumentPurgeDeps {
  store: PurgeStore;
  objects: ObjectStore;
  audit: AuditStore;
  search?: SearchPurge;
  /** Retention between soft delete and purge, in milliseconds; the same for every tenant for now. */
  retentionMs: number;
  now: () => number;
}

export type PurgeSkip = 'retention-running' | 'legal-hold' | 'sealed-retained';

export interface PurgeRunResult {
  purged: string[];
  skipped: Array<{ doc: string; reason: PurgeSkip }>;
}

export class DocumentPurge {
  readonly #d: DocumentPurgeDeps;

  constructor(deps: DocumentPurgeDeps) {
    this.#d = deps;
  }

  /**
   * Purges the tenant's documents that are due. `held` is the set of documents under a legal hold
   * (the scheduler passes it to tasks that delete). A failure on one document stops the run for the
   * tenant and is thrown, so that the scheduler records it; the documents done before it stay done.
   */
  async run(
    tenant: string,
    held: ReadonlySet<string> = new Set(),
    now: number = this.#d.now(),
  ): Promise<PurgeRunResult> {
    const result: PurgeRunResult = { purged: [], skipped: [] };
    for (const { doc, deletedAt } of await this.#d.store.deleted(tenant, 200)) {
      const assets = await this.#d.store.assets(tenant, doc);
      const plan = purgePlan({
        doc,
        deletedAt,
        retentionMs: this.#d.retentionMs,
        now,
        hold: held.has(doc) ? { inForce: true } : NO_HOLD,
        assets: assets.map<PurgeAsset>((a) => ({ id: a.id, sharedWithOtherDocument: a.shared })),
      });
      if (!plan.ok) throw new Error(`purge of ${doc} refused: ${plan.reason}`);
      const outcome = plan.outcome;
      if (!outcome.run) {
        if (outcome.reason !== 'not-deleted') result.skipped.push({ doc, reason: outcome.reason });
        continue;
      }
      const sealed = await this.#d.store.sealed(tenant, doc);
      if (sealed.some((s) => s.retainUntil > now)) {
        result.skipped.push({ doc, reason: 'sealed-retained' });
        continue;
      }
      const owned = new Set(outcome.remove.assets);
      const removing = assets.filter((a) => a.own && owned.has(a.id));
      await this.#deleteObjects(tenant, doc, removing, sealed);
      await this.#d.store.remove(
        tenant,
        doc,
        removing.map((a) => a.id),
      );
      await this.#d.search?.purgeDocument(tenant, doc);
      await this.#d.audit.record([
        {
          id: uuid7(),
          tenant,
          doc,
          actor: 'system',
          kind: 'document.purged',
          data: {
            deletedAt,
            assetsRemoved: removing.length,
            assetsKept: outcome.keptAssets.length,
          },
          // The time of the audit is the clock's, whatever time the run was asked to judge by.
          at: this.#d.now(),
        },
      ]);
      result.purged.push(doc);
    }
    return result;
  }

  async #deleteObjects(
    tenant: string,
    doc: string,
    assets: readonly PurgeAssetRow[],
    sealed: readonly SealedRow[],
  ): Promise<void> {
    const o = this.#d.objects;
    const keys = new Set<string>();
    // Checkpoints, cold segments and set-aside checkpoints all live under the document's prefix.
    for (const key of await o.list(`${objectKeys.prefix(tenant)}docs/${doc}/`)) keys.add(key);
    for (const job of await this.#d.store.jobs(tenant, doc))
      for (const key of await o.list(objectKeys.exports(tenant, job))) keys.add(key);
    for (const a of assets) {
      keys.add(objectKeys.quarantine(tenant, a.id));
      if (a.sha256 !== null && !a.contentShared) keys.add(objectKeys.asset(tenant, a.sha256));
    }
    for (const s of sealed) keys.add(s.objectKey);
    for (const key of keys) await o.delete(key);
  }
}
