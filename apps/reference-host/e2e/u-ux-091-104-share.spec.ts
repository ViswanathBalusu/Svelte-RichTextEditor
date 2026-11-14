/**
 * The host's share dialog in a browser against the demo stack (UX-095 criteria 1, 2, 4 and 6;
 * UX-093 criterion 6: `de-share-request` opens the dialog). Lane U-UX-091-104.
 *
 * Run against a stack that is already up (scripts/stack.ps1 up), so the global set-up does not
 * start one of its own:
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/u-ux-091-104-share.spec.ts
 *
 * Each test creates its own document with a title that carries the lane's name, and changes roles
 * only on that document.
 */
import { expect, test, type BrowserContext, type Page } from '@playwright/test';
import { openDocument, PEOPLE, recordEvents } from './support.ts';

const RUN = Date.now().toString(36);

async function newOwnerPage(browser: {
  newContext(): Promise<BrowserContext>;
}): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext();
  await recordEvents(context);
  return { context, page: await context.newPage() };
}

/** The host's own Share button in its editor bar (the element has a Share button of its own too). */
function hostShare(page: Page) {
  return page.locator('.editor-bar').getByRole('button', { name: 'Share', exact: true });
}

/**
 * The demo sign-in as Olivia. The page's own helper expects a trailing slash on the person's path,
 * which the host does not send, so this one waits for the person's name instead.
 */
async function signInAsOlivia(page: Page): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: `Continue as ${PEOPLE.olivia.name}` }).click();
  await expect(page.getByTestId('acting-as')).toHaveText(PEOPLE.olivia.name);
}

/** Creates a document from the template as Olivia (the owner) and opens it in the editor. */
async function createOwnedDocument(page: Page, title: string): Promise<string> {
  await signInAsOlivia(page);
  await page.getByLabel('Title', { exact: true }).fill(title);
  await page.getByRole('button', { name: 'Create and open' }).click();
  await expect(page).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
  const docId = page.url().split('/').pop()!;
  await openDocument(page, PEOPLE.olivia, docId);
  return docId;
}

test('the owner sees the people and groups with their roles, and a saved role says when it applies (UX-095 criteria 1, 2)', async ({
  browser,
}) => {
  const { context, page } = await newOwnerPage(browser);
  try {
    await createOwnedDocument(page, `U-UX-091-104 share ${RUN}`);
    await hostShare(page).click();
    const dialog = page.locator('dialog.share-dialog');
    await expect(dialog).toHaveJSProperty('open', true);
    await expect(dialog.getByRole('heading', { name: 'Share this document' })).toBeVisible();

    // Criterion 1: the seeded people, each with a role select offering the document-level roles.
    for (const person of [PEOPLE.ada, PEOPLE.bob, PEOPLE.vic]) {
      const row = dialog.locator(`tr[data-share-person="${person.sub}"]`);
      await expect(row).toContainText(person.name);
      const options = await row.locator('select[name="role"] option').allTextContents();
      expect(options).toEqual(
        expect.arrayContaining([
          'No access',
          'Viewer',
          'Commenter',
          'Suggester',
          'Editor',
          'Filler',
        ]),
      );
    }
    // The owner's own row is not a form (the action refuses to change the owner's role).
    await expect(dialog.locator(`tr[data-share-person="${PEOPLE.olivia.sub}"] form`)).toHaveCount(
      0,
    );
    // The seeded groups, with the roles of their members.
    const finance = dialog.locator('[data-share-group="g-finance"]');
    await expect(finance).toContainText('Finance');
    await expect(finance).toContainText(PEOPLE.ada.name);

    // Criterion 2: Vic is a viewer; making him a commenter ends his sessions on the document, so the
    // dialog says the change applies now.
    const vic = dialog.locator(`tr[data-share-person="${PEOPLE.vic.sub}"]`);
    await vic.locator('select[name="role"]').selectOption('commenter');
    await vic.getByRole('button', { name: 'Save role' }).click();
    const done = dialog.getByTestId('share-done');
    await expect(done).toContainText(`${PEOPLE.vic.name} is now commenter.`);
    await expect(done).toContainText(
      'Their sessions on this document have ended, so the change applies now.',
    );

    // The change is stored in the host: after a reload the dialog shows the new role.
    await page.reload();
    await expect(page.locator('doc-editor')).toBeVisible();
    await hostShare(page).click();
    await expect(
      page.locator(
        `dialog.share-dialog tr[data-share-person="${PEOPLE.vic.sub}"] select[name="role"]`,
      ),
    ).toHaveValue('commenter');
  } finally {
    await context.close();
  }
});

test('the dialog does not manage region grants and points to the permissions pane (UX-095 criterion 4)', async ({
  browser,
}) => {
  const { context, page } = await newOwnerPage(browser);
  try {
    await createOwnedDocument(page, `U-UX-091-104 pane ${RUN}`);
    await hostShare(page).click();
    const dialog = page.locator('dialog.share-dialog');
    await expect(dialog).toHaveJSProperty('open', true);
    await expect(dialog).toContainText(
      'Region grants and workflow participants are not managed here.',
    );
    await expect(dialog).toContainText("Use the editor's permissions pane for them.");
    // No control in the dialog changes a region grant or a participant.
    await expect(
      dialog.locator('select[name="region"], input[name="region"], input[name="principal"]'),
    ).toHaveCount(0);
  } finally {
    await context.close();
  }
});

test('the keyboard keeps focus in the open dialog and returns it to the Share button (UX-095 criterion 6)', async ({
  browser,
}) => {
  const { context, page } = await newOwnerPage(browser);
  try {
    await createOwnedDocument(page, `U-UX-091-104 focus ${RUN}`);
    const share = hostShare(page);
    await share.focus();
    await page.keyboard.press('Enter');
    const dialog = page.locator('dialog.share-dialog');
    await expect(dialog).toHaveJSProperty('open', true);
    // Tab well past the last control: focus stays inside the dialog at every step.
    const escapes: boolean[] = [];
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press('Tab');
      escapes.push(
        await dialog.evaluate(
          (d) => d.contains(document.activeElement) && document.activeElement !== null,
        ),
      );
    }
    expect(escapes.every(Boolean)).toBe(true);
    // Shift+Tab from the first control also stays inside.
    for (let i = 0; i < 5; i++) {
      await page.keyboard.press('Shift+Tab');
      expect(await dialog.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    }
    // Escape closes the dialog and focus goes back to the button that opened it.
    await page.keyboard.press('Escape');
    await expect(dialog).toHaveJSProperty('open', false);
    await expect(share).toBeFocused();
  } finally {
    await context.close();
  }
});

test("the element's share command opens the host's dialog (UX-093 criterion 6; UX-095 criterion 1)", async ({
  browser,
}) => {
  const { context, page } = await newOwnerPage(browser);
  try {
    await createOwnedDocument(page, `U-UX-091-104 request ${RUN}`);
    const dialog = page.locator('dialog.share-dialog');
    await expect(dialog).toHaveJSProperty('open', false);
    // The element's own Share button runs its share command, which raises `de-share-request`; the
    // page glue opens the host's dialog. Clicked inside the element's shadow root, as a person does.
    await page.locator('doc-editor').getByRole('button', { name: 'Share', exact: true }).click();
    await expect(dialog).toHaveJSProperty('open', true);
    await expect(dialog.getByRole('heading', { name: 'Share this document' })).toBeVisible();
  } finally {
    await context.close();
  }
});
