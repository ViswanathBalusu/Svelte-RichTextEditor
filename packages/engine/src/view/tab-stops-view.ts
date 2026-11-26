/**
 * Tab stops in the web view (FE-129 criterion 2; 03 §7.4; 02 §7).
 *
 * A paragraph that stores tab stops (`tabs`, set by the paragraph dialog and the ruler) draws each
 * tab of its text up to the stop that 03 §7.4 picks, with the leader the stop names. The width of
 * the tab is set on the `tab` element's own box through the CSSOM (never as a `style` attribute,
 * which a strict content security policy blocks).
 *
 * - `nextTabStop` and `tabWidth` are the pure part: the stop a tab at a position moves to, and how
 *   wide the tab is for that stop and the text after it. Positions and widths are twips from the
 *   left margin of the paragraph's container.
 * - `tabStopsPlugin` is the view part: after the DOM is brought up to date it measures each tab
 *   from left to right (a tab moves what follows it) and sets its width.
 *
 * Proposed readings are in docs/adr/0426-w1-FE-129-tab-stops-and-paragraph-dialog.md: a paragraph
 * with no stop of its own keeps the browser's tab; stops a paragraph style gives are not drawn; a
 * right-to-left paragraph keeps the browser's tab; a CSS pixel is 15 twips.
 */
import { Plugin } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import {
  tabStopsOf,
  type TabAlign,
  type TabLeader,
  type TabStopInfo,
} from '../paragraph-format-info.ts';
import { defaultTabStopOf } from '../paragraph-indent.ts';

/** The twips in one CSS pixel (96 pixels to the inch, 1440 twips to the inch). */
export const TWIPS_PER_PIXEL = 15;

export interface TabLayout {
  /** The paragraph's own stops, by position. */
  readonly stops: readonly TabStopInfo[];
  readonly indentLeft: number;
  /** From the left indent; negative for a hanging indent. */
  readonly indentFirstLine: number;
  /** `settings.defaultTabStop`. */
  readonly defaultTabStop: number;
}

export interface ChosenStop {
  readonly position: number;
  readonly align: TabAlign;
  readonly leader: TabLeader;
  readonly kind: 'explicit' | 'hanging' | 'default';
}

const RANK = { explicit: 0, hanging: 1, default: 2 } as const;

/**
 * The stop a tab at `x` moves to (03 §7.4): the nearest of the first explicit stop to the right of
 * `x`, the left indent when the paragraph hangs, and the next multiple of the default interval to
 * the right of `x` and of the last explicit stop. At one position an explicit stop wins over the
 * stop of a hanging indent, and that over a default stop. Null when no interval is set.
 */
export function nextTabStop(layout: TabLayout, x: number): ChosenStop | null {
  const candidates: ChosenStop[] = [];
  const explicit = layout.stops.find((stop) => stop.position > x);
  if (explicit) candidates.push({ ...explicit, kind: 'explicit' });
  if (layout.indentFirstLine < 0 && layout.indentLeft > x)
    candidates.push({
      position: layout.indentLeft,
      align: 'left',
      leader: 'none',
      kind: 'hanging',
    });
  const step = layout.defaultTabStop;
  if (step > 0) {
    const last = layout.stops[layout.stops.length - 1]?.position ?? 0;
    const from = Math.max(x, last);
    candidates.push({
      position: (Math.floor(from / step) + 1) * step,
      align: 'left',
      leader: 'none',
      kind: 'default',
    });
  }
  let best: ChosenStop | null = null;
  for (const c of candidates) {
    if (
      best === null ||
      c.position < best.position ||
      (c.position === best.position && RANK[c.kind] < RANK[best.kind])
    )
      best = c;
  }
  return best;
}

/** The text after a tab, up to the next tab, line break or the end of the paragraph. */
export interface Segment {
  /** Its width; null when it runs over a line end, so that it does not fit. */
  readonly width: number | null;
  /** The width of the part before the first decimal separator; the width when it has none. */
  readonly beforeDecimal: number | null;
}

