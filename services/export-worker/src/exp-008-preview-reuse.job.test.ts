/**
 * EXP-008 criterion 3 at the worker (Node.js, the compile replaced): a preview whose bundle an
 * earlier preview of the document already compiled shows that preview's files again, and nothing
 * is compiled (06 §10; preview-reuse.ts). The jobs run through the real handler, the real worker
 * composition (`createExportWorker`) and the control plane's in-memory queue; only the sandbox is a
 * stand-in that counts its calls. The way through the control plane's route is tested in
 * test/exp-008-unchanged-bundle.test.ts.
 */
import {
  JobRunner,
  MemoryJobQueue,
  type JobQueue,
  type JobRecord,
} from '@docedit/document-service';
import type { BundleManifest } from '@docedit/export-latex';
import { uuid7, type CdmEnvelope } from '@docedit/model';
import { describe, expect, it } from 'vitest';
import { demoDocument, REGION_A } from '../test/documents.ts';
import { TEST_FONTS } from '../test/fonts.ts';
import type { ContentStores } from './content.ts';
import type { ExportHandlerDeps, ExportMetrics } from './job.ts';
import { completedMetrics, metricsLogFields } from './metrics-log.ts';
import {
  earlierPreviewFrom,
  PREVIEW_KEY_MEMBER,
  PREVIEW_REUSE_MAX_AGE_MS,
  previewBundleKey,
  reusedPreview,
} from './preview-reuse.ts';
import { LIMITS, type CompileResult, type SandboxOptions } from './sandbox.ts';
import { createExportWorker, exportJobHandlers } from './worker.ts';

const INCARNATION = 'inc-exp-008';
const DAY = 24 * 60 * 60 * 1000;
/** Noon on a fixed day, so that a few hours more are the same day in UTC. */
const NOON = Date.UTC(2026, 10, 20, 12, 0, 0);

const RAW_LAYOUT = JSON.stringify({
  v: 1,
  level: 2,
  pages: [{ n: 1, start: [1, 0, 3_000_000], first: [1, 1] }],
  blocks: { '1': [1, 3_000_000, 0], '2': [1, 4_000_000, 0] },
  lines: [[1, 0, 1, 3_000_000]],
});

type Files = Readonly<Record<string, string | Uint8Array>>;
type J = Record<string, unknown>;

/** The demonstration document with its last paragraph replaced by `last`. */
function documentEnding(last: string | J[]): CdmEnvelope {
  const e = structuredClone(demoDocument().envelope) as unknown as {
    doc: { content: Array<{ content: Array<{ attrs?: J; content?: unknown }> }> };
  };
  const body = e.doc.content[1]!.content;
  const end = body[body.length - 1]!;
  end.content = typeof last === 'string' ? [{ type: 'text', text: last }] : last;
  return e as unknown as CdmEnvelope;
}

const SAME = 'The end of the document.';
const CHANGED = 'The end of the document, with a change.';
/** A paragraph that prints the date of the job. */
const DATED: J[] = [
  { type: 'text', text: 'Dated ' },
  { type: 'field', attrs: { id: 'fDate00800000001', kind: 'date' } },
];

/** The content at each `seq`: the checkpoint of that `seq`, with no commits between. */
function stores(at: Record<number, CdmEnvelope>): ContentStores {
  const seqs = Object.keys(at)
    .map(Number)
    .sort((a, b) => a - b);
  return {
    logs: {
      head: async () => ({ seq: seqs.at(-1)!, epoch: 1, owner: null, incarnation: INCARNATION }),
      read: async () => [],
    },
    checkpoints: {
      latest: async (_ref, seq: number) => {
        const usable = seqs.filter((s) => s <= seq);
        const s = usable.at(-1);
        return (s === undefined ? null : { seq: s, content: at[s] }) as never;
      },
      get: async () => null,
    },
    documents: {
      get: async (ref) =>
        ({
          id: ref.doc,
          tenant: ref.tenant,
          title: 'Preview',
          incarnation: INCARNATION,
          deletedAt: null,
        }) as never,
    },
    // A chain head of its own for every seq, so that the tests can tell whose head a result holds.
    chainHeadAt: async (_ref, seq) => String(seq % 10).repeat(64),
  };
}

