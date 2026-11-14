/**
 * EXP-033 criterion 1 for every kind the criterion names (Node.js only, Podman sandbox; lane
 * U-EXP-033-048, round 6): a `text`, `number`, `date`, `choice` or `checkbox` field is written into
 * the text at its fixed width, an empty one is blank space of that same width, and the field is
 * tagged with its label (the alternative text in the object text of the compiled PDF).
 *
 * The companion test `exp-033-field-value.compile.test.ts` covers the `text` kind alone. This file
 * compiles all five kinds in one document. Each kind has three paragraphs: a baseline with no field,
 * an empty field and a field with a value. The field sits directly after its word with no space
 * before it, as in the text-kind test, so a value glues to that word; the words are matched on their
 * start. The checkbox is compiled with the preview profile, because its glyphs are not in the image's
 * fonts (a final export would fail the glyph check); the width is the same whatever the glyph.
 *
 * The positions come from `pdftotext -bbox`. The tests skip when `sandboxReady()` reports that
 * sandboxed compiles cannot run here (EXP-070).
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
const EPS = 0.5;

/**
 * The x of every word that starts with `start`, in reading order. The three paragraphs of a kind
 * share one prefix word, so their prefix is the same width and only the field differs; the value
 * that glues to the prefix (`TXTADAVALUE`) is matched on the prefix's start.
 */
function xsStarting(bbox: string, start: string): number[] {
  return [
    ...bbox.matchAll(
      new RegExp(`<word xMin="([^"]*)" yMin="[^"]*"[^>]*>${start}[^<]*</word>`, 'g'),
    ),
  ].map((m) => Number(m[1]));
}

