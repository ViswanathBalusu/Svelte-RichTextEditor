/**
 * Scale-down drains a running job (EXP-077 criterion 3; 09 §9.5). A worker that is asked to stop
 * while it runs a job (SIGTERM from an orchestrator, which `src/main.ts` turns into
 * `ExportWorker.stop()`) finishes that job first: `stop()` resolves only after the job is
 * `completed`, and the stopped worker claims no later job.
 *
 * Needs Podman and the worker image (skips otherwise). The export is compiled in the real
 * sandbox. Work of lane w2.
 */
import { randomBytes } from 'node:crypto';
import type { JobRecord } from '@docedit/document-service';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { imageFontManifest } from '../src/fonts.ts';
import { compileInSandbox, IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';
import { createExportWorker, type ExportWorker } from '../src/worker.ts';
import { demoDocument } from './documents.ts';
import { startTestService, type TestService } from './service.ts';

vi.setConfig({ testTimeout: 420_000, hookTimeout: 180_000 });

const ready = await sandboxReady();

describe.skipIf(!ready.ok)(
  `EXP-077 a scale-down finishes the running job first (${ready.reason})`,
  () => {
    let t: TestService;
    let worker: ExportWorker;
    let compiles = 0;

    beforeAll(async () => {
      t = await startTestService();
      const fonts = await imageFontManifest(IMAGE);
      worker = createExportWorker({
        queue: t.service.parts.queue,
        deps: {
          stores: {
            logs: t.service.parts.logs,
            checkpoints: t.service.checkpoints,
            documents: t.service.parts.documents,
          },
          outputs: t.service.assets,
          fonts: async () => fonts,
          compile: (files, opts) => {
            compiles++;
            return compileInSandbox(files, {
              ...opts,
              name: `docedit-job-w2-${randomBytes(4).toString('hex')}`,
            });
          },
        },
        worker: 'export-w2-drain',
        leaseMs: 3000,
        idleMs: 50,
        retryAfterMs: 1000,
      });
      worker.start();
    });

    afterAll(async () => {
      await worker?.stop();
      await t?.close();
    });

    async function request(doc: string, token: string): Promise<string> {
      const created = await t.call('POST', `/v1/documents/${doc}/exports`, {
        token,
        body: { target: 'pdf', options: {} },
      });
      expect(created.status, created.text).toBe(202);
      return created.json.id as string;
    }

    const state = async (id: string): Promise<string> =>
      ((await t.service.parts.queue.get(t.tenant, id)) as JobRecord).state;

    it('resolves stop() only after the running job is completed, and claims no later job', async () => {
      const doc = await t.createDocument(demoDocument().envelope);
      const editor = t.userToken({ [doc]: 'editor' });
      const first = await request(doc, editor);
      // Wait until the worker has claimed the first job and is compiling it.
      for (let i = 0; i < 600 && (await state(first)) === 'queued'; i++)
        await new Promise((r) => setTimeout(r, 50));
      expect(await state(first)).toBe('running');

      // A second job is queued while the first one runs; the stopped worker must not take it.
      const second = await request(doc, editor);
      let stopped = false;
      const stopping = worker.stop().then(() => {
        stopped = true;
      });
      // Right after the request to stop, the job is still running and stop() has not resolved.
      expect(stopped).toBe(false);
      await stopping;
      expect(await state(first)).toBe('completed');
      expect(await state(second)).toBe('queued');
      expect(compiles).toBeGreaterThan(0);
      const compilesAtStop = compiles;
      await new Promise((r) => setTimeout(r, 500));
      expect(compiles).toBe(compilesAtStop);
    });
  },
);
