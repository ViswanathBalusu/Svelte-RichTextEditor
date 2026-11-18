/**
 * FE-067 criterion 5 (lane w1): documents with hostile strings in every attribute the CDM accepts,
 * opened under the strict policy, run no script, report no violation, draw no element outside the
 * schema and change no style outside the editor.
 *
 * The documents are built from the model's kitchen-sink fixture, which holds every node and mark of
 * the schema. For each string attribute of each node and mark, and for each text, a payload replaces
 * the value, and the change is kept only when `validate` from `@docedit/model` still accepts the
 * document. What the validator refuses (a grammar, a reference, a length) is a value the editor can
 * never be given, so it is counted and not opened. One document is built for each payload (every
 * accepted attribute holds that payload) and for each of SEEDS seeded assignments of payloads to
 * attributes (mulberry32), so a failure can be replayed.
 *
 * Run from the repository root with
 * `DOCEDIT_DEMO_PORT=57067 pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/fe-067-every-attribute.spec.ts`
 * in Chromium, Firefox and WebKit. The page is the embedding demo, served under the strict baseline of
 * s2-helpers.ts (no unsafe keyword, no report endpoint). This is a seeded corpus, not a
 * coverage-guided fuzzer.
 */
import { readFileSync } from 'node:fs';
import { validate } from '@docedit/model/validate';
import { type Page, expect, test } from '@playwright/test';
import { encodePolicy } from './helpers.ts';
import { policy } from './s2-helpers.ts';
import { openEmbed } from './embed-helpers.ts';

const SEEDS = [67, 6701, 6702, 6703];

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
  '‮RTL override  end',
  '<iframe src="javascript:window.__canary=9"></iframe>',
  '<math><mi xlink:href="javascript:window.__canary=10">x</mi></math>',
  '&lt;b&gt; &amp; "quotes" \'single\' `back`',
  '${window.__canary=11}',
  '<meta http-equiv="refresh" content="0;url=https://example.invalid/">',
  'a'.repeat(300),
];

type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
interface CdmNode {
  type?: string;
  text?: string;
  attrs?: Record<string, Json>;
  marks?: Array<{ type: string; attrs?: Record<string, Json> }>;
  content?: CdmNode[];
}

/** Every place a string can be replaced: a node's attribute, a mark's attribute, or a text. */
interface Slot {
  describe: string;
  get(): string;
  set(value: string): void;
}

function slotsOf(root: CdmNode): Slot[] {
  const slots: Slot[] = [];
  const visit = (node: CdmNode, path: string): void => {
    const name = `${path}/${node.type ?? '?'}`;
    for (const [key, value] of Object.entries(node.attrs ?? {}))
      if (typeof value === 'string')
        slots.push({
          describe: `${name}@${key}`,
          get: () => node.attrs![key] as string,
          set: (v) => void (node.attrs![key] = v),
        });
    for (const mark of node.marks ?? [])
      for (const [key, value] of Object.entries(mark.attrs ?? {}))
        if (typeof value === 'string')
          slots.push({
            describe: `${name}/mark:${mark.type}@${key}`,
            get: () => mark.attrs![key] as string,
            set: (v) => void (mark.attrs![key] = v),
          });
    if (typeof node.text === 'string' && node.text !== '')
      slots.push({
        describe: `${name}#text`,
        get: () => node.text as string,
        set: (v) => void (node.text = v),
      });
    for (const child of node.content ?? []) visit(child, name);
  };
  visit(root, '');
  return slots;
}

function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const sink = JSON.parse(
  readFileSync(new URL('../../model/fixtures/kitchen-sink.json', import.meta.url), 'utf8'),
) as { doc: CdmNode } & Record<string, Json>;

interface Built {
  label: string;
  envelope: unknown;
  accepted: number;
  refused: string[];
}

/** One document: each slot takes `payloadFor(index)` when the validator still accepts the document. */
function build(label: string, payloadFor: (index: number) => string): Built {
  const envelope = structuredClone(sink);
  const slots = slotsOf(envelope.doc);
  let accepted = 0;
  const refused: string[] = [];
  for (const [index, slot] of slots.entries()) {
    const before = slot.get();
    slot.set(payloadFor(index));
    if (validate(envelope).valid) accepted += 1;
    else {
      slot.set(before);
      refused.push(slot.describe);
    }
  }
  return { label, envelope, accepted, refused };
}

const built: Built[] = [
  ...PAYLOADS.map((payload, i) => build(`payload ${i}`, () => payload)),
  ...SEEDS.map((seed) => {
    const random = mulberry32(seed);
    return build(`seed ${seed}`, () => PAYLOADS[Math.floor(random() * PAYLOADS.length)]!);
  }),
];

const STRICT_NO_REPORT = policy({ 'report-uri': null });

