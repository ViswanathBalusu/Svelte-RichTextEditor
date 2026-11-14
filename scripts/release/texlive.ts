/**
 * The export worker image's TeX Live packages and fonts as bill-of-materials entries (SEC-051
 * criterion 3; 09 §9.3). The input is read from the image itself, without network:
 *
 *   podman run --rm --network=none --entrypoint tlmgr <image> \
 *     info --only-installed --data name,category,localrev,cat-version,cat-license
 *   podman run --rm --network=none --entrypoint cat <image> /opt/docedit/fonts/fonts.json
 *
 * Licences are the TeX Catalogue's keys. Keys with an exact SPDX identifier are mapped to it; the
 * others become `LicenseRef-TeXCatalogue-<key>` with a pointer to the catalogue's description,
 * because guessing a version or an "or later" clause would misstate the licence. A package with
 * several keys gets all of them joined with AND: the catalogue does not say whether they are
 * alternatives, so the bill assumes every obligation.
 */
import type { SpdxLicenceRef, SpdxPackage, SpdxRelationship } from './spdx.ts';
import { NOASSERTION, spdxId } from './spdx.ts';

export interface TexPackage {
  name: string;
  category: string;
  revision: string;
  catalogueVersion: string;
  licences: string[];
}

function splitCsv(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quoted) {
      if (c === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (c === '"') quoted = false;
      else cur += c;
    } else if (c === '"') quoted = true;
    else if (c === ',') {
      out.push(cur);
      cur = '';
    } else cur += c;
  }
  out.push(cur);
  return out;
}

