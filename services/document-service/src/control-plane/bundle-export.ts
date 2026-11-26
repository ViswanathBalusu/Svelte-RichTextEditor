/**
 * Discovery and tenant export bundles (UX-087, UX-088; 13 §10; 08 §12; docs/adr/0373-w3-UX-087-export-bundle-format.md
 * and docs/adr/0433-w3-UX-087-bundle-container-and-routes.md, both accepted by owner decision 175 or proposed
 * where they leave a point open; the file formats are in docs/export-bundle-formats.md).
 *
 * - `POST /bundle-exports` takes a kind (`discovery` or `tenant`), optionally the documents it
 *   covers and a part size. It needs a service credential. The request is audited
 *   (`export.discovery.requested` or `export.tenant.requested`), the job is queued and the answer is
 *   202. `GET /bundle-exports/{bid}` gives the state, the progress and, when it has finished, the
 *   parts with their hashes and signed URLs.
 * - The job reads the tenant's own stores only, one document at a time, and writes one tar archive
 *   for each group of documents (a part), then `parts.json`. Every file is built from an allow-list
 *   of fields, so a stored secret is not in the bundle until someone adds it to a list.
 * - `@docedit/history` (`verifyExportBundle`, `docedit-verify-bundle`) checks the result offline.
 */
import {
  type BundleCounts,
  type BundleKind,
  type LogBundle,
  type Manifest,
  type ManifestFile,
  type PartsIndex,
  BUNDLE_FORMAT_ID,
  PARTS_FORMAT,
  manifestFile,
  packFiles,
  sha256Of,
} from '@docedit/history';
import { formatTimestamp, utf8, uuid7 } from '@docedit/model';
import { objectKeys } from '../objects/store.ts';
import type { DocRef, DocumentRecord } from '../storage/types.ts';
import { buildWorkflowEvidenceBundle } from '../workflow/evidence-bundle.ts';
import type { HoldView } from './holds.ts';
import { JobFailure, type JobHandler } from './jobs/runner.ts';
import type { JobRecord } from './jobs/queue.ts';
import { json, type HandlerDeps, type Kit } from './kit.ts';
import { type Ctx, type Handler } from './pipeline.ts';
import { ApiError } from './problems.ts';

export const BUNDLE_EXPORT_KIND = 'export.bundle';

/**
 * How many documents one part holds when the request names no size. A setting of this build for
 * the size of one archive in memory, not a figure of the spec: it needs a measurement (ADR 0433).
 */
export const BUNDLE_DOCUMENTS_PER_PART = 25;
export const BUNDLE_MAX_DOCUMENTS_PER_PART = 500;
/** The most documents one request may name; a request for the whole tenant names none. */
export const BUNDLE_MAX_NAMED_DOCUMENTS = 1_000;

const PAGE = 200;

const zeroCounts = (): BundleCounts => ({
  documents: 0,
  commits: 0,
  threads: 0,
  comments: 0,
  versions: 0,
  grants: 0,
});

interface Payload {
  kind: BundleKind;
  documents: string[] | null;
  perPart: number;
  requestedBy: string;
  createdAt: string;
}

interface PartResult {
  name: string;
  sha256: string;
  size: number;
  documents: number;
}

interface Result {
  parts: PartResult[];
  index: { name: string; sha256: string; size: number };
  counts: BundleCounts;
  documents: number;
}

const lines = (rows: readonly unknown[]): Uint8Array =>
  utf8(rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length > 0 ? '\n' : ''));
const jsonFile = (value: unknown): Uint8Array => utf8(JSON.stringify(value, null, 2) + '\n');
const iso = (ms: number): string => formatTimestamp(ms);

/** The fields of the document record that leave the service. An allow-list: a new field stays in. */
function documentRecord(doc: DocumentRecord): Record<string, unknown> {
  return {
    id: doc.id,
    externalId: doc.externalId,
    title: doc.title,
    state: doc.state,
    classification: doc.label,
    cdm: doc.cdmVersion,
    requires: doc.requires,
    historyVisibility: doc.historyVisibility,
    properties: doc.properties,
    createdBy: doc.createdBy,
    createdAt: iso(doc.createdAt),
    head: doc.head,
    forkedFrom: doc.forkedFrom ?? null,
    forkedAtSeq: doc.forkedAtSeq ?? null,
  };
}

