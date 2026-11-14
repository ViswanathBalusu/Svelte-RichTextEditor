/**
 * SEC-005 criterion 3, the picture-file paste path (lane V-SEC-001-016). A picture on the clipboard
 * with no text goes through the core (FE-053, packages/engine/src/view/web.ts, image-paste.ts): the
 * file is read and handed to the assets port (packages/element/src/assets.ts). Three cases:
 * 1. a PNG header with a script and an SVG after its image data, and a payload in the file name:
 *    the picture reaches the assets port with its exact bytes and name (the "converted to an asset
 *    upload" branch), and no canary fires and the name and trailing bytes do not reach the surface;
 * 2. an SVG file with a script handler: its size cannot be read, so it is refused before upload;
 * 3. a file typed as a PNG whose bytes are not a PNG: refused before upload.
 *
 * The assets port is a recording stand-in on the backend of the embed page, because the mock
 * backend (packages/backend-mock) offers no assets port. The asset service's own validation and
 * quarantine are not run here. Inserting the uploaded picture as an `image` node was not observed
 * in the element (the node count stays 0 after the upload; see the story Notes), so this test does
 * not assert an insertion. Firefox ignores the clipboardData of a synthetic ClipboardEvent, so the
 * paste does nothing there and the tests are skipped with that reason.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const PAYLOAD_NAME = '<img src=x onerror="window.__canary=21">.png';
const TRAILER = '<script>window.__canary=22</script><svg onload="window.__canary=23"></svg>';

interface PasteFile {
  name: string;
  type: string;
  bytes: number[];
}

interface Upload {
  filename: string;
  type: string;
  size: number;
}

/** A PNG with the given size in its IHDR chunk, then `trailer` bytes after the image data. */
function pngBytes(width: number, height: number, trailer: string): number[] {
  const u32 = (n: number): number[] => [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ];
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  const ihdr = [
    ...u32(13),
    0x49,
    0x48,
    0x44,
    0x52,
    ...u32(width),
    ...u32(height),
    8,
    6,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
    0,
  ];
  return [...signature, ...ihdr, ...textBytes(trailer)];
}

function textBytes(text: string): number[] {
  return Array.from(new TextEncoder().encode(text));
}

const surfaceOf = (page: Page, name: string) =>
  page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);

/**
 * Mounts an editor whose backend has an assets port that records each upload and answers with
 * ASSET_ID, and the `assets` feature. The session reads both when it attaches (session.ts).
 */
async function mountWithRecordingAssets(page: Page, name: string): Promise<void> {
  await page.evaluate(async (name) => {
    type Up = { filename: string; type: string; size: number };
    const w = window as unknown as {
      __embed: { backend(sub: string, role: string): unknown; docId: string };
      __uploads: Up[];
    };
    w.__uploads = [];
    const backend = w.__embed.backend('ada', 'editor') as {
      features: ReadonlySet<string>;
      assets?: unknown;
    };
    let features: ReadonlySet<string> = backend.features;
    Object.defineProperty(backend, 'features', {
      configurable: true,
      get: () => new Set([...features, 'assets']),
      set: (v: ReadonlySet<string>) => {
        features = v;
      },
    });
    backend.assets = {
      async upload(
        _docId: string,
        file: { filename: string; source: { type: string; size: number } },
      ) {
        w.__uploads.push({
          filename: file.filename,
          type: file.source.type,
          size: file.source.size,
        });
        return { asset: '0190d5a4-7c3e-7d2a-9a1b-00000000000a' };
      },
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = name;
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
        { once: true },
      );
    });
    el.backend = backend;
    el.setAttribute('doc-id', w.__embed.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, name);
  await expect(surfaceOf(page, name)).toBeVisible();
}

/** Dispatches a paste whose clipboard holds the given files and no text (FE-053). */
async function pasteFiles(page: Page, name: string, files: PasteFile[]): Promise<void> {
  await page.evaluate(
    ({ name, files }) => {
      const host = document.querySelector(`doc-editor[data-test="${name}"]`)!;
      const target = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
      const dt = new DataTransfer();
      for (const f of files)
        dt.items.add(new File([new Uint8Array(f.bytes)], f.name, { type: f.type }));
      target.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, composed: true, clipboardData: dt }),
      );
    },
    { name, files },
  );
}

