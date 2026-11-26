/**
 * The export bundles of a tenant (UX-088) and of a legal request (UX-087): the file formats, the
 * archive of a part, and the offline verifier (08 §12; 13 §10; docs/adr/0373-w3-UX-087-export-bundle-format.md
 * and docs/adr/0433-w3-UX-087-bundle-container-and-routes.md; the formats are in docs/export-bundle-formats.md).
 *
 * A bundle is one or more parts. A part is a tar archive (POSIX ustar, no compression) of files and
 * one `manifest.json`. `parts.json` beside the parts lists each part with its SHA-256 and size, so
 * a missing or changed part is found before it is read. The manifest lists every file with its
 * SHA-256 and size, and holds the counts and the chain heads, so that a reader can compare them with
 * the stored data and with the history files.
 *
 * Universal: no Node.js or browser API. The verifier takes bytes; the caller reads the files.
 * Nothing in a report holds document text.
 */
import { sha256, toHex, utf8 } from '@docedit/model';
import { type LogBundle, type VerifyReport, verifyBundle } from './chain.ts';

export const BUNDLE_FORMAT_ID = 'docedit-bundle/1';
export const PARTS_FORMAT = 'docedit-bundle-parts/1';

export type BundleKind = 'discovery' | 'tenant';

/** One file of a part, as the manifest lists it. */
export interface ManifestFile {
  path: string;
  sha256: string;
  size: number;
  /** For a newline-delimited file: how many lines (records) it holds. */
  records?: number;
}

/** What the bundle holds, to compare with the stored data (UX-088 criterion 3). */
export interface BundleCounts {
  documents: number;
  commits: number;
  threads: number;
  comments: number;
  versions: number;
  grants: number;
}

export interface Manifest {
  format: typeof BUNDLE_FORMAT_ID;
  kind: BundleKind;
  tenant: string;
  createdAt: string;
  /** The identity that asked: an identifier, not a name. */
  requestedBy: string;
  part: { index: number; count: number };
  files: ManifestFile[];
  /** Counts of this part. */
  counts: BundleCounts;
  /** Per document of this part: the head of the exported log. */
  chainHeads: Record<string, { seq: number; chainHead: string | null }>;
}

export interface PartsIndex {
  format: typeof PARTS_FORMAT;
  kind: BundleKind;
  tenant: string;
  count: number;
  parts: Array<{
    name: string;
    sha256: string;
    size: number;
    manifestSha256: string;
    documents: number;
  }>;
}

// --- Archive (ustar) ---------------------------------------------------------------------------

const BLOCK = 512;

function octal(value: number, width: number): string {
  return value.toString(8).padStart(width - 1, '0') + '\0';
}

function field(out: Uint8Array, offset: number, text: string): void {
  out.set(utf8(text), offset);
}

