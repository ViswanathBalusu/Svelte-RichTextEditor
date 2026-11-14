/**
 * Focus is not hidden behind the shell's header, toolbar, panes or fixed overlays (UX-068,
 * criterion 3; lane V-UX-061-075, round 5). For each visible, enabled control of the shell, the
 * control is focused and the element at its centre is read from the shell's shadow root. The
 * control is not obscured when that element is the control itself or one of its descendants.
 *
 * The shell has no sticky element (the only `position: fixed` rules in src/styles/shell.css are
 * menus, the command search, the access-key tip and the mini toolbar, all shown on demand). The
 * test still walks every control with the full toolbar and two panes open, so that a future sticky
 * header or pane would be caught. Run from the repository root:
 * `DOCEDIT_UI_PORT=57293 pnpm exec playwright test -c packages/ui/playwright.config.ts ux-068-focus-not-obscured`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const STYLES = [
  { id: 'Normal', name: 'Normal', kind: 'paragraph' as const },
  { id: 'Heading1', name: 'Heading 1', kind: 'paragraph' as const },
  { id: 'Strong', name: 'Strong', kind: 'character' as const },
  { id: 'Grid', name: 'Grid table', kind: 'table' as const },
];

interface Walk {
  measured: number;
  obscured: string[];
}

/** Focuses each visible enabled control in turn and reports the ones covered at their centre. */
async function walkFocus(page: Page): Promise<Walk> {
  return page.evaluate(async () => {
    const root = document.getElementById('host')!.shadowRoot!;
    const selector =
      'button, [role="button"], [role="tab"], [role="menuitem"], [role="option"], [role="radio"], [role="checkbox"], select, input:not([type="hidden"]), textarea, a[href], [tabindex]:not([tabindex="-1"])';
    const controls = Array.from(root.querySelectorAll<HTMLElement>(selector));
    const out: string[] = [];
    let measured = 0;
    for (const el of controls) {
      if (el.closest('[hidden], [inert]')) continue;
      if (el.getClientRects().length === 0) continue;
      if ((el as HTMLButtonElement).disabled) continue;
      if (el.closest('.de-page, [data-content]')) continue;
      el.focus({ preventScroll: false });
      await new Promise((r) => requestAnimationFrame(() => r(null)));
      const box = el.getBoundingClientRect();
      if (box.width === 0 || box.height === 0) continue;
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      // Skip controls whose centre is off screen: a scroll would be needed, and that is a separate question.
      if (x < 0 || y < 0 || x > window.innerWidth || y > window.innerHeight) continue;
      measured += 1;
      const hit = root.elementFromPoint(x, y) as HTMLElement | null;
      const covered = hit === null || !(hit === el || el.contains(hit));
      if (covered) {
        out.push(
          `${el.tagName.toLowerCase()} "${(el.textContent ?? el.getAttribute('aria-label') ?? '').trim().slice(0, 30)}" covered by ${hit ? hit.tagName.toLowerCase() + '.' + hit.className : 'nothing'}`,
        );
      }
    }
    return { measured, obscured: out };
  });
}

test.describe('focus is not obscured by the shell (UX-068, criterion 3)', () => {
  // The pane host shows one pane at a time, so each pane is walked in its own test.
  for (const id of ['view.outline', 'view.styles']) {
    test(`every visible control, focused in turn with ${id} open, is not covered`, async ({
      page,
    }) => {
      const h = await open(page, { extended: true, toolbar: 'full', styles: STYLES });
      expect(await h.exec(id)).toEqual({ ran: true, reason: null });
      await expect(page.locator('.de-pane')).toHaveCount(1);

      const walk = await walkFocus(page);
      test.info().annotations.push({
        type: 'focus-walk',
        description: `${id}: ${walk.measured} controls focused`,
      });
      // A walk over no controls would pass vacuously.
      expect(walk.measured).toBeGreaterThan(10);
      expect(walk.obscured).toEqual([]);
    });
  }
});