function fakeCompile(over: Partial<CompileResult> = {}) {
  const calls: Array<{ files: Files; opts: SandboxOptions }> = [];
  let next: Partial<CompileResult> = {};
  const compile = async (files: Files, opts: SandboxOptions): Promise<CompileResult> => {
    calls.push({ files, opts });
    const n = opts.maxPasses ?? 2;
    const once = next;
    next = {};
    return {
      ok: true,
      exitCode: 0,
      timedOut: false,
      outputOverflow: false,
      cancelled: false,
      passes: Array.from({ length: n }, (_, i) => ({ pass: i + 1, rc: 0, ms: 100 })),
      converged: n > 1,
      pdf: new TextEncoder().encode('%PDF-2.0 test'),
      // A warning of the compile itself: it must reach the result of a job that shows these files.
      log: 'This is LuaHBTeX\n\nLaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.\n',
      layoutRaw: RAW_LAYOUT,
      stderr: '',
      wallMs: 1500,
      stdout: new Uint8Array(),
      name: 'docedit-exp-008',
      limits: { ...LIMITS, ...opts.limits },
      passTimeoutSeconds: 110,
      ...over,
      ...once,
    };
  };
  return { compile, calls, failNext: (r: Partial<CompileResult>) => (next = r) };
}

interface Ask {
  seq?: number;
  doc?: string;
  tenant?: string;
  by?: string;
  kind?: 'preview' | 'export';
  options?: J;
  hiddenRegions?: string[];
}

/**
 * A worker over an in-memory queue whose clock the test moves. `reuse: false` runs the same
 * handlers without the lookup of an earlier preview, so that every preview compiles.
 */
function harness(
  at: Record<number, CdmEnvelope> = { 0: documentEnding(SAME), 3: documentEnding(SAME) },
  opts: { reuse?: boolean; deps?: Partial<ExportHandlerDeps> } = {},
) {
  let now = NOON;
  const stored: Array<{ job: string; name: string }> = [];
  const metrics = new Map<string, ExportMetrics>();
  const stages = new Map<string, string[]>();
  class RecordingQueue extends MemoryJobQueue {
    override heartbeat(...args: Parameters<MemoryJobQueue['heartbeat']>) {
      const stage = args[3]?.stage;
      if (stage) stages.set(args[0].id, [...(stages.get(args[0].id) ?? []), stage]);
      return super.heartbeat(...args);
    }
  }
  const queue: JobQueue = new RecordingQueue(() => now);
  const probe = fakeCompile();
  const deps: ExportHandlerDeps = {
    stores: stores(at),
    outputs: {
      putExport: async (_t, job, name) => {
        stored.push({ job, name });
      },
    },
    fonts: async () => TEST_FONTS,
    imageId: async () => `sha256:${'b'.repeat(64)}`,
    compile: probe.compile,
    onMetrics: (m, job) => metrics.set(job.id, m),
    // The lookup reads the queue's own clock, which the tests move.
    ...(opts.reuse === false
      ? {}
      : { earlierPreview: earlierPreviewFrom(queue, { now: () => now }) }),
    ...opts.deps,
  };
  const settings = { queue, worker: 'w-exp-008', leaseMs: 60_000, idleMs: 10, retryAfterMs: 0 };
  const runner =
    opts.reuse === false
      ? // Without the lookup: the bare handlers, as `startService({ jobHandlers })` registers them.
        new JobRunner({ ...settings, handlers: exportJobHandlers(deps) })
      : createExportWorker({ ...settings, deps }).runner;
  const tenant = uuid7();
  const doc = uuid7();
  const run = async (a: Ask = {}): Promise<JobRecord> => {
    const kind = a.kind ?? 'preview';
    const d = a.doc ?? doc;
    const t = a.tenant ?? tenant;
    const by = a.by ?? 'user-1';
    const job = await queue.enqueue(t, {
      kind,
      doc: d,
      createdBy: by,
      payload: {
        doc: d,
        target: 'pdf',
        seq: a.seq ?? 0,
        incarnation: INCARNATION,
        options: { profile: kind === 'preview' ? 'preview' : 'final', ...a.options },
        requester: by,
        role: 'editor',
        view: 'v',
        hiddenRegions: a.hiddenRegions ?? [],
        hiddenValues: [],
      },
    });
    expect(await runner.runOnce()).toBe(true);
    return (await queue.get(t, job.id))!;
  };
  return {
    run,
    queue,
    tenant,
    doc,
    stored,
    metrics,
    stages,
    calls: probe.calls,
    failNext: probe.failNext,
    advance: (ms: number) => (now += ms),
  };
}

