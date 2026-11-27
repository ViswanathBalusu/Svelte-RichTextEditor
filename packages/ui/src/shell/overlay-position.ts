/**
 * Placing an overlay next to a point or a control (FE-020; 02 §3 overlays). Floating UI computes the
 * position in script (owner decision 252), so no CSS anchor positioning is used. The overlay opens
 * below and at the inline start of the point; where that does not fit it flips to the other side,
 * and where neither side fits it is shifted so that it stays inside the viewport.
 */
import type { Placement } from '@floating-ui/dom';

/** The gap kept between an overlay and the edge of the viewport, in CSS pixels. */
export const OVERLAY_EDGE_PADDING = 4;

export interface OverlayPoint {
  readonly x: number;
  readonly y: number;
}

/** A zero-size reference at a point of the viewport (a pointer or caret position). */
export function pointReference(point: OverlayPoint) {
  return {
    getBoundingClientRect: () => ({
      x: point.x,
      y: point.y,
      width: 0,
      height: 0,
      top: point.y,
      left: point.x,
      right: point.x,
      bottom: point.y,
    }),
  };
}

/** The placements to try, in order, for a reading direction. */
export function placementsFor(rtl: boolean): { first: Placement; fallbacks: Placement[] } {
  return rtl
    ? { first: 'bottom-end', fallbacks: ['top-end', 'bottom-start', 'top-start'] }
    : { first: 'bottom-start', fallbacks: ['top-start', 'bottom-end', 'top-end'] };
}

/**
 * Where to put `floating` (a fixed-position element) for a point of the viewport. Returns the
 * `left` and `top` to set, in the coordinates of the element's containing block.
 */
export async function placeOverlay(
  floating: HTMLElement,
  point: OverlayPoint,
  rtl: boolean,
): Promise<{ left: number; top: number }> {
  // Imported when the first overlay opens, so that it is not in the first interactive editor's
  // size budget (13 §9; FE-002).
  const { computePosition, flip, shift } = await import('@floating-ui/dom');
  const { first, fallbacks } = placementsFor(rtl);
  const { x, y } = await computePosition(pointReference(point), floating, {
    strategy: 'fixed',
    placement: first,
    middleware: [
      flip({ fallbackPlacements: fallbacks, padding: OVERLAY_EDGE_PADDING }),
      shift({ padding: OVERLAY_EDGE_PADDING }),
    ],
  });
  return { left: Math.round(x), top: Math.round(y) };
}
