/**
 * The page view's chunk (FE-101): the one module the element imports lazily when `view="print"` is
 * asked for and available. Nothing here is in the first-interactive bundle.
 */
export { mountPageView, type MountedPageView, type PageViewOptions } from './page-view.ts';
export { pageViewSupported } from './providers.ts';
