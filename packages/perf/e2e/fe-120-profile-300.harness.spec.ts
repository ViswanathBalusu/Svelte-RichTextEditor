/**
 * FE-120 criteria 2, 4 and 5 (lane V-FE-113-128): the 300-page corpus document in the web view is
 * profiled while it is typed in and scrolled. The CPU profile (Chromium's sampling profiler, through
 * the DevTools protocol) gives the share of sampled time per function, and the functions of table
 * layout and node views are listed with their share. Figures from this run are on this machine,
 * not the reference machine of ADR 0037; they are recorded with that fact, and nothing is judged
 * against a target here.
 *
 * Output: packages/perf/test-results/fe-120-profile-300.json.
 *
 * Run: DOCEDIT_PERF_PORT=57071 pnpm exec playwright test -c packages/perf/playwright.config.ts \
 *   fe-120-profile-300 --project=reference
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { writeJson } from './helpers.ts';

interface CpuProfile {
  nodes: {
    id: number;
    callFrame: { functionName: string; url: string; lineNumber: number };
  }[];
  samples: number[];
  timeDeltas: number[];
  startTime: number;
  endTime: number;
}

interface Spot {
  function: string;
  url: string;
  line: number;
  ms: number;
  share: number;
  /** The most expensive caller chain of this function, innermost first. */
  stack: string;
}

// The reference project records a trace (retain-on-failure), and the trace's DOM snapshotter runs
// inside the page while it is measured (its functions dominated the first profile of this file).
// This file turns tracing off, so that the profile is of the page alone.
test.use({ trace: 'off' });

const TYPING_KEYS = 60;
const TEXT = 'the quick brown fox jumps over the lazy dog while the editor keeps up ';
const TABLE = /table|cell|row(?![a-z])/i;
const NODE_VIEW = /nodeview|node-view|node_view|nodeview/i;

/** Self time per function: the time of each sample is the delta to the next sample. */
function selfTime(profile: CpuProfile): { spots: Spot[]; totalMs: number } {
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const parent = new Map<number, number>();
  for (const n of profile.nodes as (CpuProfile['nodes'][number] & { children?: number[] })[])
    for (const c of n.children ?? []) parent.set(c, n.id);
  // The caller chain of a node, innermost first, at most eight frames.
  const stackOf = (id: number): string => {
    const names: string[] = [];
    let cur: number | undefined = id;
    while (cur !== undefined && names.length < 60) {
      const f = byId.get(cur)?.callFrame;
      const label = f?.functionName ? `${f.functionName}@${f.url.split('/').pop() ?? ''}` : '';
      // Recursion (the same frame again and again) is written once.
      if (label && names[names.length - 1] !== label) names.push(label);
      cur = parent.get(cur);
    }
    return names.join(' < ');
  };
  const agg = new Map<string, Spot & { stacks: Map<string, number> }>();
  let total = 0;
  profile.samples.forEach((id, i) => {
    const node = byId.get(id);
    if (!node) return;
    const ms = (profile.timeDeltas[i + 1] ?? 0) / 1000;
    total += ms;
    const { functionName, url, lineNumber } = node.callFrame;
    const key = `${functionName}|${url}|${lineNumber}`;
    const spot: Spot & { stacks: Map<string, number> } = agg.get(key) ?? {
      function: functionName || '(anonymous)',
      url,
      line: lineNumber + 1,
      ms: 0,
      share: 0,
      stack: '',
      stacks: new Map<string, number>(),
    };
    spot.ms += ms;
    const stack = stackOf(id);
    spot.stacks.set(stack, (spot.stacks.get(stack) ?? 0) + ms);
    agg.set(key, spot);
  });
  const spots: Spot[] = [...agg.values()]
    .map(({ stacks, ...s }) => {
      // The most expensive caller chain of this function, for the dominant-cause note.
      const top = [...stacks.entries()].sort((a, b) => b[1] - a[1])[0];
      return {
        ...s,
        ms: Math.round(s.ms * 10) / 10,
        share: s.ms / Math.max(total, 1e-9),
        stack: top?.[0] ?? '',
      };
    })
    .sort((a, b) => b.ms - a.ms);
  return { spots, totalMs: Math.round(total * 10) / 10 };
}

