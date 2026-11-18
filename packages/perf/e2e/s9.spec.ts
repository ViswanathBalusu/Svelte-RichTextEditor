/**
 * Spike S9 (SPK-022): the input-bridge prototype (src/browser/s9-page.ts) in Chromium, Edge,
 * Firefox and WebKit.
 *
 * What this can show: typing and composition reach the document through the bridge and are painted;
 * the bridge's caret sits on the painted caret (the position an input-method window follows);
 * movement and clicks come from the layout tree; EditContext's support and events; what
 * `window.find` reports on the painted pages. What it cannot show: an operating-system input-method
 * window on the screen, a screen reader, or the browser's find bar. S9's report §7 lists them as
 * not run.
 *
 * Results: test-results/s9/<project>.json (one file per project, written at the end).
 */
import { expect, test, type CDPSession, type Page } from '@playwright/test';
import { machineInfo, writeJson } from './helpers.ts';

interface Geometry {
  painted: { left: number; top: number; height: number } | null;
  bridgeCaret: { left: number; top: number; height: number };
  bridgeRect: { left: number; top: number; width: number; height: number };
  page: number;
}

/** The page's test handle. */
const s9 = <T>(page: Page, call: string, ...args: unknown[]): Promise<T> =>
  page.evaluate(
    ([c, a]) => {
      const api = (window as unknown as { __s9: Record<string, (...x: unknown[]) => unknown> })
        .__s9;
      return api[c as string]!(...(a as unknown[]));
    },
    [call, args] as const,
  ) as Promise<T>;

const results: Record<string, unknown> = {};

async function open(page: Page, query = ''): Promise<void> {
  await page.goto(`/pages/s9.html${query}`);
  await page.waitForSelector('html[data-ready="1"]');
}

/** The largest distance, in CSS pixels, between the painted caret and the bridge's caret. */
async function offset(page: Page): Promise<{ dx: number; dy: number }> {
  const g = await s9<Geometry>(page, 'geometry');
  expect(g.painted).not.toBeNull();
  return {
    dx: Math.abs(g.bridgeCaret.left - g.painted!.left),
    dy: Math.abs(g.bridgeCaret.top - g.painted!.top),
  };
}

const isChromium = (name: string): boolean => name === 'chromium' || name === 'msedge';

test.describe.configure({ mode: 'serial' });

test.afterAll(({ browserName }, info) => {
  writeJson(`s9/${info.project.name}.json`, {
    schema: 'docedit-perf-s9/1',
    project: info.project.name,
    engine: browserName,
    machine: machineInfo(),
    results,
  });
});

test('typing in the bridge changes the document and the pages', async ({ page }) => {
  await open(page);
  await s9(page, 'focus');
  await page.keyboard.type('XY');
  const texts = await s9<Record<string, string>>(page, 'texts');
  expect(texts['p1']!.startsWith('XYalpha beta')).toBe(true);
  expect(await s9<string>(page, 'paintedText', 'p1')).toBe(texts['p1']);
  expect(await s9<number>(page, 'steps')).toBe(2);
  results['typing'] = { steps: 2, painted: true };
});

test('the bridge caret stays on the painted caret', async ({ page }) => {
  await open(page);
  await s9(page, 'focus');
  const worst = { dx: 0, dy: 0 };
  const places: Array<[string, number]> = [
    ['p1', 0],
    ['p1', 37],
    ['p1', 120],
    ['p2', 40],
    ['p3', 0],
    ['p4', 200],
    ['p5', 100],
  ];
  const seen: Array<{ at: string; page: number; dx: number; dy: number }> = [];
  for (const [id, off] of places) {
    await s9(page, 'setPos', id, off);
    const o = await offset(page);
    const g = await s9<Geometry>(page, 'geometry');
    seen.push({ at: `${id}:${off}`, page: g.page, ...o });
    worst.dx = Math.max(worst.dx, o.dx);
    worst.dy = Math.max(worst.dy, o.dy);
  }
  // After typing, with the layout re-run on every key.
  await s9(page, 'setPos', 'p1', 5);
  await page.keyboard.type('hello world, this is typed text that makes the line wrap');
  const o = await offset(page);
  worst.dx = Math.max(worst.dx, o.dx);
  worst.dy = Math.max(worst.dy, o.dy);
  const pagesSeen = new Set(seen.map((s) => s.page));
  expect(pagesSeen.size).toBeGreaterThan(1);
  expect(worst.dx).toBeLessThan(1.5);
  expect(worst.dy).toBeLessThan(1.5);
  results['caretAnchor'] = { worst, toleranceCssPx: 1.5, seen };
});

