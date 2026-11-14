/**
 * The accessibility checker's rules (UX-066; 13 section 8; 09 section 13; 03 section 4). The checker
 * reads a plain view of the document (a list of blocks, below) and returns the issues it finds,
 * grouped by kind. It changes nothing: the input is read and never written, and the result is a
 * new value each time.
 *
 * The view is what the core passes to the shell. It carries only what the rules need, so this
 * module imports no document type and the shell never sees the model directly (ADR 0041).
 *
 * Decisions this module makes where the spec is silent (listed in docs/adr/0137-ui-3-backlog-batch.md):
 * - contrast is checked against 4.5 to 1 for every text run, because the view carries no size of
 *   type, so the 3 to 1 threshold for large text cannot be applied;
 * - a heading is a paragraph whose style has an `outlineLevel`, which is the heading level, 1 to 9
 *   (03 section 4.1: `outlineLevel` is 1 to 9 or null; `Heading1` has 1);
 * - the first heading in the document is not compared with anything, so a document may start at
 *   any level;
 * - a link text is non-descriptive when it is empty or is one of a short list of generic phrases;
 * - an image with no alternative text is flagged, because the model has no decorative marking yet.
 */

/** The five kinds of issue in UX-066 criterion 1, in the order the report lists them. */
export const CHECK_KINDS = [
  'alt-text',
  'heading-order',
  'table-header',
  'link-text',
  'contrast',
] as const;

export type CheckKind = (typeof CHECK_KINDS)[number];

/** The contrast ratio a text run must reach against its background (WCAG 2.2, level AA). */
export const CONTRAST_MINIMUM = 4.5;

/** A run of text with the colours the document gives it. Colours are hex, with or without `#`. */
export interface CheckRun {
  readonly text: string;
  /** The run's text colour; null, undefined or `auto` take the default text colour. */
  readonly color?: string | null;
  /**
   * The run's highlight as hex; null, undefined, `auto` or `none` take the paragraph's shading, or
   * the page background when it has none.
   */
  readonly highlight?: string | null;
}

export type CheckBlock =
  | {
      readonly kind: 'paragraph';
      readonly id: string;
      /** The outline level of the paragraph's style, when it has one (see the header). */
      readonly outlineLevel?: number | null;
      /**
       * The shading behind the paragraph as hex: its own, or that of the table cell it is in. Null,
       * undefined, `auto` or `none` take the page background.
       */
      readonly shading?: string | null;
      readonly runs: readonly CheckRun[];
    }
  | { readonly kind: 'image' | 'figure'; readonly id: string; readonly altText?: string | null }
  | { readonly kind: 'table'; readonly id: string; readonly headerRows: number }
  /** A hyperlink's text, under the identifier of the block that holds it. */
  | { readonly kind: 'link'; readonly id: string; readonly text: string };

export interface CheckOptions {
  /** The page background as hex; the default is white. */
  readonly pageBackground?: string;
  /** The text colour when a run gives none; the default is black. */
  readonly defaultTextColor?: string;
}

export interface CheckIssue {
  readonly kind: CheckKind;
  /** The identifier of the block the issue is in (UX-066 criterion 2). */
  readonly blockId: string;
  /**
   * Facts behind the explanation, for the shell to phrase: `from` and `to` for a skipped heading
   * level, `ratio` for a contrast, and `reason` (`empty` or `generic`) for a link text.
   */
  readonly detail: Readonly<Record<string, string | number>>;
}

export interface CheckGroup {
  readonly kind: CheckKind;
  readonly issues: readonly CheckIssue[];
}

export interface CheckReport {
  /** Only the kinds that have issues, in `CHECK_KINDS` order. */
  readonly groups: readonly CheckGroup[];
  readonly count: number;
}

type Rgb = readonly [number, number, number];

/** Generic link texts a reader cannot use out of context (WCAG 2.4.4 practice). */
const GENERIC_LINK_TEXT: ReadonlySet<string> = new Set([
  'click',
  'click here',
  'here',
  'link',
  'this',
  'this link',
  'more',
  'read more',
  'learn more',
  'go',
]);

/** Parses `RRGGBB` or `RGB`, with or without a leading `#`. Anything else is not a colour here. */
export function parseColour(value: string): Rgb | null {
  const match = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value.trim());
  if (!match) return null;
  let hex = match[1]!;
  if (hex.length === 3) hex = [...hex].map((c) => c + c).join('');
  return [
    Number.parseInt(hex.slice(0, 2), 16),
    Number.parseInt(hex.slice(2, 4), 16),
    Number.parseInt(hex.slice(4, 6), 16),
  ];
}

