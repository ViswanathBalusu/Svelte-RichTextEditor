// The raw log goes with the artefacts of its job (EXP-066 criterion 4). The log is stored under the
// job's prefix beside the result, so the purge of a document, which deletes that prefix, removes it.
// The signed URL of the log carries the expiry of the result's URL (exp-066-raw-log.test.ts).
import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { MemoryAudit } from '../../src/data-plane/memory-ports.ts';
import { DAY_MS, DocumentPurge, type PurgeStore } from '../../src/control-plane/document-purge.ts';
import { MemoryObjectStore, objectKeys } from '../../src/objects/store.ts';

const NOW = 1_800_000_000_000;

describe('the log of an export job leaves with its artefacts (EXP-066 criterion 4)', () => {
  it('deletes output, layout, log and manifest of every job of a purged document', async () => {
    const tenant = randomUUID();
    const doc = randomUUID();
    const job = randomUUID();
    const otherJob = randomUUID();
    const objects = new MemoryObjectStore();
    const body = new TextEncoder().encode('x');
    for (const name of ['output.pdf', 'layout.json', 'compile.log', 'manifest.json'])
      await objects.put(objectKeys.exportFile(tenant, job, name), body);
    // The log of a job of another document stays.
    await objects.put(objectKeys.exportFile(tenant, otherJob, 'compile.log'), body);

    let removed = false;
    const store: PurgeStore = {
      deleted: async () => (removed ? [] : [{ doc, deletedAt: NOW - 31 * DAY_MS }]),
      assets: async () => [],
      jobs: async () => [job],
      sealed: async () => [],
      remove: async () => {
        removed = true;
      },
    };
    const purge = new DocumentPurge({
      store,
      objects,
      audit: new MemoryAudit(),
      retentionMs: 30 * DAY_MS,
      now: () => NOW,
    });

    expect(await objects.exists(objectKeys.exportFile(tenant, job, 'compile.log'))).toBe(true);
    const result = await purge.run(tenant);
    expect(result.purged).toEqual([doc]);
    expect(await objects.list(objectKeys.exports(tenant, job))).toEqual([]);
    expect(await objects.exists(objectKeys.exportFile(tenant, job, 'compile.log'))).toBe(false);
    expect(await objects.exists(objectKeys.exportFile(tenant, otherJob, 'compile.log'))).toBe(true);
  });
});
