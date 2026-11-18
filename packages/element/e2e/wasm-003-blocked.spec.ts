/**
 * WASM-003 (lane w6): the editor keeps working when the host's policy lacks `'wasm-unsafe-eval'`.
 * The embedding page is served with the strict baseline of s2-helpers.ts (no unsafe keyword,
 * Trusted Types enforced) and WITHOUT that directive, so compiling the layout kernel is refused.
 *
 * - Criterion 3: the refusal is reported to the host as `de-diagnostic` (`load-failed`, code
 *   `blocked_by_policy`, the directive to add) and then `degraded`, with the fallback of spike S5:
 *   canvas measurement in Chromium, Edge and WebKit, the web view in Firefox. A control with the
 *   directive loads the kernel.
 * - Criterion 2: in Firefox, where the page view is not available, a plain message says why and
 *   offers the web view and the read view, and the buttons change the `view` attribute. Elsewhere no
 *   message is shown: the page view will measure with canvas.
 * - Criterion 4: under the same policy, editing, saving, collaboration and the typeset PDF of the
 *   read view all work. The PDF is shown in Chromium and WebKit; a local filter on this machine
 *   refuses PDF responses in Firefox and Edge (spike S2 section 2; fe-072-read-view.spec.ts).
 *
 * Criterion 1 (the page view measures with canvas) is not tested: the page view is FE-101's and is
 * not built; only the choice and its report exist.
 *
 * Run with `DOCEDIT_DEMO_PORT=4796 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/wasm-003-blocked.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { FILTERED_BROWSERS, events, mountEditor, openEmbed } from './embed-helpers.ts';
import { encodePolicy } from './helpers.ts';
import { STRICT, policy } from './s2-helpers.ts';

const PORT = Number(process.env['DOCEDIT_DEMO_PORT'] ?? 4791);
const VIEWER_ORIGIN = `http://localhost:${PORT}`;

/** The strict baseline, for this page: the viewer's origin may be framed, no report endpoint. */
const BLOCKED = policy(
  {
    'report-uri': null,
    'trusted-types': 'docedit-paste docedit-worker',
    'frame-src': VIEWER_ORIGIN,
  },
  STRICT,
);
const ALLOWED = policy(
  {
    'report-uri': null,
    'trusted-types': 'docedit-paste docedit-worker',
    'frame-src': VIEWER_ORIGIN,
    'script-src': "'self' 'wasm-unsafe-eval'",
  },
  STRICT,
);

const surface = (name: string) => `doc-editor[data-test="${name}"] .de-editing-surface`;

async function open(page: Page, csp: string): Promise<void> {
  await openEmbed(page, `?csp=${encodePolicy(csp)}`);
}

interface Diagnostic {
  feature: string;
  kind: string;
  code: string | null;
  directive: string | null;
  fallback: string | null;
  ms: number | null;
}
const diagnostics = async (page: Page): Promise<Diagnostic[]> =>
  (await events(page, 'de-diagnostic')).map((e) => e.detail as Diagnostic);

test.describe('the kernel is refused by the policy (WASM-003 criteria 2 and 3)', () => {
  test('the host is told which feature degraded and which directive it lacks', async ({
    page,
    browserName,
  }) => {
    await open(page, BLOCKED);
    await mountEditor(page, { name: 'view', attributes: { view: 'print' } });
    await expect.poll(async () => (await diagnostics(page)).length).toBeGreaterThanOrEqual(2);
    const [failed, degraded] = await diagnostics(page);
    expect(failed).toMatchObject({
      feature: 'layout-kernel',
      kind: 'load-failed',
      code: 'blocked_by_policy',
      directive: "script-src 'wasm-unsafe-eval'",
      ms: null,
    });
    expect(degraded).toMatchObject({
      feature: 'layout-kernel',
      kind: 'degraded',
      code: 'blocked_by_policy',
      directive: "script-src 'wasm-unsafe-eval'",
      fallback: browserName === 'firefox' ? 'web-view' : 'canvas-measurement',
    });
    // The editor itself is unharmed.
    await expect(page.locator(surface('view'))).toBeVisible();
  });

  test('control: with the directive the kernel loads and nothing degrades', async ({ page }) => {
    await open(page, ALLOWED);
    await mountEditor(page, { name: 'view', attributes: { view: 'print' } });
    await expect.poll(async () => (await diagnostics(page)).length).toBeGreaterThanOrEqual(1);
    expect((await diagnostics(page)).map((d) => d.kind)).toEqual(['loaded']);
    await expect(
      page.locator('doc-editor[data-test="view"]').locator('.de-view-notice'),
    ).toHaveCount(0);
  });

  test('where the page view is not available a plain message says why and offers two views', async ({
    page,
    browserName,
  }) => {
    await open(page, BLOCKED);
    await mountEditor(page, { name: 'view', attributes: { view: 'print' } });
    await expect.poll(async () => (await diagnostics(page)).length).toBeGreaterThanOrEqual(2);
    const notice = page.locator('doc-editor[data-test="view"]').locator('.de-view-notice');
    if (browserName !== 'firefox') {
      // Canvas measurement is the fallback here (S5): the page view is not given up.
      await expect(notice).toHaveCount(0);
      return;
    }
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveAttribute('role', 'status');
    const text = (await notice.textContent()) ?? '';
    expect(text).toContain('The page view is not available.');
    expect(text).toContain('does not allow WebAssembly');
    expect(text).toContain("'wasm-unsafe-eval'");
    expect(await notice.locator('button').allTextContents()).toEqual(['Web view', 'Read view']);

    // "Read view" asks for it through the `view` attribute, and the message goes away.
    await notice.locator('button[data-view="read"]').click();
    await expect(page.locator('doc-editor[data-test="view"]')).toHaveAttribute('view', 'read');
    await expect(notice).toHaveCount(0);
  });
});

