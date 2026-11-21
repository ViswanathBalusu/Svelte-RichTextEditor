/**
 * SEC-005 criterion 3 (lane w8): pasted HTML that carries scripts, handlers, frames, styles and
 * data URLs, through each paste path of `<doc-editor>`:
 *
 * - the HTML path with the Word and Google Docs cleaners (FE-054): each of the six stored
 *   clipboard samples of packages/engine/test/clipboard-corpus, with the hostile markup of
 *   `hostile` put before its content and an event handler put on its own elements;
 * - the embedded-fragment path: a real copy made by the editor, pasted back with the hostile
 *   markup around it, and with its fragment rewritten to hold what the model does not know (the
 *   corpus as text, a `javascript:` link, an unknown node type, handler and prototype-chain
 *   attributes);
 * - the plain-text path: every payload of the corpus (tests/security/test/support/payloads.ts) as
 *   `text/plain` alone.
 *
 * After each paste: no canary fired (`alert`, `window.__pwned`, a polluted prototype), no request
 * was made for a probe URL, nothing that runs or loads is in the editor's shadow root, and the
 * confirmed content the element returns (`getContent`) is valid CDM that holds no handler, no
 * active URL and nothing of the hostile markup: what the model does not know did not survive. The
 * sample's own text and structure did, which shows that the cleaner path was the one taken. A
 * control at the start shows the canary fires in this browser when the same markup is assigned as
 * HTML, so the page itself blocks nothing.
 *
 * Chromium and WebKit: Firefox ignores the clipboard data of a synthetic paste event, as in the
 * other paste suites. Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57818 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/sec-005-paste-paths.spec.ts --project=chromium --project=webkit`.
 */
import { readFileSync } from 'node:fs';
import { validate } from '@docedit/model/validate';
import { type Page, expect, test } from '@playwright/test';
import { PAYLOADS } from '../../../tests/security/test/support/payloads.ts';
import { mountEditor, openEmbed } from './embed-helpers.ts';

const TOKEN = `w8-sec-005-${Date.now().toString(36)}`;

/** Markup that runs, loads or redirects when a browser is given it as HTML. */
const hostile = (): string =>
  [
    '<script>window.__pwned = 1</script>',
    `<script src="/probe/${TOKEN}-script.js"></script>`,
    `<img src="/probe/${TOKEN}-img.png" onerror="alert(1)" alt="HOSTILE-ALT">`,
    `<img src="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' onload='alert(1)'/%3E">`,
    `<iframe src="/probe/${TOKEN}-frame.html" onload="alert(1)"></iframe>`,
    '<iframe src="data:text/html,<script>parent.alert(1)</script>"></iframe>',
    '<iframe srcdoc="<script>parent.alert(1)</script>"></iframe>',
    `<object data="/probe/${TOKEN}-object.bin"></object><embed src="/probe/${TOKEN}-embed.bin">`,
    `<style>p { background: url("/probe/${TOKEN}-style.png") } @import url("/probe/${TOKEN}-import.css");</style>`,
    `<link rel="stylesheet" href="/probe/${TOKEN}-link.css">`,
    `<meta http-equiv="refresh" content="0;url=/probe/${TOKEN}-refresh">`,
    `<base href="/probe/${TOKEN}-base/">`,
    '<svg onload="alert(1)"><script>alert(1)</script><a href="javascript:alert(1)"><text>HOSTILE-SVG</text></a></svg>',
    '<math><mi xlink:href="javascript:alert(1)">x</mi></math>',
    '<p><a href="javascript:alert(1)">HOSTILE-JS-LINK</a> <a href="data:text/html,<script>alert(1)</script>">HOSTILE-DATA-LINK</a> <a href="vbscript:msgbox(1)">HOSTILE-VB-LINK</a></p>',
    '<form action="javascript:alert(1)"><input value="HOSTILE-FORM" onfocus="alert(1)" autofocus><button formaction="javascript:alert(1)">go</button></form>',
    `<p onclick="alert(1)" onmouseover="window.__pwned = 1" style="background:url(javascript:alert(1));width:expression(alert(1));behavior:url(/probe/${TOKEN}-behavior.htc)">HOSTILE-STYLED</p>`,
    `<video src="/probe/${TOKEN}-video.mp4" onloadeddata="alert(1)" autoplay></video><audio src="/probe/${TOKEN}-audio.mp3" onerror="alert(1)"></audio>`,
    // Word's own carriers: a VML shape, and an OLE object in a conditional comment.
    `<v:shape href="javascript:alert(1)" style="width:10pt;height:10pt"><v:imagedata src="/probe/${TOKEN}-vml.png" o:title="x"/></v:shape>`,
    '<!--[if gte mso 9]><xml><o:OLEObject Type="Embed" ProgID="x" ObjectID="_1"/></xml><![endif]-->',
  ].join('');

