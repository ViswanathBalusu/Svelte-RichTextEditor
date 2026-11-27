/**
 * PRM-026 in the real `<doc-editor>` (lane w9): a region the user cannot edit is shaded and carries
 * a lock indicator that says who can edit it, with names from the host's `resolveUsers` over the
 * backend's derived region list; a region the user can edit shows neither. The indicator has an icon
 * and a text label as well as the shading, and uses system colours under forced colours. A
 * `perm.changed` updates shading and indicators without a reload and without moving the selection,
 * and assistive technology is told when the caret enters a region the user cannot edit.
 *
 * The page is the embed page (demo/embed-page.ts) with its in-memory backend, which runs the real
 * room and derives "who can edit" as the document service does. Each test creates its own document:
 * a paragraph, the open region "Open" (policy `inherit`), a paragraph, the restricted region
 * "Locked" granted to Ada and to the group Legal, and a last paragraph. Bob opens it as an editor.
 *
 * Run with `DOCEDIT_DEMO_PORT=56591 pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/prm-026-lock-indicator.spec.ts`.
 */
import AxeBuilder from '@axe-core/playwright';
import { type Page, expect, test } from '@playwright/test';
import { events, openEmbed } from './embed-helpers.ts';

const IDS = {
  intro: 'pIntro0000000001',
  open: 'rOpen00000000001',
  openPara: 'pOpen00000000001',
  mid: 'pMid000000000001',
  locked: 'rLocked000000001',
  lockedPara: 'pLocked000000001',
  end: 'pEnd000000000001',
} as const;

const HOST = 'doc-editor[data-test="prm026"]';
// The region list names principals in its own order (sorted), so the group comes first.
const WHO = 'It can be edited by Group and Ada Lovelace, and by document owners.';

interface Probe {
  /** The identifiers the element asked the host's directory for, one list per call. */
  asked: string[][];
  /** Lets the directory answer; until then its answers wait. */
  answer(): void;
  /** Sets the element's `resolveUsers`, as a host does; at mount unless the test asked for `late`. */
  setDirectory(): void;
}

declare global {
  interface Window {
    __prm026?: Probe & { docId: string; region: Record<string, Element> };
  }
}

/**
 * Creates the document and mounts Bob's editor on it. The directory answers at once unless `hold`.
 * With `late`, the host sets `resolveUsers` only when the test calls the probe's `setDirectory`.
 */
async function mount(page: Page, opts: { hold?: boolean; late?: boolean } = {}): Promise<void> {
  await page.evaluate(
    async ({ IDS, hold, late }) => {
      const p = (id: string, text: string) => ({
        type: 'paragraph',
        attrs: { id },
        ...(text ? { content: [{ type: 'text', text }] } : {}),
      });
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
                p(IDS.intro, 'Hello world'),
                {
                  type: 'region',
                  attrs: { id: IDS.open, title: 'Open', policy: 'inherit' },
                  content: [p(IDS.openPara, 'Open region text')],
                },
                p(IDS.mid, 'Between'),
                {
                  type: 'region',
                  attrs: { id: IDS.locked, title: 'Locked', policy: 'restricted' },
                  content: [p(IDS.lockedPara, 'Restricted text')],
                },
                p(IDS.end, 'The end'),
              ],
            },
          ],
        },
      };
      const e = (
        window as unknown as {
          __embed: {
            service: {
              createDocument(env: unknown, opts: unknown): string;
              backend(user: unknown, roles: Record<string, string>): unknown;
            };
          };
        }
      ).__embed;
      const docId = e.service.createDocument(envelope, {
        grants: [
          { region: IDS.locked, principal: 'user:ada', role: 'editor' },
          { region: IDS.locked, principal: 'group:legal', role: 'editor' },
        ],
      });
      let release: () => void = () => {};
      const gate = hold ? new Promise<void>((resolve) => (release = resolve)) : Promise.resolve();
      const names: Record<string, string> = { ada: 'Ada Lovelace', bob: 'Bob Hopper' };
      const el = document.createElement('doc-editor') as HTMLElement & {
        backend: unknown;
        resolveUsers: unknown;
      };
      el.dataset['test'] = 'prm026';
      // The host's directory: identifiers in, names out. A group is never asked for here.
      const directory = async (ids: readonly string[]) => {
        probe.asked.push([...ids]);
        await gate;
        return ids.map((id) => (names[id] ? { id, name: names[id] } : null));
      };
      const probe = {
        asked: [] as string[][],
        answer: () => release(),
        setDirectory: () => {
          el.resolveUsers = directory;
        },
        docId,
        region: {},
      };
      window.__prm026 = probe;
      if (!late) probe.setDirectory();
      const ready = new Promise<void>((resolve, reject) => {
        el.addEventListener('de-ready', () => resolve(), { once: true });
        el.addEventListener(
          'de-error',
          (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
          { once: true },
        );
      });
      el.backend = e.service.backend({ sub: 'bob', name: 'Bob' }, { [docId]: 'editor' });
      el.setAttribute('doc-id', docId);
      document.getElementById('mount')!.append(el);
      await ready;
    },
    { IDS, hold: opts.hold === true, late: opts.late === true },
  );
  await expect(page.locator(`${HOST} .de-editing-surface`)).toBeVisible();
}

