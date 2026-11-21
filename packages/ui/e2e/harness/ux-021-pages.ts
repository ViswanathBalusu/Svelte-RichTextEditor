/**
 * A stand-in for a view with pages (UX-021), for the shell's own browser tests of the navigation
 * pane's thumbnails. It has `count` pages, upright A4 but for every fifth, which lies on its side,
 * so that the list holds thumbnails of two heights. A page is "drawn" as a box that holds its
 * number: what the real drawing looks like is the element's test, with the real painter
 * (packages/element/e2e/ux-021-page-thumbnails.spec.ts). The log says what the pane asked for.
 */
import type { PageThumbnails, PagesInfo } from '../../src/core-api.ts';

export interface PagesHarnessLog {
  /** The pages the pane asked the view to move to, in order. */
  goTo: number[];
  /** The pages the pane asked to have drawn, in order. */
  paints: number[];
}

const A4 = { width: 595.28, height: 841.89 };
const A4_ON_ITS_SIDE = { width: 841.89, height: 595.28 };

export function fakePages(
  count: number,
  log: PagesHarnessLog,
): {
  readonly service: PageThumbnails;
  /** Changes the pages as a view does: another page shown, a new layout, or no pages at all (null). */
  set(next: Partial<PagesInfo> | null): void;
} {
  let info: PagesInfo | null = { count, current: 0, revision: 1 };
  const listeners = new Set<() => void>();
  const tell = (): void => {
    for (const listener of [...listeners]) listener();
  };
  return {
    service: {
      state: {
        get: () => info,
        subscribe(listener) {
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
      },
      size: (index) =>
        info === null || index < 0 || index >= info.count
          ? null
          : index % 5 === 4
            ? A4_ON_ITS_SIDE
            : A4,
      paint(index, target, width) {
        if (info === null || index < 0 || index >= info.count) return false;
        log.paints.push(index);
        const sheet = document.createElement('div');
        sheet.dataset['sheet'] = String(index + 1);
        sheet.dataset['layout'] = String(info.revision);
        sheet.dataset['width'] = String(width);
        sheet.textContent = `Sheet ${index + 1}`;
        target.replaceChildren(sheet);
        return true;
      },
      goTo(index) {
        if (info === null || index < 0 || index >= info.count) return false;
        log.goTo.push(index);
        // The view moves, and then shows that page.
        info = { ...info, current: index };
        tell();
        return true;
      },
    },
    set(next) {
      info = next === null ? null : { ...(info ?? { count, current: 0, revision: 1 }), ...next };
      tell();
    },
  };
}
