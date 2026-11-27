/**
 * The operator's migration of documents to a newer model version (BE-094; 06 §13; 03 §11.3;
 * ADR 0435). Nothing else changes a document's version: opening a document, a rolling deploy and
 * a client never do (criterion 1).
 *
 * For each document the runner reads the head content, migrates it with the registered migrations
 * (`migrate()` of `@docedit/model`, pure), checks the result in the schema of the target version,
 * and stores it as one snapshot commit with origin `migration`:
 *
 * - the room (an open one, or a transient authority when none is open) writes the checkpoint of
 *   the state before the commit when commits came after the last checkpoint, writes the checkpoint
 *   that holds the migrated content, then the commit, which carries the target version;
 * - every channel open on the document receives `sync.reset` with reason `migration` and then
 *   closes, so a component that cannot read the new version reconnects and is refused with
 *   `unsupported_cdm` (criterion 4);
 * - only then does the document's stored version change (`DocumentStore.setCdmVersion`).
 *
 * A run stops after the document it is on when `stop()` says so, and a document the run did not
 * reach is not touched: it keeps its version and opens and edits as before (criterion 3). A run
 * that was cut off between the commit and the version change is finished by running it again: the
 * runner sees that the log's head is a migration snapshot commit of a version above the stored
 * one, and only moves the version.
 *
 * The dry run reads and migrates and writes nothing: it reports what each document would do.
 */
import { isSnapshot } from '@docedit/authority';
import { migrate, type JsonEnvelope, type Migration } from '@docedit/model';
import type { DocRef, DocumentRecord, DocumentStore, LogStore } from '../storage/types.ts';
import { hasCdmSchema, schemaForCdm } from '../cdm-schemas.ts';
import { derivedCommitId } from './commit-id.ts';
import type { RoomHost } from './room-host.ts';
import { DataPlaneError, RequestRefused } from './wire.ts';

export interface MigrationScope {
  tenant: string;
  /** A document, or a batch of them. Without it, every document of the tenant. */
  documents?: readonly string[];
}

export type MigrationOutcome =
  /** Dry run: the document would be migrated. */
  | 'would_migrate'
  | 'migrated'
  /** Already at the target version. */
  | 'current'
  /** At a version above the target: migrations only go up. */
  | 'ahead'
  /** The room, the migration or the check refused it; the document is unchanged. */
  | 'refused'
  /** Not reached: the run was stopped first. */
  | 'not_reached';

export interface MigrationItem {
  doc: string;
  from: number;
  outcome: MigrationOutcome;
  /** The commit's `seq`, once stored. */
  seq?: number;
  /** Why it was refused, or how many steps a dry run would take. */
  message?: string;
  /** Dry run: the names of the migration steps that would run. */
  steps?: readonly string[];
}

export interface MigrationReport {
  dryRun: boolean;
  target: number;
  items: MigrationItem[];
  /** Whether the run ended because `stop()` said so. */
  stopped: boolean;
}

export interface MigrationDeps {
  host: RoomHost;
  documents: DocumentStore;
  logs: Pick<LogStore, 'head' | 'read'>;
  /** The migrations of the deployment, one per step. */
  migrations: readonly Migration[];
}

export interface RunOptions {
  /** Checked before each document: true ends the run after the current one. */
  stop?: () => boolean;
  /** Called after each document, for an operator's progress line. */
  onItem?: (item: MigrationItem) => void;
}

const PAGE = 200;

export class MigrationRunner {
  readonly #d: MigrationDeps;

  constructor(deps: MigrationDeps) {
    this.#d = deps;
  }

  /** What a run to `target` would do, with nothing written (criterion 2: a dry run first). */
  dryRun(scope: MigrationScope, target: number): Promise<MigrationReport> {
    return this.#go(scope, target, true, {});
  }

  run(scope: MigrationScope, target: number, opts: RunOptions = {}): Promise<MigrationReport> {
    return this.#go(scope, target, false, opts);
  }