/** Parses `tlmgr info --data name,category,localrev,cat-version,cat-license` output. */
export function parseTlmgrInfo(text: string): TexPackage[] {
  const out: TexPackage[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const [name, category, revision, catalogueVersion, licence] = splitCsv(line);
    if (!name || category === undefined) throw new Error(`tlmgr output: unreadable line "${line}"`);
    out.push({
      name,
      category,
      revision: revision ?? '',
      catalogueVersion: catalogueVersion ?? '',
      licences: (licence ?? '').split(/\s+/).filter(Boolean),
    });
  }
  // Platform binaries (name.arch) carry no catalogue entry; they inherit their package's licences.
  const byName = new Map(out.map((p) => [p.name, p]));
  for (const p of out) {
    const dot = p.name.lastIndexOf('.');
    if (!p.licences.length && dot > 0) {
      const parent = byName.get(p.name.slice(0, dot));
      if (parent?.licences.length) p.licences = [...parent.licences];
    }
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** TeX Catalogue licence keys whose SPDX identifier is exact. */
export const TEX_CATALOGUE_SPDX: Readonly<Record<string, string>> = {
  '0bsd': '0BSD',
  agpl3: 'AGPL-3.0-only',
  apache2: 'Apache-2.0',
  artistic2: 'Artistic-2.0',
  bsd2: 'BSD-2-Clause',
  bsd3: 'BSD-3-Clause',
  bsd4: 'BSD-4-Clause',
  'cc-by-1': 'CC-BY-1.0',
  'cc-by-2': 'CC-BY-2.0',
  'cc-by-3': 'CC-BY-3.0',
  'cc-by-4': 'CC-BY-4.0',
  'cc-by-sa-2': 'CC-BY-SA-2.0',
  'cc-by-sa-3': 'CC-BY-SA-3.0',
  'cc-by-sa-4': 'CC-BY-SA-4.0',
  cc0: 'CC0-1.0',
  gpl1: 'GPL-1.0-only',
  gpl2: 'GPL-2.0-only',
  'gpl2+': 'GPL-2.0-or-later',
  gpl3: 'GPL-3.0-only',
  'gpl3+': 'GPL-3.0-or-later',
  isc: 'ISC',
  'lgpl2.1': 'LGPL-2.1-only',
  lgpl3: 'LGPL-3.0-only',
  lppl1: 'LPPL-1.0',
  'lppl1.1': 'LPPL-1.1',
  'lppl1.2': 'LPPL-1.2',
  'lppl1.3a': 'LPPL-1.3a',
  'lppl1.3c': 'LPPL-1.3c',
  mit: 'MIT',
  x11: 'X11',
};

/** `LicenseRef-TeXCatalogue-<key>`, with characters SPDX does not allow spelt out. */
export function texLicenceRef(key: string): string {
  const id = key
    .replace(/\+/g, '-plus-')
    .replace(/[^A-Za-z0-9.-]/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
  return `LicenseRef-TeXCatalogue-${id}`;
}

/**
 * The SPDX expression of a package's catalogue keys, and the references it uses. `collection` is
 * the key of TeX Live's collections, which hold other packages and no files of their own: it adds
 * no licence.
 */
export function texLicenceExpression(keys: readonly string[]): {
  expression: string;
  refs: Map<string, string>;
} {
  const refs = new Map<string, string>();
  const ids = [...new Set(keys)]
    .filter((k) => k !== 'collection')
    .map((k) => {
      const spdx = TEX_CATALOGUE_SPDX[k];
      if (spdx) return spdx;
      const ref = texLicenceRef(k);
      refs.set(ref, k);
      return ref;
    });
  if (!ids.length) return { expression: NOASSERTION, refs };
  return { expression: ids.length === 1 ? ids[0]! : ids.join(' AND '), refs };
}

export function texLicenceRefs(refs: ReadonlyMap<string, string>): SpdxLicenceRef[] {
  return [...refs].map(([licenseId, key]) => ({
    licenseId,
    name: `TeX Catalogue licence "${key}"`,
    extractedText: `The TeX Catalogue records the licence of this package as "${key}". The catalogue's description of that key is at https://ctan.org/license/${encodeURIComponent(key)}; the licence texts are in the package's files in the image.`,
    seeAlsos: [`https://ctan.org/license/${encodeURIComponent(key)}`],
  }));
}

export interface FontFace {
  file: string;
  sha256: string;
}

export interface FontManifest {
  version: number;
  families: Array<{
    name: string;
    licence: string;
    regular: FontFace;
    bold: FontFace;
    italic: FontFace;
    boldItalic: FontFace;
  }>;
  math?: { name: string; file: string; sha256: string; licence: string };
}

/** Every distinct font file of the manifest, with the faces it serves. */
export function fontFiles(
  manifest: FontManifest,
): Array<{ file: string; sha256: string; licence: string; faces: string[] }> {
  const byHash = new Map<
    string,
    { file: string; sha256: string; licence: string; faces: string[] }
  >();
  const add = (face: FontFace, licence: string, label: string) => {
    const entry = byHash.get(face.sha256) ?? {
      file: face.file,
      sha256: face.sha256,
      licence,
      faces: [],
    };
    entry.faces.push(label);
    byHash.set(face.sha256, entry);
  };
  for (const f of manifest.families)
    for (const [k, label] of [
      ['regular', 'regular'],
      ['bold', 'bold'],
      ['italic', 'italic'],
      ['boldItalic', 'bold italic'],
    ] as const)
      add(f[k], f.licence, `${f.name} ${label}`);
  if (manifest.math) add(manifest.math, manifest.math.licence, `${manifest.math.name} (math)`);
  return [...byHash.values()].sort((a, b) => (a.sha256 < b.sha256 ? -1 : 1));
}

/** Bill-of-materials entries for the TeX packages and fonts of an image, contained by `container`. */
export function texliveEntries(
  tex: readonly TexPackage[],
  fonts: FontManifest | null,
  container: string,
  fontDir = '/opt/docedit/fonts',
): { packages: SpdxPackage[]; relationships: SpdxRelationship[]; licenceRefs: SpdxLicenceRef[] } {
  const packages: SpdxPackage[] = [];
  const relationships: SpdxRelationship[] = [];
  const refs = new Map<string, string>();
  for (const p of tex) {
    const { expression, refs: used } = texLicenceExpression(p.licences);
    for (const [k, v] of used) refs.set(k, v);
    const id = spdxId('texlive', p.name, p.revision);
    packages.push({
      SPDXID: id,
      name: p.name,
      versionInfo: p.catalogueVersion || `r${p.revision}`,
      downloadLocation: NOASSERTION,
      filesAnalyzed: false,
      licenseConcluded: NOASSERTION,
      licenseDeclared: expression,
      copyrightText: NOASSERTION,
      ...(p.category === 'Package'
        ? { homepage: `https://ctan.org/pkg/${encodeURIComponent(p.name)}` }
        : {}),
      primaryPackagePurpose: p.category === 'TLCore' ? 'APPLICATION' : 'LIBRARY',
      comment: `TeX Live ${p.category.toLowerCase()} ${p.name}, revision ${p.revision || 'unknown'}${p.catalogueVersion ? `, catalogue version ${p.catalogueVersion}` : ''}; licence keys from the TeX Catalogue: ${p.licences.join(' ') || 'none'}.`,
    });
    relationships.push({
      spdxElementId: container,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: id,
    });
  }
  for (const f of fonts ? fontFiles(fonts) : []) {
    const id = spdxId('font', f.sha256);
    packages.push({
      SPDXID: id,
      name: f.faces[0]!,
      downloadLocation: NOASSERTION,
      filesAnalyzed: false,
      checksums: [{ algorithm: 'SHA256', checksumValue: f.sha256 }],
      licenseConcluded: f.licence,
      licenseDeclared: f.licence,
      copyrightText: NOASSERTION,
      primaryPackagePurpose: 'FILE',
      comment: `Font file ${fontDir}/${f.file}, serving ${f.faces.join(', ')}; the licence is the font manifest's (fonts.json, written by image/fonts.lua).`,
    });
    relationships.push({
      spdxElementId: container,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: id,
    });
  }
  return { packages, relationships, licenceRefs: texLicenceRefs(refs) };
}
