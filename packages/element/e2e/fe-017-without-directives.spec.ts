/**
 * FE-017 criterion 4 (lane w1): what the production PDF viewer frame and the math editor do when the
 * host leaves out what the guide lists for them (packages/element/docs/policies-and-side-effects.md).
 * Each test records the outcome and the violations (page events and `report-uri` reports) and pins
 * what was measured, so the guide's "without it" sentences cannot drift from behaviour.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-017-without-directives.spec.ts --retries=0
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';
import { encodePolicy, record, runId } from './helpers.ts';
import { STRICT, collect, openS2, policy, summary } from './s2-helpers.ts';

const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const VIEWER = `http://localhost:${PORT}/lib/viewer/pdf-viewer.html`;

interface MathReport {
  ok: boolean;
  error: string | null;
  value: string;
  tags: Record<string, boolean>;
}

/** Opens the math editor on the S2 page and says what the page shows of it. */
async function openMath(page: Page): Promise<{
  report: MathReport;
  field: { present: boolean; shadowChildren: number; width: number; height: number };
}> {
  return page.evaluate(async () => {
    const el = document.querySelector('doc-editor') as unknown as {
      openMathEditor(l: string, o: unknown): Promise<MathReport>;
      shadowRoot: ShadowRoot;
    };
    const report = await el.openMathEditor('x^2', {
      fontsDirectory: `${location.origin}/vendor/mathlive/fonts`,
      useCreateHTML: true,
    });
    const field = el.shadowRoot.querySelector('math-field');
    const box = field?.getBoundingClientRect();
    return {
      report: { ok: report.ok, error: report.error, value: report.value, tags: report.tags },
      field: {
        present: field !== null && field !== undefined,
        shadowChildren: field?.shadowRoot?.childElementCount ?? 0,
        width: Math.round(box?.width ?? 0),
        height: Math.round(box?.height ?? 0),
      },
    };
  });
}

test.describe('FE-017 criterion 4: what happens without the listed directives', () => {
  test('the production PDF viewer frame without frame-src for the viewer', async ({
    page,
    request,
  }) => {
    const run = runId();
    // The strict baseline has `frame-src 'none'`: the viewer's origin is not allowed.
    const csp = policy({ 'connect-src': "'self'" }, STRICT);
    await openEmbed(page, `?run=${run}&csp=${encodePolicy(csp)}`);
    const outcome = await page.evaluate(async (viewer) => {
      const e = (
        window as unknown as {
          __embed: {
            backend(s: string): unknown;
            docId: string;
            openPdf(el: Element, s: unknown): Promise<{ pages: number }>;
          };
        }
      ).__embed;
      const el = document.createElement('doc-editor') as HTMLElement & Record<string, unknown>;
      el['config'] = { pdfViewerUrl: viewer };
      el['backend'] = e.backend('ada');
      el.setAttribute('doc-id', e.docId);
      const ready = new Promise((r) => el.addEventListener('de-ready', r, { once: true }));
      document.getElementById('mount')!.append(el);
      await ready;
      const coded = new Uint8Array(
        await (await fetch('/exports/sample.xor?sig=test-signature')).arrayBuffer(),
      );
      const started = performance.now();
      const result = await e.openPdf(el, { data: coded.map((b) => b ^ 0x5a).buffer }).then(
        (r) => `resolved: ${r.pages} pages`,
        (err: Error & { code?: string }) => `rejected: ${err.code ?? err.name}: ${err.message}`,
      );
      return {
        result,
        seconds: Math.round((performance.now() - started) / 1000),
        frames: el.shadowRoot!.querySelectorAll('iframe').length,
        editorText: el.shadowRoot!.querySelector('.de-editing-surface')?.textContent?.length ?? 0,
      };
    }, VIEWER);
    const collected = await collect(page, request, run, 500);
    record('fe-017-pdf-frame-without-frame-src', { csp, outcome, violations: summary(collected) });
    console.log(`FE-017 frame: ${JSON.stringify(outcome)} ${JSON.stringify(summary(collected))}`);
    // Measured: the frame never answers, so the open is refused with `unavailable` when the ready
    // timeout ends (15 s, READY_TIMEOUT_MS); the frame is removed and the editor stays usable.
    expect(outcome.result).toBe('rejected: unavailable: the PDF viewer did not answer');
    expect(outcome.frames).toBe(0);
    expect(outcome.editorText).toBeGreaterThan(0);
    expect(summary(collected)).toEqual([`page:frame-src:http://localhost:${PORT}`]);
  });

  for (const variant of ['no policy name and no style-src-attr', 'policy name only'] as const) {
    test(`the math editor with ${variant}`, async ({ page, request }) => {
      const run = runId();
      const csp = policy(variant === 'policy name only' ? { 'trusted-types': 'docedit-math' } : {});
      await openS2(page, run, csp);
      const outcome = await openMath(page);
      const collected = await collect(page, request, run);
      record(`fe-017-math-editor-${variant.replaceAll(' ', '-')}`, {
        csp,
        outcome,
        violations: summary(collected),
        errors: collected.errors,
      });
      console.log(
        `FE-017 math (${variant}): ${JSON.stringify(outcome)} ${JSON.stringify(summary(collected))} errors ${JSON.stringify(collected.errors).slice(0, 300)}`,
      );
      expect(outcome.report.tags).toEqual({
        'math-field': true,
        'math-span': true,
        'math-div': true,
      });
      if (variant === 'policy name only') {
        // Measured: the field is drawn and takes input; each inline style MathLive writes is
        // refused and reported. How the formula looks without those styles is not judged here.
        expect(outcome.report.value).toBe('x^2+1');
        expect(outcome.field.width).toBeGreaterThan(20);
        expect(summary(collected)).toEqual(['page:style-src-attr:inline']);
        expect(collected.errors).toEqual([]);
      } else {
        // Measured: the policy cannot be created, so MathLive's markup is never written. The
        // element is on the page but empty (a few pixels wide), the insert command changes
        // nothing, and the page sees an uncaught TypeError that names the policy.
        expect(outcome.report.value).toBe('x^2');
        expect(outcome.field.width).toBeLessThan(20);
        expect(summary(collected)).toEqual(['page:trusted-types:trusted-types-policy']);
        expect(collected.errors.length).toBeGreaterThan(0);
        expect(collected.errors.every((e) => e.includes('docedit-math'))).toBe(true);
      }
    });
  }
});
