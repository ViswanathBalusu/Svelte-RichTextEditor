/**
 * UX-067 criterion 5, the shell's half (lane w3): while the accessibility checker lists issues, the
 * export command and its dialog are not blocked, and the author's export creates its job. The job
 * half (the job still reports a picture without alternative text, 09 section 13) is
 * packages/ui/test/ux-066-export-agreement.test.ts, which runs the real LaTeX job. The core here is
 * the harness's fake. Run with
 * `DOCEDIT_UI_PORT=<free port> pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/ux-067-export-not-blocked.spec.ts`.
 */
import { expect, open, test } from './helpers.ts';

test('the checker lists issues and an export is still created (UX-067 criterion 5)', async ({
  page,
}) => {
  const h = await open(page, { extended: true, checker: true, features: ['exports'] });
  await h.exec('view.checker');
  const pane = page.locator('.de-pane[data-pane="checker"]');
  await expect(pane.locator('[data-status="count"]')).toHaveText(/accessibility issues found\./);
  const issues = await pane.locator('li.de-checker-item').count();
  expect(issues).toBeGreaterThan(0);

  // The export command is offered with issues open, and the dialog's button starts a job.
  await h.exec('document.export');
  const dialog = page.getByRole('dialog', { name: 'Export' });
  const start = dialog.getByRole('button', { name: 'Export', exact: true });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(dialog.locator('[data-status="export"]')).toHaveText('Waiting to start');
  expect((await h.exportRequests()).map((r: { target: string }) => r.target)).toEqual(['pdf']);
});
