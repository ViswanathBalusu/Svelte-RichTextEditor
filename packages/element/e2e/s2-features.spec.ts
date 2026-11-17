/**
 * Spike S2 (SPK-015): every feature loaded lazily under a strict content security policy with
 * Trusted Types enforced, first under the bare baseline (STRICT: no unsafe keyword, no policy name
 * allowed) and then under the baseline plus what the integration guide lists for that feature.
 * Each run records the violations seen by the page (securitypolicyviolation events) and by the
 * server (report-uri, which includes workers), in test-results/evidence/s2-<feature>-<policy>.*.json.
 * Prepares FE-014, FE-016, FE-017, FE-069, FE-070, FE-071, FE-125.
 */
import { type Page, expect, test } from '@playwright/test';
import { clickToolbarCommand } from './embed-helpers.ts';
import { SPIKE_IDS, openPanel, record, runId } from './helpers.ts';
import {
  collect,
  harness,
  openS2,
  policy,
  requests,
  showSamplePdf,
  summary,
} from './s2-helpers.ts';

/** What the integration guide says each feature adds to the baseline (the S2 report, section 6). */
export const GUIDE: Record<string, Record<string, string>> = {
  'web view': {},
  paste: { 'trusted-types': 'docedit-paste ProseMirrorClipboard' },
  pane: {},
  pdf: { 'trusted-types': 'docedit-worker' },
  'math display': {},
  'math editor': { 'trusted-types': 'docedit-math', 'style-src-attr': "'unsafe-inline'" },
  // The baseline's `font-src 'self'` is all the manifest fonts need (FE-061; the guide's Fonts section).
  fonts: {},
};

/** The font file the S2 page's manifest lists when the page is opened with `fonts=1` (demo/s2-page.ts). */
const S2_FONT_FILE = '/vendor/mathlive/fonts/KaTeX_Main-Regular.woff2';

/** The worker script's own policy for the PDF viewer (served with pdf.worker.mjs). */
export const PDF_WORKER_POLICY =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; report-uri {report}";

