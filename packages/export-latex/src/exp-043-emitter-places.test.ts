/**
 * EXP-043 criterion 4, driven by the attribute table (lane w2, 2026-11-15; Node.js only, nothing
 * compiles). `emit.output.search.test.ts` probes the places one hand-written document reaches. This
 * file takes the list of places from `ATTRIBUTE_EMITTERS` instead: every attribute whose entry is
 * `pdfString`, `kvValue` or `url` must have a probe here, so a new entry without a probe fails.
 *
 * Each probe carries a control sequence, braces, a percent sign and a `^^` escape, and its own
 * marker. For each place the bundle is searched:
 *
 * - the raw probe is in no `.tex` file;
 * - a `pdfString` or `kvValue` place carries the probe inside a `\DEstr{<hex>}` group, the one form
 *   those two emitters write (`kvValue` adds braces round it, which an argument has anyway);
 * - a `url` place carries it inside a `\DEhref{<hex>}` target, percent-encoded.
 *
 * `KNOWN_OTHER_ROUTE` lists the places that are written, safely, by another emitter than the table
 * names; the test fails when one of them changes, so the list cannot go stale. It is empty.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { ATTRIBUTE_EMITTERS } from './attributes.ts';
import { kvValue } from './emit.ts';
import { doc, nid, para, run, type DocParts, type J } from '../test/docs.ts';
import { makePng, sha256Hex } from '../test/exp-034-png.ts';

const probe = (marker: string): string => `\\write18{${marker}}%^^41`;
const encoded = (marker: string): string => `%5Cwrite18%7B${marker}%7D%%5E%5E41`;

interface Place {
  body: (p: string) => J[];
  parts?: (p: string) => DocParts;
}

const cite = (source: string): J => ({
  type: 'citation',
  attrs: { items: [{ source }], mode: 'normal' },
});
const source = (attrs: J): J => ({
  type: 'source_def',
  attrs: {
    id: 's1',
    kind: 'book',
    title: 'T',
    authors: [{ family: 'A', given: 'B' }],
    issued: '2020',
    ...attrs,
  },
});
const cited = (): J[] => [
  para('See.', {}, [cite('s1')]),
  { type: 'bibliography', attrs: { id: nid('b') } },
];
const linked = (attrs: J): J[] => [
  para('', {}, [{ type: 'text', text: 'Link.', marks: [{ type: 'link', attrs }] }]),
];

/** One document per attribute of the table that names `pdfString`, `kvValue` or `url`. */
const PLACES: Record<string, Place> = {
  'source_def.doi': {
    body: cited,
    parts: (p) => ({ sources: [source({ doi: `10.1000/${p}` })] }),
  },
  'source_def.url': {
    body: cited,
    parts: (p) => ({ sources: [source({ url: `https://example.org/${p}` })] }),
  },
  'figure.alt': {
    body: (p) => [
      { type: 'figure', attrs: { id: nid('f'), asset: 'pic1', width: 1440, height: 1440, alt: p } },
    ],
  },
  'image.alt': {
    body: (p) => [
      para('', {}, [{ type: 'image', attrs: { asset: 'pic1', width: 720, height: 720, alt: p } }]),
    ],
  },
  'extension_block.fallbackText': {
    body: (p) => [{ type: 'extension_block', attrs: { id: nid('x'), fallbackText: p } }],
  },
  'preserved_block.label': {
    body: (p) => [{ type: 'preserved_block', attrs: { id: nid('x'), label: p } }],
  },
  'preserved_block.fallbackText': {
    body: (p) => [{ type: 'preserved_block', attrs: { id: nid('x'), fallbackText: p } }],
  },
  'preserved_inline.label': {
    body: (p) => [para('', {}, [{ type: 'preserved_inline', attrs: { label: p } }])],
  },
  'form_field.label': {
    body: (p) => [
      para('', {}, [
        {
          type: 'form_field',
          attrs: { id: nid('ff'), key: 'k', kind: 'text', label: p, width: 2880, value: null },
        },
      ]),
    ],
  },
  'mark:link.href': { body: (p) => linked({ href: `https://example.org/${p}` }) },
  'mark:link.title': { body: (p) => linked({ href: 'https://example.org/', title: p }) },
  'hidden_region.title': {
    body: (p) => [{ type: 'hidden_region', attrs: { id: nid('h'), title: p } }],
  },
};

