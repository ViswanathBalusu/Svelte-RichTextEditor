// FE-062 criterion 4: for a document family and the same family in an export, the file the editor
// chooses is the file the LaTeX worker loads, because both read one manifest. One `fonts.json` in the
// converter's shape is written to a font directory. The editor's side reads it as the document service
// serves it (`loadFontCatalogue`, the body of `GET /fonts`) through the element's production lookup
// (`resolveFamily`). The worker's side is the converter (`@docedit/export-latex`) run on a document
// whose text is in that family: the file named for the family in `styles.tex` (`\DEdeffamily`) is the
// file the worker loads. The font files are small made-up byte strings named by their SHA-256, not
// real fonts: the test is about which file is chosen, not about the glyphs. Node.js only.
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  loadFontCatalogue,
  type FontCatalogue,
} from '../../../services/document-service/src/control-plane/fonts.ts';
import { blockLines, doc, para, run } from '../../export-latex/test/docs.ts';
import type { FontManifest } from '../../export-latex/src/index.ts';
import { resolveFamily } from '../src/font-family-lookup.ts';

const sha = (b: Buffer): string => createHash('sha256').update(b).digest('hex');
const files = new Map<string, Buffer>();

function face(tag: string): { file: string; sha256: string } {
  const bytes = Buffer.from(`fe-062 ${tag}`);
  const hash = sha(bytes);
  files.set(`${hash}.ttf`, bytes);
  return { file: `${hash}.ttf`, sha256: hash };
}

function family(name: string) {
  return {
    name,
    lineHeight: 1362,
    regular: face(`${name} regular`),
    bold: face(`${name} bold`),
    italic: face(`${name} italic`),
    boldItalic: face(`${name} boldItalic`),
    licence: 'OFL-1.1',
  };
}

const MATH = { name: 'STIX Two Math', ...face('math'), licence: 'OFL-1.1' };
const SUBSTITUTES = [
  { family: 'Calibri', replacement: 'Carlito' },
  { family: 'Arial', replacement: 'Liberation Sans' },
  // A line whose replacement the manifest does not hold is ignored on both sides.
  { family: 'Segoe UI', replacement: 'Open Sans' },
];
const MANIFEST: FontManifest = {
  version: 1,
  families: [
    family('Noto Serif'),
    family('Noto Sans'),
    family('Carlito'),
    family('Liberation Sans'),
  ],
  math: MATH,
  defaultFamily: 'Noto Serif',
  substitutes: SUBSTITUTES,
};

let dir = '';
let catalogue: FontCatalogue;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), 'docedit-fe062-'));
  for (const [name, bytes] of files) await writeFile(join(dir, name), bytes);
  await writeFile(join(dir, 'fonts.json'), JSON.stringify(MANIFEST));
  catalogue = await loadFontCatalogue(dir, 'https://docs.example.test/fonts');
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

/** The file of the regular face that the editor draws `name` with, as a hash. */
const editorFile = (name: string): string | undefined =>
  resolveFamily(catalogue.manifest, name)?.face.hash;

/** The regular-face file the worker loads for text in `name`: the family of its `\DEfont`. */
async function workerFile(name: string): Promise<{ hash: string; missing: boolean }> {
  const p = para('', {}, [
    { type: 'text', text: 'Text.', marks: [{ type: 'fontFamily', attrs: { value: name } }] },
  ]);
  const bundle = await run(doc([p]), { fonts: MANIFEST });
  const id = (p['attrs'] as Record<string, string>)['id']!;
  const n = /\\DEfont\{(\d+)\}/.exec(blockLines(bundle, id).join('\n'))?.[1];
  if (n === undefined) throw new Error('the paragraph sets no family');
  const def = new RegExp(String.raw`\\DEdeffamily\{${n}\}\{\d+\}\{([0-9a-f]{64})\.ttf\}`).exec(
    bundle.files['styles.tex']!,
  );
  if (!def) throw new Error(`no \\DEdeffamily for family ${n}`);
  return {
    hash: def[1]!,
    missing: bundle.diagnostics.some((d) => d.code === 'font_family_missing'),
  };
}

describe('FE-062 criterion 4: the editor and the LaTeX worker choose the same file', () => {
  it('serves the substitute lines of the font set, and only those with a published replacement', () => {
    expect(catalogue.manifest.substitutes).toEqual([
      { family: 'Calibri', replacement: 'Carlito' },
      { family: 'Arial', replacement: 'Liberation Sans' },
    ]);
  });

  it.each(['Noto Serif', 'Noto Sans', 'Carlito', 'Liberation Sans'])(
    'a family of the manifest (%s) is the same file in both',
    async (name) => {
      const worker = await workerFile(name);
      expect(worker.missing).toBe(false);
      expect(editorFile(name)).toBe(worker.hash);
      expect(editorFile(name)).toBe(
        (MANIFEST.families.find((f) => f.name === name) as { regular: { sha256: string } }).regular
          .sha256,
      );
    },
  );

  it.each([
    ['Calibri', 'Carlito'],
    ['calibri', 'Carlito'],
    ['  Arial ', 'Liberation Sans'],
  ])(
    'a family the manifest maps to an open one (%s) is the open family’s file in both',
    async (name, open) => {
      const worker = await workerFile(name);
      expect(worker.missing).toBe(false);
      expect(editorFile(name)).toBe(worker.hash);
      expect(worker.hash).toBe(
        (MANIFEST.families.find((f) => f.name === open) as { regular: { sha256: string } }).regular
          .sha256,
      );
    },
  );

  it.each(['Aptos', 'Segoe UI'])(
    'a family with no open substitute (%s) is the default family’s file in both',
    async (name) => {
      const worker = await workerFile(name);
      expect(worker.missing).toBe(true);
      expect(editorFile(name)).toBe(worker.hash);
      expect(worker.hash).toBe(MANIFEST.families[0]!.regular.sha256);
    },
  );
});
