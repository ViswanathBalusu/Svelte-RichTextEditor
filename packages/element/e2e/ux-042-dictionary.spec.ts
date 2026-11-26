/**
 * Custom dictionaries through the product (UX-042 criterion 3; 13 §6.1; owner decision 34): the real
 * `<doc-editor>` with a stand-in proofing port that keeps two dictionaries, the person's and the
 * tenant's, flags a word of the document unless a dictionary holds it, and refuses a change of the
 * tenant's list to anyone who is not an administrator. A word added in the language dialog stops
 * being flagged in the next check, and comes back when it is removed; a port without the list and
 * remove members gets no dictionary control. No real proofing service ships (UX-043 is a spike).
 * Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts packages/element/e2e/ux-042-dictionary.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openEmbed } from './embed-helpers.ts';

const editor = 'doc-editor[data-test="one"]';
const flagged = (page: Page) =>
  page.locator(`${editor} .de-editing-surface [data-de-finding]`, { hasText: 'Remote' });

async function mount(page: Page, dictionary: boolean): Promise<void> {
  await page.evaluate(async (withDictionary) => {
    const e = (
      window as unknown as {
        __embed: { backend(sub: string, role: string): object; docId: string };
      }
    ).__embed;
    const user = new Set<string>();
    const shared = new Set<string>();
    const port: Record<string, unknown> = {
      check(request: { blocks: { blockId: string; text: string }[] }) {
        const found: unknown[] = [];
        for (const b of request.blocks) {
          const at = b.text.indexOf('Remote');
          if (at !== -1 && !user.has('Remote') && !shared.has('Remote'))
            found.push({
              blockId: b.blockId,
              from: at,
              to: at + 6,
              kind: 'spelling',
              message: 'Unknown word',
              suggestions: ['Remove'],
            });
        }
        return Promise.resolve(found);
      },
      addWord(word: string, _lang: string, opts?: { scope?: string }) {
        if (opts?.scope === 'tenant') return Promise.reject(new Error('forbidden'));
        user.add(word);
        return Promise.resolve();
      },
    };
    if (withDictionary) {
      port['listWords'] = () =>
        Promise.resolve([
          ...[...user].map((word) => ({ word, scope: 'user', removable: true })),
          ...[...shared].map((word) => ({ word, scope: 'tenant', removable: false })),
        ]);
      port['removeWord'] = (word: string) => {
        user.delete(word);
        return Promise.resolve();
      };
    }
    const el = document.createElement('doc-editor') as HTMLElement & { backend: unknown };
    el.dataset['test'] = 'one';
    const ready = new Promise<void>((resolve, reject) => {
      el.addEventListener('de-ready', () => resolve(), { once: true });
      el.addEventListener(
        'de-error',
        (ev) => reject(new Error(JSON.stringify((ev as CustomEvent).detail))),
        { once: true },
      );
    });
    const backend = e.backend('ada', 'editor');
    el.backend = new Proxy(backend, {
      get: (target, key) => {
        if (key === 'proofing') return port;
        const value = Reflect.get(target, key, target) as unknown;
        return typeof value === 'function'
          ? (value as (...a: unknown[]) => unknown).bind(target)
          : value;
      },
    });
    el.setAttribute('doc-id', e.docId);
    document.getElementById('mount')!.append(el);
    await ready;
  }, dictionary);
}

function exec(page: Page, command: string): Promise<unknown> {
  return page.evaluate(
    (c) =>
      (
        document.querySelector('doc-editor[data-test="one"]') as unknown as {
          exec(c: string): unknown;
        }
      ).exec(c),
    command,
  );
}

test('a word added to the dictionary is honoured by the next check, and removing it brings the finding back (UX-042 criterion 3)', async ({
  page,
}) => {
  await openEmbed(page);
  await mount(page, true);
  await expect(flagged(page).first()).toBeVisible();

  expect(await exec(page, 'format.language')).toMatchObject({ ok: true });
  const section = page.locator(`${editor} [data-dictionary]`);
  await expect(section).toBeVisible();
  await expect(section.locator('[data-entry]')).toHaveCount(0);

  // The person's own list.
  await section.getByLabel('Word to add').fill('Remote');
  await section.getByRole('button', { name: 'Add word' }).click();
  await expect(section.locator('[data-entry="Remote"]')).toContainText('yours');
  await expect(flagged(page)).toHaveCount(0);

  // The shared list belongs to an administrator: this port refuses, and the dialog says so.
  await section.getByLabel('Word to add').fill('Acme');
  await section.getByLabel('Add it to').selectOption('tenant');
  await section.getByRole('button', { name: 'Add word' }).click();
  await expect(section.getByRole('alert')).toContainText('Only an administrator');
  await expect(section.locator('[data-entry="Acme"]')).toHaveCount(0);

  await section.getByRole('button', { name: 'Remove Remote' }).click();
  await expect(section.locator('[data-entry="Remote"]')).toHaveCount(0);
  await expect(flagged(page).first()).toBeVisible();
});

test('a port without list and remove has no dictionary control (UX-042 criterion 3)', async ({
  page,
}) => {
  await openEmbed(page);
  await mount(page, false);
  await expect(flagged(page).first()).toBeVisible();
  expect(await exec(page, 'format.language')).toMatchObject({ ok: true });
  await expect(page.getByRole('dialog', { name: 'Language of the selected text' })).toBeVisible();
  await expect(page.locator(`${editor} [data-dictionary]`)).toHaveCount(0);
});
