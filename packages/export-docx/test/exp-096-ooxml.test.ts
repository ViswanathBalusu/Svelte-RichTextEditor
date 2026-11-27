/**
 * EXP-096: a package with every kind of Office math the converter writes validates against the Open
 * XML schemas (the same validator as EXP-090 criterion 7, `tools/ooxml-validate`; needs the .NET
 * SDK and the NuGet package restored on first run).
 */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { newDocument, type JsonNode } from '@docedit/model';
import { AssetStore } from '../src/index.ts';
import { writeDocx } from '../src/writer.ts';
import { ALLOWED } from './math-corpus.ts';

const TOOL_DIR = fileURLToPath(new URL('../tools/ooxml-validate/', import.meta.url));
const WORK_DIR = fileURLToPath(new URL('../test-results/exp-096-ooxml/', import.meta.url));

describe('EXP-096: the Office math the writer produces validates against the OOXML schemas', () => {
  it('validates a package with every equation of the corpus, inline and display', async () => {
    rmSync(WORK_DIR, { recursive: true, force: true });
    mkdirSync(WORK_DIR, { recursive: true });
    const env = newDocument();
    const body = env.doc.content!.find((n) => n.type === 'body')!;
    const blocks: JsonNode[] = [];
    ALLOWED.forEach((latex, i) => {
      blocks.push({
        type: 'equation_block',
        attrs: { id: `eAAAAAAAAAAAA${String(i).padStart(3, '0')}`, latex },
      });
      blocks.push({
        type: 'paragraph',
        attrs: { id: `pAAAAAAAAAAAA${String(i).padStart(3, '0')}` },
        content: [
          { type: 'text', text: 'Inline ' },
          { type: 'equation', attrs: { latex } },
        ],
      });
    });
    body.content = blocks;
    const out = await writeDocx(env, new AssetStore());
    expect(out.warnings.filter((w) => w.includes('equation'))).toEqual([]);
    const file = `${WORK_DIR}math.docx`;
    const result = `${WORK_DIR}result.json`;
    writeFileSync(file, out.bytes);
    execFileSync(
      'dotnet',
      [
        'run',
        '--project',
        `${TOOL_DIR}OoxmlValidate.csproj`,
        '-v',
        'q',
        '--',
        '--out',
        result,
        file,
      ],
      { stdio: ['ignore', 'pipe', 'pipe'], timeout: 540_000 },
    );
    const rows = JSON.parse(readFileSync(result, 'utf8')) as Array<{
      opened: boolean;
      exception?: string;
      errors: Array<{ part: string | null; path: string | null; description: string }>;
    }>;
    expect(rows.length).toBe(1);
    expect(rows[0]!.opened, rows[0]!.exception).toBe(true);
    expect(rows[0]!.errors.map((e) => `${e.part} ${e.path} ${e.description}`)).toEqual([]);
  }, 600_000);
});