/** The share of sampled time whose function or script matches a pattern. */
function share(spots: Spot[], total: number, re: RegExp): { ms: number; share: number } {
  const ms = spots
    .filter((s) => re.test(s.function) || re.test(s.url))
    .reduce((sum, s) => sum + s.ms, 0);
  return { ms: Math.round(ms * 10) / 10, share: total > 0 ? ms / total : 0 };
}

async function profile(cdp: CDPSession, work: () => Promise<void>): Promise<CpuProfile> {
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 1000 });
  await cdp.send('Profiler.start');
  await work();
  const { profile: p } = (await cdp.send('Profiler.stop')) as { profile: CpuProfile };
  return p;
}

async function typeInMiddle(page: Page): Promise<void> {
  const paragraphs = page.locator('doc-editor .de-editing-surface .de-body > p');
  const count = await paragraphs.count();
  const target = paragraphs.nth(Math.floor(count / 2));
  await target.scrollIntoViewIfNeeded();
  await target.click();
  await page.keyboard.press('End');
  for (let i = 0; i < TYPING_KEYS; i++) {
    const ch = TEXT[i % TEXT.length]!;
    await page.keyboard.press(ch === ' ' ? 'Space' : ch);
    await page.waitForTimeout(80);
  }
  await page.waitForTimeout(500);
}

async function scrollDocument(page: Page): Promise<void> {
  await page.mouse.move(550, 400);
  for (let i = 0; i < 60; i++) {
    await page.mouse.wheel(0, 300);
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(500);
}

test('the 300-page document is profiled while typed in and scrolled', async ({ browser }) => {
  test.setTimeout(900_000);
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  // backend=hold: the in-page mock backend never answers a commit, so the profile holds the editing
  // path without the backend's own validation (its share is reported on its own below).
  await page.goto('/pages/editor.html?doc=pages-300&backend=hold');
  await page.waitForFunction(
    () => {
      const p = (globalThis as unknown as { __perf: { readyAt?: number; error?: string } }).__perf;
      return p.readyAt !== undefined || p.error !== undefined;
    },
    undefined,
    { timeout: 600_000, polling: 250 },
  );
  const error = await page.evaluate(
    () => (globalThis as unknown as { __perf: { error?: string } }).__perf.error ?? null,
  );
  expect(error).toBeNull();
  await page.waitForTimeout(3_000);

  const typingProfile = await profile(cdp, () => typeInMiddle(page));
  const scrollProfile = await profile(cdp, () => scrollDocument(page));
  await context.close();

  const typing = selfTime(typingProfile);
  const scroll = selfTime(scrollProfile);
  const categories = (s: ReturnType<typeof selfTime>) => ({
    tableLayout: share(s.spots, s.totalMs, TABLE),
    nodeViews: share(s.spots, s.totalMs, NODE_VIEW),
    layout: share(s.spots, s.totalMs, /layout/i),
    paint: share(s.spots, s.totalMs, /paint|draw|render/i),
    // Functions whose most expensive caller chain runs through the in-page backend's commit path.
    backendCommit: {
      ms:
        Math.round(
          s.spots.filter((x) => /submit@/.test(x.stack)).reduce((sum, x) => sum + x.ms, 0) * 10,
        ) / 10,
      share:
        s.totalMs > 0
          ? s.spots.filter((x) => /submit@/.test(x.stack)).reduce((sum, x) => sum + x.ms, 0) /
            s.totalMs
          : 0,
    },
  });

  writeJson('fe-120-profile-300.json', {
    story: 'FE-120',
    lane: 'V-FE-113-128',
    document: 'pages-300',
    browser:
      'chromium (Playwright channel chromium, reference project; this machine, not the reference machine)',
    typing: {
      keys: TYPING_KEYS,
      sampledMs: typing.totalMs,
      categories: categories(typing),
      top: typing.spots.slice(0, 15),
    },
    scrolling: {
      wheelSteps: 60,
      sampledMs: scroll.totalMs,
      categories: categories(scroll),
      top: scroll.spots.slice(0, 15),
    },
  });

  expect(typing.totalMs).toBeGreaterThan(0);
  expect(scroll.totalMs).toBeGreaterThan(0);
});
