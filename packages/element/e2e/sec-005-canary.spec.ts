/**
 * SEC-005 criteria 2 and 3, in part (lane U-SEC-001-016): script-injection payloads through the
 * editor's own input paths in every browser, with a canary that a payload would set. No canary
 * may fire, no element outside the schema may appear on the editing surface, and the payload must
 * show as text. Three paths:
 * 1. typed text (keyboard input into the last paragraph);
 * 2. pasted HTML without an embedded fragment, with a plain-text part: the HTML is read through the
 *    whitelist (FE-054) and its own text is pasted; HTML that yields no text (a script only) gives way
 *    to the plain text. The order is the default of 02 §5.2 recorded in ADR 0303 item 1 (proposed,
 *    for the owner to confirm);
 * 3. pasted HTML with an embedded fragment (a real copy of the paragraph, its text replaced by a
 *    payload), so the fragment path is the one that runs.
 * Not covered here (criterion 2 and 3 stay unticked, see the story Notes): display names, comment
 * bodies, field labels and values, region titles, alt text, document titles, the Word and Google
 * Docs cleaners (not built in this tree), PUT, prefill, import and restore.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const PAYLOADS: readonly string[] = [
  '<img src=x onerror="window.__canary=1">',
  '<svg onload="window.__canary=2"></svg>',
  '<a href="javascript:window.__canary=3">x</a>',
  '<iframe src="data:text/html,<script>window.__canary=4</script>"></iframe>',
  '<math><mi xlink:href="javascript:window.__canary=5">x</mi></math>',
];

const SURFACE_FORBIDDEN =
  'img, svg, script, iframe, math, object, embed, style, a[href^="javascript"], a[href^="data"]';

async function surfaceOf(page: Page, name: string) {
  return page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
}

/** Asserts no canary fired, and nothing the schema does not hold is on the surface. */
async function expectInert(page: Page, name: string, payload: string): Promise<void> {
  const canary = await page.evaluate(() => (window as unknown as { __canary?: unknown }).__canary);
  expect(canary, `no canary fired for ${JSON.stringify(payload)}`).toBeUndefined();
  const surface = await surfaceOf(page, name);
  const forbidden = await surface.locator(SURFACE_FORBIDDEN).count();
  expect(forbidden, 'no element outside the schema is on the surface').toBe(0);
}

/** Dispatches a paste with the given parts; the component reads the clipboard data it is given. */
async function paste(page: Page, name: string, parts: { html?: string; text?: string }) {
  await page.evaluate(
    ({ name, parts }) => {
      const host = document.querySelector(`doc-editor[data-test="${name}"]`)!;
      const target = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
      const dt = new DataTransfer();
      if (parts.html !== undefined) dt.setData('text/html', parts.html);
      if (parts.text !== undefined) dt.setData('text/plain', parts.text);
      target.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, composed: true, clipboardData: dt }),
      );
    },
    { name, parts },
  );
}

test('SEC-005: typed payloads stay inert text in every browser', async ({ page }) => {
  await openEmbed(page);
  await mountEditor(page, { sub: 'ada', role: 'editor', name: 'sec-005-typed' });
  const surface = await surfaceOf(page, 'sec-005-typed');
  for (const payload of PAYLOADS) {
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    await page.keyboard.type(` ${payload}`);
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain(payload);
    await expectInert(page, 'sec-005-typed', payload);
  }
});

