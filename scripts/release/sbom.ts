/**
 * Bills of materials of the release artefacts (SEC-051; ADR 0044 §3), in SPDX 2.3 JSON:
 *
 * - a bundle (the element): the packages the build output really contains (source maps and
 *   identical files, scripts/supply-chain/bundle.ts), every file with its checksums, and the
 *   tarball's checksums; compared with the lock file and with the licence gate's walk;
 * - a service: its production dependencies from the licence gate's walk (scripts/release/walk.ts)
 *   and the workspace packages it runs, compared with the lock file;
 * - a container image: the operating-system and language packages Syft finds in it, the TeX Live
 *   packages and fonts of the export worker (texlive.ts), and the service's npm packages, compared
 *   with what Syft found in the image.
 *
 * A mismatch is a problem, and a problem fails the release.
 *
 * Usage (CI, after the image is built):
 *   node scripts/release/sbom.ts image --id <distributable> --image <repository> --version <version>
 *     --out <file> [--digest <sha256:…>] [--image-id <sha256:…>] [--syft <syft SPDX file>]
 *     [--tlmgr <file>] [--fonts <file>] [--declared <the service's npm SPDX file>]
 *     [--created <YYYY-MM-DDThh:mm:ssZ>] [--namespace <URI>]
 *   node scripts/release/sbom.ts validate <file>...
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Exception, Policy } from '../licence-policy.ts';
import type { BundleContents, BundleFile, PackageInfo } from '../supply-chain/bundle.ts';
import { integrityToHex, lockKey, type LockedPackage } from './lockfile.ts';
import {
  buildDocument,
  licenceExpression,
  NOASSERTION,
  npmPurl,
  npmTarballUrl,
  spdxId,
  stringify,
  validateDocument,
  verificationCode,
  type SpdxChecksum,
  type SpdxDocument,
  type SpdxFile,
  type SpdxLicenceRef,
  type SpdxPackage,
  type SpdxRelationship,
} from './spdx.ts';
import { parseTlmgrInfo, texliveEntries, type FontManifest, type TexPackage } from './texlive.ts';
import { conclude, type Dependency } from './walk.ts';

export interface SbomContext {
  /** The release version (the release train's). */
  version: string;
  /** Creation time, YYYY-MM-DDThh:mm:ssZ. */
  created: string;
  namespaceBase: string;
  /** The project's licence, for its own packages. */
  projectLicence: string;
  /** Where the project's sources are, for its own packages (NOASSERTION when unknown). */
  sourceLocation: string;
  lock: ReadonlyMap<string, LockedPackage>;
  policy: Policy;
  exceptions: readonly Exception[];
  today: string;
}

export interface SbomResult {
  doc: SpdxDocument;
  problems: string[];
  notes: string[];
}

export const CREATORS = [
  'Tool: docedit-release-sbom (scripts/release/sbom.ts)',
  'Organization: docedit project (working name)',
];

