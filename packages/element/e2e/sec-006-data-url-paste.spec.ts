/**
 * SEC-006 criterion 3, pasted half (lane V-SEC-001-016): an image given as a `data:` URL in pasted
 * content is refused or converted, and is never stored inline. The attribute half is
 * tests/security/test/data-url-media.test.ts (wire, memory and PostgreSQL).
 *
 * Two paste paths, in Chromium and WebKit (Firefox ignores the clipboardData of a synthetic paste
 * event, so these tests are skipped there, as in sec-005-canary.spec.ts):
 * 1. pasted HTML without an embedded fragment, with a plain-text part: the HTML is read through the
 *    whitelist (FE-054), which drops `img`, so its own text is pasted and no image node is created;
 * 2. pasted HTML that carries a data URL image in an attribute and a script next to it.
 * The HTML is preferred to the plain text (02 §5.2; ADR 0303 item 1, proposed, for the owner to
 * confirm); its text differs from the plain text, so the text that shows proves which part was used.
 *
 * After each paste: no image or script is on the editing surface, the HTML's text shows, and the
 * confirmed content the element returns (`getContent`) holds no `data:` string.
 */
import { type Page, expect, test } from '@playwright/test';
import { mountEditor, openEmbed, selectionSynced } from './embed-helpers.ts';

/** A 1x1 PNG, and an SVG with a script, both as data URLs. */
const PNG_DATA_URL =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
const SVG_DATA_URL =
  'data:image/svg+xml;base64,PHN2Zz48c2NyaXB0PndpbmRvdy5fX2NhbmFyeT03PC9zY3JpcHQ+PC9zdmc+';

const SURFACE_FORBIDDEN = 'img, svg, script, iframe, object, embed';

async function surfaceOf(page: Page, name: string) {
  return page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
}

/** Dispatches a paste with the given parts, as sec-005-canary.spec.ts does. */
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

/** The confirmed content of the element, as text, to look for any stored data URL. */
async function storedText(page: Page, name: string): Promise<string> {
  return page.evaluate(async (n) => {
    const el = document.querySelector(`doc-editor[data-test="${n}"]`) as unknown as {
      getContent(): Promise<unknown>;
    };
    return JSON.stringify(await el.getContent());
  }, name);
}

/** Firefox ignores the clipboardData of a synthetic ClipboardEvent, so the paste does nothing there. */
function skipFirefox() {
  test.skip(
    test.info().project.name === 'firefox',
    'paste paths are run in Chromium and WebKit only',
  );
}

