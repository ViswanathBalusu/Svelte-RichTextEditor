/**
 * Spike S2 (SPK-015; ADR 0016): where 'wasm-unsafe-eval' must appear for a WebAssembly module to
 * compile, for a worker created from a `blob:` URL and for a same-origin worker whose script is
 * served with its own policy, and how each browser treats `blob:` workers under `worker-src`.
 * The tiny module is 41 bytes (demo/wasm-worker-source.ts); every outcome is recorded in
 * test-results/evidence/s2-wasm-*.json and asserted.
 */
import { type APIRequestContext, type Page, expect, test } from '@playwright/test';
import { encodePolicy, record, runId } from './helpers.ts';
import { collect, summary } from './s2-helpers.ts';

const PAGE = {
  'page without wasm-unsafe-eval':
    "default-src 'none'; script-src 'self'; worker-src 'self' blob:; connect-src 'self'; report-uri {report}",
  'page with wasm-unsafe-eval':
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self'; report-uri {report}",
} as const;

const WORKER = {
  'worker script without a policy': null,
  'worker script without wasm-unsafe-eval':
    "default-src 'none'; script-src 'self'; report-uri {report}",
  'worker script with wasm-unsafe-eval':
    "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; report-uri {report}",
} as const;

interface Result {
  created: boolean;
  compiled: boolean;
  instantiated: boolean;
  sum: number | null;
  error: string | null;
  violations: Array<{ directive: string }>;
}

async function run(
  page: Page,
  request: APIRequestContext,
  csp: string,
  what: () => Promise<Result>,
) {
  const id = runId();
  await page.goto(`/pages/wasm.html?run=${id}&csp=${encodePolicy(csp)}`);
  await page.waitForFunction(
    () => 'inWorker' in ((window as unknown as { __wasm?: object }).__wasm ?? {}),
  );
  const result = await what();
  const collected = await collect(page, request, id, 500);
  return { result, violations: summary(collected) };
}

const inWorker = (page: Page, kind: 'blob' | 'same-origin', workerCsp: string | null) =>
  page.evaluate(
    ([k, w]) =>
      (
        window as unknown as { __wasm: { inWorker(k: string, w: string | null): Promise<Result> } }
      ).__wasm.inWorker(k, w),
    [kind, workerCsp ? encodePolicy(workerCsp) : null] as const,
  );

test.describe('the page itself', () => {
  for (const [name, csp] of Object.entries(PAGE)) {
    test(`compiles on the ${name}`, async ({ page, request }) => {
      const out = await run(page, request, csp, () =>
        page.evaluate(() =>
          (window as unknown as { __wasm: { onPage(): Promise<Result> } }).__wasm.onPage(),
        ),
      );
      record(`s2-wasm-page-${name.replaceAll(' ', '-')}`, out);
      const allowed = name === 'page with wasm-unsafe-eval';
      expect(out.result.compiled).toBe(allowed);
      expect(out.result.sum).toBe(allowed ? 5 : null);
    });
  }
});

test.describe('a blob: worker inherits the page policy', () => {
  for (const [name, csp] of Object.entries(PAGE)) {
    test(`blob: worker on the ${name}`, async ({ page, request }) => {
      const out = await run(page, request, csp, () => inWorker(page, 'blob', null));
      record(`s2-wasm-blob-${name.replaceAll(' ', '-')}`, out);
      const allowed = name === 'page with wasm-unsafe-eval';
      expect(out.result.created).toBe(true);
      expect(out.result.compiled).toBe(allowed);
      expect(out.result.sum).toBe(allowed ? 5 : null);
    });
  }
});

test.describe('a same-origin worker takes the policy of its own script', () => {
  for (const [pageName, csp] of Object.entries(PAGE)) {
    for (const [workerName, workerCsp] of Object.entries(WORKER)) {
      test(`same-origin worker: ${workerName}, ${pageName}`, async ({ page, request }) => {
        const out = await run(page, request, csp, () => inWorker(page, 'same-origin', workerCsp));
        record(
          `s2-wasm-same-origin-${workerName.replaceAll(' ', '-')}-${pageName.replaceAll(' ', '-')}`,
          out,
        );
        // The page's policy plays no part inside the worker.
        const allowed = workerName !== 'worker script without wasm-unsafe-eval';
        expect(out.result.created).toBe(true);
        expect(out.result.compiled).toBe(allowed);
        expect(out.result.sum).toBe(allowed ? 5 : null);
      });
    }
  }
});

test.describe('blob: workers and worker-src', () => {
  const cases: Array<[string, string, boolean]> = [
    [
      "worker-src 'self' (no blob:)",
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self'; report-uri {report}",
      false,
    ],
    [
      'worker-src blob:',
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; worker-src blob:; report-uri {report}",
      true,
    ],
    [
      "no worker-src, script-src 'self'",
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; report-uri {report}",
      false,
    ],
    [
      "no worker-src, script-src 'self' blob:",
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval' blob:; report-uri {report}",
      true,
    ],
    [
      'no worker-src, child-src blob:',
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; child-src blob:; report-uri {report}",
      true,
    ],
  ];
  for (const [name, csp, allowed] of cases) {
    test(`blob: worker with ${name}`, async ({ page, request }) => {
      const out = await run(page, request, csp, () => inWorker(page, 'blob', null));
      record(`s2-wasm-worker-src-${name.replace(/[^A-Za-z0-9]+/g, '-')}`, out);
      expect(out.result.compiled).toBe(allowed);
      if (!allowed)
        expect(out.violations.some((v) => /worker-src|script-src|child-src/.test(v))).toBe(true);
    });
  }
});
