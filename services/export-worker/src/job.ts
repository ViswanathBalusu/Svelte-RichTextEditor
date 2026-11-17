/**
 * The `export` job handler (09 §1, §9; EXP-001; EXP-060 to EXP-072; ADR 0045): what a worker does
 * with one export job the control plane queued (05 §6.2; D68, D69).
 *
 * 1. Reads the payload the control plane wrote, and refuses one that carries TeX or a bundle.
 * 2. `converting`: reads the content at the job's `seq` from storage, plans the compile from the
 *    options (profile.ts), converts, seals the bundle for this job and verifies it (verify.ts).
 * 3. `compiling`: compiles in a fresh single-use sandbox (sandbox.ts) under the limits of 09 §9.3,
 *    with SOURCE_DATE_EPOCH from the job's creation time; a cancelled job kills its sandbox.
 * 4. Reads every output as hostile: the log through the bounded parser (diagnostics.ts), the layout
 *    through its strict parser and schema (layout.ts), and fails the job with a diagnostic that
 *    names the limit when one was reached (outcome.ts).
 * 5. Stores `output.pdf`, `layout.json`, `compile.log` and `manifest.json` (the result manifest:
 *    bundle hash, class version, image, epoch, passes) under the job's prefix, and returns their
 *    names; the control plane signs URLs at each read, after its permission check.
 *
 * Every storage call uses the tenant of the job's row, never one from the payload (BE-049).
 */
