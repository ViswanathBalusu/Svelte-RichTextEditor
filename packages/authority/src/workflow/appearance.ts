/**
 * The visible signature appearances at the field positions (12 §12; 09 §7.1, §9.3; FRW-057), as a
 * pure planner. The signing service draws the appearances after the compile, so the two-compile
 * comparison of EXP-079 does not see them. This module decides which rectangles may be drawn.
 *
 * - `validateLayout` checks the `fields` part of `layout.json` before anything uses it (09 §9.3:
 *   the file is validated against its schema before use). Each entry needs a page number and a
 *   rectangle `[x0, y0, x1, y1]` of finite numbers with `x0 < x1` and `y0 < y1`. Entries that fail
 *   are not used; they are reported. The full schema of the file is the export's (EXP) and is not
 *   checked here.
 * - `planAppearances` gives one appearance for each signature and initials field whose rectangle
 *   lies inside the bounds of its page (the page size is supplied by the caller, from the compiled
 *   PDF). A rectangle outside the page is not used.
 * - A field with no usable rectangle gets no appearance and a diagnostic, and the appearances of
 *   the other fields are kept. The plan has no refusal: whether the seal is applied is the signing
 *   service's decision, which is not built (FRW-057 criterion 6 stays open until it seals with
 *   this plan).
 *
 * Not built here: writing the appearance into the PDF, the content of an appearance (the adopted
 * image, the name, the date), and whether an appearance belongs to the participant or to the seal
 * (FRW-057 Notes; Open questions 25). The layout file itself is written by the export (FRW-057
 * criterion 1).
 */

/** The four numbers of a rectangle in PDF user space: lower-left and upper-right corners. */
export type Rect = readonly [number, number, number, number];

/** The kinds of field that receive a visible appearance (FRW-057 criterion 2). */
export type AppearanceKind = 'signature' | 'initials';

/** A field of the document that may receive an appearance. */
export interface AppearanceTarget {
  /** The field identifier, as `layout.json` names it. */
  readonly id: string;
  /** The field key, as the document names it. */
  readonly key: string;
  readonly kind: string;
}

/** The size of one page of the compiled PDF, in the same units as the rectangles. */
export interface PageBounds {
  readonly page: number;
  readonly width: number;
  readonly height: number;
}

export interface LayoutEntry {
  readonly page: number;
  readonly rect: Rect;
}

export type LayoutCheck =
  | {
      readonly ok: true;
      readonly fields: ReadonlyMap<string, LayoutEntry>;
      readonly problems: readonly LayoutProblem[];
    }
  | { readonly ok: false; readonly reason: string };

export interface LayoutProblem {
  readonly id: string;
  readonly code: 'entry_invalid';
  readonly reason: string;
}

export interface AppearanceDiagnostic {
  readonly id: string;
  readonly key: string;
  readonly code:
    'no_rectangle' | 'entry_invalid' | 'rect_outside_page' | 'unknown_page' | 'layout_invalid';
  readonly reason: string;
}

export interface AppearancePlanned {
  readonly id: string;
  readonly key: string;
  readonly kind: AppearanceKind;
  readonly page: number;
  readonly rect: Rect;
}

export interface AppearancePlan {
  /** The appearances the signing service may draw, in the order of `targets`. */
  readonly appearances: readonly AppearancePlanned[];
  /** One entry for each target that gets no appearance, and for each layout problem. */
  readonly diagnostics: readonly AppearanceDiagnostic[];
}

const APPEARANCE_KINDS: ReadonlySet<string> = new Set<AppearanceKind>(['signature', 'initials']);

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPageNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 1;
}

function isRect(v: unknown): v is Rect {
  if (!Array.isArray(v) || v.length !== 4) return false;
  if (!v.every((n) => typeof n === 'number' && Number.isFinite(n))) return false;
  const [x0, y0, x1, y1] = v as [number, number, number, number];
  return x0 < x1 && y0 < y1;
}

/**
 * Checks the `fields` part of a parsed `layout.json`. A file without a `fields` object is refused
 * as a whole; a single bad entry is dropped and reported, and the other entries are kept.
 */
export function validateLayout(layout: unknown): LayoutCheck {
  if (!isRecord(layout)) return { ok: false, reason: 'layout is not an object' };
  const fields = layout['fields'];
  if (!isRecord(fields)) return { ok: false, reason: 'layout has no fields object' };
  const entries = new Map<string, LayoutEntry>();
  const problems: LayoutProblem[] = [];
  for (const id of Object.keys(fields)) {
    const raw = fields[id];
    if (!isRecord(raw)) {
      problems.push({ id, code: 'entry_invalid', reason: 'entry is not an object' });
      continue;
    }
    if (!isPageNumber(raw['page'])) {
      problems.push({ id, code: 'entry_invalid', reason: 'page is not a positive integer' });
      continue;
    }
    if (!isRect(raw['rect'])) {
      problems.push({
        id,
        code: 'entry_invalid',
        reason: 'rect is not [x0, y0, x1, y1] with x0 < x1 and y0 < y1',
      });
      continue;
    }
    entries.set(id, { page: raw['page'], rect: raw['rect'] });
  }
  return { ok: true, fields: entries, problems };
}

function insidePage(rect: Rect, bounds: PageBounds): boolean {
  const [x0, y0, x1, y1] = rect;
  return x0 >= 0 && y0 >= 0 && x1 <= bounds.width && y1 <= bounds.height;
}

/**
 * The appearances to draw for `targets` on the layout `layout` (already parsed), given the page
 * sizes. Only signature and initials targets get an appearance; other targets are skipped without a
 * diagnostic, because no appearance is wanted for them.
 */
export function planAppearances(
  layout: unknown,
  targets: readonly AppearanceTarget[],
  pages: readonly PageBounds[],
): AppearancePlan {
  const checked = validateLayout(layout);
  const sizes = new Map<number, PageBounds>();
  for (const p of pages) sizes.set(p.page, p);
  const appearances: AppearancePlanned[] = [];
  const diagnostics: AppearanceDiagnostic[] = [];
  const wanted = targets.filter((t) => APPEARANCE_KINDS.has(t.kind));
  if (!checked.ok) {
    for (const t of wanted)
      diagnostics.push({
        id: t.id,
        key: t.key,
        code: 'layout_invalid',
        reason: `layout.json was not used: ${checked.reason}`,
      });
    return { appearances, diagnostics };
  }
  for (const p of checked.problems)
    diagnostics.push({
      id: p.id,
      key: '',
      code: 'entry_invalid',
      reason: `layout entry not used: ${p.reason}`,
    });
  for (const t of wanted) {
    const entry = checked.fields.get(t.id);
    if (entry === undefined) {
      diagnostics.push({
        id: t.id,
        key: t.key,
        code: 'no_rectangle',
        reason: 'no rectangle in layout.json',
      });
      continue;
    }
    const bounds = sizes.get(entry.page);
    if (bounds === undefined) {
      diagnostics.push({
        id: t.id,
        key: t.key,
        code: 'unknown_page',
        reason: 'the page of the field is not in the compiled PDF',
      });
      continue;
    }
    if (!insidePage(entry.rect, bounds)) {
      diagnostics.push({
        id: t.id,
        key: t.key,
        code: 'rect_outside_page',
        reason: 'the rectangle lies outside its page and is not used',
      });
      continue;
    }
    appearances.push({
      id: t.id,
      key: t.key,
      kind: t.kind as AppearanceKind,
      page: entry.page,
      rect: entry.rect,
    });
  }
  return { appearances, diagnostics };
}
