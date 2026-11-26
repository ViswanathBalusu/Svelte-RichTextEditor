/**
 * `layout.json` (09 §7.1; spike S4). The class's Lua code writes `main.layout`: integers only,
 * block numbers instead of identifiers. That file is worker output and therefore hostile
 * (09 §9.3 item 7), so it is parsed strictly here, joined with `map.json` from the converter
 * (trusted) to restore block identifiers, and the result is validated against its schema before
 * anything uses it.
 *
 * Units: vertical positions are twentieths of a point (the CDM's unit), measured down from the top
 * edge of the page to the baseline of the line where the block or line starts.
 */
import { validateLayoutFile } from '@docedit/authority';
import type { SourceMap } from '@docedit/export-latex';

export type OpensWith = 'text' | 'float' | 'tableHead' | 'footnoteContinuation';

export interface LayoutPage {
  n: number;
  setup: string | null;
  starts: { blockId: string; offset: number; y: number } | null;
  opensWith: OpensWith;
}

export interface LayoutBlock {
  page: number;
  y: number;
  /** UTF-16 offsets where the block's lines start (granularity `line`). */
  lineStarts?: number[];
  /** The page of each line start, same order. */
  linePages?: number[];
  /**
   * For a table: the page on which each row starts, in row order (a repeated header row is not
   * listed again); null for a row whose cells hold no material the class reported (EXP-057).
   */
  rowPages?: Array<number | null>;
  /**
   * Indexes into `lineStarts` of the lines that start a new column: the line is on the same page as
   * the line before it and higher up the page (EXP-057). Absent when the block has none.
   */
  columnBreaks?: number[];
  /**
   * `block` on a text block that the file could not report at line level: only `page` and `y` of
   * its first material are given, and the page view keeps its own lines for it (EXP-057).
   */
  granularity?: 'block';
}

/**
 * A flattened form field's box (EXP-058): its page and rectangle in twentieths of a point from the
 * top-left corner of the page, `[x0, y0, x1, y1]` with (x0, y0) the top-left and (x1, y1) the
 * bottom-right corner, the same unit and origin as the vertical positions above.
 */
export interface LayoutField {
  page: number;
  rect: [number, number, number, number];
}

export interface LayoutJson {
  seq: number | null;
  classVersion: string;
  granularity: 'line' | 'block';
  unit: 'twip';
  pages: LayoutPage[];
  blocks: Record<string, LayoutBlock>;
  fields: Record<string, LayoutField>;
}

/** The published schema of layout.json (JSON Schema 2020-12), for EXP-055. */
export const LAYOUT_SCHEMA = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  $id: 'https://docedit.example/schema/layout-1.json',
  type: 'object',
  additionalProperties: false,
  required: ['seq', 'classVersion', 'granularity', 'unit', 'pages', 'blocks', 'fields'],
  properties: {
    seq: { type: ['integer', 'null'], minimum: 0 },
    classVersion: { type: 'string', pattern: '^[0-9]+\\.[0-9]+\\.[0-9]+(-[a-z0-9.]+)?$' },
    granularity: { enum: ['line', 'block'] },
    unit: { const: 'twip' },
    pages: {
      type: 'array',
      maxItems: 2000,
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['n', 'setup', 'starts', 'opensWith'],
        properties: {
          n: { type: 'integer', minimum: 1, maximum: 2000 },
          setup: { type: ['string', 'null'] },
          starts: {
            oneOf: [
              { type: 'null' },
              {
                type: 'object',
                additionalProperties: false,
                required: ['blockId', 'offset', 'y'],
                properties: {
                  blockId: { type: 'string', pattern: '^[A-Za-z0-9_-]{16}$' },
                  offset: { type: 'integer', minimum: 0 },
                  y: { type: 'integer', minimum: 0, maximum: 31680 },
                },
              },
            ],
          },
          opensWith: { enum: ['text', 'float', 'tableHead', 'footnoteContinuation'] },
        },
      },
    },
    blocks: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z0-9_-]{16}$' },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'y'],
        properties: {
          page: { type: 'integer', minimum: 1, maximum: 2000 },
          y: { type: 'integer', minimum: 0, maximum: 31680 },
          lineStarts: { type: 'array', items: { type: 'integer', minimum: 0 } },
          linePages: { type: 'array', items: { type: 'integer', minimum: 1, maximum: 2000 } },
          rowPages: {
            type: 'array',
            items: { type: ['integer', 'null'], minimum: 1, maximum: 2000 },
          },
          columnBreaks: { type: 'array', items: { type: 'integer', minimum: 1 } },
          granularity: { const: 'block' },
        },
      },
    },
    fields: {
      type: 'object',
      propertyNames: { pattern: '^[A-Za-z0-9_-]{16}$' },
      additionalProperties: {
        type: 'object',
        additionalProperties: false,
        required: ['page', 'rect'],
        properties: {
          page: { type: 'integer', minimum: 1, maximum: 2000 },
          rect: {
            type: 'array',
            minItems: 4,
            maxItems: 4,
            items: { type: 'integer', minimum: 0, maximum: 1_000_000 },
          },
        },
      },
    },
  },
} as const;