/** Packs files into a ustar archive. A path is at most 100 bytes; one that is longer is refused. */
export function packFiles(files: ReadonlyArray<{ path: string; bytes: Uint8Array }>): Uint8Array {
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (const f of files) {
    if (utf8(f.path).length > 100)
      throw new RangeError(`the path ${f.path} is longer than 100 bytes`);
    const header = new Uint8Array(BLOCK);
    field(header, 0, f.path);
    field(header, 100, octal(0o644, 8));
    field(header, 108, octal(0, 8));
    field(header, 116, octal(0, 8));
    field(header, 124, octal(f.bytes.length, 12));
    field(header, 136, octal(0, 12));
    field(header, 148, '        ');
    header[156] = 0x30;
    field(header, 257, 'ustar\0');
    field(header, 263, '00');
    let sum = 0;
    for (const b of header) sum += b;
    field(header, 148, sum.toString(8).padStart(6, '0') + '\0 ');
    const padded = Math.ceil(f.bytes.length / BLOCK) * BLOCK;
    const body = new Uint8Array(padded);
    body.set(f.bytes);
    chunks.push(header, body);
    total += BLOCK + padded;
  }
  chunks.push(new Uint8Array(BLOCK * 2));
  total += BLOCK * 2;
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function cString(bytes: Uint8Array, from: number, length: number): Uint8Array {
  let end = from;
  while (end < from + length && bytes[end] !== 0) end++;
  return bytes.subarray(from, end);
}

/** Decodes UTF-8; a byte sequence that is not valid becomes U+FFFD. */
export function decodeUtf8(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length;) {
    const b = bytes[i]!;
    let cp = 0xfffd;
    let n = 1;
    if (b < 0x80) cp = b;
    else if (b >= 0xc2 && b < 0xe0 && i + 1 < bytes.length) {
      cp = ((b & 0x1f) << 6) | (bytes[i + 1]! & 0x3f);
      n = 2;
    } else if (b >= 0xe0 && b < 0xf0 && i + 2 < bytes.length) {
      cp = ((b & 0x0f) << 12) | ((bytes[i + 1]! & 0x3f) << 6) | (bytes[i + 2]! & 0x3f);
      n = 3;
    } else if (b >= 0xf0 && b < 0xf5 && i + 3 < bytes.length) {
      cp =
        ((b & 0x07) << 18) |
        ((bytes[i + 1]! & 0x3f) << 12) |
        ((bytes[i + 2]! & 0x3f) << 6) |
        (bytes[i + 3]! & 0x3f);
      n = 4;
    }
    out += String.fromCodePoint(cp > 0x10ffff ? 0xfffd : cp);
    i += n;
  }
  return out;
}

/** Reads a ustar archive. Returns null when it is not one (a bad checksum, or a cut archive). */
export function unpackFiles(
  archive: Uint8Array,
): Array<{ path: string; bytes: Uint8Array }> | null {
  const files: Array<{ path: string; bytes: Uint8Array }> = [];
  let at = 0;
  while (at + BLOCK <= archive.length) {
    const header = archive.subarray(at, at + BLOCK);
    if (header.every((b) => b === 0)) return files;
    const copy = header.slice();
    copy.fill(0x20, 148, 156);
    let sum = 0;
    for (const b of copy) sum += b;
    if (parseInt(decodeUtf8(cString(header, 148, 8)).trim(), 8) !== sum) return null;
    const size = parseInt(decodeUtf8(cString(header, 124, 12)).trim() || '0', 8);
    if (!Number.isFinite(size) || at + BLOCK + size > archive.length) return null;
    files.push({
      path: decodeUtf8(cString(header, 0, 100)),
      bytes: archive.slice(at + BLOCK, at + BLOCK + size),
    });
    at += BLOCK + Math.ceil(size / BLOCK) * BLOCK;
  }
  return null;
}

// --- Hashing -----------------------------------------------------------------------------------

export async function sha256Of(bytes: Uint8Array): Promise<string> {
  return toHex(await sha256(bytes));
}

/** Builds a manifest entry for a file. */
export async function manifestFile(
  path: string,
  bytes: Uint8Array,
  records?: number,
): Promise<ManifestFile> {
  return {
    path,
    sha256: await sha256Of(bytes),
    size: bytes.length,
    ...(records !== undefined ? { records } : {}),
  };
}

// --- File formats ------------------------------------------------------------------------------

/**
 * The files a part may hold, by path pattern. Each has a format name with a version; the document
 * docs/export-bundle-formats.md describes every one, and a test checks that it names them all.
 */
export interface FileFormat {
  id: string;
  /** The path as a pattern: `<doc>` stands for a document identifier. */
  path: string;
  matches: RegExp;
  kind: BundleKind | 'both';
  /** One JSON value, newline-delimited JSON, or bytes (an asset, named by its SHA-256). */
  encoding: 'json' | 'ndjson' | 'binary';
  /** The members the file must have (each line of a newline-delimited file); the document names them. */
  members: readonly string[];
}

const DOC = '[0-9a-f-]{36}';
const re = (s: string): RegExp => new RegExp(`^${s}$`);

