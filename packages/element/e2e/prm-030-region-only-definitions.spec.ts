/**
 * PRM-030 in the real `<doc-editor>` (lane w9; 07 §7, sixth bullet): a user who may edit only inside
 * regions applies an existing style there and the server accepts it, and the commands that change
 * styles, the page setup, headers or footers are not enabled for them, with the reason at hand:
 * on the control (its description and its title), in the status live region when it is tried, and
 * in `queryCommand` for a host that draws its own controls.
 *
 * The page is the embed page (demo/embed-page.ts) with its in-memory backend, which runs the real
 * room. Each test creates its own document: a paragraph, the restricted region "Terms" granted to
 * Rita, and a last paragraph, with a custom style, a numbering definition and a header story. Rita
 * opens it with the document role `viewer`; Olivia is an owner.
 *
 * Run with `pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/prm-030-region-only-definitions.spec.ts` (set `DOCEDIT_DEMO_PORT` to a free port).
 */
import { type Page, expect, test } from '@playwright/test';
import { clickToolbarCommand, events, openEmbed } from './embed-helpers.ts';

const IDS = {
  header: 'stHeader00000001',
  headerParagraph: 'pHeader000000001',
  intro: 'pIntro0000000001',
  region: 'rTerms0000000001',
  first: 'pTerms0000000001',
  after: 'pAfter0000000001',
  quote: 'sQuote0000000001',
} as const;

const HOST = 'doc-editor[data-test="prm030"]';
const STRUCTURE = 'Changing the structure of the document needs permission to do so.';
const NOT_ENABLED = { enabled: false, active: false };

declare global {
  interface Window {
    __prm030?: { docId: string };
  }
}

type Json = { type?: string; attrs?: Record<string, unknown>; content?: Json[] };

interface HostElement extends HTMLElement {
  backend: unknown;
  queryCommand(
    name: string,
    args?: unknown,
  ): { enabled: boolean; active: boolean; reason?: string };
  exec(name: string, args?: unknown): { ok: boolean; reason: string | null };
  flush(): Promise<void>;
}

/** Creates the document and mounts the editor of `sub`, who holds the document role `role`. */
async function mount(
  page: Page,
  sub: 'rita' | 'olivia',
  role: 'viewer' | 'owner',
  opts: { header?: boolean } = {},
): Promise<void> {
  await page.evaluate(
    async ({ IDS, sub, role, header }) => {
      const p = (id: string, text: string) => ({
        type: 'paragraph',
        attrs: { id, style: 'Normal' },
        content: [{ type: 'text', text }],
      });
      const level = {
        format: 'decimal',
        text: '%1.',
        start: 1,
        restartAfter: null,
        legal: false,
        indentLeft: 720,
        hanging: 360,
        align: 'start',
        bulletChar: null,
        runProps: null,
      };
      const envelope = {
        cdm: 1,
        requires: [],
        doc: {
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
                {
                  type: 'style_def',
                  attrs: {
                    id: 'Heading1',
                    kind: 'paragraph',
                    name: 'Heading 1',
                    builtIn: true,
                    basedOn: 'Normal',
                    next: 'Normal',
                    outlineLevel: 1,
                  },
                },
                {
                  type: 'style_def',
                  attrs: {
                    id: IDS.quote,
                    kind: 'paragraph',
                    name: 'Clause quote',
                    basedOn: 'Normal',
                  },
                },
                { type: 'numbering_def', attrs: { id: 'Num1', levels: [level] } },
                {
                  type: 'page_setup',
                  attrs: { id: 'ps1', ...(header ? { headerDefault: IDS.header } : {}) },
                },
              ],
            },
            ...(header
              ? [
                  {
                    type: 'story',
                    attrs: { id: IDS.header, kind: 'header' },
                    content: [
                      {
                        type: 'paragraph',
                        attrs: { id: IDS.headerParagraph },
                        content: [{ type: 'text', text: 'Header text' }],
                      },
                    ],
                  },
                ]
              : []),
            {
              type: 'body',
              attrs: { pageSetup: 'ps1' },
              content: [
                p(IDS.intro, 'Introduction.'),
                {
                  type: 'region',
                  attrs: { id: IDS.region, title: 'Terms', policy: 'restricted' },
                  content: [p(IDS.first, 'First term.')],
                },
                p(IDS.after, 'After the terms.'),
              ],
            },
          ],
        },
      };
      const e = (
        window as unknown as {
          __embed: {
            service: {
              createDocument(env: unknown, opts: unknown): string;
              backend(user: unknown, roles: Record<string, string>): unknown;
            };
          };
        }
      ).__embed;
      const docId = e.service.createDocument(envelope, {
        grants: [{ region: IDS.region, principal: 'user:rita', role: 'editor' }],
      });
      window.__prm030 = { docId };
      const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
      el.dataset['test'] = 'prm030';
      // The host gives the editor room, as a page does: the document is three lines long, and the
      // toolbar's menu is drawn inside the element's box.
      el.style.minHeight = '40rem';
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = e.service.backend({ sub, name: sub }, { [docId]: role });
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { IDS, sub, role, header: opts.header !== false },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

