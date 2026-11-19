/**
 * WASM-011: the kernel gives the same results in every browser. The WebAssembly file of the package,
 * the TypeScript wrapper (`src/*.ts`, with its types removed by Node.js, so the code that runs is
 * the code of the package) and the harness's font files are served to a page of each browser; the
 * page starts the kernel, loads the faces by hash, and recomputes what `golden/reference.json`
 * holds, which Node.js recorded (`packages/perf/test/wasm-010-kernel-node.test.ts`):
 *
 * - the advances of fixed lines in every face, at four sizes and two settings of language and
 *   features (656 cases);
 * - for each of 666 paragraphs of the shared corpus (`pages-1`, `form-fields`, `pages-20`): the
 *   checksum of each run's advances, and the lines (starts, ends, positions, widths, spacing).
 *
 * Any difference, to the unit, fails the run. The break opportunities of a paragraph are an input of
 * the kernel (UAX #14 from `linebreak` 1.1.0), so they are the same everywhere by construction; the
 * kernel does not find them yet (WASM-007).
 *
 * Needs the build (`pnpm --filter @docedit/layout-kernel build:wasm`).
 */
import { expect, test } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const pkg = fileURLToPath(new URL('..', import.meta.url));
const dist = join(pkg, 'dist');
const fontFolder = join(pkg, '../perf/fonts');

interface Golden {
  abi: number;
  faces: Array<{ file: string; sha256: string }>;
  shaping: Array<{
    face: string;
    sizeTwips: number;
    language: string;
    features: string;
    text: string;
    advances: number[];
  }>;
  paragraphs: Record<
    string,
    Array<{ id: string; input: unknown; runChecksums: number[]; lines: unknown[] }>
  >;
}
const golden = JSON.parse(readFileSync(join(pkg, 'golden/reference.json'), 'utf8')) as Golden;

const ORIGIN = 'https://kernel.test';

test('the kernel gives, in this browser, what Node.js recorded for every advance and every line', async ({
  page,
  browserName,
}, info) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const file = (path: string, type: string): Promise<void> =>
      route.fulfill({ status: 200, contentType: type, body: readFileSync(path) });
    if (pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    if (pathname.startsWith('/src/') && pathname.endsWith('.ts'))
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: stripTypeScriptTypes(readFileSync(join(pkg, 'src', basename(pathname)), 'utf8')),
      });
    if (pathname.startsWith('/dist/'))
      return file(
        join(dist, basename(pathname)),
        pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      );
    if (pathname.startsWith('/fonts/'))
      return file(join(fontFolder, pathname.slice('/fonts/'.length)), 'application/octet-stream');
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/`);

  const result = await page.evaluate(
    async ({ faces, shaping, paragraphs }) => {
      const wrapper = (await import(`${location.origin}/src/index.ts`)) as {
        createKernel(glue: unknown, wasm: Uint8Array): Kernel;
      };
      interface Kernel {
        abi: number;
        sha256(data: Uint8Array): string;
        checksum(data: Uint8Array): number;
        faces: { load(owner: string, alias: string, sha: string, bytes: Uint8Array): string };
        shaper: {
          advances(style: unknown, text: string): Int32Array;
          breakParagraph(input: unknown): unknown[];
        };
      }
      const glue = await import(`${location.origin}/dist/docedit_layout_kernel.js`);
      const wasm = new Uint8Array(
        await (await fetch(`${location.origin}/dist/docedit_layout_kernel_bg.wasm`)).arrayBuffer(),
      );
      const kernel = wrapper.createKernel(glue, wasm);
      for (const face of faces) {
        const bytes = new Uint8Array(
          await (await fetch(`${location.origin}/fonts/${face.file}`)).arrayBuffer(),
        );
        kernel.faces.load('', `de-font-${face.sha256}`, face.sha256, bytes);
      }
      const bad: string[] = [];
      let shapingChecked = 0;
      for (const c of shaping) {
        const got = Array.from(
          kernel.shaper.advances(
            {
              alias: `de-font-${c.face}`,
              sizeTwips: c.sizeTwips,
              language: c.language,
              features: c.features,
            },
            c.text,
          ),
        );
        shapingChecked++;
        if (JSON.stringify(got) !== JSON.stringify(c.advances) && bad.length < 20)
          bad.push(
            `advances ${c.face.slice(0, 8)} ${c.sizeTwips} ${c.language}/${c.features} ${c.text}`,
          );
      }
      let paragraphsChecked = 0;
      let linesChecked = 0;
      for (const [name, list] of Object.entries(paragraphs)) {
        for (const [i, p] of list.entries()) {
          const input = p.input as {
            text: string;
            runs: Array<{
              length: number;
              alias: string;
              sizeTwips: number;
              language: string;
              features: string;
              boxWidth?: number;
            }>;
          };
          let at = 0;
          const sums: number[] = [];
          for (const run of input.runs) {
            const text = input.text.slice(at, at + run.length);
            at += run.length;
            if (run.boxWidth !== undefined) {
              sums.push(-1);
              continue;
            }
            const advances = kernel.shaper.advances(run, text);
            sums.push(
              kernel.checksum(
                new Uint8Array(advances.buffer, advances.byteOffset, advances.byteLength),
              ),
            );
          }
          if (JSON.stringify(sums) !== JSON.stringify(p.runChecksums) && bad.length < 20)
            bad.push(`advances of ${name} paragraph ${i} (${p.id})`);
          const lines = kernel.shaper.breakParagraph(input);
          if (JSON.stringify(lines) !== JSON.stringify(p.lines) && bad.length < 20)
            bad.push(`lines of ${name} paragraph ${i} (${p.id})`);
          paragraphsChecked++;
          linesChecked += lines.length;
        }
      }
      return { abi: kernel.abi, bad, shapingChecked, paragraphsChecked, linesChecked };
    },
    { faces: golden.faces, shaping: golden.shaping, paragraphs: golden.paragraphs },
  );

  expect(result.abi).toBe(golden.abi);
  expect(result.bad, 'differences from the Node.js reference').toEqual([]);
  expect(result.shapingChecked).toBe(golden.shaping.length);
  expect(result.paragraphsChecked).toBe(
    Object.values(golden.paragraphs).reduce((n, list) => n + list.length, 0),
  );
  await info.attach(`wasm-011-${browserName}.json`, {
    contentType: 'application/json',
    body: JSON.stringify({
      browser: browserName,
      version: page.context().browser()?.version(),
      checked: {
        advanceCases: result.shapingChecked,
        paragraphs: result.paragraphsChecked,
        lines: result.linesChecked,
      },
    }),
  });
});
