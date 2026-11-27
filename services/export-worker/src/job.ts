/**
 * The `export` job handler (09 §1, §9; EXP-001; EXP-060 to EXP-072; ADR 0045): what a worker does
 * with one export job the control plane queued (05 §6.2; D68, D69).
 *
 * 1. Reads the payload the control plane wrote, and refuses one that carries TeX or a bundle.
 * 2. `converting`: reads the content at the job's `seq` from storage, plans the compile from the
 *    options (profile.ts), converts, seals the bundle for this job and verifies it (verify.ts).
 *    A preview whose bundle an earlier preview of the document already compiled ends here, with
 *    that preview's files and no compile (preview-reuse.ts; EXP-008 criterion 3).
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
  readCertificateFacts,
  markdownText,
  mathGateReason,
  settleSuggestions,
  tar,
  texArchive,
  type CertificateFacts,
  type Diagnostic,
  type FontManifest,
  type CommentThread,
  type SuggestionAccess,
} from '@docedit/export-latex';
import {
  checkQueueProof,
  JobFailure,
  type ExportOutputs,
  type JobContext,
  type JobHandler,
  type JobRecord,
} from '@docedit/document-service';
import { project, type HiddenSet } from '@docedit/authority';
import { exportDocx, writeDocx } from '@docedit/export-docx';
import type { CdmEnvelope } from '@docedit/model';
import { cdmSchema } from '@docedit/model/prosemirror';
import { buildBundle, classFiles } from './bundle-io.ts';
import { imageDigest as readImageDigest, imageId as readImageId } from './container.ts';
import { chainHeadOf, contentAt, documentLang, type ContentStores } from './content.ts';
import { diagnostic, LOG_LIMITS, parseLog, type ParsedLog } from './diagnostics.ts';
import type { FontFileCheck } from './font-files.ts';
import { tenantFonts as loadTenantFonts, type TenantFontSource } from './tenant-fonts.ts';
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
import {
  PREVIEW_KEY_MEMBER,
  previewBundleKey,
  reusedPreview,
  type EarlierPreviewLookup,
} from './preview-reuse.ts';
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
  /** The job's target: `pdf`, `tex`, `docx`, `cdm`, `html` or `md` (or the refused value, cut to 20 characters). */
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
  /**
   * True when the attempt compiled nothing, because it shows the files of an earlier preview of
   * the same bundle (preview-reuse.ts; EXP-008 criterion 3): its sandbox times are 0 and it has no
   * PDF size, so a latency summary leaves it out (metrics-log.ts). Absent otherwise.
   */
  reused?: boolean;
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
  /**
   * The fonts tenants added (tenant-fonts.ts; EXP-048). A job asks for its own tenant only, so a
   * font of another tenant is neither in its manifest nor among the files it compiles with. Absent:
   * the job has the image's fonts only.
   */
  tenantFonts?: TenantFontSource;
  /** The compile; the sandbox by default. Tests replace it. */
  compile?: (
    files: Readonly<Record<string, string | Uint8Array>>,
    opts: SandboxOptions,
  ) => Promise<CompileResult>;
  /**
   * The bytes of a final asset by its SHA-256 (`AssetStore.getFinal`; EXP-087 criterion 6). Absent:
   * no picture travels with an `html` export, and each is written as its alternative text with the
   * warning `image_asset_missing`.
   */
  assetBytes?: (tenant: string, sha256: string) => Promise<Uint8Array | null>;
  /** The image that compiles; its identifier goes into the result manifest. */
  image?: string;
  imageId?: (image: string) => Promise<string | null>;
  /**
   * The manifest digest of the image (`sha256:...`), recorded in the bundle's `manifest.json` and in the
   * result manifest (EXP-073 criterion 2; EXP-076 criterion 4). When `imageId` is replaced and this is
   * not, no digest is looked up and none is recorded, so a test that stubs the image identity does not
   * call the container runtime.
   */
  imageDigest?: (image: string) => Promise<string | null>;
  /** The key of bundle seals; drawn per process when absent. */
  sealKey?: Uint8Array;
  /**
   * The key of the queue proof (EXP-067 criterion 4; `DOCEDIT_EXPORT_PROOF_KEY`). When set, a job
   * whose payload lacks the proof the control plane writes with the same key is refused before the
   * payload is read. Absent: the proof is not checked.
   */
  queueProofKey?: string;
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
  /**
   * Finds an earlier preview of the job's document with the same preview key (preview-reuse.ts;
   * EXP-008 criterion 3). When it finds one, a preview job shows that preview's files again and
   * compiles nothing. Absent: every preview compiles.
   */
  earlierPreview?: EarlierPreviewLookup;
}