const surface = (page: Page) => page.locator(`${HOST} .de-editing-surface`);
const stylesPane = (page: Page) => page.locator(`${HOST} .de-styles`);
const status = (page: Page) => page.locator(`${HOST} .de-shell > [role="status"]`);

/** The document as the server holds it now. */
function served(page: Page): Promise<Json> {
  return page.evaluate(() => {
    const e = (
      window as unknown as {
        __embed: { service: { document(id: string): { content(): { doc: unknown } } } };
      }
    ).__embed;
    return e.service.document(window.__prm030!.docId).content().doc as Json;
  });
}

const find = (node: Json, id: string): Json | null =>
  node.attrs?.['id'] === id
    ? node
    : (node.content?.map((n) => find(n, id)).find((n) => n !== null) ?? null);

/** The definitions and the stories of a document: everything but the body. */
const outsideBody = (doc: Json): string =>
  JSON.stringify((doc.content ?? []).filter((n) => n.type !== 'body'));

/** The header command of the toolbar: its state, its reason, and whether a click opened the panel. */
function headerCommand(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('doc-editor[data-test="prm030"]')!.shadowRoot!;
    const button = root.querySelector<HTMLElement>('.de-toolbar [data-command-id="page.header"]');
    if (!button) return null;
    const described = button.getAttribute('aria-describedby');
    return {
      disabled: button.getAttribute('aria-disabled'),
      title: button.getAttribute('title'),
      description: described ? (root.getElementById(described)?.textContent ?? null) : null,
    };
  });
}

/** What the host's own toolbar would be told about the commands that change definitions. */
function hostAnswers(page: Page) {
  return page.evaluate(
    ({ IDS }) => {
      const el = document.querySelector<HTMLElement>('doc-editor[data-test="prm030"]')!;
      const host = el as unknown as {
        queryCommand(
          n: string,
          a?: unknown,
        ): { enabled: boolean; active: boolean; reason?: string };
        exec(n: string, a?: unknown): { ok: boolean; reason: string | null };
      };
      const commands: Array<[string, string, unknown]> = [
        ['header', 'page.header', undefined],
        ['header, by its other name', 'editHeader', undefined],
        ['new style', 'createStyle', { styleDef: { name: 'Clause', kind: 'paragraph' } }],
        ['rename style', 'changeStyle', { styleDef: { id: IDS.quote, name: 'Citation' } }],
        ['delete style', 'deleteStyle', { styleDef: { id: IDS.quote } }],
        [
          'page setup',
          'setPageSetup',
          { pageSetup: { id: 'ps1', changes: { orientation: 'landscape' } } },
        ],
        [
          'page number in the header',
          'insertField',
          { field: { kind: 'page', story: { id: IDS.header, pos: 1 } } },
        ],
      ];
      return commands.map(([label, name, args]) => ({
        label,
        query: host.queryCommand(name, args),
        exec: host.exec(name, args),
      }));
    },
    { IDS },
  );
}

