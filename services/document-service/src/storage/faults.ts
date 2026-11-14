/**
 * Faults of the S3 simulation (packages/authority/test/harness/storage.ts) applied to the real
 * PostgreSQL write, for SYN-047 and for the fault hooks of BE-079. As in the in-memory storage,
 * the conditions come first: a stale epoch, head or revision is reported as such whatever the
 * fault. Then:
 *
 * - `fail`: the transaction is rolled back, either before anything is inserted or after the
 *   inserts and before COMMIT; the room is told `failed`.
 * - `unknown-applied`: the transaction commits and the answer is dropped; the store reads the log
 *   back as it does for a real unknown outcome, and the room is told `unknown` with that tail.
 * - `unknown-lost`: the transaction is rolled back after the inserts, and the room is told
 *   `unknown` with the tail read back.
 */
import type { WriteRequest, WriteResult } from '@docedit/authority';
import type { PgLogStore } from './log-store.ts';
import type { DocRef } from './types.ts';

export type Fault = 'none' | 'fail' | 'unknown-applied' | 'unknown-lost';
export type FailPoint = 'before-insert' | 'before-commit';

export async function appendWithFault(
  store: PgLogStore,
  ref: DocRef,
  req: WriteRequest,
  fault: Fault,
  failAt: FailPoint = 'before-commit',
): Promise<WriteResult> {
  switch (fault) {
    case 'none':
      return store.append(ref, req);
    case 'fail':
      return store.append(
        ref,
        req,
        failAt === 'before-insert'
          ? { beforeInsert: () => Promise.resolve('rollback') }
          : { beforeCommit: () => Promise.resolve('rollback') },
      );
    case 'unknown-applied': {
      const r = await store.append(ref, req);
      return r.status === 'ok' ? store.resolveUnknown(ref, req.fromSeq) : r;
    }
    case 'unknown-lost': {
      let rolledBack = false;
      const r = await store.append(ref, req, {
        beforeCommit: () => {
          rolledBack = true;
          return Promise.resolve('rollback');
        },
      });
      return rolledBack ? store.resolveUnknown(ref, req.fromSeq) : r;
    }
  }
}