/** What of the hostile markup must not be in the stored content, in any form. */
const TRACES = [
  '__pwned',
  'alert(',
  'javascript:',
  'vbscript:',
  'data:',
  'onerror',
  'onclick',
  'onload',
  'onmouseover',
  'onfocus',
  'expression(',
  '/probe/',
  'srcdoc',
  'polluted',
] as const;

interface Sample {
  file: string;
  /** Texts of the sample that the paste must bring. */
  texts: string[];
  /** What the cleaner maps the sample to: a check on the stored content. */
  mapped: (stored: string) => boolean;
}

const SAMPLES: Sample[] = [
  {
    file: 'word-text.html',
    texts: ['Quarterly review', 'under budget'],
    mapped: (s) => s.includes('"href":"https://example.com/report"'),
  },
  {
    file: 'word-lists.html',
    texts: ['Apples', 'Second step'],
    mapped: (s) => s.includes('"numbering"'),
  },
  {
    file: 'word-table.html',
    texts: ['Widgets', 'Merged footer'],
    mapped: (s) => s.includes('"type":"table"'),
  },
  {
    file: 'gdocs-text.html',
    texts: ['Meeting notes', 'ship on Friday'],
    mapped: (s) => s.includes('"href":"https://example.com/plan"'),
  },
  {
    file: 'gdocs-lists.html',
    texts: ['Milk', 'Preheat'],
    mapped: (s) => s.includes('"numbering"'),
  },
  {
    file: 'gdocs-table.html',
    texts: ['Shared note', 'Grace'],
    mapped: (s) => s.includes('"type":"table"'),
  },
];

/** The sample with the hostile markup before its content and a handler on its own elements. */
function poisoned(file: string): string {
  const html = readFileSync(
    new URL(`../../engine/test/clipboard-corpus/${file}`, import.meta.url),
    'utf8',
  );
  const first = /<(?:h[1-6]|p|ul|ol|table)\b/.exec(html);
  if (!first) throw new Error(`${file} has no block to put the markup before`);
  const withMarkup = html.slice(0, first.index) + hostile() + html.slice(first.index);
  const handled = withMarkup.replace(
    /<(p|span|a|h[1-6]|li|td|th|tr|table|ul|ol|b|i)(?=[\s>])/g,
    '<$1 onclick="alert(1)" onmouseover="window.__pwned = 1"',
  );
  expect(handled).not.toBe(withMarkup);
  return handled;
}

/** The canaries of the corpus; what a payload runs is recorded in `window.__fired`. */
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

async function fired(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const w = window as unknown as { __fired: string[] };
    return [...w.__fired, ...('polluted' in {} ? ['Object.prototype.polluted'] : [])];
  });
}

interface Watch {
  requests: string[];
  errors: string[];
}