import { createHash, randomBytes } from 'node:crypto';
import {
  CLASS_VERSION,
  bundleAltTextReport,
  cdmWriter,
  htmlText,
  texArchive,
  type Diagnostic,
  type FontManifest,
} from '@docedit/export-latex';
import {
  JobFailure,
  type ExportOutputs,
  type JobContext,
  type JobHandler,
  type JobRecord,
} from '@docedit/document-service';
import { project, type HiddenSet } from '@docedit/authority';
import type { CdmEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { buildBundle, classFiles } from './bundle-io.ts';
import { imageId as readImageId } from './container.ts';
import { chainHeadOf, contentAt, documentLang, type ContentStores } from './content.ts';
import { diagnostic, LOG_LIMITS, parseLog, type ParsedLog } from './diagnostics.ts';
import type { FontFileCheck } from './font-files.ts';
import { buildLayout, parseRawLayout, validateLayout, type LayoutJson } from './layout.ts';
import {
  compileBoth,
  comparePair,
  pinProblem,
  readSealingPin,
  type PairOutcome,
  type SealingPin,
} from './exp-079-pair.ts';
import { limitDiagnostic, limitMessage, limitReached } from './outcome.ts';
import { formatJobDate, planJob, type JobPlan } from './profile.ts';
import {
  compileInSandbox,
  IMAGE,
  type CompileResult,
  type Limits,
  type SandboxOptions,
} from './sandbox.ts';
import { bundleHashOf, checkSeal, sealBundle, verifyBundle } from './verify.ts';

/** Where outputs go: the control plane's asset store (`AssetStore.putExport`). */
export interface ExportOutputStore {
  putExport(
    tenant: string,
    job: string,
    name: string,
    bytes: Uint8Array,
    contentType: string,
  ): Promise<void>;
}

/** The file names of a job's outputs under its prefix (`tenants/{t}/exports/{job}/`). */
export const OUTPUT_FILES = {
  pdf: 'output.pdf',
  layout: 'layout.json',
  log: 'compile.log',
  manifest: 'manifest.json',
} as const;

/**
 * How the attempt that the metrics describe ended (EXP-064 criterion 6): `completed`; `failed`
 * (the handler threw; the runner may retry the job); `aborted` (the job was cancelled or its lease
 * was lost). Stage times of a stage that did not run are 0; consumers that summarise latency read
 * `completed` attempts only.
 */
export type ExportAttemptState = 'completed' | 'failed' | 'aborted';

export interface ExportMetrics {
  /** How the attempt ended. */
  state: ExportAttemptState;
  /** The job's target: `pdf`, `tex` or `cdm` (or the refused value, cut to 20 characters). */
  target: string;
  /** From the job's creation to the start of this attempt, ms. */
  queueWaitMs: number;
  contentMs: number;
  convertMs: number;
  verifyMs: number;
  /** From `podman run` to its exit, ms. */
  sandboxMs: number;
  /** Each pass, as timed inside the sandbox, ms. */
  passMs: number[];
  /** The sandbox's time outside the passes (start, unpacking, output), ms. */
  sandboxOverheadMs: number;
  parseMs: number;
  storeMs: number;
  totalMs: number;
  logBytes: number;
  pdfBytes: number | null;
  pages: number | null;
}

export interface ExportHandlerDeps {
  stores: ContentStores;
  outputs: ExportOutputStore;
  /** The font manifest of the image (fonts.ts). */
  fonts: () => Promise<FontManifest>;
  /**
   * Checks the manifest's font files on the host (font-files.ts; EXP-047 criterion 2). When it
   * reports a problem the job fails before conversion, and no other font is used. Absent: not checked.
   */
  checkFontFiles?: (manifest: FontManifest) => Promise<FontFileCheck>;
  /** The compile; the sandbox by default. Tests replace it. */
  compile?: (
    files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ) => Promise<CompileResult>;
  /** The image that compiles; its identifier goes into the result manifest. */
  image?: string;
  imageId?: (image: string) => Promise<string | null>;
  /** The key of bundle seals; drawn per process when absent. */
  sealKey?: Uint8Array;
  /** Per-job limits; 09 §9.3 item 4 by default. */
  limits?: Partial<Limits>;
  now?: () => number;
  /**
   * Receives the stage times and sizes of every attempt, once, when it ends, with its `state`
   * (EXP-060 criterion 2; EXP-064 criterion 6). A throw from it is ignored: a metrics sink does not
   * change the job's outcome.
   */
  onMetrics?: (metrics: ExportMetrics, job: JobRecord) => void;
  /** Test hook: called with the verified bundle and its seal just before the compile. */
  beforeCompile?: (files: Record<string, string>, seal: string, job: JobRecord) => void;
}

/** The file of the `cdm` target under the job's prefix (EXP-086). */
export const CDM_OUTPUT_FILE = 'output.json';

/** The file of the `html` target under the job's prefix (EXP-087; docs/adr/0371-w2-exp-087-html-job.md). */
export const HTML_OUTPUT_FILE = 'output.html';

/** The file of the `tex` target under the job's prefix: the bundle as one archive (EXP-085). */
export const TEX_OUTPUT_FILE = 'source.tar';

/** Payload members that could carry TeX or a bundle; the control plane writes none of them. */
const TEX_MEMBERS = ['bundle', 'files', 'tex', 'latex', 'preamble', 'packages', 'class', 'mainTex'];

interface Payload {
  doc: string;
  target: string;
  seq: number;
  incarnation: string;
  options: unknown;
  hiddenRegions: string[];
  hiddenValues: string[];
  /** The pin of a sealing export (EXP-079): compiled twice and compared. Null: an ordinary export. */
  sealing: SealingPin | null;
}

function readPayload(job: JobRecord): Payload {
  const p = job.payload;
  for (const k of TEX_MEMBERS)
    if (k in p)
      throw new JobFailure(
        'validation_failed',
        'the job carries TeX or a bundle; workers compile only bundles the converter writes (EXP-067)',
        false,
        { diagnostics: [diagnostic('bundle_refused', null, `The job payload has a member ${k}.`)] },
      );
  const strings = (v: unknown) => Array.isArray(v) && v.every((x) => typeof x === 'string');
  if (
    typeof p['doc'] !== 'string' ||
    p['doc'] !== job.doc ||
    typeof p['target'] !== 'string' ||
    typeof p['seq'] !== 'number' ||
    typeof p['incarnation'] !== 'string' ||
    (p['hiddenRegions'] !== undefined && !strings(p['hiddenRegions'])) ||
    (p['hiddenValues'] !== undefined && !strings(p['hiddenValues']))
  )
    throw new JobFailure('internal', 'the job payload is not one the control plane writes');
  const sealing = readSealingPin(p['sealing']);
  if (sealing === 'invalid')
    throw new JobFailure(
      'internal',
      'the sealing pin of the job is not one the control plane writes',
    );
  return {
    sealing,
    doc: p['doc'],
    target: p['target'],
    seq: p['seq'],
    incarnation: p['incarnation'],
    options: p['options'],
    hiddenRegions: (p['hiddenRegions'] as string[] | undefined) ?? [],
    hiddenValues: (p['hiddenValues'] as string[] | undefined) ?? [],
  };
}

/**
 * The envelope as the requester may read it (EXP-123; ADR 0019; SR-C4): each hidden region and
 * hidden form-field value of the job's payload is replaced by its placeholder, and the titles stay
 * hidden. The converter then prints the neutral notices and lists the redactions in the manifest.
 * Nothing hidden: the envelope is returned unchanged.
 */
function projectedEnvelope(envelope: CdmEnvelope, payload: Payload): CdmEnvelope {
  if (!payload.hiddenRegions.length && !payload.hiddenValues.length) return envelope;
  const hidden: HiddenSet = {
    regions: new Set(payload.hiddenRegions),
    values: new Set(payload.hiddenValues),
    titles: false,
  };
  const doc = project(cdmSchema().nodeFromJSON(envelope.doc), hidden).doc.toJSON();
  return { ...envelope, doc } as CdmEnvelope;
}

const failed = (code: string, message: string, diagnostics: Diagnostic[], retry = false) =>
  new JobFailure(code, message, retry, { diagnostics: dedupe(diagnostics) });

function dedupe(ds: readonly Diagnostic[]): Diagnostic[] {
  const seen = new Set<string>();
  const out: Diagnostic[] = [];
  for (const d of ds) {
    const k = `${d.code}\u0000${d.blockId ?? ''}\u0000${d.message}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(d);
    if (out.length >= 500) break;
  }
  return out;
}

function stopIfCancelled(ctx: JobContext): void {
  if (ctx.signal.aborted) throw new Error('the job was cancelled or its lease was lost');
}

const enc = new TextEncoder();
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The handler to register as `export` (JobRunner, or `startService({ jobHandlers })`). */
export function createExportHandler(deps: ExportHandlerDeps): JobHandler {
  const now = deps.now ?? Date.now;
  const compile = deps.compile ?? compileInSandbox;
  const image = deps.image ?? IMAGE;
  const sealKey = deps.sealKey ?? new Uint8Array(randomBytes(32));
  const pinned = { classFiles: classFiles(), classVersion: CLASS_VERSION };

  // One attempt of the job. It writes each stage time and size into `m` as soon as it is known
  // (EXP-064 criterion 6), so a failed attempt still records the stages that ran and its log size.
  const attempt = async (
    job: JobRecord,
    ctx: JobContext,
    m: ExportMetrics,
  ): Promise<Record<string, unknown>> => {
    const tenant = job.tenant;
    const payload = readPayload(job);
    m.target = payload.target.slice(0, 20);
    if (
      payload.target !== 'pdf' &&
      payload.target !== 'cdm' &&
      payload.target !== 'tex' &&
      payload.target !== 'html'
    )
      throw new JobFailure(
        'validation_failed',
        `this worker exports pdf, tex, cdm and html, not ${payload.target.slice(0, 20)}`,
      );
    // The control plane keys cached results by the class version (EXP-006): a worker with another
    // class leaves the job to one that has it.
    const wanted = job.payload['classVersion'];
    if (typeof wanted === 'string' && wanted !== 'unknown' && wanted !== CLASS_VERSION)
      throw new JobFailure(
        'unavailable',
        `this worker has house class ${CLASS_VERSION}, the job needs ${wanted.slice(0, 40)}`,
        true,
      );
    // The export is of what the requester may read (EXP-123; SR-C4): the envelope is projected below,
    // before the converter sees it, so the hidden content never reaches the bundle.
    await ctx.report('converting', 5);

    // The canonical JSON target (09 §11; EXP-086): the same states, gates and refusals as pdf, then
    // the envelope in its canonical form, with no compile and no sandbox.
    if (payload.target === 'cdm') {
      const cdmContent = await contentAt(
        deps.stores,
        { tenant, doc: payload.doc },
        payload.incarnation,
        payload.seq,
      );
      stopIfCancelled(ctx);
      // The manifest names the chain head of the exported state (HIS-034 criterion 3).
      const cdmChainHead = await chainHeadOf(
        deps.stores,
        { tenant, doc: payload.doc },
        payload.seq,
      );
      const canon = await cdmWriter.write(
        {
          document: projectedEnvelope(cdmContent.envelope, payload),
          seq: payload.seq,
          chainHead: cdmChainHead,
          fonts: await deps.fonts(),
          assets: {},
        },
        {},
      );
      stopIfCancelled(ctx);
      await ctx.report('converting', 50);
      await deps.outputs.putExport(
        tenant,
        job.id,
        CDM_OUTPUT_FILE,
        canon.bytes,
        'application/json',
      );
      const cdmOut: ExportOutputs = {
        output: CDM_OUTPUT_FILE,
        pages: null,
        layout: null,
        converged: null,
        log: null,
        diagnostics: [],
        chainHead: cdmChainHead,
      };
      return cdmOut as unknown as Record<string, unknown>;
    }

    // The HTML target (09 §11; EXP-087): the direct writer reads the projected envelope. It needs no
    // font and no sandbox. The writer's diagnostics are the job's, so a construct HTML cannot
    // express is named in the result (criterion 4). The worker reads no picture bytes, so every
    // picture is written as its alternative text with `image_asset_missing`; the packaging of
    // pictures (criterion 6) waits for that read.
    if (payload.target === 'html') {
      const htmlContent = await contentAt(
        deps.stores,
        { tenant, doc: payload.doc },
        payload.incarnation,
        payload.seq,
      );
      stopIfCancelled(ctx);
      const htmlEnvelope = projectedEnvelope(htmlContent.envelope, payload);
      const htmlPlan = planJob(payload.options, documentLang(htmlEnvelope));
      if (!htmlPlan.ok)
        throw failed(
          'validation_failed',
          'an export option cannot be honoured',
          htmlPlan.diagnostics,
        );
      const htmlChainHead = await chainHeadOf(
        deps.stores,
        { tenant, doc: payload.doc },
        payload.seq,
      );
      const html = htmlText(htmlEnvelope, {
        suggestions: htmlPlan.plan.suggestions,
        ...(htmlContent.title !== null ? { title: htmlContent.title } : {}),
      });
      const htmlDiagnostics: Diagnostic[] = [...htmlPlan.plan.diagnostics, ...html.diagnostics];
      if (!html.ok)
        throw failed(
          'unsupported_feature',
          'the writer cannot write this document',
          htmlDiagnostics,
        );
      stopIfCancelled(ctx);
      await ctx.report('converting', 50);
      await deps.outputs.putExport(
        tenant,
        job.id,
        HTML_OUTPUT_FILE,
        html.bytes,
        'text/html; charset=utf-8',
      );
      const htmlOut: ExportOutputs = {
        output: HTML_OUTPUT_FILE,
        pages: null,
        layout: null,
        converged: null,
        log: null,
        diagnostics: dedupe(htmlDiagnostics),
        chainHead: htmlChainHead,
      };
      return htmlOut as unknown as Record<string, unknown>;
    }

    const t0 = now();
    const { envelope: fullEnvelope, title } = await contentAt(
      deps.stores,
      { tenant, doc: payload.doc },
      payload.incarnation,
      payload.seq,
    );
    const envelope = projectedEnvelope(fullEnvelope, payload);
    m.contentMs = now() - t0;
    stopIfCancelled(ctx);
    const planned = planJob(payload.options, documentLang(envelope));
    if (!planned.ok)
      throw failed('validation_failed', 'an export option cannot be honoured', planned.diagnostics);
    const plan: JobPlan = planned.plan;

    const t1 = now();
    const fonts = await deps.fonts();
    if (deps.checkFontFiles) {
      const check = await deps.checkFontFiles(fonts);
      if (!check.ok)
        throw failed(
          'unavailable',
          'a font of the manifest is missing or does not match its hash; no other font is used (EXP-047)',
          check.problems.map((p) => diagnostic(p.code, null, `${p.family}, ${p.face}: ${p.file}`)),
        );
    }
    // The manifest names the chain head of the exported state (HIS-034 criterion 3).
    const pdfChainHead = await chainHeadOf(deps.stores, { tenant, doc: payload.doc }, payload.seq);
    // The bundle is written with the class pinned when the handler started, the same bytes
    // verifyBundle checks it against below; a second read from disk could see another class.
    const bundle = await buildBundle(
      envelope,
      {
        fonts,
        tagging: plan.tagging,
        pdfStandard: plan.pdfStandard,
        renderer: 'node',
        layout: 'line',
        profile: plan.profile,
        seq: payload.seq,
        chainHead: pdfChainHead,
        title: title ?? 'Document',
        // 09 §3.1: `date` fields print the server's instant at job creation in the job's time zone.
        instant: new Date(job.createdAt).toISOString(),
        timeZone: plan.timeZone,
        date: formatJobDate(job.createdAt, plan),
        fields: plan.fields,
        ...(plan.suggestions ? { suggestions: plan.suggestions } : {}),
      },
      pinned.classFiles,
    );
    m.convertMs = now() - t1;
    const diagnostics: Diagnostic[] = [...plan.diagnostics, ...bundle.diagnostics];
    // Counted from the converter's own list, one per occurrence, before `dedupe` joins the equal
    // diagnostics of two pictures in one block (09 §13; EXP-113 criterion 2).
    const imagesWithoutAlt = bundleAltTextReport(bundle).count;
    if (bundle.ok === false || bundle.diagnostics.some((d) => d.severity === 'error'))
      throw failed('unsupported_feature', 'the converter cannot write this document', diagnostics);

    const t2 = now();
    const assets: Record<string, Uint8Array> = bundle.assets ?? {};
    const bundleHash = bundle.manifest.bundleHash;
    const seal = sealBundle(sealKey, job.id, bundleHash);
    const problems = verifyBundle(bundle.files, pinned, assets);
    if (problems.length || !checkSeal(sealKey, job.id, bundleHashOf(bundle.files), seal))
      throw failed('internal', 'the bundle failed its checks and was not compiled', [
        ...diagnostics,
        ...problems,
      ]);
    m.verifyMs = now() - t2;
    // The tex target (09 §11; EXP-085): the verified bundle as one archive, with no compile and no
    // sandbox. The archive holds the bundle's files and assets and a README (archive.ts).
    if (payload.target === 'tex') {
      stopIfCancelled(ctx);
      await ctx.report('converting', 85);
      const archive = texArchive(bundle);
      stopIfCancelled(ctx);
      await deps.outputs.putExport(tenant, job.id, TEX_OUTPUT_FILE, archive, 'application/x-tar');
      const texOut: ExportOutputs = {
        output: TEX_OUTPUT_FILE,
        pages: null,
        layout: null,
        converged: null,
        log: null,
        diagnostics: dedupe(diagnostics),
        chainHead: bundle.manifest.chainHead,
        imagesWithoutAlt,
      };
      return texOut as unknown as Record<string, unknown>;
    }
    // A sealing export is pinned to the state the workflow completed at (EXP-079 criterion 2): a
    // bundle of another seq or chain head is refused before anything is compiled.
    if (payload.sealing) {
      const mismatch = pinProblem(bundle.manifest, payload.sealing);
      if (mismatch)
        throw failed('validation_failed', 'the bundle does not match the sealing pin', [
          ...diagnostics,
          diagnostic('seal_pin_mismatch', null, mismatch),
        ]);
    }
    deps.beforeCompile?.(bundle.files, seal, job);
    stopIfCancelled(ctx);
    await ctx.report('compiling', 20);

    const sourceDateEpoch = Math.floor(job.createdAt / 1000);
    const compileOptions: SandboxOptions = {
      image,
      minPasses: plan.minPasses,
      maxPasses: plan.maxPasses,
      sourceDateEpoch,
      signal: ctx.signal,
      ...(deps.limits ? { limits: deps.limits } : {}),
    };
    // A sealing export is compiled twice, each in its own sandbox, and the two PDFs are compared
    // (EXP-079 criterion 1). `r` is the first compile, or the second when only that one failed, so the
    // checks below treat a failed compile of either as they do for an ordinary export.
    let r: CompileResult;
    let pair: PairOutcome | null = null;
    let wallMs: number;
    let allPasses: CompileResult['passes'];
    if (payload.sealing) {
      const [first, second] = await compileBoth(
        { ...bundle.files, ...assets },
        compileOptions,
        compile,
      );
      pair = comparePair(first, second);
      r = first.ok && !second.ok ? second : first;
      wallMs = first.wallMs + second.wallMs;
      allPasses = [...first.passes, ...second.passes];
    } else {
      r = await compile({ ...bundle.files, ...assets }, compileOptions);
      wallMs = r.wallMs;
      allPasses = r.passes;
    }
    const passMs = allPasses.map((p) => p.ms);
    // Both compiles of a sealing export are counted, as the sandbox time they took.
    m.sandboxMs = Math.round(wallMs);
    m.passMs = passMs;
    m.sandboxOverheadMs = Math.max(0, Math.round(wallMs - passMs.reduce((a, b) => a + b, 0)));
    stopIfCancelled(ctx);
    await ctx.report('compiling', 85);

    const t3 = now();
    const logBytes = enc.encode(r.log);
    m.logBytes = logBytes.length;
    const log: ParsedLog = parseLog(logBytes, bundle.map);
    diagnostics.push(...log.entries);
    if (!r.ok) {
      const limit = limitReached(r, log);
      if (limit) {
        diagnostics.push(limitDiagnostic(limit, r));
        throw failed('too_large', limitMessage(limit, r), diagnostics);
      }
      if (r.passes.length === 0 && r.exitCode !== 0 && !r.log)
        throw failed('unavailable', 'the sandbox did not run the compile', diagnostics, true);
      throw failed('validation_failed', 'the document did not compile', diagnostics);
    }
    // Two compiles that differ seal nothing (EXP-079 criterion 4): no output is stored, so there is
    // no PDF to seal, and the job fails with a diagnostic that names both hashes.
    if (pair && !pair.ok)
      throw failed('internal', 'the two compiles for sealing differ; nothing is sealed', [
        ...diagnostics,
        diagnostic('seal_pair_differs', null, pair.diagnostic),
      ]);
    let layout: LayoutJson | null = null;
    if (r.layoutRaw !== null) {
      try {
        const built = buildLayout(parseRawLayout(r.layoutRaw), bundle.map, {
          seq: payload.seq,
          classVersion: bundle.manifest.classVersion,
          // One page setup: every page has it. With several, the class does not report them yet.
          setup: bundle.map.setups?.length === 1 ? bundle.map.setups[0]! : null,
        });
        if (validateLayout(built).length === 0) layout = built;
      } catch {
        layout = null;
      }
    }
    if (!layout) diagnostics.push(diagnostic('layout_invalid'));
    const converged = r.converged;
    if (!converged)
      diagnostics.push(
        diagnostic(plan.profile === 'preview' ? 'preview_one_pass' : 'references_not_converged'),
      );
    m.parseMs = now() - t3;

    // Outputs: write the files, then return their names. A cancelled job writes nothing further.
    stopIfCancelled(ctx);
    const t4 = now();
    const pdf = r.pdf!;
    const layoutBytes = layout ? enc.encode(JSON.stringify(layout)) : null;
    const storedLog =
      logBytes.length > LOG_LIMITS.maxBytes ? logBytes.subarray(0, LOG_LIMITS.maxBytes) : logBytes;
    await deps.outputs.putExport(tenant, job.id, OUTPUT_FILES.pdf, pdf, 'application/pdf');
    if (layoutBytes)
      await deps.outputs.putExport(
        tenant,
        job.id,
        OUTPUT_FILES.layout,
        layoutBytes,
        'application/json',
      );
    await deps.outputs.putExport(
      tenant,
      job.id,
      OUTPUT_FILES.log,
      storedLog,
      'text/plain; charset=utf-8',
    );
    const pages = layout ? layout.pages.length : null;
    m.pdfBytes = pdf.length;
    m.pages = pages;
    const manifest = {
      resultVersion: 1,
      job: job.id,
      doc: payload.doc,
      seq: payload.seq,
      chainHead: bundle.manifest.chainHead,
      target: 'pdf',
      profile: plan.profile,
      tagging: plan.tagging,
      pdfStandard: plan.pdfStandard,
      locale: plan.locale,
      timeZone: plan.timeZone,
      sourceDateEpoch,
      bundle: {
        hash: bundleHash,
        classVersion: bundle.manifest.classVersion,
        cdm: bundle.manifest.cdm,
        options: bundle.manifest.options,
      },
      image: { name: image, id: await (deps.imageId ?? readImageId)(image) },
      // The pin and the hashes of both compiles of a sealing export (EXP-079 criterion 3).
      ...(pair?.ok && payload.sealing
        ? {
            sealing: {
              completedSeq: payload.sealing.completedSeq,
              chainHead: payload.sealing.chainHead,
              pdfSha256: pair.hashes,
              compileMs: pair.compileMs,
            },
          }
        : {}),
      passes: r.passes,
      converged,
      limits: r.limits,
      outputs: {
        [OUTPUT_FILES.pdf]: { bytes: pdf.length, sha256: sha256(pdf) },
        ...(layoutBytes
          ? { [OUTPUT_FILES.layout]: { bytes: layoutBytes.length, sha256: sha256(layoutBytes) } }
          : {}),
        [OUTPUT_FILES.log]: {
          bytes: storedLog.length,
          sha256: sha256(storedLog),
          truncated: storedLog.length < logBytes.length,
        },
      },
    };
    await deps.outputs.putExport(
      tenant,
      job.id,
      OUTPUT_FILES.manifest,
      enc.encode(JSON.stringify(manifest, null, 2) + '\n'),
      'application/json',
    );
    m.storeMs = now() - t4;

    const out: ExportOutputs & {
      manifest: string;
      metrics: ExportMetrics;
      sealing?: { pdfSha256: { a: string; b: string }; compileMs: readonly [number, number] };
    } = {
      output: OUTPUT_FILES.pdf,
      pages,
      layout: layoutBytes ? OUTPUT_FILES.layout : null,
      converged,
      log: OUTPUT_FILES.log,
      diagnostics: dedupe(diagnostics),
      // The same value as the manifests: the host reads it from the job (EXP-011 criterion 5).
      chainHead: bundle.manifest.chainHead,
      imagesWithoutAlt,
      manifest: OUTPUT_FILES.manifest,
      metrics: m,
      ...(pair?.ok ? { sealing: { pdfSha256: pair.hashes, compileMs: pair.compileMs } } : {}),
    };
    return out as unknown as Record<string, unknown>;
  };

  // Every attempt reports its metrics once, when it ends, whatever its target and outcome (EXP-064
  // criterion 6): a `cdm` or `tex` job has no compile, so its log size is 0; a failed attempt keeps
  // the stage times it reached and the log size of its compile, if one ran.
  return async (job, ctx) => {
    const started = now();
    const m = attemptMetrics(Math.max(0, started - job.createdAt));
    try {
      const out = await attempt(job, ctx, m);
      m.state = 'completed';
      return out;
    } catch (error) {
      m.state = ctx.signal.aborted ? 'aborted' : 'failed';
      throw error;
    } finally {
      m.totalMs = Math.max(0, now() - started);
      try {
        deps.onMetrics?.(m, job);
      } catch {
        // A metrics sink that throws neither fails the job nor records a second entry.
      }
    }
  };
}

/** The metrics of an attempt before any stage has run: every time and size 0, no PDF. */
function attemptMetrics(queueWaitMs: number): ExportMetrics {
  return {
    state: 'failed',
    target: '',
    queueWaitMs,
    contentMs: 0,
    convertMs: 0,
    verifyMs: 0,
    sandboxMs: 0,
    passMs: [],
    sandboxOverheadMs: 0,
    parseMs: 0,
    storeMs: 0,
    totalMs: 0,
    logBytes: 0,
    pdfBytes: null,
    pages: null,
  };
}
