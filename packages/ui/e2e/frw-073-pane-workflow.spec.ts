/**
 * The field properties pane while a workflow runs (FRW-073 criterion 4, second half): the pane is
 * read-only when the workflow is `sent` or `in_progress`, and editable again when it is a draft. The
 * state is the one the lock banner follows (`core.workflowSend.state`); here it is a stand-in
 * service (harness/frw-028-send-port.ts), and the fields service is a stand-in too
 * (harness/main.ts `fieldProperties`). The element's service over the workflow port is tested in
 * packages/element/test/frw-028-workflow-send.test.ts. Run from the repository root with
 * `DOCEDIT_UI_PORT=57673 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-073-pane-workflow.spec.ts`.
 */
import { axe, expect, open, test } from './helpers.ts';

const OWNER = { rev: 1, docRole: 'owner', caps: ['view', 'comment', 'edit', 'manage'], scopes: {} };
const PANE = '.de-pane[data-pane="fields"]';

/** The twelve properties of 12 §3.2, by the label of their control. */
const LABELS = [
  'Key',
  'Kind',
  'Label',
  'Assignee (role)',
  'Required',
  'Read-only',
  'Default value',
  'Placeholder',
  'Options',
  'Format (JSON object)',
  'Validation (JSON object)',
  'Width (points)',
];

test.describe('the field properties pane and the workflow (FRW-073 criterion 4)', () => {
  test('is read-only while the workflow is sent or in progress, and editable again as a draft', async ({
    page,
    browserName,
  }) => {
    const h = await open(page, {
      send: 'pass',
      fieldProperties: true,
      permissions: OWNER,
      extended: true,
    });
    expect(await h.openPane('fields')).toBe(true);
    const pane = page.locator(PANE);
    await expect(pane.getByLabel('Key', { exact: true })).toHaveValue('tenant.name');

    // A draft: nothing is disabled.
    await expect(pane.locator('[data-status="read-only"]')).toHaveCount(0);
    for (const label of LABELS) await expect(pane.getByLabel(label, { exact: true })).toBeEnabled();
    await expect(pane.getByRole('button', { name: 'Apply' })).toBeEnabled();

    for (const state of ['in_progress', 'sent']) {
      await h.setSendState('draft');
      await expect(pane.getByRole('button', { name: 'Apply' })).toBeEnabled();
      await h.setSendState(state);
      await expect(pane.locator('[data-status="read-only"]')).toHaveText(
        'These properties cannot be changed now.',
      );
      for (const label of LABELS)
        await expect(pane.getByLabel(label, { exact: true })).toBeDisabled();
      await expect(pane.getByRole('button', { name: 'Apply' })).toBeDisabled();
      // The properties are still shown.
      await expect(pane.getByLabel('Key', { exact: true })).toHaveValue('tenant.name');
      // Not in Firefox: axe crashes Playwright's Firefox build on this pane (see frw-073-field-properties.spec.ts).
      if (browserName !== 'firefox') expect(await axe(page)).toEqual([]);
    }

    // A state that does not lock the content (a stopped workflow made a draft again) edits.
    await h.setSendState('draft');
    await expect(pane.locator('[data-status="read-only"]')).toHaveCount(0);
    await expect(pane.getByRole('button', { name: 'Apply' })).toBeEnabled();
  });
});
