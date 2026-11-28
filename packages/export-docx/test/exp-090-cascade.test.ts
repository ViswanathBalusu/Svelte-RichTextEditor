/**
 * EXP-090 criterion 2: the formatting Word resolves for a written package equals the model's
 * cascade (03 §6). Each package is written by the direct writer; Word opens it and reports the
 * effective character formatting of every paragraph (tools/word-cascade/read-word-formatting.ps1,
 * Word COM). The model resolves each character with resolveParagraph and resolveRun. The test
 * compares character by character: font, size, bold, italic, underline, strike, small caps,
 * all caps and colour. Paragraphs are matched by their text, in order.
 *
 * Covered: the writer's `text-styles` document, and every corpus file written as a projection
 * (the importer's envelope, suggestions accepted). Hidden runs are skipped, because Word's
 * character collection leaves them out in the view the reader uses; the writer's tests check the
 * `w:vanish` mark. Needs Microsoft Word on Windows; on other platforms the tests are skipped.
 */
import { execFile } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';
import {
  resolveParagraph,
  resolveRun,
  styleTable,
  type JsonNode,
  type TreeNode,
} from '@docedit/model';
import { importDocx } from '../src/index.ts';
import { writeDocx, type WriteOptions } from '../src/writer.ts';
import { corpusFiles, readFile } from './corpus.ts';
import { writerDocs } from './writer-docs.ts';

// A folder of this run's own: a Word instance that another run left holding a file of an earlier
// run (EBUSY on the write) cannot stop this one.
const WORK_DIR = fileURLToPath(
  new URL(`../test-results/exp-090-cascade-${process.pid}/`, import.meta.url),
);
const SCRIPT = fileURLToPath(
  new URL('../tools/word-cascade/read-word-formatting.ps1', import.meta.url),
);
const run = promisify(execFile);
/**
 * How many corpus files Word reads at the same time. Each reading starts its own Word and quits
 * it, so the readings do not share state. One at a time, the corpus is the longest test file of
 * the suite by a wide margin.
 */
const WORD_AT_ONCE = 4;
/** The face of the font registry's default, stated to the writer; Word reads it from the defaults. */
const DEFAULT_FONT = 'Carlito';

interface CharProps {
  fontName: string;
  fontSize: number;
  bold: boolean;
  italic: boolean;
  underline: boolean;
  strike: boolean;
  smallCaps: boolean;
  allCaps: boolean;
  colorHex: string | null;
}

interface Char {
  ch: string;
  props: CharProps;
}

interface WordRun {
  text: string;
  font: CharProps;
}

const isControl = (ch: string): boolean => ch.charCodeAt(0) < 32;
const text = (chars: Char[]): string => chars.map((c) => c.ch).join('');

/** The model's characters of each paragraph of the body (table cells are not compared). */
function modelParagraphs(doc: JsonNode, table: ReturnType<typeof styleTable>): Char[][] {
  const out: Char[][] = [];
  const walk = (n: JsonNode): void => {
    if (n.type === 'table') return;
    if (n.type === 'paragraph') {
      const p = resolveParagraph(table, n.attrs);
      if (!p.ok) return;
      const chars: Char[] = [];
      for (const c of n.content ?? []) {
        if (c.type !== 'text' || !c.text) continue;
        if ((c.marks ?? []).some((m) => m.type === 'del')) continue;
        const r = resolveRun(table, p.value, c.marks);
        if (!r.ok || r.value.hidden) continue;
        const props: CharProps = {
          fontName: r.value.fontFamily ?? DEFAULT_FONT,
          fontSize: r.value.fontSize / 20,
          bold: r.value.bold,
          italic: r.value.italic,
          underline: r.value.underline !== 'none',
          strike: r.value.strike,
          smallCaps: r.value.smallCaps,
          allCaps: r.value.allCaps,
          colorHex: r.value.color ? r.value.color.replace('#', '').toUpperCase() : null,
        };
        for (const ch of Array.from(c.text)) chars.push({ ch, props });
      }
      if (chars.length > 0) out.push(chars);
      return;
    }
    for (const c of n.content ?? []) walk(c);
  };
  walk(doc);
  return out;
}

/** Word's effective formatting of each paragraph's characters, read with Word COM. */
async function wordParagraphs(docx: string, name: string): Promise<Char[][]> {
  const out = `${WORK_DIR}${name}.word.json`;
  await run(
    'powershell.exe',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', SCRIPT, '-Docx', docx, '-Out', out],
    { timeout: 900_000, windowsHide: true },
  );
  const raw = readFileSync(out, 'utf8').replace(/^\uFEFF/, '');
  const parsed = JSON.parse(raw) as { runs: WordRun[] }[];
  return parsed.map((p) => {
    const chars: Char[] = [];
    for (const r of p.runs) {
      for (const ch of Array.from(r.text)) if (!isControl(ch)) chars.push({ ch, props: r.font });
    }
    return chars;
  });
}

