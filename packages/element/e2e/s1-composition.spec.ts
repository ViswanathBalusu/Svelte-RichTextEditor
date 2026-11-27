/**
 * Spike S1 (SPK-014): composition input inside the shadow root, with remote commits arriving while
 * the composition is open, in the body view and in the footnote and header sub-editors.
 *
 * Drivers (what each browser lets Playwright automate; see s1-input-drivers.spec.ts):
 * - Chromium and Edge: the DevTools protocol drives the browser's own composition path
 *   (`Input.imeSetComposition` for each update, `Input.insertText` to commit). The remote commit
 *   is applied between two updates, so the composition is open with uncommitted text in the DOM.
 * - Firefox: `keyboard.insertText` commits a composition in one step through Gecko's
 *   TextInputProcessor (compositionstart, compositionupdate, compositionend); the remote commit is
 *   applied from inside the compositionupdate event. Intermediate updates cannot be driven.
 * - WebKit: no composition can be driven (no protocol command; `insertText` inserts plain text),
 *   so only the keystroke case runs; composition stays on the manual checklist.
 *
 * Remote commits use the stand-in sync client of the engine (remote.ts) in both modes: `map`
 * (remote steps on the current state) and `rebase` (undo unconfirmed local steps, apply the remote
 * steps, re-apply the local steps: the rebuild of FE-033). Prepares FE-034, FE-056, FE-123.
 */
import { type CDPSession, type Page, expect, test } from '@playwright/test';
import type { RemoteMode, RemoteOp } from '@docedit/engine/testing';
import { SPIKE_IDS, harness, openPanel, openS1, record } from './helpers.ts';

interface Composition {
  steps: string[];
  commit: string;
}

/** Composition sequences shaped like the Windows input methods produce them. */
const SCRIPTS: Record<string, Composition[]> = {
  japanese: [{ steps: ['k', 'か', 'かn', 'かな'], commit: '仮名' }],
  chinese: [{ steps: ['n', 'ni', 'nih', 'niha', 'nihao'], commit: '你好' }],
  korean: [
    { steps: ['ㅎ', '하', '한'], commit: '한' },
    { steps: ['ㄱ', '구', '국'], commit: '국' },
  ],
  // FE-111 criterion 3: the scripts of the right-to-left and complex-script corpus (input-method-matrix.ts).
  arabic: [{ steps: ['m', 'مر', 'مرح', 'مرحب', 'مرحبا'], commit: 'مرحبا' }],
  hebrew: [{ steps: ['sh', 'של', 'שלו', 'שלום'], commit: 'שלום' }],
  devanagari: [{ steps: ['n', 'न', 'नम', 'नमस्', 'नमस्ते'], commit: 'नमस्ते' }],
  thai: [{ steps: ['ส', 'สว', 'สวั', 'สวัส', 'สวัสด', 'สวัสดี'], commit: 'สวัสดี' }],
};

type Editor = 'main' | 'footnote' | 'header';

const TARGET: Record<Editor, string> = {
  main: SPIKE_IDS.after,
  footnote: SPIKE_IDS.footnote,
  header: SPIKE_IDS.headerParagraph,
};

/** The remote marker: unique text whose count in the document must be exactly one. */
const R = '«R»';

interface Variant {
  name: string;
  /** The remote operation, or null for none. */
  op: ((mode: RemoteMode, baseLength: number) => RemoteOp) | null;
  /** Node whose text gains the marker at its start (besides the target), if any. */
  prefixed?: string;
  /** Whether the marker goes at the start of the composing node. */
  prefixesTarget?: boolean;
  /** Whether the marker lands exactly where the composition started (order not asserted). */
  atCaret?: boolean;
  /** Offset inside the composing node's original text where the marker lands. */
  inside?: number;
}

const insert =
  (node: string, at: 'start' | 'end' | number) =>
  (mode: RemoteMode): RemoteOp => ({
    kind: 'insert',
    node,
    at,
    text: R,
    mode,
  });

