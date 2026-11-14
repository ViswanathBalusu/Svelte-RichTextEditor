/**
 * FE-019 criteria 1 and 2 (lane V-FE-017-032): under `forced-colors: active`, the text, the links and
 * the selection of the web view use system colours. The document is created in the page from a
 * small CDM envelope (a plain paragraph and a paragraph whose text is a link), mounted on the embed
 * page, and each computed colour is compared with a probe element that carries the same system
 * colour under the same emulation. Forced colours are emulated in Chromium only (Playwright).
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-019-forced-web-view.spec.ts --retries=0`.
 */
import { expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

test.describe('FE-019 forced colours: the web view uses system colours', () => {
  test('text, links and the selection take the system colours under forced-colors active', async ({
    page,
    browserName,
  }) => {
    // WebKit (Playwright 27.2) keeps the author colour in getComputedStyle under the emulation, so
    // the computed-colour assertions below cannot show the system colour there. Known gap, not a pass.
    test.fixme(
      browserName === 'webkit',
      'WebKit computed colour stays the author colour under forced-colors emulation (FE-019 Notes)',
    );
    await openEmbed(page);

    const docId = await page.evaluate(() => {
      const w = window as unknown as {
        __embed: { service: { createDocument(e: unknown): string } };
      };
      const envelope = {
        cdm: 1,
        requires: [],
        doc: {
          type: 'doc',
          content: [
            {
              type: 'defs',
              content: [
                { type: 'settings', attrs: { lang: 'en-GB' } },
                {
                  type: 'style_def',
                  attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
                },
                { type: 'page_setup', attrs: { id: 'ps1' } },
              ],
            },
            {
              type: 'body',
              attrs: { pageSetup: 'ps1' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: 'p000000000000001' },
                  content: [{ type: 'text', text: 'Plain words for the system colour' }],
                },
                {
                  type: 'paragraph',
                  attrs: { id: 'p000000000000002' },
                  content: [
                    {
                      type: 'text',
                      text: 'A link',
                      marks: [
                        { type: 'link', attrs: { href: 'https://example.com/', title: null } },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
      return w.__embed.service.createDocument(envelope);
    });

    await page.evaluate(async (id) => {
      const w = window as unknown as {
        __embed: {
          service: {
            backend(who: { sub: string; name: string }, roles: Record<string, string>): unknown;
          };
        };
      };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'fe-019';
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          {
            once: true,
          },
        );
      });
      el.backend = w.__embed.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' });
      el.setAttribute('doc-id', id);
      document.getElementById('mount')!.append(el);
      await ready;
    }, docId);
    await expect(
      page.locator('doc-editor[data-test="fe-019"] .de-editing-surface'),
    ).toHaveAttribute('contenteditable', 'true');

    await page.emulateMedia({ forcedColors: 'active' });
    await expect
      .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
      .toBe(true);

    const r = await page.evaluate(() => {
      const host = document.querySelector('doc-editor[data-test="fe-019"]')!;
      const root = host.shadowRoot!;
      const surface = root.querySelector('.de-editing-surface')!;
      const plain = surface.querySelector('p')!;
      const link = surface.querySelector('a')!;
      const probe = (prop: string, value: string) => {
        const p = document.createElement('div');
        p.style.setProperty(prop, value);
        root.appendChild(p);
        const v = getComputedStyle(p).getPropertyValue(prop);
        p.remove();
        return v;
      };
      // Select the plain paragraph's text inside the shadow root, then read its ::selection style.
      (surface as HTMLElement).focus();
      // ShadowRoot.getSelection is missing in Firefox and WebKit; the shim of FE-116 falls back to the
      // document selection there, as in s1-getselection.spec.ts.
      const sel =
        (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ??
        document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(plain);
      sel.removeAllRanges();
      sel.addRange(range);
      return {
        selText: range.toString(),
        text: getComputedStyle(plain).color,
        link: getComputedStyle(link).color,
        probes: {
          canvasText: probe('color', 'CanvasText'),
          linkText: probe('color', 'LinkText'),
          highlight: probe('background-color', 'Highlight'),
        },
      };
    });
    expect(r.selText, 'the selection of the plain paragraph is in place').toContain('Plain words');
    expect(r.text).toBe(r.probes.canvasText);
    expect(r.link).toBe(r.probes.linkText);

    // The selection is painted by the browser, so the computed ::selection style does not show it
    // under forced colours. The painted pixels are counted instead: a screenshot of the paragraph,
    // decoded in the page, with the pixels of the Highlight system colour.
    const box = await page.evaluate(() => {
      const host = document.querySelector('doc-editor[data-test="fe-019"]')!;
      const plain = host.shadowRoot!.querySelector('.de-editing-surface p')!;
      const b = plain.getBoundingClientRect();
      return { x: b.x, y: b.y, width: b.width, height: b.height };
    });
    const highlight = r.probes.highlight.match(/\d+/g)!.map(Number);
    const countPixels = (png: Buffer) =>
      page.evaluate(
        async ({ b64, rgb }) => {
          const img = new Image();
          img.src = `data:image/png;base64,${b64}`;
          await img.decode();
          const c = document.createElement('canvas');
          c.width = img.naturalWidth;
          c.height = img.naturalHeight;
          const ctx = c.getContext('2d', { willReadFrequently: true })!;
          ctx.drawImage(img, 0, 0);
          const data = ctx.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < data.length; i += 4)
            if (data[i] === rgb[0] && data[i + 1] === rgb[1] && data[i + 2] === rgb[2]) n += 1;
          return n;
        },
        { b64: png.toString('base64'), rgb: highlight },
      );
    const selected = await countPixels(await page.screenshot({ clip: box }));
    expect(selected, 'the selection paints the Highlight system colour').toBeGreaterThan(0);
    await page.evaluate(() => {
      const host = document.querySelector('doc-editor[data-test="fe-019"]')!;
      const root = host.shadowRoot as ShadowRoot & { getSelection?: () => Selection | null };
      (root.getSelection?.() ?? document.getSelection())?.removeAllRanges();
    });
    const unselected = await countPixels(await page.screenshot({ clip: box }));
    expect(unselected, 'without a selection the Highlight colour is not painted').toBe(0);
  });
});
