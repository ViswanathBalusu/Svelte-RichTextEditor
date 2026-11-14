/**
 * PRO-090 criterion 4 (lane U-PRO-086-102): `destroy()` on the element closes the host's
 * `backend` exactly once. The backend is the in-memory mock that the embed page builds for the
 * host; its `close` is counted by wrapping the method on the object the host passes in.
 * Chromium, Edge, Firefox and WebKit (playwright.config.ts projects).
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

test('PRO-090: destroy() calls the host backend close() once', async ({ page }) => {
  await openEmbed(page);
  const closes = await page.evaluate(async () => {
    const e = (window as unknown as { __embed: { backend(s: string): unknown; docId: string } })
      .__embed;
    const backend = e.backend('ada') as { close: (...a: unknown[]) => unknown };
    const original = backend.close.bind(backend);
    let count = 0;
    backend.close = (...args: unknown[]) => {
      count += 1;
      return original(...args);
    };
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      destroy(): void;
    };
    el.setAttribute('doc-id', e.docId);
    el.backend = backend;
    const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
    document.getElementById('mount')!.append(el);
    await ready;
    el.destroy();
    // Give any second, unexpected close a chance to run before counting.
    await new Promise((r) => setTimeout(r, 200));
    return count;
  });
  expect(closes).toBe(1);
});
