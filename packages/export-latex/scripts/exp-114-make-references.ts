/**
 * EXP-114 (lane U-EXP-113-123): writes the stored reference PDFs under `test/references/` and their
 * manifest. Each reference is the output of the converter's bundle compiled in the export worker's
 * sandbox (LuaLaTeX in Podman), with the options recorded in the manifest. The test
 * `src/exp-114-references.compile.test.ts` checks every file against its SHA-256 and validates it
 * with veraPDF.
 *
 * Run with: node packages/export-latex/scripts/exp-114-make-references.ts [file names]
 * With file names only those references are made and the manifest is merged.
 * A change to a reference is a change to the converter's output: it must be reviewed with the
 * differences shown (EXP-114 criterion 4): this script prints them (text positions and pixels,
 * old file against new) before it overwrites a file, and the reviewer reads them with the change.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { compareWithReference } from '../../../services/export-worker/src/exp-114-reference-compare.ts';
import { sandboxReady } from '../test/harness.ts';
import {
  compileReference,
  INSTANT,
  refDir,
  references,
  type Reference,
} from '../test/references.ts';

async function main(): Promise<void> {
  const r = await sandboxReady();
  if (!r.ok) throw new Error(`sandboxed compiles cannot run here: ${r.reason}`);
  mkdirSync(refDir, { recursive: true });
  const manifest: Array<Omit<Reference, 'input'> & { sha256: string }> = [];
  const only = process.argv.slice(2);
  for (const ref of references) {
    if (only.length && !only.includes(ref.file)) continue;
    const c = await compileReference(ref);
    if (!c.compile.ok || !c.compile.pdf)
      throw new Error(`the compile of ${ref.file} failed:\n${c.compile.log.slice(-1500)}`);
    // A changed reference is shown with its differences (criterion 4): the old file against the new.
    if (existsSync(refDir + ref.file)) {
      const old = new Uint8Array(readFileSync(refDir + ref.file));
      const cmp = await compareWithReference(ref.file, c.compile.pdf, old);
      console.log(
        cmp.differs ? cmp.report : `${ref.file}: no difference from the stored reference`,
      );
    }
    writeFileSync(refDir + ref.file, c.compile.pdf);
    const sha256 = createHash('sha256').update(c.compile.pdf).digest('hex');
    manifest.push({
      file: ref.file,
      source: ref.source,
      title: ref.title,
      options: ref.options,
      flavours: ref.flavours,
      ...(ref.corpus ? { corpus: ref.corpus } : {}),
      ...(ref.without ? { without: ref.without } : {}),
      ...(ref.note ? { note: ref.note } : {}),
      sha256,
    });
    console.log(`${ref.file} ${c.compile.pdf.length} bytes ${sha256}`);
  }
  // With names on the command line only those references are made, and the manifest is merged.
  const old = only.length
    ? (
        JSON.parse(readFileSync(refDir + 'manifest.json', 'utf8')) as {
          references: typeof manifest;
        }
      ).references
    : [];
  const merged = [...old.filter((o) => !manifest.some((m) => m.file === o.file)), ...manifest];
  merged.sort((a, b) => a.file.localeCompare(b.file));
  writeFileSync(
    refDir + 'manifest.json',
    JSON.stringify({ instant: INSTANT, references: merged }, null, 2) + '\n',
  );
}

await main();
