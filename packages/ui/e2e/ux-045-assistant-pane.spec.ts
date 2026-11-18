/**
 * The assistant pane (UX-045; lane w3). With an assistant port the pane is offered and its command
 * exists; a request shows its answer in the pane and changes nothing in the document; a running
 * request is cancelled at the port; a failure says what happened and offers a retry; a view-only
 * author may ask and summarise but not draft or rewrite; progress and completion are announced.
 * Run from the repository root with `DOCEDIT_UI_PORT=57271 pnpm exec playwright test
 * -c packages/ui/playwright.config.ts packages/ui/e2e/ux-045-assistant-pane.spec.ts --project=<browser>`.
 * The assistant is a scripted fake (`assistant` option of the harness); no real provider is called.
 */
import { axe, expect, open, test } from './helpers.ts';

const PANE = '.de-pane[data-pane="assistant"]';
const EDITOR = { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'] } as const;
const VIEWER = { scope: 'body', caps: ['view'] } as const;

test.describe('the assistant pane (UX-045)', () => {
  test('is offered only while a port is attached, and then appears and goes at once (criterion 5)', async ({
    page,
  }) => {
    const none = await open(page, { extended: true });
    expect((await none.commandIds()).filter((id) => id.includes('assistant'))).toEqual([]);
    expect(await none.exec('view.assistant')).toMatchObject({ ran: false });
    await expect(page.locator(PANE)).toHaveCount(0);

    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    expect(await h.commandIds()).toContain('view.assistant');
    await h.exec('view.assistant');
    await expect(page.locator(PANE)).toBeVisible();
    await h.setAssistantAvailable(false);
    await expect.poll(async () => (await h.commandIds()).includes('view.assistant')).toBe(false);
  });

  test('shows the answer in the pane and changes nothing in the document (criteria 1 and 2)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    await h.exec('view.assistant');
    const pane = page.locator(PANE);
    const revision = await h.revision();
    await pane.getByRole('textbox').fill('Say hello');
    for (const [kind, task] of [
      ['draft', 'draft'],
      ['rewrite', 'rewrite'],
      ['summary', 'summarise'],
      ['question', 'answer'],
    ] as const) {
      await pane.locator(`[data-ask="${kind}"]`).click();
      await expect(pane.locator('[data-assistant-state="shown"]')).toHaveText(
        'Answer to: Say hello',
      );
      expect((await h.assistantCalls()).at(-1)).toMatchObject({ task, prompt: 'Say hello' });
      await pane.getByRole('button', { name: 'Clear' }).click();
    }
    expect(await h.revision()).toBe(revision);
  });

  test('cancel stops the request at the port and applies nothing (criterion 3)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    await h.setAssistantMode('hang');
    await h.exec('view.assistant');
    const pane = page.locator(PANE);
    await pane.locator('[data-ask="draft"]').click();
    await expect(pane.locator('[data-assistant-state="running"]')).toBeVisible();
    await pane.locator('[data-assistant-cancel]').click();
    await expect(pane.locator('[data-assistant-state="cancelled"]')).toBeVisible();
    await expect(pane.locator('[data-assistant-live]')).toHaveText(/cancelled/);
    expect((await h.assistantCalls()).map((c) => c.aborted)).toEqual([true]);
    await expect(pane.locator('[data-assistant-state="shown"]')).toHaveCount(0);
  });

  test('a failure is explained, nothing is applied and retry works (criterion 4)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    await h.exec('view.assistant');
    const pane = page.locator(PANE);
    const revision = await h.revision();
    for (const mode of ['rate_limited', 'quota_exceeded', 'fail'] as const) {
      await h.setAssistantMode(mode);
      await pane.locator('[data-ask="question"]').click();
      const failed = pane.locator('[data-assistant-state="failed"]');
      await expect(failed).toHaveAttribute('data-failure', mode === 'fail' ? 'port_failure' : mode);
      await expect(failed).toContainText('Nothing was applied');
      await expect(pane.locator('[data-assistant-retry]')).toBeVisible();
    }
    await h.setAssistantMode('ok');
    await pane.locator('[data-assistant-retry]').click();
    await expect(pane.locator('[data-assistant-state="shown"]')).toBeVisible();
    expect(await h.revision()).toBe(revision);
  });

  test('a view-only author may ask and summarise; draft and rewrite are unavailable with a reason (criterion 6)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: VIEWER });
    await h.exec('view.assistant');
    const pane = page.locator(PANE);
    for (const kind of ['draft', 'rewrite'] as const) {
      const button = pane.locator(`[data-ask="${kind}"]`);
      await expect(button).toHaveAttribute('aria-disabled', 'true');
      await expect(button).toHaveAccessibleDescription(/does not allow/);
      await button.click({ force: true });
    }
    expect(await h.assistantCalls()).toHaveLength(0);
    for (const kind of ['summary', 'question'] as const) {
      const button = pane.locator(`[data-ask="${kind}"]`);
      await expect(button).not.toHaveAttribute('aria-disabled', 'true');
      await button.click();
      await expect(pane.locator('[data-assistant-state="shown"]')).toBeVisible();
      await pane.getByRole('button', { name: 'Clear' }).click();
    }
    expect((await h.assistantCalls()).map((c) => c.task)).toEqual(['summarise', 'answer']);
  });

  test('progress and completion are announced, the answer is reachable by keyboard and the pane passes axe (criterion 7)', async ({
    page,
  }) => {
    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    await h.exec('view.assistant');
    const pane = page.locator(PANE);
    const live = pane.locator('[data-assistant-live]');
    await expect(live).toHaveAttribute('role', 'status');
    await h.setAssistantMode('hang');
    await pane.getByRole('textbox').fill('Wait');
    await pane.locator('[data-ask="draft"]').click();
    await expect(live).toHaveText('The assistant is working.');
    await pane.locator('[data-assistant-cancel]').click();
    await h.setAssistantMode('ok');
    // Keyboard only: focus the question button and press Enter.
    await pane.locator('[data-ask="question"]').focus();
    await page.keyboard.press('Enter');
    await expect(live).toHaveText(/The assistant has answered/);
    const answer = pane.locator('[data-assistant-state="shown"]');
    await expect(answer).toHaveAttribute('role', 'region');
    await expect(answer).toHaveAccessibleName('Response');
    await expect(answer).toHaveText('Answer to: Wait');
    expect(await axe(page)).toEqual([]);
  });
});
