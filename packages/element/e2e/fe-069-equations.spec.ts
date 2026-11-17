/**
 * FE-069 through the element (lane w1): `<doc-editor>` draws the equations of a document with KaTeX,
 * under the strict policy (Trusted Types required, no unsafe keyword), with the KaTeX fonts
 * registered under hash aliases from the host's directory (`config.katexFontsUrl`) and no
 * `@font-face` in the shadow root; a source KaTeX rejects shows a placeholder with the source;
 * numbered blocks show the numbers of the shared labels; and a drawn equation carries its source as
 * its text alternative.
 *
 * The document is the model's kitchen-sink fixture with two blocks added before its own equation
 * block: a numbered `\frac{a}{b}` and an unnumbered `\notacommand{x}`. Document order gives the
 * numbers (1), none, (2). The test serves KaTeX's own `.woff2` files at `/katex-fonts/` through
 * `page.route`, from the package installed for the element.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57069 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-069-equations.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const FONT_DIR = fileURLToPath(new URL('../node_modules/katex/dist/fonts/', import.meta.url));

type Node = { type?: string; attrs?: Record<string, unknown>; content?: Node[] };

function documentWithEquations(): unknown {
  const env = JSON.parse(
    readFileSync(new URL('../../model/fixtures/kitchen-sink.json', import.meta.url), 'utf8'),
  ) as { doc: Node };
  const insertBefore = (parent: Node): boolean => {
    const at = (parent.content ?? []).findIndex((n) => n.type === 'equation_block');
    if (at >= 0) {
      const own = parent.content![at]!;
      own.attrs = { ...own.attrs, numbered: true };
      parent.content!.splice(
        at,
        0,
        {
          type: 'equation_block',
          attrs: { id: 'eqTestA000000001', latex: '\\frac{a}{b}', numbered: true },
        },
        {
          type: 'equation_block',
          attrs: { id: 'eqTestB000000002', latex: '\\notacommand{x}', numbered: false },
        },
      );
      return true;
    }
    return (parent.content ?? []).some(insertBefore);
  };
  if (!insertBefore(env.doc)) throw new Error('the fixture has no equation block');
  return env;
}

test('FE-069: equations are drawn by KaTeX, numbered, and safe under a strict policy', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await page.route('**/katex-fonts/*.woff2', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    await route.fulfill({
      body: readFileSync(FONT_DIR + name),
      contentType: 'font/woff2',
    });
  });
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.effectiveDirective}:${e.blockedURI}`);
    });
  });
  await openEmbed(page, `?csp=${encodePolicy(policy({ 'report-uri': null }))}`);

  const facts = await page.evaluate(async (env: unknown) => {
    const w = window as unknown as {
      __embed: {
        service: {
          createDocument(env: unknown): string;
          backend(user: unknown, grants: Record<string, string>): unknown;
        };
      };
    };
    const id = w.__embed.service.createDocument(env);
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      config: unknown;
    };
    el.config = { katexFontsUrl: `${location.origin}/katex-fonts/` };
    const ready = new Promise<string>((resolve) => {
      el.addEventListener('de-ready', () => resolve('ready'), { once: true });
      el.addEventListener('de-error', () => resolve('error'), { once: true });
    });
    el.backend = w.__embed.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' });
    el.setAttribute('doc-id', id);
    document.getElementById('mount')!.append(el);
    const outcome = await Promise.race([
      ready,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
    ]);
    // KaTeX and its fonts arrive after the first paint: wait for the drawn equations.
    const root = el.shadowRoot!;
    for (let i = 0; i < 100 && root.querySelectorAll('.de-equation-body .katex').length < 2; i++)
      await new Promise((r) => setTimeout(r, 100));
    await new Promise((r) => setTimeout(r, 300));

    const blocks = Array.from(root.querySelectorAll('.de-equation-block'));
    const first = blocks[0];
    const faceFamilies = Array.from(document.fonts).map((f) => f.family.replace(/^"|"$/g, ''));
    const sheetText = (root.adoptedStyleSheets ?? [])
      .map((s) =>
        Array.from(s.cssRules)
          .map((r) => r.cssText)
          .join('\n'),
      )
      .join('\n');
    const mathItalic = root.querySelector('.de-equation-body .katex-html .mathnormal');
    return {
      outcome,
      blocks: blocks.length,
      numbers: blocks.map((b) => b.querySelector('.de-equation-number')?.textContent ?? ''),
      drawnBlocks: root.querySelectorAll('.de-equation-body .katex').length,
      drawnInline: root.querySelectorAll('.de-equation .katex').length,
      annotation: first?.querySelector('annotation[encoding="application/x-tex"]')?.textContent,
      placeholders: Array.from(root.querySelectorAll('.de-math-placeholder')).map((p) => ({
        text: p.textContent,
        label: p.getAttribute('aria-label'),
        role: p.getAttribute('role'),
      })),
      katexFamilies: faceFamilies.filter((f) => /^KaTeX_/.test(f)),
      aliasFaces: faceFamilies.filter((f) => /^de-font-[0-9a-f]{64}$/.test(f)).length,
      fontFaceRules: (sheetText.match(/@font-face/g) ?? []).length,
      katexNamesInSheet: (sheetText.match(/KaTeX_/g) ?? []).length,
      mathFont: mathItalic ? getComputedStyle(mathItalic).fontFamily : null,
    };
  }, documentWithEquations());

  expect(facts.outcome).toBe('ready');
  // Criterion 1 and 5: drawn by KaTeX, and numbered as the shared labels say (document order).
  expect(facts.blocks).toBeGreaterThanOrEqual(3);
  expect(facts.drawnBlocks).toBeGreaterThanOrEqual(2);
  expect(facts.drawnInline).toBeGreaterThanOrEqual(1);
  expect(facts.numbers.slice(0, 3)).toEqual(['(1)', '', '(2)']);
  // Criterion 6: the source is the text alternative of a drawn equation.
  expect(facts.annotation).toBe('\\frac{a}{b}');
  // Criterion 4: a source KaTeX rejects shows a placeholder with the source, and nothing throws.
  expect(facts.placeholders).toEqual([
    { text: '\\notacommand{x}', label: '\\notacommand{x}', role: 'img' },
  ]);
  // Criterion 3: the KaTeX files are registered under hash aliases, never under their own names,
  // and the shadow root's sheet has no @font-face rule and no KaTeX_ name.
  expect(facts.aliasFaces).toBeGreaterThan(0);
  expect(facts.katexFamilies).toEqual([]);
  expect(facts.fontFaceRules).toBe(0);
  expect(facts.katexNamesInSheet).toBe(0);
  expect(facts.mathFont ?? '').toContain('de-font-');
  // Criterion 2: no HTML string reached the page under Trusted Types, and no policy was violated.
  const violations = await page.evaluate(
    () => (window as unknown as { __violations: string[] }).__violations,
  );
  expect(violations).toEqual([]);
  expect(errors).toEqual([]);
});
