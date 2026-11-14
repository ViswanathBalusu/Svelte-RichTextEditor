/**
 * The typesetter's `layout.json` (09 §7.1; EXP-055 to EXP-057): where the compile broke pages and,
 * at line granularity, lines. This module reads and validates the file for the page view
 * (FE-100, 02 §9.7). The published schema is not in the repository, so the reading of 09 §7.1 here
 * is the interim one, recorded in docs/adr/0135-layout-2-backlog-batch.md (item 7): unknown keys
 * are refused, and a file that fails any check is not used at all.
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
  /** The page setup in force on the page (its name in the setups map). */
  readonly setup: string;
  readonly starts: PageStart;
  readonly opensWith: PageOpensWith;
}

export interface TypesetBlock {
  /** Line starts inside the block, in order, as offsets. */
  readonly lineStarts: readonly number[];
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
  if (!isNonEmptyString(raw['setup'])) problems.push(`${path}.setup: must be a non-empty string`);
  const starts = raw['starts'];
  if (!isRecord(starts)) {
    problems.push(`${path}.starts: must be an object`);
  } else {
    unknownKeys(starts, ['blockId', 'offset'], `${path}.starts`, problems);
    if (!isNonEmptyString(starts['blockId']))
      problems.push(`${path}.starts.blockId: must be a non-empty string`);
    if (!isNonNegativeInteger(starts['offset']))
      problems.push(`${path}.starts.offset: must be a non-negative integer`);
  }
  if (
    typeof raw['opensWith'] !== 'string' ||
    !(PAGE_OPENS as readonly string[]).includes(raw['opensWith'])
  )
    problems.push(`${path}.opensWith: must be one of ${PAGE_OPENS.join(', ')}`);
  if (problems.length !== before || !isRecord(starts)) return null;
  return {
    n: index + 1,
    setup: raw['setup'] as string,
    starts: {
      blockId: starts['blockId'] as string,
      offset: starts['offset'] as number,
    },
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
    unknownKeys(value, ['lineStarts'], path, problems);
    const starts = value['lineStarts'];
    if (!Array.isArray(starts) || !starts.every(isNonNegativeInteger)) {
      problems.push(`${path}.lineStarts: must be an array of non-negative integers`);
      continue;
    }
    for (let i = 1; i < starts.length; i++)
      if ((starts[i] as number) < (starts[i - 1] as number)) {
        problems.push(`${path}.lineStarts: must not decrease`);
        break;
      }
    out[id] = { lineStarts: starts as number[] };
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
    ['seq', 'classVersion', 'granularity', 'pages', 'blocks', 'fields'],
    '$',
    problems,
  );
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
      pages,
      blocks,
      fields,
    },
  };
}
