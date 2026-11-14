/**
 * EXP-033 criterion 1, checked on the compiled PDF (Node.js only, sandbox; lane U-EXP-033-048):
 * a `text` form field's value is written into the text at the field's fixed width, and the field
 * is tagged with its label; an empty field is blank space of that same width.
 *
 * The positions come from `pdftotext -bbox`. Each case puts the same words either side of the
 * field, so the distance from the first word to the last one is the field's width (144 pt for
 * 2880 twips) more the width of the words, and the value of a field does not change that distance.
 *
 * The tag is checked in the object text of the compiled PDF: the alternative text of the field's
 * structure element is the label (an ASCII label is written as a literal string or as UTF-16BE hex;
 * both are accepted). The tests skip when `sandboxReady()` reports that sandboxed compiles cannot
 * run here (EXP-070).
 */
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { inflateSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { doc, nid, para, type J } from '../test/docs.ts';
import { convertAndCompile, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-06T10:00:00.000Z';
const FIELD_WIDTH_TWIPS = 2880; // 144 pt
const FIELD_WIDTH_PT = 144;

/** A text `form_field` inline node of the field width, with a label and an optional value. */
function field(key: string, label: string, value: string | null): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind: 'text', label, width: FIELD_WIDTH_TWIPS, value },
  };
}

/** A paragraph of `before`, the field and `after`, with one space between each (none before the field). */
function around(before: string, inline: J, after: string): J {
  return para(before, {}, [inline, { type: 'text', text: ` ${after}` }]);
}

/** The x of a word on the first page, from `pdftotext -bbox`, or null when it is not there. */
function xOf(bbox: string, word: string): number | null {
  const m = new RegExp(`<word xMin="([^"]*)" yMin="[^"]*"[^>]*>${word}</word>`).exec(bbox);
  return m === null ? null : Number(m[1]);
}

/** The PDF as text: the raw file and the inflated contents of every Flate stream. */
function pdfObjectText(pdf: Uint8Array): string {
  const raw = Buffer.from(pdf).toString('latin1');
  const parts = [raw];
  const re = /stream\r?\n/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(raw)) !== null) {
    const start = m.index + m[0].length;
    const end = raw.indexOf('endstream', start);
    if (end < 0) break;
    try {
      parts.push(inflateSync(Buffer.from(raw.slice(start, end), 'latin1')).toString('latin1'));
    } catch {
      // Not a Flate stream; its dictionary is still in the raw text.
    }
  }
  return parts.join('\n');
}

/** The bytes of an ASCII string as a PDF hexadecimal UTF-16BE string (with the byte order mark). */
function utf16beHex(s: string): string {
  let hex = 'FEFF';
  for (const ch of s) hex += ch.charCodeAt(0).toString(16).padStart(4, '0').toUpperCase();
  return hex;
}

const LABEL = 'Customer name label EXP033';

describe.skipIf(!ready)(
  'EXP-033 criterion 1: a text field is flattened at its width and tagged with its label',
  () => {
    it('prints the value and an empty field at the same width, and tags the field with its label', async () => {
      // The baseline paragraph has no field: its two words are separated by one space, and the field
      // paragraphs keep that space after the field, so the only difference is the field's width.
      // All three paragraphs start with the same word, so their words after it start at the same x
      // when the field has the same width whatever its value.
      const body = [
        para('BEFOREFIELD AFTERBASE'),
        around('BEFOREFIELD', field('name', LABEL, null), 'AFTEREMPTY'),
        around('BEFOREFIELD', field('name2', 'Second label EXP033', 'ADAVALUE'), 'AFTERVALUE'),
      ];
      const c = await convertAndCompile(doc(body), {
        profile: 'final',
        title: 'exp-033-field-value',
        instant: INSTANT,
        timeZone: 'Europe/London',
        suggestions: 'accept',
        fields: 'flatten',
      } as never);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);

      const dir = mkdtempSync(join(tmpdir(), 'docedit-field-'));
      const file = join(dir, 'main.pdf');
      writeFileSync(file, c.compile.pdf);
      const r = spawnSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', timeout: 60_000 });
      if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
      const bbox = r.stdout;
      const x = (w: string): number => {
        const v = xOf(bbox, w);
        if (v === null) throw new Error(`the PDF does not show ${w}`);
        return v;
      };
      // The word BEFOREFIELD is in each of the three paragraphs, in reading order: the first is the
      // baseline's, the second the empty field's and the third the value field's.
      // A field with no space before it glues its value to the word before it (pdftotext reads
      // `BEFOREFIELDADAVALUE` as one word), so the match is on the word's start, not its whole text.
      const before = [
        ...bbox.matchAll(/<word xMin="([^"]*)" yMin="[^"]*"[^>]*>BEFOREFIELD[^<]*<\/word>/g),
      ].map((m) => Number(m[1]));
      expect(
        before.length,
        `three paragraphs start with BEFOREFIELD; the words: ${[...bbox.matchAll(/>([^<]*)<\/word>/g)].map((m) => m[1]).join(' ')}`,
      ).toBe(3);

      // The value is printed.
      expect(bbox).toContain('ADAVALUE');

      // The distance from the start of the paragraph to the word after the field: the baseline has no
      // field, so the empty field adds exactly its width to that distance.
      const baseGap = x('AFTERBASE') - before[0]!;
      const emptyGap = x('AFTEREMPTY') - before[1]!;
      const eps = 0.5;
      const info = JSON.stringify({ baseGap, emptyGap });
      // An empty field is blank space of its width, so the word after it moves by that width.
      expect(Math.abs(emptyGap - baseGap - FIELD_WIDTH_PT), info).toBeLessThan(eps);
      // A value of a fixed-width field does not change the width: the word after it starts at the
      // same x as after the empty field.
      expect(Math.abs(x('AFTERVALUE') - x('AFTEREMPTY')), info).toBeLessThan(eps);

      // The tag: the field's structure element carries the label as its alternative text.
      const objects = pdfObjectText(c.compile.pdf);
      const hasLabel = objects.includes(LABEL) || objects.toUpperCase().includes(utf16beHex(LABEL));
      expect(hasLabel, 'the label is the alternative text of the field').toBe(true);
    }, 600_000);
  },
);
