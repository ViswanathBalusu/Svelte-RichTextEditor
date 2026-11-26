/**
 * The fonts a tenant added, for that tenant's jobs only (09 §5; EXP-048; BE-048; owner decisions 62,
 * 94 and 95).
 *
 * A job asks `tenantFonts` for its own tenant. The source answers for that tenant alone (the
 * document service's table and object store are scoped by tenant), so another tenant's job never
 * sees the face, even when its manifest names the same hash. The worker then:
 *
 * - leaves out a face whose declaration does not permit server use (decision 62: it is used on
 *   screen only and the PDF takes the fallback chain), a WOFF2 face (decision 94: not loaded on the
 *   server), a family that has no regular face, and a family whose name the image already has (a
 *   tenant face never shadows a shared family, ADR 0424);
 * - reads each face and checks its bytes against the hash the row names, so a stored object that
 *   changed is not loaded;
 * - adds the family to the font manifest of the job, and returns the files as `tenant-fonts/<hash>`
 *   for the compile, where the class reads them (`docedit.fontpath_of` in `class/docedit.lua`).
 *
 * Every face left out is reported as `tenant_font_unavailable`, a warning that names the family.
 */
import { createHash } from 'node:crypto';
import {
  fontCoverage,
  type Diagnostic,
  type FontFace,
  type FontFamily,
  type FontManifest,
} from '@docedit/export-latex';
import { objectKeys } from '@docedit/document-service';
import { diagnostic } from './diagnostics.ts';

export type TenantFaceStyle = 'regular' | 'bold' | 'italic' | 'boldItalic';

/** A face of a tenant, as the document service's table records it. */
export interface TenantFontFace {
  sha256: string;
  family: string;
  style: TenantFaceStyle;
  format: 'truetype' | 'opentype' | 'woff2';
  licence: string;
  serverUse: boolean;
}

/** Where a tenant's faces come from. Both calls answer for the one tenant they are given. */
export interface TenantFontSource {
  faces(tenant: string): Promise<TenantFontFace[]>;
  read(tenant: string, sha256: string): Promise<Uint8Array | null>;
}

export interface TenantFonts {
  /** The job's font manifest: the image's families, then the tenant's. */
  manifest: FontManifest;
  /** Files to add to the compile, by path (`tenant-fonts/<hash>.ttf`). */
  files: Record<string, Uint8Array>;
  diagnostics: Diagnostic[];
}

/** The directory of the job where the class looks for a tenant's font files. */
export const TENANT_FONT_DIR = 'tenant-fonts/';

const EXTENSION = { truetype: 'ttf', opentype: 'otf' } as const;

/** Word's single line height, (usWinAscent + usWinDescent) / unitsPerEm, in thousandths; null if unreadable. */
export function lineHeightOf(data: Uint8Array): number | null {
  if (data.length < 12) return null;
  const v = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const count = v.getUint16(4, false);
  let head = -1;
  let os2 = -1;
  for (let i = 0; i < count && 12 + 16 * i + 16 <= data.length; i++) {
    const rec = 12 + 16 * i;
    const tag = String.fromCharCode(data[rec]!, data[rec + 1]!, data[rec + 2]!, data[rec + 3]!);
    if (tag === 'head') head = v.getUint32(rec + 8, false);
    else if (tag === 'OS/2') os2 = v.getUint32(rec + 8, false);
  }
  if (head < 0 || os2 < 0 || head + 20 > data.length || os2 + 78 > data.length) return null;
  const upem = v.getUint16(head + 18, false);
  if (upem < 16 || upem > 16384) return null;
  const line = Math.round(
    ((v.getUint16(os2 + 74, false) + v.getUint16(os2 + 76, false)) * 1000) / upem,
  );
  return line > 0 && line < 4000 ? line : null;
}