/** WCAG relative luminance of an sRGB colour. */
export function relativeLuminance([r, g, b]: Rgb): number {
  const lin = (c: number): number => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(r) + 0.7152 * lin(g) + 0.0722 * lin(b);
}

/** The WCAG contrast ratio of two colours, from 1 to 21. */
export function contrastRatio(a: Rgb, b: Rgb): number {
  const la = relativeLuminance(a);
  const lb = relativeLuminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

function isAuto(value: string | null | undefined, extra: readonly string[] = []): boolean {
  if (value === null || value === undefined) return true;
  const v = value.trim().toLowerCase();
  return v === '' || v === 'auto' || extra.includes(v);
}

/** Lower case, single spaces, no trailing punctuation: the form a link text is compared in. */
export function normaliseLinkText(text: string): string {
  return text
    .trim()
    .replace(/\s+/g, ' ')
    .toLowerCase()
    .replace(/[.!:]+$/, '');
}

/** Heading level of a paragraph whose style has an outline level from 1 to 9 (03 §4.1), else null. */
export function headingLevelOf(outlineLevel: number | null | undefined): number | null {
  if (typeof outlineLevel !== 'number' || !Number.isInteger(outlineLevel)) return null;
  return outlineLevel >= 1 && outlineLevel <= 9 ? outlineLevel : null;
}

/**
 * Runs the five checks over the blocks, in document order. The input is not changed. A colour that
 * is not hex (for example a named colour) is not evaluated, so its run is not flagged.
 */
export function checkDocument(
  blocks: readonly CheckBlock[],
  options: CheckOptions = {},
): CheckReport {
  const page = parseColour(options.pageBackground ?? '#ffffff');
  const defaultText = parseColour(options.defaultTextColor ?? '#000000');
  if (!page) throw new RangeError('pageBackground must be a hex colour');
  if (!defaultText) throw new RangeError('defaultTextColor must be a hex colour');

  const found = new Map<CheckKind, CheckIssue[]>(CHECK_KINDS.map((k) => [k, []]));
  const add = (issue: CheckIssue): void => {
    found.get(issue.kind)!.push(issue);
  };

  let previousLevel: number | null = null;
  for (const block of blocks) {
    switch (block.kind) {
      case 'image':
      case 'figure': {
        if (block.altText === null || block.altText === undefined || block.altText.trim() === '') {
          add({ kind: 'alt-text', blockId: block.id, detail: {} });
        }
        break;
      }
      case 'table': {
        if (!(block.headerRows >= 1)) {
          add({ kind: 'table-header', blockId: block.id, detail: {} });
        }
        break;
      }
      case 'link': {
        const normal = normaliseLinkText(block.text);
        if (normal === '') {
          add({ kind: 'link-text', blockId: block.id, detail: { reason: 'empty' } });
        } else if (GENERIC_LINK_TEXT.has(normal)) {
          add({ kind: 'link-text', blockId: block.id, detail: { reason: 'generic' } });
        }
        break;
      }
      case 'paragraph': {
        const level = headingLevelOf(block.outlineLevel);
        if (level !== null) {
          if (previousLevel !== null && level > previousLevel + 1) {
            add({
              kind: 'heading-order',
              blockId: block.id,
              detail: { from: previousLevel, to: level },
            });
          }
          previousLevel = level;
        }
        const shaded = isAuto(block.shading, ['none']) ? page : parseColour(block.shading!);
        const worst = shaded ? worstFailingContrast(block.runs, shaded, defaultText) : null;
        if (worst !== null) {
          add({
            kind: 'contrast',
            blockId: block.id,
            detail: { ratio: Math.round(worst * 100) / 100 },
          });
        }
        break;
      }
    }
  }

  const groups: CheckGroup[] = [];
  for (const kind of CHECK_KINDS) {
    const issues = found.get(kind)!;
    if (issues.length > 0) groups.push({ kind, issues });
  }
  return { groups, count: groups.reduce((n, g) => n + g.issues.length, 0) };
}

/**
 * The lowest ratio among the paragraph's text runs that fall below the minimum, or null. `behind`
 * is what shows behind a run without a highlight: the paragraph's shading, or the page.
 */
function worstFailingContrast(
  runs: readonly CheckRun[],
  behind: Rgb,
  defaultText: Rgb,
): number | null {
  let worst: number | null = null;
  for (const run of runs) {
    if (run.text.trim() === '') continue;
    const text = isAuto(run.color) ? defaultText : parseColour(run.color!);
    const background = isAuto(run.highlight, ['none']) ? behind : parseColour(run.highlight!);
    if (!text || !background) continue;
    const ratio = contrastRatio(text, background);
    if (ratio < CONTRAST_MINIMUM && (worst === null || ratio < worst)) worst = ratio;
  }
  return worst;
}
