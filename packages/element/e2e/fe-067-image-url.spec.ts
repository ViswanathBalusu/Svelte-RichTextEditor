/**
 * FE-067 criterion 3 through the element (lane w1): `<doc-editor>` draws a picture from the signed
 * URL its backend's assets port resolves, and from nothing else. The kitchen-sink fixture holds one
 * inline image. The embed page's mock backend has no assets port, so the test gives its backend one
 * (as fe-072-read-view.spec.ts gives it an exports port): `resolve` answers what the test case says.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57068 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-067-image-url.spec.ts`
 * in Chromium, Firefox and WebKit. The picture file is never fetched successfully (the host does not
 * exist); the test reads the DOM.
 */
import { readFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const envelope: unknown = JSON.parse(
  readFileSync(new URL('../../model/fixtures/kitchen-sink.json', import.meta.url), 'utf8'),
);

type Answer = { url: string; contentType: string } | 'none' | 'throws';

async function pictures(page: Page, answer: Answer) {
  return page.evaluate(
    async (args: { env: unknown; answer: Answer }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: {
              createDocument(env: unknown): string;
              backend(user: unknown, grants: Record<string, string>): unknown;
            };
          };
        }
      ).__embed;
      const id = e.service.createDocument(args.env);
      const backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' }) as {
        features: ReadonlySet<string>;
        connect(): Promise<void>;
        assets?: unknown;
      };
      if (args.answer !== 'none') {
        const connect = backend.connect.bind(backend);
        backend.connect = async () => {
          await connect();
          backend.features = new Set([...backend.features, 'assets']);
        };
        const calls: string[][] = [];
        backend.assets = {
          resolve: async (_doc: string, ids: string[]) => {
            calls.push(ids);
            if (args.answer === 'throws') throw new Error('offline');
            return {
              assets: ids.map((asset) => ({
                asset,
                url: (args.answer as { url: string }).url,
                contentType: (args.answer as { contentType: string }).contentType,
                expiresAt: '2099-01-01T00:00:00Z',
              })),
            };
          },
        };
        (window as unknown as { __resolveCalls: string[][] }).__resolveCalls = calls;
      }
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      const ready = new Promise<string>((resolve) => {
        el.addEventListener('de-ready', () => resolve('ready'), { once: true });
        el.addEventListener('de-error', () => resolve('error'), { once: true });
      });
      el.backend = backend;
      el.setAttribute('doc-id', id);
      document.getElementById('mount')!.append(el);
      const outcome = await Promise.race([
        ready,
        new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
      await new Promise((r) => setTimeout(r, 400));
      const root = el.shadowRoot!;
      const placeholders = root.querySelectorAll('.de-image').length;
      const imgs = Array.from(root.querySelectorAll('.de-image img')).map(
        (img) => img.getAttribute('src') ?? '',
      );
      const calls = (window as unknown as { __resolveCalls?: string[][] }).__resolveCalls ?? [];
      return { outcome, placeholders, imgs, resolveCalls: calls.length };
    },
    { env: envelope, answer },
  );
}

test('an https PNG answer is drawn inside the placeholder (FE-067, criterion 3)', async ({
  page,
}) => {
  await openEmbed(page);
  const r = await pictures(page, {
    url: 'https://assets.example.invalid/a.png?sig=1',
    contentType: 'image/png',
  });
  expect(r.outcome).toBe('ready');
  expect(r.placeholders).toBeGreaterThan(0);
  expect(r.imgs).toEqual(['https://assets.example.invalid/a.png?sig=1']);
  expect(r.resolveCalls).toBeGreaterThan(0);
});

for (const [name, answer] of [
  ['a data: URL', { url: 'data:image/png;base64,iVBORw0KGgo=', contentType: 'image/png' }],
  ['an SVG answer', { url: 'https://assets.example.invalid/a.svg', contentType: 'image/svg+xml' }],
  ['a javascript: URL', { url: 'javascript:window.__canary=1', contentType: 'image/png' }],
  ['a failing assets port', 'throws'],
  ['no assets port', 'none'],
] as const) {
  test(`${name} draws no picture (FE-067, criterion 3)`, async ({ page }) => {
    await openEmbed(page);
    const r = await pictures(page, answer);
    expect(r.outcome).toBe('ready');
    expect(r.placeholders).toBeGreaterThan(0);
    expect(r.imgs).toEqual([]);
  });
}