const JWK_MEMBERS = ['kty', 'crv', 'x', 'y', 'n', 'e', 'alg', 'use', 'kid'] as const;

function publicJwk(jwk: unknown): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const given = (jwk ?? {}) as Record<string, unknown>;
  for (const m of JWK_MEMBERS) if (given[m] !== undefined) out[m] = given[m];
  return out;
}

/** Every document of the tenant that is not deleted, in identifier order. */
async function allDocuments(d: HandlerDeps, tenant: string): Promise<DocumentRecord[]> {
  const out: DocumentRecord[] = [];
  let after: string | undefined;
  for (;;) {
    const page = await d.documents.list(tenant, { limit: PAGE, ...(after ? { after } : {}) });
    out.push(...page);
    if (page.length < PAGE) return out;
    after = page[page.length - 1]!.id;
  }
}

interface Built {
  files: Array<{ path: string; bytes: Uint8Array; records?: number }>;
  counts: BundleCounts;
  head: { seq: number; chainHead: string | null };
}

/** The files of one document, for the kind of bundle. */
async function documentFiles(
  d: HandlerDeps,
  kind: BundleKind,
  ref: DocRef,
  doc: DocumentRecord,
  assets: Map<string, Uint8Array>,
  heldBy: Map<string, HoldView[]>,
): Promise<Built> {
  const base = `documents/${doc.id}`;
  const files: Built['files'] = [];
  const counts = { ...zeroCounts(), documents: 1 };
  const head = await d.logs.head(ref);
  files.push({ path: `${base}/document.json`, bytes: jsonFile(documentRecord(doc)) });

  const full = await d.content.rebuild(ref, head.incarnation, head.seq);
  files.push({
    path: `${base}/content.json`,
    bytes: jsonFile({ cdm: full.cdm, requires: full.requires, doc: full.doc }),
  });

  // The log with its hash chain: the records and their hashes, and no payloads (ADR 0433, point 3).
  const log: LogBundle =
    head.seq >= 1 && d.logs.chainRange
      ? await d.logs.chainRange(ref, 1, head.seq)
      : {
          format: 'docedit-log-bundle/1',
          doc: doc.id,
          head: { seq: 0, chainHead: null },
          commits: [],
        };
  counts.commits = log.commits.length;
  files.push({ path: `${base}/history.json`, bytes: jsonFile(log) });

  // The comment threads with their targets, in creation order.
  const threads = [];
  if (d.threads) {
    let after: string | undefined;
    for (;;) {
      const page = await d.threads.list(ref, { limit: PAGE, ...(after ? { after } : {}) });
      threads.push(...page);
      if (page.length < PAGE) break;
      after = page[page.length - 1]!.id;
    }
  }
  counts.threads = threads.length;
  counts.comments = threads.reduce((n, t) => n + t.comments.length, 0);
  files.push({
    path: `${base}/comments.ndjson`,
    bytes: lines(threads),
    records: threads.length,
  });

  const versions = d.versions ? await d.versions.list(ref) : [];
  counts.versions = versions.length;
  files.push({ path: `${base}/versions.ndjson`, bytes: lines(versions), records: versions.length });

  // What was kept, what was thinned and what is held (UX-087 criterion 2).
  const retention = d.retention ? await d.retention.document(ref.tenant, doc.id) : null;
  const holds = heldBy.get(doc.id) ?? [];
  const thinned = d.audit
    ? (await d.audit.query(ref.tenant, { kind: 'history.thinned', doc: doc.id, limit: 1_000 })).map(
        (e) => ({ at: iso(e.at), data: e.data }),
      )
    : [];
  let evidence: 'included' | 'none' | 'not-finished' = 'none';
  if (kind === 'discovery' && d.evidence && d.workflows) {
    const wf = await d.workflows.read(ref.tenant, doc.id);
    if (wf !== null) {
      const built =
        wf.state === 'completed' || wf.state === 'finalised'
          ? await buildWorkflowEvidenceBundle({ logs: d.logs, evidence: d.evidence }, ref, wf)
          : null;
      if (built?.ok) {
        evidence = 'included';
        files.push({ path: `${base}/evidence.json`, bytes: jsonFile(built.bundle) });
      } else evidence = 'not-finished';
    }
  }
  files.push({
    path: `${base}/inclusion.json`,
    bytes: jsonFile({
      format: 'docedit-inclusion/1',
      document: doc.id,
      content: { seq: head.seq },
      history: {
        commits: log.commits.length,
        payloads: 'hash-only',
        note: 'Each record carries the hash of its payload and the chain hashes; the payloads are not part of this format version.',
      },
      retention: retention
        ? { source: retention.source, effective: retention.effective }
        : { source: 'not-available', effective: null },
      holds: holds.map((h) => ({
        id: h.id,
        reason: h.reason,
        placedBy: h.placedBy,
        placedAt: h.placedAt,
      })),
      thinned,
      evidence,
    }),
  });

  if (kind === 'tenant') {
    const revisions = await d.grants.history(ref);
    counts.grants = revisions.length;
    files.push({ path: `${base}/grants.json`, bytes: jsonFile({ revisions }) });
    const ready = d.assets ? await readyAssets(d, ref.tenant, doc.id) : [];
    files.push({
      path: `${base}/assets.ndjson`,
      bytes: lines(
        ready.map((a) => ({
          id: a.id,
          filename: a.filename,
          mime: a.mime,
          sha256: a.sha256,
          bytes: a.bytes,
        })),
      ),
      records: ready.length,
    });
    for (const a of ready) {
      if (a.sha256 === null || assets.has(a.sha256)) continue;
      const bytes = await d.assets.getFinal(ref.tenant, a.sha256);
      if (bytes) assets.set(a.sha256, bytes);
    }
  }
  return { files, counts, head: { seq: head.seq, chainHead: log.head.chainHead } };
}

