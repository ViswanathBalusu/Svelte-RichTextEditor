/**
 * Bulk send (12 §9, §10; FRW-063; docs/adr/0407-w4-FRW-063-bulk-send.md, proposed). A bulk send is a
 * job of the queue that makes one fork of a template for each recipient row, at one pinned seq.
 *
 * - `POST /bulk-sends` takes the template, an optional `templateSeq` and the rows. The request is
 *   checked (the template, the pinned seq through the history gate, the shape of the rows), the job
 *   is queued, and the answer is 202 with the bulk send. A repeat of the request with the same
 *   `Idempotency-Key` is answered from the stored response by the pipeline, so no second job and no
 *   second fork is made.
 * - `GET /bulk-sends/{bid}` gives the state and, when the job has finished, each row with the new
 *   document or the failure.
 * - The job (`bulkSendHandler`) makes the documents one row at a time with `createFromTemplate`, as
 *   `POST /documents` with a template does. A row that fails is reported with the code and the
 *   violations the single call would have answered, and the other rows go on. The document of row
 *   `i` has an identifier derived from the job and `i`, so a row that was made already is reported
 *   as made and never made twice.
 * - Both routes need a service credential, as instantiation does.
 * - The recipient rows a tenant submits in a UTC calendar month are limited by the quota
 *   `bulkSendRows` (owner decision 265): a request that would take the month's rows past it is
 *   refused with `quota_exceeded` and a `Retry-After` to the start of next month, before any job is
 *   queued. The rows used are read from the job queue, so they hold on every node.
 */