const VARIANTS: Record<Editor, Variant[]> = {
  main: [
    { name: 'none', op: null },
    {
      name: 'other paragraph after',
      op: insert(SPIKE_IDS.last, 'start'),
      prefixed: SPIKE_IDS.last,
    },
    {
      name: 'other paragraph before',
      op: insert(SPIKE_IDS.intro, 'start'),
      prefixed: SPIKE_IDS.intro,
    },
    {
      name: 'same paragraph before the caret',
      op: insert(SPIKE_IDS.after, 'start'),
      prefixesTarget: true,
    },
    {
      name: 'same text node, between earlier characters',
      op: insert(SPIKE_IDS.after, 7),
      inside: 7,
    },
    {
      name: 'same paragraph at the composition',
      op: (mode, baseLength) => insert(SPIKE_IDS.after, baseLength)(mode),
      atCaret: true,
    },
    {
      name: 'new paragraph before',
      op: (mode) => ({
        kind: 'paragraph',
        before: SPIKE_IDS.after,
        text: R,
        id: 'pRemote000000001',
        mode,
      }),
    },
  ],
  footnote: [
    { name: 'none', op: null },
    { name: 'body paragraph', op: insert(SPIKE_IDS.last, 'start'), prefixed: SPIKE_IDS.last },
    {
      name: 'footnote before the caret',
      op: insert(SPIKE_IDS.footnote, 'start'),
      prefixesTarget: true,
    },
    { name: 'footnote, between earlier characters', op: insert(SPIKE_IDS.footnote, 4), inside: 4 },
  ],
  header: [
    { name: 'none', op: null },
    { name: 'body paragraph', op: insert(SPIKE_IDS.last, 'start'), prefixed: SPIKE_IDS.last },
    {
      name: 'header before the caret',
      op: insert(SPIKE_IDS.headerParagraph, 'start'),
      prefixesTarget: true,
    },
    {
      name: 'header, between earlier characters',
      op: insert(SPIKE_IDS.headerParagraph, 3),
      inside: 3,
    },
  ],
};

async function prepare(page: Page, editor: Editor, query = '') {
  const h = await openS1(page, query);
  if (editor === 'main') await h.caretIn(SPIKE_IDS.after, 'end');
  else {
    await openPanel(page, editor);
    await h.subCaret('end');
  }
  await h.watchEvents();
  return h;
}

function count(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

async function check(
  page: Page,
  editor: Editor,
  variant: Variant,
  script: Composition[],
  before: Record<string, string>,
  driver: string,
) {
  const h = harness(page);
  const committed = script.map((c) => c.commit).join('');
  const target = TARGET[editor];
  const text = (await h.nodeText(target))!;
  const base = before[target]!;
  record(
    `composition-${driver}-${editor}-${variant.name.replaceAll(' ', '-')}-${script[0]!.commit}`,
    {
      text,
      events: await h.events(),
    },
  );
  if (variant.atCaret) {
    // A concurrent insert at the same place may land before, after or between the committed
    // compositions (Korean commits one syllable at a time), but nothing else may change.
    expect(count(text, R)).toBe(1);
    expect(text.replace(R, '')).toBe(`${base}${committed}`);
  } else if (variant.inside !== undefined) {
    expect(text).toBe(
      `${base.slice(0, variant.inside)}${R}${base.slice(variant.inside)}${committed}`,
    );
  } else {
    expect(text).toBe(`${variant.prefixesTarget ? R : ''}${base}${committed}`);
  }
  if (variant.prefixed)
    expect(await h.nodeText(variant.prefixed)).toBe(`${R}${before[variant.prefixed]}`);
  if (variant.op) {
    // The remote text arrived once, wherever it went.
    const doc = JSON.stringify(await h.doc());
    expect(count(doc, R)).toBe(1);
  }
  const events = await h.events();
  const view = editor === 'main' ? 'main' : 'sub';
  const starts = events.filter((e) => e.startsWith(`${view}:compositionstart`)).length;
  const ends = events.filter((e) => e.startsWith(`${view}:compositionend`)).length;
  // A remote commit that cancelled the composition would add an end (and a restart).
  expect({ starts, ends }).toEqual({ starts: script.length, ends: script.length });
  const remoteLines = events.filter((e) => /^remote-(applied|deferred):/.test(e));
  if (variant.op) {
    expect(remoteLines).toHaveLength(1);
    // The remote commit arrived while the composition was open...
    expect(remoteLines[0]).toMatch(/composing=(true\/false|false\/true)/);
    // ...and the core deferred it exactly when it changes the block being composed.
    const touches =
      variant.prefixesTarget === true || variant.inside !== undefined || variant.atCaret === true;
    expect(remoteLines[0]).toMatch(touches ? /^remote-deferred:/ : /^remote-applied:/);
  }
  expect((await h.validate()).violations).toEqual([]);
}

async function textsBefore(page: Page): Promise<Record<string, string>> {
  const h = harness(page);
  const out: Record<string, string> = {};
  for (const id of [
    SPIKE_IDS.after,
    SPIKE_IDS.last,
    SPIKE_IDS.intro,
    SPIKE_IDS.footnote,
    SPIKE_IDS.headerParagraph,
  ])
    out[id] = (await h.nodeText(id))!;
  return out;
}

async function cdpCompose(cdp: CDPSession, script: Composition[], mid: () => Promise<void>) {
  for (const [ci, c] of script.entries()) {
    for (const [si, s] of c.steps.entries()) {
      await cdp.send('Input.imeSetComposition', {
        text: s,
        selectionStart: s.length,
        selectionEnd: s.length,
      });
      if (ci === 0 && si === 1) await mid();
    }
    await cdp.send('Input.insertText', { text: c.commit });
  }
}

const chromiumOnly = 'The DevTools protocol exists only in Chromium and Edge';
const firefoxOnly = 'Only Firefox turns keyboard.insertText into a composition';

function matrix(
  each: (
    title: string,
    editor: Editor,
    script: Composition[],
    variant: Variant,
    mode: RemoteMode,
  ) => void,
) {
  for (const editor of ['main', 'footnote', 'header'] as const)
    for (const [language, script] of Object.entries(SCRIPTS))
      for (const variant of VARIANTS[editor])
        for (const mode of variant.op ? (['map', 'rebase'] as const) : (['map'] as const))
          each(
            `${editor}: ${language} composition, remote: ${variant.name}${variant.op ? ` (${mode})` : ''}`,
            editor,
            script,
            variant,
            mode,
          );
}

test.describe('devtools protocol', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', chromiumOnly);
  matrix((title, editor, script, variant, mode) => {
    test(title, async ({ page }) => {
      const h = await prepare(page, editor);
      const before = await textsBefore(page);
      const cdp = await page.context().newCDPSession(page);
      await cdpCompose(cdp, script, async () => {
        if (!variant.op) return;
        const composing = await h.composing();
        expect(editor === 'main' ? composing.main : composing.sub).toBe(true);
        await h.remote(variant.op(mode, before[TARGET[editor]]!.length));
      });
      await check(page, editor, variant, script, before, 'cdp');
    });
  });
});

