/**
 * FE-034 criterion 5 through the element's frame schedule: a keystroke and a remote commit that
 * land in the same animation frame are both kept, in order. Two `<doc-editor>` elements (Ada and
 * Bob) share one document on the in-page mock service (demo/embed-page.ts). The remote commit is
 * Bob's real commit, held at the service (`holdWrites`); the keystroke is a real key press from
 * Playwright into Ada's editor.
 *
 * How one frame is arranged: when Ada's key goes down, a capture listener registers a
 * `requestAnimationFrame` callback and does nothing else. The key's text is inserted by the browser
 * and read by ProseMirror as usual, which marks the core's views; their `ViewHub` registers its own
 * frame callback after ours. In the next rendered frame our callback runs first and releases Bob's
 * write; the commit reaches Ada's channel in microtasks and is applied before that callback's
 * microtask checkpoint ends; then the hub's callback runs its one notification pass. So the
 * keystroke and the remote commit are both processed for that frame, and the remote commit is
 * applied inside the frame's callbacks, not inside a key event.
 *
 * The page records every notification pass of every view of Ada's core, the keydown and input
 * events and the moment the remote text appears, with a frame counter. The test checks that no pass
 * ran between the keystroke and the remote commit, that the first pass after them shows both, and
 * that the text and both editors end equal, with the keystroke kept and in order.
 */
import { type Page, expect, test } from '@playwright/test';
import { SPIKE_IDS } from '@docedit/engine/spike-document';
import { mountEditor, openEmbed } from './embed-helpers.ts';

interface LogEntry {
  e: 'pass' | 'keydown' | 'input' | 'remote-applied' | 'frame-callback';
  frame: number;
  view?: string;
  /** Ada's paragraph where she types, then `|`, then the paragraph Bob types in. */
  text?: string;
  ok?: boolean;
}

/**
 * Installs the recorder on Ada's core: a frame counter, every view's passes, key and input events,
 * and the arming listener that releases Bob's held write in the frame after Ada's next keydown.
 */
