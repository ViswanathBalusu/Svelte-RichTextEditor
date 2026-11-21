/**
 * SEC-005 criterion 2 (lane w8): the injection corpus of the wire suites
 * (tests/security/test/support/payloads.ts), rendered by `<doc-editor>` in every supported browser,
 * in the places the criterion names:
 *
 * - region titles, the labels, values and choices of form fields, the alternative text of an
 *   inline picture and of a figure, and the document title a `title` field shows: one document
 *   that holds every payload in each of those places (and as the placeholder of an empty field,
 *   which this view does not draw);
 * - display names: a second user whose name is the payload joins the document, so the first
 *   user's editor draws the name in the presence list and on the caret. The name comes from the
 *   service (the `name` of the user's token) in one pass and from the host's own directory
 *   (`resolveUsers`) in another;
 * - comment bodies: that user comments with the payload, and the first user's editor shows the
 *   thread.
 *
 * The same strings as on the wire: a payload calls `alert`, sets `window.__pwned` or would pollute
 * `Object.prototype`, and each of those is a canary here. The page has no content security policy
 * (the embedding demo's default), so nothing stops a script but the component's own drawing; a
 * control at the start shows that the canary does fire in this browser when a payload is assigned
 * as HTML. Each payload carries a tag (`T3 <payload>`), and the test looks for the tagged string,
 * character for character, in the text, the attribute values and the control values of the
 * editor's shadow root: found there, it is text.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57818 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/sec-005-rendered-corpus.spec.ts --project=chromium --project=firefox --project=webkit`.
 */
import { validate } from '@docedit/model/validate';
import { type Page, expect, test } from '@playwright/test';
import { PAYLOADS } from '../../../tests/security/test/support/payloads.ts';
import { openEmbed } from './embed-helpers.ts';

type Json = Record<string, unknown>;

const pad = (i: number): string => String(i).padStart(4, '0');
const asset = (n: number): string => `0192f0c4-7b1e-7c3a-9a54-${n.toString(16).padStart(12, '0')}`;
/** A payload with the tag of the place it is put in, so that each place is found on its own. */
const tagged = (tag: string, i: number): string => `${tag}${i} ${PAYLOADS[i]!}`;

/** The places of the document test where the editor draws the string, by tag. */
const PLACES = {
  T: 'region title',
  L: 'form field label',
  V: 'form field value',
  O: 'choice label of a form field',
  D: 'document title',
  A: 'alternative text of a picture',
  F: 'alternative text of a figure',
} as const;

/** A document that holds every payload in every place of `PLACES`. */
function corpusDocument(): Json {
  const paragraph = (id: string, content: Json[]): Json => ({
    type: 'paragraph',
    attrs: { id, style: 'Normal' },
    content,
  });
  const text = (value: string): Json => ({ type: 'text', text: value });
  const regions = PAYLOADS.map((_, i): Json => ({
    type: 'region',
    attrs: { id: `rSec005Title${pad(i)}`, title: tagged('T', i), policy: 'inherit' },
    content: [
      paragraph(`pSec005Para0${pad(i)}`, [
        text(`Body ${i} `),
        {
          type: 'form_field',
          attrs: {
            id: `fSec005Text0${pad(i)}`,
            key: `sec.text${i}`,
            kind: 'text',
            label: tagged('L', i),
            value: tagged('V', i),
            assignee: null,
          },
        },
        text(' '),
        {
          type: 'form_field',
          attrs: {
            id: `fSec005Empty${pad(i)}`,
            key: `sec.empty${i}`,
            kind: 'text',
            label: `Empty ${i}`,
            value: null,
            placeholder: tagged('P', i),
            assignee: null,
          },
        },
        text(' '),
        { type: 'field', attrs: { kind: 'title', cached: tagged('D', i) } },
        text(' '),
        {
          type: 'image',
          attrs: { asset: asset(i + 1), width: 1440, height: 1440, alt: tagged('A', i) },
        },
      ]),
      {
        type: 'figure',
        attrs: {
          id: `gSec005Figur${pad(i)}`,
          asset: asset(i + 101),
          width: 1440,
          height: 1440,
          alt: tagged('F', i),
        },
      },
    ],
  }));
  return {
    cdm: 1,
    requires: ['fields'],
    doc: {
      type: 'doc',
      content: [
        {
          type: 'defs',
          content: [
            { type: 'settings', attrs: { lang: 'en-GB' } },
            {
              type: 'style_def',
              attrs: { id: 'Normal', kind: 'paragraph', name: 'Normal', builtIn: true },
            },
            { type: 'page_setup', attrs: { id: 'ps1' } },
          ],
        },
        {
          type: 'body',
          attrs: { pageSetup: 'ps1' },
          content: [
            paragraph('pSec005First0001', [
              text('Alpha bravo charlie '),
              {
                type: 'form_field',
                attrs: {
                  id: 'fSec005Choice001',
                  key: 'sec.choice',
                  kind: 'choice',
                  label: 'Choice',
                  value: null,
                  assignee: null,
                  options: PAYLOADS.map((_, i) => ({ id: `opt_${i}`, label: tagged('O', i) })),
                },
              },
            ]),
            ...regions,
            paragraph('pSec005Last00001', [text('Last paragraph.')]),
          ],
        },
      ],
    },
  };
}

