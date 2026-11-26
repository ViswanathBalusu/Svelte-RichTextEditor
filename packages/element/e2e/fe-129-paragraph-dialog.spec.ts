/**
 * FE-129 criteria 2 and 6 in the real element: the paragraph dialog sets alignment, spacing, line
 * spacing, keep rules, shading and a tab stop from the keyboard, the paragraph in the document
 * stores them, and a tab in the text advances to the stop. The shell's own run, against a fake
 * core, is packages/ui/e2e/fe-129-paragraph-dialog.spec.ts.
 * Run: `DOCEDIT_DEMO_PORT=57843 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-129-paragraph-dialog.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const NAME = 'fe-129';
const HOST = `doc-editor[data-test="${NAME}"]`;
const CM = 1440 / 2.54;
/** A UUID version 7 for this run. */
function uuid7(): string {
  const hex = Date.now().toString(16).padStart(12, '0');
  const rand = [...crypto.getRandomValues(new Uint8Array(10))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  const variant = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
}

async function mount(page: Page): Promise<void> {
  const id = uuid7();
  await page.evaluate(
    async ({ id, name }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: {
              createDocument(content: unknown, opts: { id: string; grants: unknown[] }): string;
              backend(user: { sub: string; name: string }, docs: Record<string, string>): unknown;
            };
          };
        }
      ).__embed;
      const p = (pid: string, text: string, content?: unknown[]) => ({
        type: 'paragraph',
        attrs: { id: pid, style: null },
        content: content ?? [{ type: 'text', text }],
      });
      const doc = {
        type: 'doc',
        content: [
          {
            type: 'defs',
            content: [
              { type: 'settings', attrs: { lang: 'en-GB', defaultParagraphStyle: 'Normal' } },
              {
                type: 'style_def',
                attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
              },
              { type: 'page_setup', attrs: { id: 'ps1Fe129000000001' } },
            ],
          },
          {
            type: 'body',
            attrs: { pageSetup: 'ps1Fe129000000001' },
            content: [
              p('pOne000000000001', '', [
                { type: 'text', text: 'AB' },
                { type: 'tab' },
                { type: 'text', text: 'CD' },
              ]),
            ],
          },
        ],
      };
      e.service.createDocument({ cdm: 1, requires: [], doc }, { id, grants: [] });
      const backend = e.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'owner' });
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = name;
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = backend;
      el.setAttribute('doc-id', id);
      el.setAttribute('toolbar', 'full');
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { id, name: NAME },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

/** Runs `fn` with the document core of the element. */
function withCore<T>(page: Page, fn: string): Promise<T> {
  return page.evaluate(
    ({ host, fn }) => {
      const embed = (
        window as unknown as {
          __embed: { internals(el: Element): { editor: { core: unknown } } };
        }
      ).__embed;
      const core = embed.internals(document.querySelector(host)!).editor.core;
      return new Function('core', `return (${fn})(core);`)(core) as never;
    },
    { host: HOST, fn },
  );
}

/** The paragraph attributes of the block with this text. */
function attrsOf(page: Page, text: string): Promise<Record<string, unknown>> {
  return withCore(
    page,
    `(core) => {
      let found = null;
      const walk = (n) => {
        if (n.type === 'paragraph' && (n.content ?? []).some((c) => c.text === ${JSON.stringify(text)}))
          found = n.attrs;
        for (const c of n.content ?? []) walk(c);
      };
      walk(core.getContent().doc);
      return found;
    }`,
  );
}

test('FE-129: the dialog sets the options from the keyboard and a tab advances to the stop', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openEmbed(page);
  await mount(page);
  await page.locator(`${HOST} .de-editing-surface p`).first().click();
  await page.locator(`${HOST} .de-ruler`).getByRole('button', { name: 'Paragraph…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Paragraph' });
  await expect(dialog).toBeVisible();

  // Alignment, spacing and the line rule with the keyboard alone.
  await dialog.getByLabel('Alignment').focus();
  await page.keyboard.type('J');
  await dialog.getByLabel('Space after (pt)').focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('12');
  await dialog.getByLabel('Line spacing (lines)').focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('1.5');
  await dialog.getByLabel('Keep with next paragraph').focus();
  await page.keyboard.press('Space');
  await dialog.getByLabel('Shading colour (#RRGGBB, blank for none)').focus();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('#FFF2CC');
  // A tab stop at 2 cm, set from the keyboard: the button adds it, Tab reaches its fields.
  await dialog.getByRole('button', { name: 'Add a tab stop' }).focus();
  await page.keyboard.press('Enter');
  await dialog.getByLabel('Tab stop 1: position (cm)').fill('4');
  await dialog.getByLabel('Tab stop 1: leader').focus();
  await page.keyboard.type('D');
  // Enter closes the open list of a select; the button then applies with Enter too.
  await page.keyboard.press('Enter');
  await dialog.getByRole('button', { name: 'Apply' }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog).toHaveCount(0);

  await expect.poll(async () => (await attrsOf(page, 'AB'))['align']).toBe('justify');
  const attrs = await attrsOf(page, 'AB');
  expect(attrs).toMatchObject({
    spaceAfter: 240,
    lineSpacing: 1500,
    keepNext: true,
    shading: { fill: '#FFF2CC' },
  });
  expect(attrs['tabs']).toEqual([{ position: Math.round(4 * CM), align: 'left', leader: 'dot' }]);

  // The tab in the text now ends at the stop: the text after it starts 4 cm from the margin.
  const gap = await page.evaluate((host) => {
    const root = document.querySelector(host)!.shadowRoot!;
    const tab = root.querySelector<HTMLElement>('.de-editing-surface .de-doc-tab')!;
    const p = tab.closest('p')!;
    const margin = Number.parseFloat(getComputedStyle(p).marginLeft) || 0;
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT);
    let left = NaN;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const at = (n as Text).data.indexOf('CD');
      if (at < 0) continue;
      const r = document.createRange();
      r.setStart(n, at);
      r.setEnd(n, at + 2);
      left = r.getBoundingClientRect().left;
    }
    return {
      drawn: tab.getAttribute('data-de-tab-stop'),
      distance: left - (p.getBoundingClientRect().left - margin),
    };
  }, HOST);
  expect(gap.drawn).toBe('explicit');
  // 4 cm is about 151 CSS pixels.
  expect(Math.abs(gap.distance - (4 / 2.54) * 96)).toBeLessThan(2);
  expect(errors).toEqual([]);
});
