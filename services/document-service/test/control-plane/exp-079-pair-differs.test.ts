// EXP-079 criterion 4, the workflow half: when the two compiles of a sealing export differ, the
// worker fails the job with `seal_pair_differs` and stores nothing (exp-079-sealing.job.test.ts in
// the export worker). Here the seal step finds that job failed: the workflow stays `completed`,
// nothing is sealed, the audit entry is written and the operator alert is raised, once.
import { uuid7 } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import type { JobRecord } from '../../src/control-plane/jobs/queue.ts';
import { finalExportJobId } from '../../src/workflow/final-export-start.ts';
import { FinalSealer } from '../../src/workflow/final-seal.ts';
import type { OperatorAlert } from '../../src/workflow/seal-and-finalise.ts';
import type { WorkflowResourceView } from '../../src/workflow/workflow-resource.ts';

const tenant = uuid7();
const doc = uuid7();
const ref = { tenant, doc } as never;

const workflow = {
  id: 'w-exp079',
  state: 'completed',
  members: { finalisation: { certificate: false } },
  participants: [{ state: 'completed', completedSeq: 7 }],
} as unknown as WorkflowResourceView;

function setup(job: Partial<JobRecord> | null) {
  const alerts: OperatorAlert[] = [];
  const audit = new MemoryAudit();
  let sealed = 0;
  const jobId = finalExportJobId(ref, workflow)!;
  const sealer = new FinalSealer({
    workflows: { read: async () => workflow },
    queue: { get: async () => (job === null ? null : ({ id: jobId, ...job } as JobRecord)) },
    audit,
    alert: (a: OperatorAlert) => void alerts.push(a),
    now: () => 1_800_000_000_000,
    signing: {
      seal: async () => {
        sealed += 1;
        throw new Error('nothing may be sealed');
      },
    },
    objects: {
      get: async () => {
        sealed += 1;
        return null;
      },
    },
  } as never);
  return { sealer, alerts, audit, sealed: () => sealed };
}

describe('a sealing export whose two compiles differ (EXP-079 criterion 4)', () => {
  const failedPair = {
    state: 'failed',
    payload: { sealing: { completedSeq: 7, chainHead: 'a'.repeat(64) }, seq: 7 },
    error: {
      code: 'internal',
      diagnostics: [{ code: 'seal_pair_differs', severity: 'error', message: 'differ' }],
    },
  } as unknown as Partial<JobRecord>;

  it('stops the run, leaves the workflow completed, audits it and alerts the operator once', async () => {
    const t = setup(failedPair);
    const first = await t.sealer.sealCompletedWorkflow(ref);
    expect(first).toEqual({ status: 'stopped', code: 'compile_pair_differs', retryable: false });
    expect(t.alerts).toHaveLength(1);
    expect(t.alerts[0]).toMatchObject({
      kind: 'workflow.finalisation_stopped',
      tenant,
      doc,
      workflow: 'w-exp079',
      code: 'compile_pair_differs',
      retryable: false,
    });
    const entries = await t.audit.query(tenant, {
      kind: 'workflow.finalisation_failed',
      limit: 10,
    });
    expect(entries).toHaveLength(1);
    // Nothing was fetched or sealed, and asking again does not alert again.
    expect(t.sealed()).toBe(0);
    expect(await t.sealer.sealCompletedWorkflow(ref)).toEqual({
      status: 'gave_up',
      code: 'compile_pair_differs',
    });
    expect(t.alerts).toHaveLength(1);
  });

  it('alerts for any other failed sealing export, with its own code, and leaves other failed exports alone', async () => {
    const other = setup({ ...failedPair, error: { code: 'internal', diagnostics: [] } } as never);
    expect(await other.sealer.sealCompletedWorkflow(ref)).toEqual({
      status: 'stopped',
      code: 'export_failed',
      retryable: false,
    });
    const plain = setup({ state: 'failed', payload: { seq: 7 } } as never);
    expect((await plain.sealer.sealCompletedWorkflow(ref)).status).toBe('waiting');
    expect(plain.alerts).toHaveLength(0);
  });
});