/** The file of the `cdm` target under the job's prefix (EXP-086). */
export const CDM_OUTPUT_FILE = 'output.json';

/** The file of the `html` target under the job's prefix (EXP-087; docs/adr/0371-w2-exp-087-html-job.md). */
export const HTML_OUTPUT_FILE = 'output.html';

/**
 * The `html` target with pictures: one archive holding `index.html` and `assets/`, the paths the
 * writer wrote in `src` (EXP-087 criterion 6; docs/adr/0371-w2-exp-087-html-job.md).
 */
export const HTML_ARCHIVE_FILE = 'output.tar';

/** The file of the `md` target under the job's prefix (EXP-088). */
export const MD_OUTPUT_FILE = 'output.md';

/** The file of the `docx` target under the job's prefix (EXP-090). */
export const DOCX_OUTPUT_FILE = 'output.docx';
const DOCX_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

/** A picture as the DOCX writer's asset source gives it (`Asset` of `@docedit/export-docx`). */
interface DocxAsset {
  readonly id: string;
  readonly bytes: Uint8Array;
  readonly contentType: string;
  readonly sha256: string;
  readonly role: 'image' | 'fragment';
  readonly serverOnly: boolean;
}

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
  /** The facts of the certificate of completion (FRW-050), written by the control plane; or null. */
  certificate: CertificateFacts | null;
  /** The owners of the suggestion identifiers and the requester's grants (EXP-081); or null. */
  suggestionAccess: SuggestionAccess | null;
  /** The comment threads at the exported `seq` (EXP-084), written by the control plane; or none. */
  commentThreads: CommentThread[];
  /** The server time of the commit that introduced each suggestion, by identifier (EXP-093). */
  suggestionDates: Record<string, string>;
  /** The ready assets of the document that the exported content names, by identifier (EXP-087). */
  assets: Record<string, { sha256: string; mediaType: string }>;
  /** A full export: the requester manages the document and asked for everything (EXP-123 criterion 1). */
  full: boolean;
  /**
   * The imported Word file, its source map and its fragments, for a `docx` export that patches the
   * original package (ADR 0017; EXP-090 criterion 5). The control plane writes it for a full export
   * only (EXP-123 criterion 3); the worker uses it for no other.
   */
  preservation: Preservation | null;
}

interface AssetRef {
  sha256: string;
  mediaType: string;
}
interface Preservation {
  original: AssetRef;
  sourceMap: AssetRef;
  fragments: Record<string, AssetRef>;
}

/**
 * The imported file, its source map and its fragments, each read by hash and checked against it;
 * null when any is missing or does not match (the job then writes from the document instead).
 */
async function readOriginal(
  read: (tenant: string, sha256: string) => Promise<Uint8Array | null>,
  tenant: string,
  p: Preservation,
): Promise<{ original: Uint8Array; sourceMap: unknown; fragments: Map<string, DocxAsset> } | null> {
  const get = async (a: AssetRef): Promise<Uint8Array | null> => {
    const bytes = await read(tenant, a.sha256);
    return bytes !== null && sha256(bytes) === a.sha256 ? bytes : null;
  };
  const original = await get(p.original);
  const map = await get(p.sourceMap);
  if (!original || !map) return null;
  let sourceMap: unknown;
  try {
    sourceMap = JSON.parse(new TextDecoder().decode(map));
  } catch {
    return null;
  }
  const fragments = new Map<string, DocxAsset>();
  for (const [id, a] of Object.entries(p.fragments)) {
    const bytes = await get(a);
    if (!bytes) return null;
    fragments.set(id, {
      id,
      bytes,
      contentType: a.mediaType,
      sha256: a.sha256,
      role: 'fragment',
      serverOnly: true,
    });
  }
  return { original, sourceMap, fragments };
}