const SP_PER_TWIP = 65781.76 / 20;
const toTwips = (sp: number): number => Math.round(sp / SP_PER_TWIP);

const isInt = (v: unknown, min = -(2 ** 31), max = 2 ** 31): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

export class LayoutError extends Error {}

interface Raw {
  level: number;
  pages: Array<{
    n: number;
    start: [number, number, number] | null;
    first: [number, number] | null;
    /** The index of the page's setup in map.json's `setups`, when the class reports it. */
    s: number | null;
  }>;
  blocks: Map<number, [number, number, number]>;
  lines: Array<[number, number, number, number]>;
  /** Form field boxes by the number the converter gave them: page and the rectangle (EXP-058). */
  fields?: Map<number, [number, number, number, number, number]>;
}

/** The members of the class's sidecar file (docedit.lua writes `v`, `level`, `pages`, `blocks`, `lines`, `fields`). */
const RAW_MEMBERS = new Set(['v', 'level', 'pages', 'blocks', 'lines', 'fields']);
/** The members of one page of the sidecar file: number, size, page setup, start, first line. */
const RAW_PAGE_MEMBERS = new Set(['n', 'w', 'h', 's', 'start', 'first']);

/** Strict parse of the class's sidecar file; anything unexpected is an error, not a guess. */
export function parseRawLayout(
  text: string,
  limits = { maxBytes: 64 * 1024 * 1024, maxPages: 2000 },
): Raw {
  if (text.length > limits.maxBytes) throw new LayoutError('layout data too large');
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new LayoutError('layout data is not JSON');
  }
  const o = j as Record<string, unknown>;
  if (typeof o !== 'object' || o === null || o['v'] !== 1 || !isInt(o['level'], 0, 2))
    throw new LayoutError('bad header');
  // The class writes exactly these members (packages/export-latex/class/docedit.lua). A member
  // it does not write is not a guess to be ignored: the report is refused (SEC-036 criterion 3).
  for (const k of Object.keys(o))
    if (!RAW_MEMBERS.has(k)) throw new LayoutError(`unknown member ${k}`);
  const pagesIn = o['pages'];
  if (!Array.isArray(pagesIn) || pagesIn.length > limits.maxPages)
    throw new LayoutError('bad pages');
  const pages: Raw['pages'] = pagesIn.map((p, i) => {
    const q = p as Record<string, unknown>;
    if (typeof q !== 'object' || q === null || q['n'] !== i + 1) throw new LayoutError('bad page');
    for (const k of Object.keys(q))
      if (!RAW_PAGE_MEMBERS.has(k)) throw new LayoutError(`unknown member ${k}`);
    if ((q['w'] !== undefined && !isInt(q['w'])) || (q['h'] !== undefined && !isInt(q['h'])))
      throw new LayoutError('bad page size');
    const s = q['start'];
    const f = q['first'];
    const start =
      Array.isArray(s) && s.length === 3 && s.every((x) => isInt(x))
        ? (s as [number, number, number])
        : null;
    if (s !== undefined && !start) throw new LayoutError('bad page start');
    const first =
      Array.isArray(f) && f.length === 2 && f.every((x) => isInt(x))
        ? (f as [number, number])
        : null;
    if (f !== undefined && !first) throw new LayoutError('bad page first');
    const setup = q['s'];
    if (setup !== undefined && !isInt(setup, 0, 10_000)) throw new LayoutError('bad page setup');
    return { n: i + 1, start, first, s: setup === undefined ? null : (setup as number) };
  });
  const blocksIn = o['blocks'];
  if (typeof blocksIn !== 'object' || blocksIn === null || Array.isArray(blocksIn))
    throw new LayoutError('bad blocks');
  const blocks = new Map<number, [number, number, number]>();
  for (const [k, v] of Object.entries(blocksIn)) {
    if (!/^[0-9]{1,9}$/.test(k) || !Array.isArray(v) || v.length !== 3 || !v.every((x) => isInt(x)))
      throw new LayoutError('bad block entry');
    blocks.set(Number(k), v as [number, number, number]);
  }
  const linesIn = o['lines'];
  if (!Array.isArray(linesIn) || linesIn.length > 2_000_000) throw new LayoutError('bad lines');
  const lines = linesIn.map((l) => {
    if (!Array.isArray(l) || l.length !== 4 || !l.every((x) => isInt(x)))
      throw new LayoutError('bad line');
    return l as [number, number, number, number];
  });
  const fieldsIn = o['fields'] ?? {};
  if (typeof fieldsIn !== 'object' || fieldsIn === null || Array.isArray(fieldsIn))
    throw new LayoutError('bad fields');
  const fields = new Map<number, [number, number, number, number, number]>();
  for (const [k, v] of Object.entries(fieldsIn)) {
    if (!/^[0-9]{1,6}$/.test(k) || !Array.isArray(v) || v.length !== 5 || !v.every((x) => isInt(x)))
      throw new LayoutError('bad field entry');
    fields.set(Number(k), v as [number, number, number, number, number]);
  }
  return { level: o['level'] as number, pages, blocks, lines, fields };
}