/**
 * How wide a tab at `x` is for `stop`: a left stop starts the segment at the stop, a right stop
 * ends it there, a centre stop centres it there (half the width rounded down) and a decimal stop
 * puts the first decimal separator there. A segment that does not fit starts at the current
 * position, so the tab is 0 wide.
 */
export function tabWidth(stop: ChosenStop, x: number, segment: Segment): number {
  const room = stop.position - x;
  if (stop.align === 'left') return Math.max(0, room);
  if (segment.width === null) return 0;
  let used = segment.width;
  if (stop.align === 'center') used = Math.floor(segment.width / 2);
  else if (stop.align === 'decimal') used = segment.beforeDecimal ?? segment.width;
  return Math.max(0, room - used);
}

/** The CSS of a leader: a repeating mark along the baseline of the tab's box; null for none. */
export function leaderCss(leader: TabLeader): string | null {
  switch (leader) {
    case 'dot':
      return 'radial-gradient(circle at 50% 85%, currentColor 0.055em, transparent 0.065em) 0 0 / 0.3em 100% repeat-x';
    case 'middleDot':
      return 'radial-gradient(circle at 50% 55%, currentColor 0.055em, transparent 0.065em) 0 0 / 0.3em 100% repeat-x';
    case 'hyphen':
      return 'linear-gradient(to right, currentColor 0.35em, transparent 0.35em) 0 80% / 0.6em 1px repeat-x';
    case 'underscore':
      return 'linear-gradient(currentColor, currentColor) 0 90% / 100% 1px no-repeat';
    case 'heavy':
      return 'linear-gradient(currentColor, currentColor) 0 90% / 100% 2px no-repeat';
    default:
      return null;
  }
}

/** Marks a tab element whose width this view has set, so that it can be taken back. */
export const TAB_DRAWN = 'data-de-tab-stop';

const PROPS = ['display', 'width', 'background'] as const;

function clearTab(el: HTMLElement): void {
  if (!el.hasAttribute(TAB_DRAWN)) return;
  for (const p of PROPS) el.style.removeProperty(p);
  el.removeAttribute(TAB_DRAWN);
}

function length(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) ? v : 0;
}

/** The point of the segment's text at `index` characters from its start. */
function pointAt(range: Range, index: number): { node: Node; offset: number } | null {
  const root = range.commonAncestorContainer;
  const walker = document.createTreeWalker(
    root.nodeType === Node.TEXT_NODE ? (root.parentNode ?? root) : root,
    NodeFilter.SHOW_TEXT,
  );
  let counted = 0;
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    if (!range.intersectsNode(n)) continue;
    const text = n as Text;
    const from = n === range.startContainer ? range.startOffset : 0;
    const to = n === range.endContainer ? range.endOffset : text.length;
    if (to <= from) continue;
    if (index < counted + (to - from)) return { node: n, offset: from + index - counted };
    counted += to - from;
  }
  return null;
}

/** Measures the segment after a tab. `pixels` converts a width in CSS pixels to twips. */
function measureSegment(
  tab: HTMLElement,
  next: Element | undefined,
  container: HTMLElement,
  toTwips: (px: number) => number,
): Segment {
  const range = document.createRange();
  range.setStartAfter(tab);
  if (next) range.setEndBefore(next);
  else range.setEnd(container, container.childNodes.length);
  const rects = Array.from(range.getClientRects()).filter((r) => r.width > 0 || r.height > 0);
  if (rects.length === 0) return { width: 0, beforeDecimal: 0 };
  const tops = rects.map((r) => Math.round(r.top));
  if (tops.some((t) => Math.abs(t - (tops[0] ?? 0)) > 2))
    return { width: null, beforeDecimal: null };
  const box = range.getBoundingClientRect();
  const width = toTwips(box.width);
  const at = range.toString().indexOf('.');
  if (at < 0) return { width, beforeDecimal: width };
  const point = pointAt(range, at);
  if (!point) return { width, beforeDecimal: width };
  const before = range.cloneRange();
  before.setEnd(point.node, point.offset);
  return { width, beforeDecimal: toTwips(before.getBoundingClientRect().width) };
}

