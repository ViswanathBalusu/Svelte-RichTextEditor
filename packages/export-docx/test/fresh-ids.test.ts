/**
 * EXP-109, criteria 1 and 2 over the S11 corpus. Every imported document passes validate(), run here
 * on an import made with the import's own check off, so that the test does not only repeat that
 * check. Whether the check runs before the snapshot commit is EXP-098's (not built). And the
 * identifiers the import gives to nodes are fresh: unique within the document and not taken from
 * the file (a second import of the same file gets different identifiers). The clause about reusing
 * the identifiers of a removed region applies to an import into an existing document (EXP-098) and
 * is not tested here.
 */
import { describe, expect, it } from 'vitest';
import { validate } from '@docedit/model/validate';
import type { JsonNode } from '@docedit/model';
import { BUILT_IN_STYLES } from '@docedit/model/definition';
import { importDocx } from '../src/index.ts';
import { corpusFiles, readFile } from './corpus.ts';

const files = corpusFiles();

function idsInDocument(doc: JsonNode): string[] {
  const out: string[] = [];
  const stack: JsonNode[] = [doc];
  while (stack.length) {
    const n = stack.pop()!;
    const id = n.attrs?.['id'];
    if (typeof id === 'string') out.push(id);
    for (const c of n.content ?? []) stack.push(c);
  }
  return out;
}

describe.each(files)('$name', (file) => {
  it('is valid for the model, checked here apart from the import’s own check', async () => {
    // The import's check is turned off, so this test does not lean on it.
    const unchecked = await importDocx(readFile(file), { validate: false });
    expect(
      validate(unchecked.envelope, { attachedAssets: unchecked.assets.ids() }).violations,
    ).toEqual([]);
  });

  it('gives unique identifiers to the nodes of the document', async () => {
    const imported = await importDocx(readFile(file));
    const ids = idsInDocument(imported.envelope.doc as JsonNode);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('does not take identifiers from the file: a second import gets different ones', async () => {
    const bytes = readFile(file);
    const a = idsInDocument((await importDocx(bytes)).envelope.doc as JsonNode);
    const b = new Set(idsInDocument((await importDocx(bytes)).envelope.doc as JsonNode));
    const shared = a.filter((id) => b.has(id));
    // Built-in styles keep the reserved identifiers of the model (Heading1, Normal and so on); those are
    // the same on every import by design. Any other identifier shared by two imports would be taken from the file.
    expect(shared.filter((id) => !(id in BUILT_IN_STYLES))).toEqual([]);
  });
});