/**
 * The canaries of the corpus: `alert` (and its kin), `window.__pwned`, and a member `polluted` on
 * `Object.prototype`. Anything a payload runs is recorded in `window.__fired`.
 */
async function armCanaries(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __fired: string[] };
    w.__fired = [];
    for (const name of ['alert', 'confirm', 'prompt'] as const)
      (window as unknown as Record<string, unknown>)[name] = (m?: unknown) => {
        w.__fired.push(`${name}(${String(m)})`);
        return null;
      };
    Object.defineProperty(window, '__pwned', {
      configurable: true,
      get: () => undefined,
      set: (v: unknown) => void w.__fired.push(`__pwned=${String(v)}`),
    });
  });
}

/** What fired, and whether the prototype of every object got a member. */
async function fired(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __fired: string[] };
    const polluted = 'polluted' in {} ? ['Object.prototype.polluted'] : [];
    return [...w.__fired, ...polluted];
  });
}

/** Shows that the canary does fire here when a payload is assigned as HTML: the test is not blind. */
async function expectCanaryWorks(page: Page): Promise<void> {
  const live = PAYLOADS.find((p) => p.includes('onerror'));
  expect(live, 'the corpus has an event-handler payload').toBeDefined();
  await page.evaluate((html) => {
    const div = document.createElement('div');
    div.id = 'canary-control';
    div.innerHTML = html;
    document.body.append(div);
  }, live!);
  await expect.poll(() => fired(page), { timeout: 10_000 }).not.toEqual([]);
  await page.evaluate(() => {
    document.getElementById('canary-control')?.remove();
    (window as unknown as { __fired: string[] }).__fired = [];
  });
}

interface Drawn {
  /** The text of the shadow root, in document order. */
  text: string;
  /** Every attribute value and every control value. */
  values: string[];
  /** Elements that could run or load something, and attributes that are event handlers. */
  live: string[];
}

/** What the editor named `name` draws: its text and values, and anything that is not text. */
async function drawn(page: Page, name: string): Promise<Drawn> {
  return page.evaluate((n) => {
    const root = document.querySelector(`doc-editor[data-test="${n}"]`)!.shadowRoot!;
    const values: string[] = [];
    const live: string[] = [];
    for (const el of root.querySelectorAll('*')) {
      for (const a of el.attributes) {
        values.push(a.value);
        if (/^on/i.test(a.name)) live.push(`${el.localName}[${a.name}]`);
        if (/^(href|src|action|formaction|data|xlink:href)$/i.test(a.name)) {
          if (/^\s*(javascript|data|vbscript):/i.test(a.value))
            live.push(`${el.localName}[${a.name}=${a.value.slice(0, 40)}]`);
        }
      }
      if (
        el instanceof HTMLInputElement ||
        el instanceof HTMLTextAreaElement ||
        el instanceof HTMLSelectElement
      )
        values.push(el.value);
      if (/^(script|iframe|object|embed|math|frame|base|meta|link)$/.test(el.localName))
        live.push(el.localName);
    }
    // On the editing surface nothing but the schema's own elements: no vector picture, no style
    // sheet, and a picture only inside the placeholder of an image, from an http or https URL.
    const surface = root.querySelector('.de-editing-surface');
    for (const el of surface?.querySelectorAll('svg, style') ?? [])
      live.push(`surface ${el.localName}`);
    for (const img of surface?.querySelectorAll('img') ?? []) {
      if (img.matches('.ProseMirror-separator')) continue;
      if (!img.closest('.de-image') || !/^https?:/.test(img.getAttribute('src') ?? ''))
        live.push('surface img');
    }
    return { text: root.textContent ?? '', values, live };
  }, name);
}

