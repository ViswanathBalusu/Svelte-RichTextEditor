/**
 * EXP-116, third criterion: identity-bound values (paragraph and text identifiers, revision-session
 * identifiers) are recorded only in the source map, never in the document. Every identity value
 * the source map holds for a corpus file, in a node, a definition or a preserved tree (EXP-116,
 * `identityTree`), is searched for in the imported document's JSON.
 */
import { describe, expect, it } from 'vitest';
import { importDocx } from '../src/index.ts';
import type { IdentityEntry } from '../src/tree.ts';
import { corpusFiles, readFile } from './corpus.ts';

const MIN_LENGTH = 6;

/**
 * Known leaks, kept as a list so that a new one fails the test and a fixed one is removed here.
 * cr043-tracked.docx had two revision-session values in the preserved tree of a paragraph's pPr
 * (its own w:sectPr); they are taken out at import and restored on write (fixed 2026-11-13).
 */
const KNOWN_LEAKS: Record<string, string[]> = {};

const identityValues = (entries: readonly IdentityEntry[] | undefined): string[] =>
  (entries ?? []).flatMap((e) => Object.values(e.attrs));

describe.each(corpusFiles())('$name', (file) => {
  it('keeps identity-bound values out of the document, except the known leaks', async () => {
    const imported = await importDocx(readFile(file));
    const json = JSON.stringify(imported.envelope);
    const values: string[] = [];
    for (const node of Object.values(imported.sourceMap.nodes)) {
      values.push(...Object.values(node.identity ?? {}), ...identityValues(node.identityTree));
    }
    for (const def of Object.values(imported.sourceMap.defs)) {
      values.push(...Object.values(def.identity ?? {}), ...identityValues(def.identityTree));
    }
    const leaked = values.filter((value) => value.length >= MIN_LENGTH && json.includes(value));
    expect([...new Set(leaked)].sort()).toEqual([...(KNOWN_LEAKS[file.name] ?? [])].sort());
  });
});
