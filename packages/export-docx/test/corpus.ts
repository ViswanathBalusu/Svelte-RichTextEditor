/** The S11 corpus (corpus/SOURCES.md): every .docx under corpus/<source>/. */
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_DIR = fileURLToPath(new URL('../corpus/', import.meta.url));
/** Generated output (measurements, files for the Word check); ignored by Git, Prettier and ESLint. */
export const OUT_DIR = fileURLToPath(new URL('../test-results/', import.meta.url));

export interface CorpusFile {
  /** `source/file.docx`. */
  name: string;
  source: string;
  path: string;
}

export function corpusFiles(): CorpusFile[] {
  const out: CorpusFile[] = [];
  for (const source of readdirSync(CORPUS_DIR).sort()) {
    const dir = join(CORPUS_DIR, source);
    if (!statSync(dir).isDirectory()) continue;
    for (const f of readdirSync(dir).sort())
      if (f.endsWith('.docx')) out.push({ name: `${source}/${f}`, source, path: join(dir, f) });
  }
  return out;
}

export const readFile = (f: CorpusFile): Uint8Array => new Uint8Array(readFileSync(f.path));
