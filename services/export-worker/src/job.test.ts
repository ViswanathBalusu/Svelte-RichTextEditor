/**
 * The export job handler with a stand-in for the sandbox (EXP-001, EXP-061 to EXP-067, EXP-071;
 * SEC-036 criterion 3), run by the control plane's own JobRunner over its in-memory queue. The
 * compile is replaced, so these tests need no Podman; the end-to-end test compiles for real.
 */
import {
  JobRunner,
  MemoryJobQueue,
  withQueueProof,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import { documentLang } from './content.ts';
import { CODES } from './diagnostics.ts';
import {
  createExportHandler,
  OUTPUT_FILES,
  type ExportHandlerDeps,
  type ExportMetrics,
} from './job.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';
import { bundleHashOf, checkSeal } from './verify.ts';

const INCARNATION = 'inc-1';

function stores(envelope: CdmEnvelope, title = 'Demo'): ContentStores {
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
          title,
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
  };
}

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

type Files = Readonly<Record<string, string | Uint8Array>>;

function fakeCompile(over: Partial<CompileResult> = {}) {
  const calls: Array<{ files: Files; opts: SandboxOptions }> = [];
  const compile = async (files: Files, opts: SandboxOptions): Promise<CompileResult> => {
    calls.push({ files, opts });
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
      name: 'docedit-job-test',
      limits: { ...LIMITS, ...opts.limits },
      passTimeoutSeconds: 110,
      ...over,
    };
  };
  return { compile, calls };
}

function harness(
  deps: Partial<ExportHandlerDeps> & { compile: NonNullable<ExportHandlerDeps['compile']> },
  opts: { leaseMs?: number; envelope?: CdmEnvelope } = {},
) {
  const stored: Array<{ name: string; bytes: Uint8Array; type: string }> = [];
  const metrics: ExportMetrics[] = [];
  const reports: string[] = [];
  // The memory queue, with its heartbeats recorded (stages and progress).
  class RecordingQueue extends MemoryJobQueue {
    override heartbeat(...args: Parameters<MemoryJobQueue['heartbeat']>) {
      const report = args[3];
      if (report?.stage) reports.push(`${report.stage} ${report.progress}`);
      return super.heartbeat(...args);
    }
  }
  const queue: JobQueue = new RecordingQueue();
  const runner = new JobRunner({
    queue,
    handlers: {
      export: createExportHandler({
        stores: stores(opts.envelope ?? demoDocument().envelope),
        outputs: {
          putExport: async (_t, _j, name, bytes, type) => {
            stored.push({ name, bytes, type });
          },
        },
        fonts: async () => TEST_FONTS,
        imageId: async () => `sha256:${'b'.repeat(64)}`,
        onMetrics: (m) => metrics.push(m),
        ...deps,
      }),
    },
    worker: 'w1',
    leaseMs: opts.leaseMs ?? 60_000,
    idleMs: 10,
    retryAfterMs: 0,
  });
  const tenant = uuid7();
  const doc = uuid7();
  // `signWith` is a queue proof key: the payload is signed as the control plane signs it (EXP-067).
  const start = async (payload: Record<string, unknown> = {}, signWith?: string) => {
    const body = {
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
      ...payload,
    };
    const job = await queue.enqueue(tenant, {
      kind: 'export',
      doc,
      createdBy: 'user-1',
      payload: signWith
        ? withQueueProof(signWith, { tenant, kind: 'export', doc, cacheKey: null }, body)
        : body,
    });
    const done = runner.runOnce().then(async () => (await queue.get(tenant, job.id))!);
    return { id: job.id, done };
  };
  const run = async (payload: Record<string, unknown> = {}, signWith?: string) =>
    (await start(payload, signWith)).done;
  return { start, run, stored, metrics, reports, queue, tenant, runner };
}

const codes = (job: JobRecord) =>
  ((job.result as { diagnostics?: Array<{ code: string }> } | null)?.diagnostics ?? []).map(
    (d) => d.code,
  );