test('SEC-005: pasted HTML without a fragment is read through the whitelist, its own text used (Chromium, WebKit)', async ({
  page,
}) => {
  // Firefox ignores the clipboardData of a synthetic ClipboardEvent, so the paste does nothing there.
  test.skip(
    test.info().project.name === 'firefox',
    'paste paths are run in Chromium and WebKit only',
  );
  await openEmbed(page);
  await mountEditor(page, { sub: 'ada', role: 'editor', name: 'sec-005-html' });
  const surface = await surfaceOf(page, 'sec-005-html');
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  for (const [i, payload] of PAYLOADS.entries()) {
    // The HTML's text differs from the plain text, so the text that shows proves which part was used.
    await paste(page, 'sec-005-html', {
      html: `<p>PASTE-HTML-${i} ${payload}</p><script>window.__canary=9</script>`,
      text: `PASTE-TEXT-${i}`,
    });
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain(`PASTE-HTML-${i}`);
    expect(await surface.evaluate((el) => el.textContent ?? '')).not.toContain(`PASTE-TEXT-${i}`);
    await expectInert(page, 'sec-005-html', payload);
  }
});

test('SEC-005: pasted HTML that yields no text gives way to the plain text (Chromium, WebKit)', async ({
  page,
}) => {
  test.skip(
    test.info().project.name === 'firefox',
    'paste paths are run in Chromium and WebKit only',
  );
  await openEmbed(page);
  await mountEditor(page, { sub: 'ada', role: 'editor', name: 'sec-005-html-empty' });
  const surface = await surfaceOf(page, 'sec-005-html-empty');
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  const payload = `<script>window.__canary=9</script>${PAYLOADS[0]!}`;
  await paste(page, 'sec-005-html-empty', { html: payload, text: 'PASTE-TEXT-ONLY' });
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain('PASTE-TEXT-ONLY');
  await expectInert(page, 'sec-005-html-empty', payload);
});

test('SEC-005: a pasted embedded fragment with a payload in its text stays inert', async ({
  page,
}) => {
  // Firefox ignores the clipboardData of a synthetic ClipboardEvent, so the paste does nothing there.
  test.skip(
    test.info().project.name === 'firefox',
    'paste paths are run in Chromium and WebKit only',
  );
  await openEmbed(page);
  await mountEditor(page, { sub: 'ada', role: 'editor', name: 'sec-005-fragment' });
  const surface = await surfaceOf(page, 'sec-005-fragment');
  await surface.locator('p').last().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  // Capture the copy the component makes (its own handler runs first, the listener reads the result).
  await page.evaluate(() => {
    document.addEventListener(
      'copy',
      (e) => {
        const cd = (e as ClipboardEvent).clipboardData;
        (window as unknown as { __copied?: { html: string; text: string } }).__copied = {
          html: cd?.getData('text/html') ?? '',
          text: cd?.getData('text/plain') ?? '',
        };
      },
      { once: true },
    );
  });
  await page.keyboard.press('Control+C');
  const copied = await page.evaluate(
    () => (window as unknown as { __copied?: { html: string; text: string } }).__copied,
  );
  expect(copied?.html ?? '', 'the copy carries an embedded fragment').toContain(
    'data-docedit-fragment',
  );

  for (const payload of PAYLOADS) {
    const html = copied!.html.replace(/Last paragraph\./g, payload);
    const fragmentRe = /data-docedit-fragment="([^"]*)"/;
    const m = fragmentRe.exec(html);
    expect(m, 'the fragment attribute is present').not.toBeNull();
    // Rewrite the fragment's own text (the attribute is the JSON the component reads back).
    const fragment = JSON.parse(decodeURIComponent(m![1]!)) as { content: unknown[] };
    const walk = (n: unknown): void => {
      if (n && typeof n === 'object') {
        const o = n as { type?: unknown; text?: unknown; content?: unknown[] };
        if (o.type === 'text' && typeof o.text === 'string')
          o.text = o.text.replace(/Last paragraph\./g, payload);
        for (const c of o.content ?? []) walk(c);
      }
    };
    for (const c of fragment.content) walk(c);
    const withPayload = html.replace(m![1]!, encodeURIComponent(JSON.stringify(fragment)));
    await paste(page, 'sec-005-fragment', { html: withPayload, text: payload });
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain(payload);
    await expectInert(page, 'sec-005-fragment', payload);
  }
});
