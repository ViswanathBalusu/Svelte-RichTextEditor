/**
 * Command state published through the registry (UX-003, criterion 4; 02 section 4): several state
 * changes within one animation frame produce one `de-command-state` event, and its detail lists
 * only the commands whose state changed. Lane U-UX-001-015.
 */
import { expect, open, test } from './helpers.ts';

test.describe('one command-state publication per frame (UX-003, criterion 4)', () => {
  test('a burst of selection changes in one frame fires one event that lists only what changed', async ({
    page,
  }) => {
    const h = await open(page, { hostToolbar: true });
    await h.setSelection({ empty: false, marks: [] });
    await h.frames(3);
    const result = await page.evaluate(async () => {
      const api = (window as unknown as { harness: Record<string, (...a: unknown[]) => unknown> })
        .harness;
      const host = document.getElementById('host')!;
      const seen: Array<{ frame: number; ids: string[] }> = [];
      let frame = 0;
      let counting = true;
      const tick = () => {
        frame++;
        if (counting) requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      const onState = (e: Event) =>
        seen.push({
          frame,
          ids: [...(e as CustomEvent<{ commands: string[] }>).detail.commands],
        });
      host.addEventListener('de-command-state', onState);
      await new Promise((r) => requestAnimationFrame(r));
      // Three changes in one task: the net state of bold is unchanged, italic changed.
      api['setSelection']!({ empty: false, marks: ['bold'] });
      api['setSelection']!({ empty: false, marks: ['bold', 'italic'] });
      api['setSelection']!({ empty: false, marks: ['italic'] });
      for (let i = 0; i < 6; i++) await new Promise((r) => requestAnimationFrame(r));
      counting = false;
      host.removeEventListener('de-command-state', onState);
      return seen;
    });
    // One publication for the burst, in one frame.
    expect(result).toHaveLength(1);
    expect(new Set(result.map((r) => r.frame)).size).toBe(1);
    const ids = result[0]!.ids;
    expect(ids).toContain('format.italic');
    // Bold ends where it started, and a command that never changes is not listed.
    expect(ids).not.toContain('format.bold');
    expect(ids).not.toContain('edit.selectAll');
  });
});