test('movement keys come from the layout tree and the bridge follows', async ({ page }) => {
  await open(page);
  await s9(page, 'focus');
  await s9(page, 'setPos', 'p1', 70);
  const log: Array<{ key: string; pos: unknown; page: number }> = [];
  const step = async (key: string): Promise<void> => {
    await page.keyboard.press(key);
    const g = await s9<Geometry>(page, 'geometry');
    log.push({ key, pos: await s9(page, 'pos'), page: g.page });
    // The bridge was re-projected: its caret is on the painted caret again.
    expect((await offset(page)).dx).toBeLessThan(1.5);
  };
  const before = await s9<Record<string, string>>(page, 'texts');
  await step('Home');
  const home = (await s9<{ blockId: string; offset: number }>(page, 'pos')).offset;
  await step('End');
  const end = (await s9<{ blockId: string; offset: number }>(page, 'pos')).offset;
  expect(home).toBeLessThan(70);
  expect(end).toBeGreaterThan(70);
  await step('ArrowDown');
  await step('ArrowDown');
  await step('PageDown');
  const afterPage = await s9<Geometry>(page, 'geometry');
  expect(afterPage.page).toBeGreaterThanOrEqual(1);
  await step('PageUp');
  await step('ArrowUp');
  await step('Control+End');
  expect((await s9<{ blockId: string }>(page, 'pos')).blockId).toBe('p5');
  await step('Control+Home');
  expect(await s9(page, 'pos')).toEqual({ blockId: 'p1', offset: 0 });
  // Keys that move the caret never changed the text.
  expect(await s9(page, 'texts')).toEqual(before);
  results['navigation'] = { log };
});

test('a click is a hit test on the layout tree and focuses the bridge', async ({ page }) => {
  await open(page);
  const p = await s9<{ x: number; y: number }>(page, 'pointOf', 'p4', 60);
  await page.mouse.click(p.x, p.y);
  expect(await s9(page, 'pos')).toEqual({ blockId: 'p4', offset: 60 });
  expect(await s9<boolean>(page, 'activeIsBridge')).toBe(true);
  await page.keyboard.type('Z');
  expect((await s9<Record<string, string>>(page, 'texts'))['p4']!.slice(55, 70)).toContain('Z');
  expect((await offset(page)).dx).toBeLessThan(1.5);
});

test('composition: Japanese, Chinese, Korean and a dead key reach the document', async ({
  page,
  browserName,
}, info) => {
  const name = info.project.name;
  await open(page);
  await s9(page, 'focus');
  await s9(page, 'setPos', 'p1', 6);
  const base = (await s9<Record<string, string>>(page, 'texts'))['p1']!;
  const out: Record<string, unknown> = {};

  if (isChromium(name)) {
    const cdp: CDPSession = await page.context().newCDPSession(page);
    const compose = async (
      steps: string[],
      commit: string,
    ): Promise<{ midOffset: number; midPainted: boolean }> => {
      let midOffset = -1;
      let midPainted = false;
      for (const text of steps) {
        await cdp.send('Input.imeSetComposition', {
          text,
          selectionStart: text.length,
          selectionEnd: text.length,
        });
        expect(await s9<boolean>(page, 'composing')).toBe(true);
        // While the composition is open, the painted line shows the composing text and the
        // bridge's caret is on the painted caret: the input-method window follows the bridge.
        midPainted = (await s9<string>(page, 'paintedText', 'p1')).includes(text);
        midOffset = Math.max(midOffset, (await offset(page)).dx);
      }
      await cdp.send('Input.insertText', { text: commit });
      return { midOffset, midPainted };
    };
    const ja = await compose(['k', 'か', 'かn', 'かな'], '仮名');
    expect(await s9<boolean>(page, 'composing')).toBe(false);
    expect((await s9<Record<string, string>>(page, 'texts'))['p1']).toBe(
      `${base.slice(0, 6)}仮名${base.slice(6)}`,
    );
    expect(ja.midPainted).toBe(true);
    expect(ja.midOffset).toBeLessThan(1.5);
    const zh = await compose(['n', 'ni', 'nihao'], '你好');
    const ko = await compose(['ㅎ', '하', '한'], '한');
    expect((await s9<Record<string, string>>(page, 'texts'))['p1']!.slice(6, 11)).toBe(
      '仮名你好한',
    );
    expect(await s9<string>(page, 'paintedText', 'p1')).toBe(
      (await s9<Record<string, string>>(page, 'texts'))['p1'],
    );
    // A Windows-style dead key: key "Dead" with no text, then the composed character.
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Dead', code: 'Quote' });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Dead', code: 'Quote' });
    await cdp.send('Input.dispatchKeyEvent', {
      type: 'keyDown',
      key: 'é',
      text: 'é',
      code: 'KeyE',
    });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'é', code: 'KeyE' });
    expect((await s9<Record<string, string>>(page, 'texts'))['p1']!.slice(6, 12)).toBe(
      '仮名你好한é',
    );
    expect((await offset(page)).dx).toBeLessThan(1.5);
    out['driver'] = 'DevTools Input.imeSetComposition and Input.insertText';
    out['japanese'] = ja;
    out['chinese'] = zh;
    out['korean'] = ko;
    out['deadKey'] = 'passed';
  } else if (browserName === 'firefox') {
    // Juggler can only commit a composition in one step; it fires the composition events.
    await page.keyboard.insertText('仮名');
    await page.keyboard.insertText('你好');
    await page.keyboard.insertText('한');
    await page.keyboard.insertText('é');
    expect((await s9<Record<string, string>>(page, 'texts'))['p1']!.slice(6, 12)).toBe(
      '仮名你好한é',
    );
    expect(await s9<boolean>(page, 'composing')).toBe(false);
    expect(await s9<string>(page, 'paintedText', 'p1')).toBe(
      (await s9<Record<string, string>>(page, 'texts'))['p1'],
    );
    expect((await offset(page)).dx).toBeLessThan(1.5);
    out['driver'] = 'keyboard.insertText (committed in one step, composition events fired)';
    out['open composition'] = 'cannot be driven in Firefox';
  } else {
    // WebKit: no driver can open a composition. Typed text and insertText reach the bridge.
    await page.keyboard.insertText('é');
    await page.keyboard.type('かな');
    expect((await s9<Record<string, string>>(page, 'texts'))['p1']!.slice(6, 9)).toBe('éかな');
    expect((await offset(page)).dx).toBeLessThan(1.5);
    out['driver'] = 'keyboard.insertText and keyboard.type (plain text; no composition)';
    out['open composition'] = 'cannot be driven in WebKit';
  }
  results['composition'] = out;
});

