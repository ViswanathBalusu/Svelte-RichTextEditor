/**
 * One export end to end (spike S4): convert, compile in the sandbox (or locally, for comparison),
 * build and validate layout.json. Validation with veraPDF is a separate step (verapdf.ts).
 */
import type { Bundle, FontManifest } from '@docedit/export-latex';
import type { CdmEnvelope } from '@docedit/model';
import { buildBundle, type BuildOptions } from './bundle-io.ts';
import { buildLayout, parseRawLayout, validateLayout, type LayoutJson } from './layout.ts';
import { compileLocally, type LocalOptions } from './local.ts';
import { compileInSandbox, type CompileResult, type SandboxOptions } from './sandbox.ts';

export interface ExportResult {
  bundle: Bundle;
  compile: CompileResult;
  layout: LayoutJson | null;
  layoutErrors: string[];
  convertMs: number;
}

export type Where =
  { kind: 'sandbox'; options?: SandboxOptions } | { kind: 'local'; options: LocalOptions };

export async function runExport(
  envelope: CdmEnvelope,
  fonts: FontManifest,
  convertOptions: Omit<BuildOptions, 'fonts'>,
  where: Where,
): Promise<ExportResult> {
  const t0 = performance.now();
  const bundle = await buildBundle(envelope, { ...convertOptions, fonts });
  const convertMs = performance.now() - t0;
  const files = { ...bundle.files, ...(bundle.assets ?? {}) };
  const compile =
    where.kind === 'sandbox'
      ? await compileInSandbox(files, where.options)
      : await compileLocally(files, where.options);
  let layout: LayoutJson | null = null;
  let layoutErrors: string[] = [];
  if (compile.layoutRaw) {
    try {
      const raw = parseRawLayout(compile.layoutRaw);
      layout = buildLayout(raw, bundle.map, {
        seq: bundle.manifest.seq,
        classVersion: bundle.manifest.classVersion,
        setup: bundle.map.setups?.length === 1 ? bundle.map.setups[0]! : null,
      });
      layoutErrors = validateLayout(layout);
      if (layoutErrors.length > 0) layout = null;
    } catch (e) {
      layoutErrors = [String(e)];
    }
  } else if (compile.ok && convertOptions.layout !== 'off') layoutErrors = ['no layout data'];
  return { bundle, compile, layout, layoutErrors, convertMs };
}
