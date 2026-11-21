/**
 * PRM-006 criterion 5 in the real `<doc-editor>` (lane w9): when `perm.changed` arrives, the
 * component raises `de-permission-change` with the complete `access` object, and the shading of the
 * regions the user cannot edit (PRM-026) follows it without a reload.
 *
 * The page is the embed page (demo/embed-page.ts) with its in-memory backend, which runs the real
 * room and bridge. Bob, an editor, opens the spike document: its restricted region "Legal review" is
 * granted to Ada only, so it is shaded for him. The grants are then changed through the service, as
 * the control plane changes them, and the room sends `perm.changed`.
 *
 * Run with `DOCEDIT_DEMO_PORT=56560 pnpm exec playwright test -c packages/element/playwright.config.ts
 * packages/element/e2e/prm-006-shading-follows-access.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { events, mountEditor, openEmbed } from './embed-helpers.ts';

const REGION = 'rLegal0000000001';
const SCOPE = `region:${REGION}`;

interface Access {
  rev: number;
  asOfSeq: number;
  docRole: string;
  caps: string[];
  scopes: Record<string, string[]>;
  leases: Record<string, unknown>;
  restrictions: string[];
}

interface RegionLook {
  locked: boolean;
  indicator: string | null;
  background: string;
  /** Whether the region's element is the one the test kept before the change. */
  same: boolean;
}

/** How the region is drawn now, read in the editor's shadow root. */
function look(page: Page): Promise<RegionLook> {
  return page.evaluate(() => {
    const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
    const el = root.querySelector<HTMLElement>('.de-region[data-title="Legal review"]')!;
    const w = window as unknown as { __prm006?: { region: HTMLElement } };
    return {
      locked: el.classList.contains('de-region-locked'),
      indicator: el.querySelector('.de-region-lock')?.textContent ?? null,
      background: getComputedStyle(el).backgroundColor,
      same: w.__prm006?.region === el,
    };
  });
}

/** Replaces the region's grants through the service: Ada always, Bob when `bob` is set. */
function setGrants(page: Page, bob: boolean): Promise<void> {
  return page.evaluate(
    ({ region, bob }) => {
      const e = (
        window as unknown as {
          __embed: {
            service: { setGrants(docId: string, grants: unknown[]): void };
            docId: string;
          };
        }
      ).__embed;
      e.service.setGrants(e.docId, [
        { region, principal: 'user:ada', role: 'editor' },
        ...(bob ? [{ region, principal: 'user:bob', role: 'editor' }] : []),
      ]);
    },
    { region: REGION, bob },
  );
}

const accesses = async (page: Page): Promise<Access[]> =>
  (await events(page, 'de-permission-change')).map((e) => e.detail as Access);

test('PRM-006: perm.changed raises de-permission-change and the shading follows without a reload', async ({
  page,
}) => {
  await openEmbed(page);
  await mountEditor(page, { sub: 'bob', role: 'editor' });

  // The access of ch.opened was raised once, and the region is shaded for Bob.
  await expect.poll(async () => (await accesses(page)).length).toBe(1);
  const opened = (await accesses(page))[0]!;
  expect(opened.scopes[SCOPE]).not.toContain('edit');
  await expect.poll(async () => (await look(page)).locked).toBe(true);
  const shaded = await look(page);
  expect(shaded.indicator).toContain('Read-only');

  // What must survive the change: the page, the element and the region's own element.
  await page.evaluate(() => {
    const root = document.querySelector('doc-editor[data-test="one"]')!.shadowRoot!;
    (window as unknown as { __prm006: unknown }).__prm006 = {
      region: root.querySelector('.de-region[data-title="Legal review"]'),
    };
  });
  const readyBefore = (await events(page, 'de-ready')).length;

  // The grant: perm.changed reaches the component.
  await setGrants(page, true);
  await expect.poll(async () => (await accesses(page)).length).toBe(2);
  const granted = (await accesses(page))[1]!;
  // The event carries the complete access object of 05 §5.5, with a higher revision.
  expect(granted.rev).toBeGreaterThan(opened.rev);
  expect(granted.asOfSeq).toBeGreaterThanOrEqual(opened.asOfSeq);
  expect(granted.docRole).toBe('editor');
  expect(granted.caps).toEqual(expect.arrayContaining(['view', 'comment', 'suggest', 'edit']));
  expect(granted.scopes[SCOPE]).toContain('edit');
  expect(granted.scopes['body']).toContain('edit');
  expect(granted.leases).toEqual({});
  expect(granted.restrictions).toEqual([]);
  // The shading and the indicator are gone, in the same element of the same page.
  await expect.poll(async () => (await look(page)).locked).toBe(false);
  const open = await look(page);
  expect(open.indicator).toBeNull();
  expect(open.background).not.toBe(shaded.background);
  expect(open.same).toBe(true);

  // The grant is taken back: the next perm.changed shades the region again.
  await setGrants(page, false);
  await expect.poll(async () => (await accesses(page)).length).toBe(3);
  const revoked = (await accesses(page))[2]!;
  expect(revoked.rev).toBeGreaterThan(granted.rev);
  expect(revoked.scopes[SCOPE]).not.toContain('edit');
  await expect.poll(async () => (await look(page)).locked).toBe(true);
  const again = await look(page);
  expect(again.indicator).toContain('Read-only');
  expect(again.background).toBe(shaded.background);
  expect(again.same).toBe(true);

  // Nothing was reloaded: one de-ready, no error, and the page still holds what the test put on it.
  expect((await events(page, 'de-ready')).length).toBe(readyBefore);
  expect(await events(page, 'de-error')).toEqual([]);
  expect(await page.evaluate(() => '__prm006' in window)).toBe(true);
});
