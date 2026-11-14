/**
 * Extension hooks run after the paint of the transaction that caused them (UX-054, criterion 2).
 * The harness counts animation frames and records the frame of each input and the frame at which
 * each hook runs. A hook must run in a later frame than its input. Run from the repository root
 * with `pnpm exec playwright test -c packages/ui/playwright.config.ts hooks-after-paint.spec.ts`.
 *
 * The harness's fake core notifies once per frame by default (`notify: 'frame'`), so two inputs in
 * one frame give one change and one hook call. The test therefore does not count calls: it waits
 * for the call that carries the last revision and checks every call that came.
 */
import { expect, focusSurface, open, test } from './helpers.ts';

test.describe('extension hooks run after the paint (UX-054)', () => {
  test('each hook call comes in a frame after the input that caused it, and typing is not held', async ({
    page,
  }) => {
    const h = await open(page, { hooks: true });
    await focusSurface(page);
    const before = (await h.hookCalls()).length;
    const start = await h.revision();
    for (const key of 'abc') {
      await page.keyboard.type(key);
      // Lets the frame with this input be drawn before the next key.
      await h.frames(2);
    }
    // Every keystroke arrived: the transaction did not wait for a hook.
    await expect(page.locator('.de-editing-surface')).toContainText('abc');
    const revision = await h.revision();
    expect(revision).toBe(start + 3);
    // The hook catches up with the last change.
    await expect.poll(async () => (await h.hookCalls()).at(-1)?.revision).toBe(revision);
    const calls = (await h.hookCalls()).slice(before);
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.length).toBeLessThanOrEqual(3);
    for (const call of calls) {
      expect(call.duringInput).toBe(false);
      expect(call.inputFrame).toBeGreaterThanOrEqual(0);
      // The hook runs after at least one frame has been drawn since its input.
      expect(call.frame).toBeGreaterThan(call.inputFrame);
    }
    // One call per change, in order.
    const revisions = calls.map((c) => c.revision);
    expect(revisions).toEqual([...new Set(revisions)].sort((a, b) => a - b));
  });
});
