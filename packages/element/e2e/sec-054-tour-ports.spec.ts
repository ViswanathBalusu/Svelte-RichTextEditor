/**
 * SEC-054 criterion 1 (10 §3.8; ADR 0044 §6), lane w8: the proofing and assistant ports under the
 * request recorder. The element now attaches both ports from the backend (UX-041, UX-045). The
 * tour mounts the element with a scripted proofing port and a scripted assistant port (no service
 * is called; the stand-ins answer from the page), lets the proofing marks appear, opens the
 * context menu on a marked word, opens the assistant pane, asks a question and approves the
 * answer. Every request made on the page must go to the demo's origin, or be a data: or blob: URL
 * built in the page.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57072 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/sec-054-tour-ports.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { expect, test, type Request as PwRequest } from '@playwright/test';
import { record, runId } from './helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const EDITOR = 'doc-editor[data-test="ports"]';
const PANE = `${EDITOR} .de-pane[data-pane="assistant"]`;
const ALLOWED_SCHEMES = new Set(['data:', 'blob:']);

test('SEC-054: the proofing and assistant ports are driven and nothing leaves the demo origin', async ({
  page,
  baseURL,
}) => {
  const origin = new URL(baseURL ?? 'http://127.0.0.1:4791').origin;
  const seen: Array<{ url: string; resourceType: string }> = [];
  page.on('request', (req: PwRequest) =>
    seen.push({ url: req.url(), resourceType: req.resourceType() }),
  );

  await openEmbed(page);
  await page.evaluate(async () => {
    const w = window as unknown as {
      __embed: { backend(sub: string, role: string): Record<string, unknown>; docId: string };
      __portCalls: { proofing: number; assistant: number };
    };
    w.__portCalls = { proofing: 0, assistant: 0 };
    const backend = w.__embed.backend('ada', 'editor');
    const proofing = {
      check(request: { blocks: { blockId: string; text: string }[] }) {
        w.__portCalls.proofing += 1;
        const found: unknown[] = [];
        for (const b of request.blocks)
          for (let at = b.text.indexOf('Remote'); at !== -1; at = b.text.indexOf('Remote', at + 1))
            found.push({
              blockId: b.blockId,
              from: at,
              to: at + 6,
              kind: 'spelling',
              message: 'Unknown word',
              suggestions: ['Remove', 'Remotely'],
            });
        return Promise.resolve(found);
      },
      addWord: () => Promise.resolve(),
    };
    const assistant = {
      async *request() {
        w.__portCalls.assistant += 1;
        yield { kind: 'text', text: 'Scripted answer' };
        yield { kind: 'done', agent: 'agt-test' };
      },
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'ports';
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
        { once: true },
      );
    });
    el.backend = new Proxy(backend, {
      get: (target, key) => {
        if (key === 'proofing') return proofing;
        if (key === 'assistant') return assistant;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    el.setAttribute('doc-id', w.__embed.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  });
  await expect(page.locator(`${EDITOR} .de-editing-surface`)).toBeVisible();

  // Proofing: the finding is drawn, and its context menu lists the port's suggestions.
  const finding = page.locator(`${EDITOR} .de-editing-surface [data-de-finding]`, {
    hasText: 'Remote',
  });
  await expect(finding.first()).toBeVisible();
  await finding.first().click({ button: 'right' });
  await expect(
    page.locator(`${EDITOR} .de-context-menu [data-finding-action="apply"]`),
  ).toHaveCount(2);
  await page.keyboard.press('Escape');

  // Assistant: open the pane, ask, and read the answer.
  const opened = await page.evaluate(
    (sel) =>
      (
        window as unknown as {
          __embed: {
            internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
          };
        }
      ).__embed
        .internals(document.querySelector(sel)!)
        .editor.openPane('assistant'),
    EDITOR,
  );
  expect(opened).toBe(true);
  const pane = page.locator(PANE);
  await pane.getByRole('textbox').fill('What is this?');
  await pane.locator('[data-ask="question"]').click();
  await expect(pane.locator('[data-assistant-state="shown"]')).toHaveText('Scripted answer');

  // The other lazy panes the header offers, opened in turn (each loads its chunk on demand).
  const panes = await page.evaluate(async (sel) => {
    const editor = (
      window as unknown as {
        __embed: {
          internals(el: Element): { editor: { openPane(id: string): Promise<boolean> } };
        };
      }
    ).__embed.internals(document.querySelector(sel)!).editor;
    const opened: Record<string, boolean> = {};
    for (const id of ['comments', 'catch-up', 'history']) opened[id] = await editor.openPane(id);
    return opened;
  }, EDITOR);
  expect(Object.values(panes).some(Boolean), 'at least one more lazy pane opened').toBe(true);
  await page.waitForLoadState('networkidle');

  const calls = await page.evaluate(
    () =>
      (window as unknown as { __portCalls: { proofing: number; assistant: number } }).__portCalls,
  );
  const remote = seen.filter((r) => {
    const u = new URL(r.url);
    return !ALLOWED_SCHEMES.has(u.protocol) && u.origin !== origin;
  });
  const hosts = [...new Set(seen.map((r) => new URL(r.url).origin))].sort();
  record('sec-054-tour-ports', {
    run: runId(),
    browser: test.info().project.name,
    requests: seen.length,
    hosts,
    panes,
    proofingCalls: calls.proofing,
    assistantCalls: calls.assistant,
    remote,
  });

  expect(calls.proofing, 'the proofing port was called').toBeGreaterThan(0);
  expect(calls.assistant, 'the assistant port was called').toBe(1);
  expect(seen.length).toBeGreaterThan(0);
  expect(remote).toEqual([]);
});
