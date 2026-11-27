/**
 * Builds a bundle from a CDM document on the worker side (spike S4): reads the house class from
 * `@docedit/export-latex/class/` and the font manifest, then calls the pure converter.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  CLASS_FILES,
  convert,
  type Bundle,
  type ConvertOptions,
  type FontManifest,
  type TableMeasure,
} from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';

export function classFiles(): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of CLASS_FILES) {
    const url = import.meta.resolve(`@docedit/export-latex/class/${name}`);
    out[name] = readFileSync(fileURLToPath(url), 'utf8');
  }
  return out;
}

export function readFontManifest(path: string): FontManifest {
  return JSON.parse(readFileSync(path, 'utf8')) as FontManifest;
}

export type BuildOptions = Omit<ConvertOptions, 'classFiles' | 'fonts'> & { fonts: FontManifest };

/**
 * `files`: the class files to write into the bundle. The export handler passes the files it pinned
 * when it started, so the bundle it verifies against them is built from the same bytes even when
 * the class on disk changes between the two reads. Without it the class is read from disk now.
 */
export async function buildBundle(
  envelope: CdmEnvelope,
  options: BuildOptions,
  files: Readonly<Record<string, string>> = classFiles(),
): Promise<Bundle> {
  const tableMeasure = options.tableMeasure ?? (await measureTablesOf(envelope));
  return convert(envelope, {
    ...options,
    ...(tableMeasure ? { tableMeasure } : {}),
    classFiles: files,
  });
}

const hasTable = (node: { type?: string; content?: unknown[] } | undefined): boolean =>
  node?.type === 'table' || (node?.content ?? []).some((c) => hasTable(c as never));

/**
 * The heights of the document's table rows from the editor's own page layout (EXP-039; owner
 * decision 114), for a document that has a table. The worker has no canvas, so the layout runs over
 * the layout package's advance table, a synthetic serif: its heights are an estimate, not those of
 * the font the compile uses. The layout is loaded only when a table is there.
 */
export async function measureTablesOf(envelope: CdmEnvelope): Promise<TableMeasure | null> {
  if (!hasTable(envelope.doc as never)) return null;
  try {
    const [{ measureTables }, { advanceTableMeasurer }, { firstFitBreaker }] = await Promise.all([
      import('../../../packages/layout/src/table-measure.ts'),
      import('../../../packages/layout/src/measure.ts'),
      import('../../../packages/layout/src/lines.ts'),
    ]);
    return measureTables(envelope as never, {
      measurer: advanceTableMeasurer(),
      breaks: { opportunities: spaces },
      lineBreaker: firstFitBreaker,
    });
  } catch {
    return null;
  }
}

/** Break opportunities after a space, which is all the estimate needs. */
function spaces(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i + 1 < text.length; i++)
    if (text[i] === ' ' && text[i + 1] !== ' ') out.push(i + 1);
  return out;
}

/** The files that go into the sandbox: everything the converter wrote. */
export function compileFiles(bundle: Bundle): Record<string, string> {
  return { ...bundle.files };
}
