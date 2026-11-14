/**
 * The indexer job (06 §1 indexer; BE-054 criteria 1, 4 and 5). A checkpoint is written, the job
 * for it is queued, and a job runner calls this handler, which reads the checkpoint's content for
 * one visibility class and indexes its text in `SearchIndex`.
 *
 * What this module holds, and what it does not:
 *
 * - The handler's only dependencies are a checkpoint source and the index (`IndexerDeps`). It has
 *   no key, token, secret or credential parameter, and it imports nothing that opens a network,
 *   file or process connection. The test `search-indexer.test.ts` checks this on the source.
 * - The tenant of every read and write is the tenant of the job row (BE-049 criterion 5), never a
 *   tenant from the payload.
 * - The text is indexed as `extractSearchText` takes it (plain strings; preserved content skipped).
 * - It is not the PostgreSQL search table of BE-011: the index is the in-memory `SearchIndex`, and
 *   the job runs in whatever process the composition gives the runner. Whether that process is off a
 *   room's event loop is the composition's decision and is not shown here (BE-054 criterion 5).
 */
import type { JsonNode } from '@docedit/model';
import type { JobHandler } from './jobs/runner.ts';
import { JobFailure } from './jobs/runner.ts';
import type { JobQueue, JobRecord } from './jobs/queue.ts';
import type { CheckpointInput } from './search-index.ts';

/**
 * Where the indexer writes: the in-memory `SearchIndex` or the PostgreSQL `PgSearchIndex`
 * (search-index-pg.ts, BE-054 criterion 1). A promise is awaited.
 */
export interface IndexTarget {
  indexCheckpoint(input: CheckpointInput): boolean | Promise<boolean>;
}

/** The job kind of the indexer (lower-case, as the queue requires). */
export const SEARCH_INDEX_KIND = 'search-index';

/**
 * Reads one checkpoint's content as one visibility class may read it, or null when there is no
 * checkpoint at that sequence. The tenant is passed explicitly, so the source cannot be asked for
 * another tenant's content by a payload.
 */
export interface CheckpointSource {
  readCheckpoint(
    tenant: string,
    doc: string,
    seq: number,
    visibility: string,
  ): Promise<JsonNode | null>;
}

/** The only things the indexer may use. */
export interface IndexerDeps {
  readonly checkpoints: CheckpointSource;
  readonly index: IndexTarget;
}

/** The payload a job of the indexer carries. The tenant is the row's, not this. */
export interface IndexJobPayload {
  readonly doc: string;
  readonly seq: number;
  readonly visibility: string;
}

/** Builds the handler for `SEARCH_INDEX_KIND`; register it with the runner's handlers. */
export function createSearchIndexHandler(deps: IndexerDeps): JobHandler {
  return async (job: JobRecord) => {
    const payload = readPayload(job.payload);
    const doc = job.doc ?? payload.doc;
    if (doc !== payload.doc)
      throw new JobFailure('validation_failed', 'the job names another document');
    const content = await deps.checkpoints.readCheckpoint(
      job.tenant,
      payload.doc,
      payload.seq,
      payload.visibility,
    );
    if (content === null)
      throw new JobFailure('not_found', 'no checkpoint at that sequence', false);
    const stored = await deps.index.indexCheckpoint({
      tenant: job.tenant,
      doc: payload.doc,
      seq: payload.seq,
      visibility: payload.visibility,
      content,
    });
    return { indexed: stored, seq: payload.seq };
  };
}

/**
 * Queues the indexing of one checkpoint for a tenant. The tenant is recorded on the job row by the
 * queue; the payload carries only the document, the sequence and the class.
 */
export async function enqueueIndexing(
  queue: JobQueue,
  tenant: string,
  payload: IndexJobPayload,
): Promise<JobRecord> {
  if (!Number.isSafeInteger(payload.seq) || payload.seq < 0)
    throw new RangeError('a checkpoint sequence is a non-negative integer');
  if (payload.visibility.length === 0) throw new RangeError('a visibility class is named');
  return queue.enqueue(tenant, {
    doc: payload.doc,
    kind: SEARCH_INDEX_KIND,
    payload: { doc: payload.doc, seq: payload.seq, visibility: payload.visibility },
    createdBy: 'system',
  });
}

function readPayload(raw: Record<string, unknown>): IndexJobPayload {
  const { doc, seq, visibility } = raw;
  if (typeof doc !== 'string' || typeof visibility !== 'string' || typeof seq !== 'number')
    throw new JobFailure(
      'validation_failed',
      'an indexing job names a document, a sequence and a class',
    );
  if (!Number.isSafeInteger(seq) || seq < 0)
    throw new JobFailure('validation_failed', 'a checkpoint sequence is a non-negative integer');
  return { doc, seq, visibility };
}
