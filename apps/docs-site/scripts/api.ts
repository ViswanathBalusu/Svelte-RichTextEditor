/**
 * The generated API documentation (FND-013 criterion 1): TypeDoc reads each package that has an
 * `src/index.ts` and writes HTML, one module for each package, named as `package.json` names it.
 * The embedding API is the module `@docedit/element`.
 */
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Application } from 'typedoc';

/** The package folders of `packages/` that have an entry point, as absolute paths. */
export function apiPackages(repoRoot: string): string[] {
  const root = join(repoRoot, 'packages');
  if (!existsSync(root)) return [];
  return readdirSync(root)
    .sort()
    .map((name) => join(root, name))
    .filter(
      (dir) => existsSync(join(dir, 'package.json')) && existsSync(join(dir, 'src', 'index.ts')),
    );
}

export interface ApiResult {
  packages: string[];
  /** The number of warnings TypeDoc gave; they are not errors (a type the entry point does not export). */
  warnings: number;
}

export async function generateApi(repoRoot: string, outDir: string): Promise<ApiResult> {
  const packages = apiPackages(repoRoot);
  if (packages.length === 0) return { packages: [], warnings: 0 };
  const app = await Application.bootstrapWithPlugins({
    // TypeDoc reads entry points as globs, which take forward slashes only.
    entryPoints: packages.map((p) => p.replaceAll('\\', '/')),
    entryPointStrategy: 'packages',
    // The packages are checked by their own type-check. Documentation does not need a second one.
    skipErrorChecking: true,
    name: 'Document editor API',
    readme: 'none',
    hideGenerator: true,
    logLevel: 'Error',
    // The sources link to the repository, which is not part of the site.
    sourceLinkTemplate: '',
    disableSources: true,
    // A type that an entry point does not export is a warning, not a reason to stop.
    treatWarningsAsErrors: false,
    validation: { notExported: false, invalidLink: false, notDocumented: false },
  });
  const project = await app.convert();
  if (!project) throw new Error('TypeDoc could not convert the packages');
  await app.generateDocs(project, outDir);
  return { packages: packages.map((p) => p), warnings: 0 };
}
