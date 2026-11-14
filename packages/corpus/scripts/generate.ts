/**
 * Writes the corpus to packages/corpus/out (FND-006): every document as `<name>.cdm.json`, the
 * images under `assets/`, `manifest.json`, and `.gitignore` for the documents that are generated
 * on demand. Run with `pnpm --filter @docedit/corpus generate`.
 *
 * The generator is deterministic: the same source gives the same bytes. When the output changes,
 * the corpus needs a new version (src/generate/version.ts); this script says so and exits with 1.
 */
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { CURRENT, generateCorpus } from '../src/generate/index.ts';

const out = join(dirname(fileURLToPath(import.meta.url)), '..', 'out');

const started = performance.now();
const corpus = await generateCorpus();
const generated = performance.now();

for (const file of corpus.files) {
  await mkdir(dirname(join(out, file.path)), { recursive: true });
  await writeFile(join(out, file.path), file.bytes);
}

const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
console.log(`Corpus version ${corpus.manifest.version}, fingerprint ${corpus.fingerprint}`);
for (const d of corpus.manifest.documents) {
  const size =
    d.fileBytes >= 1e6
      ? `${(d.fileBytes / 1e6).toFixed(1)} MB`
      : `${Math.round(d.fileBytes / 1e3)} kB`;
  console.log(
    `  ${d.name.padEnd(12)} ${String(d.pages.estimated).padStart(5)} pages (estimated)  ${size.padStart(8)}  ${d.nodes} nodes  ${d.characters} characters${d.inRepository ? '' : '  (not in git)'}`,
  );
}
console.log(
  `Generated in ${seconds(generated - started)}, written in ${seconds(performance.now() - generated)}.`,
);

if (corpus.fingerprint !== CURRENT.fingerprint) {
  console.error(
    `\nThe corpus output changed: version ${CURRENT.version} has fingerprint ${CURRENT.fingerprint}.\n` +
      `Add a new version to CORPUS_HISTORY in packages/corpus/src/generate/version.ts:\n` +
      `  { version: ${CURRENT.version + 1}, date: '<today>', fingerprint: '${corpus.fingerprint}', change: '<what changed>' }\n` +
      `then run the generator again. (For the first version, put the fingerprint into its entry instead.)`,
  );
  process.exitCode = 1;
}
