/**
 * The typesetter's `layout.json` (09 §7.1; EXP-055 to EXP-057): where the compile broke pages and,
 * at line granularity, lines. This module reads and validates the file for the page view
 * (FE-100, 02 §9.7). The published schema is `LAYOUT_SCHEMA` of the export worker
 * (`services/export-worker/src/layout.ts`, EXP-055). This reading accepts every key of that schema
 * (`unit`, the `y` of a start, and the `page`, `y`, `linePages`, `rowPages`, `columnBreaks` and
 * `granularity` of a block) and a page whose `setup` or `starts` is null. For the page view's use it
 * also needs a `seq` that is a number: a file with a null `seq` cannot say which blocks were edited
 * since, so it is not used. Unknown keys are refused, and a file that fails any check is not used at
 * all (docs/adr/0135-layout-2-backlog-batch.md, item 7, for the earlier interim reading).
 *
 * Universal: no DOM and no Node.js API (FND-004).
 */

export const PAGE_OPENS = ['text', 'float', 'tableHead', 'footnoteContinuation'] as const;
export type PageOpensWith = (typeof PAGE_OPENS)[number];

export const GRANULARITIES = ['block', 'line'] as const;
export type Granularity = (typeof GRANULARITIES)[number];

export interface PageStart {
  /** The block that holds the first material on the page. */
  readonly blockId: string;
  /** UTF-16 code units into the block's text, with each inline atom counted as one. */
  readonly offset: number;
}

export interface TypesetPage {
  /** The page number, from 1. */
  readonly n: number;
  /** The page setup in force on the page (its name in the setups map), or null when not reported. */
  readonly setup: string | null;
  /** The first material on the page, or null when the compile found none (the editor keeps its break). */
  readonly starts: PageStart | null;
  readonly opensWith: PageOpensWith;
}

export interface TypesetBlock {
  /** Line starts inside the block, in order, as offsets; empty when the file gives none. */
  readonly lineStarts: readonly number[];
  /** The page and the vertical position of the block's first material, in the unit of the file. */
  readonly page?: number;
  readonly y?: number;
  /** The page of each line start, in the same order. */
  readonly linePages?: readonly number[];
  /** For a table, the page on which each row starts; null for a row with no reported material. */
  readonly rowPages?: readonly (number | null)[];
  /** Indexes into `lineStarts` of the lines that start a new column. */
  readonly columnBreaks?: readonly number[];
  /** `block`: the file could not report this block at line level, so the editor keeps its own lines. */
  readonly granularity?: 'block';
}

export interface TypesetField {
  /** The page the field is on, from 1. */
  readonly page: number;
  /** Left, top, right and bottom, in the unit of the file. */
  readonly rect: readonly [number, number, number, number];
}

export interface LayoutJson {
  readonly seq: number;
  readonly classVersion: string;
  /** The granularity the compile achieved. */
  readonly granularity: Granularity;
  /** The unit of the positions and rectangles of the file; the schema allows `twip` only. */
  readonly unit?: 'twip';
  readonly pages: readonly TypesetPage[];
  readonly blocks: Readonly<Record<string, TypesetBlock>>;
  readonly fields: Readonly<Record<string, TypesetField>>;
}

export type LayoutJsonCheck =
  | { readonly ok: true; readonly layout: LayoutJson }
  | { readonly ok: false; readonly problems: readonly string[] };

type Json = Record<string, unknown>;

function isRecord(value: unknown): value is Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

/** Reports keys that the file does not allow; the caller adds the path of the object. */
function unknownKeys(record: Json, allowed: readonly string[], path: string, out: string[]): void {
  for (const key of Object.keys(record))
    if (!allowed.includes(key)) out.push(`${path}: unknown key "${key}"`);
}

