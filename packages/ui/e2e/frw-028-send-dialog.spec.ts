/**
 * The send dialog in the browser (FRW-028): the four checks listed with a word and an icon, the link
 * of each failed check, the send control and its confirmation, the server's verdict replacing the
 * list, the live region, keyboard use and axe, and the control's reason without `manage` or once the
 * workflow is sent. The checks and the send are a stand-in service (harness/frw-028-send-port.ts);
 * the service over the core and the workflow port is tested in packages/element and
 * packages/engine. Run from the repository root with
 * `DOCEDIT_UI_PORT=57628 pnpm exec playwright test -c packages/ui/playwright.config.ts packages/ui/e2e/frw-028-send-dialog.spec.ts`.
 */
import { axe, expect, open, test } from './helpers.ts';

const DIALOG = '[data-dialog="send"]';
const OWNER = { rev: 1, docRole: 'owner', caps: ['view', 'comment', 'edit', 'manage'], scopes: {} };
const EDITOR = { rev: 1, docRole: 'editor', caps: ['view', 'comment', 'edit'], scopes: {} };

const LABELS = [
  'Every required field has someone to fill it',
  'Every role has a participant',
  'The rules are valid',
  'No suggestion is unresolved',
];

test.describe('the pre-send checklist (FRW-028)', () => {
  test('lists the four checks, each passed or failed in words and with an icon', async ({
    page,
  }) => {
    const h = await open(page, { send: 'fail', permissions: OWNER, extended: true });
    expect(await h.exec('workflow.send')).toMatchObject({ ran: true });
    const dialog = page.locator(DIALOG);
    await expect(dialog).toBeVisible();
    const rows = dialog.locator('.de-send-check');
    await expect(rows).toHaveCount(4);
    for (const [i, label] of LABELS.entries()) {
      const row = rows.nth(i);
      await expect(row).toContainText(label);
      await expect(row.locator('[data-status="failed"]')).toHaveText('Failed');
      await expect(row.locator('svg[data-icon="fail"]')).toHaveCount(1);
    }
    await expect(rows.first()).toContainText('2 problems');
    await expect(rows.nth(1)).toContainText('1 problem');
    // The status is a word even where the icon is not seen: the icons are hidden from assistive technology.
    await expect(dialog.locator('svg[aria-hidden="true"]')).toHaveCount(4);
  });

  test('marks a check that passes with the word Passed and its own icon', async ({ page }) => {
    const h = await open(page, { send: 'pass', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const rows = page.locator(`${DIALOG} .de-send-check`);
    for (let i = 0; i < 4; i++) {
      await expect(rows.nth(i).locator('[data-status="passed"]')).toHaveText('Passed');
      await expect(rows.nth(i).locator('svg[data-icon="pass"]')).toHaveCount(1);
      await expect(rows.nth(i).locator('button')).toHaveCount(0);
    }
  });

  test('a failed check has a link to the field, the roles, the rules or the suggestion', async ({
    page,
  }) => {
    const h = await open(page, { send: 'fail', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await expect(
      dialog.getByRole('button', { name: 'Go to the field tenant.email' }),
    ).toBeVisible();
    await expect(
      dialog.getByRole('button', { name: 'Go to the field tenant.phone' }),
    ).toBeVisible();

    await dialog.getByRole('button', { name: 'Go to the field tenant.phone' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await h.sendLog()).fields).toEqual(['tenant.phone']);

    await h.exec('workflow.send');
    await dialog.getByRole('button', { name: 'Go to the suggestion sPropose00000001' }).click();
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await h.sendLog()).suggestions).toEqual(['sPropose00000001']);

    await h.exec('workflow.send');
    await dialog
      .getByRole('button', { name: 'Open the roles to give role_landlord a participant' })
      .click();
    await expect(page.locator('.de-pane[data-pane="roles"]')).toBeVisible();

    await h.exec('workflow.send');
    await dialog.getByRole('button', { name: 'Open the rules' }).click();
    await expect(page.locator('.de-pane[data-pane="rules"]')).toBeVisible();
  });
});

test.describe('the send control (FRW-028)', () => {
  test('is off while a check fails, with the reason in words', async ({ page }) => {
    const h = await open(page, { send: 'fail', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    const send = dialog.getByRole('button', { name: 'Send', exact: true });
    await expect(send).toBeDisabled();
    await expect(dialog.locator('[data-reason="send.control.checks_failed"]')).toHaveText(
      'Fix the failed checks to send.',
    );
    await expect(send).toHaveAccessibleDescription('Fix the failed checks to send.');
  });

  test('asks for confirmation, then shows the locked state and the workflow status', async ({
    page,
  }) => {
    const h = await open(page, { send: 'pass', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    // Nothing is sent by the first press.
    expect((await h.sendLog()).sends).toBe(0);
    await expect(dialog).toContainText('The document will be locked.');
    await dialog.getByRole('button', { name: 'Go back' }).click();
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeVisible();

    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(dialog.locator('[data-sent="true"]')).toContainText('The document is locked');
    await expect(dialog.locator('[data-workflow-state="sent"]')).toHaveText(
      'Workflow status: sent',
    );
    expect((await h.sendLog()).sends).toBe(1);
    await dialog.locator('.de-dialog-actions').getByRole('button', { name: 'Close' }).click();
    await expect(dialog).toHaveCount(0);
  });

  test('replaces the list with the server verdict when it refuses a send', async ({ page }) => {
    const h = await open(page, { send: 'server-refuses', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await expect(dialog.locator('[data-passed="false"]')).toHaveCount(0);
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(dialog.locator('[data-problem="refused"]')).toContainText(
      'The server found problems that the editor did not.',
    );
    await expect(dialog.locator('[data-passed="false"]')).toHaveCount(1);
    await expect(dialog.locator('[data-check="roles"] [data-status="failed"]')).toHaveText(
      'Failed',
    );
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
  });

  test('says when the server refuses the caller, and the workflow stays a draft', async ({
    page,
  }) => {
    const h = await open(page, { send: 'forbidden', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(dialog.locator('[data-problem="forbidden"]')).toContainText(
      'you may not manage this document',
    );
    await expect(dialog.locator('[data-sent]')).toHaveCount(0);
  });

  test('is off with a stated reason without manage', async ({ page }) => {
    const editor = await open(page, { send: 'pass', permissions: EDITOR, extended: true });
    await editor.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(dialog.locator('[data-reason="send.control.forbidden"]')).toHaveText(
      'You need the right to manage this document to send it.',
    );
  });

  test('is off with a stated reason for a workflow already sent', async ({ page }) => {
    const sent = await open(page, { send: 'sent', permissions: OWNER, extended: true });
    await sent.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(dialog.locator('[data-reason="send.control.not_draft"]')).toHaveText(
      'This workflow has already been sent.',
    );
  });

  test('waits for the workflow to be read before it can send', async ({ page }) => {
    const h = await open(page, { send: 'unread', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await expect(dialog.getByRole('button', { name: 'Send', exact: true })).toBeDisabled();
    await expect(dialog.locator('[data-reason="send.control.unknown"]')).toBeVisible();
    // The resource is read each time the dialog opens.
    expect((await h.sendLog()).refreshes).toBe(1);
  });
});

test.describe('the live region and the keyboard (FRW-028)', () => {
  test('announces the number of failed checks when it changes, and not when it does not', async ({
    page,
  }) => {
    const h = await open(page, { send: 'fail', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const live = page.locator(`${DIALOG} [data-send-live]`);
    await expect(live).toHaveAttribute('role', 'status');
    await expect(live).toHaveText('4 checks failed.');
    await h.setSendFailures([{ code: 'role_without_participant', roles: ['role_landlord'] }]);
    await expect(live).toHaveText('1 check failed.');
    // The same failing checks with other items: the number is the same, so nothing new is said.
    await h.setSendFailures([{ code: 'role_without_participant', roles: ['role_other'] }]);
    await expect(live).toHaveText('1 check failed.');
    await h.setSendFailures([]);
    await expect(live).toHaveText('All checks passed.');
    await expect(
      page.locator(DIALOG).getByRole('button', { name: 'Send', exact: true }),
    ).toBeEnabled();
  });

  test('is operable from the keyboard: Tab reaches the links, Enter follows one, Escape closes', async ({
    page,
  }) => {
    const h = await open(page, { send: 'fail', permissions: OWNER, extended: true });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    const link = dialog.getByRole('button', { name: 'Go to the field tenant.email' });
    // Focus starts inside the dialog; Tab moves along the links.
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(
      dialog.getByRole('button', { name: 'Go to the field tenant.phone' }),
    ).toBeFocused();
    await link.focus();
    await page.keyboard.press('Enter');
    await expect(dialog).toHaveCount(0);
    await expect.poll(async () => (await h.sendLog()).fields).toEqual(['tenant.email']);

    await h.exec('workflow.send');
    await expect(dialog).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveCount(0);
  });

  test('uses the external strings: an override replaces the title and a label', async ({
    page,
  }) => {
    const h = await open(page, {
      send: 'fail',
      permissions: OWNER,
      extended: true,
      overrides: {
        'dialog.send.title': 'Dispatch for signing',
        'send.check.roles': 'Every role is staffed',
      },
    });
    await h.exec('workflow.send');
    const dialog = page.locator(DIALOG);
    await expect(dialog).toContainText('Dispatch for signing');
    await expect(dialog).toContainText('Every role is staffed');
  });

  test('has no axe violations with failures, all passed, and once sent', async ({
    page,
    browserName,
  }) => {
    const fail = await open(page, { send: 'fail', permissions: OWNER, extended: true });
    await fail.exec('workflow.send');
    expect(await axe(page)).toEqual([]);
    await page.goto('about:blank');

    const pass = await open(page, { send: 'pass', permissions: OWNER, extended: true });
    await pass.exec('workflow.send');
    expect(await axe(page)).toEqual([]);
    const dialog = page.locator(DIALOG);
    await dialog.getByRole('button', { name: 'Send', exact: true }).click();
    await dialog.getByRole('button', { name: 'Confirm and send' }).click();
    await expect(dialog.locator('[data-sent="true"]')).toBeVisible();
    // Playwright's Firefox on Windows crashes the page while axe runs over some visible alerts.
    if (browserName !== 'firefox') expect(await axe(page)).toEqual([]);
  });
});
