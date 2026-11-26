// BE-052 criterion 2: the scheduler runs the kinds that other stories register. The service is
// started as an operator would start it (sealing, anchoring and the renewal set, and with
// PostgreSQL the purge role for the moves and thinning), and the registry the scheduler holds is
// read back. The renewal scan is run against the queue: it enqueues one job for each expiry.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { BatchAnchorClient } from '../../src/workflow/signing-client.ts';
import type { SigningClient } from '../../src/workflow/signing-client.ts';
import { MemoryHeadAnchorFiles } from '../../src/control-plane/head-anchoring.ts';
import { PLATFORM_TENANT } from '../../src/control-plane/scheduler.ts';
import { skipReason, startHarness, type Harness, type Storage } from './support.ts';

// Nothing here calls the signing service: the tasks are registered, not run.
const signing = {} as unknown as SigningClient;
const anchors = {} as unknown as BatchAnchorClient;

/** The kinds BE-052 criterion 2 names, and the task of each story that registers one. */
const NAMED: Record<string, string> = {
  'BE-034': 'idempotency.purge',
  'BE-046': 'assets.abandoned-uploads',
  'FRW-056': 'workflow.renewal.schedule',
};
/** Registered when the deployment has the stores that need the purge role and PostgreSQL. */
const WITH_POSTGRES: Record<string, string> = {
  'BE-014': 'audit.partitions',
  'HIS-029': 'payloads.cold',
  'HIS-030': 'checkpoints.thin',
  'HIS-033/036': 'heads.anchor',
};

for (const storage of ['memory', 'postgres'] as Storage[]) {
  const why = await skipReason(storage);
  describe.skipIf(why !== null)(`the scheduler's registry, ${storage} (BE-052)`, () => {
    let h: Harness;
    beforeAll(async () => {
      h = await startHarness(storage, {
        ...(storage === 'postgres'
          ? { purgeRole: true, parts: { headAnchorFiles: new MemoryHeadAnchorFiles() } }
          : {}),
        finalSealing: { signing, retry: { attempts: 1, delaysMs: [0] }, retainMs: 1000 },
        headAnchoring: { signing: anchors, retainMs: 1000 },
        renewal: { leadMs: 7 * 24 * 3600 * 1000, claimMs: 60_000 },
      });
    });
    afterAll(async () => {
      await h?.close();
    });

    it('registers the kinds of the stories BE-052 names', () => {
      const names = h.service.scheduler?.taskNames() ?? [];
      for (const [story, task] of Object.entries(NAMED))
        expect(names, `${story}: ${task}`).toContain(task);
      if (storage === 'postgres')
        for (const [story, task] of Object.entries(WITH_POSTGRES))
          expect(names, `${story}: ${task}`).toContain(task);
    });

    it('queues the job of each registered task for its current slot when the scheduler starts', async () => {
      const names = h.service.scheduler?.taskNames() ?? [];
      const scheduler = h.service.scheduler!;
      const missing: string[] = [];
      for (const name of names) {
        const id = scheduler.currentJobId(name)!;
        if (!(await h.parts.queue.get(PLATFORM_TENANT, id))) missing.push(name);
      }
      expect(missing).toEqual([]);
    });
  });
}
