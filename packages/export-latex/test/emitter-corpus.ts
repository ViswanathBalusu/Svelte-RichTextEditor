/**
 * The corpus of failing emitter inputs (EXP-046 criterion 5; Node.js only). When a fuzz property
 * of a string emitter fails, the shrunk counterexample is written here as a fixture before the
 * failure is reported, so a failure is never lost with the log that showed it. Every stored fixture
 * is replayed on each run by `src/emit.corpus.test.ts`.
 *
 * - The folder is `test/emitter-corpus/` in this package (ADR 0143, item 3, a proposal: the shared
 *   `corpus` package holds documents, not strings).
 * - A fixture is `{ "emitter": <name>, "input": <string> }`, one JSON file per input, named by the
 *   first 16 hex digits of the SHA-256 of the emitter and the input.
 */
import fc from 'fast-check';
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const CORPUS_EMITTERS = ['text', 'pdfString', 'kvValue', 'url'] as const;
export type CorpusEmitter = (typeof CORPUS_EMITTERS)[number];

export interface CorpusFixture {
  emitter: CorpusEmitter;
  input: string;
}

export const CORPUS_DIR = fileURLToPath(new URL('./emitter-corpus/', import.meta.url));

/** Writes one fixture; the name is derived from the emitter and the input, so a repeat adds no file. */
export function storeFixture(dir: string, fixture: CorpusFixture): string {
  const digest = createHash('sha256')
    .update(`${fixture.emitter}\0${fixture.input}`, 'utf8')
    .digest('hex');
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `${fixture.emitter}-${digest.slice(0, 16)}.json`);
  writeFileSync(path, `${JSON.stringify(fixture, null, 2)}\n`, 'utf8');
  return path;
}

/**
 * Runs a property like `fc.assert`. When it fails, the shrunk counterexample is stored as a fixture
 * of `emitter` (`inputOf` takes the string out of the property's arguments), and the error names the
 * file.
 */
export function assertStoring<T extends unknown[]>(
  emitter: CorpusEmitter,
  property: fc.IProperty<T>,
  params: fc.Parameters<T>,
  inputOf: (args: T) => string,
  dir: string = CORPUS_DIR,
): void {
  const r = fc.check(property, params);
  if (!r.failed) return;
  const stored = r.counterexample
    ? storeFixture(dir, { emitter, input: inputOf(r.counterexample) })
    : null;
  throw new Error(
    `${fc.defaultReportMessage(r)}\nStored as an emitter-corpus fixture: ${stored ?? 'nothing (no counterexample)'}`,
  );
}