export const FILE_FORMATS: readonly FileFormat[] = [
  {
    id: 'docedit-document-record/1',
    path: 'documents/<doc>/document.json',
    matches: re(`documents/${DOC}/document\\.json`),
    kind: 'both',
    encoding: 'json',
    members: [
      'id',
      'title',
      'state',
      'classification',
      'cdm',
      'requires',
      'historyVisibility',
      'properties',
      'createdBy',
      'createdAt',
      'head',
    ],
  },
  {
    id: 'docedit-document-content/1',
    path: 'documents/<doc>/content.json',
    matches: re(`documents/${DOC}/content\\.json`),
    kind: 'both',
    encoding: 'json',
    members: ['cdm', 'requires', 'doc'],
  },
  {
    id: 'docedit-log-bundle/1',
    path: 'documents/<doc>/history.json',
    matches: re(`documents/${DOC}/history\\.json`),
    kind: 'both',
    encoding: 'json',
    members: ['format', 'doc', 'head', 'commits'],
  },
  {
    id: 'docedit-comments/1',
    path: 'documents/<doc>/comments.ndjson',
    matches: re(`documents/${DOC}/comments\\.ndjson`),
    kind: 'both',
    encoding: 'ndjson',
    members: ['id', 'scope', 'state', 'target', 'createdBy', 'createdAt', 'comments'],
  },
  {
    id: 'docedit-versions/1',
    path: 'documents/<doc>/versions.ndjson',
    matches: re(`documents/${DOC}/versions\\.ndjson`),
    kind: 'both',
    encoding: 'ndjson',
    members: ['seq', 'kind', 'createdBy', 'createdAt'],
  },
  {
    id: 'docedit-inclusion/1',
    path: 'documents/<doc>/inclusion.json',
    matches: re(`documents/${DOC}/inclusion\\.json`),
    kind: 'both',
    encoding: 'json',
    members: [
      'format',
      'document',
      'content',
      'history',
      'retention',
      'holds',
      'thinned',
      'evidence',
    ],
  },
  {
    id: 'docedit-grants/1',
    path: 'documents/<doc>/grants.json',
    matches: re(`documents/${DOC}/grants\\.json`),
    kind: 'tenant',
    encoding: 'json',
    members: ['revisions'],
  },
  {
    id: 'docedit-evidence/1',
    path: 'documents/<doc>/evidence.json',
    matches: re(`documents/${DOC}/evidence\\.json`),
    kind: 'discovery',
    encoding: 'json',
    members: ['format'],
  },
  {
    id: 'docedit-assets/1',
    path: 'documents/<doc>/assets.ndjson',
    matches: re(`documents/${DOC}/assets\\.ndjson`),
    kind: 'tenant',
    encoding: 'ndjson',
    members: ['id', 'mime', 'sha256', 'bytes'],
  },
  {
    id: 'docedit-asset/1',
    path: 'assets/<sha256>',
    matches: re('assets/[0-9a-f]{64}'),
    kind: 'tenant',
    encoding: 'binary',
    members: [],
  },
  {
    id: 'docedit-tenant-settings/1',
    path: 'tenant/settings.json',
    matches: re('tenant/settings\\.json'),
    kind: 'tenant',
    encoding: 'json',
    members: ['format', 'settings', 'quotas', 'retention'],
  },
  {
    id: 'docedit-tenant-keys/1',
    path: 'tenant/keys.json',
    matches: re('tenant/keys\\.json'),
    kind: 'tenant',
    encoding: 'json',
    members: ['keys'],
  },
  {
    id: 'docedit-tenant-origins/1',
    path: 'tenant/origins.json',
    matches: re('tenant/origins\\.json'),
    kind: 'tenant',
    encoding: 'json',
    members: ['origins'],
  },
  {
    id: 'docedit-tenant-webhooks/1',
    path: 'tenant/webhooks.json',
    matches: re('tenant/webhooks\\.json'),
    kind: 'tenant',
    encoding: 'json',
    members: ['webhooks'],
  },
];

/**
 * Member names that must never appear in a bundle file: private key material, secrets, tokens and
 * signed URLs (UX-088 criterion 4). The writer builds each file from an allow-list of fields; this
 * list is the second check, on what was written.
 */
