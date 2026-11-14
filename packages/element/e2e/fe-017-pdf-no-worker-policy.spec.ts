/**
 * FE-017 criterion 4 (lane V-FE-017-032): what the in-page PDF panel does when the host does not
 * allow the `docedit-worker` Trusted Types policy name, measured under the strict baseline of the
 * S2 harness (require-trusted-types-for 'script', trusted-types 'none'). The guide says this was not
 * measured; this run records the violations (page and server reports, which include workers) and
 * whether the sample document opened. The production viewer frame is not covered here.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-017-pdf-no-worker-policy.spec.ts --retries=0 --project=chromium --output=packages/element/test-results/V-FE-017-032-fe017-pdf
 */
import { expect, test } from '@playwright/test';
import { runId } from './helpers.ts';
import { collect, openS2, policy, showSamplePdf, summary } from './s2-helpers.ts';

/** The worker script's own policy, as in s2-features.spec.ts (not imported: that file registers tests). */
const PDF_WORKER_POLICY =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; connect-src 'self'; report-uri {report}";

test.describe('FE-017 criterion 4: the in-page PDF panel without the docedit-worker name', () => {
  test('strict baseline, no policy name: the panel reports the violation and what opened', async ({
    page,
    request,
  }) => {
    const run = runId();
    const csp = policy({});
    await openS2(page, run, csp);
    let outcome: string;
    try {
      const result = await showSamplePdf(page, run, { workerPolicy: PDF_WORKER_POLICY });
      outcome = `resolved: ${JSON.stringify(result).slice(0, 200)}`;
    } catch (e) {
      outcome = `rejected: ${(e as Error).message.split('\n')[0]}`;
    }
    const collected = await collect(page, request, run, 1500);
    console.log(
      `FE-017 pdf without docedit-worker: outcome ${outcome}; violations ${JSON.stringify(summary(collected))}`,
    );
    // Measured: the policy is refused, the viewer reports ok false with no page, and the page
    // reports one trusted-types violation (no worker report, because no worker starts).
    // The message differs by engine (Chromium and Edge: "disallowed"; Firefox: "blocked creating").
    expect(outcome).toContain('docedit-worker');
    expect(outcome).toContain('"ok":false');
    expect(summary(collected)).toEqual(['page:trusted-types:trusted-types-policy']);
  });
});
