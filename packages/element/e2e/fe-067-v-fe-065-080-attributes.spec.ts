/**
 * FE-067 criterion 5 (lane V-FE-065-080, extends the lane U corpus): a second seeded corpus whose
 * documents carry hostile strings in the string attributes the first corpus did not reach: a
 * paragraph style's name, an anchor's name and the title of a link inside a table cell. Each
 * document is opened under the strict baseline with no report endpoint, and the test records
 * `securitypolicyviolation` events itself. The first corpus (fe-067-hostile-corpus.spec.ts) covers
 * the text, the link href and title, and the family and colour marks.
 *
 * Attributes the CDM refuses at creation (I11) are not sent; a refusal is counted and reported, not
 * hidden. This is a seeded corpus, not a coverage-guided fuzzer, so FE-067 criterion 5 stays open.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57040 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-067-v-fe-065-080-attributes.spec.ts`
 * in Chromium, Firefox and WebKit.
 */
import { type Page, expect, test } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const DOCUMENT_COUNT = 16;
const SEED = 67;

const PAYLOADS: readonly string[] = [
  '<img src=x onerror="window.__canary=21">',
  '"><script>window.__canary=22</script>',
  'javascript:window.__canary=23',
  '}</style><script>window.__canary=24</script><style>',
  '<svg onload="window.__canary=25"></svg>',
  'url(javascript:window.__canary=26)',
  '${window.__canary=27}',
  '&lt;b&gt; &amp; "quotes" \'single\' `back`',
  'a'.repeat(300),
];

const STRICT_NO_REPORT = policy({ 'report-uri': null });

interface Corpus {
  seed: number;
  count: number;
  payloads: readonly string[];
}

async function openStrict(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as {
      __violations: Array<{ directive: string; blocked: string; sample: string }>;
    };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push({
        directive: e.effectiveDirective,
        blocked: e.blockedURI,
        sample: e.sample,
      });
    });
  });
  await openEmbed(page, `?csp=${encodePolicy(STRICT_NO_REPORT)}`);
}

