/**
 * Adds the published images to a draft release's records (FND-012, SEC-052; ADR 0044 §5): the
 * images section of RELEASE-NOTES.md in place of its marker, the images and their bills in
 * release-manifest.json, and SHA256SUMS over every file again. The draft's other files are not
 * rebuilt, so what was reviewed is what is published.
 *
 * Usage: node scripts/release/finalise.ts <release files directory> <images.json>
 *   images.json: [{ "id", "image", "digest": "sha256:…", "sbom": "<file next to images.json>" }]
 */
import {
  copyFileSync,
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hashFile } from '../supply-chain/bundle.ts';
import { IMAGES_MARKER, renderImages, type Artefact, type ImageRecord } from './notes.ts';
import { sha256sums } from './release.ts';

export function finaliseNotes(notes: string, images: readonly ImageRecord[]): string {
  if (!notes.includes(IMAGES_MARKER))
    throw new Error('the release notes have no images marker: already finalised, or not a draft');
  const ids = new Set(images.map((i) => i.id));
  let text = notes.replace(IMAGES_MARKER, renderImages(images).trimEnd());
  text = text
    .split('\n')
    .filter((line) => ![...ids].some((id) => line.startsWith(`- ${id} image (`)))
    .join('\n');
  return text.replace(/## Not in this release\n+(?=## )/, '');
}

interface Manifest {
  images: ImageRecord[];
  missing: string[];
  artefacts: Artefact[];
  [key: string]: unknown;
}

export function finaliseManifest(
  manifest: Manifest,
  images: readonly ImageRecord[],
  sboms: readonly Artefact[],
): Manifest {
  const ids = new Set(images.map((i) => i.id));
  return {
    ...manifest,
    images: [...images],
    missing: manifest.missing.filter((m) => ![...ids].some((id) => m.startsWith(`${id} image (`))),
    artefacts: [
      ...manifest.artefacts.filter((a) => !sboms.some((s) => s.file === a.file)),
      ...sboms,
    ],
  };
}

function main(argv: string[]): number {
  const [dir, imagesFile] = argv;
  if (!dir || !imagesFile) {
    console.error(
      'usage: node scripts/release/finalise.ts <release files directory> <images.json>',
    );
    return 2;
  }
  const images = JSON.parse(readFileSync(imagesFile, 'utf8')) as ImageRecord[];
  for (const i of images)
    if (!/^sha256:[0-9a-f]{64}$/.test(i.digest) || basename(i.sbom) !== i.sbom)
      throw new Error(`images.json: ${i.id} needs a sha256 digest and a plain bill file name`);
  const sboms: Artefact[] = images.map((i) => {
    const from = join(dirname(imagesFile), i.sbom);
    if (existsSync(from) && resolve(from) !== resolve(dir, i.sbom))
      copyFileSync(from, join(dir, i.sbom));
    const h = hashFile(join(dir, i.sbom));
    return {
      file: i.sbom,
      kind: `SPDX 2.3 bill of materials (${i.id} image)`,
      size: h.size,
      sha256: h.sha256,
    };
  });
  const notesFile = join(dir, 'RELEASE-NOTES.md');
  writeFileSync(notesFile, finaliseNotes(readFileSync(notesFile, 'utf8'), images));
  const manifestFile = join(dir, 'release-manifest.json');
  const manifest = finaliseManifest(
    JSON.parse(readFileSync(manifestFile, 'utf8')) as Manifest,
    images,
    sboms,
  );
  writeFileSync(manifestFile, `${JSON.stringify(manifest, null, 2)}\n`);
  const files = readdirSync(dir).filter(
    (f) => f !== 'SHA256SUMS' && statSync(join(dir, f)).isFile(),
  );
  writeFileSync(
    join(dir, 'SHA256SUMS'),
    sha256sums(files.map((f) => ({ file: f, sha256: hashFile(join(dir, f)).sha256 }))),
  );
  console.log(`finalised ${dir}: ${images.length} image(s), ${files.length + 1} files`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  process.exitCode = main(process.argv.slice(2));