const sha256Hex = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** The fonts of `tenant` that a job of that tenant may load, merged into `base`. */
export async function tenantFonts(
  source: TenantFontSource,
  tenant: string,
  base: FontManifest,
): Promise<TenantFonts> {
  const diagnostics: Diagnostic[] = [];
  const files: Record<string, Uint8Array> = {};
  const taken = new Set(base.families.map((f) => f.name.toLowerCase()));
  const byFamily = new Map<string, TenantFontFace[]>();
  for (const f of await source.faces(tenant)) {
    const list = byFamily.get(f.family) ?? [];
    list.push(f);
    byFamily.set(f.family, list);
  }
  const families: FontFamily[] = [];
  const skip = (family: string, why: string): void => {
    diagnostics.push(diagnostic('tenant_font_unavailable', null, `${family}: ${why}.`));
  };
  for (const [name, faces] of [...byFamily].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    if (taken.has(name.toLowerCase())) {
      skip(name, 'a shared family has this name');
      continue;
    }
    if (faces.some((f) => !f.serverUse)) {
      skip(name, 'its licence declaration does not permit use on a server');
      continue;
    }
    const loaded = new Map<TenantFaceStyle, FontFace>();
    const bytesOf = new Map<string, Uint8Array>();
    let line: number | null = null;
    let problem: string | null = null;
    for (const f of faces) {
      if (f.format === 'woff2') {
        problem = 'a WOFF2 face is not loaded on the server';
        continue;
      }
      const bytes = await source.read(tenant, f.sha256);
      if (bytes === null) {
        problem = `the file ${f.sha256.slice(0, 12)} is missing`;
        continue;
      }
      if (sha256Hex(bytes) !== f.sha256) {
        problem = `the file ${f.sha256.slice(0, 12)} does not match its hash`;
        continue;
      }
      const file = `${f.sha256}.${EXTENSION[f.format]}`;
      let coverage: FontFace['coverage'];
      try {
        coverage = fontCoverage(bytes) as FontFace['coverage'];
      } catch {
        coverage = undefined;
      }
      loaded.set(f.style, { file, sha256: f.sha256, ...(coverage ? { coverage } : {}) });
      bytesOf.set(file, bytes);
      if (f.style === 'regular') line = lineHeightOf(bytes);
    }
    const regular = loaded.get('regular');
    if (!regular) {
      skip(name, problem ?? 'it has no regular face');
      continue;
    }
    if (problem) skip(name, `${problem}; the other faces are used`);
    if (line === null) {
      skip(name, 'the line height of its regular face cannot be read');
      continue;
    }
    // A style the tenant did not add takes the nearest face it has, as a screen does.
    const bold = loaded.get('bold') ?? regular;
    const italic = loaded.get('italic') ?? regular;
    const boldItalic =
      loaded.get('boldItalic') ?? loaded.get('bold') ?? loaded.get('italic') ?? regular;
    for (const face of new Set([regular, bold, italic, boldItalic]))
      files[`${TENANT_FONT_DIR}${face.file}`] = bytesOf.get(face.file)!;
    families.push({
      name,
      lineHeight: line,
      regular,
      bold,
      italic,
      boldItalic,
      licence: faces[0]!.licence,
      serverUse: true,
    });
    taken.add(name.toLowerCase());
  }
  return { manifest: { ...base, families: [...base.families, ...families] }, files, diagnostics };
}

/**
 * The source the worker uses: the tenant's rows from the document service's table (`list` runs
 * under that tenant's row-level security) and the file under the tenant's own object prefix, the key
 * the service wrote it to (`tenants/{tenant}/fonts/{sha256}`). A hash another tenant holds is not
 * under this tenant's prefix, so it reads as missing.
 */
export function tenantFontSource(
  store: { list(tenant: string): Promise<ReadonlyArray<TenantFontFace>> },
  objects: { get(key: string): Promise<Uint8Array | null> },
): TenantFontSource {
  return {
    faces: async (tenant) =>
      (await store.list(tenant)).map((r) => ({
        sha256: r.sha256,
        family: r.family,
        style: r.style,
        format: r.format,
        licence: r.licence,
        serverUse: r.serverUse,
      })),
    read: async (tenant, sha256) =>
      (await objects.get(`${objectKeys.prefix(tenant)}fonts/${sha256}`)) ?? null,
  };
}