/** The preservation members of a payload, or `invalid` when they are not the shape the control plane writes. */
function readPreservation(v: unknown): Preservation | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const o = v as Record<string, unknown>;
  const original = readAssets({ original: o['original'] });
  const sourceMap = readAssets({ sourceMap: o['sourceMap'] });
  const fragments = readAssets(o['fragments']);
  if (original === 'invalid' || sourceMap === 'invalid' || fragments === 'invalid')
    return 'invalid';
  if (!original['original'] || !sourceMap['sourceMap']) return 'invalid';
  return { original: original['original'], sourceMap: sourceMap['sourceMap'], fragments };
}

/** The suggestion dates of a payload, or `invalid` when they are not the shape the control plane writes. */
function readSuggestionDates(v: unknown): Payload['suggestionDates'] | 'invalid' {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const out: Payload['suggestionDates'] = Object.create(null) as Payload['suggestionDates'];
  const entries = Object.entries(v);
  if (entries.length > 5000) return 'invalid';
  for (const [id, t] of entries) {
    // Canonical timestamps only (`formatTimestamp` of the model): a date is never free text.
    if (id.length > 64 || typeof t !== 'string' || !/^\d{4}-\d\d-\d\dT[\d:.]+Z$/.test(t))
      return 'invalid';
    out[id] = t;
  }
  return out;
}

/** The picture types an HTML page shows, and the file extension each gets in the archive. */
const HTML_PICTURES: Readonly<Record<string, string>> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/gif': '.gif',
  'image/webp': '.webp',
};

/** The assets of a payload, or `invalid` when they are not the shape the control plane writes. */
function readAssets(v: unknown): Payload['assets'] | 'invalid' {
  if (v === undefined || v === null) return {};
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const out: Payload['assets'] = Object.create(null) as Payload['assets'];
  const entries = Object.entries(v);
  if (entries.length > 2000) return 'invalid';
  for (const [id, a] of entries) {
    const o = (typeof a === 'object' && a !== null ? a : {}) as Record<string, unknown>;
    if (
      id.length > 64 ||
      typeof o['sha256'] !== 'string' ||
      !/^[0-9a-f]{64}$/.test(o['sha256']) ||
      typeof o['mediaType'] !== 'string' ||
      o['mediaType'].length > 100
    )
      return 'invalid';
    out[id] = { sha256: o['sha256'], mediaType: o['mediaType'] };
  }
  return out;
}

/** The comment threads of a payload, or `invalid` when they are not the shape the control plane writes. */
function readCommentThreads(v: unknown): CommentThread[] | 'invalid' {
  if (v === undefined || v === null) return [];
  if (!Array.isArray(v) || v.length > 1000) return 'invalid';
  const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length <= max;
  const out: CommentThread[] = [];
  for (const raw of v as unknown[]) {
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return 'invalid';
    const o = raw as Record<string, unknown>;
    const messages = o['messages'];
    if (!text(o['id'], 64) || !text(o['block'], 64) || !Array.isArray(messages)) return 'invalid';
    if (messages.length > 200) return 'invalid';
    if (o['quote'] !== undefined && !text(o['quote'], 1000)) return 'invalid';
    if (o['done'] !== undefined && typeof o['done'] !== 'boolean') return 'invalid';
    if (o['detached'] !== undefined && typeof o['detached'] !== 'boolean') return 'invalid';
    const msgs: Array<{ author: string; text: string }> = [];
    for (const m of messages as unknown[]) {
      const mo = (typeof m === 'object' && m !== null ? m : {}) as Record<string, unknown>;
      if (!text(mo['author'], 200) || !text(mo['text'], 20_000)) return 'invalid';
      msgs.push({ author: mo['author'], text: mo['text'] });
    }
    out.push({
      id: o['id'],
      block: o['block'],
      ...(o['quote'] !== undefined ? { quote: o['quote'] as string } : {}),
      ...(o['done'] === true ? { done: true } : {}),
      ...(o['detached'] === true ? { detached: true } : {}),
      messages: msgs,
    });
  }
  return out;
}

