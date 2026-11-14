/**
 * EXP-047 criterion 2 (export worker, Node.js only, no sandbox): a manifest hash with no matching
 * font file fails the job with a diagnostic, and no other font is put in its place. The job checks
 * the host's font directory through `checkFontFiles` (font-files.ts) before it converts. The compile
 * is replaced by a fake that records its calls, so these tests need no Podman.
 *
 * The third case replaces the check with one that passes. The test manifest's hashes are made up
 * (test/fonts.ts), so no file of a real font can match them; the case shows only that a passing
 * check does not stop the job.
 */
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FontManifest } from '@docedit/export-latex';
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { createExportHandler, type ExportHandlerDeps } from './job.ts';
import { checkFontFiles, manifestFaces, type FontFileCheck } from './font-files.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';

const INCARNATION = 'inc-fonts';

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
      name: 'docedit-font-test',
      limits: { ...LIMITS },
      passTimeoutSeconds: 110,
    };
  };
  return { compile, count: () => calls };
}

/** Runs one export job of the demo document with the given font check; returns what happened. */
async function exportWith(checkFonts: ExportHandlerDeps['checkFontFiles']) {
  const stored: string[] = [];
  const probe = fakeCompile();
  const handler = createExportHandler({
    stores: stores(demoDocument().envelope),
    outputs: {
      putExport: async (_t, _j, name) => {
        stored.push(name);
      },
    },
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'b'.repeat(64)}`,
    compile: probe.compile,
    ...(checkFonts ? { checkFontFiles: checkFonts } : {}),
  } satisfies ExportHandlerDeps);
  const queue: JobQueue = new MemoryJobQueue();
  const runner = new JobRunner({
    queue,
    handlers: { export: handler },
    worker: 'w1',
    leaseMs: 60_000,
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
  await runner.runOnce();
  const done = (await queue.get(tenant, job.id)) as JobRecord;
  return { job: done, stored, compiles: probe.count() };
}

/** The codes of the diagnostics a failed job carries (kept as its result, runner.ts). */
function codesOf(job: JobRecord): string[] {
  const d =
    (job.result as { diagnostics?: Array<{ code: string }> } | null)?.diagnostics ??
    (job.error as { diagnostics?: Array<{ code: string }> } | null)?.diagnostics ??
    [];
  return d.map((x) => x.code);
}

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docedit-exp047-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const faceCount = manifestFaces(TEST_FONTS).length;

describe('EXP-047 criterion 2: a manifest hash with no matching file fails the job', () => {
  it('fails with font_file_missing for each face, before the engine starts, and stores nothing', async () => {
    // The directory is empty: every face of the manifest is missing.
    const out = await exportWith((m: FontManifest): Promise<FontFileCheck> =>
      checkFontFiles(m, dir),
    );
    expect(out.job.state).toBe('failed');
    expect(out.job.error?.code).toBe('unavailable');
    expect(out.compiles).toBe(0);
    expect(out.stored).toEqual([]);
    expect(codesOf(out.job)).toHaveLength(faceCount);
    expect(codesOf(out.job).every((c) => c === 'font_file_missing')).toBe(true);
  });

  it('fails with font_file_mismatch when a file of the expected name holds other bytes', async () => {
    for (const f of manifestFaces(TEST_FONTS)) {
      await writeFile(join(dir, f.file), 'not the font the manifest names');
    }
    const out = await exportWith((m) => checkFontFiles(m, dir));
    expect(out.job.state).toBe('failed');
    expect(out.compiles).toBe(0);
    expect(out.stored).toEqual([]);
    expect(codesOf(out.job).every((c) => c === 'font_file_mismatch')).toBe(true);
    expect(codesOf(out.job)).toHaveLength(faceCount);
  });

  it('is not checked when no check is wired (the default of the handler)', async () => {
    const out = await exportWith(undefined);
    expect(out.job.state).toBe('completed');
    expect(out.compiles).toBe(1);
  });

  it('completes when the check passes; the check decides, the job does not add a font', async () => {
    // Stub, see the file header: the manifest's hashes cannot match a real file.
    const out = await exportWith(async () => ({ ok: true, problems: [] }));
    expect(out.job.state).toBe('completed');
    expect(out.compiles).toBe(1);
    expect(out.stored).toContain('output.pdf');
  });
});
