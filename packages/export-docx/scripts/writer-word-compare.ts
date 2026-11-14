/**
 * Compares what Word shows (scripts/writer-word-inspect.ps1) with the model (EXP-090 criteria 2
 * and 3): the list labels Word computes against `computeLabels`, and the size, weight and slant
 * of each paragraph's first character against `resolveRun`, for the feature documents of
 * test/writer-docs.ts written by scripts/writer-word-check.ts. Prints every difference; exit code
 * 1 when there is one.
 *
 * Run from the repository root: node packages/export-docx/scripts/writer-word-compare.ts <inspection.json>
 */
import { readFileSync } from 'node:fs';
import {
  computeLabels,
  resolveParagraph,
  resolveRun,
  styleTable,
  type JsonNode,
  type TreeNode,
} from '@docedit/model';
import { writerDocs } from '../test/writer-docs.ts';

interface WordParagraph {
  text: string;
  list: string;
  style: string;
  font: string;
  size: number;
  bold: boolean;
  italic: boolean;
}
interface WordFile {
  file: string;
  paragraphs: WordParagraph[];
}

const path = process.argv[2];
if (!path) throw new Error('usage: writer-word-compare.ts <inspection.json>');
const inspection = JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, '')) as {
  word: string;
  files: WordFile[];
};
const differences: string[] = [];
let compared = 0;
for (const d of await writerDocs()) {
  const file = inspection.files.find((f) => f.file === `features\\${d.name}.docx`);
  if (!file) continue;
  const doc = d.envelope.doc as unknown as TreeNode;
  const table = styleTable(doc);
  const labels = computeLabels(doc);
  const body = d.envelope.doc.content!.find((n) => n.type === 'body')!;
  // Model paragraphs in document order, through tables.
  const paragraphs: JsonNode[] = [];
  const walk = (n: JsonNode): void => {
    if (n.type === 'paragraph') paragraphs.push(n);
    else if (n.type !== 'footnote') for (const c of n.content ?? []) walk(c);
  };
  walk(body);
  const modelLabels = paragraphs
    .map((p) => labels.lists.get(String(p.attrs?.['id']))?.text)
    .filter((x): x is string => !!x);
  const wordLabels = file.paragraphs.map((p) => p.list).filter((x) => !!x);
  if (modelLabels.length) {
    compared += modelLabels.length;
    if (JSON.stringify(modelLabels) !== JSON.stringify(wordLabels))
      differences.push(
        `${d.name}: labels ${JSON.stringify(wordLabels)} in Word, ${JSON.stringify(modelLabels)} in the model`,
      );
  }
  for (const p of paragraphs) {
    const first = (p.content ?? []).find((c) => c.type === 'text' && c.text);
    if (!first) continue;
    const w = file.paragraphs.find((x) =>
      x.text.replace(/\t/g, '').startsWith(first.text!.slice(0, 20)),
    );
    if (!w) continue;
    const rp = resolveParagraph(table, p.attrs as Record<string, unknown> | undefined);
    if (!rp.ok) continue;
    const run = resolveRun(table, rp.value, first.marks);
    if (!run.ok) continue;
    compared++;
    const want = { size: run.value.fontSize / 20, bold: run.value.bold, italic: run.value.italic };
    const got = { size: w.size, bold: w.bold, italic: w.italic };
    if (JSON.stringify(want) !== JSON.stringify(got))
      differences.push(
        `${d.name} "${first.text!.slice(0, 30)}": Word ${JSON.stringify(got)}, model ${JSON.stringify(want)}`,
      );
    if (run.value.fontFamily && w.font !== run.value.fontFamily)
      differences.push(
        `${d.name} "${first.text!.slice(0, 30)}": Word font ${w.font}, model ${run.value.fontFamily}`,
      );
  }
}
console.log(
  `Word ${inspection.word}: ${compared} labels and paragraphs compared, ${differences.length} differences`,
);
for (const x of differences) console.log(`  ${x}`);
process.exit(differences.length ? 1 : 0);
