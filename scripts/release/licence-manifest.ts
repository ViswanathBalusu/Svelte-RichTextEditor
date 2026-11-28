/**
 * The licence manifest and the source offer of the export worker image (SEC-053 criterion 3;
 * EXP-073 criteria 3 and 4; 09 §9.3 item 5; legal note section 3.2). Both are written for a
 * release, from what `scripts/release/image.ts` reads inside the built image:
 *
 *   - the TeX Live packages the image holds, with the licence keys of the TeX Catalogue
 *     (`tlmgr info --only-installed`, which reads the pruned package database of the curated
 *     image);
 *   - the fonts and their licences (fonts.json);
 *   - the packages of the base system (`dpkg-query`);
 *   - the house class's version and licence.
 *
 * Nothing is fetched: the manifest says what the image holds, and the offer says where the source
 * of the copyleft parts is. Nothing here decides what the legal text of the offer is; the owner
 * has not answered question 4 of the legal note (the form of the offer), so the wording is the
 * proposal of docs/adr/0483-w2-SEC-053-curated-tex-live-image.md.
 */
import type { ImageRecord } from './notes.ts';
import type { FontManifest, TexPackage } from './texlive.ts';

export interface BaseSystemPackage {
  name: string;
  version: string;
  /** The source package, which differs from the binary package's name for many Debian packages. */
  source: string;
}

/**
 * Parses `/var/lib/dpkg/status`, which the release reads with `cat` from the image: one stanza per
 * package, with `Package`, `Status`, `Version` and, when the source package has another name,
 * `Source` (which may carry its own version in brackets). Only installed packages are listed.
 */
