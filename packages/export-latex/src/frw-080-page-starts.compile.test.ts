/**
 * FRW-080 criterion 5 (Node.js only, Podman sandbox): the PDF of a document with a form field
 * empty and the PDF of the same document with the field filled start every page at the same block,
 * and every paragraph breaks its lines at the same places. The positions come from the class's own
 * report of the compile (`layout.json`, EXP-055), joined with the converter's map: the first block
 * and offset of each page, and the offset of each line start of each block.
 *
 * Three cases: a field with a `width` and a value that fits, a field with a `width` and a value far
 * wider than the box, and a field with no `width` (the default width of its kind) and a long value.
 * The field sits in the middle of a paragraph of a document of several pages, so that a box that
 * followed its value would move a line, and with it a page start. The tests skip when
 * `sandboxReady()` reports that sandboxed compiles cannot run here (EXP-070).
 */
import { describe, expect, it } from 'vitest';
import { doc, para, type J } from '../test/docs.ts';
import { convertAndCompile, keep, sandboxReady } from '../test/harness.ts';

const ready = (await sandboxReady()).ok;

const INSTANT = '2026-11-17T10:00:00.000Z';
const COMPILE_TIMEOUT_MS = 600_000;
const OPTIONS = {
  profile: 'preview',
  title: 'frw-080-page-starts',
  instant: INSTANT,
  timeZone: 'Europe/London',
  suggestions: 'accept',
  fields: 'flatten',
  layout: 'line',
} as never;

/** The ids are fixed so that two builds of the document name the same blocks. */
const FIELD_ID = 'fFRW080000000001'.slice(0, 16);
const BEFORE = 12;

function words(tag: string, n: number): string {
  return Array.from({ length: n }, (_v, i) => `${tag}w${i}`).join(' ');
}

/** Sixty paragraphs, the twentieth with a field in the middle of its text. */
function body(field: J): J[] {
  const out: J[] = [];
  for (let i = 0; i < 60; i++) {
    const id = `pFRW0800000${String(i).padStart(5, '0')}`;
    if (i === 20)
      out.push(
        para(words(`a${i}`, BEFORE), { id }, [
          { type: 'text', text: ' ' },
          field,
          { type: 'text', text: ` ${words(`b${i}`, 70)}` },
        ]),
      );
    else out.push(para(words(`p${i}`, 30 + (i % 9) * 5), { id }));
  }
  return out;
}

const formField = (attrs: J): J => ({
  type: 'form_field',
  attrs: { id: FIELD_ID, key: 'tenant.name', kind: 'text', label: 'Tenant name', ...attrs },
});

/** What the report says about the page starts and the line starts of every block. */
async function breaksOf(name: string, field: J) {
  const c = await convertAndCompile(doc(body(field), { requires: ['fields'] }), OPTIONS, {
    minPasses: 2,
  });
  if (!c.compile.ok || !c.compile.pdf)
    throw new Error(`the compile failed (${keep(name, c)}):\n${c.compile.log.slice(-1500)}`);
  expect(c.layoutErrors).toEqual([]);
  const layout = c.layout!;
  return {
    pages: layout.pages.map((p) => `${p.n}:${p.starts?.blockId}@${p.starts?.offset}`),
    lines: Object.fromEntries(
      Object.entries(layout.blocks).map(([id, b]) => [id, b.lineStarts ?? null]),
    ),
  };
}

describe.skipIf(!ready)(
  'FRW-080 criterion 5: filling a field moves no page start in the PDF',
  () => {
    it(
      'a field with a width: the empty and the filled document break the same',
      async () => {
        const width = 2880;
        const empty = await breaksOf('frw-080-empty', formField({ width, value: null }));
        const filled = await breaksOf(
          'frw-080-filled',
          formField({ width, value: 'Ada Lovelace' }),
        );
        // Several pages, so that a page start can move; and the field's own paragraph breaks into lines.
        expect(empty.pages.length).toBeGreaterThanOrEqual(3);
        expect(filled.pages).toEqual(empty.pages);
        expect(filled.lines).toEqual(empty.lines);
      },
      COMPILE_TIMEOUT_MS,
    );

    it(
      'a field with a width and a value far wider than its box: the box does not grow',
      async () => {
        const width = 2880;
        const empty = await breaksOf('frw-080-empty-w', formField({ width, value: null }));
        const long = 'Mrs Alexandria Tenant-Hyphenated Longname of the Lower Mill'.repeat(3);
        const filled = await breaksOf('frw-080-long', formField({ width, value: long }));
        expect(filled.pages).toEqual(empty.pages);
        expect(filled.lines).toEqual(empty.lines);
      },
      COMPILE_TIMEOUT_MS,
    );

    it(
      'a field with no width takes the default width of its kind, and a long value changes nothing',
      async () => {
        const empty = await breaksOf('frw-080-empty-d', formField({ value: null }));
        const long = 'Mrs Alexandria Tenant-Hyphenated Longname of the Lower Mill'.repeat(3);
        const filled = await breaksOf('frw-080-long-d', formField({ value: long }));
        expect(filled.pages).toEqual(empty.pages);
        expect(filled.lines).toEqual(empty.lines);
      },
      COMPILE_TIMEOUT_MS,
    );

    it(
      'is sensitive to the box: a field twice as wide moves a line start (control)',
      async () => {
        const narrow = await breaksOf('frw-080-narrow', formField({ width: 1440, value: null }));
        const wide = await breaksOf('frw-080-wide', formField({ width: 8640, value: null }));
        expect(wide.lines).not.toEqual(narrow.lines);
      },
      COMPILE_TIMEOUT_MS,
    );
  },
);
