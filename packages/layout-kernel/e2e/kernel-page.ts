/**
 * Serves the kernel to a page of a Playwright browser without a server: the package's WebAssembly
 * build, its TypeScript wrapper (`src/*.ts`, types removed by Node.js, so the code that runs is the
 * package's own) and the harness's font files, under one origin that the browser's request routing
 * answers. The page then starts the kernel with `import()`.
 */
import type { Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { stripTypeScriptTypes } from 'node:module';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PKG = fileURLToPath(new URL('..', import.meta.url));
export const ORIGIN = 'https://kernel.test';
const DIST = join(PKG, 'dist');
const FONTS = join(PKG, '../perf/fonts');

/** Routes the origin to the build, the wrapper and the fonts, and opens a blank page there. */
export async function openKernelPage(page: Page): Promise<void> {
  await page.route(`${ORIGIN}/**`, async (route) => {
    const { pathname } = new URL(route.request().url());
    const file = (path: string, type: string): Promise<void> =>
      route.fulfill({ status: 200, contentType: type, body: readFileSync(path) });
    if (pathname === '/')
      return route.fulfill({
        contentType: 'text/html',
        body: '<!doctype html><meta charset="utf-8">',
      });
    if (pathname.startsWith('/src/') && pathname.endsWith('.ts'))
      return route.fulfill({
        status: 200,
        contentType: 'text/javascript',
        body: stripTypeScriptTypes(readFileSync(join(PKG, 'src', basename(pathname)), 'utf8')),
      });
    if (pathname.startsWith('/dist/')) {
      // `dist/sea/` holds the module of Thai, Lao, Khmer and Burmese (WASM-016).
      const inSea = pathname.startsWith('/dist/sea/');
      return file(
        join(inSea ? join(DIST, 'sea') : DIST, basename(pathname)),
        pathname.endsWith('.wasm') ? 'application/wasm' : 'text/javascript',
      );
    }
    if (pathname.startsWith('/fonts/'))
      return file(join(FONTS, pathname.slice('/fonts/'.length)), 'application/octet-stream');
    return route.fulfill({ status: 404, body: '' });
  });
  await page.goto(`${ORIGIN}/`);
}
