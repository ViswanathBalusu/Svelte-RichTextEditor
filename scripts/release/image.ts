/**
 * A service image for a release (FND-012 criterion 3, SEC-051, SEC-052; ADR 0044 §5). Builds it
 * with Podman from its Containerfile, every timestamp set to SOURCE_DATE_EPOCH, twice and the
 * second time without the cache, and refuses when the two image identifiers differ. Writes the
 * image's bill of materials (Syft's catalogue, plus TeX Live and fonts read inside the image for
 * the export worker) and image.json. With --expect-id it refuses an image that differs from the
 * reviewed draft; with --push it pushes the image by digest and records the digest. The release
 * workflow signs and attests the pushed digest with cosign.
 *
 * The container CLI is DOCEDIT_CONTAINER_CLI (default podman); Syft is SYFT (default syft).
 *
 * Usage: node scripts/release/image.ts --id <distributable> --version <v> --repository <registry/owner>
 *          --out <dir> [--once] [--expect-id <sha256:…>] [--push] [--declared-dir <release files>]
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { presence } from './distributables.ts';
import { readServiceNotices, stageOverlayContext, texliveNotices } from './image-notices.ts';
import type { ImageRecord } from './notes.ts';
import { compareTexWithImage, compareWithImage, createdAt, imageSbom } from './sbom.ts';
import { stringify, type SpdxDocument } from './spdx.ts';
import { parseTlmgrInfo, type FontManifest, type TexPackage } from './texlive.ts';
import {
  licenceManifest,
  DPKG_STATUS,
  parseDpkg,
  sourceOffer,
  type BaseSystemPackage,
  type LicenceManifestInput,
} from './licence-manifest.ts';

export const TLMGR_FIELDS = 'name,category,localrev,cat-version,cat-license';

export function buildArgs(
  containerfile: string,
  context: string,
  tag: string,
  epoch: number,
  noCache: boolean,
  squash = false,
): string[] {
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error(`SOURCE_DATE_EPOCH "${epoch}" is not a number of seconds`);
  return [
    'build',
    '--timestamp',
    String(epoch),
    ...(noCache ? ['--no-cache'] : []),
    ...(squash ? ['--squash-all'] : []),
    '-f',
    containerfile,
    '-t',
    tag,
    context,
  ];
}

export function pushArgs(local: string, remote: string, digestFile: string): string[] {
  return ['push', '--digestfile', digestFile, local, `docker://${remote}`];
}

/** `sha256:<hex>`, whatever form the CLI printed. */
export function normaliseId(id: string): string {
  const hex = id.trim().replace(/^sha256:/, '');
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new Error(`"${id.trim()}" is not an image identifier`);
  return `sha256:${hex}`;
}

/** The bill's file name: the image name and the version. */
export const imageSbomName = (image: string, version: string) =>
  `${image}-${version}.image.spdx.json`;

/** The licence manifest and the source offer of an image (SEC-053 criterion 3). */
export const imageLicenceManifestName = (image: string, version: string) =>
  `${image}-${version}.licence-manifest.json`;
export const imageSourceOfferName = (image: string, version: string) =>
  `${image}-${version}.source-offer.md`;

/** The file name that the release gives a file of a distributable (release.ts `artefactName`). */
export function releaseFile(d: { packageName: string }, version: string, suffix: string): string {
  return `${d.packageName.replace(/^@/, '').replace('/', '-')}-${version}${suffix}`;
}

/**
 * Builds the notices layer on top of `base` as `tag`, twice and the second time without the cache
 * unless `once`, and returns the identifier of the image. Refuses when the two builds differ.
 */
