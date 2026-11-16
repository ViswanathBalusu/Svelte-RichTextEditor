/**
 * FE-016 criterion 5, second half: every surface reads pasted and dropped HTML under the project's
 * own Trusted Types policy, `docedit-paste`, and never under ProseMirror's `ProseMirrorClipboard`.
 * The S2 page is served with the strict baseline of s2-helpers.ts (`require-trusted-types-for
 * 'script'`) plus `trusted-types docedit-paste` and nothing else, so a read under any other policy
 * name would be reported as a violation.
 *
 * 1. A paste of HTML into the footnote panel (the sub-editor) keeps its formatting; no violation.
 * 2. A drop of HTML onto the body is read through the whitelist at the drop point; no violation.
 * 3. A drop of HTML onto the footnote panel keeps its text; no violation.
 * 4. With no policy name allowed, a paste into the footnote panel does not throw and uses the plain text.
 *
 * Chromium, Edge and WebKit: Firefox ignores the data of a synthetic ClipboardEvent, as in
 * fe-054-paste-trusted-types.spec.ts. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-016-paste-policy.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { harness, openPanel, runId } from './helpers.ts';
import { collect, openS2, policy } from './s2-helpers.ts';

const ALLOWED = policy({ 'trusted-types': 'docedit-paste' });

/** Dispatches a paste or a drop with the given parts on the first element that matches `selector`. */
async function deliver(
  page: Page,
  kind: 'paste' | 'drop',
  selector: string,
  parts: { html: string; text: string },
): Promise<void> {
  await page.evaluate(
    ({ kind, selector, parts }) => {
      const root = document.querySelector('doc-editor')!.shadowRoot!;
      const target = root.querySelector(selector) as HTMLElement;
      const dt = new DataTransfer();
      dt.setData('text/html', parts.html);
      dt.setData('text/plain', parts.text);
      if (kind === 'paste') {
        target.dispatchEvent(
          new ClipboardEvent('paste', {
            bubbles: true,
            composed: true,
            cancelable: true,
            clipboardData: dt,
          }),
        );
        return;
      }
      const box = target.getBoundingClientRect();
      target.dispatchEvent(
        new DragEvent('drop', {
          bubbles: true,
          composed: true,
          cancelable: true,
          dataTransfer: dt,
          clientX: box.left + 4,
          clientY: box.top + box.height / 2,
        }),
      );
    },
    { kind, selector, parts },
  );
}

/** The Trusted Types violations the page and the report endpoint saw. */
async function trustedTypesViolations(
  page: Page,
  request: Parameters<typeof collect>[1],
  run: string,
): Promise<string[]> {
  const c = await collect(page, request, run);
  return [...c.dom.map((v) => v.directive), ...c.reports.map((r) => r.directive)].filter((d) =>
    d.includes('trusted-types'),
  );
}

function skipFirefox() {
  test.skip(
    test.info().project.name === 'firefox',
    'paste paths are run in Chromium, Edge and WebKit only',
  );
}

test.describe('FE-016 criterion 5: HTML is read under docedit-paste on every surface', () => {
  test('a paste into the footnote panel keeps its formatting and raises no violation', async ({
    page,
    request,
  }) => {
    skipFirefox();
    const run = runId();
    await openS2(page, run, ALLOWED);
    const h = harness(page);
    await openPanel(page, 'footnote');
    await h.subCaret('end');
    await deliver(page, 'paste', '.de-sub-editor', {
      html: '<p><strong>SUB-HTML</strong> text<script>window.__canary=1</script></p>',
      text: 'SUB-PLAIN-NOT-USED',
    });
    await expect.poll(() => h.subText()).toContain('SUB-HTML');
    expect(await h.subText()).not.toContain('SUB-PLAIN-NOT-USED');
    expect(JSON.stringify(await h.subDoc())).toContain('"type":"bold"');
    expect(
      await page.locator('doc-editor .de-sub-editor').locator('script, img, iframe').count(),
    ).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __canary?: unknown }).__canary),
    ).toBeUndefined();
    expect(await trustedTypesViolations(page, request, run)).toEqual([]);
  });

  test('a drop of HTML onto the body is read at the drop point and raises no violation', async ({
    page,
    request,
  }) => {
    skipFirefox();
    const run = runId();
    await openS2(page, run, ALLOWED);
    const h = harness(page);
    await deliver(page, 'drop', '.de-editing-surface p', {
      html: '<p>BODY-DROP-HTML</p>',
      text: 'BODY-DROP-PLAIN-NOT-USED',
    });
    await expect.poll(() => h.bodyText()).toContain('BODY-DROP-HTML');
    expect(await h.bodyText()).not.toContain('BODY-DROP-PLAIN-NOT-USED');
    expect(await trustedTypesViolations(page, request, run)).toEqual([]);
  });

  test('a drop of HTML onto the footnote panel is read and raises no violation', async ({
    page,
    request,
  }) => {
    skipFirefox();
    const run = runId();
    await openS2(page, run, ALLOWED);
    const h = harness(page);
    await openPanel(page, 'footnote');
    await deliver(page, 'drop', '.de-sub-editor', {
      html: '<p>SUB-DROP-HTML</p>',
      text: 'SUB-DROP-PLAIN-NOT-USED',
    });
    await expect.poll(() => h.subText()).toContain('SUB-DROP-HTML');
    expect(await h.subText()).not.toContain('SUB-DROP-PLAIN-NOT-USED');
    expect(await trustedTypesViolations(page, request, run)).toEqual([]);
  });

  test('with no policy name allowed, a paste into the footnote panel uses the plain text', async ({
    page,
  }) => {
    skipFirefox();
    const errors: string[] = [];
    page.on('pageerror', (e) => errors.push(e.message));
    await openS2(page, runId(), policy());
    const h = harness(page);
    await openPanel(page, 'footnote');
    await h.subCaret('end');
    await deliver(page, 'paste', '.de-sub-editor', {
      html: '<p>SUB-HTML-REFUSED</p>',
      text: 'SUB-PLAIN-FALLBACK',
    });
    await expect.poll(() => h.subText()).toContain('SUB-PLAIN-FALLBACK');
    expect(await h.subText()).not.toContain('SUB-HTML-REFUSED');
    expect(errors, 'the paste handler did not throw').toEqual([]);
  });
});
