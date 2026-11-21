/**
 * A preview whose bundle has not changed since an earlier preview of the document is answered with
 * that preview's files, and nothing is compiled (06 §10: "skipped when the bundle hash is
 * unchanged"; 09 §8: PDFs cached by bundle hash, previews and final exports apart; EXP-008
 * criterion 3).
 *
 * The control plane answers an identical request from its first result before a job is queued
 * (EXP-006). That key holds the `seq`, so it cannot see that the document changed without the
 * bundle changing: an edit somebody undid, an edit in a part hidden from this reader, or a change
 * that does not print (a region's title). The bundle is known only once the converter has run, so
 * this check is the worker's, after conversion and before the compile.
 *
 * What is compared is the preview key: the bundle hash without the job's instant, with the class
 * version, the image, the fonts and the converter's diagnostics. `manifest.bundleHash` itself holds
 * the instant of the job (EXP-005: every option joins the hash), so it differs for every job and
 * could never be "unchanged". The instant reaches the files only through `date` fields, whose
 * printed text is in `main.tex` and so in the key; leaving the instant out therefore loses nothing
 * a preview shows. The PDF's own metadata keeps the date of the job that compiled it.
 *
 * Equal keys mean that this job's own compile would give the same pages, the same layout report and
 * the same diagnostics as the earlier one did (09 §9.4: the same bundle and image give the same
 * PDF). So the result of a job that shows the earlier files is the result its own compile would
 * have had, except for where the files are and who may read the raw log.
 *
 * The worker only reads the queue here. It never reads an earlier job's files: workers hold no
 * credential but a write-only upload location (09 §9.3 item 6). The result names the job whose
 * files it shows in `from`, as a cached result of the control plane does, and the control plane
 * signs the URLs.
 *
 * Proposed, see docs/adr/0421-w2-EXP-008-preview-start-gap-and-reuse.md.
 */
import { createHash } from 'node:crypto';
import {
  bundleHashInput,
  canonicalJson,
  type BundleManifest,
  type Diagnostic,
} from '@docedit/export-latex';
import type { ExportOutputs, JobQueue, JobRecord } from '@docedit/document-service';

/** The member of a preview job's result that holds its preview key. */
export const PREVIEW_KEY_MEMBER = 'previewKey';

/**
 * How old an earlier compile may be and still be shown again: seven days, the default age of the
 * control plane's own first-result cache (`cacheMaxAgeMs`). A setting, not a measurement.
 */
export const PREVIEW_REUSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;

const sha256 = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

/**
 * The preview key of a bundle: SHA-256 over
 *
 * - the hash of every file of the bundle (`manifest.files`: all but the manifest, assets included);
 * - the options without the job's instant;
 * - the class version and the image digest (a TeX Live upgrade changes one of them, 09 §9.4);
 * - the fonts with their hashes (09 §2: fonts are not in the bundle, the manifest names them);
 * - `conversion`: the diagnostics the job has before its compile, in order. They are part of the
 *   key so that two jobs with equal keys have equal diagnostics by construction, and not only when
 *   the converter happens to report the same for two documents that print the same.
 *
 * `seq`, the chain head and the list of redactions are not part of it: they are in `manifest.json`
 * only, which the class never reads.
 */
export function previewBundleKey(
  manifest: BundleManifest,
  conversion: readonly Diagnostic[] = [],
): string {
  const options: Record<string, string> = {};
  for (const [name, value] of Object.entries(manifest.options))
    if (name !== 'instant') options[name] = value;
  return sha256(
    [
      'docedit-preview-key/1',
      bundleHashInput(manifest.files, sha256(canonicalJson(options))),
      `#class ${manifest.classVersion}`,
      `#image ${manifest.imageDigest ?? ''}`,
      `#fonts ${sha256(canonicalJson(manifest.fonts))}`,
      `#diagnostics ${sha256(
        canonicalJson(conversion.map((d) => [d.severity, d.code, d.blockId, d.message])),
      )}`,
    ].join('\n'),
  );
}

