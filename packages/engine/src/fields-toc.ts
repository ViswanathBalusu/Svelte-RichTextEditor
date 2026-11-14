/**
 * Fields, the table of contents and symbols (FE-136 criteria 1, 2, 3 and 4; 03 §4.3 `toc`, §4.4
 * `field`; CDM-031, CDM-035; 09 §3.2).
 *
 * - A `page` or `pageCount` field goes in a header or footer story only (FE-057 criterion 3). Its
 *   text is set at layout, so `cached` stays null.
 * - A `date` field goes in body text. Its text is the model's shared computation, `dateFieldText`
 *   (CDM-035): the caller gives the server instant and the zone of the workflow (03 §7), and this
 *   module reads no clock. `cached` holds the text at insertion.
 * - A `title` field has no data source in the CDM (recorded in the epic's notes), so this module
 *   stores the title only when the caller supplies it, and otherwise leaves `cached` null.
 * - A `toc` atom goes after the block the caret is in, in the body or in a region. Its entries are
 *   the view's to draw and update, which is not built (FE-136 criterion 3 stays open).
 * - A symbol is inserted as text, with the marks at the caret. Flagging a character that the current
 *   font lacks needs font coverage data, which is not built (FE-136 criterion 4 stays open).
 * - The equation command opens the math editor (FE-070), which is not built (criterion 5 stays open).
 *
 * The core runs `insertField` and `insertToc` through its authoring commands (core.ts).
 */
import { dateFieldText } from '@docedit/model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { insertFormField, isFormFieldInsertKind } from './frw-072-form-fields.ts';
import type { FieldResult, InsertFieldOptions } from './fields-types.ts';

/** The field kinds this command inserts; `seq`, `ref` and the rest belong to other commands. */
export const INSERTABLE_FIELD_KINDS = ['page', 'pageCount', 'date', 'title'] as const;
export type InsertableFieldKind = (typeof INSERTABLE_FIELD_KINDS)[number];

