/**
 * Builds the distributable (FE-002): `node scripts/build.ts` (the package's `build` script).
 * 1. The library, Vite library mode: dist/lib/doc-editor.js and its lazy chunks.
 * 2. The PDF viewer's page for its sandboxed frame: dist/lib/viewer/ (FE-071).
 * 3. The size report, dist/lib/bundle-report.json; the build fails above the budget (13 §9), and
 *    when a WebAssembly module is in the first interactive set or inlined as base64 (FND-008).
 */
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build, type Rollup } from 'vite';
import {
  bundleReport,
  printReport,
  writeReport,
  type AssetInfo,
  type ChunkInfo,
} from './bundle-report.ts';
import { libDir, libraryConfig, viewerConfig, viewerDir } from './vite-configs.ts';

function chunksOf(result: Awaited<ReturnType<typeof build>>): ChunkInfo[] {
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return outputs.flatMap((o) =>
    o.output
      .filter((x): x is Rollup.OutputChunk => x.type === 'chunk')
      .map((c) => ({
        fileName: c.fileName,
        isEntry: c.isEntry,
        isDynamicEntry: c.isDynamicEntry,
        imports: c.imports,
        dynamicImports: c.dynamicImports,
        moduleIds: c.moduleIds,
        moduleSizes: Object.fromEntries(
          Object.entries(c.modules).map(([id, m]) => [id, m.renderedLength]),
        ),
        code: c.code,
      })),
  );
}

function assetsOf(result: Awaited<ReturnType<typeof build>>): AssetInfo[] {
  const outputs = (Array.isArray(result) ? result : [result]) as Rollup.RollupOutput[];
  return outputs.flatMap((o) =>
    o.output
      .filter((x): x is Rollup.OutputAsset => x.type === 'asset')
      .map((a) => ({ fileName: a.fileName, source: a.source })),
  );
}

export async function buildLibrary(): Promise<boolean> {
  const started = Date.now();
  const library = await build(libraryConfig());
  await build(viewerConfig());
  const report = bundleReport(chunksOf(library), viewerDir, assetsOf(library));
  writeReport(report, join(libDir, 'bundle-report.json'));
  printReport(report);
  console.log(`library build: done in ${((Date.now() - started) / 1000).toFixed(1)} s`);
  for (const violation of report.wasmViolations)
    console.error(`WebAssembly must load lazily, as a file of its own (FND-008): ${violation}`);
  if (!report.withinBudget)
    console.error('The first interactive editor is over its size budget (13 §9; FE-002).');
  return report.withinBudget && report.wasmViolations.length === 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ok = await buildLibrary();
  if (!ok) process.exitCode = 1;
}
