/**
 * UX-062, criterion 3, in part (lane w3): where the shell carries a meaning by colour, a cue that is
 * not colour remains under forced colours and in the high-contrast theme. Checked on the surfaces the
 * shell has: presence in the header (idle people have a dashed outline and the word "idle"), the
 * roles of a grant (each has its own shape and its name in text) and the state of a region (an
 * icon and the state in words) and the kinds of suggestion in the review pane (UX-037), each named
 * in words in the row and in its accessible name.
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/ui/playwright.config.ts ux-062-non-colour-cues`.
 */
import type { Page } from '@playwright/test';
import type { RegionRole } from '../src/core-api.ts';
import { expect, open, test } from './helpers.ts';

const STATES = ['draft', 'in_review', 'approved'] as const;
const REGIONS = STATES.map((state, order) => ({
  id: `r${order + 1}`,
  title: `Part ${order + 1}`,
  policy: 'restricted' as const,
  order,
  state,
  editors: { roles: ['owner'], principals: ['user:u1'] },
}));
const OWNER = {
  rev: 3,
  docRole: 'owner',
  caps: ['view', 'comment', 'suggest', 'edit', 'structure', 'manage'],
  scopes: {
    body: ['view', 'comment', 'suggest', 'edit'],
    'region:r1': ['view', 'comment', 'suggest', 'edit'],
  },
};
const ROLES: ReadonlyArray<readonly [RegionRole, string]> = [
  ['viewer', 'user:u1'],
  ['commenter', 'user:u9'],
  ['suggester', 'group:legal'],
  ['editor', 'user:u7'],
];

type Environment = 'forced-colors' | 'high-contrast' | 'both';

async function enter(page: Page, environment: Environment): Promise<'high-contrast' | 'light'> {
  if (environment !== 'high-contrast') await page.emulateMedia({ forcedColors: 'active' });
  return environment === 'forced-colors' ? 'light' : 'high-contrast';
}

for (const environment of ['forced-colors', 'high-contrast', 'both'] as const) {
  test.describe(`non-colour cues under ${environment} (UX-062 criterion 3)`, () => {
    test('presence: idle people have a dashed outline and the word idle', async ({ page }) => {
      const theme = await enter(page, environment);
      await open(page, {
        theme,
        features: ['presence'],
        presence: [
          { session: 's1', user: 'u1', status: 'active' as const },
          { session: 's2', user: 'u2', status: 'idle' as const },
        ],
      });
      if (environment !== 'high-contrast')
        expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
      const names = page
        .getByRole('list', { name: 'People in this document' })
        .locator('.de-person > .de-visually-hidden');
      await expect(names).toHaveText(['Ada Lovelace', 'Grace Hopper, idle']);
      const borders = await page
        .locator('.de-avatars .de-avatar')
        .evaluateAll((els) => els.map((el) => getComputedStyle(el).borderTopStyle));
      expect(borders).toEqual(['solid', 'dashed']);
    });

    test('roles: each has its own shape and its name in text', async ({ page }) => {
      const theme = await enter(page, environment);
      const h = await open(page, {
        theme,
        extended: true,
        regions: REGIONS,
        permissions: OWNER,
        grants: ROLES.map(([role, principal]) => ({ region: 'r1', principal, role })),
      });
      await h.exec('view.permissions');
      const pane = page.locator('.de-pane[data-pane="permissions"]');
      await pane.locator('[data-region="r1"]').getByRole('button').click();
      const shapes: string[] = [];
      for (const [role, principal] of ROLES) {
        const grant = pane.locator(`.de-grant[data-principal="${principal}"]`);
        await expect(grant.locator('.de-role')).toContainText(new RegExp(role, 'i'));
        const mark = grant.locator('.de-role-mark');
        const box = await mark.boundingBox();
        expect(box?.width, `${role} mark is drawn`).toBeGreaterThan(0);
        shapes.push(
          await mark.evaluate((el) => {
            const s = getComputedStyle(el);
            // The editor's mark is filled; the others are outlines of different shapes.
            const filled = s.backgroundColor !== 'rgba(0, 0, 0, 0)';
            return `${s.borderRadius}|${s.transform}|${filled}`;
          }),
        );
      }
      expect(new Set(shapes).size).toBe(ROLES.length);
    });

    test('review pane: each kind of suggestion is named in words', async ({ page }) => {
      const theme = await enter(page, environment);
      const h = await open(page, { theme, extended: true, review: true });
      const base = {
        block: false,
        user: 'u1',
        caps: ['view', 'comment', 'suggest', 'edit'],
        canResolve: true,
      } as const;
      await h.setReviewItems([
        { ...base, id: 's1', kind: 'ins', from: 10, to: 15, text: 'added' },
        { ...base, id: 's2', kind: 'del', from: 30, to: 35, text: 'removed' },
        { ...base, id: 's3', kind: 'fmt', from: 50, to: 55, text: 'styled' },
        { ...base, id: 's4', kind: 'del', block: true, from: 70, to: 75, text: 'a block' },
      ]);
      expect(await h.exec('view.review')).toEqual({ ran: true, reason: null });
      const pane = page.locator('.de-pane[data-pane="review"]');
      await expect(pane).toBeVisible();
      if (environment !== 'high-contrast')
        expect(await page.evaluate(() => matchMedia('(forced-colors: active)').matches)).toBe(true);
      // The kind is a word in the row, drawn with a size, and the four words differ: no kind is told
      // apart by colour alone.
      const words: string[] = [];
      for (const id of ['s1', 's2', 's3', 's4']) {
        const kind = pane.locator(`li[data-suggestion="${id}"] .de-review-kind`);
        const box = await kind.boundingBox();
        expect(box?.width, `${id} kind is drawn`).toBeGreaterThan(0);
        words.push((await kind.innerText()).trim());
      }
      expect(words).toEqual(['Insertion', 'Deletion', 'Formatting change', 'Block change']);
      expect(new Set(words).size).toBe(4);
      // The word is also in the row's accessible name, so a screen reader hears the kind.
      for (const [id, word] of [
        ['s1', 'Insertion'],
        ['s2', 'Deletion'],
        ['s3', 'Formatting change'],
        ['s4', 'Block change'],
      ] as const)
        expect(
          await pane
            .locator(`li[data-suggestion="${id}"] .de-review-head`)
            .getAttribute('aria-label'),
        ).toContain(word);
    });

    test('region states: each has its own icon and its name in words', async ({ page }) => {
      const theme = await enter(page, environment);
      const h = await open(page, {
        theme,
        extended: true,
        regions: REGIONS,
        permissions: OWNER,
        grants: [],
      });
      await h.exec('view.permissions');
      const pane = page.locator('.de-pane[data-pane="permissions"]');
      const cues: string[] = [];
      for (const region of REGIONS) {
        const row = pane.locator(`[data-region="${region.id}"]`);
        const icon = (await row.locator('.de-badge-icon').innerText()).trim();
        const words = (await row.innerText()).replace(icon, '').trim();
        expect(icon, `${region.state} has an icon`).not.toBe('');
        expect(words.length, `${region.state} has words`).toBeGreaterThan(0);
        cues.push(icon);
      }
      expect(new Set(cues).size).toBe(STATES.length);
    });
  });
}