export const SECRET_MEMBERS: ReadonlySet<string> = new Set([
  'secret',
  'secrets',
  'secretHash',
  'privateKey',
  'private',
  'd',
  'p',
  'q',
  'dp',
  'dq',
  'qi',
  'password',
  'token',
  'apiKey',
  'signedUrl',
  'signedUrls',
]);

const SECRET_VALUE = /\b(whsec_|sk_live_|-----BEGIN [A-Z ]*PRIVATE KEY-----)/;

/**
 * Document content, comments and history hold what people wrote and the attributes of the model,
 * whose member names are theirs: those files are checked for secret values only, the others for
 * secret member names as well.
 */
const CONTENT_FILES = /\/(content\.json|history\.json|comments\.ndjson)$/;

function findSecret(value: unknown, path: string, found: string[], members: boolean): void {
  if (typeof value === 'string') {
    if (SECRET_VALUE.test(value)) found.push(path);
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => findSecret(v, `${path}/${i}`, found, members));
  } else if (typeof value === 'object' && value !== null) {
    for (const [k, v] of Object.entries(value)) {
      if (members && SECRET_MEMBERS.has(k)) found.push(`${path}/${k}`);
      else findSecret(v, `${path}/${k}`, found, members);
    }
  }
}

// --- The verifier ------------------------------------------------------------------------------

export type BundleCheck =
  | 'parts'
  | 'archive'
  | 'manifest'
  | 'file'
  | 'format'
  | 'counts'
  | 'history'
  | 'chain-head'
  | 'secret'
  | 'tenant';

export interface BundleProblem {
  check: BundleCheck;
  /** The part name or the file path the problem is about. */
  at: string;
  /** Fixed wording: never document text. */
  reason: string;
  /** Whether it shows an alteration (a hash differs) rather than something missing or malformed. */
  altered: boolean;
}

export interface BundleReport {
  status: 'intact' | 'altered' | 'incomplete';
  kind: BundleKind | null;
  tenant: string | null;
  parts: number;
  files: number;
  counts: BundleCounts;
  /** Per document, the report of its history file. */
  histories: Record<string, Pick<VerifyReport, 'status' | 'commits' | 'head'>>;
  problems: BundleProblem[];
}

const zeroCounts = (): BundleCounts => ({
  documents: 0,
  commits: 0,
  threads: 0,
  comments: 0,
  versions: 0,
  grants: 0,
});

function parseJson(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(decodeUtf8(bytes));
  } catch {
    return undefined;
  }
}

function parseLines(bytes: Uint8Array): unknown[] | undefined {
  const text = decodeUtf8(bytes);
  if (text === '') return [];
  const out: unknown[] = [];
  for (const line of text.split('\n')) {
    if (line === '') continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      return undefined;
    }
  }
  return out;
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/**
 * Checks a bundle against the documented formats: the parts against `parts.json`, each file against
 * the manifest's hash and size, each file against the format of its path, the counts against the
 * files, every history file with the chain verifier and its head against the manifest, and the
 * absence of secrets. `parts` are the archives by name, as stored beside `parts.json`.
 */
