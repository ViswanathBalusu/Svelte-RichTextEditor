/**
 * WASM-016 criteria 2 and 3 in each browser: the module of Thai, Lao, Khmer and Burmese is fetched
 * only when a document uses one of the scripts, and its answer is the Node.js answer. The page uses
 * the package's own wrapper (`src/southeast-asian.ts`) and the build of `dist/sea/`.
 *
 * Needs the build (`pnpm --filter @docedit/layout-kernel build:wasm`).
 */
import { expect, test } from '@playwright/test';
import { openKernelPage, ORIGIN } from './kernel-page.ts';

test('the dictionary module is fetched only for a document that uses the scripts, and breaks the words', async ({
  page,
  browserName,
}, info) => {
  const fetched: string[] = [];
  page.on('request', (request) => {
    const { pathname } = new URL(request.url());
    if (pathname.startsWith('/dist/')) fetched.push(pathname);
  });
  await openKernelPage(page);

  const result = await page.evaluate(async () => {
    const sea = (await import(`${location.origin}/src/southeast-asian.ts`)) as {
      lazySoutheastAsian(load: () => Promise<unknown>): {
        loaded: boolean;
        ensure(texts: string[]): Promise<boolean>;
        segmenter(base: unknown): { opportunities(text: string): number[] };
      };
      startSoutheastAsian(glue: unknown, source: unknown): Promise<unknown>;
    };
    const kernelPkg = (await import(`${location.origin}/src/index.ts`)) as {
      createKernel(glue: unknown, wasm: Uint8Array): { segmenter: unknown };
    };
    const kernelGlue = await import(`${location.origin}/dist/docedit_layout_kernel.js`);
    const kernelWasm = new Uint8Array(
      await (await fetch(`${location.origin}/dist/docedit_layout_kernel_bg.wasm`)).arrayBuffer(),
    );
    const kernel = kernelPkg.createKernel(kernelGlue, kernelWasm);

    const lazy = sea.lazySoutheastAsian(async () => {
      const glue = await import(`${location.origin}/dist/sea/docedit_sea_segmenter.js`);
      const response = await fetch(`${location.origin}/dist/sea/docedit_sea_segmenter_bg.wasm`);
      return sea.startSoutheastAsian(glue, response);
    });
    const segmenter = lazy.segmenter(kernel.segmenter);

    const noScripts = await lazy.ensure(['Hello world', '日本語のテキスト', '한국어 문장']);
    const loadedBefore = lazy.loaded;
    const before = segmenter.opportunities('ฉันกินข้าว');
    const needed = await lazy.ensure(['Hello', 'ฉันกินข้าว']);
    const after: Record<string, number[]> = {};
    for (const text of ['ฉันกินข้าว', 'ຂ້ອຍກິນເຂົ້າ', 'ខ្ញុំញុំាបាយ', 'ကျွန်တော်ထမင်းစားတယ်'])
      after[text] = segmenter.opportunities(text);
    return { noScripts, loadedBefore, before, needed, after, loadedAfter: lazy.loaded };
  });

  expect(result.noScripts).toBe(false);
  expect(result.loadedBefore).toBe(false);
  expect(result.before).toEqual([]);
  expect(result.needed).toBe(true);
  expect(result.loadedAfter).toBe(true);
  expect(result.after).toEqual({
    ฉันกินข้าว: [3, 6],
    ຂ້ອຍກິນເຂົ້າ: [4],
    ខ្ញុំញុំាបាយ: [5, 9],
    ကျွန်တော်ထမင်းစားတယ်: [9, 17],
  });
  // The module's two files are asked for once, and only after the document needed them.
  expect(fetched.filter((p) => p.startsWith('/dist/sea/')).sort()).toEqual([
    '/dist/sea/docedit_sea_segmenter.js',
    '/dist/sea/docedit_sea_segmenter_bg.wasm',
  ]);
  expect(ORIGIN).toBe('https://kernel.test');
  await info.attach(`wasm-016-${browserName}.json`, {
    contentType: 'application/json',
    body: JSON.stringify({
      browser: browserName,
      version: page.context().browser()?.version(),
      seaFetches: fetched.filter((p) => p.startsWith('/dist/sea/')).length,
    }),
  });
});