const result = (job: JobRecord) => job.result as J;
/** A result without what a job that shows earlier files may differ in from its own compile. */
const comparable = (job: JobRecord) =>
  Object.fromEntries(Object.entries(result(job)).filter(([k]) => k !== 'from' && k !== 'metrics'));
const codes = (job: JobRecord) =>
  ((result(job)['diagnostics'] as Array<{ code: string }> | undefined) ?? []).map((d) => d.code);

describe('EXP-008 criterion 3: a preview of an unchanged bundle compiles nothing', () => {
  it('compiles the first preview and records its preview key', async () => {
    const h = harness();
    const first = await h.run();
    expect(first.state, JSON.stringify(first.error)).toBe('completed');
    expect(h.calls).toHaveLength(1);
    expect(result(first)[PREVIEW_KEY_MEMBER]).toMatch(/^[0-9a-f]{64}$/);
    expect(result(first)['from']).toBeUndefined();
    expect(h.stored.filter((s) => s.job === first.id).map((s) => s.name)).toEqual([
      'output.pdf',
      'layout.json',
      'compile.log',
      'manifest.json',
    ]);
    expect(h.stages.get(first.id)).toEqual(['converting', 'compiling', 'compiling']);
    expect(h.metrics.get(first.id)?.reused).toBeUndefined();
  });

  it('shows the earlier preview again when the document changed and its bundle did not', async () => {
    const h = harness();
    const first = await h.run({ seq: 0 });
    // A later seq whose content prints the same: another request for the control plane (its key
    // holds the seq), and the same bundle for the worker.
    h.advance(60_000);
    const second = await h.run({ seq: 3 });
    expect(second.state, JSON.stringify(second.error)).toBe('completed');
    // No compile ran, and the job wrote no file of its own.
    expect(h.calls).toHaveLength(1);
    expect(h.stored.filter((s) => s.job === second.id)).toEqual([]);
    expect(h.stages.get(second.id)).toEqual(['converting']);
    // The cached result is returned: the files of the first job, by its name.
    const r = result(second);
    expect(r['from']).toBe(first.id);
    expect(r['output']).toBe('output.pdf');
    expect(r['layout']).toBe('layout.json');
    expect(r['pages']).toBe(1);
    expect(r['converged']).toBe(false);
    expect(r[PREVIEW_KEY_MEMBER]).toBe(result(first)[PREVIEW_KEY_MEMBER]);
    // The diagnostics of the compile it did not run are the earlier compile's.
    expect(codes(second)).toEqual(codes(first));
    expect(codes(second)).toEqual(
      expect.arrayContaining(['references_changed', 'preview_one_pass']),
    );
    // The chain head is this job's own state, not the earlier job's.
    expect(result(first)['chainHead']).toBe('0'.repeat(64));
    expect(r['chainHead']).toBe('3'.repeat(64));
    // The same requester gets the raw log of the compile.
    expect(r['log']).toBe('compile.log');
    // The attempt is marked, logged as such, and left out of a latency summary.
    const m = h.metrics.get(second.id)!;
    expect(m).toMatchObject({
      state: 'completed',
      reused: true,
      sandboxMs: 0,
      passMs: [],
      pages: 1,
    });
    expect(metricsLogFields(m, second).message).toContain('no compile');
    expect(metricsLogFields(h.metrics.get(first.id)!, first).message).not.toContain('no compile');
    expect(completedMetrics([h.metrics.get(first.id), m])).toEqual([h.metrics.get(first.id)]);
  });

  it('gives the result the job would have had from a compile of its own', async () => {
    const reusing = harness();
    await reusing.run({ seq: 0 });
    const shown = await reusing.run({ seq: 3 });
    expect(reusing.calls).toHaveLength(1);
    // The same two jobs on a worker without the lookup: both compile.
    const compiling = harness(undefined, { reuse: false });
    await compiling.run({ seq: 0 });
    const compiled = await compiling.run({ seq: 3 });
    expect(compiling.calls).toHaveLength(2);
    expect(result(compiled)['from']).toBeUndefined();
    expect(comparable(shown)).toEqual(comparable(compiled));
  });

  it('compiles when the bundle changed, and shows the right one of two earlier previews', async () => {
    const h = harness({
      0: documentEnding(SAME),
      1: documentEnding(CHANGED),
      2: documentEnding(SAME),
      3: documentEnding(CHANGED),
    });
    const a = await h.run({ seq: 0 });
    const b = await h.run({ seq: 1 });
    expect(h.calls).toHaveLength(2);
    expect(result(b)['from']).toBeUndefined();
    expect(result(b)[PREVIEW_KEY_MEMBER]).not.toBe(result(a)[PREVIEW_KEY_MEMBER]);
    // The edit is undone: the bundle is the one of seq 0 again, not the last preview's.
    const c = await h.run({ seq: 2 });
    expect(result(c)['from']).toBe(a.id);
    // And done again: the one of seq 1.
    const d = await h.run({ seq: 3 });
    expect(result(d)['from']).toBe(b.id);
    expect(h.calls).toHaveLength(2);
  });

  it('keeps previews and final exports apart (09 §8)', async () => {
    const h = harness();
    const preview = await h.run({ seq: 0 });
    // A final export of the same content compiles, and its result carries no preview key.
    const final = await h.run({ seq: 0, kind: 'export' });
    expect(final.state, JSON.stringify(final.error)).toBe('completed');
    expect(h.calls).toHaveLength(2);
    expect(result(final)[PREVIEW_KEY_MEMBER]).toBeUndefined();
    expect(result(final)['from']).toBeUndefined();
    // A second final export compiles too: this check is for previews only.
    await h.run({ seq: 3, kind: 'export' });
    expect(h.calls).toHaveLength(3);
    // The next preview shows the earlier preview, never a final export.
    const again = await h.run({ seq: 3 });
    expect(result(again)['from']).toBe(preview.id);
    expect(h.calls).toHaveLength(3);
  });

  it('does not answer a preview from a final export of the same content', async () => {
    const h = harness();
    await h.run({ seq: 0, kind: 'export' });
    const preview = await h.run({ seq: 0 });
    expect(h.calls).toHaveLength(2);
    expect(result(preview)['from']).toBeUndefined();
  });

  it('never shows the files of another document or another tenant', async () => {
    const h = harness();
    await h.run({ seq: 0 });
    const otherDoc = await h.run({ seq: 0, doc: uuid7() });
    expect(result(otherDoc)['from']).toBeUndefined();
    const otherTenant = await h.run({ seq: 0, tenant: uuid7() });
    expect(result(otherTenant)['from']).toBeUndefined();
    expect(h.calls).toHaveLength(3);
    // The bundles are the same, so the keys are: only the lookup keeps them apart.
    expect(result(otherDoc)[PREVIEW_KEY_MEMBER]).toBe(result(otherTenant)[PREVIEW_KEY_MEMBER]);
  });

  it('gives the raw log to the requester of the compile only, also after another reader', async () => {
    const h = harness();
    const first = await h.run({ seq: 0, by: 'user-1' });
    const other = await h.run({ seq: 3, by: 'user-2' });
    expect(result(other)['from']).toBe(first.id);
    expect(result(other)['log']).toBeNull();
    // The newest preview with the key is now the other reader's; the compile is still user-1's.
    const back = await h.run({ seq: 3, by: 'user-1' });
    expect(result(back)['from']).toBe(first.id);
    expect(result(back)['log']).toBe('compile.log');
    const third = await h.run({ seq: 0, by: 'user-3' });
    expect(result(third)['from']).toBe(first.id);
    expect(result(third)['log']).toBeNull();
    expect(h.calls).toHaveLength(1);
  });

  it('compiles for other options, and shows earlier files only for the same ones', async () => {
    const h = harness();
    const plain = await h.run({ seq: 0 });
    const tagged = await h.run({ seq: 0, options: { tagging: 'draft' } });
    const zoned = await h.run({ seq: 0, options: { timeZone: 'Europe/London' } });
    // An option the worker ignores is named in the diagnostics, so that job compiles too.
    const noted = await h.run({ seq: 0, options: { unknownOption: 1 } });
    expect(h.calls).toHaveLength(4);
    for (const job of [tagged, zoned, noted]) expect(result(job)['from']).toBeUndefined();
    expect(codes(noted)).toContain('option_ignored');
    expect(codes(plain)).not.toContain('option_ignored');
    const taggedAgain = await h.run({ seq: 3, options: { tagging: 'draft' } });
    expect(result(taggedAgain)['from']).toBe(tagged.id);
    const notedAgain = await h.run({ seq: 3, options: { unknownOption: 1 } });
    expect(result(notedAgain)['from']).toBe(noted.id);
    expect(codes(notedAgain)).toContain('option_ignored');
    expect(h.calls).toHaveLength(4);
  });

  it('shows earlier files to readers of the same projection only (EXP-123)', async () => {
    const h = harness();
    const restricted = await h.run({ seq: 0, by: 'user-1', hiddenRegions: [REGION_A] });
    const full = await h.run({ seq: 0, by: 'user-2' });
    expect(h.calls).toHaveLength(2);
    expect(result(full)['from']).toBeUndefined();
    expect(result(full)[PREVIEW_KEY_MEMBER]).not.toBe(result(restricted)[PREVIEW_KEY_MEMBER]);
    const alsoRestricted = await h.run({ seq: 3, by: 'user-3', hiddenRegions: [REGION_A] });
    expect(result(alsoRestricted)['from']).toBe(restricted.id);
    const alsoFull = await h.run({ seq: 3, by: 'user-4' });
    expect(result(alsoFull)['from']).toBe(full.id);
    expect(h.calls).toHaveLength(2);
  });

  it('does not show a preview that failed, or one that was cancelled', async () => {
    const h = harness();
    h.failNext({ ok: false, exitCode: 1, pdf: null, log: './main.tex:5: Emergency stop.\n' });
    const failed = await h.run({ seq: 0 });
    expect(failed.state).toBe('failed');
    const next = await h.run({ seq: 3 });
    expect(next.state, JSON.stringify(next.error)).toBe('completed');
    expect(result(next)['from']).toBeUndefined();
    expect(h.calls).toHaveLength(2);
    // A job that was cancelled after it had completed elsewhere does not exist; one cancelled
    // while it waited has no result, so there is nothing to show.
    const waiting = await h.queue.enqueue(h.tenant, {
      kind: 'preview',
      doc: h.doc,
      createdBy: 'user-1',
      payload: {},
    });
    await h.queue.cancel(h.tenant, waiting.id);
    const after = await h.run({ seq: 0 });
    expect(result(after)['from']).toBe(next.id);
  });

  it('compiles again when the earlier compile is older than the limit', async () => {
    const h = harness();
    const first = await h.run({ seq: 0 });
    h.advance(PREVIEW_REUSE_MAX_AGE_MS - 60_000);
    const inside = await h.run({ seq: 3 });
    expect(result(inside)['from']).toBe(first.id);
    // The newest job with the key is one day old, the compile it shows eight days: too old.
    h.advance(DAY);
    const outside = await h.run({ seq: 0 });
    expect(result(outside)['from']).toBeUndefined();
    expect(h.calls).toHaveLength(2);
    const fresh = await h.run({ seq: 3 });
    expect(result(fresh)['from']).toBe(outside.id);
  });

  it('prints the date of the job: the same day shows the earlier files, another day compiles', async () => {
    const h = harness({ 0: documentEnding(DATED), 3: documentEnding(DATED) });
    const first = await h.run({ seq: 0 });
    expect(first.state, JSON.stringify(first.error)).toBe('completed');
    const main = String(h.calls[0]!.files['main.tex']);
    expect(main).toContain('2026-11-20');
    // Three hours later the job's instant differs and the printed date does not.
    h.advance(3 * 60 * 60 * 1000);
    const sameDay = await h.run({ seq: 3 });
    expect(result(sameDay)['from']).toBe(first.id);
    expect(h.calls).toHaveLength(1);
    // The next day the date field prints another text, so the bundle differs.
    h.advance(DAY);
    const nextDay = await h.run({ seq: 3 });
    expect(result(nextDay)['from']).toBeUndefined();
    expect(h.calls).toHaveLength(2);
    expect(String(h.calls[1]!.files['main.tex'])).toContain('2026-11-21');
  });

  it('compiles when the lookup fails, and when the handlers are registered without one', async () => {
    const failing = harness(undefined, {
      deps: {
        earlierPreview: async () => {
          throw new Error('the queue is not reachable');
        },
      },
    });
    await failing.run({ seq: 0 });
    const second = await failing.run({ seq: 3 });
    expect(second.state, JSON.stringify(second.error)).toBe('completed');
    expect(result(second)['from']).toBeUndefined();
    expect(failing.calls).toHaveLength(2);

    const bare = harness(undefined, { reuse: false });
    await bare.run({ seq: 0 });
    await bare.run({ seq: 3 });
    expect(bare.calls).toHaveLength(2);
  });

  it('looks in its own queue by default (createExportWorker)', async () => {
    const queue: JobQueue = new MemoryJobQueue();
    const probe = fakeCompile();
    const worker = createExportWorker({
      queue,
      deps: {
        stores: stores({ 0: documentEnding(SAME), 3: documentEnding(SAME) }),
        outputs: { putExport: async () => {} },
        fonts: async () => TEST_FONTS,
        imageId: async () => `sha256:${'b'.repeat(64)}`,
        compile: probe.compile,
      },
      worker: 'w-exp-008-default',
      leaseMs: 60_000,
      idleMs: 10,
      retryAfterMs: 0,
    });
    const tenant = uuid7();
    const doc = uuid7();
    const ids: string[] = [];
    for (const seq of [0, 3]) {
      const job = await queue.enqueue(tenant, {
        kind: 'preview',
        doc,
        createdBy: 'user-1',
        payload: {
          doc,
          target: 'pdf',
          seq,
          incarnation: INCARNATION,
          options: { profile: 'preview' },
          hiddenRegions: [],
          hiddenValues: [],
        },
      });
      ids.push(job.id);
      await worker.runOnce();
    }
    expect(probe.calls).toHaveLength(1);
    expect(result((await queue.get(tenant, ids[1]!))!)['from']).toBe(ids[0]);
  });
});