/** Sets the width of every tab of the view that a paragraph's own stops govern. */
export function layoutTabs(view: EditorView): void {
  const tabs = Array.from(view.dom.querySelectorAll<HTMLElement>('.de-doc-tab'));
  if (tabs.length === 0) return;
  const defaultTabStop = defaultTabStopOf(view.state.doc);
  const byParagraph = new Map<
    HTMLElement,
    { attrs: Readonly<Record<string, unknown>>; tabs: HTMLElement[] }
  >();
  for (const tab of tabs) {
    let found: { el: HTMLElement; attrs: Readonly<Record<string, unknown>> } | null = null;
    try {
      const $pos = view.state.doc.resolve(view.posAtDOM(tab, 0));
      const el = view.nodeDOM($pos.before());
      if ($pos.parent.type.name === 'paragraph' && el instanceof HTMLElement)
        found = { el, attrs: $pos.parent.attrs };
    } catch {
      // The position is gone with the node (a change in flight): the next update draws it.
    }
    if (!found) {
      clearTab(tab);
      continue;
    }
    const entry = byParagraph.get(found.el) ?? { attrs: found.attrs, tabs: [] };
    entry.tabs.push(tab);
    byParagraph.set(found.el, entry);
  }
  for (const [paragraph, { attrs, tabs: own }] of byParagraph) {
    const stops = tabStopsOf(attrs);
    const style = getComputedStyle(paragraph);
    if (stops.length === 0 || style.direction === 'rtl') {
      for (const tab of own) clearTab(tab);
      continue;
    }
    const layout: TabLayout = {
      stops,
      indentLeft: length(attrs['indentLeft']),
      indentFirstLine: length(attrs['indentFirstLine']),
      defaultTabStop,
    };
    const box = paragraph.getBoundingClientRect();
    // A scale on an ancestor (a zoomed view) shows as a width that differs from the layout width.
    const scale = paragraph.offsetWidth > 0 ? box.width / paragraph.offsetWidth : 1;
    const toTwips = (px: number): number => Math.round((px / scale) * TWIPS_PER_PIXEL);
    const origin = box.left - (Number.parseFloat(style.marginLeft) || 0) * scale;
    const breaks = Array.from(paragraph.querySelectorAll('.de-doc-tab, br'));
    for (const tab of own) {
      const x = toTwips(tab.getBoundingClientRect().left - origin);
      const stop = nextTabStop(layout, x);
      if (stop === null) {
        clearTab(tab);
        continue;
      }
      const segment =
        stop.align === 'left'
          ? { width: 0, beforeDecimal: 0 }
          : measureSegment(tab, breaks[breaks.indexOf(tab) + 1], paragraph, toTwips);
      const width = tabWidth(stop, x, segment);
      tab.setAttribute(TAB_DRAWN, stop.kind);
      tab.style.setProperty('display', 'inline-block');
      tab.style.setProperty('width', `${width / 20}pt`);
      const leader = leaderCss(stop.leader);
      if (leader === null) tab.style.removeProperty('background');
      else tab.style.setProperty('background', leader);
    }
  }
}

/**
 * The plugin that keeps the tabs of the web view at their stops. Pass it as a plugin of the view
 * (a plugin without state), not of the editor state. It runs after the view brings its DOM up to
 * date, when the width of the view changes and when the fonts of the page have loaded.
 */
export function tabStopsPlugin(): Plugin {
  return new Plugin({
    view(view) {
      let frame = 0;
      let gone = false;
      const run = (): void => {
        frame = 0;
        if (!gone) layoutTabs(view);
      };
      const later = (): void => {
        if (frame === 0 && !gone) frame = requestAnimationFrame(run);
      };
      let width = -1;
      const observer =
        typeof ResizeObserver === 'undefined'
          ? null
          : new ResizeObserver(() => {
              const now = view.dom.clientWidth;
              if (now === width) return;
              width = now;
              later();
            });
      observer?.observe(view.dom);
      void document.fonts?.ready.then(later);
      layoutTabs(view);
      return {
        update(next, prev) {
          if (next.state.doc !== prev.doc) layoutTabs(next);
        },
        destroy() {
          gone = true;
          observer?.disconnect();
          if (frame !== 0) cancelAnimationFrame(frame);
        },
      };
    },
  });
}
