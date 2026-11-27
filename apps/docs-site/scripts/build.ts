/**
 * Builds the documentation site of one release (FND-013).
 *
 *   node scripts/build.ts [--version <x.y.z>] [--site <folder>] [--site-root </path/>]
 *                         [--repo <folder>] [--stage-dir <folder>] [--no-api] [--stage-only]
 *
 * It stages the content, generates the API documentation, builds the VitePress site into
 * `<site>/<version>/`, and rewrites `<site>/versions.json` and `<site>/index.html`, so that the
 * site folder holds every release it has been given and opens the latest. Put the folder of the
 * earlier releases at `<site>` first, and the new release is added to it.
 */
import { mkdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateApi } from './api.ts';
import { listOf, readList, registerVersion } from './layout.ts';
import { stageSite } from './stage.ts';

export interface BuildOptions {
  repoRoot: string;
  version: string;
  siteDir: string;
  siteRoot: string;
  stageDir: string;
  api: boolean;
  stageOnly: boolean;
}

export async function buildSite(options: BuildOptions): Promise<void> {
  const { repoRoot, version, siteDir, stageDir } = options;
  const list = listOf([...readList(siteDir).versions, version]);
  const outDir = join(siteDir, version);
  let apiDir: string | null = null;
  if (options.api && !options.stageOnly) {
    apiDir = `${stageDir}-api`;
    rmSync(apiDir, { recursive: true, force: true });
    const result = await generateApi(repoRoot, apiDir);
    console.log(`API documentation: ${result.packages.length} packages`);
  }
  const staged = stageSite({
    repoRoot,
    stageDir,
    version,
    versions: list.versions,
    latest: list.latest,
    siteRoot: options.siteRoot,
    apiDir,
    outDir,
  });
  const count = Object.values(staged.pages).reduce((n, p) => n + p.length, 0);
  console.log(
    `staged ${count} pages, ${staged.artifactFiles} artifacts, guide ${staged.hasGuide}, API ${staged.hasApi}`,
  );
  if (options.stageOnly) return;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(siteDir, { recursive: true });
  // VitePress is loaded here so that the tests of the layout need not load it.
  const { build } = await import('vitepress');
  await build(stageDir);
  registerVersion(siteDir, version);
  console.log(`site ${version} built into ${outDir}; latest is ${list.latest}`);
}

function argValue(args: string[], name: string): string | undefined {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const here = dirname(fileURLToPath(import.meta.url));
  const app = resolve(here, '..');
  const args = process.argv.slice(2);
  const repoRoot = resolve(argValue(args, '--repo') ?? join(app, '..', '..'));
  const rootVersion = (
    JSON.parse(readFileSync(join(repoRoot, 'package.json'), 'utf8')) as { version?: string }
  ).version;
  const version = argValue(args, '--version') ?? rootVersion ?? '0.0.0';
  await buildSite({
    repoRoot,
    version: version.replace(/^v/, ''),
    siteDir: resolve(argValue(args, '--site') ?? join(app, 'dist', 'site')),
    siteRoot: argValue(args, '--site-root') ?? '/',
    stageDir: resolve(argValue(args, '--stage-dir') ?? join(app, 'dist', '.stage')),
    api: !args.includes('--no-api'),
    stageOnly: args.includes('--stage-only'),
  });
}