const OPENS: Record<number, OpensWith> = {
  1: 'text',
  2: 'footnoteContinuation',
  3: 'tableHead',
  4: 'float',
};

/** The block kinds whose text the class reports line by line (`kinds` of map.json). */
const TEXT_KINDS: ReadonlySet<string> = new Set([
  'paragraph',
  'heading',
  'listItem',
  'cellParagraph',
  'storyParagraph',
  'footnoteParagraph',
]);

/** Builds layout.json from the raw report and the converter's map. */
export function buildLayout(
  raw: Raw,
  map: SourceMap,
  meta: { seq: number | null; classVersion: string; setup: string | null },
): LayoutJson {
  const id = (b: number): string | null =>
    b > 0 && b < map.blocks.length ? (map.blocks[b] ?? null) : null;
  const pages: LayoutPage[] = raw.pages.map((p) => {
    const startId = p.start ? id(p.start[0]) : null;
    const setups = (map as { setups?: readonly string[] }).setups;
    return {
      n: p.n,
      setup: p.s !== null && setups?.[p.s] !== undefined ? setups[p.s]! : meta.setup,
      starts:
        p.start && startId
          ? { blockId: startId, offset: Math.max(0, p.start[1]), y: toTwips(p.start[2]) }
          : null,
      opensWith: (p.first && OPENS[p.first[1]]) || 'text',
    };
  });
  const blocks: Record<string, LayoutBlock> = {};
  const counted = new Map<string, number>();
  for (const [b, [page, y]] of [...raw.blocks.entries()].sort((x, z) => x[0] - z[0])) {
    const bid = id(b);
    if (bid) blocks[bid] = { page, y: toTwips(y) };
  }
  if (raw.level >= 2) {
    for (const [b, off, page] of raw.lines) {
      const bid = id(b);
      const e = bid ? blocks[bid] : undefined;
      if (!e) continue;
      (e.lineStarts ??= []).push(off);
      (e.linePages ??= []).push(page);
    }
    // A line that starts a column: same page as the line before it, and higher up (EXP-057).
    const last = new Map<string, [number, number]>();
    const breaks = new Map<string, number[]>();
    for (const [b, , page, y] of raw.lines) {
      const bid = id(b);
      const e = bid ? blocks[bid] : undefined;
      if (!bid || !e) continue;
      const k = (counted.get(bid) ?? 0) as number;
      counted.set(bid, k + 1);
      const before = last.get(bid);
      if (before && before[0] === page && y < before[1]) {
        const list = breaks.get(bid) ?? [];
        list.push(k);
        breaks.set(bid, list);
      }
      last.set(bid, [page, y]);
    }
    for (const [bid, list] of breaks) blocks[bid]!.columnBreaks = list;
  }
  // The rows of each table and the page each starts on, from the blocks its cells registered.
  const byNumber = (n: number): LayoutBlock | undefined => {
    const bid = id(n);
    return bid ? blocks[bid] : undefined;
  };
  for (const [tid, ranges] of Object.entries(map.tables ?? {})) {
    const e = blocks[tid];
    if (!e) continue;
    e.rowPages = ranges.map(([from, to]) => {
      let page: number | null = null;
      for (let n = from; n < to; n++) {
        const p = byNumber(n)?.page;
        if (p !== undefined && (page === null || p < page)) page = p;
      }
      return page;
    });
  }
  // A text block with no line start under a compile at line level is reported at block level.
  let textBlocks = 0;
  let withLines = 0;
  if (raw.level >= 2) {
    for (let n = 1; n < map.blocks.length; n++) {
      const bid = id(n);
      const e = bid ? blocks[bid] : undefined;
      if (!bid || !e || !TEXT_KINDS.has(map.kinds[n] ?? '')) continue;
      textBlocks++;
      if (e.lineStarts?.length) withLines++;
      else e.granularity = 'block';
    }
  }
  // A field is reported under its identifier, from the converter's map; a number the map does not
  // know is dropped (it cannot be named), and so is a field whose page is not a page of this file.
  const fields: Record<string, LayoutField> = {};
  for (const [k, [page, x0, y0, x1, y1]] of [...(raw.fields ?? new Map()).entries()].sort(
    (a, b) => a[0] - b[0],
  )) {
    const fid = (map as { fields?: readonly (string | null)[] }).fields?.[k] ?? null;
    if (fid === null || page < 1 || page > pages.length || Object.hasOwn(fields, fid)) continue;
    fields[fid] = {
      page,
      rect: [toTwips(x0), toTwips(y0), toTwips(x1), toTwips(y1)],
    };
  }
  return {
    seq: meta.seq,
    classVersion: meta.classVersion,
    // `line` when the compile reported lines, and at least one text block has them (EXP-057).
    granularity: raw.level >= 2 && (textBlocks === 0 || withLines > 0) ? 'line' : 'block',
    unit: 'twip',
    pages,
    blocks,
    fields,
  };
}

/**
 * Validates a layout.json value against LAYOUT_SCHEMA (hand-written; no schema library). The rules are
 * `validateLayoutFile` of `@docedit/authority`, which the document service applies to the same file
 * before it uses a rectangle (FRW-057 criterion 3).
 */
export function validateLayout(value: unknown): string[] {
  return validateLayoutFile(value);
}
