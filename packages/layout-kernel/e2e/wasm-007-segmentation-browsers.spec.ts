/**
 * WASM-007: the Unicode conformance files run through the kernel in each browser. The page is given
 * the build, the package's wrapper and the two files of `crates/layout-kernel/tests/data/`
 * (`LineBreakTest.txt` of Unicode 15.0.0 and `GraphemeBreakTest.txt` of 17.0.0), and checks every
 * case. The answer must be the Node.js answer: every case of both files passes.
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
const data = join(pkg, '../../crates/layout-kernel/tests/data');
const ORIGIN = 'https://kernel.test';

test('the Unicode line break and grapheme break test files pass, every case, in this browser', async ({
  page,
  browserName,
}, info) => {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    if (pathname === '/')
      return route.fulfill({ contentType: 'text/html', body: '<!doctype html>' });
    if (pathname.startsWith('/src/') && pathname.endsWith('.ts'))
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: stripTypeScriptTypes(readFileSync(join(pkg, 'src', basename(pathname)), 'utf8')),
      });
    if (pathname.startsWith('/dist/'))
      return route.fulfill({
        status: 200,
        contentType: pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
        body: readFileSync(join(dist, basename(pathname))),
      });
    if (pathname.startsWith('/data/'))
      return route.fulfill({
        status: 200,
        contentType: 'text/plain; charset=utf-8',
        body: readFileSync(join(data, pathname.slice('/data/'.length))),
      });
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/`);

  const result = await page.evaluate(async () => {
    const wrapper = (await import(`${location.origin}/src/index.ts`)) as {
      createKernel(glue: unknown, wasm: Uint8Array): Kernel;
    };
    interface Kernel {
      segmenter: {
        unicode: { lineBreak: string; grapheme: string };
        lineBreaks(text: string): Array<{ offset: number }>;
        graphemeBoundaries(text: string): number[];
      };
    }
    const glue = await import(`${location.origin}/dist/docedit_layout_kernel.js`);
    const wasm = new Uint8Array(
      await (await fetch(`${location.origin}/dist/docedit_layout_kernel_bg.wasm`)).arrayBuffer(),
    );
    const kernel = wrapper.createKernel(glue, wasm);
    const cases = async (path: string) => {
      const out: Array<{ line: number; text: string; breaks: number[] }> = [];
      const body = await (await fetch(`${location.origin}/data/${path}`)).text();
      body.split('\n').forEach((raw, index) => {
        const line = raw.split('#')[0]!.trim();
        if (line === '') return;
        let text = '';
        const breaks: number[] = [];
        for (const token of line.split(/\s+/)) {
          if (token === '÷') breaks.push(text.length);
          else if (token !== '×') text += String.fromCodePoint(Number.parseInt(token, 16));
        }
        out.push({ line: index + 1, text, breaks });
      });
      return out;
    };
    const lineCases = await cases('unicode-15.0.0/LineBreakTest.txt');
    const graphemeCases = await cases('unicode-17.0.0/GraphemeBreakTest.txt');
    const lineFailures = lineCases
      .filter(
        (c) =>
          kernel.segmenter
            .lineBreaks(c.text)
            .map((b) => b.offset)
            .join() !== c.breaks.filter((o) => o > 0).join(),
      )
      .map((c) => c.line);
    const graphemeFailures = graphemeCases
      .filter((c) => kernel.segmenter.graphemeBoundaries(c.text).join() !== c.breaks.join())
      .map((c) => c.line);
    return {
      unicode: kernel.segmenter.unicode,
      lineCases: lineCases.length,
      graphemeCases: graphemeCases.length,
      lineFailures,
      graphemeFailures,
    };
  });

  expect(result.unicode).toEqual({ lineBreak: '15.0.0', grapheme: '17.0.0' });
  expect(result.lineCases).toBe(7654);
  expect(result.graphemeCases).toBeGreaterThan(700);
  expect(result.graphemeFailures).toEqual([]);
  expect(result.lineFailures).toEqual([]);
  await info.attach(`wasm-007-${browserName}.json`, {
    contentType: 'application/json',
    body: JSON.stringify({
      browser: browserName,
      version: page.context().browser()?.version(),
      lineBreakCases: result.lineCases,
      lineBreakFailures: result.lineFailures.length,
      graphemeCases: result.graphemeCases,
      graphemeFailures: result.graphemeFailures.length,
    }),
  });
});