/** Opens the embedding demo with the canaries armed and the probe requests recorded. */
async function open(page: Page): Promise<Watch> {
  const watch: Watch = { requests: [], errors: [] };
  page.on('request', (r) => {
    if (r.url().includes(TOKEN)) watch.requests.push(r.url());
  });
  page.on('pageerror', (e) => watch.errors.push(e.message));
  await armCanaries(page);
  await openEmbed(page);
  // The control: the same markup, assigned as HTML outside the editor, runs and loads here.
  await page.evaluate(
    (html) => {
      const div = document.createElement('div');
      div.id = 'canary-control';
      // The control leaves out the page-level tags (a refresh navigates away, a base moves the page's own URLs).
      div.innerHTML = html;
      document.body.append(div);
    },
    hostile().replace(/<meta[^>]*>|<base[^>]*>/g, ''),
  );
  await expect.poll(() => fired(page), { timeout: 10_000 }).not.toEqual([]);
  await expect.poll(() => watch.requests.length, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.evaluate(() => {
    document.getElementById('canary-control')?.remove();
    (window as unknown as { __fired: string[] }).__fired = [];
  });
  // Let the control's own loads end before the count starts again.
  await page.waitForTimeout(1500);
  await page.evaluate(() => {
    (window as unknown as { __fired: string[] }).__fired = [];
  });
  watch.requests.length = 0;
  // The control's own frames raise page errors (a cross-origin parent.alert); the count starts again.
  watch.errors.length = 0;
  return watch;
}

/** Dispatches a paste with the given parts; the component reads the clipboard data it is given. */
async function paste(page: Page, name: string, parts: { html?: string; text?: string }) {
  await page.evaluate(
    ({ name, parts }) => {
      const host = document.querySelector(`doc-editor[data-test="${name}"]`)!;
      const target = host.shadowRoot!.querySelector('.de-editing-surface') as HTMLElement;
      const dt = new DataTransfer();
      if (parts.html !== undefined) dt.setData('text/html', parts.html);
      if (parts.text !== undefined) dt.setData('text/plain', parts.text);
      target.dispatchEvent(
        new ClipboardEvent('paste', { bubbles: true, composed: true, clipboardData: dt }),
      );
    },
    { name, parts },
  );
}

/** The confirmed content of the element. */
async function stored(page: Page, name: string): Promise<Record<string, unknown>> {
  return page.evaluate(async (n) => {
    const el = document.querySelector(`doc-editor[data-test="${n}"]`) as unknown as {
      getContent(): Promise<Record<string, unknown>>;
    };
    return el.getContent();
  }, name);
}

/** Elements and attributes in the editor's shadow root that could run or load something. */
async function live(page: Page, name: string): Promise<string[]> {
  return page.evaluate((n) => {
    const root = document.querySelector(`doc-editor[data-test="${n}"]`)!.shadowRoot!;
    const found: string[] = [];
    for (const el of root.querySelectorAll('*')) {
      for (const a of el.attributes) {
        if (/^on/i.test(a.name)) found.push(`${el.localName}[${a.name}]`);
        if (
          /^(href|src|action|formaction|data|xlink:href|srcdoc)$/i.test(a.name) &&
          /^\s*(javascript|data|vbscript):/i.test(a.value)
        )
          found.push(`${el.localName}[${a.name}=${a.value.slice(0, 40)}]`);
      }
      if (
        /^(script|iframe|object|embed|math|frame|base|meta|link|form|video|audio)$/.test(
          el.localName,
        )
      )
        found.push(el.localName);
    }
    const surface = root.querySelector('.de-editing-surface');
    for (const el of surface?.querySelectorAll('svg, style') ?? [])
      found.push(`surface ${el.localName}`);
    for (const img of surface?.querySelectorAll('img') ?? [])
      if (!img.matches('.ProseMirror-separator') && !img.closest('.de-image'))
        found.push('surface img');
    return found;
  }, name);
}

/** Everything that must hold after a paste, whatever was pasted. */
async function expectInert(page: Page, name: string, watch: Watch, what: string): Promise<string> {
  // A script or a load would follow the paste at once; give it the time to.
  await page.waitForTimeout(300);
  expect(await fired(page), `${what}: no canary fired`).toEqual([]);
  expect(watch.requests, `${what}: no probe was asked for`).toEqual([]);
  expect(await live(page, name), `${what}: nothing that runs or loads is drawn`).toEqual([]);
  const content = await stored(page, name);
  const text = JSON.stringify(content);
  for (const trace of TRACES) expect(text.includes(trace), `${what}: stored ${trace}`).toBe(false);
  const checked = validate({
    cdm: content['cdm'],
    requires: content['requires'],
    doc: content['doc'],
  } as never);
  expect(checked.violations, `${what}: the stored content is valid CDM`).toEqual([]);
  expect(watch.errors, `${what}: no page error`).toEqual([]);
  return text;
}

const skipFirefox = (): void =>
  test.skip(
    test.info().project.name === 'firefox',
    'paste paths are run in Chromium and WebKit only',
  );

for (const sample of SAMPLES) {
  test(`SEC-005: hostile markup in a paste from ${sample.file} is cleaned away`, async ({
    page,
  }) => {
    skipFirefox();
    const watch = await open(page);
    const name = `sec-005-${sample.file.replace('.html', '')}`;
    await mountEditor(page, { sub: 'ada', role: 'editor', name });
    const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
    await surface.locator('p').last().click();
    await page.keyboard.press('End');
    const before = JSON.stringify(await stored(page, name));

    // The plain-text part says something else, so the text that shows tells which part was used.
    await paste(page, name, { html: poisoned(sample.file), text: 'PLAIN-TEXT-PART' });
    for (const text of sample.texts)
      await expect
        .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
        .toContain(text);
    expect(await surface.evaluate((el) => el.textContent ?? '')).not.toContain('PLAIN-TEXT-PART');
    // The paste is confirmed: the stored content has the sample's text and its structure.
    await expect
      .poll(async () => JSON.stringify(await stored(page, name)).includes(sample.texts[0]!), {
        timeout: 10_000,
      })
      .toBe(true);
    const after = await expectInert(page, name, watch, sample.file);
    expect(after).not.toBe(before);
    expect(sample.mapped(after), `${sample.file}: mapped to the model`).toBe(true);
    // What the hostile markup said is not text of the document either.
    for (const word of ['HOSTILE-SVG', 'HOSTILE-FORM', 'HOSTILE-ALT'])
      expect(after.includes(word), `${sample.file}: ${word}`).toBe(false);
  });
}

test('SEC-005: a pasted embedded fragment brings nothing the model does not know', async ({
  page,
}) => {
  skipFirefox();
  const watch = await open(page);
  const name = 'sec-005-fragment-paths';
  await mountEditor(page, { sub: 'ada', role: 'editor', name });
  const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
  await surface.locator('p').last().click();
  await page.keyboard.press('Home');
  await page.keyboard.press('Shift+End');
  // The copy the component makes (its own handler runs first, the listener reads the result).
  await page.evaluate(() => {
    document.addEventListener(
      'copy',
      (e) => {
        const cd = (e as ClipboardEvent).clipboardData;
        (window as unknown as { __copied?: string }).__copied = cd?.getData('text/html') ?? '';
      },
      { once: true },
    );
  });
  await page.keyboard.press('ControlOrMeta+C');
  const copied = await page.evaluate(() => (window as unknown as { __copied?: string }).__copied);
  const m = /data-docedit-fragment="([^"]*)"/.exec(copied ?? '');
  expect(m, 'the copy carries an embedded fragment').not.toBeNull();
  const original = decodeURIComponent(m![1]!);
  expect(original).toContain('Last paragraph.');
  await page.keyboard.press('End');

  type Node = { type?: string; text?: string; attrs?: unknown; marks?: unknown; content?: Node[] };
  /** The copied HTML with its fragment rewritten by `change`, which gets the fragment's JSON. */
  const rewritten = (change: (json: string) => string): string =>
    (copied ?? '').replace(m![1]!, encodeURIComponent(change(original)));
  const eachNode = (json: string, visit: (n: Node) => void): string => {
    const fragment = JSON.parse(json) as { content: Node[] };
    const walk = (n: Node): void => {
      visit(n);
      for (const c of n.content ?? []) walk(c);
    };
    for (const n of fragment.content) walk(n);
    return JSON.stringify(fragment);
  };
  const withText = (json: string, text: string): string =>
    eachNode(json, (n) => {
      if (n.type === 'text' && typeof n.text === 'string')
        n.text = n.text.replace(/Last paragraph\./g, text);
    });

  const cases: Array<{ what: string; html: string; marker: string }> = [
    {
      what: 'hostile markup around an untouched fragment',
      marker: 'FRAGMENT-AROUND',
      html: hostile() + rewritten((json) => withText(json, 'FRAGMENT-AROUND')) + hostile(),
    },
    {
      what: 'a javascript link mark in the fragment',
      marker: 'FRAGMENT-LINK',
      html: rewritten((json) =>
        eachNode(withText(json, 'FRAGMENT-LINK'), (n) => {
          if (n.type === 'text')
            n.marks = [{ type: 'link', attrs: { href: 'javascript:alert(1)', title: null } }];
        }),
      ),
    },
    {
      what: 'handler attributes on every node of the fragment',
      marker: 'FRAGMENT-ATTRS',
      html: rewritten((json) =>
        eachNode(withText(json, 'FRAGMENT-ATTRS'), (n) => {
          if (n.type !== 'text')
            n.attrs = {
              ...((n.attrs as Record<string, unknown> | undefined) ?? {}),
              onclick: 'alert(1)',
              style: 'background:url(javascript:alert(1))',
              src: 'data:text/html,<script>alert(1)</script>',
            };
        }),
      ),
    },
    {
      what: 'a prototype-chain attribute in the fragment',
      marker: 'FRAGMENT-PROTO',
      // Written into the JSON text: an object literal would set the prototype instead.
      html: rewritten((json) =>
        withText(json, 'FRAGMENT-PROTO').replace(
          /"type":"text"/,
          '"__proto__":{"polluted":true},"constructor":{"prototype":{"polluted":true}},"type":"text"',
        ),
      ),
    },
    {
      what: 'a node type the schema does not have',
      marker: 'FRAGMENT-UNKNOWN',
      html: rewritten((json) => {
        const fragment = JSON.parse(withText(json, 'FRAGMENT-UNKNOWN')) as { content: Node[] };
        fragment.content.push({
          type: 'script',
          attrs: { src: `/probe/${TOKEN}-fragment.js` },
          content: [{ type: 'text', text: 'window.__pwned = 1' }],
        });
        return JSON.stringify(fragment);
      }),
    },
  ];
  // One fragment that holds the whole corpus as its text.
  cases.push({
    what: 'the corpus as the text of the fragment',
    marker: 'FRAGMENT-CORPUS',
    html: rewritten((json) => withText(json, `FRAGMENT-CORPUS ${PAYLOADS.join(' ')}`)),
  });

  const outcomes: string[] = [];
  for (const c of cases) {
    const plain = `${c.marker}-PLAIN`;
    await paste(page, name, { html: c.html, text: plain });
    await page.waitForTimeout(400);
    expect(await fired(page), `${c.what}: no canary fired`).toEqual([]);
    expect(watch.requests, `${c.what}: no probe was asked for`).toEqual([]);
    expect(await live(page, name), `${c.what}: nothing that runs or loads is drawn`).toEqual([]);
    const content = await stored(page, name);
    const text = JSON.stringify(content);
    // The corpus is text here, so its own words may be stored, as text; every other case stores
    // no trace of what it carried.
    if (c.marker !== 'FRAGMENT-CORPUS')
      for (const trace of TRACES)
        expect(text.includes(trace), `${c.what}: stored ${trace}`).toBe(false);
    expect(text.includes('"type":"script"'), `${c.what}: no unknown node`).toBe(false);
    const checked = validate({
      cdm: content['cdm'],
      requires: content['requires'],
      doc: content['doc'],
    } as never);
    expect(checked.violations, `${c.what}: the stored content is valid CDM`).toEqual([]);
    const shown = await surface.evaluate((el) => el.textContent ?? '');
    outcomes.push(
      `${c.what}: ${
        shown.includes(plain)
          ? 'the plain text was pasted instead'
          : shown.includes(c.marker)
            ? 'the fragment was pasted without it'
            : 'nothing was pasted'
      }`,
    );
  }
  test.info().annotations.push({ type: 'fragment outcomes', description: outcomes.join('; ') });
  // The corpus as text is shown as text.
  const shown = await surface.evaluate((el) => el.textContent ?? '');
  for (const payload of PAYLOADS) expect(shown, payload).toContain(payload);
  expect(watch.errors).toEqual([]);
  // The editor still takes a paste.
  await paste(page, name, { text: ' STILL-WORKS' });
  await expect
    .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
    .toContain('STILL-WORKS');
});