describe('the export job handler (EXP-001)', () => {
  it('converts, seals, compiles and stores the outputs, and returns their names', async () => {
    const { compile, calls } = fakeCompile();
    const key = new Uint8Array(32).fill(3);
    let sealed: boolean | null = null;
    const h = harness({
      compile,
      sealKey: key,
      beforeCompile: (files, seal, job) => {
        sealed = checkSeal(key, job.id, bundleHashOf(files), seal);
      },
    });
    const job = await h.run();
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    expect(sealed).toBe(true);
    // The bundle of 09 §2 went into the sandbox: main.tex, styles.tex, the class, map and manifest.
    expect(Object.keys(calls[0]!.files).sort()).toEqual([
      'docedit.cls',
      'docedit.lua',
      'main.tex',
      'manifest.json',
      'map.json',
      'styles.tex',
    ]);
    expect(calls[0]!.opts).toMatchObject({ minPasses: 2, maxPasses: 4 });
    // SOURCE_DATE_EPOCH comes from the job (09 §9.4; EXP-076 criterion 1).
    expect(calls[0]!.opts.sourceDateEpoch).toBe(Math.floor(job.createdAt / 1000));
    expect(calls[0]!.opts.signal).toBeInstanceOf(AbortSignal);
    expect(job.result).toMatchObject({
      output: OUTPUT_FILES.pdf,
      layout: OUTPUT_FILES.layout,
      log: OUTPUT_FILES.log,
      manifest: OUTPUT_FILES.manifest,
      pages: 1,
      converged: true,
    });
    expect(h.stored.map((s) => [s.name, s.type])).toEqual([
      ['output.pdf', 'application/pdf'],
      ['layout.json', 'application/json'],
      ['compile.log', 'text/plain; charset=utf-8'],
      ['manifest.json', 'application/json'],
    ]);
    // The result manifest records what reproduces the PDF (EXP-076 criterion 4).
    const manifest = JSON.parse(new TextDecoder().decode(h.stored[3]!.bytes)) as {
      bundle: { hash: string; classVersion: string };
    } & Record<string, unknown>;
    expect(manifest).toMatchObject({
      resultVersion: 1,
      job: job.id,
      profile: 'final',
      tagging: 'on',
      sourceDateEpoch: Math.floor(job.createdAt / 1000),
      image: { id: `sha256:${'b'.repeat(64)}` },
      converged: true,
    });
    expect(manifest.bundle.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(manifest.bundle.classVersion).toMatch(/^\d+\.\d+\.\d+/);
    expect(h.reports[0]).toMatch(/^converting/);
    expect(h.reports).toContain('compiling 20');
    // Stage times for EXP-060 and the log size for EXP-064.
    expect(h.metrics).toHaveLength(1);
    expect(h.metrics[0]).toMatchObject({ passMs: [100, 100, 100, 100], sandboxMs: 1500, pages: 1 });
    expect(h.metrics[0]!.logBytes).toBeGreaterThan(0);
  });

  it('compiles a preview once with tagging off and flags stale page references (EXP-062)', async () => {
    const { compile, calls } = fakeCompile();
    const job = await harness({ compile }).run({ options: { profile: 'preview' } });
    expect(job.state).toBe('completed');
    expect(calls[0]!.opts).toMatchObject({ minPasses: 1, maxPasses: 1 });
    expect(String(calls[0]!.files['main.tex'])).toContain('tagging=off');
    expect(job.result).toMatchObject({ converged: false });
    expect(codes(job)).toContain('preview_one_pass');
  });

  it('records a final export that did not converge, and delivers it flagged (EXP-061 criterion 4)', async () => {
    const { compile } = fakeCompile({ converged: false });
    const job = await harness({ compile }).run();
    expect(job.state).toBe('completed');
    expect(job.result).toMatchObject({ converged: false });
    expect(codes(job)).toContain('references_not_converged');
  });

  it('fails a job that reached a limit, with a diagnostic that names it (EXP-071 criterion 2)', async () => {
    const { compile } = fakeCompile({
      ok: false,
      exitCode: 137,
      pdf: null,
      layoutRaw: null,
      passes: [{ pass: 1, rc: 137, ms: 6800 }],
    });
    const job = await harness({ compile }).run();
    expect(job.state).toBe('failed');
    expect(job.error).toEqual({
      code: 'too_large',
      message: 'the compile reached its limit of 1536 MiB of memory (limit_memory)',
    });
    // The failed job keeps its diagnostics, which the job resource shows (EXP-065).
    expect(codes(job)).toContain('limit_memory');
  });

  it('records that page references did not converge when a final export reaches a limit (EXP-061 criterion 4)', async () => {
    // Pass 1 ended; pass 2 was killed by the wall clock before `converged 1` was written.
    const { compile } = fakeCompile({
      ok: false,
      exitCode: 255,
      timedOut: true,
      pdf: null,
      layoutRaw: null,
      converged: false,
      passes: [
        { pass: 1, rc: 0, ms: 60_000 },
        { pass: 2, rc: 137, ms: 50_000 },
      ],
    });
    const job = await harness({ compile }).run({ options: { profile: 'final' } });
    // EXP-071 criterion 2 still holds: the job ends failed, with the limit named.
    expect(job.state).toBe('failed');
    expect(job.error).toMatchObject({ code: 'too_large' });
    expect(codes(job)).toContain('limit_time');
    // The result says what the story asks, and how many passes ran.
    expect(job.result).toMatchObject({ converged: false, passes: 2 });
  });

  it('records the digest of the image in the bundle and in the result manifest (EXP-073 criterion 2; EXP-076 criterion 4)', async () => {
    const digest = `sha256:${'d'.repeat(64)}`;
    const { compile, calls } = fakeCompile();
    const h = harness({ compile, imageDigest: async () => digest });
    const job = await h.run();
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    const bundleManifest = JSON.parse(String(calls[0]!.files['manifest.json'])) as {
      imageDigest: string | null;
    };
    expect(bundleManifest.imageDigest).toBe(digest);
    const result = JSON.parse(new TextDecoder().decode(h.stored[3]!.bytes)) as {
      image: { id: string; digest: string | null };
      bundle: { classVersion: string };
    };
    // Both values are recorded: the identifier of the image and its manifest digest.
    expect(result.image).toEqual({
      name: expect.any(String),
      id: `sha256:${'b'.repeat(64)}`,
      digest,
    });
    expect(result.bundle.classVersion).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('records no digest, and does not fail, when the image has none', async () => {
    const { compile, calls } = fakeCompile();
    const h = harness({ compile, imageDigest: async () => null });
    const job = await h.run();
    expect(job.state, JSON.stringify(job.error)).toBe('completed');
    expect(JSON.parse(String(calls[0]!.files['manifest.json']))).toMatchObject({
      imageDigest: null,
    });
    expect(JSON.parse(new TextDecoder().decode(h.stored[3]!.bytes))).toMatchObject({
      image: { digest: null },
    });
  });

  it('fails a job whose document did not compile, with the diagnostics at their blocks', async () => {
    const probe = fakeCompile();
    await harness({ compile: probe.compile }).run();
    const main = String(probe.calls[0]!.files['main.tex']).split('\n');
    const line = main.findIndex((l) => l.startsWith('\\DEp{') && l.includes('pecial')) + 1;
    const block = line > 0 ? line : main.findIndex((l) => l.startsWith('\\DEp{')) + 1;
    const { compile } = fakeCompile({
      ok: false,
      exitCode: 1,
      pdf: null,
      layoutRaw: null,
      log: `./main.tex:${block}: Undefined control sequence.\n./main.tex:${block}:  ==> Fatal error occurred, no output PDF file produced!\n`,
    });
    const job = await harness({ compile }).run();
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('validation_failed');
    const ds = (job.result as { diagnostics: Array<{ code: string; blockId: string | null }> })
      .diagnostics;
    expect(ds.find((d) => d.code === 'tex_undefined')?.blockId).toMatch(/^p[A-Za-z0-9]{15}$/);
  });

  it('gives every diagnostic of a result a severity, a catalogue code, a block of map.json or null, and a message (EXP-065 criterion 1)', async () => {
    const probe = fakeCompile();
    await harness({ compile: probe.compile }).run();
    const files = probe.calls[0]!.files;
    const main = String(files['main.tex']).split('\n');
    const map = JSON.parse(String(files['map.json'])) as {
      blocks: Array<string | null>;
      lines: Array<{ from: number; to: number; block: number | null }>;
    };
    const line = main.findIndex((l) => l.startsWith('\\DEp{')) + 1;
    expect(line).toBeGreaterThan(0);
    const range = map.lines.find((r) => line >= r.from && line <= r.to);
    const expectedBlock = range && range.block !== null ? map.blocks[range.block] : null;
    expect(expectedBlock).toMatch(/^p[A-Za-z0-9]{15}$/);
    const { compile } = fakeCompile({
      ok: false,
      exitCode: 1,
      pdf: null,
      layoutRaw: null,
      log:
        [
          `./main.tex:${line}: Undefined control sequence.`,
          `./main.tex:${line}: LaTeX Error: a reference is broken.`,
          `./main.tex:${line}:  ==> Fatal error occurred, no output PDF file produced!`,
          `Overfull \\hbox (12.5pt too wide) in paragraph at lines ${line}--${line}`,
        ].join('\n') + '\n',
    });
    const job = await harness({ compile }).run();
    expect(job.state).toBe('failed');
    const ds = (
      job.result as {
        diagnostics: Array<{
          severity: unknown;
          code: unknown;
          blockId: unknown;
          message: unknown;
        }>;
      }
    ).diagnostics;
    expect(ds.length).toBeGreaterThanOrEqual(4);
    for (const d of ds) {
      expect(['error', 'warning', 'info']).toContain(d.severity);
      expect(Object.keys(CODES)).toContain(d.code);
      expect(d.blockId === null || map.blocks.includes(d.blockId as string)).toBe(true);
      expect(typeof d.message).toBe('string');
      expect((d.message as string).length).toBeGreaterThan(0);
    }
    // The entries that name the line point at the block the map gives for it, and no other.
    const named = ds.filter((d) => d.code !== 'limit_pages' && d.blockId !== null);
    expect(named.length).toBeGreaterThanOrEqual(3);
    for (const d of named) expect(d.blockId).toBe(expectedBlock);
  });

  it('never uses a hostile layout report: it is dropped with a diagnostic (SEC-036 criterion 3)', async () => {
    const hostile = [
      '{"v":1,"level":2,"pages":[{"n":1,"start":"<script>"}],"blocks":{},"lines":[]}',
      'x'.repeat(100),
      '{"v":9}',
      `{"v":1,"level":2,"pages":[],"blocks":{"1":[1,0,0]},"lines":[],"extra":1}`,
    ];
    for (const layoutRaw of hostile) {
      const h = harness({ compile: fakeCompile({ layoutRaw }).compile });
      const job = await h.run();
      expect(job.state).toBe('completed');
      expect(job.result).toMatchObject({ layout: null, pages: null });
      expect(codes(job)).toContain('layout_invalid');
      expect(h.stored.map((s) => s.name)).not.toContain('layout.json');
    }
  });

  it('refuses a job that carries TeX or a bundle before anything compiles (EXP-067 criterion 4)', async () => {
    const { compile, calls } = fakeCompile();
    const job = await harness({ compile }).run({
      files: { 'main.tex': '\\directlua{os.execute("id")}' },
    });
    expect(job.state).toBe('failed');
    expect(job.error?.code).toBe('validation_failed');
    expect(codes(job)).toContain('bundle_refused');
    expect(calls).toHaveLength(0);
  });

  it('refuses a job the control plane did not queue, when a proof key is set (EXP-067 criterion 4)', async () => {
    const key = 'k'.repeat(40);
    const { compile, calls } = fakeCompile();
    const h = harness({ compile, queueProofKey: key });
    // Written to the queue by something else: no proof, a proof under another key, a changed option.
    const bare = await h.run();
    expect(bare.state).toBe('failed');
    expect(bare.error?.code).toBe('validation_failed');
    expect(codes(bare)).toContain('bundle_refused');
    const wrongKey = await h.run({}, 'j'.repeat(40));
    expect(codes(wrongKey)).toContain('bundle_refused');
    const signed = await h.start({ options: { profile: 'preview' } }, key);
    const row = (await h.queue.get(h.tenant, signed.id))!;
    await signed.done;
    expect(calls).toHaveLength(1);
    // A signed payload that was changed afterwards (another sequence number) fails.
    const forged = await h.queue.enqueue(h.tenant, {
      kind: 'export',
      doc: row.doc,
      createdBy: 'user-1',
      payload: { ...row.payload, seq: 7 },
    });
    expect(forged.payload['queueProof']).toBe(row.payload['queueProof']);
    await h.runner.runOnce();
    const refused = (await h.queue.get(h.tenant, forged.id))!;
    expect(refused.state).toBe('failed');
    expect(codes(refused)).toContain('bundle_refused');
    // Nothing compiled for any refused job; the one signed job compiled.
    expect(calls).toHaveLength(1);
    // Without a key on the worker the proof is not checked.
    const open = harness({ compile });
    expect((await open.run()).state).toBe('completed');
    expect(calls).toHaveLength(2);
  });

  it('projects a restricted view (EXP-123), and refuses options it cannot honour without compiling', async () => {
    const { compile, calls } = fakeCompile();
    const h = harness({ compile });
    // EXP-123 criterion 1: the projection reaches the converter, so a restricted view is built, not refused.
    const hidden = await h.run({ hiddenRegions: ['rPriceBBBBBBBBB1'] });
    expect(hidden.state).toBe('completed');
    expect(codes(hidden)).not.toContain('view_unsupported');
    // Margin comments are honoured since EXP-084 (see exp-084-comments.job.test.ts); PDF/UA-2 without tagging is not.
    const untagged = await h.run({ options: { pdfStandard: 'ua-2', tagging: 'off' } });
    expect(untagged.error?.code).toBe('validation_failed');
    expect(codes(untagged)).toContain('option_unsupported');
    const docx = await h.run({ target: 'rtf' });
    expect(docx.error?.code).toBe('validation_failed');
    // Only the projected view compiled; the refused options did not.
    expect(calls).toHaveLength(1);
  });

  it('ignores options it does not know, so that no request can add TeX (EXP-067 criterion 1)', async () => {
    const { compile, calls } = fakeCompile();
    const h = harness({ compile });
    await h.run({ options: { preamble: '\\usepackage{shellesc}', package: 'x' } });
    await h.run({ options: {} });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.files['main.tex']).toBe(calls[1]!.files['main.tex']);
    expect(String(calls[0]!.files['main.tex'])).not.toContain('shellesc');
  });

  it('records the locale and time zone it used, the defaults when none are set (EXP-005 criterion 4)', async () => {
    const { compile, calls } = fakeCompile();
    const h = harness({ compile });
    const manifestOf = (i: number) =>
      JSON.parse(new TextDecoder().decode(h.stored[i * 4 + 3]!.bytes)) as {
        locale: string;
        timeZone: string;
        bundle: { hash: string; options: { timeZone: string } };
      };
    expect((await h.run()).state).toBe('completed');
    // No option: the document's language (else en-GB) and UTC, the defaults of ADR 0045 (proposed).
    const lang = documentLang(demoDocument().envelope);
    expect(manifestOf(0)).toMatchObject({ locale: lang ?? 'en-GB', timeZone: 'UTC' });
    expect(manifestOf(0).bundle.options.timeZone).toBe('UTC');
    expect((await h.run({ options: { locale: 'de-DE', timeZone: 'Europe/Berlin' } })).state).toBe(
      'completed',
    );
    expect(manifestOf(1)).toMatchObject({ locale: 'de-DE', timeZone: 'Europe/Berlin' });
    // The zone reaches the bundle's manifest, so the two jobs have different bundle hashes.
    expect(manifestOf(1).bundle.options.timeZone).toBe('Europe/Berlin');
    expect(manifestOf(1).bundle.hash).not.toBe(manifestOf(0).bundle.hash);
    expect(calls).toHaveLength(2);
    // A zone or a locale outside the rules is refused before anything compiles.
    const bad = await h.run({ options: { timeZone: 'Mars/Olympus' } });
    expect(bad.error?.code).toBe('validation_failed');
    expect(calls).toHaveLength(2);
  });

  it('stops a cancelled job: the sandbox is signalled and no result is kept (EXP-070 criterion 3)', async () => {
    let compiling!: () => void;
    const started = new Promise<void>((r) => (compiling = r));
    let signalled = false;
    const compile = async (files: Files, opts: SandboxOptions): Promise<CompileResult> => {
      compiling();
      await new Promise<void>((resolve) => opts.signal!.addEventListener('abort', () => resolve()));
      signalled = true;
      const r = await fakeCompile().compile(files, opts);
      return { ...r, ok: false, cancelled: true, pdf: null };
    };
    const h = harness({ compile }, { leaseMs: 300 });
    const { id, done } = await h.start();
    await started;
    await h.queue.cancel(h.tenant, id);
    const job = await done;
    expect(signalled).toBe(true);
    expect(job.state).toBe('cancelled');
    expect(job.result).toBeNull();
    expect(h.stored).toHaveLength(0);
  });
});