/** An earlier preview whose files can be shown again: the job that compiled them. */
export interface EarlierPreview {
  id: string;
  /** Who asked for it: its raw log goes on only to the same requester (EXP-123 criterion 4). */
  createdBy: string;
  result: Record<string, unknown>;
}

export type EarlierPreviewLookup = (
  job: JobRecord,
  previewKey: string,
) => Promise<EarlierPreview | null>;

/**
 * The lookup over the control plane's queue: the newest completed job of the same tenant, document
 * and kind whose result holds the key. A job that itself showed earlier files (a reused preview, or
 * a cached copy the control plane made, EXP-006) names the job that compiled them in `from`; that
 * job is the one returned, so the result and the owner of the raw log are always the compile's own.
 * Null when there is none, or when the compile is older than `maxAgeMs`.
 *
 * The age is judged with this process's clock against the queue's finish time; with a window of
 * days the difference between two clocks does not matter.
 */
export function earlierPreviewFrom(
  queue: Pick<JobQueue, 'findCompletedWith' | 'get'>,
  opts: { maxAgeMs?: number; now?: () => number } = {},
): EarlierPreviewLookup {
  const now = opts.now ?? Date.now;
  const maxAgeMs = opts.maxAgeMs ?? PREVIEW_REUSE_MAX_AGE_MS;
  return async (job, previewKey) => {
    if (!job.doc) return null;
    const since = now() - maxAgeMs;
    const found = await queue.findCompletedWith(
      job.tenant,
      job.doc,
      job.kind,
      PREVIEW_KEY_MEMBER,
      previewKey,
      since,
    );
    if (!found || found.id === job.id || !found.result) return null;
    const from = found.result['from'];
    if (typeof from !== 'string' || from === '' || from === found.id)
      return { id: found.id, createdBy: found.createdBy, result: found.result };
    // The job that compiled the files `found` shows: of the same tenant (the queue reads no other),
    // the same document and kind, with the same key, and not older than the limit.
    const compiled = await queue.get(job.tenant, from);
    if (
      !compiled ||
      compiled.id === job.id ||
      compiled.state !== 'completed' ||
      compiled.doc !== job.doc ||
      compiled.kind !== job.kind ||
      !compiled.result ||
      compiled.result[PREVIEW_KEY_MEMBER] !== previewKey ||
      (compiled.finishedAt ?? 0) < since
    )
      return null;
    return { id: compiled.id, createdBy: compiled.createdBy, result: compiled.result };
  };
}

/**
 * The result of a job that shows an earlier preview's files: the same output names, read from the
 * prefix of the job that compiled them (`from`), with this job's own chain head. Null when the
 * earlier result is not one of a compiled PDF with this key.
 */
export function reusedPreview(
  earlier: EarlierPreview,
  job: JobRecord,
  previewKey: string,
  own: { chainHead: string | null; imagesWithoutAlt: number },
): (ExportOutputs & Record<string, unknown>) | null {
  const r = earlier.result as Partial<ExportOutputs> & Record<string, unknown>;
  if (typeof r.output !== 'string' || r.output === '') return null;
  if (r[PREVIEW_KEY_MEMBER] !== previewKey) return null;
  if (earlier.id === job.id) return null;
  const from = typeof r.from === 'string' && r.from !== '' ? r.from : earlier.id;
  return {
    output: r.output,
    pages: typeof r.pages === 'number' ? r.pages : null,
    layout: typeof r.layout === 'string' ? r.layout : null,
    converged: typeof r.converged === 'boolean' ? r.converged : null,
    // The raw log goes to the requester of the compile only, as for a cached result (EXP-123).
    log: earlier.createdBy === job.createdBy && typeof r.log === 'string' ? r.log : null,
    diagnostics: Array.isArray(r.diagnostics) ? r.diagnostics : [],
    chainHead: own.chainHead,
    imagesWithoutAlt: own.imagesWithoutAlt,
    ...(typeof r['manifest'] === 'string' ? { manifest: r['manifest'] } : {}),
    from,
    [PREVIEW_KEY_MEMBER]: previewKey,
  };
}
