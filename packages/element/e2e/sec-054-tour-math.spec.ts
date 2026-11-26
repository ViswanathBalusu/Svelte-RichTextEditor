/**
 * SEC-054 criterion 1 (10 §3.8; ADR 0044 §6), lane w8: the math editor under the request recorder.
 * The editor's chunk and MathLive load on demand, and the equation renderer takes its fonts from
 * the page's origin (`katexFontsUrl`). The tour opens a document with equations, opens the math
 * editor by keyboard, confirms an edited source, and records every request on the page. Every
 * request must go to the demo's origin, or be a data: or blob: URL built in the page.
 *
 * The proofing and assistant ports have their own tour (sec-054-tour-ports.spec.ts).
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57071 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/sec-054-tour-math.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { expect, test, type Request as PwRequest } from '@playwright/test';
import { encodePolicy, record, runId } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const FONT_DIR = fileURLToPath(new URL('../node_modules/katex/dist/fonts/', import.meta.url));
const KITCHEN_SINK = fileURLToPath(
  new URL('../../model/fixtures/kitchen-sink.json', import.meta.url),
);
const EDITOR = 'doc-editor[data-test="math"]';
const DIALOG = `${EDITOR} dialog[data-dialog="math"]`;
const MATH_POLICY = policy({
  'trusted-types': 'docedit-math docedit-paste ProseMirrorClipboard docedit-worker',
  'style-src-attr': "'unsafe-inline'",
  'report-uri': null,
});
const ALLOWED_SCHEMES = new Set(['data:', 'blob:']);

test('SEC-054: opening and confirming the math editor loads nothing from another origin', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? 'http://127.0.0.1:4791').origin;
  const seen: Array<{ url: string; resourceType: string }> = [];
  page.on('request', (req: PwRequest) =>
    seen.push({ url: req.url(), resourceType: req.resourceType() }),
  );
  await page.route('**/katex-fonts/*.woff2', async (route) => {
    const name = new URL(route.request().url()).pathname.split('/').pop()!;
    await route.fulfill({ body: readFileSync(FONT_DIR + name), contentType: 'font/woff2' });
  });

  await openEmbed(page, `?csp=${encodePolicy(MATH_POLICY)}`);
  const outcome = await page.evaluate(
    async ({ env }) => {
      const w = window as unknown as {
        __embed: {
          mathService: {
            createDocument(env: unknown): string;
            backend(user: unknown, grants: Record<string, string>): unknown;
          };
        };
      };
      const id = w.__embed.mathService.createDocument(env);
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        config: unknown;
      };
      el.dataset['test'] = 'math';
      el.config = { katexFontsUrl: `${location.origin}/katex-fonts/` };
      const ready = new Promise<string>((resolve) => {
        el.addEventListener('de-ready', () => resolve('ready'), { once: true });
        el.addEventListener('de-error', () => resolve('error'), { once: true });
      });
      el.backend = w.__embed.mathService.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' });
      el.setAttribute('doc-id', id);
      document.getElementById('mount')!.append(el);
      return Promise.race([
        ready,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
    },
    { env: JSON.parse(readFileSync(KITCHEN_SINK, 'utf8')) },
  );
  expect(outcome).toBe('ready');
  const equation = page.locator(`${EDITOR} .de-equation`).first();
  await expect(equation.locator('.katex')).toBeVisible({ timeout: 15_000 });

  // Open the editor (this loads its chunk and MathLive), edit the source and confirm.
  await equation.click();
  await page.keyboard.press('Enter');
  await expect(page.locator(DIALOG)).toBeVisible();
  await page.locator(`${DIALOG} textarea`).fill('x^2 + y^2');
  await page.locator(`${DIALOG} button[type="submit"]`).click();
  await expect(page.locator(DIALOG)).toBeHidden();
  await page.waitForLoadState('networkidle');

  const remote = seen.filter((r) => {
    const u = new URL(r.url);
    return !ALLOWED_SCHEMES.has(u.protocol) && u.origin !== origin;
  });
  const hosts = [...new Set(seen.map((r) => new URL(r.url).origin))].sort();
  const scripts = seen.filter((r) => r.resourceType === 'script').length;
  const fonts = seen.filter((r) => r.resourceType === 'font').length;
  record('sec-054-tour-math', {
    run: runId(),
    browser: test.info().project.name,
    requests: seen.length,
    scripts,
    fonts,
    hosts,
    remote,
  });

  expect(seen.length).toBeGreaterThan(0);
  expect(fonts, 'the equation fonts were requested, so the recorder saw them').toBeGreaterThan(0);
  expect(remote).toEqual([]);
});