/** A field's `format` as the CDM admits it (cdm1.ts, `FIELD_FORMAT_PATTERN`; 1 to 64 characters). */
const FORMAT_PATTERN = /^[A-Za-z0-9 .,:;/()'-]{1,64}$/;
/** The outline levels a table of contents may name (CDM `toc.minLevel`, `maxLevel`: 1 to 9). */
const TOC_LEVEL_MIN = 1;
const TOC_LEVEL_MAX = 9;
/** The `toc.of` values of the CDM (cdm1.ts, `TOC_OF_PATTERN`): `headings`, or a caption sequence. */
const TOC_OF_PATTERN = /^(?:headings|[A-Za-z][A-Za-z0-9_-]{0,31})$/;

export type { FieldRefusal, FieldResult, InsertFieldOptions } from './fields-types.ts';

const fail = <T extends string>(reason: T): { readonly ok: false; readonly reason: T } => ({
  ok: false,
  reason,
});

/** The ancestors of the caret, the root included, as their node type names, innermost first. */
function ancestorsOf(state: EditorState): string[] {
  const { $from } = state.selection;
  const out: string[] = [];
  for (let d = $from.depth; d >= 0; d--) out.push($from.node(d).type.name);
  return out;
}

/** Whether `kind` is one of the field kinds this command inserts. */
export function isInsertableFieldKind(kind: unknown): kind is InsertableFieldKind {
  return typeof kind === 'string' && (INSERTABLE_FIELD_KINDS as readonly string[]).includes(kind);
}

/**
 * Inserts a field of `kind` at the caret, replacing a selection. Nothing changes on a refusal, and
 * without `dispatch` the call only checks (the `queryCommand` form). Returns the `cached` text.
 */
export function insertField(
  state: EditorState,
  kind: string,
  options: InsertFieldOptions,
  dispatch?: (tr: Transaction) => void,
): FieldResult {
  if (isFormFieldInsertKind(kind)) return insertFormField(state, kind, options, dispatch);
  if (!isInsertableFieldKind(kind)) return fail('bad-kind');
  const type = state.schema.nodes['field'];
  const { $from } = state.selection;
  if (!type || !$from.parent.inlineContent) return fail('not-here');
  if (!$from.parent.canReplaceWith($from.index(), $from.index(), type)) return fail('not-here');

  const format = options.format ?? null;
  if (format !== null && !FORMAT_PATTERN.test(format)) return fail('bad-format');

  const chain = ancestorsOf(state);
  const inStory = chain.includes('story');
  if ((kind === 'page' || kind === 'pageCount') && !inStory) return fail('not-in-story');
  if ((kind === 'date' || kind === 'title') && (inStory || !chain.includes('body'))) {
    return fail('not-in-body');
  }

  let cached: string | null = null;
  if (kind === 'date') {
    if (options.date === undefined) return fail('no-date-source');
    try {
      cached = dateFieldText({
        instant: options.date.instant,
        timeZone: options.date.timeZone,
        format,
      });
    } catch {
      return fail('bad-date');
    }
  } else if (kind === 'title') {
    cached = options.title ?? null;
  }

  if (!options.writable($from.pos)) return fail('read-only');
  if (dispatch) {
    const node = type.create({ kind, format, cached });
    dispatch(state.tr.replaceSelectionWith(node).scrollIntoView());
  }
  return { ok: true, cached };
}

export interface TocOptions {
  readonly minLevel?: number;
  readonly maxLevel?: number;
  /** `headings`, or a caption sequence name such as `Figure`. */
  readonly of?: string;
}

export type TocRefusal =
  'bad-id' | 'bad-levels' | 'bad-of' | 'not-in-body' | 'not-here' | 'read-only';

export type TocResult = { readonly ok: true } | { readonly ok: false; readonly reason: TocRefusal };

/**
 * Inserts a table of contents (or a list of figures or tables) after the block the caret is in. The
 * block's parent must be the body or a region. `id` is the new atom's identifier, unique in the
 * document (the caller supplies it, as the other commands do).
 */
export function insertToc(
  state: EditorState,
  id: string,
  options: TocOptions,
  guard: { readonly writable: (pos: number) => boolean },
  dispatch?: (tr: Transaction) => void,
): TocResult {
  if (typeof id !== 'string' || id === '') return fail('bad-id');
  const minLevel = options.minLevel ?? TOC_LEVEL_MIN;
  const maxLevel = options.maxLevel ?? 3;
  const of = options.of ?? 'headings';
  const levelOk = (v: number) => Number.isInteger(v) && v >= TOC_LEVEL_MIN && v <= TOC_LEVEL_MAX;
  if (!levelOk(minLevel) || !levelOk(maxLevel) || minLevel > maxLevel) return fail('bad-levels');
  if (!TOC_OF_PATTERN.test(of)) return fail('bad-of');

  const type = state.schema.nodes['toc'];
  if (!type) return fail('not-here');
  const { $from } = state.selection;
  if (ancestorsOf(state).includes('story')) return fail('not-in-body');

  // The block the caret is in: the first ancestor whose parent is the body or a region.
  let after = -1;
  for (let d = $from.depth; d >= 1 && after < 0; d--) {
    const parent = $from.node(d - 1);
    const name = parent.type.name;
    if (
      (name === 'body' || name === 'region') &&
      parent.canReplaceWith($from.index(d - 1) + 1, $from.index(d - 1) + 1, type)
    ) {
      after = $from.after(d);
    }
  }
  if (after < 0) return fail('not-in-body');
  if (!guard.writable($from.pos)) return fail('read-only');
  if (dispatch)
    dispatch(state.tr.insert(after, type.create({ id, minLevel, maxLevel, of })).scrollIntoView());
  return { ok: true };
}

export type SymbolRefusal = 'bad-symbol' | 'not-here' | 'read-only';

export type SymbolResult =
  { readonly ok: true } | { readonly ok: false; readonly reason: SymbolRefusal };

/** Whether `ch` is exactly one printable character (a code point, not a control character). */
export function isSymbolCharacter(ch: string): boolean {
  const points = Array.from(ch);
  if (points.length !== 1) return false;
  const code = points[0]!.codePointAt(0)!;
  return code >= 0x20 && !(code >= 0x7f && code <= 0x9f);
}

/** Inserts one character as text at the caret, with the marks there (09 §3.2). */
export function insertSymbol(
  state: EditorState,
  ch: string,
  options: { readonly writable: (pos: number) => boolean },
  dispatch?: (tr: Transaction) => void,
): SymbolResult {
  if (!isSymbolCharacter(ch)) return fail('bad-symbol');
  const { $from } = state.selection;
  if (!$from.parent.inlineContent) return fail('not-here');
  if (!options.writable($from.pos)) return fail('read-only');
  if (dispatch) {
    const marks = state.storedMarks ?? $from.marks();
    dispatch(state.tr.replaceSelectionWith(state.schema.text(ch, marks), false).scrollIntoView());
  }
  return { ok: true };
}
