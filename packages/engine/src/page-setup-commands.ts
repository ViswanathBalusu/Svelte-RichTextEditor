/**
 * Page setup commands (FE-137 criteria 1, 3 and 6; 03 §4.1 `page_setup`; 07 §5.3; PRM-012).
 *
 * - A page setup is a definition in `defs`, found by its identifier. Its lengths are in twentieths
 *   of a point (twips), as the CDM stores them (CDM `ULENGTH`, 0 to 31680; page sizes 144 to 31680).
 * - A paper size sets width and height in twips. The two presets are A4 and US Letter, whose
 *   dimensions in twips follow from their millimetre and inch sizes. The spec names no other sizes
 *   here; further presets are a recorded open point (FE-137 notes), not decided by this module.
 * - Changing a definition needs the rights of 07 §5.3 (PRM-012): the caller passes `writable` for
 *   the position of the `page_setup` node, and a refusal changes nothing. The core's `setPageSetup`
 *   command passes the region guard's `canWrite` for the `defs` scope (core.ts).
 * - Header and footer stories, the first-page and odd-page variants and the page number fields are
 *   not in this module (FE-137 criteria 2, 4 and 5 stay open; see the epic's notes).
 */
import type { Node } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import type { StoryPart, StoryVariant } from './header-footer.ts';
import { turnOnVariants } from './variant-turn-on.ts';

/**
 * The page number formats of the CDM (cdm1.ts, `page_setup.pageNumberFormat`). Kept here because the
 * definition index does not export the list; the test checks it against the CDM definition.
 */
export const PAGE_NUMBER_FORMATS = [
  'decimal',
  'lowerRoman',
  'upperRoman',
  'lowerLetter',
  'upperLetter',
] as const;

/** Paper sizes in twips (twentieths of a point): A4 210 by 297 mm, US Letter 8.5 by 11 inches. */
export const PAPER_SIZES = {
  A4: { width: 11906, height: 16838 },
  Letter: { width: 12240, height: 15840 },
} as const;
export type PaperSize = keyof typeof PAPER_SIZES;

const LENGTH_MIN = 0;
const LENGTH_MAX = 31680;
const PAGE_MIN = 144;
const PAGE_MAX = 31680;

/** The attributes of a `page_setup` that this module sets, with the rule each value must meet. */
const LENGTH_FIELDS = [
  'marginTop',
  'marginRight',
  'marginBottom',
  'marginLeft',
  'gutter',
  'headerDistance',
  'footerDistance',
  'columnGap',
] as const;
const BOOLEAN_FIELDS = ['differentFirstPage', 'differentOddEven'] as const;

export interface PageSetupChanges {
  readonly paperSize?: PaperSize;
  readonly width?: number;
  readonly height?: number;
  readonly orientation?: 'portrait' | 'landscape';
  readonly marginTop?: number;
  readonly marginRight?: number;
  readonly marginBottom?: number;
  readonly marginLeft?: number;
  readonly gutter?: number;
  readonly headerDistance?: number;
  readonly footerDistance?: number;
  readonly columns?: number;
  readonly columnGap?: number;
  readonly differentFirstPage?: boolean;
  readonly differentOddEven?: boolean;
  readonly pageNumberStart?: number | null;
  readonly pageNumberFormat?: (typeof PAGE_NUMBER_FORMATS)[number];
  readonly watermark?: string | null;
}

export type PageSetupRefusal = 'no-page-setup' | 'invalid-value' | 'read-only' | 'story-conflict';

export type PageSetupResult =
  | { readonly ok: true; readonly pos: number }
  | { readonly ok: false; readonly reason: PageSetupRefusal; readonly field?: string };

const isInt = (v: unknown, min: number, max: number): v is number =>
  typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max;

/** The keys a caller may change through this module; header and footer links are not among them. */
const SETTABLE: ReadonlySet<string> = new Set([
  'paperSize',
  'width',
  'height',
  'orientation',
  ...LENGTH_FIELDS,
  'columns',
  'columnGap',
  ...BOOLEAN_FIELDS,
  'pageNumberStart',
  'pageNumberFormat',
  'watermark',
]);

