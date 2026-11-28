/**
 * UX-106 against the demo stack (lane w3, 2026-11-27): the owner sends the Lease template to two
 * participants (the tenant, then the landlord); each opens the invitation from the mail sink, asks
 * for a passcode with the keyboard, takes it from the mail sink, and fills in `<doc-editor mode="fill">`
 * with the token from the host's participant endpoint. A participant who declines gives a reason and
 * the owner sees the workflow declined.
 *
 * The stack's document service announces no `sign` or `seal` feature (its PostgreSQL composition has
 * no consent-text store, no sealed-PDF store and no signing service), so the consent step, the
 * signature and the sealed PDF are not exercised here (see the Notes of UX-106).
 *
 *   $env:DOCEDIT_DEMO_REUSE = '1'; $env:DOCEDIT_DEMO_HOST_PORT = '57387'
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/w3-ux-106-fill-and-sign.spec.ts
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type BrowserContext, type Page } from '@playwright/test';
import { setting, stackSettings } from '../scripts/lib/stack.ts';
import { editor, eventsOf, PEOPLE, recordEvents, serviceUrl, signIn } from './support.ts';

const MAIL_UI = (): string =>
  `http://127.0.0.1:${setting(stackSettings(), 'DOCEDIT_DEMO_MAIL_UI_PORT')}/api/v1`;

/** The text of the newest mail to an address that has the words, waiting for it to arrive. */
async function mailText(to: string, words: string): Promise<string> {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    const res = await fetch(`${MAIL_UI()}/search?query=${encodeURIComponent(`to:${to} ${words}`)}`);
    const found = ((await res.json()) as { messages?: Array<{ ID: string }> }).messages ?? [];
    if (found[0]) {
      const full = (await (await fetch(`${MAIL_UI()}/message/${found[0].ID}`)).json()) as {
        Text: string;
      };
      return full.Text;
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`no mail to ${to} with "${words}"`);
}

async function opened(page: Page): Promise<void> {
  await expect
    .poll(async () => (await eventsOf(page, 'de-ready')).length, { timeout: 60_000 })
    .toBeGreaterThan(0);
}

const noViolations = async (page: Page): Promise<void> => {
  expect((await new AxeBuilder({ page }).analyze()).violations).toEqual([]);
};

/** The owner creates a lease and sends it to a tenant (first) and a landlord (second). */
async function sendLease(
  browser: Browser,
  stamp: string,
): Promise<{
  owner: BrowserContext;
  ownerPage: Page;
  docUrl: string;
  tenant: string;
  landlord: string;
}> {
  const owner = await browser.newContext();
  await recordEvents(owner);
  const op = await owner.newPage();
  await signIn(op, PEOPLE.olivia);
  await op.goto(`/as/${PEOPLE.olivia.sub}/templates`);
  const lease = op.locator('[data-template="lease"]');
  await lease.getByLabel('Title of the new document').fill(`Lease ${stamp}`);
  await lease.getByRole('button', { name: /^Create from / }).click();
  await expect(op).toHaveURL(/\/docs\/[0-9a-f-]{36}$/);
  const docUrl = op.url();
  await op.goto(`${docUrl}/send`);
  const tenant = `tess-${stamp}@people.example.test`;
  const landlord = `lars-${stamp}@people.example.test`;
  const people = [
    ['Tess Tenant', tenant, 'filler'],
    ['Lars Landlord', landlord, 'signer'],
  ] as const;
  for (const [i, [name, email, kind]] of people.entries()) {
    await op.locator(`#name-${i}`).fill(name);
    await op.locator(`#email-${i}`).fill(email);
    await op.locator(`#kind-${i}`).selectOption(kind);
  }
  await op.getByRole('button', { name: 'Send for completion' }).click();
  await expect(op.getByText('Each person is invited by e-mail')).toBeVisible();
  return { owner, ownerPage: op, docUrl, tenant, landlord };
}

/** Opens an invitation as a person with no account and passes the passcode, by keyboard. */
async function enter(
  context: BrowserContext,
  email: string,
): Promise<{ page: Page; link: string; tokens: string[] }> {
  const link = /https?:\/\/\S+\/fill\/\S+/.exec(await mailText(email, 'You are asked'))?.[0];
  expect(link, 'the invitation carries a link').toBeTruthy();
  expect(link).not.toMatch(/token|eyJ/);
  const page = await context.newPage();
  // The token responses of the host's endpoint, for the claims the host asserted.
  const tokens: string[] = [];
  page.on('response', (r) => {
    if (r.url().endsWith('/api/token') && r.ok())
      void r.json().then((b: { token: string }) => tokens.push(b.token));
  });
  await page.goto(link!);
  await noViolations(page);
  await page.getByRole('button', { name: 'Send me a passcode' }).press('Enter');
  await expect(page.getByText('A passcode was sent')).toBeVisible();
  const code = /passcode is (\d{6})/.exec(await mailText(email, 'passcode'))?.[1];
  expect(code, 'the passcode mail has six digits').toBeTruthy();
  const field = page.getByLabel(/^Passcode/);
  await field.fill(code!);
  await field.press('Enter');
  return { page, link: link!, tokens };
}

/** The host's token endpoint as the page's own fetch asks it: a JSON POST with the session cookie. */
const askToken = (context: BrowserContext, link: string) =>
  context.request.post(`${link}/api/token`, { data: {} });

