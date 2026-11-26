/**
 * Fonts a tenant adds (BE-048; 02 §6; 09 §5; 06 §12; 11 §9 risk 11; owner decisions 62, 94, 95).
 *
 * An administrator (the service credential) adds a font file with a licence declaration and the
 * server-use flag of decision 62. The service
 *
 * - checks the file in the asset worker's sandbox (`check`, backed by `checkFontFile`), so a file
 *   that fails is refused with the rule it broke and nothing is stored, published or audited as
 *   added (criteria 1 and 4);
 * - stores the bytes under the tenant's own prefix, named by their SHA-256
 *   (`tenants/{tenant}/fonts/{sha256}`), and records the face in the tenant's table;
 * - adds the face to the manifest of `GET /fonts` for that tenant only (decision 95: the list is
 *   tenant-wide for every user of the tenant); another tenant's manifest does not name it
 *   (criterion 2), and `jobFonts(tenant)` gives an export job the same scoped set (criterion 3,
 *   the service's half: the worker that mounts the files is EXP-048's).
 *
 * The files are not public: `GET /tenant-fonts/{sha256}` needs a credential of the tenant, because a
 * licensed font must not be served to anyone who learns its hash. The browser fetches it with the
 * token and loads it from memory.
 *
 * A face is identified by its family and style. Adding a second file for a family and style the
 * tenant already has, or a family that the shared catalogue already serves, is a `conflict`.
 */
import { createHash } from 'node:crypto';
import { uuid7 } from '@docedit/model';
import type { AuditStore } from '../storage/types.ts';
import { objectKeys, ObjectExistsError, type ObjectStore } from '../objects/store.ts';
import {
  fontsVersion,
  type FaceStyle,
  type FontCatalogue,
  type FontManifestBody,
  type ManifestFace,
  type ManifestFamily,
} from './fonts.ts';
import { ApiError } from './problems.ts';

/** What the font check learns about a file (the asset worker's `FontInfo`, the part used here). */
export interface CheckedFont {
  family: string;
  weight: number;
  bold: boolean;
  italic: boolean;
  format: 'truetype' | 'opentype' | 'woff2';
}

export type FontChecker = (
  bytes: Uint8Array,
  mime: string,
) => Promise<
  | { ok: true; font: CheckedFont }
  | { ok: false; code: 'too_large' | 'validation_failed'; message: string }
>;

export interface TenantFontRow {
  tenant: string;
  sha256: string;
  family: string;
  style: FaceStyle;
  weight: 400 | 700;
  italic: boolean;
  format: CheckedFont['format'];
  bytes: number;
  licence: string;
  serverUse: boolean;
  addedBy: string;
  addedAt: number;
}

/** Storage of the faces. `add` returns false when the tenant has the hash or the family and style. */
export interface TenantFontStore {
  add(row: TenantFontRow): Promise<'added' | 'same_file' | 'same_face'>;
  list(tenant: string): Promise<TenantFontRow[]>;
  remove(tenant: string, sha256: string): Promise<TenantFontRow | null>;
}

export class MemoryTenantFontStore implements TenantFontStore {
  #rows: TenantFontRow[] = [];

  async add(row: TenantFontRow): Promise<'added' | 'same_file' | 'same_face'> {
    const mine = this.#rows.filter((r) => r.tenant === row.tenant);
    if (mine.some((r) => r.sha256 === row.sha256)) return 'same_file';
    if (
      mine.some((r) => r.family.toLowerCase() === row.family.toLowerCase() && r.style === row.style)
    )
      return 'same_face';
    this.#rows.push(row);
    return 'added';
  }

  async list(tenant: string): Promise<TenantFontRow[]> {
    return this.#rows.filter((r) => r.tenant === tenant).map((r) => ({ ...r }));
  }

  async remove(tenant: string, sha256: string): Promise<TenantFontRow | null> {
    const i = this.#rows.findIndex((r) => r.tenant === tenant && r.sha256 === sha256);
    if (i < 0) return null;
    return this.#rows.splice(i, 1)[0]!;
  }
}

export interface TenantFontServiceDeps {
  store: TenantFontStore;
  objects: ObjectStore;
  audit: AuditStore;
  /** The sandboxed check; null when this server has no sandbox, so that nothing is added. */
  check: FontChecker | null;
  /** Where a face is fetched: `{base}/{sha256}`. */
  fileBase: string;
  now: () => number;
  /** The byte limit of a font; the check applies the same one. */
  maxBytes?: number;
}

export interface TenantFontFile {
  bytes: Uint8Array;
  contentType: string;
}

