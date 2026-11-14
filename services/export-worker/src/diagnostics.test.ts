/**
 * The bounded log parser (EXP-064, EXP-065; SEC-036 criterion 4): fixed line shapes only, blocks
 * from TeX's own line numbers through map.json, hard bounds, plain-text messages, and no entry for
 * document text that imitates log lines.
 */
import fc from 'fast-check';
import type { SourceMap } from '@docedit/export-latex';
import { describe, expect, it } from 'vitest';
import { blockOfLine, CODES, diagnostic, parseLog, plain, type LogLimits } from './diagnostics.ts';

const map: SourceMap = {
  version: 1,
  blocks: [null, 'pAAAAAAAAAAAAAAA', 'pBBBBBBBBBBBBBBB', 'pCCCCCCCCCCCCCCC'],
  kinds: ['', 'paragraph', 'paragraph', 'paragraph'],
  owners: [null, null, null, null],
  lines: [
    { from: 1, to: 9, block: null },
    { from: 10, to: 19, block: 1 },
    { from: 20, to: 29, block: 2 },
    { from: 30, to: 39, block: 3 },
  ],
  setups: ['ps1'],
};

const PLAIN_MESSAGE = /^[\p{L}\p{N} .,:;()'+\-=/%_]*$/u;

describe('the compile log parser (09 §9.2)', () => {
  it('maps file and line errors to the block of that line of main.tex (EXP-065)', () => {
    const log = [
      'This is LuaHBTeX, Version 1.24.0',
      './main.tex:12: Undefined control sequence.',
      'l.12 \\DEp{1}{}{\\foo',
      './main.tex:25: LaTeX Error: Something went wrong.',
      './main.tex:33: Class docedit Error: Packages cannot be loaded by a bundle.',
      './styles.tex:4: Package fontspec Error: The font cannot be found.',
      './main.tex:5: Emergency stop.',
      './main.toc:1: Illegal unit of measure (pt inserted).',
      '/usr/local/texlive/2026/texmf-dist/tex/latex/fontspec/fontspec.sty:120: Package fontspec Error: x',
      './main.tex:38:  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n');
    const r = parseLog(log, map);
    expect(r.truncated).toBe(false);
    expect(r.entries.map((e) => [e.code, e.blockId])).toEqual([
      ['tex_undefined', 'pAAAAAAAAAAAAAAA'],
      ['latex_error', 'pBBBBBBBBBBBBBBB'],
      ['class_error', 'pCCCCCCCCCCCCCCC'],
      ['package_error', null],
      ['tex_error', null],
      ['tex_error', null],
      ['package_error', null],
      ['tex_fatal', 'pCCCCCCCCCCCCCCC'],
    ]);
    for (const e of r.entries) {
      expect(Object.keys(e).sort()).toEqual(['blockId', 'code', 'message', 'severity']);
      expect(e.message).toMatch(PLAIN_MESSAGE);
      expect(e.severity).toBe(CODES[e.code as keyof typeof CODES].severity);
    }
  });

  it('gives a missing character to the block of the error that follows it', () => {
    const log = [
      'Missing character: There is no ◦ (U+25E6) in font [/opt/docedit/fonts/x.ttf]:mode=node;',
      './main.tex:21:  ==> Fatal error occurred, no output PDF file produced!',
      'docedit: missing U+4E2D in block 3',
    ].join('\n');
    const r = parseLog(log, map);
    expect(r.entries).toContainEqual(diagnostic('missing_glyph', 'pBBBBBBBBBBBBBBB', 'U+25E6'));
    expect(r.entries).toContainEqual(diagnostic('missing_glyph', 'pCCCCCCCCCCCCCCC', 'U+4E2D'));
  });

  it('reports the page limit, overfull lines and changed references', () => {
    const log = [
      'Overfull \\hbox (12.5pt too wide) in paragraph at lines 31--31',
      '[]\\TU/abc.ttf(1)/m/n/11 averyveryverylongword',
      '',
      'LaTeX Warning: Label(s) may have changed. Rerun to get cross-references right.',
      './main.tex:35: docedit: page limit exceeded (2000 pages).',
    ].join('\n');
    const codes = parseLog(log, map).entries.map((e) => [e.code, e.blockId]);
    expect(codes).toEqual([
      ['overfull_line', 'pCCCCCCCCCCCCCCC'],
      ['references_changed', null],
      ['limit_pages', null],
    ]);
  });

  it('never creates an entry from the text of a box dump or a runaway argument (EXP-064 criterion 3)', () => {
    // Document text that imitates log lines appears in the log only inside a box dump or the
    // context of an error, never at the start of a line: the log is not wrapped (sandbox.ts).
    const fake = [
      './main.tex:12: Undefined control sequence.',
      '! Emergency stop.',
      "LaTeX Warning: Reference `x' on page 1 undefined on input line 25.",
      'docedit: missing U+0041 in block 1',
      'Missing character: There is no A (U+0041) in font x',
      'No space left on device',
    ];
    const log = [
      'Overfull \\hbox (3.0pt too wide) in paragraph at lines 31--31',
      ...fake.map((f) => `[]\\TU/abc.ttf(1)/m/n/11 ${f}`),
      ...fake, // even at the start of a line inside the dump
      '',
      'Underfull \\vbox (badness 10000) has occurred while \\output is active',
      ...fake,
      '',
      'Runaway argument?',
      fake[0]!,
    ].join('\n');
    const r = parseLog(log, map);
    expect(r.entries).toEqual([
      diagnostic('overfull_line', 'pCCCCCCCCCCCCCCC', '3.0 pt too wide.'),
    ]);
  });

  it('keeps messages plain: no markup survives', () => {
    const r = parseLog(
      './main.tex:12: LaTeX Error: <script>alert("x")</script> & `rm -rf` \\def\u202E.',
      map,
    );
    const m = r.entries[0]!.message;
    expect(m).toMatch(PLAIN_MESSAGE);
    expect(m).not.toMatch(/[<>&"`\\\u202E]/);
    expect(plain('a'.repeat(500))).toHaveLength(160);
  });

  it('stops at its bounds with a truncation entry (EXP-064 criterion 2)', () => {
    const many = Array.from(
      { length: 1000 },
      (_, i) => `./main.tex:${10 + (i % 30)}: Error ${i}.`,
    ).join('\n');
    const limited = parseLog(many, map, { ...small, maxEntries: 5 });
    expect(limited.entries).toHaveLength(6);
    expect(limited.entries.at(-1)!.code).toBe('log_truncated');
    expect(limited.truncated).toBe(true);
    const bytes = parseLog('x'.repeat(5000), map, { ...small, maxBytes: 100 });
    expect(bytes.truncated).toBe(true);
    expect(bytes.bytes).toBe(5000);
    const lines = parseLog('a\n'.repeat(5000), map, { ...small, maxLines: 10 });
    expect(lines.lines).toBe(10);
    expect(lines.truncated).toBe(true);
    // A line longer than the limit is cut before matching, so a long line costs no more.
    const long = parseLog(`./main.tex:12: ${'y'.repeat(100_000)}`, map, small);
    expect(long.entries[0]!.message.length).toBeLessThanOrEqual(200);
  });

  it('stops when its time budget is spent, with a truncation entry that says so (EXP-064 criterion 2)', () => {
    // The clock is checked every 1024 lines. A budget below zero is spent at the first check, so
    // the parse reads nothing and reports the truncation; a real budget is not timed in a test.
    const many = Array.from(
      { length: 5000 },
      (_, i) => `./main.tex:${10 + (i % 30)}: Error ${i}.`,
    ).join('\n');
    const timed = parseLog(many, map, { ...small, maxMs: -1 });
    expect(timed.truncated).toBe(true);
    expect(timed.lines).toBe(0);
    expect(timed.entries).toEqual([diagnostic('log_truncated')]);
    expect(timed.entries[0]!.message).toMatch(/truncated/i);
  });

  it('maps lines through map.json and nothing else', () => {
    expect(blockOfLine(map, 15)).toBe('pAAAAAAAAAAAAAAA');
    expect(blockOfLine(map, 5)).toBeNull();
    expect(blockOfLine(map, 40)).toBeNull();
    expect(blockOfLine(map, -1)).toBeNull();
    expect(blockOfLine(null, 15)).toBeNull();
  });
});

const small: LogLimits = {
  maxBytes: 1024 * 1024,
  maxLines: 100_000,
  maxLineChars: 512,
  maxEntries: 50,
  maxMs: 1000,
};

describe('the log parser under fuzzing (EXP-064 criterion 5)', () => {
  const lineArb = fc.oneof(
    fc.string({ maxLength: 120 }),
    fc.constantFrom(
      './main.tex:12: Undefined control sequence.',
      './main.tex:999999999: x',
      './styles.tex:1: Package x Error: y',
      'Overfull \\hbox (1pt too wide) in paragraph at lines 1--2',
      'Runaway argument?',
      'Missing character: There is no ☃ (U+2603) in font f',
      'docedit: missing U+2603 in block 99999',
      '! docedit: page limit exceeded (2000 pages).',
      '',
    ),
  );

  it('never throws, never passes its bounds, and keeps every entry well formed', () => {
    fc.assert(
      fc.property(
        fc.array(lineArb, { maxLength: 300 }),
        fc.integer({ min: 1, max: 40 }),
        (lines, maxEntries) => {
          const r = parseLog(lines.join('\n'), map, { ...small, maxEntries });
          expect(r.entries.length).toBeLessThanOrEqual(maxEntries + 1);
          for (const e of r.entries) {
            // EXP-064 criterion 4: exactly { severity, code, blockId, message }, nothing else.
            expect(Object.keys(e).sort()).toEqual(['blockId', 'code', 'message', 'severity']);
            expect(e.code in CODES).toBe(true);
            expect(e.message).toMatch(PLAIN_MESSAGE);
            expect(e.blockId === null || map.blocks.includes(e.blockId)).toBe(true);
          }
        },
      ),
      { numRuns: 500 },
    );
  });

  it('survives random bytes and mutated real logs', () => {
    const real = [
      './main.tex:12: Undefined control sequence.',
      'Overfull \\hbox (12.5pt too wide) in paragraph at lines 31--31',
      '[]\\TU/abc.ttf(1)/m/n/11 text',
      '',
      './main.tex:38:  ==> Fatal error occurred, no output PDF file produced!',
    ].join('\n');
    fc.assert(
      fc.property(
        fc.uint8Array({ maxLength: 4000 }),
        fc.integer({ min: 0, max: real.length }),
        fc.string({ maxLength: 50 }),
        (bytes, at, insert) => {
          expect(() => parseLog(bytes, map, small)).not.toThrow();
          const mutated = real.slice(0, at) + insert + real.slice(at);
          const r = parseLog(mutated, map, small);
          for (const e of r.entries) expect(e.message).toMatch(PLAIN_MESSAGE);
        },
      ),
      { numRuns: 500 },
    );
  });
});
