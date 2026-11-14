/**
 * PRO-089: the share button asks the host for its own sharing dialog (05 §8.1). The page is the
 * production-bundle page (pages/lib.html, which has no event recorder of its own), so the host
 * behaviour is the test's: a listener on the host page for criterion 1, and no listener for
 * criterion 3. Criterion 2 (the editor shows no dialog of its own, and never lists documents) is
 * checked here by the absence of any dialog and of any document list in the element.
 *
 * Run with `DOCEDIT_DEMO_PORT=56140 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/pro-089-share-request.spec.ts`.
 * Projects: Chromium, Edge, Firefox and WebKit (lane U-PRO-086-102).
 */
import { expect, type Page, test } from '@playwright/test';
import { openLib } from './embed-helpers.ts';

const HOST = 'doc-editor[data-test="share"]';

/** Loads the library and mounts the element with the in-memory backend, as a host does. */
async function mountLibrary(page: Page, listen: boolean): Promise<void> {
  await openLib(page);
  await page.evaluate(
    async ({ listen }) => {
      const lib = (
        window as unknown as {
          __lib: { load(): Promise<unknown>; backend(s: string): unknown; docId: string };
        }
      ).__lib;
      await lib.load();
      const raised: Array<{ name: string; bubbles: boolean; composed: boolean; detail: unknown }> =
        [];
      (window as unknown as { __raised: typeof raised }).__raised = raised;
      if (listen) {
        // The host's own listener, on the document, as a host page would write it.
        document.addEventListener('de-share-request', (e) => {
          raised.push({
            name: e.type,
            bubbles: e.bubbles,
            composed: e.composed,
            detail: (e as CustomEvent).detail,
          });
        });
      }
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'share';
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = lib.backend('ada');
      el.setAttribute('doc-id', lib.docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { listen },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

const share = (page: Page) =>
  page.locator(HOST).getByRole('button', { name: 'Share', exact: true });

test.describe('PRO-089: the share button asks the host', () => {
  test('criterion 1: activating it raises de-share-request, bubbling and composed, with the document identifier only', async ({
    page,
  }) => {
    await mountLibrary(page, true);
    await share(page).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __raised: unknown[] }).__raised.length),
      )
      .toBe(1);
    const raised = await page.evaluate(
      () => (window as unknown as { __raised: Array<Record<string, unknown>> }).__raised,
    );
    expect(raised[0]).toMatchObject({ name: 'de-share-request', bubbles: true, composed: true });
    const detail = raised[0]!['detail'] as Record<string, unknown>;
    expect(Object.keys(detail)).toEqual(['docId']);
    expect(typeof detail['docId']).toBe('string');
  });

  test('criterion 2: the editor shows no sharing dialog and lists no documents', async ({
    page,
  }) => {
    await mountLibrary(page, true);
    await share(page).click();
    await expect
      .poll(() =>
        page.evaluate(() => (window as unknown as { __raised: unknown[] }).__raised.length),
      )
      .toBe(1);
    const shadow = await page.evaluate((sel) => {
      const el = document.querySelector(sel) as HTMLElement & { shadowRoot: ShadowRoot | null };
      const root = el.shadowRoot!;
      return {
        dialogs: root.querySelectorAll('dialog, [role="dialog"]').length,
        lists: root.querySelectorAll('[data-test="document-list"], [data-test="documents"]').length,
      };
    }, HOST);
    expect(shadow).toEqual({ dialogs: 0, lists: 0 });
    expect(await page.locator('dialog, [role="dialog"]').count()).toBe(0);
  });

  test('criterion 3: with no listener on the host, activating the button raises nothing that breaks and no error', async ({
    page,
  }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    page.on('console', (m) => {
      // A resource that fails to load is reported by the browser as a console error; the page's own
      // resources are checked below, and the favicon request is not the page's.
      if (m.type() === 'error' && !m.text().startsWith('Failed to load resource'))
        errors.push(m.text());
    });
    page.on('response', (r) => {
      if (r.status() >= 400 && !r.url().endsWith('/favicon.ico'))
        errors.push(`${r.status()} ${r.url()}`);
    });
    await mountLibrary(page, false);
    await share(page).click();
    // The editor is still usable: its surface keeps focus and the control stays available.
    await expect(share(page)).toBeEnabled();
    await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
    // Give the event loop a moment for any late error.
    await page.waitForTimeout(200);
    expect(errors).toEqual([]);
  });
});