export function parseDpkg(text: string): BaseSystemPackage[] {
  const out: BaseSystemPackage[] = [];
  for (const stanza of text.split(/\r?\n\s*\r?\n/)) {
    const field = (name: string): string | undefined =>
      new RegExp(`^${name}: (.*)$`, 'm').exec(stanza)?.[1]?.trim();
    const name = field('Package');
    if (!name) continue;
    if (!/ installed$/.test(field('Status') ?? '')) continue;
    const version = field('Version');
    if (!version) throw new Error(`dpkg status: package ${name} has no version`);
    const source = field('Source')?.replace(/\s*\(.*\)$/, '') || name;
    out.push({ name, version, source });
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}

/** The file of the image that `parseDpkg` reads. */
export const DPKG_STATUS = '/var/lib/dpkg/status';

/** Catalogue keys of the GNU licences: `gpl`, `gpl2`, `gpl3+`, `lgpl2.1`, `agpl3` and so on. */
export const COPYLEFT_KEY = /^(a|l)?gpl/i;

/**
 * TeX Live packages whose Catalogue entry states no licence take the licence of the package whose
 * files they belong to, and the manifest says so (`licenceFrom`): the files of `<name>.x86_64-linux`
 * are the binaries of `<name>`; the `hyphen-*` packages are the pattern files of `hyph-utf8`; and
 * three packages of TeX Live's own core are parts of the sources of another (the HarfBuzz build of
 * LuaTeX is built from the LuaTeX source, the LaTeX format builder and the configuration are
 * LaTeX's). A package that is still without a licence is listed as such and nothing is guessed.
 */
export const LICENCE_PARENT: Readonly<Record<string, string>> = {
  luahbtex: 'luatex',
  'latex-bin': 'latex',
  latexconfig: 'latex',
};

export interface ResolvedPackage extends TexPackage {
  /** The package whose licence this one takes, when the Catalogue states none for it. */
  licenceFrom?: string;
}

export function resolveLicences(tex: readonly TexPackage[]): ResolvedPackage[] {
  const byNameMap = new Map(tex.map((p) => [p.name, p]));
  const parentOf = (name: string): string | undefined => {
    if (name.endsWith('.x86_64-linux')) return name.slice(0, -'.x86_64-linux'.length);
    if (name.startsWith('hyphen-')) return 'hyph-utf8';
    return LICENCE_PARENT[name];
  };
  // Follows the chain of parents (luahbtex.x86_64-linux, luahbtex, luatex) to the first package
  // whose Catalogue entry states a licence.
  const resolve = (p: TexPackage): ResolvedPackage => {
    let at: TexPackage = p;
    for (let hop = 0; hop < 4 && !at.licences.length; hop++) {
      const parent = parentOf(at.name);
      const next = parent ? byNameMap.get(parent) : undefined;
      if (!next) return p;
      at = next;
    }
    return at === p || !at.licences.length
      ? p
      : { ...p, licences: at.licences, licenceFrom: at.name };
  };
  return tex.map(resolve);
}

export function isCopyleft(p: TexPackage): boolean {
  return p.licences.some((k) => COPYLEFT_KEY.test(k));
}

export interface LicenceManifestInput {
  image: string;
  imageId: string;
  version: string;
  /** The base image of the Containerfile, pinned by digest. */
  base: string | null;
  tex: readonly TexPackage[];
  fonts: FontManifest | null;
  houseClass: { version: string; licence: string };
  baseSystem: readonly BaseSystemPackage[];
}

export interface LicenceManifest {
  manifestVersion: 1;
  release: string;
  image: { name: string; imageId: string; base: string | null };
  source: string;
  houseClass: { name: 'docedit'; version: string; licence: string };
  tex: {
    packageCount: number;
    byLicence: Record<string, number>;
    /** Packages whose catalogue entry states no licence; a release lists them, it does not guess. */
    unknownLicence: string[];
    packages: {
      name: string;
      category: string;
      revision: string;
      version: string;
      licences: string[];
      /** Set when the Catalogue states no licence for the package and it takes its parent's. */
      licenceFrom?: string;
    }[];
  };
  fonts: { name: string; licence: string }[];
  baseSystem: { packageCount: number; packages: BaseSystemPackage[]; licences: string };
  copyleft: { name: string; version: string; licences: string[] }[];
}

const byName = <T extends { name: string }>(a: T, b: T) =>
  a.name < b.name ? -1 : a.name > b.name ? 1 : 0;

export function licenceManifest(i: LicenceManifestInput): LicenceManifest {
  const packages = resolveLicences(i.tex).sort(byName);
  const byLicence: Record<string, number> = {};
  const unknown: string[] = [];
  for (const p of packages) {
    const keys = p.licences.length ? p.licences : ['unknown'];
    for (const k of keys) byLicence[k] = (byLicence[k] ?? 0) + 1;
    // `collection` is the key of TeX Live's collections: they hold no files of their own.
    if (!p.licences.length) unknown.push(p.name);
  }
  const fonts = i.fonts
    ? [
        ...i.fonts.families.map((f) => ({ name: f.name, licence: f.licence })),
        ...(i.fonts.math ? [{ name: i.fonts.math.name, licence: i.fonts.math.licence }] : []),
        ...(i.fonts.fallback ?? []).map((f) => ({ name: f.name, licence: f.licence })),
      ]
    : [];
  return {
    manifestVersion: 1,
    release: i.version,
    image: { name: i.image, imageId: i.imageId, base: i.base },
    source:
      'catalogue-license of the TeX Catalogue, as recorded in the package database of the image (tlmgr info --only-installed)',
    houseClass: { name: 'docedit', version: i.houseClass.version, licence: i.houseClass.licence },
    tex: {
      packageCount: packages.length,
      byLicence: Object.fromEntries(Object.entries(byLicence).sort(([a], [b]) => (a < b ? -1 : 1))),
      unknownLicence: unknown,
      packages: packages.map((p) => ({
        name: p.name,
        category: p.category,
        revision: p.revision,
        version: p.catalogueVersion,
        licences: p.licences,
        ...(p.licenceFrom ? { licenceFrom: p.licenceFrom } : {}),
      })),
    },
    fonts,
    baseSystem: {
      packageCount: i.baseSystem.length,
      packages: [...i.baseSystem],
      licences:
        'each package states its own licences in /usr/share/doc/<package>/copyright inside the image',
    },
    copyleft: packages.filter(isCopyleft).map((p) => ({
      name: p.name,
      version: p.catalogueVersion || `r${p.revision}`,
      licences: p.licences,
    })),
  };
}

/**
 * The source offer: for the copyleft parts of the image, where their source is and how to get the
 * exact version that the image holds. It lists every GPL-licensed TeX Live package the image
 * keeps (LuaTeX among them) and the source packages of the base system.
 */
export function sourceOffer(i: LicenceManifestInput): string {
  const copyleft = resolveLicences(i.tex).filter(isCopyleft).sort(byName);
  const sources = new Map<string, string>();
  for (const p of i.baseSystem) if (!sources.has(p.source)) sources.set(p.source, p.version);
  const lines: string[] = [
    `# Source offer for ${i.image} ${i.version}`,
    '',
    `The image \`${i.image}\` (identifier \`${i.imageId}\`) holds software under the GNU General Public Licence and the GNU Lesser General Public Licence. The licence of each part is in \`licence-manifest.json\` of this release. This file says where the source of those parts is. The source is available to anyone who has the image, for as long as the release is published and for at least three years after the last release that holds the part.`,
    '',
    '## TeX Live',
    '',
    `The image holds a curated installation of TeX Live 2026, taken from \`${i.base ?? 'the base image of the Containerfile'}\`. The source of the programs (LuaTeX and the others) is the TeX Live source tree, \`Build/source\` of the TeX Live repository (\`svn://tug.org/texlive/trunk\`), at the revision that the package database of the image records for the package (the \`revision\` field below). The source tarball of the same TeX Live release is published at \`https://tug.org/texlive/\`.`,
    '',
    'GNU-licensed TeX Live packages in the image:',
    '',
    '| Package | Version | Catalogue licence | Revision |',
    '|---|---|---|---|',
    ...(copyleft.length
      ? copyleft.map(
          (p) =>
            `| ${p.name} | ${p.catalogueVersion || `r${p.revision}`} | ${p.licences.join(' ')} | ${p.revision} |`,
        )
      : ['| none | | | |']),
    '',
    '## Base system',
    '',
    `The base system is Debian GNU/Linux (\`/etc/os-release\` in the image). The image holds ${i.baseSystem.length} Debian packages, listed with their source packages and versions in \`licence-manifest.json\`. The source of a package is the Debian source package of the same version: \`apt-get source <source package>=<version>\` on a Debian system that lists the Debian source archive, or the same files from \`https://snapshot.debian.org/\`. The image holds ${sources.size} source packages.`,
    '',
    '## The house class and the project',
    '',
    `The house class \`docedit\` ${i.houseClass.version} is under ${i.houseClass.licence} and its source is in the source archive of this release.`,
    '',
    'Proposed wording; the form of the offer is open (legal note 2026-11-06, question 4).',
    '',
  ];
  return lines.join('\n');
}

/**
 * The files of an image record that a release lists besides the bill of materials: the licence
 * manifest and the source offer. An image that holds TeX Live must record both; a problem is
 * returned when it does not, and the release fails its step.
 */
export function imageLicenceArtefacts(
  r: Pick<ImageRecord, 'id' | 'licenceManifest' | 'sourceOffer'>,
  holdsTexLive: boolean,
): { files: { file: string; kind: string }[]; problems: string[] } {
  const files: { file: string; kind: string }[] = [];
  if (r.licenceManifest)
    files.push({ file: r.licenceManifest, kind: `licence manifest (${r.id} image)` });
  if (r.sourceOffer) files.push({ file: r.sourceOffer, kind: `source offer (${r.id} image)` });
  const problems =
    holdsTexLive && (!r.licenceManifest || !r.sourceOffer)
      ? [`${r.id}: an image that holds TeX Live needs a licence manifest and a source offer`]
      : [];
  return { files, problems };
}