/** Seconds since the epoch as an SPDX creation time. */
export function createdAt(epochSeconds: number): string {
  return new Date(epochSeconds * 1000).toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function lockChecksums(locked: LockedPackage | undefined): SpdxChecksum[] {
  const hex = locked?.integrity ? integrityToHex(locked.integrity) : null;
  return hex ? [{ algorithm: hex.algorithm, checksumValue: hex.hex }] : [];
}

/** A third-party npm package: licence as declared and as the licence gate concludes it. */
export function npmEntry(
  dep: {
    name: string;
    version: string;
    licence: string | undefined;
    homepage?: string | undefined;
  },
  ctx: SbomContext,
): { pkg: SpdxPackage; problems: string[] } {
  const problems: string[] = [];
  const locked = ctx.lock.get(lockKey(dep.name, dep.version));
  if (!locked) problems.push(`${dep.name}@${dep.version} is not in pnpm-lock.yaml`);
  else if (!locked.integrity)
    problems.push(`${dep.name}@${dep.version} has no integrity in pnpm-lock.yaml`);
  const declared = licenceExpression(dep.licence);
  const c = conclude(
    { name: dep.name, version: dep.version, licence: dep.licence ?? '' },
    ctx.policy,
    ctx.exceptions,
    ctx.today,
  );
  if (!c.ok) problems.push(`${dep.name}@${dep.version}: ${c.note ?? 'licence not allowed'}`);
  const concluded = c.ok ? licenceExpression(c.concluded) : NOASSERTION;
  const comments = [
    declared === NOASSERTION && dep.licence
      ? `The manifest's licence field reads "${dep.licence}", which is not an SPDX expression.`
      : '',
    c.note ? `${c.ok ? '' : 'Refused by the licence gate: '}${c.note}` : '',
  ].filter(Boolean);
  return {
    pkg: {
      SPDXID: spdxId('npm', dep.name, dep.version),
      name: dep.name,
      versionInfo: dep.version,
      downloadLocation: npmTarballUrl(dep.name, dep.version),
      filesAnalyzed: false,
      ...(locked ? { checksums: lockChecksums(locked) } : {}),
      ...(dep.homepage ? { homepage: dep.homepage } : {}),
      licenseConcluded: concluded,
      licenseDeclared: declared,
      copyrightText: NOASSERTION,
      externalRefs: [
        {
          referenceCategory: 'PACKAGE-MANAGER',
          referenceType: 'purl',
          referenceLocator: npmPurl(dep.name, dep.version),
        },
      ],
      primaryPackagePurpose: 'LIBRARY',
      ...(comments.length ? { comment: comments.join(' ') } : {}),
    },
    problems,
  };
}

/** One of this workspace's own packages, at the release version. */
export function workspaceEntry(
  name: string,
  ctx: SbomContext,
  purpose: SpdxPackage['primaryPackagePurpose'] = 'LIBRARY',
): SpdxPackage {
  return {
    SPDXID: spdxId('npm', name, ctx.version),
    name,
    versionInfo: ctx.version,
    downloadLocation: ctx.sourceLocation,
    filesAnalyzed: false,
    licenseConcluded: ctx.projectLicence,
    licenseDeclared: ctx.projectLicence,
    copyrightText: 'Copyright 2026 The project authors',
    externalRefs: [
      {
        referenceCategory: 'PACKAGE-MANAGER',
        referenceType: 'purl',
        referenceLocator: npmPurl(name, ctx.version),
      },
    ],
    primaryPackagePurpose: purpose,
    comment: 'Part of this project; built from its sources.',
  };
}

function spdxFile(f: BundleFile, prefix: string, licence: string): SpdxFile {
  return {
    SPDXID: spdxId('file', prefix, f.path),
    fileName: `./${f.path}`,
    checksums: [
      { algorithm: 'SHA1', checksumValue: f.sha1 },
      { algorithm: 'SHA256', checksumValue: f.sha256 },
    ],
    licenseConcluded: licence,
    copyrightText: NOASSERTION,
  };
}

export interface BundleSbomInput {
  /** Short name of the distributable (element). */
  id: string;
  /** Its package name (@docedit/element). */
  packageName: string;
  contents: BundleContents;
  /** The licence gate's walk for the package (production dependencies of its workspace closure). */
  walk: readonly Dependency[];
  /** Files the release adds next to the build output (manifest, licence, notices), as packed. */
  extraFiles?: readonly BundleFile[];
  /** Checksums of the packed tarball, when it exists. */
  tarball?: { sha256: string; sha512: string; fileName: string };
  ctx: SbomContext;
}

export function bundleSbom(input: BundleSbomInput): SbomResult {
  const { ctx, contents } = input;
  const problems = [
    ...contents.problems,
    ...contents.unattributed.map((u) => `${u}: no package explains this file of the bundle`),
  ];
  const notes: string[] = [];
  const root = workspaceEntry(input.packageName, ctx);
  const allFiles = [...contents.files, ...(input.extraFiles ?? [])];
  const files = allFiles.map((f) => spdxFile(f, input.id, NOASSERTION));
  const described: SpdxPackage = {
    ...root,
    filesAnalyzed: true,
    packageVerificationCode: {
      packageVerificationCodeValue: verificationCode(allFiles.map((f) => f.sha1)),
    },
    ...(input.tarball
      ? {
          checksums: [
            { algorithm: 'SHA256', checksumValue: input.tarball.sha256 },
            { algorithm: 'SHA512', checksumValue: input.tarball.sha512 },
          ],
          packageFileName: input.tarball.fileName,
        }
      : {}),
    comment: `The ${input.id} distributable as published: the build output and the files the release adds. Every bundled package is listed with CONTAINS, as found through the source maps and identical files of the build.`,
  };
  const packages: SpdxPackage[] = [];
  const relationships: SpdxRelationship[] = files.map((f) => ({
    spdxElementId: root.SPDXID,
    relationshipType: 'CONTAINS',
    relatedSpdxElement: f.SPDXID,
  }));
  const declared = new Set(input.walk.map((d) => lockKey(d.name, d.version)));
  const bundled = [...contents.packages.values()].filter((p) => p.name !== input.packageName);
  for (const p of bundled) {
    const entry = p.workspace
      ? { pkg: workspaceEntry(p.name, ctx), problems: [] }
      : npmEntry({ name: p.name, version: p.version, licence: p.licence }, ctx);
    problems.push(...entry.problems);
    packages.push(entry.pkg);
    relationships.push({
      spdxElementId: root.SPDXID,
      relationshipType: 'CONTAINS',
      relatedSpdxElement: entry.pkg.SPDXID,
    });
    if (!p.workspace && !declared.has(p.key))
      notes.push(
        `${p.key} is in the bundle but is not a production dependency of ${input.packageName}'s workspace closure, so the licence gate's walk does not see it; this bill concludes its licence with the same policy`,
      );
  }
  const shipped = new Set(bundled.map((p) => p.key));
  const unbundled = input.walk.filter((d) => !shipped.has(lockKey(d.name, d.version)));
  if (unbundled.length)
    notes.push(
      `${unbundled.length} production dependencies are not in the bundle (build-time or tree-shaken): ${unbundled.map((d) => `${d.name}@${d.version}`).join(', ')}`,
    );
  const doc = buildDocument({
    name: `${input.packageName}-${ctx.version}`,
    namespaceBase: ctx.namespaceBase,
    created: ctx.created,
    creators: CREATORS,
    describes: [described],
    packages,
    files,
    relationships,
  });
  problems.push(...validateDocument(doc));
  return { doc, problems, notes };
}

export interface ServiceSbomInput {
  id: string;
  packageName: string;
  /** Workspace packages the service runs (its production closure, itself included). */
  workspace: readonly string[];
  walk: readonly Dependency[];
  ctx: SbomContext;
}

export function serviceSbom(input: ServiceSbomInput): SbomResult {
  const { ctx } = input;
  const problems: string[] = [];
  const root: SpdxPackage = {
    ...workspaceEntry(input.packageName, ctx, 'APPLICATION'),
    comment: `The ${input.id} service: its own sources, the workspace packages it runs and their production dependencies (the licence gate's walk). The container image has a bill of its own.`,
  };
  const packages: SpdxPackage[] = [];
  const relationships: SpdxRelationship[] = [];
  for (const name of input.workspace) {
    if (name === input.packageName) continue;
    const pkg = workspaceEntry(name, ctx);
    packages.push(pkg);
    relationships.push({
      spdxElementId: root.SPDXID,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: pkg.SPDXID,
    });
  }
  for (const d of input.walk) {
    const entry = npmEntry(d, ctx);
    problems.push(...entry.problems);
    packages.push(entry.pkg);
    relationships.push({
      spdxElementId: root.SPDXID,
      relationshipType: 'DEPENDS_ON',
      relatedSpdxElement: entry.pkg.SPDXID,
    });
  }
  const doc = buildDocument({
    name: `${input.packageName}-${ctx.version}`,
    namespaceBase: ctx.namespaceBase,
    created: ctx.created,
    creators: CREATORS,
    describes: [root],
    packages,
    relationships,
  });
  problems.push(...validateDocument(doc));
  return { doc, problems, notes: [] };
}

/** npm packages of a document, by purl: `name@version`. */
export function npmPackagesOf(doc: SpdxDocument): Set<string> {
  const out = new Set<string>();
  for (const p of doc.packages)
    for (const r of p.externalRefs ?? []) {
      const m = /^pkg:npm\/(.+)@([^@?#]+)(?:[?#].*)?$/.exec(r.referenceLocator);
      if (r.referenceType === 'purl' && m)
        out.add(`${decodeURIComponent(m[1]!)}@${decodeURIComponent(m[2]!)}`);
    }
  return out;
}

/** Every npm package of a bill against the lock file: present, and with the locked checksum. */
export function compareWithLock(
  doc: SpdxDocument,
  lock: ReadonlyMap<string, LockedPackage>,
  version: string,
): string[] {
  const problems: string[] = [];
  for (const p of doc.packages) {
    const purl = p.externalRefs?.find(
      (r) => r.referenceType === 'purl' && r.referenceLocator.startsWith('pkg:npm/'),
    );
    if (!purl || !p.versionInfo) continue;
    if (p.name.startsWith('@docedit/')) {
      if (p.versionInfo !== version)
        problems.push(`${p.name}: version ${p.versionInfo} in the bill, ${version} in the release`);
      continue;
    }
    const locked = lock.get(lockKey(p.name, p.versionInfo));
    if (!locked) {
      problems.push(`${p.name}@${p.versionInfo} is in the bill but not in pnpm-lock.yaml`);
      continue;
    }
    const expected = lockChecksums(locked)[0];
    const actual = p.checksums?.find((c) => c.algorithm === expected?.algorithm);
    if (expected && actual?.checksumValue !== expected.checksumValue)
      problems.push(
        `${p.name}@${p.versionInfo}: the bill's ${expected.algorithm} checksum differs from pnpm-lock.yaml`,
      );
  }
  return problems;
}

/** The packages a bundle bill lists against what the bundle contains, both ways. */
export function compareWithContents(
  doc: SpdxDocument,
  contents: BundleContents,
  ownName: string,
): string[] {
  const listed = new Set(
    [...doc.packages]
      .filter((p) => p.name !== ownName && p.versionInfo)
      .map((p) => `${p.name}@${p.versionInfo}`),
  );
  const found = new Set(
    [...contents.packages.values()]
      .filter((p: PackageInfo) => p.name !== ownName)
      .map((p) => (p.workspace ? `${p.name}@${doc.packages[0]?.versionInfo ?? p.version}` : p.key)),
  );
  const problems: string[] = [];
  for (const k of found)
    if (!listed.has(k)) problems.push(`${k} is in the bundle but not in its bill`);
  for (const k of listed)
    if (!found.has(k)) problems.push(`${k} is in the bill but not in the bundle`);
  const files = new Map(
    (doc.files ?? []).map((f) => [
      f.fileName,
      f.checksums.find((c) => c.algorithm === 'SHA256')?.checksumValue,
    ]),
  );
  for (const f of contents.files) {
    const sha = files.get(`./${f.path}`);
    if (sha === undefined) problems.push(`${f.path} is in the bundle but not in its bill`);
    else if (sha !== f.sha256)
      problems.push(`${f.path}: SHA-256 in the bill differs from the file`);
  }
  return problems;
}

/** A service's npm packages against those Syft finds in its image, both ways. */
export function compareWithImage(declared: SpdxDocument, observed: SpdxDocument): string[] {
  const want = new Set([...npmPackagesOf(declared)].filter((k) => !k.startsWith('@docedit/')));
  const have = new Set([...npmPackagesOf(observed)].filter((k) => !k.startsWith('@docedit/')));
  const problems: string[] = [];
  for (const k of want)
    if (!have.has(k)) problems.push(`${k} is a declared dependency but is not in the image`);
  for (const k of have)
    if (!want.has(k)) problems.push(`${k} is in the image but not among the declared dependencies`);
  return problems;
}

export interface ImageSbomInput {
  id: string;
  /** The image reference, without tag or digest (ghcr.io/owner/docedit-export-worker). */
  image: string;
  /** The manifest digest, sha256:…, once the image is pushed. */
  digest?: string;
  /** The image identifier (its configuration's digest), which two identical builds share. */
  imageId?: string;
  syft?: SpdxDocument;
  tex?: readonly TexPackage[];
  fonts?: FontManifest | null;
  ctx: Pick<SbomContext, 'version' | 'created' | 'namespaceBase' | 'projectLicence'>;
}

/** The image's bill: Syft's packages under one image package, plus TeX Live and fonts. */
export function imageSbom(input: ImageSbomInput): SbomResult {
  const problems: string[] = [];
  const digest = input.digest?.replace(/^sha256:/, '');
  if (digest !== undefined && !/^[0-9a-f]{64}$/.test(digest))
    problems.push(`digest "${input.digest}" is not sha256:<64 hex>`);
  const root: SpdxPackage = {
    SPDXID: spdxId('image', input.id, input.ctx.version),
    name: input.image,
    versionInfo: input.ctx.version,
    downloadLocation: NOASSERTION,
    filesAnalyzed: false,
    ...(digest ? { checksums: [{ algorithm: 'SHA256' as const, checksumValue: digest }] } : {}),
    licenseConcluded: NOASSERTION,
    licenseDeclared: NOASSERTION,
    copyrightText: NOASSERTION,
    externalRefs: digest
      ? [
          {
            referenceCategory: 'PACKAGE-MANAGER',
            referenceType: 'purl',
            referenceLocator: `pkg:oci/${input.image.split('/').at(-1)}@sha256%3A${digest}?repository_url=${encodeURIComponent(input.image)}`,
          },
        ]
      : [],
    primaryPackagePurpose: 'CONTAINER',
    comment: `The ${input.id} container image${digest ? `, ${input.image}@sha256:${digest}` : ''}${input.imageId ? `, image identifier ${input.imageId}` : ''}. Its packages come from ${input.syft ? "Syft's catalogue of the image" : 'no Syft catalogue (not run)'}${input.tex ? ', from tlmgr inside the image (TeX Live) and from its font manifest' : ''}.`,
  };
  const packages: SpdxPackage[] = [];
  const relationships: SpdxRelationship[] = [];
  const licenceRefs: SpdxLicenceRef[] = [];
  if (input.syft) {
    const describedBySyft = new Set(
      input.syft.relationships
        .filter((r) => r.spdxElementId === 'SPDXRef-DOCUMENT' && r.relationshipType === 'DESCRIBES')
        .map((r) => r.relatedSpdxElement),
    );
    for (const p of input.syft.packages) {
      if (describedBySyft.has(p.SPDXID)) continue;
      packages.push(p);
      relationships.push({
        spdxElementId: root.SPDXID,
        relationshipType: 'CONTAINS',
        relatedSpdxElement: p.SPDXID,
      });
    }
    licenceRefs.push(...(input.syft.hasExtractedLicensingInfos ?? []));
  }
  if (input.tex || input.fonts) {
    const tex = texliveEntries(input.tex ?? [], input.fonts ?? null, root.SPDXID);
    packages.push(...tex.packages);
    relationships.push(...tex.relationships);
    licenceRefs.push(...tex.licenceRefs);
  }
  const doc = buildDocument({
    name: `${input.image.split('/').at(-1)}-${input.ctx.version}`,
    namespaceBase: input.ctx.namespaceBase,
    created: input.ctx.created,
    creators: CREATORS,
    describes: [root],
    packages,
    relationships,
    licenceRefs,
  });
  problems.push(...validateDocument(doc));
  return { doc, problems, notes: [] };
}

/** The TeX Live packages of a bill against tlmgr's listing of the image, both ways. */
export function compareTexWithImage(doc: SpdxDocument, tex: readonly TexPackage[]): string[] {
  const listed = new Set(
    doc.packages
      .filter((p) => p.SPDXID.startsWith('SPDXRef-texlive-'))
      .map((p) => `${p.name} ${p.versionInfo}`),
  );
  const found = new Set(tex.map((p) => `${p.name} ${p.catalogueVersion || `r${p.revision}`}`));
  const problems: string[] = [];
  for (const k of found)
    if (!listed.has(k)) problems.push(`TeX Live package ${k} is in the image but not in its bill`);
  for (const k of listed)
    if (!found.has(k)) problems.push(`TeX Live package ${k} is in the bill but not in the image`);
  return problems;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  const opt = (name: string) => {
    const i = rest.indexOf(name);
    return i >= 0 ? rest[i + 1] : undefined;
  };
  if (command === 'validate') {
    let failed = 0;
    for (const file of rest) {
      const problems = validateDocument(JSON.parse(readFileSync(file, 'utf8')) as SpdxDocument);
      console.log(`${file}: ${problems.length ? `${problems.length} problem(s)` : 'valid'}`);
      for (const p of problems) console.log(`  - ${p}`);
      if (problems.length) failed++;
    }
    return failed ? 1 : 0;
  }
  if (command === 'image') {
    const id = opt('--id');
    const image = opt('--image');
    const version = opt('--version');
    const out = opt('--out');
    if (!id || !image || !version || !out) {
      console.error(
        'usage: node scripts/release/sbom.ts image --id <id> --image <ref> --version <v> --out <file> [--digest sha256:…] [--syft f] [--tlmgr f] [--fonts f] [--declared f]',
      );
      return 2;
    }
    const read = (f: string | undefined) => (f ? readFileSync(f, 'utf8') : undefined);
    const syftText = read(opt('--syft'));
    const tlmgr = read(opt('--tlmgr'));
    const fontsText = read(opt('--fonts'));
    const declaredText = read(opt('--declared'));
    const epoch = Number(process.env['SOURCE_DATE_EPOCH'] ?? Math.floor(Date.now() / 1000));
    const tex = tlmgr ? parseTlmgrInfo(tlmgr) : undefined;
    const digest = opt('--digest');
    const imageId = opt('--image-id');
    const syft = syftText ? (JSON.parse(syftText) as SpdxDocument) : undefined;
    const result = imageSbom({
      id,
      image,
      ...(digest ? { digest } : {}),
      ...(imageId ? { imageId } : {}),
      ...(syft ? { syft } : {}),
      ...(tex ? { tex } : {}),
      fonts: fontsText ? (JSON.parse(fontsText) as FontManifest) : null,
      ctx: {
        version,
        created: opt('--created') ?? createdAt(epoch),
        namespaceBase: opt('--namespace') ?? 'https://docedit.invalid/spdx',
        projectLicence: 'Apache-2.0',
      },
    });
    if (tex) result.problems.push(...compareTexWithImage(result.doc, tex));
    if (declaredText && syft)
      result.problems.push(...compareWithImage(JSON.parse(declaredText) as SpdxDocument, syft));
    writeFileSync(out, stringify(result.doc));
    console.log(`${out}: ${result.doc.packages.length} packages`);
    for (const p of result.problems) console.error(`  - ${p}`);
    return result.problems.length ? 1 : 0;
  }
  console.error('usage: node scripts/release/sbom.ts image|validate …');
  return 2;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
