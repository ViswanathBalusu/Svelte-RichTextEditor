/**
 * Header and footer growth (03 §7, "Header growth"; CDM-045). The page setup gives a header the
 * space between `headerDistance` (from the top edge) and `marginTop`; a header taller than that
 * pushes the body down, so the body starts at the larger of `marginTop` and
 * `headerDistance + header height`. Footers grow the same way upwards (ADR 0032): the body ends at
 * the smaller of `height - marginBottom` and `height - footerDistance - footer height`.
 *
 * The header's height is the height of its story laid out at the page's text width, with the
 * first paragraph's `spaceBefore` and the last one's `spaceAfter` included (ADR 0032: containers
 * keep their edge spacing). The layout engine and the LaTeX class measure it; this module only
 * states where the body goes. Which story a page shows is `headerFor` and `footerFor`; which page
 * is the first of its section, and which pages are even, is pagination's.
 */
import type { JsonValue } from '../definition/grammar.ts';
import { indexDefinition } from '../definition/index.ts';
import type { Attrs } from '../cascade/styles.ts';

const GEOMETRY = [
  'width',
  'height',
  'marginTop',
  'marginBottom',
  'headerDistance',
  'footerDistance',
] as const;

export type PageGeometry = Readonly<Record<(typeof GEOMETRY)[number], number>>;

let defaults: PageGeometry | undefined;

/** The page setup's lengths, with the definition's defaults for those it omits (CDM-002). */
export function pageGeometry(pageSetup: Attrs | undefined): PageGeometry {
  if (!defaults) {
    const attrs = indexDefinition().nodes.get('page_setup')!.attrs;
    const d = (name: string): JsonValue => attrs[name]!.default;
    defaults = Object.freeze(
      Object.fromEntries(GEOMETRY.map((k) => [k, d(k) as number])) as Record<
        (typeof GEOMETRY)[number],
        number
      >,
    );
  }
  const base = defaults;
  return Object.fromEntries(
    GEOMETRY.map((k) => {
      const v = pageSetup?.[k];
      return [k, typeof v === 'number' ? v : base[k]];
    }),
  ) as PageGeometry;
}

export interface BodyFrame {
  /** Where the body starts, in twips from the top edge of the page. */
  readonly top: number;
  /** Where the body ends, in twips from the top edge of the page. */
  readonly bottom: number;
  /** `bottom - top`, never below 0. */
  readonly height: number;
  readonly headerPushes: boolean;
  readonly footerPushes: boolean;
  /**
   * The page on which the first body line stands, counted from 1: 2 when the header and footer
   * leave no room for the body, because the first page is then shipped empty and the body starts
   * on the next page, as the LaTeX class does (owner decision 77).
   */
  readonly startsOnPage: 1 | 2;
}

/** Where the body of a page goes, given the measured heights of its header and footer in twips. */
export function bodyFrame(
  pageSetup: Attrs | undefined,
  measured: { readonly headerHeight: number; readonly footerHeight: number },
): BodyFrame {
  const g = pageGeometry(pageSetup);
  const headerBottom = g.headerDistance + measured.headerHeight;
  const footerTop = g.height - g.footerDistance - measured.footerHeight;
  const top = Math.max(g.marginTop, headerBottom);
  const bottom = Math.min(g.height - g.marginBottom, footerTop);
  return {
    top,
    bottom,
    height: Math.max(0, bottom - top),
    headerPushes: headerBottom > g.marginTop,
    footerPushes: footerTop < g.height - g.marginBottom,
    startsOnPage: bottom - top > 0 ? 1 : 2,
  };
}

export interface PageSlot {
  /** The first page of its page section (the first page after a break that starts a new page). */
  readonly firstOfSection: boolean;
  /** An even page, as pagination numbers pages. */
  readonly even: boolean;
}

function slot(
  pageSetup: Attrs | undefined,
  page: PageSlot,
  names: readonly [string, string, string],
): string | null {
  const [first, even, other] = names;
  const pick = (name: string): string | null => {
    const v = pageSetup?.[name];
    return typeof v === 'string' ? v : null;
  };
  if (page.firstOfSection && pageSetup?.['differentFirstPage'] === true) return pick(first);
  if (page.even && pageSetup?.['differentOddEven'] === true) return pick(even);
  return pick(other);
}

/**
 * The header story a page shows, or null for none. A null slot means no header on those pages; it
 * does not fall back to another slot (ADR 0032).
 */
export function headerFor(pageSetup: Attrs | undefined, page: PageSlot): string | null {
  return slot(pageSetup, page, ['headerFirst', 'headerEven', 'headerDefault']);
}

/** The footer story a page shows, or null for none. */
export function footerFor(pageSetup: Attrs | undefined, page: PageSlot): string | null {
  return slot(pageSetup, page, ['footerFirst', 'footerEven', 'footerDefault']);
}