type Envelope = Parameters<typeof writeDocx>[0];
type Assets = Parameters<typeof writeDocx>[1];

interface Comparison {
  paragraphs: number;
  matched: number;
  unmatched: string[];
  chars: number;
  mismatches: string[];
}

/** Writes the envelope, reads it in Word, and compares each matched character with the model. */
async function compare(
  name: string,
  written: { envelope: Envelope; assets: Assets; options: WriteOptions },
): Promise<Comparison> {
  const out = await writeDocx(written.envelope, written.assets, written.options);
  const docx = `${WORK_DIR}${name}.docx`;
  writeFileSync(docx, out.bytes);
  const table = styleTable(written.envelope.doc as unknown as TreeNode);
  const expected = modelParagraphs(written.envelope.doc as unknown as JsonNode, table);
  const word = await wordParagraphs(docx, name);
  let cursor = 0;
  const result: Comparison = {
    paragraphs: expected.length,
    matched: 0,
    unmatched: [],
    chars: 0,
    mismatches: [],
  };
  for (const m of expected) {
    const want = text(m);
    const idx = word.findIndex((w, i) => i >= cursor && text(w) === want);
    if (idx < 0) {
      result.unmatched.push(JSON.stringify(want.slice(0, 60)));
      continue;
    }
    cursor = idx + 1;
    result.matched += 1;
    const got = word[idx]!;
    for (let i = 0; i < m.length; i++) {
      result.chars += 1;
      const a = m[i]!.props;
      const b = got[i]!.props;
      if (JSON.stringify(a) !== JSON.stringify(b) && result.mismatches.length < 40) {
        result.mismatches.push(
          `${name} ${JSON.stringify(m[i]!.ch)} in ${JSON.stringify(want.slice(0, 30))}: model ${JSON.stringify(a)} word ${JSON.stringify(b)}`,
        );
      }
    }
  }
  return result;
}

const hasWord = process.platform === 'win32';

describe.skipIf(!hasWord)(
  'EXP-090 criterion 2: Word resolves the cascade of 03 §6 for the written package',
  () => {
    it('text-styles: every matched character has the formatting the model resolves', async () => {
      mkdirSync(WORK_DIR, { recursive: true });
      const docs = await writerDocs();
      const d = docs.find((x) => x.name === 'text-styles');
      expect(d).toBeDefined();
      const r = await compare('text-styles', {
        envelope: d!.envelope,
        assets: d!.assets,
        options: { defaultFont: DEFAULT_FONT },
      });
      expect(r.unmatched).toEqual([]);
      expect(r.matched).toBeGreaterThanOrEqual(4);
      expect(r.chars).toBeGreaterThan(100);
      expect(r.mismatches).toEqual([]);
    }, 600_000);

    it('corpus: every corpus file written as a projection has the formatting the model resolves', async () => {
      mkdirSync(WORK_DIR, { recursive: true });
      const summary: string[] = [];
      const mismatches: string[] = [];
      let chars = 0;
      let files = 0;
      const all = corpusFiles();
      const results: Comparison[] = [];
      let next = 0;
      const worker = async (): Promise<void> => {
        for (let i = next++; i < all.length; i = next++) {
          const f = all[i]!;
          const safe = f.name.replace(/[^A-Za-z0-9]+/g, '-');
          const imported = await importDocx(readFile(f));
          results[i] = await compare(`corpus-${safe}`, {
            envelope: imported.envelope,
            assets: imported.assets,
            options: { suggestions: 'accept', defaultFont: DEFAULT_FONT },
          });
        }
      };
      await Promise.all(Array.from({ length: WORD_AT_ONCE }, worker));
      for (const [i, f] of all.entries()) {
        const r = results[i]!;
        chars += r.chars;
        files += 1;
        mismatches.push(...r.mismatches);
        summary.push(
          `${f.name}: paragraphs ${r.paragraphs}, matched ${r.matched}, unmatched ${r.unmatched.length}, characters ${r.chars}, mismatches ${r.mismatches.length}`,
        );
      }
      // The summary is in the test output so the coverage of the run is visible.
      writeFileSync(`${WORK_DIR}corpus-summary.txt`, summary.join('\n'));
      expect(files).toBeGreaterThan(0);
      expect(chars).toBeGreaterThan(1000);
      expect(mismatches).toEqual([]);
    }, 3_600_000);
  },
);