/** The access of a payload, or `invalid` when it is not the shape the control plane writes. */
function readSuggestionAccess(v: unknown): SuggestionAccess | null | 'invalid' {
  if (v === undefined || v === null) return null;
  if (typeof v !== 'object' || Array.isArray(v)) return 'invalid';
  const o = v as Record<string, unknown>;
  const owners = o['owners'];
  const edit = o['edit'];
  if (typeof owners !== 'object' || owners === null || Array.isArray(owners)) return 'invalid';
  const map: Record<string, string> = Object.create(null) as Record<string, string>;
  for (const [k, u] of Object.entries(owners)) {
    if (typeof u !== 'string') return 'invalid';
    map[k] = u;
  }
  if (edit !== 'all' && !(Array.isArray(edit) && edit.every((s) => typeof s === 'string')))
    return 'invalid';
  return { owners: map, edit: edit as 'all' | string[] };
}

function readPayload(job: JobRecord, proofKey: string | undefined): Payload {
  const p = job.payload;
  if (
    proofKey !== undefined &&
    !checkQueueProof(
      proofKey,
      { tenant: job.tenant, kind: job.kind, doc: job.doc, cacheKey: job.cacheKey },
      p,
    )
  )
    throw new JobFailure(
      'validation_failed',
      'the job was not queued by the control plane; workers compile only what it queued (EXP-067)',
      false,
      {
        diagnostics: [
          diagnostic('bundle_refused', null, 'The job does not carry the control plane proof.'),
        ],
      },
    );
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
  const certificate = readCertificateFacts(p['certificate']);
  if (certificate === 'invalid')
    throw new JobFailure(
      'internal',
      'the certificate facts of the job are not the shape the control plane writes',
    );
  const suggestionAccess = readSuggestionAccess(p['suggestionAccess']);
  if (suggestionAccess === 'invalid')
    throw new JobFailure(
      'internal',
      'the suggestion access of the job is not the shape the control plane writes',
    );
  const commentThreads = readCommentThreads(p['commentThreads']);
  if (commentThreads === 'invalid')
    throw new JobFailure(
      'internal',
      'the comment threads of the job are not the shape the control plane writes',
    );
  const suggestionDates = readSuggestionDates(p['suggestionDates']);
  if (suggestionDates === 'invalid')
    throw new JobFailure(
      'internal',
      'the suggestion dates of the job are not the shape the control plane writes',
    );
  const assets = readAssets(p['assets']);
  if (assets === 'invalid')
    throw new JobFailure(
      'internal',
      'the assets of the job are not the shape the control plane writes',
    );
  const preservation = readPreservation(p['preservation']);
  if (preservation === 'invalid')
    throw new JobFailure(
      'internal',
      'the preservation members of the job are not the shape the control plane writes',
    );
  return {
    sealing,
    certificate,
    suggestionAccess,
    commentThreads,
    suggestionDates,
    assets,
    // Only the control plane's own `true` counts, and a hidden region or value makes it not full.
    full:
      p['full'] === true &&
      !((p['hiddenRegions'] as unknown[] | undefined)?.length ?? 0) &&
      !((p['hiddenValues'] as unknown[] | undefined)?.length ?? 0),
    preservation,
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
  const readDigest = deps.imageDigest ?? (deps.imageId ? async () => null : readImageDigest);
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
    const payload = readPayload(job, deps.queueProofKey);
    m.target = payload.target.slice(0, 20);
    if (
      payload.target !== 'pdf' &&
      payload.target !== 'cdm' &&
      payload.target !== 'tex' &&
      payload.target !== 'html' &&
      payload.target !== 'md' &&
      payload.target !== 'docx'
    )
      throw new JobFailure(
        'validation_failed',
        `this worker exports pdf, tex, docx, cdm, html and md, not ${payload.target.slice(0, 20)}`,
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
    // express is named in the result (criterion 4). Pictures travel with the page when the worker
    // can read the asset bytes (`deps.assetBytes`; criterion 6).
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
      // The pictures (EXP-087 criterion 6): the control plane named the ready assets of this
      // document that the content uses; the bytes are read by hash and checked against it. A
      // picture of a type a page cannot show, or whose bytes are missing or do not match, stays
      // out of the writer's list and so is written as its alternative text with
      // `image_asset_missing`.
      const pictures: Record<string, { extension: string }> = {};
      const pictureBytes = new Map<string, Uint8Array>();
      const pictureProblems: Diagnostic[] = [];
      if (deps.assetBytes) {
        for (const [id, a] of Object.entries(payload.assets)) {
          const extension = HTML_PICTURES[a.mediaType];
          if (extension === undefined) continue;
          const bytes = await deps.assetBytes(tenant, a.sha256);
          if (bytes === null || createHash('sha256').update(bytes).digest('hex') !== a.sha256) {
            pictureProblems.push({
              severity: 'warning',
              code: 'image_asset_missing',
              blockId: null,
              message: `the bytes of a picture (asset ${id.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '')}) are not in the store or do not match their hash; its alternative text is written instead`,
            });
            continue;
          }
          pictures[id] = { extension };
          pictureBytes.set(id, bytes);
        }
        stopIfCancelled(ctx);
      }
      const html = htmlText(
        htmlEnvelope,
        {
          suggestions: htmlPlan.plan.suggestions,
          ...(payload.suggestionAccess ? { suggestionAccess: payload.suggestionAccess } : {}),
          ...(htmlContent.title !== null ? { title: htmlContent.title } : {}),
          // The classification marking (EXP-089): before and after the content, when there is a label.
          classification: htmlContent.classification,
        },
        pictures,
      );
      const htmlDiagnostics: Diagnostic[] = [
        ...htmlPlan.plan.diagnostics,
        ...pictureProblems,
        ...html.diagnostics,
      ];
      if (!html.ok)
        throw failed(
          'unsupported_feature',
          'the writer cannot write this document',
          htmlDiagnostics,
        );
      stopIfCancelled(ctx);
      await ctx.report('converting', 50);
      // With no picture the output is the page itself; with pictures it is an archive of
      // `index.html` and the files the page names (the writer's `assets` list).
      const used = html.assets.filter((p) => pictureBytes.has(p.asset));
      let htmlFile = HTML_OUTPUT_FILE;
      if (used.length === 0) {
        await deps.outputs.putExport(
          tenant,
          job.id,
          HTML_OUTPUT_FILE,
          html.bytes,
          'text/html; charset=utf-8',
        );
      } else {
        htmlFile = HTML_ARCHIVE_FILE;
        const files = new Map<string, Uint8Array>([['index.html', html.bytes]]);
        for (const p of used) files.set(p.path, pictureBytes.get(p.asset)!);
        await deps.outputs.putExport(
          tenant,
          job.id,
          HTML_ARCHIVE_FILE,
          tar(files),
          'application/x-tar',
        );
      }
      const htmlOut: ExportOutputs = {
        output: htmlFile,
        pages: null,
        layout: null,
        converged: null,
        log: null,
        diagnostics: dedupe(htmlDiagnostics),
        chainHead: htmlChainHead,
      };
      return htmlOut as unknown as Record<string, unknown>;
    }

    // The Markdown target (09 §11; EXP-088): the direct writer reads the projected envelope, as the
    // html target does. The worker reads no picture bytes, so a picture is written as its alternative
    // text with `image_asset_missing`; the writer's diagnostics are the job's warnings (criteria 1, 3).
    if (payload.target === 'md') {
      const mdContent = await contentAt(
        deps.stores,
        { tenant, doc: payload.doc },
        payload.incarnation,
        payload.seq,
      );
      stopIfCancelled(ctx);
      const mdEnvelope = projectedEnvelope(mdContent.envelope, payload);
      const mdPlan = planJob(payload.options, documentLang(mdEnvelope));
      if (!mdPlan.ok)
        throw failed(
          'validation_failed',
          'an export option cannot be honoured',
          mdPlan.diagnostics,
        );
      const mdChainHead = await chainHeadOf(deps.stores, { tenant, doc: payload.doc }, payload.seq);
      const md = markdownText(mdEnvelope, {
        suggestions: mdPlan.plan.suggestions,
        ...(payload.suggestionAccess ? { suggestionAccess: payload.suggestionAccess } : {}),
        // The classification marking (EXP-089): a line before and a line after the content.
        classification: mdContent.classification,
      });
      const mdDiagnostics: Diagnostic[] = [...mdPlan.plan.diagnostics, ...md.diagnostics];
      if (!md.ok)
        throw failed('unsupported_feature', 'the writer cannot write this document', mdDiagnostics);
      stopIfCancelled(ctx);
      await ctx.report('converting', 50);
      await deps.outputs.putExport(
        tenant,
        job.id,
        MD_OUTPUT_FILE,
        md.bytes,
        'text/markdown; charset=utf-8',
      );
      const mdOut: ExportOutputs = {
        output: MD_OUTPUT_FILE,
        pages: null,
        layout: null,
        converged: null,
        log: null,
        diagnostics: dedupe(mdDiagnostics),
        chainHead: mdChainHead,
      };
      return mdOut as unknown as Record<string, unknown>;
    }

    // The DOCX target (09 §11; EXP-090): the direct writer of `@docedit/export-docx` reads the
    // projected envelope and writes the package; no TeX, no font file and no sandbox are used. The
    // writer's warnings, one for each construct it approximates or leaves out, are the job's
    // warnings (criterion 5). Suggestions are settled here with the same rule and the same
    // permission as the other targets, so a requester who may not accept a deletion does not get it
    // accepted; with `markup` the writer writes them as tracked changes. A document imported from
    // Word is written from the CDM like any other: the preservation layer needs the original
    // package, which the job does not read (EXP-118; see the story's Notes).
    if (payload.target === 'docx') {
      const docxContent = await contentAt(
        deps.stores,
        { tenant, doc: payload.doc },
        payload.incarnation,
        payload.seq,
      );
      stopIfCancelled(ctx);
      const docxEnvelope = projectedEnvelope(docxContent.envelope, payload);
      const docxPlan = planJob(payload.options, documentLang(docxEnvelope));
      if (!docxPlan.ok)
        throw failed(
          'validation_failed',
          'an export option cannot be honoured',
          docxPlan.diagnostics,
        );
      const docxChainHead = await chainHeadOf(
        deps.stores,
        { tenant, doc: payload.doc },
        payload.seq,
      );
      const docxFonts = await deps.fonts();
      const settledDiagnostics: Diagnostic[] = [];
      const settledDoc =
        docxPlan.plan.suggestions === 'markup'
          ? docxEnvelope.doc
          : (settleSuggestions(
              docxEnvelope.doc as never,
              docxPlan.plan.suggestions,
              settledDiagnostics,
              payload.suggestionAccess ?? undefined,
            ) as unknown as CdmEnvelope['doc']);
      // The pictures, as the html target reads them: by hash, checked against it. A picture whose
      // bytes are missing or do not match is left out, and the writer names it in its warnings.
      const pictures = new Map<string, DocxAsset>();
      const pictureProblems: Diagnostic[] = [];
      if (deps.assetBytes) {
        for (const [id, a] of Object.entries(payload.assets)) {
          if (HTML_PICTURES[a.mediaType] === undefined) continue;
          const bytes = await deps.assetBytes(tenant, a.sha256);
          if (bytes === null || sha256(bytes) !== a.sha256) {
            pictureProblems.push({
              severity: 'warning',
              code: 'image_asset_missing',
              blockId: null,
              message: `the bytes of a picture (asset ${id.slice(0, 40).replace(/[^A-Za-z0-9_-]/g, '')}) are not in the store or do not match their hash; it is left out`,
            });
            continue;
          }
          pictures.set(id, {
            id,
            bytes,
            contentType: a.mediaType,
            sha256: a.sha256,
            role: 'image',
            serverOnly: false,
          });
        }
        stopIfCancelled(ctx);
      }
      // A full export of a document imported from Word patches the original package, so that what
      // the model does not hold survives (ADR 0017; EXP-090 criterion 5). Only a full export does:
      // a requester who may not read everything gets a package written from what they may read,
      // and the original is neither read nor patched here (EXP-123 criterion 3; SR-C1). The worker
      // looks at the control plane's `full` and at its own check that nothing is hidden.
      const patchingDiagnostics: Diagnostic[] = [];
      let written: { bytes: Uint8Array; warnings: string[] } | null = null;
      if (payload.full && payload.preservation !== null && deps.assetBytes) {
        const original = await readOriginal(deps.assetBytes, tenant, payload.preservation);
        stopIfCancelled(ctx);
        if (!original)
          patchingDiagnostics.push(
            diagnostic(
              'docx_approximation',
              null,
              'the imported Word file or its source map could not be read, so the package is written from the document and what the model does not hold is lost',
            ),
          );
        else
          try {
            written = await exportDocx(
              { ...docxEnvelope, doc: settledDoc } as unknown as Parameters<typeof exportDocx>[0],
              original.original,
              original.sourceMap as Parameters<typeof exportDocx>[2],
              { get: (id) => pictures.get(id) ?? original.fragments.get(id) },
            );
          } catch (e) {
            patchingDiagnostics.push(
              diagnostic(
                'docx_approximation',
                null,
                `the original package could not be patched (${e instanceof Error ? e.message.slice(0, 200) : 'error'}), so the package is written from the document and what the model does not hold is lost`,
              ),
            );
          }
      }
      try {
        written ??= await writeDocx(
          { ...docxEnvelope, doc: settledDoc } as unknown as Parameters<typeof writeDocx>[0],
          { get: (id) => pictures.get(id) },
          {
            suggestions: 'markup',
            // The commit time of each suggestion, from the control plane (EXP-093 criterion 2).
            suggestionDates: payload.suggestionDates,
            instant: new Date(job.createdAt).toISOString(),
            timeZone: docxPlan.plan.timeZone,
            ...(docxContent.title !== null ? { title: docxContent.title } : {}),
            classification: docxContent.classification,
            defaultFont: docxFonts.defaultFamily,
            // The math gate of EXP-049, the same one the PDF's converter uses (EXP-096).
            mathGate: (latex, display) => mathGateReason(latex, display),
          },
        );
      } catch (e) {
        throw failed('unsupported_feature', 'the DOCX writer cannot write this document', [
          diagnostic('docx_writer_failed', null, e instanceof Error ? e.message : String(e)),
        ]);
      }
      const docxDiagnostics: Diagnostic[] = [
        ...docxPlan.plan.diagnostics,
        ...settledDiagnostics,
        ...pictureProblems,
        ...patchingDiagnostics,
        ...written!.warnings.map((w) => diagnostic('docx_approximation', null, w)),
      ];
      stopIfCancelled(ctx);
      await ctx.report('converting', 50);
      await deps.outputs.putExport(
        tenant,
        job.id,
        DOCX_OUTPUT_FILE,
        written!.bytes,
        DOCX_CONTENT_TYPE,
      );
      const docxOut: ExportOutputs = {
        output: DOCX_OUTPUT_FILE,
        pages: null,
        layout: null,
        converged: null,
        log: null,
        diagnostics: dedupe(docxDiagnostics),
        chainHead: docxChainHead,
      };
      return docxOut as unknown as Record<string, unknown>;
    }

    const t0 = now();
    const {
      envelope: fullEnvelope,
      title,
      classification,
    } = await contentAt(
      deps.stores,
      { tenant, doc: payload.doc },
      payload.incarnation,
      payload.seq,
    );
    const envelope = projectedEnvelope(fullEnvelope, payload);
    m.contentMs = now() - t0;
    stopIfCancelled(ctx);
    const planned = planJob(payload.options, documentLang(envelope), {
      certificateFacts: payload.certificate !== null,
      marginComments: true,
    });
    if (!planned.ok)
      throw failed('validation_failed', 'an export option cannot be honoured', planned.diagnostics);
    const plan: JobPlan = planned.plan;

    const t1 = now();
    const digest = await readDigest(image);
    const imageFonts = await deps.fonts();
    if (deps.checkFontFiles) {
      const check = await deps.checkFontFiles(imageFonts);
      if (!check.ok)
        throw failed(
          'unavailable',
          'a font of the manifest is missing or does not match its hash; no other font is used (EXP-047)',
          check.problems.map((p) => diagnostic(p.code, null, `${p.family}, ${p.face}: ${p.file}`)),
        );
    }
    // The tenant's own fonts join the manifest of this job, and their files go with the compile.
    const tenantSet = deps.tenantFonts
      ? await loadTenantFonts(deps.tenantFonts, tenant, imageFonts)
      : null;
    const fonts = tenantSet ? tenantSet.manifest : imageFonts;
    const tenantFontFiles = tenantSet ? tenantSet.files : {};
    // The manifest names the chain head of the exported state (HIS-034 criterion 3).
    const pdfChainHead = await chainHeadOf(deps.stores, { tenant, doc: payload.doc }, payload.seq);
    // The bundle is written with the class pinned when the handler started, the same bytes
    // verifyBundle checks it against below; a second read from disk could see another class.
    const bundle = await buildBundle(
      envelope,
      {
        fonts,
        imageDigest: digest,
        tagging: plan.tagging,
        pdfStandard: plan.pdfStandard,
        renderer: 'node',
        layout: 'line',
        profile: plan.profile,
        seq: payload.seq,
        chainHead: pdfChainHead,
        title: title ?? 'Document',
        // The classification marking (EXP-089): absent when the document has no label.
        ...(classification ? { classification } : {}),
        // 09 §3.1: `date` fields print the server's instant at job creation in the job's time zone.
        instant: new Date(job.createdAt).toISOString(),
        timeZone: plan.timeZone,
        date: formatJobDate(job.createdAt, plan),
        fields: plan.fields,
        ...(plan.suggestions ? { suggestions: plan.suggestions } : {}),
        ...(payload.suggestionAccess ? { suggestionAccess: payload.suggestionAccess } : {}),
        // The comment threads at the exported `seq` (EXP-084): the control plane wrote them.
        ...(plan.comments === 'margin'
          ? { comments: 'margin' as const, commentThreads: payload.commentThreads }
          : {}),
        // The certificate of completion (FRW-050): facts the control plane wrote, never a client's.
        ...(payload.certificate ? { certificate: payload.certificate } : {}),
      },
      pinned.classFiles,
    );
    m.convertMs = now() - t1;
    const diagnostics: Diagnostic[] = [
      ...plan.diagnostics,
      ...(tenantSet ? tenantSet.diagnostics : []),
      ...bundle.diagnostics,
    ];
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
    // A preview whose bundle is that of an earlier preview of the document shows that preview's
    // files again, and nothing is compiled (06 §10; EXP-008 criterion 3). The key leaves out the
    // job's instant, which is why it can match across jobs, and takes in the diagnostics the job
    // has so far, so that the earlier result is the one this job's own compile would give
    // (preview-reuse.ts).
    const previewKey =
      plan.profile === 'preview' && !payload.sealing
        ? previewBundleKey(bundle.manifest, diagnostics)
        : null;
    if (previewKey !== null && deps.earlierPreview) {
      // A lookup that fails is a miss: showing earlier files saves a compile and is never needed
      // for a correct result, so the preview is compiled instead.
      const earlier = await deps.earlierPreview(job, previewKey).catch(() => null);
      const reused = earlier
        ? reusedPreview(earlier, job, previewKey, {
            chainHead: bundle.manifest.chainHead,
            imagesWithoutAlt,
          })
        : null;
      if (reused) {
        stopIfCancelled(ctx);
        m.reused = true;
        m.pages = reused.pages ?? null;
        return { ...reused, metrics: m };
      }
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
        { ...bundle.files, ...assets, ...tenantFontFiles },
        compileOptions,
        compile,
      );
      pair = comparePair(first, second);
      r = first.ok && !second.ok ? second : first;
      wallMs = first.wallMs + second.wallMs;
      allPasses = [...first.passes, ...second.passes];
    } else {
      r = await compile({ ...bundle.files, ...assets, ...tenantFontFiles }, compileOptions);
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
        // The job ends `failed` (EXP-071 criterion 2) and its result still says that the page
        // references did not converge, and how many passes ran (EXP-061 criterion 4).
        throw new JobFailure('too_large', limitMessage(limit, r), false, {
          diagnostics: dedupe(diagnostics),
          converged: r.converged,
          passes: r.passes.length,
        });
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
      image: { name: image, id: await (deps.imageId ?? readImageId)(image), digest },
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
    // A later preview of the same bundle finds this one by its key (EXP-008 criterion 3).
    return {
      ...(out as unknown as Record<string, unknown>),
      ...(previewKey !== null ? { [PREVIEW_KEY_MEMBER]: previewKey } : {}),
    };
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