describe('EXP-008 the preview key', () => {
  const manifest = (over: Partial<BundleManifest> = {}): BundleManifest => ({
    bundleVersion: 1,
    seq: 4,
    chainHead: 'a'.repeat(64),
    imageDigest: `sha256:${'d'.repeat(64)}`,
    cdm: 1,
    classVersion: '1.0.0',
    mathGate: { version: 1, katex: '0.16.0', fingerprint: 'f' },
    fonts: [
      {
        family: 'Text',
        files: [{ file: 'text-regular.otf', sha256: '1'.repeat(64) }] as never,
        licence: 'OFL-1.1',
        role: 'text',
      },
    ],
    options: {
      profile: 'preview',
      tagging: 'off',
      timeZone: 'UTC',
      instant: '2026-11-20T12:00:00.000Z',
    },
    redactions: [],
    files: { 'main.tex': 'a'.repeat(64), 'styles.tex': 'b'.repeat(64) },
    bundleHash: 'c'.repeat(64),
    ...over,
  });
  const note = {
    severity: 'warning',
    code: 'image_alt_missing',
    blockId: 'pAAAAAAAAAAAAAAA',
    message: 'm',
  } as const;

  it('is the same for what does not change the pages', () => {
    const key = previewBundleKey(manifest());
    expect(key).toMatch(/^[0-9a-f]{64}$/);
    expect(previewBundleKey(manifest())).toBe(key);
    const same: Array<Partial<BundleManifest>> = [
      { options: { ...manifest().options, instant: '2026-11-20T15:00:00.000Z' } },
      { seq: 9 },
      { chainHead: null },
      { bundleHash: 'e'.repeat(64) },
      { redactions: [{ kind: 'region', id: 'rAAAAAAAAAAAAAAA' }] },
      { files: { 'styles.tex': 'b'.repeat(64), 'main.tex': 'a'.repeat(64) } },
    ];
    for (const over of same)
      expect(previewBundleKey(manifest(over)), JSON.stringify(over)).toBe(key);
  });

  it('differs with every file, option, class, image, font and diagnostic', () => {
    const key = previewBundleKey(manifest());
    const other: Array<Partial<BundleManifest>> = [
      { files: { 'main.tex': 'f'.repeat(64), 'styles.tex': 'b'.repeat(64) } },
      { files: { ...manifest().files, 'assets/x.png': '9'.repeat(64) } },
      { files: { 'main.tex': 'a'.repeat(64) } },
      { options: { ...manifest().options, tagging: 'draft' } },
      { options: { ...manifest().options, timeZone: 'Europe/London' } },
      { options: { ...manifest().options, classification: 'Internal' } },
      { classVersion: '1.0.1' },
      { imageDigest: `sha256:${'e'.repeat(64)}` },
      { imageDigest: null },
      {
        fonts: [
          {
            family: 'Text',
            files: [{ file: 'text-regular.otf', sha256: '2'.repeat(64) }] as never,
            licence: 'OFL-1.1',
            role: 'text',
          },
        ],
      },
    ];
    const keys = other.map((over) => previewBundleKey(manifest(over)));
    for (const [i, k] of keys.entries()) expect(k, JSON.stringify(other[i])).not.toBe(key);
    expect(new Set(keys).size).toBe(keys.length);
    // The diagnostics the job has before its compile: their order and every member count.
    const withNote = previewBundleKey(manifest(), [note]);
    expect(withNote).not.toBe(key);
    expect(previewBundleKey(manifest(), [note])).toBe(withNote);
    expect(previewBundleKey(manifest(), [{ ...note, blockId: null }])).not.toBe(withNote);
    expect(previewBundleKey(manifest(), [{ ...note, message: 'n' }])).not.toBe(withNote);
    expect(previewBundleKey(manifest(), [note, note])).not.toBe(withNote);
  });
});