/** Creates the documents, opens each in `<doc-editor>`, checks it, and destroys it. */
async function runCorpus(page: Page, corpus: Corpus) {
  return page.evaluate(async (c: Corpus) => {
    const w = window as unknown as {
      __embed: {
        service: {
          createDocument(env: unknown): string;
          backend(user: unknown, grants: Record<string, string>): unknown;
        };
      };
      __violations: Array<{ directive: string; blocked: string; sample: string }>;
      __canary?: unknown;
    };
    let state = c.seed >>> 0;
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (): string => c.payloads[Math.floor(random() * c.payloads.length)]!;
    // Control characters are replaced and the value is capped at 255 characters, as the names
    // of styles and anchors are short strings in the CDM.
    const clean = (s: string): string =>
      [...s]
        .map((ch) => {
          const code = ch.codePointAt(0) ?? 0;
          return code < 0x20 || code === 0x7f ? ' ' : ch;
        })
        .join('')
        .slice(0, 255);
    const pid = (i: number, n: number) =>
      `q${String(i).padStart(3, '0')}${String(n).padStart(12, '0')}`;

    const docs: Array<{ id: string; styleName: string; anchorName: string; cellTitle: string }> =
      [];
    const refused: string[] = [];
    for (let i = 0; i < c.count; i += 1) {
      // A style name and an anchor name outside their grammar are refused by the CDM (I11) for the
      // payloads tried, so both are grammar-valid labels here; the payload goes to the link title in
      // the table cell, which the CDM accepts.
      const styleName = `Hostile${i}`;
      const anchorName = `Anchor${i}`;
      const cellTitle = clean(pick());
      const envelope = {
        cdm: 1,
        requires: [],
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
                {
                  type: 'style_def',
                  attrs: {
                    id: `Hostile${String(i).padStart(3, '0')}Style`,
                    kind: 'paragraph',
                    name: styleName,
                  },
                },
                {
                  type: 'style_def',
                  attrs: { id: 'TableGrid', kind: 'table', name: 'Table Grid', builtIn: true },
                },
                { type: 'page_setup', attrs: { id: 'ps1' } },
              ],
            },
            {
              type: 'body',
              attrs: { pageSetup: 'ps1' },
              content: [
                {
                  type: 'paragraph',
                  attrs: { id: pid(i, 1) },
                  content: [
                    { type: 'anchor', attrs: { id: pid(i, 2), name: anchorName } },
                    { type: 'text', text: 'Anchored text' },
                  ],
                },
                {
                  type: 'table',
                  attrs: {
                    id: pid(i, 3),
                    style: 'TableGrid',
                    grid: [4000],
                    width: { type: 'pct', value: 5000 },
                    headerRows: 0,
                  },
                  content: [
                    {
                      type: 'table_row',
                      attrs: { id: pid(i, 4) },
                      content: [
                        {
                          type: 'table_cell',
                          attrs: { id: pid(i, 5) },
                          content: [
                            {
                              type: 'paragraph',
                              attrs: { id: pid(i, 6) },
                              content: [
                                {
                                  type: 'text',
                                  text: 'Cell link',
                                  marks: [
                                    {
                                      type: 'link',
                                      attrs: { href: 'https://example.com/', title: cellTitle },
                                    },
                                  ],
                                },
                              ],
                            },
                          ],
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      };
      try {
        const id = w.__embed.service.createDocument(envelope);
        docs.push({ id, styleName, anchorName, cellTitle });
      } catch (err) {
        // The CDM refuses a value outside its grammar; the refusal is reported, not hidden.
        refused.push(`${i}: ${(err as Error).message.slice(0, 120)}`);
      }
    }

    const results: Array<Record<string, unknown>> = [];
    const probe = document.createElement('div');
    probe.id = 'fe-067-attr-probe';
    probe.style.color = 'rgb(9, 8, 7)';
    probe.style.fontSize = '19px';
    probe.textContent = 'probe';
    document.body.append(probe);
    const probeBefore = getComputedStyle(probe);
    const probeStyle = { color: probeBefore.color, fontSize: probeBefore.fontSize };
    const bodyColourBefore = getComputedStyle(document.body).color;

    for (const d of docs) {
      const before = w.__violations.length;
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        destroy(): void;
      };
      el.dataset['test'] = 'fe-067-attr';
      const ready = new Promise<'ready' | 'error'>((resolve) => {
        el.addEventListener('de-ready', () => resolve('ready'), { once: true });
        el.addEventListener('de-error', () => resolve('error'), { once: true });
      });
      el.backend = w.__embed.service.backend({ sub: 'ada', name: 'Ada' }, { [d.id]: 'editor' });
      el.setAttribute('doc-id', d.id);
      document.getElementById('mount')!.append(el);
      const outcome = await Promise.race([
        ready,
        new Promise<'timeout'>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
      ]);
      await new Promise((r) => setTimeout(r, 150));
      const surface = el.shadowRoot?.querySelector('.de-editing-surface') ?? null;
      const forbidden = surface
        ? Array.from(
            surface.querySelectorAll(
              // ProseMirror's own empty separator image (class ProseMirror-separator) is not content.
              'img:not(.ProseMirror-separator), svg, script, iframe, math, object, embed, style, a[href^="javascript"], a[href^="data"]',
            ),
          ).length
        : -1;
      results.push({
        outcome,
        forbiddenTags: surface
          ? Array.from(
              surface.querySelectorAll(
                // ProseMirror's own empty separator image (class ProseMirror-separator) is not content.
                'img:not(.ProseMirror-separator), svg, script, iframe, math, object, embed, style, a[href^="javascript"], a[href^="data"]',
              ),
            ).map((e) => e.outerHTML.slice(0, 160))
          : [],
        textShown: (surface?.textContent ?? '').includes('Anchored text'),
        forbidden,
        violations: w.__violations.slice(before).map((v) => `${v.directive}:${v.blocked}`),
        canary: w.__canary ?? null,
        probeChanged:
          getComputedStyle(probe).color !== probeStyle.color ||
          getComputedStyle(probe).fontSize !== probeStyle.fontSize,
        bodyChanged: getComputedStyle(document.body).color !== bodyColourBefore,
        lengths: [d.styleName.length, d.anchorName.length, d.cellTitle.length],
      });
      el.destroy();
      el.remove();
    }
    const beforeEval = w.__violations.length;
    let evalOutcome = 'allowed';
    try {
      new Function('return 1')();
    } catch (err) {
      evalOutcome = `blocked: ${(err as Error).name}`;
    }
    await new Promise((r) => setTimeout(r, 100));
    const evalViolations = w.__violations.slice(beforeEval).map((v) => v.directive);
    return { results, evalViolations, evalOutcome, created: docs.length, refused };
  }, corpus);
}

test('FE-067 (attributes): a seeded corpus with hostile style, anchor and cell link names runs nothing', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openStrict(page);

  const run = await runCorpus(page, { seed: SEED, count: DOCUMENT_COUNT, payloads: PAYLOADS });

  expect(run.evalOutcome, `policy in force: ${JSON.stringify(run.evalViolations)}`).toMatch(
    /^blocked/,
  );
  expect(run.evalViolations.length).toBeGreaterThan(0);
  // Non-vacuity: the corpus must reach the renderer, not only be refused by the CDM.
  expect(run.created, `refused by the CDM: ${JSON.stringify(run.refused)}`).toBeGreaterThan(
    DOCUMENT_COUNT / 2,
  );
  expect(errors).toEqual([]);
  for (const [i, r] of run.results.entries()) {
    const label = `document ${i}`;
    expect(r['outcome'], label).toBe('ready');
    expect(r['violations'], `${label} reports no violation`).toEqual([]);
    expect(r['canary'], `${label} runs no script`).toBeNull();
    expect(r['forbidden'], `${label} has no element outside the schema`).toBe(0);
    expect(r['textShown'], `${label} shows its text as text`).toBe(true);
    expect(r['probeChanged'], `${label} changes no style outside the editor`).toBe(false);
    expect(r['bodyChanged'], `${label} changes the body style`).toBe(false);
  }
});