async function installRecorder(page: Page, typed: string, remote: string): Promise<void> {
  await page.evaluate(
    async ([mine, theirs]) => {
      type View = { get(): unknown; subscribe(l: () => void): () => void };
      type Harness = { core: Record<string, unknown>; nodeText(id: string): string | null };
      const w = window as unknown as {
        __embed: { harness(el: Element): Promise<Harness> };
        __fe034: unknown;
      };
      const a = document.querySelector('doc-editor[data-test="one"]')!;
      const ha = await w.__embed.harness(a);
      const log: Array<Record<string, unknown>> = [];
      const text = () => `${ha.nodeText(mine!) ?? ''}|${ha.nodeText(theirs!) ?? ''}`;
      const state = {
        frame: 0,
        log,
        armed: false,
        hold: null as null | { release(): Promise<void> },
      };
      const tick = () => {
        state.frame++;
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
      for (const [name, v] of Object.entries(ha.core)) {
        const view = v as Partial<View> | null;
        if (view && typeof view.subscribe === 'function' && typeof view.get === 'function')
          view.subscribe(() =>
            log.push({ e: 'pass', view: name, frame: state.frame, text: text() }),
          );
      }
      const releaseInFrame = async () => {
        log.push({ e: 'frame-callback', frame: state.frame, text: text() });
        void state.hold!.release();
        // Delivery is in microtasks (OrderedDelivery): the remote text appears before this
        // callback's microtask checkpoint ends, so before the hub's callback in this frame.
        const arrived = () => (ha.nodeText(theirs!) ?? '').startsWith('remote');
        for (let i = 0; i < 500 && !arrived(); i++) await Promise.resolve();
        log.push({ e: 'remote-applied', frame: state.frame, ok: arrived(), text: text() });
      };
      window.addEventListener(
        'keydown',
        (e) => {
          log.push({ e: 'keydown', key: e.key, frame: state.frame });
          if (!state.armed) return;
          state.armed = false;
          // Only a frame callback: nothing is applied inside the key event.
          requestAnimationFrame(() => void releaseInFrame());
        },
        true,
      );
      window.addEventListener(
        'input',
        // After ProseMirror has read the change (its observer runs in a microtask of this event).
        () => queueMicrotask(() => log.push({ e: 'input', frame: state.frame, text: text() })),
        true,
      );
      w.__fe034 = state;
    },
    [typed, remote] as const,
  );
}

/** Text of a paragraph in an editor, through the spike harness. */
function nodeText(page: Page, editor: string, id: string): Promise<string | null> {
  return page.evaluate(
    async ([n, i]) => {
      const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
      const e = (
        window as unknown as {
          __embed: { harness(el: Element): Promise<{ nodeText(id: string): string | null }> };
        }
      ).__embed;
      return (await e.harness(el)).nodeText(i!);
    },
    [editor, id] as const,
  );
}

/** Puts the caret in an editor at the start or end of a node, which also focuses that editor. */
function caretIn(page: Page, editor: string, id: string, at: 'start' | 'end'): Promise<void> {
  return page.evaluate(
    async ([n, i, where]) => {
      const el = document.querySelector(`doc-editor[data-test="${n}"]`)!;
      const e = (
        window as unknown as {
          __embed: {
            harness(el: Element): Promise<{ caretIn(id: string, at: 'start' | 'end'): void }>;
          };
        }
      ).__embed;
      (await e.harness(el)).caretIn(i!, where as 'start' | 'end');
    },
    [editor, id, at] as const,
  );
}

/** Waits until Ada's core has run no notification pass for `frames` frames in a row. */
async function waitIdle(page: Page, frames = 10): Promise<void> {
  await page.evaluate(
    (n) =>
      new Promise<void>((resolve) => {
        const s = (window as unknown as { __fe034: { log: unknown[] } }).__fe034;
        let seen = s.log.length;
        let quiet = 0;
        const check = () => {
          if (s.log.length === seen) quiet++;
          else {
            seen = s.log.length;
            quiet = 0;
          }
          if (quiet >= n) resolve();
          else requestAnimationFrame(check);
        };
        requestAnimationFrame(check);
      }),
    frames,
  );
}

const CASES = [
  { name: 'the remote commit in the same paragraph, before the caret', remote: SPIKE_IDS.last },
  { name: 'the remote commit in another paragraph', remote: SPIKE_IDS.after },
] as const;

for (const c of CASES) {
  test(`FE-034 criterion 5: a keystroke and a remote commit in one frame are both kept, in order (${c.name})`, async ({
    page,
  }) => {
    const mine = SPIKE_IDS.last;
    await openEmbed(page);
    await mountEditor(page, { name: 'one', sub: 'ada' });
    await mountEditor(page, { name: 'two', sub: 'bob', target: 'mount-2' });
    await installRecorder(page, mine, c.remote);
    const original = (await nodeText(page, 'one', mine))!;
    const theirs = (await nodeText(page, 'one', c.remote))!;

    // Bob's commit, held at the service so that Ada does not receive it until the frame releases it.
    await page.evaluate(() => {
      const w = window as unknown as {
        __embed: {
          service: { holdWrites(docId: string): { release(): Promise<void> } };
          docId: string;
        };
        __fe034: { hold: unknown };
      };
      w.__fe034.hold = w.__embed.service.holdWrites(w.__embed.docId);
    });
    await caretIn(page, 'two', c.remote, 'start');
    // One insertion, so that Bob's text is one transaction and one held commit. Typed key by key,
    // 'r' is the held commit and the rest waits for its ack; Bob's next send then waits for the
    // recovery journal (FE-008, an IndexedDB write before every send), so it reaches Ada in a later
    // task, after the frame has checked. With the journal unavailable the key-by-key version passes.
    await page.keyboard.insertText('remote ');
    await expect.poll(() => nodeText(page, 'two', c.remote)).toBe(`remote ${theirs}`);
    await page.waitForTimeout(300);
    expect(await nodeText(page, 'one', c.remote)).toBe(theirs);

    await caretIn(page, 'one', mine, 'end');
    await waitIdle(page);
    const start = await page.evaluate(() => {
      const s = (window as unknown as { __fe034: { log: unknown[]; armed: boolean } }).__fe034;
      s.armed = true;
      return s.log.length;
    });
    await page.keyboard.press('K');

    const both =
      c.remote === mine
        ? `remote ${original}K|remote ${original}K`
        : `${original}K|remote ${theirs}`;
    await expect
      .poll(
        async () =>
          `${(await nodeText(page, 'one', mine)) ?? ''}|${(await nodeText(page, 'one', c.remote)) ?? ''}`,
        { timeout: 10_000 },
      )
      .toBe(both);
    await waitIdle(page, 5);
    const after = (
      (await page.evaluate(
        () => (window as unknown as { __fe034: { log: LogEntry[] } }).__fe034.log,
      )) as LogEntry[]
    ).slice(start);
    const at = (e: LogEntry['e']) => after.findIndex((x) => x.e === e);
    const [input, frameCallback, remote, firstPass] = [
      at('input'),
      at('frame-callback'),
      at('remote-applied'),
      at('pass'),
    ];
    const record = JSON.stringify({ case: c.name, after });
    test.info().annotations.push({ type: 'fe-034-frame', description: record });

    // The keystroke was read before the frame, the remote commit applied in the frame's callback.
    expect(input, record).toBeGreaterThanOrEqual(0);
    expect(after[input]!.text, record).toBe(
      c.remote === mine ? `${original}K|${original}K` : `${original}K|${theirs}`,
    );
    expect(frameCallback, record).toBeGreaterThan(input);
    expect(after[remote]?.ok, record).toBe(true);
    // No notification pass ran between them, and the pass of that same frame shows both.
    expect(firstPass, record).toBeGreaterThan(remote);
    expect(after[firstPass]!.frame, record).toBe(after[remote]!.frame);
    expect(after[firstPass]!.text, record).toBe(both);
    // The rendered paragraph shows the same text.
    await expect(
      page
        .locator('doc-editor[data-test="one"] .de-editing-surface p')
        .filter({ hasText: c.remote === mine ? `remote ${original}K` : `${original}K` }),
    ).toHaveCount(1);

    // A later keystroke follows it, and both editors converge on the same document.
    await page.keyboard.press('x');
    const mineFinal = c.remote === mine ? `remote ${original}Kx` : `${original}Kx`;
    await expect.poll(() => nodeText(page, 'one', mine)).toBe(mineFinal);
    await expect.poll(() => nodeText(page, 'two', mine), { timeout: 10_000 }).toBe(mineFinal);
    await expect
      .poll(
        () =>
          page.evaluate(async () => {
            const e = (
              window as unknown as {
                __embed: { harness(el: Element): Promise<{ doc(): unknown; pending(): number }> };
              }
            ).__embed;
            const [a, b] = [...document.querySelectorAll('doc-editor')];
            const [ha, hb] = [await e.harness(a!), await e.harness(b!)];
            return (
              ha.pending() === 0 &&
              hb.pending() === 0 &&
              JSON.stringify(ha.doc()) === JSON.stringify(hb.doc())
            );
          }),
        { timeout: 10_000 },
      )
      .toBe(true);
  });
}