/** The name of the first field whose value the CDM refuses, or null when all are allowed. */
export function invalidField(changes: PageSetupChanges): string | null {
  const c = changes as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (c[key] !== undefined && !SETTABLE.has(key)) return key;
  }
  if (
    c['paperSize'] !== undefined &&
    !Object.prototype.hasOwnProperty.call(PAPER_SIZES, String(c['paperSize']))
  ) {
    return 'paperSize';
  }
  for (const key of ['width', 'height'] as const) {
    if (key in c && c[key] !== undefined && !isInt(c[key], PAGE_MIN, PAGE_MAX)) return key;
  }
  for (const key of LENGTH_FIELDS) {
    if (key in c && c[key] !== undefined && !isInt(c[key], LENGTH_MIN, LENGTH_MAX)) return key;
  }
  if ('orientation' in c && c['orientation'] !== undefined) {
    if (c['orientation'] !== 'portrait' && c['orientation'] !== 'landscape') return 'orientation';
  }
  if ('columns' in c && c['columns'] !== undefined && !isInt(c['columns'], 1, 16)) return 'columns';
  for (const key of BOOLEAN_FIELDS) {
    if (key in c && c[key] !== undefined && typeof c[key] !== 'boolean') return key;
  }
  if ('pageNumberStart' in c && c['pageNumberStart'] !== undefined) {
    const v = c['pageNumberStart'];
    if (v !== null && !isInt(v, 0, 32767)) return 'pageNumberStart';
  }
  if ('pageNumberFormat' in c && c['pageNumberFormat'] !== undefined) {
    if (!(PAGE_NUMBER_FORMATS as readonly unknown[]).includes(c['pageNumberFormat'])) {
      return 'pageNumberFormat';
    }
  }
  if ('watermark' in c && c['watermark'] !== undefined) {
    const v = c['watermark'];
    if (v !== null && (typeof v !== 'string' || v.length < 1 || v.length > 255)) return 'watermark';
  }
  return null;
}

/** The position of the `page_setup` node with `id` in the definitions, or null. */
export function pageSetupPos(doc: Node, id: string): number | null {
  const defs = doc.firstChild;
  if (!defs) return null;
  let found: number | null = null;
  defs.forEach((child, offset) => {
    if (found === null && child.type.name === 'page_setup' && child.attrs['id'] === id) {
      found = 1 + offset;
    }
  });
  return found;
}

/** The attribute values one change sets: a paper size expands to width and height. */
function valuesOf(changes: PageSetupChanges): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(changes)) {
    if (value === undefined || key === 'paperSize') continue;
    out[key] = value;
  }
  if (changes.paperSize !== undefined) {
    const size = PAPER_SIZES[changes.paperSize];
    out['width'] = size.width;
    out['height'] = size.height;
  }
  return out;
}

/**
 * Stores `changes` on the page setup `id`. Nothing changes when a value is refused, the setup is
 * missing or `writable` refuses its position (07 §5.3).
 */
export function setPageSetup(
  state: EditorState,
  id: string,
  changes: PageSetupChanges,
  options: {
    readonly writable: (pos: number) => boolean;
    /**
     * Gives the identifier of each header or footer story a variant turned on needs (FE-137
     * criterion 2). When it is given and a variant flag is set to true, the stories are created in
     * the same transaction as the flag (variant-turn-on.ts).
     */
    readonly storyIdOf?: (part: StoryPart, variant: StoryVariant) => string;
  },
  dispatch?: (tr: Transaction) => void,
): PageSetupResult {
  const pos = pageSetupPos(state.doc, id);
  if (pos === null) return { ok: false, reason: 'no-page-setup' };
  const bad = invalidField(changes);
  if (bad !== null) return { ok: false, reason: 'invalid-value', field: bad };
  if (!options.writable(pos)) return { ok: false, reason: 'read-only' };
  const turnedOn = VARIANT_FLAGS.filter((flag) => changes[flag] === true);
  let tr: Transaction;
  if (options.storyIdOf !== undefined && turnedOn.length > 0) {
    const built = turnOnVariants(state, id, turnedOn, options.storyIdOf, true);
    if (built === null) return { ok: false, reason: 'story-conflict' };
    tr = built.tr;
    // The transaction holds the variant stories; the other values go on the same page setup.
    const at = pageSetupPos(tr.doc, id);
    if (at === null) return { ok: false, reason: 'no-page-setup' };
    for (const [key, value] of Object.entries(valuesOf(changes))) {
      tr.setNodeAttribute(at, key, value);
    }
  } else {
    tr = state.tr;
    for (const [key, value] of Object.entries(valuesOf(changes))) {
      tr.setNodeAttribute(pos, key, value);
    }
  }
  if (dispatch) dispatch(tr);
  return { ok: true, pos };
}

const VARIANT_FLAGS = ['differentFirstPage', 'differentOddEven'] as const;
