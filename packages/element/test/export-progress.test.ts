// The export job's reports (PRO-086, criterion 2): startExport passes onProgress to the exports
// port, and exportEvent maps each job report to the event the element raises, with the identifiers
// and the state only. The port is a stand-in that calls onProgress as a real port would (PRO-096).
// Lane U-PRO-086-102; the decision on cancelled jobs is in docs/adr/0314-lane-U-PRO-086-102.md.
import type { Backend, ExportJob, ExportsPort } from '@docedit/protocol';
import { describe, expect, it } from 'vitest';
import { exportEvent, startExport, type ExportRequest } from '../src/export.ts';

function job(state: ExportJob['state'], progress: number | null = null): ExportJob {
  return {
    id: 'job-7',
    doc: 'doc-1',
    target: 'pdf',
    seq: 3,
    state,
    progress,
  } as unknown as ExportJob;
}

/** A stand-in port that reports the given states through onProgress, then resolves the first one. */
function reportingExports(states: ExportJob['state'][]) {
  const optsSeen: Array<{ onProgress?: (j: ExportJob) => void } | undefined> = [];
  const port: ExportsPort = {
    async request(_docId, _body, opts) {
      optsSeen.push(opts);
      for (const s of states) opts?.onProgress?.(job(s, s === 'compiling' ? 40 : null));
      return job(states[0] ?? 'queued');
    },
    async get() {
      throw new Error('not used');
    },
    async cancel() {},
  };
  return { port, optsSeen };
}

const backendWith = (port: ExportsPort): Backend =>
  Object.assign({ features: new Set(['exports']) } as unknown as Backend, { exports: port });

describe('the export reports (PRO-086, criterion 2)', () => {
  it('passes onProgress to the exports port, and leaves the request unchanged without it', async () => {
    const { port, optsSeen } = reportingExports(['queued']);
    const seen: string[] = [];
    await startExport(
      { docId: 'doc-1', backend: backendWith(port) },
      { target: 'pdf' } as ExportRequest,
      (j) => seen.push(j.state),
    );
    expect(seen).toEqual(['queued']);
    expect(typeof optsSeen[0]?.onProgress).toBe('function');
    await startExport({ docId: 'doc-1', backend: backendWith(port) }, {
      target: 'pdf',
    } as ExportRequest);
    expect(optsSeen[1]).toBeUndefined();
  });

  it('maps queued, converting and compiling to de-export-progress with identifiers and state only', () => {
    expect(exportEvent(job('queued'))).toEqual({
      name: 'de-export-progress',
      detail: { jobId: 'job-7', state: 'queued', progress: null },
    });
    expect(exportEvent(job('compiling', 40))).toEqual({
      name: 'de-export-progress',
      detail: { jobId: 'job-7', state: 'compiling', progress: 40 },
    });
    expect(exportEvent(job('converting')).name).toBe('de-export-progress');
  });

  it('maps completed to de-export-completed, and failed or cancelled to de-export-failed', () => {
    expect(exportEvent(job('completed')).name).toBe('de-export-completed');
    expect(exportEvent(job('failed')).name).toBe('de-export-failed');
    expect(exportEvent(job('cancelled'))).toEqual({
      name: 'de-export-failed',
      detail: { jobId: 'job-7', state: 'cancelled', progress: null },
    });
  });

  it('carries no field other than the job identifier, state and progress', () => {
    const ev = exportEvent({
      ...job('compiling', 10),
      result: { url: 'https://x' },
      diagnostics: [{ text: 'secret' }],
    } as unknown as ExportJob);
    expect(Object.keys(ev.detail).sort()).toEqual(['jobId', 'progress', 'state']);
  });
});
