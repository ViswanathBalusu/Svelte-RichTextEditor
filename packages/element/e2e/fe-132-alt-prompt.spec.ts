/**
 * FE-132 criterion 5 in the element: a picture file pasted on the surface is uploaded through the
 * assets port and inserted, and the shell then asks for its alternative text in a dialog. Applying
 * stores the text on the picture; "Later" leaves it without text, and the accessibility checker
 * lists it (UX-066). The assets port is a stand-in for the asset service. Firefox ignores the
 * clipboardData of a synthetic ClipboardEvent, so the tests are skipped there.
 * Run: `DOCEDIT_DEMO_PORT=<port> pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-132-alt-prompt.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'fe-132-alt';
const HOST = `doc-editor[data-test="${NAME}"]`;
const ASSET = '0190d5a4-7c3e-7d2a-9a1b-00000000000a';

/** A PNG header with the given size in its IHDR chunk. */
function pngBytes(width: number, height: number): number[] {
  const u32 = (n: number): number[] => [
    (n >>> 24) & 255,
    (n >>> 16) & 255,
    (n >>> 8) & 255,
    n & 255,
  ];
  const signature = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  return [
    ...signature,
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
}

async function mount(page: Page): Promise<void> {
  await page.evaluate(async (name) => {
    const w = window as unknown as {
      __embed: { backend(sub: string, role: string): unknown; docId: string };
    };
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
      upload: () => Promise.resolve({ asset: '0190d5a4-7c3e-7d2a-9a1b-00000000000a' }),
      // The picture's view asks where to load the asset from; this stand-in has none to give.
      resolve: () => Promise.resolve({ assets: [] }),
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = name;
    const ready = new Promise<void>((resolve) =>
      el.addEventListener('de-ready', () => resolve(), { once: true }),
    );
    el.backend = backend;
    el.setAttribute('doc-id', w.__embed.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, NAME);
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

async function pastePicture(page: Page): Promise<void> {
  await page.locator(`${HOST} .de-editing-surface p`).last().click();
  await page.keyboard.press('End');
  await page.evaluate(
    ({ host, bytes }) => {
      const target = document
        .querySelector(host)!
        .shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
      const dt = new DataTransfer();
      dt.items.add(new File([new Uint8Array(bytes)], 'cat.png', { type: 'image/png' }));
      target.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, composed: true, clipboardData: dt }),
      );
    },
    { host: HOST, bytes: pngBytes(40, 20) },
  );
}

/** The `alt` of every image in the document, as the core holds it. */
function alts(page: Page): Promise<unknown[]> {
  return page.evaluate(
    ({ host, asset }) => {
      const embed = (
        window as unknown as {
          __embed: {
            internals(el: Element): {
              editor: { core: { getContent(): { doc: unknown } } } | null;
            };
          };
        }
      ).__embed;
      const out: unknown[] = [];
      const walk = (node: unknown): void => {
        const n = node as { type?: string; attrs?: Record<string, unknown>; content?: unknown[] };
        if (n.type === 'image' && n.attrs?.['asset'] === asset) out.push(n.attrs['alt'] ?? null);
        for (const child of n.content ?? []) walk(child);
      };
      walk(embed.internals(document.querySelector(host)!).editor!.core.getContent().doc);
      return out;
    },
    { host: HOST, asset: ASSET },
  );
}

const dialog = (page: Page) => page.locator(`${HOST} dialog[data-dialog="alt-text"]`);

test.describe('a picture without alternative text prompts for it (FE-132, criterion 5)', () => {
  test.beforeEach(({ browserName }) => {
    test.skip(browserName === 'firefox', 'Firefox ignores the clipboardData of a synthetic paste');
  });

  test('the dialog opens after the upload, and Apply stores the text on the picture', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page);
    await pastePicture(page);
    await expect(dialog(page)).toBeVisible();
    expect(await alts(page)).toEqual([null]);
    // Apply is off until there is text.
    await expect(dialog(page).getByRole('button', { name: 'Apply' })).toBeDisabled();
    await dialog(page).getByRole('textbox').fill('A grey cat on a sofa');
    await dialog(page).getByRole('button', { name: 'Apply' }).click();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => alts(page)).toEqual(['A grey cat on a sofa']);
  });

  test('Later closes the dialog, leaves the picture without text and the checker lists it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page);
    await pastePicture(page);
    await expect(dialog(page)).toBeVisible();
    await dialog(page).getByRole('button', { name: 'Later' }).click();
    await expect(dialog(page)).toHaveCount(0);
    expect(await alts(page)).toEqual([null]);
    // The checker (UX-066) lists the picture as missing alternative text.
    const opened = await page.evaluate((host) => {
      const embed = (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } | null };
          };
        }
      ).__embed;
      return embed.internals(document.querySelector(host)!).editor!.openPane('checker');
    }, HOST);
    expect(opened).toBe(true);
    await expect(
      page.locator(
        `${HOST} .de-pane[data-pane="checker"] li.de-checker-item[data-kind="alt-text"]`,
      ),
    ).toHaveCount(1);
  });
});
