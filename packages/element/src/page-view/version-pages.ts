/**
 * An old version painted as read-only pages (FE-095; 02 §7, 08 §5). The history pane asks a
 * `HistoryVersionView` to draw itself in a target (`mount`); this wraps a version of the engine so
 * that it draws the layout engine's pages instead of the web view, with no input bridge, no caret and
 * no way to change it. The wrapper draws no comparison marks (the pane then says the host cannot
 * draw them, HIS-013) and shows no deletions.
 */
import type { VersionView } from '@docedit/engine';
import { mountPageView, type MountedPageView, type PageViewOptions } from './page-view.ts';

/** What the pages need besides the version: the page view's injectable parts. */
export type VersionPagesOptions = Pick<
  PageViewOptions,
  'providers' | 'frame' | 'onLayout' | 'onError'
> & {
  /** The accessible name of the pages. */
  readonly label: string;
};

/**
 * A version as the history pane takes it (`HistoryVersionView` of the pane's port: the required
 * members of it), drawn as pages. `pages` is for tests and for a host that reads the page count.
 */
export interface PagedHistoryVersion {
  readonly seq: number;
  readonly time: string;
  readonly name: string | null;
  mount(target: HTMLElement): () => void;
  close(): void;
  pages(): MountedPageView | null;
}

/** Paints a version in `parent`; the caller destroys the result. */
export function mountVersionPages(
  version: VersionView,
  parent: HTMLElement,
  options: VersionPagesOptions,
): MountedPageView {
  return mountPageView({ ...options, host: version.pageHost(), parent, readOnly: true });
}

/**
 * The version as the history pane takes it, drawn as pages. `close` is the version's own, so the
 * pane releases the core as before.
 */
export function pagedHistoryVersion(
  version: VersionView,
  options: VersionPagesOptions,
): PagedHistoryVersion {
  let shown: MountedPageView | null = null;
  return {
    seq: version.seq,
    time: version.time,
    name: version.name,
    mount(target) {
      shown?.destroy();
      shown = mountVersionPages(version, target, options);
      return () => {
        shown?.destroy();
        shown = null;
      };
    },
    close() {
      shown?.destroy();
      shown = null;
      version.destroy();
    },
    pages: () => shown,
  };
}