const claimsOf = (jwt: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

test('two participants fill from their invitations, one after the other (UX-106)', async ({
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const sent = await sendLease(browser, stamp);
  const { owner, ownerPage, docUrl } = sent;
  const doc = /([0-9a-f-]{36})$/.exec(docUrl)![1]!;
  const contexts: BrowserContext[] = [owner];
  try {
    // 1. The tenant: the editor in fill mode, the token not in the address, the page or a readable cookie.
    const tenant = await browser.newContext();
    contexts.push(tenant);
    await recordEvents(tenant);
    const t = await enter(tenant, sent.tenant);
    await opened(t.page);
    expect(t.page.url()).toContain(t.link);
    expect(t.page.url()).not.toMatch(/eyJ|token/);
    expect(await t.page.content()).not.toMatch(/eyJ[A-Za-z0-9_-]{10,}\./);
    expect(await t.page.evaluate(() => document.cookie)).toBe('');
    const cookie = (await tenant.cookies()).find((c) => c.name === 'docedit_demo_participant');
    expect(cookie, 'the host session is a cookie').toMatchObject({
      httpOnly: true,
      sameSite: 'Strict',
    });
    expect(t.tokens.length).toBeGreaterThan(0);
    const claims = claimsOf(t.tokens[0]!);
    expect(claims['amr']).toEqual(['otp']);
    expect(typeof claims['wfp']).toBe('string');
    expect(typeof claims['auth_time']).toBe('number');
    await noViolations(t.page);

    // 2. Only the fields assigned to the tenant take input; the landlord's are read-only.
    const name = editor(t.page).getByLabel('Tenant name');
    await expect(name).toBeEditable();
    await expect(editor(t.page).getByLabel('Monthly rent')).not.toBeEditable();
    await expect(editor(t.page).getByLabel('Start date')).not.toBeEditable();
    await name.fill('Tess Tenant');
    await name.press('Tab'); // a field takes its value when the person leaves it
    // The value reaches the service through the normal commit path: read it back with the participant's token.
    const read = async (): Promise<string> => {
      const res = await askToken(tenant, t.link);
      if (!res.ok()) return '';
      const { token } = (await res.json()) as { token: string };
      const values = await tenant.request.get(`${serviceUrl()}/v1/documents/${doc}/field-values`, {
        headers: { Authorization: `Bearer ${token}` },
      });
      return values.ok() ? await values.text() : `status ${values.status()}`;
    };
    await expect.poll(read, { timeout: 30_000 }).toContain('Tess Tenant');
    // 3. Finish through the embedding API (the host's button calls completeFilling()).
    await t.page.getByTestId('host-finish').click();
    const confirmation = t.page.getByTestId('fill-confirmation');
    await expect(confirmation).toBeVisible({ timeout: 30_000 });
    await expect(confirmation).toContainText('Thank you, Tess Tenant');
    await expect(confirmation).toBeFocused();
    await noViolations(t.page);

    // 4. The next participant is invited, and the tenant's old link no longer lets anyone edit.
    expect(await mailText(sent.landlord, 'You are asked')).toMatch(/\/fill\//);
    await expect
      .poll(async () => (await askToken(tenant, t.link)).status(), {
        timeout: 30_000,
      })
      .toBe(410);
    await t.page.reload();
    await expect(t.page.getByTestId('fill-confirmation')).toBeVisible();
    await expect(t.page.locator('doc-editor')).toHaveCount(0);

    // 5. The landlord fills the landlord's fields and finishes.
    const landlord = await browser.newContext();
    contexts.push(landlord);
    await recordEvents(landlord);
    const l = await enter(landlord, sent.landlord);
    await opened(l.page);
    await expect(editor(l.page).getByLabel('Tenant name')).not.toBeEditable();
    await editor(l.page).getByLabel('Monthly rent').fill('1200');
    await editor(l.page).getByLabel('Monthly rent').press('Tab');
    await editor(l.page).getByLabel('Start date').fill('2027-01-01');
    await editor(l.page).getByLabel('Start date').press('Tab');
    await l.page.getByTestId('host-finish').click();
    await expect(l.page.getByTestId('fill-confirmation')).toBeVisible({ timeout: 30_000 });

    // 6. The owner sees both parts completed.
    await ownerPage.goto(`${docUrl}/send`);
    const parts = ownerPage.locator('td[data-testid^="part-"]');
    await expect(parts.first()).toHaveText('completed', { timeout: 30_000 });
    await expect(parts.last()).toHaveText('completed', { timeout: 30_000 });
  } finally {
    for (const c of contexts) await c.close();
  }
});

test('a participant who declines gives a reason and the owner sees the workflow declined (UX-106)', async ({
  browser,
}) => {
  const stamp = Date.now().toString(36);
  const sent = await sendLease(browser, stamp);
  const tenant = await browser.newContext();
  try {
    await recordEvents(tenant);
    const t = await enter(tenant, sent.tenant);
    await opened(t.page);
    await t.page.getByRole('button', { name: 'I do not want to sign' }).click();
    // A reason is asked for; none is not accepted.
    const why = t.page.getByLabel(/^Why do you not want to sign/);
    await expect(why).toBeFocused();
    await t.page.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(t.page.getByTestId('host-problem')).toContainText('Say why');
    await why.fill('The rent is not the one we agreed.');
    await t.page.getByRole('button', { name: 'Decline', exact: true }).click();
    await expect(t.page.getByTestId('fill-confirmation')).toContainText('You declined', {
      timeout: 30_000,
    });
    await noViolations(t.page);

    await sent.ownerPage.goto(`${sent.docUrl}/send`);
    await expect(sent.ownerPage.getByText('State:').locator('strong')).toHaveText('declined', {
      timeout: 30_000,
    });
    await expect.poll(async () => (await askToken(tenant, t.link)).status()).toBe(410);
  } finally {
    await tenant.close();
    await sent.owner.close();
  }
});
