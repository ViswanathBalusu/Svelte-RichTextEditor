/**
 * EXP-122 criterion 1, the Word half: Microsoft Word reads the sources part and the citation
 * fields the writers produce, and can update the fields from the sources. The tests drive Word
 * through COM (`tools/word-citations/read-citations.ps1`) and skip where Word is not installed.
 *
 * What is checked: Word opens the package without the repair option; its `Bibliography.Sources`
 * list is the document's sources; every `CITATION` field updates to a text built from the source
 * (a field whose source Word does not know would read "Invalid source specified."). The updated
 * text is Word's, in its own default style, so only the author or the year is looked for.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonEnvelope, type JsonNode } from '@docedit/model';
import { AssetStore, exportDocx, importDocx } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { wordAvailable } from './exp-115-word.ts';

const SCRIPT = fileURLToPath(
  new URL('../tools/word-citations/read-citations.ps1', import.meta.url),
);
const DIR = fileURLToPath(new URL(`../test-results/exp-122-${process.pid}/`, import.meta.url));
const run = promisify(execFile);

interface WordRead {
  word: string;
  sourceCount: number;
  sources: string[] | string;
  fields:
    | Array<{ code: string; before: string; after: string }>
    | { code: string; before: string; after: string };
}

async function readInWord(name: string, bytes: Uint8Array): Promise<WordRead> {
  mkdirSync(DIR, { recursive: true });
  const file = `${DIR}${name}.docx`;
  const out = `${DIR}${name}.json`;
  writeFileSync(file, bytes);
  await run(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-File', file, '-Out', out],
    { timeout: 240_000, windowsHide: true },
  );
  return JSON.parse(readFileSync(out, 'utf8').replace(/^\uFEFF/, '')) as WordRead;
}
/** PowerShell writes a one-element array as the element itself. */
const list = <T>(v: T[] | T): T[] => (Array.isArray(v) ? v : [v]);

function documentWithCitations(): JsonEnvelope {
  const env = newDocument();
  const defs = env.doc.content!.find((n) => n.type === 'defs')!;
  defs.content!.push(
    {
      type: 'source_def',
      attrs: {
        id: 'Smi20',
        kind: 'book',
        title: 'Notes on Editors',
        authors: [{ family: 'Smith', given: 'Ada' }],
        issued: '2020',
        publisher: 'Example Press',
        publisherPlace: 'London',
      },
    },
    {
      type: 'source_def',
      attrs: {
        id: 'Lee19',
        kind: 'article-journal',
        title: 'Fields in Word Documents',
        authors: [{ family: 'Lee', given: 'Sam' }],
        issued: '2019',
        containerTitle: 'Journal of Examples',
        volume: '4',
        pages: '10-20',
      },
    },
  );
  const body = env.doc.content!.find((n) => n.type === 'body')!;
  const t = (text: string): JsonNode => ({ type: 'text', text });
  body.content = [
    {
      type: 'paragraph',
      attrs: { id: 'p1' },
      content: [
        t('One '),
        { type: 'citation', attrs: { items: [{ source: 'Smi20' }], mode: 'normal', cached: 'x' } },
        t(', two '),
        {
          type: 'citation',
          attrs: { items: [{ source: 'Lee19' }, { source: 'Smi20' }], mode: 'normal', cached: 'x' },
        },
        t(', three '),
        {
          type: 'citation',
          attrs: { items: [{ source: 'Smi20' }], mode: 'suppressAuthor', cached: 'x' },
        },
      ],
    },
  ] as JsonNode[];
  return env;
}

describe.skipIf(!wordAvailable())('EXP-122 criterion 1 in Microsoft Word', () => {
  it('opens a written document, lists its sources and updates its citation fields', async () => {
    const written = await writeDocx(documentWithCitations(), new AssetStore());
    const read = await readInWord('written', written.bytes);
    expect(read.sourceCount).toBe(2);
    expect(list(read.sources).sort()).toEqual(['Lee19', 'Smi20']);
    const fields = list(read.fields);
    expect(fields.length).toBe(3);
    for (const f of fields) expect(f.after).not.toMatch(/invalid source/i);
    expect(fields[0]!.after).toContain('Smith');
    expect(fields[1]!.after).toContain('Lee');
    expect(fields[1]!.after).toContain('Smith');
    // Without the author, Word prints the year (or the title), not the name.
    expect(fields[2]!.after).not.toContain('Smith');
  }, 300_000);

  it('updates the citations of an imported Word file after its sources were edited', async () => {
    const original = new Uint8Array(
      readFileSync(new URL('../corpus/word/citations.docx', import.meta.url)),
    );
    const imported = await importDocx(original);
    const env = structuredClone(imported.envelope);
    const smithId = Object.entries(imported.sourceMap.defs).find(
      ([, d]) => d.wordId === 'Smi20',
    )![0];
    const smith = (function find(n: JsonNode): JsonNode | undefined {
      if (n.type === 'source_def' && n.attrs?.['id'] === smithId) return n;
      for (const c of n.content ?? []) {
        const hit = find(c);
        if (hit) return hit;
      }
      return undefined;
    })(env.doc as unknown as JsonNode)!;
    smith.attrs!['authors'] = [{ family: 'Smythe', given: 'Ada' }];
    const out = await exportDocx(env, original, imported.sourceMap, imported.assets);
    const read = await readInWord('patched', out.bytes);
    expect(list(read.sources).sort()).toEqual(['Lee19', 'Smi20']);
    const fields = list(read.fields);
    expect(fields.length).toBe(3);
    // Word rebuilt the first citation from the edited source.
    expect(fields[0]!.after).toContain('Smythe');
    for (const f of fields) expect(f.after).not.toMatch(/invalid source/i);
  }, 300_000);
});