async function readyAssets(d: HandlerDeps, tenant: string, doc: string) {
  return d.assetRegistry ? d.assetRegistry.readyFor(tenant, doc) : [];
}

/** The tenant's legal holds by document, read once for the whole job. */
async function holdsByDocument(d: HandlerDeps, tenant: string): Promise<Map<string, HoldView[]>> {
  const out = new Map<string, HoldView[]>();
  if (!d.holds) return out;
  let after: string | null = null;
  do {
    const page: { items: HoldView[]; last: string | null } = await d.holds.list(
      tenant,
      after,
      PAGE,
    );
    for (const h of page.items) out.set(h.document, [...(out.get(h.document) ?? []), h]);
    after = page.last;
  } while (after !== null);
  return out;
}

/** The files that belong to the tenant, not to a document (UX-088 criterion 1). */
async function tenantFiles(d: HandlerDeps, tenant: string): Promise<Built['files']> {
  const files: Built['files'] = [];
  const settings = d.tenantSettings ? await d.tenantSettings.get(tenant) : {};
  const quotas = d.quotaAdmin ? await d.quotaAdmin.get(tenant) : null;
  const retention = d.retention ? await d.retention.tenant(tenant) : null;
  files.push({
    path: 'tenant/settings.json',
    bytes: jsonFile({ format: 'docedit-tenant-settings/1', settings, quotas, retention }),
  });
  const keys = [];
  if (d.tenantRegistry)
    for (const use of ['user', 'service'] as const)
      for (const k of await d.tenantRegistry.keys(tenant, use))
        keys.push({
          kid: k.kid,
          use: k.use,
          alg: k.alg,
          thumbprint: k.thumbprint,
          issuer: k.issuer,
          jwk: publicJwk(k.jwk),
        });
  files.push({ path: 'tenant/keys.json', bytes: jsonFile({ keys }) });
  files.push({
    path: 'tenant/origins.json',
    bytes: jsonFile({ origins: d.tenantRegistry ? await d.tenantRegistry.origins(tenant) : [] }),
  });
  files.push({
    path: 'tenant/webhooks.json',
    bytes: jsonFile({ webhooks: d.webhooks ? await d.webhooks.viewsOf(tenant) : [] }),
  });
  return files;
}

