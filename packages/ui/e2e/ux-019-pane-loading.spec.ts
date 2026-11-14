/**
 * UX-019 criterion 2 (lane U-UX-016-030): when a pane opens for the first time its code is requested
 * on demand and a loading state is announced. The pane's chunk is held back here, so the
 * announcement can be read while the code is still on its way, and then released.
 */
import { expect, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
];

test.describe('the pane host loading state (UX-019 criterion 2)', () => {
  test('announces the loading of a first-opened pane while its code is on its way', async ({
    page,
  }) => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const requested: string[] = [];
    await page.route('**/assets/StylesPane*.js', async (route) => {
      requested.push(new URL(route.request().url()).pathname);
      await gate;
      await route.continue();
    });
    const h = await open(page, { extended: true, styles: STYLES });
    const status = page.locator('.de-shell > [role="status"]');
    const pane = page.locator('.de-pane[data-pane="styles"]');
    const run = h.exec('view.styles');
    // The code has been asked for, the pane is not yet shown, and the loading is announced.
    await expect.poll(() => requested.length).toBe(1);
    await expect(status).toHaveText(/^Loading /);
    await expect(pane).toHaveCount(0);
    release();
    expect(await run).toEqual({ ran: true, reason: null });
    await expect(pane).toBeVisible();
    // Opened again, the pane is cached: its code is not requested again.
    expect(requested).toHaveLength(1);
  });
});
