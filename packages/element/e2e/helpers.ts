/**
 * Shared helpers for the spike S1 and S2 tests. The harness (`@docedit/engine/testing`) lives in
 * the page; `harness(page)` calls its methods through `page.evaluate`.
 */
import { type Page, expect, test } from '@playwright/test';
import type { SpikeHarness } from '@docedit/engine/testing';
import { SPIKE_IDS } from '@docedit/engine/spike-document';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export { SPIKE_IDS };

type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : never;
};

/** Calls the in-page harness (stored as `window.h`). */
export function harness(page: Page): Remote<SpikeHarness> {
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        // Not a thenable: `await harness(page)` must return the proxy itself.
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (...args: unknown[]) =>
          page.evaluate(
            ([n, a]) => {
              const h = (window as unknown as { h: Record<string, (...x: unknown[]) => unknown> })
                .h;
              return h[n as string]!(...(a as unknown[]));
            },
            [name, args] as const,
          );
      },
    },
  ) as Remote<SpikeHarness>;
}

/** Opens the S1 page and waits for the editor and the harness. */
export async function openS1(page: Page, query = ''): Promise<Remote<SpikeHarness>> {
  await page.goto(`/pages/s1.html${query}`);
  await page.waitForFunction(() =>
    document.querySelector('doc-editor')?.shadowRoot?.querySelector('.de-editing-surface'),
  );
  await page.evaluate(async () => {
    const el = document.querySelector('doc-editor') as unknown as { spike(): Promise<unknown> };
    (window as unknown as { h: unknown }).h = await el.spike();
  });
  return harness(page);
}

/** Opens a sub-editor panel and waits until its view is mounted and focused. */
export async function openPanel(page: Page, kind: 'footnote' | 'header'): Promise<void> {
  const h = harness(page);
  if (kind === 'footnote') await h.openFootnote(SPIKE_IDS.footnote);
  else await h.openHeader();
  await page.locator('doc-editor .de-sub-editor').waitFor();
  await expect.poll(() => h.subMounted()).toBe(true);
}

/** Policies are sent base64url-encoded in the query string (demo/serve.ts). */
export function encodePolicy(policy: string): string {
  return Buffer.from(policy, 'utf8').toString('base64url');
}

const here = dirname(fileURLToPath(import.meta.url));

/** Writes a measurement record for the spike report: test-results/evidence/<name>.json. */
export function record(name: string, data: unknown): void {
  const info = test.info();
  const dir = join(here, '..', 'test-results', 'evidence');
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `${name}.${info.project.name}.json`);
  writeFileSync(
    file,
    JSON.stringify({ project: info.project.name, test: info.title, data }, null, 2),
  );
}

/**
 * A run identifier for the server's report and request logs, unique per execution: browsers may
 * deliver a report after the test that caused it has finished, and a reused identifier would hand
 * that late report to the next run of the same test.
 */
export function runId(): string {
  const info = test.info();
  const unique = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  return `${info.project.name}-${info.testId}-${info.repeatEachIndex}-${info.retry}-${unique}`.replace(
    /[^A-Za-z0-9_-]/g,
    '_',
  );
}
