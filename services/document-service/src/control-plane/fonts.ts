/**
 * The font manifest (05 §6.2 `/fonts`; 02 §6; 09 §5; PRO-067, BE-047; decision D143; ADR 0054).
 *
 * The editor and the typesetter must load identical files (02 §6), so the service serves the font
 * set the compile worker uses: a directory with the converter's `fonts.json` (the `FontManifest`
 * of `@docedit/export-latex`: families with four faces, the math face, the fallback faces, each
 * file named by its SHA-256) and the files themselves. At start the set is read once:
 *
 * - a family enters the manifest only if its licence is on the list of licences that allow
 *   bundling and server use (by default the font and software licences of `licences/policy.json`),
 *   and the manifest records the licence (BE-047 criterion 1);
 * - every file is hashed before it is published, and a face whose content does not match its hash
 *   leaves its family out (criterion 2);
 * - the manifest `version` is a SHA-256 over the families, faces, hashes and licences, so any
 *   change of the set changes it, and the ETag with it (criterion 3; PRO-067 criterion 3).
 *
 * The files are served at `{endpoint}/fonts/{sha256}.{ext}` with a fixed content type, cached as
 * immutable, and readable from any origin: they carry no document data, only licensed fonts.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { canonicalize } from '@docedit/model';
import type { Logger } from '../log.ts';
import type { PlainHandler, Reply } from './pipeline.ts';

/**
 * Licences that permit bundling a font with the software and using it on a server: the
 * `fontsOnly` and `allow` lists of `licences/policy.json` (FND-011). A setting.
 */
export const FONT_LICENCES: readonly string[] = [
  'OFL-1.1',
  'Apache-2.0',
  'MIT',
  'BSD-2-Clause',
  'BSD-3-Clause',
  'ISC',
  '0BSD',
  'Zlib',
  'BlueOak-1.0.0',
];

/** A face as the converter's manifest names it: `<sha256>.ttf` or `<sha256>.otf`. */
interface SourceFace {
  file: string;
  sha256: string;
  /** The code points the face covers, when the converter's manifest records them (EXP-026). */
  coverage?: unknown;
}

/**
 * The coverage of a face as the converter's manifest gives it: sorted inclusive ranges of code
 * points. Anything else is left out, never repaired.
 */
function coverageOf(value: unknown): Array<[number, number]> | null {
  if (!Array.isArray(value)) return null;
  const out: Array<[number, number]> = [];
  for (const r of value) {
    if (!Array.isArray(r) || r.length !== 2) return null;
    const [lo, hi] = r as [unknown, unknown];
    if (!Number.isSafeInteger(lo) || !Number.isSafeInteger(hi)) return null;
    if ((lo as number) < 0 || (hi as number) > 0x10ffff || (lo as number) > (hi as number))
      return null;
    out.push([lo as number, hi as number]);
  }
  return out;
}

interface SourceManifest {
  version: number;
  families: Array<{
    name: string;
    lineHeight?: number;
    regular: SourceFace;
    bold: SourceFace;
    italic: SourceFace;
    boldItalic: SourceFace;
    licence: string;
  }>;
  math?: SourceFace & { name: string; licence: string };
  defaultFamily?: string;
  /** Ordered lines `{ family, replacement }` (FE-062; owner decision 125). */
  substitutes?: unknown;
  fallback?: Array<SourceFace & { name: string; licence: string }>;
}

export type FaceStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';

export interface ManifestFace {
  style: FaceStyle;
  weight: 400 | 700;
  italic: boolean;
  url: string;
  sha256: string;
  bytes: number;
  format: 'truetype' | 'opentype' | 'woff2';
  /** The licence declaration of a tenant's own face (BE-048); absent on the shared catalogue's faces. */
  licence?: string;
  /** Whether the declaration allows the font on a server, so in a PDF (decision 62); tenant faces only. */
  serverUse?: boolean;
  /**
   * The code points the face covers, as sorted inclusive ranges, when the font set's manifest
   * records them. The editor's export preflight reads them, so that it checks characters against
   * the same coverage as the converter does (EXP-003; 09 §1). Absent: the set records none.
   */
  coverage?: Array<[number, number]>;
}

