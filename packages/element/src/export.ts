/**
 * `requestExport` (05 §8.1; PRO-086): starts an export job of the loaded document through the
 * backend's exports port, which is the route of PRO-063 (`POST /documents/{id}/exports`). The
 * element forwards the options unchanged, so the server checks the target, the `seq` and the
 * caller's access as it does for any request (PRO-063; PRM-041, phase 1b).
 *
 * The element refuses without sending when no document is loaded, when the backend has no exports
 * port, and when it has the port but did not announce the `exports` feature (05 §8.3; the client
 * does not use a route the server did not announce). A refusal from the server reaches the host
 * with its own registry code. No DOM: the element passes its current session, so this runs in
 * Node.js tests.
 *
 * The job's progress (PRO-086 criterion 2): with `onProgress`, the exports port reports the job by
 * polling (PRO-096), and `exportEvent` maps each report to the event the element raises
 * (`de-export-progress`, `de-export-completed` or `de-export-failed`) with the job's identifiers and
 * state only. A cancelled job is reported as `de-export-failed`, since it did not complete; this is
 * a choice of lane U-PRO-086-102 (docs/adr/0314-lane-U-PRO-086-102.md).
 *
 * Not here yet (PRO-086, left open): the `no-export` restriction check (PRM-056) and `print()`.
 */
import {
  hasPort,
  PortError,
  type Access,
  type Backend,
  type Body,
  type ExportJob,
} from '@docedit/protocol';

/** The detail of the three `de-export-*` events: identifiers and job state only. */
export interface ExportDetail {
  jobId: string;
  state: string;
  progress: number | null;
}

/** The event a job report raises: the name, and the detail with the job's identifier and state. */
export function exportEvent(job: ExportJob): {
  name: 'de-export-progress' | 'de-export-completed' | 'de-export-failed';
  detail: ExportDetail;
} {
  const detail: ExportDetail = { jobId: job.id, state: job.state, progress: job.progress };
  if (job.state === 'completed') return { name: 'de-export-completed', detail };
  if (job.state === 'failed' || job.state === 'cancelled')
    return { name: 'de-export-failed', detail };
  return { name: 'de-export-progress', detail };
}

/** The body of `POST /documents/{id}/exports`: `target`, optional `seq` and `options`. */
export type ExportRequest = Body<'createExport'>;

/** The part of a session this needs: the document and its backend, once connected. */
export interface ExportSource {
  readonly docId: string;
  readonly backend: Backend | null;
  /** The access in force now; a `no-export` restriction refuses the request (UX-040, PRM-056). */
  readonly access?: Access | null;
}

/** Creates an export job and resolves its identifier (PRO-086). Rejects with a `PortError`. */
export async function startExport(
  source: ExportSource | null,
  options: ExportRequest,
  onProgress?: (job: ExportJob) => void,
): Promise<{ jobId: string }> {
  if (!source?.backend) throw new PortError('unavailable', 'no document is loaded');
  if (source.access?.restrictions.includes('no-export'))
    throw new PortError('forbidden', 'exporting is restricted for this access', {
      details: { reason: 'no-export' },
    });
  const backend = source.backend;
  const exports = backend.exports;
  if (!exports || !hasPort(backend, 'exports'))
    throw new PortError('unsupported_feature', 'the backend announces no export jobs');
  const job = onProgress
    ? await exports.request(source.docId, options, { onProgress })
    : await exports.request(source.docId, options);
  return { jobId: job.id };
}
