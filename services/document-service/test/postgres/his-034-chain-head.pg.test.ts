// HIS-034 criterion 3 (lane V-HIS-033-046): the chain head of the state at a `seq` is the stored hash
// of the commit at that `seq` (PgLogStore.chainHeadAt). It is the head's chain head at the head,
// the hash the next commit names as its prev_hash below it, and null where there is no commit.
// PostgreSQL in Podman (docedit-test-postgres); each run makes its own database and drops it.
// Skips when PostgreSQL is not up (infra/test-env.ps1 up).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgLogStore } from '../../src/index.ts';
import {
  controlCommit,
  newDocument,
  stepCommit,
  write,
  type StoreHarness,
} from '../contract/checks.ts';
import {
  createTestDatabase,
  newTenant,
  pgStores,
  postgresUnavailable,
  type TestDatabase,
} from '../support/env.ts';

const skip = await postgresUnavailable();
if (skip) console.warn(`skipped: ${skip}`);

describe.skipIf(skip !== null)(
  'the chain head of a state at a seq (HIS-034 criterion 3, PostgreSQL)',
  () => {
    let db: TestDatabase;
    let h: StoreHarness;

    beforeAll(async () => {
      db = await createTestDatabase();
      const s = pgStores(db.service);
      h = {
        tenant: newTenant(),
        otherTenant: newTenant(),
        docs: s.docs,
        logs: s.logs,
        grants: s.grants,
      };
    });
    afterAll(() => db?.drop());

    it('names the stored hash of the commit at each seq, and the head chain head at the head', async () => {
      const { ref, epoch } = await newDocument(h);
      const logs = h.logs as PgLogStore;
      expect(await logs.append(ref, write(epoch, [stepCommit(1), stepCommit(2)]))).toEqual({
        status: 'ok',
      });
      expect(await logs.append(ref, write(epoch, [controlCommit(3, 1)]))).toEqual({ status: 'ok' });

      const at1 = await logs.chainHeadAt(ref, 1);
      const at2 = await logs.chainHeadAt(ref, 2);
      const at3 = await logs.chainHeadAt(ref, 3);
      for (const hash of [at1, at2, at3]) expect(hash).toMatch(/^[0-9a-f]{64}$/);
      // Distinct commits have distinct chain heads.
      expect(new Set([at1, at2, at3]).size).toBe(3);
      // At the head the chain head is the head's own chain head (BE-079 state).
      const state = await logs.state(ref);
      expect(at3).toBe(state.chainHead);
    });

    it('is null where the log has no commit, and never reads another tenant (the tenant scope)', async () => {
      const { ref, epoch } = await newDocument(h);
      const logs = h.logs as PgLogStore;
      expect(await logs.chainHeadAt(ref, 1)).toBeNull();
      expect(await logs.append(ref, write(epoch, [stepCommit(1)]))).toEqual({ status: 'ok' });
      expect(await logs.chainHeadAt(ref, 1)).toMatch(/^[0-9a-f]{64}$/);
      // The same document under another tenant has no commit visible to it.
      expect(await logs.chainHeadAt({ tenant: h.otherTenant, doc: ref.doc }, 1)).toBeNull();
    });
  },
);