test('SEC-005: every payload of the corpus pasted as plain text stays text', async ({ page }) => {
  skipFirefox();
  const watch = await open(page);
  const name = 'sec-005-plain-paths';
  await mountEditor(page, { sub: 'ada', role: 'editor', name });
  const surface = page.locator(`doc-editor[data-test="${name}"] .de-editing-surface`);
  await surface.locator('p').last().click();
  await page.keyboard.press('End');
  for (const [i, payload] of PAYLOADS.entries()) {
    await paste(page, name, { text: ` PLAIN-${i} ${payload}` });
    await expect
      .poll(() => surface.evaluate((el) => el.textContent ?? ''), { timeout: 10_000 })
      .toContain(`PLAIN-${i} ${payload}`);
    expect(await fired(page), `no canary fired for ${payload}`).toEqual([]);
    expect(await live(page, name), `nothing that runs or loads is drawn for ${payload}`).toEqual(
      [],
    );
  }
  // The payloads are stored as the text they are, in a valid document.
  await expect
    .poll(
      async () => JSON.stringify(await stored(page, name)).includes(`PLAIN-${PAYLOADS.length - 1}`),
      { timeout: 10_000 },
    )
    .toBe(true);
  const content = await stored(page, name);
  const checked = validate({
    cdm: content['cdm'],
    requires: content['requires'],
    doc: content['doc'],
  } as never);
  expect(checked.violations).toEqual([]);
  expect(watch.requests).toEqual([]);
  expect(watch.errors).toEqual([]);
});