const wire = (job: JobRecord, d: HandlerDeps) => {
  const p = job.payload as unknown as Payload;
  const result = job.result as Result | null;
  const expiresAt = d.now() + d.signedUrlMs;
  const url = (name: string): string =>
    d.exportUrl
      ? d.exportUrl(job.tenant, job.id, name, expiresAt)
      : d.assets.signedUrl(job.tenant, objectKeys.exportFile(job.tenant, job.id, name), expiresAt);
  return {
    id: job.id,
    kind: p.kind,
    state: job.state,
    progress: job.state === 'completed' ? 100 : (job.progress ?? 0),
    ...(result
      ? {
          result: {
            documents: result.documents,
            counts: result.counts,
            index: { ...result.index, url: url(result.index.name) },
            parts: result.parts.map((x) => ({ ...x, url: url(x.name) })),
            expiresAt: formatTimestamp(expiresAt),
          },
        }
      : {}),
    ...(job.error !== null ? { error: job.error } : {}),
    createdAt: formatTimestamp(job.createdAt),
    ...(job.finishedAt !== null ? { finishedAt: formatTimestamp(job.finishedAt) } : {}),
  };
};

export function bundleExportRoutes(k: Kit): Record<string, Handler> {
  const { d } = k;
  const serviceOnly = (ctx: Ctx): void => {
    // Evidence is personal data: the request needs the administrator, which is the service
    // credential here (13 §10; ADR 0373 section 5).
    if (ctx.caller.kind !== 'service')
      throw new ApiError('forbidden', 'bundle exports need a service credential (13 §10)');
  };

  const createBundleExport: Handler = async (ctx) => {
    serviceOnly(ctx);
    const body = (await ctx.body()) as {
      kind: BundleKind;
      documents?: string[];
      maxDocumentsPerPart?: number;
    };
    const perPart = body.maxDocumentsPerPart ?? BUNDLE_DOCUMENTS_PER_PART;
    if (perPart < 1 || perPart > BUNDLE_MAX_DOCUMENTS_PER_PART)
      throw new ApiError('validation_failed', 'the part size is out of range', {
        violations: [
          { path: '/maxDocumentsPerPart', rule: `1 to ${BUNDLE_MAX_DOCUMENTS_PER_PART}` },
        ],
      });
    if (body.kind === 'discovery' && body.documents !== undefined && body.documents.length === 0)
      throw new ApiError('validation_failed', 'a request names a document or none', {
        violations: [{ path: '/documents', rule: 'at least one identifier, or absent' }],
      });
    if (body.kind === 'tenant' && body.documents !== undefined)
      throw new ApiError('validation_failed', 'a tenant export covers the whole tenant', {
        violations: [{ path: '/documents', rule: 'absent for a tenant export' }],
      });
    if ((body.documents?.length ?? 0) > BUNDLE_MAX_NAMED_DOCUMENTS)
      throw new ApiError('validation_failed', 'too many documents are named', {
        violations: [{ path: '/documents', rule: `at most ${BUNDLE_MAX_NAMED_DOCUMENTS}` }],
      });
    const tenant = ctx.caller.tenant;
    // A named document must be one of the tenant's own: another tenant's is not found.
    const unique = body.documents ? [...new Set(body.documents)] : null;
    for (const id of unique ?? []) {
      const found = await d.documents.get({ tenant, doc: id });
      if (found === null || found.deletedAt !== null)
        throw new ApiError('not_found', `no document ${id}`);
    }
    const payload: Payload = {
      kind: body.kind,
      documents: unique,
      perPart,
      requestedBy: ctx.caller.actor,
      createdAt: iso(d.now()),
    };
    // The request is audited before the job exists: a refused or failed job leaves the request on record.
    await d.audit?.record([
      {
        id: uuid7(),
        tenant,
        doc: unique && unique.length === 1 ? unique[0]! : null,
        actor: ctx.caller.actor,
        kind: body.kind === 'discovery' ? 'export.discovery.requested' : 'export.tenant.requested',
        data: { documents: unique ? unique.length : 'all', perPart },
        at: d.now(),
      },
    ]);
    const job = await d.queue.enqueue(tenant, {
      kind: BUNDLE_EXPORT_KIND,
      createdBy: ctx.caller.actor,
      maxAttempts: 1,
      payload: payload as unknown as Record<string, unknown>,
    });
    d.onJobQueued?.();
    return json(202, wire(job, d), { Location: `${k.rest}/bundle-exports/${job.id}` });
  };

  const getBundleExport: Handler = async (ctx) => {
    serviceOnly(ctx);
    const job = await d.queue.get(ctx.caller.tenant, ctx.params['bid']!);
    if (job === null || job.kind !== BUNDLE_EXPORT_KIND)
      throw new ApiError('not_found', `no bundle export ${ctx.params['bid']!}`);
    return json(200, wire(job, d), { 'Cache-Control': 'private, no-store' });
  };

  return { createBundleExport, getBundleExport };
}

