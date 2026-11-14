/**
 * `no-print` in the production element (UX-040 criterion 3; lane V-UX-031-045, round 16). The real
 * element runs with its demo backend. The restriction is set on the engine core the way the session
 * does when `perm.changed` arrives (`core.setAccess`). Calling `print()` on the element then resolves
 * `{ status: 'refused', reason: 'no-print' }`, sends no request to the exports port, and prints
 * nothing. Run with
 * `DOCEDIT_DEMO_PORT=57270 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-040-no-print.spec.ts --project=<browser>`.
 */
import type { Page } from '@playwright/test';
import { expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="one"]';

/** Sets the restriction on the element's core as a new access revision. */
async function setRestrictions(page: Page, restrictions: string[]): Promise<void> {
  await page.evaluate(
    ({ sel, list }) => {
      const el = document.querySelector(sel) as HTMLElement;
      const embed = (
        window as unknown as {
          __embed: {
            internals(el: Element): {
              editor: {
                core: {
                  permissions: { get(): { rev: number } & Record<string, unknown> };
                  setAccess(a: unknown): void;
                };
              } | null;
            };
          };
        }
      ).__embed;
      const core = embed.internals(el).editor!.core;
      const current = core.permissions.get();
      core.setAccess({ ...current, rev: current.rev + 1, restrictions: list });
    },
    { sel: EDITOR, list: restrictions },
  );
}

test.describe('no-print in the element (UX-040 criterion 3)', () => {
  test('under no-print, print() is refused with a reason and requests no export', async ({
    page,
  }) => {
    const exportRequests: string[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/exports')) exportRequests.push(`${req.method()} ${req.url()}`);
    });

    await openEmbed(page);
    await mountEditor(page);
    // The session takes its access from the core's permissions store, so the change is awaited on
    // the element's `de-permission-change` event rather than read straight after the core is set.
    const changed = page.evaluate(
      (sel) =>
        new Promise<void>((resolve) => {
          document.querySelector(sel)!.addEventListener('de-permission-change', (event) => {
            const detail = (event as CustomEvent<{ restrictions?: string[] }>).detail;
            if (detail?.restrictions?.includes('no-print')) resolve();
          });
        }),
      EDITOR,
    );
    await setRestrictions(page, ['no-print']);
    await changed;

    const outcome = await page.evaluate(
      (sel) => (document.querySelector(sel) as unknown as { print(): Promise<unknown> }).print(),
      EDITOR,
    );
    expect(outcome).toEqual({ status: 'refused', reason: 'no-print' });

    // Give any stray request a moment to appear before asserting that none was made.
    await page.waitForTimeout(250);
    expect(exportRequests).toEqual([]);
  });
});
