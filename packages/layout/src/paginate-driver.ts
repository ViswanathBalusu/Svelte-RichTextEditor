/**
 * Background pagination in time slices (02 §9.5; FE-089). The pass of `paginateSteps` gives up
 * control after each item it places, and this driver runs it for as long as the caller allows, then
 * hands control back, so that a long document does not hold the page while it is paginated and the
 * browser can handle input between slices. Draining the steps gives exactly the result of
 * `paginate`.
 *
 * While the pagination runs, the driver
 * - feeds the height of each page that the pass has closed to a `PageHeights` store, which gives the
 *   mean of the computed heights for a page not yet computed and replaces it when the page is
 *   computed (criterion 2);
 * - reports the page count and whether it is final (criterion 4): the count is final when the last
 *   pass has ended, and not before, because a later item can add pages and a later pass (the stories'
 *   page count changed) can change the earlier ones.
 *
 * The driver has no clock and no scheduler of its own (FND-004): the caller gives it the test for
 * the end of a slice (`step`) or a clock and a way to yield to the host (`paginateInSlices`).
 */
import { pageHeights, type PageHeights } from './page-heights.ts';
import {
  paginateSteps,
  type PageItem,
  type PageSetup,
  type PaginateOptions,
  type Pagination,
  type PaginationProgress,
} from './paginate.ts';

export interface PageCount {
  /** The pages the pagination has opened so far; all of them once it is final. */
  readonly placed: number;
  /**
   * What the count is expected to be: the count of the previous pass when there was one, otherwise
   * the pages placed so far scaled by the items still to place. Equal to `placed` once final.
   */
  readonly projected: number;
  /** True when no later item or pass can change the count. */
  readonly final: boolean;
}

export interface PaginationDriver {
  /**
   * Places items until `shouldYield()` is true after one, or until the pagination ends. A call
   * that does not end it places at least one item, so the calls always make progress; the call that
   * ends it closes the last page. Returns whether it has ended.
   */
  step(shouldYield: () => boolean): boolean;
  readonly done: boolean;
  /** The pagination, once `done`; null before. */
  readonly result: Pagination | null;
  /** The page count and whether it is final. */
  pageCount(): PageCount;
  /** The heights of the pages: computed for the pages the pass has closed, estimated for the rest. */
  readonly heights: PageHeights;
  /** The number of calls of `step` that placed something: the slices run so far. */
  readonly slices: number;
  /** Items placed in the pass that is running (all of them once done). */
  readonly itemsDone: number;
}

/** A driver over the same input as `paginate`. `heights` defaults to a store estimating at the first page's height. */
export function paginationDriver(
  items: readonly PageItem[],
  first: PageSetup,
  options: PaginateOptions = {},
  heights: PageHeights = pageHeights(first.height),
): PaginationDriver {
  const steps = paginateSteps(items, first, options);
  let result: Pagination | null = null;
  let slices = 0;
  let itemsDone = 0;
  let itemCount = items.length;
  let pass = 0;
  let closed = 0;
  /** Pages of the last pass that ended: what a later pass is likely to end with. */
  let lastPassPages: number | null = null;
  let fed = 0;

  const feed = (p: PaginationProgress): void => {
    if (p.pass !== pass) {
      if (pass !== 0) lastPassPages = closed + 1;
      pass = p.pass;
      fed = 0;
    }
    for (; fed < p.pages.length; fed++) heights.setComputed(fed, p.pages[fed]!.height);
    itemsDone = p.itemsDone;
    itemCount = p.itemCount;
    closed = p.pages.length;
  };

  return {
    step(shouldYield) {
      if (result !== null) return true;
      slices++;
      for (;;) {
        const next = steps.next();
        if (next.done) {
          result = next.value;
          result.pages.forEach((page, i) => heights.setComputed(i, page.height));
          heights.invalidateFrom(result.pages.length);
          itemsDone = itemCount;
          return true;
        }
        feed(next.value);
        if (shouldYield()) return false;
      }
    },
    get done() {
      return result !== null;
    },
    get result() {
      return result;
    },
    pageCount() {
      if (result !== null) {
        const n = result.pages.length;
        return { placed: n, projected: n, final: true };
      }
      const placed = itemsDone === 0 ? 0 : closed + 1;
      const scaled = itemsDone === 0 ? 0 : Math.ceil((placed * itemCount) / itemsDone);
      return { placed, projected: Math.max(placed, lastPassPages ?? scaled), final: false };
    },
    heights,
    get slices() {
      return slices;
    },
    get itemsDone() {
      return itemsDone;
    },
  };
}

export interface SliceOptions {
  /** A clock in milliseconds (`performance.now` in a browser). */
  readonly now: () => number;
  /** The longest a slice runs before it yields. */
  readonly sliceMs: number;
  /**
   * Gives the host a turn: the browser handles input and paints (`scheduler.yield()`, or a message
   * channel round trip). The next slice starts when the promise settles.
   */
  readonly yieldToHost: () => Promise<void>;
}

/**
 * Paginates in time slices and resolves with the result. `onSlice` is called after each slice, for
 * example to paint the pages that are computed. The pagination is the one `paginate` gives.
 */
export async function paginateInSlices(
  items: readonly PageItem[],
  first: PageSetup,
  options: PaginateOptions,
  slice: SliceOptions,
  onSlice?: (driver: PaginationDriver) => void,
): Promise<Pagination> {
  const driver = paginationDriver(items, first, options);
  for (;;) {
    const t0 = slice.now();
    const done = driver.step(() => slice.now() - t0 >= slice.sliceMs);
    onSlice?.(driver);
    if (done) return driver.result!;
    await slice.yieldToHost();
  }
}