async function uploads(page: Page): Promise<Upload[]> {
  return page.evaluate(() => (window as unknown as { __uploads: Upload[] }).__uploads);
}

/** Asserts no canary fired, and nothing from the payload is an element or a handler on the surface. */
async function expectInert(page: Page, name: string): Promise<void> {
  const canary = await page.evaluate(() => (window as unknown as { __canary?: unknown }).__canary);
  expect(canary, 'no canary fired').toBeUndefined();
  const surface = surfaceOf(page, name);
  const forbidden = await surface
    .locator('script, svg, iframe, math, object, embed, style, [onerror], [onload], img[src="x"]')
    .count();
  expect(forbidden, 'no script, handler or payload image on the surface').toBe(0);
  const text = await surface.evaluate((el) => el.textContent ?? '');
  expect(text, 'the file name does not reach the surface').not.toContain('onerror');
  expect(text, 'trailing bytes do not reach the surface').not.toContain('window.__canary');
}

test.describe('SEC-005 picture-file paste', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(
      browserName === 'firefox',
      'Firefox ignores the clipboardData of a synthetic ClipboardEvent, so the paste does nothing there',
    );
  });

  test('a picture file reaches the assets port unchanged, and the payload stays inert (Chromium, WebKit)', async ({
    page,
  }) => {
    const bytes = pngBytes(40, 20, TRAILER);
    await openEmbed(page);
    await mountWithRecordingAssets(page, 'sec-005-picture');
    const surface = surfaceOf(page, 'sec-005-picture');
    await surface.locator('p').last().click();
    await page.keyboard.press('End');

    await pasteFiles(page, 'sec-005-picture', [{ name: PAYLOAD_NAME, type: 'image/png', bytes }]);

    await expect.poll(() => uploads(page), { timeout: 10_000 }).toHaveLength(1);
    const [sent] = await uploads(page);
    expect(sent?.type, 'the picture is sent with its type').toBe('image/png');
    expect(sent?.filename, 'the file name is handed to the asset service').toBe(PAYLOAD_NAME);
    expect(sent?.size, 'the picture is sent with its bytes').toBe(bytes.length);
    await expectInert(page, 'sec-005-picture');
  });

  test('an SVG file is refused before upload (Chromium, WebKit)', async ({ page }) => {
    await openEmbed(page);
    await mountWithRecordingAssets(page, 'sec-005-svg');
    const surface = surfaceOf(page, 'sec-005-svg');
    await surface.locator('p').last().click();
    await page.keyboard.press('End');

    await pasteFiles(page, 'sec-005-svg', [
      {
        name: 'drawing.svg',
        type: 'image/svg+xml',
        bytes: textBytes(
          '<svg xmlns="http://www.w3.org/2000/svg" onload="window.__canary=31"></svg>',
        ),
      },
    ]);
    // A refusal produces no upload. The wait is the time the core takes to answer.
    await page.waitForTimeout(500);
    expect(await uploads(page), 'nothing is uploaded').toHaveLength(0);
    await expectInert(page, 'sec-005-svg');
  });

  test('a file typed as a PNG that is not a PNG is refused before upload (Chromium, WebKit)', async ({
    page,
  }) => {
    await openEmbed(page);
    await mountWithRecordingAssets(page, 'sec-005-fake');
    const surface = surfaceOf(page, 'sec-005-fake');
    await surface.locator('p').last().click();
    await page.keyboard.press('End');

    await pasteFiles(page, 'sec-005-fake', [
      {
        name: 'photo.png',
        type: 'image/png',
        bytes: textBytes(
          '<img src=x onerror="window.__canary=41"><script>window.__canary=42</script>',
        ),
      },
    ]);
    await page.waitForTimeout(500);
    expect(await uploads(page), 'nothing is uploaded').toHaveLength(0);
    await expectInert(page, 'sec-005-fake');
  });
});