test.describe('under the same policy, everything but the page view works (WASM-003 criterion 4)', () => {
  test('editing, saving and collaboration', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await open(page, BLOCKED);
    await mountEditor(page, { name: 'ada', sub: 'ada' });
    await mountEditor(page, { name: 'bob', sub: 'bob' });

    // Editing: the text goes into the first editor.
    await page
      .locator(`${surface('ada')} p`)
      .last()
      .click();
    await page.keyboard.press('End');
    await page.keyboard.type(' wasm-blocked');
    await expect(page.locator(surface('ada'))).toContainText('wasm-blocked');

    // Saving: the editor reports a saved state after its last change.
    await expect
      .poll(
        async () => {
          const status = (await events(page, 'de-status')).filter((e) => e.element === 'ada');
          return (status.at(-1)?.detail as { sync?: string } | undefined)?.sync;
        },
        { timeout: 20_000 },
      )
      .toBe('saved');

    // Collaboration: the second session sees the first one's text.
    await expect(page.locator(surface('bob'))).toContainText('wasm-blocked', { timeout: 20_000 });
    expect(errors).toEqual([]);
  });

  test('the typeset PDF in the read view', async ({ page }, info) => {
    test.skip(
      FILTERED_BROWSERS.has(info.project.name),
      'PDF responses are filtered for this browser on this machine (spike S2 section 2); the signed-URL path runs in Chromium and WebKit',
    );
    await open(page, BLOCKED);
    const result = await page.evaluate(async () => {
      const e = (
        window as unknown as {
          __embed: { backend(sub: string, role: string): unknown; docId: string };
        }
      ).__embed;
      const backend = e.backend('ada', 'editor') as {
        features: ReadonlySet<string>;
        connect(): Promise<void>;
        exports?: unknown;
      };
      const connect = backend.connect.bind(backend);
      backend.connect = async () => {
        await connect();
        backend.features = new Set([...backend.features, 'exports']);
      };
      const job = {
        id: 'job-wasm003-1',
        docId: e.docId,
        state: 'completed',
        progress: null,
        target: 'pdf',
        result: { url: `${location.origin}/exports/sample.pdf`, pages: 1 },
        diagnostics: [],
      };
      backend.exports = { request: async () => job, get: async () => job, cancel: async () => {} };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'read';
      el.setAttribute('view', 'read');
      el.setAttribute('doc-id', e.docId);
      (el as unknown as { config: unknown }).config = {
        pdfViewerUrl: `${location.origin.replace('127.0.0.1', 'localhost')}/lib/viewer/pdf-viewer.html`,
      };
      el.backend = backend;
      document.getElementById('mount')!.append(el);
      const root = el.shadowRoot!;
      const deadline = Date.now() + 25_000;
      const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
      while (!root.querySelector('.de-read-pages iframe')) {
        if (Date.now() > deadline) throw new Error('the read view drew no page');
        await sleep(100);
      }
      return {
        editingSurfaces: root.querySelectorAll('.de-editing-surface').length,
        frames: root.querySelectorAll('.de-read-pages iframe').length,
      };
    });
    expect(result).toEqual({ editingSurfaces: 0, frames: 1 });
  });
});
