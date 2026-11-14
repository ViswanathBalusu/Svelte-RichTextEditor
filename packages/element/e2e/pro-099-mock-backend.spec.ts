/**
 * PRO-099 criteria 1 and 3 on the element (lane U-PRO-086-102): the in-memory mock backend, given
 * as the `backend` property, opens a document and takes edits with no network request; and a mock
 * built without the `presence` port shows no presence controls, even with a second user live on
 * the document. The backend half is in
 * packages/backend-mock/test/offline.test.ts. Chromium, Edge, Firefox and WebKit.
 */
import { type Locator, type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const NETWORK = new Set(['fetch', 'xhr', 'websocket', 'eventsource']);

test('PRO-099: the mock backend opens a document and takes edits with no network request', async ({
  page,
}) => {
  await openEmbed(page);
  // Watch from before the element mounts, so that opening the document is covered as well as
  // editing it. The demo page's own scripts and styles load before this point.
  const network: string[] = [];
  page.on('request', (r) => {
    if (NETWORK.has(r.resourceType())) network.push(`${r.resourceType()} ${r.url()}`);
  });
  page.on('websocket', (ws) => network.push(`websocket ${ws.url()}`));

  await mountEditor(page, { sub: 'ada', name: 'mock-offline' });
  const editor = page.locator('doc-editor[data-test="mock-offline"]');
  const surface = editor.locator('.de-editing-surface');
  await expect(surface).toBeVisible();

  // Place the caret at the end of the last paragraph, as the other element specs do. A click on
  // the centre of the surface can miss every paragraph, and WebKit then has no caret to type at.
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' offlineedit');
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain('offlineedit');
  // Give any late request a moment to show itself.
  await page.waitForTimeout(300);
  expect(network).toEqual([]);
});

/*
 * PRO-099 criterion 3 (fixer V4 group 1, round 2). `Presence.svelte` renders `.de-presence` only
 * while there is a peer (`shown.length > 0`), so an absence check with one user passes with or
 * without the port. Both tests below therefore take the same steps: ada opens the document, bob
 * opens the same document in a second editor, bob types, and ada's editor shows bob's text (so the
 * two are live on one document). They differ only in the service: the embed page's default mock,
 * which offers `presence`, or `backendWithoutPresence` (`new MockService({ presence: false })`).
 * The control must show `.de-presence` within PRESENCE_WINDOW_MS; the absence test then waits the
 * same window and must find none.
 */
const PRESENCE_WINDOW_MS = 10_000;

/** Mounts `<doc-editor>` named `name` for `sub` on the default mock or the mock without presence. */
async function mountOn(
  page: Page,
  opts: { presence: boolean; sub: string; name: string; target: string },
): Promise<void> {
  await page.evaluate(async ({ presence, sub, name, target }) => {
    const e = (
      window as unknown as {
        __embed: {
          backend(s: string, role: string): unknown;
          docId: string;
          backendWithoutPresence(s: string): unknown;
          noPresenceDocId: string;
        };
      }
    ).__embed;
    if (!document.getElementById(target)) {
      const div = document.createElement('div');
      div.id = target;
      document.body.append(div);
    }
    const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
    el.dataset['test'] = name;
    el.setAttribute('doc-id', presence ? e.docId : e.noPresenceDocId);
    el['backend'] = presence ? e.backend(sub, 'editor') : e.backendWithoutPresence(sub);
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
        { once: true },
      );
    });
    document.getElementById(target)!.append(el);
    await ready;
  }, opts);
  await expect(
    page.locator(`doc-editor[data-test="${opts.name}"] .de-editing-surface`),
  ).toBeVisible();
}

/** Ada and bob on one document of the chosen mock; bob types, and ada's editor shows it. */
async function twoUsersLive(page: Page, presence: boolean): Promise<Locator> {
  await openEmbed(page);
  await mountOn(page, { presence, sub: 'ada', name: 'ada', target: 'mount' });
  await mountOn(page, { presence, sub: 'bob', name: 'bob', target: 'mount-peer' });
  const bob = page.locator('doc-editor[data-test="bob"] .de-editing-surface');
  await bob.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' bobwashere');
  const ada = page.locator('doc-editor[data-test="ada"]');
  await expect
    .poll(() => ada.locator('.de-editing-surface').evaluate((el) => el.textContent ?? ''), {
      timeout: 15_000,
    })
    .toContain('bobwashere');
  return ada;
}

test('PRO-099: a mock built without the presence port shows no presence controls', async ({
  page,
}) => {
  const ada = await twoUsersLive(page, false);
  // Wait the whole window in which the control below sees the presence controls appear.
  await page.waitForTimeout(PRESENCE_WINDOW_MS);
  await expect(ada.locator('.de-presence')).toHaveCount(0);
  await expect(page.locator('doc-editor[data-test="bob"] .de-presence')).toHaveCount(0);
});

/**
 * Positive control for the absence check above: the same steps on the default mock, which offers
 * `presence`, make the presence controls appear in ada's editor within the same window.
 */
test('PRO-099: a mock with the presence port shows the presence controls once a peer joins', async ({
  page,
}) => {
  const ada = await twoUsersLive(page, true);
  await expect(ada.locator('.de-presence')).toBeVisible({ timeout: PRESENCE_WINDOW_MS });
});
