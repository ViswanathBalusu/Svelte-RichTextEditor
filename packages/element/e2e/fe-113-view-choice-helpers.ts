/**
 * Shared by e2e/fe-113-touch-view-choice.spec.ts and e2e/fe-113-desktop-view-choice.spec.ts
 * (FE-113 criterion 2). Mounts the element of the embed page with a `view` attribute and reports
 * which view its shadow root shows. Unlike `mountEditor` (embed-helpers.ts) it does not wait for the
 * editing surface, because the read view has none.
 */
import type { Page } from '@playwright/test';

export interface ShownViews {
  /** The web view's editing surface. */
  readonly webSurface: number;
  /** The read view (read-view-element.ts). */
  readonly readView: number;
  /** A page view (FE-101; not built). */
  readonly pageView: number;
  /** What the element reads as touch input (doc-editor.ts, `#viewChoice`). */
  readonly coarsePointer: boolean;
  readonly maxTouchPoints: number;
}

/** Mounts `<doc-editor view=…>` on the embed page and waits until one view is in its shadow root. */
export async function mountWithView(page: Page, view: string): Promise<ShownViews> {
  await page.evaluate((v) => {
    const e = (
      window as unknown as { __embed: { backend(s: string, r: string): unknown; docId: string } }
    ).__embed;
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'one';
    el.setAttribute('view', v);
    el.backend = e.backend('ada', 'editor');
    el.setAttribute('doc-id', e.docId);
    document.getElementById('mount')!.append(el);
  }, view);
  await page.waitForFunction(() => {
    const root = document.querySelector('doc-editor[data-test="one"]')?.shadowRoot;
    return !!root && root.querySelectorAll('.de-editing-surface, .de-read-view').length > 0;
  });
  return page.evaluate(() => {
    const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
    return {
      webSurface: root.querySelectorAll('.de-editing-surface').length,
      readView: root.querySelectorAll('[data-view="read"], .de-read-view').length,
      pageView: root.querySelectorAll('[data-view="print"], .de-page-view').length,
      coarsePointer: matchMedia('(any-pointer: coarse)').matches,
      maxTouchPoints: navigator.maxTouchPoints,
    };
  });
}