test.describe('SEC-006 criterion 3: pasted data URL images', () => {
  test('a pasted HTML image with a data URL is not stored inline (the HTML text is used)', async ({
    page,
  }) => {
    skipFirefox();
    await openEmbed(page);
    await mountEditor(page, { sub: 'ada', role: 'editor', name: 'sec-006-paste-text' });
    const surface = await surfaceOf(page, 'sec-006-paste-text');
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    await paste(page, 'sec-006-paste-text', {
      html: `<p>PASTE-IMAGE-HTML-6</p><img src="${PNG_DATA_URL}" alt="pixel"><img src="${SVG_DATA_URL}">`,
      text: 'PASTE-IMAGE-TEXT-6',
    });
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain('PASTE-IMAGE-HTML-6');
    expect(await surface.evaluate((el) => el.textContent ?? '')).not.toContain(
      'PASTE-IMAGE-TEXT-6',
    );
    await expect
      .poll(() => storedText(page, 'sec-006-paste-text'), { timeout: 10_000 })
      .toContain('PASTE-IMAGE-HTML-6');

    expect(
      await surface.locator(SURFACE_FORBIDDEN).count(),
      'no image or script on the surface',
    ).toBe(0);
    const canary = await page.evaluate(
      () => (window as unknown as { __canary?: unknown }).__canary,
    );
    expect(canary, 'the SVG script did not run').toBeUndefined();
    const stored = await storedText(page, 'sec-006-paste-text');
    expect(stored, 'the confirmed content holds no data URL').not.toContain('data:');
    expect(stored).not.toContain('iVBORw0KGgo');
  });

  test('a pasted HTML data URL image beside a script does not reach the document', async ({
    page,
  }) => {
    skipFirefox();
    await openEmbed(page);
    await mountEditor(page, { sub: 'ada', role: 'editor', name: 'sec-006-paste-html' });
    const surface = await surfaceOf(page, 'sec-006-paste-html');
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    await paste(page, 'sec-006-paste-html', {
      html: `<p>PASTE-SCRIPT-HTML-8 <img src="${SVG_DATA_URL}"></p><script>window.__canary=8</script>`,
      text: 'PASTE-SCRIPT-TEXT-8',
    });
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain('PASTE-SCRIPT-HTML-8');
    expect(await surface.evaluate((el) => el.textContent ?? '')).not.toContain(
      'PASTE-SCRIPT-TEXT-8',
    );
    await expect
      .poll(() => storedText(page, 'sec-006-paste-html'), { timeout: 10_000 })
      .toContain('PASTE-SCRIPT-HTML-8');

    expect(await surface.locator(SURFACE_FORBIDDEN).count()).toBe(0);
    const canary = await page.evaluate(
      () => (window as unknown as { __canary?: unknown }).__canary,
    );
    expect(canary).toBeUndefined();
    const stored = await storedText(page, 'sec-006-paste-html');
    expect(stored).not.toContain('data:');
  });

  test('a pasted embedded fragment whose image names a data URL loses the image (the sanitiser refuses it)', async ({
    page,
  }) => {
    // This takes the fragment path, which is used in preference to HTML and plain text, so the
    // image nodes reach the paste cleaner (withoutEmbeddedData, packages/engine/src/clipboard.ts).
    skipFirefox();
    const name = 'sec-006-paste-fragment';
    await openEmbed(page);
    await mountEditor(page, { sub: 'ada', role: 'editor', name });
    const surface = await surfaceOf(page, name);
    const imagesBefore = (await storedText(page, name)).split('"type":"image"').length;
    await surface.locator('p').last().click();
    await page.keyboard.press('Home');
    await page.keyboard.press('Shift+End');
    await selectionSynced(page, name);
    // Capture the copy the component makes, for a fragment of the right shape to start from.
    await page.evaluate(() => {
      document.addEventListener(
        'copy',
        (e) => {
          const cd = (e as ClipboardEvent).clipboardData;
          (window as unknown as { __copied?: string }).__copied = cd?.getData('text/html') ?? '';
        },
        { once: true },
      );
    });
    await page.keyboard.press('Control+C');
    const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
    const m = /data-docedit-fragment="([^"]*)"/.exec(copied ?? '');
    expect(m, 'the copy carries an embedded fragment').not.toBeNull();

    // Put a marker text and two inline images whose asset is a data URL into the fragment, as a
    // fragment made by hand or by another program could. A selection inside one paragraph copies
    // inline content; otherwise the images go into the fragment's first paragraph.
    const fragment = JSON.parse(decodeURIComponent(m![1]!)) as {
      content: { type: string; content?: unknown[] }[];
    };
    const image = (asset: string) => ({
      type: 'image',
      attrs: { asset, width: 240, height: 240, alt: 'pixel' },
    });
    const inline = [
      image(PNG_DATA_URL),
      { type: 'text', text: 'FRAGMENT-IMAGE-TEXT-6' },
      image(SVG_DATA_URL),
    ];
    const para = fragment.content.find((n) => n.type === 'paragraph');
    if (para) para.content = inline;
    else fragment.content = inline;
    const html = copied!.replace(m![1]!, encodeURIComponent(JSON.stringify(fragment)));
    // The plain text differs from the fragment's, so the text that shows proves which part was used.
    await paste(page, name, { html, text: 'PLAIN-TEXT-NOT-USED' });

    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain('FRAGMENT-IMAGE-TEXT-6');
    expect(await surface.evaluate((el) => el.textContent ?? '')).not.toContain(
      'PLAIN-TEXT-NOT-USED',
    );
    expect(
      await surface.locator(SURFACE_FORBIDDEN).count(),
      'no image or script on the surface',
    ).toBe(0);
    const canary = await page.evaluate(
      () => (window as unknown as { __canary?: unknown }).__canary,
    );
    expect(canary, 'the SVG script did not run').toBeUndefined();
    // The confirmed content holds the pasted text, no new image node and no data URL.
    await expect
      .poll(() => storedText(page, name), { timeout: 10_000 })
      .toContain('FRAGMENT-IMAGE-TEXT-6');
    const stored = await storedText(page, name);
    expect(stored, 'the confirmed content holds no data URL').not.toContain('data:');
    expect(stored).not.toContain('iVBORw0KGgo');
    expect(stored.split('"type":"image"').length, 'no image node was added').toBe(imagesBefore);
  });
});
