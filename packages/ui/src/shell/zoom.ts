/**
 * Zoom of the content (UX-018 criterion 5; FE-138): a scale of the page, never a change of the
 * document. The levels are the shell's own default steps, not figures from the spec; the page's
 * text is set in em, so the shell scales it through the page's font size, which keeps the core's
 * caret and selection measurements true (no transform).
 */

/** The zoom steps, as factors. A host can change the page's base size with `--de-` properties. */
export const ZOOM_LEVELS: readonly number[] = [0.5, 0.75, 0.9, 1, 1.1, 1.25, 1.5, 1.75, 2];

export const DEFAULT_ZOOM = 1;

/** The next step in a direction, or the same level at either end. */
export function stepZoom(current: number, step: 'in' | 'out' | 'reset'): number {
  if (step === 'reset') return DEFAULT_ZOOM;
  const i = nearest(current);
  const next = step === 'in' ? Math.min(i + 1, ZOOM_LEVELS.length - 1) : Math.max(i - 1, 0);
  return ZOOM_LEVELS[next]!;
}

/** The index of the step nearest a factor. */
export function nearest(level: number): number {
  let best = 0;
  for (let i = 1; i < ZOOM_LEVELS.length; i++)
    if (Math.abs(ZOOM_LEVELS[i]! - level) < Math.abs(ZOOM_LEVELS[best]! - level)) best = i;
  return best;
}

export function canZoom(level: number, step: 'in' | 'out'): boolean {
  const i = nearest(level);
  return step === 'in' ? i < ZOOM_LEVELS.length - 1 : i > 0;
}