const region = (page: Page, title: string) =>
  page.locator(`${HOST} .de-region[data-title="${title}"]`);
const lock = (page: Page, title: string) => region(page, title).locator('.de-region-lock');
const status = (page: Page) => page.locator(`${HOST} .de-shell > [role="status"]`);

/** Calls a method of the spike harness of the editor on the page. */
function harness<T>(page: Page, name: string, ...args: unknown[]): Promise<T> {
  return page.evaluate(
    async ({ name, args }) => {
      const e = (
        window as unknown as {
          __embed: { harness(el: Element): Promise<Record<string, (...a: unknown[]) => unknown>> };
        }
      ).__embed;
      const h = await e.harness(document.querySelector('doc-editor[data-test="prm026"]')!);
      return h[name]!(...args) as T;
    },
    { name, args },
  );
}

/** Changes the document's permissions through the service, as the control plane does. */
function service(
  page: Page,
  change: 'grant-bob' | 'lease-open-to-ada' | 'no-lease',
): Promise<void> {
  return page.evaluate(
    ({ change, IDS }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: {
              now(): number;
              setGrants(docId: string, grants: unknown[]): void;
              setLeases(docId: string, leases: unknown[]): void;
            };
          };
        }
      ).__embed;
      const docId = window.__prm026!.docId;
      if (change === 'grant-bob')
        e.service.setGrants(docId, [
          { region: IDS.locked, principal: 'user:ada', role: 'editor' },
          { region: IDS.locked, principal: 'group:legal', role: 'editor' },
          { region: IDS.locked, principal: 'user:bob', role: 'editor' },
        ]);
      else if (change === 'lease-open-to-ada')
        e.service.setLeases(docId, [
          { region: IDS.open, holder: 'ada', expiresAt: e.service.now() + 10 * 60_000 },
        ]);
      else e.service.setLeases(docId, []);
    },
    { change, IDS },
  );
}

/** How the locked region and its indicator are drawn now, with the system colours to compare. */
function look(page: Page) {
  return page.evaluate(() => {
    const root = document.querySelector('doc-editor[data-test="prm026"]')!.shadowRoot!;
    const el = root.querySelector<HTMLElement>('.de-region[data-title="Locked"]')!;
    const note = el.querySelector<HTMLElement>('.de-region-lock')!;
    const icon = note.querySelector<HTMLElement>('.de-region-lock-icon')!;
    const label = note.querySelector<HTMLElement>('.de-region-lock-label')!;
    const probe = (prop: string, value: string) => {
      const p = document.createElement('div');
      p.style.setProperty(prop, value);
      root.appendChild(p);
      const v = getComputedStyle(p).getPropertyValue(prop);
      p.remove();
      return v;
    };
    const s = getComputedStyle(el);
    const n = getComputedStyle(note);
    const i = getComputedStyle(icon);
    const shackle = getComputedStyle(icon, '::before');
    const box = (e: Element) => {
      const r = e.getBoundingClientRect();
      return { width: r.width, height: r.height };
    };
    return {
      region: {
        background: s.backgroundColor,
        outlineStyle: s.outlineStyle,
        outlineColor: s.outlineColor,
        ruleColor: s.borderInlineStartColor,
      },
      note: { color: n.color, border: n.borderTopColor, background: n.backgroundColor },
      icon: {
        box: box(icon),
        borderWidth: i.borderTopWidth,
        borderStyle: i.borderTopStyle,
        borderColor: i.borderTopColor,
        hidden: icon.getAttribute('aria-hidden'),
        text: icon.textContent,
        shackle: {
          content: shackle.content,
          borderStyle: shackle.borderTopStyle,
          borderColor: shackle.borderTopColor,
        },
      },
      label: { text: label.textContent, box: box(label) },
      system: {
        canvas: probe('background-color', 'Canvas'),
        canvasText: probe('color', 'CanvasText'),
      },
      text: getComputedStyle(el.querySelector('p')!).color,
      forced: matchMedia('(forced-colors: active)').matches,
    };
  });
}