test.describe('one-step commit', () => {
  test.skip(({ browserName }) => browserName !== 'firefox', firefoxOnly);
  matrix((title, editor, script, variant, mode) => {
    test(title, async ({ page }) => {
      const h = await prepare(page, editor);
      const before = await textsBefore(page);
      if (variant.op)
        await h.remoteOnNextEvent(
          editor === 'main' ? 'main' : 'sub',
          'compositionupdate',
          variant.op(mode, before[TARGET[editor]]!.length),
        );
      for (const c of script) await page.keyboard.insertText(c.commit);
      await check(page, editor, variant, script, before, 'tip');
    });
  });
});

// The footnote sub-editor under option B of 03 §13 (`paragraph+`, one paragraph): the text is in
// the footnote's paragraph, so remote inserts target that paragraph.
const VARIANTS_B: Variant[] = [
  { name: 'none', op: null },
  { name: 'body paragraph', op: insert(SPIKE_IDS.last, 'start'), prefixed: SPIKE_IDS.last },
  {
    name: "footnote's paragraph before the caret",
    op: insert(SPIKE_IDS.footnoteParagraph, 'start'),
    prefixesTarget: true,
  },
  {
    name: "footnote's paragraph, between earlier characters",
    op: insert(SPIKE_IDS.footnoteParagraph, 4),
    inside: 4,
  },
];

test.describe('footnote model paragraph: composition in the footnote sub-editor', () => {
  for (const [language, script] of Object.entries(SCRIPTS))
    for (const variant of VARIANTS_B)
      for (const mode of variant.op ? (['map', 'rebase'] as const) : (['map'] as const)) {
        const title = `footnote (paragraph model): ${language} composition, remote: ${variant.name}${variant.op ? ` (${mode})` : ''}`;
        test(title, async ({ page, browserName }) => {
          test.skip(browserName === 'webkit', 'No composition driver for WebKit');
          const h = await prepare(page, 'footnote', '?model=paragraph');
          const before = await textsBefore(page);
          if (browserName === 'chromium') {
            const cdp = await page.context().newCDPSession(page);
            await cdpCompose(cdp, script, async () => {
              if (variant.op) await h.remote(variant.op(mode, before[TARGET.footnote]!.length));
            });
          } else {
            if (variant.op)
              await h.remoteOnNextEvent(
                'sub',
                'compositionupdate',
                variant.op(mode, before[TARGET.footnote]!.length),
              );
            for (const c of script) await page.keyboard.insertText(c.commit);
          }
          await check(page, 'footnote', variant, script, before, `${browserName}-paragraph-model`);
        });
      }
});

