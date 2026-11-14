/**
 * The licence manifest of the export worker image (09 §2, §9.3 item 5; 10 §3.8; EXP-073, SEC-053):
 *
 *   node services/export-worker/scripts/licence-manifest.ts [--out <dir>]
 *
 * Reads the TeX Live package database of the image (`tlpkg/texlive.tlpdb`, whose
 * `catalogue-license` fields come from the TeX Catalogue), the image's font manifest and the house
 * class's licence, and writes `licence-manifest.json` to services/export-worker/out/licence/ (not
 * under version control). Every installed package is listed with its revision, its Catalogue
 * version and its licence; a package without a Catalogue entry is listed as `unknown`. Nothing is
 * downloaded: the database is read from the local image.
 */
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CLASS_LICENCE, CLASS_VERSION } from '@docedit/export-latex';
import { imageId, podman } from '../src/container.ts';
import { imageFontManifest } from '../src/fonts.ts';
import { IMAGE } from '../src/sandbox.ts';
import { sandboxReady } from '../src/sandbox-ready.ts';

const root = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const argv = process.argv.slice(2);
const outDir = resolve(
  argv.includes('--out') ? argv[argv.indexOf('--out') + 1]! : join(root, 'out', 'licence'),
);

const ready = await sandboxReady();
if (!ready.ok) {
  console.error(`the sandbox is not ready: ${ready.reason}`);
  process.exit(1);
}
const r = await podman(
  [
    'run',
    '--rm',
    '--network=none',
    '--read-only',
    '--cap-drop=ALL',
    '--user=10001:10001',
    '--entrypoint=cat',
    IMAGE,
    '/usr/local/texlive/2026/tlpkg/texlive.tlpdb',
  ],
  { timeoutMs: 300_000, maxStdoutBytes: 64 * 1024 * 1024 },
);
if (r.code !== 0) {
  console.error(`cannot read the package database of ${IMAGE}: ${r.stderr.slice(0, 500)}`);
  process.exit(1);
}

interface Package {
  name: string;
  category: string;
  revision: number | null;
  version: string | null;
  licence: string;
  ctan: string | null;
}

const packages: Package[] = [];
for (const stanza of new TextDecoder().decode(r.stdout).split(/\n\s*\n/)) {
  const fields = new Map<string, string>();
  for (const line of stanza.split('\n')) {
    const m = /^([a-z][a-z-]*) (.*)$/.exec(line);
    if (m && !fields.has(m[1]!)) fields.set(m[1]!, m[2]!.trim());
  }
  const name = fields.get('name');
  if (!name) continue;
  packages.push({
    name,
    category: fields.get('category') ?? 'unknown',
    revision: fields.has('revision') ? Number(fields.get('revision')) : null,
    version: fields.get('catalogue-version') ?? null,
    licence: fields.get('catalogue-license') ?? 'unknown',
    ctan: fields.get('catalogue-ctan') ?? null,
  });
}
packages.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
const byLicence: Record<string, number> = {};
for (const p of packages) byLicence[p.licence] = (byLicence[p.licence] ?? 0) + 1;

const containerfile = readFileSync(join(root, 'Containerfile'), 'utf8');
const base = /^FROM (\S+)/m.exec(containerfile)?.[1] ?? null;
const fonts = await imageFontManifest(IMAGE);
const manifest = {
  manifestVersion: 1,
  generatedFrom: {
    image: IMAGE,
    imageId: await imageId(IMAGE),
    base,
    database: '/usr/local/texlive/2026/tlpkg/texlive.tlpdb',
    licences: 'catalogue-license of the TeX Catalogue, as recorded in the database',
  },
  houseClass: { name: 'docedit', version: CLASS_VERSION, licence: CLASS_LICENCE },
  fonts: [
    ...fonts.families.map((f) => ({ name: f.name, licence: f.licence })),
    { name: fonts.math.name, licence: fonts.math.licence },
    ...(fonts.fallback ?? []).map((f) => ({ name: f.name, licence: f.licence })),
  ],
  packageCount: packages.length,
  byLicence,
  packages,
};
mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'licence-manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
console.log(`${packages.length} packages; licences: ${JSON.stringify(byLicence)}`);
console.log(`written: ${join(outDir, 'licence-manifest.json')}`);