/** Mounts an editor on `doc` for a user; resolves when it is ready. */
async function mount(
  page: Page,
  o: { name: string; target: string; doc: string; sub: string; display: string },
): Promise<void> {
  const outcome = await page.evaluate(async (opts) => {
    const w = window as unknown as {
      __embed: { service: { backend(user: unknown, grants: Record<string, string>): unknown } };
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = opts.name;
    const ready = new Promise<string>((resolve) => {
      el.addEventListener('de-ready', () => resolve('ready'), { once: true });
      el.addEventListener(
        'de-error',
        (e) => resolve(`error ${JSON.stringify((e as CustomEvent).detail)}`),
        { once: true },
      );
    });
    el.backend = w.__embed.service.backend(
      { sub: opts.sub, name: opts.display },
      { [opts.doc]: 'editor' },
    );
    el.setAttribute('doc-id', opts.doc);
    document.getElementById(opts.target)!.append(el);
    return Promise.race([
      ready,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 20_000)),
    ]);
  }, o);
  expect(outcome, `${o.name} opens`).toBe('ready');
  await expect(page.locator(`doc-editor[data-test="${o.name}"] .de-editing-surface`)).toBeVisible();
}

function exec(page: Page, name: string, command: string): Promise<unknown> {
  return page.evaluate(
    ([n, c]) =>
      (
        document.querySelector(`doc-editor[data-test="${n}"]`) as unknown as {
          exec(command: string): unknown;
        }
      ).exec(c!),
    [name, command],
  );
}

test('SEC-005: the corpus in titles, field labels and values, alternative text and the document title is drawn as text', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  const envelope = corpusDocument();
  // The model accepts every payload in every one of these places: none is left out of the test.
  const checked = validate(envelope as never);
  expect(checked.violations, 'the corpus document is valid CDM').toEqual([]);

  await armCanaries(page);
  await openEmbed(page);
  await expectCanaryWorks(page);
  const doc = await page.evaluate(
    (env) =>
      (
        window as unknown as { __embed: { service: { createDocument(e: unknown): string } } }
      ).__embed.service.createDocument(env),
    envelope,
  );
  await mount(page, { name: 'corpus', target: 'mount', doc, sub: 'ada', display: 'Ada' });
  // The pictures are asked for and the field views drawn after the first paint.
  await page.waitForTimeout(500);

  const d = await drawn(page, 'corpus');
  const missing: string[] = [];
  for (const [tag, place] of Object.entries(PLACES))
    for (let i = 0; i < PAYLOADS.length; i++) {
      const want = tagged(tag, i);
      if (!d.text.includes(want) && !d.values.some((v) => v.includes(want)))
        missing.push(`${place}: ${want}`);
    }
  expect(missing, 'every payload is drawn as text in every place').toEqual([]);
  expect(d.live, 'nothing that runs or loads is drawn').toEqual([]);
  expect(await fired(page), 'no canary fired').toEqual([]);
  expect(errors).toEqual([]);
});

/** Selects the first five characters of an editor's first paragraph, as a reader would. */
async function selectWords(page: Page, name: string): Promise<void> {
  await page.locator(`doc-editor[data-test="${name}"] .de-editing-surface p`).first().click();
  await page.keyboard.press('Home');
  for (let k = 0; k < 5; k++) await page.keyboard.press('Shift+ArrowRight');
  // The editor reads the selection on the frame after the keys: let two frames pass.
  await page.evaluate(
    () =>
      new Promise<void>((done) => requestAnimationFrame(() => requestAnimationFrame(() => done()))),
  );
}

async function unmount(page: Page, name: string): Promise<void> {
  await page.evaluate((n) => {
    const el = document.querySelector(`doc-editor[data-test="${n}"]`) as HTMLElement & {
      destroy(): void;
    };
    el.destroy();
    el.remove();
  }, name);
}

/**
 * The first user's editor draws another user's name in the list of who is here (the label of the
 * person, and the title of the avatar) and on the flag of that user's caret: each time as the
 * text of an element with no element inside it, or as an attribute value.
 */
async function expectNameDrawn(page: Page, name: string): Promise<void> {
  const one = page.locator('doc-editor[data-test="one"]');
  const person = one.locator('.de-person').filter({ hasText: name });
  await expect(person).toHaveCount(1);
  const flag = one.locator('.de-peer-flag').filter({ hasText: name });
  await expect(flag).toHaveCount(1);
  expect(await person.locator('.de-avatar').getAttribute('title')).toContain(name);
  for (const label of [person.locator('.de-visually-hidden'), flag]) {
    const shown = await label.evaluate((el) => ({
      text: el.textContent ?? '',
      children: el.childElementCount,
    }));
    expect(shown.text).toContain(name);
    expect(shown.children, 'the name is text, not markup').toBe(0);
  }
}