test.describe('PRM-030: a user who may edit only inside regions', () => {
  test('applies an existing style in the region, and the server accepts it', async ({ page }) => {
    await openEmbed(page);
    await mount(page, 'rita', 'viewer');
    const before = await served(page);
    await clickToolbarCommand(page, 'view.styles');
    await stylesPane(page).waitFor();

    // In the region: the style in effect is marked, and another existing style is applied.
    await surface(page).locator('p', { hasText: 'First term.' }).click();
    const normal = stylesPane(page).locator('[data-style="Normal"] > button');
    const heading = stylesPane(page).locator('[data-style="Heading1"] > button');
    await expect(normal).toHaveAttribute('aria-current', 'true');
    await expect(heading).not.toHaveAttribute('aria-disabled', 'true');
    await heading.click();
    await expect(
      surface(page).locator('[data-style="Heading1"]', { hasText: 'First term.' }),
    ).toBeVisible();

    // The commit is accepted: the server's document has the style, and nothing was set aside.
    await page.evaluate(() =>
      (document.querySelector('doc-editor[data-test="prm030"]') as unknown as HostElement).flush(),
    );
    await expect
      .poll(async () => find(await served(page), IDS.first)?.attrs?.['style'])
      .toBe('Heading1');
    expect(await events(page, 'de-error')).toEqual([]);
    // The definitions and the header are as they were.
    expect(outsideBody(await served(page))).toBe(outsideBody(before));

    // Outside the region the same styles are not offered: the user may only view there.
    await surface(page).locator('p', { hasText: 'Introduction.' }).click();
    await expect(heading).toHaveAttribute('aria-disabled', 'true');
    await heading.click({ force: true });
    expect(find(await served(page), IDS.intro)?.attrs?.['style']).toBe('Normal');
  });

  test('finds the commands that change styles, the page setup and the header disabled, with the reason', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, 'rita', 'viewer');
    const before = await served(page);
    await surface(page).locator('p', { hasText: 'First term.' }).click();

    // The styles pane: creating, changing and deleting a style are disabled, and the pane says why.
    await clickToolbarCommand(page, 'view.styles');
    const pane = stylesPane(page);
    await pane.waitFor();
    const why = pane.locator('[data-styles="why"]');
    await expect(why).toContainText('needs permission to change the structure of the document');
    const actions = pane.locator('[data-style-action]');
    // New style, and change and delete for each of the three styles.
    await expect(actions).toHaveCount(7);
    const reason = (await why.textContent())!.trim();
    for (const action of await actions.all()) {
      await expect(action).toHaveAttribute('aria-disabled', 'true');
      await expect(action).toHaveAccessibleDescription(reason);
    }
    await pane.getByRole('button', { name: 'New style' }).click({ force: true });
    await pane.getByRole('button', { name: 'Change style Clause quote' }).click({ force: true });
    await pane.getByRole('button', { name: 'Delete style Clause quote' }).click({ force: true });
    await expect(pane.locator('form')).toHaveCount(0);
    await expect(pane.locator('[data-style] > button', { hasText: 'Clause quote' })).toHaveCount(1);

    // The header command of the toolbar: disabled, described by its reason, and it opens nothing.
    // The toolbar draws the registry's state once a frame, so the state is waited for.
    await expect
      .poll(() => headerCommand(page))
      .toEqual({ disabled: 'true', title: STRUCTURE, description: STRUCTURE });
    await page.evaluate(() =>
      document
        .querySelector('doc-editor[data-test="prm030"]')!
        .shadowRoot!.querySelector<HTMLElement>('.de-toolbar [data-command-id="page.header"]')!
        .click(),
    );
    await expect(status(page)).toHaveText(STRUCTURE);
    await expect(page.locator(`${HOST} .de-sub-editor`)).toHaveCount(0);

    // A host that draws its own controls is told the same by queryCommand, and exec runs nothing.
    const answers = await hostAnswers(page);
    for (const a of answers) {
      expect(a.query.enabled, a.label).toBe(false);
      expect(a.exec.ok, a.label).toBe(false);
      // The header command is the shell's (`page.header`, also named `editHeader`): the host is told
      // `{ enabled, active }` (05 §8.1), and its reason is on the control, as checked above. The
      // other commands are the core's and carry the reason.
      if (a.label.startsWith('header')) expect(a.query, a.label).toEqual(NOT_ENABLED);
      else expect(a.query, a.label).toEqual({ ...NOT_ENABLED, reason: 'no-access' });
    }
    expect(answers.map((a) => a.exec.reason)).toEqual(answers.map(() => 'not-applicable'));

    // Nothing reached the server: the definitions and the header are as they were.
    await page.evaluate(() =>
      (document.querySelector('doc-editor[data-test="prm030"]') as unknown as HostElement).flush(),
    );
    expect(outsideBody(await served(page))).toBe(outsideBody(before));
    expect(await events(page, 'de-error')).toEqual([]);
  });

  test('is not offered a header that would have to be created', async ({ page }) => {
    await openEmbed(page);
    await mount(page, 'rita', 'viewer', { header: false });
    const before = await served(page);
    await expect
      .poll(() => headerCommand(page))
      .toEqual({ disabled: 'true', title: STRUCTURE, description: STRUCTURE });
    const answer = await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="prm030"]') as unknown as HostElement;
      return { query: el.queryCommand('editHeader'), exec: el.exec('editHeader') };
    });
    expect(answer.query).toEqual(NOT_ENABLED);
    expect(answer.exec).toEqual({ ok: false, reason: 'not-applicable' });
    await expect(page.locator(`${HOST} .de-sub-editor`)).toHaveCount(0);
    expect(JSON.stringify(await served(page))).toBe(JSON.stringify(before));
    expect(JSON.stringify(before)).not.toContain('"story"');
  });

  test('an owner of the same document finds the same commands enabled', async ({ page }) => {
    await openEmbed(page);
    await mount(page, 'olivia', 'owner');
    await surface(page).locator('p', { hasText: 'First term.' }).click();
    await clickToolbarCommand(page, 'view.styles');
    const pane = stylesPane(page);
    await pane.waitFor();
    await expect(pane.locator('[data-styles="why"]')).toHaveCount(0);
    for (const action of await pane.locator('[data-style-action]').all())
      await expect(action).not.toHaveAttribute('aria-disabled', 'true');
    await expect
      .poll(() => headerCommand(page))
      .toEqual({ disabled: null, title: null, description: null });
    const enabled = await page.evaluate(
      ({ IDS }) => {
        const el = document.querySelector(
          'doc-editor[data-test="prm030"]',
        ) as unknown as HostElement;
        return [
          el.queryCommand('page.header'),
          el.queryCommand('editHeader'),
          el.queryCommand('createStyle'),
          el.queryCommand('changeStyle', { styleDef: { id: IDS.quote, name: 'Citation' } }),
          el.queryCommand('deleteStyle', { styleDef: { id: IDS.quote } }),
          el.queryCommand('setPageSetup', {
            pageSetup: { id: 'ps1', changes: { orientation: 'landscape' } },
          }),
        ].map((s) => s.enabled);
      },
      { IDS },
    );
    expect(enabled).toEqual([true, true, true, true, true, true]);
    // The host's exec makes the style, through the same command the query answered for.
    const made = await page.evaluate(() => {
      const el = document.querySelector('doc-editor[data-test="prm030"]') as unknown as HostElement;
      return el.exec('createStyle', { styleDef: { name: 'Annex', kind: 'paragraph' } });
    });
    expect(made).toEqual({ ok: true, reason: null });
    await expect(pane.locator('[data-style] > button', { hasText: 'Annex' })).toHaveCount(1);
  });
});
