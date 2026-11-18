/**
 * Editable ranges of a Word file as regions (EXP-104; 07 section 15; 03 section 8, I3).
 *
 * Word marks the parts of a protected document that anyone may edit with `w:permStart` and
 * `w:permEnd`. This module plans which blocks of the body become a region:
 *
 * - A range whose two markers are children of the body and that holds whole blocks becomes an
 *   open region (policy `inherit`, no grants).
 * - A range that starts or ends inside a paragraph, inside a table, or is a column range of a
 *   table, cannot be an open region. The blocks that hold it become a locked region (policy
 *   `restricted`, no grants), and the importer reports it with its location. Owner decision 53
 *   (2026-11-17): protected parts become locked regions that the owner can unlock.
 * - Ranges that overlap or nest are merged into one region (a region never nests, I3), and the
 *   importer names them in a warning. If any range of the group is locked, the group is locked.
 * - A range that crosses a section break, or has no end, is not made a region: its markers stay
 *   as preserved content.
 *
 * The planner reads the XML only. It decides nothing about the document's own protection settings
 * (`w:documentProtection`), whose password is never carried over.
 */
import { NS, w } from './ooxml.ts';
import { attr, elements, nameOf, type XmlElement } from './xml.ts';

const PERM_START = w('permStart');
const PERM_END = w('permEnd');
const SECT_PR = w('sectPr');
const P_PR = w('pPr');

/** One region to build: a run of consecutive body blocks. */
export interface RegionPlan {
  /** The first and the last block element of the region, in body order. */
  first: XmlElement;
  last: XmlElement;
  /** The `w:id` of every editable range that the region stands for. */
  ids: string[];
  /** The `w:ed` and `w:edGrp` values of those ranges, for the report. */
  editors: string[];
  /** True: policy `restricted`; false: policy `inherit`. */
  locked: boolean;
  /** Why a locked region is locked, or why ranges were merged, for the warning text. */
  reason: string;
  /** Zero-based positions of the first and the last block among the body's blocks. */
  from: number;
  to: number;
}

/** What the planner could not turn into a region, with the reason, for the report. */
export interface RegionRefusal {
  ids: string[];
  reason: string;
}

export interface RegionPlanResult {
  plans: RegionPlan[];
  refused: RegionRefusal[];
}

interface Marker {
  el: XmlElement;
  id: string;
  /** Order of the marker in the document. */
  order: number;
  /** The index of the body block that holds it; for a body-level marker, see `bodyLevel`. */
  block: number;
  bodyLevel: boolean;
}

/** Whether a block element of the body holds section properties (it ends a section). */
function holdsSectPr(el: XmlElement): boolean {
  if (nameOf(el) !== w('p')) return false;
  const pPr = elements(el).find((c) => nameOf(c) === P_PR);
  return !!pPr && elements(pPr).some((c) => nameOf(c) === SECT_PR);
}

/**
 * Plans the regions of a body. `blocks` are the body's block elements in order (not markers and
 * not the final `w:sectPr`); `children` are all the body's child elements in order.
 */
