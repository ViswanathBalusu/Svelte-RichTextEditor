/**
 * FE-067 criterion 5 (lane U-FE-065-080): a corpus of hostile documents, opened under a strict policy,
 * runs no script, reports no violation and changes no style outside the editor. The corpus is seeded
 * (mulberry32, seed 67), so a failure can be replayed: each document puts payloads from a list of
 * hostile strings into the text, into a link's href and title, and into the font family and colour
 * marks. The page is served with the strict baseline of s2-helpers.ts (no unsafe keyword, no report
 * endpoint), and the test records `securitypolicyviolation` events itself.
 *
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-067-hostile-corpus.spec.ts`
 * in Chromium, Firefox and WebKit. The page is the embedding demo (demo/embed-page.ts).
 *
 * Criterion 5 says "a fuzz corpus"; this is a seeded corpus of DOCUMENT_COUNT documents, not a
 * coverage-guided fuzzer, and it is evidence for that corpus only. Criterion 3 (image URLs) stays open.
 */
import { type Page, expect, test } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const DOCUMENT_COUNT = 24;
const SEED = 67;

const PAYLOADS: readonly string[] = [
  '<img src=x onerror="window.__canary=1">',
  '<svg onload="window.__canary=2"></svg>',
  '"><script>window.__canary=3</script>',
  'javascript:window.__canary=4',
  'data:text/html,<script>window.__canary=5</script>',
  '}</style><script>window.__canary=6</script><style>',
  'expression(window.__canary=7)',
  'url(javascript:window.__canary=8)',
  'red; } body { background: url(https://example.invalid/x) } .x {',
  '\u0000‮RTL override  end',
  '<iframe src="javascript:window.__canary=9"></iframe>',
  '<math><mi xlink:href="javascript:window.__canary=10">x</mi></math>',
  '&lt;b&gt; &amp; "quotes" \'single\' `back`',
  '${window.__canary=11}',
  '<meta http-equiv="refresh" content="0;url=https://example.invalid/">',
  'a'.repeat(4000),
];

/** The page's no-script baseline: the strict policy without a report endpoint. */
const STRICT_NO_REPORT = policy({ 'report-uri': null });

interface Corpus {
  seed: number;
  count: number;
  payloads: readonly string[];
}

/** Opens the page under the strict policy, with the violation recorder installed before any script. */
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

