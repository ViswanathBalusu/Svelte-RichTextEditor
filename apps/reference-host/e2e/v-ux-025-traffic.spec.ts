/**
 * UX-025 criterion 5 (lane V-UX-016-030): the names and avatars that `resolveUsers` returns from the
 * host's directory never reach the document service. Two people open one document in two browser
 * contexts, so each page names the other through `resolveUsers`; every request and frame sent to
 * or received from the document service is recorded, and none of them may contain a name the host
 * supplied. The host's own directory answers must contain the names, so the test is not vacuous.
 *
 * Run against the lane's own stack (the ports are the lane's; the stack is left running):
 *
 *   DOCEDIT_DEMO_REUSE=1, DOCEDIT_DEMO_PROJECT=docedit-v-ux-016-030-demo,
 *   DOCEDIT_DEMO_PG_PORT=57260, DOCEDIT_DEMO_S3_PORT=57261, DOCEDIT_DEMO_SERVICE_PORT=57262,
 *   DOCEDIT_DEMO_HOST_PORT=57263 and DOCEDIT_DEMO_DATA set in the environment of the run:
 *   pnpm exec playwright test -c apps/reference-host/playwright.config.ts e2e/v-ux-025-traffic.spec.ts
 *
 * The test creates no document and changes none: it only opens the seeded document of the catalogue.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type BrowserContext, expect, type Page, test, type WebSocket } from '@playwright/test';
import { dataDir } from '../scripts/lib/stack.ts';
import {
  hostUrl,
  openDocument,
  PEOPLE,
  recordEvents,
  regionParagraph,
  serviceUrl,
} from './support.ts';

const SEEDED_TITLE = 'Supply agreement (demo)';

// Two traces written at once into the run's folder failed on close; this test keeps none.
test.use({ trace: 'off' });

interface Traffic {
  /** Text of every request to the document service: URL, body and response body, and frames. */
  service: string[];
  /** Text of every host response from the directory route. */
  directory: string[];
}

/** The demo sign-in (UX-092): one button per person; the page then sits at /as/<sub>. */
async function signIn(page: Page, person: { sub: string; name: string }): Promise<void> {
  await page.goto('/');
  await page.getByRole('button', { name: `Continue as ${person.name}` }).click();
  await expect(page).toHaveURL(new RegExp(`/as/${person.sub}/?$`));
}

async function record(context: BrowserContext, traffic: Traffic): Promise<void> {
  const service = new URL(serviceUrl());
  const host = new URL(hostUrl());
  context.on('request', (r) => {
    const url = new URL(r.url());
    if (url.origin === service.origin) traffic.service.push(r.url(), r.postData() ?? '');
  });
  context.on('response', async (r) => {
    const url = new URL(r.url());
    try {
      if (url.origin === service.origin) traffic.service.push(await r.text());
      if (url.origin === host.origin && url.pathname.endsWith('/api/directory'))
        traffic.directory.push(await r.text());
    } catch {
      // A body the browser does not keep has no text; nothing to check there.
    }
  });
  const onSocket = (ws: WebSocket) => {
    if (ws.url().includes(`:${service.port}`)) {
      ws.on('framesent', (f) => traffic.service.push(String(f.payload)));
      ws.on('framereceived', (f) => traffic.service.push(String(f.payload)));
    }
  };
  context.on('page', (p) => p.on('websocket', onSocket));
}

function seededDocId(): string {
  const catalogue = JSON.parse(readFileSync(join(dataDir(), 'catalogue.json'), 'utf8')) as {
    documents: { id: string; title: string }[];
  };
  const found = catalogue.documents.find((d) => d.title === SEEDED_TITLE);
  if (!found) throw new Error(`the seeded document "${SEEDED_TITLE}" is not in the catalogue`);
  return found.id;
}

test('no name or avatar from resolveUsers reaches the document service (UX-025 criterion 5)', async ({
  browser,
}) => {
  const docId = seededDocId();
  const olivia = await browser.newContext();
  const ada = await browser.newContext();
  await recordEvents(olivia);
  await recordEvents(ada);
  const oliviaTraffic: Traffic = { service: [], directory: [] };
  const adaTraffic: Traffic = { service: [], directory: [] };
  await record(olivia, oliviaTraffic);
  await record(ada, adaTraffic);

  try {
    const first = await olivia.newPage();
    await signIn(first, PEOPLE.olivia);
    await openDocument(first, PEOPLE.olivia, docId);

    // Ada arrives after Olivia: Olivia's page names her through resolveUsers.
    const second = await ada.newPage();
    await signIn(second, PEOPLE.ada);
    await openDocument(second, PEOPLE.ada, docId);
    // A caret in a region sends Ada's presence (no text is typed, so the document does not change).
    await regionParagraph(second, 'Payment section').click();
    // Olivia's page asks the directory for the names it needs: Ada's name must come back from it.
    await expect
      .poll(() => oliviaTraffic.directory.some((t) => t.includes(PEOPLE.ada.name)), {
        message: "the host's directory named Ada to Olivia's page (resolveUsers was called)",
        timeout: 30_000,
      })
      .toBe(true);

    const supplied = [PEOPLE.olivia.name, PEOPLE.ada.name, PEOPLE.bob.name, PEOPLE.vic.name];
    // The service's welcome names the signed-in user from the token it was given (not from
    // resolveUsers); that one object is set aside, and no other frame or request may carry a name.
    const WELCOME_USER = /"user":\{"id":"[^"]*","name":"[^"]*"\}/g;
    const seen = [...oliviaTraffic.service, ...adaTraffic.service]
      .map((t) => t.replace(WELCOME_USER, ''))
      .join('\n');
    // Not vacuous: the service's traffic carries the identifiers of the people present.
    expect(seen.length, 'service traffic was recorded').toBeGreaterThan(0);
    expect(oliviaTraffic.directory.length, 'the directory was asked for names').toBeGreaterThan(0);

    for (const name of supplied)
      expect(seen.includes(name), `"${name}" in service traffic`).toBe(false);
  } finally {
    await olivia.close();
    await ada.close();
  }
});