const MIME_OF: Record<CheckedFont['format'], string> = {
  truetype: 'font/ttf',
  opentype: 'font/otf',
  woff2: 'font/woff2',
};
const DECLARED = new Set(['font/ttf', 'font/otf', 'font/woff2']);
const SHA256 = /^[0-9a-f]{64}$/;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export const LICENCE_MAX = 200;
const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export interface TenantFontView {
  sha256: string;
  family: string;
  style: FaceStyle;
  format: CheckedFont['format'];
  bytes: number;
  licence: string;
  serverUse: boolean;
  url: string;
}

function invalid(path: string, rule: string): never {
  throw new ApiError('validation_failed', 'the font request does not match its schema', {
    violations: [{ path, rule }],
  });
}

export function styleOf(font: Pick<CheckedFont, 'bold' | 'italic'>): FaceStyle {
  return font.bold ? (font.italic ? 'boldItalic' : 'bold') : font.italic ? 'italic' : 'regular';
}

export class TenantFontService {
  readonly #d: TenantFontServiceDeps;

  constructor(deps: TenantFontServiceDeps) {
    this.#d = deps;
  }

  #key(tenant: string, sha256: string): string {
    return `${objectKeys.prefix(tenant)}fonts/${sha256}`;
  }

  #url(sha256: string): string {
    return `${this.#d.fileBase.replace(/\/$/, '')}/${sha256}`;
  }

  /** Adds one font file for the tenant; the answer describes the stored face. */
  async add(tenant: string, actor: string, value: unknown): Promise<TenantFontView> {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
      invalid('/', 'an object');
    const o = value as Record<string, unknown>;
    for (const k of Object.keys(o))
      if (!['filename', 'mime', 'content', 'licence', 'serverUse'].includes(k))
        invalid(`/${k}`, 'a known field');
    const mime = o['mime'];
    if (typeof mime !== 'string' || !DECLARED.has(mime))
      invalid('/mime', 'font/ttf, font/otf or font/woff2');
    const licence = typeof o['licence'] === 'string' ? o['licence'].trim() : '';
    if (licence.length < 1 || [...licence].length > LICENCE_MAX || /\p{Cc}/u.test(licence))
      invalid('/licence', `the licence declaration, 1 to ${LICENCE_MAX} characters`);
    if (typeof o['serverUse'] !== 'boolean') invalid('/serverUse', 'true or false');
    if (
      o['filename'] !== undefined &&
      (typeof o['filename'] !== 'string' || o['filename'].length > 255)
    )
      invalid('/filename', 'a name of at most 255 characters');
    const content = o['content'];
    const max = this.#d.maxBytes ?? DEFAULT_MAX_BYTES;
    if (
      typeof content !== 'string' ||
      content.length === 0 ||
      !BASE64.test(content) ||
      content.length % 4 !== 0
    )
      invalid('/content', 'the font file as base64');
    if (content.length > Math.ceil(max / 3) * 4)
      throw new ApiError('too_large', `a font is at most ${max} bytes`);
    const bytes = new Uint8Array(Buffer.from(content, 'base64'));

    if (!this.#d.check) throw new ApiError('unavailable', 'this server cannot check fonts');
    const checked = await this.#d.check(bytes, mime);
    // A font that fails is refused here: nothing has been stored, listed or audited.
    if (!checked.ok) throw new ApiError(checked.code, `the font was refused: ${checked.message}`);
    const font = checked.font;
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const row: TenantFontRow = {
      tenant,
      sha256,
      family: font.family,
      style: styleOf(font),
      weight: font.bold ? 700 : 400,
      italic: font.italic,
      format: font.format,
      bytes: bytes.length,
      licence,
      serverUse: o['serverUse'],
      addedBy: actor,
      addedAt: this.#d.now(),
    };
    const key = this.#key(tenant, sha256);
    // The bytes go first: a row never names a file that is missing. A file left by a failed add is
    // named by its hash and holds nothing but the font the administrator sent.
    await this.#d.objects
      .put(key, bytes, {
        contentType: MIME_OF[font.format],
        ifAbsent: true,
      })
      .catch((e: unknown) => {
        if (!(e instanceof ObjectExistsError)) throw e;
      });
    const outcome = await this.#d.store.add(row);
    if (outcome === 'same_file')
      throw new ApiError('conflict', 'the tenant already has this font file');
    if (outcome === 'same_face')
      throw new ApiError('conflict', `the tenant already has ${font.family} in this style`);
    await this.#d.audit.record([
      {
        id: uuid7(),
        tenant,
        doc: null,
        actor,
        kind: 'font.added',
        data: {
          sha256,
          family: font.family,
          style: row.style,
          licence,
          serverUse: row.serverUse,
          bytes: bytes.length,
        },
        at: row.addedAt,
      },
    ]);
    return this.#view(row);
  }

  #view(r: TenantFontRow): TenantFontView {
    return {
      sha256: r.sha256,
      family: r.family,
      style: r.style,
      format: r.format,
      bytes: r.bytes,
      licence: r.licence,
      serverUse: r.serverUse,
      url: this.#url(r.sha256),
    };
  }

  /** Removes a face and its file; an unknown hash, or another tenant's, is `not_found`. */
  async remove(tenant: string, actor: string, sha256: string): Promise<TenantFontView> {
    if (!SHA256.test(sha256)) throw new ApiError('not_found', 'no such font');
    const row = await this.#d.store.remove(tenant, sha256);
    if (!row) throw new ApiError('not_found', 'no such font');
    await this.#d.objects.delete(this.#key(tenant, sha256));
    await this.#d.audit.record([
      {
        id: uuid7(),
        tenant,
        doc: null,
        actor,
        kind: 'font.removed',
        data: { sha256, family: row.family, style: row.style },
        at: this.#d.now(),
      },
    ]);
    return this.#view(row);
  }

  /** The file of a face of this tenant, or null when the tenant has no such face. */
  async file(tenant: string, sha256: string): Promise<TenantFontFile | null> {
    if (!SHA256.test(sha256)) return null;
    const row = (await this.#d.store.list(tenant)).find((r) => r.sha256 === sha256);
    if (!row) return null;
    const bytes = await this.#d.objects.get(this.#key(tenant, sha256));
    if (!bytes) return null;
    return { bytes, contentType: MIME_OF[row.format] };
  }

  /**
   * The manifest of a tenant: the shared catalogue's families, then the tenant's own (decision 95).
   * Each tenant face carries its licence declaration and the server-use flag (decision 62). The
   * version changes with the tenant's set, so the ETag does too.
   */
  async manifest(tenant: string, shared: FontCatalogue): Promise<FontManifestBody> {
    const rows = await this.#d.store.list(tenant);
    if (rows.length === 0) return shared.manifest;
    const taken = new Set(shared.manifest.families.map((f) => f.family.toLowerCase()));
    const byFamily = new Map<string, TenantFontRow[]>();
    for (const r of rows) {
      // A family the shared catalogue serves is never shadowed (a row from before it was added).
      if (taken.has(r.family.toLowerCase())) continue;
      const list = byFamily.get(r.family) ?? [];
      list.push(r);
      byFamily.set(r.family, list);
    }
    const own: ManifestFamily[] = [...byFamily]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([family, faces]) => ({
        family,
        role: 'text' as const,
        licence: faces[0]!.licence,
        lineHeight: null,
        tenant: true,
        serverUse: faces.every((f) => f.serverUse),
        faces: faces
          .sort((a, b) => (a.style < b.style ? -1 : 1))
          .map((f): ManifestFace => ({
            style: f.style,
            weight: f.weight,
            italic: f.italic,
            url: this.#url(f.sha256),
            sha256: f.sha256,
            bytes: f.bytes,
            format: f.format,
            licence: f.licence,
            serverUse: f.serverUse,
          })),
      }));
    const families = [...shared.manifest.families, ...own];
    return {
      version: fontsVersion(shared.manifest.defaultFamily, families),
      defaultFamily: shared.manifest.defaultFamily,
      families,
    };
  }

  /**
   * What an export job of `tenant` may load (criterion 3): the manifest above and a reader that
   * answers only for this tenant's faces. A face is mounted only when its declaration allows
   * server use (decision 62: without it the font is on screen only and the PDF substitutes it).
   */
  async jobFonts(
    tenant: string,
    shared: FontCatalogue,
  ): Promise<{ manifest: FontManifestBody; read(sha256: string): Promise<Uint8Array | null> }> {
    const rows = (await this.#d.store.list(tenant)).filter((r) => r.serverUse);
    const allowed = new Set(rows.map((r) => r.sha256));
    const manifest = await this.manifest(tenant, shared);
    const usable: FontManifestBody = {
      ...manifest,
      families: manifest.families
        .map((f) => (f.tenant ? { ...f, faces: f.faces.filter((x) => allowed.has(x.sha256)) } : f))
        .filter((f) => f.faces.length > 0),
    };
    const shaOfShared = new Set(
      shared.manifest.families.flatMap((f) => f.faces.map((x) => x.sha256)),
    );
    return {
      manifest: usable,
      read: async (sha256) => {
        if (shaOfShared.has(sha256))
          return (
            shared.files.get(`${sha256}.ttf`)?.bytes ??
            shared.files.get(`${sha256}.otf`)?.bytes ??
            null
          );
        if (!allowed.has(sha256)) return null;
        return (await this.#d.objects.get(this.#key(tenant, sha256))) ?? null;
      },
    };
  }
}
