/**
 * Paragraph format command (FE-129 criteria 1 and 3, the storage half; 03 §4.5, §7).
 *
 * `setParagraphFormat` writes a patch of paragraph properties onto every selected paragraph the
 * user may edit. Each value is checked against the CDM's own range before anything changes: an
 * unknown property, an out-of-range integer or an unknown enumeration makes the command unavailable
 * and changes nothing. The properties are the ones `paragraphProps` in `packages/model`
 * (cdm1.ts) defines. `borders`, `shading` and `tabs` are stored whole, as the CDM defines them
 * (criterion 5; `tabs` for the ruler and the paragraph dialog, UX-102). The web view draws the
 * stored values but for the tab stops (`view/paragraph-format-view.ts`): a tab in the text is still
 * the browser's own there (criterion 2 stays open on that).
 */
import type { Node as PMNode } from 'prosemirror-model';
import type { Command } from 'prosemirror-state';
import { selectedParagraphs } from './styles.ts';

/** The CDM's `LENGTH` and `ULENGTH` ranges, in twips (`shared.ts`). */
const LENGTH_MIN = -31680;
const LENGTH_MAX = 31680;
const ULENGTH_MIN = 0;
const ULENGTH_MAX = 31680;

const ALIGN = ['start', 'center', 'end', 'justify', 'distribute'] as const;
const LINE_RULE = ['multiple', 'exact', 'atLeast'] as const;
const BORDER_STYLES = ['none', 'single', 'double', 'dotted', 'dashed', 'thick'] as const;
const BORDER_SIDES = ['top', 'bottom', 'left', 'right', 'between'] as const;
const COLOUR = /^#[0-9A-F]{6}$/;
/** A tab stop of the CDM (03 §4.5, §7; `TAB` in cdm1.ts): at most 64 on a paragraph. */
const TAB_ALIGN = ['left', 'center', 'right', 'decimal'] as const;
const TAB_LEADER = ['none', 'dot', 'hyphen', 'underscore', 'middleDot', 'heavy'] as const;
const TAB_LIMIT = 64;

/** The paragraph properties this command may set, with the check each value must pass. */
const CHECKS = {
  align: (v: unknown) => v === null || (ALIGN as readonly unknown[]).includes(v),
  indentLeft: (v: unknown) => isNullOrInt(v, LENGTH_MIN, LENGTH_MAX),
  indentRight: (v: unknown) => isNullOrInt(v, LENGTH_MIN, LENGTH_MAX),
  indentFirstLine: (v: unknown) => isNullOrInt(v, LENGTH_MIN, LENGTH_MAX),
  spaceBefore: (v: unknown) => isNullOrInt(v, ULENGTH_MIN, ULENGTH_MAX),
  spaceAfter: (v: unknown) => isNullOrInt(v, ULENGTH_MIN, ULENGTH_MAX),
  lineSpacing: (v: unknown) => isNullOrInt(v, 1, 31680),
  lineRule: (v: unknown) => v === null || (LINE_RULE as readonly unknown[]).includes(v),
  keepNext: isNullOrBool,
  keepLines: isNullOrBool,
  pageBreakBefore: isNullOrBool,
  widowControl: isNullOrBool,
  contextualSpacing: isNullOrBool,
  borders: (v: unknown) => v === null || validBorders(v),
  shading: (v: unknown) => v === null || validShading(v),
  tabs: (v: unknown) => v === null || validTabs(v),
} as const;

export type ParagraphFormatKey = keyof typeof CHECKS;

/** The patch: each named property takes the value, `null` clears it (the CDM's default). */
export type ParagraphFormatPatch = Partial<Record<ParagraphFormatKey, unknown>>;