test('SEC-005: the corpus in a display name and in a comment body is drawn as text', async ({
  page,
}) => {
  test.setTimeout(300_000);
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await armCanaries(page);
  await openEmbed(page);
  await expectCanaryWorks(page);
  const doc = await page.evaluate(
    () => (window as unknown as { __embed: { secondDocId: string } }).__embed.secondDocId,
  );
  await mount(page, { name: 'one', target: 'mount', doc, sub: 'ada', display: 'Ada' });
  const one = page.locator('doc-editor[data-test="one"]');
  expect(await exec(page, 'one', 'view.comments')).toMatchObject({ ok: true });
  const seen = new Set<string>();

  // First the name the service reports (the `name` of the user's token), and the comment body.
  for (let i = 0; i < PAYLOADS.length; i++) {
    const name = tagged('N', i);
    const body = tagged('C', i);
    // A second user whose display name is the payload joins, selects words and comments.
    await mount(page, { name: 'two', target: 'mount-2', doc, sub: `mallory${i}`, display: name });
    const two = page.locator('doc-editor[data-test="two"]');
    await selectWords(page, 'two');
    expect(await exec(page, 'two', 'review.comment')).toMatchObject({ ok: true });
    const box = two.locator('[data-dialog="comment"]');
    await expect(box).toBeVisible();
    await box.getByRole('textbox', { name: 'Comment' }).fill(body);
    await box.getByRole('button', { name: 'Post' }).click();
    await expect(box).toBeHidden();

    // The first user's editor draws the name, and, with the thread open, the body.
    await expect(one.locator('.de-comment-row')).toHaveCount(i + 1);
    await expectNameDrawn(page, name);
    // The thread that was not in the pane before is the new one.
    const rows = await one
      .locator('.de-comment-row')
      .evaluateAll((els) => els.map((el) => el.getAttribute('data-thread') ?? ''));
    const fresh = rows.filter((id) => !seen.has(id));
    expect(fresh).toHaveLength(1);
    seen.add(fresh[0]!);
    await one.locator(`.de-comment-row[data-thread="${fresh[0]}"] [data-thread-open]`).click();
    const thread = one.locator('[data-thread-view]');
    await expect(thread).toBeVisible();
    await expect(thread).toContainText(body);
    // The body is the text of one element with no element inside it.
    const bodies = await thread
      .locator('*')
      .evaluateAll(
        (els, want) =>
          els.filter((el) => (el.textContent ?? '').trim() === want && el.childElementCount === 0)
            .length,
        body,
      );
    expect(bodies, `the body of ${body} is drawn as one text`).toBe(1);
    for (const editor of ['one', 'two']) {
      const d = await drawn(page, editor);
      expect(d.live, `${editor}: nothing that runs or loads is drawn for ${name}`).toEqual([]);
    }
    expect(await fired(page), `no canary fired for ${PAYLOADS[i]}`).toEqual([]);

    // Back to the list. The second user leaves; the thread stays in the pane.
    await one.locator('[data-thread-back]').click();
    await unmount(page, 'two');
    await expect(one.locator('.de-comment-row')).toHaveCount(i + 1);
  }

  // Then the name the host's own directory gives (`resolveUsers`, 05 §8.1), which the editor
  // prefers to the service's.
  await page.evaluate(
    (payloads) => {
      const el = document.querySelector('doc-editor[data-test="one"]') as unknown as {
        resolveUsers: unknown;
      };
      el.resolveUsers = async (ids: readonly string[]) =>
        ids.map((id) => {
          const m = /^trudy(\d+)$/.exec(id);
          return m ? { id, name: `R${m[1]} ${payloads[Number(m[1])]}` } : null;
        });
    },
    [...PAYLOADS],
  );
  for (let i = 0; i < PAYLOADS.length; i++) {
    const name = tagged('R', i);
    await mount(page, { name: 'two', target: 'mount-2', doc, sub: `trudy${i}`, display: 'Trudy' });
    await selectWords(page, 'two');
    await expectNameDrawn(page, name);
    expect((await drawn(page, 'one')).live, `nothing that runs or loads for ${name}`).toEqual([]);
    expect(await fired(page), `no canary fired for ${PAYLOADS[i]}`).toEqual([]);
    await unmount(page, 'two');
  }
  expect(errors).toEqual([]);
});
