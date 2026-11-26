/**
 * What the paragraph dialog shows and the patch it makes (UX-102 criterion 3; 02 §10; FE-104,
 * FE-129): the keyboard form of every drag on the ruler. It sets the same indents and tab stops
 * through the same `setParagraphFormat` command, so a change made here is the change the ruler's
 * drag would make. No DOM here.
 *
 * Lengths are typed in centimetres and stored in twips. A field left blank keeps what the selected
 * paragraphs have; a blank field for a value they share means 0.
 */
import type { ParagraphFormatView, TabStopView } from '../core-api.ts';
import { MAX_TABS, MAX_TWIPS, centimetres, fromCentimetres, normaliseTabs } from './ruler.ts';

export interface TabRow {
  /** Centimetres, as typed. */
  position: string;
  align: TabStopView['align'];
  leader: TabStopView['leader'];
}

export interface DialogFields {
  left: string;
  right: string;
  firstLine: string;
  tabs: TabRow[];
}

export type DialogField = 'left' | 'right' | 'firstLine' | `tab${number}`;

/** What the dialog starts with: a value the paragraphs do not share is left blank. */
export function dialogFields(format: ParagraphFormatView): DialogFields {
  const text = (twips: number | null): string => (twips === null ? '' : String(centimetres(twips)));
  return {
    left: text(format.indentLeft),
    right: text(format.indentRight),
    firstLine: text(format.indentFirstLine),
    tabs: (format.tabs ?? []).map((t) => ({
      position: String(centimetres(t.position)),
      align: t.align,
      leader: t.leader,
    })),
  };
}

/** A typed number of centimetres; accepts a decimal comma. Null when it is not a number. */
export function parseCentimetres(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '' || !/^[+-]?(\d+\.?\d*|\.\d+)$/.test(trimmed)) return null;
  return fromCentimetres(Number(trimmed));
}

export interface DialogResult {
  /** The patch for `setParagraphFormat`; null when nothing changes. */
  readonly patch: Record<string, unknown> | null;
  /** The fields that do not hold a length the CDM can store. */
  readonly invalid: readonly DialogField[];
}

const within = (twips: number, min: number, max: number): boolean => twips >= min && twips <= max;

/**
 * The patch that takes the paragraphs from `format` to the dialog's fields: only what changed. A
 * value the paragraphs did not share is written when its field is filled in, and kept when blank.
 */
export function dialogPatch(format: ParagraphFormatView, fields: DialogFields): DialogResult {
  const patch: Record<string, unknown> = {};
  const invalid: DialogField[] = [];
  const indents = [
    ['left', 'indentLeft', fields.left, format.indentLeft],
    ['right', 'indentRight', fields.right, format.indentRight],
    ['firstLine', 'indentFirstLine', fields.firstLine, format.indentFirstLine],
  ] as const;
  for (const [field, key, text, was] of indents) {
    if (text.trim() === '') {
      if (was === null) continue; // the paragraphs differ and the field was left blank: keep each
      if (was !== 0) patch[key] = 0;
      continue;
    }
    const twips = parseCentimetres(text);
    const least = field === 'firstLine' ? -MAX_TWIPS : 0;
    if (twips === null || !within(twips, least, MAX_TWIPS)) invalid.push(field);
    else if (twips !== was) patch[key] = twips;
  }
  const tabs: TabStopView[] = [];
  fields.tabs.forEach((row, i) => {
    const position = parseCentimetres(row.position);
    if (position === null || !within(position, 0, MAX_TWIPS)) invalid.push(`tab${i}`);
    else tabs.push({ position, align: row.align, leader: row.leader });
  });
  if (fields.tabs.length > MAX_TABS) invalid.push(`tab${MAX_TABS}`);
  if (invalid.length === 0) {
    const next = normaliseTabs(tabs);
    const before = normaliseTabs(format.tabs ?? []);
    if (
      JSON.stringify(next) !== JSON.stringify(before) ||
      (format.tabs === null && next.length > 0)
    )
      patch['tabs'] = next.length === 0 ? null : next;
  }
  return { patch: invalid.length === 0 && Object.keys(patch).length > 0 ? patch : null, invalid };
}