test.describe('without the deferral: the failure the core works around', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', chromiumOnly);
  // With `defer=0` the core applies a remote commit at once. When the composition's text was
  // typed into a text node ProseMirror already renders (body and footnote here), a remote insert
  // into that node makes ProseMirror redraw it: Chromium drops the composition, keeps the
  // uncommitted text and starts a new composition at the next update, so the text appears twice.
  // In the header the composition follows the page field, so the browser puts it in a new text
  // node, which ProseMirror protects (a CompositionViewDesc): an insert right before it is safe.
  // These tests pin that behaviour; if they start failing, ProseMirror or Chromium changed and the
  // deferral in EditorCore.applyRemote may no longer be needed.
  const cases: Array<[Editor, string, number, boolean]> = [
    ['main', SPIKE_IDS.after, 7, true],
    ['footnote', SPIKE_IDS.footnote, 4, true],
    ['header', SPIKE_IDS.headerParagraph, 13, false],
  ];
  for (const [editor, node, at, breaks] of cases) {
    for (const mode of ['map', 'rebase'] as const) {
      test(`${editor}: remote insert next to the composition ${breaks ? 'leaves the uncommitted text' : 'is safe'} (${mode})`, async ({
        page,
      }) => {
        const h = await prepare(page, editor, '?defer=0');
        const before = await textsBefore(page);
        const cdp = await page.context().newCDPSession(page);
        await cdpCompose(cdp, SCRIPTS['japanese']!, async () => {
          expect(await h.remote({ kind: 'insert', node, at, text: R, mode })).toBe('applied');
        });
        const text = (await h.nodeText(TARGET[editor]))!;
        const base = before[TARGET[editor]]!;
        const events = await h.events();
        record(`composition-unguarded-${editor}-${mode}`, { text, events });
        const stray = breaks ? 'か' : '';
        expect(text).toBe(`${base.slice(0, at)}${R}${base.slice(at)}${stray}仮名`);
        expect(events.filter((e) => e.includes('compositionstart')).length).toBe(breaks ? 2 : 1);
      });
    }
  }
});

test.describe('dead keys [devtools protocol]', () => {
  test.skip(({ browserName }) => browserName !== 'chromium', chromiumOnly);
  for (const mode of [null, 'map', 'rebase'] as const) {
    test(`Windows-style dead key, then e, remote: ${mode ?? 'none'}`, async ({ page }) => {
      const h = await prepare(page, 'main');
      const cdp = await page.context().newCDPSession(page);
      // US-International: the apostrophe key is dead; the next e gives é. Chromium on Windows
      // sends a keydown with key "Dead" and no text, then the composed character as text.
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'rawKeyDown',
        key: 'Dead',
        code: 'Quote',
        windowsVirtualKeyCode: 222,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'Dead',
        code: 'Quote',
        windowsVirtualKeyCode: 222,
      });
      if (mode)
        await h.remote({ kind: 'insert', node: SPIKE_IDS.last, at: 'start', text: R, mode });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyDown',
        key: 'é',
        code: 'KeyE',
        text: 'é',
        unmodifiedText: 'é',
        windowsVirtualKeyCode: 69,
      });
      await cdp.send('Input.dispatchKeyEvent', {
        type: 'keyUp',
        key: 'é',
        code: 'KeyE',
        windowsVirtualKeyCode: 69,
      });
      expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote target paragraph.é');
      if (mode) expect(await h.nodeText(SPIKE_IDS.last)).toBe(`${R}Last paragraph.`);
      record(`deadkey-windows-${mode ?? 'none'}`, { events: await h.events() });
    });

    test(`macOS-style dead key composition, remote: ${mode ?? 'none'}`, async ({ page }) => {
      const h = await prepare(page, 'main');
      const cdp = await page.context().newCDPSession(page);
      // macOS input sources show the accent as marked text, then commit the composed character.
      await cdp.send('Input.imeSetComposition', { text: '´', selectionStart: 1, selectionEnd: 1 });
      if (mode)
        await h.remote({ kind: 'insert', node: SPIKE_IDS.last, at: 'start', text: R, mode });
      await cdp.send('Input.insertText', { text: 'é' });
      expect(await h.nodeText(SPIKE_IDS.after)).toBe('Remote target paragraph.é');
      if (mode) expect(await h.nodeText(SPIKE_IDS.last)).toBe(`${R}Last paragraph.`);
      const events = await h.events();
      expect(events.filter((e) => e.startsWith('main:compositionend')).length).toBe(1);
      record(`deadkey-mac-${mode ?? 'none'}`, { events });
    });
  }
});

test.describe('a keystroke and a remote commit in the same frame', () => {
  for (const editor of ['main', 'footnote', 'header'] as const) {
    for (const mode of ['map', 'rebase'] as const) {
      test(`${editor}: remote commit applied on keydown is neither lost nor reorders the keystroke (${mode})`, async ({
        page,
      }) => {
        const h = await prepare(page, editor);
        const before = await textsBefore(page);
        await h.remoteOnNextEvent(editor === 'main' ? 'main' : 'sub', 'keydown', {
          kind: 'insert',
          node: SPIKE_IDS.last,
          at: 'start',
          text: R,
          mode,
        });
        await page.keyboard.type('abc');
        await expect.poll(() => h.nodeText(TARGET[editor])).toBe(`${before[TARGET[editor]]}abc`);
        expect(await h.nodeText(SPIKE_IDS.last)).toBe(`${R}Last paragraph.`);
        expect((await h.validate()).violations).toEqual([]);
      });
    }
  }
});
