/**
 * Spike S2 (SPK-015): a host page that itself uses Svelte 5 (its own copy, default compile: HTML
 * string templates through Svelte's `svelte-trusted-html` policy) and restricts Trusted Types
 * policy names. The component is loaded next to it twice: compiled with `fragments: "tree"` (02 §3)
 * and, as the negative control, with Svelte's default `fragments: "html"`. Prepares FE-016, FE-124.
 */
import { expect, test } from '@playwright/test';
import { encodePolicy, record, runId } from './helpers.ts';
import { collect, policy, summary } from './s2-helpers.ts';

const HOST_NAMES = 'svelte-trusted-html docedit-worker docedit-math ProseMirrorClipboard';

const cases = [
  {
    name: 'component compiled with fragments: "tree"',
    bundle: 'tree',
    names: HOST_NAMES,
    loads: true,
  },
  {
    name: 'control: component compiled with fragments: "html"',
    bundle: 'control',
    names: HOST_NAMES,
    loads: false,
  },
  {
    name: "control with 'allow-duplicates' in the host policy",
    bundle: 'control',
    names: `${HOST_NAMES} 'allow-duplicates'`,
    loads: true,
  },
] as const;

for (const c of cases) {
  test(`Svelte host: ${c.name}`, async ({ page, request }) => {
    const run = runId();
    const csp = policy({ 'trusted-types': c.names });
    await page.goto(
      `/pages/svelte-host.html?run=${run}&bundle=${c.bundle}&csp=${encodePolicy(csp)}`,
    );
    await page.waitForFunction(() => {
      const s = (
        window as unknown as {
          __hostLoader?: { loaded: boolean; error: string | null; mounted: boolean };
        }
      ).__hostLoader;
      return s && (s.mounted || s.error !== null);
    });
    // The host's own Svelte keeps working.
    await page.locator('#host-button').click();
    await expect(page.locator('#host-clicked')).toHaveText('Clicked 1 times');
    const state = await page.evaluate(() => ({
      host: (window as unknown as { __host: unknown }).__host,
      loader: (window as unknown as { __hostLoader: unknown }).__hostLoader,
      editor: !!document
        .querySelector('doc-editor')
        ?.shadowRoot?.querySelector('.de-editing-surface'),
    }));
    const collected = await collect(page, request, run);
    record(
      `s2-svelte-host-${c.bundle}-${c.names.includes('allow-duplicates') ? 'dup' : 'strict'}`,
      {
        csp,
        state,
        violations: summary(collected),
        errors: collected.errors,
      },
    );
    expect((state.host as { mounted: boolean }).mounted).toBe(true);
    const loader = state.loader as { loaded: boolean; mounted: boolean; error: string | null };
    if (c.loads) {
      expect(loader).toMatchObject({ loaded: true, mounted: true, error: null });
      expect(state.editor).toBe(true);
      expect(summary(collected)).toEqual([]);
    } else {
      // The control's Svelte creates `svelte-trusted-html` when its module loads; the host already
      // did, and the host's policy does not allow duplicates. Since the production element, the
      // entry holds no Svelte (ADR 0039 §2): the element module loads, and the editor chunk, which
      // holds Svelte, fails when the document loads, reported as `de-error`.
      expect(loader.mounted).toBe(false);
      expect(state.editor).toBe(false);
      expect(loader.error).toMatch(/svelte-trusted-html/);
    }
  });
}