/** The x of a word whose whole text is `word`, or null. */
function xWord(bbox: string, word: string): number | null {
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

/** A form field inline node: the fixed width, the label and the kind's attributes. */
function field(key: string, kind: string, label: string, value: unknown, attrs: J = {}): J {
  return {
    type: 'form_field',
    attrs: { id: nid('ff'), key, kind, label, width: FIELD_WIDTH_TWIPS, value, ...attrs },
  };
}

/** Text, then the field, then a space and the word after it (no space before the field). */
function around(before: string, inline: J, after: string): J {
  return para(before, {}, [inline, { type: 'text', text: ` ${after}` }]);
}

interface Kind {
  /** Three letters, unique per kind: the prefix of its paragraph words is `${k}B`, `${k}E`, `${k}V`. */
  k: string;
  kind: string;
  label: string;
  value: unknown;
  attrs: J;
  /** The field's printed text for the value case, when it is not the stored value. */
  printed: string;
}

const KINDS: Kind[] = [
  {
    k: 'TXT',
    kind: 'text',
    label: 'Label text EXP033',
    value: 'ADAVALUE',
    attrs: {},
    printed: 'ADAVALUE',
  },
  {
    k: 'NUM',
    kind: 'number',
    label: 'Label number EXP033',
    value: '1234.5',
    attrs: { format: { decimals: 2 } },
    printed: '1234.50',
  },
  {
    k: 'DAT',
    kind: 'date',
    label: 'Label date EXP033',
    value: '2026-03-05',
    attrs: { format: { datePattern: 'dd/MM/yyyy' } },
    printed: '05/03/2026',
  },
  {
    k: 'CHO',
    kind: 'choice',
    label: 'Label choice EXP033',
    value: 'r',
    attrs: {
      options: [
        { id: 'r', label: 'Vermilion Red' },
        { id: 'g', label: 'Green' },
      ],
    },
    printed: 'Vermilion',
  },
  {
    k: 'CHK',
    kind: 'checkbox',
    label: 'Label checkbox EXP033',
    value: true,
    attrs: {},
    printed: '',
  },
];

/** Builds the document: for each kind a baseline, an empty field and a field with a value. */
function documentFor(kinds: Kind[]): J[] {
  const body: J[] = [];
  for (const d of kinds) {
    body.push(para(`${d.k} AFT${d.k}B`));
    body.push(
      around(d.k, field(`${d.k.toLowerCase()}e`, d.kind, d.label, null, d.attrs), `AFT${d.k}E`),
    );
    body.push(
      around(d.k, field(`${d.k.toLowerCase()}v`, d.kind, d.label, d.value, d.attrs), `AFT${d.k}V`),
    );
  }
  return body;
}

const OPTIONS = {
  profile: 'final',
  title: 'exp-033-kinds',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
  fields: 'flatten',
} as never;

describe.skipIf(!ready)(
  'EXP-033 criterion 1: every kind is flattened at its width and tagged with its label',
  () => {
    it('text, number, date and choice: the value and an empty field take the same width, and each is tagged', async () => {
      const kinds = KINDS.filter((d) => d.kind !== 'checkbox');
      const c = await convertAndCompile(doc(documentFor(kinds)), OPTIONS);
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);

      const dir = mkdtempSync(join(tmpdir(), 'docedit-kinds-'));
      const file = join(dir, 'main.pdf');
      writeFileSync(file, c.compile.pdf);
      const r = spawnSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', timeout: 60_000 });
      if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
      const bbox = r.stdout;

      for (const d of kinds) {
        const x = (v: number | null, what: string): number => {
          if (v === null) throw new Error(`the PDF does not show ${what} for ${d.kind}`);
          return v;
        };
        const starts = xsStarting(bbox, d.k);
        if (starts.length !== 3)
          throw new Error(`expected three ${d.kind} paragraphs, found ${starts.length}`);
        const baseAfter = x(xWord(bbox, `AFT${d.k}B`), `AFT${d.k}B`);
        const emptyAfter = x(xWord(bbox, `AFT${d.k}E`), `AFT${d.k}E`);
        const valueAfter = x(xWord(bbox, `AFT${d.k}V`), `AFT${d.k}V`);
        const info = JSON.stringify({ kind: d.kind, starts, baseAfter, emptyAfter, valueAfter });

        // The empty field is blank space of the field's width: the word after it moves by that width.
        expect(Math.abs(emptyAfter - baseAfter - FIELD_WIDTH_PT), info).toBeLessThan(EPS);
        // The value is printed in a field of the same width, so the word after it stays where it is.
        expect(Math.abs(valueAfter - emptyAfter), info).toBeLessThan(EPS);
        // The printed value is in the document.
        expect(bbox, info).toContain(d.printed);
      }

      // The tag: each field's structure element carries its label as alternative text.
      const objects = pdfObjectText(c.compile.pdf);
      for (const d of kinds) {
        const has =
          objects.includes(d.label) || objects.toUpperCase().includes(utf16beHex(d.label));
        expect(has, `the label of ${d.kind} is the alternative text of its field`).toBe(true);
      }
    }, 600_000);

    it('checkbox: an empty and a checked checkbox take the same width (preview profile; the glyph is not checked)', async () => {
      const kinds = KINDS.filter((d) => d.kind === 'checkbox');
      const c = await convertAndCompile(doc(documentFor(kinds)), {
        ...OPTIONS,
        profile: 'preview',
      });
      if (!c.compile.ok || !c.compile.pdf)
        throw new Error(`the compile failed:\n${c.compile.log.slice(-1500)}`);

      const dir = mkdtempSync(join(tmpdir(), 'docedit-kinds-chk-'));
      const file = join(dir, 'main.pdf');
      writeFileSync(file, c.compile.pdf);
      const r = spawnSync('pdftotext', ['-bbox', file, '-'], { encoding: 'utf8', timeout: 60_000 });
      if (r.error || r.status !== 0) throw new Error('pdftotext -bbox is not installed or failed');
      const bbox = r.stdout;
      const starts = xsStarting(bbox, 'CHK');
      const baseAfter = xWord(bbox, 'AFTCHKB');
      const emptyAfter = xWord(bbox, 'AFTCHKE');
      const valueAfter = xWord(bbox, 'AFTCHKV');
      if (starts.length !== 3 || baseAfter === null || emptyAfter === null || valueAfter === null) {
        throw new Error(`the PDF does not show the checkbox words:\n${bbox.slice(0, 600)}`);
      }
      const info = JSON.stringify({ starts, baseAfter, emptyAfter, valueAfter });
      expect(Math.abs(emptyAfter - baseAfter - FIELD_WIDTH_PT), info).toBeLessThan(EPS);
      expect(Math.abs(valueAfter - emptyAfter), info).toBeLessThan(EPS);

      const objects = pdfObjectText(c.compile.pdf);
      const label = KINDS.find((d) => d.kind === 'checkbox')!.label;
      expect(
        objects.includes(label) || objects.toUpperCase().includes(utf16beHex(label)),
        'checkbox label tag',
      ).toBe(true);
    }, 600_000);
  },
);
