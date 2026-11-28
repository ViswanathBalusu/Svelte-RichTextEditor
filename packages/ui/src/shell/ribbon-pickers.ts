/**
 * The lists of the ribbon's Home tab (`CommandEntry.picker`; ADR 0490): which choices each offers,
 * what its closed button shows and which choice is the current one. Pure, so that it is tested
 * without a page. The values are the model's, and no more than it allows (03 §4.5, §4.8):
 *
 * - a style is one of the document's paragraph styles, as the styles pane lists them;
 * - a size is an integer in twentieths of a point between 20 and 32,760; the list offers the
 *   sizes of a word processor's size box, and the core refuses anything else;
 * - a text colour is `#RRGGBB` with upper-case letters. The list offers a few dark colours, each
 *   with at least 4.5 to 1 against white, and the choice that takes the colour off (the style's own);
 * - a highlight is one of the sixteen names of 03 §4.8. The list offers the five light ones that
 *   dark text stays readable on, and the choice that takes the highlight off.
 *
 * Only the colour's name is a word; the swatch is drawn from the value, in the choice's `swatch`.
 */
import type { PickerKind } from '../commands/types.ts';
import '../i18n/late/ribbonToolbar.ts';
import type { SelectionSummary, StyleSummary } from '../core-api.ts';
import type { StringKey } from '../i18n/en-GB.ts';

export interface PickerChoice {
  /** Stable within the list (`data-choice`). */
  readonly id: string;
  /** The text of the choice. */
  readonly label: string;
  /** What `exec(command, args)` takes. */
  readonly args: unknown;
  /** A colour to draw beside the label, as CSS. */
  readonly swatch?: string;
  /** True or false when the document says whether this is the current choice; null when it cannot. */
  readonly checked: boolean | null;
}

export interface PickerContext {
  readonly styles: readonly StyleSummary[];
  readonly selection: SelectionSummary;
  /** Resolves a string key of the ribbon's table. */
  readonly text: (key: StringKey) => string;
}

/** The sizes the list offers, in points. */
export const FONT_SIZES_PT: readonly number[] = [
  8, 9, 10, 11, 12, 14, 16, 18, 20, 24, 28, 36, 48, 72,
];

/** The text colours the list offers: a name, and the `#RRGGBB` value (contrast on white at least 4.5 to 1). */
export const TEXT_COLOURS: ReadonlyArray<{
  readonly name: string;
  readonly key: StringKey;
  readonly value: string;
}> = [
  { name: 'darkRed', key: 'ribbon.colour.darkRed', value: '#A4262C' },
  { name: 'darkGreen', key: 'ribbon.colour.darkGreen', value: '#116329' },
  { name: 'darkBlue', key: 'ribbon.colour.darkBlue', value: '#0B5CAD' },
  { name: 'purple', key: 'ribbon.colour.purple', value: '#6B2FA0' },
  { name: 'darkGrey', key: 'ribbon.colour.darkGrey', value: '#595959' },
];

/** The highlights the list offers: the model's name, and the colour the swatch is drawn in. */
export const HIGHLIGHTS: ReadonlyArray<{
  readonly name: string;
  readonly key: StringKey;
  readonly swatch: string;
}> = [
  { name: 'yellow', key: 'ribbon.highlight.yellow', swatch: '#FFFF00' },
  { name: 'green', key: 'ribbon.highlight.green', swatch: '#00FF00' },
  { name: 'cyan', key: 'ribbon.highlight.cyan', swatch: '#00FFFF' },
  { name: 'magenta', key: 'ribbon.highlight.magenta', swatch: '#FF00FF' },
  { name: 'lightGray', key: 'ribbon.highlight.lightGray', swatch: '#D3D3D3' },
];

/** Points as a person writes them: 11, 10.5. */
function points(twips: number): string {
  return String(Math.round((twips / 20) * 100) / 100);
}

/** The paragraph style at the selection, from the list the document gives. */
function currentStyle(context: PickerContext): StyleSummary | null {
  const { selection, styles } = context;
  const paragraph = styles.filter((s) => s.kind === 'paragraph');
  const byId = selection.styleId ? paragraph.find((s) => s.id === selection.styleId) : undefined;
  return byId ?? paragraph.find((s) => s.name === selection.style) ?? null;
}

/** The choices of a list, in the order they are shown. */
export function pickerChoices(kind: PickerKind, context: PickerContext): PickerChoice[] {
  const { text, selection } = context;
  switch (kind) {
    case 'style': {
      const current = currentStyle(context);
      return context.styles
        .filter((s) => s.kind === 'paragraph')
        .map((s) => ({
          id: s.id,
          label: s.name,
          args: { style: s.id, kind: 'paragraph' },
          checked: current?.id === s.id,
        }));
    }
    case 'fontSize':
      return [
        ...FONT_SIZES_PT.map((pt) => ({
          id: String(pt),
          label: String(pt),
          args: { value: pt * 20 },
          checked: selection.fontSize === pt * 20,
        })),
        { id: 'default', label: text('ribbon.size.default'), args: { value: null }, checked: null },
      ];
    case 'colour':
      return [
        {
          id: 'automatic',
          label: text('ribbon.colour.automatic'),
          args: { value: null },
          checked: null,
        },
        ...TEXT_COLOURS.map(({ name, key, value }) => ({
          id: name,
          label: text(key),
          args: { value },
          swatch: value,
          checked: null,
        })),
      ];
    case 'highlight':
      return [
        { id: 'none', label: text('ribbon.highlight.none'), args: { value: null }, checked: null },
        ...HIGHLIGHTS.map(({ name, key, swatch }) => ({
          id: name,
          label: text(key),
          args: { value: name },
          swatch,
          checked: null,
        })),
      ];
  }
}

/** What a closed list shows: the current style's name, the current size in points, or nothing. */
export function pickerSummary(kind: PickerKind, context: PickerContext): string | null {
  if (kind === 'style') return currentStyle(context)?.name ?? context.selection.style;
  if (kind === 'fontSize') {
    const size = context.selection.fontSize;
    return typeof size === 'number' ? points(size) : null;
  }
  return null;
}