export function planRegions(
  children: readonly XmlElement[],
  blocks: readonly XmlElement[],
  isMarker: (el: XmlElement) => boolean,
): RegionPlanResult {
  const index = new Map<XmlElement, number>();
  blocks.forEach((b, i) => index.set(b, i));
  const starts = new Map<string, Marker>();
  const ends = new Map<string, Marker>();
  const duplicate = new Set<string>();
  let order = 0;
  let seen = 0;

  const note = (map: Map<string, Marker>, m: Marker): void => {
    if (map.has(m.id)) duplicate.add(m.id);
    else map.set(m.id, m);
  };
  // Pre-order and iterative: a hostile file can nest elements deeper than the call stack allows.
  const walk = (top: XmlElement, block: number): void => {
    const stack: XmlElement[] = [top];
    while (stack.length) {
      const el = stack.pop()!;
      const name = nameOf(el);
      if (name === PERM_START || name === PERM_END) {
        const id = attr(el, NS.w, 'id');
        if (id !== undefined)
          note(name === PERM_START ? starts : ends, {
            el,
            id,
            order: order++,
            block,
            bodyLevel: false,
          });
      }
      const kids = elements(el);
      for (let i = kids.length - 1; i >= 0; i--) stack.push(kids[i]!);
    }
  };
  for (const c of children) {
    if (index.has(c)) {
      seen = index.get(c)! + 1;
      walk(c, seen - 1);
    } else if (isMarker(c)) {
      const name = nameOf(c);
      if (name === PERM_START || name === PERM_END) {
        const id = attr(c, NS.w, 'id');
        // A body-level start belongs to the next block; an end, to the block before it.
        if (id !== undefined)
          note(name === PERM_START ? starts : ends, {
            el: c,
            id,
            order: order++,
            block: name === PERM_START ? seen : seen - 1,
            bodyLevel: true,
          });
      } else {
        // Other markers can hold no permission range.
      }
    }
  }

  interface Span {
    from: number;
    to: number;
    ids: string[];
    editors: string[];
    locked: boolean;
    reasons: string[];
  }
  const spans: Span[] = [];
  const refused: RegionRefusal[] = [];
  for (const [id, s] of starts) {
    const e = ends.get(id);
    if (duplicate.has(id) || !e || e.order < s.order) {
      refused.push({
        ids: [id],
        reason: duplicate.has(id)
          ? 'its identifier is used by more than one range'
          : 'it has no end after its start',
      });
      continue;
    }
    const column =
      attr(s.el, NS.w, 'colFirst') !== undefined || attr(s.el, NS.w, 'colLast') !== undefined;
    const open = s.bodyLevel && e.bodyLevel && !column;
    const from = s.block;
    const to = e.block;
    if (from < 0 || to >= blocks.length || from > to) {
      refused.push({ ids: [id], reason: 'it holds no block' });
      continue;
    }
    const editor = [attr(s.el, NS.w, 'ed'), attr(s.el, NS.w, 'edGrp')].filter(
      (x): x is string => x !== undefined,
    );
    spans.push({
      from,
      to,
      ids: [id],
      editors: editor,
      locked: !open,
      reasons: open
        ? []
        : [
            column
              ? 'it is a column range of a table'
              : 'it starts or ends inside a paragraph or a table',
          ],
    });
  }
  // Ends without a start.
  for (const id of ends.keys())
    if (!starts.has(id) && !duplicate.has(id))
      refused.push({ ids: [id], reason: 'it has no start' });

  // Flatten: overlapping and nested ranges become one span (I3: a region never nests).
  spans.sort((a, b) => a.from - b.from || b.to - a.to);
  const merged: Span[] = [];
  for (const s of spans) {
    const cur = merged[merged.length - 1];
    if (cur && s.from <= cur.to) {
      cur.to = Math.max(cur.to, s.to);
      cur.ids.push(...s.ids);
      cur.editors.push(...s.editors);
      cur.locked = cur.locked || s.locked;
      cur.reasons.push(...s.reasons);
      if (!cur.reasons.includes('it overlaps or nests with another range'))
        cur.reasons.push('it overlaps or nests with another range');
    } else merged.push({ ...s, ids: [...s.ids], editors: [...s.editors], reasons: [...s.reasons] });
  }

  const plans: RegionPlan[] = [];
  for (const m of merged) {
    const span = blocks.slice(m.from, m.to + 1);
    if (span.some(holdsSectPr)) {
      refused.push({ ids: m.ids, reason: 'it crosses a section break' });
      continue;
    }
    plans.push({
      first: span[0]!,
      last: span[span.length - 1]!,
      ids: m.ids,
      editors: [...new Set(m.editors)],
      locked: m.locked,
      reason: [...new Set(m.reasons)].join('; '),
      from: m.from,
      to: m.to,
    });
  }
  return { plans, refused };
}