export async function verifyExportBundle(input: {
  parts: ReadonlyMap<string, Uint8Array>;
  index: Uint8Array;
}): Promise<BundleReport> {
  const problems: BundleProblem[] = [];
  const add = (p: BundleProblem): void => void problems.push(p);
  const counts = zeroCounts();
  const histories: BundleReport['histories'] = {};
  let kind: BundleKind | null = null;
  let tenant: string | null = null;
  let fileCount = 0;

  const index = parseJson(input.index) as PartsIndex | undefined;
  if (!isRecord(index) || index.format !== PARTS_FORMAT || !Array.isArray(index.parts)) {
    add({
      check: 'parts',
      at: 'parts.json',
      reason: `not an index of format ${PARTS_FORMAT}`,
      altered: false,
    });
    return { status: 'incomplete', kind, tenant, parts: 0, files: 0, counts, histories, problems };
  }
  kind = index.kind;
  tenant = index.tenant;
  if (index.count !== index.parts.length)
    add({
      check: 'parts',
      at: 'parts.json',
      reason: 'the count differs from the list of parts',
      altered: false,
    });

  const seenDocuments = new Set<string>();
  let partNo = 0;
  for (const entry of index.parts) {
    partNo++;
    const archive = input.parts.get(entry.name);
    if (!archive) {
      add({ check: 'parts', at: entry.name, reason: 'the part is missing', altered: false });
      continue;
    }
    if (archive.length !== entry.size || (await sha256Of(archive)) !== entry.sha256)
      add({
        check: 'parts',
        at: entry.name,
        reason: 'the part differs from its entry in parts.json',
        altered: true,
      });
    const files = unpackFiles(archive);
    if (!files) {
      add({
        check: 'archive',
        at: entry.name,
        reason: 'the part is not a readable archive',
        altered: true,
      });
      continue;
    }
    const byPath = new Map(files.map((f) => [f.path, f.bytes]));
    const manifestBytes = byPath.get('manifest.json');
    const manifest = manifestBytes ? (parseJson(manifestBytes) as Manifest | undefined) : undefined;
    if (!manifestBytes || !isRecord(manifest) || manifest.format !== BUNDLE_FORMAT_ID) {
      add({
        check: 'manifest',
        at: entry.name,
        reason: `no manifest of format ${BUNDLE_FORMAT_ID}`,
        altered: false,
      });
      continue;
    }
    if ((await sha256Of(manifestBytes)) !== entry.manifestSha256)
      add({
        check: 'manifest',
        at: entry.name,
        reason: 'the manifest differs from its hash in parts.json',
        altered: true,
      });
    if (manifest.tenant !== tenant || manifest.kind !== kind)
      add({
        check: 'tenant',
        at: entry.name,
        reason: 'the manifest names another tenant or kind than the index',
        altered: false,
      });
    if (manifest.part?.index !== partNo || manifest.part?.count !== index.count)
      add({
        check: 'manifest',
        at: entry.name,
        reason: 'the part number or count is not the one of the index',
        altered: false,
      });

    // The files against the manifest, both ways.
    const listed = new Set<string>();
    for (const f of manifest.files ?? []) {
      listed.add(f.path);
      const bytes = byPath.get(f.path);
      if (!bytes) {
        add({
          check: 'file',
          at: f.path,
          reason: 'the file is listed and not in the part',
          altered: false,
        });
        continue;
      }
      if (bytes.length !== f.size || (await sha256Of(bytes)) !== f.sha256)
        add({
          check: 'file',
          at: f.path,
          reason: 'the file differs from its entry in the manifest',
          altered: true,
        });
    }
    for (const f of files)
      if (f.path !== 'manifest.json' && !listed.has(f.path))
        add({
          check: 'file',
          at: f.path,
          reason: 'the file is in the part and not in the manifest',
          altered: false,
        });

    // Each file against its format, and the counts from what the files hold.
    const mine = zeroCounts();
    const docsOfPart = new Set<string>();
    const heads: Record<string, { seq: number; chainHead: string | null }> = {};
    for (const f of files) {
      if (f.path === 'manifest.json') continue;
      fileCount++;
      const format = FILE_FORMATS.find((x) => x.matches.test(f.path));
      if (!format || (format.kind !== 'both' && format.kind !== kind)) {
        add({
          check: 'format',
          at: f.path,
          reason: 'no documented format for this path in this kind of bundle',
          altered: false,
        });
        continue;
      }
      const docId = /^documents\/([^/]+)\//.exec(f.path)?.[1];
      if (docId) docsOfPart.add(docId);
      if (format.encoding === 'binary') {
        if (f.path !== `assets/${await sha256Of(f.bytes)}`)
          add({
            check: 'file',
            at: f.path,
            reason: 'the asset is not the content its name gives',
            altered: true,
          });
        continue;
      }
      const value = format.encoding === 'json' ? parseJson(f.bytes) : parseLines(f.bytes);
      if (value === undefined) {
        add({
          check: 'format',
          at: f.path,
          reason: `not ${format.encoding === 'json' ? 'JSON' : 'newline-delimited JSON'}`,
          altered: false,
        });
        continue;
      }
      const rows = format.encoding === 'ndjson' ? (value as unknown[]) : [value];
      for (const member of format.members)
        if (!rows.every((r) => isRecord(r) && member in r))
          add({
            check: 'format',
            at: f.path,
            reason: `a record has no member \`${member}\``,
            altered: false,
          });
      const secrets: string[] = [];
      findSecret(value, '', secrets, !CONTENT_FILES.test(f.path));
      for (const s of secrets)
        add({
          check: 'secret',
          at: `${f.path}${s}`,
          reason: 'a secret member or value is in the file',
          altered: false,
        });
      switch (format.id) {
        case 'docedit-log-bundle/1': {
          const log = value as LogBundle;
          const report = await verifyBundle(log);
          histories[docId!] = { status: report.status, commits: report.commits, head: report.head };
          if (report.status !== 'intact')
            add({
              check: 'history',
              at: f.path,
              reason: `the log verifies as ${report.status}`,
              altered: report.status === 'altered',
            });
          if (log.doc !== docId)
            add({
              check: 'history',
              at: f.path,
              reason: 'the log is of another document than its path',
              altered: false,
            });
          mine.commits += Array.isArray(log.commits) ? log.commits.length : 0;
          heads[docId!] = { seq: log.head?.seq ?? 0, chainHead: log.head?.chainHead ?? null };
          break;
        }
        case 'docedit-document-record/1':
          if (!isRecord(value) || value['id'] !== docId)
            add({
              check: 'format',
              at: f.path,
              reason: 'the record does not carry the identifier of its path',
              altered: false,
            });
          mine.documents++;
          break;
        case 'docedit-document-content/1':
          if (!isRecord(value) || !('doc' in value) || !('cdm' in value))
            add({
              check: 'format',
              at: f.path,
              reason: 'the content has no `cdm` and `doc`',
              altered: false,
            });
          break;
        case 'docedit-comments/1': {
          const threads = value as unknown[];
          mine.threads += threads.length;
          for (const t of threads)
            if (isRecord(t) && Array.isArray(t['comments'])) mine.comments += t['comments'].length;
          break;
        }
        case 'docedit-versions/1':
          mine.versions += (value as unknown[]).length;
          break;
        case 'docedit-grants/1':
          if (!isRecord(value) || !Array.isArray(value['revisions']))
            add({
              check: 'format',
              at: f.path,
              reason: 'the grants file has no `revisions` list',
              altered: false,
            });
          else mine.grants += (value['revisions'] as unknown[]).length;
          break;
        default:
          break;
      }
    }
    for (const doc of docsOfPart) {
      if (seenDocuments.has(doc))
        add({
          check: 'manifest',
          at: entry.name,
          reason: 'a document is in two parts',
          altered: false,
        });
      seenDocuments.add(doc);
    }
    if (docsOfPart.size !== entry.documents)
      add({
        check: 'counts',
        at: entry.name,
        reason: 'the documents of the part differ from parts.json',
        altered: false,
      });
    for (const key of Object.keys(mine) as Array<keyof BundleCounts>) {
      if (manifest.counts?.[key] !== mine[key])
        add({
          check: 'counts',
          at: entry.name,
          reason: `the manifest counts ${key} differently from the files`,
          altered: false,
        });
      counts[key] += mine[key];
    }
    const claimed = manifest.chainHeads ?? {};
    for (const doc of docsOfPart) {
      const a = claimed[doc];
      const b = heads[doc];
      if (!a || !b || a.seq !== b.seq || a.chainHead !== b.chainHead)
        add({
          check: 'chain-head',
          at: doc,
          reason: 'the head in the manifest is not the head of the history file',
          altered: true,
        });
    }
  }
  const status = problems.some((p) => p.altered)
    ? 'altered'
    : problems.length > 0
      ? 'incomplete'
      : 'intact';
  return {
    status,
    kind,
    tenant,
    parts: index.parts.length,
    files: fileCount,
    counts,
    histories,
    problems,
  };
}
