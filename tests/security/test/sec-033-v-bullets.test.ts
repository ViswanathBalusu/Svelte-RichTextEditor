/**
 * SEC-033 criterion 2, bullet characters (lane V-SEC-033-048): a bullet label is a user string that
 * reaches TeX only through the published table (`BULLETS` in packages/export-latex/src/blocks.ts,
 * through `enumOf`). Each hostile value written as a bullet character must either match the table or
 * fall back to the default bullet with an `enum_unknown` warning, and must never appear in main.tex.
 *
 * The converter is the real one: `run` from packages/export-latex/test/docs.ts builds the bundle and
 * the test reads main.tex. Node.js only (vitest, fast-check). Nothing compiles, so this is the
 * token-level half of the check, as in sec-033-contexts.test.ts.
 */
import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import {
  blockLines,
  codes,
  doc,
  para,
  run,
  type J,
} from '../../../packages/export-latex/test/docs.ts';

const RUNS = Number(process.env['FUZZ_RUNS'] ?? 60);
const MAIN = 'main.tex';

/** The published bullet characters (blocks.ts, BULLETS). Kept here as a literal copy for the check. */
const PUBLISHED = new Set([
  '•',
  '◦',
  '▪',
  '■',
  '□',
  '●',
  '○',
  '–',
  '—',
  '➢',
  '✓',
  '♦',
  '◆',
  '*',
  '-',
]);

const idOf = (p: J): string => (p['attrs'] as J)['id'] as string;

const numbering = (id: string, levels: J[]): J => ({
  type: 'numbering_def',
  attrs: { id, levels },
});

function bulleted(content: string, bulletChar: string): { p: J; d: ReturnType<typeof doc> } {
  const p = para(content, { numbering: { numberingId: 'bul', level: 0, listId: 'L' } });
  const d = doc([p], {
    numberings: [numbering('bul', [{ format: 'bullet', text: '', start: 1, bulletChar }])],
  });
  return { p, d };
}

/** Hostile seeds named in SEC-033 criterion 1, written as bullet characters. */
const SEEDS = [
  '\\write18{rm -rf /}',
  '\\directlua{os.execute("id")}',
  '\\input{/etc/passwd}',
  '^^5cwrite18',
  '}\\def\\x{',
  '%comment\n\\section{x}',
  '\n[bracket after a line break',
  '\u202eevil\u202c',
  '\u0000\u0007\u007f\u009b',
  '\\\\ \\& \\$ \\# \\_ \\% \\^ \\~',
  '$$ \\DEstr{41} ) ] ]]',
  'a'.repeat(200),
];

const hostile = fc.oneof(
  fc.constantFrom(...SEEDS),
  fc.string({ maxLength: 40 }),
  fc.string({ unit: 'binary', maxLength: 20 }),
);

/** The bullet line of main.tex, if any, is the `\DEli` line; the label is its third argument. */
function labelIn(lines: string[]): string {
  const line = lines.find((l) => l.includes('\\DEli{'));
  if (line === undefined) throw new Error('the block is not a list item');
  return line;
}

describe('SEC-033 criterion 2: bullet characters with hostile values', () => {
  it('prints each published bullet character from the table', async () => {
    for (const ch of PUBLISHED) {
      const { p, d } = bulleted('item', ch);
      const bundle = await run(d);
      const line = labelIn(blockLines(bundle, idOf(p)));
      expect(line).toContain(`{${ch}}`);
      expect(codes(bundle)).not.toContain('enum_unknown');
    }
  });

  it('never writes an unpublished bullet value and falls back to the default with a warning', async () => {
    await fc.assert(
      fc.asyncProperty(hostile, async (value) => {
        fc.pre(value !== '' && !PUBLISHED.has(value));
        const { p, d } = bulleted('item', value);
        const bundle = await run(d);
        const main = bundle.files[MAIN]!;
        const line = labelIn(blockLines(bundle, idOf(p)));
        expect(line).toContain('{•}');
        expect(codes(bundle)).toContain('enum_unknown');
        expect(line).not.toContain('\\write18');
        expect(line).not.toContain('\\directlua');
        expect(line).not.toContain('\\input');
        if (value.length >= 8) expect(main).not.toContain(value);
      }),
      { numRuns: RUNS },
    );
  }, 120_000);

  it('does not let a seed reach main.tex in any form', async () => {
    for (const seed of SEEDS) {
      if (PUBLISHED.has(seed)) continue;
      const { p, d } = bulleted('item', seed);
      const bundle = await run(d);
      const main = bundle.files[MAIN]!;
      expect(codes(bundle)).toContain('enum_unknown');
      expect(main).not.toContain('rm -rf');
      expect(main).not.toContain('os.execute');
      expect(main).not.toContain('/etc/passwd');
      expect(blockLines(bundle, idOf(p)).join('\n')).not.toContain('\u202e');
    }
  });
});