/**
 * The handler of the job. `getDeps` is read when a job runs, not when the handler is made: the
 * control plane's dependencies are built after the runners are.
 */
export function bundleExportHandler(getDeps: () => HandlerDeps | null): JobHandler {
  return async (job, ctx) => {
    const d = getDeps();
    if (d === null) throw new JobFailure('unavailable', 'the control plane is not ready', true);
    const p = job.payload as unknown as Payload;
    const tenant = job.tenant;
    const docs: DocumentRecord[] = [];
    if (p.documents) {
      for (const id of p.documents) {
        const found = await d.documents.get({ tenant, doc: id });
        if (found === null || found.deletedAt !== null)
          throw new JobFailure('not_found', `document ${id} is gone`);
        docs.push(found);
      }
    } else docs.push(...(await allDocuments(d, tenant)));

    const groups: DocumentRecord[][] = [];
    for (let i = 0; i < docs.length; i += p.perPart) groups.push(docs.slice(i, i + p.perPart));
    if (groups.length === 0) groups.push([]);

    const parts: PartResult[] = [];
    const manifestHashes: string[] = [];
    const total = zeroCounts();
    let done = 0;
    const heldBy = await holdsByDocument(d, tenant);
    for (let index = 0; index < groups.length; index++) {
      const entries: Array<{ path: string; bytes: Uint8Array; records?: number }> = [];
      const counts = zeroCounts();
      const chainHeads: Manifest['chainHeads'] = {};
      const assets = new Map<string, Uint8Array>();
      if (index === 0 && p.kind === 'tenant') entries.push(...(await tenantFiles(d, tenant)));
      for (const doc of groups[index]!) {
        const built = await documentFiles(d, p.kind, { tenant, doc: doc.id }, doc, assets, heldBy);
        entries.push(...built.files);
        chainHeads[doc.id] = built.head;
        for (const key of Object.keys(counts) as Array<keyof BundleCounts>)
          counts[key] += built.counts[key];
        done++;
        const beat = await ctx.report(
          'documents',
          Math.floor((done / Math.max(1, docs.length)) * 95),
        );
        if (beat !== 'ok') throw new JobFailure('conflict', 'the export was cancelled');
      }
      for (const [sha, bytes] of assets) entries.push({ path: `assets/${sha}`, bytes });
      const listed: ManifestFile[] = [];
      for (const e of entries) listed.push(await manifestFile(e.path, e.bytes, e.records));
      const manifest: Manifest = {
        format: BUNDLE_FORMAT_ID,
        kind: p.kind,
        tenant,
        createdAt: p.createdAt,
        requestedBy: p.requestedBy,
        part: { index: index + 1, count: groups.length },
        files: listed,
        counts,
        chainHeads,
      };
      const manifestBytes = jsonFile(manifest);
      const archive = packFiles([{ path: 'manifest.json', bytes: manifestBytes }, ...entries]);
      const name = `part-${String(index + 1).padStart(4, '0')}.tar`;
      await d.assets.putExport(tenant, job.id, name, archive, 'application/x-tar');
      parts.push({
        name,
        sha256: await sha256Of(archive),
        size: archive.length,
        documents: groups[index]!.length,
      });
      manifestHashes.push(await sha256Of(manifestBytes));
      for (const key of Object.keys(total) as Array<keyof BundleCounts>) total[key] += counts[key];
    }
    const indexFile: PartsIndex = {
      format: PARTS_FORMAT,
      kind: p.kind,
      tenant,
      count: parts.length,
      parts: parts.map((x, i) => ({ ...x, manifestSha256: manifestHashes[i]! })),
    };
    const indexBytes = jsonFile(indexFile);
    await d.assets.putExport(tenant, job.id, 'parts.json', indexBytes, 'application/json');
    await ctx.report('done', 100);
    const result: Result = {
      parts: parts.map(({ name, sha256, size, documents }) => ({ name, sha256, size, documents })),
      index: { name: 'parts.json', sha256: await sha256Of(indexBytes), size: indexBytes.length },
      counts: total,
      documents: docs.length,
    };
    return result as unknown as Record<string, unknown>;
  };
}