async function exercise(page: Page, feature: string, run: string): Promise<unknown> {
  const h = harness(page);
  switch (feature) {
    case 'web view': {
      await h.caretIn(SPIKE_IDS.after, 'end');
      await page.keyboard.type(' typed');
      await page.keyboard.press('ControlOrMeta+b');
      await page.keyboard.type(' bold');
      await page.keyboard.press('Enter');
      await page.keyboard.type('New paragraph');
      const typed = await h.bodyText();
      await page.keyboard.press('ControlOrMeta+z');
      const undone = await h.bodyText();
      await openPanel(page, 'footnote');
      await h.subCaret('end');
      await page.keyboard.type(' note');
      await h.closePanel();
      await openPanel(page, 'header');
      await h.subCaret('end');
      await page.keyboard.type(' header');
      await h.closePanel();
      return {
        typedHere: typed.includes('Remote target paragraph. typed bold\nNew paragraph'),
        undoneHere: !undone.includes('New paragraph'),
        footnote: await h.nodeText(SPIKE_IDS.footnote),
        header: await h.nodeText(SPIKE_IDS.headerParagraph),
        stylePath: await page.evaluate(
          () =>
            (document.querySelector('doc-editor') as unknown as { stylePath: string }).stylePath,
        ),
        toolbarDisplay: await page.evaluate(() => {
          const t = document.querySelector('doc-editor')!.shadowRoot!.querySelector('.de-toolbar')!;
          return getComputedStyle(t).display;
        }),
      };
    }
    case 'paste': {
      await h.caretIn(SPIKE_IDS.after, 'end');
      const handled = await h.pasteHTML('main', '<p><strong>Pasted</strong> text</p>').then(
        (v) => String(v),
        (e: Error) => `threw: ${e.message.split('\n')[0]}`,
      );
      return { handled, after: await h.nodeText(SPIKE_IDS.after) };
    }
    case 'pane': {
      await clickToolbarCommand(page, 'outline');
      await page.locator('doc-editor .de-outline').waitFor();
      return { outline: await page.locator('doc-editor .de-outline').innerText() };
    }
    case 'fonts': {
      // The session registered the manifest's file under its hash alias (FE-061); loading the
      // alias makes the browser fetch the file, which `font-src` governs.
      return page.evaluate(async (file) => {
        const aliases = (): string[] =>
          Array.from(document.fonts, (f) => f.family.replace(/^["']|["']$/g, '')).filter((f) =>
            f.startsWith('de-font-'),
          );
        for (let i = 0; i < 100 && aliases().length === 0; i++)
          await new Promise((r) => setTimeout(r, 50));
        const [alias] = aliases();
        if (alias === undefined) return { aliases: 0, status: 'not registered', fetched: false };
        const loaded = await document.fonts.load(`16px "${alias}"`).then(
          (faces) => faces.map((f) => f.status),
          (e: Error) => [`threw: ${e.message}`],
        );
        return {
          aliases: aliases().length,
          status: loaded.join(','),
          fetched: performance.getEntriesByType('resource').some((e) => e.name.includes(file)),
        };
      }, S2_FONT_FILE);
    }
    case 'pdf': {
      return showSamplePdf(page, run, { workerPolicy: PDF_WORKER_POLICY });
    }
    case 'math display':
      return page.evaluate(() =>
        (
          document.querySelector('doc-editor') as unknown as {
            showMath(i: unknown[]): Promise<unknown>;
          }
        ).showMath([
          { latex: 'E = mc^2' },
          { latex: String.raw`\frac{a}{b} + \sqrt{x^2 + 1}`, display: true },
          { latex: String.raw`\sum_{i=1}^{n} i = \frac{n(n+1)}{2}`, display: true },
        ]),
      );
    case 'math editor':
      return page.evaluate(() =>
        (
          document.querySelector('doc-editor') as unknown as {
            openMathEditor(l: string, o: unknown): Promise<unknown>;
          }
        ).openMathEditor('x^2', {
          fontsDirectory: `${location.origin}/vendor/mathlive/fonts`,
          useCreateHTML: true,
        }),
      );
  }
  throw new Error(`unknown feature ${feature}`);
}

for (const feature of Object.keys(GUIDE)) {
  for (const which of ['strict', 'guide'] as const) {
    test(`${feature} under the ${which === 'strict' ? 'strict baseline' : 'baseline plus the guide'}`, async ({
      page,
      request,
    }) => {
      const run = runId();
      const csp = policy(which === 'guide' ? GUIDE[feature] : {});
      await openS2(page, run, csp, feature === 'fonts' ? '&fonts=1' : '');
      const result = await exercise(page, feature, run);
      const collected = await collect(page, request, run);
      const fetched = await requests(request, run);
      record(`s2-${feature.replaceAll(' ', '-')}-${which}`, {
        csp,
        result,
        violations: summary(collected),
        collected,
        fetched,
      });
      if (which === 'guide') {
        expect(summary(collected)).toEqual([]);
        expect(collected.errors).toEqual([]);
      }
      // Global side effects the integration guide lists: unaliased KaTeX_* families on
      // document.fonts (both math features), and MathLive's three custom element names.
      if (feature === 'math display' || feature === 'math editor') {
        const globals = (result as { globals: { addedFontFamilies: string[] } }).globals;
        expect(globals.addedFontFamilies).toContain('KaTeX_Main');
        expect(globals.addedFontFamilies).toHaveLength(12);
      }
      if (feature === 'math editor')
        expect(result).toMatchObject({
          tags: { 'math-field': true, 'math-span': true, 'math-div': true },
        });
      // `font-src 'self'` is in the baseline, so the file loads under both policies.
      if (feature === 'fonts')
        expect(result).toEqual({ aliases: 1, status: 'loaded', fetched: true });
      if (feature === 'pane') expect((result as { outline: string }).outline).not.toBe('');
      if (feature === 'web view')
        expect(result).toMatchObject({
          typedHere: true,
          undoneHere: true,
          footnote: 'Footnote text note',
          header: 'Header text 1 header',
        });
    });
  }
}

test.describe('math: what needs inline styles', () => {
  test('KaTeX features that write style attributes: \\fcolorbox and rendered errors', async ({
    page,
    request,
  }) => {
    const run = runId();
    await openS2(page, run, policy());
    const result = await page.evaluate(async () => {
      const el = document.querySelector('doc-editor') as unknown as {
        showMath(i: unknown[], throwOnError?: boolean): Promise<unknown>;
      };
      return {
        colourBox: await el.showMath([{ latex: String.raw`\fcolorbox{red}{yellow}{x}` }]),
        renderedError: await el.showMath([{ latex: String.raw`\frac{1}{` }], false),
        placeholder: await el.showMath([{ latex: String.raw`\frac{1}{` }], true),
      };
    });
    const collected = await collect(page, request, run);
    record('s2-katex-inline-styles', {
      result,
      violations: summary(collected),
      dom: collected.dom,
    });
    // Both write a `style` attribute (KaTeX's MathML border and its error colour).
    expect(summary(collected).some((v) => v.startsWith('page:style-src-attr'))).toBe(true);
  });

  for (const variant of [
    'policy name only',
    'policy name and style-src-attr',
    'no createHTML hook',
  ] as const) {
    test(`MathLive with ${variant}`, async ({ page, request }) => {
      const run = runId();
      const changes: Record<string, string> = { 'trusted-types': 'docedit-math' };
      if (variant === 'policy name and style-src-attr')
        changes['style-src-attr'] = "'unsafe-inline'";
      await openS2(page, run, policy(changes));
      const result = await page.evaluate(
        (useCreateHTML) =>
          (
            document.querySelector('doc-editor') as unknown as {
              openMathEditor(l: string, o: unknown): Promise<unknown>;
            }
          ).openMathEditor('x^2', {
            fontsDirectory: `${location.origin}/vendor/mathlive/fonts`,
            useCreateHTML,
          }),
        variant !== 'no createHTML hook',
      );
      const collected = await collect(page, request, run);
      record(`s2-mathlive-${variant.replaceAll(' ', '-')}`, {
        result,
        violations: summary(collected),
        dom: collected.dom.slice(0, 20),
      });
      if (variant === 'policy name and style-src-attr') expect(summary(collected)).toEqual([]);
      if (variant === 'policy name only')
        expect(summary(collected).some((v) => v.includes('style-src-attr'))).toBe(true);
      if (variant === 'no createHTML hook')
        expect(summary(collected).some((v) => v.includes('require-trusted-types-for'))).toBe(true);
    });
  }
});
