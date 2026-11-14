/**
 * `exec` from a host toolbar changes the document the same way the built-in toolbar does (UX-005,
 * criterion 3, lane V-UX-001-015). The harness records what the core is asked to run and every
 * core call; a bold run from the built-in toolbar and a bold run from `exec` must record the same
 * runs and the same core calls, and the second run must report that it ran.
 * Run with `DOCEDIT_UI_PORT=57250 DOCEDIT_BROWSERS=chromium pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-005-exec-parity.spec.ts`.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

test.describe('exec from the host matches the built-in toolbar (UX-005, criterion 3)', () => {
  test('a bold run from the built-in toolbar and from exec record the same core work', async ({
    page,
  }) => {
    const h = await open(page, { hostToolbar: true });
    await focusSurface(page);
    await h.setSelection({ empty: false });
    await h.frames(2);

    const runsBefore = (await h.runs()).length;
    const callsBefore = (await h.calls()).length;
    await page.locator('.de-toolbar [data-command-id="format.bold"]').click();
    await h.frames(2);
    const viaToolbar = {
      runs: (await h.runs()).slice(runsBefore),
      calls: (await h.calls()).slice(callsBefore),
    };
    expect(viaToolbar.runs.length).toBeGreaterThan(0);

    const runsMid = (await h.runs()).length;
    const callsMid = (await h.calls()).length;
    expect(await h.exec('format.bold')).toEqual({ ran: true, reason: null });
    await h.frames(2);
    const viaExec = {
      runs: (await h.runs()).slice(runsMid),
      calls: (await h.calls()).slice(callsMid),
    };

    expect(viaExec.runs).toEqual(viaToolbar.runs);
    expect(viaExec.calls).toEqual(viaToolbar.calls);
  });
});
