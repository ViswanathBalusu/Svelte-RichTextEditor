/**
 * A tagged LuaLaTeX PDF to seal (spike S8). It is the export worker's demonstration document,
 * converted with the house class and compiled with the local `lualatex` (the same route as the
 * LaTeX tests of the converter, packages/export-latex/test/cdm-local-tex.ts), so the PDF is the
 * kind the export pipeline makes: tagged, PDF 2.0, PDF/UA-2. It needs the local font directory
 * (services/export-worker/out/fonts-local, generated, not committed) and returns null without it.
 */
import {
  compileLocal,
  convertLocal,
  lualatexAvailable,
} from '../../../../packages/export-latex/test/cdm-local-tex.ts';
import { demoDocument } from '../../../export-worker/test/documents.ts';

export function taggedSampleAvailable(): boolean {
  return lualatexAvailable();
}

export async function taggedSample(): Promise<Uint8Array> {
  const bundle = await convertLocal(demoDocument().envelope, {});
  const c = compileLocal(bundle, 'spk-021');
  if (!c.ok || !c.pdf) throw new Error(`the sample did not compile:\n${c.log.slice(-2000)}`);
  return c.pdf;
}