export interface ManifestFamily {
  family: string;
  /** `text` for document families, `math` for the math face, `fallback` for the fallback chain. */
  role: 'text' | 'math' | 'fallback';
  licence: string;
  lineHeight: number | null;
  faces: ManifestFace[];
  /** True for a family the tenant added (BE-048); the shared catalogue's families omit it. */
  tenant?: true;
  /** For a tenant family: every face may be used on a server (decision 62). */
  serverUse?: boolean;
}

/** The body of `GET /fonts` (D143). */
export interface FontManifestBody {
  version: string;
  defaultFamily: string | null;
  families: ManifestFamily[];
  /**
   * Ordered lines that name a text family of this manifest to use for a family it lacks, as the
   * converter reads them from `fonts.json` (Calibri to Carlito; FE-062, owner decision 125). The first
   * line that names a family decides. Absent when the font set has no line.
   */
  substitutes?: SubstituteLine[];
}

export interface SubstituteLine {
  family: string;
  replacement: string;
}

interface FontFile {
  bytes: Buffer;
  contentType: string;
}

export interface FontCatalogue {
  manifest: FontManifestBody;
  /** The files by name (`<sha256>.<ext>`). */
  files: ReadonlyMap<string, FontFile>;
  /** Families left out, with the reason, for the operator's log. */
  excluded: Array<{ family: string; reason: string }>;
}

const FACE_STYLES: Array<[FaceStyle, 400 | 700, boolean]> = [
  ['regular', 400, false],
  ['bold', 700, false],
  ['italic', 400, true],
  ['boldItalic', 700, true],
];

const FILE = /^([0-9a-f]{64})\.(ttf|otf)$/;

const sha256 = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** The empty set: a deployment without fonts serves a manifest with no families. */
export function emptyCatalogue(): FontCatalogue {
  const families: ManifestFamily[] = [];
  return {
    manifest: { version: versionOf(null, families), defaultFamily: null, families },
    files: new Map(),
    excluded: [],
  };
}

export function versionOf(
  defaultFamily: string | null,
  families: readonly ManifestFamily[],
  substitutes: readonly SubstituteLine[] = [],
): string {
  // URLs are left out: the version names the set of fonts, wherever it is served from.
  const set = families.map((f) => ({
    family: f.family,
    role: f.role,
    licence: f.licence,
    lineHeight: f.lineHeight,
    faces: f.faces.map((x) => ({
      style: x.style,
      sha256: x.sha256,
      ...(x.licence !== undefined ? { licence: x.licence } : {}),
      ...(x.serverUse !== undefined ? { serverUse: x.serverUse } : {}),
    })),
  }));
  return createHash('sha256')
    .update(
      canonicalize(
        substitutes.length > 0
          ? { v: 1, defaultFamily, set, substitutes }
          : { v: 1, defaultFamily, set },
      ),
      'utf8',
    )
    .digest('hex');
}

/**
 * The substitute lines of `fonts.json` that the manifest can serve: both names are text, and the
 * replacement is a text family that was published. Other lines are left out, in order kept.
 */
function substituteLines(source: unknown, families: readonly ManifestFamily[]): SubstituteLine[] {
  if (!Array.isArray(source)) return [];
  const published = new Set(families.filter((f) => f.role === 'text').map((f) => f.family));
  const out: SubstituteLine[] = [];
  for (const line of source) {
    if (typeof line !== 'object' || line === null) continue;
    const { family, replacement } = line as Record<string, unknown>;
    if (
      typeof family === 'string' &&
      family.trim() !== '' &&
      typeof replacement === 'string' &&
      published.has(replacement)
    )
      out.push({ family, replacement });
  }
  return out;
}

/**
 * Reads a font directory (its `fonts.json` and the files it names) and builds the catalogue.
 * `baseUrl` is where the files are served, for example `https://docs.example.com/fonts`.
 */
