/**
 * PRO-032 criterion 4 (lane V-PRO-018-034, fixer round 1). A commit from another user creates region
 * R. Until an `access` with `asOfSeq` at or after that commit arrives, typing into R with real key
 * events is refused locally: the text does not change and the region guard raises a refusal for
 * `region:<R>`. Once that access arrives and lists R with `edit`, the same typing goes through and
 * reaches the server.
 *
 * The page is the embed page (demo/embed-page.ts) with its in-memory backend. The commit that
 * creates R is a real commit of a second user (Vic, owner) through the same mock service, which
 * sends `perm.changed` after it (07 §4). The test holds the delivery of `access` objects on Ada's
 * channel, which stands for the network delivering `perm.changed` later than the commit; nothing
 * else on the channel is held, and no commit follows while it is held.
 *
 * Run from the repository root with
 *   pnpm exec playwright test -c packages/element/playwright.config.ts pro-032-region-access
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const REGION = 'rCreated00000001';
const PARA = 'pCreated00000001';
const SCOPE = `region:${REGION}`;
const AFTER = 'pAfter0000000001';

interface AccessSeen {
  asOfSeq: number;
  scopes: Record<string, string[]>;
}

interface Probe {
  /** Whether access objects on Ada's channel are held. */
  held: boolean;
  /** Access objects that arrived on Ada's channel, held or not, in order. */
  arrived: AccessSeen[];
  release(): void;
  /** The `seq` of Vic's commit that created the region. */
  createdSeq: number;
  /** Commits by Ada that Vic's channel received. */
  fromAda: number;
}

declare global {
  interface Window {
    __pro032?: Probe;
  }
}

/** Mounts Ada's editor on the regions document with her channel's access delivery gated. */
async function mount(page: Page): Promise<void> {
  await page.evaluate(async () => {
    type Channel = {
      opened: { head: number };
      onAccess(cb: (a: AccessSeen) => void): () => void;
      onCommits(cb: (c: Array<{ kind: string; seq: number }>) => void): () => void;
      submit(c: unknown): Promise<{ seq: number }>;
    };
    type Port = {
      connect(): Promise<void>;
      sync: { open(id: string, opts: unknown): Promise<Channel> };
    };
    const e = (
      window as unknown as {
        __embed: { backend(sub: string, role: string): Port; regionsDocId: string };
      }
    ).__embed;
    const queue: Array<() => void> = [];
    const probe: Probe = {
      held: false,
      arrived: [],
      release() {
        probe.held = false;
        for (const deliver of queue.splice(0)) deliver();
      },
      createdSeq: -1,
      fromAda: 0,
    };
    window.__pro032 = probe;
    const backend = e.backend('ada', 'editor');
    const open = backend.sync.open.bind(backend.sync);
    backend.sync.open = async (id, opts) => {
      const channel = await open(id, opts);
      const onAccess = channel.onAccess.bind(channel);
      // Every subscriber (the element's session and the core's sync session) goes through the gate.
      channel.onAccess = (cb) =>
        onAccess((a) => {
          probe.arrived.push({ asOfSeq: a.asOfSeq, scopes: a.scopes });
          if (probe.held) queue.push(() => cb(a));
          else cb(a);
        });
      return channel;
    };
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'pro032';
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
        { once: true },
      );
    });
    el.backend = backend;
    el.setAttribute('doc-id', e.regionsDocId);
    document.getElementById('mount')!.append(el);
    await ready;
  });
  await expect(page.locator('doc-editor[data-test="pro032"] .de-editing-surface')).toBeVisible();
}

type CoreView = {
  permissions: { get(): AccessSeen | null };
  refusal: { get(): { n: number; reason: string; scopes: string[] } | null };
};

/** The access the editing core holds, and the last refusal of its region guard. */
function coreState(page: Page): Promise<{
  access: AccessSeen | null;
  refusal: { n: number; reason: string; scopes: string[] } | null;
}> {
  return page.evaluate(() => {
    const el = document.querySelector('doc-editor[data-test="pro032"]')!;
    const e = (
      window as unknown as { __embed: { internals(el: Element): { editor?: { core: CoreView } } } }
    ).__embed;
    const core = e.internals(el).editor!.core;
    const a = core.permissions.get();
    return {
      access: a ? { asOfSeq: a.asOfSeq, scopes: a.scopes } : null,
      refusal: core.refusal.get(),
    };
  });
}

function nodeText(page: Page, id: string): Promise<string | null> {
  return page.evaluate(async (id) => {
    const el = document.querySelector('doc-editor[data-test="pro032"]')!;
    const e = (
      window as unknown as {
        __embed: { harness(el: Element): Promise<{ nodeText(id: string): string | null }> };
      }
    ).__embed;
    return (await e.harness(el)).nodeText(id);
  }, id);
}

/**
 * Vic (owner) commits a region with one paragraph before the paragraph after the middle region,
 * with Ada's access delivery held from just before the commit.
 */
