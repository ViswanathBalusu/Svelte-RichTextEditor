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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { presence } from './distributables.ts';
import type { ImageRecord } from './notes.ts';
import { compareTexWithImage, compareWithImage, createdAt, imageSbom } from './sbom.ts';
import { stringify, type SpdxDocument } from './spdx.ts';
import { parseTlmgrInfo, type FontManifest, type TexPackage } from './texlive.ts';

export const TLMGR_FIELDS = 'name,category,localrev,cat-version,cat-license';

export function buildArgs(
  containerfile: string,
  context: string,
  tag: string,
  epoch: number,
  noCache: boolean,
): string[] {
  if (!Number.isSafeInteger(epoch) || epoch < 0)
    throw new Error(`SOURCE_DATE_EPOCH "${epoch}" is not a number of seconds`);
  return [
    'build',
    '--timestamp',
    String(epoch),
    ...(noCache ? ['--no-cache'] : []),
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

  exec(cli, buildArgs(containerfile, context, local, epoch, false), false);
  const imageId = inspect(local);
  if (!argv.includes('--once')) {
    exec(cli, buildArgs(containerfile, context, `${local}-again`, epoch, true), false);
    const again = inspect(`${local}-again`);
    console.log(`${d.image}: first build ${imageId}, second build without cache ${again}`);
    if (again !== imageId)
      throw new Error(
        `${d.image} is not reproducible: two builds of one commit gave ${imageId} and ${again}`,
      );
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
  let tex: TexPackage[] | undefined;
  let fonts: FontManifest | null = null;
  if (d.texlive) {
    const run = (...a: string[]) => exec(cli, ['run', '--rm', '--network=none', ...a]);
    tex = parseTlmgrInfo(
      run('--entrypoint', 'tlmgr', local, 'info', '--only-installed', '--data', TLMGR_FIELDS),
    );
    fonts = JSON.parse(
      run('--entrypoint', 'cat', local, '/opt/docedit/fonts/fonts.json'),
    ) as FontManifest;
  }

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
  const declaredDir = opt('--declared-dir');
  if (d.serviceInImage) {
    const declared = declaredDir
      ? join(
          declaredDir,
          `${d.packageName.replace(/^@/, '').replace('/', '-')}-${version}.spdx.json`,
        )
      : null;
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
  const record: Partial<ImageRecord> & { imageId: string } = {
    id,
    image: `${repository}/${d.image}`,
    imageId,
    sbom,
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