test('EditContext: support and what it reports in this browser', async ({ page }, info) => {
  const name = info.project.name;
  await open(page, '?ec=1');
  const supported = await page.evaluate(() => 'EditContext' in window);
  const out: Record<string, unknown> = { supported };
  const userAgent = await page.evaluate(() => navigator.userAgent);
  out['userAgent'] = userAgent;
  if (supported && isChromium(name)) {
    await s9(page, 'startEditContext');
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.imeSetComposition', { text: 'か', selectionStart: 1, selectionEnd: 1 });
    await cdp.send('Input.imeSetComposition', { text: 'かな', selectionStart: 2, selectionEnd: 2 });
    await cdp.send('Input.insertText', { text: '仮名' });
    const log = await s9<Array<Record<string, unknown>>>(page, 'ecLog');
    out['events'] = log;
    out['contextText'] = await s9(page, 'ecText');
    const types = new Set(log.map((e) => e['type']));
    expect(types.has('textupdate')).toBe(true);
    expect(types.has('compositionstart')).toBe(true);
    expect(types.has('compositionend')).toBe(true);
    // The text the EditContext holds is the text the page gave it plus the committed text.
    expect(out['contextText']).toBe('ab仮名');
    out['note'] =
      'updateControlBounds and updateSelectionBounds were accepted; whether an input-method window moves with them cannot be seen headless';
  } else {
    out['note'] = 'EditContext is not available in this browser';
  }
  results['editContext'] = out;
});

test('find in the page: what window.find reports on painted pages', async ({ page }) => {
  const out: Record<string, unknown> = {};
  const term = 'omicron';
  for (const q of [
    '?shadow=1&bridge=opacity',
    '?shadow=0&bridge=opacity',
    '?shadow=0&bridge=clip',
  ]) {
    await open(page, q);
    // The caret is in p1, whose text holds the term; the bridge then holds that text too.
    await s9(page, 'setPos', 'p1', 3);
    const texts = await s9<Record<string, string>>(page, 'texts');
    const expected = Object.values(texts).reduce((n, t) => n + (t.split(term).length - 1), 0);
    const hasFind = await page.evaluate(
      () => typeof (window as unknown as { find?: unknown }).find === 'function',
    );
    const found = hasFind
      ? await s9<{ count: number; inBridge: number; inPage: number; other: number }>(
          page,
          'findAll',
          term,
        )
      : null;
    out[q] = { occurrencesInDocument: expected, windowFind: hasFind, found };
  }
  results['find'] = out;
});