import { createHash } from 'node:crypto';
import { formatTimestamp } from '@docedit/model';
import {
  DocumentNotFoundError,
  DuplicateExternalIdError,
  type DocumentRecord,
} from '../storage/types.ts';
import { createFromTemplate, pinTemplate, type FromTemplateBody } from './template-routes.ts';
import { JobFailure, type JobHandler } from './jobs/runner.ts';
import type { JobRecord } from './jobs/queue.ts';
import { json, type HandlerDeps, type Kit } from './kit.ts';
import { monthBounds, secondsToNextMonth } from './exp-009-compile-budget.ts';
import type { QuotaSource } from './live-quotas.ts';
import type { JobQueue } from './jobs/queue.ts';
import { type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

export const BULK_SEND_KIND = 'workflow.bulk_send';

/**
 * The most rows one request may hold. A setting of this build for the size of the job's payload,
 * not a figure of the spec and not a tenant quota (see the ADR).
 */
export const BULK_SEND_MAX_ROWS = 1_000;

export interface BulkSendRefusal {
  /** The `Retry-After` of the refusal, in seconds. */
  retryAfterS: number;
  usedRows: number;
  budgetRows: number;
}

/**
 * The monthly limit on the recipient rows of a tenant's bulk sends (the quota `bulkSendRows`; owner
 * decision 265: rows per calendar month in UTC, like other usage). The rows used are the rows of
 * the bulk-send jobs created in the month, as the queue holds them, whatever their state: a row
 * that fails still was submitted. A limit that is not set (`null`) is no limit.
 */
export class BulkSendBudget {
  readonly #quotas: QuotaSource | null;
  readonly #queue: JobQueue;

  constructor(quotas: QuotaSource | null, queue: JobQueue) {
    this.#quotas = quotas;
    this.#queue = queue;
  }

  /** The rows a tenant has submitted in the UTC month containing `now`. */
  usedRows(tenant: string, now: number): Promise<number> {
    const { from, to } = monthBounds(now);
    return this.#queue.payloadItems(tenant, BULK_SEND_KIND, 'rows', from, to);
  }

  /** The monthly limit of a tenant in rows, or `null` when none is set. */
  budgetRows(tenant: string): number | null {
    return this.#quotas?.get(tenant).bulkSendRows ?? null;
  }

  /** `null` when a request of `rows` rows may go ahead; otherwise the refusal to give. */
  async refusal(tenant: string, rows: number, now: number): Promise<BulkSendRefusal | null> {
    const budget = this.budgetRows(tenant);
    if (budget === null) return null;
    const used = await this.usedRows(tenant, now);
    if (used + rows <= budget) return null;
    return { retryAfterS: secondsToNextMonth(now), usedRows: used, budgetRows: budget };
  }
}

const ROW_MEMBERS = [
  'participants',
  'values',
  'title',
  'externalId',
  'properties',
  'classification',
] as const;

/** The identifier of the document made for row `index` of a job: the same every time. */
export function bulkRowDocumentId(job: string, index: number): string {
  const h = createHash('sha256').update(`bulk-send:${job}:${index}`).digest('hex');
  const variant = ((parseInt(h.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-7${h.slice(13, 16)}-${variant}${h.slice(18, 20)}-${h.slice(20, 32)}`;
}

interface RowResult {
  index: number;
  document: string | null;
  error?: {
    code: string;
    message: string;
    violations?: readonly { path: string; rule: string }[];
  };
}

/** The failure of a row, as the single call would have answered it. Never a value of the row. */
function failureOf(e: unknown): NonNullable<RowResult['error']> {
  if (e instanceof ApiError)
    return {
      code: e.code,
      message: e.message,
      ...(e.violations !== undefined ? { violations: e.violations } : {}),
    };
  if (e instanceof DuplicateExternalIdError)
    return { code: 'conflict', message: 'a document of the tenant has this externalId (D62)' };
  if (e instanceof DocumentNotFoundError) return { code: 'not_found', message: 'no such document' };
  return { code: 'internal', message: 'the row could not be made' };
}

const wire = (job: JobRecord) => {
  const rows = (job.payload['rows'] as unknown[] | undefined)?.length ?? 0;
  const result = job.result as { rows?: RowResult[] } | null;
  return {
    id: job.id,
    template: job.payload['template'] as string,
    seq: job.payload['seq'] as number,
    state: job.state,
    total: rows,
    done:
      job.state === 'completed'
        ? rows
        : Math.min(rows, Math.floor(((job.progress ?? 0) / 100) * rows)),
    ...(result?.rows !== undefined ? { rows: result.rows } : {}),
    ...(job.error !== null ? { error: job.error } : {}),
    createdAt: formatTimestamp(job.createdAt),
    ...(job.finishedAt !== null ? { finishedAt: formatTimestamp(job.finishedAt) } : {}),
  };
};

export function bulkSendRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;
  const serviceOnly = (ctx: Ctx): void => {
    if (ctx.caller.kind !== 'service')
      throw new ApiError('forbidden', 'bulk sends are a service-credential resource (12 §9)');
  };

  // The check of the quota and the queueing of the job are one step for a tenant on this node, so
  // two requests of one tenant do not both pass the check on the same month's figure. Across nodes
  // the figure is the queue's, and a race between nodes can pass the limit by one request.
  const tails = new Map<string, Promise<unknown>>();
  const inTurn = <T>(tenant: string, step: () => Promise<T>): Promise<T> => {
    const run = (tails.get(tenant) ?? Promise.resolve()).then(step, step);
    const tail = run.catch(() => undefined);
    tails.set(tenant, tail);
    void tail.then(() => {
      if (tails.get(tenant) === tail) tails.delete(tenant);
    });
    return run;
  };

  const createBulkSend: Handler = async (ctx) => {
    serviceOnly(ctx);
    const body = (await ctx.body()) as {
      template: string;
      templateSeq?: number;
      rows: unknown[];
    };
    if (body.rows.length === 0 || body.rows.length > BULK_SEND_MAX_ROWS)
      throw new ApiError(
        'validation_failed',
        'a bulk send has at least one row and a bounded number',
        {
          violations: [{ path: '/rows', rule: `1 to ${BULK_SEND_MAX_ROWS} rows` }],
        },
      );
    const violations = body.rows.flatMap((row, i) =>
      typeof row === 'object' && row !== null && !Array.isArray(row)
        ? Object.keys(row)
            .filter((m) => !(ROW_MEMBERS as readonly string[]).includes(m))
            .map((m) => ({ path: `/rows/${i}/${m}`, rule: 'a member of a recipient row' }))
        : [{ path: `/rows/${i}`, rule: 'an object' }],
    );
    if (violations.length > 0)
      throw new ApiError('validation_failed', 'a row is not valid', { violations });
    // The template and the pinned seq are checked now, once; the rows are checked by the job.
    const pinned = await pinTemplate(k, ctx, body.template, body.templateSeq);
    const tenant = ctx.caller.tenant;
    const job = await inTurn(tenant, async () => {
      // The tenant's monthly limit on recipient rows (decision 265): refused before any job.
      await d.quotaSource?.load?.(tenant);
      const spent = await d.bulkSendBudget?.refusal(tenant, body.rows.length, d.now());
      if (spent)
        throw new ApiError(
          'quota_exceeded',
          'the tenant would pass its recipient rows for this month',
          { retryAfterS: spent.retryAfterS, quota: 'bulkSendRows' },
        );
      return d.queue.enqueue(tenant, {
        kind: BULK_SEND_KIND,
        createdBy: ctx.caller.actor,
        // A retry would make no second document (the identifiers derive from the job), but it would
        // report the first run's rows again as made: one attempt keeps the report true.
        maxAttempts: 1,
        payload: { template: pinned.template.id, seq: pinned.atSeq, rows: body.rows },
      });
    });
    d.onJobQueued?.();
    return json(202, wire(job), { Location: `${k.rest}/bulk-sends/${job.id}` });
  };

  const getBulkSend: Handler = async (ctx) => {
    serviceOnly(ctx);
    const job = await d.queue.get(ctx.caller.tenant, ctx.params['bid']!);
    if (job === null || job.kind !== BULK_SEND_KIND)
      throw new ApiError('not_found', `no bulk send ${ctx.params['bid']!}`);
    return json(200, wire(job));
  };

  return { createBulkSend, getBulkSend };
}

/**
 * The handler of the job. `getDeps` is read when a job runs, not when the handler is made: the
 * control plane's dependencies are built after the runners are.
 */
export function bulkSendHandler(getDeps: () => HandlerDeps | null): JobHandler {
  return async (job, ctx) => {
    const d = getDeps();
    if (d === null || !d.templates)
      throw new JobFailure('unavailable', 'the control plane is not ready', true);
    const payload = job.payload as { template: string; seq: number; rows: FromTemplateBody[] };
    const template = await d.templates.get(job.tenant, payload.template);
    if (template === null) throw new JobFailure('not_found', 'the template is gone');
    const source = { tenant: job.tenant, doc: template.doc };
    // The seq was checked against the history gate when the request was accepted.
    const head = await d.logs.head(source);
    const full = await d.content.rebuild(source, head.incarnation, payload.seq);
    const content = { cdm: full.cdm, requires: full.requires, doc: full.doc };

    const rows: RowResult[] = [];
    for (let index = 0; index < payload.rows.length; index++) {
      const id = bulkRowDocumentId(job.id, index);
      try {
        let made: DocumentRecord | null = await d.documents.get({ tenant: job.tenant, doc: id });
        if (made === null)
          made = await createFromTemplate(d, {
            tenant: job.tenant,
            actor: job.createdBy,
            id,
            template,
            atSeq: payload.seq,
            full: content,
            body: payload.rows[index]!,
          });
        rows.push({ index, document: made.id });
      } catch (e) {
        rows.push({ index, document: null, error: failureOf(e) });
      }
      const beat = await ctx.report('rows', Math.floor(((index + 1) / payload.rows.length) * 100));
      if (beat !== 'ok') throw new JobFailure('conflict', 'the bulk send was cancelled');
    }
    return {
      rows,
      created: rows.filter((r) => r.document !== null).length,
      failed: rows.filter((r) => r.document === null).length,
    };
  };
}
