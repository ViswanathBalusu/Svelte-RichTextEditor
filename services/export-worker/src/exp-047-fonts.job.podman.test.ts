/**
 * EXP-047 criterion 2, at job level, against the worker image (export worker, Podman; lane
 * V-SYN-019-036, fixer of V-EXP-033-048): "Given a hash in the manifest with no matching file, when
 * the job runs, then it fails with a diagnostic and no other font is substituted silently."
 *
 * The export worker is built as main.ts builds it, with the same font check (`imageFontCheck`,
 * image-font-files.ts), which runs `sha256sum` inside the real image over the faces of the job's
 * manifest. The job's manifest is the image's own `fonts.json` with one face changed:
 *
 * - a face whose hash names no file of the image: the job fails with `font_file_missing` for that
 *   face only, before the compile, and stores nothing;
 * - a face that names a real file of the image with another hash: `font_file_mismatch`;
 * - the image's manifest unchanged: the check passes on the real files and the job goes on.
 *
 * The queue and the content stores are in memory and the compile is a fake that counts its calls:
 * the job must stop before any compile, so no font at all is used, let alone another one. The last
 * case reads main.ts to show that the worker process passes this check to the handler.
 *
 * Skipped when the sandbox is not ready here (sandbox-ready.ts); DOCEDIT_REQUIRE_SANDBOX=1 makes it
 * fail instead.
 */
import { readFile } from 'node:fs/promises';
import type { FontManifest } from '@docedit/export-latex';
import { MemoryJobQueue, type JobQueue, type JobRecord } from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { beforeAll, describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import type { ContentStores } from './content.ts';
import { imageFontManifest } from './fonts.ts';
import { checkImageFontFiles, imageFontCheck } from './image-font-files.ts';
import { LIMITS, IMAGE, type CompileResult, type SandboxOptions } from './sandbox.ts';
import { sandboxReady, sandboxRequired } from './sandbox-ready.ts';
import { createExportWorker } from './worker.ts';

const INCARNATION = 'inc-v-syn-019-036-fonts';
const SLOW = 900_000;

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

function stores(envelope: CdmEnvelope): ContentStores {
  return {
    logs: {
      head: async () => ({ seq: 0, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async () => ({ seq: 0, content: envelope as never }),
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Demo',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

function fakeCompile() {
  let calls = 0;
  const compile = async (
    _files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ): Promise<CompileResult> => {
    calls += 1;
    const n = opts.maxPasses ?? 2;
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: new TextEncoder().encode('%PDF-2.0 test'),
      log: 'This is LuaHBTeX\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 1500,
      stdout: new Uint8Array(),
      name: 'docedit-v-syn-019-036-font-test',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, count: () => calls };
}

/** One export job through the worker, with main.ts's font check on the real image. */
async function exportWith(manifest: FontManifest) {
  const stored: string[] = [];
  const probe = fakeCompile();
  const queue: JobQueue = new MemoryJobQueue();
  const worker = createExportWorker({
    queue,
    deps: {
      stores: stores(demoDocument().envelope),
      outputs: {
        putExport: async (_t, _j, name) => {
          stored.push(name);
        },
      },
      fonts: async () => manifest,
      checkFontFiles: imageFontCheck(IMAGE),
      image: IMAGE,
      imageId: async () => `sha256:${'b'.repeat(64)}`,
      compile: probe.compile,
    },
    worker: 'w-v-syn-019-036',
    leaseMs: 600_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const doc = uuid7();
  const job = await queue.enqueue(tenant, {
    kind: 'export',
    doc,
    createdBy: 'user-1',
    payload: {
      doc,
      target: 'pdf',
      seq: 0,
      incarnation: INCARNATION,
      options: {},
      requester: 'user-1',
      role: 'editor',
      view: 'v',
      hiddenRegions: [],
      hiddenValues: [],
    },
  });
  await worker.runOnce();
  const done = (await queue.get(tenant, job.id)) as JobRecord;
  return { job: done, stored, compiles: probe.count() };
}

type Diag = { code: string; message?: string };

function diagnosticsOf(job: JobRecord): Diag[] {
  return (
    (job.result as { diagnostics?: Diag[] } | null)?.diagnostics ??
    (job.error as { diagnostics?: Diag[] } | null)?.diagnostics ??
    []
  );
}

const ready = await sandboxReady();
const skip = !ready.ok && !sandboxRequired();

describe.skipIf(skip)(
  `EXP-047 criterion 2: the job fails on a manifest hash with no file in the image (${ready.reason})`,
  () => {
    let real: FontManifest;
    beforeAll(async () => {
      expect(ready.ok, ready.reason).toBe(true);
      real = await imageFontManifest(IMAGE);
    }, SLOW);

    it(
      "passes the check on the image's own manifest, and the job goes on to the compile",
      async () => {
        const check = await checkImageFontFiles(real, IMAGE);
        expect(check.problems).toEqual([]);
        expect(check.ok).toBe(true);
        const out = await exportWith(real);
        expect(out.job.state, JSON.stringify(out.job.error)).toBe('completed');
        expect(out.compiles).toBe(1);
      },
      SLOW,
    );

    it(
      'fails with font_file_missing for a face whose hash names no file, before the compile, and stores nothing',
      async () => {
        const missing = `${'0'.repeat(63)}1`;
        const family = real.families[0]!;
        const manifest: FontManifest = {
          ...real,
          families: [
            { ...family, regular: { ...family.regular, file: `${missing}.otf`, sha256: missing } },
            ...real.families.slice(1),
          ],
        };
        const out = await exportWith(manifest);
        expect(out.job.state).toBe('failed');
        expect(out.job.error?.code).toBe('unavailable');
        expect(out.compiles, 'no compile ran, so no font was used in its place').toBe(0);
        expect(out.stored).toEqual([]);
        const d = diagnosticsOf(out.job);
        expect(d.map((x) => x.code)).toEqual(['font_file_missing']);
        expect(d[0]?.message).toContain(`${missing}.otf`);
        expect(d[0]?.message).toContain(family.name);
      },
      SLOW,
    );

    it(
      'fails with font_file_mismatch for a face that names a file of the image with another hash',
      async () => {
        const other = 'f'.repeat(64);
        const manifest: FontManifest = { ...real, math: { ...real.math, sha256: other } };
        const out = await exportWith(manifest);
        expect(out.job.state).toBe('failed');
        expect(out.compiles).toBe(0);
        expect(out.stored).toEqual([]);
        const d = diagnosticsOf(out.job);
        expect(d.map((x) => x.code)).toEqual(['font_file_mismatch']);
        expect(d[0]?.message).toContain(real.math.file);
      },
      SLOW,
    );
  },
);

describe('EXP-047 criterion 2: the worker process wires the image font check', () => {
  it('passes imageFontCheck(IMAGE) to the handler in main.ts', async () => {
    const src = await readFile(new URL('./main.ts', import.meta.url), 'utf8');
    expect(src).toContain("import { imageFontCheck } from './image-font-files.ts';");
    expect(src).toMatch(/checkFontFiles: imageFontCheck\(IMAGE\),/);
  });
});
