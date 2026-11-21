/**
 * The page thumbnails the shell reads (ui's `PageThumbnails`; UX-021), over whichever view has
 * pages at the moment. The shell is mounted once and keeps the service it was given; the page view
 * comes and goes with the `view` attribute. So the service is one object for the life of the
 * editor, and the element tells it which view has the pages, or that none has: in the web view its
 * state is null and the navigation pane offers no thumbnails (02 §7).
 *
 * Only types of the page view are imported here: the page view stays a chunk of its own.
 */
import type { PageThumbnails, PagesInfo } from '@docedit/ui';
import type { PageViewPages } from './page-view/pages.ts';

export interface PagesBridge {
  /** What the shell is given as `CoreApi.pages`. */
  readonly service: PageThumbnails;
  /** The view that shows pages now; null when the view on screen has none. */
  set(source: PageViewPages | null): void;
}

const same = (a: PagesInfo | null, b: PagesInfo | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.count === b.count &&
    a.current === b.current &&
    a.revision === b.revision);

export function pagesBridge(): PagesBridge {
  let source: PageViewPages | null = null;
  let stop: (() => void) | null = null;
  // The same object until something changes, so that a reader can compare by identity.
  let snapshot: PagesInfo | null = null;
  const listeners = new Set<() => void>();

  const refresh = (): void => {
    const info = source?.info() ?? null;
    // A view with no page (one that has stopped) offers no thumbnails.
    const next = info !== null && info.count > 0 ? info : null;
    if (same(next, snapshot)) return;
    snapshot = next;
    for (const listener of [...listeners]) listener();
  };

  return {
    service: {
      state: {
        get: () => snapshot,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      size: (index) => source?.size(index) ?? null,
      paint: (index, target, width) => source?.paint(index, target, width) ?? false,
      goTo: (index) => source?.goTo(index) ?? false,
    },
    set(next) {
      stop?.();
      stop = null;
      source = next;
      if (next) stop = next.subscribe(refresh);
      refresh();
    },
  };
}