test.describe('PRM-026: regions the user cannot edit', () => {
  test('a region without edit is shaded and its indicator says who can edit it; an editable region has neither', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page);

    // Criterion 1: the restricted region is shaded and carries the indicator.
    const locked = region(page, 'Locked');
    await expect(locked).toHaveClass(/de-region-locked/);
    await expect(lock(page, 'Locked')).toBeVisible();
    await expect(lock(page, 'Locked').locator('.de-region-lock-label')).toHaveText('Read-only');
    // Criterion 2: the sentence names the grantees through the host's directory, over the region
    // list of the backend: Ada by the name the host gives, the group by the word for a group, and
    // the document role that may edit a restricted region by role alone.
    await expect(lock(page, 'Locked').locator('.de-region-lock-description')).toHaveText(WHO);
    const asked = await page.evaluate(() => window.__prm026!.asked.flat());
    expect(asked).toContain('ada');
    // Only user identifiers go to the directory: no group, no principal form, no content.
    expect(asked.every((id) => /^[a-z]+$/.test(id))).toBe(true);
    expect(asked).not.toContain('legal');

    // The region Bob may edit by his document role shows neither.
    const open = region(page, 'Open');
    await expect(open).not.toHaveClass(/de-region-locked/);
    await expect(lock(page, 'Open')).toHaveCount(0);
    await expect(page.locator(`${HOST} .de-region-lock`)).toHaveCount(1);

    // The shading is a background the open region does not have.
    const backgrounds = await page.evaluate(() => {
      const root = document.querySelector('doc-editor[data-test="prm026"]')!.shadowRoot!;
      const bg = (title: string) =>
        getComputedStyle(root.querySelector(`.de-region[data-title="${title}"]`)!).backgroundColor;
      return { locked: bg('Locked'), open: bg('Open') };
    });
    expect(backgrounds.locked).not.toBe(backgrounds.open);
    expect(backgrounds.locked).not.toBe('rgba(0, 0, 0, 0)');

    // The indicator is not document content, and typing in the region is still refused.
    expect(await harness<string>(page, 'nodeText', IDS.lockedPara)).toBe('Restricted text');
    expect(JSON.stringify(await harness(page, 'doc'))).not.toContain('Read-only');
    await locked.locator('p').click();
    await page.keyboard.type('x');
    expect(await harness<string>(page, 'nodeText', IDS.lockedPara)).toBe('Restricted text');
  });

  test('the names come from resolveUsers: a neutral word until the host answers, then its name', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, { hold: true });
    const description = lock(page, 'Locked').locator('.de-region-lock-description');
    // The directory has been asked and has not answered: no identifier is shown in its place.
    await expect(description).toHaveText(
      'It can be edited by Group and Collaborator, and by document owners.',
    );
    await expect.poll(() => page.evaluate(() => window.__prm026!.asked.flat())).toContain('ada');
    await expect(description).not.toContainText('ada');
    await page.evaluate(() => window.__prm026!.answer());
    await expect(description).toHaveText(WHO);
  });

  test('a host that sets resolveUsers after the editor has loaded gets its names on the indicator', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page, { late: true });
    const description = lock(page, 'Locked').locator('.de-region-lock-description');
    // No directory yet: the indicator is drawn at once, with the neutral word.
    await expect(description).toHaveText(
      'It can be edited by Group and Collaborator, and by document owners.',
    );
    expect(await page.evaluate(() => window.__prm026!.asked)).toEqual([]);
    // The host sets its callback (05 §8.1 lets it do so at any time): the name asked for before is
    // asked for again, and is not held as unknown for the rest of the session.
    await page.evaluate(() => window.__prm026!.setDirectory());
    await expect(description).toHaveText(WHO);
    expect(await page.evaluate(() => window.__prm026!.asked.flat())).toContain('ada');
  });

  test('the indicator has an icon and a text label as well as shading', async ({ page }) => {
    await openEmbed(page);
    await mount(page);
    await expect(lock(page, 'Locked').locator('.de-region-lock-description')).toHaveText(WHO);

    // Shading, an icon that is drawn, and a label in words.
    const normal = await look(page);
    expect(normal.forced).toBe(false);
    expect(normal.region.background).not.toBe('rgba(0, 0, 0, 0)');
    expect(normal.icon.hidden).toBe('true');
    expect(normal.icon.text).toBe('');
    expect(normal.icon.box.width).toBeGreaterThan(4);
    expect(normal.icon.box.height).toBeGreaterThan(4);
    expect(normal.icon.borderStyle).toBe('solid');
    expect(parseFloat(normal.icon.borderWidth)).toBeGreaterThan(0);
    expect(normal.icon.shackle.content).not.toBe('none');
    expect(normal.icon.shackle.borderStyle).toBe('solid');
    expect(normal.label.text).toBe('Read-only');
    expect(normal.label.box.width).toBeGreaterThan(20);
    await expect(lock(page, 'Locked').locator('.de-region-lock-label')).toBeVisible();
    // The icon and the words are drawn in the text colour of the page, so they stay readable.
    expect(normal.note.color).toBe(normal.text);
    expect(normal.icon.borderColor).toBe(normal.text);
  });

  test('under forced colours the region and its indicator use system colours', async ({
    page,
    browserName,
  }) => {
    // WebKit (Playwright) keeps the author colour in getComputedStyle under the emulation, so the
    // computed-colour checks below cannot show the system colour there (as in FE-019). Known gap.
    test.fixme(
      browserName === 'webkit',
      'WebKit computed colour stays the author colour under forced-colors emulation (FE-019 Notes)',
    );
    await openEmbed(page);
    await mount(page);
    await expect(lock(page, 'Locked').locator('.de-region-lock-description')).toHaveText(WHO);
    const normal = await look(page);
    await page.emulateMedia({ forcedColors: 'active' });
    await expect
      .poll(() => page.evaluate(() => matchMedia('(forced-colors: active)').matches))
      .toBe(true);
    const forced = await look(page);
    // The shading is gone, so the region is outlined, in the system's text colour.
    expect(forced.region.background).toBe(forced.system.canvas);
    expect(forced.region.outlineStyle).toBe('dashed');
    expect(forced.region.outlineColor).toBe(forced.system.canvasText);
    expect(forced.region.ruleColor).toBe(forced.system.canvasText);
    // The indicator: the system's text colour on the system's canvas, icon and border included.
    expect(forced.note.color).toBe(forced.system.canvasText);
    expect(forced.note.border).toBe(forced.system.canvasText);
    expect(forced.note.background).toBe(forced.system.canvas);
    expect(forced.icon.borderColor).toBe(forced.system.canvasText);
    expect(forced.icon.shackle.borderColor).toBe(forced.system.canvasText);
    // The icon and the words are still there, with the same size.
    expect(forced.icon.box).toEqual(normal.icon.box);
    expect(forced.label.text).toBe('Read-only');
    await expect(lock(page, 'Locked')).toBeVisible();
    await expect(lock(page, 'Locked').locator('.de-region-lock-description')).toHaveText(WHO);
  });

  test('perm.changed updates shading and indicators without a reload and without moving the selection', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page);
    await expect(lock(page, 'Locked').locator('.de-region-lock-description')).toHaveText(WHO);

    // A selection made with the keyboard inside the open region, which Bob may edit for now.
    await region(page, 'Open').locator('p').click();
    await page.keyboard.press('Home');
    for (let i = 0; i < 4; i++) await page.keyboard.press('Shift+ArrowRight');
    await expect.poll(() => harness<string>(page, 'selectedText')).toBe('Open');
    const selection = await harness<{ from: number; to: number }>(page, 'selection');
    await page.evaluate(() => {
      const root = document.querySelector('doc-editor[data-test="prm026"]')!.shadowRoot!;
      window.__prm026!.region = {
        open: root.querySelector('.de-region[data-title="Open"]')!,
        locked: root.querySelector('.de-region[data-title="Locked"]')!,
      };
    });
    const ready = (await events(page, 'de-ready')).length;
    const changes = (await events(page, 'de-permission-change')).length;

    // Someone else takes a lease on the open region, and Bob is granted the restricted one.
    await service(page, 'lease-open-to-ada');
    await service(page, 'grant-bob');
    await expect(region(page, 'Open')).toHaveClass(/de-region-locked/);
    await expect(region(page, 'Locked')).not.toHaveClass(/de-region-locked/);
    await expect(lock(page, 'Locked')).toHaveCount(0);
    await expect(lock(page, 'Open').locator('.de-region-lock-label')).toHaveText('Read-only');
    await expect(lock(page, 'Open').locator('.de-region-lock-description')).toContainText(
      'Ada Lovelace',
    );
    expect((await events(page, 'de-permission-change')).length).toBeGreaterThan(changes);

    // The selection is where it was: the same range in the document and the same text in the page.
    expect(await harness<{ from: number; to: number }>(page, 'selection')).toMatchObject({
      from: selection.from,
      to: selection.to,
    });
    expect(await harness<string>(page, 'selectedText')).toBe('Open');
    const after = await page.evaluate(() => {
      const host = document.querySelector('doc-editor[data-test="prm026"]')!;
      const root = host.shadowRoot!;
      const sel =
        (root as ShadowRoot & { getSelection?: () => Selection | null }).getSelection?.() ??
        document.getSelection();
      const kept = window.__prm026!.region;
      // The composed range, where the browser gives one, reads the selection inside the shadow root.
      // The method is asked for through an optional type: not every engine under test has it.
      const composed = (
        sel as { getComposedRanges?(o: { shadowRoots: ShadowRoot[] }): StaticRange[] } | null
      )?.getComposedRanges?.({ shadowRoots: [root] });
      const selectedText = (): string | null => {
        if (!sel) return null;
        if (!composed) return sel.toString();
        const [r] = composed;
        if (!r) return null;
        const range = document.createRange();
        range.setStart(r.startContainer, r.startOffset);
        range.setEnd(r.endContainer, r.endOffset);
        return range.toString();
      };
      return {
        focused: root.activeElement?.classList.contains('de-editing-surface') === true,
        selected: selectedText(),
        sameOpen: root.querySelector('.de-region[data-title="Open"]') === kept['open'],
        sameLocked: root.querySelector('.de-region[data-title="Locked"]') === kept['locked'],
      };
    });
    expect(after.focused).toBe(true);
    expect(after.selected).toBe('Open');
    // Nothing was reloaded: the same elements, one de-ready, no error.
    expect(after.sameOpen).toBe(true);
    expect(after.sameLocked).toBe(true);
    expect((await events(page, 'de-ready')).length).toBe(ready);
    expect(await events(page, 'de-error')).toEqual([]);

    // The lease ends: the open region is Bob's to edit again, and its indicator goes.
    await service(page, 'no-lease');
    await expect(region(page, 'Open')).not.toHaveClass(/de-region-locked/);
    await expect(page.locator(`${HOST} .de-region-lock`)).toHaveCount(0);
    expect(await harness<{ from: number; to: number }>(page, 'selection')).toMatchObject({
      from: selection.from,
      to: selection.to,
    });
  });

  test('assistive technology is told when the caret enters a region the user cannot edit, and who can edit it', async ({
    page,
  }) => {
    await openEmbed(page);
    await mount(page);
    await expect(lock(page, 'Locked').locator('.de-region-lock-description')).toHaveText(WHO);

    // The group is named by its title and described by its indicator.
    const locked = page.locator(`${HOST}`).getByRole('group', { name: 'Locked' });
    await expect(locked).toHaveAccessibleDescription(`Read-only ${WHO}`);
    await expect(lock(page, 'Locked')).toHaveRole('note');

    // The caret goes from the paragraph before the region into it with the keyboard.
    // In Firefox the caret was found at the start of the open region (not after "Between") in
    // about a third of the runs of this step in a Playwright v1.65.0 container (2 of 6, and 3 of 6
    // once more), so the whole movement is repeated until it ends in the locked region. A page
    // that builds the regions again after the click is a possible cause; it was not found.
    await expect(async () => {
      await page.locator(`${HOST} .de-editing-surface p`, { hasText: 'Between' }).click();
      await page.keyboard.press('End');
      await expect(status(page)).not.toContainText('cannot edit');
      await page.keyboard.press('ArrowRight');
      await expect(status(page)).toHaveText(`Locked: you cannot edit this part. ${WHO}`, {
        timeout: 2_000,
      });
    }).toPass({ timeout: 20_000 });
    // Focus stays in the document: the announcement is a live region, not a dialog.
    expect(
      await page.evaluate(
        () =>
          document
            .querySelector('doc-editor[data-test="prm026"]')!
            .shadowRoot!.activeElement?.classList.contains('de-editing-surface') === true,
      ),
    ).toBe(true);

    // Entering the region Bob may edit says nothing of the kind: the status bar names the region
    // the caret is in now, and the live region never says that Open cannot be edited.
    await region(page, 'Open').locator('p').click();
    await expect(page.locator(`${HOST} [data-status="scope"]`)).toHaveText('Region: Open');
    await expect(status(page)).not.toContainText('Open: you cannot edit');
  });

  test('axe reports nothing on a locked region or its indicator', async ({ page }) => {
    await openEmbed(page);
    await mount(page);
    await expect(lock(page, 'Locked').locator('.de-region-lock-description')).toHaveText(WHO);
    const results = await new AxeBuilder({ page }).include(HOST).analyze();
    const about = results.violations.filter((v) =>
      v.nodes.some((n) => /de-region/.test(n.html) || /de-region/.test(n.target.join(' '))),
    );
    expect(about.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
  });
});
