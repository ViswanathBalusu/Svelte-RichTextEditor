/**
 * EXP-100 criterion 3, for real: the labels the editor computes for an imported file equal those
 * Word displays for the same file. `tools/word-layout/word-list-strings.ps1` lets Word open every
 * file of the corpus read-only and write the label of each list paragraph (`ListFormat.ListString`)
 * and its list type; each file is imported by `importDocx`, and `computeLabels` (the editor's
 * algorithm, the shared one of the model) gives the label of each paragraph of the imported body.
 * Numbered paragraphs are compared by label, in document order; bullets are compared by count and
 * position, because Word's `ListString` of a bullet is a glyph of a symbol font, which the model
 * writes as a character of its own (03 §4.5).
 *
 * Needs Microsoft Word on Windows; skipped without it. A file Word cannot open is named in
 * `WORD_REFUSES`, and a file where the two differ for a known reason is named in `DIFFERS`, so
 * that a new difference turns the run red.
 */
import { execFile, spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import { computeLabels, styleTable, type JsonNode, type TreeNode } from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { CORPUS_DIR, OUT_DIR, corpusFiles, readFile } from './corpus.ts';

const SCRIPT = fileURLToPath(
  new URL('../tools/word-layout/word-list-strings.ps1', import.meta.url),
);

function wordInstalled(): boolean {
  if (process.platform !== 'win32') return false;
  const r = spawnSync(
    'powershell.exe',
    [
      '-NoProfile',
      '-Command',
      "if (Test-Path 'Registry::HKEY_CLASSES_ROOT\\Word.Application') { exit 0 } else { exit 1 }",
    ],
    { windowsHide: true },
  );
  return r.status === 0;
}

/** Files that Word does not open: the reason, from Word's message. */
const WORD_REFUSES: Record<string, string> = {
  'poi/deep-table-cell.docx':
    'Word reports the file as corrupted (a fixture of a parser bug about deep nesting)',
};

type Label = { text: string; kind: string };

/** Whether `a` is `b` with some entries left out, in order. */
const isSubsequence = (a: readonly Label[], b: readonly Label[]): boolean => {
  let k = 0;
  for (const x of b) if (k < a.length && a[k]!.text === x.text && a[k]!.kind === x.kind) k++;
  return k === a.length;
};

/**
 * Files where the editor's labels and Word's differ, each with the reason and a check that the
 * difference is that reason and no other.
 */
const DIFFERS: Record<string, { reason: string; ok: (mine: Label[], theirs: Label[]) => boolean }> =
  {
    'poi/60316.docx': {
      reason:
        'the numbered paragraphs are in a text box, which the model keeps as a preserved block (03 §4.6); it holds no numbering',
      ok: (mine, theirs) => mine.length === 0 && theirs.every((t) => t.kind === 'bullet'),
    },
    'poi/delins.docx': {
      reason:
        'paragraphs whose tracked change the model cannot express (a paragraph mark inserted or deleted) are kept as preserved blocks, which hold no numbering (EXP-093)',
      ok: (mine, theirs) => mine.length < theirs.length && isSubsequence(mine, theirs),
    },
    'docx4j/review-for-word-word2010.docx': {
      reason:
        'paragraphs whose tracked change the model cannot express are kept as preserved blocks, which hold no numbering (EXP-093)',
      ok: (mine, theirs) => mine.length < theirs.length && isSubsequence(mine, theirs),
    },
    // poi/Numbering.docx ("NEW-1-FORMAT" and the Greek sequence) was listed here until owner decision
    // 240 (2026-11-26) widened the grammar of the level text and added the format `lowerGreek`.
  };

interface WordItem {
  label: string;
  type: number;
  text: string;
}

const run = promisify(execFile);

describe.skipIf(!wordInstalled())(
  'imported numbering shows the labels Word shows (EXP-100)',
  () => {
    it(
      'equals the labels of Word for every corpus file that has a list',
      { timeout: 600_000 },
      async () => {
        mkdirSync(OUT_DIR, { recursive: true });
        const out = join(OUT_DIR, 'exp-100-word-list-strings.json');
        await run(
          'powershell.exe',
          [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            SCRIPT,
            '-Dir',
            CORPUS_DIR,
            '-Out',
            out,
          ],
          { windowsHide: true, maxBuffer: 16 * 1024 * 1024 },
        );
        const raw = readFileSync(out, 'utf8');
        const word = JSON.parse(raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw) as Record<
          string,
          { items?: WordItem[] | WordItem; error?: string }
        >;
        const files = new Map(corpusFiles().map((f) => [f.name, f]));
        const compared: string[] = [];
        const differences: string[] = [];
        const refused: string[] = [];
        const differing: string[] = [];
        let numbered = 0;
        for (const [name, entry] of Object.entries(word)) {
          const file = files.get(name);
          expect(file, `${name} is a corpus file`).toBeDefined();
          if (entry.error !== undefined) {
            if (WORD_REFUSES[name] === undefined) refused.push(`${name}: Word said ${entry.error}`);
            continue;
          }
          const items = entry.items === undefined ? [] : [entry.items].flat();
          if (items.length === 0) continue;
          const imported = await importDocx(readFile(file!));
          const labels = computeLabels(imported.envelope.doc as unknown as TreeNode, {
            table: styleTable(imported.envelope.doc as unknown as TreeNode),
          });
          const body = (imported.envelope.doc.content ?? []).find((n) => n.type === 'body')!;
          const mine: Label[] = [];
          const walk = (n: JsonNode): void => {
            if (n.type === 'paragraph') {
              const l = labels.lists.get(String(n.attrs?.['id']));
              if (l && l.kind !== 'none') mine.push({ text: l.text, kind: l.kind });
            }
            for (const c of n.content ?? []) walk(c);
          };
          walk(body);
          // Word's label of a bullet is a glyph of a symbol font (a private-use character), or the
          // list type says bullet. A list level with no label at all (format none) shows nothing, as the
          // editor's `none` kind does.
          const theirs = items
            .filter((i) => i.label !== '' || i.type === 2 || i.type === 6)
            .map((i) => ({
              text: i.label,
              kind: i.type === 2 || i.type === 6 || /^[-]+$/u.test(i.label) ? 'bullet' : 'number',
            }));
          const norm = (l: Label[]): string =>
            l.map((x) => (x.kind === 'bullet' ? '•' : x.text)).join(' | ');
          numbered += theirs.filter((t) => t.kind === 'number').length;
          compared.push(name);
          if (norm(mine) !== norm(theirs)) {
            differences.push(`${name}\n  editor: ${norm(mine)}\n  Word:   ${norm(theirs)}`);
            continue;
          }
          expect(DIFFERS[name], `${name} is listed as different but is equal`).toBeUndefined();
        }
        const unexpected = differences.filter((d) => DIFFERS[d.split('\n')[0]!] === undefined);
        console.log(
          `EXP-100 labels: ${compared.length} corpus files have lists in Word, ${numbered} numbered paragraphs compared, ${differing.length} files differ for a known reason`,
        );
        expect(unexpected, unexpected.join('\n')).toEqual([]);
        expect(compared.length).toBeGreaterThan(5);
      },
    );
  },
);
