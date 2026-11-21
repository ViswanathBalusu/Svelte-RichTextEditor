/**
 * EXP-008 criterion 2 through the control plane with the real worker (Node.js; no Podman): three
 * viewers ask for previews of one document, and the compiles start at least a preview window
 * apart. Only the sandbox is a stand-in; it records when it was called.
 *
 * The first preview is made to take longer than the window to reach its compile, and the worker
 * has a second slot free all the time. A rule that counts from the request, or from the moment a
 * worker takes the job, would start the second compile before or just after the first here. The
 * queue's start gap counts from the moment a job reports the stage `compiling`, and holds the
 * document's other previews until it has (ADR 0421). The window is 300 ms in this test; the
 * default is the ten seconds of 06 §10.
 */
import type { JobRecord } from '@docedit/document-service';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LIMITS, type CompileResult, type SandboxOptions } from '../src/sandbox.ts';
import { createExportWorker, type ExportWorker } from '../src/worker.ts';
import { demoDocument } from './documents.ts';
import { TEST_FONTS } from './fonts.ts';
import { startTestService, type TestService } from './service.ts';

const WINDOW_MS = 300;
/**
 * How long the first preview takes before its compile: much longer than the window, and long
 * enough for the two requests that follow it to arrive first on a busy machine.
 */
const SLOW_MS = 1500;

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe('EXP-008 the preview window, through the control plane and the worker', () => {
  let t: TestService;
  let worker: ExportWorker;
  let slowNext = false;
  /** When the sandbox stand-in was called, by the `tagging` option of the bundle it was given. */
  const sandboxAt = new Map<string, number>();

  beforeAll(async () => {
    t = await startTestService({ config: { previewWindowMs: WINDOW_MS } });
    worker = createExportWorker({
      queue: t.service.parts.queue,
      deps: {
        stores: {
          logs: t.service.parts.logs,
          checkpoints: t.service.checkpoints,
          documents: t.service.parts.documents,
        },
        outputs: t.service.assets,
        // The font manifest is read before the conversion: a slow read makes a slow way to the
        // compile, without touching the handler.
        fonts: async () => {
          if (slowNext) {
            slowNext = false;
            await sleep(SLOW_MS);
          }
          return TEST_FONTS;
        },
        imageId: async () => `sha256:${'b'.repeat(64)}`,
        compile: async (
          files: Readonly<Record<string, string | Uint8Array>>,
          opts: SandboxOptions,
        ): Promise<CompileResult> => {
          const called = Date.now();
          const manifest = JSON.parse(String(files['manifest.json'])) as {
            options: { tagging: string };
          };
          sandboxAt.set(manifest.options.tagging, called);
          const n = opts.maxPasses ?? 1;
          return {
            ok: true,
            exitCode: 0,
            timedOut: false,
            outputOverflow: false,
            cancelled: false,
            passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 5 })),
            converged: n > 1,
            pdf: new TextEncoder().encode('%PDF-2.0 test'),
            log: 'This is LuaHBTeX\n',
            layoutRaw: RAW_LAYOUT,
            stderr: '',
            wallMs: 10,
            stdout: new Uint8Array(),
            name: 'docedit-exp-008-window',
            limits: { ...LIMITS },
            passTimeoutSeconds: 110,
          };
        },
      },
      worker: 'export-exp-008-window',
      leaseMs: 3000,
      idleMs: 10,
      retryAfterMs: 1000,
      // Two jobs at once: a free slot is there whenever a preview becomes due.
      concurrency: 2,
    });
    worker.start();
  });

  afterAll(async () => {
    await worker?.stop();
    await t?.close();
  });

  const ask = async (doc: string, token: string, tagging: string) => {
    const r = await t.call('POST', `/v1/documents/${doc}/exports`, {
      token,
      body: { target: 'pdf', options: { profile: 'preview', tagging } },
    });
    expect(r.status, r.text).toBe(202);
    return r.json.id as string;
  };

  async function reach(id: string, token: string, states: string[]): Promise<void> {
    for (let i = 0; i < 1000; i++) {
      const r = await t.call('GET', `/v1/exports/${id}`, { token });
      if (states.includes(r.json?.state)) return;
      await sleep(10);
    }
    throw new Error(`job ${id} did not reach ${states.join(' or ')}`);
  }

  it('starts the compiles of three viewers a window apart, also when the first is slow to reach its compile (criterion 2)', async () => {
    const doc = await t.createDocument(demoDocument().envelope);
    const viewers = [
      { token: t.userToken({ [doc]: 'editor' }, 'alice'), tagging: 'off' },
      { token: t.userToken({ [doc]: 'editor' }, 'eva'), tagging: 'draft' },
      { token: t.userToken({ [doc]: 'editor' }, 'max'), tagging: 'on' },
    ];
    slowNext = true;
    const ids: string[] = [];
    ids.push(await ask(doc, viewers[0]!.token, viewers[0]!.tagging));
    await reach(ids[0]!, viewers[0]!.token, ['converting']);
    // Two more viewers ask while the first preview is on its way to its compile.
    ids.push(await ask(doc, viewers[1]!.token, viewers[1]!.tagging));
    ids.push(await ask(doc, viewers[2]!.token, viewers[2]!.tagging));
    for (const [i, id] of ids.entries())
      await reach(id, viewers[i]!.token, ['completed', 'failed']);

    const records: JobRecord[] = [];
    for (const id of ids) records.push((await t.service.parts.queue.get(t.tenant, id))!);
    for (const r of records) expect(r.state, JSON.stringify(r.error)).toBe('completed');
    // Every one of them compiled: three different requests, three sandboxes.
    expect([...sandboxAt.keys()].sort()).toEqual(['draft', 'off', 'on']);

    // The first preview was claimed at once and reached its compile later than a window after.
    const [first, second, third] = records as [JobRecord, JobRecord, JobRecord];
    expect(first.startedAt! - first.createdAt).toBeGreaterThanOrEqual(SLOW_MS - 20);
    // The other two were asked for before that compile started. The request rule made the second
    // due a window after the first was asked for, which is also before that compile started, and a
    // slot of the worker was free. Both still started a window after the first compile.
    expect(second.createdAt).toBeLessThan(first.startedAt!);
    expect(third.createdAt).toBeLessThan(first.startedAt!);
    expect(first.createdAt + WINDOW_MS).toBeLessThan(first.startedAt!);
    // The recorded starts are the compiles' starts, a window apart, whatever their order.
    const starts = records.map((r) => r.startedAt!).sort((a, b) => a - b);
    expect(starts[0]).toBe(first.startedAt);
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(WINDOW_MS);
    expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(WINDOW_MS);
    // And each sandbox was called at or after the start the queue recorded for its job.
    for (const [i, r] of records.entries())
      expect(sandboxAt.get(viewers[i]!.tagging)!).toBeGreaterThanOrEqual(r.startedAt!);
  }, 60_000);
});