export async function loadFontCatalogue(
  dir: string,
  baseUrl: string,
  opts: { licences?: readonly string[]; logger?: Logger } = {},
): Promise<FontCatalogue> {
  const allowed = new Set(opts.licences ?? FONT_LICENCES);
  const source = JSON.parse(await readFile(join(dir, 'fonts.json'), 'utf8')) as SourceManifest;
  if (source.version !== 1 || !Array.isArray(source.families))
    throw new Error('fonts.json is not a font manifest of version 1');
  const files = new Map<string, FontFile>();
  const excluded: FontCatalogue['excluded'] = [];
  const base = baseUrl.replace(/\/$/, '');

  /** The published face of a source face, or the reason it cannot be published. */
  async function face(f: SourceFace, style: FaceStyle, weight: 400 | 700, italic: boolean) {
    const m = FILE.exec(f.file);
    if (!m || m[1] !== f.sha256) return 'a file is not named by its SHA-256';
    let bytes: Buffer;
    try {
      bytes = await readFile(join(dir, f.file));
    } catch {
      return 'a file is missing';
    }
    // The content is checked against its hash before it is published (BE-047 criterion 2).
    if (sha256(bytes) !== f.sha256) return 'a file does not match its SHA-256';
    const opentype = m[2] === 'otf';
    files.set(f.file, { bytes, contentType: opentype ? 'font/otf' : 'font/ttf' });
    const out: ManifestFace = {
      style,
      weight,
      italic,
      url: `${base}/${f.file}`,
      sha256: f.sha256,
      bytes: bytes.length,
      format: opentype ? 'opentype' : 'truetype',
    };
    const coverage = coverageOf(f.coverage);
    if (coverage) out.coverage = coverage;
    return out;
  }

  async function family(
    name: string,
    role: ManifestFamily['role'],
    licence: string,
    lineHeight: number | null,
    faces: Array<[SourceFace, FaceStyle, 400 | 700, boolean]>,
  ): Promise<ManifestFamily | null> {
    // A font enters the manifest only if its licence permits bundling and server use.
    if (!allowed.has(licence)) {
      excluded.push({ family: name, reason: `the licence ${licence} is not on the list` });
      return null;
    }
    const out: ManifestFace[] = [];
    for (const [f, style, weight, italic] of faces) {
      const r = await face(f, style, weight, italic);
      if (typeof r === 'string') {
        excluded.push({ family: name, reason: r });
        return null;
      }
      out.push(r);
    }
    return { family: name, role, licence, lineHeight, faces: out };
  }

  const families: ManifestFamily[] = [];
  for (const f of source.families) {
    const fam = await family(
      f.name,
      'text',
      f.licence,
      typeof f.lineHeight === 'number' ? f.lineHeight : null,
      FACE_STYLES.map(([style, weight, italic]) => [f[style], style, weight, italic]),
    );
    if (fam) families.push(fam);
  }
  if (source.math) {
    const fam = await family(source.math.name, 'math', source.math.licence, null, [
      [source.math, 'regular', 400, false],
    ]);
    if (fam) families.push(fam);
  }
  for (const fb of source.fallback ?? []) {
    const fam = await family(fb.name, 'fallback', fb.licence, null, [[fb, 'regular', 400, false]]);
    if (fam) families.push(fam);
  }
  for (const x of excluded)
    opts.logger?.warn({
      event: 'fonts.excluded',
      message: `a font family was left out: ${x.reason}`,
    });
  const defaultFamily =
    source.defaultFamily && families.some((f) => f.family === source.defaultFamily)
      ? source.defaultFamily
      : null;
  const substitutes = substituteLines(source.substitutes, families);
  return {
    manifest: {
      version: versionOf(defaultFamily, families, substitutes),
      defaultFamily,
      families,
      ...(substitutes.length > 0 ? { substitutes } : {}),
    },
    files,
    excluded,
  };
}

/** The version of a set of families, as `loadFontCatalogue` computes it (BE-047 criterion 3). */
export const fontsVersion = versionOf;

/** The ETag of a manifest: its version (BE-047 criterion 3). */
export const fontsEtag = (m: FontManifestBody) => `"f${m.version.slice(0, 32)}"`;

/** `GET {endpoint}/fonts/{sha256}.{ext}`: the files, by hash, for anyone (they are public). */
export function fontFileHandler(catalogue: () => FontCatalogue): PlainHandler {
  return async (req, url): Promise<Reply> => {
    const name = url.pathname.slice('/fonts/'.length);
    const file = FILE.test(name) ? catalogue().files.get(name) : undefined;
    if (!file || (req.method !== 'GET' && req.method !== 'HEAD'))
      return { status: 404, body: { code: 'not_found' }, headers: { 'Cache-Control': 'no-store' } };
    return {
      status: 200,
      bytes: req.method === 'HEAD' ? Buffer.alloc(0) : file.bytes,
      headers: {
        'Content-Type': file.contentType,
        'Cache-Control': 'public, max-age=31536000, immutable',
        'Access-Control-Allow-Origin': '*',
        'X-Content-Type-Options': 'nosniff',
        ETag: `"${name.slice(0, 64)}"`,
      },
    };
  };
}