describe('EXP-008 the lookup of an earlier preview and the result that shows it', () => {
  const KEY = 'ab'.repeat(32);
  const tenant = 'tenant-1';
  const doc = 'doc-1';
  const job = (over: Partial<JobRecord> = {}): JobRecord =>
    ({ id: 'job-now', tenant, doc, kind: 'preview', createdBy: 'user-1', ...over }) as JobRecord;

  /** Runs one job of the queue to completion with `result`. */
  async function completed(
    queue: MemoryJobQueue,
    result: J,
    over: { doc?: string; kind?: string; by?: string } = {},
  ): Promise<string> {
    const kind = over.kind ?? 'preview';
    const j = await queue.enqueue(tenant, {
      kind,
      doc: over.doc ?? doc,
      createdBy: over.by ?? 'user-1',
      payload: {},
    });
    await queue.claim([kind], 'w', 60_000);
    await queue.complete({ tenant, id: j.id }, 'w', result);
    return j.id;
  }

  it('returns the job that compiled, also when the newest job with the key only showed its files', async () => {
    let now = 1_000_000;
    const queue = new MemoryJobQueue(() => now);
    const lookup = earlierPreviewFrom(queue, { now: () => now });
    expect(await lookup(job(), KEY)).toBeNull();
    const compiled = await completed(queue, {
      output: 'output.pdf',
      log: 'compile.log',
      [PREVIEW_KEY_MEMBER]: KEY,
    });
    expect(await lookup(job(), KEY)).toMatchObject({ id: compiled, createdBy: 'user-1' });
    now += 1000;
    const shown = await completed(
      queue,
      { output: 'output.pdf', log: null, from: compiled, [PREVIEW_KEY_MEMBER]: KEY },
      { by: 'user-2' },
    );
    expect(
      (await queue.findCompletedWith(tenant, doc, 'preview', PREVIEW_KEY_MEMBER, KEY, 0))?.id,
    ).toBe(shown);
    const found = await lookup(job(), KEY);
    expect(found).toMatchObject({ id: compiled, createdBy: 'user-1' });
    expect(found?.result['log']).toBe('compile.log');
    // A job without a document, and the job itself, find nothing.
    expect(await lookup(job({ doc: null }), KEY)).toBeNull();
    expect(await lookup(job({ id: compiled }), KEY)).toBeNull();
    expect(await lookup(job(), 'cd'.repeat(32))).toBeNull();
  });

  it('finds nothing when the job named in `from` is not a compile of this document with this key', async () => {
    const cases: Array<[string, (queue: MemoryJobQueue) => Promise<string>]> = [
      ['no such job', async () => 'missing'],
      [
        'another document',
        (q) => completed(q, { output: 'o', [PREVIEW_KEY_MEMBER]: KEY }, { doc: 'doc-2' }),
      ],
      [
        'another kind',
        (q) => completed(q, { output: 'o', [PREVIEW_KEY_MEMBER]: KEY }, { kind: 'export' }),
      ],
      ['another key', (q) => completed(q, { output: 'o', [PREVIEW_KEY_MEMBER]: 'cd'.repeat(32) })],
      [
        'not completed',
        async (q) =>
          (await q.enqueue(tenant, { kind: 'preview', doc, createdBy: 'u', payload: {} })).id,
      ],
    ];
    for (const [name, make] of cases) {
      const queue = new MemoryJobQueue(() => 1_000_000);
      const from = await make(queue);
      // A job that claims to show the files of `from`.
      const pointer = await queue.enqueue(tenant, {
        kind: 'preview',
        doc,
        createdBy: 'user-2',
        payload: {},
        completedWith: { output: 'o', from, [PREVIEW_KEY_MEMBER]: KEY },
      });
      expect(pointer.state).toBe('completed');
      const lookup = earlierPreviewFrom(queue, { now: () => 1_000_000 });
      expect(await lookup(job(), KEY), name).toBeNull();
    }
  });

  it('builds the result from the compile, with the log for its requester only', () => {
    const earlier = {
      id: 'job-1',
      createdBy: 'user-1',
      result: {
        output: 'output.pdf',
        pages: 2,
        layout: 'layout.json',
        converged: false,
        log: 'compile.log',
        diagnostics: [{ severity: 'info', code: 'preview_one_pass', blockId: null, message: '' }],
        chainHead: 'e'.repeat(64),
        imagesWithoutAlt: 5,
        manifest: 'manifest.json',
        metrics: { totalMs: 1 },
        [PREVIEW_KEY_MEMBER]: KEY,
      },
    };
    const own = { chainHead: 'f'.repeat(64), imagesWithoutAlt: 0 };
    expect(reusedPreview(earlier, job(), KEY, own)).toEqual({
      output: 'output.pdf',
      pages: 2,
      layout: 'layout.json',
      converged: false,
      log: 'compile.log',
      diagnostics: earlier.result.diagnostics,
      chainHead: 'f'.repeat(64),
      imagesWithoutAlt: 0,
      manifest: 'manifest.json',
      from: 'job-1',
      [PREVIEW_KEY_MEMBER]: KEY,
    });
    expect(reusedPreview(earlier, job({ createdBy: 'user-2' }), KEY, own)?.log).toBeNull();
    // Not a result to show: no output, another key, or the job itself.
    expect(
      reusedPreview({ ...earlier, result: { [PREVIEW_KEY_MEMBER]: KEY } }, job(), KEY, own),
    ).toBeNull();
    expect(reusedPreview(earlier, job(), 'cd'.repeat(32), own)).toBeNull();
    expect(reusedPreview(earlier, job({ id: 'job-1' }), KEY, own)).toBeNull();
  });
});
