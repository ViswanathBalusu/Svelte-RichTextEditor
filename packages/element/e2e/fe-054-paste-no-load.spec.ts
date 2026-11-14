/**
 * FE-054 criterion 2 (lane U-FE-049-064): a paste of clipboard HTML that carries scripts, frames, objects,
 * styles, pictures and handlers runs none of them and loads none of their resources. The embedding demo is
 * served with the strict baseline of s2-helpers.ts plus `trusted-types docedit-paste`, so the HTML is parsed
 * under enforcement, as FE-054 criterion 5 requires. The test records every network request whose URL
 * carries a unique probe token, the `securitypolicyviolation` events and the page errors.
 *
 * Chromium and WebKit only: Firefox ignores the clipboardData of a synthetic ClipboardEvent (see
 * fe-054-paste-trusted-types.spec.ts). Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-054-paste-no-load.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const TOKEN = `u-fe-049-064-${Date.now().toString(36)}`;

const PROBES = [
  `/probe/${TOKEN}-img.png`,
  `/probe/${TOKEN}-script.js`,
  `/probe/${TOKEN}-frame.html`,
  `/probe/${TOKEN}-object.bin`,
  `/probe/${TOKEN}-embed.bin`,
  `/probe/${TOKEN}-style.css`,
  `/probe/${TOKEN}-video.mp4`,
  `/probe/${TOKEN}-svg.png`,
  `/probe/${TOKEN}-import.css`,
];

const HTML = [
  '<p><strong>HTML-NOLOAD</strong> kept</p>',
  `<img src="${PROBES[0]}" onerror="window.__canary=1" alt="pic">`,
  `<script src="${PROBES[1]}"></script><script>window.__canary=2</script>`,
  `<iframe src="${PROBES[2]}" onload="window.__canary=3"></iframe>`,
  `<object data="${PROBES[3]}"></object><embed src="${PROBES[4]}">`,
  `<link rel="stylesheet" href="${PROBES[5]}"><style>@import url("${PROBES[8]}");</style>`,
  `<video src="${PROBES[6]}" onloadeddata="window.__canary=4"></video>`,
  `<svg onload="window.__canary=5"><image href="${PROBES[7]}"></image></svg>`,
  '<p onclick="window.__canary=6" style="background:url(javascript:window.__canary=7)">after</p>',
].join('');

interface Recorded {
  requests: string[];
  errors: string[];
}

async function openStrict(page: Page): Promise<Recorded> {
  const recorded: Recorded = { requests: [], errors: [] };
  page.on('request', (r) => {
    if (r.url().includes(TOKEN)) recorded.requests.push(r.url());
  });
  page.on('pageerror', (e) => recorded.errors.push(e.message));
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.effectiveDirective}:${e.blockedURI}:${e.sample}`);
    });
  });
  await openEmbed(
    page,
    `?csp=${encodePolicy(policy({ 'report-uri': null, 'trusted-types': 'docedit-paste' }))}`,
  );
  return recorded;
}

test.describe('FE-054 criterion 2: pasted HTML runs nothing and loads nothing', () => {
  test('no probe resource is requested, no payload runs, and the kept text arrives (Chromium, WebKit)', async ({
    page,
    browserName,
  }) => {
    test.skip(browserName === 'firefox', 'paste paths are run in Chromium and WebKit only');
    const recorded = await openStrict(page);
    const name = 'fe-054-no-load';
    await mountEditor(page, { name });
    const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    await page.evaluate(
      ({ name, html }) => {
        const host = document.querySelector(`doc-editor[data-test="${name}"]`)!;
        const target = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
        const dt = new DataTransfer();
        dt.setData('text/html', html);
        dt.setData('text/plain', 'PLAIN-NOT-USED');
        target.dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, composed: true, clipboardData: dt }),
        );
      },
      { name, html: HTML },
    );
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain('HTML-NOLOAD');
    // Give any load the parse started time to reach the network.
    await page.waitForTimeout(1500);
    expect(recorded.requests, 'no probe resource was requested').toEqual([]);
    expect(
      await page.evaluate(() => (window as unknown as { __canary?: unknown }).__canary),
      'no payload ran',
    ).toBeUndefined();
    expect(
      await surface.locator('script, img, iframe, object, embed, video, svg, style, link').count(),
    ).toBe(0);
    expect(
      await page.evaluate(() =>
        (window as unknown as { __violations: string[] }).__violations.filter((v) =>
          v.includes('u-fe-049-064'),
        ),
      ),
      'no violation names a probe',
    ).toEqual([]);
    expect(recorded.errors, 'no page error').toEqual([]);
  });
});
