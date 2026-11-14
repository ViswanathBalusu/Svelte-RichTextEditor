/**
 * Spike S1 (SPK-014): what each browser lets Playwright 1.65 automate for composition and dead
 * keys, recorded per browser (test-results/evidence/input-drivers.*.json) and asserted, so that the
 * input matrix of FE-123 knows which cases need a scripted manual pass.
 */
import { expect, test } from '@playwright/test';
import { type BrowserFamily, DRIVER_FACTS } from '../test/input-method-matrix.ts';
import { SPIKE_IDS, openS1, record } from './helpers.ts';

/** The browser family of a Playwright browser, as the input-method matrix names it (FE-123). */
const family = (browserName: string): BrowserFamily =>
  browserName === 'firefox' ? 'gecko' : browserName === 'webkit' ? 'webkit' : 'chromium';

const compositionEvents = (events: string[]) =>
  events
    .filter((e) => /:composition(start|update|end):/.test(e))
    .map((e) => e.replace(/^main:/, ''));

test('keyboard.insertText: a composition in Firefox only', async ({ page, browserName }) => {
  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  await h.watchEvents();
  await page.keyboard.insertText('かな');
  const events = await h.events();
  record('input-drivers-insertText', { events });
  expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote target paragraph.かな');
  // The matrix's facts say the same (packages/element/test/input-method-matrix.ts).
  expect(DRIVER_FACTS.commitOnlyComposition[family(browserName)]).toBe(browserName === 'firefox');
  if (browserName === 'firefox') {
    // Juggler commits through nsITextInputProcessor.commitCompositionWith.
    expect(compositionEvents(events)).toEqual([
      'compositionstart:""',
      'compositionupdate:"かな"',
      'compositionend:"かな"',
    ]);
  } else {
    // Chromium (DevTools Input.insertText) and WebKit (Page.insertText): plain text insertion.
    expect(compositionEvents(events)).toEqual([]);
    expect(events).toContain('main:beforeinput:insertText:"かな":false');
  }
});

test('a character outside the keyboard layout: typed as text, or as a composition in Firefox', async ({
  page,
  browserName,
}) => {
  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  await h.watchEvents();
  // Playwright sends characters its US layout lacks through insertText.
  await page.keyboard.type('é');
  const events = await h.events();
  record('input-drivers-type-accented', { events });
  expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote target paragraph.é');
  expect(compositionEvents(events)).toEqual(
    browserName === 'firefox'
      ? ['compositionstart:""', 'compositionupdate:"é"', 'compositionend:"é"']
      : [],
  );
});

test('a dead key cannot be pressed through the keyboard API', async ({ page, browserName }) => {
  expect(DRIVER_FACTS.deadKeyPress[family(browserName)]).toBe(false);
  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  const error = await page.keyboard.press('Dead').then(
    () => null,
    (e: Error) => e.message.split('\n')[0]!,
  );
  record('input-drivers-dead-key', { error, text: await h.nodeText(SPIKE_IDS.after) });
  expect(error).toMatch(/Unknown key: "Dead"/);
});

test('WebKit and Firefox expose no protocol command for an open composition', async ({
  page,
  browserName,
}) => {
  test.skip(
    browserName === 'chromium',
    'Chromium has Input.imeSetComposition (s1-composition.spec.ts)',
  );
  const h = await openS1(page);
  await h.caretIn(SPIKE_IDS.after, 'end');
  // Internal API, used only to probe: the in-process Playwright server's page and its protocol session.
  const connection = (page as unknown as { _connection?: { toImpl?: (x: unknown) => unknown } })
    ._connection;
  const impl = connection?.toImpl?.(page) as
    { delegate?: { _session?: { send(m: string, p: unknown): Promise<unknown> } } } | undefined;
  const session = impl?.delegate?._session;
  const attempts: Record<string, string> = {};
  for (const method of [
    'Page.setComposition',
    'Page.imeSetComposition',
    'Input.imeSetComposition',
  ]) {
    if (!session) {
      attempts[method] = 'no protocol session reachable';
      continue;
    }
    attempts[method] = await session
      .send(method, { text: 'か', selectionStart: 1, selectionLength: 0 })
      .then(
        () => 'accepted',
        (e: Error) => e.message.split('\n')[0]!,
      );
  }
  record('input-drivers-protocol', { attempts, text: await h.nodeText(SPIKE_IDS.after) });
  for (const result of Object.values(attempts)) expect(result).not.toBe('accepted');
  expect(DRIVER_FACTS.stepwiseComposition[family(browserName)]).toBe(false);
});
