/**
 * FND-008: parts of the editing core load on first use (engine `src/parts.ts`), in the library
 * build the pages are served from (`pages/lib.html` loads `/lib/doc-editor.js` by URL, as a host
 * does). The rules language and the checks of the roles, sources and fields panes are not in the
 * first load. A document with no rule never fetches the rules language; opening the roles pane
 * fetches the authoring checks and the rules pane the rules language, and each pane then works; a
 * document with a rule has the language before it is drawn, so its fields are never shown against
 * the rules.
 *
 * A part is recognised by a string that only its chunk holds (a problem code of the rules language,
 * and an invariant message of the model's validator), in the scripts under `/lib/`: the page's own
 * script holds the in-memory backend, which has both. Run from the repository root with
 * `pnpm exec playwright test -c packages/element/playwright.config.ts e2e/fnd-008-lazy-parts.spec.ts`.
 */
import { type Page, expect, test } from '@playwright/test';
import { openLib } from './embed-helpers.ts';
import { editorOf, openPaneBySearch } from './frw-helpers.ts';

const MARKERS = { rules: 'unknown_operator', authoring: 'extension_envelope' } as const;
const LANDLORD_NAME = 'fLandlord0000001';

/** Counts the library's scripts that hold each part's marker. */
function watchParts(page: Page): { seen: () => Promise<{ rules: number; authoring: number }> } {
  const counts = { rules: 0, authoring: 0 };
  const pending: Array<Promise<void>> = [];
  page.on('response', (response) => {
    if (response.request().resourceType() !== 'script') return;
    if (!new URL(response.url()).pathname.startsWith('/lib/')) return;
    pending.push(
      response
        .text()
        .then((body) => {
          if (body.includes(MARKERS.rules)) counts.rules++;
          if (body.includes(MARKERS.authoring)) counts.authoring++;
        })
        .catch(() => undefined),
    );
  });
  return {
    seen: async () => {
      await Promise.all(pending);
      return { ...counts };
    },
  };
}

/** Mounts `<doc-editor data-test="one">` on the document the library page names `docKey`. */
async function mount(page: Page, docKey: 'fieldsDocId' | 'rulesDocId'): Promise<void> {
  await page.evaluate(async (key) => {
    interface Lib {
      load(): Promise<unknown>;
      backendFor(sub: string, docIds: string[]): unknown;
      fieldsDocId: string;
      rulesDocId: string;
    }
    const lib = (window as unknown as { __lib: Lib }).__lib;
    await lib.load();
    const docId = lib[key];
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
    el.backend = lib.backendFor('bob', [docId]);
    el.setAttribute('doc-id', docId);
    document.body.append(el);
    await ready;
  }, docKey);
  await expect(page.locator(`${editorOf('one')} .de-editing-surface`)).toBeVisible();
}

test.describe('FND-008 parts of the editing core load on first use', () => {
  test('a document without rules fetches neither part; each pane fetches its own and works', async ({
    page,
  }) => {
    const parts = watchParts(page);
    await openLib(page);
    await mount(page, 'fieldsDocId');
    // The form document has fields, roles and no rule: nothing of the two parts is fetched.
    expect(await parts.seen()).toEqual({ rules: 0, authoring: 0 });

    // The roles pane loads the authoring checks, and lists the roles without the rules language.
    const roles = await openPaneBySearch(page, 'one', 'Roles', 'roles');
    await expect(roles.locator('[data-roles="list"] > li')).toHaveCount(2);
    expect(await parts.seen()).toEqual({ rules: 0, authoring: 1 });

    // The rules pane loads the rules language, and lists the document's rules (none).
    const rules = await openPaneBySearch(page, 'one', 'Rules', 'rules');
    await expect(rules).toBeVisible();
    expect(await parts.seen()).toEqual({ rules: 1, authoring: 1 });
  });

  test('a document with a rule has the rules language before it is drawn', async ({ page }) => {
    const parts = watchParts(page);
    await openLib(page);
    await mount(page, 'rulesDocId');
    // The rules language is there and the authoring checks are not.
    expect(await parts.seen()).toEqual({ rules: 1, authoring: 0 });
    // The rule is applied at once: the tenant's name is empty, so the landlord's field is hidden.
    const field = page.locator(`${editorOf('one')} .de-form-field[data-field="${LANDLORD_NAME}"]`);
    await expect(field).toHaveAttribute('data-hidden', 'true');
    await expect(field).toBeHidden();
    // The tenant's own fields are drawn.
    await expect(
      page.locator(`${editorOf('one')} .de-form-field[data-field="fName00000000001"]`),
    ).toBeVisible();
  });
});