function checkPage(raw: unknown, index: number, problems: string[]): TypesetPage | null {
  const path = `pages[${index}]`;
  if (!isRecord(raw)) {
    problems.push(`${path}: must be an object`);
    return null;
  }
  unknownKeys(raw, ['n', 'setup', 'starts', 'opensWith'], path, problems);
  const before = problems.length;
  if (raw['n'] !== index + 1)
    problems.push(`${path}.n: must be ${index + 1}, pages are numbered from 1 in order`);
  const setup = raw['setup'];
  if (setup !== null && !isNonEmptyString(setup))
    problems.push(`${path}.setup: must be a non-empty string or null`);
  const starts = raw['starts'];
  if (starts === null) {
    // The schema allows a page with no start (no material the class could report).
  } else if (!isRecord(starts)) {
    problems.push(`${path}.starts: must be an object or null`);
  } else {
    unknownKeys(starts, ['blockId', 'offset', 'y'], `${path}.starts`, problems);
    if (!isNonEmptyString(starts['blockId']))
      problems.push(`${path}.starts.blockId: must be a non-empty string`);
    if (!isNonNegativeInteger(starts['offset']))
      problems.push(`${path}.starts.offset: must be a non-negative integer`);
    if (starts['y'] !== undefined && !isNonNegativeInteger(starts['y']))
      problems.push(`${path}.starts.y: must be a non-negative integer`);
  }
  if (
    typeof raw['opensWith'] !== 'string' ||
    !(PAGE_OPENS as readonly string[]).includes(raw['opensWith'])
  )
    problems.push(`${path}.opensWith: must be one of ${PAGE_OPENS.join(', ')}`);
  if (problems.length !== before) return null;
  return {
    n: index + 1,
    setup: setup as string | null,
    starts: isRecord(starts)
      ? { blockId: starts['blockId'] as string, offset: starts['offset'] as number }
      : null,
    opensWith: raw['opensWith'] as PageOpensWith,
  };
}

function checkBlocks(raw: unknown, problems: string[]): Record<string, TypesetBlock> {
  const out: Record<string, TypesetBlock> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    problems.push('blocks: must be an object');
    return out;
  }
  for (const [id, value] of Object.entries(raw)) {
    const path = `blocks.${id}`;
    if (!isRecord(value)) {
      problems.push(`${path}: must be an object`);
      continue;
    }
    unknownKeys(
      value,
      ['lineStarts', 'page', 'y', 'linePages', 'rowPages', 'columnBreaks', 'granularity'],
      path,
      problems,
    );
    const before = problems.length;
    const starts = value['lineStarts'] ?? [];
    if (!Array.isArray(starts) || !starts.every(isNonNegativeInteger)) {
      problems.push(`${path}.lineStarts: must be an array of non-negative integers`);
      continue;
    }
    for (let i = 1; i < starts.length; i++)
      if ((starts[i] as number) < (starts[i - 1] as number)) {
        problems.push(`${path}.lineStarts: must not decrease`);
        break;
      }
    const isPage = (v: unknown): v is number => isNonNegativeInteger(v) && v >= 1;
    if (value['page'] !== undefined && !isPage(value['page']))
      problems.push(`${path}.page: must be a page number from 1`);
    if (value['y'] !== undefined && !isNonNegativeInteger(value['y']))
      problems.push(`${path}.y: must be a non-negative integer`);
    const linePages = value['linePages'];
    if (linePages !== undefined) {
      if (!Array.isArray(linePages) || !linePages.every(isPage))
        problems.push(`${path}.linePages: must be an array of page numbers from 1`);
      else if (linePages.length !== starts.length)
        problems.push(`${path}.linePages: must have one page for each line start`);
    }
    const rowPages = value['rowPages'];
    if (
      rowPages !== undefined &&
      (!Array.isArray(rowPages) || !rowPages.every((v) => v === null || isPage(v)))
    )
      problems.push(`${path}.rowPages: must be an array of page numbers from 1 or null`);
    const columnBreaks = value['columnBreaks'];
    if (
      columnBreaks !== undefined &&
      (!Array.isArray(columnBreaks) ||
        !columnBreaks.every((v) => isNonNegativeInteger(v) && v >= 1))
    )
      problems.push(`${path}.columnBreaks: must be an array of integers of at least 1`);
    if (value['granularity'] !== undefined && value['granularity'] !== 'block')
      problems.push(`${path}.granularity: must be "block" when present`);
    if (problems.length !== before) continue;
    out[id] = {
      lineStarts: starts as number[],
      ...(value['page'] !== undefined ? { page: value['page'] as number } : {}),
      ...(value['y'] !== undefined ? { y: value['y'] as number } : {}),
      ...(linePages !== undefined ? { linePages: linePages as number[] } : {}),
      ...(rowPages !== undefined ? { rowPages: rowPages as (number | null)[] } : {}),
      ...(columnBreaks !== undefined ? { columnBreaks: columnBreaks as number[] } : {}),
      ...(value['granularity'] === 'block' ? { granularity: 'block' as const } : {}),
    };
  }
  return out;
}

