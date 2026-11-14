/**
 * EXP-011 criterion 2 (Node.js only): `main.tex` is machine-generated, is written as one block per
 * group of lines, and holds no user-authored TeX outside math. Documents come from `test/docs.ts`.
 */
import { describe, expect, it } from 'vitest';
import { doc, nid, para, run } from '../test/docs.ts';

const PROBE = '\\input{secret} 50% #1 & ~ ^^41 {x} $y$ \\write18{ls}';

describe('EXP-011 criterion 2: main.tex is generated, block by block', () => {
  it('starts main.tex with a generated macro, not with user text', async () => {
    const bundle = await run(doc([para('Plain text.')]));
    const first = bundle.files['main.tex']!.split('\n')[0]!;
    expect(first).toMatch(/^\\setrandomseed \d+\\relax$/);
  });

  it('writes the lines of each block as one contiguous range of map.json', async () => {
    const ids = [nid('p'), nid('p'), nid('p')];
    const bundle = await run(
      doc([
        para('First paragraph.', { id: ids[0] }),
        para('Second paragraph, which is longer than the first.', { id: ids[1] }),
        para('Third.', { id: ids[2] }),
      ]),
    );
    for (const id of ids) {
      const n = bundle.map.blocks.indexOf(id);
      expect(n).toBeGreaterThanOrEqual(0);
      const ranges = bundle.map.lines.filter((r) => r.block === n);
      expect(ranges.length, `ranges of ${id}`).toBe(1);
      const r = ranges[0]!;
      expect(r.to).toBeGreaterThanOrEqual(r.from);
    }
  });

  it('keeps every line of the body that no block owns to generated structure', async () => {
    const bundle = await run(doc([para('Body one.'), para('Body two.')]));
    const lines = bundle.files['main.tex']!.split('\n');
    const begin = lines.indexOf('\\begin{document}');
    expect(begin).toBeGreaterThan(0);
    const owned = new Set<number>();
    for (const r of bundle.map.lines)
      if (r.block !== null) for (let l = r.from; l <= r.to; l++) owned.add(l);
    for (let i = begin + 1; i <= lines.length; i++) {
      if (owned.has(i)) continue;
      const text = lines[i - 1]!;
      // A line with no block is a generated structure line: a macro, the end of the document, or blank.
      expect(text, `line ${i}`).toMatch(
        /^(\\DE[A-Za-z]+|\\end\{document\}|\s*|\\par|\\begin\{[A-Za-z*]+\}|\\end\{[A-Za-z*]+\}|\\[A-Za-z]+.*)$/,
      );
    }
  });

  it('writes no user TeX outside math: the probe reaches its block only in escaped form', async () => {
    const id = nid('p');
    const bundle = await run(doc([para(PROBE, { id })]));
    // The converter ends some lines with a generated `%` (a line-end comment). It is removed before
    // the check, so that only the probe's own text is searched.
    const joined = blockLinesOf(bundle, id)
      .map((l) => l.replace(/%$/, ''))
      .join('\n');
    expect(joined).toContain('\\textbackslash{}input\\{secret\\}');
    expect(joined).not.toContain('\\input{secret}');
    expect(joined).not.toContain('\\write18{ls}');
    expect(joined).not.toContain('^^41');
    // A bare percent sign, hash or ampersand would begin a comment, a parameter or a column in TeX.
    expect(joined).not.toMatch(/(^|[^\\])%/);
    expect(joined).not.toMatch(/(^|[^\\])#/);
    expect(joined).not.toMatch(/(^|[^\\])&/);
    // Dollar signs in the probe's own text are escaped, so they cannot open math.
    expect(joined).not.toMatch(/(^|[^\\])\$y\$/);
    expect(joined).toContain('\\$y\\$');
  });
});

/** The lines of main.tex that belong to one block id, through map.json. */
function blockLinesOf(b: Awaited<ReturnType<typeof run>>, id: string): string[] {
  const n = b.map.blocks.indexOf(id);
  const lines = b.files['main.tex']!.split('\n');
  const out: string[] = [];
  for (const r of b.map.lines)
    if (r.block === n) for (let l = r.from; l <= r.to; l++) out.push(lines[l - 1]!);
  return out;
}
