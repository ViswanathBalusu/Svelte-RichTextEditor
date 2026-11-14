/**
 * The corpus files are written in Prettier's layout, so `pnpm lint` accepts them unchanged
 * (FND-006). This compares the corpus printer with Prettier, run with the repository's settings.
 */
import { fileURLToPath } from 'node:url';
import * as prettier from 'prettier';
import { describe, expect, it } from 'vitest';
import { formatJson, generateCorpus } from '../src/generate/index.ts';

const path = fileURLToPath(new URL('../out/sample.json', import.meta.url));

async function prettierJson(text: string): Promise<string> {
  const options = (await prettier.resolveConfig(path)) ?? {};
  return prettier.format(text, { ...options, filepath: path });
}

describe('the JSON layout of the corpus files', () => {
  it('equals Prettier for the files kept in the repository', async () => {
    const corpus = await generateCorpus();
    const small = new Set([
      'manifest.json',
      'pages-1.cdm.json',
      'form-fields.cdm.json',
      'pages-20.cdm.json',
    ]);
    for (const f of corpus.files.filter((x) => small.has(x.path))) {
      const text = new TextDecoder().decode(f.bytes);
      expect(await prettierJson(text), f.path).toBe(text);
    }
  });

  it('equals Prettier for the shapes the printer supports', async () => {
    const samples: unknown[] = [
      { grid: Array.from({ length: 40 }, (_, i) => 1000 + i * 7) },
      { short: [1, 2, 3], names: ['a', 'b'], empty: [], none: {} },
      { long: Array.from({ length: 12 }, (_, i) => `entry number ${i}`) },
      { mixed: [{ field: 'x' }, true, 3, null, 'text'] },
      { nested: [{ a: [1, 2], b: [{ c: 'd' }] }, { e: { f: { g: 'h' } } }] },
      // `  "exactFit": ["…"],` ends exactly at column 100; `  "overflow": ["…"]` at 101.
      { exactFit: ['x'.repeat(81)], overflow: ['x'.repeat(83)] },
      { wide: ['§ 1', 'x'.repeat(120)], cjk: '中文、日本語、한국어', negative: -360 },
    ];
    for (const s of samples) {
      const text = formatJson(s);
      expect(await prettierJson(text), JSON.stringify(s)).toBe(text);
    }
  });

  it('refuses what it cannot lay out exactly', () => {
    expect(() => formatJson({ v: 1.5 })).toThrow(/integers/);
    expect(() => formatJson({ v: [[1], [2]] })).toThrow(/not supported/);
    expect(() => formatJson({ v: ['é'] })).toThrow(/non-ASCII/);
  });
});