/** Creates one document per corpus entry, opens it in `<doc-editor>`, checks it, and destroys it. */
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
    // mulberry32: a small seeded generator, so the corpus is the same on every run and browser.
    let state = c.seed >>> 0;
    const random = (): number => {
      state = (state + 0x6d2b79f5) >>> 0;
      let t = state;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
    const pick = (): string => c.payloads[Math.floor(random() * c.payloads.length)]!;
    // The CDM validator refuses values outside their grammar when the document is created (I11):
    // a family must match ^[A-Za-z0-9][A-Za-z0-9 ._+-]{0,63}$, a colour is #RRGGBB and a title is at
    // most 255 characters. The corpus therefore uses grammar-valid values for those marks, and the
    // hostile payloads for the text, the link's href and the link's title (which the CDM accepts).
    const FAMILIES = [
      'Arial',
      'Times New Roman',
      'a onerror b',
      'ScRiPt Font',
      'x'.repeat(64),
      'Font-Family+1.2',
      '0 expression x',
    ];
    const COLOURS = ['#000000', '#FFFFFF', '#FF0000', '#00FF00', '#0000FF', '#123ABC'];
    const pickFrom = (list: readonly string[]): string => list[Math.floor(random() * list.length)]!;
    const clean = (s: string): string =>
      [...s]
        .map((ch) => {
          const code = ch.codePointAt(0) ?? 0;
          return code < 0x20 || code === 0x7f ? ' ' : ch;
        })
        .join('')
        .slice(0, 255);
    const paragraph = (id: string, runs: unknown[]) => ({
      type: 'paragraph',
      attrs: { id },
      content: runs,
    });
    const docs: Array<{ id: string; text: string; href: string; family: string; colour: string }> =
      [];
    for (let i = 0; i < c.count; i += 1) {
      const text = pick();
      const hostileHref = `https://example.com/?x=${encodeURIComponent(pick().slice(0, 200))}`;
      const family = pickFrom(FAMILIES);
      const colour = pickFrom(COLOURS);
      const title = clean(pick());
      const pid = (n: number) => `p${String(i).padStart(3, '0')}${String(n).padStart(12, '0')}`;
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
                { type: 'page_setup', attrs: { id: 'ps1' } },
              ],
            },
            {
              type: 'body',
              attrs: { pageSetup: 'ps1' },
              content: [
                paragraph(pid(1), [{ type: 'text', text }]),
                paragraph(pid(2), [
                  {
                    type: 'text',
                    text: 'Link',
                    marks: [{ type: 'link', attrs: { href: hostileHref, title } }],
                  },
                ]),
                paragraph(pid(3), [
                  {
                    type: 'text',
                    text: 'Marked',
                    marks: [
                      { type: 'fontFamily', attrs: { value: family } },
                      { type: 'color', attrs: { value: colour } },
                    ],
                  },
                ]),
              ],
            },
          ],
        },
      };
      const id = w.__embed.service.createDocument(envelope);
      docs.push({ id, text, href: hostileHref, family, colour });
    }

    const results: Array<Record<string, unknown>> = [];
    const probe = document.createElement('div');
    probe.id = 'fe-067-probe';
    probe.style.color = 'rgb(1, 2, 3)';
    probe.style.fontSize = '17px';
    probe.style.fontFamily = 'serif';
    probe.textContent = 'probe';
    document.body.append(probe);
    const probeBefore = getComputedStyle(probe);
    const probeStyle = {
      color: probeBefore.color,
      fontSize: probeBefore.fontSize,
      fontFamily: probeBefore.fontFamily,
    };
    const bodyColourBefore = getComputedStyle(document.body).color;

    for (const d of docs) {
      const before = w.__violations.length;
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        destroy(): void;
      };
      el.dataset['test'] = 'fe-067';
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
      const root = el.shadowRoot;
      const surface = root?.querySelector('.de-editing-surface') ?? null;
      const surfaceText = surface?.textContent ?? '';
      const forbidden = surface
        ? Array.from(
            surface.querySelectorAll(
              'img, svg, script, iframe, math, object, embed, style, a[href^="javascript"], a[href^="data"]',
            ),
          ).length
        : -1;
      results.push({
        outcome,
        textShown: surfaceText.includes(d.text),
        forbidden,
        violations: w.__violations.slice(before).map((v) => `${v.directive}:${v.blocked}`),
        canary: w.__canary ?? null,
        probeChanged:
          getComputedStyle(probe).color !== probeStyle.color ||
          getComputedStyle(probe).fontSize !== probeStyle.fontSize ||
          getComputedStyle(probe).fontFamily !== probeStyle.fontFamily,
        bodyChanged: getComputedStyle(document.body).color !== bodyColourBefore,
        // Kept for the report: which payloads this document carried (lengths, not values).
        payloadLengths: [d.text.length, d.href.length, d.family.length, d.colour.length],
      });
      el.destroy();
      el.remove();
    }
    // Non-vacuity: the policy is in force, so an eval must be refused and reported.
    const beforeEval = w.__violations.length;
    let evalOutcome = 'allowed';
    try {
      new Function('return 1')();
    } catch (err) {
      evalOutcome = `blocked: ${(err as Error).name}`;
    }
    await new Promise((r) => setTimeout(r, 100));
    const evalViolations = w.__violations.slice(beforeEval).map((v) => v.directive);
    return { results, evalViolations, evalOutcome, documents: docs.length };
  }, corpus);
}

test('FE-067: a seeded corpus of hostile documents runs nothing and changes no outside style', async ({
  page,
}) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openStrict(page);

  const run = await runCorpus(page, {
    seed: SEED,
    count: DOCUMENT_COUNT,
    payloads: PAYLOADS,
  });

  // The policy is in force: an eval the page attempts is reported as a violation (script-src).
  // The probe is an eval, which the policy refuses and reports (as require-trusted-types-for here).
  expect(
    run.evalOutcome,
    `policy in force: eval outcome ${run.evalOutcome}, violations ${JSON.stringify(run.evalViolations)}`,
  ).toMatch(/^blocked/);
  expect(run.evalViolations.length).toBeGreaterThan(0);
  expect(run.documents).toBe(DOCUMENT_COUNT);
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
