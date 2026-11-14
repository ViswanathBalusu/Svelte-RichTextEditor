/**
 * Helpers for the shell's browser tests. `open(page, options)` loads the harness under the strict
 * policy and mounts the shell; `harness(page)` calls `window.harness` through `page.evaluate`.
 * Every test fails if the page reported a policy violation or an uncaught error.
 */
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test as base } from '@playwright/test';
import type { Harness, MountOptions } from './harness/main.ts';

type Remote<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? (...args: A) => Promise<Awaited<R>>
    : () => Promise<T[K]>;
};

export function harness(page: Page): Remote<Harness> {
  return new Proxy(
    {},
    {
      get: (_target, name) => {
        if (typeof name !== 'string' || name === 'then') return undefined;
        return (...args: unknown[]) =>
          page.evaluate(
            ([n, a]) => {
              const h = (window as unknown as { harness: Record<string, unknown> }).harness;
              const member = h[n as string];
              return typeof member === 'function'
                ? (member as (...x: unknown[]) => unknown)(...(a as unknown[]))
                : member;
            },
            [name, args] as const,
          );
      },
    },
  ) as Remote<Harness>;
}

export async function open(page: Page, options: MountOptions = {}): Promise<Remote<Harness>> {
  await page.goto('/');
  await page.waitForFunction(() => 'harness' in window);
  const h = harness(page);
  await h.mount(options);
  await page.locator('.de-shell').waitFor();
  await h.frames(2);
  return h;
}

/** Fails the test on any policy violation or uncaught error in the page. */
export const test = base.extend<{ clean: undefined }>({
  clean: [
    async ({ page }, use) => {
      await use(undefined);
      if (page.isClosed() || !page.url().startsWith('http')) return;
      const report = await page
        .evaluate(() => {
          const h = (window as unknown as { harness?: { violations: string[]; errors: string[] } })
            .harness;
          return h ? { violations: h.violations, errors: h.errors } : null;
        })
        .catch(() => null);
      if (report) {
        expect(report.violations, 'policy violations').toEqual([]);
        expect(report.errors, 'uncaught errors').toEqual([]);
      }
    },
    { auto: true },
  ],
});

export { expect };

/** What has focus inside the shell's shadow root: a short description for assertions. */
export async function focused(page: Page): Promise<{
  tag: string;
  text: string;
  command: string | null;
  className: string;
  inside: string | null;
}> {
  return page.evaluate(() => {
    const active = document.getElementById('host')!.shadowRoot!.activeElement as HTMLElement | null;
    if (!active) return { tag: '', text: '', command: null, className: '', inside: null };
    return {
      tag: active.tagName.toLowerCase(),
      text: (active.getAttribute('aria-label') ?? active.textContent ?? '').trim(),
      command: active.getAttribute('data-command-id'),
      className: active.className,
      inside: active.closest('[data-landmark]')?.getAttribute('data-landmark') ?? null,
    };
  });
}

/** Puts the caret in the editing surface. */
export async function focusSurface(page: Page): Promise<void> {
  await page.locator('.de-editing-surface').focus();
}

/** Runs axe on the shell with the WCAG 2.2 AA rule sets; returns the violations, summarised. */
export async function axe(page: Page): Promise<string[]> {
  const result = await new AxeBuilder({ page })
    .include('#host')
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa'])
    .analyze();
  return result.violations.map(
    (v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`,
  );
}

/** The text of every visible interface string in the shell, with what it belongs to. */
export async function visibleStrings(page: Page): Promise<Array<{ text: string; where: string }>> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const out: Array<{ text: string; where: string }> = [];
    // Document content (the page, names, titles, style names) is not an interface string.
    const excluded = (el: Element | null): boolean =>
      !!el?.closest('[data-content], .de-page, [hidden]');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent?.trim() ?? '';
      const parent = node.parentElement;
      if (!text || !parent || excluded(parent)) continue;
      // Rendered, or visually hidden for assistive technology (which still has a 1px box).
      if (parent.getClientRects().length === 0) continue;
      out.push({ text, where: parent.className || parent.tagName });
    }
    for (const el of root.querySelectorAll('[aria-label], [title]')) {
      if (excluded(el)) continue;
      for (const attribute of ['aria-label', 'title']) {
        const value = el.getAttribute(attribute)?.trim();
        if (value)
          out.push({ text: value, where: `${attribute} of ${el.className || el.tagName}` });
      }
    }
    return out;
  });
}