async function openStrict(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as unknown as { __violations: string[] };
    w.__violations = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      w.__violations.push(`${e.effectiveDirective}:${e.blockedURI}`);
    });
  });
  await openEmbed(page, `?csp=${encodePolicy(STRICT_NO_REPORT)}`);
}

async function open(page: Page, envelope: unknown) {
  return page.evaluate(async (env: unknown) => {
    const w = window as unknown as {
      __embed: {
        service: {
          createDocument(env: unknown): string;
          backend(user: unknown, grants: Record<string, string>): unknown;
        };
      };
      __violations: string[];
      __canary?: unknown;
    };
    const probe = document.createElement('div');
    probe.style.color = 'rgb(1, 2, 3)';
    probe.style.fontSize = '17px';
    probe.style.fontFamily = 'serif';
    probe.textContent = 'probe';
    document.body.append(probe);
    const look = () => {
      const s = getComputedStyle(probe);
      return `${s.color}|${s.fontSize}|${s.fontFamily}|${getComputedStyle(document.body).color}`;
    };
    const before = look();
    const mark = w.__violations.length;
    const id = w.__embed.service.createDocument(env);
    const el = document.createElement('doc-editor') as HTMLElement & {
      backend: unknown;
      destroy(): void;
    };
    const ready = new Promise<string>((resolve) => {
      el.addEventListener('de-ready', () => resolve('ready'), { once: true });
      el.addEventListener(
        'de-error',
        (e) => resolve(`error ${JSON.stringify((e as CustomEvent).detail)}`),
        { once: true },
      );
    });
    el.backend = w.__embed.service.backend({ sub: 'ada', name: 'Ada' }, { [id]: 'editor' });
    el.setAttribute('doc-id', id);
    document.getElementById('mount')!.append(el);
    const outcome = await Promise.race([
      ready,
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 15_000)),
    ]);
    await new Promise((r) => setTimeout(r, 250));
    const surface = el.shadowRoot?.querySelector('.de-editing-surface') ?? null;
    const forbidden = surface
      ? surface.querySelectorAll(
          'svg, script, iframe, math, object, embed, style, a[href^="javascript"], a[href^="data"]',
        ).length
      : -1;
    // A picture is allowed only inside the image placeholder, and only from an http(s) URL.
    const pictures = surface
      ? Array.from(surface.querySelectorAll('img')).filter(
          (img) => !img.matches('.ProseMirror-separator'),
        )
      : [];
    const badPictures = pictures.filter(
      (img) => !img.closest('.de-image') || !/^https?:/.test(img.getAttribute('src') ?? ''),
    ).length;
    const result = {
      outcome,
      surface: surface !== null,
      forbidden,
      badPictures,
      violations: w.__violations.slice(mark),
      canary: w.__canary ?? null,
      probeChanged: look() !== before,
    };
    el.destroy();
    el.remove();
    probe.remove();
    // The policy is in force: an eval the page attempts is refused (as in fe-067-hostile-corpus.spec.ts).
    let evalOutcome = 'allowed';
    try {
      new Function('return 1')();
    } catch (err) {
      evalOutcome = `blocked: ${(err as Error).name}`;
    }
    return { ...result, evalOutcome };
  }, envelope);
}

test('FE-067: hostile strings in every attribute the CDM accepts run nothing and change no outside style', async ({
  page,
}, testInfo) => {
  const errors: string[] = [];
  page.on('pageerror', (e) => errors.push(e.message));
  await openStrict(page);

  // Non-vacuity: the corpus reaches many attributes, and the policy is in force.
  const slotCount = slotsOf(sink.doc).length;
  expect(slotCount).toBeGreaterThan(50);
  const accepted = Math.min(...built.map((b) => b.accepted));
  expect(accepted).toBeGreaterThan(20);

  const refused = [...new Set(built.flatMap((b) => b.refused))];
  testInfo.annotations.push({
    type: 'corpus',
    description: `${built.length} documents, ${slotCount} slots, at least ${accepted} accepted per document, ${refused.length} refused by the validator for some payload`,
  });

  for (const b of built) {
    const r = await open(page, b.envelope);
    expect(r.evalOutcome, `${b.label}: the policy is in force`).toMatch(/^blocked/);
    expect(r.outcome, `${b.label}: opens`).toBe('ready');
    expect(r.surface, `${b.label}: has a surface`).toBe(true);
    expect(r.violations, `${b.label}: reports no violation`).toEqual([]);
    expect(r.canary, `${b.label}: runs no script`).toBeNull();
    expect(r.forbidden, `${b.label}: no element outside the schema`).toBe(0);
    expect(
      r.badPictures,
      `${b.label}: no picture outside the placeholder or from a non-http URL`,
    ).toBe(0);
    expect(r.probeChanged, `${b.label}: changes no style outside the editor`).toBe(false);
  }
  expect(errors).toEqual([]);
});
