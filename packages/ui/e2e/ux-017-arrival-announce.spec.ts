/**
 * UX-017 criterion 6 (lane V-UX-016-030): when a new item is set aside, the arrival is announced
 * through the shell's status region (FE-107), and a further item is announced again. Rendered in the
 * browser: the hidden `role="status"` region inside the shell's shadow root must read the notice.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-017-arrival-announce`.
 */
import type { Page } from '@playwright/test';
import { expect, open, test } from './helpers.ts';

const item = (id: string, seq: number) => ({
  id,
  reason: 'rebase' as const,
  commit: null,
  text: `Words ${id}`,
  seq,
});

async function announcement(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.getElementById('host')!.shadowRoot!;
    const region = [...root.querySelectorAll('[role="status"]')].find((el) =>
      el.classList.contains('de-visually-hidden'),
    );
    return (region?.textContent ?? '').trim();
  });
}

test.describe('set-aside arrivals are announced (UX-017 criterion 6)', () => {
  test('a new set-aside item is announced through the status region, and so is the next one', async ({
    page,
  }) => {
    const h = await open(page, { extended: true });
    await h.setAside([item('i1', 4)]);
    await expect.poll(() => announcement(page)).toMatch(/kept in recovered edits/);
    const first = await announcement(page);

    await h.setAside([item('i1', 4), item('i2', 5)]);
    await expect.poll(() => announcement(page)).toMatch(/kept in recovered edits/);
    // The second arrival is a new announcement: the text names two changes, not the one before.
    await expect.poll(() => announcement(page)).not.toBe(first);
    const second = await announcement(page);
    expect(second).toMatch(/\b2\b|two|changes/i);
  });
});