  async #records(scope: MigrationScope): Promise<DocumentRecord[]> {
    const d = this.#d.documents;
    if (scope.documents) {
      const out: DocumentRecord[] = [];
      for (const doc of scope.documents) {
        const r = await d.get({ tenant: scope.tenant, doc });
        if (r && r.deletedAt === null) out.push(r);
      }
      return out;
    }
    const out: DocumentRecord[] = [];
    let after: string | undefined;
    for (;;) {
      const page = await d.list(scope.tenant, { limit: PAGE, ...(after ? { after } : {}) });
      out.push(...page);
      if (page.length < PAGE) return out;
      after = page[page.length - 1]!.id;
    }
  }

  async #go(
    scope: MigrationScope,
    target: number,
    dryRun: boolean,
    opts: RunOptions,
  ): Promise<MigrationReport> {
    if (!Number.isSafeInteger(target) || target < 2)
      throw new DataPlaneError('validation_failed', `${target} is not a version to migrate to`);
    if (!hasCdmSchema(target))
      throw new DataPlaneError('validation_failed', `this process has no schema for CDM ${target}`);
    const records = await this.#records(scope);
    const report: MigrationReport = { dryRun, target, items: [], stopped: false };
    for (const r of records) {
      if (report.stopped || opts.stop?.()) {
        report.stopped = true;
        const item: MigrationItem = { doc: r.id, from: r.cdmVersion, outcome: 'not_reached' };
        report.items.push(item);
        continue;
      }
      const item = await this.#one({ tenant: scope.tenant, doc: r.id }, r, target, dryRun);
      report.items.push(item);
      opts.onItem?.(item);
    }
    return report;
  }

  /**
   * Changes the stored version, then closes the document's room if one is open: its channels heard
   * `sync.reset`, and each reconnects and is judged against the version the document is at now.
   */
  async #finish(ref: DocRef, from: number, target: number): Promise<void> {
    await this.#d.documents.setCdmVersion(ref, from, target);
    const room = this.#d.host.get(ref);
    if (room) await room.shutdown('migrated', true);
  }

  async #one(
    ref: DocRef,
    record: DocumentRecord,
    target: number,
    dryRun: boolean,
  ): Promise<MigrationItem> {
    const from = record.cdmVersion;
    const base = { doc: ref.doc, from };
    if (from === target) return { ...base, outcome: 'current' };
    if (from > target)
      return { ...base, outcome: 'ahead', message: `the document is at CDM ${from}` };
    try {
      // A run that was cut off after the commit: only the version is left to change.
      const tip = await this.#d.logs.head(ref);
      const last = tip.seq > 0 ? (await this.#d.logs.read(ref, tip.seq, tip.seq))[0] : undefined;
      if (last && isSnapshot(last) && last.origin === 'migration' && last.cdm > from) {
        if (last.cdm !== target)
          return {
            ...base,
            outcome: 'refused',
            message: `an earlier migration to CDM ${last.cdm} was stored but not finished`,
          };
        if (dryRun)
          return {
            ...base,
            outcome: 'would_migrate',
            message: 'only the stored version is left to change',
          };
        await this.#finish(ref, from, target);
        return { ...base, outcome: 'migrated', seq: last.seq };
      }
      const { seq: head, envelope } = await this.#d.host.headContent(ref);
      const result = migrate(
        envelope as unknown as Record<string, unknown>,
        this.#d.migrations,
        target,
      );
      if (!result.ok) return { ...base, outcome: 'refused', message: result.message };
      const migrated = result.envelope as unknown as JsonEnvelope;
      // The same check a room makes before it opens a document of that version.
      try {
        schemaForCdm(target).nodeFromJSON(migrated.doc).check();
      } catch (e) {
        return {
          ...base,
          outcome: 'refused',
          message: `the migrated document is not valid CDM ${target}: ${(e as Error).message}`,
        };
      }
      if (dryRun) return { ...base, outcome: 'would_migrate', steps: result.steps };
      const encoded = await this.#d.host.encode(migrated);
      const id = derivedCommitId(
        'migration',
        ref.tenant,
        ref.doc,
        String(from),
        String(target),
        String(head),
        encoded.hash,
      );
      const delivered = await this.#d.host.apply(ref, {
        kind: 'snapshot',
        id,
        reason: 'migration',
        actor: 'system',
        content: { ...encoded, envelope: migrated },
        migration: { cdm: target },
        preconditions: { head },
      });
      await this.#finish(ref, from, target);
      return { ...base, outcome: 'migrated', seq: delivered.seq };
    } catch (e) {
      const message =
        e instanceof RequestRefused
          ? `${e.rejection.code}: ${e.rejection.reason}`
          : (e as Error).message;
      return { ...base, outcome: 'refused', message };
    }
  }
}
