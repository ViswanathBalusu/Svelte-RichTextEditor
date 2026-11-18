/**
 * UX-070 criterion 3: the assistant's code is a separate chunk, requested only when the assistant
 * is first used. The page is the built harness with an assistant port attached; every request of
 * the page is recorded from the first navigation. At start the trace holds the editor's chunks and
 * none that names or holds the assistant's code (the controller and the request lifecycle); opening
 * the assistant pane then requests the chunk of `AssistantPane`, which does hold it. Run from the
 * repository root with `DOCEDIT_UI_PORT=57472 pnpm exec playwright test -c packages/ui/playwright.config.ts
 * ux-070-assistant-chunk.spec.ts`.
 */
import { expect, open, test } from './helpers.ts';

const EDITOR = { scope: 'body', caps: ['view', 'comment', 'suggest', 'edit'] } as const;
/** Names only the assistant's code defines (src/assistant/controller.ts, request-lifecycle.ts). */
const ASSISTANT_CODE = 'createAssistantController';

test.describe('the assistant loads on demand (UX-070, criterion 3)', () => {
  test('a network trace shows no assistant code at start and one chunk when the pane first opens', async ({
    page,
  }) => {
    const trace: string[] = [];
    page.on('request', (r) => trace.push(new URL(r.url()).pathname));
    const h = await open(page, { extended: true, assistant: true, access: EDITOR });
    await h.frames(2);
    const chunks = () => trace.filter((p) => p.startsWith('/assets/') && p.endsWith('.js'));

    // The editor has started with the assistant port attached and its command registered.
    expect(await h.commandIds()).toContain('view.assistant');
    expect(chunks().length).toBeGreaterThan(0);
    const atStart = [...chunks()];
    expect(atStart.filter((c) => /assistant/i.test(c))).toEqual([]);
    // No chunk of the start holds the assistant's code, whatever its name.
    for (const path of atStart) {
      const body = await (await page.request.get(path)).text();
      expect(body.includes(ASSISTANT_CODE), `${path} holds the assistant's code`).toBe(false);
    }

    await h.exec('view.assistant');
    await expect(page.locator('.de-pane[data-pane="assistant"]')).toBeVisible();
    const added = chunks().slice(atStart.length);
    expect(added.length).toBeGreaterThan(0);
    expect(added.some((c) => /^\/assets\/AssistantPane-[\w-]+\.js$/.test(c))).toBe(true);
    // The code arrived with the pane, in what was requested for it.
    const bodies = await Promise.all(added.map(async (p) => (await page.request.get(p)).text()));
    expect(bodies.some((b) => b.includes(ASSISTANT_CODE))).toBe(true);

    // Closing and opening again requests nothing more.
    const before = chunks().length;
    await h.exec('view.assistant');
    await expect(page.locator('.de-pane[data-pane="assistant"]')).toHaveCount(0);
    await h.exec('view.assistant');
    await expect(page.locator('.de-pane[data-pane="assistant"]')).toBeVisible();
    expect(chunks().length).toBe(before);
  });
});
