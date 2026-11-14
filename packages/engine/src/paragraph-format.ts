/**
 * Paragraph format command (FE-129 criteria 1 and 3, the storage half; 03 §4.5, §7).
 *
 * `setParagraphFormat` writes a patch of paragraph properties onto every selected paragraph the
 * user may edit. Each value is checked against the CDM's own range before anything changes: an
 * unknown property, an out-of-range integer or an unknown enumeration makes the command unavailable
 * and changes nothing. The properties are the ones `paragraphProps` in `packages/model`
 * (cdm1.ts) defines, except `tabs` and `borders`/`shading`, which have their own criteria (2 and 5).
 *
 * This module stores the values. The web view does not show them yet, so FE-129 criterion 1 stays
 * unticked; see the story's Notes.
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
} as const;

export type ParagraphFormatKey = keyof typeof CHECKS;

/** The patch: each named property takes the value, `null` clears it (the CDM's default). */
export type ParagraphFormatPatch = Partial<Record<ParagraphFormatKey, unknown>>;

function isNullOrInt(v: unknown, min: number, max: number): boolean {
  return v === null || (typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max);
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
        if (node.attrs[key] !== value) changes.push({ pos, key, value });
      }
    }
    if (dispatch && changes.length) {
      const tr = state.tr;
      for (const { pos, key, value } of changes) tr.setNodeAttribute(pos, key, value);
      dispatch(tr.scrollIntoView());
    }
    return true;
  };
}