function isNullOrInt(v: unknown, min: number, max: number): boolean {
  return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** One border of the CDM (03 §4.5): a style, and an optional width (eighths of a point), colour and space. */
function validBorder(v: unknown): boolean {
  if (v === null) return true;
  if (!isRecord(v)) return false;
  const allowed = ['style', 'width', 'color', 'space'];
  if (!Object.keys(v).every((k) => allowed.includes(k))) return false;
  if (!(BORDER_STYLES as readonly unknown[]).includes(v['style'])) return false;
  if ('width' in v && !isNullOrInt(v['width'], 0, 240)) return false;
  if ('space' in v && !isNullOrInt(v['space'], 0, 620)) return false;
  return (
    !('color' in v) ||
    v['color'] === null ||
    (typeof v['color'] === 'string' && COLOUR.test(v['color']))
  );
}

function validBorders(v: unknown): boolean {
  if (!isRecord(v)) return false;
  return Object.entries(v).every(
    ([side, border]) => (BORDER_SIDES as readonly string[]).includes(side) && validBorder(border),
  );
}

function validShading(v: unknown): boolean {
  if (!isRecord(v)) return false;
  const keys = Object.keys(v);
  return (
    keys.length === 1 &&
    keys[0] === 'fill' &&
    typeof v['fill'] === 'string' &&
    COLOUR.test(v['fill'])
  );
}

/**
 * The tab stops of a paragraph, as the CDM's grammar has them: a list of at most 64, each with a
 * position from the left margin in twips, an alignment and a leader, and nothing else. The order is
 * the caller's; the ruler and the dialog send them by position, one at a position.
 */
function validTabs(v: unknown): boolean {
  if (!Array.isArray(v) || v.length > TAB_LIMIT) return false;
  return v.every((tab: unknown) => {
    if (!isRecord(tab)) return false;
    const keys = Object.keys(tab);
    return (
      keys.length === 3 &&
      isNullOrInt(tab['position'], ULENGTH_MIN, ULENGTH_MAX) &&
      tab['position'] !== null &&
      (TAB_ALIGN as readonly unknown[]).includes(tab['align']) &&
      (TAB_LEADER as readonly unknown[]).includes(tab['leader'])
    );
  });
}

function isNullOrBool(v: unknown): boolean {
  return v === null || typeof v === 'boolean';
}

/** Whether the patch names only known properties with values in range. */
export function validParagraphFormat(patch: ParagraphFormatPatch): boolean {
  const keys = Object.keys(patch) as ParagraphFormatKey[];
  if (keys.length === 0) return false;
  return keys.every((key) => {
    const check = CHECKS[key] as ((v: unknown) => boolean) | undefined;
    return check !== undefined && check(patch[key]);
  });
}

/**
 * Writes the patch on the selected, editable paragraphs. Unavailable (false, nothing changed) when
 * the patch is not valid or no selected paragraph may be changed; a paragraph that already holds
 * every value is left as it is.
 */
export function setParagraphFormat(
  patch: ParagraphFormatPatch,
  writable: (pos: number) => boolean,
): Command {
  return (state, dispatch) => {
    if (!validParagraphFormat(patch)) return false;
    const targets = selectedParagraphs(state).filter(({ pos }) => writable(pos));
    if (targets.length === 0) return false;
    const keys = Object.keys(patch) as ParagraphFormatKey[];
    const changes: Array<{ pos: number; key: ParagraphFormatKey; value: unknown }> = [];
    for (const { node, pos } of targets as Array<{ node: PMNode; pos: number }>) {
      for (const key of keys) {
        const value = patch[key];
        if (!sameValue(node.attrs[key], value)) changes.push({ pos, key, value });
      }
    }
    if (dispatch && changes.length) {
      const tr = state.tr;
      // An object value is copied, so that the document never shares the caller's object.
      for (const { pos, key, value } of changes)
        tr.setNodeAttribute(
          pos,
          key,
          typeof value === 'object' && value !== null ? structuredClone(value) : value,
        );
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}

/** Equal as JSON values: the object properties (`borders`, `shading`) are compared by content. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || JSON.stringify(a) === JSON.stringify(b);
}