export function addNoticesLayer(o: {
  cli: string;
  base: string;
  tag: string;
  root: string;
  thirdParty: string;
  epoch: number;
  once: boolean;
}): string {
  const inspect = (tag: string) =>
    normaliseId(exec(o.cli, ['image', 'inspect', '--format', '{{.Id}}', tag]));
  const dir = mkdtempSync(join(tmpdir(), 'docedit-image-notices-'));
  try {
    const file = stageOverlayContext(dir, {
      base: o.base,
      root: o.root,
      thirdParty: o.thirdParty,
    });
    exec(o.cli, buildArgs(file, dir, o.tag, o.epoch, false), false);
    const id = inspect(o.tag);
    if (!o.once) {
      const again = `${o.tag}-layer-again`;
      exec(o.cli, buildArgs(file, dir, again, o.epoch, true), false);
      const second = inspect(again);
      exec(o.cli, ['rmi', '--force', again], false);
      if (second !== id)
        throw new Error(
          `the notices layer is not reproducible: two builds gave ${id} and ${second}`,
        );
    }
    return id;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * The house class's version (the last entry of the class release ledger of EXP-015) and licence
 * (`CLASS_LICENCE` of packages/export-latex, which the release scripts do not import).
 */
export function houseClass(root: string): { version: string; licence: string } {
  const ledger = JSON.parse(
    readFileSync(join(root, 'packages/export-latex/class/releases.json'), 'utf8'),
  ) as { releases: { version: string }[] };
  const last = ledger.releases[ledger.releases.length - 1];
  if (!last) throw new Error('packages/export-latex/class/releases.json lists no release');
  return { version: last.version, licence: 'Apache-2.0' };
}

function exec(file: string, args: string[], capture = true): string {
  const r = spawnSync(file, args, {
    encoding: 'utf8',
    maxBuffer: 256 * 1024 * 1024,
    stdio: capture ? ['ignore', 'pipe', 'inherit'] : 'inherit',
  });
  if (r.status !== 0)
    throw new Error(`${file} ${args.join(' ')} exited with ${r.status ?? r.signal}`);
  return r.stdout ?? '';
}

async function main(argv: string[]): Promise<number> {
  const opt = (name: string) => {
    const i = argv.indexOf(name);
    return i >= 0 ? argv[i + 1] : undefined;
  };
  const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', '..');
  const id = opt('--id');
  const version = opt('--version');
  const repository = opt('--repository')?.toLowerCase();
  const out = opt('--out');
  if (!id || !version || !repository || !out) {
    console.error(
      'usage: node scripts/release/image.ts --id <distributable> --version <v> --repository <registry/owner> --out <dir> [--once] [--expect-id <id>] [--push] [--declared-dir <dir>]',
    );
    return 2;
  }
  const d = presence(root).images.find((i) => i.id === id);
  if (!d) throw new Error(`${id}: no image to build (scripts/release/distributables.ts)`);
  const cli = process.env['DOCEDIT_CONTAINER_CLI'] || 'podman';
  const syft = process.env['SYFT'] || 'syft';
  const epoch = Number(process.env['SOURCE_DATE_EPOCH']);
  mkdirSync(out, { recursive: true });
  const local = `localhost/${d.image}:${version}`;
  const inspect = (tag: string) =>
    normaliseId(exec(cli, ['image', 'inspect', '--format', '{{.Id}}', tag]));
  // The context: a directory of the repository, or one the service's build script stages.
  let containerfile = join(root, d.containerfile);
  let context = d.context ? join(root, d.context) : '';
  if (d.stage) {
    const mod = (await import(pathToFileURL(join(root, d.stage.module)).href)) as Record<
      string,
      unknown
    >;
    const stage = mod[d.stage.export];
    if (typeof stage !== 'function')
      throw new Error(`${d.stage.module} exports no ${d.stage.export}()`);
    context = (stage as () => string)();
    containerfile = join(context, 'Containerfile');
  }

  // An image whose context does not write the notices gets one more layer that holds them
  // (scripts/release/image-notices.ts); the image of the release is then the one with the layer.
  const layer = !d.noticesInContext;
  const base = layer ? `${local}-base` : local;
  exec(cli, buildArgs(containerfile, context, base, epoch, false, d.texlive === true), false);
  const baseId = inspect(base);
  if (!argv.includes('--once')) {
    exec(
      cli,
      buildArgs(containerfile, context, `${local}-again`, epoch, true, d.texlive === true),
      false,
    );
    const again = inspect(`${local}-again`);
    console.log(`${d.image}: first build ${baseId}, second build without cache ${again}`);
    if (again !== baseId)
      throw new Error(
        `${d.image} is not reproducible: two builds of one commit gave ${baseId} and ${again}`,
      );
  }
  const declaredDir = opt('--declared-dir');
  let tex: TexPackage[] | undefined;
  let fonts: FontManifest | null = null;
  let baseSystem: BaseSystemPackage[] = [];
  if (d.texlive) {
    const run = (...a: string[]) => exec(cli, ['run', '--rm', '--network=none', ...a]);
    tex = parseTlmgrInfo(
      run('--entrypoint', 'tlmgr', base, 'info', '--only-installed', '--data', TLMGR_FIELDS),
    );
    fonts = JSON.parse(
      run('--entrypoint', 'cat', base, '/opt/docedit/fonts/fonts.json'),
    ) as FontManifest;
    baseSystem = parseDpkg(run('--entrypoint', 'cat', base, DPKG_STATUS));
  }
  let imageId = baseId;
  if (layer) {
    let thirdParty: string;
    if (tex) thirdParty = texliveNotices(`${d.packageName} ${version}`, tex, fonts);
    else {
      if (!declaredDir)
        throw new Error(`${id}: the service's notices are needed for the image (--declared-dir)`);
      thirdParty = readServiceNotices(join(declaredDir, releaseFile(d, version, '.notices.md')));
    }
    imageId = addNoticesLayer({
      cli,
      base,
      tag: local,
      root,
      thirdParty,
      epoch,
      once: argv.includes('--once'),
    });
  }
  const expected = opt('--expect-id');
  if (expected && normaliseId(expected) !== imageId)
    throw new Error(
      `${d.image}: this build is ${imageId}, the reviewed draft recorded ${expected}`,
    );

  const archive = join(out, `${d.image}.oci.tar`);
  exec(cli, ['save', '--format', 'oci-archive', '-o', archive, local], false);
  const syftFile = join(out, `${d.image}.syft.spdx.json`);
  exec(syft, ['scan', `oci-archive:${archive}`, '-o', `spdx-json=${syftFile}`], false);
  rmSync(archive, { force: true });
  const syftDoc = JSON.parse(readFileSync(syftFile, 'utf8')) as SpdxDocument;

  let digest: string | undefined;
  if (argv.includes('--push')) {
    const digestFile = join(out, `${d.image}.digest`);
    exec(cli, pushArgs(local, `${repository}/${d.image}:${version}`, digestFile), false);
    digest = normaliseId(readFileSync(digestFile, 'utf8'));
  }

  const result = imageSbom({
    id,
    image: `${repository}/${d.image}`,
    ...(digest ? { digest } : {}),
    imageId,
    syft: syftDoc,
    ...(tex ? { tex } : {}),
    fonts,
    ctx: {
      version,
      created: createdAt(epoch),
      namespaceBase: process.env['DOCEDIT_SBOM_NAMESPACE'] ?? 'https://docedit.invalid/spdx',
      projectLicence: 'Apache-2.0',
    },
  });
  if (tex) result.problems.push(...compareTexWithImage(result.doc, tex));
  if (d.serviceInImage) {
    const declared = declaredDir ? join(declaredDir, releaseFile(d, version, '.spdx.json')) : null;
    if (!declared || !existsSync(declared))
      result.problems.push(
        `${id}: the service's bill is needed to compare with the image (--declared-dir)`,
      );
    else
      result.problems.push(
        ...compareWithImage(JSON.parse(readFileSync(declared, 'utf8')) as SpdxDocument, syftDoc),
      );
  }
  if (d.stage) rmSync(context, { recursive: true, force: true });
  const sbom = imageSbomName(d.image, version);
  writeFileSync(join(out, sbom), stringify(result.doc));
  // The licence manifest and the source offer of an image that holds TeX Live (SEC-053 criterion 3).
  let licenceFiles: { licenceManifest: string; sourceOffer: string } | null = null;
  if (tex) {
    const input: LicenceManifestInput = {
      image: `${repository}/${d.image}`,
      imageId,
      version,
      base: /^FROM (S+)/m.exec(readFileSync(containerfile, 'utf8'))?.[1] ?? null,
      tex,
      fonts,
      houseClass: houseClass(root),
      baseSystem,
    };
    const manifest = licenceManifest(input);
    // Listed in the manifest, not a failure: TeX Live's own infrastructure packages state no licence
    // in the Catalogue, and the release does not guess one (ADR 0483).
    if (manifest.tex.unknownLicence.length)
      console.error(
        `note: ${manifest.tex.unknownLicence.length} TeX Live packages state no licence in the Catalogue: ${manifest.tex.unknownLicence.join(', ')}`,
      );
    licenceFiles = {
      licenceManifest: imageLicenceManifestName(d.image, version),
      sourceOffer: imageSourceOfferName(d.image, version),
    };
    writeFileSync(
      join(out, licenceFiles.licenceManifest),
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    writeFileSync(join(out, licenceFiles.sourceOffer), sourceOffer(input));
  }
  const record: Partial<ImageRecord> & { imageId: string } = {
    id,
    image: `${repository}/${d.image}`,
    imageId,
    sbom,
    ...(licenceFiles ?? {}),
    ...(digest ? { digest } : {}),
  };
  writeFileSync(join(out, 'image.json'), `${JSON.stringify(record, null, 2)}\n`);
  console.log(
    `${d.image}: ${result.doc.packages.length - 1} packages in ${sbom}${digest ? `; pushed as ${repository}/${d.image}@${digest}` : ''}`,
  );
  for (const p of result.problems) console.error(`  - ${p}`);
  return result.problems.length ? 1 : 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.exitCode = await main(process.argv.slice(2));
  } catch (e) {
    console.error(e instanceof Error ? e.message : String(e));
    process.exitCode = 1;
  }
}
