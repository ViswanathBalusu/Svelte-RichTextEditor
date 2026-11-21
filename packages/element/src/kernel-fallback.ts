/**
 * When the layout kernel cannot start (WASM-003; ADR 0016, decision 2): what the page view does
 * instead, and what the person is told. Editing never depends on the kernel, so a host whose policy
 * lacks `'wasm-unsafe-eval'` loses the page view at most.
 *
 * Spike S5 (docs/spikes/2026-11-06-s5-text-measurement.md, "Fallback when the host blocks
 * WebAssembly") recorded the fallback per engine: canvas measurement matches painted Latin text
 * within 0.08 px in Chromium, Edge and WebKit, so the page view measures with canvas there; in
 * Firefox canvas misses the half-pixel tolerance on most lines, so the element stays in the web view
 * and says why. The page view itself is FE-101's and is not built; this module is the decision and
 * the message, which it reads when it is.
 */
import type { DiagnosticDetail } from './events.ts';

export type PageViewFallback = 'canvas-measurement' | 'web-view';

/** The fallback for a browser, from its user agent. Only Firefox lacks an acceptable canvas. */
export function fallbackFor(userAgent: string): PageViewFallback {
  return /\bFirefox\//.test(userAgent) ? 'web-view' : 'canvas-measurement';
}

/**
 * Who measures text for the page view (FE-079 criterion 6). Spike S5's recommendation (docs/spikes/
 * 2026-11-06-s5-text-measurement.md, "Recommendation" 1 and 4), accepted with ADR 0016 and the
 * owner's decisions 26 and 27:
 *  - `font-files`: advances computed from the manifest's font files by the layout kernel (the Rust
 *    WebAssembly module). This is the default.
 *  - `canvas`: canvas `measureText` (`./canvas-measure.ts`), only when the kernel cannot start, and
 *    only in Chromium, Edge and WebKit.
 *  - `none`: no measurer; the page view is not offered and the element stays in the web view
 *    (Firefox without the kernel).
 */
export type MeasurementProvider = 'font-files' | 'canvas' | 'none';

/** The provider the page view measures with while the kernel is able to start. */
export const DEFAULT_MEASUREMENT_PROVIDER: MeasurementProvider = 'font-files';

/**
 * The provider to use. `kernel` is whether the layout kernel started (or has not failed yet);
 * `userAgent` decides the fallback when it did not.
 */
export function chooseMeasurementProvider(
  kernel: 'available' | 'unavailable',
  userAgent: string,
): MeasurementProvider {
  if (kernel === 'available') return DEFAULT_MEASUREMENT_PROVIDER;
  return fallbackFor(userAgent) === 'canvas-measurement' ? 'canvas' : 'none';
}

/** The words of the notice. Replaceable strings are UX's (13 §8); these are the working English ones. */
export const PAGE_VIEW_NOTICE = {
  unavailable: 'The page view is not available.',
  blocked:
    "This page's security policy does not allow WebAssembly, which the page view needs in this browser. The site's administrator can allow it with 'wasm-unsafe-eval' in script-src.",
  other: "The page view's WebAssembly file could not be loaded.",
  measurement: 'This browser cannot measure text accurately enough for the page view yet.',
  trapped: "The page view's text kernel stopped unexpectedly.",
  choose: 'You can keep editing in the web view, or read the typeset result in the read view.',
  web: 'Web view',
  read: 'Read view',
} as const;

/** The sentence that says why the page view is not available, from the failure's code. */
export function noticeReason(detail: Pick<DiagnosticDetail, 'code'>): string {
  if (detail.code === 'blocked_by_policy') return PAGE_VIEW_NOTICE.blocked;
  if (detail.code === 'measurement_unavailable') return PAGE_VIEW_NOTICE.measurement;
  return detail.code === 'kernel_trap' ? PAGE_VIEW_NOTICE.trapped : PAGE_VIEW_NOTICE.other;
}

/**
 * Puts the notice at the top of `root`: a plain message with the reason, and a button for each view
 * the person can use instead. `choose` is called with the view they pick. Returns the notice, so
 * the caller can remove it.
 */
export function showPageViewNotice(
  root: ParentNode & { prepend(...nodes: Node[]): void },
  reason: string,
  choose: (view: 'web' | 'read') => void,
): HTMLElement {
  const notice = document.createElement('div');
  notice.className = 'de-view-notice';
  notice.setAttribute('role', 'status');
  const message = document.createElement('p');
  message.textContent = `${PAGE_VIEW_NOTICE.unavailable} ${reason} ${PAGE_VIEW_NOTICE.choose}`;
  notice.append(message);
  for (const view of ['web', 'read'] as const) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'de-view-notice-button';
    button.dataset['view'] = view;
    button.textContent = PAGE_VIEW_NOTICE[view];
    button.addEventListener('click', () => choose(view));
    notice.append(button);
  }
  root.prepend(notice);
  return notice;
}