/**
 * Places written, safely, by another emitter than the table names. None now: the link title went
 * through `pdfHexString` until EXP-030 criterion 5 (owner decision 209), and goes through
 * `pdfString` like every other title.
 */
const KNOWN_OTHER_ROUTE: Record<string, (main: string, p: string) => boolean> = {};

const STRING_EMITTERS = new Set(['pdfString', 'kvValue', 'url']);
const TABLE = Object.entries(ATTRIBUTE_EMITTERS).filter(
  (e): e is [string, string] => e[1] !== null && STRING_EMITTERS.has(e[1]),
);

function decodeGroups(main: string, command: string): string[] {
  const out: string[] = [];
  const re = new RegExp(`\\\\${command}\\{([0-9A-F]*)\\}`, 'g');
  for (const m of main.matchAll(re)) out.push(Buffer.from(m[1]!, 'hex').toString('utf8'));
  return out;
}

describe('EXP-043 criterion 4: every place of the attribute table goes through its emitter', () => {
  it('has a probe for every pdfString, kvValue and url entry of the table, and no stale one', () => {
    expect(Object.keys(PLACES).sort()).toEqual(TABLE.map(([k]) => k).sort());
    for (const k of Object.keys(KNOWN_OTHER_ROUTE)) expect(Object.keys(PLACES)).toContain(k);
  });

  it('writes a string command and a link target only where an emitter makes them (source search)', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const sources = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(sources).toContain('emit.ts');
    for (const f of sources) {
      const text = readFileSync(dir + f, 'utf8');
      // `\DEstr{` is the form `pdfString` writes; nothing else builds it.
      if (f !== 'emit.ts') expect(text, `${f} builds \\DEstr`).not.toMatch(/\\DEstr\{/);
      // A `\DEhref` target is the `tex` of the `url` emitter and nothing else.
      for (const m of text.matchAll(/\\DEhref\{(\$\{[^}]*\}|[^}]*)\}/g))
        expect(m[1], `${f} writes a \\DEhref target`).toBe('${u.tex}');
    }
  });

  it.each(TABLE)('%s is written only in the form of %s', async (key, emitter) => {
    const marker = `m${TABLE.findIndex(([k]) => k === key)}q`;
    const p = probe(marker);
    const place = PLACES[key]!;
    const b = await run(doc(place.body(p), place.parts?.(p) ?? {}), { title: 'T' });
    for (const [name, text] of Object.entries(b.files)) {
      if (typeof text !== 'string' || !name.endsWith('.tex')) continue;
      expect(text, name).not.toContain('\\write18');
      expect(text, name).not.toContain('^^41');
    }
    const main = b.files['main.tex']!;
    const viaEmitter =
      emitter === 'url'
        ? decodeGroups(main, 'DEhref').some((t) => t.includes(encoded(marker)))
        : decodeGroups(main, 'DEstr').some((t) => t.includes(p));
    const other = KNOWN_OTHER_ROUTE[key];
    if (other) {
      // A known gap: safe, but not the emitter the table names. Fails when the gap closes.
      expect(viaEmitter, `${key} now goes through ${emitter}: remove it from the list`).toBe(false);
      expect(other(main, p), `${key} is written by its other route`).toBe(true);
    } else {
      expect(viaEmitter, `${key} reaches main.tex through ${emitter}`).toBe(true);
    }
  });

  it.each(['figure.alt', 'image.alt'])(
    '%s with its picture is the braced kvValue argument of the picture command',
    async (key) => {
      const bytes = makePng(20, 10);
      const asset = {
        sha256: sha256Hex(bytes),
        mediaType: 'image/png',
        status: 'ready' as const,
        bytes,
      };
      const p = probe('pic');
      const b = await run(doc(PLACES[key]!.body(p)), { title: 'T', assets: { pic1: asset } });
      const main = b.files['main.tex']!;
      expect(main).not.toContain('\\write18');
      expect(main).toContain(`{${kvValue(p)}}`);
      const img = /\\DEimg\{[^\n]*/.exec(main);
      expect(img, 'the picture is set').not.toBeNull();
      expect(img![0]).toContain(`${kvValue(p)}`);
    },
  );
});