function checkFields(raw: unknown, problems: string[]): Record<string, TypesetField> {
  const out: Record<string, TypesetField> = {};
  if (raw === undefined) return out;
  if (!isRecord(raw)) {
    problems.push('fields: must be an object');
    return out;
  }
  for (const [id, value] of Object.entries(raw)) {
    const path = `fields.${id}`;
    if (!isRecord(value)) {
      problems.push(`${path}: must be an object`);
      continue;
    }
    unknownKeys(value, ['page', 'rect'], path, problems);
    const rect = value['rect'];
    const page = value['page'];
    if (!isNonNegativeInteger(page) || page < 1)
      problems.push(`${path}.page: must be a page number from 1`);
    if (!Array.isArray(rect) || rect.length !== 4 || !rect.every(isFiniteNumber)) {
      problems.push(`${path}.rect: must be four finite numbers`);
      continue;
    }
    const [left, top, right, bottom] = rect as [number, number, number, number];
    if (right < left || bottom < top)
      problems.push(`${path}.rect: right and bottom must not be less than left and top`);
    else out[id] = { page: page as number, rect: [left, top, right, bottom] as const };
  }
  return out;
}

/**
 * Checks a parsed `layout.json` (09 §7.1; 02 §9.7 "a `layout.json` that fails validation is not
 * used"). Every problem is listed, with its path, so that the job can report a diagnostic (EXP-055).
 */
export function validateLayoutJson(value: unknown): LayoutJsonCheck {
  const problems: string[] = [];
  if (!isRecord(value)) return { ok: false, problems: ['the file must be a JSON object'] };
  unknownKeys(
    value,
    ['seq', 'classVersion', 'granularity', 'unit', 'pages', 'blocks', 'fields'],
    '$',
    problems,
  );
  if (value['unit'] !== undefined && value['unit'] !== 'twip')
    problems.push('unit: must be "twip" when present');
  if (!isNonNegativeInteger(value['seq'])) problems.push('seq: must be a non-negative integer');
  if (!isNonEmptyString(value['classVersion']))
    problems.push('classVersion: must be a non-empty string');
  if (
    typeof value['granularity'] !== 'string' ||
    !(GRANULARITIES as readonly string[]).includes(value['granularity'])
  )
    problems.push(`granularity: must be one of ${GRANULARITIES.join(', ')}`);
  const rawPages = value['pages'];
  const pages: TypesetPage[] = [];
  if (!Array.isArray(rawPages) || rawPages.length === 0) {
    problems.push('pages: must be a non-empty array');
  } else {
    rawPages.forEach((raw, index) => {
      const page = checkPage(raw, index, problems);
      if (page) pages.push(page);
    });
  }
  const blocks = checkBlocks(value['blocks'], problems);
  const fields = checkFields(value['fields'], problems);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    layout: {
      seq: value['seq'] as number,
      classVersion: value['classVersion'] as string,
      granularity: value['granularity'] as Granularity,
      ...(value['unit'] === 'twip' ? { unit: 'twip' as const } : {}),
      pages,
      blocks,
      fields,
    },
  };
}