async function createRegion(page: Page): Promise<void> {
  await page.evaluate(
    async ({ REGION, PARA, AFTER }) => {
      type Channel = {
        opened: { head: number };
        onCommits(cb: (c: Array<{ kind: string; seq: number }>) => void): () => void;
        submit(c: unknown): Promise<{ seq: number }>;
      };
      type Port = {
        connect(): Promise<void>;
        sync: { open(id: string, opts: unknown): Promise<Channel> };
      };
      const e = (
        window as unknown as {
          __embed: {
            backend(sub: string, role: string): Port;
            regionsDocId: string;
            harness(el: Element): Promise<{
              view: {
                state: {
                  doc: {
                    descendants(
                      f: (n: { attrs: Record<string, unknown> }, pos: number) => boolean,
                    ): void;
                  };
                };
              };
            }>;
          };
        }
      ).__embed;
      const probe = window.__pro032!;
      const vic = e.backend('vic', 'owner');
      await vic.connect();
      const channel = await vic.sync.open(e.regionsDocId, {});
      // Vic's own commit answers his submit; a step commit after it on his channel is Ada's.
      channel.onCommits((cs) => {
        for (const c of cs)
          if (c.kind === 'steps' && probe.createdSeq > 0 && c.seq > probe.createdSeq)
            probe.fromAda++;
      });
      // The position before the paragraph after the middle region, in the document at the head.
      const h = await e.harness(document.querySelector('doc-editor[data-test="pro032"]')!);
      let pos = -1;
      h.view.state.doc.descendants((n, p) => {
        if (pos >= 0) return false;
        if (n.attrs['id'] === AFTER) pos = p;
        return pos < 0;
      });
      if (pos < 0) throw new Error('no paragraph after the region');
      const hex = Date.now().toString(16).padStart(12, '0');
      const rand = [...crypto.getRandomValues(new Uint8Array(10))]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      const variant = ((parseInt(rand.slice(3, 4), 16) & 0x3) | 0x8).toString(16);
      const id = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-7${rand.slice(0, 3)}-${variant}${rand.slice(4, 7)}-${rand.slice(7, 19)}`;
      probe.held = true;
      const ack = await channel.submit({
        id,
        base: channel.opened.head,
        steps: [
          {
            stepType: 'replace',
            from: pos,
            to: pos,
            slice: {
              content: [
                {
                  type: 'region',
                  attrs: { id: REGION, title: 'Created', policy: 'inherit' },
                  content: [
                    {
                      type: 'paragraph',
                      attrs: { id: PARA },
                      content: [{ type: 'text', text: 'New region.' }],
                    },
                  ],
                },
              ],
            },
          },
        ],
      });
      probe.createdSeq = ack.seq;
    },
    { REGION, PARA, AFTER },
  );
}

/** Puts the caret at the end of the new region's paragraph with a click and End, and types. */
async function typeInRegion(page: Page, text: string): Promise<void> {
  const surface = page.locator('doc-editor[data-test="pro032"] .de-editing-surface');
  await surface.locator('p', { hasText: 'New region.' }).click();
  await page.keyboard.press('End');
  await page.keyboard.type(text);
}

test('PRO-032: typing into a region created by a commit is refused until an access with asOfSeq at or after it arrives', async ({
  page,
}) => {
  await openEmbed(page);
  await mount(page);
  await expect.poll(async () => (await coreState(page)).access !== null).toBe(true);

  await createRegion(page);
  const createdSeq = await page.evaluate(() => window.__pro032!.createdSeq);
  expect(createdSeq).toBeGreaterThan(0);
  // Ada's editor has received the commit that creates R.
  await expect.poll(() => nodeText(page, PARA)).toBe('New region.');
  // The server's perm.changed for it arrived and is held: asOfSeq at or after the commit, listing R.
  await expect
    .poll(() =>
      page.evaluate(
        ({ seq, scope }) =>
          window.__pro032!.arrived.some((a) => a.asOfSeq >= seq && scope in a.scopes),
        { seq: createdSeq, scope: SCOPE },
      ),
    )
    .toBe(true);
  // The core holds no access with asOfSeq at or after the commit, and its access does not list R.
  const before = await coreState(page);
  expect(before.access!.asOfSeq).toBeLessThan(createdSeq);
  expect(before.access!.scopes[SCOPE]).toBeUndefined();
  const refusalsBefore = before.refusal?.n ?? 0;

  // Typing into R with real key events is refused locally.
  await typeInRegion(page, 'X');
  await expect
    .poll(async () => (await coreState(page)).refusal?.n ?? 0)
    .toBeGreaterThan(refusalsBefore);
  const refused = (await coreState(page)).refusal!;
  expect(refused.reason).toBe('scope');
  expect(refused.scopes).toContain(SCOPE);
  expect(await nodeText(page, PARA)).toBe('New region.');

  // The access arrives: R is listed with edit, and the same typing goes through.
  await page.evaluate(() => window.__pro032!.release());
  await expect
    .poll(async () => {
      const a = (await coreState(page)).access;
      return a !== null && a.asOfSeq >= createdSeq && (a.scopes[SCOPE] ?? []).includes('edit');
    })
    .toBe(true);
  const refusalsAfterRelease = (await coreState(page)).refusal?.n ?? 0;
  await typeInRegion(page, 'Y');
  await expect.poll(() => nodeText(page, PARA)).toBe('New region.Y');
  expect((await coreState(page)).refusal?.n ?? 0).toBe(refusalsAfterRelease);
  // The edit was sent and stored: Vic's channel receives Ada's commit.
  await expect.poll(() => page.evaluate(() => window.__pro032!.fromAda)).toBeGreaterThan(0);
});
