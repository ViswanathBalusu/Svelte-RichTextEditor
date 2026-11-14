/**
 * FE-054 criterion 5 (lane V-FE-049-064, fixer round 4): a paste of clipboard HTML under Trusted Types
 * enforcement. The embedding demo is served with the strict baseline of s2-helpers.ts
 * (`require-trusted-types-for 'script'`, no report endpoint), and the test records
 * `securitypolicyviolation` events and page errors itself.
 *
 * 1. With the paste policy name allowed (`trusted-types docedit-paste`), the HTML is read through the
 *    whitelist: its own text arrives, not the plain text, and no violation is reported.
 * 2. With no policy name allowed, the parse is refused; the paste handler does not throw and the plain
 *    text is pasted instead.
 *
 * Chromium and WebKit only: Firefox ignores the clipboardData of a synthetic ClipboardEvent, as in
 * sec-005-canary.spec.ts. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-054-paste-trusted-types.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { mountEditor, openEmbed } from './embed-helpers.ts';

interface Recorded {
  violations: string[];
  errors: string[];
}

/** Opens the embedding demo under the strict policy plus `changes`, recording violations and errors. */
async function openStrict(page: Page, changes: Record<string, string | null>): Promise<Recorded> {
  const recorded: Recorded = { violations: [], errors: [] };
  page.on('pageerror', (e) => recorded.errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.effectiveDirective}:${e.blockedURI}:${e.sample}`);
    });
  });
  await openEmbed(page, `?csp=${encodePolicy(policy({ 'report-uri': null, ...changes }))}`);
  return recorded;
}

async function violations(page: Page): Promise<string[]> {
  return page.evaluate(() => [...(window as unknown as { __violations: string[] }).__violations]);
}

/** Dispatches a paste with the given parts, as sec-005-canary.spec.ts does. */
async function paste(page: Page, name: string, parts: { html: string; text: string }) {
  await page.evaluate(
    ({ name, parts }) => {
      const host = document.querySelector(`doc-editor[data-test="${name}"]`)!;
      const target = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
      const dt = new DataTransfer();
      dt.setData('text/html', parts.html);
      dt.setData('text/plain', parts.text);
      target.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, composed: true, clipboardData: dt }),
      );
    },
    { name, parts },
  );
}

/**
 * Puts the caret at the end of the last paragraph and types a marker, waiting until it shows, so the
 * surface is known to accept edits before the paste is dispatched.
 */
async function caretAtEnd(page: Page, name: string): Promise<void> {
  const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  await page.keyboard.type(' READY');
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain('READY');
}

function skipFirefox() {
  test.skip(
    test.info().project.name === 'firefox',
    'paste paths are run in Chromium and WebKit only',
  );
}

test.describe('FE-054 criterion 5: pasted HTML under Trusted Types enforcement', () => {
  test('with the paste policy allowed, the HTML text is pasted and no violation is reported', async ({
    page,
  }) => {
    skipFirefox();
    const recorded = await openStrict(page, { 'trusted-types': 'docedit-paste' });
    const name = 'fe-054-tt-allowed';
    await mountEditor(page, { name });
    const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
    await caretAtEnd(page, name);
    const before = await violations(page);
    await paste(page, name, {
      html: '<p><strong>HTML-TT-ALLOWED</strong> text<script>window.__canary=1</script></p>',
      text: 'PLAIN-TT-NOT-USED',
    });
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain('HTML-TT-ALLOWED');
    expect(await surface.evaluate((el) => el.textContent ?? '')).not.toContain('PLAIN-TT-NOT-USED');
    expect(await surface.locator('strong, b, [style*="bold"]').count()).toBeGreaterThan(0);
    expect(await surface.locator('script, img, svg, iframe').count()).toBe(0);
    expect(
      await page.evaluate(() => (window as unknown as { __canary?: unknown }).__canary),
    ).toBeUndefined();
    expect((await violations(page)).slice(before.length), 'no violation from the paste').toEqual(
      [],
    );
    expect(recorded.errors, 'no page error').toEqual([]);
  });

  test('with no policy name allowed, the paste does not throw and the plain text is used', async ({
    page,
  }) => {
    skipFirefox();
    const recorded = await openStrict(page, {});
    const name = 'fe-054-tt-refused';
    await mountEditor(page, { name });
    const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
    await caretAtEnd(page, name);
    await paste(page, name, {
      html: '<p>HTML-TT-REFUSED</p>',
      text: 'PLAIN-TT-FALLBACK',
    });
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain('PLAIN-TT-FALLBACK');
    expect(await surface.evaluate((el) => el.textContent ?? '')).not.toContain('HTML-TT-REFUSED');
    expect(recorded.errors, 'the paste handler did not throw').toEqual([]);
    // The refused policy name is reported by the page (the host has not allowed it).
    expect((await violations(page)).some((v) => v.startsWith('trusted-types'))).toBe(true);
  });
});
